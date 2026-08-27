import { CoachChat } from "@/components/CoachChat";
import { WeeklyInsights } from "@/components/WeeklyInsights";
import { listInsights } from "@/db/queries/insights";
import { coachIsConfigured, isMockMode } from "@/lib/ai/client";
import { maybeTriggerWeekly } from "@/lib/ai/trigger";

export const dynamic = "force-dynamic";

/**
 * The coach.
 *
 * The disclaimer sits at the top rather than buried in a footer. This is a
 * language model reading consumer-device data and giving advice someone may
 * act on; saying so once, plainly, up front is the honest placement.
 */
export default async function CoachPage() {
  const configured = coachIsConfigured();

  // Generate last week's report if it's missing. Fire-and-forget — the page
  // must not wait on a model call.
  maybeTriggerWeekly();

  const insights = await listInsights(8);

  return (
    <main className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold" style={{ color: "var(--ink)" }}>
          Coach
        </h1>
        <p className="text-sm" style={{ color: "var(--ink-muted)" }}>
          Not a doctor. Consumer-device data, not clinical measurement — worth
          treating as a prompt to look closer, never as a diagnosis.
          {isMockMode() && " Currently in mock mode."}
        </p>
      </div>

      <CoachChat configured={configured} />

      <section className="flex flex-col gap-2">
        <h2
          className="text-xs font-medium uppercase tracking-wide"
          style={{ color: "var(--ink-muted)" }}
        >
          Weekly reports
        </h2>
        <WeeklyInsights insights={insights} />
      </section>
    </main>
  );
}
