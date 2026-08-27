import { listHabitsWithProgress } from "@/db/queries/habits";
import { listJournalForAI } from "@/db/queries/journal";
import {
  correlate,
  correlateSleepWithMetric,
  getMetricSeries,
  getMetricStats,
  getSleepNights,
  getWorkouts,
  listMetrics,
} from "@/db/queries/metrics";
import { describeSchedule } from "@/lib/habits/streak";
import { addDays, daysBetween, type DayString } from "@/lib/time/day";

/**
 * The bounded query layer the AI coach reads through.
 *
 * The governing constraint: **150 metrics × years of daily values is roughly
 * 2.7 million tokens.** None of it can go in a prompt. So the coach gets no
 * data up front — it calls these functions, and each one is shaped to return
 * the smallest thing that answers the question.
 *
 * Three rules run through all of it:
 *
 *  - **Round aggressively.** A raw float64 step count is twelve tokens of pure
 *    noise. Nobody needs `9412.000000000002`.
 *  - **Cap and say so.** Every function that could return a long series
 *    downsamples and reports that it did, so the model knows it is looking at
 *    weekly means rather than silently mistaking them for days.
 *  - **Compute the statistics here.** Language models are unreliable at
 *    arithmetic over dozens of numbers, and a fabricated correlation
 *    coefficient is exactly the confident-sounding wrong answer that would
 *    make this feature worse than useless.
 *
 * These are plain async functions, not tool objects, so they can be tested
 * without an API key. `tools.ts` wraps them.
 */

/** Keeps tool results small; a raw float is mostly noise. */
function round(v: number | null | undefined, places = 1): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

/** Guard against a model asking for a decade. */
function clampRange(
  from: DayString,
  to: DayString,
  maxDays = 400,
): { from: DayString; to: DayString; clamped: boolean } {
  const span = daysBetween(from, to);
  if (span <= maxDays) return { from, to, clamped: false };
  return { from: addDays(to, -maxDays), to, clamped: true };
}

/* -------------------------------------------------------------------------- */

/**
 * The metric registry: what exists, in what unit, over what range.
 *
 * Deliberately the first thing the coach should call. It is small (~40 rows
 * for a real user, since only metrics with data appear) and it stops the model
 * guessing at metric keys that don't exist.
 */
export async function toolListMetrics(): Promise<{
  metrics: {
    key: string;
    name: string;
    unit: string;
    category: string;
    aggregation: string;
    from: string | null;
    to: string | null;
    days: number;
  }[];
  note: string;
}> {
  const metrics = await listMetrics();
  return {
    metrics: metrics.map((m) => ({
      key: m.key,
      name: m.displayName,
      unit: m.unit,
      category: m.category,
      aggregation: m.agg,
      from: m.firstDate,
      to: m.lastDate,
      days: m.dayCount,
    })),
    note:
      "Values are stored in the unit shown. Use `metric_stats` before " +
      "`metric_series` — stats are far smaller and usually enough.",
  };
}

/**
 * Summary statistics plus the preceding window of equal length.
 *
 * The cheapest useful tool, at roughly forty tokens per metric. "62 bpm" says
 * nothing on its own; "62 bpm, 8% above the previous 30 days" says a lot.
 */
export async function toolMetricStats(input: {
  metric_keys: string[];
  start_date: string;
  end_date: string;
}): Promise<{
  range: { start: string; end: string };
  stats: Record<string, unknown>[];
  missing: string[];
}> {
  const { from, to } = clampRange(input.start_date, input.end_date);
  const stats: Record<string, unknown>[] = [];
  const missing: string[] = [];

  for (const key of input.metric_keys.slice(0, 12)) {
    const s = await getMetricStats(key, from, to);
    if (!s) {
      missing.push(key);
      continue;
    }
    stats.push({
      key: s.key,
      name: s.displayName,
      unit: s.unit,
      mean: round(s.mean),
      median: round(s.median),
      min: round(s.min),
      max: round(s.max),
      days_with_data: s.n,
      days_in_range: s.days,
      previous_period_mean: round(s.previousMean),
      change_pct: round(s.changePct),
    });
  }

  return { range: { start: from, end: to }, stats, missing };
}

/**
 * A daily series, coarsened when the range is long.
 *
 * A year of daily values is ~365 rows and several thousand tokens; the same
 * year as weekly means is 52 rows. The response says which it gave, because a
 * model that mistook weekly means for daily values would draw badly wrong
 * conclusions about variability.
 */
export async function toolMetricSeries(input: {
  metric_key: string;
  start_date: string;
  end_date: string;
  granularity?: "day" | "week";
}): Promise<Record<string, unknown>> {
  const { from, to, clamped } = clampRange(input.start_date, input.end_date);
  const series = await getMetricSeries(input.metric_key, from, to);
  if (!series) {
    return { error: `No metric named "${input.metric_key}". Call list_metrics.` };
  }

  const MAX_POINTS = 120;
  const dayCount = series.points.length;
  const wantWeekly =
    input.granularity === "week" || dayCount > MAX_POINTS;

  if (!wantWeekly) {
    return {
      key: series.key,
      unit: series.unit,
      granularity: "day",
      range_clamped: clamped,
      points: series.points
        .filter((p) => p.value !== null)
        .map((p) => ({ d: p.date, v: round(p.value) })),
    };
  }

  // Weekly means over available values only — a gap thins the window rather
  // than being counted as a zero.
  const buckets = new Map<string, number[]>();
  for (const p of series.points) {
    if (p.value === null) continue;
    const weekStart = addDays(p.date, -((daysBetween(from, p.date) % 7) + 0));
    const key = weekStart;
    const list = buckets.get(key) ?? [];
    list.push(p.value);
    buckets.set(key, list);
  }

  return {
    key: series.key,
    unit: series.unit,
    granularity: "week",
    range_clamped: clamped,
    note:
      "Weekly means, not daily values — the requested range was too long to " +
      "return day by day.",
    points: [...buckets.entries()].map(([week, values]) => ({
      week_starting: week,
      mean: round(values.reduce((a, b) => a + b, 0) / values.length),
      n: values.length,
    })),
  };
}

/** Nightly sleep with its stage breakdown. */
export async function toolGetSleep(input: {
  start_date: string;
  end_date: string;
}): Promise<Record<string, unknown>> {
  const { from, to } = clampRange(input.start_date, input.end_date, 180);
  const nights = await getSleepNights(from, to);

  return {
    range: { start: from, end: to },
    nights_recorded: nights.length,
    average_hours: round(
      nights.reduce((s, n) => s + n.totalSleepMin, 0) / (nights.length || 1) / 60,
      2,
    ),
    // Minutes are converted to hours here: the model reasons about sleep in
    // hours, and making it divide 437 by 60 repeatedly invites arithmetic slips.
    nights: nights.map((n) => ({
      date: n.date,
      hours: round(n.totalSleepMin / 60, 2),
      deep_h: round((n.deepMin ?? 0) / 60, 2),
      rem_h: round((n.remMin ?? 0) / 60, 2),
      awake_h: round((n.awakeMin ?? 0) / 60, 2),
      efficiency_pct: round((n.efficiency ?? 0) * 100, 0),
    })),
  };
}

/** Habits with streaks and completion rates. */
export async function toolGetHabits(): Promise<Record<string, unknown>> {
  const habits = await listHabitsWithProgress();
  return {
    habits: habits.map((h) => ({
      name: h.name,
      schedule: describeSchedule(h),
      current_streak: h.streak.current,
      longest_streak: h.streak.longest,
      completion_rate_pct: round(h.streak.completionRate * 100, 0),
      done_today: h.todayCount >= h.targetPerDay,
    })),
  };
}

/**
 * Journal entries — **excluding anything marked private**.
 *
 * The exclusion happens in the SQL of `listJournalForAI`, not here and
 * certainly not in the prompt. A privacy control the model could choose to
 * ignore would not be one.
 */
export async function toolGetJournal(input: {
  start_date: string;
  end_date: string;
  limit?: number;
}): Promise<Record<string, unknown>> {
  const { from, to } = clampRange(input.start_date, input.end_date, 180);
  const entries = await listJournalForAI(
    from,
    to,
    Math.min(input.limit ?? 20, 40),
  );

  return {
    range: { start: from, end: to },
    note: "Entries the user marked private are never returned here.",
    entries: entries.map((e) => ({
      date: e.date,
      mood: e.mood,
      energy: e.energy,
      tags: e.tags,
      // Truncated: a long journal is the easiest way to blow the budget, and
      // the first 400 characters carry the gist.
      text: e.body.length > 400 ? `${e.body.slice(0, 400)}…` : e.body,
    })),
  };
}

/** Workouts over a range. */
export async function toolGetWorkouts(input: {
  start_date: string;
  end_date: string;
}): Promise<Record<string, unknown>> {
  const { from, to } = clampRange(input.start_date, input.end_date, 180);
  const workouts = await getWorkouts(from, to, 50);

  return {
    range: { start: from, end: to },
    count: workouts.length,
    workouts: workouts.map((w) => ({
      date: w.date,
      type: w.name,
      minutes: round(w.durationSec / 60, 0),
      kcal: round(w.activeEnergyKcal, 0),
      km: round((w.distanceM ?? 0) / 1000, 2),
      avg_hr: round(w.avgHeartRate, 0),
    })),
  };
}

/**
 * Correlation between two metrics, or between sleep and a metric.
 *
 * The highest-value tool here: it answers "does my sleep predict my resting
 * heart rate?" in about twenty tokens, where the raw data would be 1,460
 * numbers. `lag_days: 1` is the interesting case — *last night's* sleep
 * against *today's* reading.
 */
export async function toolCorrelate(input: {
  metric_a: string;
  metric_b: string;
  start_date: string;
  end_date: string;
  lag_days?: number;
}): Promise<Record<string, unknown>> {
  const { from, to } = clampRange(input.start_date, input.end_date);
  const lag = Math.max(-7, Math.min(7, input.lag_days ?? 0));

  const isSleep = (k: string): boolean =>
    /^(sleep|sleep_duration|sleep_hours)$/i.test(k);

  const result = isSleep(input.metric_a)
    ? await correlateSleepWithMetric(input.metric_b, from, to, lag)
    : isSleep(input.metric_b)
      ? await correlateSleepWithMetric(input.metric_a, from, to, -lag)
      : await correlate(input.metric_a, input.metric_b, from, to, lag);

  if (!result) {
    return { error: "One of those metrics does not exist. Call list_metrics." };
  }

  const r = result.r;
  const strength =
    r === null
      ? "unknown"
      : Math.abs(r) >= 0.5
        ? "strong"
        : Math.abs(r) >= 0.3
          ? "moderate"
          : Math.abs(r) >= 0.15
            ? "weak"
            : "negligible";

  return {
    metric_a: result.keyA,
    metric_b: result.keyB,
    lag_days: result.lagDays,
    r: round(r, 3),
    n: result.n,
    strength,
    // Stated in the payload so the caveat travels with the number rather than
    // depending on the model to remember it.
    caveat:
      result.n < 20
        ? "Too few paired days to be meaningful — do not present this as a finding."
        : "Correlation, not causation. One person's data is a small sample.",
  };
}
