import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { inferGrain, inferSeriesGrain, normalizeHaePayload } from "./normalize";

const TZ = "America/New_York";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(path.resolve(process.cwd(), "fixtures/hae", name), "utf8"),
  );
}

const run = (name: string, opts = {}) =>
  normalizeHaePayload(fixture(name), { timeZone: TZ, ...opts });

describe("scalar metrics", () => {
  it("normalizes plain qty readings", () => {
    const r = run("scalar-metrics.json");
    const steps = r.points.filter((p) => p.metricKey === "step_count");

    expect(steps).toHaveLength(3);
    expect(steps.map((s) => s.value)).toEqual([1240, 980, 2310]);
    expect(steps[0].localDate).toBe("2026-08-26");
    expect(steps[0].tzOffsetMinutes).toBe(-240);
    expect(steps[0].sourceName).toBe("iPhone");
    expect(r.warnings).toHaveLength(0);
  });

  it("converts units to canonical on the way in", () => {
    const r = run("scalar-metrics.json");
    const distance = r.points.find(
      (p) => p.metricKey === "walking_running_distance",
    )!;

    // 6.4 km arrives; 6400 m is stored. Mixing km and miles in one column is
    // the thing this prevents.
    expect(distance.value).toBeCloseTo(6400, 6);
    expect(distance.unit).toBe("m");
  });
});

describe("heart rate — the Min/Avg/Max shape", () => {
  it("maps capitalised Avg/Min/Max onto value/min/max", () => {
    const r = run("heart-rate-minavgmax.json");
    const hr = r.points.filter((p) => p.metricKey === "heart_rate");

    expect(hr).toHaveLength(2);
    expect(hr[0].value).toBe(63.4);
    expect(hr[0].valueMin).toBe(54);
    expect(hr[0].valueMax).toBe(118);
    // A 154bpm peak must survive — it's the interesting part of the day.
    expect(hr[1].valueMax).toBe(154);
  });

  it("still handles the same metric family sent as a plain qty", () => {
    const r = run("heart-rate-minavgmax.json");
    const resting = r.points.find((p) => p.metricKey === "resting_heart_rate")!;
    expect(resting.value).toBe(56);
    expect(resting.valueMin).toBeNull();
  });
});

describe("paired and annotated readings", () => {
  it("splits blood pressure across value and value2", () => {
    const r = run("blood-pressure.json");
    const bp = r.points.find((p) => p.metricKey === "blood_pressure")!;
    expect(bp.value).toBe(118); // systolic
    expect(bp.value2).toBe(76); // diastolic
    expect(bp.unit).toBe("mmHg");
  });

  it("keeps glucose mealTime as meta rather than discarding it", () => {
    const r = run("blood-pressure.json");
    const glucose = r.points.find((p) => p.metricKey === "blood_glucose")!;
    expect(glucose.value).toBe(104);
    expect(glucose.meta).toMatchObject({ mealTime: "After Meal" });
  });
});

describe("sleep — aggregated", () => {
  it("converts hours to minutes and computes efficiency", () => {
    const r = run("sleep-aggregated.json");
    expect(r.sleep).toHaveLength(1);
    const s = r.sleep[0];

    expect(s.totalSleepMin).toBeCloseTo(432, 3); // 7.2h
    expect(s.deepMin).toBeCloseTo(69, 3); // 1.15h
    expect(s.remMin).toBeCloseTo(117, 3); // 1.95h
    expect(s.inBedMin).toBeCloseTo(472.2, 2);
    expect(s.efficiency).toBeCloseTo(432 / 472.2, 5);
  });

  it("files the night under the day it started, not the wake day", () => {
    // 25 Aug 23:12 → 26 Aug 07:04 is "the night of the 25th".
    const r = run("sleep-aggregated.json");
    expect(r.sleep[0].date).toBe("2026-08-25");
  });
});

describe("sleep — unaggregated phase rows", () => {
  it("rebuilds one session from per-phase intervals", () => {
    const r = run("sleep-unaggregated.json");
    expect(r.sleep).toHaveLength(1);

    const s = r.sleep[0];
    expect(s.date).toBe("2026-08-25");
    expect(s.deepMin).toBeCloseTo(65, 1);
    expect(s.remMin).toBeCloseTo(75, 1);
    expect(s.coreMin).toBeCloseTo(78 + 239, 1);
    expect(s.awakeMin).toBeCloseTo(15, 1);
    // Asleep excludes the awake block; in-bed includes it.
    expect(s.totalSleepMin).toBeCloseTo(457, 1);
    expect(s.inBedMin).toBeCloseTo(472, 1);
    expect(s.meta).toMatchObject({ reconstructedFromPhases: true });
  });

  it("agrees closely with the aggregated form of the same night", () => {
    // Both fixtures describe the same night. If the two code paths disagreed
    // materially, a user who changed HAE's aggregation setting would see a
    // step change in their sleep history.
    const agg = run("sleep-aggregated.json").sleep[0];
    const phases = run("sleep-unaggregated.json").sleep[0];

    expect(phases.date).toBe(agg.date);
    expect(Math.abs(phases.totalSleepMin - agg.totalSleepMin)).toBeLessThan(30);
  });
});

describe("workouts", () => {
  it("normalizes totals and heart rate", () => {
    const r = run("workout-with-route.json");
    expect(r.workouts).toHaveLength(1);
    const w = r.workouts[0];

    expect(w.name).toBe("Running");
    expect(w.durationSec).toBe(2760);
    expect(w.activeEnergyKcal).toBeCloseTo(486.2, 3);
    expect(w.distanceM).toBeCloseTo(8120, 3); // 8.12 km → m
    expect(w.avgHeartRate).toBe(152.4);
    expect(w.maxHeartRate).toBe(178);
    expect(w.date).toBe("2026-08-26");
  });

  it("drops GPS routes by default and keeps them only on request", () => {
    // Location history is the most sensitive thing in the payload, and nothing
    // in v1 renders it — so it is opt-in, not opt-out.
    expect(run("workout-with-route.json").workouts[0].route).toBeNull();
    expect(
      run("workout-with-route.json", { storeRoutes: true }).workouts[0].route,
    ).toHaveLength(2);
  });

  it("keeps unrecognised workout fields as meta", () => {
    const r = run("workout-with-route.json");
    expect(r.workouts[0].meta).toMatchObject({ temperature: { qty: 19.5 } });
  });
});

describe("resilience — the point is never to lose a reading", () => {
  it("keeps an unknown metric instead of rejecting it", () => {
    const r = run("unknown-and-malformed.json");
    const novel = r.points.find(
      (p) => p.metricKey === "brand_new_apple_metric_2027",
    );

    expect(novel).toBeDefined();
    expect(novel!.value).toBe(42);
    // Reported so it can be surfaced in settings, but never a reason to 4xx —
    // Apple ships new metric types with roughly every iOS release.
    expect(r.unknownMetrics).toContain("brand_new_apple_metric_2027");
  });

  it("skips only the bad rows in a batch, keeping the good ones", () => {
    const r = run("unknown-and-malformed.json");
    const steps = r.points.filter((p) => p.metricKey === "step_count");

    // Three rows in: one bad date, one good, one with no qty.
    expect(steps).toHaveLength(1);
    expect(steps[0].value).toBe(777);
    expect(r.warnings.some((w) => w.includes("unparseable date"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("no numeric qty"))).toBe(true);
  });

  it("survives nameless metrics and broken workouts", () => {
    const r = run("unknown-and-malformed.json");
    expect(r.workouts).toHaveLength(0);
    expect(r.warnings.some((w) => w.includes("no `name`"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("unparseable start/end"))).toBe(true);
  });

  it("returns empty rather than throwing on a garbage payload", () => {
    for (const junk of [null, undefined, 42, "hello", {}, { data: null }]) {
      const r = normalizeHaePayload(junk, { timeZone: TZ });
      expect(r.points).toEqual([]);
      expect(r.sleep).toEqual([]);
    }
  });
});

describe("timezones", () => {
  it("files each sample under its own local date, not the server's", () => {
    // The traveller case. All three samples are the 26th where they were
    // recorded, even though they span three different UTC days.
    const r = run("timezone-travel.json");
    expect(r.points).toHaveLength(3);
    for (const p of r.points) expect(p.localDate).toBe("2026-08-26");

    expect(r.points.map((p) => p.tzOffsetMinutes)).toEqual([540, -420, 330]);

    // The UTC days genuinely differ — proving localDate isn't just the instant.
    const utcDays = r.points.map((p) =>
      new Date(p.startAt).toISOString().slice(0, 10),
    );
    expect(new Set(utcDays).size).toBeGreaterThan(1);
  });
});

describe("inferGrain", () => {
  it("classifies by the window a sample covers", () => {
    const t = Date.parse("2026-08-26T08:00:00Z");
    expect(inferGrain(t, t)).toBe("sample");
    expect(inferGrain(t, t + 30_000)).toBe("sample");
    expect(inferGrain(t, t + 59 * 60_000)).toBe("hourly");
    expect(inferGrain(t, t + 60 * 60_000)).toBe("hourly");
    expect(inferGrain(t, t + 24 * 3_600_000)).toBe("daily");
    // A DST day is 23 hours and must still read as daily.
    expect(inferGrain(t, t + 23 * 3_600_000)).toBe("daily");
  });

  it("reads the fixtures' hourly buckets as hourly", () => {
    // These are instantaneous timestamps with no endDate. One of them says
    // nothing about the window it covers — but a run of them on exact hour
    // boundaries does, and calling them `sample` is what would let a history
    // backfill be summed on top of live sync.
    const r = run("scalar-metrics.json");
    const steps = r.points.filter((p) => p.metricKey === "step_count");
    expect(steps.length).toBeGreaterThan(1);
    expect(steps.every((p) => p.grain === "hourly")).toBe(true);
  });

  it("honours an explicit grain override", () => {
    const r = run("scalar-metrics.json", { forceGrain: "hourly" as const });
    expect(r.points.every((p) => p.grain === "hourly")).toBe(true);
  });
});

describe("inferSeriesGrain", () => {
  const hour = 3_600_000;
  const at = (iso: string) => Date.parse(iso);

  it("recognises evenly spaced buckets on the hour", () => {
    const starts = [0, 1, 2, 3].map((i) => at("2026-08-26T08:00:00Z") + i * hour);
    expect(inferSeriesGrain(starts)).toBe("hourly");
  });

  it("recognises daily buckets", () => {
    const starts = [0, 1, 2, 3].map((i) => at("2026-08-26T00:00:00Z") + i * 24 * hour);
    expect(inferSeriesGrain(starts)).toBe("daily");
  });

  it("still reads daily across a 23-hour DST day", () => {
    const starts = [
      at("2026-11-01T07:00:00Z"),
      at("2026-11-02T08:00:00Z"), // 25h later in wall-clock terms
      at("2026-11-03T08:00:00Z"),
    ];
    expect(inferSeriesGrain(starts)).toBe("daily");
  });

  it("does not mistake irregular raw samples for buckets", () => {
    const base = at("2026-08-26T08:00:00Z");
    const starts = [base, base + 137_000, base + 402_000, base + 900_000];
    expect(inferSeriesGrain(starts)).toBeNull();
  });

  it("does not call a daily habit an aggregate just because it is regular", () => {
    // A scale read within a few minutes of 07:00 every morning is regularly
    // spaced but is not a bucket, and treating it as one would let it outrank
    // real data in the rollup.
    const starts = [0, 1, 2, 3].map(
      (i) => at("2026-08-26T07:00:00Z") + i * 24 * hour + i * 137_000,
    );
    expect(inferSeriesGrain(starts)).toBeNull();
  });

  it("declines to guess from a single point", () => {
    // Genuinely ambiguous. HAE_AGGREGATION exists for this case.
    expect(inferSeriesGrain([at("2026-08-26T08:00:00Z")])).toBeNull();
    expect(inferSeriesGrain([])).toBeNull();
  });

  it("ignores duplicate timestamps from two sources", () => {
    const base = at("2026-08-26T08:00:00Z");
    const starts = [base, base, base + hour, base + hour, base + 2 * hour];
    expect(inferSeriesGrain(starts)).toBe("hourly");
  });
});
