import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { client } from "@/db/index";

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
 * Tests for the coach's query layer.
 *
 * These run against the seeded development database rather than a fixture, so
 * they exercise the same path the coach actually takes. They are skipped
 * entirely when that database is empty, so a fresh checkout doesn't fail on
 * data it was never given.
 *
 * What's being checked is not "does it return something" but the two
 * properties that make the coach viable at all: **results stay small**, and
 * **the statistics are computed here rather than by the model**.
 */

const TODAY = "2026-08-26";
const MONTH_AGO = "2026-07-28";
const QUARTER_AGO = "2026-05-29";

let hasData = false;

beforeAll(async () => {
  try {
    const r = await client.execute("SELECT COUNT(*) AS n FROM daily_metrics");
    hasData = Number(r.rows[0].n) > 0;
  } catch {
    hasData = false;
  }
});

afterAll(() => {
  client.close();
});

const withData = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!hasData) return; // seeded DB absent — nothing to assert against
    await fn();
  });

/** Rough token estimate. Four characters per token is the usual rule of thumb. */
const tokens = (value: unknown): number =>
  Math.ceil(JSON.stringify(value).length / 4);

describe("list_metrics", () => {
  withData("returns the registry compactly", async () => {
    const result = await toolListMetrics();
    expect(result.metrics.length).toBeGreaterThan(0);

    for (const m of result.metrics) {
      expect(m.key).toBeTruthy();
      expect(m.days).toBeGreaterThan(0);
    }
    // The whole registry has to be affordable as an opening move.
    expect(tokens(result)).toBeLessThan(3000);
  });
});

describe("metric_stats — the cheap tool", () => {
  withData("is small enough to be the default", async () => {
    const result = await toolMetricStats({
      metric_keys: ["step_count", "resting_heart_rate", "heart_rate_variability"],
      start_date: MONTH_AGO,
      end_date: TODAY,
    });

    expect(result.stats.length).toBe(3);
    // The design claim is ~40 tokens per metric. Hold it to something near that.
    expect(tokens(result)).toBeLessThan(400);
  });

  withData("includes the previous period, so a number has a baseline", async () => {
    const result = await toolMetricStats({
      metric_keys: ["step_count"],
      start_date: MONTH_AGO,
      end_date: TODAY,
    });
    const steps = result.stats[0];

    expect(steps.mean).toBeTypeOf("number");
    expect(steps.previous_period_mean).toBeTypeOf("number");
    expect(steps.change_pct).toBeTypeOf("number");
  });

  withData("rounds — a raw float is noise the model pays for", async () => {
    const result = await toolMetricStats({
      metric_keys: ["resting_heart_rate"],
      start_date: MONTH_AGO,
      end_date: TODAY,
    });
    const mean = result.stats[0].mean as number;

    // At most one decimal place.
    expect(mean).toBe(Math.round(mean * 10) / 10);
  });

  withData("reports unknown keys rather than failing the call", async () => {
    const result = await toolMetricStats({
      metric_keys: ["step_count", "not_a_real_metric"],
      start_date: MONTH_AGO,
      end_date: TODAY,
    });
    expect(result.missing).toContain("not_a_real_metric");
    expect(result.stats.length).toBe(1);
  });
});

describe("metric_series — the expensive tool", () => {
  withData("returns daily values over a short range", async () => {
    const result = await toolMetricSeries({
      metric_key: "step_count",
      start_date: "2026-08-20",
      end_date: TODAY,
    });
    expect(result.granularity).toBe("day");
  });

  withData("coarsens a long range instead of returning a year of days", async () => {
    const result = await toolMetricSeries({
      metric_key: "step_count",
      start_date: "2025-09-01",
      end_date: TODAY,
    });

    // The important part: it says what it did. A model that mistook weekly
    // means for daily values would describe variability completely wrongly.
    expect(result.granularity).toBe("week");
    expect(result.note).toContain("Weekly means");
    expect(tokens(result)).toBeLessThan(4000);
  });

  withData("names the problem when the metric doesn't exist", async () => {
    const result = await toolMetricSeries({
      metric_key: "nonsense_metric",
      start_date: MONTH_AGO,
      end_date: TODAY,
    });
    expect(String(result.error)).toContain("list_metrics");
  });
});

describe("get_sleep", () => {
  withData("returns hours, not minutes", async () => {
    const result = await toolGetSleep({ start_date: MONTH_AGO, end_date: TODAY });
    const nights = result.nights as { hours: number }[];

    expect(nights.length).toBeGreaterThan(0);
    // Making the model divide 437 by 60 repeatedly is asking for arithmetic
    // slips; a night is 3–12 hours.
    for (const n of nights.slice(0, 10)) {
      expect(n.hours).toBeGreaterThan(2);
      expect(n.hours).toBeLessThan(14);
    }
    expect(result.average_hours).toBeTypeOf("number");
  });
});

describe("correlate — computed here, never by the model", () => {
  withData("finds the seeded sleep → next-day resting HR relationship", async () => {
    const result = await toolCorrelate({
      metric_a: "sleep",
      metric_b: "resting_heart_rate",
      start_date: QUARTER_AGO,
      end_date: TODAY,
      lag_days: 1,
    });

    // The seed builds this in deliberately: short sleep raises next-day
    // resting heart rate. If this comes back positive or null, either the
    // correlation code or the lag handling is wrong.
    expect(result.r).toBeLessThan(-0.3);
    expect(result.n).toBeGreaterThan(50);
    expect(result.strength).toBe("strong");
  });

  withData("finds the positive HRV relationship in the other direction", async () => {
    const result = await toolCorrelate({
      metric_a: "sleep",
      metric_b: "heart_rate_variability",
      start_date: QUARTER_AGO,
      end_date: TODAY,
      lag_days: 1,
    });
    expect(result.r).toBeGreaterThan(0.3);
  });

  withData("is tiny — that is the entire point of the tool", async () => {
    const result = await toolCorrelate({
      metric_a: "sleep",
      metric_b: "resting_heart_rate",
      start_date: QUARTER_AGO,
      end_date: TODAY,
      lag_days: 1,
    });

    // ~90 days of two series would be hundreds of numbers; this answers the
    // same question in a handful of tokens.
    expect(tokens(result)).toBeLessThan(120);
  });

  withData("carries its own caveat, so the warning travels with the number", async () => {
    const result = await toolCorrelate({
      metric_a: "sleep",
      metric_b: "resting_heart_rate",
      start_date: "2026-08-20",
      end_date: TODAY,
      lag_days: 1,
    });
    expect(String(result.caveat)).toContain("Too few paired days");
  });

  withData("refuses an unknown metric rather than inventing a number", async () => {
    const result = await toolCorrelate({
      metric_a: "step_count",
      metric_b: "not_real",
      start_date: MONTH_AGO,
      end_date: TODAY,
    });
    expect(result.error).toBeTruthy();
  });
});

describe("get_journal — the privacy boundary", () => {
  withData("never returns entries marked private", async () => {
    // Mark one entry private directly, then confirm the coach's tool can't
    // see it. This is the control that must not depend on prompt wording.
    const target = await client.execute(
      "SELECT date FROM journal_entries WHERE body != '' ORDER BY date DESC LIMIT 1",
    );
    if (target.rows.length === 0) return;
    const date = String(target.rows[0].date);

    await client.execute({
      sql: "UPDATE journal_entries SET is_private = 1 WHERE date = ?",
      args: [date],
    });

    const result = await toolGetJournal({ start_date: date, end_date: date });
    expect((result.entries as unknown[]).length).toBe(0);

    // ...and still returns non-private entries, or the filter is just broken.
    await client.execute({
      sql: "UPDATE journal_entries SET is_private = 0 WHERE date = ?",
      args: [date],
    });
    const after = await toolGetJournal({ start_date: date, end_date: date });
    expect((after.entries as unknown[]).length).toBe(1);
  });

  withData("truncates long entries", async () => {
    const result = await toolGetJournal({
      start_date: QUARTER_AGO,
      end_date: TODAY,
      limit: 40,
    });
    for (const e of result.entries as { text: string }[]) {
      expect(e.text.length).toBeLessThanOrEqual(401);
    }
  });
});

describe("habits and workouts", () => {
  withData("returns habits with streaks", async () => {
    const result = await toolGetHabits();
    const habits = result.habits as { name: string; current_streak: number }[];
    expect(habits.length).toBeGreaterThan(0);
    expect(tokens(result)).toBeLessThan(600);
  });

  withData("returns workouts compactly", async () => {
    const result = await toolGetWorkouts({
      start_date: MONTH_AGO,
      end_date: TODAY,
    });
    expect(tokens(result)).toBeLessThan(2000);
  });
});

describe("the whole point: a full question stays affordable", () => {
  withData("a realistic multi-tool answer fits well inside the budget", async () => {
    // Roughly what "how did I sleep last week vs the week before, and did it
    // affect me?" would actually pull.
    const payloads = [
      await toolListMetrics(),
      await toolGetSleep({ start_date: "2026-08-13", end_date: TODAY }),
      await toolMetricStats({
        metric_keys: ["resting_heart_rate", "heart_rate_variability"],
        start_date: "2026-08-13",
        end_date: TODAY,
      }),
      await toolCorrelate({
        metric_a: "sleep",
        metric_b: "resting_heart_rate",
        start_date: QUARTER_AGO,
        end_date: TODAY,
        lag_days: 1,
      }),
      await toolGetJournal({ start_date: "2026-08-13", end_date: TODAY }),
    ];

    const total = payloads.reduce((sum, p) => sum + tokens(p), 0);

    // Against the ~2.7M tokens the raw data would be. The runtime cap is
    // 60,000 bytes; this should sit far below it.
    expect(total).toBeLessThan(8000);
  });
});

/**
 * An empty range is not a measurement of zero.
 *
 * These run regardless of whether the database has data, because the range is
 * chosen to be empty either way — and the failure they guard is one that only
 * shows up on a fresh install, which is precisely when nobody is running the
 * test suite.
 */
describe("empty ranges report absence, not zero", () => {
  it("returns null average sleep rather than 0", async () => {
    const r = await toolGetSleep({ start_date: "1990-01-01", end_date: "1990-01-07" });
    expect(r.nights_recorded).toBe(0);
    // 0 would render as "you averaged 0h", which reads as a real and alarming
    // measurement rather than an absence of one.
    expect(r.average_hours).toBeNull();
  });

  it("returns a null correlation rather than a number", async () => {
    const r = await toolCorrelate({
      metric_a: "sleep",
      metric_b: "resting_heart_rate",
      start_date: "1990-01-01",
      end_date: "1990-03-01",
      lag_days: 1,
    });
    expect(r.r).toBeNull();
    expect(r.n).toBe(0);
  });
});
