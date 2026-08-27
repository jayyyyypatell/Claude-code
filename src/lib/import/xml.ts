import { SaxesParser, type SaxesTagPlain } from "saxes";

import {
  sessionsFromPhases,
  type NormalizedPoint,
  type NormalizedSleep,
  type NormalizedWorkout,
} from "@/lib/hae/normalize";
import { tryParseHaeDate } from "@/lib/hae/dates";
import { describeMetric } from "@/lib/metrics/catalog";
import { convertTo } from "@/lib/metrics/units";
import { nightOfDate, USER_TIMEZONE } from "@/lib/time/day";

import {
  BLOOD_PRESSURE_TYPES,
  metricKeyForHkType,
  sleepPhaseFromCategoryValue,
  SLEEP_TYPE,
  workoutNameForActivityType,
} from "./hk-types";

/**
 * Streaming parser for Apple Health's `export.xml`.
 *
 * SAX, not DOM, and that is the whole design. A real export is a single XML
 * document of a few hundred megabytes containing millions of `<Record>`
 * elements; `DOMParser` or `xml2js` would need the entire tree resident and
 * dies on any normal machine. SAX sees one element at a time and forgets it.
 *
 * The parser holds no growing state except sleep phases and workouts, which
 * are thousands of items rather than millions and have to be complete before
 * they can be assembled (see `finish`). Records are handed to `onPoints` in
 * batches and dropped.
 *
 * Backpressure is the caller's job and is not optional: `onPoints` returns a
 * promise, and `parseHealthExportXml` stops feeding the parser until it
 * settles. Without that, SAX parses at disk speed, the database writes at
 * database speed, and the difference accumulates in memory until the process
 * dies — the exact failure the streaming was meant to avoid.
 */

export interface XmlImportOptions {
  timeZone?: string;
  /** Rows per database round trip. */
  batchSize?: number;
  /** Persist workout GPS routes. Off by default — see the privacy notes. */
  storeRoutes?: boolean;
  /** Skip anything before this local date (`YYYY-MM-DD`). */
  since?: string | null;
  onPoints: (points: NormalizedPoint[]) => Promise<void>;
  onProgress?: (progress: XmlImportProgress) => void;
}

export interface XmlImportProgress {
  bytesRead: number;
  records: number;
  points: number;
  skipped: number;
  workouts: number;
  sleepPhases: number;
}

export interface XmlImportResult extends XmlImportProgress {
  sleep: NormalizedSleep[];
  workouts_parsed: NormalizedWorkout[];
  warnings: string[];
  unknownTypes: string[];
  exportDate: string | null;
}

/** Progress callbacks per N records — often enough to feel live, rare enough to be free. */
const PROGRESS_EVERY = 25_000;

/** Distinct warning texts kept. A malformed export must not produce a 4M-line log. */
const MAX_WARNINGS = 50;

type SleepPhase = { start: number; end: number; phase: string; date: string };

interface PendingWorkout {
  activityType: string;
  startAt: number;
  endAt: number;
  durationSec: number;
  sourceName: string;
  localDate: string;
  stats: Map<string, number>;
  meta: Record<string, unknown>;
  route: unknown[] | null;
}

export class HealthExportParser {
  private readonly opts: Required<Omit<XmlImportOptions, "onProgress">> & {
    onProgress?: (p: XmlImportProgress) => void;
  };

  private readonly parser: SaxesParser;
  private readonly buffer: NormalizedPoint[] = [];
  private readonly sleepPhases: SleepPhase[] = [];
  private readonly workouts: NormalizedWorkout[] = [];
  private readonly warnings = new Set<string>();
  private readonly unknownTypes = new Set<string>();

  /** Systolic waiting for the diastolic that shares its timestamp, or vice versa. */
  private readonly bpPending = new Map<
    string,
    { systolic?: number; diastolic?: number; point: NormalizedPoint }
  >();

  private workout: PendingWorkout | null = null;
  private inRoute = false;
  private exportDate: string | null = null;
  private fatal: Error | null = null;

  private counts: XmlImportProgress = {
    bytesRead: 0,
    records: 0,
    points: 0,
    skipped: 0,
    workouts: 0,
    sleepPhases: 0,
  };

  constructor(options: XmlImportOptions) {
    this.opts = {
      timeZone: options.timeZone ?? USER_TIMEZONE,
      batchSize: options.batchSize ?? 2_000,
      storeRoutes: options.storeRoutes ?? false,
      since: options.since ?? null,
      onPoints: options.onPoints,
      onProgress: options.onProgress,
    };

    this.parser = new SaxesParser({ fragment: false });
    this.parser.on("opentag", (tag) => this.openTag(tag as SaxesTagPlain));
    this.parser.on("closetag", (tag) => this.closeTag(tag.name));
    this.parser.on("error", (err) => {
      // Apple's exporter occasionally emits an entity it never declared. Keep
      // going: a bad byte at 80% through should not throw away the 80%.
      this.warn(`XML parse error: ${err.message}`);
      this.counts.skipped++;
    });
  }

  /** Feed a chunk. Await the result before feeding the next one. */
  async write(chunk: string | Buffer): Promise<void> {
    if (this.fatal) throw this.fatal;
    this.counts.bytesRead += typeof chunk === "string"
      ? Buffer.byteLength(chunk)
      : chunk.length;
    this.parser.write(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    if (this.buffer.length >= this.opts.batchSize) await this.flush();
  }

  async finish(): Promise<XmlImportResult> {
    this.parser.close();
    await this.flush();

    // Blood pressure readings that never found their partner still belong in
    // the database — half a reading is data, and dropping it silently loses it.
    for (const pending of this.bpPending.values()) this.buffer.push(pending.point);
    this.bpPending.clear();
    await this.flush();

    const sleep = this.assembleSleep();

    return {
      ...this.counts,
      sleep,
      workouts_parsed: this.workouts,
      warnings: [...this.warnings],
      unknownTypes: [...this.unknownTypes],
      exportDate: this.exportDate,
    };
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    this.counts.points += batch.length;
    await this.opts.onPoints(batch);
  }

  private warn(message: string): void {
    if (this.warnings.size < MAX_WARNINGS) this.warnings.add(message);
  }

  private tick(): void {
    this.counts.records++;
    if (this.counts.records % PROGRESS_EVERY === 0) {
      this.opts.onProgress?.({ ...this.counts, points: this.counts.points + this.buffer.length });
    }
  }

  /* --------------------------------------------------------------- elements */

  private openTag(tag: SaxesTagPlain): void {
    const a = tag.attributes;
    switch (tag.name) {
      case "Record":
        this.tick();
        this.record(a);
        break;
      case "Workout":
        this.tick();
        this.openWorkout(a);
        break;
      case "WorkoutStatistics":
        this.workoutStatistic(a);
        break;
      case "MetadataEntry":
        if (this.workout && a.key) this.workout.meta[a.key] = a.value ?? "";
        break;
      case "WorkoutRoute":
        this.inRoute = true;
        break;
      case "Location":
        if (this.inRoute && this.workout && this.opts.storeRoutes) {
          this.workout.route ??= [];
          this.workout.route.push({
            lat: Number(a.latitude),
            lon: Number(a.longitude),
            alt: a.altitude ? Number(a.altitude) : null,
            t: a.date ?? null,
          });
        }
        break;
      case "ExportDate":
        this.exportDate = a.value ?? null;
        break;
      case "ActivitySummary":
        // Deliberately ignored: every field here is a daily total that the
        // per-sample records already carry. Importing both would give the
        // rollup two sources for one day at two different grains.
        break;
      default:
        break;
    }
  }

  private closeTag(name: string): void {
    if (name === "Workout") this.closeWorkout();
    else if (name === "WorkoutRoute") this.inRoute = false;
  }

  /* ---------------------------------------------------------------- records */

  private record(a: Record<string, string>): void {
    const hkType = a.type;
    if (!hkType) {
      this.counts.skipped++;
      return;
    }

    const start = tryParseHaeDate(a.startDate, this.opts.timeZone);
    if (!start) {
      this.warn(`Unparseable startDate on a ${hkType} record: ${a.startDate}`);
      this.counts.skipped++;
      return;
    }
    const end = tryParseHaeDate(a.endDate, this.opts.timeZone) ?? start;

    if (this.opts.since && start.localDate < this.opts.since) {
      this.counts.skipped++;
      return;
    }

    if (hkType === SLEEP_TYPE) {
      this.sleepRecord(a, start.epochMs, end.epochMs);
      return;
    }

    const bpSide = BLOOD_PRESSURE_TYPES[hkType];
    const { key, isKnown } = bpSide
      ? { key: "blood_pressure", isKnown: true }
      : metricKeyForHkType(hkType);
    if (!isKnown) this.unknownTypes.add(hkType);

    const rawValue = this.valueOf(a, key);
    if (rawValue === null) {
      this.counts.skipped++;
      return;
    }

    const descriptor = describeMetric(key, a.unit);
    const sourceName = a.sourceName ?? "";

    // The record's own duration decides the grain. `export.xml` is raw
    // samples, but Apple writes some types (exercise minutes, stand hours) as
    // pre-bucketed intervals, and calling those `sample` would let them win
    // grain precedence over the hourly aggregates Health Auto Export sends.
    const grain = end.epochMs - start.epochMs >= 23 * 3600_000 ? "daily"
      : end.epochMs - start.epochMs >= 3600_000 ? "hourly"
      : "sample";

    // Convert to the metric's own storage unit, exactly as the Health Auto
    // Export path does. A history whose units were canonicalised differently
    // from live sync would put two scales on one chart.
    const converted = convertTo(rawValue, a.unit ?? null, descriptor.canonicalUnit);
    if (a.unit && !converted.compatible) {
      this.warn(
        `${key}: unit "${a.unit}" is not compatible with ${descriptor.canonicalUnit}; stored unconverted.`,
      );
    }

    const point: NormalizedPoint = {
      metricKey: key,
      descriptor,
      startAt: start.epochMs,
      endAt: end.epochMs,
      grain,
      localDate: start.localDate,
      tzOffsetMinutes: start.tzOffsetMinutes,
      value: converted.value,
      valueMin: null,
      valueMax: null,
      value2: null,
      unit: converted.unit || descriptor.canonicalUnit,
      sourceName,
      meta: null,
    };

    if (bpSide) this.bloodPressure(point, bpSide, start.epochMs, sourceName);
    else this.buffer.push(point);
  }

  /**
   * Numeric value, including the ones Apple writes as words.
   *
   * Category records carry a string in `value` — `HKCategoryValueSleepAnalysis…`,
   * `HKCategoryValueAppleStandHourStood`. Those are events, and an event is a
   * count of one.
   */
  private valueOf(a: Record<string, string>, key: string): number | null {
    const raw = a.value;

    if (raw === undefined || raw === "") {
      // Some category records omit value entirely and mean "it happened".
      return a.type?.startsWith("HKCategoryTypeIdentifier") ? 1 : null;
    }

    const n = Number(raw);
    if (Number.isFinite(n)) return n;

    if (raw.startsWith("HKCategoryValue")) {
      // "…Stood" / "…Idle": only the former is the thing being counted.
      if (/Idle|NotSet|None/i.test(raw)) return 0;
      return 1;
    }

    this.warn(`Non-numeric value on ${key}: ${raw}`);
    return null;
  }

  /**
   * Merge the two blood pressure record types into one row.
   *
   * They are separate records at an identical timestamp. Stored separately
   * they would be two metrics that each average to a number nobody wants —
   * "your blood pressure is 104" is not a reading.
   */
  private bloodPressure(
    point: NormalizedPoint,
    side: "systolic" | "diastolic",
    startAt: number,
    sourceName: string,
  ): void {
    const slot = `${startAt}|${sourceName}`;
    const held = this.bpPending.get(slot);

    if (!held) {
      const seed = { ...point, value: 0, meta: {} as Record<string, unknown> };
      const entry = { [side]: point.value, point: seed } as {
        systolic?: number;
        diastolic?: number;
        point: NormalizedPoint;
      };
      this.bpPending.set(slot, entry);
      return;
    }

    held[side] = point.value;
    const { systolic, diastolic } = held;

    held.point.value = systolic ?? diastolic ?? 0;
    held.point.value2 = diastolic ?? null;
    held.point.meta = { systolic: systolic ?? null, diastolic: diastolic ?? null };
    this.buffer.push(held.point);
    this.bpPending.delete(slot);

    // Bound the map: an export with a systolic that never gets its diastolic
    // would otherwise hold one entry per orphan for the length of the file.
    if (this.bpPending.size > 5_000) {
      for (const [k, v] of this.bpPending) {
        this.buffer.push(v.point);
        this.bpPending.delete(k);
        if (this.bpPending.size <= 2_500) break;
      }
    }
  }

  private sleepRecord(a: Record<string, string>, startAt: number, endAt: number): void {
    this.sleepPhases.push({
      start: startAt,
      end: endAt,
      phase: sleepPhaseFromCategoryValue(a.value ?? ""),
      // Night-of, not calendar date: a night beginning at 23:40 belongs to the
      // morning it ends on, which is how every sleep app reports it.
      date: nightOfDate(endAt, this.opts.timeZone),
    });
    this.counts.sleepPhases++;
  }

  /**
   * Sessions can only be built once the whole file is read.
   *
   * `export.xml` is not sorted, so a phase belonging to a night can appear
   * anywhere; assembling early would cut nights in half. Phases are kept as
   * four small fields each — a decade of watch-tracked sleep is on the order
   * of ten megabytes, which is affordable where the records are not.
   */
  private assembleSleep(): NormalizedSleep[] {
    const bySource = new Map<string, SleepPhase[]>();
    for (const p of this.sleepPhases) {
      // Grouped by source so an iPhone's coarse "in bed" and a watch's staged
      // sleep for the same night stay two rows. `sleep_sessions` is unique on
      // (date, source_name), so merging them would silently drop one.
      const src = p.phase === "inbed" ? "iPhone" : "Apple Watch";
      const list = bySource.get(src) ?? [];
      list.push(p);
      bySource.set(src, list);
    }

    const sessions: NormalizedSleep[] = [];
    for (const [source, phases] of bySource) {
      sessions.push(...sessionsFromPhases(phases, source));
    }
    // Free it: the caller still has to write everything else.
    this.sleepPhases.length = 0;
    return sessions;
  }

  /* --------------------------------------------------------------- workouts */

  private openWorkout(a: Record<string, string>): void {
    const start = tryParseHaeDate(a.startDate, this.opts.timeZone);
    if (!start) {
      this.warn(`Unparseable startDate on a workout: ${a.startDate}`);
      this.counts.skipped++;
      return;
    }
    const end = tryParseHaeDate(a.endDate, this.opts.timeZone) ?? start;

    if (this.opts.since && start.localDate < this.opts.since) {
      this.counts.skipped++;
      return;
    }

    const durationUnit = (a.durationUnit ?? "min").toLowerCase();
    const duration = Number(a.duration);
    const durationSec = Number.isFinite(duration)
      ? durationUnit.startsWith("s") ? duration
        : durationUnit.startsWith("h") ? duration * 3600
        : duration * 60
      : Math.round((end.epochMs - start.epochMs) / 1000);

    this.workout = {
      activityType: a.workoutActivityType ?? "HKWorkoutActivityTypeOther",
      startAt: start.epochMs,
      endAt: end.epochMs,
      durationSec: Math.round(durationSec),
      sourceName: a.sourceName ?? "",
      localDate: start.localDate,
      stats: new Map(),
      meta: {},
      route: null,
    };

    // Pre-iOS 16 exports put totals on the element itself rather than in
    // <WorkoutStatistics> children. Both shapes appear in one file when a
    // history spans that upgrade.
    const legacyEnergy = Number(a.totalEnergyBurned);
    if (Number.isFinite(legacyEnergy)) {
      this.workout.stats.set(
        "energy",
        convertTo(legacyEnergy, a.totalEnergyBurnedUnit ?? "kcal", "kcal").value,
      );
    }
    const legacyDistance = Number(a.totalDistance);
    if (Number.isFinite(legacyDistance)) {
      this.workout.stats.set(
        "distance",
        convertTo(legacyDistance, a.totalDistanceUnit ?? "km", "m").value,
      );
    }
  }

  private workoutStatistic(a: Record<string, string>): void {
    if (!this.workout || !a.type) return;

    // `sum` for totals, `average`/`maximum` for rates — a heart rate has no sum.
    const sum = Number(a.sum);
    const avg = Number(a.average);
    const max = Number(a.maximum);

    switch (a.type) {
      case "HKQuantityTypeIdentifierActiveEnergyBurned":
        if (Number.isFinite(sum)) {
          this.workout.stats.set("energy", convertTo(sum, a.unit ?? "kcal", "kcal").value);
        }
        break;
      case "HKQuantityTypeIdentifierDistanceWalkingRunning":
      case "HKQuantityTypeIdentifierDistanceCycling":
      case "HKQuantityTypeIdentifierDistanceSwimming":
      case "HKQuantityTypeIdentifierDistanceWheelchair":
      case "HKQuantityTypeIdentifierDistanceDownhillSnowSports":
        if (Number.isFinite(sum)) {
          this.workout.stats.set("distance", convertTo(sum, a.unit ?? "km", "m").value);
        }
        break;
      case "HKQuantityTypeIdentifierHeartRate":
        if (Number.isFinite(avg)) this.workout.stats.set("avgHr", avg);
        if (Number.isFinite(max)) this.workout.stats.set("maxHr", max);
        break;
      default:
        break;
    }
  }

  private closeWorkout(): void {
    const w = this.workout;
    this.workout = null;
    this.inRoute = false;
    if (!w) return;

    this.workouts.push({
      // Deterministic, so re-importing the same export updates rather than
      // duplicates — and so a workout that also arrived via Health Auto Export
      // collides with it rather than appearing twice.
      id: `hk:${w.startAt}:${w.activityType}`,
      date: w.localDate,
      name: workoutNameForActivityType(w.activityType),
      startAt: w.startAt,
      endAt: w.endAt,
      durationSec: w.durationSec,
      activeEnergyKcal: w.stats.get("energy") ?? null,
      distanceM: w.stats.get("distance") ?? null,
      avgHeartRate: w.stats.get("avgHr") ?? null,
      maxHeartRate: w.stats.get("maxHr") ?? null,
      route: w.route,
      sourceName: w.sourceName,
      meta: Object.keys(w.meta).length ? w.meta : null,
    });
    this.counts.workouts++;
  }
}
