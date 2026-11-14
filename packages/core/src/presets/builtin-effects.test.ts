import { describe, expect, it } from "vitest";
import { LAYER_EFFECT_TYPES, createLayerEffect, layerEffectTypeDef } from "../animation/layer-effects";
import { layerEffectSchema } from "../schema/layer-effects";
import { BUILTIN_PRESETS } from "./builtin-effects";
import { activePreset, applyPresetPatch, effectPresetKind } from "./library";

/**
 * The preset library's contract, checked against the registry rather than
 * against a list. Every one of these caught something real while the v57
 * families were being written.
 */
describe("built-in effect presets", () => {
  const layerPresets = BUILTIN_PRESETS.filter((p) => p.kind.startsWith("effect:"));

  it("names an effect type that exists", () => {
    const known = new Set(LAYER_EFFECT_TYPES.map((d) => d.type));
    for (const p of layerPresets) {
      const type = p.kind.slice("effect:".length);
      // Audio cards register in their own domain and share the `effect:` kind.
      if (!known.has(type as never)) continue;
      expect(p.data).toBeTruthy();
    }
  });

  it("only sets fields the effect actually has", () => {
    for (const p of layerPresets) {
      const type = p.kind.slice("effect:".length);
      const def = layerEffectTypeDef(type as never);
      if (!def) continue;
      // The truth about what an effect HAS is its factory, not its `fields`
      // list — `fields` is UI metadata (what gets a row and a slider), and a
      // card whose value is edited by a bespoke body (the grade card's node
      // graph) legitimately carries state no row describes. Taking the union
      // keeps the original guarantee (a preset cannot invent a field) without
      // mistaking a rendering list for a schema.
      const shape = def.create() as Record<string, unknown>;
      const known = new Set<string>([
        ...Object.keys(shape).filter((k) => k !== "id" && k !== "type"),
        ...def.fields.map((f) => f.key),
        ...(def.toggles ?? []).map((t) => t.key),
      ]);
      for (const key of Object.keys(p.data as object)) {
        expect(known.has(key), `${p.name} (${type}) sets unknown field "${key}"`).toBe(true);
      }
    }
  });

  it("is a COMPLETE patch, so switching looks never inherits the last one", () => {
    for (const p of layerPresets) {
      const type = p.kind.slice("effect:".length);
      const def = layerEffectTypeDef(type as never);
      if (!def) continue;
      const data = p.data as Record<string, unknown>;
      for (const f of def.fields) {
        expect(f.key in data, `${p.name} (${type}) omits "${f.key}"`).toBe(true);
      }
    }
  });

  it("produces an effect the schema accepts", () => {
    for (const p of layerPresets) {
      const type = p.kind.slice("effect:".length);
      const def = layerEffectTypeDef(type as never);
      if (!def) continue;
      const applied = applyPresetPatch(createLayerEffect(type as never), p.data);
      const parsed = layerEffectSchema.safeParse(applied);
      expect(parsed.success, `${p.name} (${type}): ${parsed.success ? "" : parsed.error.message}`).toBe(true);
    }
  });

  it("is recognised as active right after it is applied", () => {
    for (const p of layerPresets) {
      const type = p.kind.slice("effect:".length);
      const def = layerEffectTypeDef(type as never);
      if (!def) continue;
      const applied = applyPresetPatch(createLayerEffect(type as never), p.data) as unknown as Record<string, unknown>;
      const mine = layerPresets.filter((q) => q.kind === p.kind);
      expect(activePreset(mine, applied)?.name, `${p.name} (${type})`).toBe(p.name);
    }
  });

  it("gives every layer effect at least one preset to start from", () => {
    const withPresets = new Set(layerPresets.map((p) => p.kind));
    // A look (`group`) starts from the looks themselves, not a card preset.
    const missing = LAYER_EFFECT_TYPES.filter((d) => d.type !== "group" && !withPresets.has(effectPresetKind(d.type))).map((d) => d.type);
    expect(missing).toEqual([]);
  });
});
