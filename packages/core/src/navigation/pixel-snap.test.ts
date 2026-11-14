import { describe, expect, it } from "vitest";
import { apply, multiply, rotation, scaling, snapRectToPixels, translation } from "./matrix";

const devEdges = (m: Parameters<typeof apply>[0], r: { x: number; y: number; width: number; height: number }) => {
  const a = apply(m, { x: r.x, y: r.y });
  const b = apply(m, { x: r.x + r.width, y: r.y + r.height });
  return [a.x, a.y, b.x, b.y];
};

describe("snapRectToPixels", () => {
  it("lands every edge of a scaled, offset box on whole device pixels", () => {
    // A 1920×1080 comp cropped by 4px, at 0.9 inside a 1080×1920 reel, at a stage zoom.
    const m = multiply(scaling(0.3347, 0.3347), multiply(translation(-324.5, 507.6), scaling(0.9, 0.9)));
    const r = snapRectToPixels(m, { x: 4, y: 4, width: 1912, height: 1072 });
    for (const v of devEdges(m, r)) expect(Math.abs(v - Math.round(v))).toBeLessThan(1e-6);
  });

  it("moves no edge more than half a device pixel", () => {
    const m = multiply(translation(10.3, 20.7), scaling(0.37, 0.37));
    const src = { x: 0, y: 0, width: 1080, height: 1920 };
    const before = devEdges(m, src);
    const after = devEdges(m, snapRectToPixels(m, src));
    after.forEach((v, i) => expect(Math.abs(v - before[i]!)).toBeLessThanOrEqual(0.5 + 1e-9));
  });

  it("keeps a mirrored box a positive-size rect", () => {
    const m = multiply(translation(100.4, 0), scaling(-0.5, 0.5));
    const r = snapRectToPixels(m, { x: 0, y: 0, width: 101, height: 51 });
    expect(r.width).toBeGreaterThan(0);
    for (const v of devEdges(m, r)) expect(Math.abs(v - Math.round(v))).toBeLessThan(1e-6);
  });

  it("leaves a rotated box alone — there is no grid to land on", () => {
    const m = multiply(translation(3.3, 4.4), rotation(12));
    const src = { x: 1, y: 2, width: 30, height: 40 };
    expect(snapRectToPixels(m, src)).toBe(src);
  });
});
