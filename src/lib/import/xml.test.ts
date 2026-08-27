import { describe, expect, it } from "vitest";

import type { NormalizedPoint } from "@/lib/hae/normalize";

import { HealthExportParser } from "./xml";
import {
  metricKeyForHkType,
  sleepPhaseFromCategoryValue,
  snakeFromCamel,
  workoutNameForActivityType,
} from "./hk-types";

const TZ = "America/Los_Angeles";

/** Run a whole document through the parser and collect everything it emits. */
async function parse(xml: string, opts: { storeRoutes?: boolean; since?: string } = {}) {
  const points: NormalizedPoint[] = [];
  const parser = new HealthExportParser({
    timeZone: TZ,
    batchSize: 500,
    storeRoutes: opts.storeRoutes,
    since: opts.since ?? null,
    onPoints: async (batch) => {
      points.push(...batch);
    },
  });
  await parser.write(xml);
  const result = await parser.finish();
  // `result.points` is a count, so the collected rows go under their own name
  // rather than being spread over.
  return { ...result, points, pointCount: result.points };
}

function doc(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
<ExportDate value="2026-08-27 09:00:00 -0700"/>
${inner}
</HealthData>`;
}

function record(attrs: Record<string, string>): string {
  const a = Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  return `<Record ${a}/>`;
}

/* ------------------------------------------------------------ type mapping -- */

describe("metricKeyForHkType", () => {
  it("maps HealthKit identifiers onto the keys Health Auto Export uses", () => {
    // This is the whole point of the table: both ingest paths must produce the
    // same key, or the backfill lands in a metric nothing reads.
    expect(metricKeyForHkType("HKQuantityTypeIdentifierStepCount")).toEqual({
      key: "step_count",
      isKnown: true,
    });
    expect(
      metricKeyForHkType("HKQuantityTypeIdentifierDistanceWalkingRunning").key,
    ).toBe("walking_running_distance");
    expect(
      metricKeyForHkType("HKQuantityTypeIdentifierHeartRateVariabilitySDNN").key,
    ).toBe("heart_rate_variability");
    expect(metricKeyForHkType("HKQuantityTypeIdentifierActiveEnergyBurned").key).toBe(
      "active_energy",
    );
    expect(metricKeyForHkType("HKQuantityTypeIdentifierBodyMass").key).toBe(
      "weight_body_mass",
    );
  });

  it("derives a key for a type it has never seen rather than dropping it", () => {
    const r = metricKeyForHkType("HKQuantityTypeIdentifierSomeNewMetric");
    expect(r.key).toBe("some_new_metric");
    // Flagged so the user hears about it — but still imported.
    expect(r.isKnown).toBe(false);
  });

  it("breaks acronyms and digits the way the catalog spells them", () => {
    expect(snakeFromCamel("VO2Max")).toBe("vo2_max");
    expect(snakeFromCamel("AppleStandHour")).toBe("apple_stand_hour");
    expect(snakeFromCamel("HRVAverage")).toBe("hrv_average");
    expect(snakeFromCamel("UVExposure")).toBe("uv_exposure");
  });
});

describe("workoutNameForActivityType", () => {
  it("renders an activity type as a readable name", () => {
    expect(workoutNameForActivityType("HKWorkoutActivityTypeRunning")).toBe("Running");
    expect(
      workoutNameForActivityType("HKWorkoutActivityTypeHighIntensityIntervalTraining"),
    ).toBe("High Intensity Interval Training");
  });
});

describe("sleepPhaseFromCategoryValue", () => {
  it("keeps 'asleep unspecified' distinct from 'in bed'", () => {
    // A phone-only night has no stages. Reading it as time in bed would report
    // eight hours of lying awake.
    expect(sleepPhaseFromCategoryValue("HKCategoryValueSleepAnalysisAsleepUnspecified"))
      .toBe("asleep");
    expect(sleepPhaseFromCategoryValue("HKCategoryValueSleepAnalysisInBed")).toBe("inbed");
    expect(sleepPhaseFromCategoryValue("HKCategoryValueSleepAnalysisAsleepDeep")).toBe("deep");
    expect(sleepPhaseFromCategoryValue("HKCategoryValueSleepAnalysisAsleepREM")).toBe("rem");
    expect(sleepPhaseFromCategoryValue("HKCategoryValueSleepAnalysisAsleepCore")).toBe("core");
    expect(sleepPhaseFromCategoryValue("HKCategoryValueSleepAnalysisAwake")).toBe("awake");
  });

  it("handles the legacy numeric values", () => {
    expect(sleepPhaseFromCategoryValue("0")).toBe("inbed");
    expect(sleepPhaseFromCategoryValue("1")).toBe("asleep");
  });
});

/* ------------------------------------------------------------------ records -- */

describe("HealthExportParser records", () => {
  it("parses a step record into a point on its own local day", async () => {
    const { points } = await parse(
      doc(
        record({
          type: "HKQuantityTypeIdentifierStepCount",
          sourceName: "iPhone",
          unit: "count",
          startDate: "2026-08-26 08:00:00 -0700",
          endDate: "2026-08-26 08:05:00 -0700",
          value: "437",
        }),
      ),
    );

    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      metricKey: "step_count",
      value: 437,
      unit: "count",
      localDate: "2026-08-26",
      sourceName: "iPhone",
      grain: "sample",
    });
  });

  it("converts to the metric's own storage unit, not the dimension default", async () => {
    // The bug this guards: canonicalising per dimension puts sodium in kg and
    // renders 2300mg as 0.0023.
    const { points } = await parse(
      doc(
        record({
          type: "HKQuantityTypeIdentifierBodyMass",
          unit: "lb",
          startDate: "2026-08-26 07:00:00 -0700",
          endDate: "2026-08-26 07:00:00 -0700",
          value: "185.2",
        }) +
          record({
            type: "HKQuantityTypeIdentifierDietarySodium",
            unit: "mg",
            startDate: "2026-08-26 12:00:00 -0700",
            endDate: "2026-08-26 12:00:00 -0700",
            value: "2300",
          }),
      ),
    );

    const weight = points.find((p) => p.metricKey === "weight_body_mass");
    expect(weight?.value).toBeCloseTo(84.0, 1);
    expect(weight?.unit).toBe("kg");

    const sodium = points.find((p) => p.metricKey === "sodium");
    expect(sodium?.value).toBeCloseTo(2300, 5);
    expect(sodium?.unit).toBe("mg");
  });

  it("files a late-night sample under the local date it was written in", async () => {
    // 23:30 in Tokyo is the 26th there and the 26th here — the offset in the
    // string decides, never the server's clock.
    const { points } = await parse(
      doc(
        record({
          type: "HKQuantityTypeIdentifierStepCount",
          unit: "count",
          startDate: "2026-08-26 23:30:00 +0900",
          endDate: "2026-08-26 23:35:00 +0900",
          value: "1200",
        }),
      ),
    );
    expect(points[0].localDate).toBe("2026-08-26");
    expect(points[0].tzOffsetMinutes).toBe(540);
  });

  it("assigns grain by record duration so hourly buckets don't outrank samples", async () => {
    // Grain decides precedence in the daily rollup. A pre-bucketed hourly
    // interval labelled 'sample' would beat live sync's hourly aggregate and
    // then be summed alongside it.
    const { points } = await parse(
      doc(
        record({
          type: "HKQuantityTypeIdentifierAppleExerciseTime",
          unit: "min",
          startDate: "2026-08-26 08:00:00 -0700",
          endDate: "2026-08-26 09:00:00 -0700",
          value: "12",
        }) +
          record({
            type: "HKQuantityTypeIdentifierStepCount",
            unit: "count",
            startDate: "2026-08-26 08:00:00 -0700",
            endDate: "2026-08-26 08:02:00 -0700",
            value: "300",
          }),
      ),
    );

    expect(points.find((p) => p.metricKey === "apple_exercise_time")?.grain).toBe("hourly");
    expect(points.find((p) => p.metricKey === "step_count")?.grain).toBe("sample");
  });

  it("merges systolic and diastolic into one blood pressure row", async () => {
    const { points } = await parse(
      doc(
        record({
          type: "HKQuantityTypeIdentifierBloodPressureSystolic",
          unit: "mmHg",
          sourceName: "Omron",
          startDate: "2026-08-26 07:30:00 -0700",
          endDate: "2026-08-26 07:30:00 -0700",
          value: "118",
        }) +
          record({
            type: "HKQuantityTypeIdentifierBloodPressureDiastolic",
            unit: "mmHg",
            sourceName: "Omron",
            startDate: "2026-08-26 07:30:00 -0700",
            endDate: "2026-08-26 07:30:00 -0700",
            value: "76",
          }),
      ),
    );

    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      metricKey: "blood_pressure",
      value: 118,
      value2: 76,
    });
  });

  it("keeps a blood pressure reading whose other half never arrives", async () => {
    const { points } = await parse(
      doc(
        record({
          type: "HKQuantityTypeIdentifierBloodPressureSystolic",
          unit: "mmHg",
          startDate: "2026-08-26 07:30:00 -0700",
          endDate: "2026-08-26 07:30:00 -0700",
          value: "118",
        }),
      ),
    );
    expect(points).toHaveLength(1);
    expect(points[0].metricKey).toBe("blood_pressure");
  });

  it("imports an unrecognised type and reports it", async () => {
    const { points, unknownTypes } = await parse(
      doc(
        record({
          type: "HKQuantityTypeIdentifierSomethingAppleAddedLater",
          unit: "count",
          startDate: "2026-08-26 08:00:00 -0700",
          endDate: "2026-08-26 08:00:00 -0700",
          value: "7",
        }),
      ),
    );

    expect(points).toHaveLength(1);
    expect(points[0].metricKey).toBe("something_apple_added_later");
    expect(unknownTypes).toContain("HKQuantityTypeIdentifierSomethingAppleAddedLater");
  });

  it("counts a category event with no numeric value as one occurrence", async () => {
    const { points } = await parse(
      doc(
        record({
          type: "HKCategoryTypeIdentifierHandwashingEvent",
          startDate: "2026-08-26 08:00:00 -0700",
          endDate: "2026-08-26 08:00:20 -0700",
          value: "HKCategoryValueNotApplicable",
        }),
      ),
    );
    expect(points[0].value).toBe(1);
  });

  it("skips records before `since` without failing", async () => {
    const { points, skipped } = await parse(
      doc(
        record({
          type: "HKQuantityTypeIdentifierStepCount",
          unit: "count",
          startDate: "2020-01-01 08:00:00 -0700",
          endDate: "2020-01-01 08:05:00 -0700",
          value: "100",
        }) +
          record({
            type: "HKQuantityTypeIdentifierStepCount",
            unit: "count",
            startDate: "2026-08-26 08:00:00 -0700",
            endDate: "2026-08-26 08:05:00 -0700",
            value: "200",
          }),
      ),
      { since: "2026-01-01" },
    );

    expect(points).toHaveLength(1);
    expect(points[0].value).toBe(200);
    expect(skipped).toBe(1);
  });

  it("keeps going past a record with an unparseable date", async () => {
    // History cannot be re-fetched. One bad row must never cost the rest.
    const { points, skipped, warnings } = await parse(
      doc(
        record({
          type: "HKQuantityTypeIdentifierStepCount",
          unit: "count",
          startDate: "not a date",
          endDate: "also not a date",
          value: "100",
        }) +
          record({
            type: "HKQuantityTypeIdentifierStepCount",
            unit: "count",
            startDate: "2026-08-26 08:00:00 -0700",
            endDate: "2026-08-26 08:05:00 -0700",
            value: "200",
          }),
      ),
    );

    expect(points).toHaveLength(1);
    expect(skipped).toBe(1);
    expect(warnings.join(" ")).toMatch(/Unparseable startDate/);
  });
});

/* ------------------------------------------------------------------- sleep -- */

describe("HealthExportParser sleep", () => {
  const phase = (value: string, start: string, end: string) =>
    record({
      type: "HKCategoryTypeIdentifierSleepAnalysis",
      sourceName: "Apple Watch",
      startDate: start,
      endDate: end,
      value: value,
    });

  it("rebuilds a night from loose phase records", async () => {
    const { sleep } = await parse(
      doc(
        phase("HKCategoryValueSleepAnalysisAsleepCore", "2026-08-25 23:30:00 -0700", "2026-08-26 01:00:00 -0700") +
          phase("HKCategoryValueSleepAnalysisAsleepDeep", "2026-08-26 01:00:00 -0700", "2026-08-26 02:00:00 -0700") +
          phase("HKCategoryValueSleepAnalysisAsleepREM", "2026-08-26 02:00:00 -0700", "2026-08-26 03:00:00 -0700") +
          phase("HKCategoryValueSleepAnalysisAsleepCore", "2026-08-26 03:00:00 -0700", "2026-08-26 06:30:00 -0700"),
      ),
    );

    expect(sleep).toHaveLength(1);
    const night = sleep[0];
    // Filed under the evening it began, matching `nightOfDate` and the Health
    // Auto Export path — the same night must not get two different dates
    // depending on which way it was imported.
    expect(night.date).toBe("2026-08-25");
    expect(night.deepMin).toBeCloseTo(60, 0);
    expect(night.remMin).toBeCloseTo(60, 0);
    expect(night.coreMin).toBeCloseTo(300, 0);
    expect(night.totalSleepMin).toBeCloseTo(420, 0);
  });

  it("does not merge a nap into a night that shares its date", async () => {
    const { sleep } = await parse(
      doc(
        // An early-evening nap and the night that follows it both fall under
        // night-of 2026-08-25, so only the gap rule can separate them —
        // exactly the case that would otherwise report a ten-hour night.
        phase("HKCategoryValueSleepAnalysisAsleepCore", "2026-08-25 20:00:00 -0700", "2026-08-25 20:40:00 -0700") +
          phase("HKCategoryValueSleepAnalysisAsleepCore", "2026-08-26 00:00:00 -0700", "2026-08-26 06:00:00 -0700"),
      ),
    );

    expect(sleep).toHaveLength(2);
    expect(sleep.every((s) => s.date === "2026-08-25")).toBe(true);
    expect(sleep.map((s) => Math.round(s.totalSleepMin)).sort((a, b) => a - b)).toEqual([40, 360]);
  });

  it("keeps a phone's in-bed record separate from the watch's staged sleep", async () => {
    // `sleep_sessions` is unique on (date, source_name); merging these would
    // drop one of them on insert.
    const { sleep } = await parse(
      doc(
        phase("HKCategoryValueSleepAnalysisAsleepCore", "2026-08-26 00:00:00 -0700", "2026-08-26 06:00:00 -0700") +
          record({
            type: "HKCategoryTypeIdentifierSleepAnalysis",
            sourceName: "iPhone",
            startDate: "2026-08-25 23:40:00 -0700",
            endDate: "2026-08-26 06:20:00 -0700",
            value: "HKCategoryValueSleepAnalysisInBed",
          }),
      ),
    );


    expect(sleep).toHaveLength(2);
    expect(new Set(sleep.map((s) => s.sourceName))).toEqual(
      new Set(["Apple Watch", "iPhone"]),
    );
  });
});

/* ---------------------------------------------------------------- workouts -- */

describe("HealthExportParser workouts", () => {
  it("reads a modern workout with WorkoutStatistics children", async () => {
    const { workouts_parsed } = await parse(
      doc(`<Workout workoutActivityType="HKWorkoutActivityTypeRunning"
                    duration="32.5" durationUnit="min"
                    sourceName="Apple Watch"
                    startDate="2026-08-26 07:00:00 -0700"
                    endDate="2026-08-26 07:32:30 -0700">
             <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="320" unit="kcal"/>
             <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" sum="5.2" unit="km"/>
             <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="148" maximum="171" unit="count/min"/>
             <MetadataEntry key="HKIndoorWorkout" value="0"/>
           </Workout>`),
    );

    expect(workouts_parsed).toHaveLength(1);
    expect(workouts_parsed[0]).toMatchObject({
      name: "Running",
      date: "2026-08-26",
      durationSec: 1950,
      activeEnergyKcal: 320,
      avgHeartRate: 148,
      maxHeartRate: 171,
      sourceName: "Apple Watch",
    });
    // km → m, because that's what the schema stores.
    expect(workouts_parsed[0].distanceM).toBeCloseTo(5200, 0);
  });

  it("reads a pre-iOS 16 workout with totals on the element", async () => {
    // Both shapes appear in one file when a history spans that upgrade.
    const { workouts_parsed } = await parse(
      doc(`<Workout workoutActivityType="HKWorkoutActivityTypeCycling"
                    duration="45" durationUnit="min"
                    totalEnergyBurned="410" totalEnergyBurnedUnit="kcal"
                    totalDistance="18.4" totalDistanceUnit="km"
                    startDate="2019-05-04 17:00:00 -0700"
                    endDate="2019-05-04 17:45:00 -0700"/>`),
    );

    expect(workouts_parsed[0]).toMatchObject({
      name: "Cycling",
      activeEnergyKcal: 410,
    });
    expect(workouts_parsed[0].distanceM).toBeCloseTo(18400, 0);
  });

  it("gives a workout a stable id so re-importing updates it", async () => {
    const xml = doc(`<Workout workoutActivityType="HKWorkoutActivityTypeRunning"
                              duration="30" durationUnit="min"
                              startDate="2026-08-26 07:00:00 -0700"
                              endDate="2026-08-26 07:30:00 -0700"/>`);
    const a = await parse(xml);
    const b = await parse(xml);
    expect(a.workouts_parsed[0].id).toBe(b.workouts_parsed[0].id);
  });

  it("drops GPS routes unless they are explicitly asked for", async () => {
    const xml = doc(`<Workout workoutActivityType="HKWorkoutActivityTypeRunning"
                              duration="30" durationUnit="min"
                              startDate="2026-08-26 07:00:00 -0700"
                              endDate="2026-08-26 07:30:00 -0700">
             <WorkoutRoute sourceName="Apple Watch" startDate="2026-08-26 07:00:00 -0700" endDate="2026-08-26 07:30:00 -0700">
               <Location latitude="37.7749" longitude="-122.4194" altitude="12" date="2026-08-26 07:00:05 -0700"/>
               <Location latitude="37.7750" longitude="-122.4195" altitude="13" date="2026-08-26 07:00:10 -0700"/>
             </WorkoutRoute>
           </Workout>`);

    const off = await parse(xml);
    expect(off.workouts_parsed[0].route).toBeNull();

    const on = await parse(xml, { storeRoutes: true });
    expect(on.workouts_parsed[0].route).toHaveLength(2);
  });
});

/* ---------------------------------------------------------------- streaming -- */

describe("HealthExportParser streaming", () => {
  it("produces the same result whether fed whole or split mid-element", async () => {
    // The real importer feeds 64KB chunks that land in the middle of tags.
    const xml = doc(
      Array.from({ length: 50 }, (_, i) =>
        record({
          type: "HKQuantityTypeIdentifierStepCount",
          unit: "count",
          startDate: `2026-08-26 08:${String(i).padStart(2, "0")}:00 -0700`,
          endDate: `2026-08-26 08:${String(i).padStart(2, "0")}:30 -0700`,
          value: String(i * 10),
        }),
      ).join("\n"),
    );

    const whole = await parse(xml);

    const chunked: NormalizedPoint[] = [];
    const parser = new HealthExportParser({
      timeZone: TZ,
      batchSize: 7,
      onPoints: async (batch) => {
        chunked.push(...batch);
      },
    });
    for (let i = 0; i < xml.length; i += 17) {
      await parser.write(xml.slice(i, i + 17));
    }
    await parser.finish();

    expect(chunked).toHaveLength(whole.points.length);
    expect(chunked.map((p) => p.value)).toEqual(whole.points.map((p) => p.value));
  });

  it("applies backpressure: never buffers more than one batch ahead of the writer", async () => {
    // The failure this prevents is the whole reason for streaming — SAX parses
    // at disk speed, SQLite writes at database speed, and without awaiting the
    // consumer the difference accumulates in memory until the process dies.
    let inFlight = 0;
    let maxInFlight = 0;
    let maxBatch = 0;

    const parser = new HealthExportParser({
      timeZone: TZ,
      batchSize: 10,
      onPoints: async (batch) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        maxBatch = Math.max(maxBatch, batch.length);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
      },
    });

    const xml = doc(
      Array.from({ length: 100 }, (_, i) =>
        record({
          type: "HKQuantityTypeIdentifierStepCount",
          unit: "count",
          startDate: `2026-08-26 0${i % 9}:00:00 -0700`,
          endDate: `2026-08-26 0${i % 9}:00:30 -0700`,
          value: String(i),
        }),
      ).join(""),
    );

    // 200-byte chunks: several records land per write, so the buffer is
    // checked mid-document rather than only at the end.
    for (let i = 0; i < xml.length; i += 200) {
      await parser.write(xml.slice(i, i + 200));
    }
    const result = await parser.finish();

    expect(maxInFlight).toBe(1);
    expect(maxBatch).toBeLessThanOrEqual(30);
    expect(result.points).toBe(100); // the emitted count, not the array
  });

  it("reports the export date and record counts", async () => {
    const result = await parse(
      doc(
        record({
          type: "HKQuantityTypeIdentifierStepCount",
          unit: "count",
          startDate: "2026-08-26 08:00:00 -0700",
          endDate: "2026-08-26 08:05:00 -0700",
          value: "437",
        }),
      ),
    );
    expect(result.exportDate).toBe("2026-08-27 09:00:00 -0700");
    expect(result.records).toBe(1);
    expect(result.bytesRead).toBeGreaterThan(0);
  });
});
