import { describe, expect, it } from "vitest";
import type { SurfaceEffect } from "../schema/layer-effects";
import { createLayerEffect } from "./layer-effects";
import { effectFieldVisible } from "./effect-base";
import { SURFACE_TILE_MAX, buildSurfaceLayers, resolveSurfaceParams, surfaceLayersKey, surfaceRecipe, surfaceTextureSide, surfaceTileScale, surfaceTileSize, textureSurfaceLayers } from "./surface";

/** A side×side picture: left half black, right half white — one hard edge to find. */
function halves(side: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(side * side * 4);
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      const o = (y * side + x) * 4;
      const v = x < side / 2 ? 0 : 255;
      px[o] = px[o + 1] = px[o + 2] = v;
      px[o + 3] = 255;
    }
  return px;
}

const card = (patch: Partial<SurfaceEffect> = {}): SurfaceEffect => ({ ...(createLayerEffect("surface") as SurfaceEffect), ...patch });

describe("a Surface card's own texture", () => {
  it("is the material's own pattern until a texture is picked", () => {
    const p = resolveSurfaceParams(card(), {}, 1, 0);
    expect(p.texture).toBeNull();
    expect(surfaceLayersKey(p)).not.toContain("tex:");
  });

  it("keys the sheet by its texture, so two pictures never share a tile", () => {
    const a = resolveSurfaceParams(card({ texture: "a" }), {}, 1, 0);
    const b = resolveSurfaceParams(card({ texture: "b" }), {}, 1, 0);
    expect(surfaceLayersKey(a)).not.toBe(surfaceLayersKey(b));
    expect(surfaceLayersKey(a)).not.toBe(surfaceLayersKey({ ...a, texture: null }));
  });

  it("reads light as height and dark as valley, zero-mean like every recipe", () => {
    const n = 64;
    const l = textureSurfaceLayers(halves(n), n, n, false, 0);
    let mean = 0;
    for (const v of l.height) mean += v;
    expect(Math.abs(mean / l.height.length)).toBeLessThan(0.02);
    // Middle of the dark half is low, of the bright half high.
    expect(l.height[32 * n + 8]!).toBeLessThan(0);
    expect(l.height[32 * n + 56]!).toBeGreaterThan(0);
    expect(l.albedo[32 * n + 8]!).toBeLessThan(l.albedo[32 * n + 56]!);
    expect(l.tint).toBeUndefined();
  });

  it("mirrors into four quarters, so any picture tiles without a seam", () => {
    const n = 64;
    const l = textureSurfaceLayers(halves(n / 2), n / 2, n, true, 0);
    for (const y of [3, 20, 40]) for (const x of [2, 10, 25]) expect(l.height[y * n + x]).toBeCloseTo(l.height[y * n + (n - 1 - x)]!, 5);
  });

  it("prints its colour only when asked, and not its tone twice", () => {
    const n = 16;
    const red = new Uint8ClampedArray(n * n * 4);
    for (let i = 0; i < n * n; i++) red.set([255, 0, 0, 255], i * 4);
    const l = textureSurfaceLayers(red, n, n, false, 1);
    expect(l.tint![0]).toBeCloseTo(0);
    expect(l.tint![1]).toBeCloseTo(-1);
    expect(l.albedo.every((v) => v === 0)).toBe(true);
  });

  it("keeps the material's behaviour while the picture replaces the pattern", () => {
    const p = resolveSurfaceParams(card({ material: "foil", texture: "t" }), {}, 0.25, 0);
    const side = surfaceTextureSide(p);
    expect(side).toBe(surfaceTileSize(p));
    const own = buildSurfaceLayers({ ...p, texture: null });
    const mine = buildSurfaceLayers(p, { rgba: halves(side), side });
    // Foil's diffraction grooves are its behaviour, not its pattern: kept.
    expect(own.layers.skin).toBeDefined();
    expect(mine.layers.skin).toBeDefined();
    // The pattern is the picture: the two halves stand at different heights.
    expect(mine.layers.height[8]!).toBeLessThan(mine.layers.height[side - 8]!);
  });

  it("shows its colour and tiling rows only once a texture is picked", () => {
    const row = { showIf: { key: "texture", equals: [""], not: true } };
    expect(effectFieldVisible(row, { texture: "" })).toBe(false);
    expect(effectFieldVisible(row, { texture: "asset" })).toBe(true);
  });
});

describe("a magnified sheet keeps its material (surfaceTileScale)", () => {
  it("builds the same proportions at a coarser texel instead of wrapping a clamped tile", () => {
    const base = surfaceRecipe("clay").tile;
    const atRest = buildSurfaceLayers({ material: "clay", unit: 1, seed: 3 });
    expect(atRest.scale).toBe(1);
    // A camera group at ×4.2: the tile would be 4.2× the side.
    const unit = (SURFACE_TILE_MAX / base) * 4.2;
    const zoomed = buildSurfaceLayers({ material: "clay", unit, seed: 3 });
    expect(surfaceTileScale({ material: "clay", unit })).toBeCloseTo(4.2, 6);
    expect(zoomed.scale).toBeCloseTo(4.2, 6);
    expect(zoomed.size).toBeLessThanOrEqual(SURFACE_TILE_MAX);
    // Texels × scale = the side the unit asks for: features keep their size in the picture.
    expect(zoomed.size * zoomed.scale).toBeCloseTo(base * unit, -1);
  });
});
