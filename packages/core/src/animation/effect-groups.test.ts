import { describe, expect, it } from "vitest";

import { createStarterDocument } from "../factories";
import { parseDocument, serializeDocument } from "../io";
import { applyLookAsGroup, findLook, lookDataFromGroup } from "../presets/looks";
import type { LayerEffect } from "../schema/layer-effects";
import {
  effectGroupPlan,
  groupEffects,
  groupMembers,
  isEffectGroup,
  moveEffect,
  normalizeEffectGroups,
  ungroupEffects,
  type EffectGroupCard,
} from "./effect-groups";
import { LFX } from "./layer-effects";

const on = (e: { enabled: boolean }) => e.enabled;
const mixOf = (g: EffectGroupCard) => g.mix;
const look = (mix: number, id = "g1") => ({ ...(LFX.create("group") as EffectGroupCard), id, mix }) as unknown as LayerEffect;
const card = (type: Parameters<typeof LFX.create>[0], id: string, group?: string) =>
  ({ ...LFX.create(type), id, ...(group ? { group } : {}) }) as LayerEffect;

/** What the renderer compiles, with membership erased: the cards it runs and the mix of each run. */
const plan = (effects: LayerEffect[]) =>
  effectGroupPlan(effects, on, mixOf as never).map((s) => ({ mix: s.mix, cards: s.effects.map((e) => ({ ...e, group: undefined })) }));

describe("look groups — the render plan", () => {
  it("a one-card look at mix 1 runs exactly the bare card", () => {
    const bare = [card("blur", "a")];
    const grouped = [look(1), card("blur", "a", "g1")];
    expect(plan(grouped)).toEqual(plan(bare));
  });

  it("a look at mix 0 is identity — nothing runs", () => {
    expect(plan([look(0), card("blur", "a", "g1"), card("grain", "b", "g1")])).toEqual([]);
    // …and around loose cards it leaves exactly them.
    expect(plan([card("shadow", "s"), look(0), card("blur", "a", "g1")])).toEqual(plan([card("shadow", "s")]));
  });

  it("a switched-off look runs nothing, whatever its mix", () => {
    expect(plan([{ ...look(1), enabled: false }, card("blur", "a", "g1")])).toEqual([]);
  });

  it("a partial look is its own segment, between full runs that merge", () => {
    const segs = effectGroupPlan(
      [card("shadow", "s"), look(0.4), card("blur", "a", "g1"), card("grain", "b", "g1"), card("glow", "t")],
      on,
      mixOf as never,
    );
    expect(segs.map((s) => [s.mix, s.effects.map((e) => e.id)])).toEqual([
      [1, ["s"]],
      [0.4, ["a", "b"]],
      [1, ["t"]],
    ]);
  });

  it("full looks inline into one run with their neighbours", () => {
    const segs = effectGroupPlan([card("shadow", "s"), look(1), card("blur", "a", "g1"), card("glow", "t")], on, mixOf as never);
    expect(segs.map((s) => s.effects.map((e) => e.id))).toEqual([["s", "a", "t"]]);
  });
});

describe("look groups — editing verbs", () => {
  it("normalize pulls members after their header and frees orphans", () => {
    const out = normalizeEffectGroups([card("blur", "a", "g1"), card("shadow", "s"), look(1), card("glow", "x", "gone")]);
    expect(out.map((e) => e.id)).toEqual(["s", "g1", "a", "x"]);
    expect(out.find((e) => e.id === "x")!.group).toBeUndefined();
  });

  it("normalize returns the same list when nothing is out of place", () => {
    const ok = [look(1), card("blur", "a", "g1"), card("shadow", "s")];
    expect(normalizeEffectGroups(ok)).toBe(ok);
  });

  it("applying a look INSERTS a group — the existing stack survives", () => {
    const found = findLook("paper-cut-out", "layer");
    expect("look" in found).toBe(true);
    if (!("look" in found)) return;
    const before = [card("shadow", "s")];
    const { effects, group } = applyLookAsGroup(before, found.look);
    expect(effects[0]!.id).toBe("s");
    const header = effects.find((e) => e.id === group)!;
    expect(isEffectGroup(header)).toBe(true);
    expect(groupMembers(effects, group).length).toBeGreaterThan(0);
    // Applying another look INTO it swaps members, keeps place and mix.
    const other = findLook("stop-motion", "layer");
    if (!("look" in other)) throw new Error("stop-motion missing");
    const mixed = effects.map((e) => (e.id === group ? { ...e, mix: 0.5 } : e));
    const swapped = applyLookAsGroup(mixed, other.look, group);
    expect(swapped.group).toBe(group);
    expect((swapped.effects.find((e) => e.id === group) as unknown as EffectGroupCard).mix).toBe(0.5);
    expect(swapped.removed.sort()).toEqual(groupMembers(effects, group).map((m) => m.id).sort());
    expect(swapped.effects[0]!.id).toBe("s");
  });

  it("group, save, ungroup", () => {
    const stack = [card("shadow", "s"), card("blur", "a"), card("glow", "b")];
    const grouped = groupEffects(stack, ["a", "b"], look(1, "g9") as never);
    expect(grouped.map((e) => [e.id, e.group])).toEqual([["s", undefined], ["g9", undefined], ["a", "g9"], ["b", "g9"]]);
    const saved = lookDataFromGroup(grouped, "g9");
    expect(saved.map((e) => e.type)).toEqual(["blur", "glow"]);
    expect(saved.some((e) => "group" in e || "id" in e)).toBe(false);
    expect(ungroupEffects(grouped, "g9")).toEqual(stack);
  });

  it("drags a card into a look and back out", () => {
    const stack = [look(1), card("blur", "a", "g1"), card("shadow", "s")];
    const inside = moveEffect(stack, "s", 1, "g1");
    expect(inside.map((e) => [e.id, e.group])).toEqual([["g1", undefined], ["s", "g1"], ["a", "g1"]]);
    const out = moveEffect(inside, "s", 3, null);
    expect(out.map((e) => [e.id, e.group])).toEqual([["g1", undefined], ["a", "g1"], ["s", undefined]]);
  });
});

describe("look groups — documents", () => {
  const firstVisual = (doc: ReturnType<typeof createStarterDocument>) =>
    doc.tracks.flatMap((t) => t.clips).find((c) => c.kind !== "audio" && "effects" in c) as { effects: LayerEffect[] } | undefined;

  it("an old stack (no groups) round-trips unchanged", () => {
    const doc = createStarterDocument();
    const clip = firstVisual(doc)!;
    clip.effects = [card("shadow", "s"), card("blur", "a")];
    const before = structuredClone(clip.effects);
    const back = firstVisual(parseDocument(serializeDocument(doc)))!;
    expect(back.effects).toEqual(before);
    expect(back.effects.some((e) => "group" in e)).toBe(false);
  });

  it("a stack with a look round-trips with its membership", () => {
    const doc = createStarterDocument();
    const clip = firstVisual(doc)!;
    clip.effects = [card("shadow", "s"), look(0.25), card("blur", "a", "g1")];
    const before = structuredClone(clip.effects);
    expect(firstVisual(parseDocument(serializeDocument(doc)))!.effects).toEqual(before);
  });
});
