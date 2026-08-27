import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "@/db/test-utils";
import { normalizeHaePayload } from "@/lib/hae/normalize";
import { persistNormalized } from "@/lib/hae/persist";

import { importHealthExport } from "./run";

/**
 * The two ingest paths, landing in one database.
 *
 * This is the test the whole `grain` design exists for. Apple's `export.xml`
 * carries raw per-sample records; Health Auto Export sends hourly aggregates
 * of the same underlying samples. They share no natural key, so nothing stops
 * both from being stored — and if the daily rollup summed across them, every
 * additive metric would double the moment a history was backfilled onto a
 * database live sync had been filling. It would look like a real number.
 */

const TZ = "America/Los_Angeles";

let t: TestDb;
let dir: string;

beforeEach(async () => {
  t = await createTestDb();
  dir = mkdtempSync(path.join(tmpdir(), "lifetracker-xml-"));
});

afterEach(() => {
  t.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Raw per-sample step records, the way `export.xml` stores them. */
function rawSamplesXml(
  date: string,
  samples: { hour: number; minute: number; value: number }[],
): string {
  const records = samples
    .map(({ hour, minute, value }) => {
      const h = String(hour).padStart(2, "0");
      const m = String(minute).padStart(2, "0");
      return `<Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="${date} ${h}:${m}:00 -0700" endDate="${date} ${h}:${m}:30 -0700" value="${value}"/>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
<ExportDate value="2026-08-27 09:00:00 -0700"/>
${records}
</HealthData>`;
}

async function writeXml(name: string, xml: string): Promise<string> {
  const p = path.join(dir, name);
  writeFileSync(p, xml);
  return p;
}

async function dailyTotal(key: string, date: string): Promise<number | null> {
  const r = await t.client.execute({
    sql: `SELECT dm.value FROM daily_metrics dm
          JOIN metric_types mt ON mt.id = dm.metric_type_id
          WHERE mt.key = ? AND dm.date = ?`,
    args: [key, date],
  });
  return r.rows.length ? Number(r.rows[0].value) : null;
}

/** An hourly aggregate exactly as Health Auto Export would push it. */
async function pushHourly(
  date: string,
  buckets: { hour: number; qty: number }[],
): Promise<void> {
  // A single bucket carries no cadence to detect, so these tests state the
  // aggregation the way a user would with HAE_AGGREGATION. Multi-bucket
  // detection is covered in normalize.test.ts.
  const normalized = normalizeHaePayload(
    {
      data: {
        metrics: [
          {
            name: "step_count",
            units: "count",
            data: buckets.map(({ hour, qty }) => ({
              date: `${date} ${String(hour).padStart(2, "0")}:00:00 -0700`,
              qty,
              source: "iPhone",
            })),
          },
        ],
        workouts: [],
      },
    },
    { timeZone: TZ, forceGrain: "hourly" },
  );
  await persistNormalized(normalized, t.client);
}

describe("export.xml and Health Auto Export in one database", () => {
  it("does not double-count when a backfill lands on top of live sync", async () => {
    const date = "2026-08-26";

    // Live sync has already stored two hourly buckets: 500 + 300 = 800 steps.
    await pushHourly(date, [
      { hour: 8, qty: 500 },
      { hour: 9, qty: 300 },
    ]);
    expect(await dailyTotal("step_count", date)).toBe(800);

    // Now backfill the raw samples those buckets were aggregated from. Same
    // 800 steps, recorded per-sample.
    const xml = await writeXml(
      "export.xml",
      rawSamplesXml(date, [
        { hour: 8, minute: 3, value: 200 },
        { hour: 8, minute: 27, value: 300 },
        { hour: 9, minute: 12, value: 180 },
        { hour: 9, minute: 41, value: 120 },
      ]),
    );
    await importHealthExport(xml, { timeZone: TZ, db: t.client });

    // Still 800. Summing across grains would give 1,600 — a plausible-looking
    // number that nothing about the app would flag.
    expect(await dailyTotal("step_count", date)).toBe(800);
  });

  it("keeps both grains stored, and picks samples over hourly", async () => {
    const date = "2026-08-26";
    await pushHourly(date, [{ hour: 8, qty: 500 }]);

    const xml = await writeXml(
      "export.xml",
      rawSamplesXml(date, [
        { hour: 8, minute: 3, value: 210 },
        { hour: 8, minute: 27, value: 305 },
      ]),
    );
    await importHealthExport(xml, { timeZone: TZ, db: t.client });

    const grains = await t.client.execute(
      "SELECT grain, COUNT(*) c FROM metric_points GROUP BY grain ORDER BY grain",
    );
    // Nothing was overwritten — both representations survive, which is what
    // makes it possible to change precedence later without re-importing.
    expect(Object.fromEntries(grains.rows.map((r) => [r.grain, Number(r.c)]))).toEqual({
      hourly: 1,
      sample: 2,
    });

    // Precedence is sample > hourly, so the day reads from the raw samples.
    expect(await dailyTotal("step_count", date)).toBe(515);
  });

  it("re-importing the same export changes nothing", async () => {
    const date = "2026-08-26";
    const xml = await writeXml(
      "export.xml",
      rawSamplesXml(date, [
        { hour: 8, minute: 3, value: 200 },
        { hour: 9, minute: 12, value: 180 },
      ]),
    );

    await importHealthExport(xml, { timeZone: TZ, db: t.client });
    const first = await t.client.execute(
      "SELECT COUNT(*) c, SUM(value) s FROM metric_points",
    );

    await importHealthExport(xml, { timeZone: TZ, db: t.client });
    const second = await t.client.execute(
      "SELECT COUNT(*) c, SUM(value) s FROM metric_points",
    );

    expect(second.rows[0]).toEqual(first.rows[0]);
    expect(await dailyTotal("step_count", date)).toBe(380);
  });

  it("imports arriving in either order reach the same daily total", async () => {
    // Order matters if precedence is applied at write time. It isn't — the
    // rollup decides on read, so a backfill-then-sync and a sync-then-backfill
    // must agree.
    const date = "2026-08-26";
    const xml = await writeXml(
      "export.xml",
      rawSamplesXml(date, [
        { hour: 8, minute: 3, value: 210 },
        { hour: 8, minute: 27, value: 305 },
      ]),
    );

    await importHealthExport(xml, { timeZone: TZ, db: t.client });
    await pushHourly(date, [{ hour: 8, qty: 500 }]);

    expect(await dailyTotal("step_count", date)).toBe(515);
  });

  it("detects hourly cadence from the push itself, with no configuration", async () => {
    // The real bug this guards: HAE sends `{date, qty}` with no end date, so
    // a per-point duration check calls every bucket a raw sample and the
    // double-count protection silently stops working.
    const date = "2026-08-26";
    const normalized = normalizeHaePayload(
      {
        data: {
          metrics: [
            {
              name: "step_count",
              units: "count",
              data: [
                { date: `${date} 08:00:00 -0700`, qty: 500, source: "iPhone" },
                { date: `${date} 09:00:00 -0700`, qty: 300, source: "iPhone" },
                { date: `${date} 10:00:00 -0700`, qty: 400, source: "iPhone" },
              ],
            },
          ],
          workouts: [],
        },
      },
      { timeZone: TZ },
    );
    expect(normalized.points.map((p) => p.grain)).toEqual(["hourly", "hourly", "hourly"]);

    await persistNormalized(normalized, t.client);
    expect(await dailyTotal("step_count", date)).toBe(1200);

    // Backfilling the raw samples behind those buckets must not add to it.
    const xml = await writeXml(
      "export.xml",
      rawSamplesXml(date, [
        { hour: 8, minute: 3, value: 200 },
        { hour: 8, minute: 27, value: 300 },
        { hour: 9, minute: 12, value: 300 },
        { hour: 10, minute: 5, value: 400 },
      ]),
    );
    await importHealthExport(xml, { timeZone: TZ, db: t.client });
    expect(await dailyTotal("step_count", date)).toBe(1200);
  });

  it("registers one metric type for a key both paths use", async () => {
    // If the HealthKit identifier mapped to its own key, the backfill would
    // land in a second row that no chart reads and no rollup touches.
    const date = "2026-08-26";
    await pushHourly(date, [{ hour: 8, qty: 500 }]);
    const xml = await writeXml("export.xml", rawSamplesXml(date, [
      { hour: 8, minute: 3, value: 210 },
    ]));
    await importHealthExport(xml, { timeZone: TZ, db: t.client });

    const types = await t.client.execute(
      "SELECT key FROM metric_types WHERE key LIKE '%step%'",
    );
    expect(types.rows.map((r) => r.key)).toEqual(["step_count"]);
  });
});

describe("importing a bare .xml as well as a .zip", () => {
  it("accepts an unzipped export", async () => {
    // The first thing anyone does when an import goes wrong is unzip it to
    // look inside; being told to re-zip it at that point is needless.
    const xml = await writeXml(
      "export.xml",
      rawSamplesXml("2026-08-26", [{ hour: 8, minute: 3, value: 200 }]),
    );
    const summary = await importHealthExport(xml, { timeZone: TZ, db: t.client });
    expect(summary.points).toBe(1);
    expect(summary.records).toBe(1);
  });

  it("reports a useful error for a file that isn't an export", async () => {
    const notAZip = path.join(dir, "holiday-photos.zip");
    writeFileSync(notAZip, "this is not a zip archive");
    await expect(
      importHealthExport(notAZip, { timeZone: TZ, db: t.client }),
    ).rejects.toThrow();
  });
});
