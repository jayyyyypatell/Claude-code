import type { Client } from "@libsql/client";

import { client as defaultClient } from "@/db/index";
import { rebuildRollupsFor } from "@/db/rollups";

import type { NormalizeResult } from "./normalize";

/**
 * Writing a normalized payload to the database.
 *
 * Everything here upserts. Health Auto Export re-sends overlapping windows on
 * every push, so the same sample arrives many times over its life; inserts
 * would inflate every additive metric. See `metricPoints` in the schema for
 * the natural key and why `grain` is part of it.
 */

export interface PersistCounts {
  metricTypesCreated: number;
  pointsUpserted: number;
  sleepUpserted: number;
  workoutsUpserted: number;
  rollupsRebuilt: number;
}

/** Batch size for multi-row INSERTs. SQLite's variable limit is ~32k. */
const CHUNK = 400;

export async function persistNormalized(
  normalized: NormalizeResult,
  db: Client = defaultClient,
): Promise<PersistCounts> {
  const counts: PersistCounts = {
    metricTypesCreated: 0,
    pointsUpserted: 0,
    sleepUpserted: 0,
    workoutsUpserted: 0,
    rollupsRebuilt: 0,
  };

  /* ------------------------------------------------- metric type registry -- */
  const idByKey = new Map<string, number>();
  const distinct = new Map<string, NormalizeResult["points"][number]["descriptor"]>();
  for (const p of normalized.points) distinct.set(p.metricKey, p.descriptor);

  for (const [key, d] of distinct) {
    const before = await db.execute({
      sql: "SELECT id FROM metric_types WHERE key = ?",
      args: [key],
    });

    if (before.rows.length) {
      idByKey.set(key, Number(before.rows[0].id));
      continue;
    }

    // A metric we've never seen. Register it rather than dropping the data —
    // Apple adds metric types regularly and we cannot go back and re-fetch.
    const inserted = await db.execute({
      sql: `INSERT INTO metric_types
              (key, display_name, canonical_unit, category, agg, source, pinned)
            VALUES (?, ?, ?, ?, ?, 'apple_health', ?)
            ON CONFLICT (key) DO UPDATE SET key = excluded.key
            RETURNING id`,
      args: [key, d.displayName, d.canonicalUnit, d.category, d.agg, d.pinned ? 1 : 0],
    });
    idByKey.set(key, Number(inserted.rows[0].id));
    counts.metricTypesCreated++;
  }

  /* ------------------------------------------------------------- points --- */
  const dirty = new Map<string, { metricTypeId: number; localDate: string }>();

  for (let i = 0; i < normalized.points.length; i += CHUNK) {
    const chunk = normalized.points.slice(i, i + CHUNK);
    const args: (string | number | null)[] = [];

    for (const p of chunk) {
      const metricTypeId = idByKey.get(p.metricKey);
      if (metricTypeId === undefined) continue;
      dirty.set(`${metricTypeId}|${p.localDate}`, { metricTypeId, localDate: p.localDate });
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
    counts.pointsUpserted += rows;
  }

  /* -------------------------------------------------------------- sleep --- */
  for (const s of normalized.sleep) {
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
    counts.sleepUpserted++;
  }

  /* ----------------------------------------------------------- workouts --- */
  for (const w of normalized.workouts) {
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
              route              = COALESCE(excluded.route, workouts.route),
              meta               = excluded.meta`,
      args: [
        w.id, w.date, w.name, w.startAt, w.endAt, w.durationSec,
        w.activeEnergyKcal, w.distanceM, w.avgHeartRate, w.maxHeartRate,
        w.route ? JSON.stringify(w.route) : null,
        w.sourceName, w.meta ? JSON.stringify(w.meta) : null,
      ],
    });
    counts.workoutsUpserted++;
  }

  /* ------------------------------------------------------------ rollups --- */
  // Only the days this push actually touched — for a routine sync that's a day
  // or two, not the whole history.
  counts.rollupsRebuilt = await rebuildRollupsFor(dirty.values(), db);

  return counts;
}
