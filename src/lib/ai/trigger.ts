import { weeklyReportMissing } from "@/db/queries/insights";
import { todayLocal } from "@/lib/time/day";

import { coachIsConfigured } from "./client";
import { ensureWeeklyReport } from "./weekly";

/**
 * Generate last week's report on demand, with no scheduler.
 *
 * This box has no cron, a self-hosted instance may have none either, and
 * Vercel Cron only exists if you deploy there. So the zero-infrastructure path
 * is: when a page renders and last week has no report, make one.
 *
 * Two properties make that safe rather than reckless:
 *
 *  - **It never blocks the render.** The promise is deliberately not awaited;
 *    a page load must not wait fifteen seconds on a model call.
 *  - **It can't double-fire.** An in-process guard stops concurrent renders
 *    racing, and `UNIQUE(kind, period_start)` stops anything that slips past
 *    it from writing twice.
 *
 * A cron hitting `/api/jobs/weekly-insight` is still the better answer if you
 * have one; this is the fallback that always works.
 */

let inFlight: string | null = null;

export function maybeTriggerWeekly(): void {
  // Without a key there is nothing to trigger, and firing anyway would put a
  // failing call on every page load.
  if (!coachIsConfigured()) return;

  void (async () => {
    try {
      const weekEnd = await weeklyReportMissing(todayLocal());
      if (!weekEnd || inFlight === weekEnd) return;

      inFlight = weekEnd;
      await ensureWeeklyReport(weekEnd);
    } catch {
      // Swallowed on purpose: a failed background generation must never break
      // the page someone actually asked for. The next render retries.
    } finally {
      inFlight = null;
    }
  })();
}
