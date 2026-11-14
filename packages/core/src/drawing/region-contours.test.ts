import { describe, expect, it } from "vitest";
import { gridToMask } from "./area";
import { pathBox } from "../pivot";
import { traceRegionContours } from "./region-contours";

const FRAME = { width: 400, height: 400 };

/** A filled polygon burned into a frame-sized mask, the way a flood leaves one. */
function maskOf(poly: Array<[number, number]>) {
  const grid = new Uint8Array(FRAME.width * FRAME.height);
  const inside = (x: number, y: number) => {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i]!;
      const [xj, yj] = poly[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  for (let y = 0; y < FRAME.height; y++) {
    for (let x = 0; x < FRAME.width; x++) if (inside(x + 0.5, y + 0.5)) grid[y * FRAME.width + x] = 1;
  }
  return gridToMask(grid, FRAME.width, FRAME.height);
}

/** Where a contour point actually lands once the clip is placed at cx/cy. */
const placed = (t: { subpaths: Array<{ points: Array<{ x: number; y: number }> }>; cx: number; cy: number }) =>
  t.subpaths.flatMap((s) => s.points.map((p) => ({ x: p.x + t.cx, y: p.y + t.cy })));

describe("traceRegionContours", () => {
  const triangle: Array<[number, number]> = [[60, 60], [340, 90], [180, 320]];

  it("places the outline on its OWN centre, so a fill lands where it was poured", () => {
    const t = traceRegionContours(maskOf(triangle), FRAME, { simplify: 1.4, fit: 2.2, minAreaPx: 16 })!;
    // The pivot is a fraction of `pathBox`, so the geometry must be centred on
    // it. Anything else renders the art displaced by the difference — the
    // "it's in the wrong place until I nudge it" bug.
    const box = pathBox(t.subpaths);
    expect(box.cx).toBeCloseTo(0, 6);
    expect(box.cy).toBeCloseTo(0, 6);
  });

  it("and lands on the pixels it was traced from", () => {
    const t = traceRegionContours(maskOf(triangle), FRAME, { simplify: 1.4, fit: 2.2, minAreaPx: 16 })!;
    // Frame-centre coords → frame pixels, compared against the polygon's box.
    for (const p of placed(t)) {
      expect(p.x + FRAME.width / 2).toBeGreaterThan(55);
      expect(p.x + FRAME.width / 2).toBeLessThan(345);
      expect(p.y + FRAME.height / 2).toBeGreaterThan(55);
      expect(p.y + FRAME.height / 2).toBeLessThan(325);
    }
  });

  it("a poured polygon has no curves in it", () => {
    const t = traceRegionContours(maskOf(triangle), FRAME, { simplify: 1.4, fit: 2.2, minAreaPx: 16 })!;
    expect(t.subpaths).toHaveLength(1);
    const pts = t.subpaths[0]!.points;
    expect(pts.length).toBeLessThanOrEqual(4);
    expect(pts.every((p) => p.hIn === null && p.hOut === null)).toBe(true);
  });

  it("a THIN sliver keeps its straight edges — the acute case that still bowed", () => {
    const sliver: Array<[number, number]> = [[40, 200], [360, 176], [360, 200]];
    const t = traceRegionContours(maskOf(sliver), FRAME, { simplify: 1.4, fit: 2.2, minAreaPx: 16 })!;
    const pts = t.subpaths[0]!.points;
    expect(pts.every((p) => p.hIn === null && p.hOut === null)).toBe(true);
  });
});
