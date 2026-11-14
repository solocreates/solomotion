import { z } from "zod";
import { createId } from "../ids";
import { defaultStrokeSet, strokeSetSchema, type StrokeSet } from "../presets/stroke-sets";
import { blendModeSchema } from "../schema/common";
import { GRAIN_TEXTURES } from "./grain";
import { DEFAULT_WET } from "./watercolor";
import { DEFAULT_TIP_PARAMS, TIP_KINDS } from "./tips";

/**
 * The brush model — Procreate-grade, but DATA. A `BrushPreset` fully describes
 * a brush across both engines: how its tip stamps (raster) or how its stroke
 * fits into an editable path (vector). The Brush Studio edits this object, the
 * stroke engine consumes it, and the account-level brush store persists it —
 * three surfaces, one schema, zero per-brush code.
 *
 * Brushes are ACCOUNT-level (they follow the artist, not the project), so this
 * schema versions independently of the document. Factory presets are editable
 * IN PLACE and resettable: the library stores an override beside the frozen
 * original rather than forcing a duplicate, so "make the pencil softer" is one
 * slider and one Reset, not a second brush called "6B Pencil copy".
 */

export const BRUSH_SCHEMA_VERSION = 3;

export const brushEngineSchema = z.enum(["raster", "vector"]);
/** Which layer kind a brush paints into: raster → pixel layers, vector → paths. */
export type BrushEngine = z.infer<typeof brushEngineSchema>;

/**
 * Studio grouping — the shelves the picker's sidebar is built from, and the
 * only fixed taxonomy in the model. Everything finer ("Dry media", "Foliage")
 * is a free-text `group`, because a library that grows by preset needs a label
 * that grows with it and adding an enum case per idea is how an enum goes bad.
 */
export const brushFamilySchema = z.enum([
  "sketching",
  "inking",
  "painting",
  "airbrushing",
  "calligraphy",
  "texture",
  "artistic",
  "elements",
  "abstract",
  "retouch",
  "vector",
]);
export type BrushFamily = z.infer<typeof brushFamilySchema>;

/** Shelf headings for the families, in picker order. */
export const FAMILY_LABEL: Record<BrushFamily, string> = {
  sketching: "Sketching",
  inking: "Inking",
  painting: "Painting",
  airbrushing: "Airbrushing",
  calligraphy: "Calligraphy",
  texture: "Textures",
  artistic: "Artistic",
  elements: "Elements",
  abstract: "Abstract",
  retouch: "Retouch",
  vector: "Vector",
};

export const BRUSH_FAMILIES = Object.keys(FAMILY_LABEL) as BrushFamily[];

/**
 * The tip: what one dab looks like.
 *
 * `type` names a PROCEDURAL STENCIL (see `drawing/tips`) — round, chisel,
 * bristle, spray, grit … — or `image` for an uploaded PNG/SVG (or a captured
 * layer) whose alpha becomes the stamp. Procedural is the default and the
 * reason this library can ship eighty brushes without shipping a single
 * bitmap: a stencil is crisp at any size, tints to any colour, and costs one
 * sprite bake per (brush, colour) no matter how intricate it is.
 */
/**
 * ONE entry in a tip's source set — a stamp the brush can draw from.
 *
 * `assetId` is an opaque blob-store id, and that opacity is the feature: a
 * project asset, an uploaded SVG, and a layer captured straight off the canvas
 * are the same thing to a brush. So "make a brush out of that shape I just
 * drew" needs no new plumbing — it needs a capture that writes a blob.
 */
export const brushTipSourceSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  /** Relative pick weight. Two entries at 1 and 3 land 25% / 75% of the time. */
  weight: z.number().min(0).max(8).default(1),
});
export type BrushTipSource = z.infer<typeof brushTipSourceSchema>;

/**
 * Fold a single-image tip forward into the source LIST.
 *
 * A tip was one bitmap, and one bitmap is a rubber stamp: forty identical
 * leaves in a row is what gives a stamp brush away instantly. A weighted list
 * is the same feature scaled — one entry behaves exactly as before, and a
 * scatter of six captured shapes becomes a particle brush with no second code
 * path anywhere in the engine or the painter.
 */
const foldLegacyTip = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object") return raw;
  const v = { ...(raw as Record<string, unknown>) };
  if (Array.isArray(v.sources)) return v;
  v.sources =
    typeof v.imageId === "string" && v.imageId
      ? [{ id: `tipsrc_${v.imageId}`, assetId: v.imageId, weight: 1 }]
      : [];
  return v;
};

export const brushShapeSchema = z.preprocess(foldLegacyTip, z.object({
  // EVERY field in the brush tree carries a default (this enum included), so
  // `{}` — or a wholly omitted sub-object — always parses. That invariant is
  // what lets createBrushPreset seed from patches and lets future schema
  // fields land without touching a single preset or migration.
  type: z.enum([...TIP_KINDS, "image"]).default("round"),
  /** 0 = fully feathered airbrush edge, 1 = hard circle. */
  hardness: z.number().min(0).max(1).default(0.9),
  /** Tip squash: 1 = circular, →0 = a sliver (calligraphy nibs). */
  roundness: z.number().min(0.05).max(1).default(1),
  /** Tip rotation in degrees (fixed component). */
  angle: z.number().default(0),
  /** Rotate the tip to follow the stroke direction (nibs, rakes). */
  followStroke: z.boolean().default(false),
  /** How many marks the stencil is made of — bristles, spray dots, hatches. */
  density: z.number().min(0).max(1).default(DEFAULT_TIP_PARAMS.density),
  /** How far those marks spread from the tip's centre. */
  spread: z.number().min(0).max(1).default(DEFAULT_TIP_PARAMS.spread),
  /** How broken / uneven the mark is — the difference between ink and chalk. */
  irregular: z.number().min(0).max(1).default(DEFAULT_TIP_PARAMS.irregular),
  /** Point count for the geometric stencils (polygon, sparkle). */
  sides: z.number().int().min(3).max(12).default(DEFAULT_TIP_PARAMS.sides),
  /**
   * The stencil's deal of the cards. Same seed = same tip, forever, in the
   * painter and in a test; nudging it in the studio deals a new bristle
   * arrangement instead of forcing a new brush.
   */
  seed: z.number().int().default(1),
  /**
   * THE STAMPS this tip draws from — a weighted set, read only when
   * `type === "image"`. Empty falls back to the procedural round tip; one entry
   * is an ordinary image brush; several make a PARTICLE brush that deals a
   * different stamp per dab (leaves, petals, debris, sparks).
   *
   * A list rather than a field because the second stamp must not cost a second
   * code path: the engine picks an index, the painter bakes a sprite per index,
   * and nothing else in the pipeline knows how many there are.
   */
  sources: z.array(brushTipSourceSchema).default([]),
  /** Legacy single-bitmap tip; folded into `sources` at parse time. */
  imageId: z.string().nullable().default(null),
}));
export type BrushShape = z.infer<typeof brushShapeSchema>;

/**
 * Paper grain multiplied into the stroke's alpha. `moving` grain travels with
 * the stroke (smooth charcoal); anchored grain sticks to the canvas (true
 * paper texture — dabs reveal the same pattern wherever they land).
 *
 * `texture` names a generated field (`drawing/grain`); `imageId` overrides it
 * with an uploaded tile. Generated is the default for the same reason the tips
 * are: nine textures × a seed is a folder of paper that weighs nothing.
 */
export const brushGrainSchema = z.object({
  texture: z.enum(GRAIN_TEXTURES).default("paper"),
  imageId: z.string().nullable().default(null),
  scale: z.number().min(0.1).max(8).default(1),
  /** 0 = no grain, 1 = grain fully gates the paint. */
  intensity: z.number().min(0).max(1).default(0),
  moving: z.boolean().default(false),
  seed: z.number().int().default(1),
});
export type BrushGrain = z.infer<typeof brushGrainSchema>;

/**
 * The stroke path: how samples become dab positions. Spacing is in fractions
 * of the current dab size (0.05 = airbrush-continuous, 1+ = stamp chains).
 * `streamline` is the Procreate stabilizer — input chases a smoothed point.
 * Taper pulls size/opacity to zero over the stroke's first/last N px.
 */
export const brushStrokePathSchema = z.object({
  // The floor is 0.01, not 0.02: a bristle rake needs its hairs to STREAK, and
  // a streak is stamps overlapping by ~98%. At 0.02 the hairs resolve into
  // separate dots at large sizes, which is the difference between an oil brush
  // and a polka-dot generator.
  spacing: z.number().min(0.01).max(4).default(0.12),
  streamline: z.number().min(0).max(1).default(0.35),
  /** Random positional offset per dab, in dab-size fractions. */
  jitter: z.number().min(0).max(4).default(0),
  /** Perpendicular scatter per dab, in dab-size fractions. */
  scatter: z.number().min(0).max(4).default(0),
  /** Taper lengths in surface px (0 = blunt ends). */
  taperStartPx: z.number().min(0).max(400).default(0),
  taperEndPx: z.number().min(0).max(400).default(0),
});
export type BrushStrokePath = z.infer<typeof brushStrokePathSchema>;

// ── Dynamics: ONE modulation list ───────────────────────────────────────────

/**
 * What a modulation drives. Multiplicative targets (size … grain) scale the
 * value the brush would otherwise have; additive targets (angle … lightness)
 * offset it. The split is per-target and fixed, because "50% of an angle" is
 * meaningless while "50% of a size" is the only thing it could mean.
 */
export const modTargetSchema = z.enum([
  "size",
  "opacity",
  "flow",
  "roundness",
  "grain",
  "angle",
  "scatter",
  "jitter",
  "hue",
  "saturation",
  "lightness",
]);
export type BrushModTarget = z.infer<typeof modTargetSchema>;

/**
 * Where the signal comes from. `random` is fresh per dab; `strokeT` runs 0→1
 * along the stroke; `time` is seconds since the stroke began. Those three are
 * what make a brush feel ALIVE while you draw — a foliage stamp that rotates
 * and recolours per dab, a ribbon that fades along its length — and they are
 * deliberately drawing-time only: a stroke, once laid down, is pixels.
 */
export const modSourceSchema = z.enum([
  "pressure",
  "tilt",
  "velocity",
  "direction",
  "random",
  "strokeT",
  "time",
]);
export type BrushModSource = z.infer<typeof modSourceSchema>;

/**
 * ONE modulation: a signal, a destination, an amount.
 *
 * This replaced four hard-coded fields (`sizePressure`, `opacityPressure`,
 * `sizeVelocity`, `sizeTilt`), and the replacement is the whole reason the
 * factory pack can exist. Those fields could express a pencil and nothing
 * else: no angle-from-direction (calligraphy), no size-from-random (foliage,
 * spatter), no hue-from-random (confetti, autumn leaves), no fade-along-stroke
 * (ribbons, comet trails). Every one of those is a brush people expect, and a
 * fifth, sixth and seventh named field would have been the same mistake at
 * greater cost — the list is what makes the eighth free.
 */
export const brushModSchema = z.object({
  id: z.string(),
  target: modTargetSchema,
  source: modSourceSchema,
  /**
   * −1…1. Magnitude is depth; SIGN inverts the signal, so "thinner when fast"
   * and "thicker when fast" are one control rather than two sources.
   */
  amount: z.number().min(-1).max(1).default(1),
  /** Response shaping: <1 reacts early (soft touch), >1 late (firm touch). */
  gamma: z.number().min(0.1).max(4).default(1),
  /** Floor for a multiplicative target — a feather touch still marks. */
  floor: z.number().min(0).max(1).default(0),
});
export type BrushMod = z.infer<typeof brushModSchema>;

/** A modulation from a sparse patch (the pack's and the studio's constructor). */
export function brushMod(
  target: BrushModTarget,
  source: BrushModSource,
  amount = 1,
  patch: Partial<Pick<BrushMod, "gamma" | "floor">> = {},
): BrushMod {
  return { id: createId("mod"), target, source, amount, gamma: 1, floor: 0, ...patch };
}

/**
 * Fold a v1 brush's four named dynamics into the modulation list, so a library
 * saved before this change opens as the same brush rather than a flat one.
 * A parse-time preprocess rather than a document migration, because brushes
 * live in the account's library file — the same reason `brushLibrarySchema`
 * carries its own version.
 */
const foldLegacyDynamics = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object") return raw;
  const v = { ...(raw as Record<string, unknown>) };
  if (Array.isArray(v.mods)) return v;
  const num = (k: string, d = 0) => (typeof v[k] === "number" ? (v[k] as number) : d);
  const mods: BrushMod[] = [];
  const push = (target: BrushModTarget, source: BrushModSource, amount: number, floor: number) => {
    if (Math.abs(amount) > 0.001) mods.push(brushMod(target, source, amount, { floor }));
  };
  push("size", "pressure", num("sizePressure", 0.9), num("minSize", 0.15));
  push("opacity", "pressure", num("opacityPressure", 0.6), num("minOpacity", 0.05));
  push("size", "velocity", -num("sizeVelocity"), 0.2);
  push("size", "tilt", num("sizeTilt"), 0);
  for (const k of ["sizePressure", "opacityPressure", "sizeVelocity", "sizeTilt", "minSize", "minOpacity"]) {
    delete v[k];
  }
  v.mods = mods;
  return v;
};

/**
 * Dynamics: everything that makes a dab differ from the one before it.
 *
 * Only ONE scalar survives as a field, because it is not a modulation: `flow` is
 * how much paint one stamp lays down, where opacity is the ceiling the stroke
 * builds toward. Everything else is in `mods`.
 */
export const brushDynamicsSchema = z.preprocess(foldLegacyDynamics, z.object({
  mods: z.array(brushModSchema).default([]),
  /** Per-dab paint build-up (opacity caps the stroke; flow fills it in). */
  flow: z.number().min(0.01).max(1).default(1),
}));
export type BrushDynamics = z.infer<typeof brushDynamicsSchema>;

/**
 * How the stroke composites onto the layer while painting.
 *
 * `stamp` is the one that decides what a brush IS, and it is the difference
 * between a marker and an airbrush:
 *
 *  • `uniform` — the stroke is assembled in its own buffer at full strength
 *    and composited ONCE at the brush's opacity. Overlapping yourself inside
 *    one stroke changes nothing, so a 30%-opacity wash stays even. This is
 *    what airbrushes, washes and highlighters need.
 *  • `glaze` — every stamp composites separately, so paint accumulates where
 *    the stroke crosses itself and where dabs overlap. This is what markers,
 *    inks and dry media need: going over a line twice makes it darker, which
 *    is the entire feel of a real marker.
 */
/**
 * WET MEDIA — the brush paints into a live water film instead of onto pixels.
 *
 * This is a different INSTRUMENT, not a stronger setting, which is why it is a
 * block with an `enabled` rather than one more slider. A wet brush's marks keep
 * moving after the stroke ends: they flow, they bleed into each other, and they
 * dry — on their own, on command, or under the drying fan. The simulation lives
 * in `drawing/watercolor`; these are the numbers a brush hands it.
 */
export const brushWetSchema = z.object({
  enabled: z.boolean().default(false),
  /** How much WATER each dab carries, separately from how much pigment. A
   *  loaded wash runs; a thirsty brush stains where it touches and stops. */
  wetness: z.number().min(0).max(1).default(0.8),
  flow: z.number().min(0).max(1).default(DEFAULT_WET.flow),
  evaporation: z.number().min(0.0005).max(0.08).default(DEFAULT_WET.evaporation),
  granulation: z.number().min(0).max(1).default(DEFAULT_WET.granulation),
  edge: z.number().min(0).max(1).default(DEFAULT_WET.edge),
  deposition: z.number().min(0.005).max(0.5).default(DEFAULT_WET.deposition),
  texture: z.enum(GRAIN_TEXTURES).default(DEFAULT_WET.texture),
});
export type BrushWet = z.infer<typeof brushWetSchema>;

/**
 * Fold the old `wetEdge` scalar into the real wet block.
 *
 * `wetEdge` was a number nothing read — a promise of watercolour with no
 * watercolour behind it. A brush that asked for one now gets the simulation,
 * with that number as its edge strength.
 */
const foldLegacyWet = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object") return raw;
  const v = { ...(raw as Record<string, unknown>) };
  if (v.wet && typeof v.wet === "object") {
    delete v.wetEdge;
    return v;
  }
  const legacy = typeof v.wetEdge === "number" ? v.wetEdge : 0;
  delete v.wetEdge;
  if (legacy > 0) v.wet = { enabled: true, edge: Math.min(1, legacy) };
  return v;
};

/**
 * How the stroke composites onto the layer while painting.
 *
 * `stamp` is the one that decides what a brush IS, and it is the difference
 * between a marker and an airbrush:
 *
 *  • `uniform` — the stroke is assembled in its own buffer at full strength
 *    and composited ONCE at the brush's opacity. Overlapping yourself inside
 *    one stroke changes nothing, so a 30%-opacity wash stays even. This is
 *    what airbrushes, washes and highlighters need.
 *  • `glaze` — every stamp composites separately, so paint accumulates where
 *    the stroke crosses itself and where dabs overlap. This is what markers,
 *    inks and dry media need: going over a line twice makes it darker, which
 *    is the entire feel of a real marker.
 */
export const brushRenderingSchema = z.preprocess(foldLegacyWet, z.object({
  blend: blendModeSchema.default("normal"),
  stamp: z.enum(["uniform", "glaze"]).default("uniform"),
  /** Erase instead of paint (an eraser IS a brush with this flag). */
  erase: z.boolean().default(false),
  wet: brushWetSchema.default({}),
}));
export type BrushRendering = z.infer<typeof brushRenderingSchema>;

/**
 * Fold a LEGACY vector brush forward: its cap/join lived beside the fit
 * settings, both of which the stroke stack now owns. Done as a parse-time
 * preprocess rather than a document migration because brushes live in the
 * account's own library file, not in the document — the same reason
 * `brushLibrarySchema` carries its own version.
 */
const foldLegacyVector = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object") return raw;
  const v = { ...(raw as Record<string, unknown>) };
  if (Array.isArray(v.lines) || v.line) return v;
  const cap = typeof v.cap === "string" ? v.cap : "round";
  const join = typeof v.join === "string" ? v.join : "round";
  delete v.cap;
  delete v.join;
  v.lines = [{ ...defaultStrokeSet(), cap, join }];
  return v;
};

export const brushVectorSchema = z.preprocess(foldLegacyVector, z.object({
  /**
   * THE LINES this brush draws — a STACK of the same `StrokeSet` a shape's
   * stroke carries, in the same bottom-to-top order.
   *
   * This is the unification. A vector brush and a layer's stroke were always
   * the same object described twice: the brush said "taper 14px, round cap" in
   * its own fields, the stroke said "taper 20%, round cap" in its, and neither
   * could express the other's dash, trim, wave or arrowheads. Now the brush
   * OWNS a stroke set, the studio and the stroke editor render the same
   * registry over it, and a brush you save appears in the stroke-set picker
   * because it is one.
   *
   * A LIST rather than one line, because a brush that lays down a dark core
   * inside a soft halo, or an ink line beside its own dry-brush shadow, is a
   * stack — the same thing a layer already carries. Making it singular now
   * would mean discovering that later and migrating every saved brush. One
   * entry is the ordinary case and costs nothing.
   *
   * Drawing turns each set into a real stroke on the emitted path clip, so a
   * multi-stroke brush produces a multi-stroke LAYER: whatever you drew stays
   * editable in the inspector with the identical controls that authored it.
   *
   * What stays outside the stack — fit tolerance, pressure response,
   * auto-close, straighten — is about turning a GESTURE into a line, which a
   * shape's stroke has no gesture to do.
   */
  lines: z.array(strokeSetSchema).min(1).default(() => [defaultStrokeSet()]),
  /** Curve-fit tolerance in px — higher = fewer anchors, smoother result. */
  fitTolerance: z.number().min(0.5).max(20).default(2.5),
  /**
   * Pressure → variable width. Off: a uniform-width STROKED path (cleanest to
   * edit). On: the stroke becomes a FILLED outline path whose width follows
   * pressure (expressive, still a path).
   */
  variableWidth: z.boolean().default(false),
  /** How much pressure modulates the width when variableWidth is on. */
  widthPressure: z.number().min(0).max(1).default(0.8),
  /**
   * Width floor as a fraction of the base size — the vector twin of
   * `dynamics.minSize`, so a feather-light pass still leaves a visible line
   * instead of collapsing the outline to nothing.
   */
  minWidth: z.number().min(0).max(1).default(0.15),
  /**
   * Close the outline when the stroke ends near where it began, within this
   * many px (0 = never). Lets a loop drawn in one gesture become a real closed,
   * fillable shape instead of a path with a hairline seam.
   */
  autoClosePx: z.number().min(0).max(120).default(0),
  /**
   * Snap near-straight runs to true straight segments (px of allowed deviation,
   * 0 = off). The "clean up my line art" pass — Illustrator's smooth tool, done
   * at fit time rather than as a separate command.
   */
  straightenPx: z.number().min(0).max(40).default(0),
}));
export type BrushVector = z.infer<typeof brushVectorSchema>;

export const brushPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  family: brushFamilySchema.default("painting"),
  /**
   * Free-text shelf heading in the picker ("Dry media", "Spray"). Optional and
   * purely organisational — `family` is the fixed taxonomy, but a library that
   * grows by preset needs a label that grows with it, and adding a case to an
   * enum every time someone coins a category is how a fixed enum becomes wrong.
   */
  group: z.string().optional(),
  engine: brushEngineSchema.default("raster"),
  /** Frozen factory brush — duplicate to customize. */
  builtIn: z.boolean().default(false),
  /** Base size in surface px (the size slider multiplies from here). */
  size: z.number().min(1).max(600).default(12),
  /** Base opacity 0..1. */
  opacity: z.number().min(0.01).max(1).default(1),
  // Sub-objects default WHOLESALE (their every field self-defaults, so `{}`
  // is a complete value): a stored preset from an older library version — or
  // a terse patch — parses into a fully-populated brush, always.
  shape: brushShapeSchema.default({}),
  grain: brushGrainSchema.default({}),
  strokePath: brushStrokePathSchema.default({}),
  dynamics: brushDynamicsSchema.default({}),
  rendering: brushRenderingSchema.default({}),
  vector: brushVectorSchema.default({}),
});
export type BrushPreset = z.infer<typeof brushPresetSchema>;

/** One line of a brush's stack, from a sparse patch. */
function brushLine(patch: Partial<StrokeSet>): StrokeSet {
  return { ...defaultStrokeSet(), ...patch };
}

/**
 * What a preset can be BUILT from: the schema's input, sparse at every level.
 *
 * Not `Partial<BrushPreset>` — that is the OUTPUT type, where every sub-object
 * is complete, so seeding a brush with `{ shape: { hardness: 1 } }` would not
 * typecheck even though it is exactly what the schema's defaults exist for.
 */
export type BrushPresetPatch = Partial<z.input<typeof brushPresetSchema>>;

/**
 * A preset from a sparse patch — the studio's "New brush" seed and the
 * factory set's constructor. Everything omitted default-fills through the
 * schema (see the wholesale sub-object defaults above).
 */
export function createBrushPreset(patch: BrushPresetPatch & { name: string }): BrushPreset {
  return brushPresetSchema.parse({ id: createId("brush"), ...patch });
}

/** Deep-copy a preset into an editable custom brush ("Duplicate" in the studio). */
export function duplicateBrushPreset(source: BrushPreset): BrushPreset {
  return {
    ...structuredClone(source),
    id: createId("brush"),
    name: `${source.name} copy`,
    builtIn: false,
  };
}

/**
 * The account-level brush library file (localStorage/IDB payload).
 *
 * Three lists, and the split is the whole persistence model:
 *
 *  • `customBrushes` — brushes the artist MADE. They exist nowhere else.
 *  • `overrides` — factory brushes the artist EDITED, stored whole beside the
 *    frozen original. Editing a factory brush in place (rather than forcing a
 *    duplicate) is what people actually want — "make the pencil softer" is not
 *    a new brush — and keeping the original means Reset is deleting a key, and
 *    the picker can badge what has been touched without storing a flag that
 *    could disagree with the fact.
 *  • `folders` — the artist's own shelves, holding ids of ANY brush, factory
 *    or custom. A brush can sit in several; a folder owns no brush.
 */
export const brushFolderSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Lucide icon name — the sidebar's, chosen from a fixed palette in the UI. */
  icon: z.string().default("folder"),
  brushIds: z.array(z.string()).default([]),
});
export type BrushFolder = z.infer<typeof brushFolderSchema>;

export const brushLibrarySchema = z.object({
  version: z.number().int().positive(),
  customBrushes: z.array(brushPresetSchema).default([]),
  overrides: z.record(z.string(), brushPresetSchema).default({}),
  folders: z.array(brushFolderSchema).default([]),
  /** Ordering of ALL brush ids as the picker shows them (built-ins included). */
  order: z.array(z.string()).default([]),
});
export type BrushLibrary = z.infer<typeof brushLibrarySchema>;
