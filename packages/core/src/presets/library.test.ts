import { describe, expect, it } from "vitest";
import {
  activePreset,
  applyPresetPatch,
  collectPresets,
  effectPresetKind,
  groupPresets,
  makePreset,
  presetPatchFrom,
  removePreset,
  renamePreset,
  upsertPreset,
} from "./library";
import { BUILTIN_PRESETS, builtinPresetSource } from "./builtin-effects";
import { createLayerEffect } from "../animation/layer-effects";
import type { Preset } from "./library";
import type { GlassEffect } from "../schema/layer-effects";

describe("preset library", () => {
  it("collects one kind across scopes and tags each with where it lives", () => {
    const mine = makePreset(effectPresetKind("glass"), "My pane", { frost: 4 });
    const found = collectPresets(
      [builtinPresetSource(), { scope: "project", entries: [mine] }],
      effectPresetKind("glass"),
    );
    expect(found.some((p) => p.name === "Liquid Glass" && p.scope === "builtin")).toBe(true);
    expect(found.some((p) => p.name === "My pane" && p.scope === "project")).toBe(true);
    // Other kinds never leak in.
    expect(found.every((p) => p.kind === effectPresetKind("glass"))).toBe(true);
  });

  it("searches name, group and tags", () => {
    const src = [builtinPresetSource()];
    expect(collectPresets(src, effectPresetKind("glass"), "bubble").length).toBe(1);
    expect(collectPresets(src, effectPresetKind("glass"), "apple").length).toBeGreaterThan(1);
    expect(collectPresets(src, effectPresetKind("glass"), "iridescent").length).toBe(1);
    expect(collectPresets(src, effectPresetKind("glass"), "zzz").length).toBe(0);
  });

  it("groups for the picker, preserving first-seen order", () => {
    const groups = groupPresets(collectPresets([builtinPresetSource()], effectPresetKind("glass")));
    expect(groups[0]!.group).toBe("Apple");
    expect(groups.flatMap((g) => g.items).length).toBe(
      BUILTIN_PRESETS.filter((p) => p.kind === effectPresetKind("glass")).length,
    );
  });

  it("applies a patch without ever touching identity", () => {
    const fx = createLayerEffect("glass") as GlassEffect;
    const next = applyPresetPatch(fx, { frost: 99, id: "hacked", type: "blur", enabled: false });
    expect(next.frost).toBe(99);
    expect(next.id).toBe(fx.id);
    expect(next.type).toBe("glass");
    expect(next.enabled).toBe(true);
  });

  it("captures a patch that excludes identity", () => {
    const fx = createLayerEffect("glass") as GlassEffect;
    const patch = presetPatchFrom(fx);
    expect(patch.id).toBeUndefined();
    expect(patch.type).toBeUndefined();
    expect(patch.enabled).toBeUndefined();
    expect(patch.ior).toBe(fx.ior);
  });

  it("deep-clones on save so later edits can't rewrite history", () => {
    const source = { nested: { frost: 1 } };
    const saved = makePreset("effect:glass", "x", source);
    source.nested.frost = 99;
    expect((saved.data as typeof source).nested.frost).toBe(1);
  });

  it("upserts, renames and removes by id", () => {
    const a = makePreset("k", "A", {});
    let list = upsertPreset([], a);
    list = upsertPreset(list, { ...a, name: "A2" });
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("A2");
    list = renamePreset(list, a.id, "A3");
    expect(list[0]!.name).toBe("A3");
    expect(removePreset(list, a.id)).toHaveLength(0);
  });

  it("every builtin preset carries a complete, identity-free payload", () => {
    for (const p of BUILTIN_PRESETS) {
      const data = p.data as Record<string, unknown>;
      expect(data.id).toBeUndefined();
      expect(data.type).toBeUndefined();
      expect(data.enabled).toBeUndefined();
    }
    // Glass looks are complete patches — switching presets can never inherit a
    // stale field from the look you were on before.
    const keys = Object.keys(presetPatchFrom(createLayerEffect("glass") as GlassEffect)).sort();
    for (const p of BUILTIN_PRESETS.filter((x) => x.kind === effectPresetKind("glass"))) {
      expect(Object.keys(p.data as object).sort()).toEqual(keys);
    }
  });
});

describe("activePreset — which preset a card currently IS", () => {
  const glow = BUILTIN_PRESETS.filter((p) => p.kind === effectPresetKind("glow"));

  it("names the preset a freshly-applied card is", () => {
    const neon = glow.find((p) => p.name === "Neon sign")!;
    const fx = applyPresetPatch(createLayerEffect("glow"), neon.data);
    expect(activePreset(glow, presetPatchFrom(fx))?.name).toBe("Neon sign");
  });

  it("goes custom the moment a field is tweaked", () => {
    const neon = glow.find((p) => p.name === "Neon sign")!;
    const fx = applyPresetPatch(createLayerEffect("glow"), neon.data) as Record<string, unknown>;
    fx.size = (fx.size as number) + 5;
    expect(activePreset(glow, presetPatchFrom(fx as object))).toBeNull();
  });

  it("ignores identity, so two cards wearing one look match the same preset", () => {
    const a = applyPresetPatch(createLayerEffect("glow"), glow[0]!.data);
    const b = applyPresetPatch(createLayerEffect("glow"), glow[0]!.data);
    expect(a.id).not.toBe(b.id);
    expect(activePreset(glow, presetPatchFrom(a))?.id).toBe(activePreset(glow, presetPatchFrom(b))?.id);
  });

  it("tolerates float dust and colour case", () => {
    const ember = glow.find((x) => x.name === "Ember")!;
    const fx = applyPresetPatch(createLayerEffect("glow"), ember.data) as Record<string, unknown>;
    fx.size = (fx.size as number) + 1e-9;
    fx.color = String(fx.color).toUpperCase();
    expect(activePreset(glow, presetPatchFrom(fx as object))?.name).toBe("Ember");
  });

  it("never matches an empty patch — nothing is not a look", () => {
    expect(activePreset([{ ...glow[0]!, data: {} }], { size: 3 })).toBeNull();
  });
});

describe("activePreset with structural fields", () => {
  const preset = (id: string, data: unknown): Preset => ({
    id,
    kind: "effect:eq",
    name: id,
    data,
    scope: "builtin",
    createdAt: 0,
    chip: null,
    group: null,
    tags: [],
  });

  const bands = (gain: number) => [
    { id: "a", type: "lowshelf", freqHz: 120, gainDb: gain, q: 0.7, enabled: true },
    { id: "b", type: "peaking", freqHz: 1000, gainDb: 0, q: 1, enabled: true },
  ];

  it("matches a list-valued field, ignoring the ids inside it", () => {
    const list = [preset("Warm", { mix: 1, bands: bands(4) })];
    // The card holds the same curve under DIFFERENT band ids — which is exactly
    // what `mergeEqPresetBands` produces so keyframe paths survive a preset.
    const onCard = { mix: 1, bands: bands(4).map((b, i) => ({ ...b, id: `own-${i}` })) };
    expect(activePreset(list, onCard)?.name).toBe("Warm");
  });

  it("a changed value inside the list is a custom look again", () => {
    const list = [preset("Warm", { mix: 1, bands: bands(4) })];
    expect(activePreset(list, { mix: 1, bands: bands(5) })).toBeNull();
  });

  it("a different band count never matches", () => {
    const list = [preset("Warm", { mix: 1, bands: bands(4) })];
    expect(activePreset(list, { mix: 1, bands: [bands(4)[0]] })).toBeNull();
  });

  it("nested `type` and `enabled` are VALUES, not identity", () => {
    const list = [preset("Warm", { mix: 1, bands: bands(4) })];
    const retyped = bands(4).map((b, i) => (i === 0 ? { ...b, type: "highshelf" } : b));
    const muted = bands(4).map((b, i) => (i === 0 ? { ...b, enabled: false } : b));
    expect(activePreset(list, { mix: 1, bands: retyped })).toBeNull();
    expect(activePreset(list, { mix: 1, bands: muted })).toBeNull();
  });
});
