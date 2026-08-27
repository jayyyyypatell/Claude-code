import { client } from "@/db/index";
import {
  computeStreak,
  habitCalendar,
  type DayState,
  type HabitLog,
  type HabitSpec,
  type Schedule,
  type StreakResult,
} from "@/lib/habits/streak";
import { addDays, dayOfWeek, todayLocal, type DayString } from "@/lib/time/day";

export interface Habit extends HabitSpec {
  id: number;
  name: string;
  emoji: string;
  color: string;
  schedule: Schedule;
  sortOrder: number;
  archivedAt: number | null;
}

export interface HabitWithProgress extends Habit {
  streak: StreakResult;
  /** Today's logged count. */
  todayCount: number;
  calendar: { date: DayString; state: DayState; count: number }[];
}

const COLOR_TOKENS = ["indigo", "emerald", "amber", "rose", "sky", "violet"];

function rowToHabit(row: Record<string, unknown>): Habit {
  return {
    id: Number(row.id),
    name: String(row.name),
    emoji: String(row.emoji ?? "✅"),
    color: COLOR_TOKENS.includes(String(row.color))
      ? String(row.color)
      : "indigo",
    schedule: String(row.schedule) as Schedule,
    daysMask: Number(row.days_mask ?? 127),
    targetPerDay: Number(row.target_per_day ?? 1),
    sortOrder: Number(row.sort_order ?? 0),
    archivedAt: row.archived_at === null ? null : Number(row.archived_at),
  };
}

/**
 * Every active habit with its streak and a calendar window.
 *
 * All entries for the window are fetched in one query and grouped in memory
 * rather than issuing a query per habit — a dozen habits would otherwise mean
 * a dozen round trips on every page load.
 */
export async function listHabitsWithProgress(
  today: DayString = todayLocal(),
  calendarDays = 84,
): Promise<HabitWithProgress[]> {
  const habitRows = await client.execute(`
    SELECT id, name, emoji, color, schedule, days_mask, target_per_day,
           sort_order, archived_at
    FROM habits
    WHERE archived_at IS NULL
    ORDER BY sort_order, id
  `);
  if (habitRows.rows.length === 0) return [];

  /**
   * Align the calendar window to a Sunday.
   *
   * The heatmap chunks days into columns of seven, so each row is a weekday —
   * but only if the window starts on one. An arbitrary start date silently
   * rotates every row, which makes a tidy Mon/Wed/Fri habit look like scattered
   * noise and hides the weekday patterns the grid exists to show.
   */
  const rawFrom = addDays(today, -(calendarDays - 1));
  const from = addDays(rawFrom, -dayOfWeek(rawFrom));

  const entryRows = await client.execute({
    sql: `SELECT habit_id, date, count FROM habit_entries
          WHERE date >= ? ORDER BY date`,
    args: [from],
  });

  // Streaks need history beyond the calendar window, or a 100-day streak would
  // be reported as 84.
  const allRows = await client.execute(
    "SELECT habit_id, date, count FROM habit_entries ORDER BY date",
  );

  const byHabit = new Map<number, HabitLog[]>();
  for (const r of allRows.rows) {
    const id = Number(r.habit_id);
    const list = byHabit.get(id) ?? [];
    list.push({ date: String(r.date), count: Number(r.count) });
    byHabit.set(id, list);
  }

  const windowByHabit = new Map<number, HabitLog[]>();
  for (const r of entryRows.rows) {
    const id = Number(r.habit_id);
    const list = windowByHabit.get(id) ?? [];
    list.push({ date: String(r.date), count: Number(r.count) });
    windowByHabit.set(id, list);
  }

  return habitRows.rows.map((row) => {
    const habit = rowToHabit(row as Record<string, unknown>);
    const all = byHabit.get(habit.id) ?? [];
    const windowed = windowByHabit.get(habit.id) ?? [];

    return {
      ...habit,
      streak: computeStreak(habit, all, today),
      todayCount: all.find((l) => l.date === today)?.count ?? 0,
      calendar: habitCalendar(habit, windowed, from, today, today),
    };
  });
}

/**
 * Set a habit's count for a day.
 *
 * Upsert rather than insert: ticking a habit twice must not create two rows,
 * and a count of zero deletes the row rather than storing a falsy entry, so
 * "not done" has exactly one representation.
 */
export async function setHabitEntry(
  habitId: number,
  date: DayString,
  count: number,
): Promise<void> {
  if (count <= 0) {
    await client.execute({
      sql: "DELETE FROM habit_entries WHERE habit_id = ? AND date = ?",
      args: [habitId, date],
    });
    return;
  }

  await client.execute({
    sql: `INSERT INTO habit_entries (habit_id, date, count)
          VALUES (?, ?, ?)
          ON CONFLICT (habit_id, date) DO UPDATE SET count = excluded.count`,
    args: [habitId, date, count],
  });
}

export async function createHabit(input: {
  name: string;
  emoji?: string;
  color?: string;
  schedule?: Schedule;
  daysMask?: number;
  targetPerDay?: number;
}): Promise<number> {
  const next = await client.execute(
    "SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM habits",
  );

  const r = await client.execute({
    sql: `INSERT INTO habits
            (name, emoji, color, schedule, days_mask, target_per_day, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          RETURNING id`,
    args: [
      input.name.trim().slice(0, 80),
      input.emoji?.slice(0, 8) || "✅",
      COLOR_TOKENS.includes(input.color ?? "") ? input.color! : "indigo",
      input.schedule ?? "daily",
      Math.max(0, Math.min(127, input.daysMask ?? 127)),
      Math.max(1, Math.min(50, input.targetPerDay ?? 1)),
      Number(next.rows[0].n),
    ],
  });
  return Number(r.rows[0].id);
}

/**
 * Archive rather than delete.
 *
 * Deleting a habit would take its history with it — including the streak you
 * were proud of. Archiving hides it from the list while keeping the record.
 */
export async function archiveHabit(habitId: number): Promise<void> {
  await client.execute({
    sql: "UPDATE habits SET archived_at = unixepoch() * 1000 WHERE id = ?",
    args: [habitId],
  });
}

export async function unarchiveHabit(habitId: number): Promise<void> {
  await client.execute({
    sql: "UPDATE habits SET archived_at = NULL WHERE id = ?",
    args: [habitId],
  });
}
