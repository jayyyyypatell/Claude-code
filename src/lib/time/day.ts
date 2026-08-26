/**
 * Local-day arithmetic.
 *
 * Every "per day" number in this app — steps on Tuesday, last night's sleep,
 * a habit streak — is a question about a *local calendar day*, while the
 * underlying samples are UTC instants. This module is the only place that
 * bridges the two, so the conversion is defined once and tested once.
 *
 * Everything here is pure and takes an explicit timezone, so tests can pin a
 * zone (and a DST boundary) without touching the environment.
 */

/**
 * IANA zone the user lives in. All local-day maths resolves against this.
 *
 * Read from the public copy first so the same value is used on the server and
 * in the browser — `USER_TIMEZONE` alone is undefined in the client bundle,
 * which would silently make every client-rendered time UTC. `next.config.ts`
 * maps one into the other.
 */
export const USER_TIMEZONE =
  process.env.NEXT_PUBLIC_USER_TIMEZONE ?? process.env.USER_TIMEZONE ?? "UTC";

/** A local calendar day, `YYYY-MM-DD`. */
export type DayString = string;

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

/**
 * Cache the formatters. `Intl.DateTimeFormat` construction is surprisingly
 * expensive, and a backfill import calls this once per record — hundreds of
 * thousands of times.
 */
const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = partsFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsFormatters.set(timeZone, fmt);
  }
  return fmt;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock reading in `timeZone` at a given UTC instant. */
function wallClock(instantMs: number, timeZone: string): WallClock {
  const parts = partsFormatter(timeZone).formatToParts(new Date(instantMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : 0;
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    // Some ICU builds render midnight as hour "24" under hour12:false.
    // Left unhandled it shifts midnight samples onto the previous day.
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/**
 * The zone's UTC offset, in ms, *at a particular instant*.
 *
 * Instant-specific because offsets are not a property of a zone — they change
 * at DST transitions. `America/New_York` is -5h in January and -4h in July.
 */
export function timeZoneOffsetMs(instantMs: number, timeZone: string): number {
  const wc = wallClock(instantMs, timeZone);
  const asIfUtc = Date.UTC(
    wc.year,
    wc.month - 1,
    wc.day,
    wc.hour,
    wc.minute,
    wc.second,
  );
  // Round to the second: `instantMs` may carry sub-second precision that would
  // otherwise leak into the offset.
  return asIfUtc - Math.floor(instantMs / 1000) * 1000;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** The local calendar day containing a UTC instant. */
export function localDay(
  instantMs: number,
  timeZone: string = USER_TIMEZONE,
): DayString {
  const wc = wallClock(instantMs, timeZone);
  return `${pad(wc.year, 4)}-${pad(wc.month)}-${pad(wc.day)}`;
}

/** Parse `YYYY-MM-DD` into its numeric parts. Throws on anything else. */
export function parseDayString(day: DayString): {
  year: number;
  month: number;
  day: number;
} {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error(`Invalid day string: ${JSON.stringify(day)}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/**
 * The UTC instant at which a local day begins.
 *
 * Solved by iteration rather than algebra: we want the instant `t` where the
 * wall clock reads midnight, but the offset needed to find `t` is itself a
 * function of `t`. Guess using the offset at UTC-midnight, correct, then
 * re-check once — the second pass is what gets DST-transition days right.
 */
export function startOfLocalDayMs(
  day: DayString,
  timeZone: string = USER_TIMEZONE,
): number {
  const { year, month, day: d } = parseDayString(day);
  const utcMidnight = Date.UTC(year, month - 1, d, 0, 0, 0);

  let ts = utcMidnight - timeZoneOffsetMs(utcMidnight, timeZone);
  ts = utcMidnight - timeZoneOffsetMs(ts, timeZone);

  // On a spring-forward day local midnight may not exist (rare, but real:
  // some zones shift at 00:00). Step forward to the first instant that does
  // land on the requested day.
  if (localDay(ts, timeZone) !== day) {
    for (let extra = 1; extra <= 4; extra++) {
      const candidate = ts + extra * MS_PER_HOUR;
      if (localDay(candidate, timeZone) === day) return candidate;
    }
  }
  return ts;
}

/**
 * Half-open UTC bounds `[startMs, endMs)` of a local day.
 *
 * Derived from the *next* day's start rather than by adding 24h, so days that
 * are 23 or 25 hours long across a DST shift come out the right length.
 */
export function localDayRangeMs(
  day: DayString,
  timeZone: string = USER_TIMEZONE,
): { startMs: number; endMs: number } {
  const startMs = startOfLocalDayMs(day, timeZone);
  const endMs = startOfLocalDayMs(addDays(day, 1), timeZone);
  return { startMs, endMs };
}

/** Shift a day string by whole days. Calendar-safe across months and years. */
export function addDays(day: DayString, delta: number): DayString {
  const { year, month, day: d } = parseDayString(day);
  const shifted = new Date(Date.UTC(year, month - 1, d + delta));
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(
    shifted.getUTCMonth() + 1,
  )}-${pad(shifted.getUTCDate())}`;
}

/** Whole days between two day strings (`to - from`). */
export function daysBetween(from: DayString, to: DayString): number {
  const a = parseDayString(from);
  const b = parseDayString(to);
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) -
      Date.UTC(a.year, a.month - 1, a.day)) /
      MS_PER_DAY,
  );
}

/** Every day from `start` to `end`, inclusive of both. */
export function eachDay(start: DayString, end: DayString): DayString[] {
  const out: DayString[] = [];
  const span = daysBetween(start, end);
  for (let i = 0; i <= span; i++) out.push(addDays(start, i));
  return out;
}

/** Day of week for a day string. 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(day: DayString): number {
  const { year, month, day: d } = parseDayString(day);
  return new Date(Date.UTC(year, month - 1, d)).getUTCDay();
}

/** Today, in the user's zone. */
export function todayLocal(
  timeZone: string = USER_TIMEZONE,
  now: number = Date.now(),
): DayString {
  return localDay(now, timeZone);
}

/**
 * Which night a sleep session belongs to.
 *
 * Sleep spans midnight, so neither endpoint's calendar day is the obvious
 * answer. The rule: **subtract 12 hours from the wake time and take that local
 * day**, which files Tue 23:00 → Wed 07:00 under Tuesday. "Tuesday's sleep"
 * therefore means the night that followed Tuesday, matching how people talk
 * about it and letting sleep line up with the day whose behaviour caused it.
 *
 * The 12-hour shift also handles the awkward cases without special-casing: a
 * 02:00 → 09:00 night still lands on the previous day, and an afternoon nap
 * ending at 16:00 lands on the current day.
 */
export function nightOfDate(
  sleepEndMs: number,
  timeZone: string = USER_TIMEZONE,
): DayString {
  return localDay(sleepEndMs - 12 * MS_PER_HOUR, timeZone);
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * `2026-08-26` → `Wed 26 Aug`. Display only.
 *
 * Assembled by hand rather than via `Intl.DateTimeFormat`. This string is
 * rendered on the server and hydrated in the browser, and the two runtimes
 * ship different ICU versions — Node produced `Tue 28 Jul` while Chromium
 * produced `Tue, 28 Jul` for the same locale and options, which React
 * correctly reports as a hydration mismatch and re-renders the whole subtree
 * over. Any Intl-formatted string inside a client component is exposed to that
 * drift; a fixed lookup table simply cannot disagree with itself.
 */
export function formatDayShort(day: DayString): string {
  const { year, month, day: d } = parseDayString(day);
  const weekday = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
  return `${WEEKDAY_NAMES[weekday]} ${d} ${MONTH_NAMES[month - 1]}`;
}

/** `2026-08-26` → `26 Aug`. For tight spaces where the weekday won't fit. */
export function formatDayCompact(day: DayString): string {
  const { month, day: d } = parseDayString(day);
  return `${d} ${MONTH_NAMES[month - 1]}`;
}

/** Local wall-clock `HH:MM` of an instant — bedtimes, wake times. */
export function formatClock(
  instantMs: number,
  timeZone: string = USER_TIMEZONE,
): string {
  const wc = wallClock(instantMs, timeZone);
  return `${pad(wc.hour)}:${pad(wc.minute)}`;
}

/**
 * Minutes since local midnight, allowed to go negative for late-evening times.
 *
 * Bedtime consistency needs 23:30 and 00:30 to be half an hour apart, not 23
 * hours. Anything at or after 18:00 is expressed as a negative offset from the
 * following midnight, which puts them on one continuous axis.
 */
export function minutesFromMidnightSigned(
  instantMs: number,
  timeZone: string = USER_TIMEZONE,
): number {
  const wc = wallClock(instantMs, timeZone);
  const minutes = wc.hour * 60 + wc.minute;
  return wc.hour >= 18 ? minutes - 24 * 60 : minutes;
}

/** Minutes between two instants. */
export function minutesBetween(startMs: number, endMs: number): number {
  return (endMs - startMs) / MS_PER_MINUTE;
}
