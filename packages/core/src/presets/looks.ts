import type { MotionDocument } from "../schema";
import type { BaseEffect, EffectRegistry, EffectTypeDefBase } from "../animation/effect-base";
import { LFX } from "../animation/layer-effects";
import { TFX } from "../animation/text-effects";
import { EMITTER } from "../physics/emitters";
import { BUILTIN_PRESETS } from "./builtin-effects";
import { collectPresets, type Preset } from "./library";
import { effectsFromStackPreset, stackPresetFrom, type StackPresetEntry } from "./stacks";
import {
  EFFECT_GROUP_TYPE,
  groupMembers,
  insertEffectGroup,
  isEffectGroup,
  swapGroupLook,
  type EffectGroupCard,
  type GroupableEffect,
} from "../animation/effect-groups";

/**
 * LOOKS BY NAME — every whole-stack look (a layer's effect stack, a text
 * layer's per-glyph stack, a layer's particle emitters) as one addressable
 * list, for the surfaces that cannot open a picker: the agent API, scripts,
 * a gift pack's prompt. The picker and this read the same library entries,
 * so "Paper cut-out" in the frame panel and `effects_look {look:
 * "paper-cut-out"}` are one look.
 *
 * A look's address is its SHORT id (`paper-cut-out`) — the built-in id with
 * its namespace stripped — or its name, case-insensitively, or (for a look
 * saved into the project) its stored id. Ids are unique within a domain; when
 * a name exists in two domains the caller says which.
 */

export type LookDomain = "layer" | "text" | "emitter";

type AnyRegistry = EffectRegistry<BaseEffect, EffectTypeDefBase<BaseEffect>>;

const DOMAINS: ReadonlyArray<{ domain: LookDomain; registry: AnyRegistry }> = [
  { domain: "layer", registry: LFX as unknown as AnyRegistry },
  { domain: "text", registry: TFX as unknown as AnyRegistry },
  { domain: "emitter", registry: EMITTER as unknown as AnyRegistry },
];

export interface LookEntry {
  domain: LookDomain;
  preset: Preset;
}

/** `builtin:<kind>:<id>` → `<id>`; a stored look keeps its own id. */
export function lookShortId(p: Preset): string {
  const prefix = `builtin:${p.kind}:`;
  return p.id.startsWith(prefix) ? p.id.slice(prefix.length) : p.id;
}

/** The registry that owns a look's cards. */
export function lookRegistry(domain: LookDomain): AnyRegistry {
  return DOMAINS.find((d) => d.domain === domain)!.registry;
}

/** Every look the document can reach: built-in, then the project's own. */
export function allLooks(doc?: Pick<MotionDocument, "presets"> | null): LookEntry[] {
  const sources = [
    { scope: "builtin" as const, entries: BUILTIN_PRESETS },
    ...(doc?.presets?.length ? [{ scope: "project" as const, entries: doc.presets }] : []),
  ];
  return DOMAINS.flatMap(({ domain, registry }) =>
    collectPresets(sources, registry.stackPresetKind).map((preset) => ({ domain, preset })),
  );
}

/**
 * The look `query` names, or a list of what it could have meant. Never
 * guesses between two: an ambiguous name is an error the caller can fix.
 */
export function findLook(
  query: string,
  domain?: LookDomain,
  doc?: Pick<MotionDocument, "presets"> | null,
): { look: LookEntry } | { error: string; suggestions: string[] } {
  const q = query.trim().toLowerCase();
  const pool = allLooks(doc).filter((l) => !domain || l.domain === domain);
  const hits = pool.filter((l) => lookShortId(l.preset).toLowerCase() === q || l.preset.id.toLowerCase() === q || l.preset.name.toLowerCase() === q);
  if (hits.length === 1) return { look: hits[0]! };
  if (hits.length > 1) {
    return { error: `"${query}" names a look in ${hits.map((h) => h.domain).join(" and ")} — say which with domain.`, suggestions: hits.map((h) => `${h.domain}:${lookShortId(h.preset)}`) };
  }
  const near = pool.filter((l) => l.preset.name.toLowerCase().includes(q) || l.preset.tags.some((t) => t.toLowerCase().includes(q)));
  return { error: `No look "${query}".`, suggestions: (near.length ? near : pool).slice(0, 12).map((l) => lookShortId(l.preset)) };
}

/** A look as fresh cards (new ids) of its own registry's defaults, patched. */
export function lookCards(entry: LookEntry): BaseEffect[] {
  return effectsFromStackPreset(lookRegistry(entry.domain), entry.preset.data);
}

/** The catalogue row an agent reads: what the look is and what it is made of. */
export function lookRow(entry: LookEntry) {
  const cards = Array.isArray(entry.preset.data) ? (entry.preset.data as Array<{ type?: unknown }>).map((c) => String(c.type)) : [];
  return {
    id: lookShortId(entry.preset),
    name: entry.preset.name,
    domain: entry.domain,
    group: entry.preset.group,
    cards,
    ...(entry.preset.fps ? { fps: entry.preset.fps } : {}),
    ...(entry.preset.scope !== "builtin" ? { scope: entry.preset.scope } : {}),
  };
}

// ── Looks as groups (D13) ────────────────────────────────────────────────────

/**
 * APPLY A LOOK to a stack the way a person means it: as ONE group card that
 * holds the look's cards, added after what the layer already wears. Applying
 * to an existing group (`into`) swaps its members and keeps its place, mix and
 * eye — so trying ten looks in a row is ten swaps of one card, not ten cards.
 *
 * Only the `layer` domain has groups; the per-glyph and emitter stacks keep
 * whole-stack replace (`lookCards`) until their registries carry a group arm.
 * `removed` lists the ids that left, so the caller drops their keyframes.
 */
export function applyLookAsGroup<E extends GroupableEffect>(
  effects: readonly E[],
  entry: LookEntry,
  into?: string | null,
): { effects: E[]; group: string; removed: string[] } {
  const cards = lookCards(entry) as unknown as E[];
  const look = { name: entry.preset.name, look: lookShortId(entry.preset) };
  const target = into ? effects.find((e) => e.id === into && isEffectGroup(e)) : undefined;
  if (target) {
    const swapped = swapGroupLook(effects, target.id, cards, look);
    return { ...swapped, group: target.id };
  }
  const header = { ...(lookRegistry("layer").create(EFFECT_GROUP_TYPE) as unknown as EffectGroupCard), ...look } as unknown as E & EffectGroupCard;
  return { effects: insertEffectGroup(effects, header, cards), group: header.id, removed: [] };
}

/** A group's members as a storable look — what "Save as look" writes. */
export function lookDataFromGroup<E extends GroupableEffect>(effects: readonly E[], groupId: string): StackPresetEntry[] {
  return stackPresetFrom(groupMembers(effects, groupId));
}

/** The look a stack wears, by short id: its first group's `look`. */
export function wornLook(effects: readonly GroupableEffect[]): string | null {
  const g = effects.find(isEffectGroup) as EffectGroupCard | undefined;
  return g?.look ?? null;
}
