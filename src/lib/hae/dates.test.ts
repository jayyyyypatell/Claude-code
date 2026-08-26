import { describe, expect, it } from "vitest";

import { HaeDateParseError, parseHaeDate, tryParseHaeDate } from "./dates";

describe("parseHaeDate", () => {
  it("parses the canonical Health Auto Export format", () => {
    const r = parseHaeDate("2026-08-26 14:30:00 -0700");
    expect(r.epochMs).toBe(Date.parse("2026-08-26T14:30:00-07:00"));
    expect(r.tzOffsetMinutes).toBe(-420);
    expect(r.localDate).toBe("2026-08-26");
    expect(r.usedFallbackZone).toBe(false);
  });

  it("does not agree with naive `new Date()` on the risky case", () => {
    // The whole reason this module exists. A sample recorded at 23:30 local in
    // a +0900 zone belongs to the 26th locally, but is the 26th at 14:30 UTC.
    // Deriving the day from the instant in a UTC-hosted server gives the same
    // answer here — but a -0700 sample at 23:30 would come out as the NEXT
    // day. We take the day from the string, so the local day is always right.
    const tokyo = parseHaeDate("2026-08-26 23:30:00 +0900");
    const la = parseHaeDate("2026-08-26 23:30:00 -0700");

    expect(tokyo.localDate).toBe("2026-08-26");
    expect(la.localDate).toBe("2026-08-26");

    // ...whereas the UTC day of the LA sample is the 27th.
    expect(new Date(la.epochMs).toISOString().slice(0, 10)).toBe("2026-08-27");
  });

  it("handles positive and half-hour offsets", () => {
    expect(parseHaeDate("2026-08-26 09:00:00 +0530").tzOffsetMinutes).toBe(330);
    expect(parseHaeDate("2026-08-26 09:00:00 +0530").epochMs).toBe(
      Date.parse("2026-08-26T09:00:00+05:30"),
    );
    // Nepal, +05:45 — the offset nobody remembers to test.
    expect(parseHaeDate("2026-08-26 09:00:00 +0545").tzOffsetMinutes).toBe(345);
  });

  it("accepts a colon in the offset", () => {
    expect(parseHaeDate("2026-08-26 14:30:00 -07:00").tzOffsetMinutes).toBe(-420);
  });

  it("accepts ISO 8601 with T and Z", () => {
    const r = parseHaeDate("2026-08-26T14:30:00Z");
    expect(r.epochMs).toBe(Date.parse("2026-08-26T14:30:00Z"));
    expect(r.tzOffsetMinutes).toBe(0);
  });

  it("handles fractional seconds left-aligned", () => {
    // `.5` means 500ms, not 5ms.
    expect(parseHaeDate("2026-08-26 14:30:00.5 +0000").epochMs % 1000).toBe(500);
    expect(parseHaeDate("2026-08-26 14:30:00.25 +0000").epochMs % 1000).toBe(250);
    expect(parseHaeDate("2026-08-26 14:30:00.123 +0000").epochMs % 1000).toBe(123);
  });

  it("handles missing seconds", () => {
    expect(parseHaeDate("2026-08-26 14:30 +0000").epochMs).toBe(
      Date.parse("2026-08-26T14:30:00Z"),
    );
  });

  it("falls back to the configured zone when no offset is present", () => {
    const r = parseHaeDate("2026-08-26 14:30:00", "America/New_York");
    // August → EDT → UTC-4.
    expect(r.tzOffsetMinutes).toBe(-240);
    expect(r.epochMs).toBe(Date.parse("2026-08-26T14:30:00-04:00"));
    expect(r.localDate).toBe("2026-08-26");
    expect(r.usedFallbackZone).toBe(true);
  });

  it("applies the right DST offset in the fallback zone", () => {
    // Same wall clock, different times of year, different offsets.
    expect(parseHaeDate("2026-01-15 12:00:00", "America/New_York").tzOffsetMinutes).toBe(-300);
    expect(parseHaeDate("2026-07-15 12:00:00", "America/New_York").tzOffsetMinutes).toBe(-240);
  });

  it("keeps the local date stable across a year boundary", () => {
    const r = parseHaeDate("2025-12-31 23:45:00 -0500");
    expect(r.localDate).toBe("2025-12-31");
    // It is already 2026 in UTC — the local date must not follow.
    expect(new Date(r.epochMs).toISOString().slice(0, 10)).toBe("2026-01-01");
  });

  it("rejects garbage rather than guessing", () => {
    for (const bad of [
      "not a date",
      "",
      "2026-13-01 00:00:00 +0000", // month 13
      "2026-08-32 00:00:00 +0000", // day 32
      "2026-08-26 25:00:00 +0000", // hour 25
      null,
      undefined,
      12345,
      {},
    ]) {
      expect(() => parseHaeDate(bad)).toThrow(HaeDateParseError);
    }
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseHaeDate("  2026-08-26 14:30:00 -0700  ").tzOffsetMinutes).toBe(-420);
  });
});

describe("tryParseHaeDate", () => {
  it("returns null instead of throwing, for skip-and-warn ingest", () => {
    expect(tryParseHaeDate("nope")).toBeNull();
    expect(tryParseHaeDate("2026-08-26 14:30:00 -0700")).not.toBeNull();
  });
});
