import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "@/db/test-utils";

import { normalizeHaePayload } from "./normalize";
import { persistNormalized } from "./persist";

const TZ = "America/New_York";
let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});
afterEach(() => t.close());

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(path.resolve(process.cwd(), "fixtures/hae", name), "utf8"),
  );
}

/** The full ingest path a real push takes, minus HTTP. */
async function ingest(name: string, opts = {}) {
  const normalized = normalizeHaePayload(fixture(name), { timeZone: TZ, ...opts });
  const counts = await persistNormalized(normalized, t.client);
  return { normalized, counts };
}

const scalar = async (sql: string, args: unknown[] = []) =>
  (await t.client.execute({ sql, args: args as never })).rows[0];

describe("idempotency — the property the whole sync design rests on", () => {
  it("does not duplicate or double-count when the same push arrives repeatedly", async () => {
    // Health Auto Export re-sends overlapping windows on every push. This is
    // the normal case, not an edge case.
    await ingest("scalar-metrics.json");
    const afterFirst = await scalar(
      "SELECT COUNT(*) n, SUM(value) total FROM metric_points",
    );

    await ingest("scalar-metrics.json");
    await ingest("scalar-metrics.json");
    const afterThird = await scalar(
      "SELECT COUNT(*) n, SUM(value) total FROM metric_points",
    );

    expect(afterThird.n).toBe(afterFirst.n);
    expect(afterThird.total).toBe(afterFirst.total);

    // And the rollup that the dashboard and the AI read is stable too.
    const steps = await scalar(
      `SELECT value FROM daily_metrics dm
       JOIN metric_types mt ON mt.id = dm.metric_type_id
       WHERE mt.key = 'step_count' AND dm.date = '2026-08-26'`,
    );
    expect(Number(steps.value)).toBe(1240 + 980 + 2310);
  });

  it("registers each metric type exactly once across repeated pushes", async () => {
    const first = await ingest("scalar-metrics.json");
    const second = await ingest("scalar-metrics.json");

    expect(first.counts.metricTypesCreated).toBe(3);
    expect(second.counts.metricTypesCreated).toBe(0);

    const n = await scalar("SELECT COUNT(*) n FROM metric_types");
    expect(Number(n.n)).toBe(3);
  });

  it("updates a re-sent sleep night in place", async () => {
    await ingest("sleep-aggregated.json");
    await ingest("sleep-aggregated.json");

    const n = await scalar("SELECT COUNT(*) n FROM sleep_sessions");
    expect(Number(n.n)).toBe(1);
  });

  it("updates a re-sent workout in place", async () => {
    await ingest("workout-with-route.json");
    await ingest("workout-with-route.json");

    const n = await scalar("SELECT COUNT(*) n FROM workouts");
    expect(Number(n.n)).toBe(1);
  });

  it("does not lose a stored GPS route when a later push omits it", async () => {
    // Routes are opt-in, so a push made with the setting off must not wipe a
    // route captured while it was on.
    await ingest("workout-with-route.json", { storeRoutes: true });
    expect((await scalar("SELECT route FROM workouts")).route).not.toBeNull();

    await ingest("workout-with-route.json", { storeRoutes: false });
    expect((await scalar("SELECT route FROM workouts")).route).not.toBeNull();
  });
});

describe("the double-count scenario, end to end", () => {
  it("does not double a day covered by both raw samples and hourly aggregates", async () => {
    // The realistic sequence: live hourly pushes have been running, then you
    // backfill export.xml and its raw per-sample records land on the same day.
    const day = "2026-08-26";

    const hourly = {
      data: {
        metrics: [
          {
            name: "step_count",
            units: "count",
            data: [
              { date: `${day} 08:00:00 -0400`, endDate: `${day} 09:00:00 -0400`, qty: 600, source: "iPhone" },
              { date: `${day} 09:00:00 -0400`, endDate: `${day} 10:00:00 -0400`, qty: 400, source: "iPhone" },
            ],
          },
        ],
      },
    };
    await persistNormalized(
      normalizeHaePayload(hourly, { timeZone: TZ }),
      t.client,
    );

    let steps = await scalar(
      `SELECT value, grain_used FROM daily_metrics dm
       JOIN metric_types mt ON mt.id = dm.metric_type_id
       WHERE mt.key='step_count' AND dm.date = ?`,
      [day],
    );
    expect(Number(steps.value)).toBe(1000);
    expect(steps.grain_used).toBe("hourly");

    // Now the backfill: ten raw samples describing the same 1000 steps.
    const raw = {
      data: {
        metrics: [
          {
            name: "step_count",
            units: "count",
            data: Array.from({ length: 10 }, (_, i) => ({
              date: `${day} 08:${String(i * 5).padStart(2, "0")}:00 -0400`,
              qty: 100,
              source: "iPhone",
            })),
          },
        ],
      },
    };
    await persistNormalized(normalizeHaePayload(raw, { timeZone: TZ }), t.client);

    steps = await scalar(
      `SELECT value, grain_used, sample_count FROM daily_metrics dm
       JOIN metric_types mt ON mt.id = dm.metric_type_id
       WHERE mt.key='step_count' AND dm.date = ?`,
      [day],
    );

    // Still 1000 — not 2000. The finest grain wins outright.
    expect(Number(steps.value)).toBe(1000);
    expect(steps.grain_used).toBe("sample");
    expect(Number(steps.sample_count)).toBe(10);

    // Both grains remain stored; we discard nothing.
    const total = await scalar("SELECT COUNT(*) n FROM metric_points");
    expect(Number(total.n)).toBe(12);
  });
});

describe("shapes reach the database intact", () => {
  it("stores heart rate min/max alongside the average", async () => {
    await ingest("heart-rate-minavgmax.json");
    const row = await scalar(
      `SELECT value, value_min, value_max FROM metric_points mp
       JOIN metric_types mt ON mt.id = mp.metric_type_id
       WHERE mt.key='heart_rate' ORDER BY start_at LIMIT 1`,
    );
    expect(Number(row.value)).toBeCloseTo(63.4, 6);
    expect(Number(row.value_min)).toBe(54);
    expect(Number(row.value_max)).toBe(118);
  });

  it("stores blood pressure as a pair", async () => {
    await ingest("blood-pressure.json");
    const row = await scalar(
      `SELECT value, value_2 FROM metric_points mp
       JOIN metric_types mt ON mt.id = mp.metric_type_id
       WHERE mt.key='blood_pressure'`,
    );
    expect(Number(row.value)).toBe(118);
    expect(Number(row.value_2)).toBe(76);
  });

  it("registers a brand-new metric rather than dropping it", async () => {
    const { counts } = await ingest("unknown-and-malformed.json");
    expect(counts.pointsUpserted).toBeGreaterThan(0);

    const row = await scalar(
      "SELECT key, agg FROM metric_types WHERE key = 'brand_new_apple_metric_2027'",
    );
    expect(row).toBeDefined();

    const point = await scalar(
      `SELECT value FROM metric_points mp
       JOIN metric_types mt ON mt.id = mp.metric_type_id
       WHERE mt.key='brand_new_apple_metric_2027'`,
    );
    expect(Number(point.value)).toBe(42);
  });

  it("files travelling samples under their own local dates", async () => {
    await ingest("timezone-travel.json");
    const rows = await t.client.execute(
      "SELECT DISTINCT local_date FROM metric_points",
    );
    expect(rows.rows.map((r) => r.local_date)).toEqual(["2026-08-26"]);

    // All three roll into one local day, totalling 1200.
    const steps = await scalar(
      `SELECT value FROM daily_metrics dm
       JOIN metric_types mt ON mt.id = dm.metric_type_id
       WHERE mt.key='step_count' AND dm.date='2026-08-26'`,
    );
    expect(Number(steps.value)).toBe(1200);
  });
});
