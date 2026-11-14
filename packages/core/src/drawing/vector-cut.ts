import { toSubpath } from "../vector/contour-id";
import type { Contour, PathPoint, Subpath } from "../schema";
import {
  DEFAULT_PATH_FIDELITY,
  refitSubpaths,
  type PathFidelity,
} from "./fidelity";
import {
  multiPolyArea,
  multiPolyContains,
  multiPolyToSubpaths,
  ringsToRegion,
  robustBoolean,
  subpathsToMultiPoly,
} from "../vector/polygon";

/**
 * Cutting vector geometry — THE one brain behind every tool that takes
 * something away from an outline: the eraser's drag, the lasso's loop, the
 * wand's traced region.
 *
 * Geometry answers to what it IS, not to which tool asked:
 *
 *  - an OPEN outline (a drawn stroke) is a curve, so a cut SPLITS it: the
 *    touched arc goes and the survivors stay true Béziers (de Casteljau at the
 *    cut parameters, untouched anchors byte-identical);
 *  - FILLED art is an area, so a cut CARVES it: the outline is booleaned
 *    against the region and both sides come back CLOSED — which is the only
 *    honest answer to "lasso half of a filled shape", because splitting a
 *    fill's outline into arcs would leave two things that no longer enclose
 *    anything.
 *
 * The result is always still a path clip's subpath list — never new layers of
 * its own doing — so the pen tool's node editor keeps working on whatever comes
 * out. Shapes and text outlines cut through the same door once compiled to
 * subpaths.
 */

/** The eraser's travelled footprint: a polyline of circles (pressure-sized). */
export interface EraserPath {
  points: Array<{ x: number; y: number; radius: number }>;
}

interface Pt {
  x: number;
  y: number;
}

/** Segment of a subpath as an explicit cubic (lines become degenerate cubics). */
interface Seg {
  p0: Pt;
  c1: Pt;
  c2: Pt;
  p3: Pt;
  /** Original anchors, to preserve corner-ness on untouched boundaries. */
  a: PathPoint;
  b: PathPoint;
  line: boolean;
}

function segsOf(sub: Contour): Seg[] {
  const pts = sub.points;
  const count = sub.closed ? pts.length : pts.length - 1;
  const segs: Seg[] = [];
  for (let i = 0; i < count; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const line = !a.hOut && !b.hIn;
    segs.push({
      p0: { x: a.x, y: a.y },
      c1: a.hOut ? { ...a.hOut } : { x: a.x, y: a.y },
      c2: b.hIn ? { ...b.hIn } : { x: b.x, y: b.y },
      p3: { x: b.x, y: b.y },
      a,
      b,
      line,
    });
  }
  return segs;
}

function segPoint(s: Seg, t: number): Pt {
  const mt = 1 - t;
  const w0 = mt * mt * mt;
  const w1 = 3 * mt * mt * t;
  const w2 = 3 * mt * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * s.p0.x + w1 * s.c1.x + w2 * s.c2.x + w3 * s.p3.x,
    y: w0 * s.p0.y + w1 * s.c1.y + w2 * s.c2.y + w3 * s.p3.y,
  };
}

/** Distance² from a point to the eraser capsule chain. */
function eraserDistSq(p: Pt, eraser: EraserPath): number {
  let best = Infinity;
  const pts = eraser.points;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    if (i + 1 < pts.length) {
      const b = pts[i + 1]!;
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const lenSq = abx * abx + aby * aby;
      const t = lenSq < 1e-12 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq));
      const dx = p.x - (a.x + abx * t);
      const dy = p.y - (a.y + aby * t);
      const r = a.radius + (b.radius - a.radius) * t;
      const d = dx * dx + dy * dy - r * r;
      if (d < best) best = d;
    } else {
      const dx = p.x - a.x;
      const dy = p.y - a.y;
      const d = dx * dx + dy * dy - a.radius * a.radius;
      if (d < best) best = d;
    }
  }
  return best; // ≤ 0 means inside the eraser footprint
}

/** De Casteljau: the sub-cubic of `s` over [t0, t1]. */
function slice(s: Seg, t0: number, t1: number): Seg {
  // Split at t0, keep right; then split that at adjusted t, keep left.
  const right = splitAt(s, t0)[1];
  const tt = t0 >= 1 ? 0 : (t1 - t0) / (1 - t0);
  return splitAt(right, Math.min(1, Math.max(0, tt)))[0];
}

function splitAt(s: Seg, t: number): [Seg, Seg] {
  const lerp = (a: Pt, b: Pt): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const q0 = lerp(s.p0, s.c1);
  const q1 = lerp(s.c1, s.c2);
  const q2 = lerp(s.c2, s.p3);
  const r0 = lerp(q0, q1);
  const r1 = lerp(q1, q2);
  const m = lerp(r0, r1);
  const mk = (p0: Pt, c1: Pt, c2: Pt, p3: Pt): Seg => ({
    p0, c1, c2, p3, a: s.a, b: s.b, line: s.line,
  });
  return [mk(s.p0, q0, r0, m), mk(m, r1, q2, s.p3)];
}

/** A kept span in one subpath's param space: [seg index + t, seg index + t]. */
interface Run {
  start: number;
  end: number;
}

const SAMPLES_PER_SEG = 24;

/**
 * The result of cutting subpaths by a point test: what stayed and what the
 * test claimed. Both sides are true Béziers (de Casteljau splits at the cut
 * parameters). `touched` false ⇒ the test never bit — callers skip the doc
 * update entirely.
 */
export interface SubpathPartition<T extends Contour = Subpath> {
  kept: T[];
  removed: T[];
  touched: boolean;
}

/**
 * Cut `subpaths` by an arbitrary point predicate — THE generalized splitter
 * behind the vector eraser (predicate = inside the eraser capsule chain) and
 * the vector lasso (predicate = inside the selection region). Sampling walks
 * every segment; contiguous runs on each side rebuild into exact sub-Béziers;
 * a closed path whose seam survives re-joins across it (both sides).
 */
export function partitionSubpaths<T extends Contour>(
  subpaths: ReadonlyArray<T>,
  isRemoved: (p: { x: number; y: number }) => boolean,
): SubpathPartition<T> {
  const result: SubpathPartition<T> = { kept: [], removed: [], touched: false };

  for (const sub of subpaths) {
    if (sub.points.length < 2) {
      // A lone anchor: wholly on whichever side the test says.
      const p = sub.points[0];
      if (!p) continue;
      if (isRemoved(p)) {
        result.removed.push(sub);
        result.touched = true;
      } else result.kept.push(sub);
      continue;
    }
    const segs = segsOf(sub);
    const total = segs.length;
    // Sample the whole subpath; kept[i] per global sample index.
    const sampleCount = total * SAMPLES_PER_SEG + 1;
    const kept: boolean[] = new Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      const g = Math.min(total - 1e-9, i / SAMPLES_PER_SEG);
      const si = Math.floor(g);
      kept[i] = !isRemoved(segPoint(segs[si]!, g - si));
    }
    if (kept.every(Boolean)) {
      result.kept.push(sub);
      continue;
    }
    result.touched = true;
    if (kept.every((k) => !k)) {
      result.removed.push(sub);
      continue;
    }
    result.kept.push(...buildSideRuns(segs, sub, kept, total, true));
    result.removed.push(...buildSideRuns(segs, sub, kept, total, false));
  }
  return result;
}

/** Contiguous runs on one side of the cut, rebuilt into subpaths (wrap-aware). */
function buildSideRuns<T extends Contour>(
  segs: Seg[],
  sub: T,
  kept: boolean[],
  total: number,
  side: boolean,
): T[] {
  const sampleCount = kept.length;
  const runs: Run[] = [];
  let runStart: number | null = null;
  for (let i = 0; i < sampleCount; i++) {
    const on = kept[i] === side;
    if (on && runStart === null) runStart = i;
    if ((!on || i === sampleCount - 1) && runStart !== null) {
      const endI = on ? i : i - 1;
      if (endI > runStart) {
        runs.push({ start: runStart / SAMPLES_PER_SEG, end: endI / SAMPLES_PER_SEG });
      }
      runStart = null;
    }
  }
  // A closed path whose seam survives on this side: merge the wrap-around runs.
  const wrap =
    sub.closed && runs.length >= 2 && runs[0]!.start === 0 && runs[runs.length - 1]!.end >= total - 1e-9;

  // Each surviving run is still THIS contour — same part, same style — so it
  // inherits the source and only its points change. Identity duplicated across
  // the pieces is re-minted by `healContourIds` at the write seam.
  const built: T[] = runs.map((r) => ({ ...sub, ...buildRunSubpath(segs, r) }));
  if (wrap && built.length >= 2) {
    const tail = built.pop()!;
    const head = built.shift()!;
    // tail's end meets head's start (the original closed seam).
    const joinedPts = [...tail.points, ...head.points.slice(1)];
    // The seam anchor keeps both its handles from the two halves.
    const seamIn = tail.points[tail.points.length - 1]!;
    const seamOut = head.points[0]!;
    joinedPts[tail.points.length - 1] = { ...seamIn, hOut: seamOut.hOut };
    built.unshift({ ...sub, closed: false, points: joinedPts });
  }
  return built.filter((s) => s.points.length >= 2);
}

/**
 * Erase `eraser`'s footprint out of `subpaths`. Returns the new subpath list
 * (empty = the whole path is gone) or null when nothing was touched (callers
 * can skip the document update entirely). A thin wrapper over
 * `partitionSubpaths` that discards the removed side.
 */
export function eraseSubpaths<T extends Contour>(subpaths: ReadonlyArray<T>, eraser: EraserPath): T[] | null {
  if (eraser.points.length === 0) return null;
  const partition = partitionSubpaths(subpaths, (p) => eraserDistSq(p, eraser) <= 0);
  return partition.touched ? partition.kept : null;
}

/** Rebuild one kept run into a Subpath (splitting boundary cubics). */
function buildRunSubpath(segs: Seg[], run: Run): Contour {
  const points: PathPoint[] = [];
  const startSeg = Math.floor(run.start);
  const endSeg = Math.min(segs.length - 1, Math.floor(run.end - 1e-9));

  for (let si = startSeg; si <= endSeg; si++) {
    const t0 = si === startSeg ? run.start - startSeg : 0;
    const t1 = si === endSeg ? run.end - endSeg : 1;
    const s = segs[si]!;
    const cut = t0 > 1e-6 || t1 < 1 - 1e-6 ? slice(s, t0, Math.max(t0 + 1e-6, t1)) : s;
    const isLine = s.line && t0 <= 1e-6 && t1 >= 1 - 1e-6;

    if (points.length === 0) {
      // First anchor of the run.
      points.push({
        x: cut.p0.x,
        y: cut.p0.y,
        hIn: null,
        hOut: isLine ? null : { x: cut.c1.x, y: cut.c1.y },
      });
    } else {
      // Continue: the previous anchor's hOut comes from this segment.
      points[points.length - 1]!.hOut = isLine ? null : { x: cut.c1.x, y: cut.c1.y };
    }
    points.push({
      x: cut.p3.x,
      y: cut.p3.y,
      hIn: isLine ? null : { x: cut.c2.x, y: cut.c2.y },
      hOut: null,
    });
  }
  // Degenerate handle cleanup: a handle sitting on its anchor is no handle.
  for (const p of points) {
    if (p.hIn && Math.hypot(p.hIn.x - p.x, p.hIn.y - p.y) < 0.05) p.hIn = null;
    if (p.hOut && Math.hypot(p.hOut.x - p.x, p.hOut.y - p.y) < 0.05) p.hOut = null;
  }
  return { closed: false, points };
}

// ── What a cut MEANS on vector art (the tools' shared vocabulary) ────────────

/**
 * How the eraser treats an outline it drags across. Blender's grease-pencil
 * vocabulary, because it is the one artists already have: cut the line, rub out
 * the points, or take the whole stroke.
 *
 *  - `split`  cut the outline where you rub (filled art is carved instead —
 *             see `cutSubpathsByRegion`). The default, and the one that behaves
 *             like a pixel eraser on a drawing.
 *  - `points` dissolve the pen NODES under the brush, path unbroken.
 *  - `whole`  touch it anywhere and the whole path goes.
 */
export type VectorEraseMode = "split" | "points" | "whole";

/**
 * What the lasso does when its loop lands on vector art: split the geometry
 * into pieces you can grab (the loop becomes the new border) or pick the whole
 * objects it touched, geometry untouched — Illustrator's lasso versus Figma's
 * marquee, chosen rather than guessed.
 */
export type VectorLassoMode = "cut" | "whole";

// ── Regions: a closed area to cut with ───────────────────────────────────────

/**
 * A cut region in the geometry's OWN space: closed loops, even-odd nested
 * (an outer loop with an island inside it reads as a donut). The lasso hands
 * over the outline it drew, the wand the contours it traced, the eraser its
 * travelled footprint — one shape, so nothing downstream asks which tool ran.
 */
export interface CutRegion {
  loops: Array<Array<{ x: number; y: number }>>;
}

/** Is this point inside the eraser's swept capsule chain? */
export function eraserContains(eraser: EraserPath, p: Pt): boolean {
  return eraserDistSq(p, eraser) <= 0;
}

/**
 * The eraser's drag as a REGION — ONE swept outline: the trail offset to each
 * side by the local radius, closed with a round cap at each end.
 *
 * It used to be a pile of primitives — a circle at every sample plus a quad per
 * step — and that is where the "thousand dots" came from. Handing a boolean 500
 * heavily overlapping quads does not produce a smooth edge: near-parallel edges
 * cross at grazing angles and the union comes back as a ZIGZAG, oscillating a
 * pixel back and forth all along the cut. Every one of those oscillations then
 * survived into the document as an anchor — and no refit can rescue a boundary
 * whose every vertex looks like a genuine corner.
 *
 * An offset ribbon has none of that: it is the shape the eraser actually swept,
 * described once. Where the trail turns tighter than its own radius the ribbon
 * crosses itself, which `ringsToRegion`'s union resolves — and a cap ring goes
 * in at any hard turn, where a mitre would otherwise cut the corner off the
 * swept area.
 */
export function eraserFootprint(eraser: EraserPath): CutRegion {
  const pts: EraserPath["points"] = [];
  for (const p of eraser.points) {
    const prev = pts[pts.length - 1];
    if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) < Math.max(0.75, p.radius * 0.35)) continue;
    pts.push(p);
  }
  const last = eraser.points[eraser.points.length - 1];
  if (last && pts[pts.length - 1] !== last) pts.push(last);

  const loops: CutRegion["loops"] = [];
  /** Arc resolution from size: a 2px tip does not need a 24-gon. */
  const arcSteps = (radius: number) => Math.max(6, Math.min(24, Math.ceil(radius * 1.2) + 5));

  const circle = (c: { x: number; y: number; radius: number }) => {
    const steps = arcSteps(c.radius) * 2;
    const ring: Pt[] = [];
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      ring.push({ x: c.x + Math.cos(a) * c.radius, y: c.y + Math.sin(a) * c.radius });
    }
    loops.push(ring);
  };

  // A tap: one circle is the whole footprint.
  if (pts.length === 1) {
    circle(pts[0]!);
    return { loops };
  }

  /** Direction of travel at `i` — central difference, so the offset follows the
   *  curve rather than each individual step. */
  const dirAt = (i: number): Pt => {
    const a = pts[Math.max(0, i - 1)]!;
    const b = pts[Math.min(pts.length - 1, i + 1)]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > 1e-6) return { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    const c = pts[Math.min(pts.length - 1, i + 1)]!;
    const d = Math.hypot(c.x - pts[i]!.x, c.y - pts[i]!.y);
    return d > 1e-6 ? { x: (c.x - pts[i]!.x) / d, y: (c.y - pts[i]!.y) / d } : { x: 1, y: 0 };
  };

  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const d = dirAt(i);
    left.push({ x: p.x - d.y * p.radius, y: p.y + d.x * p.radius });
    right.push({ x: p.x + d.y * p.radius, y: p.y - d.x * p.radius });
  }

  /** Half-circle from angle `from`, sweeping `sign`, around a sample. */
  const cap = (c: { x: number; y: number; radius: number }, from: number, sign: number): Pt[] => {
    const steps = arcSteps(c.radius);
    const out: Pt[] = [];
    for (let i = 1; i < steps; i++) {
      const a = from + sign * Math.PI * (i / steps);
      out.push({ x: c.x + Math.cos(a) * c.radius, y: c.y + Math.sin(a) * c.radius });
    }
    return out;
  };

  const first = pts[0]!;
  const lastPt = pts[pts.length - 1]!;
  const dFirst = dirAt(0);
  const dLast = dirAt(pts.length - 1);
  loops.push([
    ...left,
    ...cap(lastPt, Math.atan2(dLast.x, -dLast.y), -1),
    ...right.slice().reverse(),
    ...cap(first, Math.atan2(-dFirst.x, dFirst.y), -1),
  ]);

  // A hard turn is the one place a ribbon under-covers: the swept area there is
  // a disc, and mitred offsets cut across it. One ring per corner, no more.
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = dirAt(i - 1);
    const b = dirAt(i + 1);
    if (a.x * b.x + a.y * b.y < 0.5) circle(pts[i]!);
  }
  return { loops };
}

// ── Cutting an outline with a region ─────────────────────────────────────────

/**
 * Both sides of a cut. `inside` is what the region claimed, `outside` what
 * survived; `touched` false means the region never met the geometry, so the
 * caller can skip the document update entirely.
 */
export interface RegionCut {
  inside: Subpath[];
  outside: Subpath[];
  touched: boolean;
}

/** Below this the boolean produced a sliver, not a piece — treat as a miss. */
const AREA_EPSILON = 0.02;

/**
 * Cut an outline with a closed region — the door BOTH the lasso and the eraser
 * come through.
 *
 * `filled` decides the meaning of the cut, not the tool: filled art booleans
 * into two closed areas (the lasso's stroke becomes the new border that closes
 * each side), an open stroke splits into arcs. Curves survive untouched on the
 * arc side; the area side flattens for the boolean and is REFITTED back to
 * curves at `fidelity` on the way out, so what the tool returns is geometry a
 * pen tool can still edit rather than the boolean's raw vertex soup.
 */
export function cutSubpathsByRegion(
  subpaths: Subpath[],
  region: CutRegion,
  opts: { filled: boolean; fidelity?: PathFidelity },
): RegionCut {
  const miss: RegionCut = { inside: [], outside: subpaths, touched: false };
  if (subpaths.length === 0 || region.loops.length === 0) return miss;

  if (!opts.filled) {
    const cutter = ringsToRegion(region.loops);
    if (cutter.length === 0) return miss;
    const part = partitionSubpaths(subpaths, (p) => multiPolyContains(cutter, p.x, p.y));
    return { inside: part.removed, outside: part.kept, touched: part.touched };
  }

  const fidelity = opts.fidelity ?? DEFAULT_PATH_FIDELITY;
  const subject = subpathsToMultiPoly(subpaths, flattenTolerance(fidelity));
  const cutter = ringsToRegion(region.loops);
  if (subject.length === 0 || cutter.length === 0) return miss;
  const inside = robustBoolean("intersection", [subject, cutter]);
  if (!inside || multiPolyArea(inside) <= AREA_EPSILON) return miss;
  const outside = robustBoolean("difference", [subject, cutter]);
  if (!outside) return miss;
  // Refit BOTH sides. A boolean speaks in polygons — one anchor per flattened
  // vertex — and handing that straight back was the bug this whole seam exists
  // to prevent: every cut multiplied the node count, the next cut re-flattened
  // the result, and three strokes in the outline had thousands of dots.
  // A boolean FUSES its inputs, so the pieces it hands back are new contours
  // with no ancestor to take an id from — they are minted, not inherited.
  const adopt = (cs: Contour[]): Subpath[] => cs.map(toSubpath);
  return {
    inside: adopt(refitSubpaths(multiPolyToSubpaths(inside), fidelity)),
    outside:
      multiPolyArea(outside) <= AREA_EPSILON
        ? []
        : adopt(refitSubpaths(multiPolyToSubpaths(outside), fidelity)),
    touched: true,
  };
}

/**
 * How finely curves become polygons on the way INTO a boolean. Tied to the
 * fidelity so one knob owns accuracy end to end — flattening finer than the
 * refit will resolve is pure cost, and coarser would put error in before the
 * refit could even see it.
 */
function flattenTolerance(fidelity: PathFidelity): number {
  return Math.min(0.5, Math.max(0.05, fidelity.simplify * 0.35));
}

// ── The node eraser ──────────────────────────────────────────────────────────

/**
 * Dissolve the ANCHORS under a predicate — the pen-node eraser. The path keeps
 * flowing through whatever survives (neighbours keep their handles, so the
 * curve's direction survives the gap); a subpath left with fewer than two
 * anchors is gone. Null = nothing was under the eraser.
 *
 * This is the "rub out the points, not the line" eraser: cheap to reason about,
 * lossless where you didn't touch, and it never multiplies subpaths — which is
 * exactly why it is the right mode for cleaning up a traced or recorded outline
 * that came out with far too many nodes.
 */
export function dissolvePoints<T extends Contour>(
  subpaths: ReadonlyArray<T>,
  isRemoved: (p: { x: number; y: number }) => boolean,
): T[] | null {
  let touched = false;
  const out: T[] = [];
  for (const sub of subpaths) {
    const kept = sub.points.filter((p) => !isRemoved(p));
    if (kept.length === sub.points.length) {
      out.push(sub);
      continue;
    }
    touched = true;
    if (kept.length < 2) continue;
    out.push({ ...sub, closed: sub.closed && kept.length >= 3, points: kept });
  }
  return touched ? out : null;
}

// ── What a tool asks for: one call, one verdict ───────────────────────────────

/**
 * What a cut did to one clip's outline. The caller applies it; deciding it is
 * this file's job, so the eraser's three modes never become a `switch` in the
 * overlay (and the next mode is one arm here, nowhere else).
 */
export type VectorCutResult =
  /** The tool missed — skip the document update entirely. */
  | { kind: "none" }
  /** Write this outline back (through the app's geometry seam). */
  | { kind: "geometry"; subpaths: Subpath[] }
  /** Nothing survived, or the mode says take it all: the clip goes. */
  | { kind: "delete" }
  /** Split: `subpaths` stays, `taken` becomes a piece of its own. */
  | { kind: "split"; subpaths: Subpath[]; taken: Subpath[] }
  /** The region claimed the whole object without changing its geometry. */
  | { kind: "whole" };

/**
 * Erase across an outline — the whole eraser, decided in one place.
 *
 * `filled` is the fact that changes the answer, not a preference: a filled path
 * is an AREA, so `split` carves it with the eraser's own footprint (Illustrator's
 * eraser), while an open stroke is a LINE, so `split` cuts it into arcs.
 */
export function eraseVectorSubpaths(
  subpaths: Subpath[],
  eraser: EraserPath,
  opts: { mode: VectorEraseMode; filled: boolean; fidelity?: PathFidelity },
): VectorCutResult {
  if (subpaths.length === 0 || eraser.points.length === 0) return { kind: "none" };
  const inside = (p: Pt) => eraserContains(eraser, p);

  if (opts.mode === "points") {
    const next = dissolvePoints(subpaths, inside);
    if (!next) return { kind: "none" };
    return next.length === 0 ? { kind: "delete" } : { kind: "geometry", subpaths: next };
  }

  if (opts.mode === "whole") {
    const touched = opts.filled
      ? cutSubpathsByRegion(subpaths, eraserFootprint(eraser), { filled: true, fidelity: opts.fidelity }).touched
      : partitionSubpaths(subpaths, inside).touched;
    return touched ? { kind: "delete" } : { kind: "none" };
  }

  if (opts.filled) {
    const cut = cutSubpathsByRegion(subpaths, eraserFootprint(eraser), {
      filled: true,
      fidelity: opts.fidelity,
    });
    if (!cut.touched) return { kind: "none" };
    return cut.outside.length === 0 ? { kind: "delete" } : { kind: "geometry", subpaths: cut.outside };
  }

  const kept = eraseSubpaths(subpaths, eraser);
  if (kept === null) return { kind: "none" };
  return kept.length === 0 ? { kind: "delete" } : { kind: "geometry", subpaths: kept };
}

/**
 * Cut an outline with a lasso/wand region — the selection tool's whole vector
 * story, decided here.
 *
 * In `cut` mode the loop you drew becomes the new border: filled art comes back
 * as two closed areas, an open stroke as arcs, and the taken side is handed
 * back for the caller to lift into its own clip. In `whole` mode the region
 * only PICKS — geometry is never rewritten, which is what you want the moment
 * the lasso is being used to grab objects rather than to carve them.
 */
export function cutVectorByRegion(
  subpaths: Subpath[],
  region: CutRegion,
  opts: { mode: VectorLassoMode; filled: boolean; fidelity?: PathFidelity },
): VectorCutResult {
  const cut = cutSubpathsByRegion(subpaths, region, {
    filled: opts.filled,
    fidelity: opts.fidelity,
  });
  if (!cut.touched) return { kind: "none" };
  if (opts.mode === "whole") return { kind: "whole" };
  if (cut.outside.length === 0) return { kind: "whole" };
  if (cut.inside.length === 0) return { kind: "none" };
  return { kind: "split", subpaths: cut.outside, taken: cut.inside };
}
