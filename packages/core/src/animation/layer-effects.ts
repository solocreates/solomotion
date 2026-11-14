import { createId } from "../ids";
import type { LayerEffect, LayerEffectType } from "../schema/layer-effects";
import { createEffectRegistry, type EffectFieldDef, type EffectStackSummary } from "./effect-base";
import { ANALOG_EFFECT_TYPES } from "./effects/analog";
import { BASIC_EFFECT_TYPES } from "./effects/basics";
import { COLOR_EFFECT_TYPES } from "./effects/color";
import { DISTORT_EFFECT_TYPES } from "./effects/distort";
import { LIGHT_EFFECT_TYPES } from "./effects/light";
import { MATERIAL_EFFECT_TYPES } from "./effects/material";
import { PATTERN_EFFECT_TYPES } from "./effects/pattern";
import { DEPTH_EFFECT_TYPES } from "./effects/depth";
import { COSMOS_EFFECT_TYPES } from "./effects/cosmos";
import { SURFACE_EFFECT_TYPES } from "./effects/surface";
import type { LayerEffectTypeDef } from "./effects/shared";

export * from "./effects/shared";

/**
 * THE VISUAL EFFECT REGISTRY — every effect that processes a layer's pixels.
 *
 * It is one specialisation of `effect-base.ts`, not a system of its own: the
 * field vocabulary, the palette taxonomy, the keyframe-path convention, the
 * clone/summary/defaults helpers and the "which layers may carry this" rule all
 * come from there, and the audio registry is built from the identical parts.
 * What lives in `effects/*.ts` is only what is true of pixels: the list of
 * cards, their fields, and their defaults. Adding an effect kind is one entry
 * in a family file plus one case in that family's renderer — the inspector
 * card, the floating editor, the node-board card, the keyframe rows, the preset
 * library and the add palette all appear with no further code.
 *
 * Keyframe paths are `lfx.<effectId>.<field>` (owned by `LFX`, below).
 *
 * WHY FAMILIES. This was one 900-line list until it held thirty-six cards, at
 * which point two things broke at once: the file stopped being readable, and
 * every pixel engine in the app — grain, glass, lightning, halftone — sat in
 * the editor's first chunk whether the document used them or not. The family
 * split fixes both with one boundary, because the same grouping that makes the
 * metadata legible is the grouping the renderer lazily imports. Metadata is
 * cheap and must be eager (the palette has to list what you do not have yet);
 * engines are expensive and must not be. See `stage/render/passes/registry.ts`.
 *
 * There used to be a SECOND registry beside this one — a per-glyph text stack
 * with its own Shadow, Glow, Blur, Inner shadow, Stroke and Long shadow. Five
 * of those six were the same idea drawn twice (a "Size" that meant blur radius
 * in one and spread in the other), and the sixth pair only differed in that the
 * glyph version could not be used on anything but text. It is gone: `stroke`
 * and `longShadow` were promoted into this table as silhouette passes, and the
 * rest resolved to the cards that were already better. One Glow. (v54.)
 */
export const LAYER_EFFECT_TYPES: LayerEffectTypeDef[] = [
  ...BASIC_EFFECT_TYPES,
  ...COLOR_EFFECT_TYPES,
  ...MATERIAL_EFFECT_TYPES,
  ...ANALOG_EFFECT_TYPES,
  ...LIGHT_EFFECT_TYPES,
  ...DISTORT_EFFECT_TYPES,
  ...PATTERN_EFFECT_TYPES,
  ...DEPTH_EFFECT_TYPES,
  ...COSMOS_EFFECT_TYPES,
  ...SURFACE_EFFECT_TYPES,
];

/**
 * The visual domain's registry instance — lookup, creation, defaults, palette
 * filtering, the `lfx.` path convention and the stack summary, all from the
 * shared factory. The named functions below are thin doors onto it, kept so the
 * hundred call sites that predate the base read unchanged; new code can take
 * `LFX` whole (that is what the audio stack does).
 */
export const LFX = createEffectRegistry<LayerEffect, LayerEffectTypeDef>("layer", "lfx", LAYER_EFFECT_TYPES);

export function layerEffectTypeDef(type: LayerEffectType): LayerEffectTypeDef | undefined {
  return LFX.def(type);
}

/**
 * Does THIS effect instance need the scene behind its layer rendered for it?
 *
 * Type-level capability (`readsBackdrop`) AND the instance's own opt-out: a
 * material set to `edgeOnly` draws its rim and nothing else, so it reads no
 * backdrop and must not make the renderer pay for one. `edgeOnly` is the shared
 * name for that switch across every backdrop-reading card, the way `enabled`
 * and `mix` are shared — a new material reuses it rather than inventing a
 * second spelling.
 */
export function layerEffectReadsBackdrop(effect: LayerEffect): boolean {
  if (!layerEffectTypeDef(effect.type)?.readsBackdrop) return false;
  return !("edgeOnly" in effect && effect.edgeOnly === true);
}

/** Does this card cut holes in what it is given? See `LayerEffectTypeDef.carves`. */
export function layerEffectCarves(type: LayerEffectType): boolean {
  return layerEffectTypeDef(type)?.carves === true;
}

export function layerEffectFields(effect: LayerEffect): EffectFieldDef[] {
  return LFX.fields(effect);
}

export function createLayerEffect(type: LayerEffectType): LayerEffect {
  return LFX.create(type);
}

/** True when the card's output CAN change with time, not only with its fields. */
export function isTimeDrivenEffect(type: LayerEffectType): boolean {
  return LFX.isTimeDriven(type);
}

/** True when THIS card is moving on its own right now — see `EffectRegistry.isMoving`. */
export function layerEffectMoves(effect: LayerEffect): boolean {
  return LFX.isMoving(effect);
}

/** The stepped picture a moving card shows at `timeSec` — see `LayerEffectTypeDef.picture`. */
export function layerEffectPictureAt(effect: LayerEffect, timeSec: number): string | null {
  return LFX.pictureAt(effect, timeSec);
}

/** Keyframe path for a layer-effect field. */
export function layerEffectPath(effectId: string, field: string): string {
  return LFX.path(effectId, field);
}

/** Deep-clone a layer-effect stack with fresh ids. */
export function cloneLayerEffects(effects: LayerEffect[]): LayerEffect[] {
  return effects.map((e) => ({ ...e, id: createId("lfx") }));
}

/** @see EffectStackSummary — what the timeline's `fx` badge and tooltip read. */
export type ClipEffectSummary = EffectStackSummary;

export function clipEffectSummary(effects: readonly LayerEffect[]): ClipEffectSummary {
  return LFX.summary(effects);
}
