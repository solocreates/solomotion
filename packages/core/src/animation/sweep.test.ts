import { describe, expect, it } from "vitest";
import { sweepAt } from "./sweep";

const clock = (over: Partial<Parameters<typeof sweepAt>[0]> = {}) => ({
  position: 0,
  duration: 2,
  delay: 0,
  loop: true,
  ...over,
});

describe("sweepAt", () => {
  it("is the authored position when the duration is off", () => {
    expect(sweepAt(clock({ duration: 0, position: 0.42 }), 99)).toBe(0.42);
  });

  it("ramps 0→1 across the duration", () => {
    expect(sweepAt(clock(), 0)).toBe(0);
    expect(sweepAt(clock(), 1)).toBe(0.5);
    expect(sweepAt(clock(), 1.999)).toBeCloseTo(1, 2);
  });

  it("adds the authored position to the ramp, so keyframes still bite", () => {
    expect(sweepAt(clock({ position: 0.25 }), 1)).toBe(0.75);
  });

  it("holds at the far end through the gap instead of snapping back", () => {
    // A 2s pass with a 1s gap: the pass runs t∈[1,3], then HOLDS at 1 until 4.
    const withDelay = clock({ duration: 2, delay: 1 });
    expect(sweepAt(withDelay, 2.5)).toBe(0.75);
    expect(sweepAt(withDelay, 3)).toBe(1);
    expect(sweepAt(withDelay, 3.5)).toBe(1);
    expect(sweepAt(withDelay, 4)).toBe(0);
    // With no gap the cycle restarts the instant it finishes.
    expect(sweepAt(clock({ delay: 0, duration: 2 }), 2)).toBe(0);
  });

  it("waits out the delay before the first pass", () => {
    expect(sweepAt(clock({ delay: 1, loop: false }), 0.5)).toBe(0);
    expect(sweepAt(clock({ delay: 1, loop: false }), 2)).toBe(0.5);
  });

  it("finishes and stays finished when it does not loop", () => {
    const once = clock({ loop: false });
    expect(sweepAt(once, 2)).toBe(1);
    expect(sweepAt(once, 200)).toBe(1);
  });
});
