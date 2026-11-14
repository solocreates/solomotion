import type { Contour, PathPoint } from "../schema";
import { fitSubpath } from "./path-fit";

/**
 * PATH FIDELITY — the one description of how a gesture becomes vector geometry.
 *
 * Every tool that turns hand motion into anchors answers the same three
 * questions, so they are asked once here and reused rather than re-invented per
 * tool: how much the hand is STABILISED before the line is recorded, how far
 * the resulting curve may stray from it, and how sharp a turn has to be before
 * it is a corner instead of a bend.
 *
 * It exists because of a real bug. A boolean (the eraser carving a fill, the
 * lasso cutting one) can only work on polygons, and its result came straight
 * back into the document as one ANCHOR PER FLATTENED VERTEX — a few hundred
 * nodes for a circle, compounding on every stroke because the next cut
 * re-flattened what the last one produced. Three strokes and the outline was
 * unusable; the pen tool then tried to draw a handle for each of them. Cutting
 * geometry has to hand back geometry an artist can still edit, and that means
 * refitting, which means a tolerance, which is this.
 *
 *   `simplify`  px of allowed deviation. LOW = faithful and dense, HIGH = few
 *               anchors. It is a real distance, not a 0..100 "quality", because
 *               a distance is the only version of this number that means the
 *               same thing at every zoom, on every layer scale, in the exporter.
 *   `corner`    the turn angle (degrees) at which a vertex stays a corner. It
 *               is what keeps a refit rectangle rectangular while a refit
 *               circle becomes four smooth arcs.
 *   `smoothing` the stabiliser leash (see stabilizer.ts) — input, not output,
 *               but it belongs to the same knob because the two together are
 *               what an artist means by "how clean is my line".
 */
export interface PathFidelity {
  /** Stabiliser strength 0..1 — the leash the tool trails behind the cursor. */
  smoothing: number;
  /** Fit tolerance in px: how far the fitted curve may stray from the input. */
  simplify: number;
  /** Turn angle in degrees above which a vertex stays a hard corner. */
  corner: number;
}

/**
 * The default for tools that CUT existing art (eraser, lasso, wand). Sub-pixel
 * accurate, so a carved edge still reads as the edge you drew, while a circle
 * comes back as a handful of arcs instead of two hundred dots.
 */
export const DEFAULT_PATH_FIDELITY: PathFidelity = { smoothing: 0, simplify: 0.8, corner: 50 };

/**
 * The default for tools that DRAW (the vector brush). Looser, because a
 * freehand line's small wobble is hand noise rather than intent — the same
 * reason a pencil tool ships at a few px of fidelity everywhere else.
 */
export const DEFAULT_FREEHAND_FIDELITY: PathFidelity = { smoothing: 0, simplify: 2.5, corner: 40 };

/** UI bounds, kept beside the meaning so a slider cannot invent its own. */
export const FIDELITY_RANGE = {
  smoothing: { min: 0, max: 1, step: 0.01 },
  simplify: { min: 0.05, max: 8, step: 0.05 },
  corner: { min: 10, max: 170, step: 1 },
} as const;

/** Under this, a fit stops thinning anything: expect a node per wobble. */
export const DENSE_SIMPLIFY_PX = 0.3;

/** Should the UI warn? True when the setting will produce dense outlines. */
export function isDenseFidelity(f: PathFidelity): boolean {
  return f.simplify < DENSE_SIMPLIFY_PX;
}

/**
 * The hard ceiling on one refitted subpath, independent of any setting.
 *
 * This is a SAFETY NET, not a quality knob, and the difference matters: set it
 * low and it fires on ordinary detailed artwork, where the only way to meet it
 * is to throw away shape the artist drew. It is here for the pathological case
 * — a traced region, a boolean along a rasterised edge, tens of thousands of
 * vertices — where the alternative is a document the node editor cannot open.
 * A few hundred anchors is an ordinary complex path; several thousand is a
 * different kind of object.
 */
export const MAX_REFIT_ANCHORS = 2000;

/**
 * How far escalation may relax the corner angle. Never past a right angle:
 * relaxing beyond it makes a rectangle's own corners "smooth", and a carve that
 * rounds off the artwork it was cutting is worse than the anchor count it was
 * trying to save. Past this point the arc-length resample takes over instead.
 */
const MAX_ESCALATED_CORNER = 110;

interface Pt {
  x: number;
  y: number;
}

const dist = (a: Pt, b: Pt): number => Math.hypot(b.x - a.x, b.y - a.y);

/** Perpendicular distance² from `p` to segment ab (Douglas–Peucker's metric). */
function segDistSq(p: Pt, a: Pt, b: Pt): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  const t = lenSq < 1e-12 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq));
  const dx = p.x - (a.x + abx * t);
  const dy = p.y - (a.y + aby * t);
  return dx * dx + dy * dy;
}

/**
 * Douglas–Peucker decimation, iterative. Recursion would be the shorter code
 * and would blow the stack on exactly the input this exists for — a boolean
 * result with tens of thousands of collinear vertices.
 */
export function decimatePolyline(points: readonly Pt[], tolerance: number): Pt[] {
  const n = points.length;
  if (n < 3 || tolerance <= 0) return points.slice();
  const tolSq = tolerance * tolerance;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    if (last <= first + 1) continue;
    let worst = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = segDistSq(points[i]!, points[first]!, points[last]!);
      if (d > worst) {
        worst = d;
        index = i;
      }
    }
    if (index < 0 || worst <= tolSq) continue;
    keep[index] = 1;
    stack.push([first, index], [index, last]);
  }
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]!);
  return out;
}

/** Turn angle at `points[i]` in degrees (0 = straight on, 180 = doubles back). */
function turnAngle(points: readonly Pt[], i: number, closed: boolean): number {
  const n = points.length;
  const prev = i === 0 ? (closed ? points[n - 1]! : null) : points[i - 1]!;
  const next = i === n - 1 ? (closed ? points[0]! : null) : points[i + 1]!;
  if (!prev || !next) return 180; // an open end is always a terminus
  const ax = points[i]!.x - prev.x;
  const ay = points[i]!.y - prev.y;
  const bx = next.x - points[i]!.x;
  const by = next.y - points[i]!.y;
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (la < 1e-9 || lb < 1e-9) return 0;
  const cos = Math.min(1, Math.max(-1, (ax * bx + ay * by) / (la * lb)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** Indices that must survive as hard corners, by the fidelity's angle. */
function cornerIndices(points: readonly Pt[], closed: boolean, cornerDeg: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < points.length; i++) {
    if (turnAngle(points, i, closed) >= cornerDeg) out.push(i);
  }
  return out;
}

/**
 * A handle sitting ON the chord it leaves describes a straight line the long
 * way round. Schneider always emits one (it fits cubics, not lines), so a
 * carved rectangle came back with four corners wearing eight handles that did
 * nothing but clutter the node editor and survive into the SVG. Collapse them:
 * a line is a line.
 */
function collapseStraightSegments(points: PathPoint[], closed: boolean): void {
  const n = points.length;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    const len = dist(a, b);
    if (len < 1e-9) continue;
    const eps = Math.max(0.01, len * 0.004);
    const offChord = (h: { x: number; y: number } | null): boolean =>
      !h || Math.sqrt(segDistSq(h, a, b)) > eps;
    if (offChord(a.hOut) || offChord(b.hIn)) continue;
    a.hOut = null;
    b.hIn = null;
  }
}

/** Merge two fitted runs: the shared anchor keeps a handle from each side. */
function appendRun(anchors: PathPoint[], run: Contour): void {
  const pts = run.points;
  if (pts.length === 0) return;
  if (anchors.length === 0) {
    anchors.push(...pts.map((p) => ({ ...p })));
    return;
  }
  const seam = anchors[anchors.length - 1]!;
  seam.hOut = pts[0]!.hOut ? { ...pts[0]!.hOut } : null;
  for (let i = 1; i < pts.length; i++) anchors.push({ ...pts[i]! });
}

/**
 * Fit a polyline into Béziers, splitting at its corners first — THE fitter
 * behind both the freehand brush and every refit of cut geometry.
 *
 * Plain least-squares fitting rounds corners (it is trying to be smooth); a
 * rectangle traced by hand or produced by a boolean comes back as a pillow.
 * Splitting at the turn angle first means each straight run is fitted on its
 * own and the corner between them is an anchor with two independent handles —
 * the same result Illustrator's simplify gives, and the reason a carved
 * rectangle still has four right angles.
 */
export function fitPolyline(points: readonly Pt[], fidelity: PathFidelity, closed: boolean): Contour | null {
  const tolerance = Math.max(0.01, fidelity.simplify);
  const pts = points.slice();
  if (closed && pts.length > 2 && dist(pts[0]!, pts[pts.length - 1]!) < 1e-6) pts.pop();
  if (pts.length < 2) return null;
  if (pts.length === 2 || (closed && pts.length < 4)) return fitSubpath(pts, tolerance, false);

  const corners = cornerIndices(pts, closed, fidelity.corner);

  if (!closed) {
    // Open runs always break at both ends, corners or not.
    const breaks = [0, ...corners.filter((i) => i > 0 && i < pts.length - 1), pts.length - 1];
    return stitchRuns(pts, breaks, tolerance, false);
  }
  if (corners.length === 0) {
    // A smooth loop: start the seam at the flattest vertex, where a slight
    // tangent discontinuity is invisible, instead of wherever the boolean's
    // ring happened to begin (often a hard corner of the cutter).
    let seam = 0;
    let flattest = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = turnAngle(pts, i, true);
      if (a < flattest) {
        flattest = a;
        seam = i;
      }
    }
    const rotated = [...pts.slice(seam), ...pts.slice(0, seam)];
    const loop = fitSubpath([...rotated, rotated[0]!], tolerance, true);
    if (loop) collapseStraightSegments(loop.points, true);
    return loop;
  }
  // A loop with corners: rotate so it BEGINS on a corner, then fit each run.
  const start = corners[0]!;
  const rotated = [...pts.slice(start), ...pts.slice(0, start)];
  const breaks = [0, ...corners.slice(1).map((i) => (i - start + pts.length) % pts.length).sort((a, b) => a - b), pts.length];
  return stitchRuns([...rotated, rotated[0]!], breaks, tolerance, true);
}

/** Fit each [breaks[i], breaks[i+1]] run and stitch them into one subpath. */
function stitchRuns(pts: Pt[], breaks: number[], tolerance: number, closed: boolean): Contour | null {
  const anchors: PathPoint[] = [];
  for (let b = 0; b + 1 < breaks.length; b++) {
    const from = breaks[b]!;
    const to = breaks[b + 1]!;
    if (to <= from) continue;
    const run = pts.slice(from, to + 1);
    const fitted = fitSubpath(run, tolerance, false);
    if (fitted) appendRun(anchors, fitted);
  }
  if (anchors.length < 2) return null;
  if (!closed) {
    collapseStraightSegments(anchors, false);
    return { closed: false, points: anchors };
  }
  // The wrap seam is one anchor, not two: it keeps a handle from each side.
  const tail = anchors.pop()!;
  anchors[0]!.hIn = tail.hIn ? { ...tail.hIn } : null;
  if (anchors.length < 2) return null;
  collapseStraightSegments(anchors, true);
  return { closed: true, points: anchors };
}

/** Every anchor is a plain corner ⇒ this came out of a polygon, not a pen. */
function isPolygonal(sub: Contour): boolean {
  return sub.points.every((p) => !p.hIn && !p.hOut);
}

/** Below this a boolean result is already lean — refitting could only distort. */
const REFIT_MIN_POINTS = 16;

/** Vertices the thinning pass will ever look at (see `refitOne`). */
const DECIMATE_INPUT_CAP = 8000;

/**
 * Refit dense polygon geometry back into editable curves — the cure for the
 * eraser/lasso "thousand dots" outline, applied automatically wherever a
 * boolean hands geometry back to the document.
 *
 * Only touches subpaths that are ALL corners and long enough to have come from
 * a flattening (`REFIT_MIN_POINTS`): a boolean's output, never a path someone
 * drew with the pen, and never a small polygon whose vertices ARE the art. That
 * guard is what separates this from the pen tool's own Simplify command
 * (`simplifySubpaths` in vector/edit-engine), which is a deliberate act on a
 * chosen path and may thin anything. The anchor budget is enforced after the
 * fit, so no fidelity setting can produce an outline that cannot be edited.
 */
export function refitSubpaths<T extends Contour>(subpaths: readonly T[], fidelity: PathFidelity): T[] {
  const out: T[] = [];
  for (const sub of subpaths) {
    if (sub.points.length < REFIT_MIN_POINTS || !isPolygonal(sub)) {
      out.push(sub);
      continue;
    }
    out.push(refitOne(sub, fidelity) ?? sub);
  }
  return out;
}

/**
 * Refit one ring, escalating until it fits the anchor budget.
 *
 * Escalation relaxes BOTH knobs, because they fail for different reasons: a
 * merely detailed contour is beaten by a coarser tolerance, while a jagged one
 * (a traced region, a boolean along a rasterised edge) is all corners, and no
 * tolerance thins a path whose every vertex is declared a corner. If both give
 * up, the ring is resampled by arc length — a visibly simplified shape, which
 * is still an outline you can edit, and the only outcome that stays bounded
 * whatever comes in.
 */
function refitOne<T extends Contour>(sub: T, fidelity: PathFidelity): T | null {
  // Douglas–Peucker degrades to O(n²) on a pure staircase, which is exactly
  // what a boolean along a jagged edge produces — so cap what it ever sees.
  // 8k vertices is far more detail than MAX_REFIT_ANCHORS can survive anyway.
  const source =
    sub.points.length > DECIMATE_INPUT_CAP
      ? resampleRing(sub.points, DECIMATE_INPUT_CAP, sub.closed)
      : sub.points;
  let tolerance = Math.max(0.01, fidelity.simplify);
  let corner = fidelity.corner;
  let best: T | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const thinned = decimatePolyline(source, tolerance * 0.4);
    const fitted = fitPolyline(thinned, { ...fidelity, simplify: tolerance, corner }, sub.closed);
    if (fitted) {
      // The refit REPLACES this run's points and nothing else — it is still the
      // same contour, so it keeps whatever identity it arrived with.
      best = { ...sub, ...fitted };
      if (fitted.points.length <= MAX_REFIT_ANCHORS) return best;
    }
    tolerance *= 2.5;
    corner = Math.min(MAX_ESCALATED_CORNER, corner * 1.3);
  }
  const capped = fitPolyline(
    resampleRing(source, MAX_REFIT_ANCHORS, sub.closed),
    { ...fidelity, simplify: tolerance, corner: MAX_ESCALATED_CORNER },
    sub.closed,
  );
  return capped ? { ...sub, ...capped } : best;
}

/** Evenly spaced points along a contour — the last-resort thinning. */
function resampleRing(points: readonly Pt[], count: number, closed: boolean): Pt[] {
  const n = points.length;
  if (n <= count) return points.slice();
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1]! + dist(points[i - 1]!, points[i]!));
  if (closed) cum.push(cum[n - 1]! + dist(points[n - 1]!, points[0]!));
  const total = cum[cum.length - 1]!;
  if (total < 1e-9) return points.slice(0, count);
  const out: Pt[] = [];
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    const target = (total * i) / count;
    while (cursor + 1 < cum.length && cum[cursor + 1]! < target) cursor++;
    out.push(points[Math.min(n - 1, cursor)]!);
  }
  return out;
}
