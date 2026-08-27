import { describeMetric, type MetricDescriptor } from "@/lib/metrics/catalog";
import { convertTo } from "@/lib/metrics/units";
import { nightOfDate, USER_TIMEZONE } from "@/lib/time/day";

import { tryParseHaeDate } from "./dates";

/**
 * Turning a Health Auto Export payload into rows.
 *
 * Pure — no database access, no clock, no environment beyond an explicit
 * timezone. That keeps the messy part (HAE's inconsistent per-metric shapes)
 * testable against fixtures without a database.
 *
 * The governing rule throughout: **never drop a reading because we didn't
 * recognise its shape.** An unknown metric key, an unexpected unit, a field
 * we've never seen — all of these produce a warning and a best-effort row.
 * Health data can't be re-fetched from the past, so a lossy parser is a much
 * worse failure than a slightly wrong category label.
 */

export type Grain = "sample" | "hourly" | "daily";

export interface NormalizedPoint {
  metricKey: string;
  descriptor: MetricDescriptor;
  startAt: number;
  endAt: number;
  grain: Grain;
  localDate: string;
  tzOffsetMinutes: number;
  value: number;
  valueMin: number | null;
  valueMax: number | null;
  value2: number | null;
  unit: string;
  sourceName: string;
  meta: Record<string, unknown> | null;
}

export interface NormalizedSleep {
  date: string;
  startAt: number;
  endAt: number;
  totalSleepMin: number;
  asleepMin: number | null;
  coreMin: number | null;
  deepMin: number | null;
  remMin: number | null;
  awakeMin: number | null;
  inBedMin: number | null;
  efficiency: number | null;
  sourceName: string;
  meta: Record<string, unknown> | null;
}

export interface NormalizedWorkout {
  id: string;
  date: string;
  name: string;
  startAt: number;
  endAt: number;
  durationSec: number;
  activeEnergyKcal: number | null;
  distanceM: number | null;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  route: unknown[] | null;
  sourceName: string;
  meta: Record<string, unknown> | null;
}

export interface NormalizeResult {
  points: NormalizedPoint[];
  sleep: NormalizedSleep[];
  workouts: NormalizedWorkout[];
  warnings: string[];
  /** Metric keys that weren't in the catalog — surfaced in settings. */
  unknownMetrics: string[];
}

export interface NormalizeOptions {
  timeZone?: string;
  /** Persist workout GPS routes. Off by default: large, and nothing renders them. */
  storeRoutes?: boolean;
  /** Force a grain instead of inferring it from sample duration. */
  forceGrain?: Grain;
}

/* -------------------------------------------------------------------------- */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * Infer how pre-aggregated a sample is from the window it covers.
 *
 * HAE's aggregation setting isn't in the payload, so the sample duration is
 * the only signal. The thresholds are deliberately loose: an "hourly" bucket
 * may run 59m59s, and a "daily" one 23h on a DST day.
 *
 * This matters because `grain` gates the double-count protection in the daily
 * rollup — see `metricPoints.grain` in the schema.
 */
export function inferGrain(startAt: number, endAt: number): Grain {
  const span = endAt - startAt;
  if (span >= 23 * HOUR_MS) return "daily";
  if (span >= 50 * MINUTE_MS) return "hourly";
  return "sample";
}

/** Coerce HAE's numbers, which arrive as numbers or numeric strings. */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Read a workout field that may be a scalar or a `{qty, units}` object.
 * HAE v2 uses the object form for most totals but not consistently.
 */
function quantity(
  v: unknown,
  fallbackUnit?: string,
): { value: number; unit: string } | null {
  if (v == null) return null;
  const direct = num(v);
  if (direct !== null) return { value: direct, unit: fallbackUnit ?? "" };
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const q = num(o.qty ?? o.value);
    if (q === null) return null;
    return { value: q, unit: String(o.units ?? o.unit ?? fallbackUnit ?? "") };
  }
  return null;
}

/** Everything except the fields we've explicitly consumed, kept as meta. */
function leftovers(
  obj: Record<string, unknown>,
  consumed: string[],
): Record<string, unknown> | null {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!consumed.includes(k) && v != null) rest[k] = v;
  }
  return Object.keys(rest).length ? rest : null;
}

/* -------------------------------------------------------------------------- */

/** Metric names that need bespoke handling rather than the scalar path. */
const SLEEP_KEYS = new Set(["sleep_analysis", "sleep"]);
const BLOOD_PRESSURE_KEYS = new Set(["blood_pressure"]);

/** Metrics that arrive as `{Min, Avg, Max}` instead of `{qty}`. */
function hasMinAvgMax(d: Record<string, unknown>): boolean {
  return "Avg" in d || "avg" in d;
}

/* -------------------------------------------------------------------------- */

export function normalizeHaePayload(
  payload: unknown,
  options: NormalizeOptions = {},
): NormalizeResult {
  const tz = options.timeZone ?? USER_TIMEZONE;
  const result: NormalizeResult = {
    points: [], sleep: [], workouts: [], warnings: [], unknownMetrics: [],
  };

  const root = (payload as { data?: unknown })?.data ?? payload;
  if (!root || typeof root !== "object") {
    result.warnings.push("Payload has no `data` object; nothing ingested.");
    return result;
  }

  const data = root as Record<string, unknown>;
  const unknown = new Set<string>();

  /* ------------------------------------------------------------- metrics -- */
  const metrics = Array.isArray(data.metrics) ? data.metrics : [];
  for (const raw of metrics) {
    if (!raw || typeof raw !== "object") continue;
    const metric = raw as Record<string, unknown>;

    const name = typeof metric.name === "string" ? metric.name.trim() : "";
    if (!name) {
      result.warnings.push("Skipped a metric with no `name`.");
      continue;
    }
    const units = typeof metric.units === "string" ? metric.units : undefined;
    const rows = Array.isArray(metric.data) ? metric.data : [];
    if (rows.length === 0) continue;

    if (SLEEP_KEYS.has(name)) {
      normalizeSleep(rows, tz, result);
      continue;
    }

    const descriptor = describeMetric(name, units);
    if (!descriptor.isKnown) unknown.add(name);

    for (const rawRow of rows) {
      if (!rawRow || typeof rawRow !== "object") continue;
      const row = rawRow as Record<string, unknown>;

      const parsed = tryParseHaeDate(row.date ?? row.startDate, tz);
      if (!parsed) {
        result.warnings.push(
          `${name}: unparseable date ${JSON.stringify(row.date ?? row.startDate)}; row skipped.`,
        );
        continue;
      }

      const endParsed = row.endDate ? tryParseHaeDate(row.endDate, tz) : null;
      const startAt = parsed.epochMs;
      const endAt = endParsed?.epochMs ?? startAt;
      const grain = options.forceGrain ?? inferGrain(startAt, endAt);
      const sourceName = String(row.source ?? metric.source ?? "");
      const rowUnits = typeof row.units === "string" ? row.units : units;

      /* -- blood pressure: a pair, not a scalar ----------------------------- */
      if (BLOOD_PRESSURE_KEYS.has(name) || ("systolic" in row && "diastolic" in row)) {
        const sys = num(row.systolic);
        const dia = num(row.diastolic);
        if (sys === null || dia === null) {
          result.warnings.push(`${name}: incomplete blood pressure reading; skipped.`);
          continue;
        }
        result.points.push({
          metricKey: name, descriptor,
          startAt, endAt, grain,
          localDate: parsed.localDate, tzOffsetMinutes: parsed.tzOffsetMinutes,
          value: sys, valueMin: null, valueMax: null, value2: dia,
          unit: "mmHg", sourceName,
          meta: leftovers(row, ["systolic", "diastolic", "date", "source", "units", "endDate"]),
        });
        continue;
      }

      /* -- heart rate and friends: {Min, Avg, Max} -------------------------- */
      if (hasMinAvgMax(row)) {
        // Note the capitalised keys — HAE uses `Min`/`Avg`/`Max` here while
        // using lowercase everywhere else.
        const avg = num(row.Avg ?? row.avg);
        const min = num(row.Min ?? row.min);
        const max = num(row.Max ?? row.max);
        if (avg === null) {
          result.warnings.push(`${name}: Min/Max present but no Avg; skipped.`);
          continue;
        }
        const target = descriptor.canonicalUnit;
        const c = convertTo(avg, rowUnits, target);
        result.points.push({
          metricKey: name, descriptor,
          startAt, endAt, grain,
          localDate: parsed.localDate, tzOffsetMinutes: parsed.tzOffsetMinutes,
          value: c.value,
          valueMin: min === null ? null : convertTo(min, rowUnits, target).value,
          valueMax: max === null ? null : convertTo(max, rowUnits, target).value,
          value2: null,
          unit: c.unit, sourceName,
          meta: leftovers(row, ["Min", "Avg", "Max", "min", "avg", "max", "date", "source", "units", "endDate"]),
        });
        continue;
      }

      /* -- the ordinary scalar path ---------------------------------------- */
      const qty = num(row.qty ?? row.value);
      if (qty === null) {
        result.warnings.push(
          `${name}: no numeric qty in ${JSON.stringify(Object.keys(row))}; skipped.`,
        );
        continue;
      }

      // Convert to the METRIC's storage unit, not just the dimension default:
      // sodium belongs in mg, body weight in kg, and both are "mass".
      const c = convertTo(qty, rowUnits, descriptor.canonicalUnit);
      if (rowUnits && !c.compatible) {
        // Keep the reading, but flag it. A phone locale flip mid-history looks
        // exactly like this, and it silently changes what the numbers mean.
        result.warnings.push(
          `${name}: unit "${rowUnits}" is not compatible with ${descriptor.canonicalUnit}; stored unconverted.`,
        );
      }

      result.points.push({
        metricKey: name, descriptor,
        startAt, endAt, grain,
        localDate: parsed.localDate, tzOffsetMinutes: parsed.tzOffsetMinutes,
        value: c.value, valueMin: null, valueMax: null, value2: null,
        unit: c.unit || descriptor.canonicalUnit, sourceName,
        meta: leftovers(row, ["qty", "value", "date", "source", "units", "endDate", "startDate"]),
      });
    }
  }

  /* ------------------------------------------------------------ workouts -- */
  const workouts = Array.isArray(data.workouts) ? data.workouts : [];
  for (const raw of workouts) {
    if (!raw || typeof raw !== "object") continue;
    const w = raw as Record<string, unknown>;

    const start = tryParseHaeDate(w.start ?? w.startDate, tz);
    const end = tryParseHaeDate(w.end ?? w.endDate, tz);
    if (!start || !end) {
      result.warnings.push(`Workout ${String(w.id ?? "?")}: unparseable start/end; skipped.`);
      continue;
    }

    const energy = quantity(w.activeEnergyBurned ?? w.activeEnergy, "kcal");
    const distance = quantity(w.distance, "km");
    const hr = w.heartRate as Record<string, unknown> | undefined;

    // HAE gives workouts a UUID. When it doesn't (older payloads), synthesise
    // a stable key from the workout's own identity so re-pushes still collapse
    // onto one row rather than accumulating duplicates.
    const id =
      typeof w.id === "string" && w.id
        ? w.id
        : `syn-${start.epochMs}-${String(w.name ?? "workout").replace(/\s+/g, "-").toLowerCase()}`;

    result.workouts.push({
      id,
      date: start.localDate,
      name: String(w.name ?? "Workout"),
      startAt: start.epochMs,
      endAt: end.epochMs,
      durationSec:
        num(w.duration) ?? Math.round((end.epochMs - start.epochMs) / 1000),
      activeEnergyKcal: energy ? convertTo(energy.value, energy.unit, "kcal").value : null,
      distanceM: distance ? convertTo(distance.value, distance.unit, "m").value : null,
      avgHeartRate: num(hr?.Avg ?? hr?.avg ?? w.avgHeartRate),
      maxHeartRate: num(hr?.Max ?? hr?.max ?? w.maxHeartRate),
      route: options.storeRoutes && Array.isArray(w.route) ? w.route : null,
      sourceName: String(w.source ?? ""),
      meta: leftovers(w, [
        "id", "name", "start", "end", "startDate", "endDate", "duration",
        "activeEnergyBurned", "activeEnergy", "distance", "heartRate",
        "avgHeartRate", "maxHeartRate", "route", "source",
      ]),
    });
  }

  result.unknownMetrics = [...unknown];
  return result;
}

/* -------------------------------------------------------------------------- */

/**
 * Sleep arrives in two entirely different shapes depending on HAE's
 * aggregation setting, and the setting can be changed at any time — so both
 * have to work, and a history can contain a mix.
 *
 *   aggregated:   { totalSleep, asleep, core, deep, rem, sleepStart, sleepEnd }
 *   unaggregated: { startDate, endDate, qty, value }   ← one row per phase
 */
function normalizeSleep(
  rows: unknown[],
  tz: string,
  result: NormalizeResult,
): void {
  const phaseRows: { start: number; end: number; phase: string; date: string }[] = [];

  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;

    /* -- aggregated ------------------------------------------------------- */
    if ("sleepStart" in row || "totalSleep" in row) {
      const start = tryParseHaeDate(row.sleepStart ?? row.startDate ?? row.date, tz);
      const end = tryParseHaeDate(row.sleepEnd ?? row.endDate, tz);
      if (!start || !end) {
        result.warnings.push("Sleep: unparseable sleepStart/sleepEnd; skipped.");
        continue;
      }

      // HAE reports these in hours. Stored in minutes so they compose with
      // everything else that measures duration.
      const hoursToMin = (v: unknown): number | null => {
        const n = num(v);
        return n === null ? null : n * 60;
      };

      const total = hoursToMin(row.totalSleep) ?? hoursToMin(row.asleep) ?? 0;
      const inBed = hoursToMin(row.inBed);

      result.sleep.push({
        date: nightOfDate(end.epochMs, tz),
        startAt: start.epochMs,
        endAt: end.epochMs,
        totalSleepMin: total,
        asleepMin: hoursToMin(row.asleep) ?? total,
        coreMin: hoursToMin(row.core),
        deepMin: hoursToMin(row.deep),
        remMin: hoursToMin(row.rem),
        awakeMin: hoursToMin(row.awake),
        inBedMin: inBed,
        efficiency: inBed && inBed > 0 ? total / inBed : null,
        sourceName: String(row.source ?? ""),
        meta: leftovers(row, [
          "sleepStart", "sleepEnd", "startDate", "endDate", "date",
          "totalSleep", "asleep", "core", "deep", "rem", "awake", "inBed", "source",
        ]),
      });
      continue;
    }

    /* -- unaggregated: one row per phase ---------------------------------- */
    const start = tryParseHaeDate(row.startDate ?? row.date, tz);
    const end = tryParseHaeDate(row.endDate, tz);
    if (!start || !end) {
      result.warnings.push("Sleep: unparseable phase interval; skipped.");
      continue;
    }
    phaseRows.push({
      start: start.epochMs,
      end: end.epochMs,
      phase: String(row.value ?? "asleep").toLowerCase(),
      date: nightOfDate(end.epochMs, tz),
    });
  }

  if (phaseRows.length) {
    result.sleep.push(...sessionsFromPhases(phaseRows));
  }
}

/**
 * Rebuild whole-night sessions from individual phase intervals.
 *
 * Phases are grouped by night-of date and then split on gaps longer than an
 * hour, so an afternoon nap doesn't get merged into the previous night.
 *
 * Exported because `export.xml` carries sleep the same way — as loose phase
 * intervals — and reconstructing nights differently in the two ingest paths
 * would give the same night two different durations depending on which path
 * loaded it.
 */
export function sessionsFromPhases(
  phases: { start: number; end: number; phase: string; date: string }[],
  sourceName = "",
): NormalizedSleep[] {
  const GAP_MS = 60 * MINUTE_MS;
  const byNight = new Map<string, typeof phases>();

  for (const p of phases) {
    const list = byNight.get(p.date) ?? [];
    list.push(p);
    byNight.set(p.date, list);
  }

  const sessions: NormalizedSleep[] = [];

  for (const [date, list] of byNight) {
    list.sort((a, b) => a.start - b.start);

    let group: typeof list = [];
    const flushGroup = () => {
      if (group.length === 0) return;
      const startAt = group[0].start;
      const endAt = Math.max(...group.map((g) => g.end));

      const minutesIn = (test: (phase: string) => boolean): number =>
        group
          .filter((g) => test(g.phase))
          .reduce((sum, g) => sum + (g.end - g.start) / MINUTE_MS, 0);

      const deep = minutesIn((p) => p.includes("deep"));
      const rem = minutesIn((p) => p.includes("rem"));
      const core = minutesIn((p) => p.includes("core") || p.includes("light"));
      const awake = minutesIn((p) => p.includes("awake"));
      const inBedOnly = minutesIn((p) => p.includes("inbed") || p.includes("in_bed"));
      const asleep = deep + rem + core || minutesIn((p) => p.includes("asleep"));
      const inBed = inBedOnly || asleep + awake;

      sessions.push({
        date, startAt, endAt,
        totalSleepMin: asleep,
        asleepMin: asleep,
        coreMin: core || null,
        deepMin: deep || null,
        remMin: rem || null,
        awakeMin: awake || null,
        inBedMin: inBed || null,
        efficiency: inBed > 0 ? asleep / inBed : null,
        sourceName,
        meta: { reconstructedFromPhases: true, phaseCount: group.length },
      });
      group = [];
    };

    for (const p of list) {
      if (group.length && p.start - group[group.length - 1].end > GAP_MS) flushGroup();
      group.push(p);
    }
    flushGroup();
  }

  return sessions;
}
