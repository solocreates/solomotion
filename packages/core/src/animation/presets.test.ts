import { describe, expect, it } from "vitest";
import {
  ANIMATION_CATEGORY_LABEL,
  ANIMATION_CATEGORY_ORDER,
  ANIMATION_PRESETS,
  GLYPH_IDENTITY,
  groupedAnimationPresets,
  specFromPreset,
} from "./presets";

/** Eased progress the renderer can actually hand an evaluator, ends included. */
const STEPS = Array.from({ length: 21 }, (_, i) => i / 20);

describe("the preset registry", () => {
  it("mints unique ids — a collision silently shadows a preset", () => {
    const ids = ANIMATION_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("files every preset under a category the rail can draw", () => {
    for (const p of ANIMATION_PRESETS) {
      expect(ANIMATION_CATEGORY_ORDER).toContain(p.category);
      expect(ANIMATION_CATEGORY_LABEL[p.category]).toBeTruthy();
    }
  });

  it("loses nothing between the flat list and the shelves", () => {
    const grouped = groupedAnimationPresets(ANIMATION_PRESETS);
    const flat = grouped.flatMap((g) => g.presets.map((p) => p.id));
    expect(flat.sort()).toEqual(ANIMATION_PRESETS.map((p) => p.id).sort());
  });

  it("shelves in browse order, quietest first", () => {
    const order = groupedAnimationPresets(ANIMATION_PRESETS).map((g) => g.category);
    expect(order).toEqual(ANIMATION_CATEGORY_ORDER.filter((c) => order.includes(c)));
  });

  it("searches names, taglines and family alike", () => {
    const byName = groupedAnimationPresets(ANIMATION_PRESETS, "glitch");
    expect(byName.flatMap((g) => g.presets.map((p) => p.id))).toContain("glitch");
    // A family name is a search term too: "spins" has to find the spins.
    const byFamily = groupedAnimationPresets(ANIMATION_PRESETS, "spins");
    expect(byFamily.every((g) => g.category === "spin")).toBe(true);
    expect(byFamily[0]!.presets.length).toBeGreaterThan(1);
  });

  it("evaluates to finite poses across the whole span, in and out", () => {
    // The one test that earns its place: thirty-five hand-written curves, and a
    // single NaN or Infinity anywhere in one makes a layer vanish mid-animation
    // with nothing in the console to say which.
    for (const def of ANIMATION_PRESETS) {
      const params = Object.fromEntries(def.params.map((k) => [k.key, k.defaultValue]));
      for (const t of STEPS) {
        for (const [phase, evaluate] of [
          ["in", def.evalIn],
          ["out", def.evalOut ?? def.evalIn],
        ] as const) {
          const pose = evaluate(t, params);
          for (const key of Object.keys(GLYPH_IDENTITY) as (keyof typeof GLYPH_IDENTITY)[]) {
            const value = pose[key];
            expect(Number.isFinite(value), `${def.id} ${phase} @${t} ${key}=${value}`).toBe(true);
          }
          expect(pose.opacity, `${def.id} ${phase} @${t}`).toBeGreaterThanOrEqual(0);
          expect(pose.opacity, `${def.id} ${phase} @${t}`).toBeLessThanOrEqual(1);
          expect(pose.blur, `${def.id} ${phase} @${t}`).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("lands on the identity pose when an entrance completes", () => {
    // t=1 is the layer at rest. A preset that ends anywhere else leaves the
    // artwork permanently offset from where the inspector says it is — the
    // defect nobody attributes to the animation.
    for (const def of ANIMATION_PRESETS) {
      const params = Object.fromEntries(def.params.map((k) => [k.key, k.defaultValue]));
      const end = def.evalIn(1, params);
      expect(end.opacity, def.id).toBeCloseTo(1, 2);
      expect(end.dx, def.id).toBeCloseTo(0, 2);
      expect(end.dy, def.id).toBeCloseTo(0, 2);
      expect(end.scale, def.id).toBeCloseTo(1, 2);
      expect(end.rotation, def.id).toBeCloseTo(0, 2);
      expect(end.blur, def.id).toBeCloseTo(0, 2);
    }
  });

  it("builds a usable spec for every preset, with every knob defaulted", () => {
    for (const def of ANIMATION_PRESETS) {
      const spec = specFromPreset(def.id);
      expect(spec.preset).toBe(def.id);
      expect(spec.durationMs).toBeGreaterThan(0);
      for (const knob of def.params) expect(spec.params[knob.key]).toBe(knob.defaultValue);
    }
  });

  it("declares knob ranges that contain their own default", () => {
    for (const def of ANIMATION_PRESETS) {
      for (const k of def.params) {
        expect(k.defaultValue, `${def.id}.${k.key}`).toBeGreaterThanOrEqual(k.min);
        expect(k.defaultValue, `${def.id}.${k.key}`).toBeLessThanOrEqual(k.max);
        expect(k.step, `${def.id}.${k.key}`).toBeGreaterThan(0);
      }
    }
  });
});
