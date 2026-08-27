/**
 * One-time repair for points ingested before hourly buckets were detected.
 *
 *   npm run repair-grain -- --dry-run
 *   npm run repair-grain
 *
 * Health Auto Export sends an hourly aggregate as `{date, qty}` with no end
 * date. Early builds inferred grain from the per-point span, saw zero width,
 * and stored every bucket as a raw `sample`.
 *
 * Left alone that is worse than cosmetic. `sample` outranks `hourly` in the
 * daily rollup, so the mislabelled rows keep winning and correctly-labelled
 * data pushed after the fix is silently ignored for any day they cover — and
 * a history backfill would be summed on top of them rather than replacing
 * them.
 *
 * Only rows that are unambiguously buckets are touched: zero width, exactly on
 * an hour boundary, from Apple Health. A real instantaneous sample lands on an
 * exact hour boundary roughly once in 3,600 readings, and one that also has
 * `start_at = end_at` is a bucket.
 */

import { client } from "@/db/index";
import { rebuildRollupsFor } from "@/db/rollups";

const HOUR_MS = 3_600_000;

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const target = (arg("grain") ?? "hourly") as "hourly" | "daily";
  if (target !== "hourly" && target !== "daily") {
    console.error("--grain must be hourly or daily");
    process.exit(1);
  }
  const unit = target === "daily" ? 24 * HOUR_MS : HOUR_MS;

  const candidates = await client.execute({
    sql: `SELECT mp.id, mp.metric_type_id, mp.start_at, mp.source_name, mp.local_date, mt.key
          FROM metric_points mp
          JOIN metric_types mt ON mt.id = mp.metric_type_id
          WHERE mp.grain = 'sample'
            AND mp.start_at = mp.end_at
            AND mp.start_at % ? = 0
            AND mt.source = 'apple_health'`,
    args: [unit],
  });

  if (candidates.rows.length === 0) {
    console.log("Nothing to repair — no zero-width points on an exact boundary.");
    return;
  }

  const byKey = new Map<string, number>();
  for (const r of candidates.rows) {
    byKey.set(String(r.key), (byKey.get(String(r.key)) ?? 0) + 1);
  }

  console.log(`${candidates.rows.length} point(s) look like ${target} buckets stored as samples:\n`);
  for (const [key, n] of [...byKey].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key.padEnd(32)} ${n}`);
  }

  if (dryRun) {
    console.log("\n--dry-run: nothing written.");
    return;
  }

  const dirty = new Map<string, { metricTypeId: number; localDate: string }>();
  let relabelled = 0;
  let removed = 0;

  for (const row of candidates.rows) {
    const metricTypeId = Number(row.metric_type_id);
    const localDate = String(row.local_date);
    dirty.set(`${metricTypeId}|${localDate}`, { metricTypeId, localDate });

    // A correctly-labelled row may already occupy the natural key this one is
    // about to move onto — that happens once live sync has pushed the same
    // hour since the fix. The newer row is authoritative, so the stale
    // duplicate goes rather than colliding.
    const clash = await client.execute({
      sql: `SELECT id FROM metric_points
            WHERE metric_type_id = ? AND grain = ? AND start_at = ? AND source_name = ?`,
      args: [metricTypeId, target, Number(row.start_at), String(row.source_name)],
    });

    if (clash.rows.length > 0) {
      await client.execute({
        sql: "DELETE FROM metric_points WHERE id = ?",
        args: [Number(row.id)],
      });
      removed++;
    } else {
      await client.execute({
        sql: "UPDATE metric_points SET grain = ? WHERE id = ?",
        args: [target, Number(row.id)],
      });
      relabelled++;
    }
  }

  const rebuilt = await rebuildRollupsFor(dirty.values(), client);

  console.log(`\n  relabelled      ${relabelled}`);
  console.log(`  removed as dupe ${removed}`);
  console.log(`  days rolled up  ${rebuilt}`);
  console.log("\nSafe to run again — it only ever matches rows still marked 'sample'.");
}

main().catch((e) => {
  console.error("Repair failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
