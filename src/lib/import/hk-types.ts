/**
 * HealthKit type identifiers → the metric keys the rest of the app uses.
 *
 * This table is the entire reason the two ingest paths converge. Apple's
 * `export.xml` says `HKQuantityTypeIdentifierStepCount`; Health Auto Export
 * says `step_count`. Without a mapping they register as two different metrics,
 * and your history sits in a second row that no chart reads and no rollup
 * touches — the backfill would appear to work and produce nothing.
 *
 * Anything not listed here still imports. `metricKeyForHkType` falls back to
 * de-camel-casing the identifier, which lands close enough to the HAE spelling
 * to be recognisable, and the catalog invents a descriptor for it. Dropping an
 * unrecognised type would be the worse failure: it is history, and there is no
 * second copy.
 */

const EXPLICIT: Record<string, string> = {
  /* ---------------------------------------------------------------- activity */
  HKQuantityTypeIdentifierStepCount: "step_count",
  HKQuantityTypeIdentifierDistanceWalkingRunning: "walking_running_distance",
  HKQuantityTypeIdentifierDistanceCycling: "cycling_distance",
  HKQuantityTypeIdentifierDistanceSwimming: "swimming_distance",
  HKQuantityTypeIdentifierDistanceWheelchair: "wheelchair_distance",
  HKQuantityTypeIdentifierDistanceDownhillSnowSports: "distance_downhill_snow_sports",
  HKQuantityTypeIdentifierActiveEnergyBurned: "active_energy",
  HKQuantityTypeIdentifierBasalEnergyBurned: "basal_energy_burned",
  HKQuantityTypeIdentifierAppleExerciseTime: "apple_exercise_time",
  HKQuantityTypeIdentifierAppleStandTime: "apple_stand_time",
  HKCategoryTypeIdentifierAppleStandHour: "apple_stand_hour",
  HKQuantityTypeIdentifierAppleMoveTime: "apple_move_time",
  HKQuantityTypeIdentifierFlightsClimbed: "flights_climbed",
  HKQuantityTypeIdentifierPushCount: "push_count",
  HKQuantityTypeIdentifierSwimmingStrokeCount: "swimming_stroke_count",
  HKQuantityTypeIdentifierPhysicalEffort: "physical_effort",
  HKQuantityTypeIdentifierTimeInDaylight: "time_in_daylight",

  /* ------------------------------------------------------------------ vitals */
  HKQuantityTypeIdentifierHeartRate: "heart_rate",
  HKQuantityTypeIdentifierRestingHeartRate: "resting_heart_rate",
  HKQuantityTypeIdentifierWalkingHeartRateAverage: "walking_heart_rate_average",
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: "heart_rate_variability",
  HKQuantityTypeIdentifierHeartRateRecoveryOneMinute: "heart_rate_recovery_one_minute",
  HKQuantityTypeIdentifierAtrialFibrillationBurden: "atrial_fibrillation_burden",
  HKQuantityTypeIdentifierOxygenSaturation: "blood_oxygen_saturation",
  HKQuantityTypeIdentifierRespiratoryRate: "respiratory_rate",
  HKQuantityTypeIdentifierBodyTemperature: "body_temperature",
  HKQuantityTypeIdentifierAppleSleepingWristTemperature: "apple_sleeping_wrist_temperature",
  HKQuantityTypeIdentifierBloodGlucose: "blood_glucose",
  HKQuantityTypeIdentifierVO2Max: "vo2_max",
  HKQuantityTypeIdentifierForcedVitalCapacity: "forced_vital_capacity",
  HKQuantityTypeIdentifierPeakExpiratoryFlowRate: "peak_expiratory_flow_rate",

  /* -------------------------------------------------------------------- body */
  HKQuantityTypeIdentifierBodyMass: "weight_body_mass",
  HKQuantityTypeIdentifierBodyFatPercentage: "body_fat_percentage",
  HKQuantityTypeIdentifierLeanBodyMass: "lean_body_mass",
  HKQuantityTypeIdentifierBodyMassIndex: "body_mass_index",
  HKQuantityTypeIdentifierHeight: "height",
  HKQuantityTypeIdentifierWaistCircumference: "waist_circumference",

  /* --------------------------------------------------------------- nutrition */
  HKQuantityTypeIdentifierDietaryEnergyConsumed: "dietary_energy",
  HKQuantityTypeIdentifierDietaryProtein: "protein",
  HKQuantityTypeIdentifierDietaryCarbohydrates: "carbohydrates",
  HKQuantityTypeIdentifierDietaryFatTotal: "total_fat",
  HKQuantityTypeIdentifierDietaryFatSaturated: "saturated_fat",
  HKQuantityTypeIdentifierDietaryFiber: "fiber",
  HKQuantityTypeIdentifierDietarySugar: "dietary_sugar",
  HKQuantityTypeIdentifierDietarySodium: "sodium",
  HKQuantityTypeIdentifierDietaryWater: "dietary_water",
  HKQuantityTypeIdentifierDietaryCaffeine: "dietary_caffeine",
  HKQuantityTypeIdentifierDietaryCholesterol: "dietary_cholesterol",

  /* ------------------------------------------------------------- mindfulness */
  HKCategoryTypeIdentifierMindfulSession: "mindful_minutes",
  HKStateOfMind: "state_of_mind_valence",

  /* ---------------------------------------------------------------- mobility */
  HKQuantityTypeIdentifierWalkingSpeed: "walking_speed",
  HKQuantityTypeIdentifierWalkingStepLength: "walking_step_length",
  HKQuantityTypeIdentifierWalkingAsymmetryPercentage: "walking_asymmetry_percentage",
  HKQuantityTypeIdentifierWalkingDoubleSupportPercentage: "walking_double_support_percentage",
  HKQuantityTypeIdentifierAppleWalkingSteadiness: "apple_walking_steadiness",
  HKQuantityTypeIdentifierSixMinuteWalkTestDistance: "six_minute_walking_test_distance",
  HKQuantityTypeIdentifierStairAscentSpeed: "stair_speed_up",
  HKQuantityTypeIdentifierStairDescentSpeed: "stair_speed_down",
  HKQuantityTypeIdentifierRunningSpeed: "running_speed",
  HKQuantityTypeIdentifierRunningPower: "running_power",
  HKQuantityTypeIdentifierRunningGroundContactTime: "running_ground_contact_time",
  HKQuantityTypeIdentifierRunningVerticalOscillation: "running_vertical_oscillation",
  HKQuantityTypeIdentifierCyclingPower: "cycling_power",
  HKQuantityTypeIdentifierCyclingCadence: "cycling_cadence",
  HKQuantityTypeIdentifierCyclingFunctionalThresholdPower: "cycling_functional_threshold_power",

  /* ------------------------------------------------------------------- other */
  HKQuantityTypeIdentifierHeadphoneAudioExposure: "headphone_audio_exposure",
  HKQuantityTypeIdentifierEnvironmentalAudioExposure: "environmental_audio_exposure",
  HKQuantityTypeIdentifierUVExposure: "uv_exposure",
  HKQuantityTypeIdentifierNumberOfTimesFallen: "number_of_times_fallen",
  HKCategoryTypeIdentifierHandwashingEvent: "handwashing",
  HKCategoryTypeIdentifierToothbrushingEvent: "toothbrushing",
  HKCategoryTypeIdentifierSexualActivity: "sexual_activity",
  HKQuantityTypeIdentifierInhalerUsage: "inhaler_usage",
  HKQuantityTypeIdentifierInsulinDelivery: "insulin_delivery",
};

/** Blood pressure arrives as two separate record types; the app stores one row. */
export const BLOOD_PRESSURE_TYPES: Record<string, "systolic" | "diastolic"> = {
  HKQuantityTypeIdentifierBloodPressureSystolic: "systolic",
  HKQuantityTypeIdentifierBloodPressureDiastolic: "diastolic",
};

export const SLEEP_TYPE = "HKCategoryTypeIdentifierSleepAnalysis";

const PREFIXES = [
  "HKQuantityTypeIdentifier",
  "HKCategoryTypeIdentifier",
  "HKDataTypeIdentifier",
  "HKCharacteristicTypeIdentifier",
  "HKCorrelationTypeIdentifier",
  "HKWorkoutActivityType",
];

/** `AppleStandHour` → `apple_stand_hour`; `VO2Max` → `vo2_max`. */
export function snakeFromCamel(name: string): string {
  return name
    // A digit ends an acronym run: VO2Max must break as VO2 | Max, not VO | 2Max.
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    // ...and an acronym followed by a word: HRVAverage → HRV_Average.
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/**
 * The metric key for a HealthKit type, mapped or derived.
 *
 * `isKnown` is false for a derived key. Callers surface that as a warning —
 * it means Apple shipped a type this table predates, which is worth telling
 * the user about, but never a reason to skip the record.
 */
export function metricKeyForHkType(hkType: string): {
  key: string;
  isKnown: boolean;
} {
  const explicit = EXPLICIT[hkType];
  if (explicit) return { key: explicit, isKnown: true };

  let stripped = hkType;
  for (const p of PREFIXES) {
    if (stripped.startsWith(p)) {
      stripped = stripped.slice(p.length);
      break;
    }
  }
  return { key: snakeFromCamel(stripped) || hkType.toLowerCase(), isKnown: false };
}

/** `HKWorkoutActivityTypeHighIntensityIntervalTraining` → `High Intensity Interval Training`. */
export function workoutNameForActivityType(activityType: string): string {
  const stripped = activityType.replace(/^HKWorkoutActivityType/, "");
  if (!stripped) return "Workout";
  return snakeFromCamel(stripped)
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Sleep phase values, reduced to the vocabulary `sessionsFromPhases` matches on.
 *
 * `AsleepUnspecified` is what a phone-only sleep record looks like — no stages,
 * just "asleep". It has to stay distinguishable from `InBed`, or a night
 * tracked without a watch reads as eight hours of lying awake.
 */
export function sleepPhaseFromCategoryValue(value: string): string {
  const v = value.replace(/^HKCategoryValueSleepAnalysis/, "").toLowerCase();
  if (v.includes("deep")) return "deep";
  if (v.includes("rem")) return "rem";
  if (v.includes("core")) return "core";
  if (v.includes("awake")) return "awake";
  if (v.includes("inbed")) return "inbed";
  if (v.includes("asleep")) return "asleep";
  // A bare numeric category value: 0 is InBed, 1 is the legacy "asleep".
  if (v === "0") return "inbed";
  if (v === "1") return "asleep";
  return v || "asleep";
}
