import { fromCanonical } from "@/lib/metrics/units";

/**
 * Display formatting.
 *
 * Values are stored canonical (metres, kilograms, minutes) and converted to
 * something human only here, at render time. That ordering is deliberate:
 * flipping the app between metric and imperial must never rewrite stored data.
 */

export type UnitSystem = "metric" | "imperial";

/** How each stored unit should be shown, per system. */
const DISPLAY_UNITS: Record<string, { metric: string; imperial: string }> = {
  m: { metric: "km", imperial: "mi" },
  kg: { metric: "kg", imperial: "lb" },
  degC: { metric: "degC", imperial: "degF" },
};

/** Human labels — `degC` is a storage token, not something to put on screen. */
const UNIT_LABELS: Record<string, string> = {
  count: "",
  km: "km",
  mi: "mi",
  m: "m",
  kg: "kg",
  lb: "lb",
  kcal: "kcal",
  min: "min",
  bpm: "bpm",
  ms: "ms",
  "%": "%",
  mmHg: "mmHg",
  "mg/dL": "mg/dL",
  mL: "mL",
  mg: "mg",
  g: "g",
  degC: "°C",
  degF: "°F",
  "m/s": "m/s",
  "mL/kg·min": "mL/kg·min",
};

export function unitLabel(unit: string): string {
  return UNIT_LABELS[unit] ?? unit;
}

/**
 * Convert a stored value into the unit a person should see.
 *
 * Distances are the interesting case: stored in metres because that's the
 * dimension's base, but nobody reads "8120 m" — it's 8.1 km or 5.0 mi.
 */
export function toDisplay(
  value: number,
  storedUnit: string,
  system: UnitSystem = "metric",
): { value: number; unit: string } {
  const mapping = DISPLAY_UNITS[storedUnit];
  if (!mapping) return { value, unit: storedUnit };

  const target = mapping[system];
  return { value: fromCanonical(value, target), unit: target };
}

/**
 * Format a number for display, with sensible precision for its magnitude.
 *
 * Precision by size rather than a fixed setting: 9,412 steps wants no decimals,
 * 7.2 hours wants one, and 0.85 efficiency wants two. A single rule for all
 * three produces either "9412.00" or "0.9".
 */
export function formatNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";

  const abs = Math.abs(value);
  if (abs === 0) return "0";

  // Whole numbers stay whole. "23.0 min" of exercise reads as false precision
  // when the underlying value is exactly 23.
  if (Number.isInteger(value)) return groupThousands(value);

  if (abs >= 100) return groupThousands(Math.round(value));
  if (abs >= 1) return value.toFixed(1);
  if (abs >= 0.01) return value.toFixed(2);
  return value.toPrecision(2);
}

/**
 * Thousands separators, without `toLocaleString`.
 *
 * These strings are server-rendered and hydrated in the browser, and the two
 * runtimes can resolve a default locale differently — which shows up as a
 * hydration mismatch rather than as anything obviously wrong. Formatting
 * explicitly removes the possibility.
 */
function groupThousands(value: number): string {
  const negative = value < 0;
  const digits = Math.abs(value).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return negative ? `-${grouped}` : grouped;
}

/** Compact form for stat tiles: 1,284 · 12.9K · 1.2M. */
export function formatCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${(value / 1000).toFixed(1)}K`;
  return formatNumber(value);
}

/** A stored value rendered with its unit, ready for a tile. */
export function formatValue(
  value: number | null | undefined,
  storedUnit: string,
  system: UnitSystem = "metric",
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const d = toDisplay(value, storedUnit, system);
  const label = unitLabel(d.unit);
  return label ? `${formatCompact(d.value)} ${label}` : formatCompact(d.value);
}

/** Minutes as `7h 12m` — nobody reads sleep as "432 min". */
export function formatDuration(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes)) return "—";
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

/** A signed percentage for a delta chip. */
export function formatDelta(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return "—";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(0)}%`;
}

/**
 * Whether an increase in this metric is a good thing.
 *
 * Needed because the delta chip's colour must follow *meaning*, not direction:
 * resting heart rate going up is bad, HRV going up is good, and colouring both
 * green would be actively misleading. Anything genuinely ambiguous returns
 * `null` and gets a neutral chip rather than a guess.
 */
export function higherIsBetter(metricKey: string): boolean | null {
  if (
    /^(step_count|active_energy|apple_exercise_time|heart_rate_variability|vo2_max|mindful_minutes|time_in_daylight|dietary_water|flights_climbed|walking_running_distance|apple_stand_hour)$/.test(
      metricKey,
    )
  ) {
    return true;
  }
  if (
    /^(resting_heart_rate|body_fat_percentage|dietary_caffeine|sodium|walking_asymmetry_percentage)$/.test(
      metricKey,
    )
  ) {
    return false;
  }
  // Weight, blood pressure, calories eaten — direction depends on the person's
  // goals, which this app doesn't know. Neutral is the honest answer.
  return null;
}

/** "12 minutes ago" / "3 days ago". */
export function relativeTime(
  timestampMs: number | null | undefined,
  now: number = Date.now(),
): string {
  if (timestampMs == null) return "never";
  const seconds = Math.round((now - timestampMs) / 1000);

  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? "" : "s"} ago`;
}
