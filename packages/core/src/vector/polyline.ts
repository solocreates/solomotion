import type { PathCommand } from "./geometry";

/**
 * Arc-length polylines — the sampled counterpart to `trim.ts`.
 *
 * `trim.ts` CUTS exact béziers, which is right when the answer is still a
 * curve. Everything that has to reason about "how far along the line am I, and
 * which way does it point here" — displacing a stroke sideways, varying its
 * width, placing an arrowhead, walking a dash pattern — needs the other
 * representation: a polyline parameterised by distance. This is that kit, and
 * it exists once so those four features cannot disagree about arc length.
 *
 * Flattening is deterministic (subdivision derived from the control polygon and
 * a tolerance), never adaptive-random, so the same geometry produces the same
 * samples on every machine and in the exporter.
 */

export interface Pt {
  x: number;
  y: number;
}

/** A flattened contour: points, whether it closes, and cumulative arc length. */
export interface Polyline {
  pts: Pt[];
  closed: boolean;
  /** `cum[i]` = arc length from `pts[0]` to `pts[i]`. Length `pts.length`. */
  cum: number[];
  length: number;
}

/** A point on a polyline plus the unit tangent there. */
export interface PolySample extends Pt {
  /** Unit tangent (direction of travel). */
  tx: number;
  ty: number;
}

const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);

/** Subdivision count for one cubic: proportional to its control polygon, so a
 *  tight curve gets more segments and a near-straight one costs almost nothing. */
function cubicSteps(p0: Pt, c1: Pt, c2: Pt, p1: Pt, tolerance: number): number {
  const rough = dist(p0, c1) + dist(c1, c2) + dist(c2, p1);
  return Math.max(2, Math.min(96, Math.ceil(Math.sqrt(rough / Math.max(0.01, tolerance)))));
}

function cubicPoint(p0: Pt, c1: Pt, c2: Pt, p1: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p1.x,
    y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p1.y,
  };
}

/** Fill in `cum`/`length` for a contour whose `pts` are set. */
function measure(pl: Polyline): Polyline {
  const cum = [0];
  let acc = 0;
  for (let i = 1; i < pl.pts.length; i++) {
    acc += dist(pl.pts[i - 1]!, pl.pts[i]!);
    cum.push(acc);
  }
  pl.cum = cum;
  pl.length = acc;
  return pl;
}

/**
 * Flatten a command list to arc-length polylines, one per subpath. A closed
 * subpath repeats its first point as its last, so `cum` covers the closing
 * segment and walking distance across the seam needs no special case.
 */
export function flattenCommands(cmds: readonly PathCommand[], tolerance = 0.3): Polyline[] {
  const out: Polyline[] = [];
  let cur: Polyline | null = null;
  let pen: Pt = { x: 0, y: 0 };
  let start: Pt = { x: 0, y: 0 };

  const flush = () => {
    if (cur && cur.pts.length > 1) out.push(measure(cur));
    cur = null;
  };

  for (const c of cmds) {
    switch (c.type) {
      case "M":
        flush();
        pen = { x: c.x, y: c.y };
        start = pen;
        cur = { pts: [pen], closed: false, cum: [], length: 0 };
        break;
      case "L":
        if (!cur) break;
        pen = { x: c.x, y: c.y };
        cur.pts.push(pen);
        break;
      case "C": {
        if (!cur) break;
        const p1 = { x: c.x, y: c.y };
        const c1 = { x: c.x1, y: c.y1 };
        const c2 = { x: c.x2, y: c.y2 };
        const steps = cubicSteps(pen, c1, c2, p1, tolerance);
        for (let i = 1; i <= steps; i++) cur.pts.push(cubicPoint(pen, c1, c2, p1, i / steps));
        pen = p1;
        break;
      }
      case "Z":
        if (!cur) break;
        cur.closed = true;
        if (dist(pen, start) > 1e-9) cur.pts.push({ x: start.x, y: start.y });
        pen = start;
        flush();
        break;
    }
  }
  flush();
  return out;
}

/** Total arc length across every contour. */
/**
 * Is `p` inside the polygon `poly` closes? Ray casting, the standard even-odd
 * test — it works for self-intersecting outlines, which matters twice: a
 * hand-drawn lasso crosses itself constantly, and a star's outline is one
 * self-crossing contour. A winding-number test would quietly drop the lobes.
 */
export function pointInPolygon(p: Pt, poly: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Is `p` inside any of these closed contours? Open ones enclose nothing. */
export function pointInPolylines(p: Pt, pls: readonly Polyline[]): boolean {
  return pls.some((pl) => pl.closed && pointInPolygon(p, pl.pts));
}

export function totalLength(pls: readonly Polyline[]): number {
  let n = 0;
  for (const pl of pls) n += pl.length;
  return n;
}

/**
 * The point and unit tangent at `d` px along `pl`. Clamped at both ends (a
 * distance past the end returns the end), which is what every caller wants —
 * dash walking and marker placement both land exactly on the terminus.
 */
export function polylineAt(pl: Polyline, d: number): PolySample {
  const n = pl.pts.length;
  if (n === 0) return { x: 0, y: 0, tx: 1, ty: 0 };
  if (n === 1) return { ...pl.pts[0]!, tx: 1, ty: 0 };
  const target = Math.min(pl.length, Math.max(0, d));
  // Binary search the cumulative table for the segment containing `target`.
  let lo = 1;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pl.cum[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  const a = pl.pts[lo - 1]!;
  const b = pl.pts[lo]!;
  const segLen = pl.cum[lo]! - pl.cum[lo - 1]!;
  const t = segLen <= 1e-9 ? 0 : (target - pl.cum[lo - 1]!) / segLen;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const m = Math.hypot(dx, dy) || 1;
  return { x: a.x + dx * t, y: a.y + dy * t, tx: dx / m, ty: dy / m };
}

/** Resample a contour to evenly spaced points (inclusive of both ends). */
export function resample(pl: Polyline, count: number): PolySample[] {
  const n = Math.max(2, Math.floor(count));
  const out: PolySample[] = [];
  for (let i = 0; i < n; i++) out.push(polylineAt(pl, (pl.length * i) / (n - 1)));
  return out;
}

/** Points → a command list (one `M` + `L`s, closed with `Z`). */
export function pointsToCommands(pts: readonly Pt[], closed: boolean): PathCommand[] {
  if (pts.length < 2) return [];
  const out: PathCommand[] = [{ type: "M", x: pts[0]!.x, y: pts[0]!.y }];
  for (let i = 1; i < pts.length; i++) out.push({ type: "L", x: pts[i]!.x, y: pts[i]!.y });
  if (closed) out.push({ type: "Z" });
  return out;
}

/** Polylines → a command list, contours concatenated in order. */
export function polylinesToCommands(pls: readonly Polyline[]): PathCommand[] {
  const out: PathCommand[] = [];
  for (const pl of pls) {
    // A closed contour repeats its first point; drop it and let `Z` close.
    const pts = pl.closed ? pl.pts.slice(0, -1) : pl.pts;
    out.push(...pointsToCommands(pts, pl.closed));
  }
  return out;
}

/**
 * Deterministic value noise in −1…1, smooth between integer stations. Seeded so
 * a rough stroke looks the same every frame (and in the exporter) — a random
 * one would shimmer during playback, which is the classic "why does my hand-
 * drawn line boil" bug.
 */
export function valueNoise(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const s = f * f * (3 - 2 * f);
  return hash(i, seed) * (1 - s) + hash(i + 1, seed) * s;
}

function hash(i: number, seed: number): number {
  let h = Math.imul(i ^ seed, 0x27d4eb2d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}
