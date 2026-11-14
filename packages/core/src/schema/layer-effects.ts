import { z } from "zod";

import { ANALOG_EFFECT_ARMS } from "./effects/analog";
import { BASIC_EFFECT_ARMS } from "./effects/basics";
import { COLOR_EFFECT_ARMS } from "./effects/color";
import { DISTORT_EFFECT_ARMS } from "./effects/distort";
import { LIGHT_EFFECT_ARMS } from "./effects/light";
import { MATERIAL_EFFECT_ARMS } from "./effects/material";
import { PATTERN_EFFECT_ARMS } from "./effects/pattern";
import { DEPTH_EFFECT_ARMS } from "./effects/depth";
import { COSMOS_EFFECT_ARMS } from "./effects/cosmos";
import { SURFACE_EFFECT_ARMS } from "./effects/surface";

export { EFFECT_BLEND_MODES, type EffectBlendMode } from "./effects/shared";
export { SURFACE_MATERIALS, SURFACE_COLOR_MODES, SURFACE_MORPH_STYLES, SURFACE_MORPH_TARGETS, SURFACE_TEXTURE_TILINGS, type SurfaceMaterial, type SurfaceColorMode, type SurfaceMorphStyle, type SurfaceTextureTiling } from "./effects/surface";

/**
 * Layer effects — the effect stack EVERY visual clip carries (text, captions,
 * nested comps, images, videos, shapes, paths). These composite the whole
 * layer: a shadow follows the actual painted silhouette (a star casts a star,
 * not a box), a bulge magnifies whatever is under it, and every numeric field
 * and every colour is a keyframe path (`lfx.<id>.<field>`), so the whole stack
 * animates and record mode picks it up like any other value.
 *
 * THIS FILE IS THE ASSEMBLY POINT, NOT THE INVENTORY. The arms live in
 * `effects/<family>.ts` and are welded into one discriminated union here. That
 * split is the answer to "what does this cost at a hundred effects":
 *
 *   - a family is a file, and adding one is a file plus one spread below;
 *   - the family boundary is ALSO the renderer's lazy-chunk boundary
 *     (`stage/render/passes/registry.ts`), so the pixel engine for an effect
 *     nobody used is never downloaded, parsed or held in memory;
 *   - `effects/shared.ts` holds the blocks every arm is built from, so thirty
 *     cards cannot drift into thirty ideas of what `enabled` or `blend` mean.
 *
 * The union stays flat on purpose. It is what `clip.effects` validates against,
 * what the registry keys off and what every migration walks — a nested "family"
 * discriminator would buy nothing and cost every consumer a second switch.
 */
export const layerEffectSchema = z.discriminatedUnion("type", [
  ...BASIC_EFFECT_ARMS,
  ...COLOR_EFFECT_ARMS,
  ...MATERIAL_EFFECT_ARMS,
  ...ANALOG_EFFECT_ARMS,
  ...LIGHT_EFFECT_ARMS,
  ...DISTORT_EFFECT_ARMS,
  ...PATTERN_EFFECT_ARMS,
  ...DEPTH_EFFECT_ARMS,
  ...COSMOS_EFFECT_ARMS,
  ...SURFACE_EFFECT_ARMS,
]);
export type LayerEffect = z.infer<typeof layerEffectSchema>;
export type LayerEffectType = LayerEffect["type"];

/**
 * The effect stack as ONE named schema. `effects` rides the base clip, which is
 * spread into every arm of the clip union — so without a name, this 30-variant
 * discriminated union is written out in full once per clip kind in the emitted
 * declarations. That repetition is most of `documentSchema`'s declaration size,
 * and it is what pushed the compiler past its serialization limit (TS7056) when
 * a single field was added to the base clip. Naming it buys the schema real
 * headroom instead of leaving the next field to hit the same wall.
 */
export const layerEffectListSchema: z.ZodType<LayerEffect[], z.ZodTypeDef, unknown> = z
  .array(layerEffectSchema)
  .default([]);

/**
 * Named arms, for the resolvers that take one card rather than the union. Only
 * the cards with a BRAIN of their own need one — everything else is resolved
 * generically from its field metadata and never names its own type.
 */
export type ColorGradeEffect = Extract<LayerEffect, { type: "colorGrade" }>;
export type GlassEffect = Extract<LayerEffect, { type: "glass" }>;
export type GrainEffect = Extract<LayerEffect, { type: "grain" }>;
export type FilmDamageEffect = Extract<LayerEffect, { type: "filmDamage" }>;
export type ScanlinesEffect = Extract<LayerEffect, { type: "scanlines" }>;
export type NoiseEffect = Extract<LayerEffect, { type: "noise" }>;
export type GlowEffect = Extract<LayerEffect, { type: "glow" }>;
export type StrokeEffect = Extract<LayerEffect, { type: "stroke" }>;
export type LongShadowEffect = Extract<LayerEffect, { type: "longShadow" }>;
export type LightningEffect = Extract<LayerEffect, { type: "lightning" }>;
export type RoughenEdgesEffect = Extract<LayerEffect, { type: "roughenEdges" }>;
export type GlitchEffect = Extract<LayerEffect, { type: "glitch" }>;
export type ShineEffect = Extract<LayerEffect, { type: "shine" }>;
export type LensEffect = Extract<LayerEffect, { type: "lens" }>;
export type SurfaceEffect = Extract<LayerEffect, { type: "surface" }>;

/**
 * Every effect that carries the temporal clock. One list, so "which cards are
 * alive?" — asked by the registry's `timeDriven` flag, the preview's own clock
 * and any future adapter — has a single answer.
 */
export type TemporalEffect =
  | GrainEffect
  | FilmDamageEffect
  | ScanlinesEffect
  | NoiseEffect
  | LightningEffect
  | RoughenEdgesEffect
  | GlitchEffect
  | SurfaceEffect;
