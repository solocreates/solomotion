import { z } from "zod";
import { Bindable } from "./variables";

/**
 * Text style — typography, colour, alignment and the highlight pill.
 *
 * It deliberately holds NO effect stack any more (v54). A text layer's shadows,
 * glow, stroke and blur live on `clip.effects` with every other layer's, drawn
 * as silhouette passes rather than per glyph: one Glow in the app instead of
 * two that disagreed, and an outline that works on a shape as readily as on a
 * word. What stays here is what is genuinely typographic — the things that have
 * no meaning off a run of text.
 *
 * The `highlight` pill is the one that looks like an effect and is not: it sits
 * BEHIND the text, sized from the laid-out run's own box and padding, so it is a
 * property of the type, not a pass over the layer's pixels. Captions reuse it
 * for the spoken-word background, which is the same reason.
 */

/** Background pill behind a run of text — also powers caption word highlighting. */
export const textHighlightSchema = z.object({
  color: z.string(),
  radius: z.number().min(0),
  paddingX: z.number().min(0),
  paddingY: z.number().min(0),
});
export type TextHighlight = z.infer<typeof textHighlightSchema>;

export const textAlignSchema = z.enum(["left", "center", "right", "justify"]);
export type TextAlign = z.infer<typeof textAlignSchema>;

/**
 * Paragraph reading direction. "auto" detects per-paragraph from content
 * (first strong character, Unicode UAX #9 P2/P3 — Arabic/Hebrew/etc. resolve
 * RTL automatically); "ltr"/"rtl" force it regardless of content.
 */
export const textDirectionSchema = z.enum(["auto", "ltr", "rtl"]);
export type TextDirectionSetting = z.infer<typeof textDirectionSchema>;

/** Underline / strikethrough — drawn as a line over the run, follows the color. */
export const textDecorationSchema = z.enum(["none", "underline", "strikethrough"]);
export type TextDecoration = z.infer<typeof textDecorationSchema>;

/** Display-only case transform (the underlying text is never changed). */
export const textCaseSchema = z.enum(["none", "upper", "lower", "title"]);
export type TextCase = z.infer<typeof textCaseSchema>;

/**
 * TEXT EFFECTS — the passes drawn PER GLYPH, in the glyph pass, beside the
 * stroke pipeline.
 *
 * These are a different thing from `clip.effects`, and the difference is the
 * whole reason both exist:
 *
 *   a TEXT effect   is drawn per glyph, from the glyph's own resolved style,
 *                   so it can differ per range and per caption focus
 *   a LAYER effect  is drawn over the finished layer raster, so it cannot —
 *                   splitting a silhouette changes what a blur or a glow MEANS
 *
 * v54 removed a per-glyph effect stack because there were two Glows in the app
 * that disagreed. The lesson was not "never per glyph"; it was "never twice".
 * So this list holds only what is per-glyph MEANINGFUL and is not offered by
 * the layer stack under the same name: a cast shadow, an outer glow, the
 * stepped extrude and the fading echo. Blur, grain, glass and grading stay
 * layer-only, where they are correct. Outlining stays in the stroke pipeline,
 * which is a better outline than an effect ever was.
 *
 * Because the renderer reads these off the glyph's RESOLVED style, a caption's
 * focused word carrying its own glow costs no new code path at all — the same
 * `styleAt` merge that gives it its own colour gives it its own effects.
 *
 * The SHAPE is the schema's; everything a surface asks about a kind — fields,
 * ranges, labels, defaults, presets, the keyframe path — is the registry's
 * (`animation/text-effects.ts`), the same registry factory the layer and audio
 * stacks are built from. That is what makes a text effect a card in the same
 * editor, with the same keyframes and modulators, rather than a panel of its
 * own.
 */
export const TEXT_EFFECT_TYPES = ["shadow", "glow", "extrude", "echo"] as const;
export type TextEffectType = (typeof TEXT_EFFECT_TYPES)[number];

/**
 * Where a pass gets its colour.
 *
 *   text    FOLLOW THE GLYPH — the default for a glow, because a halo in a
 *           colour the letter isn't reads as a second object rather than as
 *           light coming off this one. It also makes the effect scope itself
 *           with zero extra machinery: the renderer reads the colour off the
 *           glyph's RESOLVED style, so re-colouring a caption's focused word
 *           re-colours its glow without focus or range knowing this exists.
 *   custom  the pass's own `color`.
 *
 * It used to be `color: null`, which was the same fact encoded as an absence —
 * unkeyframeable, invisible to the registry's field vocabulary, and a second
 * spelling of the layer glow's `mode`. A discrete select is what the rest of
 * the app already says for this idea.
 */
export const textEffectSourceSchema = z.enum(["text", "custom"]);
export type TextEffectSource = z.infer<typeof textEffectSourceSchema>;

const textEffectBase = {
  /** Stable id — makes every field keyframe-addressable as `tfx.<id>.<field>`. */
  id: z.string(),
  enabled: z.boolean().default(true),
  source: textEffectSourceSchema.default("custom"),
  /** The pass's own colour; read only while `source` is `custom`. */
  color: z.string().default("#000000"),
  /** 0..1, multiplied into the pass. Distinct from the colour's own alpha. */
  opacity: z.number().min(0).max(1).default(1),
};

interface TextEffectBase {
  id: string;
  enabled: boolean;
  source: TextEffectSource;
  color: string;
  opacity: number;
}

export type TextEffect =
  | (TextEffectBase & { type: "shadow"; x: number; y: number; blur: number })
  | (TextEffectBase & { type: "glow"; radius: number; intensity: number })
  | (TextEffectBase & { type: "extrude"; angle: number; length: number })
  /**
   * Stepped COPIES of the glyph, spaced apart and fading with distance — a
   * trail. Not an extrude: an extrude is one solid face made of touching
   * steps, an echo is separate letters you can see between.
   */
  | (TextEffectBase & { type: "echo"; count: number; distance: number; angle: number; fade: number });

export const textEffectSchema: z.ZodType<TextEffect, z.ZodTypeDef, unknown> = z.discriminatedUnion("type", [
  z.object({
    ...textEffectBase,
    type: z.literal("shadow"),
    x: z.number().default(0),
    y: z.number().default(4),
    blur: z.number().min(0).default(8),
  }),
  z.object({
    ...textEffectBase,
    type: z.literal("glow"),
    radius: z.number().min(0).default(12),
    /** How many times the halo is laid down — brightness without a second pass. */
    intensity: z.number().min(0.1).max(4).default(1),
  }),
  z.object({
    ...textEffectBase,
    type: z.literal("extrude"),
    angle: z.number().default(45),
    length: z.number().min(0).default(20),
  }),
  z.object({
    ...textEffectBase,
    type: z.literal("echo"),
    count: z.number().int().min(1).max(12).default(4),
    distance: z.number().min(0).default(8),
    angle: z.number().default(45),
    /** 0 = every copy as strong as the first; 1 = the last copy vanishes. */
    fade: z.number().min(0).max(1).default(0.6),
  }),
]);

/**
 * WRITING ORIENTATION. `horizontal` is every line the app has ever laid out.
 * `vertical` stacks upright glyphs top-to-bottom, one per row, with lines
 * advancing RIGHT-TO-LEFT (the CJK convention, and the one Illustrator's
 * vertical type tool uses) — a display treatment, so Latin stays upright too
 * rather than turning on its side (that is a rotation, which the transform
 * already does). Mirroring is NOT a field here: the architecture says a mirror
 * is a negative scale and nothing else, so "flip vertically" is the transform's
 * flip beside this switch.
 */
export const textOrientationSchema = z.enum(["horizontal", "vertical"]);
export type TextOrientation = z.infer<typeof textOrientationSchema>;

export const textStyleSchema = z.object({
  // Bindable typography: a literal OR a `var:<id>` token — resolve through
  // `resolveTextStyle(doc, style)` before rendering/measuring.
  fontFamily: Bindable(z.string()),
  fontSize: Bindable(z.number().positive()),
  fontWeight: Bindable(z.number().int().min(100).max(1000)),
  /**
   * FAUX BOLD — extra ink laid over the glyph, as a fraction of the font size
   * per side (0.03 at 96px grows every edge by ~2.9px).
   *
   * Deliberately NOT the weight. `fontWeight` picks a FACE the foundry drew,
   * and a family only draws the weights it ships: Space Grotesk stops at 700,
   * so a Bold button that meant "700" did nothing on text that was already
   * 700. Faux bold is the design-app sense of the word (Photoshop's Faux
   * Bold): thickness ADDED to whatever weight is selected, on any family,
   * including one that ships a single weight. Relative to size so it survives
   * a size animation; keyframable so it can breathe.
   */
  fauxBold: z.number().min(0).max(0.25).default(0),
  italic: z.boolean(),
  color: z.string(),
  // Tracking is ALWAYS 0 unless explicitly set — a font swap must never leave a
  // stray spacing behind (Persian/Vazir looked compressed when it did).
  letterSpacing: z.number().default(0),
  lineHeight: z.number().positive(),
  /**
   * Where the letters sit in their line box (v117) — see `text/line-box.ts`.
   * `centered` puts the letters' own middle on the box's middle, from the
   * face's real metrics. `fixed` is the pre-v117 rule (0.78 em below the top,
   * whatever the font), stamped by the migration on text that was laid out
   * with it so no saved document moves.
   */
  baseline: z.enum(["fixed", "centered"]).default("centered"),
  align: textAlignSchema,
  /** Paragraph reading direction — default auto-detects from content. */
  direction: textDirectionSchema.default("auto"),
  /** Horizontal lines, or upright glyphs stacked in vertical columns (v73). */
  orientation: textOrientationSchema.default("horizontal"),
  /** Underline / strikethrough (default none). */
  decoration: textDecorationSchema.default("none"),
  /** Display-only case transform (default none). */
  textCase: textCaseSchema.default("none"),
  opacity: z.number().min(0).max(1),
  /** Background pill behind the text — kept single (also powers captions). */
  highlight: textHighlightSchema.nullable(),
  /**
   * Per-glyph passes (shadow / glow / extrude). Additive default, so every
   * existing document opens with none and nothing to migrate.
   */
  textEffects: z.array(textEffectSchema).default([]),
});
export type TextStyle = z.infer<typeof textStyleSchema>;

/** Every field optional — used for range overrides and caption highlight styles. */
export const partialTextStyleSchema = textStyleSchema.partial();
export type PartialTextStyle = z.infer<typeof partialTextStyleSchema>;
