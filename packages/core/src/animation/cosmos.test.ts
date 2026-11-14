import { describe, expect, it } from "vitest";
import { LFX, createLayerEffect, layerEffectMoves, layerEffectPictureAt } from "./layer-effects";
import { layerEffectOutsetPx } from "./layer-region";
import { layerEffectSchema } from "../schema/layer-effects";

describe("space effects", () => {
  it("every card's factory is what the schema says", () => {
    // The factory and the schema's defaults are one look, not two.
    for (const t of ["lens", "star", "starfield", "nebula"] as const) expect(strip(createLayerEffect(t))).toEqual(strip(layerEffectSchema.parse({ id: "x", type: t })));
  });

  it("a starfield twinkles in steps: one picture per step, so caches keep each", () => {
    const sf = createLayerEffect("starfield");
    expect(layerEffectMoves(sf)).toBe(true);
    expect(layerEffectPictureAt(sf, 1.0)).toBe(layerEffectPictureAt(sf, 1.08));
    expect(layerEffectPictureAt(sf, 1.0)).not.toBe(layerEffectPictureAt(sf, 1.09));
    expect(layerEffectMoves({ ...sf, twinkle: 0 } as typeof sf)).toBe(false);
  });

  it("a nebula is still until asked to move; a star boils", () => {
    expect(layerEffectMoves(createLayerEffect("nebula"))).toBe(false);
    expect(layerEffectMoves(createLayerEffect("star"))).toBe(true);
    expect(LFX.def("lens")?.readsBackdrop).toBe(true);
  });

  it("reserves room for the bend and the corona", () => {
    const lens = createLayerEffect("lens");
    expect(layerEffectOutsetPx({ effects: [lens] }, {}, 20)).toBeGreaterThanOrEqual(230 * 4);
    expect(layerEffectOutsetPx({ effects: [createLayerEffect("star")] }, {}, 600)).toBeGreaterThan(300 * 0.9);
    expect(layerEffectOutsetPx({ effects: [createLayerEffect("nebula")] }, {}, 600)).toBe(0);
  });
});

function strip(e: object): object {
  const { id: _i, type: _t, ...rest } = e as Record<string, unknown>;
  return rest;
}
