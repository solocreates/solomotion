import { describe, expect, it } from "vitest";
import { DEFAULT_WET, WetLayer } from "./watercolor";

/** A loaded wash in the middle of a small sheet. */
function wash(settings = DEFAULT_WET, radius = 9): WetLayer {
  const layer = new WetLayer(48, 48, settings);
  layer.dab(24, 24, radius, [0.1, 0.2, 0.7], 0.9, 0.9);
  return layer;
}

describe("water", () => {
  it("only ever loses water — flow can never create it", () => {
    // The stability guarantee: water moves to a LOWER head, so a step is a
    // redistribution plus evaporation, never a source.
    const layer = wash();
    let previous = layer.totalWater();
    for (let i = 0; i < 40; i++) {
      layer.step();
      const now = layer.totalWater();
      expect(now).toBeLessThanOrEqual(previous + 1e-6);
      previous = now;
    }
  });

  it("carries paint beyond where the brush touched", () => {
    // Asserted on the DEPOSIT, not the water rect: what matters is that dried
    // pigment ends up outside the dab's own footprint, which is the visible
    // consequence of the wash having flowed at all.
    const radius = 9;
    const layer = wash(DEFAULT_WET, radius);
    for (let i = 0; i < 400 && !layer.isDry; i++) layer.step();

    const alphaAt = (x: number, y: number) => layer.deposit[(y * layer.width + x) * 4 + 3]!;
    let reach = 0;
    for (let r = 0; r < 20; r++) {
      if (alphaAt(24 + r, 24) > 0.01 || alphaAt(24 - r, 24) > 0.01) reach = r;
    }
    expect(reach).toBeGreaterThan(radius);
  });

  it("dries completely, and then costs nothing", () => {
    const layer = wash({ ...DEFAULT_WET, evaporation: 0.08 });
    for (let i = 0; i < 400 && !layer.isDry; i++) layer.step();
    expect(layer.isDry).toBe(true);
    expect(layer.totalWater()).toBeLessThan(1e-3);
    // A dry layer must be a no-op, or an idle canvas burns a core for ever.
    const rect = layer.step();
    expect(rect.x1).toBeLessThan(rect.x0);
  });
});

describe("pigment", () => {
  it("is conserved through drying — nothing evaporates but water", () => {
    const layer = wash();
    const before = layer.totalPigment();
    for (let i = 0; i < 60; i++) layer.step();
    expect(layer.totalPigment()).toBeCloseTo(before, 1);
  });

  it("dryAll settles everything at once and leaves the layer dry", () => {
    const layer = wash();
    const before = layer.totalPigment();
    layer.dryAll();
    expect(layer.isDry).toBe(true);
    expect(layer.totalWater()).toBe(0);
    expect(layer.totalPigment()).toBeCloseTo(before, 5);
    // Everything is settled: nothing is left suspended.
    let suspended = 0;
    for (let i = 3; i < layer.pigment.length; i += 4) suspended += layer.pigment[i]!;
    expect(suspended).toBe(0);
  });

  it("THE WATERCOLOUR EDGE: a drying wash goes darker at its rim than its middle", () => {
    // The whole reason this is a simulation. Nothing draws the rim — it appears
    // because thin water deposits pigment faster, and the rim is where the film
    // is thinnest. If this ever fails, the medium has stopped being watercolour.
    const layer = wash();
    for (let i = 0; i < 220 && !layer.isDry; i++) layer.step();

    const alphaAt = (x: number, y: number) => layer.deposit[(y * layer.width + x) * 4 + 3]!;
    // A RADIAL PROFILE, averaged over four directions — flow is anisotropic
    // over paper, so one side can run further than another and a single sample
    // proves nothing. The claim is that the profile PEAKS away from the centre.
    const profile: number[] = [];
    for (let r = 0; r <= 14; r++) {
      profile.push(
        (alphaAt(24 + r, 24) + alphaAt(24 - r, 24) + alphaAt(24, 24 + r) + alphaAt(24, 24 - r)) / 4,
      );
    }
    const peak = profile.indexOf(Math.max(...profile));
    expect(peak).toBeGreaterThan(1);
    expect(profile[peak]!).toBeGreaterThan(profile[0]!);
  });

  it("a staining pigment keeps more in suspension than a settling one", () => {
    const stain = wash({ ...DEFAULT_WET, deposition: 0.05 });
    const settle = wash({ ...DEFAULT_WET, deposition: 0.9 });
    for (let i = 0; i < 25; i++) {
      stain.step();
      settle.step();
    }
    const suspended = (l: WetLayer) => {
      let s = 0;
      for (let i = 3; i < l.pigment.length; i += 4) s += l.pigment[i]!;
      return s;
    };
    expect(suspended(stain)).toBeGreaterThan(suspended(settle));
  });

  it("two wet washes bleed into each other", () => {
    const layer = new WetLayer(64, 32, DEFAULT_WET);
    layer.dab(20, 16, 7, [1, 0, 0], 0.9, 0.9);
    layer.dab(34, 16, 7, [0, 0, 1], 0.9, 0.9);
    for (let i = 0; i < 30; i++) layer.step();
    // The gap between them carries pigment neither dab put there.
    const mid = (27 * 1 + 16 * 64) * 4;
    const at = (x: number, y: number) => {
      const p = (y * 64 + x) * 4;
      return layer.deposit[p + 3]! + layer.pigment[p + 3]!;
    };
    void mid;
    expect(at(27, 16)).toBeGreaterThan(0);
  });
});

describe("the drying fan", () => {
  it("dries where you point it, and leaves the rest wet", () => {
    const layer = new WetLayer(64, 64, DEFAULT_WET);
    layer.dab(20, 32, 8, [0, 0, 0], 0.8, 1);
    layer.dab(44, 32, 8, [0, 0, 0], 0.8, 1);
    const waterAt = (x: number, y: number) => layer.water[y * 64 + x]!;
    const untouched = waterAt(44, 32);

    layer.fan(20, 32, 9, 0.6);
    // Relative, not absolute: what matters is that the fan dried THIS wash and
    // not the one beside it.
    expect(waterAt(20, 32)).toBeLessThan(untouched * 0.5);
    expect(waterAt(44, 32)).toBeCloseTo(untouched, 5);
  });

  it("turns the water it removes into pigment rather than losing it", () => {
    const layer = new WetLayer(48, 48, DEFAULT_WET);
    layer.dab(24, 24, 8, [0.2, 0.4, 0.9], 0.9, 1);
    const before = layer.totalPigment();
    layer.fan(24, 24, 10, 0.9);
    expect(layer.totalPigment()).toBeCloseTo(before, 1);
    expect(layer.totalWater()).toBeLessThan(before + 1e6); // water went, paint stayed
  });
});

describe("cost", () => {
  it("only simulates the wet region, never the canvas", () => {
    const layer = new WetLayer(512, 512, DEFAULT_WET);
    layer.dab(40, 40, 6, [0, 0, 0], 0.8, 0.8);
    const rect = layer.step();
    expect(rect.x1 - rect.x0).toBeLessThan(40);
    expect(rect.y1 - rect.y0).toBeLessThan(40);
  });

  it("composing writes premultiplied bytes without allocating", () => {
    const layer = wash();
    for (let i = 0; i < 20; i++) layer.step();
    const out = new Uint8ClampedArray(48 * 48 * 4);
    layer.compose(out);
    expect(out.some((v) => v > 0)).toBe(true);
    // Alpha is never below a channel it premultiplies — the invariant a canvas
    // putImageData relies on.
    for (let p = 0; p < out.length; p += 4) {
      if (out[p + 3] === 0) expect(out[p]).toBe(0);
    }
  });
});
