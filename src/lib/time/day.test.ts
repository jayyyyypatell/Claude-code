import { describe, expect, it } from "vitest";

import {
  addDays,
  dayOfWeek,
  daysBetween,
  eachDay,
  formatClock,
  localDay,
  localDayRangeMs,
  minutesFromMidnightSigned,
  nightOfDate,
  startOfLocalDayMs,
  timeZoneOffsetMs,
} from "./day";

const NY = "America/New_York";
const KOLKATA = "Asia/Kolkata"; // UTC+5:30, no DST — catches half-hour offsets
const UTC = "UTC";

describe("localDay", () => {
  it("uses the local calendar day, not the UTC one", () => {
    // 2026-08-27T01:30:00Z is still the 26th in New York (UTC-4 in August).
    const instant = Date.parse("2026-08-27T01:30:00Z");
    expect(localDay(instant, UTC)).toBe("2026-08-27");
    expect(localDay(instant, NY)).toBe("2026-08-26");
  });

  it("handles half-hour offset zones", () => {
    // 20:00Z is already the next day in Kolkata (+5:30 → 01:30).
    const instant = Date.parse("2026-08-26T20:00:00Z");
    expect(localDay(instant, KOLKATA)).toBe("2026-08-27");
  });

  it("does not roll midnight back a day", () => {
    // Regression guard: some ICU builds report midnight as hour "24" under
    // hour12:false, which would push this onto the 25th.
    const midnightNY = Date.parse("2026-08-26T04:00:00Z"); // 00:00 EDT
    expect(localDay(midnightNY, NY)).toBe("2026-08-26");
    expect(formatClock(midnightNY, NY)).toBe("00:00");
  });
});

describe("timeZoneOffsetMs", () => {
  it("tracks DST rather than treating the offset as fixed", () => {
    const jan = Date.parse("2026-01-15T12:00:00Z");
    const jul = Date.parse("2026-07-15T12:00:00Z");
    expect(timeZoneOffsetMs(jan, NY)).toBe(-5 * 3_600_000); // EST
    expect(timeZoneOffsetMs(jul, NY)).toBe(-4 * 3_600_000); // EDT
  });

  it("handles a half-hour zone", () => {
    const t = Date.parse("2026-08-26T12:00:00Z");
    expect(timeZoneOffsetMs(t, KOLKATA)).toBe(5.5 * 3_600_000);
  });
});

describe("startOfLocalDayMs / localDayRangeMs", () => {
  it("resolves local midnight to the right UTC instant", () => {
    expect(startOfLocalDayMs("2026-08-26", NY)).toBe(
      Date.parse("2026-08-26T04:00:00Z"), // EDT = UTC-4
    );
    expect(startOfLocalDayMs("2026-01-15", NY)).toBe(
      Date.parse("2026-01-15T05:00:00Z"), // EST = UTC-5
    );
  });

  it("round-trips: the start of a day is in that day", () => {
    for (const day of ["2026-01-01", "2026-03-08", "2026-08-26", "2026-11-01"]) {
      expect(localDay(startOfLocalDayMs(day, NY), NY)).toBe(day);
    }
  });

  it("gives a 23-hour day on spring forward", () => {
    // US DST 2026 starts Sunday 8 March.
    const { startMs, endMs } = localDayRangeMs("2026-03-08", NY);
    expect((endMs - startMs) / 3_600_000).toBe(23);
  });

  it("gives a 25-hour day on fall back", () => {
    // US DST 2026 ends Sunday 1 November.
    const { startMs, endMs } = localDayRangeMs("2026-11-01", NY);
    expect((endMs - startMs) / 3_600_000).toBe(25);
  });

  it("gives a 24-hour day normally", () => {
    const { startMs, endMs } = localDayRangeMs("2026-08-26", NY);
    expect((endMs - startMs) / 3_600_000).toBe(24);
  });

  it("produces ranges that tile without gaps or overlaps", () => {
    // Every instant must belong to exactly one day bucket — including across
    // the DST seam, where an off-by-one-hour bug would double-count or drop.
    let cursor = startOfLocalDayMs("2026-10-30", NY);
    for (const day of eachDay("2026-10-30", "2026-11-03")) {
      const { startMs, endMs } = localDayRangeMs(day, NY);
      expect(startMs).toBe(cursor);
      cursor = endMs;
    }
  });
});

describe("nightOfDate", () => {
  it("files an overnight sleep under the day it started", () => {
    // Tue 23:00 → Wed 07:00 is "Tuesday night".
    const wake = Date.parse("2026-08-27T11:00:00Z"); // Thu 07:00 EDT
    expect(nightOfDate(wake, NY)).toBe("2026-08-26");
  });

  it("files a very late bedtime under the previous day", () => {
    // Slept 02:00, woke 09:00 — still the night belonging to the day before.
    const wake = Date.parse("2026-08-27T13:00:00Z"); // 09:00 EDT on the 27th
    expect(nightOfDate(wake, NY)).toBe("2026-08-26");
  });

  it("files an afternoon nap under the current day", () => {
    const wake = Date.parse("2026-08-26T20:00:00Z"); // 16:00 EDT
    expect(nightOfDate(wake, NY)).toBe("2026-08-26");
  });

  it("is stable across a month boundary", () => {
    const wake = Date.parse("2026-09-01T11:00:00Z"); // 07:00 EDT, 1 Sep
    expect(nightOfDate(wake, NY)).toBe("2026-08-31");
  });
});

describe("day string arithmetic", () => {
  it("adds days across month and year boundaries", () => {
    expect(addDays("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29"); // leap year
  });

  it("counts days between dates", () => {
    expect(daysBetween("2026-08-26", "2026-09-02")).toBe(7);
    expect(daysBetween("2026-09-02", "2026-08-26")).toBe(-7);
    expect(daysBetween("2026-08-26", "2026-08-26")).toBe(0);
  });

  it("is unaffected by DST when counting days", () => {
    // 23- and 25-hour days must still count as one day each.
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2);
    expect(daysBetween("2026-10-31", "2026-11-02")).toBe(2);
  });

  it("enumerates inclusive ranges", () => {
    expect(eachDay("2026-08-26", "2026-08-29")).toEqual([
      "2026-08-26",
      "2026-08-27",
      "2026-08-28",
      "2026-08-29",
    ]);
    expect(eachDay("2026-08-26", "2026-08-26")).toEqual(["2026-08-26"]);
  });

  it("computes weekday", () => {
    expect(dayOfWeek("2026-08-26")).toBe(3); // Wednesday
    expect(dayOfWeek("2026-08-30")).toBe(0); // Sunday
  });
});

describe("minutesFromMidnightSigned", () => {
  it("puts late-night and early-morning bedtimes on one continuous axis", () => {
    const t2330 = Date.parse("2026-08-27T03:30:00Z"); // 23:30 EDT on the 26th
    const t0030 = Date.parse("2026-08-27T04:30:00Z"); // 00:30 EDT on the 27th

    const a = minutesFromMidnightSigned(t2330, NY);
    const b = minutesFromMidnightSigned(t0030, NY);

    expect(a).toBe(-30);
    expect(b).toBe(30);
    // The whole point: these are 60 minutes apart, not 23 hours.
    expect(Math.abs(b - a)).toBe(60);
  });
});
