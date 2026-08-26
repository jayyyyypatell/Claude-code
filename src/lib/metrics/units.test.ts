import { describe, expect, it } from "vitest";

import {
  canonicalUnitFor,
  dimensionOf,
  fromCanonical,
  guessAggregation,
  normalizeUnitToken,
  toCanonical,
} from "./units";

describe("normalizeUnitToken", () => {
  it("collapses casing and pluralisation", () => {
    for (const u of ["km", "KM", "Kilometers", "kilometre", "  km  "]) {
      expect(normalizeUnitToken(u)).toBe("km");
    }
  });

  it("treats Apple's `Cal` as kilocalories", () => {
    // Apple's UI writes kilocalories as "Cal". Reading it as a gram-calorie
    // would divide every energy figure by 1000.
    expect(normalizeUnitToken("Cal")).toBe("kcal");
    expect(normalizeUnitToken("kcal")).toBe("kcal");
  });

  it("returns empty for null/undefined/blank", () => {
    expect(normalizeUnitToken(null)).toBe("");
    expect(normalizeUnitToken(undefined)).toBe("");
    expect(normalizeUnitToken("   ")).toBe("");
  });
});

describe("toCanonical", () => {
  it("converts distances to metres", () => {
    expect(toCanonical(1, "km").value).toBeCloseTo(1000, 6);
    expect(toCanonical(1, "mi").value).toBeCloseTo(1609.344, 3);
    expect(toCanonical(5000, "m")).toEqual({
      value: 5000,
      unit: "m",
      converted: false,
    });
  });

  it("converts masses to kilograms", () => {
    expect(toCanonical(154, "lb").value).toBeCloseTo(69.8532, 3);
    expect(toCanonical(1, "st").value).toBeCloseTo(6.35029318, 6);
  });

  it("converts durations to minutes", () => {
    expect(toCanonical(1, "hr").value).toBe(60);
    expect(toCanonical(90, "s").value).toBeCloseTo(1.5, 9);
  });

  it("handles temperature as affine, not multiplicative", () => {
    // The classic bug: 98.6°F scaled by a factor instead of offset+scaled.
    const r = toCanonical(98.6, "degF");
    expect(r.value).toBeCloseTo(37, 6);
    expect(r.unit).toBe("degC");
    expect(toCanonical(32, "degF").value).toBeCloseTo(0, 9);
  });

  it("converts mmol/L glucose to mg/dL", () => {
    expect(toCanonical(5.5, "mmol/L").value).toBeCloseTo(99.1, 1);
  });

  it("passes unknown units through instead of dropping the reading", () => {
    const r = toCanonical(42, "sprockets");
    expect(r).toEqual({ value: 42, unit: "sprockets", converted: false });
  });

  it("round-trips through fromCanonical", () => {
    for (const [value, unit] of [
      [26.2, "mi"],
      [154, "lb"],
      [98.6, "degF"],
      [5.5, "mmol/L"],
      [2.5, "hr"],
    ] as const) {
      const c = toCanonical(value, unit);
      expect(fromCanonical(c.value, unit)).toBeCloseTo(value, 6);
    }
  });
});

describe("dimensionOf / canonicalUnitFor", () => {
  it("classifies units", () => {
    expect(dimensionOf("mi")).toBe("distance");
    expect(dimensionOf("Cal")).toBe("energy");
    expect(dimensionOf("bpm")).toBe("frequency");
    expect(dimensionOf("nonsense")).toBe("unknown");
  });

  it("reports the storage unit for a dimension", () => {
    expect(canonicalUnitFor("mi")).toBe("m");
    expect(canonicalUnitFor("lb")).toBe("kg");
    expect(canonicalUnitFor("degF")).toBe("degC");
  });
});

describe("guessAggregation", () => {
  it("sums additive counters", () => {
    expect(guessAggregation("count", "step_count")).toBe("sum");
    expect(guessAggregation("kcal", "active_energy")).toBe("sum");
    expect(guessAggregation("km", "walking_running_distance")).toBe("sum");
    expect(guessAggregation("min", "apple_exercise_time")).toBe("sum");
  });

  it("averages rates and levels", () => {
    expect(guessAggregation("bpm", "heart_rate")).toBe("avg");
    expect(guessAggregation("%", "blood_oxygen_saturation")).toBe("avg");
    expect(guessAggregation("ms", "heart_rate_variability")).toBe("avg");
  });

  it("takes the last reading for body measurements", () => {
    // Summing daily weigh-ins would report a 300kg human.
    expect(guessAggregation("kg", "weight_body_mass")).toBe("last");
    expect(guessAggregation("count", "body_mass_index")).toBe("last");
    expect(guessAggregation("%", "body_fat_percentage")).toBe("last");
  });

  it("defaults to avg for a wholly unknown metric", () => {
    // An averaged counter reads as obviously-too-small; a summed rate reads
    // as a real and alarming number. Prefer the visible failure.
    expect(guessAggregation("sprockets", "brand_new_apple_metric")).toBe("avg");
  });
});
