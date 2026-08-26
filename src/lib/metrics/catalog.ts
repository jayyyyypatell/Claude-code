import { canonicalUnitFor, guessAggregation } from "./units";

/**
 * Known Apple Health / Health Auto Export metrics.
 *
 * This is a *hint table*, not a whitelist. Apple ships new metric types with
 * roughly every iOS release, and Health Auto Export exposes them before anyone
 * updates a catalog like this one. So an unrecognised key is never rejected —
 * `describeMetric()` synthesises a sensible entry and the ingest path records
 * a warning. Losing a year of a new metric because we hadn't heard of it would
 * be a far worse failure than getting its category slightly wrong.
 *
 * What the catalog buys us is the things that can't be inferred: a readable
 * name, the right category, and — crucially — the correct aggregation where
 * the unit alone would mislead. `body_mass_index` is a unitless `count`, and
 * guessing `sum` for it would report a BMI of 700.
 */

export type MetricAgg = "sum" | "avg" | "last" | "min" | "max";
export type MetricCategory =
  | "activity"
  | "vitals"
  | "sleep"
  | "body"
  | "nutrition"
  | "mindfulness"
  | "other";

export interface MetricDescriptor {
  key: string;
  displayName: string;
  category: MetricCategory;
  agg: MetricAgg;
  /** Unit to store in when the payload doesn't say. */
  canonicalUnit: string;
  /** Show on the Today page by default. */
  pinned?: boolean;
}

type CatalogEntry = Omit<MetricDescriptor, "key">;

const CATALOG: Record<string, CatalogEntry> = {
  /* ---------------------------------------------------------------- activity */
  step_count: { displayName: "Steps", category: "activity", agg: "sum", canonicalUnit: "count", pinned: true },
  active_energy: { displayName: "Active Energy", category: "activity", agg: "sum", canonicalUnit: "kcal", pinned: true },
  basal_energy_burned: { displayName: "Resting Energy", category: "activity", agg: "sum", canonicalUnit: "kcal" },
  apple_exercise_time: { displayName: "Exercise Minutes", category: "activity", agg: "sum", canonicalUnit: "min", pinned: true },
  apple_stand_time: { displayName: "Stand Minutes", category: "activity", agg: "sum", canonicalUnit: "min" },
  apple_stand_hour: { displayName: "Stand Hours", category: "activity", agg: "sum", canonicalUnit: "count" },
  apple_move_time: { displayName: "Move Minutes", category: "activity", agg: "sum", canonicalUnit: "min" },
  walking_running_distance: { displayName: "Walking + Running Distance", category: "activity", agg: "sum", canonicalUnit: "m", pinned: true },
  cycling_distance: { displayName: "Cycling Distance", category: "activity", agg: "sum", canonicalUnit: "m" },
  swimming_distance: { displayName: "Swimming Distance", category: "activity", agg: "sum", canonicalUnit: "m" },
  wheelchair_distance: { displayName: "Wheelchair Distance", category: "activity", agg: "sum", canonicalUnit: "m" },
  distance_downhill_snow_sports: { displayName: "Downhill Snow Sports Distance", category: "activity", agg: "sum", canonicalUnit: "m" },
  flights_climbed: { displayName: "Flights Climbed", category: "activity", agg: "sum", canonicalUnit: "count" },
  push_count: { displayName: "Pushes", category: "activity", agg: "sum", canonicalUnit: "count" },
  swimming_stroke_count: { displayName: "Swim Strokes", category: "activity", agg: "sum", canonicalUnit: "count" },
  physical_effort: { displayName: "Physical Effort", category: "activity", agg: "avg", canonicalUnit: "kcal" },
  time_in_daylight: { displayName: "Time in Daylight", category: "activity", agg: "sum", canonicalUnit: "min" },

  /* ------------------------------------------------------------------ vitals */
  heart_rate: { displayName: "Heart Rate", category: "vitals", agg: "avg", canonicalUnit: "bpm" },
  resting_heart_rate: { displayName: "Resting Heart Rate", category: "vitals", agg: "avg", canonicalUnit: "bpm", pinned: true },
  walking_heart_rate_average: { displayName: "Walking Heart Rate", category: "vitals", agg: "avg", canonicalUnit: "bpm" },
  heart_rate_variability: { displayName: "HRV", category: "vitals", agg: "avg", canonicalUnit: "ms", pinned: true },
  heart_rate_recovery_one_minute: { displayName: "HR Recovery (1 min)", category: "vitals", agg: "avg", canonicalUnit: "bpm" },
  atrial_fibrillation_burden: { displayName: "AFib Burden", category: "vitals", agg: "avg", canonicalUnit: "%" },
  blood_pressure: { displayName: "Blood Pressure", category: "vitals", agg: "avg", canonicalUnit: "mmHg" },
  blood_oxygen_saturation: { displayName: "Blood Oxygen", category: "vitals", agg: "avg", canonicalUnit: "%" },
  respiratory_rate: { displayName: "Respiratory Rate", category: "vitals", agg: "avg", canonicalUnit: "bpm" },
  body_temperature: { displayName: "Body Temperature", category: "vitals", agg: "avg", canonicalUnit: "degC" },
  apple_sleeping_wrist_temperature: { displayName: "Wrist Temperature (Sleeping)", category: "vitals", agg: "avg", canonicalUnit: "degC" },
  blood_glucose: { displayName: "Blood Glucose", category: "vitals", agg: "avg", canonicalUnit: "mg/dL" },
  vo2_max: { displayName: "VO₂ Max", category: "vitals", agg: "last", canonicalUnit: "mL/kg·min" },
  forced_vital_capacity: { displayName: "Forced Vital Capacity", category: "vitals", agg: "avg", canonicalUnit: "L" },
  peak_expiratory_flow_rate: { displayName: "Peak Expiratory Flow", category: "vitals", agg: "avg", canonicalUnit: "L/min" },

  /* -------------------------------------------------------------------- body */
  weight_body_mass: { displayName: "Weight", category: "body", agg: "last", canonicalUnit: "kg", pinned: true },
  body_fat_percentage: { displayName: "Body Fat", category: "body", agg: "last", canonicalUnit: "%" },
  lean_body_mass: { displayName: "Lean Body Mass", category: "body", agg: "last", canonicalUnit: "kg" },
  // Unitless `count` — the unit-based guess would say `sum` and report a BMI
  // in the hundreds. This is exactly why the catalog exists.
  body_mass_index: { displayName: "BMI", category: "body", agg: "last", canonicalUnit: "count" },
  height: { displayName: "Height", category: "body", agg: "last", canonicalUnit: "m" },
  waist_circumference: { displayName: "Waist Circumference", category: "body", agg: "last", canonicalUnit: "m" },

  /* --------------------------------------------------------------- nutrition */
  dietary_energy: { displayName: "Calories Eaten", category: "nutrition", agg: "sum", canonicalUnit: "kcal" },
  protein: { displayName: "Protein", category: "nutrition", agg: "sum", canonicalUnit: "g" },
  carbohydrates: { displayName: "Carbohydrates", category: "nutrition", agg: "sum", canonicalUnit: "g" },
  total_fat: { displayName: "Total Fat", category: "nutrition", agg: "sum", canonicalUnit: "g" },
  saturated_fat: { displayName: "Saturated Fat", category: "nutrition", agg: "sum", canonicalUnit: "g" },
  fiber: { displayName: "Fibre", category: "nutrition", agg: "sum", canonicalUnit: "g" },
  dietary_sugar: { displayName: "Sugar", category: "nutrition", agg: "sum", canonicalUnit: "g" },
  sodium: { displayName: "Sodium", category: "nutrition", agg: "sum", canonicalUnit: "mg" },
  dietary_water: { displayName: "Water", category: "nutrition", agg: "sum", canonicalUnit: "mL" },
  dietary_caffeine: { displayName: "Caffeine", category: "nutrition", agg: "sum", canonicalUnit: "mg" },
  dietary_cholesterol: { displayName: "Cholesterol", category: "nutrition", agg: "sum", canonicalUnit: "mg" },

  /* ------------------------------------------------------------- mindfulness */
  mindful_minutes: { displayName: "Mindful Minutes", category: "mindfulness", agg: "sum", canonicalUnit: "min" },
  // Apple's State of Mind. Valence runs -1 (very unpleasant) to +1 (very
  // pleasant), so it averages — summing would make a long day look euphoric.
  state_of_mind_valence: { displayName: "Mood (Valence)", category: "mindfulness", agg: "avg", canonicalUnit: "count" },

  /* -------------------------------------------------------------- mobility */
  walking_speed: { displayName: "Walking Speed", category: "activity", agg: "avg", canonicalUnit: "m/s" },
  walking_step_length: { displayName: "Step Length", category: "activity", agg: "avg", canonicalUnit: "m" },
  walking_asymmetry_percentage: { displayName: "Walking Asymmetry", category: "activity", agg: "avg", canonicalUnit: "%" },
  walking_double_support_percentage: { displayName: "Double Support Time", category: "activity", agg: "avg", canonicalUnit: "%" },
  apple_walking_steadiness: { displayName: "Walking Steadiness", category: "activity", agg: "avg", canonicalUnit: "%" },
  six_minute_walking_test_distance: { displayName: "6-Minute Walk Distance", category: "activity", agg: "last", canonicalUnit: "m" },
  stair_speed_up: { displayName: "Stair Speed (Up)", category: "activity", agg: "avg", canonicalUnit: "m/s" },
  stair_speed_down: { displayName: "Stair Speed (Down)", category: "activity", agg: "avg", canonicalUnit: "m/s" },
  running_speed: { displayName: "Running Speed", category: "activity", agg: "avg", canonicalUnit: "m/s" },
  running_power: { displayName: "Running Power", category: "activity", agg: "avg", canonicalUnit: "W" },
  running_ground_contact_time: { displayName: "Ground Contact Time", category: "activity", agg: "avg", canonicalUnit: "ms" },
  running_vertical_oscillation: { displayName: "Vertical Oscillation", category: "activity", agg: "avg", canonicalUnit: "m" },
  cycling_power: { displayName: "Cycling Power", category: "activity", agg: "avg", canonicalUnit: "W" },
  cycling_cadence: { displayName: "Cycling Cadence", category: "activity", agg: "avg", canonicalUnit: "bpm" },
  cycling_functional_threshold_power: { displayName: "Cycling FTP", category: "activity", agg: "last", canonicalUnit: "W" },

  /* ------------------------------------------------------------------- other */
  headphone_audio_exposure: { displayName: "Headphone Audio Exposure", category: "other", agg: "avg", canonicalUnit: "dBASPL" },
  environmental_audio_exposure: { displayName: "Environmental Audio Exposure", category: "other", agg: "avg", canonicalUnit: "dBASPL" },
  uv_exposure: { displayName: "UV Index", category: "other", agg: "avg", canonicalUnit: "count" },
  number_of_times_fallen: { displayName: "Falls", category: "other", agg: "sum", canonicalUnit: "count" },
  handwashing: { displayName: "Handwashing", category: "other", agg: "sum", canonicalUnit: "s" },
  toothbrushing: { displayName: "Toothbrushing", category: "other", agg: "sum", canonicalUnit: "s" },
  sexual_activity: { displayName: "Sexual Activity", category: "other", agg: "sum", canonicalUnit: "count" },
  inhaler_usage: { displayName: "Inhaler Usage", category: "other", agg: "sum", canonicalUnit: "count" },
  insulin_delivery: { displayName: "Insulin Delivery", category: "other", agg: "sum", canonicalUnit: "IU" },
};

/** `walking_running_distance` → `Walking Running Distance`. */
function titleCase(key: string): string {
  return key
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Resolve a metric key to a descriptor, inventing a reasonable one if the key
 * is unknown.
 *
 * `isKnown` lets the caller decide whether to warn — it never gates ingest.
 */
export function describeMetric(
  key: string,
  unitFromPayload?: string | null,
): MetricDescriptor & { isKnown: boolean } {
  const normalizedKey = key.trim();
  const entry = CATALOG[normalizedKey];

  if (entry) {
    return {
      key: normalizedKey,
      ...entry,
      // Prefer the payload's unit dimension when the catalog has no opinion,
      // so a metric we listed without a unit still stores something sane.
      canonicalUnit:
        entry.canonicalUnit || canonicalUnitFor(unitFromPayload) || "",
      isKnown: true,
    };
  }

  return {
    key: normalizedKey,
    displayName: titleCase(normalizedKey),
    category: inferCategory(normalizedKey),
    agg: guessAggregation(unitFromPayload, normalizedKey),
    canonicalUnit: canonicalUnitFor(unitFromPayload),
    isKnown: false,
  };
}

/** Best-effort category for an unknown key, from substrings in its name. */
function inferCategory(key: string): MetricCategory {
  const k = key.toLowerCase();
  if (/sleep/.test(k)) return "sleep";
  if (/heart|blood|oxygen|respiratory|temperature|glucose|vo2|ecg|pressure/.test(k))
    return "vitals";
  if (/weight|body|bmi|height|lean|waist|fat_percentage/.test(k)) return "body";
  if (/dietary|protein|carb|fat|fiber|fibre|sugar|sodium|caffeine|water|vitamin|calcium|iron|magnesium|potassium|zinc/.test(k))
    return "nutrition";
  if (/mindful|state_of_mind|mood/.test(k)) return "mindfulness";
  if (/step|distance|energy|exercise|stand|flight|walk|run|cycl|swim|workout|speed|push/.test(k))
    return "activity";
  return "other";
}

/** Every key the catalog knows about. Used by the seed script. */
export function catalogKeys(): string[] {
  return Object.keys(CATALOG);
}

/** Keys pinned to the Today page by default. */
export function pinnedKeys(): string[] {
  return Object.entries(CATALOG)
    .filter(([, v]) => v.pinned)
    .map(([k]) => k);
}
