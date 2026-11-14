import type { Contour, FillRule } from "../schema/vector";
import { pointInRing, ringSignedArea, subpathToRing } from "./polygon";

/**
 * REGIONS — the one answer to "how many separate pieces of artwork is this?".
 *
 * A path clip's `subpaths` are the contours of ONE filled region: an outer
 * outline and the holes punched through it, sharing a fill rule. That is a
 * compound path — a donut, the counter in an `o`, the two bowls of a `B`. The
 * hole is not a piece of artwork in its own right: it cannot have its own
 * colour, because "the colour of a hole" is not a thing. It needs no identity
 * beyond its order in the list.
 *
 * Everything ELSE — two contours that are simply beside each other — is two
 * pieces. Illustrator's rule, and the reason it is right here too: a piece that
 * wants its own fill, stroke, transform, effects, morph, trim, in/out animation
 * and keyframes is a LAYER, and this app already has one of those. Splitting
 * along region boundaries is therefore the whole of "promote artwork into
 * editable pieces" — the pieces are `path` clips and inherit every capability
 * the app has, including the ones it grows next year.
 *
 * Pure geometry, no identity, no document: the knife, the cut tool, the pen and
 * SVG import all ask the same question and get the same answer.
 */

/** One separable piece: an outer contour plus the contours it swallows. */
export interface Region<T extends Contour = Contour> {
  /** Outer first, then its holes — the order a compound path is drawn in. */
  contours: T[];
  /** Indices into the input array, in `contours` order. */
  indices: number[];
}

/** Flattening tolerance for containment tests — coarse on purpose (see below). */
const CONTAINMENT_TOL = 0.75;

/**
 * Partition contours into the pieces they actually are.
 *
 * The rule, stated once:
 *
 *  - **Containment** decides parentage. A contour whose representative point
 *    lies inside another is nested in it; the TIGHTEST such container wins, so
 *    an island inside a hole inside a shape resolves correctly.
 *  - **Depth** decides hole-ness. Even nesting depth is a piece of artwork; odd
 *    depth is a hole in the piece above it. This is the even-odd reading, and
 *    it is used for BOTH fill rules — under `nonzero` a nested contour is a
 *    hole only when it winds the opposite way, so winding is consulted there
 *    and containment alone decides under `evenodd`.
 *  - An island inside a hole is a piece of its own (depth 2), NOT part of its
 *    grandparent. That is what makes the dot of an `i`-in-a-counter separable.
 *
 * Contours too degenerate to have an inside (fewer than 3 points, or zero area)
 * can neither contain nor be contained meaningfully, so each becomes its own
 * piece — an open squiggle drawn with the pen is a piece of artwork, and losing
 * it because it encloses nothing would be the worst possible failure here.
 *
 * Order is preserved: pieces come out in the order their outer contour appeared,
 * and holes follow their owner. So `separateRegions(x).flatMap(r => r.contours)`
 * is a stable reordering of `x`, never a loss.
 */
export function separateRegions<T extends Contour>(
  contours: ReadonlyArray<T>,
  fillRule: FillRule = "nonzero",
): Region<T>[] {
  const n = contours.length;
  if (n <= 1) {
    return n === 1 ? [{ contours: [contours[0]!], indices: [0] }] : [];
  }

  // Flatten once. A coarse tolerance is right: we are asking "is this contour
  // inside that one", a question whose answer never turns on a quarter-pixel,
  // and the cost is O(n²) point-in-ring tests.
  const rings = contours.map((c) => subpathToRing(c, CONTAINMENT_TOL));
  const areas = rings.map(ringSignedArea);
  const solid = rings.map((r, i) => r.length >= 3 && Math.abs(areas[i]!) > 1e-6);

  // Tightest container of each contour — smallest-area ring that holds its
  // representative point. Only a SOLID ring can contain anything.
  const parent: number[] = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const rep = rings[i]![0];
    if (!rep) continue;
    let best = -1;
    let bestArea = Infinity;
    for (let j = 0; j < n; j++) {
      if (i === j || !solid[j]) continue;
      // A degenerate contour has no interior, so it is never a container; but it
      // can still be CONTAINED (an open squiggle drawn inside a circle).
      if (!pointInRing(rep, rings[j]!)) continue;
      const a = Math.abs(areas[j]!);
      // Equal areas would make containment mutual and the tree cyclic; break the
      // tie by index so exactly one direction survives.
      if (a < bestArea || (a === bestArea && j < best)) {
        best = j;
        bestArea = a;
      }
    }
    parent[i] = best;
  }
  breakCycles(parent);

  // Depth = how many contours enclose this one.
  const depth: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let d = 0;
    for (let p = parent[i]!; p !== -1; p = parent[p]!) d++;
    depth[i] = d;
  }

  // Hole-ness. Even-odd: nested at all = hole. Nonzero: nested AND winding
  // against its container = hole; a nested contour winding the SAME way is
  // painted solid on top, so it is its own piece (that is precisely what
  // nonzero means, and why the two rules must not share one branch).
  const isHole = (i: number): boolean => {
    const p = parent[i]!;
    if (p === -1 || !solid[i]) return false;
    if (depth[i]! % 2 === 0) return false;
    if (fillRule === "evenodd") return true;
    return Math.sign(areas[i]!) !== Math.sign(areas[p]!);
  };

  // Emit: every non-hole is a piece, in input order; holes join their owner.
  const regionOf: number[] = new Array(n).fill(-1);
  const regions: Region<T>[] = [];
  for (let i = 0; i < n; i++) {
    if (isHole(i)) continue;
    regionOf[i] = regions.length;
    regions.push({ contours: [contours[i]!], indices: [i] });
  }
  for (let i = 0; i < n; i++) {
    if (!isHole(i)) continue;
    // Walk up to the nearest ancestor that is a piece — a hole inside a hole
    // belongs to the piece that owns the outer hole's region.
    let owner = parent[i]!;
    while (owner !== -1 && regionOf[owner] === -1) owner = parent[owner]!;
    const r = owner === -1 ? null : regions[regionOf[owner]!];
    if (r) {
      r.contours.push(contours[i]!);
      r.indices.push(i);
    } else {
      // Orphaned hole (its owner vanished into a cycle break) — a lone contour
      // is still artwork, so it becomes its own piece rather than disappearing.
      regionOf[i] = regions.length;
      regions.push({ contours: [contours[i]!], indices: [i] });
    }
  }
  return regions;
}

/**
 * Does this artwork consist of more than one piece? The cheap question the
 * import path, the knife and the pen ask before doing any work.
 */
export function isSeparable(contours: ReadonlyArray<Contour>, fillRule: FillRule = "nonzero"): boolean {
  return contours.length > 1 && separateRegions(contours, fillRule).length > 1;
}

/**
 * Containment is derived from sampled points, so a pathological pair (identical
 * rings, self-intersecting art) can come back mutually contained. Rather than
 * loop forever walking the parent chain, cut the back-edge: the deeper index
 * keeps its parent, the other becomes a root.
 */
function breakCycles(parent: number[]): void {
  const state = new Uint8Array(parent.length); // 0 unvisited, 1 on stack, 2 done
  for (let i = 0; i < parent.length; i++) {
    if (state[i]) continue;
    const stack: number[] = [];
    let cur = i;
    while (cur !== -1 && state[cur] === 0) {
      state[cur] = 1;
      stack.push(cur);
      cur = parent[cur]!;
    }
    if (cur !== -1 && state[cur] === 1) parent[cur] = -1; // close the loop
    for (const idx of stack) state[idx] = 2;
  }
}

/**
 * Which region of a compound path a point falls inside — the vector bucket's
 * exact answer, before anything is rasterized.
 *
 * This is the difference between filling a shape and filling a PICTURE of a
 * shape. A traced fill is a new outline fitted to pixels: it is resolution-
 * bound, it duplicates geometry that already exists, and it stops agreeing with
 * the artwork the moment the artwork is edited. When the click genuinely lands
 * inside a closed contour, the honest fill is a `Paint` on that contour — which
 * scales, animates, morphs and follows a colour variable, because it IS the
 * shape's fill rather than a copy sitting on top of it.
 *
 * Tracing stays for the case it was invented for: an enclosure formed by
 * several strokes that overlap without being one path, where there is no single
 * contour to point at.
 *
 * Returns the TIGHTEST containing region, so clicking inside a shape nested in
 * a hole fills the island rather than its grandparent.
 */
export function regionAtPoint<T extends Contour>(
  contours: ReadonlyArray<T>,
  x: number,
  y: number,
  fillRule: FillRule = "nonzero",
): Region<T> | null {
  const regions = separateRegions(contours, fillRule);
  let best: Region<T> | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const region of regions) {
    const outer = region.contours[0];
    if (!outer) continue;
    const ring = subpathToRing(outer, CONTAINMENT_TOL);
    if (ring.length < 3 || !pointInRing([x, y], ring)) continue;
    // Inside one of its holes is outside the piece.
    let inHole = false;
    for (let i = 1; i < region.contours.length; i++) {
      const hole = subpathToRing(region.contours[i]!, CONTAINMENT_TOL);
      if (hole.length >= 3 && pointInRing([x, y], hole)) {
        inHole = true;
        break;
      }
    }
    if (inHole) continue;
    const area = Math.abs(ringSignedArea(ring));
    if (area < bestArea) {
      best = region;
      bestArea = area;
    }
  }
  return best;
}

/**
 * Is this region CUT UP by other artwork — does anything cross its interior?
 *
 * ## Why the bucket needs this and nothing else does
 *
 * The paint bucket has two ways to answer "what did I click on", and they ask
 * different questions:
 *
 *  - `regionAtPoint` — which FILL REGION of this path contains the point. Exact
 *    geometry, editable forever, keyframable: clicking a petal recolours that
 *    petal's own fill rather than stacking a traced copy on top of it. This is
 *    the answer you want whenever it is true.
 *  - the pixel flood — which FACE of the whole picture contains the point. What
 *    the hover outline draws, and therefore what the person was promised.
 *
 * They are the same answer right up until something crosses the region: draw a
 * hexagon with three lines across it and the flood finds the small triangle you
 * clicked, while `regionAtPoint` finds the hexagon — and recolouring the
 * hexagon's fill repaints the entire drawing. The preview said one thing, the
 * click did another, and the geometry was not wrong so much as answering a
 * question nobody asked.
 *
 * So this is the gate: take the exact-geometry shortcut only where the two
 * questions provably have the same answer, which is exactly when no other
 * contour runs through the region's inside.
 *
 * ## How it decides
 *
 * The MIDPOINT of each flattened segment, not its endpoints. A chord drawn
 * corner to corner has both endpoints ON the boundary, where point-in-ring has
 * no defined answer and either verdict is a coin toss; its midpoint is
 * unambiguously inside. Contours that merely touch, share a vertex, or sit
 * entirely outside contribute no interior sample and do not count.
 *
 * "Inside" means inside by more than the tolerance the outline was flattened
 * at. That is not a fudge factor, it is the precision this file already works
 * to: an edge running ALONG the region's own boundary — a shape traced over
 * another, two rectangles sharing a wall — is nearer the edge than the edge is
 * knowable, and reading that as "crosses the interior" would break the shortcut
 * for every shape with a neighbour it never actually touched.
 *
 * An island genuinely inside the region counts as subdividing it, and that is
 * right: a circle drawn inside a square makes the square's face a donut, and a
 * donut is what the flood traced.
 *
 * A region is never subdivided by its OWN outline or holes, and that is
 * enforced by object identity rather than asked of the caller: `separateRegions`
 * hands back the very contours it was given, so `others` can simply be the
 * whole picture — the layer's entire contour list — and the region's own parts
 * drop out on the way past. Contours from another layer are different objects
 * because they are different artwork, which is the same answer either way.
 *
 * What it cannot see is a boundary that is not a contour: a brush mark, a
 * photograph, a letter of text drawn across the shape. Those bound the flood
 * and not this, so the shortcut can still over-fill under them. Fixing that
 * needs the pixels, which is a different (and much more expensive) question
 * than the one this file answers.
 */
export function regionIsSubdivided<T extends Contour>(
  region: Region<T>,
  others: ReadonlyArray<Contour>,
): boolean {
  const outer = region.contours[0];
  if (!outer) return false;
  const ring = subpathToRing(outer, CONTAINMENT_TOL);
  if (ring.length < 3 || Math.abs(ringSignedArea(ring)) <= 1e-6) return false;
  const holes = region.contours
    .slice(1)
    .map((c) => subpathToRing(c, CONTAINMENT_TOL))
    .filter((r) => r.length >= 3);
  const own = new Set<Contour>(region.contours);

  const outline = [ring, ...holes];

  for (const other of others) {
    if (own.has(other)) continue;
    const line = subpathToRing(other, CONTAINMENT_TOL);
    if (line.length < 2) continue;
    const last = other.closed ? line.length : line.length - 1;
    for (let i = 0; i < last; i++) {
      const a = line[i]!;
      const b = line[(i + 1) % line.length]!;
      const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (!pointInRing(mid, ring)) continue;
      if (holes.some((h) => pointInRing(mid, h))) continue;
      if (nearAnyRing(mid, outline, CONTAINMENT_TOL)) continue;
      return true;
    }
  }
  return false;
}

/** Is this point within `tol` of any of these rings? (Squared — no roots.) */
function nearAnyRing(pt: readonly [number, number], rings: ReadonlyArray<ReadonlyArray<readonly [number, number]>>, tol: number): boolean {
  const tolSq = tol * tol;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const lenSq = dx * dx + dy * dy;
      const t = lenSq > 0 ? Math.max(0, Math.min(1, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / lenSq)) : 0;
      const ex = pt[0] - (a[0] + t * dx);
      const ey = pt[1] - (a[1] + t * dy);
      if (ex * ex + ey * ey <= tolSq) return true;
    }
  }
  return false;
}
