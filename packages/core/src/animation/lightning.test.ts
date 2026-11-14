import { describe, expect, it } from "vitest";
import { LFX, createLayerEffect } from "./layer-effects";
import { lightningIsNoop, lightningStrandsFor, resolveLightningParams, type LightningOutline } from "./lightning";
import type { LightningEffect } from "../schema/layer-effects";

const bolt = (over: Partial<LightningEffect> = {}): LightningEffect => ({
  ...(createLayerEffect("lightning") as LightningEffect),
  ...over,
});
const resolve = (fx: LightningEffect, t = 0, outline?: LightningOutline) =>
  resolveLightningParams(fx, {}, 1, t, (c) => c, undefined, outline);

/** A 100×100 square outline in a 200×200 pass, inset by 50. */
const square: LightningOutline = {
  contours: [
    [
      { x: 50, y: 50 },
      { x: 150, y: 50 },
      { x: 150, y: 150 },
      { x: 50, y: 150 },
    ],
  ],
  closed: [true],
  width: 200,
  height: 200,
};

describe("resolveLightningParams", () => {
  it("is a pure function of (seed, time) — the export matches the preview", () => {
    const fx = bolt();
    const a = resolve(fx, 1.3);
    const b = resolve(fx, 1.3);
    expect(JSON.stringify(a.strands)).toBe(JSON.stringify(b.strands));
  });

  it("re-rolls when the seed changes", () => {
    const a = resolve(bolt({ seed: 1 }));
    const b = resolve(bolt({ seed: 2 }));
    expect(JSON.stringify(a.strands)).not.toBe(JSON.stringify(b.strands));
  });

  it("subdivides the spine 2^detail times", () => {
    expect(resolve(bolt({ detail: 1, branches: 0, flicker: 0 })).strands[0]!.points.length).toBe(3);
    expect(resolve(bolt({ detail: 4, branches: 0, flicker: 0 })).strands[0]!.points.length).toBe(17);
  });

  it("hangs every fork off a real vertex of the arc", () => {
    const p = resolve(bolt({ branches: 4, detail: 3 }));
    const spine = p.strands[0]!.points;
    for (const fork of p.strands.slice(1)) {
      const root = fork.points[0]!;
      expect(spine.some((s) => s.x === root.x && s.y === root.y)).toBe(true);
    }
  });

  it("keeps a zero-chaos bolt on the straight line between its endpoints", () => {
    const p = resolve(bolt({ chaos: 0, branches: 0, ax: -1, ay: 0, bx: 1, by: 0 }));
    for (const pt of p.strands[0]!.points) expect(pt.y).toBeCloseTo(0.5, 6);
  });

  it("defers outline mode until the renderer has a silhouette, and never culls it", () => {
    const pending = resolve(bolt({ mode: "outline", count: 3 }));
    expect(pending.strands).toEqual([]);
    expect(pending.deferred).not.toBeNull();
    expect(lightningIsNoop(pending)).toBe(false);
    // The renderer finishes it later with the same pure function, so passing
    // the outline up front and passing it at draw time agree exactly.
    expect(lightningStrandsFor(pending.deferred!, square)).toEqual(resolve(bolt({ mode: "outline", count: 3 }), 0, square).strands);
  });

  it("outline mode at chaos 0 lies exactly on the path", () => {
    const p = resolve(bolt({ mode: "outline", chaos: 0, branches: 0, count: 1, span: 1, offset: 0, drift: 0 }), 0, square);
    expect(p.deferred).toBeNull();
    expect(p.strands.length).toBe(1);
    for (const pt of p.strands[0]!.points) {
      const x = pt.x * 200;
      const y = pt.y * 200;
      const onEdge =
        (Math.abs(x - 50) < 1e-6 || Math.abs(x - 150) < 1e-6) && y >= 50 - 1e-6 && y <= 150 + 1e-6
          ? true
          : (Math.abs(y - 50) < 1e-6 || Math.abs(y - 150) < 1e-6) && x >= 50 - 1e-6 && x <= 150 + 1e-6;
      expect(onEdge).toBe(true);
    }
    // A full span covers the whole perimeter: first and last point coincide.
    const pts = p.strands[0]!.points;
    expect(pts[0]).toEqual(pts[pts.length - 1]);
  });

  it("span and offset place the arc along the outline; drift moves it with time", () => {
    const at = (t: number) =>
      resolve(bolt({ mode: "outline", chaos: 0, branches: 0, count: 1, span: 0.25, offset: 0, drift: 1, flicker: 0 }), t, square).strands[0]!.points;
    // A quarter of the perimeter from the top-left corner is the top edge.
    const top = at(0);
    expect(top[0]!.x * 200).toBeCloseTo(50, 6);
    expect(top[top.length - 1]!.x * 200).toBeCloseTo(150, 6);
    for (const pt of top) expect(pt.y * 200).toBeCloseTo(50, 6);
    // A quarter lap later (drift 1 lap/s at t = 0.25) it is the right edge.
    const right = at(0.25);
    for (const pt of right) expect(pt.x * 200).toBeCloseTo(150, 6);
  });

  it("fill mode throws arcs between points inside the shape, clipped to it", () => {
    const p = resolve(bolt({ mode: "fill", count: 4, branches: 0, chaos: 0 }), 0, square);
    expect(p.inside).toBe(true);
    expect(p.strands.length).toBe(4);
    for (const s of p.strands) {
      for (const pt of [s.points[0]!, s.points[s.points.length - 1]!]) {
        expect(pt.x * 200).toBeGreaterThanOrEqual(50);
        expect(pt.x * 200).toBeLessThanOrEqual(150);
        expect(pt.y * 200).toBeGreaterThanOrEqual(50);
        expect(pt.y * 200).toBeLessThanOrEqual(150);
      }
    }
  });

  it("flicker dims deterministically and never brightens", () => {
    const still = resolve(bolt({ flicker: 0 }), 0.5).intensity;
    const live = resolve(bolt({ flicker: 1 }), 0.5).intensity;
    expect(live).toBeLessThanOrEqual(still);
    expect(resolve(bolt({ flicker: 1 }), 0.5).intensity).toBe(live);
  });

  it("draws itself on over the sweep duration", () => {
    const striking = bolt({ duration: 2, delay: 0, position: 0, loop: false });
    expect(resolve(striking, 0).growth).toBe(0);
    expect(resolve(striking, 1).growth).toBeCloseTo(0.5, 5);
    expect(resolve(striking, 5).growth).toBe(1);
    expect(lightningIsNoop(resolve(striking, 0))).toBe(true);
  });

  it("follows the artwork when added to a vector layer", () => {
    expect((LFX.createFor("lightning", ["path"]) as LightningEffect).mode).toBe("outline");
    expect((LFX.createFor("lightning", ["shape", "path"]) as LightningEffect).mode).toBe("outline");
    expect((LFX.createFor("lightning", ["text"]) as LightningEffect).mode).toBe("bolt");
    expect((LFX.createFor("lightning", []) as LightningEffect).mode).toBe("bolt");
  });
});
