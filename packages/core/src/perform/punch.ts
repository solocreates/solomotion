import { createId } from "../ids";
import { sameKeyframeRange } from "../animation/keyframes";
import type { Easing, Keyframe, KeyframeRange, KeyframeTrack, KeyframeValue } from "../schema";

/**
 * PUNCH-IN — a take REPLACES its own range on one channel and nothing else.
 *
 * Keys strictly outside `[fromMs, toMs]` are kept exactly (same ids, times,
 * values, easings): a second pass over bar 3 never disturbs bars 1, 2 and 4.
 * Keys inside the range are dropped and the take's keys go in. The curve
 * between the last key before the range and the take's first key bridges to
 * the performance — the same thing every DAW and After Effects' Motion Sketch
 * do at a punch point; a gesture starts from what is on screen, so the bridge
 * is short and flat in practice.
 *
 * A channel that had NO keys (its base value showed) gains a guard key one
 * frame before the take holding that base value, so the take changes nothing
 * before it starts. After the take the last performed value holds — the hand
 * let go there.
 *
 * Pure over the tracks array; mutates (call inside a document update).
 */

export interface PunchKey {
  t: number;
  v: KeyframeValue;
  easing?: Easing;
}

export interface PunchOptions {
  range?: KeyframeRange | null;
  /** Keys this close to the edges count as inside (ms). */
  epsMs?: number;
  /** The guard's distance before the take (a frame). 0 = no guard. */
  guardMs?: number;
  /** What the channel showed before it had keys (the guard's value). */
  baseValue?: KeyframeValue;
}

export interface PunchResult {
  removed: number;
  added: number;
}

const LINEAR: Easing = { kind: "linear" };

export function punchIn(
  tracks: KeyframeTrack[],
  property: string,
  fromMs: number,
  toMs: number,
  keys: readonly PunchKey[],
  opts: PunchOptions = {},
): PunchResult {
  const range = opts.range ?? null;
  const eps = opts.epsMs ?? 0.5;
  const lo = Math.min(fromMs, toMs) - eps;
  const hi = Math.max(fromMs, toMs) + eps;
  let track = tracks.find((t) => t.property === property && sameKeyframeRange(t.range, range));
  const fresh = !track || track.keys.length === 0;
  if (!keys.length && fresh) return { removed: 0, added: 0 };
  if (!track) {
    track = { id: createId("ktrack"), property, range, keys: [] };
    tracks.push(track);
  }
  const before = track.keys.length;
  track.keys = track.keys.filter((k) => k.timeMs < lo || k.timeMs > hi);
  const removed = before - track.keys.length;
  let added = 0;
  const guard = opts.guardMs ?? 0;
  if (fresh && guard > 0 && opts.baseValue !== undefined && keys.length) {
    const first = Math.min(...keys.map((k) => k.t));
    track.keys.push({ id: createId("key"), timeMs: first - guard, value: opts.baseValue, easing: LINEAR });
    added++;
  }
  for (const k of keys) {
    const key: Keyframe = { id: createId("key"), timeMs: k.t, value: k.v, easing: k.easing ?? LINEAR };
    track.keys.push(key);
    added++;
  }
  track.keys.sort((a, b) => a.timeMs - b.timeMs);
  if (!track.keys.length) tracks.splice(tracks.indexOf(track), 1);
  return { removed, added };
}
