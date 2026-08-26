import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Time conventions used throughout this schema:
 *
 *  - `*_at` columns hold **unix milliseconds, UTC**. Always. No local time is
 *    ever stored in an instant column.
 *  - `date` columns hold a **local calendar day** as `YYYY-MM-DD`, resolved in
 *    the user's timezone (`USER_TIMEZONE`). See `src/lib/time/day.ts`.
 *
 * The split matters: "steps on 2026-08-26" is a question about a local day, but
 * the samples that answer it are instants. Bucketing instants by UTC day would
 * silently mis-attribute everything before ~8pm for a US user.
 */

/* -------------------------------------------------------------------------- */
/* Metric registry                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One row per distinct Apple Health metric (150+ of them, and growing whenever
 * Apple or Health Auto Export adds one).
 *
 * This registry is what lets a single fact table hold every metric type: the
 * per-metric knowledge (what unit it's in, how it rolls up to a day) lives here
 * as data instead of as 150 bespoke tables.
 *
 * Rows are created automatically by the ingest normalizer when it meets a
 * metric key it hasn't seen before.
 */
export const metricTypes = sqliteTable(
  "metric_types",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    /** Health Auto Export's `name`, e.g. `step_count`, `heart_rate`. */
    key: text("key").notNull(),

    /** Human label, e.g. "Steps". Falls back to a title-cased `key`. */
    displayName: text("display_name").notNull(),

    /**
     * The unit every `metric_points.value` for this metric is stored in.
     * Incoming values are converted to this on ingest (see `units.ts`), so the
     * fact table is never a mix of km and miles.
     */
    canonicalUnit: text("canonical_unit").notNull().default(""),

    category: text("category", {
      enum: [
        "activity",
        "vitals",
        "sleep",
        "body",
        "nutrition",
        "mindfulness",
        "other",
      ],
    })
      .notNull()
      .default("other"),

    /**
     * How same-day samples combine into `daily_metrics.value`.
     *
     *  - `sum`  — additive counters (steps, active energy, distance)
     *  - `avg`  — rates and levels (heart rate, HRV, blood glucose)
     *  - `last` — state that supersedes (body weight, VO2 max)
     *  - `min`/`max` — extremes (resting HR floor, peak HR)
     *
     * Choosing wrong is a *silent* correctness bug: averaging step counts, or
     * summing heart rate, both produce plausible-looking nonsense. The
     * normalizer guesses from the unit and the guess is overridable here.
     */
    agg: text("agg", { enum: ["sum", "avg", "last", "min", "max"] })
      .notNull()
      .default("avg"),

    source: text("source", { enum: ["apple_health", "manual", "derived"] })
      .notNull()
      .default("apple_health"),

    /** Shown on the dashboard's pinned row. */
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),

    /** Hidden from metric pickers without deleting the history. */
    hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),

    sortOrder: integer("sort_order").notNull().default(0),

    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [uniqueIndex("metric_types_key_uq").on(t.key)],
);

/* -------------------------------------------------------------------------- */
/* Fact table                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every individual health sample, for every metric type.
 *
 * The extra value columns look redundant until you meet the payload: Health
 * Auto Export sends most metrics as a plain `qty`, heart rate as
 * `{Min, Avg, Max}`, and blood pressure as `{systolic, diastolic}`. Rather than
 * three tables, one row carries whichever of those shapes applies:
 *
 *   plain          value = qty
 *   heart rate     value = Avg,      valueMin = Min, valueMax = Max
 *   blood pressure value = systolic, value2   = diastolic
 */
export const metricPoints = sqliteTable(
  "metric_points",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    metricTypeId: integer("metric_type_id")
      .notNull()
      .references(() => metricTypes.id, { onDelete: "cascade" }),

    /** Unix ms, UTC. Sample start. */
    startAt: integer("start_at").notNull(),
    /** Unix ms, UTC. Equals `startAt` for instantaneous samples. */
    endAt: integer("end_at").notNull(),

    /**
     * How pre-aggregated this row already is, and the fix for the nastiest
     * double-count in the system.
     *
     * The two ingest paths disagree about granularity: Apple's `export.xml`
     * carries **raw per-sample** records, while Health Auto Export sends
     * **hourly (or daily) aggregates**. A raw sample at 08:03 and the hourly
     * bucket covering 08:00 are different `startAt` values, so they do not
     * collide on any natural key — both rows land, and a `sum` rollup adds
     * them together. Backfill your history after live sync has been running
     * and every additive metric quietly doubles.
     *
     * So `grain` is part of the uniqueness key, and `daily_metrics` picks
     * exactly ONE grain per (metric, day) by precedence
     * (`sample` > `hourly` > `daily`) rather than summing across them.
     */
    grain: text("grain", { enum: ["sample", "hourly", "daily"] })
      .notNull()
      .default("sample"),

    /**
     * The local calendar day this sample belongs to, `YYYY-MM-DD`, derived
     * from the **sample's own UTC offset** — not from the user's home zone.
     *
     * Denormalised deliberately. It makes the rollup a plain `GROUP BY`
     * instead of per-row timezone maths, and it makes travel correct: a run
     * at 23:30 in Tokyo files under the Tokyo date, which is what the Health
     * app itself shows and what you'd expect looking back at the trip.
     */
    localDate: text("local_date").notNull(),

    /** The sample's own UTC offset in minutes, straight off the timestamp. */
    tzOffsetMinutes: integer("tz_offset_minutes").notNull().default(0),

    /** Primary value, already converted to `metricTypes.canonicalUnit`. */
    value: real("value").notNull(),

    valueMin: real("value_min"),
    valueMax: real("value_max"),
    /** Second component of a paired reading — diastolic blood pressure. */
    value2: real("value_2"),

    /** Canonical unit, denormalised so a point is readable on its own. */
    unit: text("unit").notNull().default(""),

    /**
     * Originating device, e.g. "Apple Watch" / "iPhone".
     *
     * NOT NULL with a `''` default, deliberately: it is part of the uniqueness
     * key below, and SQLite treats NULLs as distinct in unique indexes. A
     * nullable column here would let every re-push insert duplicate rows while
     * the constraint sat there looking like it was working.
     */
    sourceName: text("source_name").notNull().default(""),

    /** Shape-specific extras: sleep phase, glucose `mealTime`, etc. */
    meta: text("meta", { mode: "json" }).$type<Record<string, unknown> | null>(),

    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    /**
     * The idempotency key.
     *
     * Health Auto Export re-sends overlapping windows on every push — the same
     * sample arrives many times over its lifetime. Ingest upserts against this
     * index (`ON CONFLICT DO UPDATE`) so a re-push is a no-op and a *corrected*
     * value overwrites in place instead of double-counting.
     *
     * Blind inserts here would inflate every additive metric without ever
     * looking wrong enough to notice.
     *
     * `grain` is in the key so the two ingest paths can coexist — see the
     * column's own note. Note what is *deliberately absent*: which path the
     * row arrived by. An XML backfill and a live push describing the same
     * sample converge on one row, which is what makes re-importing safe.
     */
    uniqueIndex("metric_points_natural_uq").on(
      t.metricTypeId,
      t.grain,
      t.startAt,
      t.sourceName,
    ),
    index("metric_points_type_time_idx").on(t.metricTypeId, t.startAt),
    index("metric_points_type_day_idx").on(t.metricTypeId, t.localDate),
    index("metric_points_day_idx").on(t.localDate),
  ],
);

/* -------------------------------------------------------------------------- */
/* Daily rollups                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Pre-aggregated per-local-day values, recomputed for affected days after each
 * ingest.
 *
 * Exists for two reasons:
 *  1. Charts over a year of minute-level samples would be unusably slow.
 *  2. It is the *only* health data the AI coach reads. Raw points would blow
 *     the context window on a single question; a year of daily rollups for one
 *     metric is ~365 short rows.
 */
export const dailyMetrics = sqliteTable(
  "daily_metrics",
  {
    /** Local calendar day, `YYYY-MM-DD`. */
    date: text("date").notNull(),

    metricTypeId: integer("metric_type_id")
      .notNull()
      .references(() => metricTypes.id, { onDelete: "cascade" }),

    /** Aggregated per `metricTypes.agg`. */
    value: real("value").notNull(),
    valueMin: real("value_min"),
    valueMax: real("value_max"),
    /** How many raw points fed this rollup — lets the AI judge sparse days. */
    sampleCount: integer("sample_count").notNull().default(0),

    /**
     * Which grain this rollup was computed from.
     *
     * A day can hold raw samples *and* hourly aggregates for the same metric
     * (see `metricPoints.grain`). The rollup picks the finest grain present
     * and uses only that, so recording the choice here makes a suspicious
     * number traceable back to the rows that produced it.
     */
    grainUsed: text("grain_used", { enum: ["sample", "hourly", "daily"] })
      .notNull()
      .default("sample"),

    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex("daily_metrics_pk").on(t.date, t.metricTypeId),
    index("daily_metrics_type_date_idx").on(t.metricTypeId, t.date),
  ],
);

/* -------------------------------------------------------------------------- */
/* Sleep                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Sleep gets its own table rather than living in `metric_points`, because a
 * night is a single event with a phase breakdown, not a scalar sample.
 *
 * `date` is the **night-of** day, not the wake day: sleep running Tuesday 23:00
 * → Wednesday 07:00 files under Tuesday, so "Tuesday's sleep" means the night
 * that followed Tuesday. See `nightOfDate()` in `src/lib/time/day.ts`.
 */
export const sleepSessions = sqliteTable(
  "sleep_sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    /** Night-of local day, `YYYY-MM-DD`. */
    date: text("date").notNull(),

    startAt: integer("start_at").notNull(),
    endAt: integer("end_at").notNull(),

    /** Minutes. `totalSleep` excludes awake time; `inBed` includes it. */
    totalSleepMin: real("total_sleep_min").notNull().default(0),
    asleepMin: real("asleep_min"),
    coreMin: real("core_min"),
    deepMin: real("deep_min"),
    remMin: real("rem_min"),
    awakeMin: real("awake_min"),
    inBedMin: real("in_bed_min"),

    /** `totalSleepMin / inBedMin`, 0–1. Null when in-bed time is unknown. */
    efficiency: real("efficiency"),

    /** See the note on `metricPoints.sourceName` — same NULL/unique trap. */
    sourceName: text("source_name").notNull().default(""),

    meta: text("meta", { mode: "json" }).$type<Record<string, unknown> | null>(),

    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex("sleep_sessions_natural_uq").on(t.date, t.sourceName),
    index("sleep_sessions_date_idx").on(t.date),
  ],
);

/* -------------------------------------------------------------------------- */
/* Workouts                                                                   */
/* -------------------------------------------------------------------------- */

export const workouts = sqliteTable(
  "workouts",
  {
    /** Health Auto Export's own workout UUID — already stable and unique. */
    id: text("id").primaryKey(),

    /** Local day the workout started. */
    date: text("date").notNull(),

    name: text("name").notNull(),
    startAt: integer("start_at").notNull(),
    endAt: integer("end_at").notNull(),
    durationSec: real("duration_sec").notNull().default(0),

    activeEnergyKcal: real("active_energy_kcal"),
    /** Metres. Converted from whatever unit arrived. */
    distanceM: real("distance_m"),
    avgHeartRate: real("avg_heart_rate"),
    maxHeartRate: real("max_heart_rate"),

    /**
     * GPS route as JSON, or null. Routes are large (thousands of points per
     * run) and nothing in v1 renders them, so ingest drops them unless
     * `HAE_STORE_ROUTES=1`.
     */
    route: text("route", { mode: "json" }).$type<unknown[] | null>(),

    sourceName: text("source_name").notNull().default(""),
    meta: text("meta", { mode: "json" }).$type<Record<string, unknown> | null>(),

    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index("workouts_date_idx").on(t.date),
    index("workouts_start_idx").on(t.startAt),
  ],
);

/* -------------------------------------------------------------------------- */
/* Habits                                                                     */
/* -------------------------------------------------------------------------- */

export const habits = sqliteTable(
  "habits",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    emoji: text("emoji").notNull().default("✅"),
    /** Tailwind-ish accent token resolved in the UI, not a raw hex. */
    color: text("color").notNull().default("indigo"),

    /**
     * Which days the habit is expected.
     * `daily` — every day. `weekdays` — Mon–Fri.
     * `custom` — consult `daysMask`.
     */
    schedule: text("schedule", { enum: ["daily", "weekdays", "custom"] })
      .notNull()
      .default("daily"),

    /**
     * Bitmask of scheduled weekdays when `schedule = 'custom'`.
     * Bit 0 = Sunday … bit 6 = Saturday. `0b1111111` (127) = every day.
     */
    daysMask: integer("days_mask").notNull().default(127),

    /** Completions needed to count the day done (e.g. 3 glasses of water). */
    targetPerDay: integer("target_per_day").notNull().default(1),

    /** Soft delete — archiving keeps the history and the past streaks. */
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    sortOrder: integer("sort_order").notNull().default(0),

    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index("habits_sort_idx").on(t.sortOrder)],
);

/**
 * One row per habit per day it was logged. Absence means "not done".
 *
 * Streaks are deliberately NOT stored here. They are derived by walking back
 * over scheduled days (`getStreak()`), because a stored counter drifts the
 * moment you back-fill yesterday, edit a schedule, or archive a habit — and a
 * wrong streak is worse than no streak.
 */
export const habitEntries = sqliteTable(
  "habit_entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    habitId: integer("habit_id")
      .notNull()
      .references(() => habits.id, { onDelete: "cascade" }),

    /** Local day, `YYYY-MM-DD`. */
    date: text("date").notNull(),
    count: integer("count").notNull().default(1),
    note: text("note"),

    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex("habit_entries_habit_date_uq").on(t.habitId, t.date),
    index("habit_entries_date_idx").on(t.date),
  ],
);

/* -------------------------------------------------------------------------- */
/* Journal                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One free-text note per day, plus two subjective scales.
 *
 * This is the only table that records *why*. Health data can show a bad sleep
 * week; only the journal can say "deadline + new coffee habit". The AI coach
 * reads it for exactly that reason.
 */
export const journalEntries = sqliteTable(
  "journal_entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    /** Local day, `YYYY-MM-DD`. One entry per day. */
    date: text("date").notNull(),
    body: text("body").notNull().default(""),

    /** Self-reported 1–5. Null when not filled in — never defaulted to 3. */
    mood: integer("mood"),
    energy: integer("energy"),

    tags: text("tags", { mode: "json" }).$type<string[] | null>(),

    /**
     * Withhold this entry from the AI coach entirely.
     *
     * Journal text is the most personal content in the app, and it is the one
     * thing here that would otherwise leave the machine. Enforced in the tool
     * layer that reads the database — not by asking the model nicely in a
     * prompt, which is not a privacy control.
     */
    isPrivate: integer("is_private", { mode: "boolean" })
      .notNull()
      .default(false),

    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [uniqueIndex("journal_entries_date_uq").on(t.date)],
);

/* -------------------------------------------------------------------------- */
/* AI coach                                                                   */
/* -------------------------------------------------------------------------- */

/** Generated weekly reports (and one-off deep dives). */
export const insights = sqliteTable(
  "insights",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind", { enum: ["weekly", "adhoc"] })
      .notNull()
      .default("weekly"),

    /** Inclusive local-day bounds of the period analysed. */
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),

    /** One-line headline, surfaced on the Today page. */
    summary: text("summary").notNull().default(""),
    /** Full report, markdown. */
    bodyMd: text("body_md").notNull().default(""),

    /** The structured findings/actions the model returned. */
    data: text("data", { mode: "json" }).$type<Record<string, unknown> | null>(),

    model: text("model").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex("insights_kind_period_uq").on(t.kind, t.periodStart),
    index("insights_created_idx").on(t.createdAt),
  ],
);

/**
 * Coach chat history.
 *
 * `content` stores the **full Anthropic content-block array**, not a plain
 * string. The coach answers by calling tools, so a turn contains `tool_use` and
 * `tool_result` blocks that must be replayed verbatim on the next request —
 * flattening to text would break the conversation the moment a tool is used.
 */
export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conversationId: text("conversation_id").notNull(),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content", { mode: "json" }).$type<unknown>().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index("chat_messages_conv_idx").on(t.conversationId, t.id)],
);

/* -------------------------------------------------------------------------- */
/* Ingest bookkeeping                                                         */
/* -------------------------------------------------------------------------- */

/**
 * One row per ingest attempt.
 *
 * Powers the "last synced" badge, which is the difference between trusting a
 * background sync and wondering about it. Also the first place to look when the
 * phone goes quiet — iOS decides when automations actually run, so "no data
 * since Tuesday" needs to distinguish "phone never pushed" from "push arrived
 * and the parser threw".
 */
export const ingestLog = sqliteTable(
  "ingest_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    source: text("source", {
      enum: ["hae", "apple_export", "manual", "seed"],
    }).notNull(),

    receivedAt: integer("received_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),

    status: text("status", { enum: ["running", "ok", "partial", "error"] })
      .notNull()
      .default("running"),

    bytes: integer("bytes").notNull().default(0),
    metricsSeen: integer("metrics_seen").notNull().default(0),
    pointsUpserted: integer("points_upserted").notNull().default(0),
    sleepUpserted: integer("sleep_upserted").notNull().default(0),
    workoutsUpserted: integer("workouts_upserted").notNull().default(0),

    /** 0–100 for the long-running export.zip import. */
    progress: integer("progress").notNull().default(0),

    /** Path of the archived raw payload, relative to the repo root. */
    rawPath: text("raw_path"),

    /**
     * SHA-256 of the exact request body.
     *
     * Health Auto Export retries on timeout even when the write actually
     * succeeded. The upserts make a replay harmless, but recognising an
     * identical recent body lets us skip redoing the rollup work during a
     * retry storm.
     */
    bodyHash: text("body_hash"),

    error: text("error"),
    /** Non-fatal problems — unparseable dates, unknown shapes, skipped rows. */
    warnings: text("warnings", { mode: "json" }).$type<string[] | null>(),
  },
  (t) => [
    index("ingest_log_received_idx").on(t.receivedAt),
    index("ingest_log_hash_idx").on(t.bodyHash, t.receivedAt),
  ],
);

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

/** Single-row-per-key store for user preferences (timezone, units, …). */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

/* -------------------------------------------------------------------------- */

export type MetricType = typeof metricTypes.$inferSelect;
export type NewMetricType = typeof metricTypes.$inferInsert;
export type MetricPoint = typeof metricPoints.$inferSelect;
export type NewMetricPoint = typeof metricPoints.$inferInsert;
export type DailyMetric = typeof dailyMetrics.$inferSelect;
export type SleepSession = typeof sleepSessions.$inferSelect;
export type NewSleepSession = typeof sleepSessions.$inferInsert;
export type Workout = typeof workouts.$inferSelect;
export type NewWorkout = typeof workouts.$inferInsert;
export type Habit = typeof habits.$inferSelect;
export type HabitEntry = typeof habitEntries.$inferSelect;
export type JournalEntry = typeof journalEntries.$inferSelect;
export type Insight = typeof insights.$inferSelect;
export type IngestLogRow = typeof ingestLog.$inferSelect;
