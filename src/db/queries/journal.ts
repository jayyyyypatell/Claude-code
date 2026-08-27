import { client } from "@/db/index";
import { addDays, todayLocal, type DayString } from "@/lib/time/day";

/**
 * Journal entries.
 *
 * This is the only table that records *why*. Health data can show a bad sleep
 * week; only the journal can say "deadline, plus I started drinking coffee
 * after 4pm". The AI coach reads it for exactly that reason — which is also
 * why `isPrivate` exists and is enforced here, in the query layer, rather than
 * by asking the model not to look.
 */

export interface JournalEntry {
  id: number;
  date: DayString;
  body: string;
  mood: number | null;
  energy: number | null;
  tags: string[];
  isPrivate: boolean;
  updatedAt: number;
}

function rowToEntry(row: Record<string, unknown>): JournalEntry {
  let tags: string[] = [];
  if (row.tags) {
    try {
      const parsed = JSON.parse(String(row.tags));
      if (Array.isArray(parsed)) tags = parsed.map(String);
    } catch {
      tags = [];
    }
  }

  return {
    id: Number(row.id),
    date: String(row.date),
    body: String(row.body ?? ""),
    mood: row.mood === null ? null : Number(row.mood),
    energy: row.energy === null ? null : Number(row.energy),
    tags,
    isPrivate: Boolean(row.is_private),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

export async function getJournalEntry(
  date: DayString,
): Promise<JournalEntry | null> {
  const r = await client.execute({
    sql: `SELECT id, date, body, mood, energy, tags, is_private, updated_at
          FROM journal_entries WHERE date = ?`,
    args: [date],
  });
  return r.rows.length ? rowToEntry(r.rows[0] as Record<string, unknown>) : null;
}

export async function listJournalEntries(
  from: DayString,
  to: DayString,
  limit = 100,
): Promise<JournalEntry[]> {
  const r = await client.execute({
    sql: `SELECT id, date, body, mood, energy, tags, is_private, updated_at
          FROM journal_entries
          WHERE date >= ? AND date <= ?
          ORDER BY date DESC LIMIT ?`,
    args: [from, to, limit],
  });
  return r.rows.map((row) => rowToEntry(row as Record<string, unknown>));
}

/**
 * Entries the AI coach is allowed to read.
 *
 * Private entries are excluded by the query itself, so no prompt phrasing or
 * model behaviour can reach them. A privacy control that depends on the model
 * choosing to respect it is not a privacy control.
 */
export async function listJournalForAI(
  from: DayString,
  to: DayString,
  limit = 30,
): Promise<JournalEntry[]> {
  const r = await client.execute({
    sql: `SELECT id, date, body, mood, energy, tags, is_private, updated_at
          FROM journal_entries
          WHERE date >= ? AND date <= ?
            AND is_private = 0
            AND (body != '' OR mood IS NOT NULL OR energy IS NOT NULL)
          ORDER BY date DESC LIMIT ?`,
    args: [from, to, limit],
  });
  return r.rows.map((row) => rowToEntry(row as Record<string, unknown>));
}

/** Hashtags written in the body become tags. */
function extractTags(body: string): string[] {
  const found = body.match(/#([\p{L}\p{N}_-]{1,32})/gu) ?? [];
  return [...new Set(found.map((t) => t.slice(1).toLowerCase()))];
}

export async function saveJournalEntry(input: {
  date: DayString;
  body: string;
  mood?: number | null;
  energy?: number | null;
  isPrivate?: boolean;
}): Promise<void> {
  const body = input.body.slice(0, 20_000);
  const tags = extractTags(body);

  const clampScale = (v: number | null | undefined): number | null => {
    if (v == null || !Number.isFinite(v)) return null;
    return Math.max(1, Math.min(5, Math.round(v)));
  };

  await client.execute({
    sql: `INSERT INTO journal_entries
            (date, body, mood, energy, tags, is_private, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, unixepoch() * 1000)
          ON CONFLICT (date) DO UPDATE SET
            body       = excluded.body,
            mood       = excluded.mood,
            energy     = excluded.energy,
            tags       = excluded.tags,
            is_private = excluded.is_private,
            updated_at = excluded.updated_at`,
    args: [
      input.date,
      body,
      clampScale(input.mood),
      clampScale(input.energy),
      JSON.stringify(tags),
      input.isPrivate ? 1 : 0,
    ],
  });
}

export async function deleteJournalEntry(date: DayString): Promise<void> {
  await client.execute({
    sql: "DELETE FROM journal_entries WHERE date = ?",
    args: [date],
  });
}

/** Substring search across bodies and tags. */
export async function searchJournal(
  query: string,
  limit = 50,
): Promise<JournalEntry[]> {
  const term = `%${query.trim().toLowerCase()}%`;
  const r = await client.execute({
    sql: `SELECT id, date, body, mood, energy, tags, is_private, updated_at
          FROM journal_entries
          WHERE lower(body) LIKE ? OR lower(tags) LIKE ?
          ORDER BY date DESC LIMIT ?`,
    args: [term, term, limit],
  });
  return r.rows.map((row) => rowToEntry(row as Record<string, unknown>));
}

export interface MoodPoint {
  date: DayString;
  mood: number | null;
  energy: number | null;
}

/** Mood and energy over a range, for charting against health metrics. */
export async function getMoodSeries(
  from: DayString,
  to: DayString,
): Promise<MoodPoint[]> {
  const r = await client.execute({
    sql: `SELECT date, mood, energy FROM journal_entries
          WHERE date >= ? AND date <= ?
            AND (mood IS NOT NULL OR energy IS NOT NULL)
          ORDER BY date`,
    args: [from, to],
  });
  return r.rows.map((row) => ({
    date: String(row.date),
    mood: row.mood === null ? null : Number(row.mood),
    energy: row.energy === null ? null : Number(row.energy),
  }));
}

/** Recent days that have no entry — for a gentle "you haven't written" prompt. */
export async function recentEmptyDays(
  today: DayString = todayLocal(),
  lookback = 7,
): Promise<DayString[]> {
  const from = addDays(today, -(lookback - 1));
  const r = await client.execute({
    sql: `SELECT date FROM journal_entries
          WHERE date >= ? AND date <= ? AND body != ''`,
    args: [from, today],
  });
  const filled = new Set(r.rows.map((row) => String(row.date)));

  const out: DayString[] = [];
  for (let i = 0; i < lookback; i++) {
    const date = addDays(today, -i);
    if (!filled.has(date)) out.push(date);
  }
  return out;
}
