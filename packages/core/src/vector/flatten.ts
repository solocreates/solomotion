import { type MultiPolygon } from "polygon-clipping";
import type { MotionDocument, GroupMode, KeyframeValue, Paint, StrokeStyle, VisualClip } from "../schema";
import type { Contour, PathPoint } from "../schema/vector";
import { anchorLocal, type LayerBox } from "../transform-map";
import { pathBox } from "../pivot";
import {
  multiPolyToSubpaths,
  ringsToMultiPoly,
  robustBoolean,
  subpathToRing,
} from "./polygon";
import {
  commandsToSubpaths,
  copySubpaths,
  pathGeometryAt,
  shapeCommands,
  subpathBounds,
  type Bounds,
} from "./geometry";
import {
  frameLayerTree,
  type GroupLayerNode,
  type LayerTreeNode,
} from "../timeline/layer-tree";
import { selectionTopUnits } from "../timeline/groups";
import { sampleKeyframes } from "../animation/keyframes";
import { clipRenderLocalTime } from "../animation/evaluate";
import { trackLocalTime } from "../drawing/flipbook";
import { resolveShapeGeometry } from "../animation/paths";
import { isIdentityPose, layerPoseAt } from "../animation/layer-animation";
import type { GlyphVisual } from "../animation/presets";
import { groupDeltaMatrix, groupPivotPlaced } from "../timeline/group-space";
import { multiply as matMul, translation, rotation, scaling, type Mat2D } from "../navigation/matrix";

/**
 * Flatten-to-path — THE headless brain that turns any selection into ONE exact
 * vector path. Figma's ⌘E: a shape, a text run, a boolean/combine group, or a
 * deep nest of them collapses to a single filled outline.
 *
 * It is a pure geometry reducer with two representations working in tandem:
 *
 *  1. **Exact béziers** (comp space) — a lone shape/path/text stays its true
 *     curved outline; disjoint pieces just concatenate. Curves survive until a
 *     boolean genuinely forces a merge.
 *  2. **Polygon regions** (via `polygon-clipping`) — the moment overlapping
 *     geometry has to be unioned/subtracted/intersected/excluded/masked, we
 *     flatten curves to a high-resolution polyline, run robust polygon booleans,
 *     and emit the resulting outline (with real holes).
 *
 * The reduction walks the SAME layer tree the renderer composites, honouring
 * each group's mode with the SAME orientation (subtract = bottom minus the ones
 * above; mask = content ∩ the union of direct `isStencil` stencils), so the
 * flattened path is geometrically identical to what the composite paints — at
 * ANY nesting depth.
 *
 * Text is the one thing core can't vectorize itself (fonts live in the app), so
 * callers inject outlines through `FlattenOptions.outlineOf`.
 */

export interface FlattenOptions {
  /** Curve→polyline tolerance in comp px when a boolean forces flattening. */
  tolerance?: number;
  /**
   * Local-space (transform-anchored) outlines for clips core can't vectorize —
   * text/caption above all. Returns null when unavailable (the clip is skipped).
   */
  outlineOf?: (clip: VisualClip) => Contour[] | null;
  /**
   * SAMPLE THE ANIMATION at this COMP time (ms), instead of baking the declared
   * geometry.
   *
   * ⌘E is a static bake — you flatten what you designed, at rest — and that is
   * still the default (omit this). A GROUP'S SILHOUETTE is the opposite
   * question: it is the outline of what the group looks like RIGHT NOW, so a
   * member that is moving, scaling, morphing or not yet on screen has to be
   * read at the playhead or the stroke around the group drifts away from the
   * art inside it.
   *
   * One reducer, one optional time — never a second flattener, because a second
   * one would disagree about a composite mode at depth the first week it
   * existed. Each member resolves its OWN local time through its track (speed,
   * loop, reverse and trim included), exactly as the renderer does, and a
   * member outside its span contributes nothing.
   *
   * Text is the exception: `outlineOf` hands back a laid-out outline the caller
   * produced, so an animated text member contributes its box at the pose it
   * holds, not per-glyph animation.
   */
  atMs?: number;
}

export interface FlattenResult {
  /** Merged outline in comp coordinates (frame-center relative). */
  subpaths: Contour[];
  bounds: Bounds;
  /** Paints inherited from the topmost contributing layer (Figma's rule). */
  fills: Paint[];
  strokes: StrokeStyle[];
  fillRule: "nonzero" | "evenodd";
}

// ── Region: exact béziers + a lazily-flattened polygon view ──────────────────

interface Region {
  /** Exact outline in comp space (authoritative while `exact` is true). */
  beziers: Contour[];
  bbox: Bounds | null;
  /** Cached polygon form; computed on first boolean. */
  poly: MultiPolygon | null;
  fillRule: "nonzero" | "evenodd";
  /** True while `beziers` are original curves (no boolean applied yet). */
  exact: boolean;
}

const EMPTY: Region = { beziers: [], bbox: null, poly: [], fillRule: "nonzero", exact: true };

/**
 * The reduction's shared state: the options, the flattening tolerance, and —
 * when a time was given — the per-clip keyframe sampler. `null` sampler is the
 * static bake, and every branch below reads `ctx.sampled(clip)` rather than
 * asking whether a time exists, so the two modes cannot drift apart.
 */
interface FlattenCtx {
  doc: MotionDocument;
  /** The group being flattened, when one is — placed by its caller, not here. */
  root: string | null;
  opts: FlattenOptions;
  tol: number;
  /** Sampled keyframes at the clip's own local time; null = not live right now. */
  sampled: (clip: VisualClip) => Record<string, KeyframeValue> | null;
  /** The clip's own local time — null in the static bake, where nothing is "now". */
  localTime: (clip: VisualClip) => number | null;
}

const STATIC_SAMPLE: Record<string, KeyframeValue> = {};

/**
 * The CLOCK for a comp time: track-local, span-aware, per clip — the sampled
 * keyframes and the local time they were sampled at, from one lookup, so the
 * geometry and the in/out pose of a layer can never be read at two instants.
 */
function buildClock(doc: MotionDocument, atMs: number | undefined): Pick<FlattenCtx, "sampled" | "localTime"> {
  if (atMs == null) return { sampled: () => STATIC_SAMPLE, localTime: () => null };
  const trackOf = new Map<string, (typeof doc.tracks)[number]>();
  for (const track of doc.tracks) for (const clip of track.clips) trackOf.set(clip.id, track);
  const cache = new Map<string, { values: Record<string, KeyframeValue>; localMs: number } | null>();
  const at = (clip: VisualClip) => {
    const hit = cache.get(clip.id);
    if (hit !== undefined) return hit;
    const track = trackOf.get(clip.id);
    let out: { values: Record<string, KeyframeValue>; localMs: number } | null = null;
    // Off the lane's clock, hidden, or inside a group whose window has closed
    // over it: not on screen, so no silhouette. The enclosing groups are read
    // by the tree walk (`reduceNode` stops at a group that is off), so only the
    // clip's own lane and span are asked here.
    if (track && !track.hidden && !clip.hidden) {
      const local = clipRenderLocalTime(track, clip, trackLocalTime(track, clip.frameId, atMs));
      out = local ? { values: sampleKeyframes(clip.keyframes, local.local), localMs: local.local } : null;
    }
    cache.set(clip.id, out);
    return out;
  };
  return { sampled: (clip) => at(clip)?.values ?? null, localTime: (clip) => at(clip)?.localMs ?? null };
}

/**
 * A layer's IN/OUT POSE as a matrix about its pivot, in comp space — the same
 * arc `withLayer` composites an animating buffer along, so the outline a group
 * strokes around a member that is flying, spinning or popping in is the
 * outline of where that member IS, not where it will land.
 */
function animMatrix(anim: GlyphVisual, pivot: { x: number; y: number }): Mat2D {
  let m = translation(pivot.x + anim.dx, pivot.y + anim.dy);
  m = matMul(m, rotation(anim.rotation));
  m = matMul(m, scaling(anim.scale, anim.scale));
  return matMul(m, translation(-pivot.x, -pivot.y));
}

function mapContours(subs: Contour[], m: Mat2D): Contour[] {
  const map = (x: number, y: number) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });
  return subs.map((s) => ({
    ...s,
    points: s.points.map((p) => ({
      ...p,
      ...map(p.x, p.y),
      hIn: p.hIn ? map(p.hIn.x, p.hIn.y) : null,
      hOut: p.hOut ? map(p.hOut.x, p.hOut.y) : null,
    })),
  }));
}

/** A reduced region, moved by a matrix — curves and any polygon view alike. */
function mapRegion(r: Region, m: Mat2D): Region {
  if (r.bbox == null) return r;
  const beziers = mapContours(r.beziers, m);
  const poly = r.poly
    ? (r.poly.map((polygon) => polygon.map((ring) => ring.map(([x, y]) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f] as [number, number]))) as MultiPolygon)
    : null;
  const bbox = r.exact ? subpathBounds(beziers) : polyBounds(poly ?? []);
  return { ...r, beziers, poly, bbox };
}

function polyBounds(mp: MultiPolygon): Bounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const polygon of mp) for (const ring of polygon) for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

// ── Local geometry extraction (kind → clip-local subpaths) ────────────────────

function clipLocalSubpaths(
  clip: VisualClip,
  ctx: FlattenCtx,
  sampled: Record<string, KeyframeValue>,
): Contour[] | null {
  switch (clip.kind) {
    case "shape": {
      // The SAMPLED geometry — a shape whose width, radius, star points or arc
      // sweep animate is a different silhouette at every frame, and
      // `resolveShapeGeometry` is the one seam the renderer and every on-stage
      // handle already read it through.
      const geo = resolveShapeGeometry(clip, sampled);
      return commandsToSubpaths(shapeCommands(geo));
    }
    case "path":
      // A morph key holds a whole geometry; `pathGeometryAt` is the one place
      // that decides between it and the declared contours.
      return copySubpaths(pathGeometryAt(clip, sampled));
    default:
      /*
       * EVERY kind core cannot vectorize asks the caller — media, rasters,
       * nested comps and text alike.
       *
       * This used to be `case "text"` with media falling through to `null`,
       * and that was the bug behind "the stroke around my mask follows the
       * wrong shape". A group's silhouette supplies `outlineOf` precisely so
       * the layers it cannot turn into curves still contribute their box; a
       * text member took it and a photo did not, so a mask group holding an
       * image reduced to `content = ∅` and the stroke ran around whatever
       * vector happened to be in there beside it — or around nothing at all.
       *
       * Asking for every unvectorizable kind is also the only version that
       * stays right as kinds are added: a new raster-ish clip gets the
       * caller's outline for free instead of silently contributing nothing.
       * ⌘E is unaffected — it passes no `outlineOf` for media, so a bake still
       * refuses to approximate artwork it would be replacing.
       */
      return ctx.opts.outlineOf?.(clip) ?? null;
  }
}

/**
 * Map a clip's local outline into comp space through its transform, the same
 * mapping the renderer uses: world = (x,y) + R(rot)·K·(scale·lx, scaleY·ly).
 *
 * The values are the SAMPLED ones when a time was given (see `atMs`), the
 * declared ones otherwise — one map, either way, so a group's live silhouette
 * and its ⌘E bake can never place the same layer differently.
 */
function worldSubpaths(
  subs: Contour[],
  clip: VisualClip,
  size: LayerBox,
  sampled: Record<string, KeyframeValue>,
): Contour[] {
  const t = clip.transform;
  const n = (key: string, base: number) =>
    typeof sampled[key] === "number" ? (sampled[key] as number) : base;
  // The pivot is where `t.x/y` sits — geometry is authored about the box center,
  // so it is measured from the pivot before the linear map (see transform-map).
  const anchor = anchorLocal(
    { x: n("anchor.x", t.anchor.x), y: n("anchor.y", t.anchor.y) },
    size,
  );
  const sx = n("scale", t.scale);
  // `scaleY: null` mirrors X — and a keyed `scaleY` breaks that link, exactly
  // as `resolveScaleY` does for the renderer.
  const sy = typeof sampled["scaleY"] === "number"
    ? (sampled["scaleY"] as number)
    : t.scaleY == null
      ? sx
      : t.scaleY;
  const tx = n("x", t.x);
  const ty = n("y", t.y);
  const rad = (n("rotation", t.rotation) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const tkx = Math.tan((n("skewX", t.skewX) * Math.PI) / 180);
  const tky = Math.tan((n("skewY", t.skewY) * Math.PI) / 180);
  const map = (x: number, y: number): { x: number; y: number } => {
    // Scale → shear → rotate → translate (T·R·K·S), matching the renderer.
    const scx = (x - anchor.x) * sx;
    const scy = (y - anchor.y) * sy;
    const lx = scx + tkx * scy;
    const ly = scy + tky * scx;
    return { x: tx + lx * cos - ly * sin, y: ty + lx * sin + ly * cos };
  };
  return subs.map((s) => ({
    closed: s.closed,
    points: s.points.map((p): PathPoint => {
      const a = map(p.x, p.y);
      return {
        x: a.x,
        y: a.y,
        hIn: p.hIn ? map(p.hIn.x, p.hIn.y) : null,
        hOut: p.hOut ? map(p.hOut.x, p.hOut.y) : null,
      };
    }),
  }));
}

function clipRegion(clip: VisualClip, ctx: FlattenCtx): Region {
  // A member that is not on screen at this moment has no silhouette. (In the
  // static bake every clip reads as live, which is what ⌘E means.)
  const sampled = ctx.sampled(clip);
  if (!sampled) return EMPTY;
  const local = clipLocalSubpaths(clip, ctx, sampled);
  if (!local || local.length === 0) return EMPTY;
  // The pivot is a FRACTION of the layer's box, so flatten needs that box. A
  // shape states it outright; anything else takes its outline extent, which is
  // the same box the renderer lays out in (for text it is the ink extent rather
  // than the laid-out line box — a sub-pixel difference, and text flatten is an
  // approximation via `outlineOf` anyway).
  const size: LayerBox =
    clip.kind === "shape"
      ? {
          width: typeof sampled["width"] === "number" ? (sampled["width"] as number) : clip.width,
          height: typeof sampled["height"] === "number" ? (sampled["height"] as number) : clip.height,
          cx: 0,
          cy: 0,
        }
      : pathBox(local);
  let world = worldSubpaths(local, clip, size, sampled);
  // THE IN/OUT POSE, live. A member mid-animation is a different silhouette —
  // and a member faded all the way out is no silhouette at all.
  const t = ctx.localTime(clip);
  if (t != null) {
    const anim = layerPoseAt(clip, t);
    if (anim.opacity <= 0.001) return EMPTY;
    if (!isIdentityPose(anim)) {
      const n = (key: string, base: number) => (typeof sampled[key] === "number" ? (sampled[key] as number) : base);
      world = mapContours(world, animMatrix(anim, { x: n("x", clip.transform.x), y: n("y", clip.transform.y) }));
    }
  }
  const bbox = subpathBounds(world);
  if (!bbox) return EMPTY;
  return {
    beziers: world,
    bbox,
    poly: null,
    fillRule: clip.kind === "path" ? clip.fillRule : "nonzero",
    exact: true,
  };
}

function regionPoly(r: Region, tol: number): MultiPolygon {
  if (r.poly) return r.poly;
  const rings = r.beziers.map((s) => subpathToRing(s, tol));
  r.poly = ringsToMultiPoly(rings);
  return r.poly;
}

function regionFromMultiPoly(mp: MultiPolygon): Region {
  const beziers = multiPolyToSubpaths(mp);
  return { beziers, bbox: subpathBounds(beziers), poly: mp, fillRule: "nonzero", exact: false };
}

// ── Region combination ────────────────────────────────────────────────────────

function bboxOverlap(a: Bounds, b: Bounds): boolean {
  const eps = 0.01;
  return a.minX <= b.maxX + eps && b.minX <= a.maxX + eps && a.minY <= b.maxY + eps && b.minY <= a.maxY + eps;
}

function mergeBounds(list: Bounds[]): Bounds | null {
  if (list.length === 0) return null;
  const b = { ...list[0]! };
  for (const o of list.slice(1)) {
    b.minX = Math.min(b.minX, o.minX);
    b.minY = Math.min(b.minY, o.minY);
    b.maxX = Math.max(b.maxX, o.maxX);
    b.maxY = Math.max(b.maxY, o.maxY);
  }
  return b;
}

/** All bounding boxes mutually non-overlapping (conservative: bbox includes handles). */
function allDisjoint(regs: Region[]): boolean {
  for (let i = 0; i < regs.length; i++) {
    for (let j = i + 1; j < regs.length; j++) {
      if (bboxOverlap(regs[i]!.bbox!, regs[j]!.bbox!)) return false;
    }
  }
  return true;
}

function unionRegions(regs: Region[], tol: number): Region {
  const live = regs.filter((r) => r.bbox);
  if (live.length === 0) return EMPTY;
  if (live.length === 1) return live[0]!;
  // Disjoint curves that all fill nonzero can simply coexist as subpaths — no
  // boolean, so their curves survive untouched (the common "flatten two circles").
  if (live.every((r) => r.exact && r.fillRule === "nonzero") && allDisjoint(live)) {
    return {
      beziers: live.flatMap((r) => r.beziers),
      bbox: mergeBounds(live.map((r) => r.bbox!)),
      poly: null,
      fillRule: "nonzero",
      exact: true,
    };
  }
  const polys = live.map((r) => regionPoly(r, tol));
  // A boolean that fails outright leaves the operands where they were, rather
  // than losing the artwork (see `robustBoolean`).
  const merged = robustBoolean("union", polys);
  return merged ? regionFromMultiPoly(merged) : live[0]!;
}

/** Combine ordered (top→bottom) regions under a boolean op, matching the renderer. */
function booleanRegions(mode: GroupMode, regs: Region[], tol: number): Region {
  const live = regs.filter((r) => r.bbox);
  if (live.length === 0) return EMPTY;
  if (live.length === 1) return live[0]!;
  const polys = live.map((r) => regionPoly(r, tol));
  let mp: MultiPolygon | null;
  switch (mode) {
    case "subtract": {
      // Renderer paints bottom child first, then knocks the ones above out of it.
      const base = polys[polys.length - 1]!;
      const cutters = polys.slice(0, -1);
      mp = cutters.length ? robustBoolean("difference", [base, ...cutters]) : base;
      break;
    }
    case "intersect":
      mp = robustBoolean("intersection", polys);
      break;
    case "exclude":
      mp = robustBoolean("xor", polys);
      break;
    default:
      mp = robustBoolean("union", polys);
      break;
  }
  return mp ? regionFromMultiPoly(mp) : live[0]!;
}

// ── Layer-tree reduction ──────────────────────────────────────────────────────

function reduceNode(node: LayerTreeNode, ctx: FlattenCtx): Region {
  const tol = ctx.tol;
  if (node.type === "clip") {
    return node.clip.hidden ? EMPTY : clipRegion(node.clip, ctx);
  }
  // A NESTED GROUP that is not showing right now — hidden, or outside its own
  // span at this moment — contributes nothing, exactly as its members would
  // not paint. Its span is a window (`withinGroupWindow`); the live sampler
  // answers "is this clip on at this moment" for a group like any clip.
  if (node.clip.hidden || !ctx.sampled(node.clip)) return EMPTY;
  return placeGroup(node, reduceGroupContents(node, ctx), ctx);
}

/**
 * A NESTED group is placed the way the painter places it: its members are
 * reduced in the parent's space, then the whole result takes the group's own
 * transform (`groupDeltaMatrix`) and its in/out pose about its pivot — the
 * two things `withGroupTransform` and `withLayer` do to its pixels. The ROOT
 * of a flatten is left in place: the renderer applies its delta when it
 * strokes the outline, and ⌘E writes the result where the members were.
 */
function placeGroup(node: GroupLayerNode, region: Region, ctx: FlattenCtx): Region {
  if (ctx.root === node.clip.id || region.bbox == null) return region;
  const t = ctx.localTime(node.clip);
  const localMs = t ?? 0;
  let out = region;
  const delta = groupDeltaMatrix(ctx.doc, node.clip, localMs);
  if (delta) out = mapRegion(out, delta);
  if (t != null) {
    const anim = layerPoseAt(node.clip, t);
    if (anim.opacity <= 0.001) return EMPTY;
    if (!isIdentityPose(anim)) out = mapRegion(out, animMatrix(anim, groupPivotPlaced(ctx.doc, node.clip, t)));
  }
  return out;
}

function reduceGroupContents(node: GroupLayerNode, ctx: FlattenCtx): Region {
  const tol = ctx.tol;
  const children = node.children.filter((c) => !(c.type === "clip" && c.clip.hidden));
  const mode = node.clip.mode;
  if (mode === "pass" || mode === "union") {
    return unionRegions(children.map((c) => reduceNode(c, ctx)), tol);
  }
  // Every other mode reads the SAME role split the renderer does: the stencil
  // members union into one shape, and the mode applies it to the content. So a
  // flatten of a two-cutter subtract is geometrically what the canvas painted.
  const stencils = children.filter((c) => c.clip.isStencil);
  const contents = children.filter((c) => !c.clip.isStencil);
  const content = unionRegions(contents.map((c) => reduceNode(c, ctx)), tol);
  if (stencils.length === 0) return content;
  const stencil = unionRegions(stencils.map((c) => reduceNode(c, ctx)), tol);
  // `booleanRegions` takes the LAST region as the base (it mirrors the paint
  // order, bottom-most last), so content goes last: content − stencil.
  return booleanRegions(mode === "mask" ? "intersect" : mode, [stencil, content], tol);
}

function indexGroupNodes(nodes: LayerTreeNode[], into: Map<string, GroupLayerNode>): void {
  for (const node of nodes) {
    if (node.type === "group") {
      into.set(node.clip.id, node);
      indexGroupNodes(node.children, into);
    }
  }
}

// ── Public entry ──────────────────────────────────────────────────────────────

/**
 * Flatten a selection of clip ids to ONE path. Whole selected groups fold under
 * their composite mode (any depth); loose clips and multiple units union
 * (Figma's ⌘E). Returns null when nothing in the selection yields geometry.
 */
export function flattenClipsToPath(
  doc: MotionDocument,
  clipIds: string[],
  opts: FlattenOptions = {},
): FlattenResult | null {
  const tol = opts.tolerance ?? 0.3;
  const ctx: FlattenCtx = { doc, opts, tol, root: clipIds.length === 1 ? clipIds[0]! : null, ...buildClock(doc, opts.atMs) };
  const byId = new Map<string, VisualClip>();
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== "audio") byId.set(clip.id, clip);
    }
  }
  const selected = clipIds.map((id) => byId.get(id)).filter((c): c is VisualClip => !!c);
  if (selected.length === 0) return null;
  const frameId = selected[0]!.frameId;
  const inFrame = selected.filter((c) => c.frameId === frameId);

  const tree = frameLayerTree(doc, frameId);
  const groupNodes = new Map<string, GroupLayerNode>();
  indexGroupNodes(tree, groupNodes);

  const units = selectionTopUnits(doc, inFrame.map((c) => c.id));
  const regions: Region[] = [];
  for (const gid of units.groups) {
    const node = groupNodes.get(gid);
    if (node) regions.push(reduceNode(node, ctx));
  }
  for (const cid of units.clips) {
    const clip = byId.get(cid);
    if (clip) regions.push(clipRegion(clip, ctx));
  }

  const merged = regions.length === 1 ? regions[0]! : unionRegions(regions, tol);
  if (!merged.bbox || merged.beziers.length === 0) return null;

  // Paints from the topmost contributing layer (smallest track index in frame).
  const order = new Map<string, number>();
  doc.tracks.forEach((t, i) => t.clips.forEach((c) => order.set(c.id, i)));
  const topClip = [...inFrame].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))[0]!;

  return {
    subpaths: merged.beziers,
    bounds: merged.bbox,
    fills: topClip.fills,
    strokes: topClip.strokes,
    fillRule: merged.fillRule,
  };
}
