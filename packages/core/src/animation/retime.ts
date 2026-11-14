import { sampleKeyframeTrack, setKeyframe } from "./keyframes";
import { clipPlaybackOf } from "../clip-registry";
import type { Clip, Easing, Keyframe, KeyframeTrack } from "../schema";

/**
 * RETIME — speed, ramps and freezes, with no new concept anywhere.
 *
 * A clip's speed was one number on `playback`. Everything a person actually
 * wants to do with it — ramp into slow motion, hold on a frame, drift back up
 * to full rate over eight frames — is that number CHANGING OVER TIME, which is
 * what a keyframe is. So `playback.speed` is now an ordinary animatable
 * property, and every piece of machinery already built for animatable
 * properties comes along for free: the diamond, the curve editor, the dope
 * sheet, `E` for easing, record mode, expressions, drivers, the node board,
 * copy/paste of keyframes, and the keyframe row on the clip itself.
 *
 * The one thing that had to be written is the INTEGRAL, and it is the whole
 * file. Speed is a rate, so where a clip sits in its source is the area under
 * the speed curve up to that instant:
 *
 *     source(t) = ∫₀ᵗ speed(u) du
 *
 * With a constant speed that is `t × speed`, which is exactly what the code
 * did before — so a clip with no speed keys takes the same path it always did,
 * to the millisecond, and nothing about existing documents changes.
 *
 * Three facts fall out of the integral rather than being features:
 *
 *  · a FREEZE FRAME is speed 0. The area stops growing, so the source stops
 *    advancing, so `SourcePhase.held` lights up — and every surface that
 *    already shades a hold (the clip's run-out shading, the poster strip, the
 *    cache bars) shades a freeze too, with no new branch anywhere. The doc
 *    comment on `held` anticipated exactly this.
 *  · a RAMP is the easing between two speed keys. "How fast does the speed
 *    change" is the easing curve, editable with the same editor and the same
 *    keystroke as any other easing, and "over how long" is the gap between the
 *    two keys — which you drag on the clip like any other keyframe.
 *  · REVERSE, at least locally, is a negative speed. The area decreases and
 *    the source runs backwards. (`playback.reverse` remains the whole-clip
 *    switch; it is the cheaper answer for the common case.)
 *
 * WHY AN INTEGRAL AND NOT A TIME-REMAP TRACK. After Effects keys the source
 * TIME, which is exact and needs no integration — but it is also the thing
 * every AE user finds unreadable, because the value you key is not the value
 * you are thinking about. You think "40%", and you are made to compute a
 * timestamp. Keying the rate is what the person means; the integral is the
 * machine's problem, and the machine can do it.
 */

import { MAX_SPEED, MIN_SPEED, SPEED_PROPERTY } from "./speed";
export { MAX_SPEED, MIN_SPEED, SPEED_PROPERTY };

/**
 * A clip's speed curve, integrated once into a cumulative table.
 *
 * Sampled rather than solved because a segment's easing is an arbitrary cubic
 * bezier, whose integral has no useful closed form. The sampling is FIXED and
 * deterministic — the same table in the renderer, the exporter, a worker and a
 * test — which is the property that actually matters here; a millisecond of
 * numerical drift in a creative retime is invisible, while two surfaces
 * disagreeing about where the footage is would not be.
 */
export interface SpeedCurve {
  /** Sample times in clip-local ms, ascending, from 0 to the clip's duration. */
  readonly t: Float64Array;
  /** Source ms consumed by `t[i]` — the running integral. */
  readonly s: Float64Array;
  /** The rate at each sample, so `speedAt` needs no second pass. */
  readonly v: Float64Array;
}

/** One sample per frame at 30fps: fine enough for any easing anyone can see. */
const SAMPLE_MS = 33;
/** Floor and ceiling on samples per segment — a guard, not a tuning knob. */
const MIN_SAMPLES = 8;
const MAX_SAMPLES = 512;

/**
 * Build the cumulative table for one speed track over `durationMs`.
 *
 * Trapezoidal, which is exact for a linear ramp and within a rounding error of
 * anything smooth at this sample density. Before the first key and after the
 * last, a keyframe track HOLDS — so those stretches are constant-rate and are
 * integrated exactly rather than sampled.
 */
export function buildSpeedCurve(track: KeyframeTrack, durationMs: number): SpeedCurve {
  const keys = [...track.keys].sort((a, b) => a.timeMs - b.timeMs);
  const bounds: number[] = [0];
  for (const k of keys) {
    const t = Math.min(Math.max(k.timeMs, 0), durationMs);
    if (t > bounds[bounds.length - 1]! + 0.001) bounds.push(t);
  }
  if (durationMs > bounds[bounds.length - 1]! + 0.001) bounds.push(durationMs);

  const times: number[] = [];
  const rates: number[] = [];
  const push = (t: number) => {
    const v = rateOf(track, t);
    times.push(t);
    rates.push(v);
  };

  push(bounds[0]!);
  for (let i = 1; i < bounds.length; i++) {
    const a = bounds[i - 1]!;
    const b = bounds[i]!;
    const span = b - a;
    const steps = Math.min(MAX_SAMPLES, Math.max(MIN_SAMPLES, Math.ceil(span / SAMPLE_MS)));
    for (let j = 1; j <= steps; j++) push(a + (span * j) / steps);
  }

  const t = new Float64Array(times);
  const v = new Float64Array(rates);
  const s = new Float64Array(times.length);
  for (let i = 1; i < t.length; i++) {
    // Trapezoid: the average of the two rates over the step.
    s[i] = s[i - 1]! + ((v[i - 1]! + v[i]!) / 2) * (t[i]! - t[i - 1]!);
  }
  return { t, s, v };
}

function rateOf(track: KeyframeTrack, timeMs: number): number {
  const sampled = sampleKeyframeTrack(track, timeMs);
  const n = typeof sampled === "number" ? sampled : 1;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, n));
}

/**
 * The curve for a clip, or null when its speed is a plain number.
 *
 * Null is the fast path and the common one: a clip with no speed keys costs
 * nothing, and every caller reads it as "multiply by `playback.speed`", which
 * is what it did before this file existed.
 *
 * Memoised on the clip OBJECT. Immer hands out a new clip on every edit, so
 * the cache turns over exactly when the answer changes — the same trick the
 * caption focus cache uses, and the reason this can be called per frame.
 */
export function clipSpeedCurve(clip: Clip): SpeedCurve | null {
  const track = clip.keyframes.find((k) => k.property === SPEED_PROPERTY);
  if (!track || track.keys.length === 0) return null;
  let curve = curveCache.get(clip);
  if (!curve) curveCache.set(clip, (curve = buildSpeedCurve(track, clip.durationMs)));
  return curve;
}

const curveCache = new WeakMap<Clip, SpeedCurve>();

/** Source ms consumed by clip-local `localMs` — the integral, interpolated. */
export function retimedSourceMs(curve: SpeedCurve, localMs: number): number {
  const { t, s, v } = curve;
  const last = t.length - 1;
  if (localMs <= t[0]!) return s[0]! + (localMs - t[0]!) * v[0]!;
  // Past the table, the final rate holds — a clip can be asked for a time
  // beyond its own duration (a transition's overlap, a parent's loop).
  if (localMs >= t[last]!) return s[last]! + (localMs - t[last]!) * v[last]!;
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid]! <= localMs) lo = mid;
    else hi = mid;
  }
  const span = t[hi]! - t[lo]!;
  if (span <= 0) return s[lo]!;
  const u = (localMs - t[lo]!) / span;
  // Integrate the trapezoid partially: the rate is linear across the step.
  const rateHere = v[lo]! + (v[hi]! - v[lo]!) * u;
  return s[lo]! + ((v[lo]! + rateHere) / 2) * (localMs - t[lo]!);
}

/**
 * The INVERSE: at what clip-local time has the clip consumed `sourceMs`?
 *
 * Many-valued in general (a curve that dips negative visits a source time more
 * than once), so this answers the FIRST crossing, which is the editing-useful
 * one — "where does this clip run out of footage" has exactly one sensible
 * answer and it is the earliest. Returns null when the curve never gets there.
 */
export function wallTimeForSourceMs(curve: SpeedCurve, sourceMs: number): number | null {
  const { t, s, v } = curve;
  const last = t.length - 1;
  if (sourceMs <= s[0]!) return t[0]!;
  for (let i = 1; i <= last; i++) {
    if (s[i]! >= sourceMs) {
      const span = s[i]! - s[i - 1]!;
      if (span <= 0) return t[i - 1]!;
      return t[i - 1]! + ((sourceMs - s[i - 1]!) / span) * (t[i]! - t[i - 1]!);
    }
  }
  // Past the table the final rate holds — extrapolate, unless it is a standstill.
  const tail = v[last]!;
  if (tail <= 0) return null;
  return t[last]! + (sourceMs - s[last]!) / tail;
}

/**
 * The rate the curve is running at, at an instant.
 *
 * Separate from `speedAt` because the TRANSPORT needs it without a clip in
 * hand: `sourcePhaseAt` is handed a curve, and "is the source advancing right
 * now" is the question that makes a freeze a real freeze rather than a very
 * slow crawl — the video element is parked instead of rolled.
 */
export function curveRateAt(curve: SpeedCurve, localMs: number): number {
  const { t, v } = curve;
  const last = t.length - 1;
  if (localMs <= t[0]!) return v[0]!;
  if (localMs >= t[last]!) return v[last]!;
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid]! <= localMs) lo = mid;
    else hi = mid;
  }
  const span = t[hi]! - t[lo]!;
  return span <= 0 ? v[lo]! : v[lo]! + (v[hi]! - v[lo]!) * ((localMs - t[lo]!) / span);
}

/** The rate at an instant — what the clip PRINTS on itself ("1.5×"). */
export function speedAt(clip: Clip, localMs: number): number {
  const curve = clipSpeedCurve(clip);
  return curve ? curveRateAt(curve, localMs) : clipPlaybackOf(clip)?.speed ?? 1;
}

/**
 * How much SOURCE a clip consumes over its whole span. The number "Fit to
 * source" solves against, and what tells a play-once clip whether it runs out.
 */
export function clipSourceSpanMs(clip: Clip): number {
  const curve = clipSpeedCurve(clip);
  if (!curve) return clip.durationMs * (clipPlaybackOf(clip)?.speed ?? 1);
  return retimedSourceMs(curve, clip.durationMs);
}

// ── The list the Speed panel and the clip's own band read ────────────────────

/**
 * A stretch of the clip between two speed decisions.
 *
 * DERIVED from the keys, never stored — which is the whole reason speed keys
 * were the right shape. A segment list stored beside the keys would be a second
 * record of one fact, and the first drag of a keyframe in the curve editor
 * would put the two out of agreement. Everything the panel shows and edits is
 * a projection of `clip.keyframes`.
 */
export interface SpeedSegment {
  /**
   * WHAT THIS STRETCH IS, named rather than inferred.
   *
   * A speed curve is a sequence of HOLDS connected by RAMPS, and that is the
   * whole mental model — a hold is a thing (this bit runs at 40%), a ramp is
   * the transition between two of them. It used to be a `flat` boolean, and
   * the difference shows up in every reader: a list that alternates two row
   * shapes with no name for either is a list nobody can scan.
   */
  readonly kind: "hold" | "ramp";
  /** The key that OPENS this segment (null for the stretch before the first). */
  readonly fromKeyId: string | null;
  /** The key that CLOSES it (null for the stretch after the last) — what a
   *  length edit moves. */
  readonly toKeyId: string | null;
  readonly startMs: number;
  readonly endMs: number;
  readonly fromRate: number;
  readonly toRate: number;
  /** The easing that carries `fromRate` to `toRate` — the ramp's shape. */
  readonly easing: Easing | null;
  /** The source stands still here — a freeze. Only ever true on a hold. */
  readonly frozen: boolean;
}

/** Below this a rate is a hold, not a crawl. One definition, every surface. */
export const FREEZE_EPSILON = 0.001;

export function speedSegments(clip: Clip): SpeedSegment[] {
  const track = clip.keyframes.find((k) => k.property === SPEED_PROPERTY);
  const base = clipPlaybackOf(clip)?.speed ?? 1;
  if (!track || track.keys.length === 0) {
    return [
      {
        kind: "hold",
        fromKeyId: null,
        toKeyId: null,
        startMs: 0,
        endMs: clip.durationMs,
        fromRate: base,
        toRate: base,
        easing: null,
        frozen: Math.abs(base) < FREEZE_EPSILON,
      },
    ];
  }

  const keys = [...track.keys].sort((a, b) => a.timeMs - b.timeMs);
  const out: SpeedSegment[] = [];
  const rate = (k: Keyframe) => (typeof k.value === "number" ? k.value : base);

  const first = keys[0]!;
  if (first.timeMs > 0.5) out.push(hold(null, first.id, 0, first.timeMs, rate(first)));
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    const fromRate = rate(a);
    const toRate = rate(b);
    const flat = Math.abs(toRate - fromRate) < 0.0005;
    out.push({
      kind: flat ? "hold" : "ramp",
      fromKeyId: a.id,
      toKeyId: b.id,
      startMs: a.timeMs,
      endMs: b.timeMs,
      fromRate,
      toRate,
      // The SEGMENT's easing is the one on the key that opens it — the same
      // convention `sampleKeyframes` interpolates by, so the row you edit and
      // the curve that plays are the same object.
      easing: a.easing ?? null,
      frozen: Math.abs(fromRate) < FREEZE_EPSILON && Math.abs(toRate) < FREEZE_EPSILON,
    });
  }
  const last = keys[keys.length - 1]!;
  if (last.timeMs < clip.durationMs - 0.5) {
    out.push(hold(last.id, null, last.timeMs, clip.durationMs, rate(last)));
  }
  // A CUT is not a stretch. Listing the two-millisecond span that expresses an
  // instant rate change would put a row in the panel for something with no
  // duration to edit and no picture to show — so the reader sees the freeze and
  // the run either side of it, which is what is actually there.
  return out.filter((s) => s.endMs - s.startMs > CUT_MS);

  function hold(
    fromKeyId: string | null,
    toKeyId: string | null,
    startMs: number,
    endMs: number,
    r: number,
  ): SpeedSegment {
    return {
      kind: "hold",
      fromKeyId,
      toKeyId,
      startMs,
      endMs,
      fromRate: r,
      toRate: r,
      easing: null,
      frozen: Math.abs(r) < FREEZE_EPSILON,
    };
  }
}

/** Does this clip's speed vary at all? Drives "is there anything to show". */
export function isRetimed(clip: Clip): boolean {
  const track = clip.keyframes.find((k) => k.property === SPEED_PROPERTY);
  if (track && track.keys.length > 0) return true;
  return Math.abs((clipPlaybackOf(clip)?.speed ?? 1) - 1) > 0.0005;
}

// ── Writing: the four gestures, as keyframe edits ────────────────────────────

/**
 * THE CUT.
 *
 * A keyframe track cannot hold two values at one instant — `setKeyframe` merges
 * anything within a millisecond, which is right for every other property and is
 * the one place this model needs a word. A freeze that begins with a HARD cut
 * (the usual kind) is a rate that goes from full to zero instantly, so it is
 * written as the shortest span the track can represent and treated as an event
 * rather than a stretch everywhere it is read. Two milliseconds is a sixteenth
 * of a frame at 30fps: nothing plays during it and nothing can be seen in it.
 *
 * The alternative was a fourth easing kind (`hold`), which would have touched
 * the schema, the curve editor, the graph panel, both exporters and every
 * adapter — to express something a two-millisecond ramp already expresses
 * exactly.
 */
export const CUT_MS = 2;

/**
 * The keys a FREEZE needs, as plain data.
 *
 * A freeze is "rate 0 from here to there, and back to what it was after" — four
 * keys. Data rather than a mutation, so the timeline gesture, the context menu
 * and a plugin all plant the same shape, and so it can be tested without a
 * document.
 *
 * `rampMs` is the ease into and out of the hold: 0 for the hard cut to still
 * that a freeze frame usually is, and a few frames for the slam sports coverage
 * uses. Either way the SHAPE is the same four keys, which is what keeps one
 * code path behind both.
 */
export function freezeKeys(
  atMs: number,
  holdMs: number,
  rate: number,
  rampMs = 0,
): Array<{ timeMs: number; value: number; easing?: Easing }> {
  const lead = Math.max(CUT_MS, rampMs);
  const start = Math.max(lead, atMs);
  const end = start + Math.max(CUT_MS * 2, holdMs);
  const ramp: Easing | undefined = rampMs > 0 ? undefined : { kind: "linear" };
  return [
    { timeMs: start - lead, value: rate, easing: ramp },
    { timeMs: start, value: 0, easing: { kind: "linear" } },
    { timeMs: end, value: 0, easing: ramp },
    { timeMs: end + lead, value: rate },
  ];
}

// ── The WRITERS: one place each, so every door does the same thing ──────────

function speedTrackOf(clip: Clip): KeyframeTrack | undefined {
  return clip.keyframes.find((t) => t.property === SPEED_PROPERTY);
}

function sortedKeys(clip: Clip): Keyframe[] {
  const track = speedTrackOf(clip);
  return track ? [...track.keys].sort((a, b) => a.timeMs - b.timeMs) : [];
}

/**
 * RAMP TO A RATE, AND STAY THERE.
 *
 * The bug this exists to kill: writing only the ramp's two keys leaves whatever
 * key came AFTER holding the old rate, so the curve obediently ramps straight
 * back up again. Ask for "slow down here" twice and you get a V — a dip you did
 * not draw, in a shape you cannot read, and the panel dutifully lists it as a
 * third ramp going the other way. "Ramp" means *from here on, run at this*, so
 * the rate has to be carried forward.
 *
 * Carried through the CONTINUATION only: every following key that still holds
 * the old rate is a hold that existed because nothing had changed it yet, and
 * it moves. The first key that holds anything else is a decision someone made,
 * and it stays exactly where it is.
 */
export function applySpeedRamp(
  clip: Clip,
  atMs: number,
  durationMs: number,
  toRate: number,
  easing?: Easing,
): void {
  const from = speedAt(clip, atMs);
  const end = Math.max(atMs + CUT_MS, atMs + durationMs);
  const tail = sortedKeys(clip).filter((k) => k.timeMs > end + 0.5);
  setKeyframe(clip.keyframes, SPEED_PROPERTY, atMs, from, easing);
  setKeyframe(clip.keyframes, SPEED_PROPERTY, end, toRate);
  for (const k of tail) {
    if (typeof k.value !== "number" || Math.abs(k.value - from) > 0.0005) break;
    k.value = toRate;
  }
}

/** Freeze the frame at `atMs` for `holdMs`. One door, four keys. */
export function applyFreeze(clip: Clip, atMs: number, holdMs: number, rampMs = 0): void {
  const rate = speedAt(clip, atMs) || 1;
  for (const k of freezeKeys(atMs, holdMs, rate, rampMs)) {
    setKeyframe(clip.keyframes, SPEED_PROPERTY, k.timeMs, k.value, k.easing);
  }
}

/**
 * Where a speed key may be dragged to: strictly between its neighbours.
 *
 * Keys are allowed to cross in the generic keyframe engine, and for a position
 * track that is fine — the order is re-sorted and the result is what you drew.
 * A speed curve is read as a SEQUENCE, so a crossing silently re-orders the
 * holds and ramps under the cursor and the shape inverts. Clamping is what
 * makes dragging a handle feel like moving a boundary rather than shuffling a
 * deck.
 */
export function speedKeyBounds(
  clip: Clip,
  keyId: string,
): { lo: number; hi: number } | null {
  const keys = sortedKeys(clip);
  const i = keys.findIndex((k) => k.id === keyId);
  if (i === -1) return null;
  const prev = keys[i - 1];
  const next = keys[i + 1];
  return {
    lo: prev ? prev.timeMs + CUT_MS : 0,
    hi: next ? next.timeMs - CUT_MS : clip.durationMs,
  };
}

/** The two keys of a RAMP from one rate to another across a span. */
export function rampKeys(
  fromMs: number,
  toMs: number,
  fromRate: number,
  toRate: number,
  easing?: Easing,
): Array<{ timeMs: number; value: number; easing?: Easing }> {
  return [
    { timeMs: Math.max(0, fromMs), value: fromRate, easing },
    { timeMs: Math.max(fromMs + CUT_MS, toMs), value: toRate },
  ];
}
