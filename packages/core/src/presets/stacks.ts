import type { BaseEffect, EffectRegistry, EffectTypeDefBase } from "../animation/effect-base";
import { applyPresetPatch, presetPatchFrom, type Preset } from "./library";

/**
 * STACK PRESETS — a whole effect list as one thing you can name.
 *
 * A single-card preset answers "make this glow look like Neon". A stack preset
 * answers "make this title look like a neon sign": a glow AND a shadow AND an
 * extrude, in order, applied together. Nobody wants to rebuild the same three
 * cards on every title, and a preset that can only hold one card makes them.
 *
 * It rides the SAME library as everything else (`strokeStack` was the first of
 * these; this is the effect domains' version), so search, scopes, rename and
 * delete already exist. The payload is a list of `{ type, ...fields }` — each
 * entry is a card's identity-free patch plus the ONE identity key a card needs
 * to be re-created, its type. Ids are never stored; applying mints fresh ones,
 * so two layers wearing the same look never share a keyframe address.
 *
 * Apply REPLACES the stack — a look is a claim about the whole list, exactly as
 * a stroke stack is — and is one undo step. The add palette's "Saved" group
 * offers single cards for the append case.
 */
export interface StackPresetEntry {
  type: string;
  [field: string]: unknown;
}

/** Lift a live stack into a storable look. */
export function stackPresetFrom<E extends BaseEffect>(effects: readonly E[]): StackPresetEntry[] {
  return effects.map((e) => ({ type: e.type, ...presetPatchFrom(e) }));
}

/**
 * A look as fresh cards of the registry's own defaults, patched. Entries whose
 * type the registry does not know (a look saved by a newer build, a plugin
 * that is not installed) are skipped rather than trusted — a card the
 * renderer cannot draw is worse than a card that is missing.
 */
export function effectsFromStackPreset<E extends BaseEffect, D extends EffectTypeDefBase<E>>(
  registry: EffectRegistry<E, D>,
  data: unknown,
): E[] {
  if (!Array.isArray(data)) return [];
  const out: E[] = [];
  for (const entry of data as unknown[]) {
    if (!entry || typeof entry !== "object") continue;
    const { type, ...patch } = entry as StackPresetEntry;
    if (typeof type !== "string" || !registry.def(type)) continue;
    out.push(applyPresetPatch(registry.create(type as E["type"]), patch));
  }
  return out;
}

/** A built-in look — the read-only scope's entry for a stack. */
export function builtinStackPreset(
  kind: string,
  id: string,
  name: string,
  group: string,
  chip: [string, string] | null,
  stack: readonly StackPresetEntry[],
  tags: string[] = [],
  /** The rate the look holds its layer on — see `Preset.fps`. */
  fps?: number,
): Preset {
  return {
    ...(fps ? { fps } : {}),
    id: `builtin:${kind}:${id}`,
    kind,
    name,
    scope: "builtin",
    data: stack.map((e) => structuredClone(e)),
    chip,
    group,
    tags,
    createdAt: 0,
  };
}
