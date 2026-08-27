import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

import {
  toolCorrelate,
  toolGetHabits,
  toolGetJournal,
  toolGetSleep,
  toolGetWorkouts,
  toolListMetrics,
  toolMetricSeries,
  toolMetricStats,
} from "./queries";

/**
 * The coach's tools.
 *
 * Thin wrappers over `queries.ts`, which holds the real implementations and is
 * independently testable. The split matters: the interesting logic (rounding,
 * capping, correlation) can be verified without an API key, and only the
 * schema lives here.
 *
 * **Deliberately not a SQL tool.** A fixed set of parameterised functions is
 * the whole safety model: no query the model writes can return five million
 * rows into the context, touch a table it has no business reading, or reach
 * journal entries the user marked private.
 */

const DateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .describe("A calendar date, YYYY-MM-DD, in the user's local timezone.");

const listMetricsTool = betaZodTool({
  name: "list_metrics",
  description:
    "List every health metric that has data, with its unit, category and " +
    "available date range. Call this first — it tells you which metric keys " +
    "actually exist, so you never guess one.",
  inputSchema: z.object({}),
  run: async () => JSON.stringify(await toolListMetrics()),
});

const metricStatsTool = betaZodTool({
  name: "metric_stats",
  description:
    "Summary statistics for up to 12 metrics over a date range, plus the " +
    "same statistics for the preceding period of equal length. This is the " +
    "cheapest tool and usually the right one — prefer it over metric_series " +
    "unless you specifically need the shape of the data day by day.",
  inputSchema: z.object({
    metric_keys: z
      .array(z.string())
      .min(1)
      .max(12)
      .describe("Metric keys from list_metrics."),
    start_date: DateStr,
    end_date: DateStr,
  }),
  run: async (input) => JSON.stringify(await toolMetricStats(input)),
});

const metricSeriesTool = betaZodTool({
  name: "metric_series",
  description:
    "Day-by-day values for one metric. Long ranges are automatically " +
    "returned as weekly means instead, and the response says so — check the " +
    "`granularity` field before describing variability.",
  inputSchema: z.object({
    metric_key: z.string(),
    start_date: DateStr,
    end_date: DateStr,
    granularity: z.enum(["day", "week"]).optional(),
  }),
  run: async (input) => JSON.stringify(await toolMetricSeries(input)),
});

const getSleepTool = betaZodTool({
  name: "get_sleep",
  description:
    "Nightly sleep with stage breakdown (deep, REM, awake) and efficiency. " +
    "Dates are the night the sleep began, so 2026-08-25 means the night of " +
    "the 25th into the morning of the 26th.",
  inputSchema: z.object({ start_date: DateStr, end_date: DateStr }),
  run: async (input) => JSON.stringify(await toolGetSleep(input)),
});

const getHabitsTool = betaZodTool({
  name: "get_habits",
  description:
    "The user's habits with current streak, longest streak and completion " +
    "rate.",
  inputSchema: z.object({}),
  run: async () => JSON.stringify(await toolGetHabits()),
});

const getJournalTool = betaZodTool({
  name: "get_journal",
  description:
    "The user's journal entries, with self-reported mood and energy (1-5). " +
    "This is the only source of context for WHY a period went the way it " +
    "did — reach for it before speculating about causes. Entries the user " +
    "marked private are never returned.",
  inputSchema: z.object({
    start_date: DateStr,
    end_date: DateStr,
    limit: z.number().int().min(1).max(40).optional(),
  }),
  run: async (input) => JSON.stringify(await toolGetJournal(input)),
});

const getWorkoutsTool = betaZodTool({
  name: "get_workouts",
  description: "Recorded workouts: type, duration, energy, distance, heart rate.",
  inputSchema: z.object({ start_date: DateStr, end_date: DateStr }),
  run: async (input) => JSON.stringify(await toolGetWorkouts(input)),
});

const correlateTool = betaZodTool({
  name: "correlate",
  description:
    "Pearson correlation between two metrics' daily values, computed " +
    "server-side. Pass metric_a: \"sleep\" to correlate sleep duration " +
    "against a metric. `lag_days: 1` compares each day's metric_a against " +
    "the NEXT day's metric_b — which is the right shape for questions like " +
    "'does last night's sleep affect today's resting heart rate'. Always " +
    "check `n` and report it; never present a correlation from few days as " +
    "a finding.",
  inputSchema: z.object({
    metric_a: z.string().describe('A metric key, or "sleep" for sleep duration.'),
    metric_b: z.string(),
    start_date: DateStr,
    end_date: DateStr,
    lag_days: z.number().int().min(-7).max(7).optional(),
  }),
  run: async (input) => JSON.stringify(await toolCorrelate(input)),
});

export const coachTools = [
  listMetricsTool,
  metricStatsTool,
  metricSeriesTool,
  getSleepTool,
  getHabitsTool,
  getJournalTool,
  getWorkoutsTool,
  correlateTool,
];

/** Names only, for logging a tool trace in the UI. */
export const coachToolNames = coachTools.map((t) => t.name);
