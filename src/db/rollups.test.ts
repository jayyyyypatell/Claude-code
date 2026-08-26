import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { rebuildRollups } from "./rollups";
import { createTestDb, type TestDb } from "./test-utils";

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(() => {
  t.close();
});

async function addMetric(
  key: string,
  agg: "sum" | "avg" | "last" | "min" | "max",
  unit = "count",
): Promise<number> {
  const r = await t.client.execute({
    sql: `INSERT INTO metric_types (key, display_name, canonical_unit, agg)
          VALUES (?, ?, ?, ?) RETURNING id`,
    args: [key, key, unit, agg],
  });
  return Number(r.rows[0].id);
}

async function addPoint(opts: {
  metricTypeId: number;
  startAt: number;
  value: number;
  grain?: "sample" | "hourly" | "daily";
  localDate?: string;
  source?: string;
  unit?: string;
  min?: number | null;
  max?: number | null;
}): Promise<void> {
  await t.client.execute({
    sql: `INSERT INTO metric_points
            (metric_type_id, start_at, end_at, grain, local_date,
             tz_offset_minutes, value, value_min, value_max, unit, source_name)
          VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
          ON CONFLICT (metric_type_id, grain, start_at, source_name)
          DO UPDATE SET value = excluded.value`,
    args: [
      opts.metricTypeId,
      opts.startAt,
      opts.startAt,
      opts.grain ?? "sample",
      opts.localDate ?? "2026-08-26",
      opts.value,
      opts.min ?? null,
      opts.max ?? null,
      opts.unit ?? "count",
      opts.source ?? "iPhone",
    ],
  });
}

async function rollup(metricTypeId: number, date = "2026-08-26") {
  const r = await t.client.execute({
    sql: `SELECT value, value_min, value_max, sample_count, grain_used
          FROM daily_metrics WHERE metric_type_id = ? AND date = ?`,
    args: [metricTypeId, date],
  });
  return r.rows[0];
}

describe("grain precedence — the double-count guard", () => {
  it("does NOT sum raw samples together with hourly aggregates", async () => {
    // This is the scenario that silently doubles your step count: you backfill
    // export.xml (raw per-sample records) into a database that Health Auto
    // Export has already been pushing hourly aggregates into. Both describe
    // the same 1000 steps.
    const steps = await addMetric("step_count", "sum");
    const base = Date.parse("2026-08-26T12:00:00Z");

    // Raw samples from the XML backfill: 10 × 100 = 1000 steps.
    for (let i = 0; i < 10; i++) {
      await addPoint({
        metricTypeId: steps,
        startAt: base + i * 60_000,
        value: 100,
        grain: "sample",
      });
    }

    // The same day already covered by two hourly aggregates: 500 + 500 = 1000.
    await addPoint({
      metricTypeId: steps,
      startAt: Date.parse("2026-08-26T12:00:00Z"),
      value: 500,
      grain: "hourly",
    });
    await addPoint({
      metricTypeId: steps,
      startAt: Date.parse("2026-08-26T13:00:00Z"),
      value: 500,
      grain: "hourly",
    });

    // Both grains are stored — we don't throw data away...
    const stored = await t.client.execute(
      "SELECT COUNT(*) n FROM metric_points",
    );
    expect(Number(stored.rows[0].n)).toBe(12);

    await rebuildRollups({}, t.client);
    const row = await rollup(steps);

    // ...but the rollup uses the finest grain ONLY. Naive summing gives 2000.
    expect(Number(row.value)).toBe(1000);
    expect(row.grain_used).toBe("sample");
    expect(Number(row.sample_count)).toBe(10);
  });

  it("falls back to hourly when no raw samples exist", async () => {
    const steps = await addMetric("step_count", "sum");
    await addPoint({
      metricTypeId: steps,
      startAt: Date.parse("2026-08-26T12:00:00Z"),
      value: 500,
      grain: "hourly",
    });
    await addPoint({
      metricTypeId: steps,
      startAt: Date.parse("2026-08-26T13:00:00Z"),
      value: 700,
      grain: "hourly",
    });

    await rebuildRollups({}, t.client);
    const row = await rollup(steps);

    expect(Number(row.value)).toBe(1200);
    expect(row.grain_used).toBe("hourly");
  });

  it("prefers hourly over daily", async () => {
    const steps = await addMetric("step_count", "sum");
    await addPoint({
      metricTypeId: steps,
      startAt: Date.parse("2026-08-26T12:00:00Z"),
      value: 400,
      grain: "hourly",
    });
    await addPoint({
      metricTypeId: steps,
      startAt: Date.parse("2026-08-26T00:00:00Z"),
      value: 9999,
      grain: "daily",
    });

    await rebuildRollups({}, t.client);
    const row = await rollup(steps);

    expect(Number(row.value)).toBe(400);
    expect(row.grain_used).toBe("hourly");
  });

  it("keeps grain precedence independent per day", async () => {
    // A backfill covers older days at sample grain while recent days only have
    // live hourly pushes. Each day must resolve on its own evidence.
    const steps = await addMetric("step_count", "sum");

    await addPoint({
      metricTypeId: steps,
      startAt: Date.parse("2026-08-25T12:00:00Z"),
      value: 300,
      grain: "sample",
      localDate: "2026-08-25",
    });
    await addPoint({
      metricTypeId: steps,
      startAt: Date.parse("2026-08-25T13:00:00Z"),
      value: 999,
      grain: "hourly",
      localDate: "2026-08-25",
    });
    await addPoint({
      metricTypeId: steps,
      startAt: Date.parse("2026-08-26T13:00:00Z"),
      value: 800,
      grain: "hourly",
      localDate: "2026-08-26",
    });

    await rebuildRollups({}, t.client);

    expect(Number((await rollup(steps, "2026-08-25")).value)).toBe(300);
    expect((await rollup(steps, "2026-08-25")).grain_used).toBe("sample");
    expect(Number((await rollup(steps, "2026-08-26")).value)).toBe(800);
    expect((await rollup(steps, "2026-08-26")).grain_used).toBe("hourly");
  });
});

describe("per-metric aggregation", () => {
  it("sums additive counters", async () => {
    const steps = await addMetric("step_count", "sum");
    for (const v of [100, 250, 400]) {
      await addPoint({
        metricTypeId: steps,
        startAt: Date.parse("2026-08-26T12:00:00Z") + v * 1000,
        value: v,
      });
    }
    await rebuildRollups({}, t.client);
    expect(Number((await rollup(steps)).value)).toBe(750);
  });

  it("averages rates and carries min/max through", async () => {
    const hr = await addMetric("heart_rate", "avg", "bpm");
    await addPoint({
      metricTypeId: hr,
      startAt: Date.parse("2026-08-26T12:00:00Z"),
      value: 60,
      min: 55,
      max: 70,
      unit: "bpm",
    });
    await addPoint({
      metricTypeId: hr,
      startAt: Date.parse("2026-08-26T13:00:00Z"),
      value: 80,
      min: 72,
      max: 140,
      unit: "bpm",
    });

    await rebuildRollups({}, t.client);
    const row = await rollup(hr);

    expect(Number(row.value)).toBe(70); // (60 + 80) / 2
    // Min/max come from the per-sample extremes, not the averages — a peak of
    // 140bpm during a workout must survive into the daily row.
    expect(Number(row.value_min)).toBe(55);
    expect(Number(row.value_max)).toBe(140);
  });

  it("takes the chronologically last reading for body metrics", async () => {
    // Three weigh-ins in a day. Summing would report 250kg; averaging would
    // invent a weight you never were.
    const weight = await addMetric("weight_body_mass", "last", "kg");
    await addPoint({
      metricTypeId: weight,
      startAt: Date.parse("2026-08-26T07:00:00Z"),
      value: 83.5,
      unit: "kg",
    });
    await addPoint({
      metricTypeId: weight,
      startAt: Date.parse("2026-08-26T21:00:00Z"),
      value: 84.9,
      unit: "kg",
    });
    await addPoint({
      metricTypeId: weight,
      startAt: Date.parse("2026-08-26T12:00:00Z"),
      value: 84.1,
      unit: "kg",
    });

    await rebuildRollups({}, t.client);
    expect(Number((await rollup(weight)).value)).toBeCloseTo(84.9, 6);
  });
});

describe("idempotency", () => {
  it("is stable when run repeatedly", async () => {
    const steps = await addMetric("step_count", "sum");
    await addPoint({
      metricTypeId: steps,
      startAt: Date.parse("2026-08-26T12:00:00Z"),
      value: 1234,
    });

    await rebuildRollups({}, t.client);
    await rebuildRollups({}, t.client);
    await rebuildRollups({}, t.client);

    const all = await t.client.execute("SELECT COUNT(*) n FROM daily_metrics");
    expect(Number(all.rows[0].n)).toBe(1);
    expect(Number((await rollup(steps)).value)).toBe(1234);
  });

  it("reflects a corrected point rather than adding to it", async () => {
    const steps = await addMetric("step_count", "sum");
    const at = Date.parse("2026-08-26T12:00:00Z");

    await addPoint({ metricTypeId: steps, startAt: at, value: 1000 });
    await rebuildRollups({}, t.client);
    expect(Number((await rollup(steps)).value)).toBe(1000);

    // Health Auto Export re-pushes the same window with a revised figure.
    await addPoint({ metricTypeId: steps, startAt: at, value: 1180 });
    await rebuildRollups({}, t.client);

    expect(Number((await rollup(steps)).value)).toBe(1180);
    const n = await t.client.execute("SELECT COUNT(*) n FROM metric_points");
    expect(Number(n.rows[0].n)).toBe(1);
  });
});

describe("scoping", () => {
  it("only rebuilds the requested window", async () => {
    const steps = await addMetric("step_count", "sum");
    for (const d of ["2026-08-24", "2026-08-25", "2026-08-26"]) {
      await addPoint({
        metricTypeId: steps,
        startAt: Date.parse(`${d}T12:00:00Z`),
        value: 500,
        localDate: d,
      });
    }

    await rebuildRollups({ fromDate: "2026-08-25", toDate: "2026-08-25" }, t.client);

    const rows = await t.client.execute("SELECT date FROM daily_metrics");
    expect(rows.rows.map((r) => r.date)).toEqual(["2026-08-25"]);
  });
});
