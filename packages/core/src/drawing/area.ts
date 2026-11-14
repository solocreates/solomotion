/**
 * Area detection — the ONE region brain behind every "find the shape under the
 * cursor" tool: the paint bucket (px AND vector), paint inside/outside, the
 * auto lasso / magic wand, and tomorrow's video-region tracker seeds. It
 * operates on a plain RGBA buffer, so the same code serves a raster layer
 * directly, a rasterized snapshot of vector layers ("fill a shape's gap"), or a
 * composite of a reference ("fill inside the outline on the layer above").
 *
 *   pixels ──► resolveRegion(scope) ──► RegionMask ──► maskCoverage() ──► paint
 *                                                  └─► traceRegion() ──► Contour (vector fill / lasso outline)
 *
 * The flood is colour-blind on purpose. `toleranceMask` decides what a colour
 * match IS, `floodGrid` walks whatever grid it is handed, and gap closing is
 * nothing more than removing cells from that grid before the walk — which is
 * why closing a gap, expanding a fill and feathering its edge are three
 * settings here rather than three tools that each half-implement the others.
 */

/** A binary region over a w×h grid (1 byte per pixel; 1 = inside). */
export interface RegionMask {
  width: number;
  height: number;
  data: Uint8Array;
  /** Tight bounds of the set pixels (x1/y1 exclusive). Empty ⇒ x0 > x1. */
  bounds: { x0: number; y0: number; x1: number; y1: number };
}

function emptyBounds() {
  return { x0: Number.MAX_SAFE_INTEGER, y0: Number.MAX_SAFE_INTEGER, x1: -1, y1: -1 };
}

function growBounds(b: RegionMask["bounds"], x: number, y: number): void {
  if (x < b.x0) b.x0 = x;
  if (y < b.y0) b.y0 = y;
  if (x > b.x1) b.x1 = x;
  if (y > b.y1) b.y1 = y;
}

/** Squared RGBA distance, alpha-weighted so transparent areas read as "one color". */
function colorDistSq(px: Uint8ClampedArray, i: number, r: number, g: number, b: number, a: number): number {
  const pa = px[i + 3]!;
  // Both effectively transparent → identical regardless of hidden RGB.
  if (pa < 8 && a < 8) return 0;
  const dr = px[i]! - r;
  const dg = px[i + 1]! - g;
  const db = px[i + 2]! - b;
  const da = pa - a;
  return dr * dr + dg * dg + db * db + da * da * 2;
}

/**
 * The pixels a flood may TRAVEL THROUGH: everything within `tolerance` of the
 * seed colour. Split out from the flood itself because three different tools
 * need this grid and only one of them is contiguous — the wand takes it whole,
 * gap closing dilates its complement into a barrier, and the flood walks it.
 */
export function toleranceMask(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  seedX: number,
  seedY: number,
  tolerance: number,
): Uint8Array | null {
  const sx = Math.round(seedX);
  const sy = Math.round(seedY);
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return null;
  const seedI = (sy * width + sx) * 4;
  const r = pixels[seedI]!;
  const g = pixels[seedI + 1]!;
  const b = pixels[seedI + 2]!;
  const a = pixels[seedI + 3]!;
  // Max distance² is 4 channels × 255²(alpha ×2 weight ⇒ ~5×) — scale tolerance into it.
  const tolSq = tolerance * tolerance * (255 * 255 * 5);
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) {
    if (colorDistSq(pixels, i * 4, r, g, b, a) <= tolSq) out[i] = 1;
  }
  return out;
}

/** A passability grid as a mask (tight bounds computed). */
export function gridToMask(grid: Uint8Array, width: number, height: number): RegionMask {
  const bounds = emptyBounds();
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] === 1) growBounds(bounds, i % width, (i / width) | 0);
  }
  return { width, height, data: grid, bounds };
}

/**
 * Scanline flood from a seed over a boolean passability grid.
 *
 * The flood knows nothing about colour any more, which is what lets gap closing
 * exist at all: the barrier is just cells removed from the grid before the walk.
 */
export function floodGrid(
  allowed: Uint8Array,
  width: number,
  height: number,
  seedX: number,
  seedY: number,
): RegionMask | null {
  const sx = Math.round(seedX);
  const sy = Math.round(seedY);
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return null;
  const data = new Uint8Array(width * height);
  const bounds = emptyBounds();
  if (!allowed[sy * width + sx]) return { width, height, data, bounds };
  const stack: number[] = [sx, sy];
  while (stack.length > 0) {
    const y = stack.pop()!;
    let x = stack.pop()!;
    let i = y * width + x;
    if (data[i] || !allowed[i]) continue;
    while (x > 0 && !data[i - 1] && allowed[i - 1]) {
      x--;
      i--;
    }
    let spanUp = false;
    let spanDown = false;
    while (x < width && !data[i] && allowed[i]) {
      data[i] = 1;
      growBounds(bounds, x, y);
      if (y > 0) {
        const upOk = !data[i - width] && allowed[i - width] === 1;
        if (upOk && !spanUp) {
          stack.push(x, y - 1);
          spanUp = true;
        } else if (!upOk) spanUp = false;
      }
      if (y < height - 1) {
        const dnOk = !data[i + width] && allowed[i + width] === 1;
        if (dnOk && !spanDown) {
          stack.push(x, y + 1);
          spanDown = true;
        } else if (!dnOk) spanDown = false;
      }
      x++;
      i++;
    }
  }
  return { width, height, data, bounds };
}

/**
 * Scanline flood fill from a seed with a 0..1 tolerance (0 = exact color,
 * 1 = everything). Contiguous only — for "select same color everywhere"
 * (non-contiguous wand) use `globalColorMask`.
 */
export function floodRegion(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  seedX: number,
  seedY: number,
  tolerance: number,
): RegionMask | null {
  const allowed = toleranceMask(pixels, width, height, seedX, seedY, tolerance);
  return allowed ? floodGrid(allowed, width, height, seedX, seedY) : null;
}

/** Non-contiguous wand: every pixel within tolerance of the seed color. */
export function globalColorMask(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  seedX: number,
  seedY: number,
  tolerance: number,
): RegionMask | null {
  const allowed = toleranceMask(pixels, width, height, seedX, seedY, tolerance);
  return allowed ? gridToMask(allowed, width, height) : null;
}

/**
 * Chamfer (3–4) distance transform: for every cell, the approximate distance to
 * the nearest set cell of `seed`. Two passes, O(n), no per-pixel neighbourhood
 * scan — and ONE implementation, because growing a mask, shrinking it and
 * feathering its edge are three readings of the same number.
 */
function chamfer(seed: Uint8Array, width: number, height: number): Float32Array {
  const INF = 1e9;
  const dist = new Float32Array(width * height);
  for (let i = 0; i < dist.length; i++) dist[i] = seed[i] ? 0 : INF;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (dist[i] === 0) continue;
      let d = dist[i]!;
      if (x > 0) d = Math.min(d, dist[i - 1]! + 1);
      if (y > 0) {
        d = Math.min(d, dist[i - width]! + 1);
        if (x > 0) d = Math.min(d, dist[i - width - 1]! + 1.4);
        if (x < width - 1) d = Math.min(d, dist[i - width + 1]! + 1.4);
      }
      dist[i] = d;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      let d = dist[i]!;
      if (x < width - 1) d = Math.min(d, dist[i + 1]! + 1);
      if (y < height - 1) {
        d = Math.min(d, dist[i + width]! + 1);
        if (x < width - 1) d = Math.min(d, dist[i + width + 1]! + 1.4);
        if (x > 0) d = Math.min(d, dist[i + width - 1]! + 1.4);
      }
      dist[i] = d;
    }
  }
  return dist;
}

/** Grow a passability/ink grid by `radius` px (the barrier builder). */
function growGrid(grid: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return grid;
  const dist = chamfer(grid, width, height);
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) if (dist[i]! <= radius) out[i] = 1;
  return out;
}

/**
 * Smooth value noise on an integer lattice — the margin's wander.
 *
 * Hand-rolled and tiny on purpose: this file is core, it must run in a worker
 * and a test, and a noise library for one bilinear lerp of a hash would be a
 * dependency for eleven lines. Deterministic in `seed`, so a hover preview and
 * the commit that follows it produce the identical edge — a jittered margin
 * that resampled on commit would move under the cursor at the worst moment.
 */
function valueNoise(x: number, y: number, seed: number): number {
  const hash = (ix: number, iy: number): number => {
    let h = (ix * 374761393 + iy * 668265263 + seed * 1442695040) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  // Smoothstep the interpolant: linear lerp between lattice values bands.
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(x0, y0) + (hash(x0 + 1, y0) - hash(x0, y0)) * sx;
  const b = hash(x0, y0 + 1) + (hash(x0 + 1, y0 + 1) - hash(x0, y0 + 1)) * sx;
  return a + (b - a) * sy;
}

/** The lattice period, px. Coarse enough to read as a wandering edge rather
 *  than as fizz on it. */
const JITTER_SCALE = 22;

/**
 * Grow a mask by `px`, with the distance VARYING along the edge.
 *
 * The jittered version is separate from `growMask` rather than a parameter on
 * it, because the plain one is the hot path (gap barriers run it twice per
 * fill) and it must not pay for a noise lookup it does not use.
 */
function growMaskJittered(
  mask: RegionMask,
  px: number,
  jitter: number,
  seed: number,
): RegionMask {
  const { width, height, data } = mask;
  const grow = px > 0;
  const seedGrid = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) seedGrid[i] = grow ? data[i]! : data[i] ? 0 : 1;
  const dist = chamfer(seedGrid, width, height);
  const out = new Uint8Array(width * height);
  const base = Math.abs(px);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      // 0..1 noise → a margin between (1 - jitter) and (1 + jitter) of `px`.
      const n = valueNoise(x / JITTER_SCALE, y / JITTER_SCALE, seed);
      const radius = base * (1 + jitter * (n * 2 - 1));
      const inside = dist[i]! <= radius;
      out[i] = grow ? (inside ? 1 : 0) : inside ? 0 : 1;
    }
  }
  return gridToMask(out, width, height);
}

/**
 * Grow a mask by `px` (positive) or shrink it (negative).
 *
 * Shrinking is growing the complement — the same transform, read from the other
 * side — which is why there is one function here rather than a `dilate` and an
 * `erode` that would eventually disagree about what "1px" means.
 */
export function growMask(mask: RegionMask, px: number): RegionMask {
  if (px === 0) return mask;
  const { width, height, data } = mask;
  if (px > 0) return gridToMask(growGrid(data, width, height, px), width, height);
  const outside = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) outside[i] = data[i] ? 0 : 1;
  const grown = growGrid(outside, width, height, -px);
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = grown[i] ? 0 : 1;
  return gridToMask(out, width, height);
}

/** Grow a mask by `radius` px. Kept as the name the wand and bucket already use. */
export function dilateMask(mask: RegionMask, radius: number): RegionMask {
  return radius <= 0 ? mask : growMask(mask, radius);
}

/**
 * Grow a mask by `steps` pixels, but only THROUGH passable ground.
 *
 * A distance transform asks "how far is this cell from the region"; a geodesic
 * dilation asks "can the region walk here" — so it flows around a corner and
 * stops dead at a wall, where a distance grow would jump straight over a
 * one-pixel line. That difference is the whole reason gap closing can hand back
 * what its barrier took without also spilling out of the shape.
 *
 * Four-connected on purpose: an eight-connected step slips diagonally through
 * the corner where two wall pixels meet, which is precisely the leak the
 * barrier exists to prevent. Callers that need to undo a chamfer-built barrier
 * therefore pass a proportionally longer walk — see the call in `resolveRegion`.
 */
function geodesicGrow(mask: RegionMask, allowed: Uint8Array, steps: number): RegionMask {
  const { width, height } = mask;
  if (steps <= 0) return mask;
  let cur = Uint8Array.from(mask.data);
  let front: number[] = [];
  for (let i = 0; i < cur.length; i++) if (cur[i]) front.push(i);
  for (let step = 0; step < steps && front.length > 0; step++) {
    const next: number[] = [];
    for (const i of front) {
      const x = i % width;
      if (x > 0 && !cur[i - 1] && allowed[i - 1]) {
        cur[i - 1] = 1;
        next.push(i - 1);
      }
      if (x < width - 1 && !cur[i + 1] && allowed[i + 1]) {
        cur[i + 1] = 1;
        next.push(i + 1);
      }
      if (i >= width && !cur[i - width] && allowed[i - width]) {
        cur[i - width] = 1;
        next.push(i - width);
      }
      if (i < cur.length - width && !cur[i + width] && allowed[i + width]) {
        cur[i + width] = 1;
        next.push(i + width);
      }
    }
    front = next;
  }
  return gridToMask(cur, width, height);
}

/** Everything the mask is not (bounded by the grid). */
export function invertMask(mask: RegionMask): RegionMask {
  const { width, height, data } = mask;
  const out = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ? 0 : 1;
  return gridToMask(out, width, height);
}

/**
 * A mask as an 8-bit COVERAGE map, optionally with a soft edge.
 *
 * Feather is a distance ramp measured inward from the boundary, so a 0px
 * feather is exactly the binary mask and every larger value is the same shape
 * with a softer skirt — there is no second, "soft" code path that could draw a
 * different region than the hard one previewed a moment earlier.
 */
export function maskCoverage(mask: RegionMask, featherPx = 0): Uint8Array {
  const { width, height, data } = mask;
  const out = new Uint8Array(width * height);
  if (featherPx <= 0) {
    for (let i = 0; i < data.length; i++) out[i] = data[i] ? 255 : 0;
    return out;
  }
  // Distance from OUTSIDE the region: 0 on the boundary, rising inward.
  const outside = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) outside[i] = data[i] ? 0 : 1;
  const dist = chamfer(outside, width, height);
  for (let i = 0; i < out.length; i++) {
    if (!data[i]) continue;
    const t = Math.min(1, dist[i]! / featherPx);
    // Smoothstep — a linear ramp bands visibly against flat colour.
    out[i] = Math.round(255 * t * t * (3 - 2 * t));
  }
  return out;
}

/** How a region is asked for — the bucket's settings and the stencil's, once. */
export interface RegionOptions {
  /** Colour sensitivity, 0..1. */
  tolerance: number;
  /**
   * Gap closing, px. The line art is thickened into a BARRIER before the flood
   * runs, so paint cannot escape through an opening narrower than this, and the
   * result is thickened back afterwards so it tucks under the line instead of
   * leaving a halo where the barrier stood. Dilating only the RESULT — which is
   * what this used to do — grows the fill without ever closing anything.
   */
  closeGapPx?: number;
  /** Grow (+) or shrink (−) the finished region, px. */
  expandPx?: number;
  /**
   * Margin irregularity, 0..1 — smooth value noise on the expand distance, so
   * an offset edge wanders like a hand instead of reading as machined. Costs
   * nothing at 0: no noise is evaluated.
   */
  jitter?: number;
  /** Deterministic per document/gesture, so a preview and its commit agree. */
  jitterSeed?: number;
  /**
   * Let the region grow INTO the boundary it stopped at — but never past it,
   * into the next enclosure. This is "tuck the fill under the line": without it
   * an anti-aliased outline leaves a pale halo between the ink and the fill.
   */
  includeEdge?: boolean;
  /** Take every matching pixel, not just the connected one (the wand). */
  global?: boolean;
  /** Take the complement — paint OUTSIDE what you clicked in. */
  invert?: boolean;
}

/**
 * THE region resolver — one function behind the paint bucket, "paint inside",
 * "paint outside" and the magic wand.
 *
 * They were four floods with four different combinations of tolerance,
 * dilation and inversion, and only one of them actually closed a gap. Asking
 * the same question once means the preview a person sees before they commit is
 * computed by the same code that commits — which is the only way a preview can
 * be trusted.
 */
export function resolveRegion(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  seedX: number,
  seedY: number,
  opts: RegionOptions,
): RegionMask | null {
  const allowed = toleranceMask(pixels, width, height, seedX, seedY, opts.tolerance);
  if (!allowed) return null;
  const gap = Math.max(0, Math.round(opts.closeGapPx ?? 0));

  // The ink — everything the flood may not cross. Built once; both gap closing
  // and `includeEdge` are questions about it.
  const ink = new Uint8Array(width * height);
  for (let i = 0; i < allowed.length; i++) ink[i] = allowed[i] ? 0 : 1;

  let mask: RegionMask | null;
  if (opts.global) {
    mask = gridToMask(allowed, width, height);
  } else {
    let grid = allowed;
    /** Cells gap closing TOOK from the flood — thickened ink that was passable. */
    let taken: Uint8Array | null = null;
    if (gap > 0) {
      const barrier = growGrid(ink, width, height, gap);
      grid = new Uint8Array(width * height);
      taken = new Uint8Array(width * height);
      for (let i = 0; i < grid.length; i++) {
        if (!allowed[i]) continue;
        if (barrier[i]) taken[i] = 1;
        else grid[i] = 1;
      }
    }
    mask = floodGrid(grid, width, height, seedX, seedY);
    if (mask && mask.bounds.x1 < mask.bounds.x0 && gap > 0) {
      // The seed itself can fall inside the barrier when it sits close to a
      // line; without the un-barriered retry the bucket simply does nothing
      // near an edge, which reads as "gap closing broke the tool".
      mask = floodGrid(allowed, width, height, seedX, seedY);
    } else if (mask && taken) {
      // GIVE BACK WHAT THE BARRIER TOOK — geodesic dilation, `gap` steps.
      //
      // Three earlier versions of this step were each wrong, and how they were
      // wrong is why this one is worth the paragraph.
      //
      // `growMask(mask, gap)` grew the region in every direction, including
      // where the barrier had constrained nothing — several pixels of paint
      // outside the area on every edge of a photograph, which is the "I hover
      // and the area is right, then I draw and it overlaps" bug. Intersecting
      // that grow with the cells the barrier took removed the overshoot but
      // could not reach corners, where the barrier eats inward from two walls
      // at once and digs deeper than `gap` from the surviving core. Flooding
      // those cells reached the corners and then walked straight back out
      // through the opening the barrier had just sealed — both sides of a wall
      // are within `gap` of it, and the gap is exactly where they meet.
      // Removing the step altogether left a closed region visibly inset by the
      // gap: the mirror of the first bug.
      //
      // A GEODESIC dilation is the one that is right. It expands the core one
      // pixel at a time THROUGH passable ground, so it flows around corners and
      // recovers them exactly, and it can never cross a wall because a wall is
      // not passable. Its only leak is through the sealed opening itself, and
      // there it advances at most `gap` pixels — a short tongue rather than a
      // flood, which is the trade every paint tool makes for this feature.
      // `gap × 2`, and the factor is arithmetic rather than taste. The barrier
      // was built with a CHAMFER distance; this walk is four-connected, so it
      // measures Manhattan. In an inside corner the barrier eats `gap` from
      // each of two walls at once, leaving the corner cell 2 × gap Manhattan
      // steps from the nearest surviving core cell — so a shorter walk leaves
      // the corners bitten, and a plain square visibly gains rounded corners
      // the moment gap closing is switched on.
      //
      // Walls bound it in every direction that has one, so the extra reach
      // costs nothing on a closed shape. Where it does show is the sealed
      // opening: the tongue through a gap is up to 2 × gap long. That is the
      // trade this feature has always made, now stated rather than stumbled on.
      mask = geodesicGrow(mask, allowed, gap * 2);
    }
  }
  if (!mask) return null;

  // TUCK UNDER THE LINE. The region grows into the boundary it stopped at, and
  // is then clipped back to (itself ∪ the ink) — which is what keeps it from
  // spilling through into the next enclosure. Without the clip this would be an
  // ordinary expand and would leak wherever the line is thinner than the grow.
  if (opts.includeEdge) {
    const reach = growMask(mask, EDGE_REACH_PX);
    const out = new Uint8Array(width * height);
    for (let i = 0; i < out.length; i++) {
      out[i] = mask.data[i] || (reach.data[i] && ink[i]) ? 1 : 0;
    }
    mask = gridToMask(out, width, height);
  }

  if (opts.expandPx) {
    mask =
      opts.jitter && opts.jitter > 0
        ? growMaskJittered(mask, opts.expandPx, Math.min(1, opts.jitter), opts.jitterSeed ?? 1)
        : growMask(mask, opts.expandPx);
  }
  if (opts.invert) mask = invertMask(mask);
  return mask;
}

/**
 * How far "under the line" reaches, px.
 *
 * A constant rather than a setting: it is not a look, it is the width of the
 * anti-aliased seam a fill has to cross, and every line in every drawing has
 * roughly the same one. The clip against the ink is what makes it safe to
 * overshoot — a thin line is covered, a thick one is entered by this much and
 * no further, and neither case leaks into the next enclosure.
 */
const EDGE_REACH_PX = 3;

/**
 * How a freshly drawn selection merges with the live one — the ONE headless
 * rule shared by every lasso sub-tool (free / rectangle / polygon) and the
 * wand, so "add / subtract / intersect" is written once, not per tool.
 */
export type MaskCombine = "new" | "add" | "subtract" | "intersect";

/**
 * Boolean-combine two masks of the SAME dimensions. `new` (or a size mismatch)
 * returns `next` verbatim. Tight bounds are recomputed so tracing/lift downstream
 * stay correct. This is what lets you rectangle-select, then free-lasso-add,
 * then wand-subtract — all into one unified selection area.
 */
export function combineMasks(existing: RegionMask, next: RegionMask, mode: MaskCombine): RegionMask {
  if (mode === "new" || existing.width !== next.width || existing.height !== next.height) return next;
  const { width, height } = next;
  const data = new Uint8Array(width * height);
  const bounds = emptyBounds();
  for (let i = 0; i < data.length; i++) {
    const a = existing.data[i] === 1;
    const b = next.data[i] === 1;
    const on = mode === "add" ? a || b : mode === "subtract" ? a && !b : a && b;
    if (on) {
      data[i] = 1;
      growBounds(bounds, i % width, (i / width) | 0);
    }
  }
  return { width, height, data, bounds };
}

/** Point-in-mask test for hit-checks (out-of-range = outside). */
export function maskContains(mask: RegionMask, x: number, y: number): boolean {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= mask.width || yi >= mask.height) return false;
  return mask.data[yi * mask.width + xi] === 1;
}

/** Rasterize a closed polygon (freehand lasso) into a RegionMask. */
export function polygonMask(
  points: Array<{ x: number; y: number }>,
  width: number,
  height: number,
): RegionMask {
  const data = new Uint8Array(width * height);
  const bounds = emptyBounds();
  if (points.length >= 3) {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(height - 1, Math.ceil(maxY));
    for (let y = y0; y <= y1; y++) {
      // Even-odd scanline crossings.
      const xs: number[] = [];
      const cy = y + 0.5;
      for (let i = 0; i < points.length; i++) {
        const a = points[i]!;
        const b = points[(i + 1) % points.length]!;
        if (a.y <= cy === b.y <= cy) continue;
        xs.push(a.x + ((cy - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.round(xs[k]!));
        const xb = Math.min(width - 1, Math.round(xs[k + 1]!));
        for (let x = xa; x <= xb; x++) {
          data[y * width + x] = 1;
          growBounds(bounds, x, y);
        }
      }
    }
  }
  return { width, height, data, bounds };
}

/**
 * Trace a mask's outer contours into polygon loops (Moore-Neighbor boundary
 * tracing — pixel-exact, then simplified with Ramer–Douglas–Peucker). Feed each
 * loop to `fitSubpath` for a vector-fill path, or use raw for marching-ant
 * overlays. Returns loops in mask coordinates, largest first.
 *
 * The trace carries an explicit BACKTRACK pixel (the background cell we entered
 * the current boundary pixel from) and always scans the Moore neighborhood
 * clockwise starting just past it. That is the ONLY correct way to keep a Moore
 * trace on-contour: tracking a bare "last direction" instead (as a naive tracer
 * does) walks off thin/noisy structures and never finds its way back to the
 * start, spinning until a guard trips — which, on a real photo's jagged wand
 * mask, is tens of thousands of contour starts each burning a huge guard: an
 * effectively infinite freeze. Here every step advances the boundary and the
 * loop closes the instant it re-reaches its start pixel, so the cost is
 * O(total perimeter). `noiseFloor` drops sub-perimeter specks so a soft-edged
 * selection doesn't hand the overlay tens of thousands of invisible loops.
 */
export function traceRegion(
  mask: RegionMask,
  simplifyTolerance = 1,
  /**
   * Smallest loop worth keeping, in PIXELS OF AREA — not of perimeter.
   *
   * Area, and this matters more than it looks. Callers used to drop specks by
   * perimeter and then `.slice(n)` the longest few, and slicing a traced loop
   * set BREAKS EVEN-ODD NESTING: keep a hole whose outer contour was cut and
   * the shape fills where it should be empty; cut a hole whose outer survived
   * and it is solid where it should be a window. On clean line art there were
   * few enough loops that it never showed; on a photograph or a GIF it is why
   * "paint inside" produced a stencil with pieces both inside and outside the
   * area that was highlighted.
   *
   * An area threshold is nesting-SAFE by construction: a hole is strictly
   * smaller than the contour containing it, so anything that drops a parent has
   * already dropped its children. Callers should therefore filter here and
   * never slice the result.
   */
  minAreaPx = 4,
): Array<Array<{ x: number; y: number }>> {
  const { width, height, data, bounds } = mask;
  if (bounds.x1 < bounds.x0) return [];
  const inside = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && data[y * width + x] === 1;
  const visited = new Uint8Array(width * height);
  const loops: Array<Array<{ x: number; y: number }>> = [];
  // Moore neighborhood, clockwise from W.
  const DX = [-1, -1, 0, 1, 1, 1, 0, -1];
  const DY = [0, -1, -1, -1, 0, 1, 1, 1];
  // (dx+1)*3 + (dy+1) → direction index, for "which way is the backtrack pixel".
  const DIR = new Int8Array(9).fill(-1);
  for (let d = 0; d < 8; d++) DIR[(DX[d]! + 1) * 3 + (DY[d]! + 1)] = d;
  // A finite safety net only — correct termination is the return-to-start test.
  const guardCap = width * height + 8;

  for (let y = bounds.y0; y <= bounds.y1; y++) {
    for (let x = bounds.x0; x <= bounds.x1; x++) {
      const i = y * width + x;
      // A boundary start: inside pixel whose W neighbor is outside, not yet traced.
      if (data[i] !== 1 || visited[i] || inside(x - 1, y)) continue;
      const loop: Array<{ x: number; y: number }> = [];
      const startX = x;
      const startY = y;
      // The W neighbor is guaranteed outside (start condition) → valid backtrack.
      let bx = x - 1;
      let by = y;
      let cx = x;
      let cy = y;
      let guard = guardCap;
      while (guard-- > 0) {
        visited[cy * width + cx] = 1;
        loop.push({ x: cx, y: cy });
        // Scan clockwise from just past the backtrack; the last background cell
        // examined before the hit becomes the next step's backtrack.
        const bd = DIR[(bx - cx + 1) * 3 + (by - cy + 1)]!;
        let found = false;
        let nx = 0;
        let ny = 0;
        let nbx = bx;
        let nby = by;
        for (let k = 1; k <= 8; k++) {
          const nd = (bd + k) & 7;
          nx = cx + DX[nd]!;
          ny = cy + DY[nd]!;
          if (inside(nx, ny)) {
            found = true;
            break;
          }
          nbx = nx;
          nby = ny;
        }
        if (!found) break; // isolated pixel
        if (nx === startX && ny === startY) break; // closed the loop
        bx = nbx;
        by = nby;
        cx = nx;
        cy = ny;
      }
      if (loop.length < 3) continue;
      if (Math.abs(polygonArea(loop)) < minAreaPx) continue;
      loops.push(simplifyPolyline(loop, simplifyTolerance, true));
    }
  }
  // Largest first, by AREA — the order a caller that wants "the main piece"
  // expects, and the same quantity the threshold above is expressed in.
  loops.sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
  return loops;
}

/** Signed area of a closed polyline (shoelace). */
export function polygonArea(points: ReadonlyArray<{ x: number; y: number }>): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const q = points[(i + 1) % points.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Ramer–Douglas–Peucker simplification (iterative, closed-loop aware). */
export function simplifyPolyline(
  points: Array<{ x: number; y: number }>,
  tolerance: number,
  closed = false,
): Array<{ x: number; y: number }> {
  if (tolerance <= 0 || points.length <= 4) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const tolSq = tolerance * tolerance;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    const a = points[first]!;
    const b = points[last]!;
    let maxD = 0;
    let index = -1;
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const abLenSq = abx * abx + aby * aby || 1e-12;
    for (let i = first + 1; i < last; i++) {
      const p = points[i]!;
      const t = Math.min(1, Math.max(0, ((p.x - a.x) * abx + (p.y - a.y) * aby) / abLenSq));
      const dx = p.x - (a.x + abx * t);
      const dy = p.y - (a.y + aby * t);
      const d = dx * dx + dy * dy;
      if (d > maxD) {
        maxD = d;
        index = i;
      }
    }
    if (maxD > tolSq && index > 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  const out = points.filter((_, i) => keep[i] === 1);
  // A closed loop must keep enough points to stay an area.
  if (closed && out.length < 3) return points;
  return out;
}

/**
 * Split a drawn polyline into the runs that lie INSIDE a mask.
 *
 * This is how a vector stroke is confined, and it exists because the obvious
 * approach is wrong in a way that silently eats the stroke. A vector brush's
 * geometry is the CENTRE LINE — an open contour, with the width living in the
 * stroke style, which is what keeps a drawn line an editable line. Intersecting
 * an open contour with a region as polygons gives an empty result, so a
 * "confined" vector stroke simply vanished.
 *
 * Splitting instead preserves everything that makes it vector: each run is
 * still a centre line, still carries its own pressure widths, still takes a
 * dash, a taper, a colour and a trim afterwards. A stroke drawn across two
 * enclosures becomes two strokes, which is exactly what it looks like.
 *
 * The crossing point is BISECTED rather than snapped to the last inside
 * sample, so an edge lands on the boundary instead of up to one sample short of
 * it — visible as a ragged inset at any real brush size.
 *
 * Generic over the point type and driven by a predicate: the caller owns the
 * mapping from its own space into the mask, and nothing here needs to know
 * whether these points carry pressure, tilt or a timestamp.
 */
export function splitPolylineByMask<T extends { x: number; y: number }>(
  points: readonly T[],
  inside: (p: { x: number; y: number }) => boolean,
  /** Blend two points at `t` — how a crossing point is built. */
  lerp: (a: T, b: T, t: number) => T,
  /** Runs shorter than this are hand jitter across a boundary, not strokes. */
  minRun = 2,
): T[][] {
  const runs: T[][] = [];
  let run: T[] = [];
  let prevIn = false;

  /** Where the segment a→b crosses the boundary, to ~1/64 of its length. */
  const crossing = (a: T, b: T): T => {
    let lo = 0;
    let hi = 1;
    const aIn = inside(a);
    for (let i = 0; i < 6; i++) {
      const mid = (lo + hi) / 2;
      if (inside(lerp(a, b, mid)) === aIn) lo = mid;
      else hi = mid;
    }
    return lerp(a, b, (lo + hi) / 2);
  };

  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const isIn = inside(p);
    if (isIn && !prevIn) {
      run = [];
      // Entering: start at the boundary, not at the first sample past it.
      if (i > 0) run.push(crossing(points[i - 1]!, p));
      run.push(p);
    } else if (isIn) {
      run.push(p);
    } else if (prevIn) {
      // Leaving: finish on the boundary.
      run.push(crossing(points[i - 1]!, p));
      if (run.length >= minRun) runs.push(run);
      run = [];
    }
    prevIn = isIn;
  }
  if (prevIn && run.length >= minRun) runs.push(run);
  return runs;
}
