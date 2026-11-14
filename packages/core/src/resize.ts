/**
 * Headless RESIZE MATH — the ONE solver behind every resize gesture in the app:
 * a single layer's handles, the multi-select group box, and the two native
 * geometry modes (a shape's own width/height, a text box's wrap width). The
 * stage used to carry four hand-rolled copies of this arithmetic; they drifted,
 * and each copy independently forgot that a drag can cross its own anchor.
 *
 * ## Mirroring is NEGATIVE SCALE — one fact, one representation
 *
 * Dragging a handle past the corner it is anchored to does not stop at zero: it
 * flips the layer, exactly like Figma/Illustrator. That flip is stored as a
 * negative `transform.scale` / `transform.scaleY` and NOTHING else. There is no
 * `flipX` boolean anywhere in the document — a boolean plus a scale would be two
 * stored fields describing one fact, and they would disagree the moment a
 * keyframe interpolates one of them.
 *
 * The corollary is the reason this module hands back MAGNITUDE and SIGN
 * separately: geometry never goes negative. A shape's `width`, a text box's
 * `maxWidth`, a crop inset — those stay positive magnitudes, because a negative
 * width is meaningless to a corner radius, a stroke join or a line wrapper. So a
 * native-geometry resize that crosses its anchor grows the geometry back up from
 * zero AND multiplies the layer's scale by -1. Both modes end up mirrored; only
 * one of them changed a dimension.
 *
 * Everything works in the box's OWN axes, so a rotated or sheared layer resizes
 * and mirrors along its own edges rather than the world's.
 */

import { anchorLocal, mapLinear, type LayerBox } from "./transform-map";
import type { AnchorPoint } from "./schema/common";

/** Radians per degree. */
const DEG = Math.PI / 180;

/**
 * The sign of a grabbed handle along one of the box's own axes: +1 = the
 * positive side (right / bottom), -1 = the negative side, 0 = an EDGE handle
 * that pins this axis (it has no travel of its own).
 */
export type HandleSign = -1 | 0 | 1;

/** The resized box as it stood when the gesture began, in its own axes. */
export interface ResizeBox {
  /** World center of the box at gesture start. */
  cx: number;
  cy: number;
  /** Box rotation in degrees — its local +X axis relative to world +X. */
  rotation: number;
  /** World half-extents at gesture start. Always positive; must be > 0. */
  halfW: number;
  halfH: number;
  /** Which handle was grabbed, in box axes. The OPPOSITE corner is the anchor. */
  sx: HandleSign;
  sy: HandleSign;
  /**
   * World position of the layer's PIVOT. ⌥/Alt resizes about it — which is the
   * box centre by default and wherever the user moved it otherwise, so "⌥ grows
   * symmetrically" generalizes to "⌥ grows about the pivot" for free. Omit and
   * the centre is used.
   */
  pivot?: { x: number; y: number };
}

export interface ResizeConstraints {
  /** ⌥/Alt — resize about the box CENTER instead of the opposite corner. */
  centerAnchor: boolean;
  /** Lock the aspect ratio (magnitudes only — the two axes may still mirror independently). */
  keepAspect: boolean;
  /**
   * Allow the drag to cross its anchor and flip the layer. False for things that
   * have no meaningful mirror (an artboard, a crop window), which then clamp at
   * zero instead.
   */
  allowMirror: boolean;
}

/**
 * How much the box grew along each of its own axes, SIGNED: `|f|` is the growth
 * factor, `f < 0` means the drag crossed the anchor and the axis is mirrored.
 * `f === 1` on an axis an edge handle pins.
 */
export interface ResizeFactors {
  fx: number;
  fy: number;
}

/** Scale magnitude bounds. Below the floor a layer is unclickable; above the ceiling it is a memory bomb. */
export const MIN_SCALE_ABS = 0.01;
export const MAX_SCALE_ABS = 50;
/**
 * The floor for an EVALUATED scale — keys, expressions, drivers — as opposed
 * to one a hand sets. `MIN_SCALE_ABS` keeps a DRAGGED layer grabbable; applied
 * to animation it was a bug: a camera rig pulling back past 1% (a powers-of-ten
 * zoom, a whole sky of ancestors) froze there and everything inside rendered
 * up to 100× too big, and every "scale to 0" exit left a 1% speck behind. After
 * Effects animates to 0%. This floor only keeps the matrix invertible for hit
 * testing; it is far below anything a pixel can show.
 */
export const MIN_EVAL_SCALE_ABS = 1e-6;

/** The box's own axes as world unit vectors (local +X = ux, local +Y = uy). */
export function localAxes(rotationDeg: number): { uxx: number; uxy: number; uyx: number; uyy: number } {
  const rad = rotationDeg * DEG;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { uxx: cos, uxy: sin, uyx: -sin, uyy: cos };
}

/**
 * The sign a resize factor contributes. Zero counts as POSITIVE: a factor of
 * exactly 0 means the pointer sits on the anchor, and treating that as "not yet
 * mirrored" keeps the flip from chattering as the drag grazes the crossing.
 */
export function resizeSign(f: number): 1 | -1 {
  return f < 0 ? -1 : 1;
}

/**
 * The point that stays PINNED for the whole gesture: the corner/edge opposite
 * the grabbed one, or the box center under ⌥.
 */
export function resizeAnchorPoint(box: ResizeBox, centerAnchor: boolean): { x: number; y: number } {
  if (centerAnchor) return box.pivot ?? { x: box.cx, y: box.cy };
  const { uxx, uxy, uyx, uyy } = localAxes(box.rotation);
  return {
    x: box.cx - box.sx * box.halfW * uxx - box.sy * box.halfH * uyx,
    y: box.cy - box.sx * box.halfW * uxy - box.sy * box.halfH * uyy,
  };
}

/**
 * Pointer → signed growth factors along the box's own axes.
 *
 * The pointer's offset from the anchor is projected onto each local axis and
 * divided by the half-extent the grabbed handle covers, so the factor is 1 the
 * instant the gesture starts and passes smoothly THROUGH 0 into negative
 * territory when the drag crosses the anchor — no clamp, no discontinuity, no
 * special "am I flipped yet" state to keep in sync.
 *
 * Aspect lock couples the two MAGNITUDES and leaves the two signs alone, so
 * dragging a corner diagonally past one edge mirrors that one axis while the
 * proportions hold (Figma). On an edge handle the single moving axis drives
 * both, and the pinned axis (factor 1, sign +) can never introduce a flip.
 */
export function solveResizeFactors(
  box: ResizeBox,
  pointer: { x: number; y: number },
  c: ResizeConstraints,
): ResizeFactors {
  const { uxx, uxy, uyx, uyy } = localAxes(box.rotation);
  const a = resizeAnchorPoint(box, c.centerAnchor);
  // The grabbed handle's start position (an edge handle's is its midpoint).
  const hx = box.cx + box.sx * box.halfW * uxx + box.sy * box.halfH * uyx;
  const hy = box.cy + box.sx * box.halfW * uxy + box.sy * box.halfH * uyy;
  const proj = (px: number, py: number) => ({
    x: px * uxx + py * uxy,
    y: px * uyx + py * uyy,
  });
  // The factor is simply "how far along this axis the pointer is, relative to
  // where the handle started" — both measured from the anchor. That single
  // statement covers all four cases the old code special-cased: corner vs edge,
  // and opposite-corner vs ⌥-pivot anchoring. It also passes smoothly THROUGH 0
  // into negative territory when the drag crosses the anchor, which is the
  // mirror — no clamp, no discontinuity, no "am I flipped yet" state.
  const q = proj(hx - a.x, hy - a.y);
  const d = proj(pointer.x - a.x, pointer.y - a.y);
  const EPS = 1e-6;
  let fx = box.sx === 0 || Math.abs(q.x) < EPS ? 1 : d.x / q.x;
  let fy = box.sy === 0 || Math.abs(q.y) < EPS ? 1 : d.y / q.y;
  if (!c.allowMirror) {
    fx = Math.max(0, fx);
    fy = Math.max(0, fy);
  }
  if (c.keepAspect) {
    // Aspect lock couples the two MAGNITUDES and leaves the two signs alone, so
    // dragging a corner diagonally past one edge mirrors that one axis while the
    // proportions hold (Figma). On an edge handle the single moving axis drives
    // both, and the pinned axis (factor 1, sign +) can never introduce a flip.
    const edge = box.sx === 0 || box.sy === 0;
    const mag = edge
      ? Math.abs(box.sx === 0 ? fy : fx)
      : Math.max(Math.abs(fx), Math.abs(fy));
    fx = mag * resizeSign(fx);
    fy = mag * resizeSign(fy);
  }
  return { fx, fy };
}

/**
 * Where the box centre lands so the ANCHOR stays pinned, given the factors the
 * resize actually realized — i.e. after each mode's own clamping and coupling,
 * not the raw ones the pointer asked for.
 *
 * The box is simply scaled about the anchor in the box's own axes: `|f|` scales
 * the centre's offset from the anchor and `f < 0` reflects it across, which is
 * what makes a flip look like the layer folded over its pinned edge instead of
 * teleporting. With ⌥ (anchor = the pivot) an off-centre pivot correctly sweeps
 * the box around itself, and a centred one leaves it exactly where it was.
 *
 * Every mode reduces to this one call, which is the point: a shape reports
 * `newWidth / startWidth`, a scaled layer reports `newScale / startScale`, a
 * text box reports `newWrap / startWrap` — and an axis the drag doesn't touch
 * reports 1. No mode re-derives where the box goes.
 */
export function resizeCenter(
  box: ResizeBox,
  realized: ResizeFactors,
  centerAnchor: boolean,
): { x: number; y: number } {
  const a = resizeAnchorPoint(box, centerAnchor);
  const { uxx, uxy, uyx, uyy } = localAxes(box.rotation);
  const dx = box.cx - a.x;
  const dy = box.cy - a.y;
  const px = (dx * uxx + dy * uxy) * realized.fx;
  const py = (dx * uyx + dy * uyy) * realized.fy;
  return { x: a.x + px * uxx + py * uyx, y: a.y + px * uxy + py * uyy };
}

/**
 * The factor a mode actually realized on one axis: the achieved size ratio
 * carrying the requested mirror sign. Feeding this (rather than the raw pointer
 * factor) to `resizeCenter` is what keeps the anchor pinned when a clamp bites —
 * at a shape's minimum width, at the scale ceiling, or on an axis whose geometry
 * simply doesn't track the drag.
 */
export function realizedFactor(next: number, start: number, requested: number): number {
  const ratio = Math.abs(next) / Math.max(1e-6, Math.abs(start));
  return resizeSign(requested) * ratio;
}

/**
 * Clamp a scale to a usable MAGNITUDE while preserving its sign, so a mirrored
 * layer clamps to -0.01/-50 rather than being yanked back to positive. Zero maps
 * to the positive floor (a layer with no scale at all can never be grabbed again).
 * This is the only place scale bounds are decided.
 */
export function clampScale(v: number, min = MIN_SCALE_ABS, max = MAX_SCALE_ABS): number {
  if (!Number.isFinite(v)) return min;
  const mag = Math.min(max, Math.max(min, Math.abs(v)));
  return v < 0 ? -mag : mag;
}

/**
 * Carry a mirror onto a scale WITHOUT touching its magnitude — the native
 * geometry modes' half of the flip (the other half grew a positive width).
 */
export function mirrorScale(startScale: number, f: number): number {
  return f < 0 ? -startScale : startScale;
}

/**
 * The per-axis scale pair with `scaleY: null` (uniform) resolved. `null` means
 * "mirror `scale`", which is a genuine space saving for the common case but is
 * exactly wrong the moment ONE axis flips — hence this pair and `flipScalePair`.
 */
export interface ScalePair {
  scale: number;
  /** `null` = uniform: Y mirrors X. Kept null whenever the two agree, to avoid schema noise. */
  scaleY: number | null;
}

/** Resolve a possibly-uniform pair to two concrete numbers. */
export function resolveScalePair(t: ScalePair): { x: number; y: number } {
  return { x: t.scale, y: t.scaleY ?? t.scale };
}

/**
 * Flip a transform across one axis. The trap this exists to prevent: a uniform
 * layer stores `scaleY: null`, so negating `scale` alone would flip BOTH axes —
 * a 180° rotation, not a mirror. Flipping X therefore MATERIALIZES the Y scale
 * first. Flipping Y on a uniform layer materializes it as the negated value and
 * leaves X alone, for the same reason.
 */
export function flipScalePair(t: ScalePair, axis: "x" | "y"): ScalePair {
  const { x, y } = resolveScalePair(t);
  if (axis === "x") {
    const nx = -x;
    // Uniform only survives if the two still agree (they can't, unless |x| flipped into y's value).
    return { scale: nx, scaleY: nx === y ? null : y };
  }
  const ny = -y;
  return { scale: x, scaleY: ny === x ? null : ny };
}

/* ───────────────────────────────────── where the LAYER goes, not the box ── */

/**
 * The pose a resize starts from — everything needed to say where the layer's
 * POSITION has to be once its box has moved.
 */
export interface ResizePose {
  /** `transform.x/y` at gesture start. */
  x: number;
  y: number;
  scale: number;
  scaleY: number;
  rotation: number;
  skewX: number;
  skewY: number;
  /** Normalized pivot (a fraction of `size`). */
  anchor: AnchorPoint;
  /** The box that fraction is of, at gesture start. */
  size: LayerBox;
}

/**
 * WHERE THE LAYER'S POSITION LANDS — the second half of every resize, and the
 * half that has to know a layer is PLACED BY ITS PIVOT while a resize is
 * SPECIFIED BY ITS BOX.
 *
 * `resizeCenter` above says where the box centre must sit for the grabbed
 * handle's anchor to stay pinned. That is not what a layer stores. The stored
 * position is the pivot's, and the offset from pivot to box centre rides both
 * the scale and the box size — both of which a resize changes — so the centre's
 * travel alone under-reports the move by exactly:
 *
 *     L₁(pivot − boxCentre) − L₀(pivot − boxCentre)
 *
 * ## One formula, both placement models
 *
 * This document has two: a leaf's `x/y` IS its pivot, while a GROUP's `x/y` is a
 * DELTA about a pivot derived from the box of what it holds (`group-space.ts`).
 * Their box centres therefore sit at `position + L(c − p)` and
 * `position + p + L(c − p)` — genuinely different placements.
 *
 * **A resize never moves the pivot**, so that extra `p` is the same before and
 * after and cancels out of the difference. What is left is this expression, for
 * both. The stage used to carry a second, group-specific derivation at the call
 * site; it was not a different fact, it was the same fact derived twice, and the
 * copy applied its correction in a space it had already left — so a group crept
 * on every pointer move. There is one derivation now, and it is tested against
 * the only thing that actually matters: the pinned point does not move.
 *
 * ## Measured from the box CENTRE, not from the origin
 *
 * `anchorLocal` alone was the offset for years, and it is right for every kind
 * whose geometry is authored about its own origin — a shape, an image, a text
 * box, a nested comp. A PATH's outline wanders off its origin the moment a node
 * is dragged, and a GROUP's box is the union of its members wherever they sit.
 * For those, `boxCentre` is nowhere near zero, so the old expression reported a
 * correction for a layer whose pivot was dead centre and had nothing to correct
 * — adding the artwork's own offset on top of a box that had already moved.
 * Pull such a layer's handle and it slid by (Δscale × that offset), every frame,
 * for as long as the drag lasted.
 *
 * `centreDelta` is `resizeCenter(...) − (box.cx, box.cy)`: how far the box
 * centre travelled, in the same space the position is written in.
 */
export function resizePosition(
  start: ResizePose,
  next: { scale: number; scaleY: number; size: LayerBox },
  centreDelta: { x: number; y: number },
): { x: number; y: number } {
  const offset = (box: LayerBox) => {
    const p = anchorLocal(start.anchor, box);
    return { x: p.x - box.cx, y: p.y - box.cy };
  };
  const o0 = offset(start.size);
  const o1 = offset(next.size);
  // A centred pivot on an unchanged box has no offset to carry at any scale —
  // the case almost every layer is in, and the reason a plain centre delta was
  // right until pivots existed.
  if (o0.x === 0 && o0.y === 0 && o1.x === 0 && o1.y === 0) {
    return { x: start.x + centreDelta.x, y: start.y + centreDelta.y };
  }
  const shape = { rotation: start.rotation, skewX: start.skewX, skewY: start.skewY };
  const before = mapLinear(o0.x, o0.y, { ...shape, scale: start.scale, scaleY: start.scaleY });
  const after = mapLinear(o1.x, o1.y, { ...shape, scale: next.scale, scaleY: next.scaleY });
  return {
    x: start.x + centreDelta.x + (after.x - before.x),
    y: start.y + centreDelta.y + (after.y - before.y),
  };
}
