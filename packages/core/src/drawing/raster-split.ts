/**
 * SEPARATE A PAINT LAYER — what the pieces of a drawing actually are.
 *
 * The vector side has had this for a while: artwork that is several shapes
 * wearing one layer splits into a comp with one clip per shape
 * (`promotePathClip`). Pixels had no equivalent, because a bitmap has no list
 * of shapes to read — so the question "what are the pieces of this drawing"
 * had no answer, and every attempt to have one instead GUESSED, at draw time,
 * from how far apart two marks landed.
 *
 * There is a real answer and it is in the pixels: the CONNECTED REGIONS of the
 * layer's own alpha. Ink that touches is one piece. Ink that does not is
 * another. Nobody has to be told the rule, because it is what the drawing looks
 * like — and it is decided at the moment somebody asks, on the finished
 * artwork, rather than stroke by stroke on a guess about intent.
 *
 * ## Why it is worth doing at all
 *
 * Each piece comes back cropped to its own ink, so separating a drawing makes
 * it SMALLER: five marks on a 1080×1920 canvas stop being five full canvases
 * and become five boxes the size of the marks. And a piece is an ordinary
 * layer, so it can be moved, scaled, keyframed, effected and animated on its
 * own — which is the whole point of asking.
 *
 * ## The gaps this deliberately leaves
 *
 * Two strokes that cross are ONE region, and that is correct: they are one
 * shape now, and anything else would need to know which pixel came from which
 * gesture, which the bitmap does not record. Ink thinner than the bridge
 * between two marks joins them. Both are what a person sees when they look at
 * the drawing, which is the only standard that matters here.
 */

import type { PixelBounds } from "./canvas-bounds";

/** One connected piece of a layer's ink. */
export interface RasterRegion {
  /** Tight bounds in surface pixels; `x1`/`y1` exclusive. */
  bounds: PixelBounds;
  /** 1 byte per pixel over the WHOLE surface; 1 = this region. */
  mask: Uint8Array;
  /** Opaque-ish pixels in the region — the ordering and pruning key. */
  area: number;
}

/**
 * Alpha at or below this is not ink.
 *
 * Not zero: a soft brush leaves a long tail of near-transparent pixels, and
 * counting them as ink joins every mark on the layer into one region through a
 * film nobody can see. Eight is under half a percent — invisible, and enough to
 * keep two marks that merely pass near each other apart.
 */
export const INK_ALPHA = 8;

/**
 * The smallest region worth its own layer, in pixels.
 *
 * A brush edge sheds specks, and a separate layer per speck is a layer list
 * nobody can read. Below this a region is left in the largest piece it is
 * nearest to — see `separateInkRegions`, which never throws ink away.
 */
export const MIN_REGION_PX = 24;

/**
 * Label the connected regions of an RGBA buffer, largest first.
 *
 * Iterative scanline flood (no recursion — a full-canvas region is millions of
 * pixels deep and every recursive version of this eventually meets a stack it
 * cannot grow), 8-connected so a diagonal hairline stays one piece.
 */
export function labelRegions(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  minAlpha = INK_ALPHA,
): RasterRegion[] {
  const n = width * height;
  const seen = new Uint8Array(n);
  const out: RasterRegion[] = [];
  const stack: number[] = [];

  for (let start = 0; start < n; start++) {
    if (seen[start] || pixels[start * 4 + 3]! <= minAlpha) continue;
    const mask = new Uint8Array(n);
    let area = 0;
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const i = stack.pop()!;
      const x = i % width;
      const y = (i / width) | 0;
      mask[i] = 1;
      area++;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const j = ny * width + nx;
          if (seen[j] || pixels[j * 4 + 3]! <= minAlpha) continue;
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    out.push({ mask, area, bounds: { x0, y0, x1: x1 + 1, y1: y1 + 1 } });
  }
  // Largest first: the biggest piece is the one a person thinks of as "the
  // drawing", and it is what specks get folded back into.
  return out.sort((a, b) => b.area - a.area);
}

/**
 * The regions a Separate should actually produce: the substantial ones, with
 * every speck folded into the nearest of them.
 *
 * NOTHING IS EVER DISCARDED. A split that quietly loses the dot on an `i`
 * because it was under the size floor is worse than one that produces a few
 * more layers than you wanted, and a person can merge; they cannot un-lose.
 */
export function separateInkRegions(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  minArea = MIN_REGION_PX,
  minAlpha = INK_ALPHA,
): RasterRegion[] {
  const all = labelRegions(pixels, width, height, minAlpha);
  if (all.length <= 1) return all;
  const keep = all.filter((r) => r.area >= minArea);
  if (keep.length === 0) return [all[0]!];
  const specks = all.filter((r) => r.area < minArea);
  for (const speck of specks) {
    const host = nearestRegion(keep, speck);
    for (let i = 0; i < speck.mask.length; i++) if (speck.mask[i]) host.mask[i] = 1;
    host.area += speck.area;
    host.bounds = {
      x0: Math.min(host.bounds.x0, speck.bounds.x0),
      y0: Math.min(host.bounds.y0, speck.bounds.y0),
      x1: Math.max(host.bounds.x1, speck.bounds.x1),
      y1: Math.max(host.bounds.y1, speck.bounds.y1),
    };
  }
  return keep;
}

/** The kept region whose box is nearest a speck's (0 when they overlap). */
function nearestRegion(keep: RasterRegion[], speck: RasterRegion): RasterRegion {
  let best = keep[0]!;
  let bestGap = Infinity;
  for (const r of keep) {
    const dx = Math.max(0, Math.max(r.bounds.x0 - speck.bounds.x1, speck.bounds.x0 - r.bounds.x1));
    const dy = Math.max(0, Math.max(r.bounds.y0 - speck.bounds.y1, speck.bounds.y0 - r.bounds.y1));
    const gap = dx * dx + dy * dy;
    if (gap < bestGap) {
      bestGap = gap;
      best = r;
    }
  }
  return best;
}
