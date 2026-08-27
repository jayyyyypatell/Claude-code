import { timingSafeEqual } from "node:crypto";

import { ensureWeeklyReport } from "@/lib/ai/weekly";
import { addDays, dayOfWeek, todayLocal } from "@/lib/time/day";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Generate the weekly report.
 *
 * Guarded by CRON_SECRET rather than left open: generating a report costs
 * money, so an unauthenticated endpoint that triggers one is a way for anyone
 * who finds the URL to run up a bill.
 *
 * Safe to call repeatedly. `UNIQUE(kind, period_start)` means a cron, a page
 * load and a manual run can all fire at once and exactly one report is
 * written.
 */

function authorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  const header = req.headers.get("authorization") ?? "";
  const provided = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : (req.headers.get("x-cron-secret") ?? "");

  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The most recent completed week, ending last Sunday. */
export function lastCompleteWeekEnd(today = todayLocal()): string {
  // dayOfWeek: 0 = Sunday. Step back to the Sunday on or before yesterday, so
  // a report is never written about a week still in progress.
  const yesterday = addDays(today, -1);
  return addDays(yesterday, -dayOfWeek(yesterday));
}

export async function POST(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return Response.json(
      { error: "Invalid or missing CRON_SECRET." },
      { status: 401 },
    );
  }

  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  const weekEnd = url.searchParams.get("week_end") ?? lastCompleteWeekEnd();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekEnd)) {
    return Response.json({ error: "Invalid week_end." }, { status: 400 });
  }

  try {
    const result = await ensureWeeklyReport(weekEnd, force);
    return Response.json({ ok: true, weekEnd, ...result });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
