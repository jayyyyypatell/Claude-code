"use client";

import { useOptimistic, useTransition } from "react";

import { toggleHabitAction } from "@/app/actions";
import type { DayState } from "@/lib/habits/streak";

/**
 * The daily habit checklist.
 *
 * Ticking is optimistic: the box fills the instant you tap it and the write
 * happens behind that. A habit tracker that pauses for a round trip on every
 * tap feels broken, and this is the one interaction people do every single
 * day — it has to be immediate.
 */

export interface HabitItem {
  id: number;
  name: string;
  emoji: string;
  color: string;
  targetPerDay: number;
  todayCount: number;
  scheduleLabel: string;
  streak: { current: number; longest: number; completionRate: number };
  dueToday: boolean;
}

const ACCENTS: Record<string, string> = {
  indigo: "var(--series-1)",
  emerald: "var(--series-3)",
  amber: "var(--series-4)",
  rose: "var(--series-2)",
  sky: "var(--sleep-rem)",
  violet: "var(--sleep-deep)",
};

export function HabitList({
  habits,
  date,
  compact = false,
}: {
  habits: HabitItem[];
  date: string;
  compact?: boolean;
}) {
  const [, startTransition] = useTransition();

  const [optimistic, applyOptimistic] = useOptimistic(
    habits,
    (state: HabitItem[], update: { id: number; count: number }) =>
      state.map((h) =>
        h.id === update.id ? { ...h, todayCount: update.count } : h,
      ),
  );

  const toggle = (habit: HabitItem): void => {
    // For a multi-count habit, tapping steps up and wraps back to zero at the
    // target — so one control both increments and clears.
    const next =
      habit.targetPerDay > 1
        ? habit.todayCount >= habit.targetPerDay
          ? 0
          : habit.todayCount + 1
        : habit.todayCount > 0
          ? 0
          : 1;

    startTransition(async () => {
      applyOptimistic({ id: habit.id, count: next });
      await toggleHabitAction(habit.id, date, next);
    });
  };

  if (optimistic.length === 0) {
    return (
      <p className="text-sm" style={{ color: "var(--ink-muted)" }}>
        No habits yet.
      </p>
    );
  }

  return (
    <ul
      className="divide-y overflow-hidden rounded-xl border"
      style={{ background: "var(--surface)", borderColor: "var(--hairline)" }}
    >
      {optimistic.map((habit) => {
        const done = habit.todayCount >= habit.targetPerDay;
        const accent = ACCENTS[habit.color] ?? "var(--series-1)";

        return (
          <li
            key={habit.id}
            className="flex items-center gap-3 p-3"
            style={{ borderColor: "var(--hairline)" }}
          >
            <button
              type="button"
              onClick={() => toggle(habit)}
              aria-pressed={done}
              aria-label={`${done ? "Undo" : "Complete"} ${habit.name}`}
              /* 44px hit target — anything smaller is a miss on a phone. */
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-2 transition-colors"
              style={{
                borderColor: done ? accent : "var(--axis)",
                background: done ? accent : "transparent",
                color: done ? "#fff" : "var(--ink-muted)",
              }}
            >
              {habit.targetPerDay > 1 ? (
                <span className="tabular text-sm font-medium">
                  {habit.todayCount}/{habit.targetPerDay}
                </span>
              ) : done ? (
                <CheckIcon />
              ) : (
                <span aria-hidden="true">{habit.emoji}</span>
              )}
            </button>

            <div className="min-w-0 flex-1">
              <div
                className="truncate text-sm font-medium"
                style={{ color: "var(--ink)" }}
              >
                {habit.name}
              </div>
              <div className="text-xs" style={{ color: "var(--ink-muted)" }}>
                {habit.dueToday ? habit.scheduleLabel : "Not due today"}
                {!compact && ` · ${Math.round(habit.streak.completionRate * 100)}% kept`}
              </div>
            </div>

            <StreakBadge current={habit.streak.current} accent={accent} />
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The streak count.
 *
 * Shown without a flame or any celebration below 2 — a "1 day streak" badge on
 * the first day reads as pressure rather than progress.
 */
function StreakBadge({ current, accent }: { current: number; accent: string }) {
  if (current < 2) {
    return (
      <span className="text-xs" style={{ color: "var(--ink-muted)" }}>
        —
      </span>
    );
  }
  return (
    <span
      className="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium"
      style={{
        background: `color-mix(in srgb, ${accent} 14%, transparent)`,
        color: "var(--ink)",
      }}
      title={`${current} in a row`}
    >
      <span className="tabular">{current}</span> day
      {current === 1 ? "" : "s"}
    </span>
  );
}

function CheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 13l4 4L19 7"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * A GitHub-style completion grid.
 *
 * Hand-written SVG rather than a chart library — this is a grid of squares,
 * and every charting library fights you on it.
 */
export function HabitHeatmap({
  calendar,
  color,
}: {
  calendar: { date: string; state: DayState; count: number }[];
  color: string;
}) {
  const accent = ACCENTS[color] ?? "var(--series-1)";
  const CELL = 11;
  const GAP = 3;

  // Column-major weeks, so the grid reads like a calendar.
  const weeks: (typeof calendar)[] = [];
  let current: typeof calendar = [];
  for (const day of calendar) {
    current.push(day);
    if (current.length === 7) {
      weeks.push(current);
      current = [];
    }
  }
  if (current.length) weeks.push(current);

  const fill = (state: DayState): string => {
    switch (state) {
      case "complete":
        return accent;
      case "partial":
        return `color-mix(in srgb, ${accent} 45%, var(--surface-2))`;
      case "missed":
        return "var(--surface-2)";
      default:
        // Unscheduled and future days are barely there — a rest day is not a
        // failure and must not read like one.
        return "transparent";
    }
  };

  // Row labels for alternate days — all seven is noise at this cell size.
  const DAY_INITIALS = ["", "M", "", "W", "", "F", ""];
  const LABEL_W = 14;

  return (
    <svg
      width={LABEL_W + weeks.length * (CELL + GAP)}
      height={7 * (CELL + GAP)}
      role="img"
      aria-label="Completion over the last 12 weeks, one column per week"
    >
      {DAY_INITIALS.map((label, i) =>
        label ? (
          <text
            key={i}
            x={0}
            y={i * (CELL + GAP) + CELL / 2}
            dominantBaseline="middle"
            fontSize={9}
            fill="var(--ink-muted)"
          >
            {label}
          </text>
        ) : null,
      )}
      {weeks.map((week, wi) =>
        week.map((day, di) => (
          <rect
            key={day.date}
            x={LABEL_W + wi * (CELL + GAP)}
            y={di * (CELL + GAP)}
            width={CELL}
            height={CELL}
            rx={2}
            fill={fill(day.state)}
            stroke={day.state === "unscheduled" ? "var(--grid)" : "none"}
            strokeWidth={day.state === "unscheduled" ? 1 : 0}
          >
            <title>{`${day.date}: ${day.state}`}</title>
          </rect>
        )),
      )}
    </svg>
  );
}
