import { describe, expect, it } from "vitest";
import { fitClosedContour, fitSubpath } from "./path-fit";

/** Densely sampled ring, the way a traced region arrives. */
function sample(points: Array<[number, number]>, step: number) {
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i]!;
    const [bx, by] = points[(i + 1) % points.length]!;
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 0; k < n; k++) out.push({ x: ax + ((bx - ax) * k) / n, y: ay + ((by - ay) * k) / n });
  }
  return out;
}

const sharp = (p: { hIn: unknown; hOut: unknown }) => p.hIn === null && p.hOut === null;

describe("fitClosedContour", () => {
  const triangle = sample([[0, 0], [400, 0], [200, 300]], 6);

  it("a polygon comes back a polygon — the bucket's whole complaint", () => {
    const fitted = fitClosedContour(triangle, 2.2)!;
    expect(fitted.closed).toBe(true);
    // Three corners, and nothing rounded between them.
    expect(fitted.points).toHaveLength(3);
    expect(fitted.points.every(sharp)).toBe(true);
  });

  it("and it stays inside the shape it was traced from", () => {
    const fitted = fitClosedContour(triangle, 2.2)!;
    const xs = fitted.points.map((p) => p.x);
    const ys = fitted.points.map((p) => p.y);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(-1);
    expect(Math.max(...xs)).toBeLessThanOrEqual(401);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(-1);
    expect(Math.max(...ys)).toBeLessThanOrEqual(301);
  });

  it("the freehand fitter is what rounded it off — why this function exists", () => {
    const smoothed = fitSubpath([...triangle], 2.2, true)!;
    // Handles where the shape has none, and it escapes the triangle's own box.
    expect(smoothed.points.some((p) => p.hIn !== null || p.hOut !== null)).toBe(true);
    const out = smoothed.points.some((p) => p.x < -2 || p.x > 402 || p.y < -2 || p.y > 302);
    const anchors = smoothed.points.filter(sharp).length;
    expect(out || anchors < 3).toBe(true);
  });

  it("a curve is still a curve — no corners invented on a circle", () => {
    const circle: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 240; i++) {
      const t = (i / 240) * Math.PI * 2;
      circle.push({ x: 200 + 150 * Math.cos(t), y: 200 + 150 * Math.sin(t) });
    }
    const fitted = fitClosedContour(circle, 1)!;
    expect(fitted.points.length).toBeLessThan(12);
    expect(fitted.points.some((p) => p.hIn !== null && p.hOut !== null)).toBe(true);
  });

  it("declines a ring with nothing in it", () => {
    expect(fitClosedContour([{ x: 0, y: 0 }, { x: 1, y: 1 }], 1)).toBeNull();
  });
});
