import { createId } from "../ids";
import type { KeyframeValue } from "../schema/animation";
import type { Modulator } from "../schema/modulators";
import type { TextEffect, TextEffectType } from "../schema/text-style";
import { createEffectRegistry, type EffectFieldDef, type EffectTypeDefBase } from "./effect-base";
import { resolveEffectValues } from "./effect-values";

/**
 * THE TEXT EFFECT REGISTRY — every pass drawn per glyph.
 *
 * The third specialisation of `effect-base.ts`, after pixels and sound. It
 * declares nothing the others do not: a kind is a label, a blurb, a category,
 * its fields and a `create()`, and from that the inspector card, the floating
 * editor, the keyframe rows, the modulator badges, the preset picker and the
 * add palette all exist with no further code — exactly as they do for a layer
 * effect. The per-glyph section used to be a hand-built panel with its own
 * inputs, no keyframes, no presets and a Sparkles icon for "enabled"; that was
 * a fourth answer to a question this registry had already answered three
 * times.
 *
 * What stays different is WHERE the stack lives and HOW it is drawn, and both
 * are the schema's and the renderer's business, not this file's: the list sits
 * on the resolved text style (so a range or a caption's focus can carry its
 * own), and the passes are laid down per glyph under the glyph's own transform,
 * which is why no field here is `scaled` — they ride the CTM.
 *
 * Keyframe paths are `tfx.<effectId>.<field>` (owned by `TFX`, below).
 */
export interface TextEffectTypeDef extends EffectTypeDefBase<TextEffect> {
  type: TextEffectType;
}

/**
 * The colour block every pass shares, in the same words the layer glow uses
 * for the same idea (`mode: auto | solid`): a source, and a colour that only
 * exists while the source is custom. Written once and spread, so the four
 * cards cannot drift apart on the one row they all have.
 */
const COLOR_FIELDS: EffectFieldDef[] = [
  {
    key: "source",
    label: "Color",
    kind: "select",
    options: [
      { value: "text", label: "Text colour", hint: "Follows the letter — recolour the word and this follows." },
      { value: "custom", label: "Custom", hint: "A colour of its own, whatever the letter is painted." },
    ],
    hint: "Where the pass gets its colour. Text colour makes a focused word's glow follow its focus colour on its own.",
  },
  { key: "color", label: "Tint", kind: "color", showIf: { key: "source", equals: ["custom"] } },
];

const OPACITY_FIELD: EffectFieldDef = {
  key: "opacity",
  label: "Opacity",
  kind: "number",
  min: 0,
  max: 1,
  step: 0.01,
  hint: "Multiplied into the pass, on top of the colour's own alpha.",
};

const ANGLE_FIELD: EffectFieldDef = { key: "angle", label: "Angle", kind: "number", min: 0, max: 360, step: 1, unit: "°" };

export const TEXT_EFFECT_TYPE_DEFS: TextEffectTypeDef[] = [
  {
    type: "shadow",
    label: "Shadow",
    blurb: "A cast shadow under every letter — offset and softened.",
    tags: ["drop shadow", "depth", "offset", "hard shadow", "print"],
    category: "glyph-light",
    fields: [
      ...COLOR_FIELDS,
      { key: "x", label: "X", kind: "number", min: -120, max: 120, step: 1, unit: "px", bipolar: true },
      { key: "y", label: "Y", kind: "number", min: -120, max: 120, step: 1, unit: "px", bipolar: true },
      { key: "blur", label: "Blur", kind: "number", min: 0, max: 120, step: 1, unit: "px", hint: "0 is a hard-edged copy — the offset-print look." },
      OPACITY_FIELD,
    ],
    create: () => ({
      id: createId("tfx"),
      type: "shadow",
      enabled: true,
      source: "custom",
      color: "#00000099",
      opacity: 1,
      x: 0,
      y: 4,
      blur: 8,
    }),
  },
  {
    type: "glow",
    label: "Glow",
    blurb: "A halo around every letter — in the text's own colour by default.",
    tags: ["neon", "halo", "bloom", "light", "outer glow"],
    category: "glyph-light",
    fields: [
      ...COLOR_FIELDS,
      { key: "radius", label: "Radius", kind: "number", min: 0, max: 120, step: 1, unit: "px", hint: "How far the halo reaches from the letter's edge." },
      {
        key: "intensity",
        label: "Strength",
        kind: "number",
        min: 0.1,
        max: 4,
        step: 0.1,
        hint: "How many times the halo is laid down. Past 1 the core blows out — the neon look.",
      },
      OPACITY_FIELD,
    ],
    create: () => ({
      id: createId("tfx"),
      type: "glow",
      enabled: true,
      source: "text",
      color: "#ffffff",
      opacity: 1,
      radius: 14,
      intensity: 1,
    }),
  },
  {
    type: "extrude",
    label: "Extrude",
    blurb: "A solid face behind each letter — stepped copies, for 3D type.",
    tags: ["3d", "block", "depth", "solid", "isometric"],
    category: "glyph-depth",
    fields: [
      ...COLOR_FIELDS,
      ANGLE_FIELD,
      { key: "length", label: "Depth", kind: "number", min: 0, max: 160, step: 1, unit: "px" },
      OPACITY_FIELD,
    ],
    create: () => ({
      id: createId("tfx"),
      type: "extrude",
      enabled: true,
      source: "custom",
      color: "#00000066",
      opacity: 1,
      angle: 45,
      length: 16,
    }),
  },
  {
    type: "echo",
    label: "Echo",
    blurb: "Fading copies trailing off each letter — motion, stacked, ghosted.",
    tags: ["trail", "ghost", "repeat", "stack", "motion", "afterimage"],
    category: "glyph-depth",
    fields: [
      ...COLOR_FIELDS,
      { key: "count", label: "Copies", kind: "number", min: 1, max: 12, step: 1 },
      { key: "distance", label: "Spacing", kind: "number", min: 0, max: 120, step: 1, unit: "px", hint: "Distance between one copy and the next." },
      ANGLE_FIELD,
      { key: "fade", label: "Fade", kind: "number", min: 0, max: 1, step: 0.01, hint: "How much each copy dims toward the last. 1 makes the last one vanish." },
      OPACITY_FIELD,
    ],
    create: () => ({
      id: createId("tfx"),
      type: "echo",
      enabled: true,
      source: "text",
      color: "#ffffff",
      opacity: 0.6,
      count: 4,
      distance: 8,
      angle: 0,
      fade: 0.7,
    }),
  },
];

/** The per-glyph domain's registry — lookup, creation, `tfx.` paths, presets. */
export const TFX = createEffectRegistry<TextEffect, TextEffectTypeDef>("text", "tfx", TEXT_EFFECT_TYPE_DEFS);

export function textEffectTypeDef(type: TextEffectType): TextEffectTypeDef | undefined {
  return TFX.def(type);
}

export function createTextEffect(type: TextEffectType): TextEffect {
  return TFX.create(type);
}

/** Keyframe path for a text-effect field. */
export function textEffectPath(effectId: string, field: string): string {
  return TFX.path(effectId, field);
}

/** Deep-clone a text-effect stack with fresh ids. */
export function cloneTextEffects(effects: readonly TextEffect[]): TextEffect[] {
  return effects.map((e) => ({ ...e, id: createId("tfx") }));
}

/**
 * A pass with every field RESOLVED for this instant — keyframes, the colour
 * table, modulators — and its colour already decided: `color` here is what to
 * paint with, the glyph's own colour substituted when the source says so.
 *
 * The renderer, the region outset and the library's CSS preview all read this
 * rather than the raw effect, so "what does this pass look like right now" has
 * one answer. Its shape is the effect's own minus `source`, which has been
 * consumed.
 */
export type ResolvedTextEffect = TextEffect;

export function resolveTextEffect(
  effect: TextEffect,
  sampled: Record<string, KeyframeValue>,
  opts: {
    /** The glyph's own resolved colour — what `source: "text"` paints with. */
    glyphColor: string;
    resolveColor?: (c: string) => string;
    modulators?: readonly Modulator[];
    timeSec?: number;
  },
): ResolvedTextEffect {
  const vals = resolveEffectValues(TFX.fields(effect), effect as unknown as Record<string, unknown>, sampled, (k) => TFX.path(effect.id, k), {
    resolveColor: opts.resolveColor,
    modulators: opts.modulators,
    timeSec: opts.timeSec,
  });
  const source = vals["source"] === "text" ? "text" : "custom";
  const color = source === "text" ? (opts.resolveColor?.(opts.glyphColor) ?? opts.glyphColor) : String(vals["color"]);
  return { ...(effect as object), ...vals, source, color } as ResolvedTextEffect;
}

/**
 * Outward px a resolved pass reaches past the glyph's outline — the one
 * number the region pad, the isolation buffer and the preview frame all need.
 *
 * A canvas `shadowBlur` is 2σ, so its tail dies at about 1.5× the authored
 * number — not the 3× a real Gaussian radius needs. The constant lives here,
 * beside the passes it describes, rather than in whichever caller remembered.
 */
export function textEffectReachPx(fx: ResolvedTextEffect): number {
  const SHADOW_REACH = 1.5;
  switch (fx.type) {
    case "shadow":
      return Math.hypot(fx.x, fx.y) + fx.blur * SHADOW_REACH;
    case "glow":
      return fx.radius * SHADOW_REACH;
    case "extrude":
      return Math.max(0, fx.length);
    case "echo":
      return Math.max(0, fx.count * fx.distance);
  }
}
