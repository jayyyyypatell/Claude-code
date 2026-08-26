"use client";

import { useMemo, useState } from "react";

import {
  formatClock,
  formatDayShort,
  minutesFromMidnightSigned,
} from "@/lib/time/day";

import { useChartWidth } from "./use-chart-width";

/**
 * When you fell asleep and woke, night by night.
 *
 * The axis is the reason this chart works. Clock time wraps at midnight, so
 * plotting 23:30 and 00:30 on a 0–24 axis puts them at opposite ends of the
 * chart despite being an hour apart — and a week of ordinary bedtimes looks
 * like wild chaos. Times from 18:00 are therefore expressed as negative
 * minutes before the following midnight, putting the whole night on one
 * continuous axis (see `minutesFromMidnightSigned`).
 *
 * Two series, so a legend is present. They are one hue at two shades rather
 * than two hues: bedtime and wake time are the same kind of thing, and the
 * span between them is what the eye should follow.
 */

export interface ConsistencyNight {
  date: string;
  startAt: number;
  endAt: number;
}

const PAD = { top: 12, right: 16, bottom: 26, left: 52 };

function labelForMinutes(m: number): string {
  const wrapped = ((m % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const min = wrapped % 60;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export function BedtimeConsistency({
  nights,
  height = 220,
}: {
  nights: ConsistencyNight[];
  height?: number;
}) {
  const [ref, width] = useChartWidth();
  const [hover, setHover] = useState<number | null>(null);

  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = Math.max(10, height - PAD.top - PAD.bottom);

  const rows = useMemo(
    () =>
      nights.map((n) => ({
        ...n,
        bed: minutesFromMidnightSigned(n.startAt),
        wake: minutesFromMidnightSigned(n.endAt),
      })),
    [nights],
  );

  const { lo, hi, ticks } = useMemo(() => {
    if (rows.length === 0) return { lo: -120, hi: 540, ticks: [] as number[] };
    const values = rows.flatMap((r) => [r.bed, r.wake]);
    const min = Math.min(...values) - 30;
    const max = Math.max(...values) + 30;

    // Hour ticks across the visible span.
    const first = Math.ceil(min / 60) * 60;
    const step = max - min > 600 ? 120 : 60;
    const out: number[] = [];
    for (let v = first; v <= max; v += step) out.push(v);
    return { lo: min, hi: max, ticks: out };
  }, [rows]);

  const y = (minutes: number): number =>
    PAD.top + ((minutes - lo) / (hi - lo || 1)) * plotH;

  const band = rows.length ? plotW / rows.length : plotW;
  const barW = Math.min(10, Math.max(2, band - 4));

  const handleMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const idx = Math.floor((e.clientX - rect.left - PAD.left) / band);
    setHover(idx >= 0 && idx < rows.length ? idx : null);
  };

  if (rows.length === 0) return null;
  const hovered = hover !== null ? rows[hover] : null;

  return (
    <div ref={ref} className="w-full">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`Bedtime and wake time across ${rows.length} nights`}
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
              {labelForMinutes(t)}
            </text>
          </g>
        ))}

        {/* midnight, marked because it is the reference everyone reads against */}
        {lo < 0 && hi > 0 && (
          <line
            x1={PAD.left}
            x2={PAD.left + plotW}
            y1={y(0)}
            y2={y(0)}
            stroke="var(--axis)"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        )}

        {rows.map((row, i) => {
          const cx = PAD.left + i * band + (band - barW) / 2;
          const top = y(row.bed);
          const bottom = y(row.wake);

          return (
            <g key={row.date} opacity={hover === null || hover === i ? 1 : 0.4}>
              <rect
                x={cx}
                y={top}
                width={barW}
                height={Math.max(2, bottom - top)}
                rx={barW / 2}
                fill="var(--series-1)"
                opacity={0.35}
              />
              {/* end caps carry the surface ring so they stay legible when
                  adjacent nights nearly touch */}
              <circle
                cx={cx + barW / 2}
                cy={top}
                r={3}
                fill="var(--sleep-deep)"
                stroke="var(--surface)"
                strokeWidth={1.5}
              />
              <circle
                cx={cx + barW / 2}
                cy={bottom}
                r={3}
                fill="var(--sleep-rem)"
                stroke="var(--surface)"
                strokeWidth={1.5}
              />
            </g>
          );
        })}

        <text x={PAD.left} y={height - 6} fontSize={11} fill="var(--ink-muted)">
          {formatDayShort(rows[0].date)}
        </text>
        <text
          x={PAD.left + plotW}
          y={height - 6}
          textAnchor="end"
          fontSize={11}
          fill="var(--ink-muted)"
        >
          {formatDayShort(rows[rows.length - 1].date)}
        </text>
      </svg>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <LegendItem color="var(--sleep-deep)" label="Fell asleep" />
        <LegendItem color="var(--sleep-rem)" label="Woke" />
      </div>

      <div
        className="mt-2 min-h-[1.25rem] text-xs"
        style={{ color: "var(--ink-2)" }}
        aria-live="polite"
      >
        {hovered ? (
          <>
            <span className="font-medium" style={{ color: "var(--ink)" }}>
              {formatDayShort(hovered.date)}
            </span>{" "}
            — asleep {formatClock(hovered.startAt)}, woke{" "}
            {formatClock(hovered.endAt)}
          </>
        ) : (
          <span style={{ color: "var(--ink-muted)" }}>
            Hover a night for exact times.
          </span>
        )}
      </div>
    </div>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span
      className="flex items-center gap-1.5 text-xs"
      style={{ color: "var(--ink-2)" }}
    >
      <span
        className="inline-block h-2.5 w-2.5 rounded-full"
        style={{ background: color }}
      />
      {label}
    </span>
  );
}
