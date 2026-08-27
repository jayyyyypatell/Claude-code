import { CoachChat } from "@/components/CoachChat";
import { coachIsConfigured, isMockMode } from "@/lib/ai/client";

export const dynamic = "force-dynamic";

/**
 * The coach.
 *
 * The disclaimer sits at the top rather than buried in a footer. This is a
 * language model reading consumer-device data and giving advice someone may
 * act on; saying so once, plainly, up front is the honest placement.
 */
export default function CoachPage() {
  const configured = coachIsConfigured();

  return (
    <main className="flex flex-col gap-5">
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
    </main>
  );
}
