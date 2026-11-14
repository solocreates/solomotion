import { z } from "zod";
import { blendModeSchema, type BlendMode } from "./common";
import { createId } from "../ids";

/**
 * Vector primitives — the data behind shape and path clips. Everything here is
 * deliberately plain and numeric so the keyframe engine can address any of it
 * by path ("width", "radius.tl", "stroke.<id>.width", "fill.<id>", …) and host
 * adapters can rebuild the geometry without a browser.
 *
 * A vector carries an ORDERED LIST of fills and of strokes (Figma model): each
 * entry is self-describing — a stable `id` (so its every value is keyframe-
 * addressable as `fill.<id>.…`), its own `opacity`, and its own `blendMode`
 * (how it composites over the entries beneath it within the layer).
 */

/** Parametric shape kinds. Anything beyond these is a `path` clip. */
export const shapeKindSchema = z.enum(["rect", "ellipse", "polygon", "star"]);
export type ShapeKind = z.infer<typeof shapeKindSchema>;

/** Per-corner radii, Figma-style (rect). Uniform = all four equal. */
export const cornerRadiusSchema = z.object({
  tl: z.number().min(0).default(0),
  tr: z.number().min(0).default(0),
  br: z.number().min(0).default(0),
  bl: z.number().min(0).default(0),
});
export type CornerRadius = z.infer<typeof cornerRadiusSchema>;

export const strokeAlignSchema = z.enum(["center", "inside", "outside"]);
export type StrokeAlign = z.infer<typeof strokeAlignSchema>;

/**
 * Paint — what fills or strokes a vector (or text). Solid keeps the plain color
 * slot (literal or `var:` token); gradients carry id-stable stops so every
 * stop's offset and color is keyframe-addressable (`fill.stop.<id>.color`, …).
 *
 * GRADIENT GEOMETRY IS UNIFIED. Every gradient — linear, radial, angular — is
 * described by the SAME two points in the paint box's normalized space (0..1
 * across the bounds, {0,0} = top-left): `start` and `end`. What the two points
 * mean is the only thing the type changes:
 *   linear   the ramp runs start → end (position + angle + length in one).
 *   radial   `start` is the center, `end` sits on the outer edge (radius).
 *   angular  `start` is the center, start → end is the 0° sweep direction.
 * This is why one on-stage handle rig drives all three (see gradient-handles),
 * and why a type switch keeps its geometry.
 */
export const gradientStopSchema = z.object({
  id: z.string(),
  offset: z.number().min(0).max(1),
  color: z.string(),
});
export type GradientStop = z.infer<typeof gradientStopSchema>;

/** A point in the paint box's normalized space (0..1 across the bounds). */
export const gradientPointSchema = z.object({ x: z.number(), y: z.number() });
export type GradientPoint = z.infer<typeof gradientPointSchema>;

/** The two normalized handle points every gradient shares. */
const gradientGeometryFields = {
  stops: z.array(gradientStopSchema).min(2),
  start: gradientPointSchema.default({ x: 0, y: 0.5 }),
  end: gradientPointSchema.default({ x: 1, y: 0.5 }),
};

/** The gradient types — a plain list so the UI and switches stay in sync. */
export const GRADIENT_TYPES = ["linear", "radial", "angular"] as const;
export type GradientType = (typeof GRADIENT_TYPES)[number];

/**
 * Fields every paint/stroke ENTRY carries as a member of its layer's list.
 * `id` makes the entry keyframe-addressable (`fill.<id>.color`, …); `opacity`
 * and `blendMode` are how it composites over the entries below it.
 */
const paintEntryFields = {
  id: z.string(),
  /**
   * Visibility, Figma's eye toggle. A DISTINCT fact from `opacity: 0`: hiding a
   * paint must not destroy the opacity you dialled, and un-hiding must bring it
   * back — which a single opacity field cannot express. Defaults true, so every
   * legacy paint loads visible with nothing to migrate.
   */
  enabled: z.boolean().default(true),
  opacity: z.number().min(0).max(1).default(1),
  blendMode: blendModeSchema.default("normal"),
};

/**
 * MEDIA paint (v42) — an image/video paint, so any layer can be filled with
 * footage (Figma image fills) and a media clip's own footage is just its bottom
 * fill. `source.self` draws the HOST clip's footage (reusing the proven per-kind
 * media draw); `source.asset` draws any imported asset, usable on any layer.
 * `fit` frames it (Figma Fill/Fit/Crop/Tile); `focus` is the 0..1 focal point
 * used when the fitted media overflows the box; `adjust` is an optional per-fill
 * grade sharing the `adjust` layer effect's knobs (absent = none, zero cost).
 */
// NOTE: these leaf schemas carry EXPLICIT type annotations (not `z.infer`). The
// paint union feeds every visual clip → track → document, and adding media/
// pattern pushed the document's inferred type past TS's serialization limit.
// Annotating the leaves caps inference depth here so the document type stays
// serializable — keep the annotation in sync when a field changes.
export type MediaFit = "cover" | "contain" | "fill" | "tile";
export const mediaFitSchema: z.ZodType<MediaFit> = z.enum(["cover", "contain", "fill", "tile"]);

export type MediaSource = { type: "self" } | { type: "asset"; assetId: string };
export const mediaSourceSchema: z.ZodType<MediaSource> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("self") }),
  z.object({ type: z.literal("asset"), assetId: z.string() }),
]);

/** Per-fill image grade — the SAME knobs as the `adjust` layer effect, so both
 *  reuse one CSS-filter builder. Optional on a media paint (absent = neutral). */
export interface MediaAdjust {
  brightness: number;
  contrast: number;
  saturate: number;
  hueDeg: number;
  grayscale: number;
  sepia: number;
}
export const mediaAdjustSchema: z.ZodType<MediaAdjust, z.ZodTypeDef, unknown> = z.object({
  brightness: z.number().min(0).default(1),
  contrast: z.number().min(0).default(1),
  saturate: z.number().min(0).default(1),
  hueDeg: z.number().default(0),
  grayscale: z.number().min(0).max(1).default(0),
  sepia: z.number().min(0).max(1).default(0),
});

/**
 * PATTERN paint — a procedural, tiling fill, and the reason this is a FLAT
 * record with a `kind` tag rather than a discriminated union per kind.
 *
 * A union looked right until the second kind arrived: nine arms each restating
 * `color`, `background`, `spacing`, and each needing its own keyframe path, its
 * own scalar table entry and its own line in every switch that touches a
 * pattern. Worse for the person using it — switching stripes to dots threw away
 * the spacing and the angle they had just dialled, because the new arm had no
 * field to receive them.
 *
 * Flat, the fields are shared vocabulary: `spacing` is the period, `thickness`
 * is how much of it is painted, whatever the kind. Switching kinds KEEPS what
 * you dialled and simply re-reads it. One scalar table, one keyframe path
 * scheme (`fill.<id>.pattern.<field>`), one field registry driving the studio,
 * and adding a kind touches the registry and the tile builder — nothing else.
 *
 * Which fields a kind actually uses is the registry's answer (`PATTERN_FIELDS`,
 * with `showIf`), not the type's, exactly as an effect declares its own fields.
 */
export const PATTERN_KINDS = [
  "stripes",
  "grid",
  "checks",
  "dots",
  "squares",
  "cross",
  "triangles",
  "zigzag",
  "waves",
  "noise",
  "image",
] as const;
export type PatternKind = (typeof PATTERN_KINDS)[number];

export interface PatternSpec {
  kind: PatternKind;
  // ── The lattice ──
  /** Multiplies every length below. THE size knob, and the one to keyframe. */
  scale: number;
  /** Rotation of the whole tiling, degrees. */
  angleDeg: number;
  /** Phase in px — keyframe either to scroll the pattern under the shape. */
  offsetX: number;
  offsetY: number;
  /** Tile height over tile width. 1 is square; squash to stretch the lattice. */
  aspect: number;
  // ── The marks ──
  /** The period: stripe pitch, dot pitch, check size, one wavelength. */
  spacing: number;
  /** How much of the period is painted: bar width, dot diameter, line weight. */
  thickness: number;
  /** Corner rounding of square-edged marks, 0..1. */
  roundness: number;
  /** Shifts alternate rows — 0 is a square lattice, 0.5 a brick/hex one. */
  stagger: number;
  /** Wave/zigzag height; doubles as noise contrast. */
  amplitude: number;
  /** Random displacement of each mark, 0..1 — seeded, never re-rolled. */
  jitter: number;
  seed: number;
  // ── The paint ──
  /** The mark colour. Takes a `var:` token like any other colour slot. */
  color: string;
  /** Behind the marks. Fully transparent = the layers below show through. */
  background: string;
  /** `kind: "image"` — an asset in the document's library. */
  assetId: string;
}

export const patternSpecSchema: z.ZodType<PatternSpec, z.ZodTypeDef, unknown> = z.object({
  kind: z.enum(PATTERN_KINDS).default("stripes"),
  scale: z.number().min(0.02).max(40).default(1),
  angleDeg: z.number().default(45),
  offsetX: z.number().default(0),
  offsetY: z.number().default(0),
  aspect: z.number().min(0.1).max(10).default(1),
  spacing: z.number().min(1).default(20),
  thickness: z.number().min(0).default(10),
  roundness: z.number().min(0).max(1).default(0),
  stagger: z.number().min(0).max(1).default(0),
  amplitude: z.number().min(0).default(0.5),
  jitter: z.number().min(0).max(1).default(0),
  seed: z.number().int().min(0).default(1),
  color: z.string().default("#1E1E1E"),
  background: z.string().default("#FFFFFF"),
  assetId: z.string().default(""),
});

/** A pattern with every field at its default — the ONE place a new pattern's
 *  starting values live, so the constructor, the studio's reset and a kind
 *  switch cannot each invent their own. */
export function defaultPatternSpec(kind: PatternKind = "stripes"): PatternSpec {
  return {
    kind,
    scale: 1,
    angleDeg: 45,
    offsetX: 0,
    offsetY: 0,
    aspect: 1,
    spacing: 20,
    thickness: 10,
    roundness: 0,
    stagger: 0,
    amplitude: 0.5,
    jitter: 0,
    seed: 1,
    color: "#1E1E1E",
    background: "#FFFFFF",
    assetId: "",
  };
}

/** Fields every paint entry shares (see `paintEntryFields`). */
interface PaintEntry {
  id: string;
  enabled: boolean;
  opacity: number;
  blendMode: BlendMode;
}
export type SolidPaint = PaintEntry & { type: "solid"; color: string };
export type GradientPaint = PaintEntry & {
  type: GradientType;
  stops: GradientStop[];
  start: GradientPoint;
  end: GradientPoint;
};
export type MediaPaint = PaintEntry & {
  type: "media";
  source: MediaSource;
  fit: MediaFit;
  focus: GradientPoint;
  tileScale: number;
  adjust?: MediaAdjust;
};
export type PatternPaint = PaintEntry & { type: "pattern"; pattern: PatternSpec };
/**
 * A paint that IS a document variable — Figma's fill styles, and the arm that
 * lets a gradient or a pattern be a reusable, renameable, one-edit-updates-
 * everything thing instead of a copy on every layer.
 *
 * It carries the ordinary entry fields, and that is the whole design: the
 * VARIABLE owns the look (its stops, its pattern, its colour), the ENTRY owns
 * how this layer composites it (`enabled`, `opacity`, `blendMode`). Two layers
 * can share one gradient and still fade independently, which is exactly what a
 * shared style is for and what storing the opacity on the variable would make
 * impossible.
 *
 * It is an arm of the paint union rather than a `variableId?` field on every
 * paint, because a paint is EITHER its own look or a reference to one, never
 * both — and a nullable field on all five other arms is precisely the "unlikely
 * rather than unrepresentable" illegal state that grows a bug.
 */
export type VariablePaint = PaintEntry & {
  type: "variable";
  variableId: string;
  /**
   * LOCAL OVERRIDES — what this entry changed about the style it links to.
   *
   * A link used to be all-or-nothing: take the style exactly, or break it and
   * own a dead copy. That is the wrong shape for a fill. The reason you reach
   * for a shared gradient is its COLOURS, and the reason you tune it here is
   * its angle — so "inherit everything except the two things I moved" is the
   * ordinary case, not an edge case, and the old model could not say it.
   *
   * Sparse and keyed by the SAME paint sub-paths the keyframe engine already
   * addresses (`start.x`, `stop.<id>.color`, `pattern.spacing`, …), so this
   * introduces no second addressing scheme and no second writer: overriding a
   * property IS `setPaintProperty` landing on a reference instead of a look.
   *
   * Sparse is what makes it a link and not a copy — a property you never
   * touched keeps following the style forever, so recolouring the palette still
   * recolours this fill. And because the keys are paths, an override for a
   * property the style no longer has (the style became a pattern) simply stops
   * applying rather than corrupting anything: nothing to migrate, nothing to
   * clean up.
   *
   * Absent when nothing is overridden, so a plain link carries no empty object
   * into every saved file.
   */
  overrides?: Record<string, string | number>;
};
/** The unified paint union. Explicitly typed (not `z.infer`) so the document's
 *  inferred type stays under TS's serialization limit — see the leaf-schema note. */
export type Paint = SolidPaint | GradientPaint | MediaPaint | PatternPaint | VariablePaint;

export const paintSchema: z.ZodType<Paint, z.ZodTypeDef, unknown> = z.discriminatedUnion("type", [
  z.object({ ...paintEntryFields, type: z.literal("solid"), color: z.string() }),
  z.object({ ...paintEntryFields, type: z.literal("linear"), ...gradientGeometryFields }),
  z.object({ ...paintEntryFields, type: z.literal("radial"), ...gradientGeometryFields }),
  z.object({ ...paintEntryFields, type: z.literal("angular"), ...gradientGeometryFields }),
  z.object({
    ...paintEntryFields,
    type: z.literal("media"),
    source: mediaSourceSchema,
    fit: mediaFitSchema.default("cover"),
    focus: gradientPointSchema.default({ x: 0.5, y: 0.5 }),
    /** Tile scale (fit === "tile") — 1 = the media's intrinsic size. */
    tileScale: z.number().min(0.01).default(1),
    adjust: mediaAdjustSchema.optional(),
  }),
  z.object({ ...paintEntryFields, type: z.literal("pattern"), pattern: patternSpecSchema }),
  z.object({
    ...paintEntryFields,
    type: z.literal("variable"),
    variableId: z.string(),
    overrides: z.record(z.union([z.string(), z.number()])).optional(),
  }),
]);

/** True for any of the gradient paint types (they share geometry + stops). Every
 *  "not solid ⇒ gradient" shortcut MUST route through this now that media/pattern
 *  also live in the union. */
export function isGradientPaint(paint: Paint): paint is GradientPaint {
  return paint.type === "linear" || paint.type === "radial" || paint.type === "angular";
}

/** The everyday paint: one flat color, full opacity, normal blend. */
export function solidPaint(color: string): Paint {
  return { id: createId("paint"), type: "solid", color, enabled: true, opacity: 1, blendMode: "normal" };
}

/** A gradient paint with default left→right geometry — the shared constructor. */
export function gradientPaint(
  type: GradientType,
  stops: GradientStop[],
  geom?: { start?: GradientPoint; end?: GradientPoint },
): Paint {
  return {
    id: createId("paint"),
    type,
    enabled: true,
    opacity: 1,
    blendMode: "normal",
    stops,
    start: geom?.start ?? (type === "linear" ? { x: 0, y: 0.5 } : { x: 0.5, y: 0.5 }),
    end: geom?.end ?? { x: 1, y: 0.5 },
  };
}

/** A media paint (image/video fill). `source` defaults to the host clip's own
 *  footage — the seed fill every image/video clip carries. */
export function mediaPaint(
  source: MediaSource = { type: "self" },
  opts: Partial<Pick<MediaPaint, "fit" | "focus" | "tileScale" | "adjust" | "opacity" | "blendMode">> = {},
): Paint {
  return {
    id: createId("paint"),
    type: "media",
    source,
    fit: opts.fit ?? "cover",
    focus: opts.focus ?? { x: 0.5, y: 0.5 },
    tileScale: opts.tileScale ?? 1,
    ...(opts.adjust ? { adjust: opts.adjust } : {}),
    enabled: true,
    opacity: opts.opacity ?? 1,
    blendMode: opts.blendMode ?? "normal",
  };
}

/** The everyday pattern paint — a diagonal two-tone stripe until dialed. */
export function patternPaint(pattern?: PatternSpec): Paint {
  return {
    id: createId("paint"),
    type: "pattern",
    pattern: pattern ?? defaultPatternSpec(),
    enabled: true,
    opacity: 1,
    blendMode: "normal",
  };
}

/** Every color a pattern references (feeds variable scanning + previews). */
export function patternColors(pattern: PatternSpec): string[] {
  return [pattern.color, pattern.background];
}

/**
 * Every color a paint references (variable scanning, previews). Media paints
 * carry no color slot, and a VARIABLE paint deliberately carries none either —
 * its colours belong to the variable, and reporting them here would count one
 * shared gradient once per layer that uses it, turning the usage numbers and
 * the "selection colors" list into nonsense. Resolve first if you want them.
 */
export function paintColors(paint: Paint): string[] {
  switch (paint.type) {
    case "solid":
      return [paint.color];
    case "pattern":
      return patternColors(paint.pattern);
    case "media":
    case "variable":
      return [];
    default:
      return paint.stops.map((s) => s.color);
  }
}

/** A paint that points at a document variable. The one constructor, so binding
 *  a fill to a style never restates the entry fields by hand. */
export function variablePaint(
  variableId: string,
  opts: Partial<Pick<PaintEntry, "enabled" | "opacity" | "blendMode">> = {},
): Paint {
  return {
    id: createId("paint"),
    type: "variable",
    variableId,
    enabled: opts.enabled ?? true,
    opacity: opts.opacity ?? 1,
    blendMode: opts.blendMode ?? "normal",
  };
}

/**
 * Trim paths (After Effects): draw only the arc-length window [start, end] of
 * the outline, rotated by `offset` turns (wraps around closed shapes). All
 * three are keyframe paths — 0→100% stroke reveals.
 *
 * Trim belongs to a STROKE, not to the layer. It used to sit on the vector clip
 * (one window shared by every stroke), which made the signature move of the
 * medium — two or three strokes chasing each other around one shape — simply
 * unrepresentable, and duplicated "how much of the outline is drawn" in two
 * places once strokes became a list. One stroke, one window.
 */
export const trimSpecSchema = z.object({
  start: z.number().min(0).max(1).default(0),
  end: z.number().min(0).max(1).default(1),
  offset: z.number().default(0),
});
export type TrimSpec = z.infer<typeof trimSpecSchema>;

/**
 * Stroke ENDPOINT decoration (Figma's stroke endpoints, SVG's markers): the
 * arrow/dot/bar that caps an open path. A named `kind` plus a `size` in
 * MULTIPLES OF THE STROKE WIDTH — so a marker stays proportional when the width
 * is animated, which a pixel size would not.
 *
 * Kinds are a plain list because they are drawn by one table-driven builder
 * (`markerCommands`): a new arrowhead is one entry there, never a new field
 * here and never a switch in the renderer.
 */
export const STROKE_MARKER_KINDS = [
  "none",
  "arrow",
  "arrow-line",
  "chevron",
  "triangle",
  "circle",
  "square",
  "diamond",
  "bar",
] as const;
export type StrokeMarkerKind = (typeof STROKE_MARKER_KINDS)[number];

export interface StrokeMarker {
  kind: StrokeMarkerKind;
  /** Length/width of the head, in multiples of the stroke width. */
  size: number;
}
export const strokeMarkerSchema: z.ZodType<StrokeMarker, z.ZodTypeDef, unknown> = z.object({
  kind: z.enum(STROKE_MARKER_KINDS).default("none"),
  size: z.number().min(0).default(4),
});

/**
 * Stroke PROFILE — width along the length of the line (After Effects' taper,
 * Illustrator's width profile, the reason a hand-drawn line reads as drawn).
 * Widths are FRACTIONS of the stroke's `width`; lengths are fractions of the
 * drawn arc length that the taper occupies.
 *
 * The LENGTHS default to the two halves (0.5 / 0.5), not to zero, so the widths
 * alone say everything: `{1, 1}` is a uniform line and dropping `startWidth` to
 * 0 grows the stroke out of a point. A zero-length default would have made the
 * width knob silently do nothing until a second knob was found — the kind of
 * dead control that teaches people a feature is broken.
 *
 * Identity is `{1, 1, 0.5, 0.5, 0}`, and the renderer takes its fast native-
 * stroke path whenever the profile is identity, so this costs nothing unused.
 */
export interface StrokeProfile {
  startWidth: number;
  endWidth: number;
  startLength: number;
  endLength: number;
  /** −1 (ease into the taper) … 0 (linear) … 1 (ease out of it). */
  ease: number;
  /**
   * A MEASURED width curve — evenly spaced multipliers along the line, and the
   * reason a pressure-drawn brush stroke stays editable.
   *
   * A pen's pressure is arbitrary per-sample data that four taper numbers
   * cannot describe, so the vector brush used to bake it into a filled outline
   * and the stroke stopped being a stroke: no width slider, no colour swap, no
   * dash, no trim, and no way back. Storing the curve instead keeps the layer a
   * centre line with a live stroke, so everything you can do to a stroke you
   * can still do to something you drew.
   *
   * `null` (the default) means "use the taper numbers" — the ordinary case,
   * with nothing stored and nothing to interpolate.
   */
  samples: number[] | null;
}
export const strokeProfileSchema: z.ZodType<StrokeProfile, z.ZodTypeDef, unknown> = z.object({
  startWidth: z.number().min(0).max(4).default(1),
  endWidth: z.number().min(0).max(4).default(1),
  startLength: z.number().min(0).max(1).default(0.5),
  endLength: z.number().min(0).max(1).default(0.5),
  ease: z.number().min(-1).max(1).default(0),
  samples: z.array(z.number().min(0)).nullable().default(null),
});

/**
 * Stroke WAVE — displaces the centre line along its own normal (After Effects'
 * Wiggly Paths / Zig Zag). `roughness` blends the wave from a clean sine (0) to
 * a seeded, hand-wobbled line (1); `phase` is in turns, so keyframing it alone
 * crawls the wave along the stroke. Amplitude 0 = off, and the sampler is
 * skipped entirely.
 */
export interface StrokeWave {
  amplitude: number;
  wavelength: number;
  phase: number;
  roughness: number;
  seed: number;
}
export const strokeWaveSchema: z.ZodType<StrokeWave, z.ZodTypeDef, unknown> = z.object({
  amplitude: z.number().min(0).default(0),
  wavelength: z.number().min(1).default(40),
  phase: z.number().default(0),
  roughness: z.number().min(0).max(1).default(0),
  seed: z.number().int().min(0).default(1),
});

/**
 * Stroke ROUGHNESS — the two edges of the ribbon wobble INDEPENDENTLY.
 *
 * This is the difference between a squiggle and dry media, and it is why
 * `wave` cannot do it: `wave` displaces the CENTRE LINE, so both edges move
 * together and the line stays the same weight all the way along — a clean rope
 * following a wiggly route. A pencil, a charcoal stick or a dry brush does the
 * opposite: its route is steady and its EDGES are ragged, because the tip only
 * touches some of the tooth of the paper.
 *
 * `spread` is what selects between those two readings. At 0 both edges share
 * one noise field (the ribbon breathes, keeping its weight); at 1 each edge
 * gets its own (the line is chewed). `scale` is the grain size in px along the
 * path — small is gritty, large is a lazy hand-drawn wobble.
 *
 * `erode` pinches the ribbon shut where the noise falls below it, so the stroke
 * BREAKS into islands. That is what makes a dry brush skip and a torn edge
 * tear, and it is deliberately part of roughness rather than a stage of its
 * own: both are the same question — how much of the tip is touching.
 */
export interface StrokeRoughness {
  amount: number;
  scale: number;
  spread: number;
  erode: number;
  seed: number;
}
export const strokeRoughnessSchema: z.ZodType<StrokeRoughness, z.ZodTypeDef, unknown> = z.object({
  /** Edge displacement in px. 0 = perfectly clean edges, and the sampler is skipped. */
  amount: z.number().min(0).default(0),
  /** Grain size: px along the path per noise cycle. */
  scale: z.number().min(0.5).default(12),
  /** 0 = both edges share the noise, 1 = each edge is its own. */
  spread: z.number().min(0).max(1).default(1),
  /** Pinch the ribbon shut below this noise level — 0 solid, 1 mostly gaps. */
  erode: z.number().min(0).max(0.95).default(0),
  seed: z.number().int().min(0).default(1),
});

/**
 * Stroke SCATTER — stamp discrete dabs along the path instead of drawing a
 * continuous ribbon. The whole spray/stipple/grain family, and the one stage
 * that changes the SHAPE of the plan: the result is many small filled marks,
 * not one outline, so it comes back in the plan's `ribbon` slot as a single
 * multi-contour path that fills in one call.
 *
 * `density` is dabs per 100px so a preset reads the same on a short letter and
 * a long swash — a per-dab spacing would make every look depend on how big the
 * artwork happened to be. Jitter fields are seeded, so a scattered stroke is
 * stable frame to frame and only crawls when you animate the seed.
 */
export const SCATTER_SHAPES = ["round", "square", "diamond"] as const;
export type ScatterShape = (typeof SCATTER_SHAPES)[number];

export interface StrokeScatter {
  density: number;
  size: number;
  sizeJitter: number;
  spread: number;
  shape: ScatterShape;
  seed: number;
}
export const strokeScatterSchema: z.ZodType<StrokeScatter, z.ZodTypeDef, unknown> = z.object({
  /** Dabs per 100px of path. 0 = off (a normal ribbon/line is drawn). */
  density: z.number().min(0).default(0),
  /** Dab diameter as a fraction of the stroke width. */
  size: z.number().min(0).default(0.5),
  /** 0 = every dab the same, 1 = sizes vary from nothing to double. */
  sizeJitter: z.number().min(0).max(1).default(0.5),
  /** Perpendicular scatter in px — how far off the line a dab may land. */
  spread: z.number().min(0).default(4),
  shape: z.enum(SCATTER_SHAPES).default("round"),
  seed: z.number().int().min(0).default(1),
});

/**
 * Calligraphic NIB — the width follows the direction of travel.
 *
 * A real broad-nib pen is a flat edge held at a fixed angle to the page, so a
 * line drawn ACROSS the nib is as wide as the nib, and a line drawn ALONG it is
 * as thin as the nib is sharp. That single rule is where the thick/thin
 * modulation of every calligraphic hand comes from, and no amount of tapering
 * reproduces it, because taper is a function of distance along the stroke while
 * this is a function of DIRECTION.
 *
 * `ratio` is the nib's thin dimension over its broad one: 1 is a round pen (no
 * modulation at all, which is why it is the identity) and 0.1 is a blade.
 */
export interface StrokeNib {
  angleDeg: number;
  ratio: number;
}
export const strokeNibSchema: z.ZodType<StrokeNib, z.ZodTypeDef, unknown> = z.object({
  /** The angle the nib is held at, in degrees. */
  angleDeg: z.number().default(45),
  /** Thin/broad ratio. 1 = round pen = identity. */
  ratio: z.number().min(0.02).max(1).default(1),
});

/**
 * Stroke — one entry of a layer's stroke list, and a whole PIPELINE over the
 * layer's outline rather than "a fill that has a width":
 *
 *   outline → trim → wave → dash → profile → paint → caps + markers
 *
 * Every stage is per-entry and every scalar in it is keyframe-addressable as
 * `stroke.<id>.…`, so three strokes on one shape can trim, dash and taper
 * independently. `paint` (solid/gradient/media/pattern, exactly like a fill)
 * supplies the colour; the entry's OWN `opacity`/`blendMode`/`enabled` (from
 * `paintEntryFields`) govern how it composites, so the inner paint's
 * opacity/blend are not consulted for strokes.
 *
 * Dash follows SVG's model — a `dash` pattern in px plus a `dashOffset` along
 * the path — because that maps 1:1 to canvas (`setLineDash`/`lineDashOffset`)
 * and to every export target, and because the offset is what makes marching
 * ants a one-keyframe animation. Empty pattern = solid line.
 */
export interface StrokeStyle extends PaintEntry {
  paint: Paint;
  width: number;
  /**
   * The width this look was DESIGNED at — the reference the rest of the
   * pipeline is proportional to, and the missing fact that made resizing a
   * stroke deform it.
   *
   * Every other px-dimensioned stage (dash, wave, roughness, scatter spread,
   * offset) was stored in absolute pixels, so a 2px dashed, wobbling line
   * dragged up to 40px became a 40px line wearing a 2px line's dashes and
   * wobble — the same numbers, now invisible. Nothing about the stroke recorded
   * how big it was meant to be, so nothing could scale with it.
   *
   * `k = width / baseWidth` is applied ONCE, in `resolveStrokeAt`, after
   * keyframes and modulators — so animating or modulating the width scales the
   * whole design with it, and the canvas, the exporter and the inspector's
   * readout cannot disagree about how a 40px version of a 2px look is drawn.
   *
   * `null` opts out: absolute pixels, every stage independent. That is the
   * escape hatch for a look that genuinely wants a hairline dash on a fat line,
   * and it is what the UI's proportional lock turns off.
   *
   * NOT keyframable, deliberately. It is the constant the animation is measured
   * against; keyframing it would be a second, contradictory way of saying what
   * keyframing `width` already says.
   */
  baseWidth: number | null;
  align: StrokeAlign;
  cap: "butt" | "round" | "square";
  join: "miter" | "round" | "bevel";
  dash: number[];
  dashOffset: number;
  trim: TrimSpec;
  /** Perpendicular displacement from the path, px. Positive = left of travel.
   *  Stacked with different offsets, one shape becomes a rail, a double line or
   *  a hatch — which is why this is a scalar here rather than a "lines" count:
   *  the stroke LIST already expresses "more than one line", and each of those
   *  lines wants its own width, colour, dash and roughness. */
  offset: number;
  profile: StrokeProfile;
  wave: StrokeWave;
  roughness: StrokeRoughness;
  scatter: StrokeScatter;
  nib: StrokeNib;
  markers: { start: StrokeMarker; end: StrokeMarker };
}

/** The identity profile — a uniform-width line. Compared against to take the
 *  renderer's fast path, so it is defined once here. */
export const UNIFORM_PROFILE: StrokeProfile = { startWidth: 1, endWidth: 1, startLength: 0.5, endLength: 0.5, ease: 0, samples: null };
/** The identity wave — no displacement. */
export const FLAT_WAVE: StrokeWave = { amplitude: 0, wavelength: 40, phase: 0, roughness: 0, seed: 1 };
/** The identity roughness — perfectly clean edges. */
export const CLEAN_EDGES: StrokeRoughness = { amount: 0, scale: 12, spread: 1, erode: 0, seed: 1 };
/** The identity scatter — a continuous line, no dabs. */
export const NO_SCATTER: StrokeScatter = { density: 0, size: 0.5, sizeJitter: 0.5, spread: 4, shape: "round", seed: 1 };
/** The identity nib — a round pen, no directional modulation. */
export const ROUND_NIB: StrokeNib = { angleDeg: 45, ratio: 1 };
/** No endpoint decoration. */
export const NO_MARKER: StrokeMarker = { kind: "none", size: 4 };

// Explicitly annotated (not `z.infer`) for the same reason the paint leaves are:
// strokes ride every visual clip → track → document, and the inferred type would
// push the document past TS's serialization limit. Keep in sync when a field moves.
export const strokeStyleSchema: z.ZodType<StrokeStyle, z.ZodTypeDef, unknown> = z.object({
  ...paintEntryFields,
  paint: paintSchema,
  width: z.number().min(0),
  /** Absent → null (absolute px), so pre-v61 documents load exactly as drawn;
   *  the v61 migration is what opts existing strokes into proportional scaling
   *  by stamping their current width as the design width. */
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
    .default({ start: NO_MARKER, end: NO_MARKER }),
});

/** A stroke entry with sane defaults (id/enabled/opacity/blend + a whole
 *  identity pipeline stamped) — the ONE constructor every surface uses. */
export function strokeStyle(
  paint: Paint,
  opts: Partial<Omit<StrokeStyle, "id" | "paint">> = {},
): StrokeStyle {
  return {
    id: createId("stroke"),
    paint,
    width: opts.width ?? 2,
    // A stroke is born at its own width, so the proportional lock is ON and
    // does nothing until the width actually changes. Passing `null` opts out.
    baseWidth: opts.baseWidth !== undefined ? opts.baseWidth : (opts.width ?? 2),
    align: opts.align ?? "center",
    cap: opts.cap ?? "butt",
    join: opts.join ?? "miter",
    dash: opts.dash ?? [],
    dashOffset: opts.dashOffset ?? 0,
    trim: opts.trim ?? { start: 0, end: 1, offset: 0 },
    offset: opts.offset ?? 0,
    profile: opts.profile ?? { ...UNIFORM_PROFILE },
    wave: opts.wave ?? { ...FLAT_WAVE },
    roughness: opts.roughness ?? { ...CLEAN_EDGES },
    scatter: opts.scatter ?? { ...NO_SCATTER },
    nib: opts.nib ?? { ...ROUND_NIB },
    markers: opts.markers ?? { start: { ...NO_MARKER }, end: { ...NO_MARKER } },
    enabled: opts.enabled ?? true,
    opacity: opts.opacity ?? 1,
    blendMode: opts.blendMode ?? "normal",
  };
}

/**
 * One anchor of a Bézier path, in clip-local coordinates. `hIn`/`hOut` are
 * ABSOLUTE handle positions (not offsets); null = no handle on that side
 * (a corner). A point with mirrored handles reads as smooth in the editor.
 */
export const pathPointSchema = z.object({
  x: z.number(),
  y: z.number(),
  /**
   * DEPTH of this point off the layer's plane (v89, units; + is away from the
   * front). Absent = 0, so every flat path is unchanged. In a world, a path
   * whose points have depth is a true 3D curve — a grease-pencil stroke that
   * wraps the surface it was drawn on.
   */
  z: z.number().optional(),
  /**
   * A handle may carry its own DEPTH (`z`, absolute, like its x and y) — what
   * lets a curve bend toward or away from its plane between two anchors.
   * Absent = the depth a straight run would have there (a third of the way to
   * the neighbour's depth), so a flat path and every path written before
   * handles had depth read exactly as they did (see `handleDepth`).
   */
  hIn: z.object({ x: z.number(), y: z.number(), z: z.number().optional() }).nullable().default(null),
  hOut: z.object({ x: z.number(), y: z.number(), z: z.number().optional() }).nullable().default(null),
  /**
   * Per-vertex corner radius (Figma vector corner-radius), in clip-local units.
   * Rounds this anchor with a true circular fillet tangent to its two adjacent
   * STRAIGHT segments; ignored on a curved side or an open path's endpoint (no
   * corner to round). Optional/absent == 0, so old documents load untouched and
   * every anchor stays a sharp corner until you dial it.
   */
  cornerRadius: z.number().min(0).optional(),
  /**
   * Node identity. Points sharing a `weldId` are ONE node that happens to be
   * stored once per run through it — a T-junction, which a subpath cannot hold
   * on its own because a point has exactly two neighbours.
   *
   * This is the seam toward a real vector network: a network's node table is
   * exactly "which points are the same node", so it can be built from these
   * rather than guessed from coordinates. Coincidence is NOT identity — two
   * anchors can sit on the same pixel by accident, and dragging one of those
   * must not drag the other.
   *
   * Optional/absent == an ordinary node, so old documents load untouched (the
   * same additive rule `cornerRadius` follows — nothing to migrate).
   */
  weldId: z.string().optional(),
});
export type PathPoint = z.infer<typeof pathPointSchema>;

export const fillRuleSchema = z.enum(["nonzero", "evenodd"]);
export type FillRule = z.infer<typeof fillRuleSchema>;

/**
 * A CONTOUR — a bare run of anchors, open or closed. Pure geometry and nothing
 * else: this is what every outline BUILDER produces and every outline READER
 * consumes (stroke outlining, flatten, boolean ops, text-to-outline, polygon
 * and polyline construction, bounds, hit-testing, the exporters).
 *
 * Identity is deliberately NOT here. A silhouette computed for one frame of one
 * render has nothing to be identified as, and giving it an id would mean minting
 * one per frame and inviting somebody to store it. Identity begins where storage
 * does — see `Subpath`, which is a contour that lives in a document.
 */
export const contourSchema = z.object({
  closed: z.boolean(),
  points: z.array(pathPointSchema),
});
export type Contour = z.infer<typeof contourSchema>;

/**
 * A contour that LIVES IN A LAYER: geometry plus a stable `id`.
 *
 * Identity is the whole difference, and it is not decoration. Every gesture in
 * the node editor addresses contours BY INDEX (`"<sub>:<index>"`), so any edit
 * that inserts, splits, reorders or deletes a run silently re-points a live
 * selection at different geometry. An id is what a selection, a clipboard, a
 * morph correspondence and an undo step can hold across a structural edit.
 *
 * What a contour deliberately does NOT carry is style, transform or timing. A
 * piece of artwork that needs its own fill, its own rotation, its own effects
 * and its own span is a LAYER, and this app already has an excellent one —
 * duplicating `Clip`'s field set down here would mean building every future
 * feature twice. Disjoint pieces become clips; the contours that stay in one
 * clip are the ones that must share a fill rule, which is exactly what a
 * compound path (a donut and its hole) is.
 *
 * ORDER IS PAINT ORDER — `subpaths[0]` paints first, so it sits at the BOTTOM.
 * That matches canvas and matches SVG document order, so an import needs no
 * reversal.
 */
export const subpathSchema = contourSchema.extend({
  id: z.string(),
});
export type Subpath = z.infer<typeof subpathSchema>;
