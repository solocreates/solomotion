import { describe, expect, it } from "vitest";
import { DEFAULT_EAR_GUARD, auditionGain, guardTrimDb } from "./audition";

/**
 * The guard's contract, asserted where every surface can see it.
 *
 * These are the numbers three different browsers now depend on through one
 * `auditionItem`, and the reason the test exists is that two of them used to
 * bypass the guard entirely — which no test could catch while the guard lived
 * in one panel's own preferences.
 */
describe("the ear guard", () => {
  const guard = DEFAULT_EAR_GUARD;

  it("holds a loud sound down to the ceiling and leaves a quiet one alone", () => {
    // Ten decibels over the −18 dB ceiling comes down by exactly ten.
    expect(guardTrimDb(-8, guard)).toBeCloseTo(-10, 5);
    // Under the ceiling, untouched — it is a ceiling, not a normaliser, and
    // equalising two sounds would destroy what you are auditioning for.
    expect(guardTrimDb(-30, guard)).toBe(0);
  });

  it("does nothing to a sound whose loudness was never measured", () => {
    // A synthesized pack has no measured loudness. Silence is the right answer
    // rather than a guess, and `auditionItem` leans on exactly this.
    expect(guardTrimDb(null, guard)).toBe(0);
    expect(auditionGain(0.8, null, guard)).toBeCloseTo(0.8, 5);
  });

  it("multiplies the correction into the listener's volume, never replaces it", () => {
    // Taking the smaller of the two would make the volume slider do nothing
    // between 50% and 100% on every loud file.
    const loud = auditionGain(1, -8, guard);
    const half = auditionGain(0.5, -8, guard);
    expect(half).toBeCloseTo(loud / 2, 5);
  });

  it("is off when it is off", () => {
    const off = { ...guard, enabled: false };
    expect(guardTrimDb(-8, off)).toBe(0);
    expect(auditionGain(0.8, -8, off)).toBeCloseTo(0.8, 5);
  });
});
