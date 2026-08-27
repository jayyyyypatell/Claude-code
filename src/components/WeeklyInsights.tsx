import { renderCoachMarkdown } from "@/lib/ai/markdown";
import type { Insight } from "@/db/queries/insights";
import { formatDayCompact } from "@/lib/time/day";

/**
 * Past weekly reports.
 *
 * Findings render from the stored structured output rather than by parsing
 * prose, so confidence and direction are real fields — which lets a
 * low-confidence finding actually look tentative instead of asserting itself
 * in the same voice as a solid one.
 */

interface Finding {
  title: string;
  metric: string;
  direction: "up" | "down" | "flat";
  is_good: "good" | "bad" | "neutral";
  detail: string;
  confidence: "high" | "medium" | "low";
}

export function WeeklyInsights({ insights }: { insights: Insight[] }) {
  if (insights.length === 0) {
    return (
      <p className="text-sm" style={{ color: "var(--ink-muted)" }}>
        No weekly reports yet. One is generated automatically once a full week
        of data has accumulated.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {insights.map((insight, i) => {
        const findings = (insight.data?.findings ?? []) as Finding[];
        const actions = (insight.data?.actions ?? []) as {
          action: string;
          why: string;
        }[];
        const concerns = (insight.data?.concerns ?? []) as string[];

        return (
          <details
            key={insight.id}
            open={i === 0}
            className="rounded-xl border p-4"
            style={{
              background: "var(--surface)",
              borderColor: "var(--hairline)",
            }}
          >
            <summary className="cursor-pointer">
              <span className="text-xs" style={{ color: "var(--ink-muted)" }}>
                {formatDayCompact(insight.periodStart)} –{" "}
                {formatDayCompact(insight.periodEnd)}
              </span>
              <div
                className="mt-0.5 text-sm font-medium"
                style={{ color: "var(--ink)" }}
              >
                {insight.summary}
              </div>
            </summary>

            <div className="mt-3 flex flex-col gap-3">
              {findings.map((f, j) => (
                <div key={j} className="flex gap-2">
                  <DirectionMark direction={f.direction} isGood={f.is_good} />
                  <div className="min-w-0">
                    <div
                      className="text-sm font-medium"
                      style={{ color: "var(--ink)" }}
                    >
                      {f.title}
                      {/* Stated, not colour-coded: a tentative finding should
                          read as tentative rather than looking identical to a
                          solid one. */}
                      {f.confidence === "low" && (
                        <span
                          className="ml-2 text-xs font-normal"
                          style={{ color: "var(--ink-muted)" }}
                        >
                          low confidence
                        </span>
                      )}
                    </div>
                    <p className="text-sm" style={{ color: "var(--ink-2)" }}>
                      {f.detail}
                    </p>
                  </div>
                </div>
              ))}

              {actions.length > 0 && (
                <div
                  className="rounded-lg p-3"
                  style={{ background: "var(--surface-2)" }}
                >
                  <div
                    className="mb-1 text-xs font-medium uppercase tracking-wide"
                    style={{ color: "var(--ink-muted)" }}
                  >
                    Worth trying
                  </div>
                  <ul className="flex flex-col gap-1">
                    {actions.map((a, j) => (
                      <li key={j} className="text-sm" style={{ color: "var(--ink)" }}>
                        {a.action}{" "}
                        <span style={{ color: "var(--ink-muted)" }}>— {a.why}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {concerns.length > 0 && (
                <div
                  className="rounded-lg border p-3"
                  style={{ borderColor: "var(--warning)" }}
                >
                  <div
                    className="mb-1 text-xs font-medium uppercase tracking-wide"
                    style={{ color: "var(--ink-2)" }}
                  >
                    Worth raising with a doctor
                  </div>
                  <ul className="flex flex-col gap-1">
                    {concerns.map((c, j) => (
                      <li key={j} className="text-sm" style={{ color: "var(--ink)" }}>
                        {c}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {findings.length === 0 && insight.bodyMd && (
                <div
                  className="whitespace-pre-wrap text-sm"
                  style={{ color: "var(--ink-2)" }}
                  dangerouslySetInnerHTML={{
                    __html: renderCoachMarkdown(insight.bodyMd),
                  }}
                />
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}

/** An arrow whose colour follows meaning, never direction alone. */
function DirectionMark({
  direction,
  isGood,
}: {
  direction: "up" | "down" | "flat";
  isGood: "good" | "bad" | "neutral";
}) {
  const color =
    isGood === "good"
      ? "var(--delta-up-good)"
      : isGood === "bad"
        ? "var(--critical)"
        : "var(--ink-muted)";

  return (
    <span
      className="mt-0.5 shrink-0 text-sm"
      style={{ color }}
      aria-label={`${direction}, ${isGood}`}
    >
      {direction === "up" ? "↑" : direction === "down" ? "↓" : "→"}
    </span>
  );
}
