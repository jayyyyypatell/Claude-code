import Link from "next/link";

import { listJournalEntries, searchJournal } from "@/db/queries/journal";
import { addDays, formatDayShort, todayLocal } from "@/lib/time/day";

export const dynamic = "force-dynamic";

/**
 * The journal index.
 *
 * A list rather than a wall of full entries: you scan for the day you want,
 * then open it. Mood and energy show as small pips so a bad stretch is visible
 * without reading a word.
 */
export default async function JournalPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const today = todayLocal();

  const entries = q?.trim()
    ? await searchJournal(q)
    : await listJournalEntries(addDays(today, -365), today, 100);

  const todayEntry = entries.find((e) => e.date === today);

  return (
    <main className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold" style={{ color: "var(--ink)" }}>
          Journal
        </h1>
        <Link
          href={`/journal/${today}`}
          className="rounded-lg px-3 py-2 text-sm font-medium text-white"
          style={{ background: "var(--series-1)" }}
        >
          {todayEntry ? "Edit today" : "Write today"}
        </Link>
      </div>

      <form action="/journal" className="flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={q ?? ""}
          placeholder="Search entries and #tags…"
          aria-label="Search journal"
          className="flex-1 rounded-lg border px-3 py-2 text-sm"
          style={{
            background: "var(--surface)",
            borderColor: "var(--hairline)",
            color: "var(--ink)",
          }}
        />
      </form>

      {entries.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--ink-2)" }}>
          {q
            ? `Nothing matches “${q}”.`
            : "No entries yet. A sentence a day is enough — it's what lets the coach explain why a week went the way it did."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {entries.map((entry) => (
            <li key={entry.id}>
              <Link
                href={`/journal/${entry.date}`}
                className="block rounded-xl border p-4 transition-colors hover:border-current"
                style={{
                  background: "var(--surface)",
                  borderColor: "var(--hairline)",
                }}
              >
                <div className="mb-1 flex items-center justify-between gap-3">
                  <span
                    className="text-sm font-medium"
                    style={{ color: "var(--ink)" }}
                  >
                    {formatDayShort(entry.date)}
                    {entry.date === today && (
                      <span
                        className="ml-2 text-xs font-normal"
                        style={{ color: "var(--ink-muted)" }}
                      >
                        today
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-2">
                    {entry.isPrivate && (
                      <span
                        className="text-xs"
                        style={{ color: "var(--ink-muted)" }}
                        title="Hidden from the AI coach"
                      >
                        🔒 private
                      </span>
                    )}
                    <Pips label="Mood" value={entry.mood} />
                    <Pips label="Energy" value={entry.energy} />
                  </span>
                </div>

                <p
                  className="line-clamp-2 text-sm"
                  style={{ color: "var(--ink-2)" }}
                >
                  {entry.body || <em>No text</em>}
                </p>

                {entry.tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {entry.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full px-2 py-0.5 text-xs"
                        style={{
                          background: "var(--surface-2)",
                          color: "var(--ink-2)",
                        }}
                      >
                        #{tag}
                      </span>
                    ))}
                  </div>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

/**
 * A 1–5 scale as five pips.
 *
 * Pips rather than a number because the value is subjective and coarse —
 * "3.0 mood" implies a precision that self-reporting doesn't have. The label
 * is in the title so the pips are never colour-and-shape alone.
 */
function Pips({ label, value }: { label: string; value: number | null }) {
  if (value == null) return null;

  return (
    <span
      className="flex items-center gap-0.5"
      title={`${label}: ${value} of 5`}
      aria-label={`${label}: ${value} of 5`}
    >
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{
            background: i <= value ? "var(--series-1)" : "var(--surface-2)",
          }}
        />
      ))}
    </span>
  );
}
