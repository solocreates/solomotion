import type { Paint, StrokeStyle, Contour, FillRule, Subpath } from "../schema/vector";
import { pathGeometryAt } from "../vector/geometry";
import { allGroupClips } from "../timeline/groups";
import { groupCarriesLook } from "../timeline/group-paint";
import { contourOverlay, hasContourOverrides, resolveContourStyle } from "../vector/contour-style";
import { isGradientPaint, strokeStyle } from "../schema/vector";
import type { KeyframeValue } from "../schema/animation";
import type { PathClip, ShapeClip, TextClip, VisualClip } from "../schema/clips";
import type { MotionDocument } from "../schema/document";
import { sampleKeyframes } from "../animation/keyframes";
import { effectiveCornerOffsets } from "../animation/paths";
import { paintWithSampled } from "../animation/paint";
import { clipLocalTime } from "../animation/evaluate";
import { layerPoseAt } from "../animation/layer-animation";
import { clipRevealAt } from "../vector/reveal-strands";
import { resolveColor } from "../variables";
import {
  pathCommands,
  shapeCommands,
  subpathBounds,
  type PathCommand,
} from "../vector/geometry";
import { buildStrokePlan, sampleStroke, strokeIsVisible } from "../vector/stroke";
import { anchorLocal, type LayerBox } from "../transform-map";
import { pathBox } from "../pivot";
import { targetVisualClips, type ExportTarget } from "./target";

/**
 * The SVG serializer — a true vector export, headless.
 *
 * Mirrors the canvas renderer exactly: same sampled keyframes, same paint
 * lists (ordered fills/strokes with per-entry opacity + blend), same gradient
 * geometry (normalized to the painted bounds), same stroke alignment
 * (inside/outside via clip/mask + doubled width) and the same trim-paths.
 * What canvas rasterizes, SVG keeps as geometry — one model, two writers.
 *
 * Core can't lay out text or decode media, so the app injects two callbacks:
 *  - `outlineText` turns a text clip into filled outline paths
 *    (clip-local space) — the "convert to path at export time" contract.
 *  - `rasterize` returns a PNG data URI + frame-space rect for layers SVG
 *    can't express as vectors (image/video/nested/waveform, layer effects,
 *    boolean composite groups). Missing callbacks degrade to a warning.
 */

export interface OutlinedTextPath {
  /** SVG path data in the clip's local space (anchor at the layer origin). */
  d: string;
  fill?: string;
  fillRule?: FillRule;
  opacity?: number;
  stroke?: { color: string; width: number };
}

export interface SvgRasterPatch {
  /** PNG data URI. */
  href: string;
  /** Frame-space rect the image maps onto. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SvgSerializeOptions {
  /** Document (timeline) time to sample, ms. */
  timeMs: number;
  /** Crop region in frame space; default = the whole frame. */
  region?: { x: number; y: number; width: number; height: number };
  /** Paint the frame background under everything (frame exports). */
  includeBackground?: boolean;
  /** Convert a text clip to outline paths (app supplies fonts). */
  outlineText?: (clip: TextClip, localMs: number) => OutlinedTextPath[] | null;
  /**
   * The laid-out box of a text layer at this instant. Needed only for the PIVOT,
   * which is stored as a fraction of the layer's box (see transform-map) and so
   * can't be resolved without one; text layout needs font metrics core has no
   * access to. Omitted → the pivot is treated as centered, which is the default
   * and therefore right for every layer whose pivot was never moved.
   */
  textBox?: (clip: TextClip, localMs: number) => LayerBox | null;
  /** Rasterize clips SVG can't express (returns null to skip with warning). */
  rasterize?: (clipIds: string[]) => SvgRasterPatch | null;
  /** Fraction digits for coordinates (default 2). */
  decimals?: number;
}

export interface SvgResult {
  svg: string;
  warnings: string[];
  width: number;
  height: number;
}

// ── Small writers ────────────────────────────────────────────────────────────

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function fmt(n: number, decimals: number): string {
  const s = n.toFixed(decimals);
  // Trim trailing zeros ("12.50" → "12.5", "12.00" → "12").
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** PathCommand list → SVG path data. */
export function commandsToSvgPath(cmds: PathCommand[], decimals = 2): string {
  const f = (n: number) => fmt(n, decimals);
  const parts: string[] = [];
  for (const c of cmds) {
    if (c.type === "M") parts.push(`M${f(c.x)} ${f(c.y)}`);
    else if (c.type === "L") parts.push(`L${f(c.x)} ${f(c.y)}`);
    else if (c.type === "C") parts.push(`C${f(c.x1)} ${f(c.y1)} ${f(c.x2)} ${f(c.y2)} ${f(c.x)} ${f(c.y)}`);
    else parts.push("Z");
  }
  return parts.join("");
}

/** Subpaths → SVG path data (convenience over `pathCommands`). */
export function subpathsToSvgPath(subpaths: Contour[], decimals = 2): string {
  return commandsToSvgPath(pathCommands(subpaths), decimals);
}

// ── Serializer ───────────────────────────────────────────────────────────────

interface Ctx {
  doc: MotionDocument;
  decimals: number;
  defs: string[];
  warnings: string[];
  idSeq: number;
  resolve: (color: string) => string;
}

function nextId(ctx: Ctx, prefix: string): string {
  return `${prefix}${++ctx.idSeq}`;
}

interface PaintBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A Paint as an SVG attribute value; gradients register a def and return a
 * url() reference. Geometry matches the canvas painter exactly (userSpaceOnUse
 * against the local paint bounds).
 */
function paintRef(ctx: Ctx, paint: Paint, bounds: PaintBounds): { fill: string; opacity: number } {
  if (paint.type === "solid") return { fill: ctx.resolve(paint.color), opacity: paint.opacity };
  if (!isGradientPaint(paint)) {
    // Media/pattern have no native SVG paint server yet — approximate so the SVG
    // stays valid: a pattern falls back to its background, media to nothing.
    if (paint.type === "pattern") return { fill: ctx.resolve(paint.pattern.background), opacity: paint.opacity };
    return { fill: "none", opacity: 0 };
  }
  const f = (n: number) => fmt(n, ctx.decimals);
  const id = nextId(ctx, "g");
  const stops = [...paint.stops]
    .sort((a, b) => a.offset - b.offset)
    .map(
      (s) =>
        `<stop offset="${fmt(Math.min(1, Math.max(0, s.offset)) * 100, 2)}%" stop-color="${esc(ctx.resolve(s.color))}"/>`,
    )
    .join("");
  const sx = bounds.x + paint.start.x * bounds.w;
  const sy = bounds.y + paint.start.y * bounds.h;
  const ex = bounds.x + paint.end.x * bounds.w;
  const ey = bounds.y + paint.end.y * bounds.h;
  if (paint.type === "radial") {
    const r = Math.max(0.001, Math.hypot(ex - sx, ey - sy));
    ctx.defs.push(
      `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${f(sx)}" cy="${f(sy)}" r="${f(r)}">${stops}</radialGradient>`,
    );
  } else {
    // SVG has no native conic paint server — angular exports as its linear axis.
    ctx.defs.push(
      `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${f(sx)}" y1="${f(sy)}" x2="${f(ex)}" y2="${f(ey)}">${stops}</linearGradient>`,
    );
  }
  return { fill: `url(#${id})`, opacity: paint.opacity };
}

const blendAttr = (blend: string) =>
  blend === "normal" ? "" : ` style="mix-blend-mode:${blend}"`;

/** One fill entry as a <path> element. */
function fillElement(ctx: Ctx, d: string, fill: Paint, fillRule: FillRule, bounds: PaintBounds): string {
  const p = paintRef(ctx, fill, bounds);
  const rule = fillRule === "evenodd" ? ` fill-rule="evenodd"` : "";
  const op = p.opacity < 1 ? ` fill-opacity="${fmt(p.opacity, 3)}"` : "";
  return `<path d="${d}" fill="${esc(p.fill)}"${rule}${op}${blendAttr(fill.blendMode)}/>`;
}

/**
 * One stroke entry as element(s). The geometry comes from the SAME
 * `buildStrokePlan` the canvas renderer uses — trim, wave, dash, taper and
 * endpoint markers all resolved once — so an exported SVG and the stage can
 * never disagree about what a stroke looks like.
 *
 * A tapered stroke arrives as a filled RIBBON rather than a stroked path, which
 * SVG represents natively as a `<path fill>`; alignment does not apply to a
 * ribbon (it already has real edges), so it skips the clip/mask branch.
 */
function strokeElement(
  ctx: Ctx,
  cmds: PathCommand[],
  fullD: string,
  stroke: StrokeStyle,
  fillRule: FillRule,
  bounds: PaintBounds,
  reveal?: ReadonlyArray<readonly [number, number, number?]>,
): string {
  const plan = buildStrokePlan(cmds, stroke, reveal);
  const p = paintRef(ctx, stroke.paint, bounds);
  const combinedOpacity = stroke.opacity * p.opacity;
  const opAttr = combinedOpacity < 1 ? ` fill-opacity="${fmt(combinedOpacity, 3)}"` : "";
  const markers = plan.markers.length
    ? `<path d="${commandsToSvgPath(plan.markers, ctx.decimals)}" fill="${esc(p.fill)}"${opAttr}${blendAttr(stroke.blendMode)}/>`
    : "";

  if (plan.ribbon) {
    return `<path d="${commandsToSvgPath(plan.ribbon, ctx.decimals)}" fill="${esc(p.fill)}"${opAttr}${blendAttr(stroke.blendMode)}/>${markers}`;
  }
  if (!plan.path) return markers;

  const strokeD = commandsToSvgPath(plan.path, ctx.decimals);
  const attrs = [
    `d="${strokeD}"`,
    `fill="none"`,
    `stroke="${esc(p.fill)}"`,
    combinedOpacity < 1 ? `stroke-opacity="${fmt(combinedOpacity, 3)}"` : "",
    stroke.cap !== "butt" ? `stroke-linecap="${stroke.cap}"` : "",
    stroke.join !== "miter" ? `stroke-linejoin="${stroke.join}"` : "",
    plan.dash.length ? `stroke-dasharray="${plan.dash.map((v) => fmt(v, 2)).join(" ")}"` : "",
    plan.dashOffset !== 0 ? `stroke-dashoffset="${fmt(-plan.dashOffset, 2)}"` : "",
  ].filter(Boolean);
  const rule = fillRule === "evenodd" ? ` clip-rule="evenodd"` : "";

  if (stroke.align === "center") {
    return `<path ${attrs.join(" ")} stroke-width="${fmt(stroke.width, 2)}"${blendAttr(stroke.blendMode)}/>${markers}`;
  }
  if (stroke.align === "inside") {
    const id = nextId(ctx, "c");
    ctx.defs.push(`<clipPath id="${id}"><path d="${fullD}"${rule}/></clipPath>`);
    return `<path ${attrs.join(" ")} stroke-width="${fmt(stroke.width * 2, 2)}" clip-path="url(#${id})"${blendAttr(stroke.blendMode)}/>${markers}`;
  }
  // outside: doubled width, masked to everything BUT the shape.
  const id = nextId(ctx, "m");
  const B = 1e5;
  ctx.defs.push(
    `<mask id="${id}" maskUnits="userSpaceOnUse" x="${-B}" y="${-B}" width="${2 * B}" height="${2 * B}"><rect x="${-B}" y="${-B}" width="${2 * B}" height="${2 * B}" fill="#fff"/><path d="${fullD}" fill="#000"${rule}/></mask>`,
  );
  return `<path ${attrs.join(" ")} stroke-width="${fmt(stroke.width * 2, 2)}" mask="url(#${id})"${blendAttr(stroke.blendMode)}/>${markers}`;
}

/** Sampled numeric with fallback. */
const num = (sampled: Record<string, KeyframeValue>, key: string, fallback: number): number =>
  typeof sampled[key] === "number" ? (sampled[key] as number) : fallback;

/** One fill entry with its per-id keyframes applied (mirror of the renderer). */
function effectiveFill(fill: Paint, sampled: Record<string, KeyframeValue>): Paint {
  const p = paintWithSampled(fill, `fill.${fill.id}`, sampled);
  const op = sampled[`fill.${fill.id}.opacity`];
  return typeof op === "number" && op !== p.opacity ? { ...p, opacity: op } : p;
}

function effectiveStroke(stroke: StrokeStyle, sampled: Record<string, KeyframeValue>): StrokeStyle {
  const s = sampleStroke(stroke, (path) => {
    const v = sampled[path];
    return typeof v === "number" ? v : undefined;
  });
  return { ...s, paint: paintWithSampled(s.paint, `stroke.${s.id}`, sampled) };
}

/** The pose shared by every visual layer (transform + layer opacity + the
 *  whole-layer in/out animation sampled at this instant). */
function samplePose(clip: VisualClip, sampled: Record<string, KeyframeValue>, localMs: number) {
  const scale = num(sampled, "scale", clip.transform.scale);
  const anim = layerPoseAt(clip, localMs);
  return {
    x: num(sampled, "x", clip.transform.x) + anim.dx,
    y: num(sampled, "y", clip.transform.y) + anim.dy,
    scale: scale * anim.scale,
    scaleY: num(sampled, "scaleY", clip.transform.scaleY ?? scale) * anim.scale,
    rotation: num(sampled, "rotation", clip.transform.rotation) + anim.rotation,
    skewX: num(sampled, "skewX", clip.transform.skewX),
    skewY: num(sampled, "skewY", clip.transform.skewY),
    opacity: num(sampled, "opacity", clip.opacity) * anim.opacity,
    anchor: {
      x: num(sampled, "anchor.x", clip.transform.anchor.x),
      y: num(sampled, "anchor.y", clip.transform.anchor.y),
    },
  };
}

/** The layer <g> wrapper: frame-centered transform + opacity + blend. */
function layerGroup(
  ctx: Ctx,
  clip: VisualClip,
  pose: ReturnType<typeof samplePose>,
  frameW: number,
  frameH: number,
  inner: string,
  selfOpacity = false,
  /** The layer's own box — the pivot is a fraction of it (see transform-map). */
  size?: LayerBox,
): string {
  const f = (n: number) => fmt(n, ctx.decimals);
  const t: string[] = [`translate(${f(frameW / 2 + pose.x)} ${f(frameH / 2 + pose.y)})`];
  if (pose.rotation !== 0) t.push(`rotate(${f(pose.rotation)})`);
  // Shear (K in T·R·K·S) as an exact matrix — SVG's skewX/skewY primitives don't
  // compose to the same matrix, so emit matrix(1, tanY, tanX, 1, 0, 0).
  if (pose.skewX !== 0 || pose.skewY !== 0) {
    const tkx = Math.tan((pose.skewX * Math.PI) / 180);
    const tky = Math.tan((pose.skewY * Math.PI) / 180);
    t.push(`matrix(1 ${f(tky)} ${f(tkx)} 1 0 0)`);
  }
  if (pose.scale !== 1 || pose.scaleY !== pose.scale) t.push(`scale(${f(pose.scale)} ${f(pose.scaleY)})`);
  // Step off the PIVOT last (inside the scaled space) — the same order the
  // renderer uses, so the SVG lands pixel-for-pixel on the canvas output.
  if (size) {
    const a = anchorLocal(pose.anchor, size);
    if (a.x !== 0 || a.y !== 0) t.push(`translate(${f(-a.x)} ${f(-a.y)})`);
  }
  const op = !selfOpacity && pose.opacity < 1 ? ` opacity="${fmt(pose.opacity, 3)}"` : "";
  return `<g transform="${t.join(" ")}"${op}${blendAttr(clip.blendMode)} data-name="${esc(clip.name)}">${inner}</g>`;
}

function serializeVectorClip(
  ctx: Ctx,
  clip: ShapeClip | PathClip,
  localMs: number,
  compTimeMs: number,
  frameW: number,
  frameH: number,
): string {
  const sampled = sampleKeyframes(clip.keyframes, localMs);
  const pose = samplePose(clip, sampled, localMs);
  if (pose.opacity <= 0.001) return "";
  // The draw-on in force at this instant — the same resolver the canvas asks,
  // so an exported frame is inked exactly as far as the stage showed it.
  const reveal = clipRevealAt(ctx.doc, clip, localMs, compTimeMs);

  let cmds: PathCommand[];
  let bounds: PaintBounds;
  let fillRule: FillRule = "nonzero";
  /** The contours, with identity, when this is a path clip (see below). */
  let contours: Subpath[] | null = null;
  if (clip.kind === "shape") {
    const width = Math.max(1, num(sampled, "width", clip.width));
    const height = Math.max(1, num(sampled, "height", clip.height));
    const geo = {
      shape: clip.shape,
      width,
      height,
      cornerRadius: {
        tl: num(sampled, "radius.tl", clip.cornerRadius.tl),
        tr: num(sampled, "radius.tr", clip.cornerRadius.tr),
        br: num(sampled, "radius.br", clip.cornerRadius.br),
        bl: num(sampled, "radius.bl", clip.cornerRadius.bl),
      },
      radius: num(sampled, "radius", clip.radius),
      pointCount: num(sampled, "pointCount", clip.pointCount),
      innerRatio: num(sampled, "innerRatio", clip.innerRatio),
      arcStartDeg: num(sampled, "arcStartDeg", clip.arcStartDeg),
      arcSweepDeg: num(sampled, "arcSweepDeg", clip.arcSweepDeg),
      arcRatio: num(sampled, "arcRatio", clip.arcRatio),
      cornerOffsets: effectiveCornerOffsets(clip.cornerOffsets, sampled),
    };
    cmds = shapeCommands(geo);
    // Paint bounds are the parametric frame — exactly what the canvas uses.
    bounds = { x: -width / 2, y: -height / 2, w: width, h: height };
  } else {
    // Identity-preserving, even mid-morph (`lendIdentity`) — the same brain the
    // renderer uses, so an exported contour is the contour whose override we
    // are about to look up.
    const geometry = pathGeometryAt(clip, sampled);
    contours = geometry;
    cmds = pathCommands(geometry);
    const b = subpathBounds(geometry);
    bounds = b
      ? { x: b.minX, y: b.minY, w: Math.max(1, b.maxX - b.minX), h: Math.max(1, b.maxY - b.minY) }
      : { x: -4, y: -4, w: 8, h: 8 };
    fillRule = clip.fillRule;
  }

  const parts: string[] = [];
  /** Emit one run of geometry under one resolved style. */
  const emit = (
    runCmds: PathCommand[],
    runFills: Paint[],
    runStrokes: StrokeStyle[],
    rule: FillRule,
    windows?: ReadonlyArray<readonly [number, number, number?]>,
  ) => {
    const d = commandsToSvgPath(runCmds, ctx.decimals);
    const fillAlpha = reveal?.fillAlpha ?? 1;
    const fs = runFills
      .filter((f) => f.enabled)
      .map((f) => effectiveFill(f, sampled))
      .map((f) => (fillAlpha < 1 ? { ...f, opacity: f.opacity * fillAlpha } : f))
      .filter((f) => f.opacity > 0.001);
    const ss = runStrokes.map((st) => effectiveStroke(st, sampled)).filter(strokeIsVisible);
    // A layer with no stroke still draws on: the fill's silhouette is inked in
    // the fill's paint — the same pen the canvas borrows.
    if (reveal?.synthesiseOutline) {
      const pen = fs.find((f) => f.type !== "media") ?? runFills.find((f) => f.enabled && f.type !== "media");
      if (pen) ss.unshift(strokeStyle(pen, { width: reveal.reveal.pen, cap: "round", join: "round", opacity: pen.opacity }));
    }
    // Paint bounds stay the WHOLE layer's, so a gradient spans the artwork and
    // not whichever piece is painting — same rule as the canvas.
    for (const fill of fs) parts.push(fillElement(ctx, d, fill, rule, bounds));
    for (const stroke of ss) parts.push(strokeElement(ctx, runCmds, d, stroke, rule, bounds, windows));
  };

  if (clip.kind === "path" && contours && hasContourOverrides(clip)) {
    // Runs of consecutive contours sharing an overlay — order IS paint order,
    // and a compound path stays intact because its holes inherit. Identical
    // rule to the renderer, so an export cannot disagree with the canvas.
    for (let start = 0; start < contours.length; ) {
      const key = contourOverlay(clip, contours[start]!.id);
      let end = start + 1;
      while (end < contours.length && contourOverlay(clip, contours[end]!.id) === key) end++;
      const style = resolveContourStyle(clip, contours[start]!.id);
      emit(pathCommands(contours.slice(start, end)), style.fills, style.strokes, style.fillRule, reveal?.windows.slice(start, end));
      start = end;
    }
  } else {
    emit(cmds, clip.fills, clip.strokes, fillRule, reveal?.windows);
  }
  if (parts.length === 0) return "";
  return layerGroup(
    ctx,
    clip,
    pose,
    frameW,
    frameH,
    parts.join(""),
    false,
    // A path's pivot is a fraction of the outline the CLIP declares, not of the
    // frame a geometry morph happens to be showing — the same box the renderer
    // resolves against, or an exported morph would swim where the canvas holds
    // still. A shape's box is parametric and always centred.
    clip.kind === "path" ? pathBox(clip.subpaths) : { width: bounds.w, height: bounds.h, cx: 0, cy: 0 },
  );
}

function serializeTextClip(
  ctx: Ctx,
  clip: TextClip,
  localMs: number,
  frameW: number,
  frameH: number,
  options: SvgSerializeOptions,
): string {
  const outlines = options.outlineText?.(clip, localMs) ?? null;
  if (!outlines) {
    ctx.warnings.push(`"${clip.name}": text could not be outlined — layer skipped.`);
    return "";
  }
  const sampled = sampleKeyframes(clip.keyframes, localMs);
  const pose = samplePose(clip, sampled, localMs);
  const parts = outlines.map((o) => {
    const rule = o.fillRule === "evenodd" ? ` fill-rule="evenodd"` : "";
    const op = o.opacity !== undefined && o.opacity < 1 ? ` opacity="${fmt(o.opacity, 3)}"` : "";
    const stroke = o.stroke
      ? ` stroke="${esc(o.stroke.color)}" stroke-width="${fmt(o.stroke.width, 2)}" stroke-linejoin="round"`
      : "";
    return `<path d="${o.d}" fill="${esc(o.fill ?? "#000")}"${rule}${op}${stroke}/>`;
  });
  // Text bakes opacity into glyphs (canvas contract) — don't re-apply on the <g>.
  return layerGroup(
    ctx,
    clip,
    pose,
    frameW,
    frameH,
    parts.join(""),
    true,
    options.textBox?.(clip, localMs) ?? undefined,
  );
}

function rasterElement(ctx: Ctx, options: SvgSerializeOptions, clipIds: string[], label: string): string {
  const patch = options.rasterize?.(clipIds);
  if (!patch) {
    ctx.warnings.push(`"${label}": not expressible as vectors — layer skipped.`);
    return "";
  }
  const f = (n: number) => fmt(n, ctx.decimals);
  return `<image href="${patch.href}" x="${f(patch.x)}" y="${f(patch.y)}" width="${f(patch.width)}" height="${f(patch.height)}" data-name="${esc(label)}"/>`;
}

/**
 * Serialize an export target to a standalone SVG document at one instant.
 * Layer order matches the canvas renderer (last track first, track 0 on top).
 */
export function serializeSvgTarget(
  doc: MotionDocument,
  target: ExportTarget,
  options: SvgSerializeOptions,
): SvgResult {
  const frame = doc.frames.find((f) => f.id === target.frameId) ?? doc.frames[0]!;
  const decimals = options.decimals ?? 2;
  const ctx: Ctx = {
    doc,
    decimals,
    defs: [],
    warnings: [],
    idSeq: 0,
    resolve: (c) => resolveColor(doc, c),
  };

  const wanted = new Set(target.clipIds);
  const only = wanted.size > 0;
  // A group that CARRIES A LOOK rasterizes as one unit, because that is what
  // the look is applied to: a tint over the finished picture, one silhouette
  // stroke around it, an effect pass, an opacity, a blend — none of which has a
  // per-member meaning. Its transform counts too: serializing the members on
  // their own would leave the artwork where the document says it is and quietly
  // drop the move the group made.
  //
  // `union` is the one composite mode that needs no pixels of its own — drawing
  // every member in order IS the union — so a plain union keeps its vectors.
  const rasterGroups = new Map(
    allGroupClips(doc)
      .filter((g) => groupCarriesLook(g.mode === "union" ? { ...g, mode: "pass" } : g))
      .map((g) => [g.id, g]),
  );
  const renderedGroups = new Set<string>();

  const body: string[] = [];
  for (let t = doc.tracks.length - 1; t >= 0; t--) {
    const track = doc.tracks[t]!;
    if (track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.kind === "audio" || clip.frameId !== frame.id) continue;
      // A group is a container: its members are serialized in their own right.
      if (clip.kind === "group") continue;
      if (only && !wanted.has(clip.id)) continue;
      const localMs = clipLocalTime(clip, options.timeMs);
      if (localMs === null) continue;

      const group = track.groupId ? rasterGroups.get(track.groupId) : undefined;
      if (group) {
        if (renderedGroups.has(group.id)) continue;
        renderedGroups.add(group.id);
        const memberIds = [];
        for (const tr of doc.tracks) {
          if (tr.groupId !== group.id) continue;
          for (const c of tr.clips)
            if (c.frameId === frame.id && c.kind !== "audio" && (!only || wanted.has(c.id))) memberIds.push(c.id);
        }
        body.push(rasterElement(ctx, options, memberIds, group.name));
        continue;
      }
      if (clip.effects.length > 0) {
        body.push(rasterElement(ctx, options, [clip.id], clip.name));
        continue;
      }

      if (clip.kind === "shape" || clip.kind === "path") {
        body.push(serializeVectorClip(ctx, clip, localMs, options.timeMs, frame.width, frame.height));
      } else if (clip.kind === "text") {
        body.push(serializeTextClip(ctx, clip, localMs, frame.width, frame.height, options));
      } else {
        body.push(rasterElement(ctx, options, [clip.id], clip.name));
      }
    }
  }

  const region = options.region ?? { x: 0, y: 0, width: frame.width, height: frame.height };
  const f = (n: number) => fmt(n, decimals);
  const bg = options.includeBackground
    ? `<rect x="${f(region.x)}" y="${f(region.y)}" width="${f(region.width)}" height="${f(region.height)}" fill="${esc(ctx.resolve(frame.background))}"/>`
    : "";
  const defs = ctx.defs.length ? `<defs>${ctx.defs.join("")}</defs>` : "";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${f(region.width)}" height="${f(region.height)}" ` +
    `viewBox="${f(region.x)} ${f(region.y)} ${f(region.width)} ${f(region.height)}" fill="none">` +
    `${defs}${bg}${body.filter(Boolean).join("")}</svg>`;

  return { svg, warnings: ctx.warnings, width: region.width, height: region.height };
}
