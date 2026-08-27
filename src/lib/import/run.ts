import type { Client } from "@libsql/client";

import { client as defaultClient } from "@/db/index";
import { rebuildRollupsFor } from "@/db/rollups";
import type {
  NormalizedPoint,
  NormalizedSleep,
  NormalizedWorkout,
} from "@/lib/hae/normalize";
import { describeMetric } from "@/lib/metrics/catalog";
import { USER_TIMEZONE } from "@/lib/time/day";

import { openHealthExport } from "./zip";
import { HealthExportParser, type XmlImportProgress } from "./xml";

/**
 * Driving a full history import.
 *
 * The shape is: read a chunk, parse it, write what came out, repeat — with
 * every step awaited. The stream is explicitly paused while a batch is being
 * written, which is the difference between a bounded 100MB process and one
 * that grows until the kernel kills it.
 *
 * Writes go through the same upsert as live sync, so importing on top of a
 * database that Health Auto Export has been filling is safe, and importing the
 * same file twice changes nothing the second time.
 */

export interface ImportOptions {
  timeZone?: string;
  storeRoutes?: boolean;
  /** Only import days on or after this local date. */
  since?: string | null;
  /** Rows per database round trip. */
  batchSize?: number;
  onProgress?: (p: ImportProgress) => void;
  db?: Client;
}

export interface ImportProgress extends XmlImportProgress {
  /** 0–1 through the XML, or null when the archive didn't record a size. */
  fraction: number | null;
  phase: "parsing" | "sleep" | "workouts" | "rollups" | "done";
}

export interface ImportSummary {
  records: number;
  points: number;
  skipped: number;
  sleepSessions: number;
  workouts: number;
  metricTypesCreated: number;
  daysTouched: number;
  rollupsRebuilt: number;
  warnings: string[];
  unknownTypes: string[];
  exportDate: string | null;
  elapsedMs: number;
}

/** Multi-row INSERT width. SQLite's variable ceiling is ~32k; 13 columns per row. */
const ROWS_PER_STATEMENT = 400;

export async function importHealthExport(
  path: string,
  options: ImportOptions = {},
): Promise<ImportSummary> {
  const db = options.db ?? defaultClient;
  const startedAt = Date.now();
  const timeZone = options.timeZone ?? USER_TIMEZONE;

  const { stream, uncompressedSize } = await openHealthExport(path);

  // Resolved once per metric key and reused. Looking the id up per point would
  // be millions of round trips.
  const idByKey = new Map<string, number>();
  let metricTypesCreated = 0;

  // Every (metric, day) the import touched, so rollups rebuild only those.
  // Keyed as a string to collapse duplicates: millions of points across a few
  // thousand days.
  const dirty = new Map<string, { metricTypeId: number; localDate: string }>();

  const report = (p: XmlImportProgress, phase: ImportProgress["phase"]) => {
    options.onProgress?.({
      ...p,
      phase,
      fraction: uncompressedSize > 0
        ? Math.min(1, p.bytesRead / uncompressedSize)
        : null,
    });
  };

  let lastProgress: XmlImportProgress = {
    bytesRead: 0, records: 0, points: 0, skipped: 0, workouts: 0, sleepPhases: 0,
  };

  const parser = new HealthExportParser({
    timeZone,
    storeRoutes: options.storeRoutes,
    since: options.since ?? null,
    batchSize: options.batchSize ?? 5_000,
    onProgress: (p) => {
      lastProgress = p;
      report(p, "parsing");
    },
    onPoints: async (points) => {
      await ensureMetricTypes(db, points, idByKey, () => metricTypesCreated++);
      await writePoints(db, points, idByKey, dirty);
    },
  });

  /* ------------------------------------------------------------- streaming -- */

  stream.setEncoding("utf8");

  await new Promise<void>((resolve, reject) => {
    let pending: Promise<void> = Promise.resolve();

    stream.on("data", (chunk: string) => {
      // Stop reading before the write starts, not after. Node delivers the
      // next chunk synchronously otherwise, and the queue grows behind us.
      stream.pause();
      pending = pending
        .then(() => parser.write(chunk))
        .then(() => {
          stream.resume();
        })
        .catch(reject);
    });

    stream.on("end", () => {
      pending.then(resolve).catch(reject);
    });
    stream.on("error", reject);
  });

  const result = await parser.finish();
  lastProgress = result;

  /* ----------------------------------------------------------------- sleep -- */

  report({ ...result, points: result.points }, "sleep");
  await writeSleep(db, result.sleep);

  report({ ...result }, "workouts");
  await writeWorkouts(db, result.workouts_parsed);

  /* --------------------------------------------------------------- rollups -- */

  report({ ...result }, "rollups");
  const rollupsRebuilt = await rebuildRollupsFor(dirty.values(), db);

  report({ ...lastProgress }, "done");

  return {
    records: result.records,
    points: result.points,
    skipped: result.skipped,
    sleepSessions: result.sleep.length,
    workouts: result.workouts_parsed.length,
    metricTypesCreated,
    daysTouched: dirty.size,
    rollupsRebuilt,
    warnings: result.warnings,
    unknownTypes: result.unknownTypes,
    exportDate: result.exportDate,
    elapsedMs: Date.now() - startedAt,
  };
}

/* ------------------------------------------------------------------ writes -- */

/**
 * Register any metric key in this batch that isn't already known.
 *
 * Cached across the whole import, so this costs a handful of queries in total
 * rather than one per point.
 */
async function ensureMetricTypes(
  db: Client,
  points: NormalizedPoint[],
  idByKey: Map<string, number>,
  onCreated: () => void,
): Promise<void> {
  const unseen = new Map<string, NormalizedPoint["descriptor"]>();
  for (const p of points) {
    if (!idByKey.has(p.metricKey)) unseen.set(p.metricKey, p.descriptor);
  }
  if (unseen.size === 0) return;

  for (const [key, d] of unseen) {
    const existing = await db.execute({
      sql: "SELECT id FROM metric_types WHERE key = ?",
      args: [key],
    });
    if (existing.rows.length) {
      idByKey.set(key, Number(existing.rows[0].id));
      continue;
    }

    const descriptor = d ?? describeMetric(key);
    const inserted = await db.execute({
      sql: `INSERT INTO metric_types
              (key, display_name, canonical_unit, category, agg, source, pinned)
            VALUES (?, ?, ?, ?, ?, 'apple_health', ?)
            ON CONFLICT (key) DO UPDATE SET key = excluded.key
            RETURNING id`,
      args: [
        key,
        descriptor.displayName,
        descriptor.canonicalUnit,
        descriptor.category,
        descriptor.agg,
        descriptor.pinned ? 1 : 0,
      ],
    });
    idByKey.set(key, Number(inserted.rows[0].id));
    onCreated();
  }
}

/**
 * Upsert a batch of points.
 *
 * The conflict target is the same natural key live sync uses, which is what
 * makes a backfill onto a running database safe. `grain` being part of it is
 * why a raw 08:03 sample and an hourly 08:00 bucket stay distinct rather than
 * being summed into a double-counted day.
 */
async function writePoints(
  db: Client,
  points: NormalizedPoint[],
  idByKey: Map<string, number>,
  dirty: Map<string, { metricTypeId: number; localDate: string }>,
): Promise<void> {
  for (let i = 0; i < points.length; i += ROWS_PER_STATEMENT) {
    const chunk = points.slice(i, i + ROWS_PER_STATEMENT);
    const args: (string | number | null)[] = [];

    for (const p of chunk) {
      const metricTypeId = idByKey.get(p.metricKey);
      if (metricTypeId === undefined) continue;
      dirty.set(`${metricTypeId}|${p.localDate}`, {
        metricTypeId,
        localDate: p.localDate,
      });
      args.push(
        metricTypeId, p.startAt, p.endAt, p.grain, p.localDate,
        p.tzOffsetMinutes, p.value, p.valueMin, p.valueMax, p.value2,
        p.unit, p.sourceName, p.meta ? JSON.stringify(p.meta) : null,
      );
    }
    if (args.length === 0) continue;

    const rows = args.length / 13;
    await db.execute({
      sql: `INSERT INTO metric_points
              (metric_type_id, start_at, end_at, grain, local_date,
               tz_offset_minutes, value, value_min, value_max, value_2,
               unit, source_name, meta)
            VALUES ${Array.from({ length: rows }, () => "(?,?,?,?,?,?,?,?,?,?,?,?,?)").join(",")}
            ON CONFLICT (metric_type_id, grain, start_at, source_name)
            DO UPDATE SET
              end_at            = excluded.end_at,
              value             = excluded.value,
              value_min         = excluded.value_min,
              value_max         = excluded.value_max,
              value_2           = excluded.value_2,
              unit              = excluded.unit,
              local_date        = excluded.local_date,
              tz_offset_minutes = excluded.tz_offset_minutes,
              meta              = excluded.meta`,
      args,
    });
  }
}

async function writeSleep(db: Client, sessions: NormalizedSleep[]): Promise<void> {
  for (const s of sessions) {
    await db.execute({
      sql: `INSERT INTO sleep_sessions
              (date, start_at, end_at, total_sleep_min, asleep_min, core_min,
               deep_min, rem_min, awake_min, in_bed_min, efficiency,
               source_name, meta)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT (date, source_name) DO UPDATE SET
              start_at        = excluded.start_at,
              end_at          = excluded.end_at,
              total_sleep_min = excluded.total_sleep_min,
              asleep_min      = excluded.asleep_min,
              core_min        = excluded.core_min,
              deep_min        = excluded.deep_min,
              rem_min         = excluded.rem_min,
              awake_min       = excluded.awake_min,
              in_bed_min      = excluded.in_bed_min,
              efficiency      = excluded.efficiency,
              meta            = excluded.meta`,
      args: [
        s.date, s.startAt, s.endAt, s.totalSleepMin, s.asleepMin, s.coreMin,
        s.deepMin, s.remMin, s.awakeMin, s.inBedMin, s.efficiency,
        s.sourceName, s.meta ? JSON.stringify(s.meta) : null,
      ],
    });
  }
}

async function writeWorkouts(db: Client, workouts: NormalizedWorkout[]): Promise<void> {
  for (const w of workouts) {
    await db.execute({
      sql: `INSERT INTO workouts
              (id, date, name, start_at, end_at, duration_sec,
               active_energy_kcal, distance_m, avg_heart_rate, max_heart_rate,
               route, source_name, meta)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT (id) DO UPDATE SET
              date               = excluded.date,
              name               = excluded.name,
              start_at           = excluded.start_at,
              end_at             = excluded.end_at,
              duration_sec       = excluded.duration_sec,
              active_energy_kcal = excluded.active_energy_kcal,
              distance_m         = excluded.distance_m,
              avg_heart_rate     = excluded.avg_heart_rate,
              max_heart_rate     = excluded.max_heart_rate,
              -- Never clear a route that's already stored: a re-import with
              -- routes disabled would otherwise erase them.
              route              = COALESCE(excluded.route, workouts.route),
              meta               = excluded.meta`,
      args: [
        w.id, w.date, w.name, w.startAt, w.endAt, w.durationSec,
        w.activeEnergyKcal, w.distanceM, w.avgHeartRate, w.maxHeartRate,
        w.route ? JSON.stringify(w.route) : null,
        w.sourceName, w.meta ? JSON.stringify(w.meta) : null,
      ],
    });
  }
}
