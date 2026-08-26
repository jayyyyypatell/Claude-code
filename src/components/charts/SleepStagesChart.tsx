"use client";

import { useMemo, useState } from "react";

import { formatDuration } from "@/lib/format";
import { formatDayShort } from "@/lib/time/day";

import { useChartWidth } from "./use-chart-width";

/**
 * Nightly sleep, broken into stages.
 *
 * Colour choice worth explaining: the stages use an **ordinal blue ramp**
 * (deep = darkest → REM = lightest) rather than four categorical hues. Sleep
 * stages are genuinely ordered by depth, so "more depth = darker" is readable
 * without memorising a legend, and it sidesteps the four-hue problem entirely.
 * Awake isn't a sleep stage at all, so it sits outside the ramp in neutral
 * grey — which also stops it competing visually with the sleep itself.
 *
 * Segments are separated by a 2px surface gap rather than a stroke, so the
 * separation costs no extra ink.
 */

export interface SleepBar {
  date: string;
  deepMin: number | null;
  coreMin: number | null;
  remMin: number | null;
  awakeMin: number | null;
  totalSleepMin: number;
}

const STAGES = [
  { key: "deepMin", label: "Deep", color: "var(--sleep-deep)" },
  { key: "coreMin", label: "Core", color: "var(--sleep-core)" },
  { key: "remMin", label: "REM", color: "var(--sleep-rem)" },
  { key: "awakeMin", label: "Awake", color: "var(--sleep-awake)" },
] as const;

const PAD = { top: 12, right: 12, bottom: 26, left: 44 };
const GAP = 2; // the surface gap between stacked segments

interface Props {
  nights: SleepBar[];
  height?: number;
  /** Draw a target line, e.g. 8 hours. */
  targetMin?: number | null;
}

export function SleepStagesChart({ nights, height = 260, targetMin = 480 }: Props) {
  const [ref, width] = useChartWidth();
  const [hover, setHover] = useState<number | null>(null);

  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = Math.max(10, height - PAD.top - PAD.bottom);

  const { yMax, ticks } = useMemo(() => {
    const totals = nights.map(
      (n) =>
        (n.deepMin ?? 0) + (n.coreMin ?? 0) + (n.remMin ?? 0) + (n.awakeMin ?? 0) ||
        n.totalSleepMin,
    );
    const peak = Math.max(targetMin ?? 0, ...totals, 60);
    const top = Math.ceil((peak * 1.05) / 60) * 60;

    /**
     * Whole-hour ticks, generated directly rather than by a generic
     * nice-number routine.
     *
     * The generic version works in the axis's own units — minutes here — and
     * happily returns a step of 200, which renders as "3.3333333333333335h".
     * An axis measured in hours should tick in hours.
     */
    const stepHours = top > 720 ? 3 : top > 480 ? 2 : 1;
    const out: number[] = [];
    for (let h = 0; h * 60 <= top; h += stepHours) out.push(h * 60);
    return { yMax: top, ticks: out };
  }, [nights, targetMin]);

  const y = (minutes: number): number =>
    PAD.top + plotH - (minutes / (yMax || 1)) * plotH;

  const band = nights.length ? plotW / nights.length : plotW;
  // Cap bar thickness and let the leftover be air — never fill the slot.
  const barW = Math.min(24, Math.max(2, band - 3));

  const handleMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = e.clientX - rect.left - PAD.left;
    const idx = Math.floor(rel / band);
    setHover(idx >= 0 && idx < nights.length ? idx : null);
  };

  const hovered = hover !== null ? nights[hover] : null;

  return (
    <div ref={ref} className="w-full">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`Sleep stages across ${nights.length} nights`}
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={y(t)}
              y2={y(t)}
              stroke="var(--grid)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={y(t)}
              textAnchor="end"
              dominantBaseline="middle"
              className="tabular"
              fontSize={11}
              fill="var(--ink-muted)"
            >
              {t / 60}h
            </text>
          </g>
        ))}

        {targetMin != null && (
          <line
            x1={PAD.left}
            x2={PAD.left + plotW}
            y1={y(targetMin)}
            y2={y(targetMin)}
            stroke="var(--axis)"
            strokeWidth={1}
            strokeDasharray="4 4"
          />
        )}

        {nights.map((night, i) => {
          const cx = PAD.left + i * band + (band - barW) / 2;
          let cursor = 0;

          return (
            <g key={night.date} opacity={hover === null || hover === i ? 1 : 0.45}>
              {STAGES.map((stage) => {
                const minutes = night[stage.key] ?? 0;
                if (minutes <= 0) return null;

                const top = y(cursor + minutes);
                const bottom = y(cursor);
                cursor += minutes;

                // Reserve the surface gap out of each segment's height. A
                // segment thinner than the gap is drawn solid rather than
                // vanishing.
                const rawH = bottom - top;
                const h = rawH > GAP * 2 ? rawH - GAP : rawH;
                if (h <= 0) return null;

                return (
                  <rect
                    key={stage.key}
                    x={cx}
                    y={top}
                    width={barW}
                    height={h}
                    rx={2}
                    fill={stage.color}
                  />
                );
              })}
            </g>
          );
        })}

        {nights.length > 1 && (
          <>
            <text x={PAD.left} y={height - 6} fontSize={11} fill="var(--ink-muted)">
              {formatDayShort(nights[0].date)}
            </text>
            <text
              x={PAD.left + plotW}
              y={height - 6}
              textAnchor="end"
              fontSize={11}
              fill="var(--ink-muted)"
            >
              {formatDayShort(nights[nights.length - 1].date)}
            </text>
          </>
        )}
      </svg>

      {/* Legend is always present at ≥2 series — identity never rests on
          colour-matching alone. Swatches carry the colour; the text is ink. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        {STAGES.map((s) => (
          <span
            key={s.key}
            className="flex items-center gap-1.5 text-xs"
            style={{ color: "var(--ink-2)" }}
          >
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ background: s.color }}
            />
            {s.label}
          </span>
        ))}
      </div>

      <div
        className="mt-2 min-h-[2.5rem] text-xs"
        style={{ color: "var(--ink-2)" }}
        aria-live="polite"
      >
        {hovered ? (
          <>
            <span className="font-medium" style={{ color: "var(--ink)" }}>
              {formatDayShort(hovered.date)}
            </span>{" "}
            — {formatDuration(hovered.totalSleepMin)} asleep
            <span className="tabular">
              {hovered.deepMin ? ` · deep ${formatDuration(hovered.deepMin)}` : ""}
              {hovered.remMin ? ` · REM ${formatDuration(hovered.remMin)}` : ""}
              {hovered.coreMin ? ` · core ${formatDuration(hovered.coreMin)}` : ""}
              {hovered.awakeMin ? ` · awake ${formatDuration(hovered.awakeMin)}` : ""}
            </span>
          </>
        ) : (
          <span style={{ color: "var(--ink-muted)" }}>
            Hover a night for its breakdown.
          </span>
        )}
      </div>
    </div>
  );
}
