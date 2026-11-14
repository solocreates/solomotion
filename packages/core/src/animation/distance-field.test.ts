import { describe, expect, it } from "vitest";
import { signedDistanceField } from "./distance-field";

function rect(w: number, h: number, x0: number, y0: number, x1: number, y1: number): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = 1;
  return m;
}

describe("signedDistanceField", () => {
  it("is exact and positive inside, negative outside, zero on the edge", () => {
    const w = 32;
    const h = 32;
    const d = signedDistanceField(rect(w, h, 8, 8, 24, 24), w, h);
    const at = (x: number, y: number) => d[y * w + x]!;
    // The boundary ring's centre sits half a pixel inside the true edge.
    expect(at(8, 16)).toBeCloseTo(0.5, 5);
    expect(at(7, 16)).toBeCloseTo(-0.5, 5);
    // Straight in from the left edge: k pixels in = k + 0.5.
    expect(at(12, 16)).toBeCloseTo(4.5, 5);
    // The centre is 8 in from every side (a sharp rect keeps sharp isolines).
    expect(at(16, 16)).toBeCloseTo(7.5, 5);
    // A corner pixel outside measures the diagonal, not the axis.
    expect(at(5, 5)).toBeCloseTo(-(Math.hypot(3, 3) - 0.5), 5);
  });

  it("caps at the declared reach", () => {
    const w = 64;
    const d = signedDistanceField(rect(w, w, 4, 4, 60, 60), w, w, 3);
    expect(d[32 * w + 32]).toBe(3);
    expect(d[0]).toBe(-3);
  });

  it("treats the buffer border as an edge", () => {
    const w = 10;
    const d = signedDistanceField(rect(w, w, 0, 0, w, w), w, w);
    expect(d[0]).toBeCloseTo(0.5, 5);
    expect(d[4 * w + 4]).toBeCloseTo(4.5, 5); // 4 in from the top/left ring
  });
});
