import { describe, expect, it } from "vitest";
import type { SurfaceEffect } from "../schema/layer-effects";
import { layerEffectSchema } from "../schema/layer-effects";
import { createLayerEffect } from "./layer-effects";
import {
  SURFACE_RECIPES,
  buildSurfaceLayers,
  cutSurface,
  resolveSurfaceParams,
  shadeSurfaceTile,
  surfaceFrontField,
  surfaceFrontMask,
  surfaceMorphEnds,
  surfaceReadsPicture,
} from "./surface";
import { distanceToSeeds, shapeStageActive } from "./surface-body";
import { sampleKeyframes } from "./keyframes";
import { createDocumentStore } from "../history/document-store";
import { createEmptyDocument } from "../factories";
import { createCommandApi, type CommandContext } from "../api";
import { frameEffectClip } from "../timeline/frame-effects";

const surface = (over: Partial<SurfaceEffect> = {}): SurfaceEffect => ({ ...(createLayerEffect("surface") as SurfaceEffect), ...over });

/** A flat illustration: an orange disc and a blue bar on a cream ground. */
function picture(w: number, h: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const disc = Math.hypot(x - w * 0.4, y - h * 0.5) < w * 0.22;
      const bar = x > w * 0.7 && x < w * 0.8 && y > h * 0.2 && y < h * 0.8;
      px.set(disc ? [242, 106, 46, 255] : bar ? [38, 92, 160, 255] : [241, 233, 218, 255], (y * w + x) * 4);
    }
  }
  return px;
}

function render(fx: SurfaceEffect, w = 72, h = 72): Uint8ClampedArray {
  const p = resolveSurfaceParams(fx, {}, 1, 0);
  const px = picture(w, h);
  if (surfaceReadsPicture(p)) cutSurface(px, w, h, p, shadeSurfaceTile(p, buildSurfaceLayers(p)));
  return px;
}

/**
 * The material engine's contract: one shape stage for every material, exact
 * distances, a body that responds to the shape, a morph that is a pure
 * function of `morph`, and cards saved before it keep their look.
 */
describe("the shape stage", () => {
  it("measures exact Euclidean distance to the nearest seed", () => {
    const w = 9;
    const h = 7;
    const seed = new Uint8Array(w * h);
    seed[3 * w + 4] = 1;
    const d = distanceToSeeds(seed, w, h);
    expect(d[3 * w + 4]).toBe(0);
    expect(d[3 * w + 7]).toBeCloseTo(3);
    expect(d[0]).toBeCloseTo(Math.hypot(4, 3));
  });

  it("renders every material on a flat picture: finite, deterministic, and visibly itself", () => {
    const flat = picture(72, 72);
    for (const r of SURFACE_RECIPES) {
      const fx = surface({ material: r.id, lift: 6, edge: 0.5, scale: 0.5 });
      const a = render(fx);
      expect(a.every((v) => Number.isFinite(v)), r.id).toBe(true);
      expect(render(fx), r.id).toEqual(a);
      let moved = 0;
      for (let i = 0; i < a.length; i++) moved += Math.abs(a[i]! - flat[i]!);
      expect(moved, r.id).toBeGreaterThan(0);
    }
  });

  it("rounds a lifted piece by its thickness, and presses it in below 0", () => {
    // Across the disc's left edge: a raised felt piece and a pressed one are
    // lit on opposite walls, so they cannot be the same row of pixels.
    const row = (px: Uint8ClampedArray) => Array.from({ length: 12 }, (_, k) => px[(36 * 72 + 8 + k) * 4 + 1]!);
    const up = render(surface({ material: "felt", lift: 6 }));
    const down = render(surface({ material: "felt", lift: -6 }));
    const flat = render(surface({ material: "felt", lift: 6, body: 0 }));
    expect(row(up)).not.toEqual(row(down));
    expect(row(up)).not.toEqual(row(flat));
  });

  it("leaves a card saved before the engine flat: its dials are absent, so 0", () => {
    const old = layerEffectSchema.parse({ id: "x", type: "surface", material: "felt", lift: 6 }) as SurfaceEffect;
    const p = resolveSurfaceParams(old, {}, 1, 0);
    expect([p.body, p.sheen, p.glow, p.flow]).toEqual([0, 0, 0, 0]);
    expect(shapeStageActive(SURFACE_RECIPES.find((r) => r.id === "felt")!, p)).toBe(false);
  });
});

describe("the morph", () => {
  it("is between the two materials only while the front is moving", () => {
    const at = (morph: number) => surfaceMorphEnds(resolveSurfaceParams(surface({ material: "felt", to: "foil", morph }), {}, 1, 0));
    expect(at(0).a.material).toBe("felt");
    expect(at(0).b).toBeNull();
    expect([at(0.5).a.material, at(0.5).b?.material]).toEqual(["felt", "foil"]);
    expect(at(1).a.material).toBe("foil");
    expect(at(1).b).toBeNull();
    // The other material is dyed the same and takes its own sheet tone.
    expect(at(0.5).b!.tone).not.toEqual(at(0.5).a.tone);
  });

  it("only ever advances: a sample the front has reached stays reached", () => {
    for (const morphStyle of ["spread", "sweep", "fade"] as const) {
      const p = resolveSurfaceParams(surface({ material: "paper", to: "chrome", morphStyle }), {}, 1, 0);
      const field = surfaceFrontField(p, 120, 80, 30, 20);
      let prev = surfaceFrontMask(field, 0);
      expect(Math.max(...prev), morphStyle).toBe(0);
      for (let m = 0.1; m <= 1.0001; m += 0.1) {
        const next = surfaceFrontMask(field, m);
        for (let i = 0; i < next.length; i++) expect(next[i]!, morphStyle).toBeGreaterThanOrEqual(prev[i]!);
        prev = next;
      }
      expect(Math.min(...prev), morphStyle).toBe(255);
    }
  });
});

describe("effects.morph", () => {
  it("keys a chain so each instant shows the right material, and the switch between links is invisible", async () => {
    const store = createDocumentStore(createEmptyDocument("Test"));
    const api = createCommandApi();
    const ctx: CommandContext = {
      store,
      actor: "AI",
      historyKey: "turn-1",
      historyLabel: "Morph",
      session: { focusFrameId: () => store.getState().frames[0]?.id ?? null, playheadMs: () => 0, selection: () => [] },
    };
    const frame = store.getState().frames[0]!;
    await api.call("effects.look", { id: frame.id, look: "felt" }, ctx);
    const res = await api.call(
      "effects.morph",
      { id: frame.id, stops: [{ material: "paper", atMs: 0 }, { material: "felt", atMs: 1000 }, { material: "foil", atMs: 2000 }], overMs: 500 },
      ctx,
    );
    expect(res.ok).toBe(true);
    const clip = frameEffectClip(store.getState(), frame.id)!;
    // The look's card was used, not a second one added (the look arrives as a group).
    expect(clip.effects.map((e) => e.type)).toEqual(["group", "surface"]);
    const fx = clip.effects[1] as SurfaceEffect;
    const showing = (t: number) => {
      const p = resolveSurfaceParams(fx, sampleKeyframes(clip.keyframes, t), 1, t / 1000);
      const ends = surfaceMorphEnds(p);
      return ends.b ? `${ends.a.material}>${ends.b.material}` : ends.a.material;
    };
    expect(showing(0)).toBe("paper");
    expect(showing(400)).toBe("paper");
    expect(showing(750)).toBe("paper>felt");
    expect(showing(999.5)).toBe("felt");
    expect(showing(1000)).toBe("felt");
    expect(showing(1200)).toBe("felt");
    expect(showing(1750)).toBe("felt>foil");
    expect(showing(2000)).toBe("foil");
    expect(showing(5000)).toBe("foil");

    const bad = await api.call("effects.morph", { id: frame.id, stops: [{ material: "felt", atMs: 500 }, { material: "foil", atMs: 100 }] }, ctx);
    expect(bad.ok).toBe(false);
  });
});
