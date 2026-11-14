import { describe, expect, it } from "vitest";
import type { Contour, Subpath } from "../schema";
import {
  DEFAULT_PATH_FIDELITY,
  MAX_REFIT_ANCHORS,
  decimatePolyline,
  fitPolyline,
  refitSubpaths,
} from "./fidelity";
import { eraseVectorSubpaths } from "./vector-cut";
import { subpathToRing } from "../vector/polygon";

/** A polygonal ring, the shape a boolean hands back: every vertex a corner. */
let n = 0;
function polygonSubpath(points: Array<{ x: number; y: number }>): Subpath {
  return { id: `s${n++}`, closed: true, points: points.map((p) => ({ x: p.x, y: p.y, hIn: null, hOut: null })) };
}

function circlePolygon(r: number, steps: number, cx = 0, cy = 0) {
  return Array.from({ length: steps }, (_, i) => {
    const a = (i / steps) * Math.PI * 2;
    return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
  });
}

/** Max distance from each sample of `sub` to the nearest point of `ring`. */
function maxDeviation(sub: Contour, ring: Array<{ x: number; y: number }>): number {
  const samples = subpathToRing(sub, 0.05);
  let worst = 0;
  for (const [x, y] of samples) {
    let best = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const len = abx * abx + aby * aby;
      const t = len < 1e-12 ? 0 : Math.min(1, Math.max(0, ((x - a.x) * abx + (y - a.y) * aby) / len));
      best = Math.min(best, Math.hypot(x - (a.x + abx * t), y - (a.y + aby * t)));
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

describe("decimatePolyline", () => {
  it("keeps the ends and drops collinear points", () => {
    const line = Array.from({ length: 500 }, (_, i) => ({ x: i, y: 0 }));
    expect(decimatePolyline(line, 0.5)).toHaveLength(2);
  });

  it("survives an input far deeper than the call stack allows", () => {
    // A staircase: every point matters, so a recursive RDP would recurse once
    // per point. This is the shape a boolean on a rasterised region produces.
    const stair = Array.from({ length: 20_000 }, (_, i) => ({ x: i, y: i % 2 }));
    expect(decimatePolyline(stair, 0.1).length).toBeGreaterThan(1000);
  });
});

describe("fitPolyline", () => {
  it("keeps a rectangle's corners sharp", () => {
    // Densely sampled edges — the input a carve produces.
    const pts: Array<{ x: number; y: number }> = [];
    const push = (x0: number, y0: number, x1: number, y1: number) => {
      for (let i = 0; i < 40; i++) pts.push({ x: x0 + ((x1 - x0) * i) / 40, y: y0 + ((y1 - y0) * i) / 40 });
    };
    push(-50, -30, 50, -30);
    push(50, -30, 50, 30);
    push(50, 30, -50, 30);
    push(-50, 30, -50, -30);
    const fitted = fitPolyline(pts, DEFAULT_PATH_FIDELITY, true)!;
    expect(fitted.points).toHaveLength(4);
    // A corner is a corner: no handle rounds it off.
    for (const p of fitted.points) {
      expect(p.hIn).toBeNull();
      expect(p.hOut).toBeNull();
    }
  });

  it("turns a dense circle into a handful of smooth anchors", () => {
    const ring = circlePolygon(80, 240);
    const fitted = fitPolyline(ring, DEFAULT_PATH_FIDELITY, true)!;
    expect(fitted.points.length).toBeLessThanOrEqual(10);
    expect(fitted.closed).toBe(true);
    expect(maxDeviation(fitted, ring)).toBeLessThan(DEFAULT_PATH_FIDELITY.simplify * 2);
  });
});

describe("refitSubpaths", () => {
  it("leaves small polygons and authored curves alone", () => {
    const star = polygonSubpath(circlePolygon(20, 10));
    expect(refitSubpaths([star], DEFAULT_PATH_FIDELITY)[0]).toBe(star);

    const curvy: Subpath = {
      id: "curvy",
      closed: false,
      points: Array.from({ length: 40 }, (_, i) => ({
        x: i * 10,
        y: 0,
        hIn: { x: i * 10 - 3, y: 0 },
        hOut: { x: i * 10 + 3, y: 0 },
      })),
    };
    expect(refitSubpaths([curvy], DEFAULT_PATH_FIDELITY)[0]).toBe(curvy);
  });

  it("caps anchors however fine the fidelity is set", () => {
    // A noisy blob at a fidelity that asks for every wobble: the budget, not
    // the setting, decides that this can still be opened in the node editor.
    const noisy = polygonSubpath(
      Array.from({ length: 6000 }, (_, i) => {
        const a = (i / 6000) * Math.PI * 2;
        const r = 200 + (i % 2 === 0 ? 6 : -6);
        return { x: Math.cos(a) * r, y: Math.sin(a) * r };
      }),
    );
    const out = refitSubpaths([noisy], { smoothing: 0, simplify: 0.05, corner: 20 })[0]!;
    expect(out.points.length).toBeLessThanOrEqual(MAX_REFIT_ANCHORS);
  });
});

describe("the eraser on filled art", () => {
  it("hands back an editable outline, not a vertex dump", () => {
    const disc = polygonSubpath(circlePolygon(100, 360));
    const trail = Array.from({ length: 120 }, (_, i) => ({ x: -140 + i * 2.4, y: 60, radius: 14 }));

    let subpaths = [disc];
    // Ten passes: the old code compounded, because each cut re-flattened what
    // the previous one produced. The count has to stay flat, not creep.
    for (let pass = 0; pass < 10; pass++) {
      const result = eraseVectorSubpaths(
        subpaths,
        { points: trail.map((p) => ({ ...p, y: 60 - pass * 3 })) },
        { mode: "split", filled: true, fidelity: DEFAULT_PATH_FIDELITY },
      );
      if (result.kind === "geometry") subpaths = result.subpaths;
      else if (result.kind === "delete") subpaths = [];
    }
    const anchors = subpaths.reduce((n, s) => n + s.points.length, 0);
    expect(anchors).toBeGreaterThan(0);
    expect(anchors).toBeLessThan(120);
  });
});
