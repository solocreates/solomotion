import type { Easing, KeyframeTrack } from "../schema";
import type { GradientPaint, Paint, StrokeStyle, Contour } from "../schema/vector";
import { isGradientPaint, paintColors } from "../schema/vector";
import type {
  Clip,
  ImageClip,
  NestedClip,
  PathClip,
  ShapeClip,
  TextClip,
  VisualClip,
} from "../schema/clips";
import type { Frame, MotionDocument } from "../schema/document";
import { easingPoints } from "../easing";
import { allGroupClips } from "../timeline/groups";
import { groupCarriesLook } from "../timeline/group-paint";
import { contentIsIdentity } from "../transform-map";
import { hasSpatialTangents, sampleKeyframes } from "../animation/keyframes";
import { motionKeysOf } from "../animation/motion-path";
import { MIN_SHAPE_EXTENT, effectiveCornerOffsets } from "../animation/paths";
import { paintWithSampled } from "../animation/paint";
import { clipLocalTime, evaluateTextGlyphs, sourceTimeAt } from "../animation/evaluate";
import { layerPoseAt } from "../animation/layer-animation";
import { GLYPH_IDENTITY, type GlyphVisual } from "../animation/presets";
import { anchorLocal } from "../transform-map";
import { clipNaturalSize } from "../timeline/ops";
import { segmentText, type TextSegmentation } from "../text/segment";
import { resolveColor } from "../variables";
import { clipEnd, frameDurationMs, compDurationMs } from "../timeline/ops";
import { frameFps } from "../timeline/fps";
import { pathCommands, pathGeometryAt, shapeCommands, type PathCommand } from "../vector/geometry";
import { contourOverlay, hasContourOverrides, resolveContourStyle } from "../vector/contour-style";
import { isFlatWave, isFullTrim, isUniformProfile } from "../vector/stroke";
import { strokeStyle } from "../schema/vector";
import { clipRevealAt, type ClipReveal } from "../vector/reveal-strands";
import { frameTarget, type ExportTarget } from "./target";

/**
 * The Lottie translator — one headless brain that turns a the app comp
 * (or any export target) into a bodymovin/Lottie animation.
 *
 * Strategy, in order of preference per feature:
 *  1. NATIVE MAP — keyframes carry over losslessly. Our per-segment cubic
 *     bezier easing IS Lottie's keyframe i/o model; transforms, opacity,
 *     parametric rect/ellipse, fills, strokes, gradients, dashes, trim paths
 *     and subpath morphs all translate exactly.
 *  2. BAKE — anything procedural (text glyph animations, exotic parametric
 *     shapes like arcs/corner-dragged rects, loop/pingpong time remaps)
 *     samples at the comp frame rate into dense keys. Correct by
 *     construction, bigger files.
 *  3. REPORT — what Lottie simply can't hold (video, audio-reactive
 *     waveforms, boolean composite groups, layer effects) is skipped and
 *     reported per layer, so the export dialog can say exactly what happened
 *     instead of silently shipping a broken file.
 *
 * Core stays headless: image bytes and text outlines come in through
 * `LottieProviders` (the app wires fonts + the asset store into them).
 */

// ── Public interface ─────────────────────────────────────────────────────────

/** One glyph of a text clip, laid out and outlined in clip-local space. */
export interface LottieGlyph {
  subpaths: Contour[];
  /** Resolved fill color (hex / rgba string). */
  fill: string;
  /** The glyph's anchor (its layout position) — animations pivot here. */
  anchor: { x: number; y: number };
  /**
   * Faux bold, px per edge (`fauxBold × fontSize`). Exported as a round-joined
   * stroke in the glyph's own colour — the silhouette the canvas and the SVG
   * exporter draw. Absent or 0 = none.
   */
  outset?: number;
}

export interface LottieProviders {
  /** PNG/JPEG data URI + intrinsic size for an image asset. */
  imageAsset?: (assetId: string) => { dataUri: string; width: number; height: number } | null;
  /** Outline a text clip's glyphs (fonts live app-side). */
  outlineGlyphs?: (clip: TextClip) => LottieGlyph[] | null;
}

export interface LottieOptions extends LottieProviders {
  /** Export window on the frame's timeline; defaults to the whole comp. */
  startMs?: number;
  endMs?: number;
  /** Crop region in frame space (layer exports); default = the whole frame. */
  region?: { x: number; y: number; width: number; height: number };
  /** Paint the comp background as a base rectangle (default true for frames). */
  includeBackground?: boolean;
}

export type LottieLayerStatus = "mapped" | "baked" | "partial" | "skipped";

export interface LottieLayerReport {
  name: string;
  kind: string;
  status: LottieLayerStatus;
  notes: string[];
}

export interface LottieResult {
  lottie: Record<string, unknown>;
  report: LottieLayerReport[];
  /** Comp size (region-cropped for layer targets). */
  width: number;
  height: number;
  durationMs: number;
  fps: number;
}

// ── Lottie value plumbing ────────────────────────────────────────────────────

type Json = Record<string, unknown>;

/** A static Lottie property. */
const sv = (k: unknown): Json => ({ a: 0, k });

interface LottieKey {
  t: number;
  s: unknown[];
  o?: { x: number[]; y: number[] };
  i?: { x: number[]; y: number[] };
  h?: number;
  /** Spatial tangents (position only): out of this key / into the next. */
  to?: number[];
  ti?: number[];
}

/** Segment easing (leaving a key) → Lottie o/i handles, or `h: 1` for a hold. */
function keyEasing(easing: Easing): { o: { x: number[]; y: number[] }; i: { x: number[]; y: number[] } } | { h: number } {
  if (easing.kind === "hold") return { h: 1 };
  const [x1, y1, x2, y2] = easingPoints(easing);
  return { o: { x: [x1], y: [y1] }, i: { x: [x2], y: [y2] } };
}

function parseColorStr(input: string): [number, number, number, number] {
  const s = input.trim();
  if (s.startsWith("#")) {
    const hex = s.slice(1);
    const n = (h: string) => parseInt(h, 16);
    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b, a] = [...hex].map((c) => n(c + c) / 255);
      return [r!, g!, b!, hex.length === 4 ? a! : 1];
    }
    if (hex.length === 6 || hex.length === 8) {
      return [
        n(hex.slice(0, 2)) / 255,
        n(hex.slice(2, 4)) / 255,
        n(hex.slice(4, 6)) / 255,
        hex.length === 8 ? n(hex.slice(6, 8)) / 255 : 1,
      ];
    }
  }
  const m = s.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const parts = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
    return [(parts[0] ?? 0) / 255, (parts[1] ?? 0) / 255, (parts[2] ?? 0) / 255, parts[3] ?? 1];
  }
  return [0, 0, 0, 1];
}

// ── Translator context ───────────────────────────────────────────────────────

interface Ctx {
  doc: MotionDocument;
  fps: number;
  /** Export window offset — everything shifts left by this. */
  startMs: number;
  /** Region offset added to every layer position (crop for layer exports). */
  offsetX: number;
  offsetY: number;
  providers: LottieProviders;
  report: LottieLayerReport[];
  assets: Json[];
  /** frameId → precomp asset id (cycle guard doubles as the registry). */
  precomps: Map<string, string>;
  layerSeq: number;
}

/**
 * Our PIVOT → Lottie's native anchor point `a`. Both mean the same thing (the
 * point position/rotation/scale act on), so this is an exact carry, not a bake —
 * ours is normalized to the layer's box, Lottie's is layer px, and our layer
 * content is emitted centered on the origin. An animated pivot is flattened to
 * its value at the layer's start (Lottie would take a keyed `a` happily; our
 * emitter has no reason to keep two shapes of anchor track alive yet).
 */
function anchorProp(ctx: Ctx, clip: VisualClip): Json {
  const size = clipNaturalSize(ctx.doc, clip);
  if (!size) return sv([0, 0, 0]);
  const a = anchorLocal(clip.transform.anchor, size);
  return sv([a.x, a.y, 0]);
}


const frames = (ctx: Ctx, ms: number) => (ms / 1000) * ctx.fps;

function note(rep: LottieLayerReport, status: LottieLayerStatus, text?: string): void {
  const rank: LottieLayerStatus[] = ["mapped", "baked", "partial", "skipped"];
  if (rank.indexOf(status) > rank.indexOf(rep.status)) rep.status = status;
  if (text) rep.notes.push(text);
}

/** The clip's whole-clip keyframe track for a property (range-scoped excluded). */
function trackFor(clip: Clip, property: string): KeyframeTrack | undefined {
  return clip.keyframes.find((t) => t.property === property && !t.range && t.keys.length > 0);
}

const isAnimatedTrack = (t: KeyframeTrack | undefined): t is KeyframeTrack => !!t && t.keys.length >= 2;

/**
 * A scalar property as a Lottie value: static when unkeyed (or one key),
 * exact keyframes with mapped bezier easing otherwise. `map` converts units
 * (e.g. ×100 for percents). Times are clip-local; `baseMs` shifts to comp time.
 */
function scalarProp(
  ctx: Ctx,
  clip: Clip,
  property: string,
  fallback: number,
  baseMs: number,
  map: (v: number) => number = (v) => v,
): Json {
  const track = trackFor(clip, property);
  if (!track || track.keys.length < 2) {
    const v = track?.keys[0]?.value;
    return sv(map(typeof v === "number" ? v : fallback));
  }
  const keys = [...track.keys].sort((a, b) => a.timeMs - b.timeMs);
  const k: LottieKey[] = keys.map((key, i) => ({
    t: frames(ctx, baseMs + key.timeMs - ctx.startMs),
    s: [map(typeof key.value === "number" ? key.value : fallback)],
    ...(i < keys.length - 1 ? keyEasing(key.easing) : {}),
  }));
  return { a: 1, k };
}

/** A color slot (may hold `var:` tokens) as a Lottie color property. */
function colorProp(ctx: Ctx, clip: Clip, property: string, fallback: string, baseMs: number): Json {
  const track = trackFor(clip, property);
  const resolve = (v: unknown) =>
    parseColorStr(resolveColor(ctx.doc, typeof v === "string" ? v : fallback));
  if (!track || track.keys.length < 2) {
    const [r, g, b] = resolve(track?.keys[0]?.value);
    return sv([r, g, b]);
  }
  const keys = [...track.keys].sort((a, b) => a.timeMs - b.timeMs);
  const k: LottieKey[] = keys.map((key, i) => {
    const [r, g, b] = resolve(key.value);
    return {
      t: frames(ctx, baseMs + key.timeMs - ctx.startMs),
      s: [r, g, b, 1],
      ...(i < keys.length - 1 ? keyEasing(key.easing) : {}),
    };
  });
  return { a: 1, k };
}

// ── Transform ────────────────────────────────────────────────────────────────

const BLEND_INDEX: Record<string, number> = {
  normal: 0, multiply: 1, screen: 2, overlay: 3, darken: 4, lighten: 5,
  "color-dodge": 6, "color-burn": 7, "hard-light": 8, "soft-light": 9,
  difference: 10, exclusion: 11, hue: 12, saturation: 13, color: 14, luminosity: 15,
};

/**
 * A transform with a whole-layer in/out animation: procedural, so it BAKES —
 * dense keys inside the in/out windows (frame rate), sparse everywhere else
 * (keyframe times + window edges). Exact by construction.
 */
function bakedLayerTransform(ctx: Ctx, clip: VisualClip, frame: Frame, baseMs: number, rep: LottieLayerReport): Json {
  note(rep, "baked", "layer in/out animation baked at the comp frame rate.");
  const cx = frame.width / 2 + ctx.offsetX;
  const cy = frame.height / 2 + ctx.offsetY;
  const frameMs = 1000 / ctx.fps;

  const times = new Set<number>([0, clip.durationMs]);
  if (clip.animIn) {
    for (let t = 0; t <= Math.min(clip.durationMs, clip.animIn.durationMs); t += frameMs) times.add(t);
  }
  if (clip.animOut) {
    for (let t = Math.max(0, clip.durationMs - clip.animOut.durationMs); t <= clip.durationMs; t += frameMs) times.add(t);
  }
  for (const track of clip.keyframes) for (const k of track.keys) times.add(k.timeMs);
  const sorted = [...times].sort((a, b) => a - b);

  const p: LottieKey[] = [];
  const s: LottieKey[] = [];
  const r: LottieKey[] = [];
  const o: LottieKey[] = [];
  for (const t of sorted) {
    const sampled = sampleKeyframes(clip.keyframes, t);
    const n = (key: string, fb: number) => (typeof sampled[key] === "number" ? (sampled[key] as number) : fb);
    const pose = layerPoseAt(clip, t);
    const sx = n("scale", clip.transform.scale);
    const tf = frames(ctx, baseMs + t - ctx.startMs);
    p.push({ t: tf, s: [cx + n("x", clip.transform.x) + pose.dx, cy + n("y", clip.transform.y) + pose.dy] });
    s.push({ t: tf, s: [sx * pose.scale * 100, (n("scaleY", clip.transform.scaleY ?? sx)) * pose.scale * 100] });
    r.push({ t: tf, s: [n("rotation", clip.transform.rotation) + pose.rotation] });
    o.push({ t: tf, s: [n("opacity", clip.opacity) * pose.opacity * 100] });
  }
  return { o: { a: 1, k: o }, r: { a: 1, k: r }, p: { a: 1, k: p }, a: anchorProp(ctx, clip), s: { a: 1, k: s } };
}

/**
 * The layer transform. Position uses Lottie's split dimensions so our
 * independent x / y tracks map key-for-key; scale merges scale/scaleY by
 * sampling the union of their key times (exact when only one animates).
 */
/**
 * A motion path (spatial tangents on position keys) exports as Lottie's native
 * joint position with to/ti — our tangent model IS Lottie's, so the curve is
 * carried exactly, not baked. Null when the clip's position has no curves.
 */
function spatialPositionProp(ctx: Ctx, clip: VisualClip, cx: number, cy: number, baseMs: number): Json | null {
  if (!hasSpatialTangents(clip.keyframes)) return null;
  const keys = motionKeysOf(clip);
  if (keys.length < 2) return null;
  const k: LottieKey[] = keys.map((key, i) => {
    const next = keys[i + 1];
    const base: LottieKey = {
      t: frames(ctx, baseMs + key.timeMs - ctx.startMs),
      s: [cx + key.x, cy + key.y],
    };
    if (!next) return base;
    const curved = !!(key.tOut || next.tIn);
    return {
      ...base,
      ...keyEasing(key.easing),
      ...(curved
        ? {
            to: [key.tOut?.x ?? (next.x - key.x) / 3, key.tOut?.y ?? (next.y - key.y) / 3],
            ti: [next.tIn?.x ?? (key.x - next.x) / 3, next.tIn?.y ?? (key.y - next.y) / 3],
          }
        : {}),
    };
  });
  return { a: 1, k };
}

function layerTransform(ctx: Ctx, clip: VisualClip, frame: Frame, baseMs: number, rep: LottieLayerReport): Json {
  if (clip.animIn || clip.animOut) return bakedLayerTransform(ctx, clip, frame, baseMs, rep);
  const cx = frame.width / 2 + ctx.offsetX;
  const cy = frame.height / 2 + ctx.offsetY;
  const spatialP = spatialPositionProp(ctx, clip, cx, cy, baseMs);
  const px = spatialP ? null : scalarProp(ctx, clip, "x", clip.transform.x, baseMs, (v) => v + cx);
  const py = spatialP ? null : scalarProp(ctx, clip, "y", clip.transform.y, baseMs, (v) => v + cy);

  const sx = trackFor(clip, "scale");
  const sy = trackFor(clip, "scaleY");
  let s: Json;
  if (!isAnimatedTrack(sx) && !isAnimatedTrack(sy)) {
    const vx = clip.transform.scale;
    s = sv([vx * 100, (clip.transform.scaleY ?? vx) * 100]);
  } else {
    // Union of key times; each dimension sampled — exact for single-axis keys.
    const times = new Set<number>();
    for (const t of [sx, sy]) if (t) for (const key of t.keys) times.add(key.timeMs);
    const sorted = [...times].sort((a, b) => a - b);
    const src = isAnimatedTrack(sx) ? sx : sy!;
    if (isAnimatedTrack(sx) && isAnimatedTrack(sy)) {
      note(rep, "partial", "scale X and Y animate independently — merged on shared key times.");
    }
    const k: LottieKey[] = sorted.map((tMs, i) => {
      const sampled = sampleKeyframes(clip.keyframes, tMs);
      const vx = typeof sampled["scale"] === "number" ? (sampled["scale"] as number) : clip.transform.scale;
      const vy =
        typeof sampled["scaleY"] === "number"
          ? (sampled["scaleY"] as number)
          : clip.transform.scaleY ?? vx;
      const srcKey = src.keys.find((kk) => kk.timeMs === tMs);
      return {
        t: frames(ctx, baseMs + tMs - ctx.startMs),
        s: [vx * 100, vy * 100],
        ...(i < sorted.length - 1 ? keyEasing(srcKey?.easing ?? { kind: "linear" }) : {}),
      };
    });
    s = { a: 1, k };
  }

  // Skew: our T·R·K·S shear (two independent angles) has no faithful equivalent
  // in Lottie's single directional `sk`/`sa`, so rather than ship a guessed
  // matrix we report it and export without the shear (same policy as stroke
  // alignment / per-paint blends above).
  if (
    clip.transform.skewX !== 0 ||
    clip.transform.skewY !== 0 ||
    isAnimatedTrack(trackFor(clip, "skewX")) ||
    isAnimatedTrack(trackFor(clip, "skewY"))
  ) {
    note(rep, "partial", "layer skew isn't in Lottie — exported without shear.");
  }

  // Text bakes opacity into glyph alpha (renderer contract) — the
  // layer transform still carries it here because Lottie glyphs are baked
  // from GlyphVisual, which composes the ANIMATION's alpha only.
  return {
    o: scalarProp(ctx, clip, "opacity", clip.opacity, baseMs, (v) => v * 100),
    r: scalarProp(ctx, clip, "rotation", clip.transform.rotation, baseMs),
    p: spatialP ?? { s: true, x: px, y: py },
    a: anchorProp(ctx, clip),
    s,
  };
}

// ── Shape geometry ───────────────────────────────────────────────────────────

/** PathCommand[] → one-or-more Lottie bezier shapes (one per subpath). */
function commandsToLottiePaths(cmds: PathCommand[]): Json[] {
  const shapes: Json[] = [];
  let v: number[][] = [];
  let i: number[][] = [];
  let o: number[][] = [];
  let closed = false;
  const flush = () => {
    if (v.length) shapes.push({ ind: shapes.length, ty: "sh", ks: sv({ i, o, v, c: closed }) });
    v = [];
    i = [];
    o = [];
    closed = false;
  };
  for (const c of cmds) {
    if (c.type === "M") {
      flush();
      v.push([c.x, c.y]);
      i.push([0, 0]);
      o.push([0, 0]);
    } else if (c.type === "L") {
      v.push([c.x, c.y]);
      i.push([0, 0]);
      o.push([0, 0]);
    } else if (c.type === "C") {
      const prev = v[v.length - 1];
      if (prev) o[o.length - 1] = [c.x1 - prev[0]!, c.y1 - prev[1]!];
      v.push([c.x, c.y]);
      i.push([c.x2 - c.x, c.y2 - c.y]);
      o.push([0, 0]);
    } else {
      closed = true;
    }
  }
  flush();
  return shapes;
}

/** Subpaths → Lottie bezier values (for morph keys; index-aligned). */
function subpathToLottieBezier(sub: Contour): Json {
  const v: number[][] = [];
  const i: number[][] = [];
  const o: number[][] = [];
  for (const p of sub.points) {
    v.push([p.x, p.y]);
    i.push(p.hIn ? [p.hIn.x - p.x, p.hIn.y - p.y] : [0, 0]);
    o.push(p.hOut ? [p.hOut.x - p.x, p.hOut.y - p.y] : [0, 0]);
  }
  return { i, o, v, c: sub.closed };
}

// ── Paint stacks ─────────────────────────────────────────────────────────────

interface LocalBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Gradient stops → Lottie's packed color (+alpha) array. */
function gradientStops(ctx: Ctx, paint: GradientPaint): Json {
  const stops = [...paint.stops].sort((a, b) => a.offset - b.offset);
  const rgb: number[] = [];
  const alpha: number[] = [];
  let hasAlpha = false;
  for (const s of stops) {
    const [r, g, b, a] = parseColorStr(resolveColor(ctx.doc, s.color));
    rgb.push(s.offset, r, g, b);
    alpha.push(s.offset, a);
    if (a < 1) hasAlpha = true;
  }
  return { p: stops.length, k: sv(hasAlpha ? [...rgb, ...alpha] : rgb) };
}

/** One paint entry as a Lottie fill/gradient-fill (fills) shape item. */
function fillItem(ctx: Ctx, clip: ShapeClip | PathClip, paint: Paint, bounds: LocalBounds, baseMs: number, fillRule: 1 | 2): Json | null {
  const opacity = scalarProp(ctx, clip, `fill.${paint.id}.opacity`, paint.opacity, baseMs, (v) => v * 100);
  if (paint.type === "solid") {
    return { ty: "fl", nm: "Fill", c: colorProp(ctx, clip, `fill.${paint.id}.color`, paint.color, baseMs), o: opacity, r: fillRule };
  }
  // Media/pattern fills have no Lottie equivalent — skip them (caller drops nulls).
  if (!isGradientPaint(paint)) return null;
  const geo = gradientGeometry(paint, bounds);
  return {
    ty: "gf", nm: "Gradient fill",
    t: paint.type === "radial" ? 2 : 1,
    s: sv(geo.s), e: sv(geo.e), g: gradientStops(ctx, paint),
    o: opacity, r: fillRule, h: sv(0), a: sv(0),
  };
}

/** Gradient endpoints in shape-local space — same unified math as the painter. */
function gradientGeometry(paint: GradientPaint, b: LocalBounds): { s: number[]; e: number[] } {
  const sx = b.x + paint.start.x * b.w;
  const sy = b.y + paint.start.y * b.h;
  const ex = b.x + paint.end.x * b.w;
  const ey = b.y + paint.end.y * b.h;
  // Lottie has no conic gradient — angular exports along its linear axis.
  return { s: [sx, sy], e: [ex, ey] };
}

const CAP_INDEX = { butt: 1, round: 2, square: 3 } as const;
const JOIN_INDEX = { miter: 1, round: 2, bevel: 3 } as const;

/** One stroke entry as a Lottie stroke/gradient-stroke shape item. */
function strokeItem(ctx: Ctx, clip: ShapeClip | PathClip, stroke: StrokeStyle, bounds: LocalBounds, baseMs: number, rep: LottieLayerReport): Json {
  if (stroke.align !== "center") {
    note(rep, "partial", `stroke "${stroke.align}" alignment isn't in Lottie — exported center-aligned.`);
  }
  const base: Json = {
    nm: "Stroke",
    o: scalarProp(ctx, clip, `stroke.${stroke.id}.opacity`, stroke.opacity, baseMs, (v) => v * 100),
    w: scalarProp(ctx, clip, `stroke.${stroke.id}.width`, stroke.width, baseMs),
    lc: CAP_INDEX[stroke.cap],
    lj: JOIN_INDEX[stroke.join],
    ml: 4,
  };
  if (stroke.dash.length > 0 || trackFor(clip, `stroke.${stroke.id}.dashLength`)) {
    base.d = [
      { n: "d", nm: "dash", v: scalarProp(ctx, clip, `stroke.${stroke.id}.dashLength`, stroke.dash[0] ?? 0, baseMs) },
      { n: "g", nm: "gap", v: scalarProp(ctx, clip, `stroke.${stroke.id}.dashGap`, stroke.dash[1] ?? stroke.dash[0] ?? 0, baseMs) },
      { n: "o", nm: "offset", v: scalarProp(ctx, clip, `stroke.${stroke.id}.dashOffset`, stroke.dashOffset, baseMs) },
    ];
  }
  // The sampled half of the pipeline has no Lottie primitive: a variable-width
  // ribbon and a displaced centre line are baked geometry there, not a modifier.
  if (!isUniformProfile(stroke.profile)) note(rep, "partial", "stroke taper isn't in Lottie — exported at full width.");
  if (!isFlatWave(stroke.wave)) note(rep, "partial", "stroke wave isn't in Lottie — exported straight.");
  if (stroke.markers.start.kind !== "none" || stroke.markers.end.kind !== "none") {
    note(rep, "partial", "stroke endpoints aren't in Lottie — exported without arrowheads.");
  }
  if (stroke.paint.type === "solid") {
    return { ...base, ty: "st", c: colorProp(ctx, clip, `stroke.${stroke.id}.color`, stroke.paint.color, baseMs) };
  }
  // Media/pattern strokes have no Lottie equivalent — approximate with a solid.
  if (!isGradientPaint(stroke.paint)) {
    note(rep, "partial", `${stroke.paint.type} stroke isn't in Lottie — exported as a solid color.`);
    return { ...base, ty: "st", c: colorProp(ctx, clip, `stroke.${stroke.id}.color`, paintColors(stroke.paint)[0] ?? "#000000", baseMs) };
  }
  const geo = gradientGeometry(stroke.paint, bounds);
  return { ...base, ty: "gs", t: stroke.paint.type === "radial" ? 2 : 1, s: sv(geo.s), e: sv(geo.e), g: gradientStops(ctx, stroke.paint) };
}

const GROUP_TR: Json = { ty: "tr", p: sv([0, 0]), a: sv([0, 0]), s: sv([100, 100]), r: sv(0), o: sv(100) };

// ── Vector layers (shape + path clips) ───────────────────────────────────────

/** Geometry-affecting properties per shape kind (bake detection). */
const SHAPE_GEO_PROPS = [
  "width", "height", "radius", "radius.tl", "radius.tr", "radius.br", "radius.bl",
  "pointCount", "innerRatio", "arcStartDeg", "arcSweepDeg", "arcRatio",
];

function geometryAnimated(clip: ShapeClip): boolean {
  return clip.keyframes.some(
    (t) =>
      t.keys.length >= 2 &&
      (SHAPE_GEO_PROPS.includes(t.property) || t.property.startsWith("corner.")),
  );
}

/** The parametric geometry input at a sampled time (mirror of the renderer). */
function shapeGeoAt(clip: ShapeClip, localMs: number) {
  const sampled = sampleKeyframes(clip.keyframes, localMs);
  const n = (key: string, fallback: number) =>
    typeof sampled[key] === "number" ? (sampled[key] as number) : fallback;
  return {
    shape: clip.shape,
    width: Math.max(MIN_SHAPE_EXTENT, n("width", clip.width)),
    height: Math.max(MIN_SHAPE_EXTENT, n("height", clip.height)),
    cornerRadius: {
      tl: n("radius.tl", clip.cornerRadius.tl),
      tr: n("radius.tr", clip.cornerRadius.tr),
      br: n("radius.br", clip.cornerRadius.br),
      bl: n("radius.bl", clip.cornerRadius.bl),
    },
    radius: n("radius", clip.radius),
    pointCount: n("pointCount", clip.pointCount),
    innerRatio: n("innerRatio", clip.innerRatio),
    arcStartDeg: n("arcStartDeg", clip.arcStartDeg),
    arcSweepDeg: n("arcSweepDeg", clip.arcSweepDeg),
    arcRatio: n("arcRatio", clip.arcRatio),
    cornerOffsets: effectiveCornerOffsets(clip.cornerOffsets, sampled),
  };
}

/**
 * Shape geometry as Lottie items. Clean parametric cases map natively
 * (rc / el / sr); everything else — arcs, corner-dragged shapes, per-corner
 * radii, animated vertex counts — bakes exact bezier frames.
 */
function shapeGeometryItems(ctx: Ctx, clip: ShapeClip, baseMs: number, rep: LottieLayerReport): Json[] {
  const cr = clip.cornerRadius;
  const uniformRadius = cr.tl === cr.tr && cr.tr === cr.br && cr.br === cr.bl;
  const perCornerKeys = ["radius.tl", "radius.tr", "radius.br", "radius.bl"].some((p) => isAnimatedTrack(trackFor(clip, p)));
  const hasOffsets = !!clip.cornerOffsets?.some((o) => o.x !== 0 || o.y !== 0) ||
    clip.keyframes.some((t) => t.property.startsWith("corner.") && t.keys.length > 0);

  if (clip.shape === "rect" && uniformRadius && !perCornerKeys && !hasOffsets) {
    return [{
      ty: "rc", nm: "Rect", d: 1,
      p: sv([0, 0]),
      s: sizeProp(ctx, clip, baseMs),
      r: scalarProp(ctx, clip, "radius.tl", cr.tl, baseMs),
    }];
  }
  if (clip.shape === "ellipse" && clip.arcSweepDeg >= 360 && clip.arcRatio === 0 && !hasOffsets &&
      !isAnimatedTrack(trackFor(clip, "arcSweepDeg")) && !isAnimatedTrack(trackFor(clip, "arcRatio")) &&
      !isAnimatedTrack(trackFor(clip, "arcStartDeg"))) {
    return [{ ty: "el", nm: "Ellipse", d: 1, p: sv([0, 0]), s: sizeProp(ctx, clip, baseMs) }];
  }
  if ((clip.shape === "polygon" || clip.shape === "star") && clip.width === clip.height &&
      clip.radius === 0 && !hasOffsets &&
      !isAnimatedTrack(trackFor(clip, "width")) && !isAnimatedTrack(trackFor(clip, "height")) &&
      !isAnimatedTrack(trackFor(clip, "radius"))) {
    const or = clip.width / 2;
    const star = clip.shape === "star";
    return [{
      ty: "sr", nm: star ? "Star" : "Polygon", d: 1, sy: star ? 1 : 2,
      p: sv([0, 0]),
      pt: scalarProp(ctx, clip, "pointCount", clip.pointCount, baseMs),
      r: sv(0),
      or: sv(or), os: sv(0),
      ...(star ? { ir: scalarProp(ctx, clip, "innerRatio", clip.innerRatio, baseMs, (v) => v * or), is: sv(0) } : {}),
    }];
  }

  // Bake: exact bezier geometry, per-frame hold keys while it animates.
  if (!geometryAnimated(clip)) {
    return commandsToLottiePaths(shapeCommands(shapeGeoAt(clip, 0)));
  }
  note(rep, "baked", "shape geometry baked per frame (arc / corners / vertex count animate).");
  return bakeCommandsPerFrame(ctx, clip, baseMs, (t) => shapeCommands(shapeGeoAt(clip, t)));
}

/** Rect/ellipse size as an animated [w,h] (union of the two tracks' keys). */
function sizeProp(ctx: Ctx, clip: ShapeClip, baseMs: number): Json {
  const wT = trackFor(clip, "width");
  const hT = trackFor(clip, "height");
  if (!isAnimatedTrack(wT) && !isAnimatedTrack(hT)) {
    const sampled = sampleKeyframes(clip.keyframes, 0);
    const w = typeof sampled["width"] === "number" ? (sampled["width"] as number) : clip.width;
    const h = typeof sampled["height"] === "number" ? (sampled["height"] as number) : clip.height;
    return sv([w, h]);
  }
  const times = new Set<number>();
  for (const t of [wT, hT]) if (t) for (const key of t.keys) times.add(key.timeMs);
  const sorted = [...times].sort((a, b) => a - b);
  const src = isAnimatedTrack(wT) ? wT : hT!;
  const k: LottieKey[] = sorted.map((tMs, i) => {
    const sampled = sampleKeyframes(clip.keyframes, tMs);
    const w = typeof sampled["width"] === "number" ? (sampled["width"] as number) : clip.width;
    const h = typeof sampled["height"] === "number" ? (sampled["height"] as number) : clip.height;
    const srcKey = src.keys.find((kk) => kk.timeMs === tMs);
    return {
      t: frames(ctx, baseMs + tMs - ctx.startMs),
      s: [w, h],
      ...(i < sorted.length - 1 ? keyEasing(srcKey?.easing ?? { kind: "linear" }) : {}),
    };
  });
  return { a: 1, k };
}

/** Per-frame hold-key baking of arbitrary geometry (the universal fallback). */
function bakeCommandsPerFrame(ctx: Ctx, clip: Clip, baseMs: number, cmdsAt: (localMs: number) => PathCommand[]): Json[] {
  const frameMs = 1000 / ctx.fps;
  const steps = Math.max(1, Math.round(clip.durationMs / frameMs));
  // Bake the FIRST subpath set; per-frame each subpath becomes its own sh.
  const first = commandsToLottiePaths(cmdsAt(0));
  const perPathKeys: LottieKey[][] = first.map(() => []);
  for (let i = 0; i <= steps; i++) {
    const t = Math.min(clip.durationMs, i * frameMs);
    const shapes = commandsToLottiePaths(cmdsAt(t));
    for (let p = 0; p < perPathKeys.length; p++) {
      const shape = shapes[Math.min(p, shapes.length - 1)];
      const ks = shape ? (shape.ks as Json).k : undefined;
      if (ks !== undefined) {
        perPathKeys[p]!.push({ t: frames(ctx, baseMs + t - ctx.startMs), s: [ks], h: 1 });
      }
    }
  }
  return perPathKeys.map((keys, idx) => ({ ind: idx, ty: "sh", ks: { a: 1, k: keys } }));
}

/** Path clip geometry: static, natively morphed, or baked. */
function pathGeometryItems(ctx: Ctx, clip: PathClip, baseMs: number, rep: LottieLayerReport): Json[] {
  const geoTrack = trackFor(clip, "geometry");
  if (!isAnimatedTrack(geoTrack)) {
    const sampled = sampleKeyframes(clip.keyframes, 0);
    const geometry = Array.isArray(sampled["geometry"]) ? (sampled["geometry"] as Contour[]) : clip.subpaths;
    return commandsToLottiePaths(pathCommands(geometry));
  }
  const keys = [...geoTrack.keys].sort((a, b) => a.timeMs - b.timeMs);
  const values = keys.map((k) => (Array.isArray(k.value) ? (k.value as Contour[]) : clip.subpaths));
  const counts = values.map((v) => v.map((s) => s.points.length).join(","));
  const compatible = counts.every((c) => c === counts[0]);
  if (!compatible) {
    note(rep, "baked", "morph keys have differing point counts — geometry baked per frame.");
    return bakeCommandsPerFrame(ctx, clip, baseMs, (t) => {
      const sampled = sampleKeyframes(clip.keyframes, t);
      const geometry = Array.isArray(sampled["geometry"]) ? (sampled["geometry"] as Contour[]) : clip.subpaths;
      return pathCommands(geometry);
    });
  }
  // True native morph: one animated sh per subpath, key-for-key with easing.
  const subCount = values[0]!.length;
  return Array.from({ length: subCount }, (_, si) => ({
    ind: si,
    ty: "sh",
    ks: {
      a: 1,
      k: keys.map((key, i) => ({
        t: frames(ctx, baseMs + key.timeMs - ctx.startMs),
        s: [subpathToLottieBezier(values[i]![si] ?? values[i]![0]!)],
        ...(i < keys.length - 1 ? keyEasing(key.easing) : {}),
      })),
    },
  }));
}

/** One stroke's trim window → a Lottie tm item (offset turns → degrees). Trim
 *  is per-stroke, and Lottie's tm trims everything in its group — which is
 *  exactly why each stroke is exported in a group of its own. */
function trimItem(ctx: Ctx, clip: ShapeClip | PathClip, stroke: StrokeStyle, baseMs: number): Json | null {
  const p = (sub: string) => `stroke.${stroke.id}.${sub}`;
  const active =
    !isFullTrim(stroke.trim) ||
    ["trim.start", "trim.end", "trim.offset"].some((s) => isAnimatedTrack(trackFor(clip, p(s))));
  if (!active) return null;
  return {
    ty: "tm", nm: "Trim",
    s: scalarProp(ctx, clip, p("trim.start"), stroke.trim.start, baseMs, (v) => v * 100),
    e: scalarProp(ctx, clip, p("trim.end"), stroke.trim.end, baseMs, (v) => v * 100),
    o: scalarProp(ctx, clip, p("trim.offset"), stroke.trim.offset, baseMs, (v) => v * 360),
    m: 1,
  };
}

// ── Draw On ──────────────────────────────────────────────────────────────────

/** The draw-on over a clip's whole span, sampled once per frame. */
interface RevealBake {
  /** Frame-aligned samples, clip-local ms → the reveal (null = whole). */
  samples: Array<{ t: number; reveal: ClipReveal | null }>;
  /** Strand count the windows describe. */
  strands: number;
  /** Any frame where the fills are dimmed. */
  fillsFade: boolean;
  /** Any frame with an outline to synthesise. */
  synthesise: boolean;
  /** The pen used for a synthesised outline (first sample's). */
  pen: number;
}

/**
 * Sample the reveal in force on a vector layer — its own draw-on, or an
 * enclosing group's read through — at every frame of the clip. Null when no
 * frame draws, which is almost every layer. Baked rather than translated from
 * the spec because a group's clock, a stagger and a "from the middle" window
 * are per strand and per instant, and Lottie's trim is a keyframed number:
 * dense linear keys are exactly that number at exactly those instants.
 */
function bakeReveal(ctx: Ctx, clip: ShapeClip | PathClip): RevealBake | null {
  const frameMs = 1000 / ctx.fps;
  const steps = Math.max(1, Math.round(clip.durationMs / frameMs));
  const samples: RevealBake["samples"] = [];
  let strands = 0;
  let fillsFade = false;
  let synthesise = false;
  let pen = 2;
  let any = false;
  for (let i = 0; i <= steps; i++) {
    const t = Math.min(clip.durationMs, i * frameMs);
    const reveal = clipRevealAt(ctx.doc, clip, t, clip.startMs + t);
    if (reveal) {
      any = true;
      strands = Math.max(strands, reveal.windows.length);
      if (reveal.fillAlpha < 0.999) fillsFade = true;
      if (reveal.synthesiseOutline) {
        synthesise = true;
        pen = reveal.reveal.pen;
      }
    }
    samples.push({ t, reveal });
  }
  return any ? { samples, strands, fillsFade, synthesise, pen } : null;
}

/** Dense linear keys for one scalar read off every sample. */
function bakedKeys(ctx: Ctx, bake: RevealBake, baseMs: number, read: (r: ClipReveal | null) => number): Json {
  const k: LottieKey[] = bake.samples.map((s, i) => ({
    t: frames(ctx, baseMs + s.t - ctx.startMs),
    s: [read(s.reveal)],
    ...(i < bake.samples.length - 1 ? keyEasing({ kind: "linear" }) : {}),
  }));
  return { a: 1, k };
}

/**
 * A stroke's Lottie trim under a draw-on, for ONE strand: the reveal's window
 * with the stroke's own static trim folded inside it (the design's window is
 * cut from what the reveal has inked — the same order the canvas applies).
 * An animated or offset trim cannot be folded into two numbers; the stroke's
 * own tm is then emitted after this one and the report says so.
 */
function revealTrim(ctx: Ctx, bake: RevealBake, strand: number, stroke: StrokeStyle, foldable: boolean, baseMs: number): Json {
  const win = (r: ClipReveal | null): [number, number, number] => {
    const [a, b, offset] = r?.windows[strand] ?? [0, 1, 0];
    if (!foldable) return [a, b, offset];
    return [a + (b - a) * stroke.trim.start, a + (b - a) * stroke.trim.end, offset];
  };
  return {
    ty: "tm", nm: "Draw on",
    s: bakedKeys(ctx, bake, baseMs, (r) => win(r)[0] * 100),
    e: bakedKeys(ctx, bake, baseMs, (r) => win(r)[1] * 100),
    // Turns → degrees, the same map the stroke's own trim offset takes.
    o: bakedKeys(ctx, bake, baseMs, (r) => win(r)[2] * 360),
    m: 1,
  };
}

/** A trim offset that wraps nothing — the only kind that folds into a window. */
function trimOffsetIsWhole(s: StrokeStyle): boolean {
  return s.trim.offset % 1 === 0;
}

function vectorLocalBounds(clip: ShapeClip | PathClip): LocalBounds {
  if (clip.kind === "shape") {
    return { x: -clip.width / 2, y: -clip.height / 2, w: clip.width, h: clip.height };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const sub of clip.subpaths) {
    for (const p of sub.points) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
  }
  if (minX > maxX) return { x: -4, y: -4, w: 8, h: 8 };
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

function vectorShapeLayer(ctx: Ctx, clip: ShapeClip | PathClip, frame: Frame, rep: LottieLayerReport): Json {
  const baseMs = clip.startMs;
  const bounds = vectorLocalBounds(clip);
  const fillRule: 1 | 2 = clip.kind === "path" && clip.fillRule === "evenodd" ? 2 : 1;
  const geometry =
    clip.kind === "shape"
      ? shapeGeometryItems(ctx, clip, baseMs, rep)
      : pathGeometryItems(ctx, clip, baseMs, rep);

  /**
   * One run of geometry under one set of paints. Ordered paints, top-first for
   * Lottie (our lists paint bottom→top); each stroke exports as its OWN group
   * so it can carry its own trim window.
   */
  const bake = bakeReveal(ctx, clip);
  if (bake) note(rep, "baked", "draw-on baked as per-strand trim keys, one per frame.");

  /**
   * A stroke under a draw-on: one group PER STRAND, each with its own baked
   * trim, because a stagger or a group's clock gives every subpath a window of
   * its own and a Lottie trim is one window per group. `geoOffset` is where
   * this run's geometry starts in the layer's strand list.
   */
  const revealStrokeGroups = (geo: Json[], geoOffset: number, s: StrokeStyle, nm: string): Json[] => {
    const trimStatic = !["trim.start", "trim.end", "trim.offset"].some((p) => isAnimatedTrack(trackFor(clip, `stroke.${s.id}.${p}`)));
    const foldable = trimStatic && trimOffsetIsWhole(s);
    const own = foldable ? null : trimItem(ctx, clip, s, baseMs);
    if (own) note(rep, "partial", "a draw-on over an animated or offset trim exports as two trims — check the result.");
    const item = strokeItem(ctx, clip, s, bounds, baseMs, rep);
    return geo.map((g, i) => ({
      ty: "gr", nm,
      it: [g, revealTrim(ctx, bake!, geoOffset + i, s, foldable, baseMs), ...(own ? [own] : []), item, GROUP_TR],
    }));
  };

  const groupsFor = (geo: Json[], paintFills: Paint[], paintStrokes: StrokeStyle[], rule: 1 | 2, geoOffset = 0): Json[] => {
    const strokes = [...paintStrokes].reverse()
      .filter((s) => s.enabled && (s.width > 0 || isAnimatedTrack(trackFor(clip, `stroke.${s.id}.width`))));
    const strokeGroups = bake
      ? strokes.flatMap((s) => revealStrokeGroups(geo, geoOffset, s, "Stroke"))
      : strokes.map((s) => {
          const tm = trimItem(ctx, clip, s, baseMs);
          const it = [...geo, ...(tm ? [tm] : []), strokeItem(ctx, clip, s, bounds, baseMs, rep), GROUP_TR];
          return { ty: "gr", nm: "Stroke", it } as Json;
        });
    const fills = paintFills.filter((f) => f.enabled).reverse()
      .map((f) => fillItem(ctx, clip, f, bounds, baseMs, rule))
      .filter((f): f is Json => f !== null);
    // Strokes paint over fills, and each already carries its own trim group.
    const out: Json[] = [...strokeGroups];
    // A filled layer with no stroke still draws on: its silhouette is inked in
    // the fill's paint at the reveal's pen — the same borrowed outline the
    // canvas and the SVG exporter draw.
    if (bake?.synthesise) {
      const ink = paintFills.find((f) => f.enabled && f.type !== "media");
      if (ink) {
        const pen = strokeStyle(ink, { width: bake.pen, cap: "round", join: "round", opacity: ink.opacity });
        out.push(...revealStrokeGroups(geo, geoOffset, pen, "Draw on"));
      }
    }
    if (fills.length > 0) {
      // The fills fade per the reveal's Fill setting — on the group's own
      // opacity, so the fill's keyframed opacity still exports as itself.
      const tr = bake?.fillsFade
        ? { ...GROUP_TR, o: bakedKeys(ctx, bake, baseMs, (r) => (r?.fillAlpha ?? 1) * 100) }
        : GROUP_TR;
      out.unshift({ ty: "gr", nm: "Fills", it: [...geo, ...fills, tr] });
    }
    return out;
  };

  for (const p of [...clip.fills, ...clip.strokes]) {
    if (p.blendMode !== "normal") note(rep, "partial", "per-paint blend modes aren't in Lottie — exported normal.");
  }

  let shapes: Json[];
  if (clip.kind === "path" && hasContourOverrides(clip)) {
    // A contour that overrides its layer becomes its OWN Lottie group, over the
    // same runs the canvas and the SVG exporter paint — geometry items are 1:1
    // with contours and in order, so a run is a slice. Consecutive, not
    // gathered, so paint order survives and a compound path keeps its holes.
    const contours = pathGeometryAt(clip, sampleKeyframes(clip.keyframes, 0));
    shapes = [];
    for (let start = 0; start < contours.length; ) {
      const key = contourOverlay(clip, contours[start]!.id);
      let end = start + 1;
      while (end < contours.length && contourOverlay(clip, contours[end]!.id) === key) end++;
      const style = resolveContourStyle(clip, contours[start]!.id);
      const rule: 1 | 2 = style.fillRule === "evenodd" ? 2 : 1;
      shapes.push(...groupsFor(geometry.slice(start, end), style.fills, style.strokes, rule, start));
      start = end;
    }
    // A per-contour override is a static value, but the layer's paint may also
    // be keyframed — Lottie would then animate over the override, because both
    // address the same paint id. Say so rather than exporting a lie.
    if (clip.keyframes.some((t) => /^(fill|stroke)\./.test(t.property) && isAnimatedTrack(t))) {
      note(rep, "partial", "a contour overrides a paint that also animates — the animation wins in Lottie.");
    }
  } else {
    shapes = groupsFor(geometry, clip.fills, clip.strokes, fillRule);
  }

  return {
    ddd: 0, ty: 4, ind: ++ctx.layerSeq, nm: clip.name,
    sr: 1, ks: layerTransform(ctx, clip, frame, baseMs, rep), ao: 0,
    shapes,
    ip: frames(ctx, clip.startMs - ctx.startMs),
    op: frames(ctx, clipEnd(clip) - ctx.startMs),
    st: frames(ctx, clip.startMs - ctx.startMs),
    bm: BLEND_INDEX[clip.blendMode] ?? 0,
  };
}

// ── Text layers (baked glyph groups) ─────────────────────────────────────────

/** Sample times where a glyph's pose can change (its in/out windows), frame-stepped. */
function glyphSampleTimes(clip: TextClip, fps: number): number[] {
  const frameMs = 1000 / fps;
  const times: number[] = [];
  for (let t = 0; t <= clip.durationMs; t += frameMs) times.push(t);
  return times;
}

function poseOf(clip: TextClip, seg: TextSegmentation, index: number, localMs: number): GlyphVisual {
  return evaluateTextGlyphs(clip, seg, localMs)[index] ?? GLYPH_IDENTITY;
}

const samePose = (a: GlyphVisual, b: GlyphVisual) =>
  Math.abs(a.opacity - b.opacity) < 1e-3 && Math.abs(a.dx - b.dx) < 1e-2 && Math.abs(a.dy - b.dy) < 1e-2 &&
  Math.abs(a.scale - b.scale) < 1e-3 && Math.abs(a.rotation - b.rotation) < 1e-2;

function textLayer(ctx: Ctx, clip: TextClip, frame: Frame, rep: LottieLayerReport): Json | null {
  const glyphs = ctx.providers.outlineGlyphs?.(clip) ?? null;
  if (!glyphs) {
    note(rep, "skipped", "text could not be outlined (font unavailable).");
    return null;
  }
  const baseMs = clip.startMs;
  const seg = segmentText(clip.text);
  const animated = !!(clip.animations.in || clip.animations.out || clip.caption ||
    clip.ranges.some((r) => r.animation));
  if (clip.caption) note(rep, "partial", "caption focus styling is baked without its recolour.");
  if (animated) note(rep, "baked", "per-glyph text animation baked at the comp frame rate.");

  const groups: Json[] = glyphs.map((glyph, gi) => {
    const paths = glyph.subpaths.map((sub, si) => ({ ind: si, ty: "sh", ks: sv(subpathToLottieBezier(sub)) }));
    const [r, g, b, a] = parseColorStr(resolveColor(ctx.doc, glyph.fill));
    const fill: Json = { ty: "fl", nm: "Fill", c: sv([r, g, b]), o: sv(a * 100), r: 1 };
    const bold: Json[] =
      glyph.outset && glyph.outset > 0
        ? [{ ty: "st", nm: "Faux bold", c: sv([r, g, b]), o: sv(a * 100), w: sv(glyph.outset * 2), lc: 2, lj: 2 }]
        : [];

    let tr: Json = { ...GROUP_TR, a: sv([glyph.anchor.x, glyph.anchor.y]), p: sv([glyph.anchor.x, glyph.anchor.y]) };
    if (animated) {
      // Bake this glyph's pose wherever it changes; static spans stay keyless.
      const times = glyphSampleTimes(clip, ctx.fps);
      const posKeys: LottieKey[] = [];
      const scaleKeys: LottieKey[] = [];
      const rotKeys: LottieKey[] = [];
      const opKeys: LottieKey[] = [];
      let prev: GlyphVisual | null = null;
      for (const t of times) {
        const pose = poseOf(clip, seg, gi, t);
        if (prev && samePose(prev, pose) && t !== times[times.length - 1]) continue;
        const tf = frames(ctx, baseMs + t - ctx.startMs);
        posKeys.push({ t: tf, s: [glyph.anchor.x + pose.dx, glyph.anchor.y + pose.dy] });
        scaleKeys.push({ t: tf, s: [pose.scale * 100, pose.scale * 100] });
        rotKeys.push({ t: tf, s: [pose.rotation] });
        opKeys.push({ t: tf, s: [pose.opacity * 100] });
        prev = pose;
      }
      const animOrStatic = (keys: LottieKey[], staticVal: unknown): Json =>
        keys.length > 1 ? { a: 1, k: keys } : sv(keys[0]?.s.length === 1 ? keys[0].s[0] : keys[0]?.s ?? staticVal);
      tr = {
        ty: "tr",
        a: sv([glyph.anchor.x, glyph.anchor.y]),
        p: animOrStatic(posKeys, [glyph.anchor.x, glyph.anchor.y]),
        s: animOrStatic(scaleKeys, [100, 100]),
        r: animOrStatic(rotKeys, 0),
        o: animOrStatic(opKeys, 100),
      };
    }
    return { ty: "gr", nm: `glyph ${gi}`, it: [...paths, ...bold, fill, tr] };
  });

  return {
    ddd: 0, ty: 4, ind: ++ctx.layerSeq, nm: clip.name,
    sr: 1, ks: layerTransform(ctx, clip, frame, baseMs, rep), ao: 0,
    shapes: groups,
    ip: frames(ctx, clip.startMs - ctx.startMs),
    op: frames(ctx, clipEnd(clip) - ctx.startMs),
    st: frames(ctx, clip.startMs - ctx.startMs),
    bm: BLEND_INDEX[clip.blendMode] ?? 0,
  };
}

// ── Image / nested layers ────────────────────────────────────────────────────

function imageLayer(ctx: Ctx, clip: ImageClip, frame: Frame, rep: LottieLayerReport): Json | null {
  const asset = ctx.providers.imageAsset?.(clip.assetId) ?? null;
  if (!asset) {
    note(rep, "skipped", "image bytes unavailable.");
    return null;
  }
  const id = `img_${clip.assetId}`;
  if (!ctx.assets.some((a) => a.id === id)) {
    ctx.assets.push({ id, w: asset.width, h: asset.height, u: "", p: asset.dataUri, e: 1 });
  }
  const ks = layerTransform(ctx, clip, frame, clip.startMs, rep) as Json;
  // Images draw centered on the transform — anchor at the bitmap center.
  ks.a = sv([asset.width / 2, asset.height / 2, 0]);
  return {
    ddd: 0, ty: 2, ind: ++ctx.layerSeq, nm: clip.name, refId: id,
    sr: 1, ks, ao: 0,
    ip: frames(ctx, clip.startMs - ctx.startMs),
    op: frames(ctx, clipEnd(clip) - ctx.startMs),
    st: frames(ctx, clip.startMs - ctx.startMs),
    bm: BLEND_INDEX[clip.blendMode] ?? 0,
  };
}

/** Nested comp → precomp asset + a time-remapped precomp layer. */
function nestedLayer(ctx: Ctx, clip: NestedClip, frame: Frame, rep: LottieLayerReport): Json | null {
  const source = ctx.doc.frames.find((f) => f.id === clip.sourceFrameId);
  if (!source) {
    note(rep, "skipped", "source comp not found.");
    return null;
  }
  if (ctx.precomps.get(clip.sourceFrameId) === "__building__") {
    note(rep, "skipped", "recursive nesting cycle.");
    return null;
  }
  let refId = ctx.precomps.get(clip.sourceFrameId);
  if (!refId) {
    refId = `comp_${clip.sourceFrameId}`;
    ctx.precomps.set(clip.sourceFrameId, "__building__");
    const layers = buildLayers(ctx, source, null, 0);
    ctx.precomps.set(clip.sourceFrameId, refId);
    ctx.assets.push({ id: refId, nm: source.name, fr: ctx.fps, layers });
  }

  // Time remap bakes speed / reverse / trimIn / loop / pingpong exactly, by
  // sampling the ONE shared source-time contract per frame.
  const sourceDur = compDurationMs(ctx.doc, clip.sourceFrameId);
  const frameMs = 1000 / ctx.fps;
  const steps = Math.max(1, Math.round(clip.durationMs / frameMs));
  const tmKeys: LottieKey[] = [];
  for (let i = 0; i <= steps; i++) {
    const local = Math.min(clip.durationMs, i * frameMs);
    // Same contract as the renderer: trim first, remap the remainder.
    const src = clip.trimInMs + sourceTimeAt(local, Math.max(1, sourceDur - clip.trimInMs), clip.playback);
    tmKeys.push({ t: frames(ctx, clip.startMs + local - ctx.startMs), s: [src / 1000] });
  }
  const simplePlayback = clip.playback.speed === 1 && !clip.playback.reverse && clip.playback.loop === "none" && clip.trimInMs === 0;
  if (!simplePlayback) note(rep, "baked", "playback (speed/loop/reverse/trim) baked as time remap.");

  return {
    ddd: 0, ty: 0, ind: ++ctx.layerSeq, nm: clip.name, refId,
    w: source.width, h: source.height,
    sr: 1, ks: precompTransform(ctx, clip, frame, source, rep), ao: 0,
    tm: simplePlayback ? undefined : { a: 1, k: tmKeys },
    ip: frames(ctx, clip.startMs - ctx.startMs),
    op: frames(ctx, clipEnd(clip) - ctx.startMs),
    st: frames(ctx, clip.startMs - ctx.startMs),
    bm: BLEND_INDEX[clip.blendMode] ?? 0,
  };
}

/** Nested layers draw centered on their transform (same as images). */
function precompTransform(ctx: Ctx, clip: NestedClip, frame: Frame, source: Frame, rep: LottieLayerReport): Json {
  const ks = layerTransform(ctx, clip, frame, clip.startMs, rep) as Json;
  ks.a = sv([source.width / 2, source.height / 2, 0]);
  return ks;
}

// ── Orchestration ────────────────────────────────────────────────────────────

function buildLayers(ctx: Ctx, frame: Frame, only: Set<string> | null, exportStartMs: number): Json[] {
  const layers: Json[] = [];
  const compositeGroups = new Map(
    allGroupClips(ctx.doc).filter((g) => g.mode !== "pass" && g.mode !== "union").map((g) => [g.id, g]),
  );
  const reportedGroups = new Set<string>();

  // Track order top-first — exactly Lottie's layer order.
  for (const track of ctx.doc.tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.frameId !== frame.id) continue;
      if (only && !only.has(clip.id)) continue;
      if (clipEnd(clip) <= exportStartMs) continue;
      // A group paints nothing of its own — its members are separate layers
      // here. Its transform, paint and effects have no Lottie equivalent as a
      // container, so say so rather than dropping them silently.
      if (clip.kind === "group") {
        if (groupCarriesLook(clip)) {
          ctx.report.push({
            name: clip.name, kind: "group", status: "partial",
            notes: ["a group's own transform, fill, stroke and effects aren't expressible in Lottie yet."],
          });
        }
        continue;
      }

      const rep: LottieLayerReport = { name: clip.name, kind: clip.kind, status: "mapped", notes: [] };
      const group = clip.kind !== "audio" && track.groupId ? compositeGroups.get(track.groupId) : undefined;
      if (group) {
        if (!reportedGroups.has(group.id)) {
          reportedGroups.add(group.id);
          ctx.report.push({
            name: group.name, kind: `group (${group.mode})`, status: "skipped",
            notes: ["boolean/mask composite groups aren't expressible in Lottie yet."],
          });
        }
        continue;
      }

      let layer: Json | null = null;
      if (clip.kind === "shape" || clip.kind === "path") layer = vectorShapeLayer(ctx, clip, frame, rep);
      else if (clip.kind === "text") layer = textLayer(ctx, clip, frame, rep);
      else if (clip.kind === "image") layer = imageLayer(ctx, clip, frame, rep);
      else if (clip.kind === "nested") layer = nestedLayer(ctx, clip, frame, rep);
      else if (clip.kind === "audio") {
        rep.status = "skipped";
        rep.notes.push("Lottie has no audio.");
      } else if (clip.kind === "video") {
        rep.status = "skipped";
        rep.notes.push("video layers aren't supported in Lottie.");
      } else if (clip.kind === "waveform") {
        rep.status = "skipped";
        rep.notes.push("audio-reactive waveforms can't run without sound.");
      } else if (clip.kind === "trace") {
        rep.status = "skipped";
        rep.notes.push("a trace is sampled from its source every frame — export as video/PNG to include it.");
      } else if (clip.kind === "raster") {
        rep.status = "skipped";
        rep.notes.push("paint layers are pixels — export as video/PNG/SVG to include them.");
      }

      if (layer && clip.kind !== "audio" && (clip as VisualClip).effects.length > 0) {
        note(rep, "partial", "layer effects (shadow/blur/adjust) aren't translated.");
      }

      // The picture's placement INSIDE its crop window (v68). Lottie has no
      // container with those semantics — a layer's transform moves the layer
      // and its mask together — so a reframed photo would export at its
      // authored framing with nothing on screen saying the framing was lost.
      // Say it instead: a silent wrong answer is the failure mode this report
      // exists to prevent.
      if (layer && clip.kind !== "audio" && !contentIsIdentity((clip as VisualClip).content)) {
        note(rep, "partial", "the picture's position inside its crop isn't translated.");
      }
      if (layer) layers.push(layer);
      ctx.report.push(rep);
    }
  }
  return layers;
}

/**
 * Translate an export target into a Lottie animation + a per-layer report.
 * The one entry point for every surface (dialog, sidebar, menu).
 */
export function translateLottie(
  doc: MotionDocument,
  target: ExportTarget | null,
  options: LottieOptions = {},
): LottieResult {
  const t = target ?? frameTarget(doc, doc.frames[0]!.id);
  const frame = doc.frames.find((f) => f.id === t.frameId) ?? doc.frames[0]!;
  const fps = frameFps(doc, frame);
  const startMs = options.startMs ?? 0;
  const endMs = options.endMs ?? frameDurationMs(doc, frame);
  const region = options.region ?? { x: 0, y: 0, width: frame.width, height: frame.height };

  const ctx: Ctx = {
    doc,
    fps,
    startMs,
    offsetX: -region.x,
    offsetY: -region.y,
    providers: options,
    report: [],
    assets: [],
    precomps: new Map(),
    layerSeq: 0,
  };

  const only = t.clipIds.length > 0 ? new Set(t.clipIds) : null;
  const layers = buildLayers(ctx, frame, only, startMs);

  if (options.includeBackground ?? !only) {
    const [r, g, b] = parseColorStr(resolveColor(doc, frame.background));
    layers.push({
      ddd: 0, ty: 4, ind: ++ctx.layerSeq, nm: "Background", sr: 1,
      ks: { o: sv(100), r: sv(0), p: sv([region.width / 2, region.height / 2, 0]), a: sv([0, 0, 0]), s: sv([100, 100, 100]) },
      ao: 0,
      shapes: [{
        ty: "gr", nm: "bg",
        it: [
          { ty: "rc", d: 1, p: sv([0, 0]), s: sv([region.width, region.height]), r: sv(0) },
          { ty: "fl", c: sv([r, g, b]), o: sv(100), r: 1 },
          GROUP_TR,
        ],
      }],
      ip: 0, op: frames(ctx, endMs - startMs), st: 0, bm: 0,
    });
  }

  const lottie: Json = {
    v: "5.12.2",
    fr: fps,
    ip: 0,
    op: Math.max(1, frames(ctx, endMs - startMs)),
    w: Math.round(region.width),
    h: Math.round(region.height),
    nm: t.name,
    ddd: 0,
    assets: ctx.assets,
    layers,
  };

  return { lottie, report: ctx.report, width: region.width, height: region.height, durationMs: endMs - startMs, fps };
}
