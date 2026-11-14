/**
 * RANGE MATH — what a value bar's dialect means for the VALUE, not the paint.
 *
 * Most dialects are paint only: a trail and a meter move freely and look
 * different. Two of them are instruments with detents, and the detent is the
 * point of drawing them:
 *
 *  • RULER steps from tick to tick. It snaps to every minor tick and pulls
 *    harder near a major one, the way a ruler on a desk is read. Holding
 *    Shift frees it to sit between ticks. Arrow keys move one minor tick.
 *  • BLOCKS steps one block at a time. Holding Shift moves freely, so a block
 *    can fill partly (37% shows a part-filled fourth block).
 *
 * Pure functions, shared by the studio's Range and the site's, so a ruler
 * means the same thing wherever it is drawn.
 */

export interface RulerScale {
  /** Major tick spacing, in the value's units. */
  major: number;
  /** Minor tick spacing; a whole fraction of `major`. */
  minor: number;
  /** Where ticks are counted from (the first major at or below `min`). */
  origin: number;
}

const EPS = 1e-9;
const roundTo = (v: number, d = 10) => Number(v.toFixed(d));

/** A "nice" step near `raw`: 1, 2 or 5 times a power of ten. */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  const nice = m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10;
  return roundTo(nice * p);
}

/**
 * Ticks for a span. About `majors` major ticks across it, each split into
 * minors that stay readable: a 1-based major splits in 5 (0.2 each), a 2 in
 * 4 (0.5), a 5 in 5 (1). Angles get their own: 360° reads in 45° majors and
 * 15° minors, because nobody thinks of an angle in fifths.
 */
export function rulerScale(min: number, max: number, opts: { majors?: number; unit?: string } = {}): RulerScale {
  const span = Math.abs(max - min);
  if (!(span > 0)) return { major: 1, minor: 1, origin: min };
  if (opts.unit === "°" && span >= 90) {
    const major = span >= 360 ? 45 : 15;
    const minor = major === 45 ? 15 : 5;
    return { major, minor, origin: Math.floor(min / major) * major };
  }
  const major = niceStep(span / (opts.majors ?? 8));
  const lead = roundTo(major / Math.pow(10, Math.floor(Math.log10(major))));
  const minor = roundTo(major / (lead === 2 ? 4 : 5));
  return { major, minor, origin: Math.floor(min / major + EPS) * major };
}

const nearestOn = (v: number, step: number, origin: number) => origin + Math.round((v - origin) / step) * step;

/**
 * Where a ruler lets a value rest. Every minor tick is a detent; within 60% of
 * a minor step of a MAJOR tick, the major wins (the "harder" pull). `free`
 * (Shift) returns the value untouched.
 */
export function snapRuler(v: number, s: RulerScale, opts: { free?: boolean; min?: number; max?: number } = {}): number {
  if (opts.free) return clampOpt(v, opts);
  const major = nearestOn(v, s.major, s.origin);
  if (Math.abs(v - major) <= s.minor * 0.6) return clampOpt(roundTo(major), opts);
  return clampOpt(roundTo(nearestOn(v, s.minor, s.origin)), opts);
}

/** One arrow press: the next minor tick in `dir`, never a fraction of one. */
export function stepRuler(v: number, dir: 1 | -1, s: RulerScale, opts: { min?: number; max?: number } = {}): number {
  const k = (v - s.origin) / s.minor;
  const onTick = Math.abs(k - Math.round(k)) < 1e-6;
  const next = dir > 0 ? (onTick ? Math.round(k) + 1 : Math.ceil(k)) : onTick ? Math.round(k) - 1 : Math.floor(k);
  return clampOpt(roundTo(s.origin + next * s.minor), opts);
}

/** The tick spacing as fractions of the bar, for drawing (CSS percentages). */
export function rulerPaint(min: number, max: number, s: RulerScale): { minorPct: number; majorPct: number; offsetPct: number } {
  const span = max - min || 1;
  const offset = ((((s.origin - min) % s.major) + s.major) % s.major) / span;
  return { minorPct: (s.minor / span) * 100, majorPct: (s.major / span) * 100, offsetPct: offset * 100 };
}

function clampOpt(v: number, o: { min?: number; max?: number }): number {
  let x = v;
  if (o.min !== undefined && x < o.min) x = o.min;
  if (o.max !== undefined && x > o.max) x = o.max;
  return x;
}

// ── Blocks and steps ────────────────────────────────────────────────────────

/** How many blocks a blocks/steps bar draws. */
export const BLOCK_COUNT = 10;

/**
 * Each block's fill, 0..1, for a bar at `fraction`. Every block fills by
 * exactly its share, so the last one lit is partial: 0.37 → three full
 * blocks, the fourth at 70%, the rest empty.
 */
export function blockFills(fraction: number, count = BLOCK_COUNT): number[] {
  const f = Math.min(1, Math.max(0, fraction)) * count;
  return Array.from({ length: count }, (_, i) => Math.min(1, Math.max(0, roundTo(f - i, 6))));
}

/**
 * Steps shows the same value by OPACITY: blocks before the value are lit, the
 * block the value sits in is lit by its share, so it reads as a level meter
 * rather than a progress bar.
 */
export function stepOpacities(fraction: number, count = BLOCK_COUNT): number[] {
  return blockFills(fraction, count).map((x) => (x >= 1 ? 1 : x > 0 ? 0.25 + 0.75 * x : 0));
}

/** Blocks rest on whole blocks; `free` (Shift) lets one fill partly. */
export function snapBlocks(fraction: number, count = BLOCK_COUNT, free = false): number {
  const f = Math.min(1, Math.max(0, fraction));
  return free ? f : Math.round(f * count) / count;
}

/** One arrow press on a blocks bar: the next whole block. */
export function stepBlocks(fraction: number, dir: 1 | -1, count = BLOCK_COUNT): number {
  const k = fraction * count;
  const onBlock = Math.abs(k - Math.round(k)) < 1e-6;
  const next = dir > 0 ? (onBlock ? Math.round(k) + 1 : Math.ceil(k)) : onBlock ? Math.round(k) - 1 : Math.floor(k);
  return Math.min(1, Math.max(0, next / count));
}

// ── The dialect as behaviour ────────────────────────────────────────────────

export type RangeDetents = "free" | "ruler" | "blocks";

/** Which dialects carry detents. Everything else moves freely. */
export function detentsOf(dialect: string | undefined): RangeDetents {
  if (dialect === "ruler") return "ruler";
  if (dialect === "blocks" || dialect === "steps") return "blocks";
  return "free";
}

/**
 * Where a value bar at `dialect` lets `v` rest, and where one arrow press
 * takes it. The one entry point a Range calls; `free` is Shift.
 */
export function rangeDetent(
  dialect: string | undefined,
  v: number,
  min: number,
  max: number,
  opts: { free?: boolean; unit?: string } = {},
): number {
  const kind = detentsOf(dialect);
  if (kind === "free" || opts.free || !(max > min)) return v;
  if (kind === "ruler") return snapRuler(v, rulerScale(min, max, { unit: opts.unit }), { min, max });
  const f = snapBlocks((v - min) / (max - min));
  return roundTo(min + f * (max - min));
}

export function rangeStep(
  dialect: string | undefined,
  v: number,
  dir: 1 | -1,
  min: number,
  max: number,
  opts: { unit?: string } = {},
): number | null {
  const kind = detentsOf(dialect);
  if (kind === "free" || !(max > min)) return null;
  if (kind === "ruler") return stepRuler(v, dir, rulerScale(min, max, { unit: opts.unit }), { min, max });
  return roundTo(min + stepBlocks((v - min) / (max - min), dir) * (max - min));
}
