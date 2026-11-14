import { describe, expect, it } from "vitest";
import { LAYER_EFFECT_TYPES, createLayerEffect, layerEffectMoves, layerEffectReadsBackdrop } from "./layer-effects";
import { MAX_SLOPE, glassBezel, glassDisplacementPx, glassIsNoop, glassMoves, glassRefract, resolveGlassParams } from "./glass";
import type { GlassEffect } from "../schema/layer-effects";

const glass = (over: Partial<GlassEffect> = {}): GlassEffect =>
  ({ ...(createLayerEffect("glass") as GlassEffect), ...over });

describe("resolveGlassParams", () => {
  it("scales px fields by the render scale and leaves ratios alone", () => {
    const p = resolveGlassParams(glass({ depth: 20, frost: 10, refraction: 0.5, inset: -4 }), {}, 2, 0);
    expect(p.depth).toBe(40);
    expect(p.frost).toBe(20);
    expect(p.refraction).toBe(0.5);
    expect(p.insetPx).toBe(-8);
    expect(p.outsetPx).toBe(8);
    // The field only has to be resolved as far as the bezel (plus the grow and
    // the corner soften) reaches — that is what keeps a huge pane cheap.
    expect(p.reach).toBeGreaterThanOrEqual(40 + 8);
    expect(p.reach).toBeLessThan(40 + 8 + 32 * 2 + 3);
  });

  it("lets keyframes beat base values", () => {
    const fx = glass({ ior: 1.2 });
    const p = resolveGlassParams(fx, { [`lfx.${fx.id}.ior`]: 2 }, 1, 0);
    expect(p.ior).toBe(2);
  });

  it("builds a unit light direction, y down", () => {
    const p = resolveGlassParams(glass({ lightAngle: -90 }), {}, 1, 0);
    expect(Math.hypot(...p.light)).toBeCloseTo(1, 6);
    expect(p.light[1]).toBeCloseTo(-1, 6); // −90° = from above (screen y grows down)
  });

  it("advances the ripple phase from local time × speed", () => {
    const at = (t: number) => resolveGlassParams(glass({ ripplePhase: 0, rippleSpeed: 1 }), {}, 1, t).phase;
    expect(at(0)).toBe(0);
    expect(at(1)).toBeCloseTo(Math.PI * 2, 6); // one cycle per second
    // Deterministic: the same time always yields the same wave (export == preview).
    expect(at(0.37)).toBe(at(0.37));
  });

  it("only moves while its ripple is driven — a still pane runs no clock", () => {
    expect(glassMoves(glass())).toBe(false);
    expect(glassMoves(glass({ ripple: 0.3 }))).toBe(false);
    expect(glassMoves(glass({ ripple: 0.3, rippleSpeed: 0.5 }))).toBe(true);
    expect(layerEffectMoves(glass())).toBe(false);
    expect(layerEffectMoves(glass({ ripple: 1, rippleSpeed: 1 }))).toBe(true);
  });

  it("treats a zero mix as a no-op the renderer can skip", () => {
    expect(glassIsNoop(resolveGlassParams(glass({ mix: 0 }), {}, 1, 0))).toBe(true);
    expect(glassIsNoop(resolveGlassParams(glass(), {}, 1, 0))).toBe(false);
  });

  it("resolves colours through the caller's variable resolver", () => {
    const p = resolveGlassParams(glass({ tintColor: "var:abc" }), {}, 1, 0, (c) => (c === "var:abc" ? "#ff0000" : c));
    expect(p.tintColor).toBe("#ff0000");
  });

  it("falls back to the squircle for an unknown profile", () => {
    expect(resolveGlassParams(glass({ profile: "nope" as GlassEffect["profile"] }), {}, 1, 0).profile).toBe("squircle");
  });
});

/**
 * The bezel is the whole material: its slope is what bends the light. These
 * pin the shape the shader and the CPU fallback both implement.
 */
describe("glassBezel", () => {
  it("convex profiles are flat on top and vertical at the edge", () => {
    for (const profile of ["squircle", "circle"] as const) {
      expect(glassBezel(1, profile).slope).toBeCloseTo(0, 6);
      expect(glassBezel(1, profile).height).toBeCloseTo(1, 6);
      expect(glassBezel(0, profile).slope).toBe(MAX_SLOPE);
      expect(glassBezel(0, profile).height).toBeCloseTo(0, 6);
    }
  });

  it("the squircle stays flatter than the circle across the bezel — the smoother stretch", () => {
    for (const t of [0.3, 0.5, 0.7, 0.9]) {
      expect(glassBezel(t, "squircle").slope).toBeLessThan(glassBezel(t, "circle").slope);
    }
  });

  it("a dish is the convex profile turned over", () => {
    const c = glassBezel(0.4, "squircle");
    const d = glassBezel(0.4, "concave");
    expect(d.height).toBeCloseTo(1 - c.height, 6);
    expect(d.slope).toBeCloseTo(-c.slope, 6);
  });

  it("displacement grows toward the edge and vanishes past the bezel", () => {
    const p = { depth: 40, refraction: 0.8, ior: 1.5, profile: "squircle" as const };
    const edge = glassDisplacementPx(0.5, p);
    const mid = glassDisplacementPx(20, p);
    expect(edge).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(0);
    expect(glassDisplacementPx(40, p)).toBe(0);
    expect(glassDisplacementPx(90, p)).toBe(0);
    // Snell caps the bend at the critical angle: never more than the slab.
    expect(edge).toBeLessThanOrEqual(p.refraction * p.depth);
    // No refraction, no bend.
    expect(glassDisplacementPx(0.5, { ...p, refraction: 0 })).toBe(0);
  });

  it("refracts by Snell — a higher index bends less far", () => {
    expect(glassRefract(1, 1.2)).toBeGreaterThan(glassRefract(1, 2.0));
    expect(glassRefract(-1, 1.5)).toBeCloseTo(-glassRefract(1, 1.5), 9);
    expect(glassRefract(0, 1.5)).toBe(0);
  });
});

/**
 * The backdrop contract. The renderer answers "does this layer need the scene
 * behind it rendered?" in two files at two moments (the layer-tree walk builds
 * the painter; the effect stack allocates the buffer). Both must resolve to the
 * declaration these tests pin, or a material refracts an empty canvas — which
 * is precisely how liquid glass shipped flat in every export.
 */
describe("layerEffectReadsBackdrop", () => {
  it("is declared by the material, not inferred by the renderer", () => {
    expect(layerEffectReadsBackdrop(glass())).toBe(true);
    expect(layerEffectReadsBackdrop(createLayerEffect("blur"))).toBe(false);
    expect(layerEffectReadsBackdrop(createLayerEffect("colorGrade"))).toBe(false);
  });

  it("lets an instance opt out through edgeOnly — a rim reads nothing behind it", () => {
    expect(layerEffectReadsBackdrop(glass({ edgeOnly: true }))).toBe(false);
  });

  it("only backdrop-reading cards carry the flag", () => {
    const declared = LAYER_EFFECT_TYPES.filter((d) => d.readsBackdrop).map((d) => d.type);
    // Adding a second material? Add it here AND check both renderer sites
    // (`readsBackdrop` in draw-frame, `passNeedsBackdrop` in effect-passes)
    // resolve it — that pair drifting is the bug this list exists to catch.
    expect(declared).toEqual(["glass", "lens", "shockwave"]);
  });
});
