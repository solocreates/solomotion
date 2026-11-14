import { evaluateEasing } from "../easing";
import { easingForSegment, monotoneSlopes } from "../animation/smoothing";
import type { Easing, KeyframeValue } from "../schema";

/**
 * PERFORMANCE → KEYS. A take is a run of samples on the playback clock; what
 * the document keeps is the fewest keys whose EASED playback stays within
 * `tolerance` of every sample. Pure, headless, and the only reducer: the
 * canvas, the agent verb and the tests all go through it.
 *
 * Three passes:
 *  1. SNAP + CLEAN — times land on the comp's frame grid when one is given (a
 *     key between frames is a key nobody can see), later samples win a tie.
 *     Optional Gaussian smoothing (`smoothMs`) takes the tremor out of a hand.
 *  2. INSERT — start from the two ends; wherever the EASED curve (step 3)
 *     strays past tolerance, the worst sample becomes a key, and again until
 *     nothing strays. Error is measured VERTICALLY (value at the sample's own
 *     instant), normalised per channel by its tolerance — the error a person
 *     sees on playback — and a key is never moved off its sample, so timing
 *     holds. (Seeding with straight-chord RDP, as this did before, kept most
 *     frames of any smooth move: a line cannot follow a curve.)
 *  3. EASE — every key gets an arriving and a leaving velocity: the Smooth
 *     brain's monotone cubic (`monotoneSlopes` — continuous through keys, zero
 *     at a real stop), except at a CUSP (a bounce flips direction at speed and
 *     keeps both velocities) and at a moving END. Each segment's handle
 *     INFLUENCES are then fitted to the samples, so one segment can carry a
 *     strong ease-in-out instead of needing a key every few frames.
 *
 * Channels sampled together (x and y of one drag) are reduced JOINTLY: they
 * share key times, so a motion key stays a pair.
 */

export interface PerformSample {
  /** Clip-local ms, on the playback clock. */
  t: number;
  /** One value per channel, in a fixed order. */
  v: readonly number[];
}

export interface ReducedKey {
  t: number;
  v: number[];
  /** Per channel: the easing of the segment LEAVING this key. */
  easing: Easing[];
}

export interface FrameGrid {
  stepMs: number;
  /** A time that is on the grid (clip-local frames sit at `originMs + k·stepMs`). */
  originMs?: number;
}

export interface ReduceOptions {
  /** Gaussian smoothing of the samples before reduction (σ, ms). 0 = none. */
  smoothMs?: number;
  /** Snap sample times to this grid first. */
  grid?: FrameGrid;
}

const MAX_REFINE = 64;

/** Snap a time onto a frame grid (nearest frame). */
export function snapToGrid(t: number, grid: FrameGrid): number {
  const o = grid.originMs ?? 0;
  const k = Math.round((t - o) / grid.stepMs);
  // Round the float so equal frames compare equal however they were reached.
  return Math.round((o + k * grid.stepMs) * 1000) / 1000;
}

/**
 * Monotone, de-duplicated, optionally grid-snapped. When several samples land
 * on one frame the one taken nearest that instant speaks for it (a value moved
 * half a frame is a timing error a person can see); exact ties go to the later.
 */
export function cleanSamples<T extends { t: number }>(samples: readonly T[], grid?: FrameGrid): T[] {
  const out: T[] = [];
  let lastOff = Infinity;
  for (const s of samples) {
    if (!Number.isFinite(s.t)) continue;
    const t = grid ? snapToGrid(s.t, grid) : s.t;
    const off = Math.abs(s.t - t);
    const last = out[out.length - 1];
    if (last && t <= last.t + 1e-6) {
      if (Math.abs(t - last.t) <= 1e-6 && off <= lastOff + 1e-9) {
        out[out.length - 1] = { ...s, t };
        lastOff = off;
      }
      // An earlier time after a later one is a wrap — the caller splits runs
      // (`splitRuns`); inside one run it is noise and is dropped.
      continue;
    }
    out.push({ ...s, t });
    lastOff = off;
  }
  return out;
}

/**
 * Split a take into monotone runs. The playhead only goes backwards when the
 * transport WRAPS (a loop, a ping-pong reflection read as a new pass), so each
 * run is one pass over the range, recorded in order — a later pass replaces
 * what an earlier one wrote where they overlap.
 */
export function splitRuns<T extends { t: number }>(samples: readonly T[]): T[][] {
  const runs: T[][] = [];
  let cur: T[] = [];
  for (const s of samples) {
    const last = cur[cur.length - 1];
    if (last && s.t < last.t - 1e-6) {
      runs.push(cur);
      cur = [];
    }
    cur.push(s);
  }
  if (cur.length) runs.push(cur);
  return runs;
}

function gaussianSmooth(samples: PerformSample[], sigma: number): PerformSample[] {
  if (!(sigma > 0) || samples.length < 3) return samples;
  const reach = sigma * 3;
  const dims = samples[0]!.v.length;
  return samples.map((s, i) => {
    const acc = new Array<number>(dims).fill(0);
    let wsum = 0;
    for (let j = i; j >= 0 && s.t - samples[j]!.t <= reach; j--) add(j);
    for (let j = i + 1; j < samples.length && samples[j]!.t - s.t <= reach; j++) add(j);
    function add(j: number) {
      const d = samples[j]!.t - s.t;
      const w = Math.exp(-(d * d) / (2 * sigma * sigma));
      wsum += w;
      for (let k = 0; k < dims; k++) acc[k]! += w * samples[j]!.v[k]!;
    }
    return { t: s.t, v: acc.map((a) => a / wsum) };
  });
}

/** A one-sided sample slope at `i` (`dir` −1 = arriving, +1 = leaving), or null at the edge. */
function sampleSlope(samples: PerformSample[], i: number, k: number, dir: -1 | 1): number | null {
  const j = i + dir;
  const S = samples[i], N = samples[j];
  if (!S || !N || N.t === S.t) return null;
  return (N.v[k]! - S.v[k]!) / (N.t - S.t);
}

/** How sharply the motion changes velocity AT sample i, in tolerances per frame. */
function jolt(samples: PerformSample[], i: number, tol: readonly number[]): number {
  if (i <= 0 || i >= samples.length - 1) return 0;
  let m = 0;
  for (let k = 0; k < tol.length; k++) {
    const d0 = samples[i]!.v[k]! - samples[i - 1]!.v[k]!;
    const d1 = samples[i + 1]!.v[k]! - samples[i]!.v[k]!;
    m = Math.max(m, Math.abs(d1 - d0) / tol[k]!);
  }
  return m;
}

/**
 * Is sample i a CORNER — the velocity changes there and not at its neighbours
 * (a turn, a stop, a start, a bounce)? Smooth acceleration changes velocity a
 * little at every sample and is not one. A corner is a pose: it is keyed at its
 * own instant, keeps the velocities it really arrives and leaves with, and is
 * never thinned away.
 */
function isCorner(samples: PerformSample[], i: number, tol: readonly number[]): boolean {
  return jolt(samples, i, tol) - Math.max(jolt(samples, i - 1, tol), jolt(samples, i + 1, tol)) > 2;
}

/**
 * Each kept key's arriving and leaving velocity, per channel, read from the
 * samples where they can be trusted and from the kept keys where they cannot:
 *  - SMOOTH where it stands (the samples arrive and leave at nearly the same
 *    speed): the samples' own velocity. A baked or simulated track is exact
 *    data; its key in the middle of an ease-in-out is moving at 1.5× the
 *    secant, and monotone cubic would say 1×, which no easing can repair.
 *  - a CUSP (it flips direction at speed — a bounce, an impact, a whip): both
 *    velocities, broken. Easing into a stop there is the stall a bounce must
 *    not have.
 *  - anything else (a trembling hand): monotone cubic (`monotoneSlopes`) —
 *    continuous through the key, zero at a real stop, never overshooting.
 * An END keeps the speed it has when it is moving, else rests. "At speed"
 * means at least a quarter of the neighbouring segments' average.
 */
function keySlopes(samples: PerformSample[], idx: number[], k: number, tol: readonly number[]): { arrive: number[]; leave: number[] } {
  const ts = idx.map((i) => samples[i]!.t);
  const vs = idx.map((i) => samples[i]!.v[k]!);
  const m = monotoneSlopes(ts, vs);
  const arrive = [...m];
  const leave = [...m];
  const secant = (j: number) => {
    const dt = ts[j + 1]! - ts[j]!;
    return dt > 0 ? (vs[j + 1]! - vs[j]!) / dt : 0;
  };
  for (let j = 0; j < idx.length; j++) {
    const near = Math.max(j > 0 ? Math.abs(secant(j - 1)) : 0, j < idx.length - 1 ? Math.abs(secant(j)) : 0);
    const fast = (v: number | null): v is number => v !== null && Math.abs(v) > 0.25 * near && Math.abs(v) > 1e-9;
    const back = sampleSlope(samples, idx[j]!, k, -1); // (v_i − v_{i−1}) / Δt: the velocity arriving
    const fwd = sampleSlope(samples, idx[j]!, k, 1); // (v_{i+1} − v_i) / Δt: the velocity leaving
    if (j === 0 || j === idx.length - 1) {
      if (j === 0 && fast(fwd)) leave[0] = fwd;
      if (j === idx.length - 1 && fast(back)) arrive[j] = back;
      continue;
    }
    if (back === null || fwd === null) continue;
    if ((fast(back) && fast(fwd) && Math.sign(back) !== Math.sign(fwd)) || isCorner(samples, idx[j]!, tol)) {
      arrive[j] = back;
      leave[j] = fwd;
    } else if (Math.abs(back - fwd) <= 0.25 * Math.max(Math.abs(back), Math.abs(fwd))) {
      arrive[j] = leave[j] = (back + fwd) / 2;
    }
  }
  return { arrive, leave };
}

/** Worst tolerance-normalised error of one channel's eased segment against its samples. */
function segmentError(samples: PerformSample[], a: number, b: number, k: number, e: Easing, tol: number): number {
  const A = samples[a]!, B = samples[b]!;
  const span = B.t - A.t;
  let worst = 0;
  for (let i = a + 1; i < b; i++) {
    const S = samples[i]!;
    const u = span > 0 ? (S.t - A.t) / span : 0;
    const v = A.v[k]! + (B.v[k]! - A.v[k]!) * evaluateEasing(e, u);
    worst = Math.max(worst, Math.abs(S.v[k]! - v) / tol);
  }
  return worst;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const clampY = (v: number) => Math.max(-2, Math.min(3, v));

/**
 * The segment's easing: its end velocities are fixed (`mStart`, `mEnd`, so
 * speed stays continuous where the keys say it is), and its INFLUENCES — how
 * long each velocity persists, the handles' horizontal reach — are fitted to
 * the samples. Pinning both at the time-thirds (the Smooth command's
 * convention, and this reducer's before) cannot draw a strong ease-in-out:
 * one designed move became dozens of keys. The thirds are tried first and kept
 * when they already fit, so a segment only changes shape when it has to.
 */
function fitSegmentEasing(samples: PerformSample[], a: number, b: number, k: number, mStart: number, mEnd: number, tol: number, coarse = false): Easing {
  const A = samples[a]!, B = samples[b]!;
  const dt = B.t - A.t;
  const avg = dt > 0 ? (B.v[k]! - A.v[k]!) / dt : 0;
  const thirds = easingForSegment(avg, mStart, mEnd);
  if (Math.abs(avg) < 1e-9 || b - a < 2) return thirds;
  if (segmentError(samples, a, b, k, thirds, tol) <= 1) return thirds;
  const make = (x1: number, x2: number): Easing => ({
    kind: "bezier",
    values: [round3(x1), round3(clampY((x1 * mStart) / avg)), round3(x2), round3(clampY(1 - ((1 - x2) * mEnd) / avg))],
  });
  let best = thirds;
  let bestErr = segmentError(samples, a, b, k, thirds, tol);
  const search = (c1: number, c2: number, step: number, reach: number) => {
    for (let x1 = c1 - reach; x1 <= c1 + reach + 1e-9; x1 += step) {
      for (let x2 = c2 - reach; x2 <= c2 + reach + 1e-9; x2 += step) {
        if (x1 < 0.02 || x1 > 0.98 || x2 < 0.02 || x2 > 0.98) continue;
        const e = make(x1, x2);
        const err = segmentError(samples, a, b, k, e, tol);
        if (err < bestErr) (bestErr = err), (best = e);
      }
    }
  };
  search(0.5, 0.5, 0.1, 0.4);
  if (coarse) return best;
  if (best.kind === "bezier") search(best.values[0], best.values[2], 0.02, 0.08);
  if (best.kind === "bezier") search(best.values[0], best.values[2], 0.005, 0.02);
  return best;
}

/** Fitted easings for every channel of the kept keys (the last key's is linear: nothing leaves it). */
function easeKeys(samples: PerformSample[], idx: number[], dims: number, tol: number[]): Easing[][] {
  const per: Easing[][] = idx.map(() => []);
  for (let k = 0; k < dims; k++) {
    const { arrive, leave } = keySlopes(samples, idx, k, tol);
    for (let j = 0; j < idx.length; j++) {
      if (j === idx.length - 1) {
        per[j]!.push({ kind: "linear" });
        continue;
      }
      per[j]!.push(fitSegmentEasing(samples, idx[j]!, idx[j + 1]!, k, leave[j]!, arrive[j + 1]!, tol[k]!));
    }
  }
  return per;
}

/** The sample between keys a and b that strays furthest past tolerance, or −1 when the segment fits. */
function worstSample(samples: PerformSample[], a: number, b: number, easing: Easing[], tol: number[]): number {
  const A = samples[a]!, B = samples[b]!;
  const span = B.t - A.t;
  let worst = -1, worstErr = 1;
  for (let i = a + 1; i < b; i++) {
    const S = samples[i]!;
    const u = span > 0 ? (S.t - A.t) / span : 0;
    let e = 0;
    for (let k = 0; k < tol.length; k++) {
      const v = A.v[k]! + (B.v[k]! - A.v[k]!) * evaluateEasing(easing[k]!, u);
      e = Math.max(e, Math.abs(S.v[k]! - v) / tol[k]!);
    }
    if (e > worstErr) (worstErr = e), (worst = i);
  }
  return worst;
}

/**
 * Where to put the key that segment `j` needs: the worst sample is the obvious
 * answer and often a poor one (an ease-in-out misses most a third of the way
 * in, but its natural key is the middle). Up to 16 evenly spaced candidates and
 * the worst sample are each tried, and the one whose two halves fit best wins.
 */
function bestSplit(samples: PerformSample[], kept: number[], j: number, worst: number, tol: number[]): number {
  const a = kept[j]!, b = kept[j + 1]!;
  const step = Math.max(1, Math.floor((b - a - 1) / 16));
  const cands = new Set<number>([worst]);
  for (let i = a + 1; i < b; i += step) cands.add(i);
  // A corner keys first, at its own instant: the sharpest one in the segment.
  let corner = -1, sharpest = 0;
  for (let i = a + 1; i < b; i++) {
    if (!isCorner(samples, i, tol)) continue;
    const j2 = jolt(samples, i, tol);
    if (j2 > sharpest) (sharpest = j2), (corner = i);
  }
  if (corner >= 0) return corner;
  let best = worst, bestErr = Infinity;
  for (const c of cands) {
    const trial = [...kept.slice(0, j + 1), c, ...kept.slice(j + 1)];
    let err = 0;
    for (let k = 0; k < tol.length && err < bestErr; k++) {
      const { arrive, leave } = keySlopes(samples, trial, k, tol);
      const e1 = fitSegmentEasing(samples, a, c, k, leave[j + 0]!, arrive[j + 1]!, tol[k]!, true);
      const e2 = fitSegmentEasing(samples, c, b, k, leave[j + 1]!, arrive[j + 2]!, tol[k]!, true);
      err = Math.max(err, segmentError(samples, a, c, k, e1, tol[k]!), segmentError(samples, c, b, k, e2, tol[k]!));
    }
    if (err < bestErr) (bestErr = err), (best = c);
  }
  return best;
}

/**
 * Reduce performed samples to keys. `tolerance` is in the channel's own units
 * (px, degrees, 0..1) — one number for every channel, or one per channel.
 * Zero samples → no keys; one instant → one key.
 */
export function reduceSamplesToKeys(
  input: readonly PerformSample[],
  tolerance: number | readonly number[],
  opts: ReduceOptions = {},
): ReducedKey[] {
  let samples = cleanSamples(input, opts.grid).filter((s) => s.v.every((x) => Number.isFinite(x)));
  if (!samples.length) return [];
  const dims = samples[0]!.v.length;
  const tol = Array.from({ length: dims }, (_, k) => {
    const t = typeof tolerance === "number" ? tolerance : (tolerance[k] ?? tolerance[0] ?? 0.5);
    return Math.max(1e-6, t);
  });
  if (samples.length === 1) {
    const s = samples[0]!;
    return [{ t: s.t, v: [...s.v], easing: s.v.map(() => ({ kind: "linear" }) as Easing) }];
  }
  samples = gaussianSmooth(samples, opts.smoothMs ?? 0);

  // Start from the two ends and let the EASED error decide where keys go. Seeding
  // with straight-chord RDP kept a key wherever a line could not follow a
  // curve — most of the frames of any smooth move — and the verify pass can
  // only add.
  let kept = [0, samples.length - 1];
  let easings = easeKeys(samples, kept, dims, tol);
  // INSERT where the eased curve strays: at the split that fits both halves best.
  for (let pass = 0; pass < MAX_REFINE; pass++) {
    const add: number[] = [];
    for (let j = 0; j < kept.length - 1; j++) {
      const worst = worstSample(samples, kept[j]!, kept[j + 1]!, easings[j]!, tol);
      if (worst >= 0) add.push(bestSplit(samples, kept, j, worst, tol));
    }
    if (!add.length) break;
    kept = [...new Set([...kept, ...add])].sort((x, y) => x - y);
    easings = easeKeys(samples, kept, dims, tol);
  }
  // REMOVE what greedy insertion over-placed: a key whose neighbours still fit
  // without it was never needed.
  for (let j = 1; j < kept.length - 1; ) {
    if (isCorner(samples, kept[j]!, tol)) {
      j++;
      continue;
    }
    const trial = kept.filter((_, q) => q !== j);
    const e = easeKeys(samples, trial, dims, tol);
    if (trial.every((a, q) => q === trial.length - 1 || worstSample(samples, a, trial[q + 1]!, e[q]!, tol) < 0)) {
      kept = trial;
      easings = e;
    } else j++;
  }
  return kept.map((i, j) => ({ t: samples[i]!.t, v: [...samples[i]!.v], easing: easings[j]! }));
}

/**
 * A DISCRETE channel (a switch, a pose name, a bool): a key at the first
 * sample and wherever the value changes — nothing to ease, nothing to thin.
 */
export function reduceDiscreteSamples(
  input: ReadonlyArray<{ t: number; v: KeyframeValue }>,
  grid?: FrameGrid,
): Array<{ t: number; v: KeyframeValue }> {
  const samples = cleanSamples(input, grid);
  const out: Array<{ t: number; v: KeyframeValue }> = [];
  for (const s of samples) {
    const last = out[out.length - 1];
    if (last && sameValue(last.v, s.v)) continue;
    out.push({ t: s.t, v: s.v });
  }
  return out;
}

function sameValue(a: KeyframeValue, b: KeyframeValue): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Unwrap an angle series so a turn past ±180 keeps turning instead of spinning back. */
export function unwrapDegrees(vs: readonly number[]): number[] {
  const out: number[] = [];
  for (const v of vs) {
    const prev = out[out.length - 1];
    if (prev === undefined) {
      out.push(v);
      continue;
    }
    let d = v - prev;
    d -= Math.round(d / 360) * 360;
    out.push(prev + d);
  }
  return out;
}
