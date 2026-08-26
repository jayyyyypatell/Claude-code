import { client } from "@/db/index";
import type { MetricAgg, MetricCategory } from "@/lib/metrics/catalog";
import { addDays, eachDay, todayLocal, type DayString } from "@/lib/time/day";

/**
 * The read layer.
 *
 * Everything user-facing reads from here, and everything here reads
 * `daily_metrics` rather than raw points — a year of one metric is ~365 rows
 * instead of ~500k. The same functions back the AI coach's tools in M4, which
 * is what keeps its context budget survivable.
 *
 * All SQL lives under `src/db/queries/` so a future move to Postgres is a
 * contained edit rather than a hunt through the codebase.
 */

export interface MetricSummary {
  id: number;
  key: string;
  displayName: string;
  unit: string;
  category: MetricCategory;
  agg: MetricAgg;
  pinned: boolean;
  firstDate: string | null;
  lastDate: string | null;
  dayCount: number;
}

/** Every metric that actually has data, with its available range. */
export async function listMetrics(): Promise<MetricSummary[]> {
  const r = await client.execute(`
    SELECT mt.id, mt.key, mt.display_name, mt.canonical_unit, mt.category,
           mt.agg, mt.pinned, mt.sort_order,
           MIN(dm.date) AS first_date,
           MAX(dm.date) AS last_date,
           COUNT(dm.date) AS day_count
    FROM metric_types mt
    JOIN daily_metrics dm ON dm.metric_type_id = mt.id
    WHERE mt.hidden = 0
    GROUP BY mt.id
    ORDER BY mt.pinned DESC, mt.sort_order, mt.display_name
  `);

  return r.rows.map((row) => ({
    id: Number(row.id),
    key: String(row.key),
    displayName: String(row.display_name),
    unit: String(row.canonical_unit ?? ""),
    category: String(row.category) as MetricCategory,
    agg: String(row.agg) as MetricAgg,
    pinned: Boolean(row.pinned),
    firstDate: row.first_date ? String(row.first_date) : null,
    lastDate: row.last_date ? String(row.last_date) : null,
    dayCount: Number(row.day_count),
  }));
}

export interface SeriesPoint {
  date: DayString;
  value: number | null;
  min: number | null;
  max: number | null;
}

export interface MetricSeries {
  key: string;
  displayName: string;
  unit: string;
  agg: MetricAgg;
  points: SeriesPoint[];
}

/**
 * A metric's daily values over a range.
 *
 * Missing days come back as `null` rather than being omitted. A gap is real
 * information — the watch was off the wrist — and silently closing it would
 * draw a straight line through a week that never happened.
 */
export async function getMetricSeries(
  metricKey: string,
  from: DayString,
  to: DayString,
): Promise<MetricSeries | null> {
  const meta = await client.execute({
    sql: `SELECT id, key, display_name, canonical_unit, agg
          FROM metric_types WHERE key = ?`,
    args: [metricKey],
  });
  if (meta.rows.length === 0) return null;
  const m = meta.rows[0];

  const rows = await client.execute({
    sql: `SELECT date, value, value_min, value_max
          FROM daily_metrics
          WHERE metric_type_id = ? AND date >= ? AND date <= ?
          ORDER BY date`,
    args: [Number(m.id), from, to],
  });

  const byDate = new Map(
    rows.rows.map((r) => [
      String(r.date),
      {
        value: r.value === null ? null : Number(r.value),
        min: r.value_min === null ? null : Number(r.value_min),
        max: r.value_max === null ? null : Number(r.value_max),
      },
    ]),
  );

  return {
    key: String(m.key),
    displayName: String(m.display_name),
    unit: String(m.canonical_unit ?? ""),
    agg: String(m.agg) as MetricAgg,
    points: eachDay(from, to).map((date) => ({
      date,
      value: byDate.get(date)?.value ?? null,
      min: byDate.get(date)?.min ?? null,
      max: byDate.get(date)?.max ?? null,
    })),
  };
}

export interface MetricStats {
  key: string;
  displayName: string;
  unit: string;
  agg: MetricAgg;
  /** Mean for `avg`/`last` metrics, daily total for `sum` metrics. */
  mean: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
  /** Days with data, and days in the requested range. */
  n: number;
  days: number;
  /** Same statistic over the immediately preceding window of equal length. */
  previousMean: number | null;
  /** Percent change vs the previous window. */
  changePct: number | null;
}

/**
 * Summary statistics for a metric, plus the same window shifted back.
 *
 * Comparing to your own recent baseline is what makes a number mean anything:
 * "62 bpm" says nothing, "62 bpm, up 8% on the last 30 days" says quite a lot.
 * This is deliberately compact — it is also the AI coach's cheapest tool, at
 * roughly forty tokens per metric instead of a year of daily rows.
 */
export async function getMetricStats(
  metricKey: string,
  from: DayString,
  to: DayString,
): Promise<MetricStats | null> {
  const series = await getMetricSeries(metricKey, from, to);
  if (!series) return null;

  const span = eachDay(from, to).length;
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(span - 1));
  const prev = await getMetricSeries(metricKey, prevFrom, prevTo);

  const values = series.points
    .map((p) => p.value)
    .filter((v): v is number => v !== null);
  const prevValues = (prev?.points ?? [])
    .map((p) => p.value)
    .filter((v): v is number => v !== null);

  const mean = (xs: number[]): number | null =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

  const median = (xs: number[]): number | null => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };

  const current = mean(values);
  const previous = mean(prevValues);

  return {
    key: series.key,
    displayName: series.displayName,
    unit: series.unit,
    agg: series.agg,
    mean: current,
    median: median(values),
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    n: values.length,
    days: span,
    previousMean: previous,
    changePct:
      current !== null && previous !== null && previous !== 0
        ? ((current - previous) / Math.abs(previous)) * 100
        : null,
  };
}

/**
 * Centred rolling mean.
 *
 * Daily health data is far too noisy to read raw — a 7-day window is what turns
 * a jagged step count into a visible trend. Windows are computed over available
 * values only, so a gap thins the window rather than poisoning it with zeros.
 */
export function rollingMean(
  points: SeriesPoint[],
  window = 7,
): (number | null)[] {
  const half = Math.floor(window / 2);
  return points.map((_, i) => {
    const slice = points
      .slice(Math.max(0, i - half), Math.min(points.length, i + half + 1))
      .map((p) => p.value)
      .filter((v): v is number => v !== null);
    // Require at least half the window, or the ends of the series wobble
    // wildly off one or two values and read as a real trend.
    if (slice.length < Math.max(2, Math.ceil(window / 2))) return null;
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
}

export interface SleepNight {
  date: DayString;
  startAt: number;
  endAt: number;
  totalSleepMin: number;
  deepMin: number | null;
  coreMin: number | null;
  remMin: number | null;
  awakeMin: number | null;
  inBedMin: number | null;
  efficiency: number | null;
}

/** Sleep nights over a range, most recent last. */
export async function getSleepNights(
  from: DayString,
  to: DayString,
): Promise<SleepNight[]> {
  const r = await client.execute({
    sql: `SELECT date, start_at, end_at, total_sleep_min, deep_min, core_min,
                 rem_min, awake_min, in_bed_min, efficiency
          FROM sleep_sessions
          WHERE date >= ? AND date <= ?
          ORDER BY date`,
    args: [from, to],
  });

  return r.rows.map((row) => ({
    date: String(row.date),
    startAt: Number(row.start_at),
    endAt: Number(row.end_at),
    totalSleepMin: Number(row.total_sleep_min ?? 0),
    deepMin: row.deep_min === null ? null : Number(row.deep_min),
    coreMin: row.core_min === null ? null : Number(row.core_min),
    remMin: row.rem_min === null ? null : Number(row.rem_min),
    awakeMin: row.awake_min === null ? null : Number(row.awake_min),
    inBedMin: row.in_bed_min === null ? null : Number(row.in_bed_min),
    efficiency: row.efficiency === null ? null : Number(row.efficiency),
  }));
}

export interface WorkoutRow {
  id: string;
  date: DayString;
  name: string;
  startAt: number;
  durationSec: number;
  activeEnergyKcal: number | null;
  distanceM: number | null;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
}

export async function getWorkouts(
  from: DayString,
  to: DayString,
  limit = 50,
): Promise<WorkoutRow[]> {
  const r = await client.execute({
    sql: `SELECT id, date, name, start_at, duration_sec, active_energy_kcal,
                 distance_m, avg_heart_rate, max_heart_rate
          FROM workouts
          WHERE date >= ? AND date <= ?
          ORDER BY start_at DESC
          LIMIT ?`,
    args: [from, to, limit],
  });

  return r.rows.map((row) => ({
    id: String(row.id),
    date: String(row.date),
    name: String(row.name),
    startAt: Number(row.start_at),
    durationSec: Number(row.duration_sec ?? 0),
    activeEnergyKcal:
      row.active_energy_kcal === null ? null : Number(row.active_energy_kcal),
    distanceM: row.distance_m === null ? null : Number(row.distance_m),
    avgHeartRate:
      row.avg_heart_rate === null ? null : Number(row.avg_heart_rate),
    maxHeartRate:
      row.max_heart_rate === null ? null : Number(row.max_heart_rate),
  }));
}

export interface SyncStatus {
  lastIngestAt: number | null;
  lastStatus: string | null;
  lastSource: string | null;
  warningCount: number;
  totalPoints: number;
  /**
   * The server's clock at the moment this request's data was read.
   *
   * Returned here rather than read inside a component. "How stale is this?" is
   * a property of the fetch, not of rendering — and a component that reads the
   * clock is impure, since its output changes without its inputs changing.
   * Anchoring the answer to the fetch also means the badge and the data it
   * describes cannot disagree about what time it is.
   */
  now: number;
}

/**
 * When the phone last pushed.
 *
 * Surfaced prominently because iOS decides when background automations
 * actually run — a sync-based app that can't answer "is this current?" quietly
 * erodes trust in every number on the screen.
 */
export async function getSyncStatus(): Promise<SyncStatus> {
  const last = await client.execute(`
    SELECT received_at, status, source, warnings
    FROM ingest_log
    WHERE status IN ('ok','partial')
    ORDER BY received_at DESC LIMIT 1
  `);
  const totals = await client.execute(
    "SELECT COUNT(*) AS n FROM metric_points",
  );

  const row = last.rows[0];
  let warningCount = 0;
  if (row?.warnings) {
    try {
      warningCount = (JSON.parse(String(row.warnings)) as string[]).length;
    } catch {
      warningCount = 0;
    }
  }

  return {
    lastIngestAt: row ? Number(row.received_at) : null,
    lastStatus: row ? String(row.status) : null,
    lastSource: row ? String(row.source) : null,
    warningCount,
    totalPoints: Number(totals.rows[0].n),
    now: Date.now(),
  };
}

/**
 * A metric's value for one day, plus how unusual that is against a trailing
 * baseline.
 *
 * The z-score is what lets the Today page lead with what's *different* rather
 * than showing the same grid of numbers every morning.
 */
export interface TodayMetric {
  key: string;
  displayName: string;
  unit: string;
  agg: MetricAgg;
  value: number | null;
  baseline: number | null;
  changePct: number | null;
  zScore: number | null;
  spark: (number | null)[];
  /**
   * The day `value` came from, when it isn't today.
   *
   * Only set for metrics that carry forward — you don't weigh yourself daily,
   * and showing an em-dash because today has no reading is strictly worse than
   * showing Monday's number and saying so.
   */
  asOf: DayString | null;
}

export async function getTodayMetrics(
  keys: string[],
  today: DayString = todayLocal(),
  baselineDays = 30,
): Promise<TodayMetric[]> {
  const out: TodayMetric[] = [];
  const from = addDays(today, -baselineDays);

  for (const key of keys) {
    const series = await getMetricSeries(key, from, today);
    if (!series) continue;

    let todayPoint = series.points.find((p) => p.date === today);
    let asOf: DayString | null = null;

    /**
     * Metrics whose value persists between readings carry the last one
     * forward. Weight and BMI are measured every few days at best; a blank
     * tile misrepresents that as missing data rather than as "unchanged since
     * Monday", and the reading is labelled with its date so it can't be
     * mistaken for today's.
     */
    if (!todayPoint?.value && series.agg === "last") {
      for (let i = series.points.length - 1; i >= 0; i--) {
        if (series.points[i].value != null) {
          todayPoint = series.points[i];
          asOf = series.points[i].date;
          break;
        }
      }
    }

    const history = series.points
      .filter((p) => p.date !== today)
      .map((p) => p.value)
      .filter((v): v is number => v !== null);

    const baseline = history.length
      ? history.reduce((a, b) => a + b, 0) / history.length
      : null;

    let zScore: number | null = null;
    if (baseline !== null && history.length > 3 && todayPoint?.value != null) {
      const variance =
        history.reduce((sum, v) => sum + (v - baseline) ** 2, 0) /
        history.length;
      const sd = Math.sqrt(variance);
      zScore = sd > 0 ? (todayPoint.value - baseline) / sd : null;
    }

    out.push({
      key: series.key,
      displayName: series.displayName,
      unit: series.unit,
      agg: series.agg,
      value: todayPoint?.value ?? null,
      baseline,
      changePct:
        todayPoint?.value != null && baseline !== null && baseline !== 0
          ? ((todayPoint.value - baseline) / Math.abs(baseline)) * 100
          : null,
      zScore,
      spark: series.points.slice(-14).map((p) => p.value),
      asOf,
    });
  }

  return out;
}

/** Pearson's r over paired values. Shared by both correlation entry points. */
function pearson(pairs: [number, number][]): number | null {
  const n = pairs.length;
  if (n < 3) return null;

  const meanA = pairs.reduce((s, [x]) => s + x, 0) / n;
  const meanB = pairs.reduce((s, [, y]) => s + y, 0) / n;

  let num = 0;
  let devA = 0;
  let devB = 0;
  for (const [x, y] of pairs) {
    const dx = x - meanA;
    const dy = y - meanB;
    num += dx * dy;
    devA += dx * dx;
    devB += dy * dy;
  }

  const denom = Math.sqrt(devA * devB);
  return denom === 0 ? null : num / denom;
}

export interface CorrelationResult {
  r: number | null;
  n: number;
  keyA: string;
  keyB: string;
  lagDays: number;
}

/**
 * Correlate a night's sleep duration against a metric on a later day.
 *
 * Sleep lives in its own table rather than the metric registry, so it needs its
 * own entry point. The lag is the important parameter and defaults to 1: the
 * question worth asking is whether *last night's* sleep predicts *today's*
 * resting heart rate. Correlating them same-day would mostly measure the
 * relationship running backwards.
 */
export async function correlateSleepWithMetric(
  metricKey: string,
  from: DayString,
  to: DayString,
  lagDays = 1,
): Promise<CorrelationResult> {
  const nights = await getSleepNights(from, to);
  const metric = await getMetricSeries(metricKey, from, addDays(to, lagDays));

  const result: CorrelationResult = {
    r: null,
    n: 0,
    keyA: "sleep_duration",
    keyB: metricKey,
    lagDays,
  };
  if (!metric) return result;

  const byDate = new Map(metric.points.map((p) => [p.date, p.value]));

  const pairs: [number, number][] = [];
  for (const night of nights) {
    if (!night.totalSleepMin) continue;
    const partner = byDate.get(addDays(night.date, lagDays));
    if (partner == null) continue;
    pairs.push([night.totalSleepMin / 60, partner]);
  }

  return { ...result, r: pearson(pairs), n: pairs.length };
}

/**
 * Pearson correlation between two metrics' daily values, with an optional lag.
 *
 * Computed here rather than by the model. Language models are unreliable at
 * arithmetic over dozens of numbers, and a fabricated correlation coefficient
 * is exactly the kind of confident-sounding wrong answer that would make the
 * coach worse than useless.
 *
 * `lagDays` shifts B forward relative to A, so lag 1 answers "does today's A
 * relate to tomorrow's B?" — which is the shape of most useful health
 * questions (last night's sleep vs today's resting heart rate).
 */
export async function correlate(
  keyA: string,
  keyB: string,
  from: DayString,
  to: DayString,
  lagDays = 0,
): Promise<CorrelationResult | null> {
  const a = await getMetricSeries(keyA, from, to);
  const b = await getMetricSeries(keyB, from, addDays(to, lagDays));
  if (!a || !b) return null;

  const bByDate = new Map(b.points.map((p) => [p.date, p.value]));

  const pairs: [number, number][] = [];
  for (const p of a.points) {
    if (p.value === null) continue;
    const partner = bByDate.get(addDays(p.date, lagDays));
    if (partner == null) continue;
    pairs.push([p.value, partner]);
  }

  // Fewer than ~10 paired days can produce a spuriously extreme r, so `n` goes
  // back with the result for the caller (and the coach) to judge.
  return { r: pearson(pairs), n: pairs.length, keyA, keyB, lagDays };
}
