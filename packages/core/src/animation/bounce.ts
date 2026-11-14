import type { Easing } from "../schema";

/**
 * A BOUNCE, AS KEYS.
 *
 * A bounce is not an easing: every easing here is one cubic bezier (exports
 * write them as-is, `splitEasing` cuts them exactly), and no single bezier
 * lands, rebounds and lands again. It is a sequence of free falls — and a free
 * fall IS a bezier: position under gravity is t², which is exactly
 * cubic-bezier(1/3, 0, 2/3, 1/3); the rise is its mirror. So a bounce expands
 * into ordinary keys, one per impact and one per apex, each segment an exact
 * parabola, and plays, edits and exports like any other keys.
 *
 * Heights decay by `decay` per rebound; times follow from the heights (a fall
 * from h takes √h), scaled so the last impact lands on the segment's end.
 */

export interface BounceOptions {
  /** Rebounds before it settles (≥ 1). */
  count?: number;
  /** Each rebound's height as a fraction of the one before (0–1). */
  decay?: number;
}

export interface BounceKey {
  at: number;
  value: number;
  /** The segment leaving this key. */
  easing: Easing;
}

/** Gravity: accelerating into the floor. */
export const FALL: Easing = { kind: "bezier", values: [1 / 3, 0, 2 / 3, 1 / 3] };
/** Leaving the floor, slowing to the apex. */
export const RISE: Easing = { kind: "bezier", values: [1 / 3, 2 / 3, 2 / 3, 1] };

/**
 * Keys for a drop from (t0, v0) that lands on v1 at t1 and bounces in between.
 * Returns the start key (re-eased as a fall) and every key after it up to, but
 * not including, the landing at t1 — the caller's next key is that landing.
 */
export function bounceKeys(t0: number, v0: number, t1: number, v1: number, opts: BounceOptions = {}): BounceKey[] {
  const count = Math.max(1, Math.min(12, Math.round(opts.count ?? 3)));
  const decay = Math.max(0.01, Math.min(0.95, opts.decay ?? 0.35));
  const span = t1 - t0;
  if (!(span > 0) || v0 === v1) return [{ at: t0, value: v0, easing: FALL }];
  // Fall times ∝ √height; a rebound to h is a rise and a fall, 2√h.
  const heights = Array.from({ length: count }, (_, i) => decay ** (i + 1));
  const unit = 1 + heights.reduce((sum, h) => sum + 2 * Math.sqrt(h), 0);
  const scale = span / unit;
  const keys: BounceKey[] = [{ at: t0, value: v0, easing: FALL }];
  let t = t0 + scale;
  for (const h of heights) {
    keys.push({ at: t, value: v1, easing: RISE });
    t += scale * Math.sqrt(h);
    keys.push({ at: t, value: v1 + (v0 - v1) * h, easing: FALL });
    t += scale * Math.sqrt(h);
  }
  return keys;
}
