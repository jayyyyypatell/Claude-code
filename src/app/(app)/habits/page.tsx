import { createHabitAction } from "@/app/actions";
import { HabitHeatmap, HabitList, type HabitItem } from "@/components/HabitList";
import { listHabitsWithProgress } from "@/db/queries/habits";
import { describeSchedule, isScheduled } from "@/lib/habits/streak";
import { todayLocal } from "@/lib/time/day";

export const dynamic = "force-dynamic";

/**
 * Habits.
 *
 * Today's checklist first, then a per-habit heatmap. The ordering is
 * deliberate: the thing you came to do (tick a box) is at the top, and the
 * thing you came to look at (how you're doing) is below it.
 */
export default async function HabitsPage() {
  const today = todayLocal();
  const habits = await listHabitsWithProgress(today);

  const items: HabitItem[] = habits.map((h) => ({
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
    dueToday: isScheduled(h, today),
  }));

  return (
    <main className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold" style={{ color: "var(--ink)" }}>
        Habits
      </h1>

      {habits.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--ink-2)" }}>
          No habits yet — add one below to start tracking.
        </p>
      ) : (
        <>
          <section className="flex flex-col gap-2">
            <h2
              className="text-xs font-medium uppercase tracking-wide"
              style={{ color: "var(--ink-muted)" }}
            >
              Today
            </h2>
            <HabitList habits={items} date={today} />
          </section>

          <section className="flex flex-col gap-2">
            <h2
              className="text-xs font-medium uppercase tracking-wide"
              style={{ color: "var(--ink-muted)" }}
            >
              Last 12 weeks
            </h2>
            <div className="flex flex-col gap-3">
              {habits.map((h) => (
                <div
                  key={h.id}
                  className="rounded-xl border p-4"
                  style={{
                    background: "var(--surface)",
                    borderColor: "var(--hairline)",
                  }}
                >
                  <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                    <span
                      className="text-sm font-medium"
                      style={{ color: "var(--ink)" }}
                    >
                      {h.emoji} {h.name}
                    </span>
                    <span className="text-xs" style={{ color: "var(--ink-2)" }}>
                      <span className="tabular">{h.streak.current}</span> now ·
                      best <span className="tabular">{h.streak.longest}</span> ·{" "}
                      <span className="tabular">
                        {Math.round(h.streak.completionRate * 100)}%
                      </span>{" "}
                      kept
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <HabitHeatmap calendar={h.calendar} color={h.color} />
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      <NewHabitForm />
    </main>
  );
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function NewHabitForm() {
  return (
    <section
      className="rounded-xl border p-4"
      style={{ background: "var(--surface)", borderColor: "var(--hairline)" }}
    >
      <h2 className="mb-3 text-sm font-medium" style={{ color: "var(--ink)" }}>
        Add a habit
      </h2>
      <form action={createHabitAction} className="flex flex-col gap-3">
        <div className="flex gap-2">
          <input
            name="emoji"
            defaultValue="✅"
            maxLength={4}
            aria-label="Emoji"
            className="w-14 rounded-lg border px-2 py-2 text-center text-sm"
            style={{
              background: "var(--surface-2)",
              borderColor: "var(--hairline)",
              color: "var(--ink)",
            }}
          />
          <input
            name="name"
            required
            placeholder="Read for 20 minutes"
            aria-label="Habit name"
            className="flex-1 rounded-lg border px-3 py-2 text-sm"
            style={{
              background: "var(--surface-2)",
              borderColor: "var(--hairline)",
              color: "var(--ink)",
            }}
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs" style={{ color: "var(--ink-2)" }}>
            Schedule{" "}
            <select
              name="schedule"
              defaultValue="daily"
              className="ml-1 rounded-lg border px-2 py-1.5 text-sm"
              style={{
                background: "var(--surface-2)",
                borderColor: "var(--hairline)",
                color: "var(--ink)",
              }}
            >
              <option value="daily">Every day</option>
              <option value="weekdays">Weekdays</option>
              <option value="custom">Specific days</option>
            </select>
          </label>

          <label className="text-xs" style={{ color: "var(--ink-2)" }}>
            Times per day{" "}
            <input
              name="targetPerDay"
              type="number"
              min={1}
              max={50}
              defaultValue={1}
              className="ml-1 w-16 rounded-lg border px-2 py-1.5 text-sm"
              style={{
                background: "var(--surface-2)",
                borderColor: "var(--hairline)",
                color: "var(--ink)",
              }}
            />
          </label>
        </div>

        <fieldset className="flex flex-wrap gap-2">
          <legend className="mb-1 text-xs" style={{ color: "var(--ink-muted)" }}>
            Days (only used with &ldquo;Specific days&rdquo;)
          </legend>
          {DAY_LABELS.map((label, i) => (
            <label
              key={label}
              className="flex items-center gap-1 text-xs"
              style={{ color: "var(--ink-2)" }}
            >
              <input type="checkbox" name="days" value={i} defaultChecked />
              {label}
            </label>
          ))}
        </fieldset>

        <button
          type="submit"
          className="self-start rounded-lg px-4 py-2 text-sm font-medium text-white"
          style={{ background: "var(--series-1)" }}
        >
          Add habit
        </button>
      </form>
    </section>
  );
}
