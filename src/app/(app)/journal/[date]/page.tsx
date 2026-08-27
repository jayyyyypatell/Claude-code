import Link from "next/link";
import { notFound } from "next/navigation";

import { saveJournalAction } from "@/app/actions";
import { getJournalEntry } from "@/db/queries/journal";
import { getSleepNights, getTodayMetrics } from "@/db/queries/metrics";
import { formatDuration, formatValue } from "@/lib/format";
import { addDays, formatDayShort, todayLocal } from "@/lib/time/day";

export const dynamic = "force-dynamic";

/**
 * The day editor.
 *
 * The day's health numbers sit above the text box on purpose. Writing "felt
 * rough today" is more useful when you can see that you slept 5h20m — it turns
 * a vague note into a note with a cause attached, which is exactly what makes
 * the journal worth anything to the coach later.
 */
export default async function JournalDayPage({
  params,
}: {
  params: Promise<{ date: string }>;
}) {
  const { date } = await params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) notFound();

  const today = todayLocal();

  const [entry, metrics, nights] = await Promise.all([
    getJournalEntry(date),
    getTodayMetrics(
      ["step_count", "resting_heart_rate", "active_energy"],
      date,
    ),
    getSleepNights(date, date),
  ]);

  const night = nights[0] ?? null;

  return (
    <main className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold" style={{ color: "var(--ink)" }}>
            {formatDayShort(date)}
          </h1>
          <p className="text-sm" style={{ color: "var(--ink-muted)" }}>
            {date === today ? "Today" : date}
          </p>
        </div>
        <Link
          href="/journal"
          className="text-sm hover:underline"
          style={{ color: "var(--series-1)" }}
        >
          All entries
        </Link>
      </div>

      {/* Day navigation — flicking back through the week shouldn't need the
          index page. Forward is capped at today; there is nothing to write
          about tomorrow. */}
      <div className="flex items-center gap-2 text-sm">
        <Link
          href={`/journal/${addDays(date, -1)}`}
          className="rounded-lg border px-3 py-1.5"
          style={{
            borderColor: "var(--hairline)",
            color: "var(--ink-2)",
            background: "var(--surface)",
          }}
        >
          ← Previous day
        </Link>
        {date < today && (
          <Link
            href={`/journal/${addDays(date, 1)}`}
            className="rounded-lg border px-3 py-1.5"
            style={{
              borderColor: "var(--hairline)",
              color: "var(--ink-2)",
              background: "var(--surface)",
            }}
          >
            Next day →
          </Link>
        )}
      </div>

      {(night || metrics.some((m) => m.value != null)) && (
        <section
          className="flex flex-wrap gap-x-6 gap-y-2 rounded-xl border p-4 text-sm"
          style={{
            background: "var(--surface)",
            borderColor: "var(--hairline)",
          }}
        >
          {night && (
            <Fact label="Slept" value={formatDuration(night.totalSleepMin)} />
          )}
          {metrics
            .filter((m) => m.value != null)
            .map((m) => (
              <Fact
                key={m.key}
                label={m.displayName}
                value={formatValue(m.value, m.unit)}
              />
            ))}
        </section>
      )}

      <form
        action={saveJournalAction}
        className="flex flex-col gap-4 rounded-xl border p-4"
        style={{ background: "var(--surface)", borderColor: "var(--hairline)" }}
      >
        <input type="hidden" name="date" value={date} />

        <label className="flex flex-col gap-1">
          <span className="text-xs" style={{ color: "var(--ink-2)" }}>
            How was the day? Use #tags to group things.
          </span>
          <textarea
            name="body"
            rows={8}
            defaultValue={entry?.body ?? ""}
            placeholder="Slept badly, too much coffee after 4pm. #tired"
            className="w-full resize-y rounded-lg border p-3 text-sm leading-relaxed outline-none"
            style={{
              background: "var(--surface-2)",
              borderColor: "var(--hairline)",
              color: "var(--ink)",
            }}
          />
        </label>

        <div className="flex flex-wrap gap-6">
          <ScaleInput name="mood" label="Mood" value={entry?.mood ?? null} />
          <ScaleInput name="energy" label="Energy" value={entry?.energy ?? null} />
        </div>

        <label
          className="flex items-center gap-2 text-sm"
          style={{ color: "var(--ink-2)" }}
        >
          <input
            type="checkbox"
            name="isPrivate"
            defaultChecked={entry?.isPrivate ?? false}
          />
          Keep this entry private — never send it to the AI coach
        </label>

        <button
          type="submit"
          className="self-start rounded-lg px-4 py-2 text-sm font-medium text-white"
          style={{ background: "var(--series-1)" }}
        >
          Save
        </button>
      </form>
    </main>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span className="text-xs" style={{ color: "var(--ink-muted)" }}>
        {label}{" "}
      </span>
      <span className="tabular font-medium" style={{ color: "var(--ink)" }}>
        {value}
      </span>
    </span>
  );
}

/**
 * A 1–5 scale as radio buttons.
 *
 * Radios rather than a slider: a slider implies a continuum and invites
 * fiddling, while five labelled options are one tap and honest about the
 * granularity. "Not set" is a real option — forcing a number on a day you
 * didn't think about it would put noise into the data the coach reads.
 */
function ScaleInput({
  name,
  label,
  value,
}: {
  name: string;
  label: string;
  value: number | null;
}) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-xs" style={{ color: "var(--ink-2)" }}>
        {label}
      </legend>
      <div className="flex items-center gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <label
            key={n}
            className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg border text-sm"
            style={{
              borderColor: value === n ? "var(--series-1)" : "var(--hairline)",
              background: value === n ? "var(--series-1)" : "var(--surface-2)",
              color: value === n ? "#fff" : "var(--ink-2)",
            }}
          >
            <input
              type="radio"
              name={name}
              value={n}
              defaultChecked={value === n}
              className="sr-only"
            />
            {n}
          </label>
        ))}
        <label
          className="ml-1 flex cursor-pointer items-center gap-1 text-xs"
          style={{ color: "var(--ink-muted)" }}
        >
          <input
            type="radio"
            name={name}
            value=""
            defaultChecked={value == null}
          />
          not set
        </label>
      </div>
    </fieldset>
  );
}
