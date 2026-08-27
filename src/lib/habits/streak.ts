import { addDays, dayOfWeek, daysBetween, type DayString } from "@/lib/time/day";

/**
 * Streak calculation.
 *
 * Pure functions over a habit's schedule and its logged days. Streaks are
 * never stored: a counter drifts the moment you back-fill yesterday, edit a
 * schedule, or archive a habit, and a *wrong* streak is worse than no streak
 * because it silently destroys trust in the number. A habit has at most a few
 * thousand entries, so recomputing costs microseconds.
 */

export type Schedule = "daily" | "weekdays" | "custom";

export interface HabitSpec {
  schedule: Schedule;
  /** Bitmask of scheduled weekdays for `custom`. Bit 0 = Sunday. */
  daysMask: number;
  /** Completions needed for the day to count as done. */
  targetPerDay: number;
}

export interface HabitLog {
  date: DayString;
  count: number;
}

export interface StreakResult {
  current: number;
  longest: number;
  /** Scheduled days completed / scheduled days elapsed, over the window. */
  completionRate: number;
  scheduledDays: number;
  completedDays: number;
  /** True when today is scheduled and not yet logged — the streak is at risk. */
  pendingToday: boolean;
}

/** Whether a habit is expected on a given day. */
export function isScheduled(spec: HabitSpec, date: DayString): boolean {
  switch (spec.schedule) {
    case "daily":
      return true;
    case "weekdays": {
      const dow = dayOfWeek(date);
      return dow >= 1 && dow <= 5;
    }
    case "custom":
      return (spec.daysMask & (1 << dayOfWeek(date))) !== 0;
  }
}

/**
 * Current and longest streaks, plus completion rate.
 *
 * @param spec    the habit's schedule and target
 * @param logs    logged days (any order; only scheduled days are considered)
 * @param today   the user's local today
 * @param since   earliest day to consider — usually the habit's creation date
 */
export function computeStreak(
  spec: HabitSpec,
  logs: HabitLog[],
  today: DayString,
  since?: DayString,
): StreakResult {
  const done = new Map<string, number>();
  for (const log of logs) done.set(log.date, log.count);

  const isComplete = (date: DayString): boolean =>
    (done.get(date) ?? 0) >= spec.targetPerDay;

  // Start from the habit's own history rather than an arbitrary window, so a
  // long-running streak isn't truncated by the lookback.
  const earliest =
    since ??
    (logs.length
      ? logs.reduce((min, l) => (l.date < min ? l.date : min), logs[0].date)
      : today);

  /* ------------------------------------------------------------- current -- */
  /**
   * Walk backwards over scheduled days.
   *
   * The rule everyone gets wrong: **an unlogged today does not break the
   * streak.** The day isn't over. Starting the walk at today and stopping on
   * "not complete" would zero a 40-day streak every morning until you ticked
   * the box, which makes the app feel hostile at 9am and is the single fastest
   * way to get someone to stop opening it.
   */
  let current = 0;
  let cursor = today;

  const todayScheduled = isScheduled(spec, today);
  const todayDone = isComplete(today);

  if (todayScheduled && !todayDone) {
    // Today is still open — start counting from yesterday instead.
    cursor = addDays(today, -1);
  }

  while (cursor >= earliest) {
    if (!isScheduled(spec, cursor)) {
      cursor = addDays(cursor, -1);
      continue;
    }
    if (!isComplete(cursor)) break;
    current++;
    cursor = addDays(cursor, -1);
  }

  /* ------------------------------------------------------------- longest -- */
  let longest = 0;
  let run = 0;
  let scheduledDays = 0;
  let completedDays = 0;

  const span = daysBetween(earliest, today);
  for (let i = 0; i <= span; i++) {
    const date = addDays(earliest, i);
    if (!isScheduled(spec, date)) continue;

    // Today only counts against the rate once it's actually finished; an
    // unlogged today would otherwise drag the percentage down all day.
    const countsTowardRate = date !== today || todayDone;
    if (countsTowardRate) scheduledDays++;

    if (isComplete(date)) {
      completedDays++;
      run++;
      if (run > longest) longest = run;
    } else if (date !== today) {
      run = 0;
    }
  }

  return {
    current,
    longest: Math.max(longest, current),
    completionRate: scheduledDays > 0 ? completedDays / scheduledDays : 0,
    scheduledDays,
    completedDays,
    pendingToday: todayScheduled && !todayDone,
  };
}

/**
 * Per-day completion state over a window, for the heatmap.
 *
 * Distinguishes "not scheduled" from "scheduled and missed" — greying out a
 * rest day the same as a failure would misrepresent a perfectly kept habit.
 */
export type DayState = "complete" | "partial" | "missed" | "unscheduled" | "future";

export function habitCalendar(
  spec: HabitSpec,
  logs: HabitLog[],
  from: DayString,
  to: DayString,
  today: DayString,
): { date: DayString; state: DayState; count: number }[] {
  const done = new Map<string, number>();
  for (const log of logs) done.set(log.date, log.count);

  const out: { date: DayString; state: DayState; count: number }[] = [];
  const span = daysBetween(from, to);

  for (let i = 0; i <= span; i++) {
    const date = addDays(from, i);
    const count = done.get(date) ?? 0;

    let state: DayState;
    if (date > today) state = "future";
    else if (!isScheduled(spec, date)) state = "unscheduled";
    else if (count >= spec.targetPerDay) state = "complete";
    else if (count > 0) state = "partial";
    else state = "missed";

    out.push({ date, state, count });
  }

  return out;
}

/** `daysMask` → weekday indices, for rendering a schedule. */
export function maskToDays(mask: number): number[] {
  return [0, 1, 2, 3, 4, 5, 6].filter((d) => (mask & (1 << d)) !== 0);
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A human description of when a habit is expected. */
export function describeSchedule(spec: HabitSpec): string {
  if (spec.schedule === "daily") return "Every day";
  if (spec.schedule === "weekdays") return "Weekdays";

  const days = maskToDays(spec.daysMask);
  if (days.length === 7) return "Every day";
  if (days.length === 0) return "No days set";
  return days.map((d) => DAY_LABELS[d]).join(", ");
}
