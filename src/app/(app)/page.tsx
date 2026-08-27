import Link from "next/link";

import { HabitList, type HabitItem } from "@/components/HabitList";
import { StatTile } from "@/components/StatTile";
import { SyncBadge } from "@/components/SyncBadge";
import { listHabitsWithProgress } from "@/db/queries/habits";
import { latestInsight } from "@/db/queries/insights";
import { getJournalEntry } from "@/db/queries/journal";
import {
  getSleepNights,
  getSyncStatus,
  getTodayMetrics,
  getWorkouts,
} from "@/db/queries/metrics";
import { maybeTriggerWeekly } from "@/lib/ai/trigger";
import { describeSchedule, isScheduled } from "@/lib/habits/streak";
import { formatDuration, formatValue } from "@/lib/format";
import { addDays, formatDayShort, todayLocal } from "@/lib/time/day";

export const dynamic = "force-dynamic";

/**
 * Today.
 *
 * The organising idea: **lead with what's different, not with everything.**
 * A fixed grid of the same numbers every morning becomes wallpaper within a
 * week. So the tiles are ordered by how far today sits from your own trailing
 * baseline, and anything genuinely unusual gets called out in a sentence above
 * them. On an ordinary day nothing shouts, which is itself information.
 */

const PINNED = [
  "step_count",
  "active_energy",
  "resting_heart_rate",
  "heart_rate_variability",
  "apple_exercise_time",
  "weight_body_mass",
];

export default async function TodayPage() {
  // The clock is read in the query layer, not here — a component that reads
  // the clock is impure, and every date on this page should agree with the
  // data it was fetched alongside.
  const sync = await getSyncStatus();
  const today = todayLocal(undefined, sync.now);

  // Generate last week's report if it's missing — fire-and-forget, so the page
  // never waits on a model call. This is the zero-infrastructure scheduler.
  maybeTriggerWeekly();

  const [metrics, nights, workouts, habits, journalToday] = await Promise.all([
    getTodayMetrics(PINNED, today),
    getSleepNights(addDays(today, -2), today),
    getWorkouts(addDays(today, -1), today, 3),
    listHabitsWithProgress(today),
    getJournalEntry(today),
  ]);

  const insight = await latestInsight();

  // Only what is actually expected today — a Mon/Wed/Fri habit on a Tuesday
  // is noise on this page, not a reminder.
  const dueHabits: HabitItem[] = habits
    .filter((h) => isScheduled(h, today))
    .map((h) => ({
      id: h.id,
      name: h.name,
      emoji: h.emoji,
      color: h.color,
      targetPerDay: h.targetPerDay,
      todayCount: h.todayCount,
      scheduleLabel: describeSchedule(h),
      streak: {
        current: h.streak.current,
        longest: h.streak.longest,
        completionRate: h.streak.completionRate,
      },
      dueToday: true,
    }));

  const habitsDone = dueHabits.filter(
    (h) => h.todayCount >= h.targetPerDay,
  ).length;

  const lastNight = nights.at(-1) ?? null;

  // Rank by |z|, so the unusual floats up. Metrics with no reading today sink
  // rather than occupying a prime slot with an em-dash.
  const ranked = [...metrics].sort((a, b) => {
    if (a.value == null && b.value != null) return 1;
    if (b.value == null && a.value != null) return -1;
    return Math.abs(b.zScore ?? 0) - Math.abs(a.zScore ?? 0);
  });

  const notable = ranked.filter(
    (m) => m.zScore != null && Math.abs(m.zScore) >= 1.5 && m.value != null,
  );

  const hasAnyData = metrics.some((m) => m.value != null) || lastNight;

  return (
    <main className="flex flex-col gap-6">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold" style={{ color: "var(--ink)" }}>
            Today
          </h1>
          <p className="text-sm" style={{ color: "var(--ink-muted)" }}>
            {formatDayShort(today)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SyncBadge
            lastIngestAt={sync.lastIngestAt}
            status={sync.lastStatus}
            source={sync.lastSource}
            now={sync.now}
          />
          <Link
            href="/settings"
            aria-label="Settings"
            className="rounded-full border p-1.5"
            style={{
              borderColor: "var(--hairline)",
              background: "var(--surface)",
              color: "var(--ink-muted)",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </Link>
        </div>
      </header>

      {!hasAnyData && <EmptyState />}

      {insight && (
        <Link
          href="/coach"
          className="rounded-xl border p-4 transition-colors"
          style={{
            background: "var(--surface)",
            borderColor: "var(--hairline)",
          }}
        >
          <div
            className="mb-1 text-xs font-medium uppercase tracking-wide"
            style={{ color: "var(--ink-muted)" }}
          >
            This week
          </div>
          <p className="text-sm" style={{ color: "var(--ink)" }}>
            {insight.summary}
          </p>
        </Link>
      )}

      {notable.length > 0 && (
        <section
          className="rounded-xl border p-4"
          style={{
            background: "var(--surface)",
            borderColor: "var(--hairline)",
          }}
        >
          <h2
            className="mb-1 text-xs font-medium uppercase tracking-wide"
            style={{ color: "var(--ink-muted)" }}
          >
            Worth noticing
          </h2>
          <ul className="flex flex-col gap-1">
            {notable.slice(0, 3).map((m) => (
              <li key={m.key} className="text-sm" style={{ color: "var(--ink)" }}>
                <span className="font-medium">{m.displayName}</span> is{" "}
                {m.zScore! > 0 ? "well above" : "well below"} your usual —{" "}
                <span className="tabular">
                  {formatValue(m.value, m.unit)}
                </span>{" "}
                against a typical{" "}
                <span className="tabular">
                  {formatValue(m.baseline, m.unit)}
                </span>
                .
              </li>
            ))}
          </ul>
        </section>
      )}

      {lastNight && (
        <section className="flex flex-col gap-2">
          <SectionHeading href="/sleep">Last night</SectionHeading>
          <div
            className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border p-4"
            style={{
              background: "var(--surface)",
              borderColor: "var(--hairline)",
            }}
          >
            <div>
              <div
                className="text-2xl font-semibold"
                style={{ color: "var(--ink)" }}
              >
                {formatDuration(lastNight.totalSleepMin)}
              </div>
              <div className="text-xs" style={{ color: "var(--ink-2)" }}>
                asleep
              </div>
            </div>
            <StageBreakdown night={lastNight} />
          </div>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <SectionHeading href="/trends">Today&rsquo;s numbers</SectionHeading>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          {ranked.map((m) => (
            <StatTile
              key={m.key}
              label={m.displayName}
              value={m.value}
              unit={m.unit}
              metricKey={m.key}
              changePct={m.changePct}
              spark={m.spark}
              asOf={m.asOf}
            />
          ))}
        </div>
      </section>

      {dueHabits.length > 0 && (
        <section className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <h2
              className="text-xs font-medium uppercase tracking-wide"
              style={{ color: "var(--ink-muted)" }}
            >
              Habits
            </h2>
            <span className="text-xs" style={{ color: "var(--ink-muted)" }}>
              <span className="tabular">
                {habitsDone}/{dueHabits.length}
              </span>{" "}
              done
            </span>
          </div>
          <HabitList habits={dueHabits} date={today} compact />
        </section>
      )}

      <section className="flex flex-col gap-2">
        <SectionHeading href="/journal">Journal</SectionHeading>
        <Link
          href={`/journal/${today}`}
          className="block rounded-xl border p-4 transition-colors"
          style={{
            background: "var(--surface)",
            borderColor: "var(--hairline)",
          }}
        >
          {journalToday?.body ? (
            <p
              className="line-clamp-3 text-sm"
              style={{ color: "var(--ink-2)" }}
            >
              {journalToday.body}
            </p>
          ) : (
            <p className="text-sm" style={{ color: "var(--ink-muted)" }}>
              Nothing written today. Even a sentence helps — it&rsquo;s what lets
              the coach explain <em>why</em> a week went the way it did.
            </p>
          )}
        </Link>
      </section>

      {workouts.length > 0 && (
        <section className="flex flex-col gap-2">
          <SectionHeading>Recent workouts</SectionHeading>
          <ul
            className="divide-y rounded-xl border"
            style={{
              background: "var(--surface)",
              borderColor: "var(--hairline)",
            }}
          >
            {workouts.map((w) => (
              <li
                key={w.id}
                className="flex items-center justify-between gap-3 p-3 text-sm"
                style={{ borderColor: "var(--hairline)" }}
              >
                <span style={{ color: "var(--ink)" }}>{w.name}</span>
                <span className="tabular" style={{ color: "var(--ink-2)" }}>
                  {formatDuration(w.durationSec / 60)}
                  {w.activeEnergyKcal
                    ? ` · ${Math.round(w.activeEnergyKcal)} kcal`
                    : ""}
                  {w.avgHeartRate ? ` · ${Math.round(w.avgHeartRate)} bpm` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

function SectionHeading({
  children,
  href,
}: {
  children: React.ReactNode;
  href?: string;
}) {
  return (
    <div className="flex items-baseline justify-between">
      <h2
        className="text-xs font-medium uppercase tracking-wide"
        style={{ color: "var(--ink-muted)" }}
      >
        {children}
      </h2>
      {href && (
        <Link
          href={href}
          className="text-xs hover:underline"
          style={{ color: "var(--series-1)" }}
        >
          See all
        </Link>
      )}
    </div>
  );
}

/**
 * A single night's stages as one proportional bar.
 *
 * Same ordinal ramp as the sleep page, and the labels are visible rather than
 * hover-only — the aqua/light steps sit below 3:1 on the light surface, and the
 * relief rule for that is exactly this: show the text.
 */
function StageBreakdown({
  night,
}: {
  night: {
    deepMin: number | null;
    coreMin: number | null;
    remMin: number | null;
    awakeMin: number | null;
  };
}) {
  const stages = [
    { label: "Deep", minutes: night.deepMin ?? 0, color: "var(--sleep-deep)" },
    { label: "Core", minutes: night.coreMin ?? 0, color: "var(--sleep-core)" },
    { label: "REM", minutes: night.remMin ?? 0, color: "var(--sleep-rem)" },
    { label: "Awake", minutes: night.awakeMin ?? 0, color: "var(--sleep-awake)" },
  ].filter((s) => s.minutes > 0);

  const total = stages.reduce((sum, s) => sum + s.minutes, 0);
  if (total === 0) return null;

  return (
    <div className="flex min-w-[200px] flex-1 flex-col gap-2">
      {/* 2px surface gaps do the separating — no strokes. */}
      <div className="flex h-2.5 w-full gap-[2px] overflow-hidden">
        {stages.map((s) => (
          <div
            key={s.label}
            className="h-full rounded-sm"
            style={{
              width: `${(s.minutes / total) * 100}%`,
              background: s.color,
            }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {stages.map((s) => (
          <span
            key={s.label}
            className="flex items-center gap-1 text-xs"
            style={{ color: "var(--ink-2)" }}
          >
            <span
              className="inline-block h-2 w-2 rounded-sm"
              style={{ background: s.color }}
            />
            {s.label}{" "}
            <span className="tabular">{formatDuration(s.minutes)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <section
      className="rounded-xl border p-6 text-sm"
      style={{ background: "var(--surface)", borderColor: "var(--hairline)" }}
    >
      <h2 className="mb-2 font-medium" style={{ color: "var(--ink)" }}>
        No data yet
      </h2>
      <p style={{ color: "var(--ink-2)" }}>
        Nothing has arrived from your phone. Either connect Health Auto Export
        (see the README for the setup steps), or generate some realistic sample
        data to look around with:
      </p>
      <pre
        className="mt-3 overflow-x-auto rounded-lg p-3 text-xs"
        style={{ background: "var(--surface-2)", color: "var(--ink-2)" }}
      >
        npm run seed -- --days=550 --reset
      </pre>
    </section>
  );
}
