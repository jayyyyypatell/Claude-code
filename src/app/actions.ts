"use server";

import { revalidatePath } from "next/cache";

import {
  archiveHabit,
  createHabit,
  setHabitEntry,
  unarchiveHabit,
} from "@/db/queries/habits";
import { saveJournalEntry } from "@/db/queries/journal";
import type { Schedule } from "@/lib/habits/streak";
import { todayLocal, type DayString } from "@/lib/time/day";

/**
 * Mutations, as Server Actions.
 *
 * Server Actions rather than API routes: ticking a habit is a form submission,
 * not an API, and this way there is no client-side fetch code, no JSON contract
 * to keep in sync, and no extra endpoint to secure.
 *
 * Everything here validates its own input. A Server Action is a public HTTP
 * endpoint in disguise — the fact that only your own UI calls it today is not
 * a security property.
 */

function assertPositiveInt(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${field}`);
  }
  return n;
}

function assertDay(value: unknown): DayString {
  const s = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error("Invalid date");
  return s;
}

/* ------------------------------------------------------------------ habits */

export async function toggleHabitAction(
  habitId: number,
  date: string,
  nextCount: number,
): Promise<void> {
  const id = assertPositiveInt(habitId, "habit id");
  const day = assertDay(date);
  const count = Math.max(0, Math.min(50, Math.floor(Number(nextCount) || 0)));

  await setHabitEntry(id, day, count);

  // Both pages show habit state, so both need refreshing.
  revalidatePath("/habits");
  revalidatePath("/");
}

export async function createHabitAction(formData: FormData): Promise<void> {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("A habit needs a name");

  const schedule = String(formData.get("schedule") ?? "daily") as Schedule;
  if (!["daily", "weekdays", "custom"].includes(schedule)) {
    throw new Error("Invalid schedule");
  }

  // Custom schedules arrive as a set of checked weekday boxes.
  let daysMask = 127;
  if (schedule === "custom") {
    daysMask = 0;
    for (const raw of formData.getAll("days")) {
      const d = Number(raw);
      if (Number.isInteger(d) && d >= 0 && d <= 6) daysMask |= 1 << d;
    }
    // A custom schedule with nothing selected would never be due, and the
    // habit would sit there permanently neither done nor missed.
    if (daysMask === 0) daysMask = 127;
  }

  await createHabit({
    name,
    emoji: String(formData.get("emoji") ?? "").trim() || "✅",
    color: String(formData.get("color") ?? "indigo"),
    schedule,
    daysMask,
    targetPerDay: Number(formData.get("targetPerDay") ?? 1),
  });

  revalidatePath("/habits");
  revalidatePath("/");
}

export async function archiveHabitAction(habitId: number): Promise<void> {
  await archiveHabit(assertPositiveInt(habitId, "habit id"));
  revalidatePath("/habits");
  revalidatePath("/");
}

export async function unarchiveHabitAction(habitId: number): Promise<void> {
  await unarchiveHabit(assertPositiveInt(habitId, "habit id"));
  revalidatePath("/habits");
}

/* ----------------------------------------------------------------- journal */

export async function saveJournalAction(formData: FormData): Promise<void> {
  const date = assertDay(formData.get("date") ?? todayLocal());

  const scale = (name: string): number | null => {
    const raw = formData.get(name);
    if (raw == null || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };

  await saveJournalEntry({
    date,
    body: String(formData.get("body") ?? ""),
    mood: scale("mood"),
    energy: scale("energy"),
    isPrivate: formData.get("isPrivate") === "on",
  });

  revalidatePath("/journal");
  revalidatePath(`/journal/${date}`);
  revalidatePath("/");
}
