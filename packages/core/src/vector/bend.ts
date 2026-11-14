import type { Contour, PathPoint } from "../schema/vector";
import { isSmoothNode } from "./edit-engine";

/**
 * SEGMENT BEND — the ⌘-drag in Figma's vector edit and Illustrator's curvature
 * drag: grab ANY point of a segment and pull, and the whole curve bends so it
 * passes through the pointer. Both handles move; the anchors do not.
 *
 * The cubic is B(t) = (1-t)³P0 + 3(1-t)²t·P1 + 3(1-t)t²·P2 + t³P3. Moving P1 by
 * o1 and P2 by o2 moves B(t) by 3(1-t)²t·o1 + 3(1-t)t²·o2. Splitting the needed
 * displacement Δ between the two by a weight w gives
 *     o1 = (1-w)Δ / (3t(1-t)²)      o2 = wΔ / (3t²(1-t))
 * which lands B(t) on the pointer EXACTLY for any w. w is Inkscape's smooth
 * ramp of t (0 near the start, 1 near the end), so a grab near one anchor moves
 * mostly that anchor's handle — what a hand on a real spline does.
 *
 * Always computed from the geometry at PRESS (`BendGrab`), never accumulated
 * move by move, so a long drag cannot drift and the inverse drag restores the
 * curve exactly.
 */

type Vec2 = { x: number; y: number };

/** The segment `index → index+1` (wrapping on a closed run), as it was at press. */
export interface BendGrab {
  sub: number;
  index: number;
  /** Curve parameter of the grabbed point, clamped clear of the anchors. */
  t: number;
  p0: Vec2;
  p1: Vec2;
  p2: Vec2;
  p3: Vec2;
  /** Pointer minus the curve point at press, so the press itself never jumps the curve. */
  grip: Vec2;
  /** Whether each anchor was smooth at press, so its far arm can follow. */
  smoothA: boolean;
  smoothB: boolean;
}

/** t is kept off the anchors: at 0 or 1 the handle a grab moves has no leverage. */
export const BEND_T_MIN = 0.06;

export const cubicAt = (p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 => {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
};

/** Inkscape's split of the pull between the two handles. */
export function bendWeight(t: number): number {
  if (t <= 1 / 6) return 0;
  if (t <= 0.5) return (6 * t - 1) ** 3 / 16;
  if (t <= 5 / 6) return 1 - (6 * (1 - t) - 1) ** 3 / 16;
  return 1;
}

/** The anchors and control points of a segment (a missing handle sits on its anchor). */
export function segmentControls(sub: Contour, index: number): [Vec2, Vec2, Vec2, Vec2] | null {
  const n = sub.points.length;
  if (index < 0 || index >= n || (!sub.closed && index === n - 1)) return null;
  const a = sub.points[index]!;
  const b = sub.points[(index + 1) % n]!;
  return [
    { x: a.x, y: a.y },
    a.hOut ? { x: a.hOut.x, y: a.hOut.y } : { x: a.x, y: a.y },
    b.hIn ? { x: b.hIn.x, y: b.hIn.y } : { x: b.x, y: b.y },
    { x: b.x, y: b.y },
  ];
}

/**
 * The parameter of the point on a segment nearest `p`: a coarse scan then a few
 * Newton-free bisection refinements. Good to well under a pixel for any segment
 * a person can see.
 */
export function nearestT(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, p: Vec2): number {
  const d2 = (t: number) => {
    const q = cubicAt(p0, p1, p2, p3, t);
    return (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
  };
  const N = 48;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i <= N; i++) {
    const d = d2(i / N);
    if (d < bestD) {
      bestD = d;
      best = i / N;
    }
  }
  let lo = Math.max(0, best - 1 / N);
  let hi = Math.min(1, best + 1 / N);
  for (let k = 0; k < 30; k++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (d2(m1) < d2(m2)) hi = m2;
    else lo = m1;
  }
  return (lo + hi) / 2;
}

/** Capture a bend at press: the segment, and where on it the pointer landed. */
export function beginBend(subs: ReadonlyArray<Contour>, sub: number, index: number, at: Vec2): BendGrab | null {
  const s = subs[sub];
  if (!s) return null;
  const raw = segmentControls(s, index);
  if (!raw) return null;
  // A missing handle becomes the neutral third-of-chord arm (`curveSegment`'s
  // shape): the same straight line, but evenly parameterised, so t means "how
  // far along" and a bend of a straight segment pulls like a rope.
  const n0 = s.points[index]!;
  const c: [Vec2, Vec2, Vec2, Vec2] = [
    raw[0],
    n0.hOut ? raw[1] : { x: raw[0].x + (raw[3].x - raw[0].x) / 3, y: raw[0].y + (raw[3].y - raw[0].y) / 3 },
    s.points[(index + 1) % s.points.length]!.hIn ? raw[2] : { x: raw[3].x - (raw[3].x - raw[0].x) / 3, y: raw[3].y - (raw[3].y - raw[0].y) / 3 },
    raw[3],
  ];
  const t = Math.min(1 - BEND_T_MIN, Math.max(BEND_T_MIN, nearestT(...c, at)));
  const on = cubicAt(...c, t);
  const n = s.points.length;
  return {
    sub,
    index,
    t,
    p0: c[0],
    p1: c[1],
    p2: c[2],
    p3: c[3],
    grip: { x: at.x - on.x, y: at.y - on.y },
    smoothA: isSmoothNode(s.points[index]!) && !!s.points[index]!.hIn,
    smoothB: isSmoothNode(s.points[(index + 1) % n]!) && !!s.points[(index + 1) % n]!.hOut,
  };
}

/** The two control points that put B(grab.t) on `to` (less the press grip). Pure. */
export function bendControls(grab: BendGrab, to: Vec2): { p1: Vec2; p2: Vec2 } {
  const { t, p0, p1, p2, p3 } = grab;
  const now = cubicAt(p0, p1, p2, p3, t);
  const dx = to.x - grab.grip.x - now.x;
  const dy = to.y - grab.grip.y - now.y;
  const w = bendWeight(t);
  const k1 = (1 - w) / (3 * t * (1 - t) ** 2);
  const k2 = w / (3 * t * t * (1 - t));
  return { p1: { x: p1.x + dx * k1, y: p1.y + dy * k1 }, p2: { x: p2.x + dx * k2, y: p2.y + dy * k2 } };
}

/**
 * Write the bend into `subs` (a draft copy). A smooth anchor stays smooth: its
 * far arm turns to stay collinear with the moved one, keeping its own length —
 * otherwise every bend would crease the curve at both ends.
 */
export function applyBend(subs: Contour[], grab: BendGrab, to: Vec2): boolean {
  const s = subs[grab.sub];
  if (!s) return false;
  const n = s.points.length;
  const a = s.points[grab.index];
  const b = s.points[(grab.index + 1) % n];
  if (!a || !b) return false;
  const { p1, p2 } = bendControls(grab, to);
  a.hOut = keepDepth(a.hOut, p1);
  b.hIn = keepDepth(b.hIn, p2);
  if (grab.smoothA) a.hIn = opposite(a, p1, a.hIn);
  if (grab.smoothB) b.hOut = opposite(b, p2, b.hOut);
  return true;
}

const keepDepth = (old: PathPoint["hOut"], p: Vec2): NonNullable<PathPoint["hOut"]> =>
  old && old.z !== undefined ? { x: p.x, y: p.y, z: old.z } : { x: p.x, y: p.y };

/** The far arm of a smooth anchor, re-aimed opposite `toward`, its length kept. */
function opposite(anchor: PathPoint, toward: Vec2, far: PathPoint["hIn"]): PathPoint["hIn"] {
  if (!far) return far;
  const len = Math.hypot(far.x - anchor.x, far.y - anchor.y);
  const dx = toward.x - anchor.x;
  const dy = toward.y - anchor.y;
  const dl = Math.hypot(dx, dy);
  if (dl < 1e-9 || len < 1e-9) return far;
  return keepDepth(far, { x: anchor.x - (dx / dl) * len, y: anchor.y - (dy / dl) * len });
}
