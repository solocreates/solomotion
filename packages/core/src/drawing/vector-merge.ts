import type { Contour, PathPoint, Subpath } from "../schema/vector";
import { simplifyPolyline } from "./area";
import { fitClosedContour } from "./path-fit";
import type { MultiPolygon, Pair, Ring } from "polygon-clipping";
import {
  multiPolyToSubpaths,
  pointInRing,
  robustBoolean,
  subpathToRing,
  subpathsToMultiPoly,
} from "../vector/polygon";

/**
 * VECTOR MERGE — what a freshly drawn stroke does to the geometry it lands on.
 *
 * Every vector brush in this app appended a contour and stopped, so two strokes
 * crossing each other stayed two outlines that merely LOOKED joined: fill them
 * and the overlap double-darkened, trim them and each ran its own length, and a
 * bucket poured into the corner they made leaked out through the seam. The
 * drawing was a picture of a shape rather than a shape.
 *
 * Two settings, deliberately independent, because they answer different
 * questions and people want them in different combinations:
 *
 *   MERGE       should this stroke become one body with what it overlaps?
 *   CLOSE GAPS  should a near-miss count as a touch?
 *
 * Close gaps is not a sub-option of merge — it is the SAME promise the paint
 * bucket makes about a hand-drawn outline ("treat this as if it closed"), in
 * the same units, from the same control. One number, three consumers.
 *
 * Merging is a union of OUTLINES, which is why it happens after the brush has
 * turned a gesture into geometry rather than inside the stroke engine: by then
 * a stroke is a closed contour like any other, and joining two of them is the
 * same operation as a boolean group — the one already in `vector/polygon`.
 */

/** Flattening tolerance for the union. Fine enough that a 1px nib survives. */
const MERGE_TOL = 0.25;

/**
 * Fallback refit tolerance, in layer units, for a caller with no fidelity of
 * its own to quote. Near the freehand brush's default (`2.5`) on purpose: a
 * merge may not be more precise than the strokes it merged, and the flattening
 * tolerance — which this used to be — is ten times finer than any hand.
 */
const DEFAULT_SIMPLIFY = 2;

/**
 * The smallest piece of a union worth keeping, as a fraction of its largest.
 *
 * A hand-drawn ribbon crosses ITSELF wherever the hand wobbled further than the
 * nib is wide, so the union of two of them is the shape you drew plus a dozen
 * slivers — needles and specks a fraction of a pixel across. Nobody can see
 * them, and every one costs anchors, a style entry and a node to snag on. The
 * outline you drew is never the sliver, so the largest piece sets the scale.
 */
const SLIVER_FRACTION = 1e-4;

/**
 * THE OUTPUT OF A BOOLEAN IS A POLYGON, AND A POLYGON IS NOT A DRAWING.
 *
 * `polygon-clipping` returns one straight-line vertex per sample the flattener
 * took, so unioning two smooth brush strokes produced a body carrying HUNDREDS
 * of points where the brush that drew them had left a dozen anchors. That is
 * the wall of green squares down every merged stroke, and it is not only ugly:
 *
 *   - every later merge re-flattens that inflated ring into a bigger one, so
 *     the cost of the tenth stroke is paid on the geometry the first nine left
 *     behind — the drawing gets heavier and slower with every line;
 *   - the document carries thousands of points that render identically to a few
 *     dozen, through save, undo, export and every morph tween;
 *   - node editing, which is the entire reason for drawing in vector, becomes
 *     unusable on the shape you just made.
 *
 * The previous attempt at this was Ramer–Douglas–Peucker at a sub-pixel
 * tolerance, on the argument that a union's corners must not be smoothed
 * through. The argument is right and the tool was wrong: RDP can only DELETE
 * vertices, so keeping a curve looking like a curve forces it to keep almost
 * all of them. Below a pixel it removes essentially nothing, which is exactly
 * what shipped.
 *
 * So: REFIT, through `fitClosedContour` — corners found and kept sharp, Béziers
 * fitted through the smooth runs between them. A cubic follows a curve instead
 * of approximating it with chords, so a tight tolerance costs anchors only
 * where the shape genuinely turns: an arc becomes one or two anchors rather
 * than two hundred, and a crossing stays a crossing.
 *
 * What is left here is the POLICY — when a refit is worth doing at all — while
 * the fit itself is shared with the paint bucket, which traces rings with the
 * same kind of corners in them.
 */
function refitContour(c: Contour, tolerance: number): Contour {
  if (tolerance <= 0 || c.points.length <= 8) return c;
  // Schneider IS the simplifier — a cubic follows a curve, so there is nothing
  // for a vertex-dropping pass to do first. RDP only runs as a guard on an
  // absurd ring, to bound the fitter's recursion.
  const ring =
    c.points.length > 4000 ? simplifyPolyline(c.points, tolerance / 2, true) : c.points;
  if (ring.length < 4) return c;
  const fitted = fitClosedContour(ring, tolerance);
  // A fit that came out no smaller than the polygon is not worth the handles.
  if (!fitted || fitted.points.length >= ring.length) return c;
  return { ...c, points: fitted.points, closed: true };
}

/** What a stroke merge did, so the caller knows whether the stroke kept an identity. */
export interface StrokeMergeResult {
  /** The contours that replace `existing`. Ids of survivors are preserved. */
  subpaths: Subpath[];
  /** Ids of the existing contours that were absorbed (and so no longer exist). */
  absorbed: string[];
  /** True when the incoming stroke actually joined something. */
  merged: boolean;
}

/** Shoelace area of a closed contour, absolute. */
function contourArea(c: Contour): number {
  const p = c.points;
  let sum = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    sum += (p[j]!.x + p[i]!.x) * (p[j]!.y - p[i]!.y);
  }
  return Math.abs(sum) / 2;
}

/**
 * Throw away the specks a boolean leaves behind (see `SLIVER_FRACTION`).
 *
 * The largest piece always survives — it is the shape somebody drew, and no
 * threshold may ever be allowed to eat it.
 */
function dropSlivers(contours: Contour[]): Contour[] {
  if (contours.length <= 1) return contours;
  const areas = contours.map(contourArea);
  const largest = Math.max(...areas);
  if (largest <= 0) return contours;
  const floor = largest * SLIVER_FRACTION;
  const kept = contours.filter((_, i) => areas[i]! >= floor);
  return kept.length > 0 ? kept : contours;
}

/** Squared distance between two ring vertices. */
function dist2(a: Pair, b: Pair): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

/**
 * Does `a` come within `gap` of `b`? Ring-to-ring, coarse on purpose: this is
 * the "did the artist mean these to touch" test, not a contact solver, and a
 * quarter-pixel answer would make the setting behave differently at every zoom.
 */
function ringsWithin(a: Ring, b: Ring, gap: number): boolean {
  if (gap <= 0) return false;
  const g2 = gap * gap;
  // Ring vertices are dense after flattening, so vertex-to-vertex is enough and
  // is O(n·m) on small n — a stroke against one contour, not the whole document.
  for (const p of a) {
    for (const q of b) {
      if (dist2(p, q) <= g2) return true;
    }
  }
  return false;
}

/**
 * FLATTENED RINGS, REMEMBERED.
 *
 * The document store is immer, so a contour nobody touched is the SAME OBJECT
 * from one stroke to the next — an exact, free content stamp. Flattening is the
 * expensive half of the touch test, and a drawing's four hundred untouched
 * contours are flattened identically every time somebody draws a line across
 * them. Keyed on identity, the second stroke onto a drawing pays for itself and
 * nothing else, and a contour that changes simply is not found.
 *
 * A WeakMap, so a deleted contour's ring leaves with it.
 */
const ringCache = new WeakMap<Contour, Ring>();

function ringOf(c: Contour): Ring {
  const had = ringCache.get(c);
  if (had) return had;
  const ring = subpathToRing(c, MERGE_TOL);
  ringCache.set(c, ring);
  return ring;
}

/**
 * A contour's bounds WITHOUT flattening it: the box of its anchors and their
 * handles. A cubic never leaves the convex hull of its four control points, so
 * this contains the curve — loosely, which is exactly what a pre-filter wants.
 */
function contourHull(c: Contour): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (c.points.length < 2) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const put = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const p of c.points) {
    put(p.x, p.y);
    if (p.hIn) put(p.hIn.x, p.hIn.y);
    if (p.hOut) put(p.hOut.x, p.hOut.y);
  }
  return { minX, minY, maxX, maxY };
}

/** Axis-aligned bounds of a ring, inflated by `pad`. */
function ringBounds(r: Ring, pad: number) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of r) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

function boxesOverlap(a: ReturnType<typeof ringBounds>, b: ReturnType<typeof ringBounds>): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

/**
 * Which existing contours the incoming stroke touches.
 *
 * Bounds first, then geometry — a drawing carries hundreds of contours and the
 * stroke overlaps two of them, so the real test must only ever run on the
 * handful a box test could not rule out. The cost of a stroke is proportional
 * to what it actually crosses, not to the size of the drawing.
 *
 * THE REAL TEST IS NOT A BOOLEAN. It used to be: `robustBoolean("intersection")`
 * per bbox-overlapping candidate — a full polygon-clipping run to answer a
 * yes/no question. At 242ms of a 293ms merge on a two-hundred-stroke sketch it
 * WAS the pause between finishing one line and being allowed to start the next.
 *
 * Overlap is a question about EDGES, so it is answered with edges: the incoming
 * outline's edges go into a uniform grid once, and each candidate is walked
 * against only the cells its own edges fall in. Containment — one outline
 * wholly inside another, no edges crossing — is the one case a crossing test
 * misses, so it is asked separately, once per candidate.
 *
 * `closeGapPx` widens the test from "crosses" to "comes this close", which is
 * what makes two strokes that visibly meet at a corner behave as if they do.
 */
export function contoursTouching(
  existing: ReadonlyArray<Subpath>,
  incoming: ReadonlyArray<Contour>,
  closeGapPx = 0,
): Set<string> {
  const hit = new Set<string>();
  if (existing.length === 0 || incoming.length === 0) return hit;
  const inRings = incoming.map((c) => subpathToRing(c, MERGE_TOL)).filter((r) => r.length >= 3);
  if (inRings.length === 0) return hit;
  const inBoxes = inRings.map((r) => ringBounds(r, closeGapPx));
  const grids = inRings.map((r) => new EdgeGrid(r, closeGapPx));

  for (const sub of existing) {
    // BOUNDS BEFORE FLATTENING. Flattening a bezier contour is the expensive
    // half, and a drawing is hundreds of contours the stroke never goes near —
    // so the box comes from the anchors and their handles, which bound a cubic
    // exactly and cost one pass over the points. Re-flattening the whole
    // drawing on every stroke was most of what was left of this function.
    const hull = contourHull(sub);
    if (!hull || !inBoxes.some((b) => boxesOverlap(hull, b))) continue;
    const ring = ringOf(sub);
    if (ring.length < 3) continue;
    const box = ringBounds(ring, 0);
    let touches = false;
    for (let i = 0; i < inRings.length && !touches; i++) {
      if (!boxesOverlap(box, inBoxes[i]!)) continue;
      const other = inRings[i]!;
      if (grids[i]!.crosses(ring)) touches = true;
      // Nested without crossing: one vertex of each decides it, either way round.
      else if (pointInRing(ring[0]!, other) || pointInRing(other[0]!, ring)) touches = true;
      else if (ringsWithin(ring, other, closeGapPx)) touches = true;
    }
    if (touches) hit.add(sub.id);
  }
  return hit;
}

/**
 * A uniform grid over one ring's EDGES — "does another ring cross this one?"
 * without comparing every edge to every edge.
 *
 * Built once per incoming outline and reused across every candidate, so the
 * whole touch test costs one pass over each outline rather than a polygon
 * boolean per candidate. The cell size is tied to the ring's own extent and
 * edge count, which keeps the buckets a handful of edges deep whether the
 * stroke is a dash or sweeps the page.
 */
class EdgeGrid {
  private readonly cell: number;
  private readonly minX: number;
  private readonly minY: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly buckets = new Map<number, number[]>();
  private readonly ring: Ring;
  private readonly pad: number;

  constructor(ring: Ring, pad = 0) {
    this.ring = ring;
    this.pad = pad;
    const b = ringBounds(ring, pad);
    this.minX = b.minX;
    this.minY = b.minY;
    const w = Math.max(1, b.maxX - b.minX);
    const h = Math.max(1, b.maxY - b.minY);
    // Aim at roughly one edge per cell, and never fewer than a handful of cells
    // across: a grid bigger than the work it saves is not a saving.
    const target = Math.sqrt((w * h) / Math.max(1, ring.length));
    this.cell = Math.max(1, Math.min(target, Math.max(w, h) / 4));
    this.cols = Math.max(1, Math.ceil(w / this.cell));
    this.rows = Math.max(1, Math.ceil(h / this.cell));
    for (let i = 0; i < ring.length; i++) {
      this.each(ring[i]!, ring[(i + 1) % ring.length]!, (key) => {
        const list = this.buckets.get(key);
        if (list) list.push(i);
        else this.buckets.set(key, [i]);
      });
    }
  }

  /** Every cell key the segment's padded box covers. */
  private each(a: Pair, b: Pair, fn: (key: number) => void): void {
    const x0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - this.pad - this.minX) / this.cell));
    const x1 = Math.min(this.cols - 1, Math.floor((Math.max(a[0], b[0]) + this.pad - this.minX) / this.cell));
    const y0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - this.pad - this.minY) / this.cell));
    const y1 = Math.min(this.rows - 1, Math.floor((Math.max(a[1], b[1]) + this.pad - this.minY) / this.cell));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) fn(y * this.cols + x);
  }

  /** Does any edge of `other` cross an edge of the ring this grid holds? */
  crosses(other: Ring): boolean {
    const seen = new Set<number>();
    for (let j = 0; j < other.length; j++) {
      const p = other[j]!;
      const q = other[(j + 1) % other.length]!;
      let found = false;
      seen.clear();
      this.each(p, q, (key) => {
        if (found) return;
        const list = this.buckets.get(key);
        if (!list) return;
        for (const i of list) {
          if (seen.has(i)) continue;
          seen.add(i);
          if (segmentsCross(p, q, this.ring[i]!, this.ring[(i + 1) % this.ring.length]!)) {
            found = true;
            return;
          }
        }
      });
      if (found) return true;
    }
    return false;
  }
}

/** Orientation of the triple (a, b, c): >0 left turn, <0 right, 0 collinear. */
function cross3(a: Pair, b: Pair, c: Pair): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/** Do segments a→b and c→d cross? Touching counts — a graze is a touch. */
function segmentsCross(a: Pair, b: Pair, c: Pair, d: Pair): boolean {
  const d1 = cross3(c, d, a);
  const d2 = cross3(c, d, b);
  const d3 = cross3(a, b, c);
  const d4 = cross3(a, b, d);
  return (
    ((d1 > 0) !== (d2 > 0) || d1 === 0 || d2 === 0) &&
    ((d3 > 0) !== (d4 > 0) || d3 === 0 || d4 === 0)
  );
}

/**
 * Union an incoming stroke into the contours it touches.
 *
 * Untouched contours are returned UNCHANGED and by identity — a merge must not
 * re-flatten a drawing's other four hundred curves into polygons just because
 * one stroke crossed one of them. That is both a fidelity promise (your bezier
 * corners survive) and the reason this stays fast on a real drawing.
 *
 * The merged body inherits the id of the FIRST contour it absorbed, so a
 * selection, a style override or a morph correspondence pointing at the shape
 * you drew into still resolves after the join. A merge that mints a fresh id
 * silently drops every one of those.
 *
 * `mintId` is injected rather than imported so this file stays free of the id
 * factory (and so a test can make merges deterministic).
 */
export function mergeStrokeInto(
  existing: ReadonlyArray<Subpath>,
  incoming: ReadonlyArray<Contour>,
  mintId: () => string,
  opts: { closeGapPx?: number; only?: ReadonlySet<string>; simplifyPx?: number } = {},
): StrokeMergeResult {
  const gap = Math.max(0, opts.closeGapPx ?? 0);
  const touched = opts.only ?? contoursTouching(existing, incoming, gap);
  const incomingSubs = (): Subpath[] =>
    incoming.map((c) => ({ ...c, id: mintId() }));

  // Gap closing at the geometry level. `polygon-clipping` has no offset, so
  // instead of growing every operand by half the gap and shrinking back — which
  // would round every corner in the drawing to make one join — the union takes
  // a BRIDGE across each near-miss and leaves the original outlines exact.
  //
  // These are computed BEFORE the early-out, because a stroke with a gap in
  // ITSELF has something to merge even when it touched nothing at all.
  const bridges = gap > 0 ? gapBridges(existing, touched, incoming, gap) : [];

  if (touched.size === 0 && bridges.length === 0) {
    return { subpaths: [...existing, ...incomingSubs()], absorbed: [], merged: false };
  }

  const operands: MultiPolygon[] = [subpathsToMultiPoly(incoming as Contour[], MERGE_TOL)];
  const absorbed: string[] = [];
  for (const sub of existing) {
    if (!touched.has(sub.id)) continue;
    absorbed.push(sub.id);
    operands.push(subpathsToMultiPoly([sub], MERGE_TOL));
  }
  operands.push(...bridges);

  const united = robustBoolean("union", operands);
  if (!united || united.length === 0) {
    // The boolean gave up (see `robustBoolean`) — append rather than lose the
    // stroke. A drawing tool that eats a line is worse than one that does not
    // merge it.
    return { subpaths: [...existing, ...incomingSubs()], absorbed: [], merged: false };
  }

  const mergedContours = dropSlivers(multiPolyToSubpaths(united)).map((c) =>
    refitContour(c, opts.simplifyPx ?? DEFAULT_SIMPLIFY),
  );
  // The body keeps the id of the first host it absorbed; a stroke that only
  // closed its OWN gap absorbed nothing, so it is simply a new contour.
  const keepId = absorbed[0];
  const mergedSubs: Subpath[] = mergedContours.map((c, i) => ({
    ...c,
    id: i === 0 && keepId ? keepId : mintId(),
  }));

  // Rebuild in place: the merged body takes the position of the first contour
  // it absorbed, so paint order (`subpaths[0]` is the bottom) is preserved and
  // the drawing does not visibly restack when two strokes join.
  const out: Subpath[] = [];
  let placed = false;
  for (const sub of existing) {
    if (!touched.has(sub.id)) {
      out.push(sub);
      continue;
    }
    if (!placed) {
      out.push(...mergedSubs);
      placed = true;
    }
  }
  if (!placed) out.push(...mergedSubs);
  return { subpaths: out, absorbed, merged: true };
}

/**
 * A SELF-BRIDGE IS ONLY A GAP IF IT IS A SHORTCUT.
 *
 * Two points on one outline that sit close together are usually not a gap at
 * all — they are neighbouring samples, the two sides of a thin stroke, or the
 * fold at an end cap. Bridging those welds a stroke shut along its own length,
 * which is the "it self-merged into a mess" failure.
 *
 * The test that tells them apart is not how many SAMPLES apart they are (a
 * meaningless count on a ring whose flattener samples curves densely and
 * straights sparsely — which is what the old index-based skip measured). It is
 * how far apart they are ALONG THE OUTLINE: the mouth of a C is a short hop
 * across and a long walk around, while the two sides of a ribbon are a short
 * hop across and a short walk around the cap. So a bridge has to be a genuine
 * shortcut, by this factor, before it is built.
 */
const SHORTCUT_RATIO = 3;

/** Cumulative arc length at each ring vertex, plus the ring's perimeter. */
function ringArc(r: Ring): { at: Float64Array; total: number } {
  const at = new Float64Array(r.length);
  let total = 0;
  for (let i = 1; i < r.length; i++) {
    total += Math.hypot(r[i]![0] - r[i - 1]![0], r[i]![1] - r[i - 1]![1]);
    at[i] = total;
  }
  const close = Math.hypot(r[0]![0] - r[r.length - 1]![0], r[0]![1] - r[r.length - 1]![1]);
  return { at, total: total + close };
}

/** Shorter of the two ways round between two vertices, in outline distance. */
function arcApart(arc: { at: Float64Array; total: number }, i: number, j: number): number {
  const d = Math.abs(arc.at[i]! - arc.at[j]!);
  return Math.min(d, arc.total - d);
}

/**
 * Is the space between `a` and `b` actually EMPTY — i.e. is this a gap, and not
 * the inside of the shape looking narrow?
 *
 * This one test is what makes self-closing possible at all. A brush stroke is a
 * closed ribbon, so its outline comes within a hair of itself at both END CAPS
 * and anywhere the stroke is thin — bridge those and you weld the stroke shut
 * along its own length. The mouth of a C is the opposite: the chord across it
 * runs through open canvas. So the rule is "bridge only where the shortcut is
 * outside the shape", which is exactly what a person means by a gap and needs
 * no knowledge of nib width, pressure or how the stroke was drawn.
 */
function spansOpenSpace(a: Pair, b: Pair, rings: readonly Ring[]): boolean {
  const mid: Pair = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  for (const r of rings) if (pointInRing(mid, r)) return false;
  return true;
}

/**
 * A fat quad spanning a near-miss — the "close gaps" bridge.
 *
 * Offsetting both outlines and shrinking back would round every corner in the
 * drawing to make one join; a bridge touches nothing except the gap it exists
 * to close, which is the behaviour people actually mean by the setting.
 */
function bridgeQuad(a: Pair, b: Pair, gap: number): MultiPolygon {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  // Half a gap wide, and extended a hair past both ends so the union bites.
  const w = Math.max(0.5, gap * 0.5);
  const ex = (dx / len) * 0.5;
  const ey = (dy / len) * 0.5;
  const nx = (-dy / len) * w;
  const ny = (dx / len) * w;
  const ax = a[0] - ex;
  const ay = a[1] - ey;
  const bx = b[0] + ex;
  const by = b[1] + ey;
  return [
    [
      [
        [ax + nx, ay + ny],
        [bx + nx, by + ny],
        [bx - nx, by - ny],
        [ax - nx, ay - ny],
        [ax + nx, ay + ny],
      ],
    ],
  ];
}

/** The shortest open-space near-miss between two rings (or a ring and itself). */
function nearestGap(a: Ring, b: Ring, gap: number, guards: readonly Ring[]): { a: Pair; b: Pair } | null {
  const g2 = gap * gap;
  const self = a === b;
  const arc = self ? ringArc(a) : null;
  let best: { a: Pair; b: Pair; d2: number } | null = null;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!;
    for (let j = self ? i + 1 : 0; j < b.length; j++) {
      const q = b[j]!;
      const d = dist2(p, q);
      if (d <= 1e-9 || d > g2) continue;
      if (best && d >= best.d2) continue;
      // Only a real shortcut counts as a gap in one's own outline.
      if (arc && arcApart(arc, i, j) < Math.sqrt(d) * SHORTCUT_RATIO) continue;
      if (!spansOpenSpace(p, q, guards)) continue;
      best = { a: p, b: q, d2: d };
    }
  }
  return best ? { a: best.a, b: best.b } : null;
}

/**
 * Every bridge this stroke justifies: to what it lands on, to its own other
 * pieces, and — the case that was missing entirely — to ITSELF.
 *
 * Close gaps used to reach only for contours that were already in the layer, so
 * the setting did nothing at all for the stroke you were drawing: sweep a C in
 * one gesture with a 4px gap and its mouth stayed open, because there was no
 * second contour to bridge to. A gap is a gap whoever left it, and the stroke
 * under the cursor is the one whose gaps a person is actually looking at.
 *
 * One bridge per pair of rings, so a stroke that genuinely closes two openings
 * closes both while a wobbly outline cannot spray a dozen welds along itself.
 */
function gapBridges(
  existing: ReadonlyArray<Subpath>,
  touched: ReadonlySet<string>,
  incoming: ReadonlyArray<Contour>,
  gap: number,
): MultiPolygon[] {
  const inRings = incoming.map((c) => subpathToRing(c, MERGE_TOL)).filter((r) => r.length >= 3);
  if (inRings.length === 0) return [];
  const hostRings: Ring[] = [];
  for (const sub of existing) {
    if (!touched.has(sub.id)) continue;
    const r = ringOf(sub);
    if (r.length >= 3) hostRings.push(r);
  }
  // A bridge may not cut through anything solid — including a contour it is not
  // joining, which is why every ring in play guards the midpoint test.
  const guards = [...hostRings, ...inRings];
  const out: MultiPolygon[] = [];
  const add = (a: Ring, b: Ring) => {
    const found = nearestGap(a, b, gap, guards);
    if (found) out.push(bridgeQuad(found.a, found.b, gap));
  };
  for (let i = 0; i < inRings.length; i++) {
    // …to itself, …to the stroke's other pieces, …to what it landed on.
    add(inRings[i]!, inRings[i]!);
    for (let j = i + 1; j < inRings.length; j++) add(inRings[i]!, inRings[j]!);
    for (const host of hostRings) add(inRings[i]!, host);
  }
  return out;
}
