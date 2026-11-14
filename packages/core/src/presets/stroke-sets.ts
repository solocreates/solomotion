import { z } from "zod";
import { createId } from "../ids";
import type { Preset } from "./library";
import { strokeStyle, type Paint } from "../schema/vector";
import {
  FLAT_WAVE,
  UNIFORM_PROFILE,
  CLEAN_EDGES,
  NO_SCATTER,
  ROUND_NIB,
  strokeRoughnessSchema,
  strokeScatterSchema,
  strokeNibSchema,
  strokeAlignSchema,
  strokeMarkerSchema,
  strokeProfileSchema,
  strokeWaveSchema,
  trimSpecSchema,
  type StrokeStyle,
} from "../schema/vector";

/**
 * STROKE SETS — the built-in scope of stroke presets.
 *
 * A stroke set is the PIPELINE without the paint: width, alignment, ends, dash,
 * trim, taper and wave. Colour is deliberately excluded, because a stroke style
 * is a claim about how a line is drawn, not what colour it is — applying
 * "Sketch" to a magenta stroke should leave it magenta. That is also what makes
 * one set reusable across a whole document.
 *
 * Sets ride the SAME preset library as effect presets, so "save this stroke for
 * this project / for every project", search, grouping and deletion all already
 * exist; this file only supplies the curated read-only scope.
 */

/**
 * Two namespaces, one engine.
 *
 *   `stroke`       ONE line. Offered on an individual stroke — you are changing
 *                  that stroke, so a preset that replaced the whole stack would
 *                  be answering a question you did not ask.
 *   `strokeStack`  a LIST of lines. Offered on the Stroke SECTION, because that
 *                  is the thing a stack replaces — and it is exactly what a
 *                  vector brush is, which is why brushes load straight in.
 *
 * A solo set is a stack of one, so everything below (preview, capture, apply)
 * is written once against the list and used for both.
 */
export const STROKE_PRESET_KIND = "stroke";
export const STROKE_STACK_PRESET_KIND = "strokeStack";

/** An ordered stack of lines — a layer's whole stroke list, or a brush's. */
export type StrokeStack = StrokeSet[];

/**
 * What a stroke set stores: everything about a line except its PAINT.
 *
 * Paint is excluded on purpose — a stroke style is a claim about how a line is
 * drawn, not what colour it is, so applying "Sketch" to a magenta stroke leaves
 * it magenta and one set is reusable across a whole document.
 *
 * It keeps an `id` because sets travel in LISTS (a brush draws a stack of them,
 * exactly as a layer carries a stack of strokes) and a list you can sort, key
 * and address needs stable identity. `applyStrokeSet` never copies it over — the
 * target keeps its own.
 */
export type StrokeSet = Omit<StrokeStyle, "paint" | "enabled" | "opacity" | "blendMode">;

/**
 * A stroke set as SCHEMA, so it can be stored in the document — which is what
 * lets a vector brush own one (`brush.vector.line`) instead of describing its
 * line a second time in its own vocabulary. That is the whole unification: a
 * brush IS a stroke set plus the input behaviour that turns a gesture into it.
 */
export const strokeSetSchema: z.ZodType<StrokeSet, z.ZodTypeDef, unknown> = z.object({
  id: z.string().default(() => createId("line")),
  width: z.number().min(0).default(2),
  /** The width the look was authored at (see `StrokeStyle.baseWidth`). Absent
   *  in pre-v61 saved brushes → null, i.e. the absolute-pixel behaviour they
   *  were designed under. */
  baseWidth: z.number().min(0).nullable().default(null),
  align: strokeAlignSchema.default("center"),
  cap: z.enum(["butt", "round", "square"]).default("butt"),
  join: z.enum(["miter", "round", "bevel"]).default("miter"),
  dash: z.array(z.number().min(0)).default([]),
  dashOffset: z.number().default(0),
  trim: trimSpecSchema.default({ start: 0, end: 1, offset: 0 }),
  offset: z.number().default(0),
  profile: strokeProfileSchema.default(UNIFORM_PROFILE),
  wave: strokeWaveSchema.default(FLAT_WAVE),
  roughness: strokeRoughnessSchema.default(CLEAN_EDGES),
  scatter: strokeScatterSchema.default(NO_SCATTER),
  nib: strokeNibSchema.default(ROUND_NIB),
  markers: z
    .object({ start: strokeMarkerSchema, end: strokeMarkerSchema })
    .default({ start: { kind: "none", size: 4 }, end: { kind: "none", size: 4 } }),
});

/** The default line: a plain 2px centred stroke. */
export function defaultStrokeSet(): StrokeSet {
  return set();
}

/** Lift the reusable half out of a live stroke (deep-copied — a saved set must
 *  not keep moving when the stroke it came from is edited). */
export function strokeSetFrom(s: StrokeStyle): StrokeSet {
  return {
    id: s.id,
    width: s.width,
    // A set IS a look, and a look is authored at a size — so the reference
    // travels with it. Without this, applying a 12px brush set would land on a
    // stroke still claiming it was designed at 2px, and the whole pipeline
    // would be scaled 6× on arrival.
    baseWidth: s.baseWidth,
    align: s.align,
    cap: s.cap,
    join: s.join,
    dash: [...s.dash],
    dashOffset: s.dashOffset,
    trim: { ...s.trim },
    offset: s.offset,
    profile: { ...s.profile },
    wave: { ...s.wave },
    roughness: { ...s.roughness },
    scatter: { ...s.scatter },
    nib: { ...s.nib },
    markers: { start: { ...s.markers.start }, end: { ...s.markers.end } },
  };
}

/** Apply a set to a stroke, keeping its identity, paint and compositing. */
export function applyStrokeSet(stroke: StrokeStyle, set: StrokeSet): StrokeStyle {
  const merged = strokeSetFrom({ ...stroke, ...set } as StrokeStyle);
  return { ...stroke, ...merged, id: stroke.id };
}

/** A stroke set as a live stroke, painted with `paint`. The seam a brush draws
 *  through: N sets in, N strokes out, and the result is an ordinary stroke
 *  stack the inspector can edit like any other. */
export function strokeFromSet(set: StrokeSet, paint: Paint): StrokeStyle {
  return { ...strokeStyle(paint), ...set, id: createId("stroke"), paint };
}

/** A complete set from a sparse patch — every field explicit, so switching sets
 *  is predictable and never inherits a stray value from the previous one. */
function set(patch: Partial<StrokeSet> = {}): StrokeSet {
  return {
    id: createId("line"),
    width: 2,
    baseWidth: patch.width ?? 2,
    align: "center",
    cap: "butt",
    join: "miter",
    dash: [],
    dashOffset: 0,
    trim: { start: 0, end: 1, offset: 0 },
    offset: 0,
    profile: { ...UNIFORM_PROFILE },
    wave: { ...FLAT_WAVE },
    roughness: { ...CLEAN_EDGES },
    scatter: { ...NO_SCATTER },
    nib: { ...ROUND_NIB },
    markers: { start: { kind: "none", size: 4 }, end: { kind: "none", size: 4 } },
    ...patch,
  };
}

function preset(id: string, name: string, group: string, chip: [string, string], data: StrokeSet, tags: string[]): Preset {
  // A saved set is IDENTITY-FREE, like every other preset in the library: the
  // line's own id belongs to the stroke it lives on, never to the look.
  return { id: `builtin:stroke-${id}`, kind: STROKE_PRESET_KIND, name, scope: "builtin", data: strokeSetPatch(data), chip, group, tags, createdAt: 0 };
}

/** A set as a PRESET payload — the look without the identity. */
export function strokeSetPatch(s: StrokeSet): Omit<StrokeSet, "id"> {
  const { id: _id, ...look } = s;
  return look;
}

const INK: [string, string] = ["#e8e8ea", "#7d7d86"];
const HAND: [string, string] = ["#f0d9b5", "#b98a4e"];
const TECH: [string, string] = ["#9fd4ff", "#4d8fd4"];
const DRY: [string, string] = ["#d8d2c8", "#6f6a62"];
const WET: [string, string] = ["#cbb8ff", "#6a4fd0"];
const SPRAY: [string, string] = ["#ffd9a8", "#c9762a"];

// ── Authoring the brush library ──────────────────────────────────────────────
//
// Each family is one stage of the pipeline doing the work, and the numbers are
// not interchangeable — they are what makes a pencil read as a pencil:
//
//   ROUGHNESS  `scale` is grain SIZE in px along the path. Small (4–6) reads as
//              tooth and grit; large (14–24) reads as a torn or hand-wobbled
//              edge. `spread` at 1 lets the two edges disagree (chewed, dry);
//              near 0 they move together and the line keeps its weight.
//              `erode` is how often the tip lifts — it BREAKS the ribbon, which
//              is the difference between "textured" and "dry".
//   NIB        the calligraphic family. `ratio` is thin/broad: 0.3 is a brush
//              pen, 0.1 a proper broad nib, 0.05 a blade. `angleDeg` is the
//              hand's angle and is what decides which strokes go thick.
//   SCATTER    `density` is dabs per 100px. Low + big + wide = confetti; high +
//              tiny + narrow = grain. `size` is a fraction of the stroke width,
//              so a spray scales with the line like everything else.
//   OFFSET     sideways displacement. One line offset is just a moved line —
//              the multi-line looks are STACKS, several sets at different
//              offsets, which is why they live in `STROKE_STACKS` below.
//
// Widths are authored for a ~1080px canvas and scale with the layer.

export const STROKE_SETS: Preset[] = [
  preset("hairline", "Hairline", "Basics", INK, set({ width: 1 }), ["thin", "line"]),
  preset("solid", "Solid", "Basics", INK, set({ width: 3, cap: "round", join: "round" }), ["plain"]),
  preset("bold", "Bold", "Basics", INK, set({ width: 10, cap: "round", join: "round" }), ["heavy", "thick"]),
  preset("inside", "Inset border", "Basics", INK, set({ width: 4, align: "inside", join: "round" }), ["border", "frame"]),

  preset("dashed", "Dashed", "Dashes", TECH, set({ width: 2, dash: [10, 6] }), ["dash"]),
  preset("dotted", "Dotted", "Dashes", TECH, set({ width: 4, cap: "round", dash: [0.01, 10] }), ["dot"]),
  preset("ants", "Marching ants", "Dashes", TECH, set({ width: 1.5, dash: [6, 4] }), ["selection", "dash", "loop"]),
  preset("dot-dash", "Dot dash", "Dashes", TECH, set({ width: 2, cap: "round", dash: [14, 5, 0.01, 5] }), ["technical", "cad"]),

  preset("arrow", "Arrow", "Ends", INK, set({ width: 3, cap: "round", markers: { start: { kind: "none", size: 4 }, end: { kind: "arrow", size: 4 } } }), ["pointer", "annotation"]),
  preset("double-arrow", "Double arrow", "Ends", INK, set({ width: 3, cap: "round", markers: { start: { kind: "arrow", size: 4 }, end: { kind: "arrow", size: 4 } } }), ["measure", "dimension"]),
  preset("line-arrow", "Line arrow", "Ends", INK, set({ width: 2.5, cap: "round", markers: { start: { kind: "none", size: 4 }, end: { kind: "arrow-line", size: 5 } } }), ["thin", "callout"]),
  preset("dot-to-arrow", "Dot to arrow", "Ends", INK, set({ width: 2.5, cap: "round", markers: { start: { kind: "circle", size: 2.5 }, end: { kind: "triangle", size: 4 } } }), ["callout", "leader"]),
  preset("dimension", "Dimension", "Ends", TECH, set({ width: 1.5, markers: { start: { kind: "bar", size: 4 }, end: { kind: "bar", size: 4 } } }), ["measure", "technical"]),

  preset("ink", "Ink taper", "Hand-drawn", HAND, set({
    width: 8, cap: "round", join: "round",
    profile: { startWidth: 0.1, endWidth: 0, startLength: 0.18, endLength: 0.45, ease: 0.5, samples: null },
  }), ["brush", "taper", "calligraphy"]),
  preset("sketch", "Sketch", "Hand-drawn", HAND, set({
    width: 2.5, cap: "round", join: "round",
    wave: { amplitude: 1.6, wavelength: 26, phase: 0, roughness: 1, seed: 3 },
  }), ["rough", "hand", "wobble"]),
  preset("brush", "Dry brush", "Hand-drawn", HAND, set({
    width: 12, cap: "round", join: "round",
    profile: { startWidth: 0.35, endWidth: 0.15, startLength: 0.3, endLength: 0.5, ease: 0.3, samples: null },
    // Now that edges can be roughened, the skip comes from EROSION rather than
    // from waving the centre line — a dry brush does not wander, it lifts.
    roughness: { amount: 1.6, scale: 9, spread: 0.9, erode: 0.3, seed: 11 },
  }), ["paint", "texture"]),
  preset("ribbon", "Ribbon", "Hand-drawn", HAND, set({
    width: 16, cap: "butt",
    profile: { startWidth: 0, endWidth: 0, startLength: 0.5, endLength: 0.5, ease: -0.4, samples: null },
  }), ["swell", "taper"]),
  preset("squiggle", "Squiggle", "Hand-drawn", HAND, set({
    width: 3, cap: "round", join: "round",
    wave: { amplitude: 7, wavelength: 22, phase: 0, roughness: 0, seed: 1 },
  }), ["wave", "wiggle", "fun"]),

  // ── Dry media. Fine grain, edges disagreeing, the tip lifting now and then.
  preset("pencil", "Pencil", "Dry media", DRY, set({
    width: 2.2, cap: "round", join: "round",
    roughness: { amount: 0.4, scale: 5, spread: 1, erode: 0.12, seed: 21 },
  }), ["graphite", "sketch", "fine"]),
  preset("graphite", "Graphite", "Dry media", DRY, set({
    width: 6, cap: "round", join: "round",
    profile: { startWidth: 0.6, endWidth: 0.4, startLength: 0.25, endLength: 0.35, ease: 0.2, samples: null },
    roughness: { amount: 1, scale: 8, spread: 1, erode: 0.22, seed: 33 },
  }), ["pencil", "shading", "soft"]),
  preset("charcoal", "Charcoal", "Dry media", DRY, set({
    width: 15, cap: "round", join: "round",
    roughness: { amount: 2.6, scale: 15, spread: 0.9, erode: 0.34, seed: 47 },
  }), ["smudge", "heavy", "expressive"]),
  preset("chalk", "Chalk", "Dry media", DRY, set({
    width: 11, cap: "butt", join: "round",
    roughness: { amount: 1.9, scale: 6, spread: 1, erode: 0.46, seed: 59 },
  }), ["pastel", "board", "broken"]),
  preset("crayon", "Crayon", "Dry media", DRY, set({
    width: 8, cap: "round", join: "round",
    roughness: { amount: 1.2, scale: 4, spread: 0.7, erode: 0.28, seed: 71 },
  }), ["wax", "kids", "grainy"]),

  // ── Ink. The nib does all the work: thick across, thin along.
  preset("calligraphy", "Calligraphy", "Ink", WET, set({
    width: 13, cap: "butt", join: "round",
    nib: { angleDeg: 45, ratio: 0.12 },
  }), ["nib", "italic", "lettering"]),
  preset("brush-pen", "Brush pen", "Ink", WET, set({
    width: 15, cap: "round", join: "round",
    nib: { angleDeg: 30, ratio: 0.35 },
    profile: { startWidth: 0.45, endWidth: 0.1, startLength: 0.2, endLength: 0.4, ease: 0.4, samples: null },
  }), ["marker", "lettering", "taper"]),
  preset("blade", "Blade", "Ink", WET, set({
    width: 18, cap: "butt", join: "miter",
    nib: { angleDeg: 0, ratio: 0.06 },
  }), ["flat", "sharp", "contrast"]),
  preset("signature", "Signature", "Ink", WET, set({
    width: 6, cap: "round", join: "round",
    nib: { angleDeg: 55, ratio: 0.3 },
    profile: { startWidth: 0.3, endWidth: 0, startLength: 0.12, endLength: 0.3, ease: 0.5, samples: null },
    roughness: { amount: 0.3, scale: 10, spread: 0.6, erode: 0, seed: 83 },
  }), ["handwriting", "script"]),

  // ── Spray. Dabs, not a line — density and size are the whole vocabulary.
  preset("stipple", "Stipple", "Spray", SPRAY, set({
    width: 12, scatter: { density: 30, size: 0.26, sizeJitter: 0.6, spread: 3, shape: "round", seed: 5 },
  }), ["dots", "shading", "print"]),
  preset("spray", "Spray", "Spray", SPRAY, set({
    width: 20, scatter: { density: 70, size: 0.16, sizeJitter: 0.9, spread: 8, shape: "round", seed: 13 },
  }), ["airbrush", "paint", "scatter"]),
  preset("grain", "Grain", "Spray", SPRAY, set({
    width: 10, scatter: { density: 110, size: 0.1, sizeJitter: 0.5, spread: 2, shape: "round", seed: 29 },
  }), ["noise", "texture", "fine"]),
  preset("confetti", "Confetti", "Spray", SPRAY, set({
    width: 22, scatter: { density: 12, size: 0.9, sizeJitter: 0.7, spread: 10, shape: "square", seed: 37 },
  }), ["party", "fun", "chunky"]),
  preset("speckle", "Speckle", "Spray", SPRAY, set({
    width: 14, scatter: { density: 42, size: 0.3, sizeJitter: 1, spread: 5, shape: "diamond", seed: 53 },
  }), ["fleck", "scatter", "organic"]),

  // ── Grunge. Coarse grain plus heavy erosion — torn rather than drawn.
  preset("torn", "Torn", "Grunge", DRY, set({
    width: 11, cap: "butt", join: "bevel",
    roughness: { amount: 3.2, scale: 22, spread: 1, erode: 0.18, seed: 97 },
  }), ["ripped", "paper", "edge"]),
  preset("eroded", "Eroded", "Grunge", DRY, set({
    width: 13, cap: "butt", join: "round",
    roughness: { amount: 1.6, scale: 9, spread: 1, erode: 0.58, seed: 101 },
  }), ["worn", "broken", "stamp"]),
  preset("distressed", "Distressed", "Grunge", DRY, set({
    width: 9, cap: "round", join: "round",
    roughness: { amount: 2.1, scale: 5, spread: 1, erode: 0.4, seed: 113 },
    wave: { amplitude: 1.2, wavelength: 34, phase: 0, roughness: 1, seed: 127 },
  }), ["punk", "photocopy", "rough"]),
];

/**
 * Builtin STACKS — looks that need more than one line, so they cannot be a
 * stroke set. Each entry is several sets at different `offset`s, which is
 * exactly what the layer's stroke list already is: applying one replaces the
 * stack, and every line in it stays independently editable afterwards.
 */
export const STROKE_STACKS: Preset[] = [
  stackPreset("double", "Double line", "Multi-line", TECH, [
    set({ width: 2, offset: 3 }),
    set({ width: 2, offset: -3 }),
  ], ["parallel", "rail", "outline"]),
  stackPreset("tram", "Tram lines", "Multi-line", TECH, [
    set({ width: 1.5, offset: 5 }),
    set({ width: 1.5, offset: -5 }),
    set({ width: 0.75, dash: [6, 6] }),
  ], ["road", "track", "technical"]),
  stackPreset("rail", "Rail", "Multi-line", TECH, [
    set({ width: 7, cap: "round", join: "round" }),
    set({ width: 1, offset: 4.5 }),
    set({ width: 1, offset: -4.5 }),
  ], ["highlight", "inline", "emboss"]),
  stackPreset("hatch", "Hatch", "Multi-line", TECH, [
    set({ width: 1, offset: 4, dash: [3, 5] }),
    set({ width: 1, offset: 0, dash: [3, 5], dashOffset: 2 }),
    set({ width: 1, offset: -4, dash: [3, 5], dashOffset: 4 }),
  ], ["shading", "engraving", "texture"]),
  // The classic "drawn twice" look: the same wobbly line laid down two and a
  // half times, each with its OWN seed so the strokes disagree the way a hand
  // does. One seed for all three would read as a printing error, not a sketch.
  stackPreset("sketch-pair", "Sketched twice", "Multi-line", HAND, [
    set({ width: 2, cap: "round", join: "round", roughness: { amount: 0.5, scale: 7, spread: 1, erode: 0.1, seed: 3 } }),
    set({ width: 1.6, cap: "round", join: "round", offset: 1.2, roughness: { amount: 0.6, scale: 9, spread: 1, erode: 0.2, seed: 17 } }),
    set({ width: 1, cap: "round", join: "round", offset: -1.6, trim: { start: 0.1, end: 0.85, offset: 0 }, roughness: { amount: 0.5, scale: 6, spread: 1, erode: 0.25, seed: 41 } }),
  ], ["hand", "doodle", "loose"]),
];

/** A stack preset — the same identity-free payload rule as a single set. */
function stackPreset(id: string, name: string, group: string, chip: [string, string], stack: StrokeStack, tags: string[]): Preset {
  return {
    id: `builtin:stack-${id}`,
    kind: STROKE_STACK_PRESET_KIND,
    name,
    scope: "builtin",
    data: stack.map(strokeSetPatch),
    chip,
    group,
    tags,
    createdAt: 0,
  };
}

/** Lift a layer's whole stroke list into a reusable stack. */
export function strokeStackFrom(strokes: readonly StrokeStyle[]): StrokeStack {
  return strokes.map(strokeSetFrom);
}

/** A stack as live strokes, each painted with `paint`. The seam BOTH a brush
 *  stroke and a "apply this stack" click go through. */
export function strokesFromStack(stack: readonly StrokeSet[], paint: Paint): StrokeStyle[] {
  return stack.map((s) => strokeFromSet(s, paint));
}

/**
 * Vector brushes, offered as stroke-stack presets.
 *
 * This is the payoff of the brush owning a stroke stack rather than describing
 * its line in private fields: the brush library needs no export format, no
 * converter and no second preview — its `lines` ARE the preset payload, so a
 * brush you designed in the studio is immediately a look you can drop onto any
 * shape, and a stack you liked on a shape can go back the other way.
 */
export function brushStackPresets(
  brushes: readonly { id: string; name: string; engine: string; vector: { lines: StrokeSet[] } }[],
): Preset[] {
  return brushes
    .filter((b) => b.engine === "vector")
    .map((b) => ({
      id: `brush:${b.id}`,
      kind: STROKE_STACK_PRESET_KIND,
      name: b.name,
      scope: "builtin" as const,
      data: b.vector.lines.map(strokeSetPatch),
      chip: null,
      group: "Vector brushes",
      tags: ["brush", "vector"],
      createdAt: 0,
    }));
}

// NOTE: there is deliberately no `strokeSetSource()` here. Builtins reach the
// app through the ONE `builtinPresetSource()` in `builtin-effects.ts`, which
// every preset surface already mounts; a second source for this one family
// would be a source the picker never asked — which is exactly what the unused
// one that used to sit here was.
