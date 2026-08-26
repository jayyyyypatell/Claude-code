import type { Client } from "@libsql/client";

import { client as defaultClient } from "./index";

/**
 * Daily rollup computation.
 *
 * `daily_metrics` is the table everything else reads: every chart, every stat
 * card, and every AI tool. Raw `metric_points` are only ever touched by ingest
 * and by this file.
 *
 * Two things make this more than a `GROUP BY`:
 *
 *  1. **Grain precedence.** A single (metric, day) can hold raw samples from an
 *     XML backfill *and* hourly aggregates from a live push. Summing across
 *     both double-counts. So we pick the finest grain present and use only
 *     that.
 *  2. **Per-metric aggregation.** Steps sum, heart rate averages, weight takes
 *     the last reading. The function comes from `metric_types.agg`.
 */

/** Finest first. Lower rank wins when a day holds more than one grain. */
const GRAIN_RANK_SQL = `CASE grain WHEN 'sample' THEN 0 WHEN 'hourly' THEN 1 ELSE 2 END`;

export interface RollupScope {
  /** Inclusive lower bound, `YYYY-MM-DD`. Omit for all of history. */
  fromDate?: string;
  /** Inclusive upper bound, `YYYY-MM-DD`. */
  toDate?: string;
  /** Restrict to these metrics. Omit for all. */
  metricTypeIds?: number[];
}

/**
 * Recompute `daily_metrics` for a scope.
 *
 * Written as one statement so the whole recompute happens inside SQLite rather
 * than streaming millions of rows into JS — which matters for the backfill
 * path, where a full rebuild covers years of per-minute samples.
 *
 * Returns the number of (metric, day) rows written.
 */
export async function rebuildRollups(
  scope: RollupScope = {},
  db: Client = defaultClient,
): Promise<number> {
  const where: string[] = [];
  const args: (string | number)[] = [];

  if (scope.fromDate) {
    where.push("local_date >= ?");
    args.push(scope.fromDate);
  }
  if (scope.toDate) {
    where.push("local_date <= ?");
    args.push(scope.toDate);
  }
  if (scope.metricTypeIds?.length) {
    where.push(
      `metric_type_id IN (${scope.metricTypeIds.map(() => "?").join(",")})`,
    );
    args.push(...scope.metricTypeIds);
  }
  const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const sql = `
    WITH ranked AS (
      SELECT id, metric_type_id, local_date, value, value_min, value_max,
             start_at, ${GRAIN_RANK_SQL} AS grain_rank
      FROM metric_points
      ${filter}
    ),
    -- The finest grain each (metric, day) actually has.
    best AS (
      SELECT metric_type_id, local_date, MIN(grain_rank) AS gr
      FROM ranked
      GROUP BY metric_type_id, local_date
    ),
    -- Only rows at that grain survive. This is the double-count fix: a day
    -- holding both raw samples and hourly aggregates keeps the samples and
    -- discards the aggregates, rather than adding them together.
    kept AS (
      SELECT r.*
      FROM ranked r
      JOIN best b
        ON b.metric_type_id = r.metric_type_id
       AND b.local_date     = r.local_date
       AND b.gr             = r.grain_rank
    ),
    agg AS (
      SELECT metric_type_id, local_date,
             SUM(value)                       AS sum_v,
             AVG(value)                       AS avg_v,
             MIN(COALESCE(value_min, value))  AS min_v,
             MAX(COALESCE(value_max, value))  AS max_v,
             COUNT(*)                         AS n,
             MAX(grain_rank)                  AS gr
      FROM kept
      GROUP BY metric_type_id, local_date
    ),
    -- 'last' metrics (weight, BMI, VO2 max) need the chronologically final
    -- reading, not an average of the day's weigh-ins.
    lastv AS (
      SELECT metric_type_id, local_date, value AS last_v
      FROM (
        SELECT metric_type_id, local_date, value,
               ROW_NUMBER() OVER (
                 PARTITION BY metric_type_id, local_date
                 ORDER BY start_at DESC, id DESC
               ) AS rn
        FROM kept
      )
      WHERE rn = 1
    )
    INSERT INTO daily_metrics
      (date, metric_type_id, value, value_min, value_max,
       sample_count, grain_used, updated_at)
    SELECT
      a.local_date,
      a.metric_type_id,
      CASE mt.agg
        WHEN 'sum'  THEN a.sum_v
        WHEN 'avg'  THEN a.avg_v
        WHEN 'min'  THEN a.min_v
        WHEN 'max'  THEN a.max_v
        ELSE l.last_v
      END,
      a.min_v,
      a.max_v,
      a.n,
      CASE a.gr WHEN 0 THEN 'sample' WHEN 1 THEN 'hourly' ELSE 'daily' END,
      unixepoch() * 1000
    FROM agg a
    JOIN metric_types mt ON mt.id = a.metric_type_id
    LEFT JOIN lastv l
      ON l.metric_type_id = a.metric_type_id
     AND l.local_date     = a.local_date
    WHERE 1=1
    ON CONFLICT (date, metric_type_id) DO UPDATE SET
      value        = excluded.value,
      value_min    = excluded.value_min,
      value_max    = excluded.value_max,
      sample_count = excluded.sample_count,
      grain_used   = excluded.grain_used,
      updated_at   = excluded.updated_at
  `;

  const result = await db.execute({ sql, args });
  return Number(result.rowsAffected ?? 0);
}

/**
 * Recompute only the (metric, day) pairs an ingest actually touched.
 *
 * Ingest collects dirty pairs in a Set; this narrows the rebuild to their
 * bounding box, which for a routine push is a day or two rather than years.
 */
export async function rebuildRollupsFor(
  dirty: Iterable<{ metricTypeId: number; localDate: string }>,
  db: Client = defaultClient,
): Promise<number> {
  const dates: string[] = [];
  const metricIds = new Set<number>();

  for (const d of dirty) {
    dates.push(d.localDate);
    metricIds.add(d.metricTypeId);
  }
  if (dates.length === 0) return 0;

  dates.sort();
  return rebuildRollups(
    {
      fromDate: dates[0],
      toDate: dates[dates.length - 1],
      metricTypeIds: [...metricIds],
    },
    db,
  );
}

/**
 * Drop rollups whose underlying points have all disappeared.
 *
 * Only relevant after a deletion — the upsert above never removes rows, so a
 * day emptied by a correction would otherwise keep a stale total forever.
 */
export async function pruneOrphanedRollups(
  db: Client = defaultClient,
): Promise<number> {
  const result = await db.execute(`
    DELETE FROM daily_metrics
    WHERE NOT EXISTS (
      SELECT 1 FROM metric_points mp
      WHERE mp.metric_type_id = daily_metrics.metric_type_id
        AND mp.local_date     = daily_metrics.date
    )
  `);
  return Number(result.rowsAffected ?? 0);
}
