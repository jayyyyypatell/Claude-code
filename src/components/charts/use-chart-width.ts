"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Measure a chart container in real pixels.
 *
 * Charts here render at 1:1 with the container rather than scaling a viewBox,
 * because the mark specs are absolute: a 2px line and an 8px marker have to be
 * 2px and 8px on screen. Scaling a viewBox multiplies stroke widths and text
 * by the scale factor, so a wide chart gets fat lines and a narrow one gets
 * hairlines — the opposite of a consistent visual system.
 */
export function useChartWidth(
  fallback = 640,
): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(Math.floor(w));
    });
    observer.observe(el);
    setWidth(Math.floor(el.getBoundingClientRect().width) || fallback);

    return () => observer.disconnect();
  }, [fallback]);

  return [ref, width];
}

/** Nice round axis ticks — 0 / 2,000 / 4,000 rather than 0 / 1,847 / 3,694. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    return [min];
  }
  const span = max - min;
  const rawStep = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;

  /**
   * Standard nice-number cut points. Using 1/2/5/10 as the *upper* bounds
   * jumps too eagerly to the coarser step — a range of 0–940 landed on a step
   * of 500, leaving a chart with exactly two gridlines. The 1.5/3/7 midpoints
   * pick 200 instead, which is what a person would choose.
   */
  const step =
    (normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10) *
    magnitude;

  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 0.001; v += step) {
    // Floating point accumulates; round to the step's own precision.
    ticks.push(Number(v.toPrecision(12)));
  }
  return ticks;
}
