import { describe, expect, it } from "vitest";
import { createBrushPreset } from "./brush";
import { vectorStroke, widthProfileSamples, type VectorStrokePoint } from "./vector-stroke";

const brush = (vector: Record<string, unknown> = {}, strokePath: Record<string, unknown> = {}) =>
  createBrushPreset({ name: "v", engine: "vector", vector, strokePath } as never);

/** Read a measured curve the way `profileAt` does: `t` is a fraction of LENGTH. */
const at = (curve: readonly number[], t: number): number => {
  const p = Math.min(1, Math.max(0, t)) * (curve.length - 1);
  const i = Math.min(curve.length - 2, Math.floor(p));
  return curve[i]! + (curve[i + 1]! - curve[i]!) * (p - i);
};

describe("vectorStroke pressure", () => {
  /**
   * THE regression. A hand does not move at a constant speed, so input samples
   * are spaced by TIME while a stroke profile is read by DISTANCE. The curve
   * used to be stored one-entry-per-sample, so pressure applied in the first
   * tenth of a line was replayed across the first four fifths of it.
   *
   * Here the hand dawdles over the first 10px (20 samples, pressing hard) and
   * then races the remaining 90px (5 samples, barely touching). The step in
   * width belongs at t = 0.1, where the hand actually let go.
   */
  it("places pressure where the hand was, not where the samples were", () => {
    const pts: VectorStrokePoint[] = [];
    for (let i = 0; i < 20; i++) pts.push({ x: (i * 10) / 19, y: 0, pressure: 1 });
    for (let i = 1; i <= 5; i++) pts.push({ x: 10 + (i * 90) / 5, y: 0, pressure: 0 });

    const s = vectorStroke(pts, brush({ variableWidth: true, widthPressure: 1, minWidth: 0, straightenPx: 0 }), 10)!;
    const curve = widthProfileSamples(s.widths!, 10);

    // Hard through the dawdle, light for the whole race.
    expect(at(curve, 0.02)).toBeCloseTo(1, 1);
    expect(at(curve, 0.06)).toBeCloseTo(1, 1);
    expect(at(curve, 0.5)).toBeLessThan(0.1);
    expect(at(curve, 0.95)).toBeLessThan(0.1);
    // The old index-space curve put the transition at 20/24 ≈ 0.83; the honest
    // one is well before halfway.
    const cross = curve.findIndex((w) => w < 0.5) / (curve.length - 1);
    expect(cross).toBeGreaterThan(0.05);
    expect(cross).toBeLessThan(0.25);
  });

  it("bounds what it stores, however long or slowly the line was drawn", () => {
    const many: VectorStrokePoint[] = Array.from({ length: 4000 }, (_, i) => ({
      x: i * 0.5,
      y: 0,
      pressure: (Math.sin(i / 40) + 1) / 2,
    }));
    const s = vectorStroke(many, brush({ variableWidth: true, straightenPx: 0 }), 10)!;
    expect(s.widths!.length).toBeLessThanOrEqual(256);
    expect(s.widths!.length).toBeGreaterThan(2);
  });

  it("a stroke that went nowhere still describes one width", () => {
    const still: VectorStrokePoint[] = Array.from({ length: 8 }, () => ({ x: 5, y: 5, pressure: 0.5 }));
    const s = vectorStroke(still, brush({ variableWidth: true, autoClosePx: 0, straightenPx: 0 }), 10);
    if (s) expect(s.widths).toHaveLength(1);
  });

  it("gives no curve at all when the brush does not vary its width", () => {
    const pts: VectorStrokePoint[] = Array.from({ length: 8 }, (_, i) => ({ x: i * 9, y: 0, pressure: i / 7 }));
    expect(vectorStroke(pts, brush(), 6)!.widths).toBeNull();
  });
});
