import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import { client } from "@/db/index";
import { addDays, type DayString } from "@/lib/time/day";

import { COACH_MODEL, getAnthropic, isMockMode } from "./client";
import {
  toolCorrelate,
  toolGetHabits,
  toolGetJournal,
  toolGetSleep,
  toolGetWorkouts,
  toolMetricStats,
} from "./queries";

/**
 * The weekly report.
 *
 * Unlike the chat coach, this does **not** use tools. The input set is fixed
 * and known in advance — last week, the four weeks before it, sleep, habits,
 * workouts, journal — so assembling that digest directly and making one call
 * is both cheaper and far more consistent than twelve tool round trips where
 * the model decides what to look at each time. A weekly report that examines
 * different things every week isn't a weekly report.
 *
 * The output is structured, so the app can render findings as data rather
 * than parsing prose.
 */

const CORE_METRICS = [
  "step_count",
  "active_energy",
  "apple_exercise_time",
  "resting_heart_rate",
  "heart_rate_variability",
  "weight_body_mass",
  "dietary_caffeine",
  "time_in_daylight",
];

/* ----------------------------------------------------------------- schema -- */

const FindingSchema = z.object({
  title: z.string().describe("One short sentence stating what changed."),
  metric: z
    .string()
    .describe("The metric key this is about, or 'sleep' / 'habits' / 'journal'."),
  direction: z
    .enum(["up", "down", "flat"])
    .describe("Which way the number moved."),
  is_good: z
    .enum(["good", "bad", "neutral"])
    .describe(
      "Whether this movement is good for the user. Resting heart rate going " +
        "up is bad; HRV going up is good; weight is neutral — the app does " +
        "not know their goals.",
    ),
  detail: z
    .string()
    .describe(
      "One or two sentences with the actual numbers and the comparison " +
        "period. Never a number without its range.",
    ),
  confidence: z
    .enum(["high", "medium", "low"])
    .describe(
      "Low when the data is thin — few recorded days, a small sample, or a " +
        "difference inside normal week-to-week noise.",
    ),
});

const WeeklyReportSchema = z.object({
  headline: z
    .string()
    .describe(
      "One sentence summarising the week, specific enough to be worth " +
        "reading. Not 'a mixed week'.",
    ),
  findings: z
    .array(FindingSchema)
    .min(1)
    .max(5)
    .describe("The things actually worth knowing. Fewer is better than padded."),
  actions: z
    .array(
      z.object({
        action: z
          .string()
          .describe("Something specific and small enough to do this week."),
        why: z.string().describe("The observation from their data behind it."),
      }),
    )
    .max(3)
    .describe(
      "Concrete suggestions. Omit rather than inventing one — 'get more " +
        "sleep' is not advice.",
    ),
  concerns: z
    .array(z.string())
    .max(2)
    .describe(
      "Anything worth raising with a doctor: a sustained unexplained shift, " +
        "or a reading well outside a normal range. Do not manufacture alarm " +
        "over ordinary variation. Usually empty.",
    ),
});

export type WeeklyReport = z.infer<typeof WeeklyReportSchema>;

/* ----------------------------------------------------------------- digest -- */

export interface WeeklyDigest {
  period: { start: DayString; end: DayString };
  baseline: { start: DayString; end: DayString };
  metrics: unknown;
  sleep: unknown;
  habits: unknown;
  workouts: unknown;
  journal: unknown;
  correlations: unknown[];
}

/**
 * Assemble everything the report is allowed to see.
 *
 * Bounded on purpose: this is roughly 4–6k tokens, which is a fixed and
 * predictable cost per week rather than whatever the model felt like fetching.
 */
export async function buildWeeklyDigest(
  weekEnd: DayString,
): Promise<WeeklyDigest> {
  const weekStart = addDays(weekEnd, -6);
  const baselineStart = addDays(weekStart, -28);
  const baselineEnd = addDays(weekStart, -1);

  const [metrics, sleep, habits, workouts, journal] = await Promise.all([
    toolMetricStats({
      metric_keys: CORE_METRICS,
      start_date: weekStart,
      end_date: weekEnd,
    }),
    toolGetSleep({ start_date: weekStart, end_date: weekEnd }),
    toolGetHabits(),
    toolGetWorkouts({ start_date: weekStart, end_date: weekEnd }),
    toolGetJournal({ start_date: weekStart, end_date: weekEnd, limit: 7 }),
  ]);

  // A few fixed correlations over a longer window — these are about the
  // user's general pattern, not this week specifically, so they use 90 days.
  const correlations = await Promise.all([
    toolCorrelate({
      metric_a: "sleep",
      metric_b: "resting_heart_rate",
      start_date: addDays(weekEnd, -89),
      end_date: weekEnd,
      lag_days: 1,
    }),
    toolCorrelate({
      metric_a: "sleep",
      metric_b: "step_count",
      start_date: addDays(weekEnd, -89),
      end_date: weekEnd,
      lag_days: 1,
    }),
  ]);

  return {
    period: { start: weekStart, end: weekEnd },
    baseline: { start: baselineStart, end: baselineEnd },
    metrics,
    sleep,
    habits,
    workouts,
    journal,
    correlations,
  };
}

/* ------------------------------------------------------------- generation -- */

const SYSTEM = `You write one person's weekly health review, inside their own tracking app. You are writing to them, about their data.

Everything you say must come from the digest you are given. Do not infer, extrapolate, or fill gaps with what is typically true of people — if the digest doesn't show it, it isn't a finding.

Be selective. Three real observations beat five padded ones, and a week where nothing much changed should say so rather than manufacturing significance. Ordinary week-to-week variation is not a finding.

Always give the numbers and the comparison period. Their own baseline is the only meaningful comparison; population norms are not.

Mark confidence honestly. Thin data — few recorded nights, a small sample, a difference inside normal noise — is 'low', and low-confidence findings should read as "worth watching", not as conclusions.

Read the journal entries. They are the only thing that can explain WHY a week went the way it did, and a report that ignores them to speculate about causes is worse than one that stays descriptive.

You are not a doctor. Never diagnose and never mention medication. Use 'concerns' only for something genuinely worth raising with a clinician — a sustained unexplained shift, or a reading well outside a normal range. Leave it empty otherwise; crying wolf about normal variation would make the whole feature untrustworthy.

Do not comment on body weight in evaluative terms and do not encourage restriction.`;

export async function generateWeeklyReport(
  digest: WeeklyDigest,
): Promise<{ report: WeeklyReport; model: string }> {
  if (isMockMode()) {
    return { report: mockReport(digest), model: "mock" };
  }

  const response = await getAnthropic().messages.parse({
    model: COACH_MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "high",
      format: zodOutputFormat(WeeklyReportSchema),
    },
    messages: [
      {
        role: "user",
        content: `Here is the digest for the week of ${digest.period.start} to ${digest.period.end}, with the preceding four weeks as the baseline.\n\n${JSON.stringify(digest, null, 1)}`,
      },
    ],
  });

  const parsed = response.parsed_output;
  if (!parsed) {
    throw new Error("The model did not return a valid report.");
  }
  return { report: parsed, model: COACH_MODEL };
}

/** Deterministic stand-in so the UI is buildable without a key. */
function mockReport(digest: WeeklyDigest): WeeklyReport {
  const stats = (digest.metrics as { stats: Record<string, unknown>[] }).stats;
  const sleep = digest.sleep as { average_hours: number | null };
  const moved = stats
    .filter((s) => Math.abs(Number(s.change_pct ?? 0)) >= 5)
    .slice(0, 3);

  return {
    headline: `Mock report — you averaged ${sleep.average_hours ?? "—"}h of sleep this week.`,
    findings: (moved.length ? moved : stats.slice(0, 2)).map((s) => ({
      title: `${s.name} ${Number(s.change_pct ?? 0) >= 0 ? "up" : "down"} ${Math.abs(Number(s.change_pct ?? 0)).toFixed(0)}%`,
      metric: String(s.key),
      direction: Number(s.change_pct ?? 0) >= 0 ? ("up" as const) : ("down" as const),
      is_good: "neutral" as const,
      detail: `${s.mean} ${s.unit} on average from ${digest.period.start} to ${digest.period.end}, against ${s.previous_period_mean} ${s.unit} over the previous four weeks.`,
      confidence: Number(s.days_with_data) >= 5 ? ("medium" as const) : ("low" as const),
    })),
    actions: [],
    concerns: [],
  };
}

/* ---------------------------------------------------------------- storage -- */

/**
 * Generate and store the report for a week, unless one already exists.
 *
 * The `UNIQUE(kind, period_start)` constraint is what makes every trigger path
 * safe to fire repeatedly — a page load, a cron, and a manual run can all race
 * and only one report is written.
 */
export async function ensureWeeklyReport(
  weekEnd: DayString,
  force = false,
): Promise<{ created: boolean; reason?: string }> {
  const weekStart = addDays(weekEnd, -6);

  if (!force) {
    const existing = await client.execute({
      sql: "SELECT id FROM insights WHERE kind = 'weekly' AND period_start = ?",
      args: [weekStart],
    });
    if (existing.rows.length > 0) return { created: false, reason: "exists" };
  }

  const digest = await buildWeeklyDigest(weekEnd);

  // A week with almost nothing recorded produces a report about nothing.
  const nights = (digest.sleep as { nights_recorded: number }).nights_recorded;
  const withData = (
    digest.metrics as { stats: { days_with_data: number }[] }
  ).stats.filter((s) => s.days_with_data >= 3).length;

  if (nights < 2 && withData < 2) {
    return { created: false, reason: "not enough data for this week" };
  }

  const { report, model } = await generateWeeklyReport(digest);

  const bodyMd = [
    ...report.findings.map(
      (f) =>
        `### ${f.title}\n\n${f.detail}\n\n_Confidence: ${f.confidence}._`,
    ),
    report.actions.length
      ? `### Worth trying\n\n${report.actions.map((a) => `- **${a.action}** — ${a.why}`).join("\n")}`
      : "",
    report.concerns.length
      ? `### Worth raising with a doctor\n\n${report.concerns.map((c) => `- ${c}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  await client.execute({
    sql: `INSERT INTO insights
            (kind, period_start, period_end, summary, body_md, data, model)
          VALUES ('weekly', ?, ?, ?, ?, ?, ?)
          ON CONFLICT (kind, period_start) DO UPDATE SET
            summary = excluded.summary,
            body_md = excluded.body_md,
            data    = excluded.data,
            model   = excluded.model`,
    args: [
      weekStart,
      weekEnd,
      report.headline,
      bodyMd,
      JSON.stringify(report),
      model,
    ],
  });

  return { created: true };
}
