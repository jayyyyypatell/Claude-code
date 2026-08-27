import { describe, expect, it } from "vitest";

import {
  computeStreak,
  describeSchedule,
  habitCalendar,
  isScheduled,
  type HabitLog,
  type HabitSpec,
} from "./streak";

const daily: HabitSpec = { schedule: "daily", daysMask: 127, targetPerDay: 1 };
const weekdays: HabitSpec = { schedule: "weekdays", daysMask: 127, targetPerDay: 1 };
// Mon / Wed / Fri → bits 1, 3, 5 → 0b0101010 = 42
const mwf: HabitSpec = { schedule: "custom", daysMask: 42, targetPerDay: 1 };

const logs = (...dates: string[]): HabitLog[] =>
  dates.map((date) => ({ date, count: 1 }));

// 2026-08-26 is a Wednesday.
const WED = "2026-08-26";

describe("isScheduled", () => {
  it("handles daily", () => {
    expect(isScheduled(daily, "2026-08-29")).toBe(true); // Saturday
  });

  it("handles weekdays", () => {
    expect(isScheduled(weekdays, "2026-08-26")).toBe(true); // Wed
    expect(isScheduled(weekdays, "2026-08-29")).toBe(false); // Sat
    expect(isScheduled(weekdays, "2026-08-30")).toBe(false); // Sun
  });

  it("handles a custom weekday mask", () => {
    expect(isScheduled(mwf, "2026-08-24")).toBe(true); // Mon
    expect(isScheduled(mwf, "2026-08-25")).toBe(false); // Tue
    expect(isScheduled(mwf, "2026-08-26")).toBe(true); // Wed
    expect(isScheduled(mwf, "2026-08-28")).toBe(true); // Fri
  });
});

describe("current streak", () => {
  it("counts consecutive completed days", () => {
    const r = computeStreak(
      daily,
      logs("2026-08-24", "2026-08-25", "2026-08-26"),
      WED,
    );
    expect(r.current).toBe(3);
  });

  it("does NOT break the streak just because today isn't logged yet", () => {
    // The rule everyone gets wrong. At 9am on Wednesday, with Mon and Tue
    // done, the streak is 2 — not 0. The day isn't over.
    const r = computeStreak(daily, logs("2026-08-24", "2026-08-25"), WED);

    expect(r.current).toBe(2);
    expect(r.pendingToday).toBe(true);
  });

  it("extends the streak once today is logged", () => {
    const r = computeStreak(
      daily,
      logs("2026-08-24", "2026-08-25", "2026-08-26"),
      WED,
    );
    expect(r.current).toBe(3);
    expect(r.pendingToday).toBe(false);
  });

  it("breaks on a genuinely missed day", () => {
    // Monday done, Tuesday missed, today pending → the run ended at Tuesday.
    const r = computeStreak(daily, logs("2026-08-22", "2026-08-24"), WED);
    expect(r.current).toBe(0);
  });

  it("skips unscheduled days without breaking the run", () => {
    // Mon/Wed/Fri habit: the weekend is not a miss.
    const r = computeStreak(
      mwf,
      logs("2026-08-19", "2026-08-21", "2026-08-24", "2026-08-26"),
      WED,
    );
    // Wed 26, Mon 24, Fri 21, Wed 19 — four scheduled days in a row.
    expect(r.current).toBe(4);
  });

  it("does not count an unscheduled today as pending", () => {
    // Saturday, for a weekdays-only habit.
    const r = computeStreak(weekdays, logs("2026-08-28"), "2026-08-29");
    expect(r.pendingToday).toBe(false);
    expect(r.current).toBe(1); // Friday still counts
  });

  it("respects a multi-count target", () => {
    const water: HabitSpec = { schedule: "daily", daysMask: 127, targetPerDay: 3 };
    const partial = [
      { date: "2026-08-25", count: 3 },
      { date: "2026-08-26", count: 2 },
    ];
    const r = computeStreak(water, partial, WED);

    // Today is short of target, so it's pending rather than complete.
    expect(r.current).toBe(1);
    expect(r.pendingToday).toBe(true);
  });

  it("returns zero for a habit with no logs", () => {
    const r = computeStreak(daily, [], WED);
    expect(r.current).toBe(0);
    expect(r.longest).toBe(0);
    expect(r.completionRate).toBe(0);
  });
});

describe("longest streak", () => {
  it("finds the longest historical run", () => {
    const r = computeStreak(
      daily,
      logs(
        "2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", // 4
        // gap
        "2026-08-20", "2026-08-21", // 2
        "2026-08-25", "2026-08-26", // 2, current
      ),
      WED,
    );
    expect(r.longest).toBe(4);
    expect(r.current).toBe(2);
  });

  it("never reports a longest shorter than the current run", () => {
    const r = computeStreak(
      daily,
      logs("2026-08-24", "2026-08-25", "2026-08-26"),
      WED,
    );
    expect(r.longest).toBeGreaterThanOrEqual(r.current);
  });
});

describe("completion rate", () => {
  it("counts only scheduled days", () => {
    // Mon–Fri habit over Mon 24 to Wed 26: three scheduled days, two done.
    const r = computeStreak(
      weekdays,
      logs("2026-08-24", "2026-08-26"),
      WED,
      "2026-08-24",
    );
    expect(r.scheduledDays).toBe(3);
    expect(r.completedDays).toBe(2);
    expect(r.completionRate).toBeCloseTo(2 / 3, 6);
  });

  it("does not penalise an unfinished today", () => {
    // Mon and Tue done, Wed still open. That's 100% so far, not 67% —
    // otherwise the number sags every morning and recovers every evening.
    const r = computeStreak(
      daily,
      logs("2026-08-24", "2026-08-25"),
      WED,
      "2026-08-24",
    );
    expect(r.scheduledDays).toBe(2);
    expect(r.completionRate).toBe(1);
  });
});

describe("habitCalendar", () => {
  it("distinguishes unscheduled days from missed ones", () => {
    // Greying out a rest day the same as a failure would misreport a
    // perfectly kept habit as full of holes.
    const cal = habitCalendar(
      mwf,
      logs("2026-08-24"),
      "2026-08-24",
      "2026-08-26",
      WED,
    );

    expect(cal.map((c) => c.state)).toEqual([
      "complete", // Mon, done
      "unscheduled", // Tue, not expected
      "missed", // Wed, expected and not done
    ]);
  });

  it("marks partial days", () => {
    const water: HabitSpec = { schedule: "daily", daysMask: 127, targetPerDay: 3 };
    const cal = habitCalendar(
      water,
      [{ date: WED, count: 1 }],
      WED,
      WED,
      WED,
    );
    expect(cal[0].state).toBe("partial");
  });

  it("marks future days rather than calling them missed", () => {
    const cal = habitCalendar(daily, [], WED, "2026-08-28", WED);
    expect(cal.map((c) => c.state)).toEqual(["missed", "future", "future"]);
  });
});

describe("describeSchedule", () => {
  it("reads naturally", () => {
    expect(describeSchedule(daily)).toBe("Every day");
    expect(describeSchedule(weekdays)).toBe("Weekdays");
    expect(describeSchedule(mwf)).toBe("Mon, Wed, Fri");
    expect(
      describeSchedule({ schedule: "custom", daysMask: 127, targetPerDay: 1 }),
    ).toBe("Every day");
  });
});
