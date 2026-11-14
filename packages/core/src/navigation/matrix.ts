/**
 * A minimal 2D affine matrix — the geometry currency of the navigation system.
 *
 * Deliberately NOT `DOMMatrix`: the navigation brain is headless (it runs in
 * tests, in the exporter, in a worker, on the server), so it may not touch a
 * browser global. Everything here is pure data; a surface that wants a
 * `DOMMatrix` builds one from `[a,b,c,d,e,f]` at the edge.
 *
 * Convention matches CSS/canvas: column-vector, `p' = M · p`, composition
 * left-to-right in application order (`multiply(parent, child)` = apply parent
 * after child, i.e. the usual `parent.multiply(child)`).
 */

import type { Vec2 } from "../schema";

export type { Vec2 };

export interface Mat2D {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY: Mat2D = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function multiply(m: Mat2D, n: Mat2D): Mat2D {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

export function translation(x: number, y: number): Mat2D {
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
}

export function rotation(deg: number): Mat2D {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

export function scaling(sx: number, sy: number): Mat2D {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

/** The K in T·R·K·S: `x += tan(skewX)·y`, `y += tan(skewY)·x` (degrees). */
export function shear(skewXDeg: number, skewYDeg: number): Mat2D {
  return {
    a: 1,
    b: Math.tan((skewYDeg * Math.PI) / 180),
    c: Math.tan((skewXDeg * Math.PI) / 180),
    d: 1,
    e: 0,
    f: 0,
  };
}

export function apply(m: Mat2D, p: Vec2): Vec2 {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

/** Inverse, or `null` for a degenerate (zero-determinant) matrix. */
export function invert(m: Mat2D): Mat2D | null {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-12) return null;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}

/** Map a point through the inverse, or return it unchanged if degenerate. */
export function applyInverse(m: Mat2D, p: Vec2): Vec2 {
  const inv = invert(m);
  return inv ? apply(inv, p) : p;
}

/** The four corners of a local-space rect mapped through `m` (TL, TR, BR, BL). */
export function quadOf(m: Mat2D, width: number, height: number): [Vec2, Vec2, Vec2, Vec2] {
  return [
    apply(m, { x: 0, y: 0 }),
    apply(m, { x: width, y: 0 }),
    apply(m, { x: width, y: height }),
    apply(m, { x: 0, y: height }),
  ];
}

/** Axis-aligned bounds of a local-space rect mapped through `m`. */
export function boundsOf(
  m: Mat2D,
  width: number,
  height: number,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const q = quadOf(m, width, height);
  return {
    minX: Math.min(q[0].x, q[1].x, q[2].x, q[3].x),
    minY: Math.min(q[0].y, q[1].y, q[2].y, q[3].y),
    maxX: Math.max(q[0].x, q[1].x, q[2].x, q[3].x),
    maxY: Math.max(q[0].y, q[1].y, q[2].y, q[3].y),
  };
}

/** Flatten for `ctx.setTransform` / `new DOMMatrix(...)`. */
export function toArray(m: Mat2D): [number, number, number, number, number, number] {
  return [m.a, m.b, m.c, m.d, m.e, m.f];
}

/** A local-space rectangle (top-left + size). */
export interface LocalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * HOW MANY PIXELS a span of `span` device px needs: the ceiling, after
 * forgiving floating-point noise.
 *
 * A comp 1080 wide drawn at 0.4 is 432 px — but a scale read back from a
 * DOMMatrix is single precision (0.4000000059604645), so it came out
 * 432.0000064 and `Math.ceil` made 433: a buffer one column wider than its
 * picture, its last column empty. Everything that reads the buffer's edge then
 * read nothing: an RGB split repeating its edge left a red-less line down the
 * right of the frame, and a blur or glow pulled a dark rim in from it. A span
 * within a thousandth of a whole pixel IS that whole pixel. Never below 1.
 */
export function pixelCount(span: number): number {
  return Math.max(1, Math.ceil(span - 1e-3));
}

/**
 * THE PIXEL-GRID EDGE — `rect` nudged (≤ half a device pixel per edge) so that,
 * seen through `m` (local → device pixels), its edges land on whole pixels.
 *
 * Why a box edge must sit on the grid: two layers that END AT THE SAME EDGE —
 * a comp's dark background and the paper laid over it, both cut by the same
 * crop — are each anti-aliased on their own. A pixel the edge half-covers gets
 * `a·dark` and then `a·paper` over that, so `a·(1−a)` of the dark survives as a
 * seam that no single layer drew. It flickers as the edge slides through the
 * sub-pixel positions of an animated scale. A clip whose edges sit on the grid
 * covers every pixel fully or not at all, so nothing layered inside it can
 * seam at that edge.
 *
 * Only an axis-aligned mapping has a pixel grid to land on; under rotation or
 * shear the rect comes back unchanged. So does a degenerate one.
 */
export function snapRectToPixels(m: Mat2D, rect: LocalRect): LocalRect {
  const EPS = 1e-9;
  if (Math.abs(m.b) > EPS || Math.abs(m.c) > EPS || Math.abs(m.a) < EPS || Math.abs(m.d) < EPS) return rect;
  const snapAxis = (lo: number, size: number, scale: number, offset: number): [number, number] => {
    const d0 = Math.round(scale * lo + offset);
    const d1 = Math.round(scale * (lo + size) + offset);
    const l0 = (d0 - offset) / scale;
    const l1 = (d1 - offset) / scale;
    return [Math.min(l0, l1), Math.abs(l1 - l0)];
  };
  const [x, width] = snapAxis(rect.x, rect.width, m.a, m.e);
  const [y, height] = snapAxis(rect.y, rect.height, m.d, m.f);
  return { x, y, width, height };
}
