import { describe, expect, it } from "vitest";
import { createLayerEffect } from "./layer-effects";
import { buildSurfaceLayers, resolveSurfaceParams, shadeSurfaceTile } from "./surface";
import { twoInkSeparation } from "./two-ink";
import type { SurfaceEffect } from "../schema/layer-effects";

const PAPER: [number, number, number] = [0xf3, 0xec, 0xdb];
const BLUE: [number, number, number] = [0x00, 0x78, 0xbf];
const PINK: [number, number, number] = [0xff, 0x48, 0xb0];
const sep = (c: [number, number, number]) => twoInkSeparation(c, PAPER, BLUE, PINK);

describe("two-ink separation (riso)", () => {
  it("prints paper as paper and each ink as itself", () => {
    expect(sep(PAPER).map((v) => v + 0)).toEqual([0, 0]);
    const [a, b] = sep(BLUE);
    expect(a).toBeCloseTo(1, 2);
    expect(b).toBeCloseTo(0, 2);
    const [a2, b2] = sep(PINK);
    expect(a2).toBeCloseTo(0, 2);
    expect(b2).toBeCloseTo(1, 2);
  });

  it("sends warm colours to the pink drum and cool ones to the blue", () => {
    const [sunBlue, sunPink] = sep([0xff, 0xc8, 0x45]);
    expect(sunPink).toBeGreaterThan(sunBlue);
    const [skyBlue, skyPink] = sep([0xcf, 0xe7, 0xfa]);
    expect(skyBlue).toBeGreaterThan(skyPink);
    // Darker is more ink on both drums, never less.
    const light = sep([0x9a, 0xd0, 0x8f]);
    const dark = sep([0x3f, 0x94, 0x50]);
    expect(dark[0] + dark[1]).toBeGreaterThan(light[0] + light[1]);
  });
});

describe("surface bite", () => {
  it("is a rank: a breakup threshold loses that share of every material", () => {
    for (const material of ["paper", "blackCard", "linen"] as const) {
      const fx = { ...(createLayerEffect("surface") as SurfaceEffect), material, scale: 0.25 };
      const p = resolveSurfaceParams(fx, {}, 1, 0);
      const { bite } = shadeSurfaceTile(p, buildSurfaceLayers(p));
      let below = 0;
      for (const v of bite) if (v < 0.3) below++;
      // Black card's tooth is clipped flat over half its sheet; a rank still
      // splits it where asked instead of all at once.
      expect(below / bite.length, material).toBeCloseTo(0.3, 1);
    }
  });
});
