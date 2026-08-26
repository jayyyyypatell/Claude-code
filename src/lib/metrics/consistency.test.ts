import { describe, expect, it } from "vitest";

import { catalogKeys, describeMetric } from "./catalog";
import { convertTo, normalizeUnitToken, toCanonical } from "./units";

/**
 * Invariants between the catalog and the unit tables.
 *
 * These exist because of a real bug: `blood_glucose` was catalogued as
 * `mg/dl` while the unit module canonicalised to `mg/dL`. Nothing was
 * mis-stored, but the mismatch tripped the "unrecognised unit" warning on
 * every single glucose reading — and a warning that fires constantly is a
 * warning nobody reads, which quietly disables the real ones.
 *
 * The class of bug is a spelling drift between two tables that must agree, so
 * the test checks the agreement rather than any one entry.
 */

describe("catalog / unit-table agreement", () => {
  it("every catalogued unit is one the converter understands", () => {
    const drifted: string[] = [];

    for (const key of catalogKeys()) {
      const d = describeMetric(key);
      if (!d.canonicalUnit) continue; // unitless metrics are fine

      // A metric's storage unit must be reachable by the converter, or ingest
      // will flag every reading of it as incompatible.
      const r = convertTo(1, d.canonicalUnit, d.canonicalUnit);
      if (!r.compatible || r.unit !== d.canonicalUnit) {
        drifted.push(`${key}: "${d.canonicalUnit}" is not a unit convertTo can target`);
      }
    }

    expect(drifted).toEqual([]);
  });

  it("normalizing a canonical unit returns it unchanged", () => {
    const drifted: string[] = [];

    for (const key of catalogKeys()) {
      const { canonicalUnit } = describeMetric(key);
      if (!canonicalUnit) continue;

      const token = normalizeUnitToken(canonicalUnit);
      if (token !== canonicalUnit) {
        drifted.push(`${key}: "${canonicalUnit}" normalizes to "${token}"`);
      }
    }

    expect(drifted).toEqual([]);
  });

  it("converting a value already in its metric's unit is a no-op", () => {
    // The bug this guards: nutrition macros are catalogued in g/mg while the
    // MASS dimension canonicalises to kg. Routing through the dimension
    // default turned 100g of protein into 0.1, to be rendered as "0.1 g".
    const changed: string[] = [];

    for (const key of catalogKeys()) {
      const { canonicalUnit } = describeMetric(key);
      if (!canonicalUnit) continue;

      const r = convertTo(100, canonicalUnit, canonicalUnit);
      if (r.value !== 100 || r.unit !== canonicalUnit) {
        changed.push(`${key}: 100 ${canonicalUnit} became ${r.value} ${r.unit}`);
      }
    }

    expect(changed).toEqual([]);
  });

  it("converts into a metric's own unit rather than the dimension default", () => {
    // Both are mass, and they must land in different units.
    expect(convertTo(100, "g", "g").value).toBe(100);
    expect(convertTo(2300, "mg", "mg").value).toBe(2300);
    expect(convertTo(1, "kg", "g").value).toBeCloseTo(1000, 6);
    expect(convertTo(154, "lb", "kg").value).toBeCloseTo(69.8532, 3);

    // Cross-dimension conversion is refused, not silently scaled.
    const bad = convertTo(100, "kg", "km");
    expect(bad.compatible).toBe(false);
    expect(bad.value).toBe(100);
  });

  it("catalogues every metric with a sane aggregation", () => {
    // A wrong `agg` is silent: averaged steps look too small, summed heart
    // rate looks alarmingly high, and both are plausible enough to miss.
    const suspicious: string[] = [];

    for (const key of catalogKeys()) {
      const d = describeMetric(key);

      if (/^(step_count|flights_climbed|active_energy|dietary_)/.test(key) && d.agg !== "sum") {
        suspicious.push(`${key} is a counter but aggregates as ${d.agg}`);
      }
      if (/heart_rate$|_percentage$|saturation$/.test(key) && d.agg === "sum") {
        suspicious.push(`${key} is a rate/ratio but aggregates as sum`);
      }
      if (/^(weight_body_mass|body_mass_index|height)$/.test(key) && d.agg !== "last") {
        suspicious.push(`${key} is a body measurement but aggregates as ${d.agg}`);
      }
    }

    expect(suspicious).toEqual([]);
  });

  it("the glucose case that prompted these tests", () => {
    // Explicit regression guard for the original bug.
    const d = describeMetric("blood_glucose", "mg/dL");
    expect(d.canonicalUnit).toBe("mg/dL");
    expect(toCanonical(104, "mg/dL")).toEqual({
      value: 104,
      unit: "mg/dL",
      converted: false,
    });
    // And the mmol/L path lands on the same spelling.
    expect(toCanonical(5.5, "mmol/L").unit).toBe("mg/dL");
  });
});
