import { z } from "zod";
import { blendModeSchema, type BlendMode } from "./common";
import { layerEffectListSchema, type LayerEffect } from "./layer-effects";
import { graphViewSchema, type GraphView } from "./nodes";
import { subpathSchema } from "./vector";
import { trackShapeSchema } from "./tracking";

/**
 * COLOUR GRADING AS A NODE GRAPH (v77) — the stored model behind the Color page.
 *
 * ── THE ONE QUESTION THIS FILE ANSWERS FIRST ────────────────────────────────
 *
 * "Does the grade happen before or after the layer's effects?" It is a real
 * question — a grain pass wants to be graded, a glow wants to be added to an
 * already-graded plate — and every answer that picks one is wrong half the time.
 *
 * So the grade does not sit before or after the stack. IT IS AN ENTRY IN IT.
 * `effects/color.ts` carries a `grade` card whose payload is a graph id, so the
 * grade's position is the card's position: drag it above the glow, or below it,
 * in the list that already owns effect order. Nothing new to learn, nothing to
 * guess, no second ordering concept to disagree with the first. Grading the
 * whole composite instead is what adjustment layers are already for.
 *
 * ── WHY A GRAPH AND NOT A LONGER CARD ───────────────────────────────────────
 *
 * Grading is 10% maths and 90% CHOOSING PIXELS. A flat card can hold the maths
 * and can never hold the choosing: it has nowhere to say "this correction, only
 * on the skin tones, only inside this moving window, and this other correction
 * on everything the first one did not take". That is what a node carrying BOTH
 * an image and a KEY expresses, and it is the actual reason Resolve's page is
 * the professional standard.
 *
 * ── WHAT IS REUSED, DELIBERATELY ────────────────────────────────────────────
 *
 * A corrector's payload is a `LayerEffect[]` — the SAME union every layer's
 * stack holds. So `colorGrade`, `gradientMap`, `posterize`, blur, sharpen and
 * every future card work inside a node on day one; they keyframe through the
 * existing `lfx.<id>.<field>` paths; they preset through the existing library;
 * they render through the existing pass registry. A node adds a KEY and a
 * COMPOSITE around an effect stack. It does not add a second effect system.
 *
 * A power window's geometry is `subpathSchema` — the same contours the pen tool
 * draws and the tracker follows. Promoting a drawn window to a tracked one is
 * therefore a change of source, not a conversion.
 */

// ── The key: how a node chooses its pixels ───────────────────────────────────

/**
 * One axis of the HSL qualifier, as a soft band.
 *
 * Centre + width + two soft shoulders, for all three axes including the linear
 * ones. Low/high reads more naturally for saturation than centre/width does —
 * and then the hue axis, which is circular, needs a different shape, and the
 * picker needs two controls, and the two drift. One shape, three instances, one
 * control: the shoulders are what make a qualifier usable at all, and they are
 * the part a low/high model keeps forgetting to grow.
 *
 * Units are the axis's own: degrees for hue (wrapping), 0..1 for sat and lum.
 */
export const qualifierBandSchema = z.object({
  enabled: z.boolean().default(true),
  center: z.number(),
  width: z.number().min(0),
  /** Ramp below the band where the weight falls from 1 to 0. */
  softLow: z.number().min(0).default(0),
  /** Ramp above the band. */
  softHigh: z.number().min(0).default(0),
});
export type QualifierBand = z.infer<typeof qualifierBandSchema>;

/**
 * The HSL qualifier — a per-pixel key from colour alone. Disabled by default:
 * a node with no qualifier and no window grades everything, which is what a
 * fresh node should do.
 */
export const gradeQualifierSchema = z.object({
  enabled: z.boolean().default(false),
  hue: qualifierBandSchema.default({ enabled: true, center: 30, width: 40, softLow: 12, softHigh: 12 }),
  sat: qualifierBandSchema.default({ enabled: true, center: 0.5, width: 0.5, softLow: 0.1, softHigh: 0.1 }),
  lum: qualifierBandSchema.default({ enabled: true, center: 0.5, width: 0.5, softLow: 0.1, softHigh: 0.1 }),
});
export type GradeQualifier = z.infer<typeof gradeQualifierSchema>;

/**
 * A DEPTH band — near/far isolation, Resolve's Depth Map in one control.
 *
 * The band is stored here and the MAP is not: a depth estimate is a per-frame
 * analysis over pixels, the same shape of work as a track, so it arrives
 * through a provider seam (`grade/depth.ts`) with a CPU/ML backend chosen at
 * runtime, exactly like `TrackerEngine`. Storing the band separately means the
 * document is tiny and portable, and swapping in a better estimator re-keys
 * every existing grade for free.
 *
 * `near`/`far` are normalised: 0 = closest surface in frame, 1 = furthest.
 */
export const gradeDepthSchema = z.object({
  enabled: z.boolean().default(false),
  near: z.number().min(0).max(1).default(0),
  far: z.number().min(0).max(1).default(0.5),
  /** Ramp at both ends of the band, in the same normalised units. */
  softness: z.number().min(0).max(1).default(0.08),
  invert: z.boolean().default(false),
});
export type GradeDepth = z.infer<typeof gradeDepthSchema>;

/** A static window's placement — the pose its contour is drawn with. */
export const windowTransformSchema = z.object({
  x: z.number().default(0),
  y: z.number().default(0),
  scale: z.number().positive().default(1),
  /** Vertical scale; null = locked to `scale`. */
  scaleY: z.number().positive().nullable().default(null),
  rotation: z.number().default(0),
});
export type WindowTransform = z.infer<typeof windowTransformSchema>;

/**
 * Where a power window's silhouette and motion come from.
 *
 *   shape    drawn here, posed by `transform` — keyframable like any property.
 *   tracker  borrowed whole from a `doc.trackers` entry, contour AND motion.
 *
 * Two arms rather than "a shape plus an optional tracker id", because a tracked
 * window has no pose of its own to keyframe: the tracker's samples ARE the pose,
 * and a second stored pose beside them is the two-fields-one-fact defect. The
 * UI's "Track this window" is a promotion between the arms, seeding the tracker
 * from the drawn contour, so nothing is lost crossing over.
 */
export const windowSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("shape"),
    /** Which tool drew it — provenance, shared with the tracker's own vocabulary. */
    shape: trackShapeSchema.default("ellipse"),
    /** Contour in FRAME space, centred on the origin (multiply by `transform`). */
    subpaths: z.array(subpathSchema).min(1),
    transform: windowTransformSchema.default({}),
  }),
  z.object({ type: z.literal("tracker"), trackerId: z.string() }),
  /**
   * A DEPTH BAND (Tracking 3): everything of the footage between `near` and
   * `far` (depth 0..1 across the shot, 0 the nearest) — Resolve's depth-map
   * window. `softness` rolls the band's edges off, in depth. A raster matte,
   * not a contour: it follows whatever stands at that depth, frame by frame.
   */
  z.object({
    type: z.literal("depth"),
    trackerId: z.string(),
    near: z.number().min(0).max(1).default(0),
    far: z.number().min(0).max(1).default(0.4),
    softness: z.number().min(0).max(0.5).default(0.05),
  }),
]);
export type WindowSource = z.infer<typeof windowSourceSchema>;

/** One power window. A node may carry any number; they combine in list order. */
export const powerWindowSchema = z.object({
  id: z.string(),
  name: z.string().default("Window"),
  enabled: z.boolean().default(true),
  source: windowSourceSchema,
  /** Edge softness in frame px. */
  feather: z.number().min(0).default(12),
  /** Grow (+) / choke (−) in frame px, before the feather. */
  expand: z.number().default(0),
  invert: z.boolean().default(false),
  /** How this window folds into the ones before it. */
  combine: z.enum(["union", "intersect", "subtract"]).default("union"),
});
export type PowerWindow = z.infer<typeof powerWindowSchema>;

/**
 * How an INCOMING key wire meets the matte a node builds for itself.
 *
 * `replace` plus `invert` is Resolve's beloved "outside node" — grade everything
 * the upstream node did not take — expressed as two ordinary fields instead of a
 * special node kind that has to be explained.
 */
export const keyInputModeSchema = z.enum(["ignore", "replace", "intersect", "union", "subtract"]);
export type KeyInputMode = z.infer<typeof keyInputModeSchema>;

export const gradeKeySchema = z.object({
  qualifier: gradeQualifierSchema.default({}),
  depth: gradeDepthSchema.default({}),
  windows: z.array(powerWindowSchema).default([]),
  input: keyInputModeSchema.default("intersect"),
  /** Flip the finished matte. */
  invert: z.boolean().default(false),
  /** Matte refinement, after everything combines. */
  blurPx: z.number().min(0).default(0),
  /** Shrink (+) / grow (−) the finished matte, in frame px. */
  shrinkPx: z.number().default(0),
});
export type GradeKey = z.infer<typeof gradeKeySchema>;

/** A key that selects everything — the fast path the compiler skips work for. */
export const NEUTRAL_KEY: GradeKey = {
  qualifier: {
    enabled: false,
    hue: { enabled: true, center: 30, width: 40, softLow: 12, softHigh: 12 },
    sat: { enabled: true, center: 0.5, width: 0.5, softLow: 0.1, softHigh: 0.1 },
    lum: { enabled: true, center: 0.5, width: 0.5, softLow: 0.1, softHigh: 0.1 },
  },
  depth: { enabled: false, near: 0, far: 0.5, softness: 0.08, invert: false },
  windows: [],
  input: "intersect",
  invert: false,
  blurPx: 0,
  shrinkPx: 0,
};

// ── Nodes ────────────────────────────────────────────────────────────────────

export const gradeNodeKindSchema = z.enum(["source", "corrector", "mixer", "output"]);

const gradeNodeBase = {
  id: z.string(),
  x: z.number(),
  y: z.number(),
  /** User-facing label. Resolve names nodes and people rely on it heavily. */
  name: z.string().default(""),
  /**
   * Bypass. An ordinary DISCRETE animatable property, not a UI flag — the eye
   * IS a keyframable value everywhere else in this app, and a grade you can
   * switch on at a beat is worth more than one you cannot.
   */
  enabled: z.boolean().default(true),
  collapsed: z.boolean().default(false),
};

interface GradeNodeBase {
  id: string;
  x: number;
  y: number;
  name: string;
  enabled: boolean;
  collapsed: boolean;
}

/** The plate — whatever the effect stack handed the grade. Exactly one. */
export interface SourceNode extends GradeNodeBase {
  kind: "source";
}
/** The result. Exactly one; what it reads is what gets drawn. */
export interface OutputNode extends GradeNodeBase {
  kind: "output";
}
export interface CorrectorNode extends GradeNodeBase {
  kind: "corrector";
  /** The correction — an ordinary layer-effect stack. See the file header. */
  effects: LayerEffect[];
  key: GradeKey;
  /** How the corrected pixels composite back over this node's own input. */
  blend: BlendMode;
  opacity: number;
}
export interface MixerNode extends GradeNodeBase {
  kind: "mixer";
  /**
   * `layer` composites its inputs bottom-to-top honouring each corrector's own
   * blend and opacity (Resolve's Layer Mixer). `parallel` averages them, which
   * is what you want when two qualifiers each took part of the frame and
   * neither should win where they overlap.
   */
  mix: "layer" | "parallel";
}

/**
 * A node. Discriminated on `kind`, so a mixer cannot carry an effect stack and a
 * corrector cannot carry a mix mode — the fields that exist are the fields that
 * mean something.
 *
 * The TYPES are hand-written and the schema is annotated with them, rather than
 * the usual `z.infer`. A corrector holds a `LayerEffect[]`, and the `grade` card
 * is itself a `LayerEffect`, so the two are mutually recursive: left to
 * inference, TypeScript expands the whole thirty-arm effect union inside itself
 * and the declaration emitter falls over (TS7056 — the same wall
 * `layerEffectListSchema` exists to hold back). Naming both sides keeps the
 * emitted declarations to a reference.
 */
export const gradeNodeSchema: z.ZodType<GradeNode, z.ZodTypeDef, unknown> = z.discriminatedUnion("kind", [
  z.object({ ...gradeNodeBase, kind: z.literal("source") }),
  z.object({ ...gradeNodeBase, kind: z.literal("output") }),
  z.object({
    ...gradeNodeBase,
    kind: z.literal("corrector"),
    effects: z.lazy(() => layerEffectListSchema),
    key: gradeKeySchema.default({}),
    blend: blendModeSchema.default("normal"),
    opacity: z.number().min(0).max(1).default(1),
  }),
  z.object({
    ...gradeNodeBase,
    kind: z.literal("mixer"),
    mix: z.enum(["layer", "parallel"]).default("layer"),
  }),
]) as z.ZodType<GradeNode, z.ZodTypeDef, unknown>;

export type GradeNode = SourceNode | OutputNode | CorrectorNode | MixerNode;
export type GradeNodeKind = GradeNode["kind"];

// ── Wires ────────────────────────────────────────────────────────────────────

/**
 * Two wire kinds, and that is the whole reason this graph is more than a list:
 * `rgb` carries the picture, `key` carries a matte. A key output wired into a
 * downstream key input is how one node's selection becomes another's — the move
 * a stack of cards can never make.
 */
export const gradePortKindSchema = z.enum(["rgb", "key"]);
export type GradePortKind = z.infer<typeof gradePortKindSchema>;

export const gradePortSchema = z.object({
  node: z.string(),
  port: gradePortKindSchema,
  /** Which slot, on nodes that take several (a mixer). 0 everywhere else. */
  index: z.number().int().min(0).default(0),
});
export type GradePort = z.infer<typeof gradePortSchema>;

export const gradeEdgeSchema = z.object({
  id: z.string(),
  from: gradePortSchema,
  to: gradePortSchema,
});
export type GradeEdge = z.infer<typeof gradeEdgeSchema>;

// ── The graph ────────────────────────────────────────────────────────────────

/**
 * A grade graph LIVES ON ITS CARD (`effects/color.ts`'s `grade` arm), not in a
 * document table, and that is worth defending because the first draft did the
 * opposite.
 *
 * A table would have meant the graph is reachable only through the document, and
 * every animatable value inside it — a node's opacity, a qualifier's hue centre,
 * a window's rotation — would have needed a keyframe path the clip-scoped path
 * resolver cannot follow. Living on the card, every one of them rides the
 * `lfx.<cardId>.…` grammar that already exists, with no plumbing at all. It also
 * means a grade travels with its clip through copy, paste, duplicate, slice,
 * merge and property-transfer for free, and that deleting the card is the whole
 * of deleting the grade — no orphan sweep, no lifetime rule.
 *
 * The thing a table would have bought is SHARING one look across many clips.
 * That want is real and it already has a better answer than a mutable shared
 * tree: a preset. Copying a grade is also what every colourist expects, because
 * it is what every grading application does.
 */
export interface GradeGraph {
  id: string;
  name: string;
  nodes: GradeNode[];
  edges: GradeEdge[];
  /** Saved board camera; null = fit on open. */
  view: GraphView | null;
}

export const gradeGraphSchema: z.ZodType<GradeGraph, z.ZodTypeDef, unknown> = z.object({
  id: z.string(),
  name: z.string().default("Grade"),
  nodes: z.array(gradeNodeSchema).default([]),
  edges: z.array(gradeEdgeSchema).default([]),
  view: graphViewSchema.nullable().default(null),
}) as z.ZodType<GradeGraph, z.ZodTypeDef, unknown>;

/** The preset kind grade graphs register under in the existing preset library. */
export const GRADE_PRESET_KIND = "grade";
