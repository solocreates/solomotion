/**
 * THE BOARD PICTURE'S MIP LADDER — which resolution of a retained comp picture
 * to draw, which to make, and which to let go. Headless; the stage's
 * `render/board-pictures.ts` owns the canvases.
 *
 * A comp you are not working in is drawn as a picture at a power-of-two LEVEL
 * (device px per comp unit). A 2D canvas has no mipmaps: drawing a 4096 px
 * picture into a 300 px box resamples all 16 M of its pixels, every frame. So
 * after one zoom in and back out, every comp on the board was a full-size
 * downsample per pan frame, forever — the board never got smooth again.
 *
 * The answer is the one GPUs give textures: keep a LADDER of levels, draw the
 * smallest one that still covers the zoom, derive a coarser rung by halving
 * the one above it (once, not per frame), and let a rung nobody has drawn for
 * a while go. A comp nobody looks at at all — one on a page you left — keeps a
 * single thumbnail rung.
 */

/** The coarsest level a picture is ever made at. */
export const BOARD_MIN_LEVEL = 1 / 64;
/** A first picture's level is this fraction of the zoom's — see `boardFirstLevel`. */
const FIRST_LEVEL_FRACTION = 1 / 4;
/** …but never so coarse its longest side drops under this many device px. */
const FIRST_MIN_SIDE = 320;
/** A rung not drawn for this long is released (the timer that does it is the stage's). */
export const BOARD_RUNG_IDLE_MS = 4000;
/** What an unwatched comp keeps: one rung whose longest side is at most this. */
export const BOARD_PARKED_SIDE = 512;
/** Longest side any picture may have, whatever the budget. */
const MAX_SIDE_CEILING = 4096;
const MAX_SIDE_FLOOR = 1024;
/** How many full-size pictures the budget must hold at once — the side follows from it. */
const PICTURES_AT_MAX = 6;

const pow2Ceil = (x: number) => 2 ** Math.ceil(Math.log2(x) - 1e-9);
const pow2Floor = (x: number) => 2 ** Math.floor(Math.log2(x) + 1e-9);

/**
 * The longest side a picture may have under `budgetBytes`: a power of two such
 * that `PICTURES_AT_MAX` of them fit (4 bytes a pixel), between 1024 and 4096.
 * A weak machine's smaller ceiling means softer deep zooms of the comps you
 * are NOT in — never a picture that crowds the GPU out of memory.
 */
export function boardMaxSide(budgetBytes: number): number {
  const side = Math.sqrt(Math.max(0, budgetBytes) / (4 * PICTURES_AT_MAX));
  return Math.max(MAX_SIDE_FLOOR, Math.min(MAX_SIDE_CEILING, pow2Floor(Math.max(1, side))));
}

/**
 * The power-of-two level for a comp drawn at `devicePxPerUnit`, clamped to the
 * largest that keeps its longest side within `maxSide` — null only for a
 * degenerate scale. A comp you are not in is a picture at any zoom, soft past
 * its cap: rendering the neighbours' effect stacks live at deep zoom cost
 * seconds a frame for comps nobody was working in.
 */
export function boardLevel(devicePxPerUnit: number, width: number, height: number, maxSide: number): number | null {
  if (!(devicePxPerUnit > 0) || !Number.isFinite(devicePxPerUnit)) return null;
  const level = Math.max(BOARD_MIN_LEVEL, pow2Ceil(devicePxPerUnit));
  return Math.max(BOARD_MIN_LEVEL, Math.min(level, capLevel(width, height, maxSide)));
}

/** The largest level whose longest side fits `maxSide` (not rounded: the cap is exact). */
function capLevel(width: number, height: number, maxSide: number): number {
  return maxSide / Math.max(1, width, height);
}

/**
 * The level a comp's FIRST picture renders at: a quarter of what the zoom
 * wants, kept above `FIRST_MIN_SIDE` and never above `level` itself. Pixel
 * effects cost per pixel, so a coarse first look is a fraction of the bill.
 */
export function boardFirstLevel(level: number, width: number, height: number): number {
  const floor = FIRST_MIN_SIDE / Math.max(1, width, height);
  return Math.min(level, Math.max(BOARD_MIN_LEVEL, level * FIRST_LEVEL_FRACTION, floor));
}

/**
 * Which rung to draw for `want`: the smallest one that still covers it, else
 * the sharpest there is (soft, until a sharper one is made). `levels` in any
 * order; returns an index, or -1 when there are none.
 */
export function pickRung(levels: readonly number[], want: number): number {
  let best = -1;
  let sharpest = -1;
  for (let i = 0; i < levels.length; i++) {
    const l = levels[i]!;
    if (sharpest < 0 || l > levels[sharpest]!) sharpest = i;
    if (l >= want - 1e-9 && (best < 0 || l < levels[best]!)) best = i;
  }
  return best >= 0 ? best : sharpest;
}

/**
 * The rung worth DERIVING when drawing `have` for `want`: the coarsest halving
 * of `have` that still covers `want`, or null when `have` is already within a
 * factor of two (drawing it costs at most four source pixels per screen pixel).
 */
export function coarserRung(have: number, want: number): number | null {
  if (!(want > 0) || have <= want * 2 + 1e-9) return null;
  return Math.max(BOARD_MIN_LEVEL, pow2Ceil(want));
}

/** One rung, as the trim sees it. */
export interface RungUse {
  level: number;
  lastDrawn: number;
}

/**
 * What the trim keeps of one picture's ladder at `nowMs`: every rung drawn
 * within `BOARD_RUNG_IDLE_MS`, and — when none was — a single PARKED rung, the
 * coarsest whose side stays within `BOARD_PARKED_SIDE` (derived from the
 * coarsest rung it has when it has none that small). `drop` are indices.
 */
export function trimRungs(
  rungs: readonly RungUse[],
  nowMs: number,
  width: number,
  height: number,
): { drop: number[]; park: number | null } {
  const live = rungs.map((r) => nowMs - r.lastDrawn < BOARD_RUNG_IDLE_MS);
  if (live.some(Boolean)) return { drop: rungs.flatMap((_, i) => (live[i] ? [] : [i])), park: null };
  if (rungs.length === 0) return { drop: [], park: null };
  const parked = parkedLevel(width, height);
  // The rung to keep: the coarsest at or under the parked level, else the coarsest of all (derived down).
  let keep = -1;
  for (let i = 0; i < rungs.length; i++) {
    if (keep < 0 || rungs[i]!.level < rungs[keep]!.level) keep = i;
  }
  const keepLevel = rungs[keep]!.level;
  return {
    drop: rungs.flatMap((_, i) => (i === keep ? [] : [i])),
    park: keepLevel > parked + 1e-9 ? parked : null,
  };
}

/** The level whose longest side is the parked size (a power of two at or under it). */
export function parkedLevel(width: number, height: number): number {
  return Math.max(BOARD_MIN_LEVEL, pow2Floor(BOARD_PARKED_SIDE / Math.max(1, width, height)));
}
