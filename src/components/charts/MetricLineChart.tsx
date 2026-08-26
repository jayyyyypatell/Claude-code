"use client";

import { useMemo, useState } from "react";

import { formatNumber, unitLabel } from "@/lib/format";
import { formatDayShort } from "@/lib/time/day";

import { niceTicks, useChartWidth } from "./use-chart-width";

/**
 * The generic daily-metric chart.
 *
 * One component drives every one of the 150+ metrics rather than 150 bespoke
 * charts — the metric registry supplies the name, unit and shape, and this
 * renders it. Adding a metric to the app requires no chart code at all.
 *
 * Marks follow the fixed specs: 2px line, ≥8px end marker with a 2px surface
 * ring, hairline solid gridlines, ~10% area wash, and labels in ink tokens
 * rather than the series colour.
 */

export interface LinePoint {
  date: string;
  value: number | null;
}

interface Props {
  points: LinePoint[];
  /** Centred rolling mean, same length as `points`. Drawn as the trend. */
  rolling?: (number | null)[];
  unit: string;
  label: string;
  height?: number;
  /** Force the y-axis to include zero. Right for counts, wrong for heart rate. */
  zeroBased?: boolean;
  color?: string;
}

const PAD = { top: 12, right: 16, bottom: 24, left: 44 };

export function MetricLineChart({
  points,
  rolling,
  unit,
  label,
  height = 220,
  zeroBased = false,
  color = "var(--series-1)",
}: Props) {
  const [ref, width] = useChartWidth();
  const [hover, setHover] = useState<number | null>(null);

  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = Math.max(10, height - PAD.top - PAD.bottom);

  const { yMin, yMax, ticks } = useMemo(() => {
    const values = points
      .map((p) => p.value)
      .filter((v): v is number => v !== null);
    if (values.length === 0) return { yMin: 0, yMax: 1, ticks: [0, 1] };

    let lo = Math.min(...values);
    let hi = Math.max(...values);
    if (zeroBased) lo = Math.min(0, lo);

    // Pure headroom, so the top mark never touches the frame.
    const span = hi - lo || Math.abs(hi) || 1;
    hi += span * 0.08;
    if (!zeroBased) lo -= span * 0.08;

    return { yMin: lo, yMax: hi, ticks: niceTicks(lo, hi, 4) };
  }, [points, zeroBased]);

  const x = (i: number): number =>
    PAD.left + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v: number): number =>
    PAD.top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;

  /**
   * Build path segments, breaking at gaps.
   *
   * A missing day is real information — the watch was off — so the line stops
   * rather than interpolating across it. Drawing straight through a gap
   * invents a week of data that never existed.
   */
  const segments = useMemo(() => {
    const out: string[] = [];
    let current: string[] = [];
    points.forEach((p, i) => {
      if (p.value === null) {
        if (current.length > 1) out.push(current.join(" "));
        current = [];
        return;
      }
      current.push(`${current.length === 0 ? "M" : "L"} ${x(i)} ${y(p.value)}`);
    });
    if (current.length > 1) out.push(current.join(" "));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, yMin, yMax, plotW, plotH, width]);

  const rollingPath = useMemo(() => {
    if (!rolling) return "";
    const parts: string[] = [];
    let started = false;
    rolling.forEach((v, i) => {
      if (v === null) {
        started = false;
        return;
      }
      parts.push(`${started ? "L" : "M"} ${x(i)} ${y(v)}`);
      started = true;
    });
    return parts.join(" ");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rolling, yMin, yMax, plotW, plotH, width]);

  const lastIndex = useMemo(() => {
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i].value !== null) return i;
    }
    return -1;
  }, [points]);

  const hoverPoint = hover !== null ? points[hover] : null;

  const handleMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = e.clientX - rect.left - PAD.left;
    const idx = Math.round((rel / plotW) * (points.length - 1));
    setHover(idx >= 0 && idx < points.length ? idx : null);
  };

  return (
    <div ref={ref} className="relative w-full">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`${label} over ${points.length} days`}
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
        className="touch-none"
      >
        {/* gridlines — hairline, solid, recessive */}
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
              {formatNumber(t)}
            </text>
          </g>
        ))}

        {/* area wash at ~10% — context, never a saturated block */}
        {segments.length > 0 && lastIndex >= 0 && (
          <path
            d={`${segments[0]} L ${x(lastIndex)} ${PAD.top + plotH} L ${x(0)} ${
              PAD.top + plotH
            } Z`}
            fill={color}
            opacity={0.1}
          />
        )}

        {/* the 7-day trend sits under the raw line, de-emphasised */}
        {rollingPath && (
          <path
            d={rollingPath}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.35}
          />
        )}

        {segments.map((d, i) => (
          <path
            key={i}
            d={d}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}

        {/* end marker: ≥8px with a 2px surface ring so it reads over the line */}
        {lastIndex >= 0 && points[lastIndex].value !== null && (
          <circle
            cx={x(lastIndex)}
            cy={y(points[lastIndex].value)}
            r={4}
            fill={color}
            stroke="var(--surface)"
            strokeWidth={2}
          />
        )}

        {/* crosshair */}
        {hoverPoint?.value != null && hover !== null && (
          <g pointerEvents="none">
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.top}
              y2={PAD.top + plotH}
              stroke="var(--axis)"
              strokeWidth={1}
            />
            <circle
              cx={x(hover)}
              cy={y(hoverPoint.value)}
              r={4}
              fill={color}
              stroke="var(--surface)"
              strokeWidth={2}
            />
          </g>
        )}

        {/* x labels: first and last only — a label per day is unreadable */}
        {points.length > 1 && (
          <>
            <text
              x={PAD.left}
              y={height - 6}
              fontSize={11}
              fill="var(--ink-muted)"
            >
              {formatDayShort(points[0].date)}
            </text>
            <text
              x={PAD.left + plotW}
              y={height - 6}
              textAnchor="end"
              fontSize={11}
              fill="var(--ink-muted)"
            >
              {formatDayShort(points[points.length - 1].date)}
            </text>
          </>
        )}
      </svg>

      {/* Tooltip in ink tokens — text never wears the series colour. */}
      {hoverPoint?.value != null && hover !== null && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border px-2 py-1 text-xs shadow-sm"
          style={{
            left: Math.min(Math.max(x(hover) - 60, 0), Math.max(0, width - 130)),
            top: 0,
            background: "var(--surface)",
            borderColor: "var(--hairline)",
            color: "var(--ink)",
          }}
        >
          <div style={{ color: "var(--ink-muted)" }}>
            {formatDayShort(hoverPoint.date)}
          </div>
          <div className="flex items-center gap-1.5 font-medium">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: color }}
            />
            <span className="tabular">
              {formatNumber(hoverPoint.value)} {unitLabel(unit)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
