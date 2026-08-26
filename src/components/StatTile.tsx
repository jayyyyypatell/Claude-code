import {
  formatDelta,
  formatValue,
  higherIsBetter,
  type UnitSystem,
} from "@/lib/format";
import { formatDayCompact } from "@/lib/time/day";

/**
 * A single headline number.
 *
 * A one-bar bar chart is the wrong form for one value — this is the right one.
 * Contract: label · value · delta vs a named baseline · sparkline for shape.
 *
 * The delta chip's colour follows *meaning*, not direction. Resting heart rate
 * rising is bad news and HRV rising is good news; painting both green because
 * the arrow points up would actively mislead. Metrics whose direction depends
 * on personal goals (weight, calories eaten) get a neutral chip rather than a
 * guess, and the arrow glyph means the colour never carries it alone.
 */

interface Props {
  label: string;
  value: number | null;
  unit: string;
  metricKey: string;
  changePct?: number | null;
  baselineLabel?: string;
  spark?: (number | null)[];
  system?: UnitSystem;
  /** Pre-formatted value, for things units can't express (e.g. "7h 12m"). */
  displayOverride?: string;
  /** Set when the value is carried forward from an earlier day. */
  asOf?: string | null;
}

export function StatTile({
  label,
  value,
  unit,
  metricKey,
  changePct,
  baselineLabel = "30-day average",
  spark,
  system = "metric",
  displayOverride,
  asOf,
}: Props) {
  const better = higherIsBetter(metricKey);
  const hasDelta = changePct != null && Number.isFinite(changePct);

  // Sub-3% moves in noisy biometric data are not signal. Calling every one of
  // them out trains you to ignore the chip entirely.
  const meaningful = hasDelta && Math.abs(changePct) >= 3;

  let deltaColor = "var(--ink-muted)";
  if (meaningful && better !== null) {
    const isGood = changePct > 0 === better;
    deltaColor = isGood ? "var(--delta-up-good)" : "var(--critical)";
  }

  return (
    <div
      className="flex flex-col gap-1 rounded-xl border p-4"
      style={{ background: "var(--surface)", borderColor: "var(--hairline)" }}
    >
      <span className="text-xs" style={{ color: "var(--ink-2)" }}>
        {label}
      </span>

      <span
        className="text-2xl font-semibold leading-tight"
        style={{ color: "var(--ink)" }}
      >
        {displayOverride ?? formatValue(value, unit, system)}
      </span>

      <div className="flex items-center justify-between gap-2">
        {asOf ? (
          // A carried-forward reading is labelled, so it can never be mistaken
          // for something measured today.
          <span className="text-xs" style={{ color: "var(--ink-muted)" }}>
            as of {formatDayCompact(asOf)}
          </span>
        ) : hasDelta ? (
          <span className="text-xs" style={{ color: deltaColor }}>
            {/* Glyph, not colour alone — the arrow survives CVD and greyscale. */}
            {meaningful ? (changePct > 0 ? "↑" : "↓") : "→"}{" "}
            <span className="tabular">{formatDelta(changePct)}</span>
            <span style={{ color: "var(--ink-muted)" }}> vs {baselineLabel}</span>
          </span>
        ) : (
          <span className="text-xs" style={{ color: "var(--ink-muted)" }}>
            no baseline yet
          </span>
        )}

        {spark && spark.some((v) => v !== null) && (
          <Sparkline values={spark} />
        )}
      </div>
    </div>
  );
}

/**
 * A 14-point shape cue, not a chart.
 *
 * Deliberately unlabelled and un-hovered: its job is "roughly flat / climbing /
 * falling" at a glance. Anyone who wants the numbers taps through to the trend
 * page, where there are axes.
 */
function Sparkline({
  values,
  width = 64,
  height = 20,
}: {
  values: (number | null)[];
  width?: number;
  height?: number;
}) {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length < 2) return null;

  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;

  /**
   * Unlike the full chart, the sparkline connects across gaps.
   *
   * The trend chart breaks its line at missing days because you read *values*
   * off it, and bridging a gap would assert data that doesn't exist. A
   * sparkline carries no axis and no values — its only job is "rising, falling
   * or flat". Breaking it leaves isolated two-point fragments that read as
   * rendering glitches rather than as absent data. Points keep their true
   * horizontal position, so the spacing still shows where the gaps are.
   */
  const parts: string[] = [];
  values.forEach((v, i) => {
    if (v === null) return;
    const x = (i / (values.length - 1)) * width;
    const y = height - ((v - min) / span) * height;
    parts.push(`${parts.length === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`);
  });

  return (
    <svg width={width} height={height} aria-hidden="true" className="shrink-0">
      <path
        d={parts.join(" ")}
        fill="none"
        stroke="var(--series-1)"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.7}
      />
    </svg>
  );
}
