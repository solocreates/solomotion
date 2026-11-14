import { describe, expect, it } from "vitest";
import { createDocumentStore } from "../history/document-store";
import { createEmptyDocument } from "../factories";
import { createCommandApi, type CommandContext } from "../api";
import { layerEffectSchema, type SurfaceEffect } from "../schema/layer-effects";
import { frameEvalTimeMs } from "../timeline/fps";
import { frameEffectClip } from "../timeline/frame-effects";
import { LAYER_EFFECT_TYPES, createLayerEffect, layerEffectPictureAt } from "./layer-effects";
import { TEXTURE_LOOKS } from "../presets/builtin-effects";
import { findLook, lookCards, lookShortId } from "../presets/looks";
import {
  SURFACE_RECIPES,
  buildSurfaceLayers,
  cutSurface,
  detectSurfaceGround,
  resolveSurfaceParams,
  shadeSurfaceTile,
  surfaceLightMask,
  surfaceTileSize,
} from "./surface";

const surface = (over: Partial<SurfaceEffect> = {}): SurfaceEffect => ({ ...(createLayerEffect("surface") as SurfaceEffect), ...over });

/**
 * The Surface card's contract: a material is a pure function of its seed and
 * its step, so preview, scrub, export and re-export are the same sheet — and a
 * re-rolling sheet changes on the beat and only on the beat.
 */
describe("surface", () => {
  it("builds the same sheet from the same seed, and another from another", () => {
    const p = resolveSurfaceParams(surface({ material: "linen", scale: 0.25 }), {}, 1, 0);
    const a = shadeSurfaceTile(p, buildSurfaceLayers(p));
    const b = shadeSurfaceTile(p, buildSurfaceLayers(p));
    expect(a.dark).toEqual(b.dark);
    expect(a.light).toEqual(b.light);
    const q = resolveSurfaceParams(surface({ material: "linen", scale: 0.25, seed: 2 }), {}, 1, 0);
    expect(shadeSurfaceTile(q, buildSurfaceLayers(q)).dark).not.toEqual(a.dark);
  });

  it("holds still unless it animates, and re-rolls only on its beat", () => {
    const still = surface();
    expect(resolveSurfaceParams(still, {}, 1, 0)).toEqual(resolveSurfaceParams(still, {}, 1, 3.7));
    expect(layerEffectPictureAt(still, 0)).toBe(layerEffectPictureAt(still, 3.7));

    const moving = surface({ animate: true, rate: 12 });
    // 0.10 s and 0.15 s share the second beat at 12 Hz; 0.20 s is the third.
    const a = resolveSurfaceParams(moving, {}, 1, 0.1);
    const b = resolveSurfaceParams(moving, {}, 1, 0.15);
    const c = resolveSurfaceParams(moving, {}, 1, 0.2);
    expect(b).toEqual(a);
    expect([c.offsetX, c.offsetY]).not.toEqual([a.offsetX, a.offsetY]);
    expect(layerEffectPictureAt(moving, 0.1)).toBe(layerEffectPictureAt(moving, 0.15));
    expect(layerEffectPictureAt(moving, 0.1)).not.toBe(layerEffectPictureAt(moving, 0.2));
    // The authored sheet is step 0: switching Animate on never moves it there.
    expect(resolveSurfaceParams(moving, {}, 1, 0).offsetX).toBe(0);
  });

  it("has a recipe for every material the schema offers, each with a sane tile", () => {
    const def = LAYER_EFFECT_TYPES.find((d) => d.type === "surface")!;
    const offered = def.fields.find((f) => f.key === "material")!.options!.map((o) => o.value);
    expect(SURFACE_RECIPES.map((r) => r.id).sort()).toEqual([...offered].sort());
    for (const r of SURFACE_RECIPES) {
      const n = surfaceTileSize({ material: r.id, unit: 1 });
      expect(n, r.id).toBeGreaterThanOrEqual(64);
      expect(n, r.id).toBeLessThanOrEqual(1024);
    }
  });

  it("finds a flat illustration's ground, and refuses a picture that has none", () => {
    const w = 64;
    const h = 64;
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const x = i % w;
      const inShape = x > 20 && x < 40;
      px.set(inShape ? [220, 80, 70, 255] : [160, 210, 230, 255], i * 4);
    }
    const g = detectSurfaceGround(px, w, h)!;
    expect(g.map(Math.round)).toEqual([160, 210, 230]);
    // A layer (transparent around its shape) has alpha for shapes, not a ground.
    const layer = px.slice();
    for (let i = 0; i < w * h; i++) if (i % w <= 20 || i % w >= 40) layer[i * 4 + 3] = 0;
    expect(detectSurfaceGround(layer, w, h)).toBeNull();
    // Noise has no colour covering a quarter of it.
    const noise = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) noise.set([(i * 37) % 256, (i * 91) % 256, (i * 53) % 256, 255], i * 4);
    expect(detectSurfaceGround(noise, w, h)).toBeNull();
  });

  it("lifts a layer's shape: its shadow falls past its edge, away from the light", () => {
    const w = 80;
    const h = 80;
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 20; y < 60; y++) for (let x = 20; x < 60; x++) px.set([255, 255, 255, 255], (y * w + x) * 4);
    // Light from the top-left: the shadow lands bottom-right.
    const p = resolveSurfaceParams(surface({ lift: 6, shadow: 1, lightAngle: -135, scale: 0.25 }), {}, 1, 0);
    cutSurface(px, w, h, p, shadeSurfaceTile(p, buildSurfaceLayers(p)));
    const alphaAt = (x: number, y: number) => px[(y * w + x) * 4 + 3]!;
    expect(alphaAt(62, 62)).toBeGreaterThan(20);
    expect(alphaAt(17, 17)).toBe(0);
  });

  it("spares coloured light and leaves chalk, ground and empty pixels to the card", () => {
    const px = new Uint8ClampedArray([
      255, 90, 46, 255, // ember: a light
      237, 233, 226, 255, // chalk: the card takes it
      11, 13, 16, 255, // the night ground
      255, 90, 46, 128, // a light half there counts half
      90, 32, 20, 255, // an ember halo fading on the dark: still light
      0, 0, 0, 0, // nothing
    ]);
    const m = surfaceLightMask(px, 6, 1, 1);
    expect(m[0]).toBe(255);
    expect(m[1]).toBe(0);
    expect(m[2]).toBe(0);
    expect(m[3]).toBeGreaterThan(120);
    expect(m[3]).toBeLessThan(135);
    expect(m[4]).toBeGreaterThan(100);
    expect(m[5]).toBe(0);
    expect([...surfaceLightMask(px, 6, 1, 0)].every((v) => v === 0)).toBe(true);
    // A card made before the dial existed spares nothing.
    expect(resolveSurfaceParams(surface(), {}, 1, 0).lights).toBe(0);
  });

  it("asks the light layers by default: colour cannot see a white-hot core and takes any coloured shape for a light", () => {
    const px = new Uint8ClampedArray([
      255, 255, 255, 255, // an ember's white-hot core
      255, 90, 46, 255, // an orange label that gives off no light
    ]);
    const guess = surfaceLightMask(px, 2, 1, 1);
    expect(guess[0]).toBe(0);
    expect(guess[1]).toBe(255);
    expect(resolveSurfaceParams(surface(), { lights: 1 }, 1, 0).lightsFrom).toBe("layers");
    expect(resolveSurfaceParams(surface({ lightsFrom: "colour" }), { lights: 1 }, 1, 0).lightsFrom).toBe("colour");
  });
});

describe("texture looks", () => {
  it("are the contracted looks, by these ids, in this order", () => {
    expect(TEXTURE_LOOKS.map((l) => [lookShortId(l), l.name])).toEqual([
      ["paper-cut-out", "Paper cut-out"],
      ["stop-motion", "Stop motion"],
      ["chalk-on-card", "Chalk on card"],
      ["riso-print", "Riso print"],
      ["cross-stitch", "Cross-stitch"],
      ["led-board", "LED board"],
      ["felt", "Felt"],
      ["cardboard", "Cardboard"],
      ["crumpled-paper", "Crumpled paper"],
      ["claymation", "Claymation"],
      ["blueprint", "Blueprint"],
      ["engraving", "Engraving"],
      ["watercolor", "Watercolour"],
      ["holo-foil", "Holographic foil"],
      ["liquid-chrome", "Liquid chrome"],
      ["neon-glass", "Neon glass"],
      ["stained-glass", "Stained glass"],
      ["frosted-glass", "Frosted glass"],
      ["crystal", "Crystal"],
      ["soap-film", "Soap film"],
      ["ferrofluid", "Ferrofluid"],
      ["kintsugi", "Kintsugi"],
      ["tufted-rug", "Tufted rug"],
      ["crt-phosphor", "CRT phosphor"],
      ["ink-bleed", "Ink on rice paper"],
      ["marbling", "Marbling"],
      ["letterpress", "Letterpress"],
      ["embossed-paper", "Embossed paper"],
      ["cyanotype", "Cyanotype"],
      ["newspaper", "Newspaper"],
      ["woodblock", "Woodblock"],
      ["graph-paper", "Graph paper"],
      ["photocopy", "Photocopy"],
      ["vhs", "VHS"],
      ["game-boy", "Game Boy"],
    ]);
  });

  it("resolve to cards the renderer knows and the schema accepts", () => {
    for (const look of TEXTURE_LOOKS) {
      const found = findLook(lookShortId(look));
      expect("look" in found, look.name).toBe(true);
      if (!("look" in found)) continue;
      const cards = lookCards(found.look);
      expect(cards.length, look.name).toBe((look.data as unknown[]).length);
      for (const card of cards) expect(layerEffectSchema.safeParse(card).success, `${look.name}: ${card.type}`).toBe(true);
    }
    // Only Stop motion owns time.
    expect(TEXTURE_LOOKS.filter((l) => l.fps).map((l) => [lookShortId(l), l.fps])).toEqual([["stop-motion", 12], ["claymation", 12]]);
    // By name too, case-insensitively.
    expect("look" in findLook("paper CUT-out")).toBe(true);
  });
});

describe("posterize time and looks through the API", () => {
  function harness() {
    const store = createDocumentStore(createEmptyDocument("Test"));
    const api = createCommandApi();
    const ctx: CommandContext = {
      store,
      actor: "AI",
      historyKey: "turn-1",
      historyLabel: "Texture",
      session: { focusFrameId: () => store.getState().frames[0]?.id ?? null, playheadMs: () => 0, selection: () => [] },
    };
    const call = async (id: string, input: unknown = {}) => {
      const res = await api.call(id, input, ctx);
      if (!res.ok) throw new Error(`${id}: ${res.error}`);
      return res.value as Record<string, unknown>;
    };
    return { store, call };
  }

  it("applies Stop motion to a whole comp in one step, and holds the comp on twelves", async () => {
    const { store, call } = harness();
    const frame = store.getState().frames[0]!;
    const before = store.getState();
    const res = await call("effects.look", { id: frame.id, look: "stop-motion" });
    expect(res.fps).toBe(12);
    const doc = store.getState();
    const fx = frameEffectClip(doc, frame.id)!;
    expect(fx.id).toBe(res.id);
    // One group card holding the look's cards (D13 — a look is a group).
    expect(fx.effects.map((e) => e.type)).toEqual(["group", "surface", "filmDamage"]);
    expect(fx.effects.slice(1).every((e) => e.group === res.groupId)).toBe(true);
    expect(fx.fps).toBe(12);
    // The comp still runs at its own rate; its picture holds for 1/12 s.
    expect(frameEvalTimeMs(doc, frame, 100)).toBeCloseTo(1000 / 12, 3);
    expect(frameEvalTimeMs(before, frame, 100)).toBeCloseTo(100, 0);

    // Another look INTO the group swaps what it wears — same card, same place.
    await call("effects.look", { id: frame.id, look: "Felt", into: res.groupId });
    const after = frameEffectClip(store.getState(), frame.id)!;
    expect(after.id).toBe(fx.id);
    expect(after.effects.map((e) => e.type)).toEqual(["group", "surface"]);
    expect(after.effects[0]!.id).toBe(res.groupId);
    // …and `replace` is the old whole-stack swap, bare cards.
    await call("effects.look", { id: frame.id, look: "Felt", replace: true });
    expect(frameEffectClip(store.getState(), frame.id)!.effects.map((e) => e.type)).toEqual(["surface"]);
  });

  it("lists looks in the catalogue with what they are made of", async () => {
    const { call } = harness();
    const rows = (await call("catalog.list", { catalog: "looks", query: "texture" })) as unknown as Array<{ id: string; cards: string[] }>;
    expect(rows.find((r) => r.id === "led-board")?.cards).toEqual(["pixelate", "glow"]);
    const one = await call("catalog.get", { catalog: "looks", id: "riso-print" });
    expect(Array.isArray(one.stack)).toBe(true);
    await expect(call("effects.look", { id: "nope", look: "felt" })).rejects.toThrow();
    await expect(call("effects.look", { id: "x", look: "no-such-look" })).rejects.toThrow(/No look/);
  });
});
