/**
 * Unit normalization.
 *
 * Health Auto Export reports each metric in whatever unit the phone's locale
 * is set to, and that can change mid-history — fly to London, switch to
 * metric, and your distance series silently changes meaning halfway through.
 *
 * So values are converted to one canonical unit per dimension at ingest, and
 * converted back only at render time from a display preference. That ordering
 * matters: toggling metric/imperial in the UI must never rewrite stored data.
 */

/** The unit every stored value of a given dimension is expressed in. */
export const CANONICAL_UNITS = {
  distance: "m",
  energy: "kcal",
  mass: "kg",
  duration: "min",
  temperature: "degC",
  pressure: "mmHg",
  frequency: "bpm",
  count: "count",
  percent: "%",
  concentration: "mg/dL",
  volume: "mL",
  speed: "m/s",
  time: "ms",
  vo2: "mL/kg·min",
  unknown: "",
} as const;

export type Dimension = keyof typeof CANONICAL_UNITS;

/**
 * Alias table. Health Auto Export is not consistent about casing or
 * pluralisation, and Apple's own strings differ again (`Cal` means kilocalorie
 * in Apple's UI, which is a units crime but one we have to accommodate).
 */
const ALIASES: Record<string, string> = {
  // distance
  m: "m", meter: "m", meters: "m", metre: "m", metres: "m",
  km: "km", kilometer: "km", kilometers: "km", kilometre: "km", kilometres: "km",
  mi: "mi", mile: "mi", miles: "mi",
  ft: "ft", foot: "ft", feet: "ft",
  yd: "yd", yard: "yd", yards: "yd",
  cm: "cm", in: "in", inch: "in", inches: "in",

  // energy — note `Cal`/`Calorie` mean *kilo*calories in Apple's vocabulary
  kcal: "kcal", cal: "kcal", calorie: "kcal", calories: "kcal", kj: "kJ",

  // mass
  kg: "kg", kilogram: "kg", kilograms: "kg",
  g: "g", gram: "g", grams: "g", mg: "mg", mcg: "mcg", µg: "mcg",
  lb: "lb", lbs: "lb", pound: "lb", pounds: "lb",
  st: "st", stone: "st", oz: "oz", ounce: "oz", ounces: "oz",

  // duration
  min: "min", minute: "min", minutes: "min", mins: "min",
  hr: "hr", hour: "hr", hours: "hr", h: "hr",
  s: "s", sec: "s", second: "s", seconds: "s",
  ms: "ms", day: "day", days: "day",

  // temperature
  degc: "degC", c: "degC", celsius: "degC", "°c": "degC",
  degf: "degF", f: "degF", fahrenheit: "degF", "°f": "degF",

  // rate / misc
  bpm: "bpm", "count/min": "bpm", "count/s": "count/s",
  "%": "%", percent: "%",
  mmhg: "mmHg",
  "mg/dl": "mg/dl", "mmol/l": "mmol/L",
  l: "L", liter: "L", litre: "L", ml: "mL", "fl_oz_us": "fl_oz",
  "m/s": "m/s", "km/h": "km/h", mph: "mph",
  "ml/kg·min": "mL/kg·min", "ml/kg/min": "mL/kg·min", "ml/(kg*min)": "mL/kg·min",
  count: "count",
};

/** Multiplicative conversions into the canonical unit of each dimension. */
const FACTORS: Record<string, { dimension: Dimension; toCanonical: number }> = {
  // distance → m
  m: { dimension: "distance", toCanonical: 1 },
  km: { dimension: "distance", toCanonical: 1000 },
  mi: { dimension: "distance", toCanonical: 1609.344 },
  ft: { dimension: "distance", toCanonical: 0.3048 },
  yd: { dimension: "distance", toCanonical: 0.9144 },
  cm: { dimension: "distance", toCanonical: 0.01 },
  in: { dimension: "distance", toCanonical: 0.0254 },

  // energy → kcal
  kcal: { dimension: "energy", toCanonical: 1 },
  kJ: { dimension: "energy", toCanonical: 0.239006 },

  // mass → kg
  kg: { dimension: "mass", toCanonical: 1 },
  g: { dimension: "mass", toCanonical: 0.001 },
  mg: { dimension: "mass", toCanonical: 1e-6 },
  mcg: { dimension: "mass", toCanonical: 1e-9 },
  lb: { dimension: "mass", toCanonical: 0.45359237 },
  st: { dimension: "mass", toCanonical: 6.35029318 },
  oz: { dimension: "mass", toCanonical: 0.028349523 },

  // duration → min
  min: { dimension: "duration", toCanonical: 1 },
  hr: { dimension: "duration", toCanonical: 60 },
  s: { dimension: "duration", toCanonical: 1 / 60 },
  day: { dimension: "duration", toCanonical: 1440 },

  // volume → mL
  mL: { dimension: "volume", toCanonical: 1 },
  L: { dimension: "volume", toCanonical: 1000 },
  fl_oz: { dimension: "volume", toCanonical: 29.5735 },

  // speed → m/s
  "m/s": { dimension: "speed", toCanonical: 1 },
  "km/h": { dimension: "speed", toCanonical: 1 / 3.6 },
  mph: { dimension: "speed", toCanonical: 0.44704 },

  // already canonical / dimensionless
  ms: { dimension: "time", toCanonical: 1 },
  bpm: { dimension: "frequency", toCanonical: 1 },
  "count/s": { dimension: "frequency", toCanonical: 60 },
  "%": { dimension: "percent", toCanonical: 1 },
  mmHg: { dimension: "pressure", toCanonical: 1 },
  "mg/dl": { dimension: "concentration", toCanonical: 1 },
  count: { dimension: "count", toCanonical: 1 },
  "mL/kg·min": { dimension: "vo2", toCanonical: 1 },
  degC: { dimension: "temperature", toCanonical: 1 },
};

/**
 * Units whose conversion is affine or molar rather than a plain factor, so
 * they can't ride the `FACTORS` table.
 *
 * They still need a dimension: without this, `dimensionOf("degF")` returns
 * `unknown` and a Fahrenheit reading gets stored as-is under a Fahrenheit
 * unit label, right next to Celsius values in the same column.
 */
const AFFINE_DIMENSIONS: Record<string, Dimension> = {
  degF: "temperature",
  "mmol/L": "concentration",
};

/** Collapse casing/pluralisation noise to a known unit token. */
export function normalizeUnitToken(unit: string | null | undefined): string {
  if (!unit) return "";
  const raw = String(unit).trim();
  if (!raw) return "";
  return ALIASES[raw.toLowerCase()] ?? raw;
}

/** Which physical dimension a unit belongs to. */
export function dimensionOf(unit: string | null | undefined): Dimension {
  const token = normalizeUnitToken(unit);
  return FACTORS[token]?.dimension ?? AFFINE_DIMENSIONS[token] ?? "unknown";
}

/** The canonical unit a value in `unit` will be stored as. */
export function canonicalUnitFor(unit: string | null | undefined): string {
  const dim = dimensionOf(unit);
  return dim === "unknown"
    ? normalizeUnitToken(unit)
    : CANONICAL_UNITS[dim];
}

/**
 * Convert a value into its canonical unit.
 *
 * Unknown units pass through untouched rather than being coerced to zero or
 * dropped — an unrecognised unit is a reason to keep the number and warn, not
 * a reason to lose the reading.
 */
export function toCanonical(
  value: number,
  unit: string | null | undefined,
): { value: number; unit: string; converted: boolean } {
  const token = normalizeUnitToken(unit);

  // Temperature is affine, not multiplicative — it needs the offset, so it
  // can't ride the factor table.
  if (token === "degF") {
    return { value: ((value - 32) * 5) / 9, unit: "degC", converted: true };
  }
  if (token === "mmol/L") {
    // Blood glucose. 18.0182 is the molar mass factor for glucose.
    return { value: value * 18.0182, unit: "mg/dl", converted: true };
  }

  const entry = FACTORS[token];
  if (!entry) return { value, unit: token, converted: false };

  const canonical = CANONICAL_UNITS[entry.dimension];
  return {
    value: value * entry.toCanonical,
    unit: canonical,
    converted: entry.toCanonical !== 1,
  };
}

/** Convert a canonical value out to a display unit. Render-time only. */
export function fromCanonical(value: number, displayUnit: string): number {
  const token = normalizeUnitToken(displayUnit);
  if (token === "degF") return (value * 9) / 5 + 32;
  if (token === "mmol/L") return value / 18.0182;
  const entry = FACTORS[token];
  if (!entry) return value;
  return value / entry.toCanonical;
}

/**
 * Guess how a metric should roll up to a day, from its unit alone.
 *
 * Used only when a metric key arrives that isn't in the catalog. Getting this
 * wrong is a *silent* correctness bug — averaging step counts, or summing
 * heart rate, both yield plausible-looking nonsense — so the guess is
 * conservative and always overridable in `metric_types`.
 *
 * `avg` is the safe default: an averaged counter looks obviously too small,
 * whereas a summed rate looks like a real (alarming) number.
 */
export function guessAggregation(
  unit: string | null | undefined,
  metricKey = "",
): "sum" | "avg" | "last" | "min" | "max" {
  const key = metricKey.toLowerCase();
  const dim = dimensionOf(unit);

  // Body measurements supersede rather than accumulate.
  if (/weight|mass|bmi|height|body_fat|lean_body/.test(key)) return "last";
  if (/^resting_heart_rate$/.test(key)) return "avg";

  // Additive counters.
  if (dim === "count" && !/rate|per_min/.test(key)) return "sum";
  if (dim === "energy" || dim === "distance" || dim === "volume") return "sum";
  if (dim === "duration") return "sum";

  // Rates, levels and ratios average.
  return "avg";
}
