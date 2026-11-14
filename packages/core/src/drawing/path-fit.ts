import type { Contour, PathPoint } from "../schema";

/**
 * Curve fitting — a freehand polyline becomes an editable Bézier `Contour`
 * (Schneider's least-squares algorithm, the same one Illustrator/Inkscape
 * pencil tools use). This is the vector brush's core: strokes land as the
 * SAME path clips the pen tool edits — smooth handles, few anchors, no
 * thousand-point polylines in the document.
 */

interface Pt {
  x: number;
  y: number;
}

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a: Pt, s: number): Pt => ({ x: a.x * s, y: a.y * s });
const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y;
const norm = (a: Pt): number => Math.hypot(a.x, a.y);
function normalize(a: Pt): Pt {
  const n = norm(a);
  return n < 1e-12 ? { x: 0, y: 0 } : { x: a.x / n, y: a.y / n };
}

/** One fitted cubic: p0, p0+out-handle, p3+in-handle, p3 (absolute points). */
type Cubic = [Pt, Pt, Pt, Pt];

function bezierPoint(c: Cubic, t: number): Pt {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const cc = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * c[0].x + b * c[1].x + cc * c[2].x + d * c[3].x,
    y: a * c[0].y + b * c[1].y + cc * c[2].y + d * c[3].y,
  };
}

/** Chord-length parameterization of the points. */
function chordLengths(pts: Pt[], first: number, last: number): number[] {
  const u: number[] = [0];
  for (let i = first + 1; i <= last; i++) {
    u.push(u[u.length - 1]! + norm(sub(pts[i]!, pts[i - 1]!)));
  }
  const total = u[u.length - 1]!;
  return total < 1e-12 ? u.map(() => 0) : u.map((v) => v / total);
}

/** Least-squares fit of one cubic to points[first..last] with end tangents. */
function generateBezier(pts: Pt[], first: number, last: number, u: number[], tHat1: Pt, tHat2: Pt): Cubic {
  const n = last - first + 1;
  const A: Array<[Pt, Pt]> = [];
  for (let i = 0; i < n; i++) {
    const t = u[i]!;
    A.push([scale(tHat1, 3 * t * (1 - t) * (1 - t)), scale(tHat2, 3 * t * t * (1 - t))]);
  }
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;
  const p0 = pts[first]!;
  const p3 = pts[last]!;
  for (let i = 0; i < n; i++) {
    const t = u[i]!;
    const b0 = (1 - t) ** 3;
    const b1 = 3 * t * (1 - t) ** 2;
    const b2 = 3 * t * t * (1 - t);
    const b3 = t ** 3;
    const tmp = sub(
      pts[first + i]!,
      add(scale(p0, b0 + b1), scale(p3, b2 + b3)),
    );
    c00 += dot(A[i]![0], A[i]![0]);
    c01 += dot(A[i]![0], A[i]![1]);
    c11 += dot(A[i]![1], A[i]![1]);
    x0 += dot(A[i]![0], tmp);
    x1 += dot(A[i]![1], tmp);
  }
  const detC0C1 = c00 * c11 - c01 * c01;
  const detC0X = c00 * x1 - c01 * x0;
  const detXC1 = x0 * c11 - x1 * c01;
  let alphaL = detC0C1 < 1e-12 ? 0 : detXC1 / detC0C1;
  let alphaR = detC0C1 < 1e-12 ? 0 : detC0X / detC0C1;
  const segLength = norm(sub(p3, p0));
  const epsilon = 1e-6 * segLength;
  if (alphaL < epsilon || alphaR < epsilon) {
    // Wu/Barsky heuristic fallback.
    alphaL = alphaR = segLength / 3;
  }
  return [p0, add(p0, scale(tHat1, alphaL)), add(p3, scale(tHat2, alphaR)), p3];
}

/** Max squared distance of points to the curve; returns [error, splitIndex]. */
function computeMaxError(pts: Pt[], first: number, last: number, curve: Cubic, u: number[]): [number, number] {
  let maxDist = 0;
  let splitPoint = (last - first + 1) >> 1;
  for (let i = first + 1; i < last; i++) {
    const p = bezierPoint(curve, u[i - first]!);
    const v = sub(p, pts[i]!);
    const dist = v.x * v.x + v.y * v.y;
    if (dist > maxDist) {
      maxDist = dist;
      splitPoint = i;
    }
  }
  return [maxDist, splitPoint];
}

/** Newton–Raphson parameter refinement (one pass). */
function reparameterize(pts: Pt[], first: number, last: number, u: number[], curve: Cubic): number[] {
  return u.map((t, i) => {
    const p = pts[first + i]!;
    const d = bezierPoint(curve, t);
    // Derivatives
    const c1: Cubic = curve;
    const qp: Pt = {
      x: 3 * ((c1[1].x - c1[0].x) * (1 - t) ** 2 + 2 * (c1[2].x - c1[1].x) * (1 - t) * t + (c1[3].x - c1[2].x) * t * t),
      y: 3 * ((c1[1].y - c1[0].y) * (1 - t) ** 2 + 2 * (c1[2].y - c1[1].y) * (1 - t) * t + (c1[3].y - c1[2].y) * t * t),
    };
    const qpp: Pt = {
      x: 6 * ((c1[2].x - 2 * c1[1].x + c1[0].x) * (1 - t) + (c1[3].x - 2 * c1[2].x + c1[1].x) * t),
      y: 6 * ((c1[2].y - 2 * c1[1].y + c1[0].y) * (1 - t) + (c1[3].y - 2 * c1[2].y + c1[1].y) * t),
    };
    const diff = sub(d, p);
    const numerator = dot(diff, qp);
    const denominator = dot(qp, qp) + dot(diff, qpp);
    return Math.abs(denominator) < 1e-12 ? t : Math.min(1, Math.max(0, t - numerator / denominator));
  });
}

function fitCubic(pts: Pt[], first: number, last: number, tHat1: Pt, tHat2: Pt, errorSq: number, out: Cubic[]): void {
  // Two points: heuristic straight-ish segment.
  if (last - first === 1) {
    const p0 = pts[first]!;
    const p3 = pts[last]!;
    const dist = norm(sub(p3, p0)) / 3;
    out.push([p0, add(p0, scale(tHat1, dist)), add(p3, scale(tHat2, dist)), p3]);
    return;
  }
  let u = chordLengths(pts, first, last);
  let curve = generateBezier(pts, first, last, u, tHat1, tHat2);
  let [maxError, splitPoint] = computeMaxError(pts, first, last, curve, u);
  if (maxError < errorSq) {
    out.push(curve);
    return;
  }
  // Try refining the parameterization a few times before splitting.
  if (maxError < errorSq * 16) {
    for (let i = 0; i < 4; i++) {
      u = reparameterize(pts, first, last, u, curve);
      curve = generateBezier(pts, first, last, u, tHat1, tHat2);
      [maxError, splitPoint] = computeMaxError(pts, first, last, curve, u);
      if (maxError < errorSq) {
        out.push(curve);
        return;
      }
    }
  }
  // Split at the worst point with a centered tangent and recurse.
  const centerT = normalize(sub(pts[splitPoint - 1]!, pts[splitPoint + 1]!));
  const tHatCenter = centerT.x === 0 && centerT.y === 0
    ? normalize(sub(pts[splitPoint - 1]!, pts[splitPoint]!))
    : centerT;
  fitCubic(pts, first, splitPoint, tHat1, tHatCenter, errorSq, out);
  fitCubic(pts, splitPoint, last, scale(tHatCenter, -1), tHat2, errorSq, out);
}

/** Drop consecutive duplicates (zero-length chords break the fitter). */
function dedupe(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > 1e-6) out.push({ x: p.x, y: p.y });
  }
  return out;
}

/**
 * Fit a freehand polyline into a Contour of smooth Bézier anchors.
 * `tolerance` is the max deviation in the polyline's own units (px).
 */
export function fitSubpath(points: Pt[], tolerance: number, closed = false): Contour | null {
  const pts = dedupe(points);
  if (pts.length < 2) return null;
  if (pts.length === 2) {
    return {
      closed: false,
      points: [
        { x: pts[0]!.x, y: pts[0]!.y, hIn: null, hOut: null },
        { x: pts[1]!.x, y: pts[1]!.y, hIn: null, hOut: null },
      ],
    };
  }
  const tHat1 = normalize(sub(pts[1]!, pts[0]!));
  const tHat2 = normalize(sub(pts[pts.length - 2]!, pts[pts.length - 1]!));
  const cubics: Cubic[] = [];
  fitCubic(pts, 0, pts.length - 1, tHat1, tHat2, tolerance * tolerance, cubics);
  if (cubics.length === 0) return null;

  // Stitch cubics into PathPoints (absolute handles; shared anchors merge).
  const anchors: PathPoint[] = [];
  for (let i = 0; i < cubics.length; i++) {
    const c = cubics[i]!;
    if (i === 0) {
      anchors.push({ x: c[0].x, y: c[0].y, hIn: null, hOut: { x: c[1].x, y: c[1].y } });
    } else {
      anchors[anchors.length - 1]!.hOut = { x: c[1].x, y: c[1].y };
    }
    anchors.push({ x: c[3].x, y: c[3].y, hIn: { x: c[2].x, y: c[2].y }, hOut: null });
  }
  if (closed && anchors.length > 2) {
    // Merge the wrap-around anchor pair.
    const lastAnchor = anchors.pop()!;
    anchors[0]!.hIn = lastAnchor.hIn;
  }
  return { closed, points: anchors };
}

/* ------------------------------------------- a traced outline keeps its corners */

/**
 * A turn sharper than this, measured over `CORNER_WINDOW`, is a CORNER — a
 * place two strokes crossed, an end cap, the tip of a nib — and is kept as a
 * hard anchor. Anything gentler is curve, and gets fitted through.
 */
const CORNER_DEG = 45;

/**
 * HOW MUCH OUTLINE THE CORNER TEST LOOKS AT, in layer units.
 *
 * This window is the whole difference between a corner test that works on a
 * real drawing and one that does not. Measured between NEIGHBOURING vertices,
 * the test is a hand-wobble detector: a person's line wanders a couple of
 * pixels, the flattener samples every wander, and each one turns sharply
 * against its neighbours — so a wobbly loop reported forty "corners", the fit
 * was chopped into forty runs, and the result was the polygon again wearing a
 * few handles.
 *
 * Over a span of outline instead, wobble cancels: a 3px wander across 12px of
 * line is a gentle bend, while two strokes crossing turn hard however finely
 * they are sampled. Corner detection has to be a question about SHAPE, and
 * shape is not a property of one vertex.
 */
const CORNER_WINDOW = 12;

/**
 * Corners closer together than this are ONE corner — the sharpest of them.
 *
 * A nib's end cap is a tight arc, and a tight arc really does turn sharply over
 * any window; without this it comes back as a cluster of six hard anchors a
 * pixel apart, which is exactly the knot of nodes at every stroke end.
 */
const CORNER_MERGE = 8;

/**
 * Fit a CLOSED polyline into a contour that still looks like the shape.
 *
 * The one answer to "I have a ring of points and I want artwork", and the
 * reason it is one: `fitSubpath` is a Schneider least-squares fit, which is
 * tangent-continuous BY CONSTRUCTION. That is exactly right for a freehand
 * gesture, where every apparent corner is a hand changing direction smoothly,
 * and exactly wrong for anything with a real corner — it rounds the corner off
 * and, having no tangent to honour at the ends of a closed ring, bulges the
 * seam outward as well.
 *
 * Two callers already had rings with real corners:
 *
 *  - a stroke MERGE, whose whole point is the crossing two strokes make;
 *  - a traced REGION — the paint bucket. Pour into a triangle between three
 *    ruled lines and the smoothing fit returned a rounded blob that spilled
 *    past every edge, nothing like the outline the preview had drawn.
 *
 * Only the first had the corner-aware fit, privately. So it lives here now,
 * beside the fitter it wraps, and both callers get the same answer.
 *
 * Corners are found first (`cornerIndices` — a question about SHAPE, measured
 * over a span of outline, not about one vertex), then each smooth run BETWEEN
 * two corners is fitted on its own. A corner keeps one handle from each side,
 * which is what makes it read as a corner; a run of two points comes back as a
 * plain segment with no handles at all, so a polygon stays a polygon.
 *
 * Returns null when the ring is too degenerate to fit — the caller keeps what
 * it had.
 */
export function fitClosedContour(
  ring: ReadonlyArray<{ x: number; y: number }>,
  tolerance: number,
): Contour | null {
  if (ring.length < 3) return null;
  const corners = cornerIndices(ring);
  return corners.length === 0
    ? fitSubpath([...ring], tolerance, true)
    : fitCornered(ring, corners, tolerance);
}

/**
 * Is this run of samples already a straight edge?
 *
 * Asked of the SAMPLES, not of the curve fitted to them, and that distinction
 * is the whole point. A traced region's edge is a pixel staircase: the wobble
 * is quantisation, not shape, so the honest question is "does the chord stay
 * within the tolerance I am fitting to" — and if it does, the edge is straight
 * and deserves no handles at all.
 *
 * Judging the fitted control points instead (which is what this used to do)
 * asks about an artifact. Schneider answers a three-sample run with a cubic
 * whose controls can sit well off a chord those samples never leave, so a
 * poured polygon came back with one bowed edge at the seam where the trace
 * closed — the corner that "still had a curve in it".
 */
function spanIsStraight(span: ReadonlyArray<Pt>, tolerance: number): boolean {
  if (span.length <= 2) return true;
  const a = span[0]!;
  const b = span[span.length - 1]!;
  for (let i = 1; i < span.length - 1; i++) {
    if (distToSegment(span[i]!, a, b) > tolerance) return false;
  }
  return true;
}

/** Distance from a point to the segment a→b. */
function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Cumulative outline distance at each vertex of a closed ring, and its perimeter. */
function ringArcOf(ring: ReadonlyArray<{ x: number; y: number }>): { at: Float64Array; total: number } {
  const at = new Float64Array(ring.length);
  let total = 0;
  for (let i = 1; i < ring.length; i++) {
    total += Math.hypot(ring[i]!.x - ring[i - 1]!.x, ring[i]!.y - ring[i - 1]!.y);
    at[i] = total;
  }
  const last = ring[ring.length - 1]!;
  return { at, total: total + Math.hypot(ring[0]!.x - last.x, ring[0]!.y - last.y) };
}

/** Walk `dist` along the ring from `i`, forward (+1) or back (−1). */
function stepAlong(
  ring: ReadonlyArray<{ x: number; y: number }>,
  arc: { at: Float64Array; total: number },
  i: number,
  dist: number,
  dir: 1 | -1,
): number {
  const n = ring.length;
  let j = i;
  let gone = 0;
  for (let k = 0; k < n && gone < dist; k++) {
    const next = (j + dir + n) % n;
    gone += Math.hypot(ring[next]!.x - ring[j]!.x, ring[next]!.y - ring[j]!.y);
    j = next;
  }
  return j;
}

/** The turn at vertex `i` measured across `CORNER_WINDOW` of outline, degrees. */
function turnDeg(
  ring: ReadonlyArray<{ x: number; y: number }>,
  arc: { at: Float64Array; total: number },
  i: number,
  window: number,
): number {
  const a = ring[stepAlong(ring, arc, i, window, -1)]!;
  const q = ring[i]!;
  const b = ring[stepAlong(ring, arc, i, window, 1)]!;
  const ax = q.x - a.x;
  const ay = q.y - a.y;
  const bx = b.x - q.x;
  const by = b.y - q.y;
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (la < 1e-9 || lb < 1e-9) return 0;
  const cos = Math.min(1, Math.max(-1, (ax * bx + ay * by) / (la * lb)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/**
 * Where a closed ring genuinely turns a corner — measured over a span of
 * outline, and thinned so a tight arc is one corner rather than a cluster.
 */
function cornerIndices(ring: ReadonlyArray<{ x: number; y: number }>): number[] {
  const arc = ringArcOf(ring);
  // A ring shorter than a few windows has no "span" to measure over; treat the
  // whole thing as curve and let the fitter decide.
  if (arc.total < CORNER_WINDOW * 3) return [];
  const found: Array<{ i: number; turn: number }> = [];
  for (let i = 0; i < ring.length; i++) {
    const turn = turnDeg(ring, arc, i, CORNER_WINDOW);
    if (turn >= CORNER_DEG) found.push({ i, turn });
  }
  if (found.length === 0) return [];
  // Thin: walk in ring order, keeping the sharpest of each run of neighbours
  // that sit within `CORNER_MERGE` of one another along the outline.
  const kept: number[] = [];
  let best = found[0]!;
  for (let k = 1; k <= found.length; k++) {
    const here = found[k % found.length]!;
    const gap = k === found.length ? Infinity : arc.at[here.i]! - arc.at[best.i]!;
    if (gap <= CORNER_MERGE) {
      if (here.turn > best.turn) best = here;
      continue;
    }
    kept.push(best.i);
    best = here;
  }
  // The wrap-around pair may have ended up as two corners a hair apart.
  if (kept.length > 1) {
    const first = kept[0]!;
    const last = kept[kept.length - 1]!;
    if (arc.total - arc.at[last]! + arc.at[first]! <= CORNER_MERGE) kept.pop();
  }
  return kept.sort((a, b) => a - b);
}

/**
 * Fit a closed ring that HAS corners: one Bézier run per span between
 * consecutive corners, stitched so each corner keeps a handle from each side
 * and is therefore still a corner. Smoothing across one would round off the
 * very crossing the merge exists to make.
 */
function fitCornered(
  ring: ReadonlyArray<{ x: number; y: number }>,
  corners: readonly number[],
  tolerance: number,
): Contour | null {
  const n = ring.length;
  const anchors: PathPoint[] = [];
  for (let k = 0; k < corners.length; k++) {
    const from = corners[k]!;
    const to = corners[(k + 1) % corners.length]!;
    // The span from one corner to the next, walking forward and wrapping.
    const span: Array<{ x: number; y: number }> = [];
    for (let i = from; ; i = (i + 1) % n) {
      span.push(ring[i]!);
      if (i === to) break;
      if (span.length > n) return null; // defensive: never loop a broken ring
    }
    // A straight edge is a straight edge — no fit, no handles, no bow.
    const run = spanIsStraight(span, tolerance)
      ? ({
          closed: false,
          points: [
            { x: span[0]!.x, y: span[0]!.y, hIn: null, hOut: null },
            { x: span[span.length - 1]!.x, y: span[span.length - 1]!.y, hIn: null, hOut: null },
          ],
        } satisfies Contour)
      : fitSubpath(span, tolerance, false);
    if (!run || run.points.length < 2) return null;
    const pts = run.points;
    if (anchors.length === 0) anchors.push({ ...pts[0]! });
    else {
      // Shared corner: keep the incoming handle, take the outgoing one. Both
      // sides keep their own tangent, which is what makes it read as a corner.
      anchors[anchors.length - 1]!.hOut = pts[0]!.hOut;
    }
    for (let i = 1; i < pts.length; i++) anchors.push({ ...pts[i]! });
  }
  if (anchors.length < 3) return null;
  // The walk ended back on the first corner — fold that duplicate into it.
  const tail = anchors.pop()!;
  anchors[0]!.hIn = tail.hIn;
  return { closed: true, points: anchors };
}

/**
 * A pressure-driven OUTLINE around a polyline (variable-width vector brush):
 * offsets each side by the local half-width, then fits ONE closed subpath
 * around the ribbon. Widths are per input point, in px.
 */
export function outlineSubpath(
  points: Array<Pt & { width: number }>,
  tolerance: number,
): Contour | null {
  const pts = points.filter((p, i, arr) => {
    const prev = arr[i - 1];
    return !prev || Math.hypot(p.x - prev.x, p.y - prev.y) > 1e-6;
  });
  if (pts.length < 2) return null;
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const prev = pts[Math.max(0, i - 1)]!;
    const next = pts[Math.min(pts.length - 1, i + 1)]!;
    const dir = normalize(sub(next, prev));
    const n = { x: -dir.y, y: dir.x };
    const hw = Math.max(0.25, p.width / 2);
    left.push(add(p, scale(n, hw)));
    right.push(add(p, scale(n, -hw)));
  }
  right.reverse();
  const ribbon = [...left, ...right];
  return fitSubpath(ribbon, tolerance, true);
}
