import { describe, expect, it } from "vitest";
import { blackbody, blackbodyHex } from "./blackbody";

describe("blackbody", () => {
  it("runs red → sunlight → white → blue-white the way a hotter body does", () => {
    const ember = blackbody(1200), candle = blackbody(1900), sun = blackbody(5800), white = blackbody(6500), giant = blackbody(30000);
    expect(ember.r).toBeCloseTo(1, 5);
    expect(ember.g).toBeLessThan(0.55);
    expect(ember.b).toBeLessThan(0.1);
    expect(candle.g).toBeGreaterThan(ember.g);
    // Sunlight: warm white.
    expect(sun.r).toBeCloseTo(1, 5);
    expect(sun.g).toBeGreaterThan(0.85);
    expect(sun.b).toBeGreaterThan(0.75);
    expect(sun.b).toBeLessThan(sun.g);
    // 6500 K is about the sRGB white point.
    for (const c of [white.r, white.g, white.b]) expect(c).toBeGreaterThan(0.93);
    // A blue giant is bluer than it is red.
    expect(giant.b).toBeCloseTo(1, 5);
    expect(giant.r).toBeLessThan(0.8);
  });

  it("is monotonic: hotter is always bluer", () => {
    let last = -1;
    for (let k = 800; k <= 40000; k += 400) {
      const c = blackbody(k);
      const blueness = c.b - c.r;
      expect(blueness).toBeGreaterThanOrEqual(last - 1e-4);
      last = blueness;
    }
  });

  it("holds its ends and reads as hex", () => {
    expect(blackbodyHex(100)).toBe(blackbodyHex(500));
    expect(blackbodyHex(1e6)).toBe(blackbodyHex(50000));
    expect(blackbodyHex(5800)).toMatch(/^#ff[0-9a-f]{4}$/);
  });
});
