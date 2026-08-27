import { SleepStagesChart } from "@/components/charts/SleepStagesChart";
import { BedtimeConsistency } from "@/components/charts/BedtimeConsistency";
import { correlateSleepWithMetric, getSleepNights } from "@/db/queries/metrics";
import { formatDuration } from "@/lib/format";
import { addDays, todayLocal } from "@/lib/time/day";

export const dynamic = "force-dynamic";

/**
 * Sleep.
 *
 * Sleep gets its own page rather than being one more metric, because the
 * interesting questions about it aren't "how much" — they're about
 * composition, regularity, and what it does to the next day. The correlation
 * strip at the bottom is the payoff: it's the thing you can't see by looking
 * at a sleep chart alone.
 */

export default async function SleepPage() {
  const today = todayLocal();
  const from = addDays(today, -29);
  const quarterAgo = addDays(today, -89);

  const [nights, longRun, vsRestingHr, vsHrv, vsSteps] = await Promise.all([
    getSleepNights(from, today),
    getSleepNights(quarterAgo, today),
    // Lag 1: last night's sleep against *tomorrow's* reading. That ordering is
    // the whole point — same-day correlation would mostly measure the reverse.
    correlateSleepWithMetric("resting_heart_rate", quarterAgo, today, 1),
    correlateSleepWithMetric("heart_rate_variability", quarterAgo, today, 1),
    correlateSleepWithMetric("step_count", quarterAgo, today, 1),
  ]);

  if (nights.length === 0) {
    return (
      <main className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold" style={{ color: "var(--ink)" }}>
          Sleep
        </h1>
        <p className="text-sm" style={{ color: "var(--ink-2)" }}>
          No sleep data yet. Health Auto Export sends this as{" "}
          <code>sleep_analysis</code> once your watch has recorded a night.
        </p>
      </main>
    );
  }

  const withSleep = longRun.filter((n) => n.totalSleepMin > 0);
  const avg =
    withSleep.reduce((sum, n) => sum + n.totalSleepMin, 0) /
    (withSleep.length || 1);

  const avgEfficiency =
    withSleep.filter((n) => n.efficiency != null).reduce(
      (sum, n) => sum + (n.efficiency ?? 0),
      0,
    ) / (withSleep.filter((n) => n.efficiency != null).length || 1);

  const shortNights = withSleep.filter((n) => n.totalSleepMin < 360).length;

  return (
    <main className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold" style={{ color: "var(--ink)" }}>
          Sleep
        </h1>
        <p className="text-sm" style={{ color: "var(--ink-muted)" }}>
          Last {nights.length} nights
        </p>
      </header>

      <section
        className="grid grid-cols-2 gap-3 rounded-xl border p-4 sm:grid-cols-4"
        style={{ background: "var(--surface)", borderColor: "var(--hairline)" }}
      >
        <Figure label="Average night" value={formatDuration(avg)} />
        <Figure
          label="Efficiency"
          value={
            Number.isFinite(avgEfficiency) && avgEfficiency > 0
              ? `${Math.round(avgEfficiency * 100)}%`
              : "—"
          }
        />
        <Figure
          label="Under 6 hours"
          value={`${shortNights} night${shortNights === 1 ? "" : "s"}`}
        />
        <Figure label="Nights recorded" value={String(withSleep.length)} />
      </section>

      <section
        className="rounded-xl border p-4"
        style={{ background: "var(--surface)", borderColor: "var(--hairline)" }}
      >
        <h2 className="mb-1 text-base font-medium" style={{ color: "var(--ink)" }}>
          Nightly breakdown
        </h2>
        {/* Describes the ordering rather than the shade: on a dark surface the
            ramp inverts (deeper = lighter, for contrast against the ground), so
            "darker means deeper" would be wrong for half of all viewers. */}
        <p className="mb-3 text-xs" style={{ color: "var(--ink-muted)" }}>
          Each bar runs deep → core → REM from the bottom, with time awake on
          top. The dashed line is 8 hours.
        </p>
        <SleepStagesChart nights={nights} />
      </section>

      <section
        className="rounded-xl border p-4"
        style={{ background: "var(--surface)", borderColor: "var(--hairline)" }}
      >
        <h2 className="mb-1 text-base font-medium" style={{ color: "var(--ink)" }}>
          Consistency
        </h2>
        <p className="mb-3 text-xs" style={{ color: "var(--ink-muted)" }}>
          When you fell asleep and woke, each night. Tight bands mean a regular
          rhythm — which tends to matter more than total hours.
        </p>
        <BedtimeConsistency nights={nights} />
      </section>

      <section className="flex flex-col gap-2">
        <h2
          className="text-xs font-medium uppercase tracking-wide"
          style={{ color: "var(--ink-muted)" }}
        >
          What your sleep predicts
        </h2>
        <div
          className="flex flex-col divide-y rounded-xl border"
          style={{
            background: "var(--surface)",
            borderColor: "var(--hairline)",
          }}
        >
          <CorrelationRow
            label="Next-day resting heart rate"
            r={vsRestingHr?.r ?? null}
            n={vsRestingHr?.n ?? 0}
          />
          <CorrelationRow
            label="Next-day HRV"
            r={vsHrv?.r ?? null}
            n={vsHrv?.n ?? 0}
          />
          <CorrelationRow
            label="Next-day steps"
            r={vsSteps?.r ?? null}
            n={vsSteps?.n ?? 0}
          />
        </div>
        <p className="text-xs" style={{ color: "var(--ink-muted)" }}>
          Correlation is not causation, and 90 days of one person&rsquo;s data is a
          small sample. Treat these as prompts to look closer, not conclusions.
        </p>
      </section>
    </main>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs" style={{ color: "var(--ink-2)" }}>
        {label}
      </div>
      <div className="text-lg font-semibold" style={{ color: "var(--ink)" }}>
        {value}
      </div>
    </div>
  );
}

/**
 * One correlation, stated in words as well as a number.
 *
 * "r = −0.65" means nothing to most people, so the strength is also spelled
 * out. `n` is shown because a strong-looking r over twelve nights is noise,
 * and hiding the sample size would make it look authoritative.
 */
function CorrelationRow({
  label,
  r,
  n,
}: {
  label: string;
  r: number | null;
  n: number;
}) {
  const strength =
    r === null
      ? null
      : Math.abs(r) >= 0.5
        ? "strong"
        : Math.abs(r) >= 0.3
          ? "moderate"
          : Math.abs(r) >= 0.15
            ? "weak"
            : "none";

  const description =
    r === null || n < 10
      ? "not enough paired days yet"
      : strength === "none"
        ? "no clear relationship"
        : `${strength} — more sleep goes with ${r > 0 ? "higher" : "lower"} values`;

  return (
    <div
      className="flex items-center justify-between gap-3 p-3 text-sm"
      style={{ borderColor: "var(--hairline)" }}
    >
      <span style={{ color: "var(--ink)" }}>{label}</span>
      <span className="text-right">
        <span className="tabular block" style={{ color: "var(--ink)" }}>
          {r === null || n < 10 ? "—" : `r = ${r.toFixed(2)}`}
        </span>
        <span className="text-xs" style={{ color: "var(--ink-muted)" }}>
          {description}
          {n >= 10 ? ` · ${n} nights` : ""}
        </span>
      </span>
    </div>
  );
}
