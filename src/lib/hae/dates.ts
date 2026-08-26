import { timeZoneOffsetMs, USER_TIMEZONE } from "@/lib/time/day";

/**
 * Parsing Health Auto Export timestamps.
 *
 * HAE sends `yyyy-MM-dd HH:mm:ss Z`, e.g. `2026-08-26 14:30:00 -0700`.
 *
 * **Never use `new Date(str)` on this.** Two separate problems:
 *
 *  1. The space-separated form is not ISO 8601. Parsing it is
 *     implementation-defined — engines disagree, and the same string can give
 *     different answers on different runtimes.
 *  2. Even where it parses, you get an instant and lose the offset. The offset
 *     is precisely the information needed to decide which *local day* a sample
 *     belongs to, which is what every "steps per day" figure depends on.
 *
 * Both failure modes are silent. A misparse doesn't throw; it shifts your data
 * by hours and you find out months later when a chart looks subtly wrong.
 */

/**
 * `2026-08-26 14:30:00 -0700`, `2026-08-26T14:30:00Z`, `2026-08-26 14:30:00`,
 * with optional fractional seconds and an optional colon in the offset.
 */
const HAE_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,9}))?\s*(?:(Z)|([+-])(\d{2}):?(\d{2}))?$/;

export interface ParsedHaeDate {
  /** UTC instant, unix ms. */
  epochMs: number;
  /** The sample's own UTC offset, in minutes. */
  tzOffsetMinutes: number;
  /**
   * The local calendar day, taken from the **wall-clock digits in the string**
   * rather than recomputed from `epochMs`. They are the same thing, but taking
   * them from the string makes it obvious that a sample at 23:30 in Tokyo
   * belongs to the Tokyo date, regardless of where the server is.
   */
  localDate: string;
  /** True when the string carried no offset and the fallback zone was used. */
  usedFallbackZone: boolean;
}

export class HaeDateParseError extends Error {
  constructor(public readonly input: unknown) {
    super(`Unparseable Health Auto Export timestamp: ${JSON.stringify(input)}`);
    this.name = "HaeDateParseError";
  }
}

/**
 * Resolve a wall-clock reading in a named zone to a UTC instant.
 *
 * Needed when a timestamp arrives with no offset. Iterative for the same
 * reason as `startOfLocalDayMs`: the offset depends on the instant, and the
 * instant depends on the offset. Two passes settle DST boundaries.
 */
function wallClockToInstant(
  utcGuess: number,
  timeZone: string,
): { epochMs: number; offsetMinutes: number } {
  let offset = timeZoneOffsetMs(utcGuess, timeZone);
  let epochMs = utcGuess - offset;
  offset = timeZoneOffsetMs(epochMs, timeZone);
  epochMs = utcGuess - offset;
  return { epochMs, offsetMinutes: offset / 60_000 };
}

/**
 * Parse a Health Auto Export timestamp.
 *
 * @param input     the raw string from the payload
 * @param fallbackZone  zone to assume when the string carries no offset
 * @throws HaeDateParseError when the string doesn't match at all
 */
export function parseHaeDate(
  input: unknown,
  fallbackZone: string = USER_TIMEZONE,
): ParsedHaeDate {
  if (typeof input !== "string") throw new HaeDateParseError(input);

  const m = HAE_TIMESTAMP.exec(input.trim());
  if (!m) throw new HaeDateParseError(input);

  const [
    ,
    yearStr, monthStr, dayStr,
    hourStr, minuteStr, secondStr, fractionStr,
    zulu, sign, offHourStr, offMinStr,
  ] = m;

  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const second = Number(secondStr ?? "0");

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    throw new HaeDateParseError(input);
  }

  // Fractional seconds are written left-aligned: `.5` is 500ms, not 5ms.
  const ms = fractionStr
    ? Math.round(Number(`0.${fractionStr}`) * 1000)
    : 0;

  const wallClockUtc = Date.UTC(year, month - 1, day, hour, minute, second, ms);

  // The local day is the date as written. Deliberately not derived from the
  // instant — that round-trip is where timezone bugs hide.
  const localDate = `${yearStr}-${monthStr}-${dayStr}`;

  if (zulu) {
    return { epochMs: wallClockUtc, tzOffsetMinutes: 0, localDate, usedFallbackZone: false };
  }

  if (sign) {
    const offsetMinutes =
      (sign === "-" ? -1 : 1) * (Number(offHourStr) * 60 + Number(offMinStr));
    return {
      epochMs: wallClockUtc - offsetMinutes * 60_000,
      tzOffsetMinutes: offsetMinutes,
      localDate,
      usedFallbackZone: false,
    };
  }

  // No offset in the string. Interpret the wall clock in the configured zone
  // rather than silently assuming UTC, which would shift every sample by the
  // user's offset.
  const { epochMs, offsetMinutes } = wallClockToInstant(wallClockUtc, fallbackZone);
  return { epochMs, tzOffsetMinutes: offsetMinutes, localDate, usedFallbackZone: true };
}

/** Non-throwing variant, for ingest paths that skip-and-warn per item. */
export function tryParseHaeDate(
  input: unknown,
  fallbackZone: string = USER_TIMEZONE,
): ParsedHaeDate | null {
  try {
    return parseHaeDate(input, fallbackZone);
  } catch {
    return null;
  }
}
