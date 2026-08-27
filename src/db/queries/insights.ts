import { client } from "@/db/index";
import { addDays, dayOfWeek, todayLocal, type DayString } from "@/lib/time/day";

export interface Insight {
  id: number;
  periodStart: DayString;
  periodEnd: DayString;
  summary: string;
  bodyMd: string;
  data: Record<string, unknown> | null;
  model: string;
  createdAt: number;
}

function rowToInsight(row: Record<string, unknown>): Insight {
  let data: Record<string, unknown> | null = null;
  if (row.data) {
    try {
      data = JSON.parse(String(row.data)) as Record<string, unknown>;
    } catch {
      data = null;
    }
  }
  return {
    id: Number(row.id),
    periodStart: String(row.period_start),
    periodEnd: String(row.period_end),
    summary: String(row.summary ?? ""),
    bodyMd: String(row.body_md ?? ""),
    data,
    model: String(row.model ?? ""),
    createdAt: Number(row.created_at ?? 0),
  };
}

export async function listInsights(limit = 12): Promise<Insight[]> {
  const r = await client.execute({
    sql: `SELECT id, period_start, period_end, summary, body_md, data, model, created_at
          FROM insights WHERE kind = 'weekly'
          ORDER BY period_start DESC LIMIT ?`,
    args: [limit],
  });
  return r.rows.map((row) => rowToInsight(row as Record<string, unknown>));
}

export async function latestInsight(): Promise<Insight | null> {
  const rows = await listInsights(1);
  return rows[0] ?? null;
}

/** The most recent completed week, ending on a Sunday. */
export function lastCompleteWeekEnd(today: DayString = todayLocal()): DayString {
  // Never a week still in progress: step back to the Sunday on or before
  // yesterday.
  const yesterday = addDays(today, -1);
  return addDays(yesterday, -dayOfWeek(yesterday));
}

/**
 * Whether last week's report is missing.
 *
 * Read on page load so the app can generate one without any scheduler — see
 * `maybeTriggerWeekly`. Deliberately a cheap indexed lookup, since it runs on
 * every render of the Today page.
 */
export async function weeklyReportMissing(
  today: DayString = todayLocal(),
): Promise<DayString | null> {
  const weekEnd = lastCompleteWeekEnd(today);
  const weekStart = addDays(weekEnd, -6);

  const r = await client.execute({
    sql: "SELECT id FROM insights WHERE kind = 'weekly' AND period_start = ? LIMIT 1",
    args: [weekStart],
  });
  return r.rows.length === 0 ? weekEnd : null;
}
