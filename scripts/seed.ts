/**
 * Generate a plausible synthetic history so the app can be built and demoed
 * without waiting months for real data to accumulate.
 *
 * Two things make this more than random noise:
 *
 *  1. **Deterministic.** A fixed PRNG seed means the same database every run,
 *     so a chart that looks wrong stays wrong long enough to debug.
 *  2. **Genuinely correlated.** Short sleep raises next-day resting heart rate
 *     and suppresses steps; hard workouts cost sleep that night; weekends run
 *     later and lazier. Without real structure the AI coach and the
 *     `correlate` tool can only ever report noise, and you'd have no way to
 *     tell a working implementation from a broken one.
 *
 * Usage:  npm run seed -- [--days 550] [--reset]
 */

import { client } from "../src/db/index";
import { rebuildRollups } from "../src/db/rollups";
import { describeMetric } from "../src/lib/metrics/catalog";
import {
  USER_TIMEZONE,
  addDays,
  localDay,
  nightOfDate,
  startOfLocalDayMs,
  todayLocal,
} from "../src/lib/time/day";

/**
 * Build a UTC instant from a local wall-clock time on a given day.
 *
 * The seed previously composed timestamps as `Date.parse(`${date}T08:00:00Z`)`,
 * i.e. in UTC. Rendered back in the user's timezone that shifted everything by
 * their offset — a 23:24 bedtime displayed as 19:24, and the whole night landed
 * on the wrong side of the night-of boundary. Synthetic data that misrepresents
 * the app's own timezone handling is worse than no data, because it makes
 * correct code look broken.
 */
function localInstant(date: string, hoursFromMidnight: number): number {
  return startOfLocalDayMs(date, TZ) + Math.round(hoursFromMidnight * 3_600_000);
}

/* ------------------------------------------------------------------ config */

const args = process.argv.slice(2);
const DAYS = Number(
  args.find((a) => a.startsWith("--days="))?.split("=")[1] ??
    (args.includes("--days") ? args[args.indexOf("--days") + 1] : 550),
);
const RESET = args.includes("--reset");
// The shared constant rather than a third default: this file previously said
// America/New_York while day.ts and next.config.ts said UTC, so seeding with
// USER_TIMEZONE unset wrote data bucketed in one zone and rendered it in
// another.
const TZ = USER_TIMEZONE;

/* --------------------------------------------------------------------- rng */

/** mulberry32 — small, fast, and deterministic across Node versions. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = makeRng(20260826);

/** Box–Muller. Real biometrics are normal-ish, not uniform. */
function gauss(mean: number, sd: number): number {
  const u = Math.max(rng(), 1e-9);
  const v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/* ------------------------------------------------------------------ helpers */

const metricIds = new Map<string, number>();

async function ensureMetric(key: string, unitHint?: string): Promise<number> {
  const cached = metricIds.get(key);
  if (cached) return cached;

  const d = describeMetric(key, unitHint);
  await client.execute({
    sql: `INSERT INTO metric_types
            (key, display_name, canonical_unit, category, agg, source, pinned)
          VALUES (?, ?, ?, ?, ?, 'apple_health', ?)
          ON CONFLICT (key) DO UPDATE SET display_name = excluded.display_name`,
    args: [d.key, d.displayName, d.canonicalUnit, d.category, d.agg, d.pinned ? 1 : 0],
  });
  const r = await client.execute({
    sql: "SELECT id FROM metric_types WHERE key = ?",
    args: [key],
  });
  const id = Number(r.rows[0].id);
  metricIds.set(key, id);
  return id;
}

interface PendingPoint {
  metricTypeId: number;
  startAt: number;
  endAt: number;
  grain: "sample" | "hourly" | "daily";
  localDate: string;
  tzOffsetMinutes: number;
  value: number;
  valueMin: number | null;
  valueMax: number | null;
  unit: string;
  sourceName: string;
}

const buffer: PendingPoint[] = [];

function push(p: Omit<PendingPoint, "endAt"> & { endAt?: number }): void {
  buffer.push({ ...p, endAt: p.endAt ?? p.startAt });
}

/** Batched inserts — one statement per row over 100k rows is unusably slow. */
async function flush(): Promise<number> {
  if (buffer.length === 0) return 0;
  let written = 0;

  const CHUNK = 500;
  for (let i = 0; i < buffer.length; i += CHUNK) {
    const chunk = buffer.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "(?,?,?,?,?,?,?,?,?,?,?)").join(",");
    const args: (string | number | null)[] = [];
    for (const p of chunk) {
      args.push(
        p.metricTypeId, p.startAt, p.endAt, p.grain, p.localDate,
        p.tzOffsetMinutes, p.value, p.valueMin, p.valueMax, p.unit, p.sourceName,
      );
    }
    await client.execute({
      sql: `INSERT INTO metric_points
              (metric_type_id, start_at, end_at, grain, local_date,
               tz_offset_minutes, value, value_min, value_max, unit, source_name)
            VALUES ${placeholders}
            ON CONFLICT (metric_type_id, grain, start_at, source_name)
            DO UPDATE SET value = excluded.value`,
      args,
    });
    written += chunk.length;
  }
  buffer.length = 0;
  return written;
}

/* -------------------------------------------------------------------- main */

async function main(): Promise<void> {
  console.log(`Seeding ${DAYS} days of synthetic history (tz: ${TZ})`);

  if (RESET) {
    console.log("  clearing existing data…");
    for (const t of [
      "daily_metrics", "metric_points", "sleep_sessions", "workouts",
      "habit_entries", "habits", "journal_entries", "insights",
      "chat_messages", "ingest_log", "metric_types",
    ]) {
      await client.execute(`DELETE FROM ${t}`);
    }
    metricIds.clear();
  }

  const today = todayLocal(TZ);
  const startDate = addDays(today, -DAYS + 1);

  const ids = {
    steps: await ensureMetric("step_count", "count"),
    activeEnergy: await ensureMetric("active_energy", "kcal"),
    exercise: await ensureMetric("apple_exercise_time", "min"),
    distance: await ensureMetric("walking_running_distance", "km"),
    restingHr: await ensureMetric("resting_heart_rate", "bpm"),
    hrv: await ensureMetric("heart_rate_variability", "ms"),
    heartRate: await ensureMetric("heart_rate", "bpm"),
    weight: await ensureMetric("weight_body_mass", "kg"),
    spo2: await ensureMetric("blood_oxygen_saturation", "%"),
    respiratory: await ensureMetric("respiratory_rate", "bpm"),
    water: await ensureMetric("dietary_water", "mL"),
    caffeine: await ensureMetric("dietary_caffeine", "mg"),
    mindful: await ensureMetric("mindful_minutes", "min"),
    daylight: await ensureMetric("time_in_daylight", "min"),
  };

  /* ---- carried state, so days depend on the days before them ---- */
  let weightKg = 84.5;
  let fitness = 0; // slow drift; pushes resting HR down and HRV up over time
  let prevSleepHours = 7.2;
  let prevWorkoutHard = false;

  const sleepRows: unknown[][] = [];
  const workoutRows: unknown[][] = [];
  const journalRows: unknown[][] = [];

  for (let i = 0; i < DAYS; i++) {
    const date = addDays(startDate, i);
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const isWeekend = dow === 0 || dow === 6;
    const progress = i / DAYS;

    // Gentle fitness improvement with a plateau in the middle third.
    fitness = clamp(progress * 1.6 - (progress > 0.35 && progress < 0.6 ? 0.3 : 0), 0, 1.4);

    /* ---------------------------------------------------------- sleep ---- */
    // Weekends run later and longer. A hard workout the previous day costs
    // some sleep — that's a correlation the coach should be able to surface.
    const bedBase = isWeekend ? 24.6 : 23.4;
    const bedHour = bedBase + gauss(0, 0.55) + (prevWorkoutHard ? 0.25 : 0);
    let sleepHours = clamp(
      gauss(isWeekend ? 8.0 : 7.05, 0.85) - (prevWorkoutHard ? 0.25 : 0),
      3.8,
      10.5,
    );
    // Occasional genuinely bad night — real data has outliers and the app
    // needs to render them without breaking.
    if (rng() < 0.045) sleepHours = clamp(sleepHours - gauss(2.4, 0.7), 3.0, 6);

    const bedMs = localInstant(date, bedHour);
    const wakeMs = bedMs + Math.round(sleepHours * 3_600_000);

    const inBed = sleepHours * (1 + Math.abs(gauss(0.07, 0.03)));
    const deep = sleepHours * clamp(gauss(0.16, 0.035), 0.06, 0.28);
    const rem = sleepHours * clamp(gauss(0.21, 0.04), 0.08, 0.33);
    const awake = (inBed - sleepHours) * 60;
    const core = sleepHours - deep - rem;

    sleepRows.push([
      nightOfDate(wakeMs, TZ), bedMs, wakeMs,
      +(sleepHours * 60).toFixed(1), +(sleepHours * 60).toFixed(1),
      +(core * 60).toFixed(1), +(deep * 60).toFixed(1), +(rem * 60).toFixed(1),
      +awake.toFixed(1), +(inBed * 60).toFixed(1),
      +(sleepHours / inBed).toFixed(4), "Apple Watch",
    ]);

    /* ------------------------------------------- vitals, driven by sleep --- */
    // The headline correlation: last night's short sleep shows up as elevated
    // resting HR and suppressed HRV today.
    const sleepDebt = clamp(7.5 - prevSleepHours, -1.5, 3.5);
    const restingHr = clamp(
      gauss(58 - fitness * 3.5, 1.6) + sleepDebt * 2.1,
      44, 78,
    );
    const hrv = clamp(
      gauss(48 + fitness * 9, 6.5) - sleepDebt * 5.2,
      14, 115,
    );

    const tzOff = 0;
    const noon = localInstant(date, 12);

    push({ metricTypeId: ids.restingHr, startAt: noon, grain: "daily", localDate: date, tzOffsetMinutes: tzOff, value: +restingHr.toFixed(1), valueMin: null, valueMax: null, unit: "bpm", sourceName: "Apple Watch" });
    push({ metricTypeId: ids.hrv, startAt: noon, grain: "daily", localDate: date, tzOffsetMinutes: tzOff, value: +hrv.toFixed(1), valueMin: null, valueMax: null, unit: "ms", sourceName: "Apple Watch" });
    push({ metricTypeId: ids.spo2, startAt: noon, grain: "daily", localDate: date, tzOffsetMinutes: tzOff, value: +clamp(gauss(97.4, 0.8), 92, 100).toFixed(1), valueMin: null, valueMax: null, unit: "%", sourceName: "Apple Watch" });
    push({ metricTypeId: ids.respiratory, startAt: noon, grain: "daily", localDate: date, tzOffsetMinutes: tzOff, value: +clamp(gauss(14.6, 1.1), 10, 22).toFixed(1), valueMin: null, valueMax: null, unit: "bpm", sourceName: "Apple Watch" });

    /* ------------------------------------------------------- activity ---- */
    // Tired days are less active, weekends more variable.
    const tiredPenalty = sleepDebt > 1 ? 0.82 : 1;
    const baseSteps = (isWeekend ? 7400 : 9200) * (1 + fitness * 0.1);
    const steps = Math.round(
      clamp(gauss(baseSteps, 2900) * tiredPenalty, 700, 27000),
    );

    // Hourly step buckets, so the app has intraday shape to chart — and so
    // `grain: 'hourly'` is exercised end-to-end the way a real push arrives.
    let remaining = steps;
    const weights = Array.from({ length: 17 }, (_, h) => {
      const hour = h + 6;
      const morning = Math.exp(-((hour - 8.5) ** 2) / 6);
      const lunch = Math.exp(-((hour - 12.8) ** 2) / 3.5) * 0.9;
      const evening = Math.exp(-((hour - 18.2) ** 2) / 7) * 1.15;
      return morning + lunch + evening + 0.08;
    });
    const wSum = weights.reduce((a, b) => a + b, 0);
    for (let h = 0; h < 17 && remaining > 0; h++) {
      const share = h === 16 ? remaining : Math.round((steps * weights[h]) / wSum);
      const v = Math.min(remaining, Math.max(0, share));
      remaining -= v;
      if (v <= 0) continue;
      push({
        metricTypeId: ids.steps,
        startAt: localInstant(date, h + 6),
        endAt: localInstant(date, h + 6) + 59 * 60_000 + 59_000,
        grain: "hourly", localDate: date, tzOffsetMinutes: tzOff,
        value: v, valueMin: null, valueMax: null,
        unit: "count", sourceName: "iPhone",
      });
    }

    const distanceM = steps * clamp(gauss(0.735, 0.03), 0.6, 0.9);
    const activeKcal = Math.round(steps * 0.043 + gauss(180, 70));
    const exerciseMin = Math.round(clamp(gauss(isWeekend ? 34 : 26, 18) + fitness * 8, 0, 150));

    push({ metricTypeId: ids.distance, startAt: noon, grain: "daily", localDate: date, tzOffsetMinutes: tzOff, value: +distanceM.toFixed(1), valueMin: null, valueMax: null, unit: "m", sourceName: "iPhone" });
    push({ metricTypeId: ids.activeEnergy, startAt: noon, grain: "daily", localDate: date, tzOffsetMinutes: tzOff, value: Math.max(60, activeKcal), valueMin: null, valueMax: null, unit: "kcal", sourceName: "Apple Watch" });
    push({ metricTypeId: ids.exercise, startAt: noon, grain: "daily", localDate: date, tzOffsetMinutes: tzOff, value: exerciseMin, valueMin: null, valueMax: null, unit: "min", sourceName: "Apple Watch" });
    push({ metricTypeId: ids.daylight, startAt: noon, grain: "daily", localDate: date, tzOffsetMinutes: tzOff, value: Math.round(clamp(gauss(isWeekend ? 95 : 58, 42), 0, 400)), valueMin: null, valueMax: null, unit: "min", sourceName: "Apple Watch" });

    // A handful of intraday heart-rate samples with Min/Avg/Max, matching the
    // shape Health Auto Export actually sends for this metric.
    for (let h = 7; h <= 22; h += 3) {
      const avg = clamp(gauss(restingHr + 18, 9), 48, 150);
      push({
        metricTypeId: ids.heartRate,
        startAt: localInstant(date, h),
        grain: "hourly", localDate: date, tzOffsetMinutes: tzOff,
        value: +avg.toFixed(1),
        valueMin: +clamp(avg - Math.abs(gauss(9, 4)), 40, 200).toFixed(1),
        valueMax: +clamp(avg + Math.abs(gauss(16, 8)), 40, 200).toFixed(1),
        unit: "bpm", sourceName: "Apple Watch",
      });
    }

    /* -------------------------------------------------------- workouts --- */
    const willWork = rng() < (isWeekend ? 0.55 : 0.38);
    let hardToday = false;
    if (willWork) {
      const kinds = [
        { name: "Running", minM: 22, maxM: 62, hard: true },
        { name: "Outdoor Walk", minM: 25, maxM: 70, hard: false },
        { name: "Traditional Strength Training", minM: 30, maxM: 65, hard: true },
        { name: "Cycling", minM: 30, maxM: 95, hard: true },
        { name: "Yoga", minM: 20, maxM: 55, hard: false },
        { name: "HIIT", minM: 15, maxM: 35, hard: true },
      ];
      const k = kinds[Math.floor(rng() * kinds.length)];
      hardToday = k.hard;
      const durMin = k.minM + rng() * (k.maxM - k.minM);
      const startH = isWeekend ? 9 + rng() * 5 : rng() < 0.5 ? 6.5 + rng() * 1.5 : 17.5 + rng() * 2;
      const wStart = localInstant(date, startH);
      const wEnd = wStart + Math.round(durMin * 60_000);
      const avgHr = clamp(gauss(k.hard ? 148 : 112, 12), 80, 185);

      workoutRows.push([
        `seed-${date}-${k.name.replace(/\s+/g, "-").toLowerCase()}`,
        localDay(wStart, TZ), k.name, wStart, wEnd, Math.round(durMin * 60),
        Math.round(durMin * (k.hard ? 11.2 : 5.4) + gauss(0, 25)),
        /Run|Walk|Cycl/.test(k.name) ? Math.round(durMin * (k.name === "Cycling" ? 330 : 145)) : null,
        +avgHr.toFixed(1), +clamp(avgHr + Math.abs(gauss(22, 9)), 90, 200).toFixed(1),
        "Apple Watch",
      ]);
    }

    /* ---------------------------------------------------------- body ----- */
    // A slowly falling baseline plus bounded day-to-day water-weight noise —
    // NOT a random walk. Accumulating noise (σ≈0.16/day) would drift ±3.7kg
    // over 550 days and swamp the ~2.5kg trend entirely, which is both
    // unrealistic and useless for testing a trend line.
    const weightBaseline = 84.5 - 2.5 * progress;
    weightKg = clamp(weightBaseline + gauss(0, 0.45), 74, 92);
    if (rng() < 0.62) {
      push({
        metricTypeId: ids.weight,
        startAt: localInstant(date, 7 + 20 / 60),
        grain: "daily", localDate: date, tzOffsetMinutes: tzOff,
        value: +weightKg.toFixed(2), valueMin: null, valueMax: null,
        unit: "kg", sourceName: "Withings",
      });
    }

    /* ------------------------------------------------------ intake etc --- */
    push({ metricTypeId: ids.water, startAt: noon, grain: "daily", localDate: date, tzOffsetMinutes: tzOff, value: Math.round(clamp(gauss(1900, 620), 200, 4200)), valueMin: null, valueMax: null, unit: "mL", sourceName: "iPhone" });
    push({ metricTypeId: ids.caffeine, startAt: noon, grain: "daily", localDate: date, tzOffsetMinutes: tzOff, value: Math.round(clamp(gauss(isWeekend ? 130 : 215, 85), 0, 520)), valueMin: null, valueMax: null, unit: "mg", sourceName: "iPhone" });
    if (rng() < 0.42) {
      push({ metricTypeId: ids.mindful, startAt: noon, grain: "daily", localDate: date, tzOffsetMinutes: tzOff, value: Math.round(clamp(gauss(12, 6), 3, 45)), valueMin: null, valueMax: null, unit: "min", sourceName: "iPhone" });
    }

    /* -------------------------------------------------------- journal ---- */
    // Not every day — nobody journals daily, and the coach should cope with
    // a sparse record.
    if (rng() < 0.42) {
      const good = sleepHours > 7.4 && steps > 8000;
      const rough = sleepHours < 6 || sleepDebt > 1.6;
      const moodScore = clamp(Math.round(gauss(good ? 4.2 : rough ? 2.4 : 3.4, 0.75)), 1, 5);
      const energyScore = clamp(Math.round(gauss(good ? 4.1 : rough ? 2.2 : 3.3, 0.8)), 1, 5);

      const goodLines = [
        "Slept properly and it showed — got through the deep work block without stalling.",
        "Long walk at lunch. Head felt clear all afternoon.",
        "Good session at the gym, ate properly, actually stopped working at six.",
      ];
      const roughLines = [
        "Up half the night. Ran on coffee and it caught up with me by 3pm.",
        "Bad sleep again. Skipped the workout, which I always regret.",
        "Deadline stress. Too much caffeine, went to bed wired.",
      ];
      const midLines = [
        "Ordinary day. Nothing much to report.",
        "Busy but fine. Walked a bit, ate okay.",
        "Slow start, decent finish.",
      ];
      const pool = good ? goodLines : rough ? roughLines : midLines;
      journalRows.push([
        date, pool[Math.floor(rng() * pool.length)], moodScore, energyScore,
        JSON.stringify(good ? ["good-day"] : rough ? ["tired"] : []),
      ]);
    }

    prevSleepHours = sleepHours;
    prevWorkoutHard = hardToday;
  }

  /* ----------------------------------------------------------- persist ---- */

  const points = await flush();
  console.log(`  metric_points:   ${points}`);

  for (let i = 0; i < sleepRows.length; i += 200) {
    const chunk = sleepRows.slice(i, i + 200);
    await client.execute({
      sql: `INSERT INTO sleep_sessions
              (date, start_at, end_at, total_sleep_min, asleep_min, core_min,
               deep_min, rem_min, awake_min, in_bed_min, efficiency, source_name)
            VALUES ${chunk.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?)").join(",")}
            ON CONFLICT (date, source_name) DO UPDATE SET
              total_sleep_min = excluded.total_sleep_min`,
      args: chunk.flat() as never,
    });
  }
  console.log(`  sleep_sessions:  ${sleepRows.length}`);

  for (let i = 0; i < workoutRows.length; i += 200) {
    const chunk = workoutRows.slice(i, i + 200);
    await client.execute({
      sql: `INSERT INTO workouts
              (id, date, name, start_at, end_at, duration_sec,
               active_energy_kcal, distance_m, avg_heart_rate, max_heart_rate, source_name)
            VALUES ${chunk.map(() => "(?,?,?,?,?,?,?,?,?,?,?)").join(",")}
            ON CONFLICT (id) DO NOTHING`,
      args: chunk.flat() as never,
    });
  }
  console.log(`  workouts:        ${workoutRows.length}`);

  for (const row of journalRows) {
    await client.execute({
      sql: `INSERT INTO journal_entries (date, body, mood, energy, tags)
            VALUES (?,?,?,?,?)
            ON CONFLICT (date) DO UPDATE SET body = excluded.body`,
      args: row as never,
    });
  }
  console.log(`  journal_entries: ${journalRows.length}`);

  /* ------------------------------------------------------------- habits --- */
  const habitDefs = [
    { name: "Move 30 min", emoji: "🏃", color: "emerald", schedule: "daily", rate: 0.68 },
    { name: "Read", emoji: "📚", color: "amber", schedule: "daily", rate: 0.55 },
    { name: "No phone in bed", emoji: "🌙", color: "indigo", schedule: "daily", rate: 0.44 },
    { name: "Strength training", emoji: "🏋️", color: "rose", schedule: "custom", rate: 0.72 },
    { name: "Journal", emoji: "✍️", color: "sky", schedule: "daily", rate: 0.42 },
  ];

  for (const [idx, h] of habitDefs.entries()) {
    await client.execute({
      sql: `INSERT INTO habits (name, emoji, color, schedule, days_mask, sort_order)
            VALUES (?,?,?,?,?,?)`,
      // Strength training runs Mon/Wed/Fri → bits 1, 3, 5 → 0b0101010 = 42.
      args: [h.name, h.emoji, h.color, h.schedule, h.schedule === "custom" ? 42 : 127, idx],
    });
    const hid = Number(
      (await client.execute({ sql: "SELECT id FROM habits WHERE name = ?", args: [h.name] }))
        .rows[0].id,
    );

    const entries: (string | number)[][] = [];
    for (let i = 0; i < DAYS; i++) {
      const date = addDays(startDate, i);
      const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
      if (h.schedule === "custom" && ![1, 3, 5].includes(dow)) continue;
      // Adherence improves slightly over time, with a slump in the middle —
      // otherwise every streak chart is a straight line and proves nothing.
      const slump = i / DAYS > 0.45 && i / DAYS < 0.58 ? 0.35 : 0;
      if (rng() < h.rate + (i / DAYS) * 0.12 - slump) entries.push([hid, date, 1]);
    }
    for (let i = 0; i < entries.length; i += 200) {
      const chunk = entries.slice(i, i + 200);
      await client.execute({
        sql: `INSERT INTO habit_entries (habit_id, date, count)
              VALUES ${chunk.map(() => "(?,?,?)").join(",")}
              ON CONFLICT (habit_id, date) DO NOTHING`,
        args: chunk.flat() as never,
      });
    }
    console.log(`  habit "${h.name}": ${entries.length} entries`);
  }

  /* ------------------------------------------------------------ rollups --- */
  console.log("  rebuilding daily rollups…");
  const rolled = await rebuildRollups();
  console.log(`  daily_metrics:   ${rolled}`);

  await client.execute({
    sql: `INSERT INTO ingest_log (source, status, finished_at, points_upserted,
                                  sleep_upserted, workouts_upserted, progress)
          VALUES ('seed', 'ok', unixepoch()*1000, ?, ?, ?, 100)`,
    args: [points, sleepRows.length, workoutRows.length],
  });

  console.log(`\nDone. ${startDate} → ${today}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
