import type { PathClip, ShapeClip, TextAlign, TextPathSpec } from "../schema";
import { sampleKeyframes } from "../animation/keyframes";
import { resolveShapeGeometry } from "../animation/paths";
import { pathCommands, pathGeometryAt, shapeCommands, type PathCommand } from "../vector/geometry";
import { flattenCommands, polylineAt, type Polyline, type Pt } from "../vector/polyline";

/**
 * TEXT ON A PATH — the placement maths, headless.
 *
 * A laid-out line of text is a row of glyphs with an x along the baseline; a
 * path is a polyline with a distance along it. Putting one on the other is one
 * map, `laid x → arc length`, and everything a surface asks — where a glyph
 * sits, which way it turns, whether the pointer is on the outline, where a drag
 * along the curve lands — is a question about that one map. It lives here,
 * once, so the canvas, the caret overlay, the hit test and the drag handle
 * cannot disagree about where a letter is.
 *
 * Nothing here knows about fonts. The layout engine (web, `text-layout.ts`)
 * measures the glyphs and hands their advances in; this hands back a pose per
 * glyph. That split is the same one `measure.ts` describes: core owns the
 * geometry, the surface owns the measurement.
 */

/** One laid glyph's extent along the baseline, in layout px. */
export interface GlyphAdvance {
  /** Left edge, in the layout's own x (block-centred, so usually negative on the left). */
  x: number;
  width: number;
  /**
   * Baseline offset from the FIRST line's baseline (0 on the first line). A
   * second line stacks INSIDE the curve — concentric, the way a ring of text is
   * lettered — so the offset runs against the up-vector.
   */
  dy: number;
}

/** Where a glyph lands: its baseline centre, and the baseline's angle. */
export interface PathGlyphPose {
  x: number;
  y: number;
  /** Radians; 0 = a horizontal baseline reading left to right. */
  angle: number;
  /** False for a glyph that ran off an open path with `loop` off. */
  visible: boolean;
}

/** The subset of the spec the placement actually reads. */
export type PathPlacementSpec = Pick<TextPathSpec, "offset" | "rise" | "flip" | "follow" | "loop">;

/**
 * Where the run's ANCHOR sits along the block — the point that lands at
 * `offset`. `left` puts the run's start there so the text extends forward from
 * the offset; `center` balances it about the offset; `right` ends it there.
 * It is the text's own `align`, read here so there is not a second alignment
 * concept for the path case.
 */
function anchorX(advances: readonly GlyphAdvance[], align: TextAlign): number {
  let min = Infinity;
  let max = -Infinity;
  for (const a of advances) {
    min = Math.min(min, a.x);
    max = Math.max(max, a.x + a.width);
  }
  if (!Number.isFinite(min)) return 0;
  return align === "left" || align === "justify" ? min : align === "right" ? max : (min + max) / 2;
}

/** Positive modulo, for wrapping a distance onto a closed length. */
function wrap(d: number, length: number): number {
  if (length <= 0) return 0;
  const m = d % length;
  return m < 0 ? m + length : m;
}

/**
 * THE PLACEMENT. One pose per advance, in the host's local coordinates (the
 * space its outline is authored in).
 *
 * Reading direction is the path's direction of travel, or its reverse under
 * `flip`; the up-vector is the travel direction turned a quarter turn towards
 * screen-up, so on a clockwise shape the letters stand on the outside. `rise`
 * lifts along that up-vector; a second line stacks against it.
 */
export function placeGlyphsOnPath(
  advances: readonly GlyphAdvance[],
  pl: Polyline,
  spec: PathPlacementSpec,
  align: TextAlign,
): PathGlyphPose[] {
  const L = pl.length;
  const anchor = anchorX(advances, align);
  const dir = spec.flip ? -1 : 1;
  const s0 = spec.offset * L;
  return advances.map((a) => {
    const along = (a.x + a.width / 2 - anchor) * dir;
    let d = s0 + along;
    let visible = true;
    if (spec.loop) d = wrap(d, L);
    else if (d < 0 || d > L) visible = false;
    const p = polylineAt(pl, d);
    // Baseline direction: travel, or its reverse.
    const bx = p.tx * dir;
    const by = p.ty * dir;
    // Up = baseline turned toward screen-up (y is down, so (bx,by)→(by,-bx)).
    const ux = by;
    const uy = -bx;
    const lift = spec.rise - a.dy;
    return {
      x: p.x + ux * lift,
      y: p.y + uy * lift,
      angle: spec.follow === "upright" ? 0 : Math.atan2(by, bx),
      visible,
    };
  });
}

/** The axis-aligned box of a set of poses, or null when none is visible. */
export function poseBounds(poses: readonly PathGlyphPose[], pad = 0): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poses) {
    if (!p.visible) continue;
    minX = Math.min(minX, p.x - pad);
    minY = Math.min(minY, p.y - pad);
    maxX = Math.max(maxX, p.x + pad);
    maxY = Math.max(maxY, p.y + pad);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

// ── The host's outline ───────────────────────────────────────────────────────

/** A layer whose outline text can ride. */
export type PathHostClip = ShapeClip | PathClip;

export function isPathHost(clip: { kind: string } | null | undefined): clip is PathHostClip {
  return !!clip && (clip.kind === "shape" || clip.kind === "path");
}

/**
 * The host's outline at one of ITS local instants, as commands in its own
 * space — keyframed width, corner radii, arc sweep, a morph key, all resolved.
 * The same geometry the host paints, by construction: it is built from the
 * same two resolvers the renderer calls.
 */
export function hostOutlineAt(host: PathHostClip, hostLocalMs: number): PathCommand[] {
  const sampled = sampleKeyframes(host.keyframes, hostLocalMs);
  return host.kind === "shape"
    ? shapeCommands(resolveShapeGeometry(host, sampled))
    : pathCommands(pathGeometryAt(host, sampled));
}

/**
 * The outline flattened to arc-length polylines, one per contour. Memoised on
 * the host CLIP OBJECT for the last instant asked — the renderer, the hit test,
 * the box measurer and the drag handle all ask for the same (clip, time) many
 * times per frame, and a resolved document hands every one of them the same
 * frozen clip.
 */
const outlineMemo = new WeakMap<PathHostClip, { t: number; pls: Polyline[] }>();

export function hostPolylinesAt(host: PathHostClip, hostLocalMs: number): Polyline[] {
  const hit = outlineMemo.get(host);
  if (hit && hit.t === hostLocalMs) return hit.pls;
  const pls = flattenCommands(hostOutlineAt(host, hostLocalMs), 0.25);
  // Every clip that reaches here is immutable — the store's (immer freezes)
  // or a bake's (frozen on the way out) — so identity + instant is a safe key.
  outlineMemo.set(host, { t: hostLocalMs, pls });
  return pls;
}

/** The contour the spec names, clamped into range; null when the host has none. */
export function hostContour(pls: readonly Polyline[], contour: number): Polyline | null {
  if (pls.length === 0) return null;
  return pls[Math.min(pls.length - 1, Math.max(0, contour))] ?? null;
}

// ── Pointer ↔ outline ────────────────────────────────────────────────────────

/** The closest point on a polyline to `pt`: where, how far, and how far ALONG. */
export interface OutlineHit {
  x: number;
  y: number;
  /** Distance from `pt` to the outline. */
  dist: number;
  /** Arc length from the contour's start to the hit. */
  d: number;
  /** Which contour, for a multi-contour host. */
  contour: number;
}

/** Nearest point on ONE polyline. */
export function nearestOnPolyline(pl: Polyline, pt: Pt): Omit<OutlineHit, "contour"> {
  let best: Omit<OutlineHit, "contour"> = { x: pl.pts[0]?.x ?? 0, y: pl.pts[0]?.y ?? 0, dist: Infinity, d: 0 };
  for (let i = 1; i < pl.pts.length; i++) {
    const a = pl.pts[i - 1]!;
    const b = pl.pts[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 <= 1e-12 ? 0 : Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2));
    const x = a.x + dx * t;
    const y = a.y + dy * t;
    const dist = Math.hypot(pt.x - x, pt.y - y);
    if (dist < best.dist) best = { x, y, dist, d: pl.cum[i - 1]! + Math.sqrt(len2) * t };
  }
  return best;
}

/** Nearest point across every contour of a host. */
export function nearestOnOutline(pls: readonly Polyline[], pt: Pt): OutlineHit | null {
  let best: OutlineHit | null = null;
  pls.forEach((pl, contour) => {
    const h = nearestOnPolyline(pl, pt);
    if (!best || h.dist < best.dist) best = { ...h, contour };
  });
  return best;
}

/**
 * The offset (in laps) that puts the run's anchor at arc length `d` — the
 * inverse of the placement's first line, for a click that binds and a drag
 * that slides. A drag hands in the previous offset so the result stays on the
 * same LAP: without that a slide across the seam of a circle would snap the
 * value from 0.98 to 0.02 and a keyframe between the two would spin the text
 * the long way round.
 */
export function offsetForArcLength(d: number, length: number, near?: number): number {
  if (length <= 0) return 0;
  const frac = d / length;
  if (near === undefined) return frac;
  const lap = Math.floor(near);
  const candidates = [lap - 1, lap, lap + 1].map((k) => k + frac);
  let best = candidates[0]!;
  for (const c of candidates) if (Math.abs(c - near) < Math.abs(best - near)) best = c;
  return best;
}

/** The anchor's point and direction on the outline, for drawing the grip. */
export function pathAnchorPose(pl: Polyline, spec: PathPlacementSpec): PathGlyphPose {
  const [pose] = placeGlyphsOnPath([{ x: 0, width: 0, dy: 0 }], pl, spec, "center");
  return pose!;
}
