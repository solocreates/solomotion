import type { Easing, KeyframeTrack, SpatialTangents, Vec2 } from "../schema";
import { motionKeyTimes, positionTracks, sampleKeyframeTrack } from "./keyframes";

/**
 * The "Smooth / Unify Movements" brain — one headless pass that makes a
 * keyframe sequence FLOW: velocity stays continuous through every interior
 * key instead of dropping to zero, so the stop-start pause an ease-in-out
 * leaves at each key disappears. Values, positions and times are never
 * touched — only the segment easings (and, for motion paths, the spatial
 * curve tangents). Pure and mutating; call inside a document update.
 *
 * The math is monotone cubic (Fritsch–Carlson): each interior key gets a
 * target slope from its neighbouring secants — a weighted harmonic mean that
 * is exactly the incoming AND outgoing velocity, so speed is C1-continuous —
 * and clamps to zero at a genuine reversal (a real peak, where a momentary
 * stop is physically correct, not a glitch). The animation's own first/last
 * key ease to rest (slope 0) for a graceful start and stop. Endpoints of a
 * PARTIAL selection blend into the untouched neighbours because their slopes
 * are computed over the full track, not the subset.
 *
 * Each segment easing is a normalized cubic bezier with handles pinned at the
 * time-thirds (x1 = 1/3, x2 = 2/3), the same convention the curve editor uses,
 * with y set so the tangent AT the key equals the target velocity. y may leave
 * [0,1] — that overshoot is how unequal segment lengths keep one speed across
 * a key — and is clamped to a sane range so a near-flat segment can't produce
 * a wild handle.
 */

const HANDLE_X1 = 1 / 3;
const HANDLE_X2 = 2 / 3;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
const clampHandle = (v: number) => Math.max(-2, Math.min(3, v));

/**
 * Target slopes at each sample of (t, v). Interior keys use Fritsch–Carlson
 * (continuous, overshoot-free, zero at reversals); the first and last ease to
 * rest. `chordMode` treats the values as non-negative segment lengths (motion
 * speed), which never reverse sign.
 */
export function monotoneSlopes(ts: number[], vs: number[]): number[] {
  const n = ts.length;
  const m = new Array<number>(n).fill(0);
  if (n < 2) return m;
  const h: number[] = [];
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dt = ts[i + 1]! - ts[i]!;
    h.push(dt);
    d.push(dt > 0 ? (vs[i + 1]! - vs[i]!) / dt : 0);
  }
  // Ends rest — a clean ease-out of the start, ease-in to the stop.
  m[0] = 0;
  m[n - 1] = 0;
  for (let i = 1; i < n - 1; i++) {
    const dPrev = d[i - 1]!;
    const dNext = d[i]!;
    if (dPrev === 0 || dNext === 0 || dPrev * dNext < 0) {
      m[i] = 0; // a real reversal / flat — stopping here is correct
      continue;
    }
    const wPrev = 2 * h[i]! + h[i - 1]!;
    const wNext = h[i]! + 2 * h[i - 1]!;
    m[i] = (wPrev + wNext) / (wPrev / dPrev + wNext / dNext);
  }
  return m;
}

/**
 * The segment easing whose tangents equal the target velocities at its ends.
 * `avgSlope` is the segment's own (Δv/Δt); a flat segment can't carry a
 * meaningful eased profile, so it stays linear.
 */
export function easingForSegment(avgSlope: number, mStart: number, mEnd: number): Easing {
  if (Math.abs(avgSlope) < 1e-9) return { kind: "linear" };
  const y1 = clampHandle(mStart / avgSlope / 3);
  const y2 = clampHandle(1 - mEnd / avgSlope / 3);
  return { kind: "bezier", values: [HANDLE_X1, round3(y1), HANDLE_X2, round3(y2)] };
}

/** Smooth one scalar numeric track over the selected subset (null = all keys). */
function smoothScalarTrack(track: KeyframeTrack, keyIds: Set<string> | null): void {
  const keys = [...track.keys].sort((a, b) => a.timeMs - b.timeMs);
  if (keys.length < 2) return;
  const nums = keys.map((k) => (typeof k.value === "number" ? k.value : null));
  if (nums.some((v) => v === null)) return; // non-numeric track — nothing to ease
  const ts = keys.map((k) => k.timeMs);
  const vs = nums as number[];
  const slopes = monotoneSlopes(ts, vs);
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (keyIds && !(keyIds.has(a.id) && keyIds.has(b.id))) continue;
    if (a.easing.kind === "hold") continue; // a cut is a decision, not a stall to smooth away
    const dt = ts[i + 1]! - ts[i]!;
    const avg = dt > 0 ? (vs[i + 1]! - vs[i]!) / dt : 0;
    a.easing = easingForSegment(avg, slopes[i]!, slopes[i + 1]!);
  }
}

/**
 * Smooth a 2D motion path: continuous SPEED through interior keys (arc-length
 * Fritsch–Carlson on the temporal carrier) plus Catmull-Rom spatial tangents
 * so the path itself flows through each point with no corner. Time carrier is
 * the x key; y stays aligned. Only the selected columns are rewritten.
 */
interface MotionMeasure {
  times: number[];
  pts: Vec2[];
  chord: number[];
  /** Arc-length-vs-time slopes: the speed profile the timing pass eases toward. */
  slopes: number[];
  keyNear: (track: KeyframeTrack, t: number) => { id: string } | undefined;
  inSubset: (t: number) => boolean;
}

/**
 * Measure a motion path once: merged key times, their positions, the chord
 * length of each segment, and the monotone arc-length slopes. Shared by the
 * spatial and timing passes so they can be applied together or on their own.
 */
function measureMotionPath(
  xt: KeyframeTrack,
  yt: KeyframeTrack,
  keyIds: Set<string> | null,
): MotionMeasure | null {
  const times = motionKeyTimes(xt, yt);
  if (times.length < 2) return null;
  const num = (v: unknown, fb: number) => (typeof v === "number" ? v : fb);
  const keyNear = (track: KeyframeTrack, t: number) =>
    track.keys.find((k) => Math.abs(k.timeMs - t) < 0.5);

  const pts: Vec2[] = times.map((t) => ({
    x: num(sampleKeyframeTrack(xt, t), 0),
    y: num(sampleKeyframeTrack(yt, t), 0),
  }));
  const chord: number[] = [];
  for (let i = 0; i < times.length - 1; i++) {
    chord.push(Math.hypot(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.y - pts[i]!.y));
  }
  // Cumulative arc length as the "value" the slopes describe: FC over it gives
  // a continuous speed profile along the path (chord length per unit time).
  let acc = 0;
  const arc: number[] = [0];
  for (let i = 0; i < chord.length; i++) {
    acc += chord[i]!;
    arc.push(acc);
  }
  const inSubset = (t: number) => {
    if (!keyIds) return true;
    const xk = keyNear(xt, t);
    const yk = keyNear(yt, t);
    return (xk && keyIds.has(xk.id)) || (yk && keyIds.has(yk.id)) || false;
  };
  return { times, pts, chord, slopes: monotoneSlopes(times, arc), keyNear, inSubset };
}

/**
 * Rewrite ONLY the temporal carrier so the layer keeps a continuous speed
 * through each interior key — no decelerating into a point and accelerating out
 * of it. The path's SHAPE is left exactly as it is.
 *
 * Split out from the full smooth because inserting a key on an existing path
 * needs precisely this half: the de Casteljau split already preserves the curve,
 * so re-deriving spatial tangents would move a path the user just pointed at.
 */
export function smoothMotionTiming(
  xt: KeyframeTrack,
  yt: KeyframeTrack,
  keyIds: Set<string> | null,
): void {
  const m = measureMotionPath(xt, yt, keyIds);
  if (!m) return;
  for (let i = 0; i < m.times.length - 1; i++) {
    if (keyIds && !(m.inSubset(m.times[i]!) && m.inSubset(m.times[i + 1]!))) continue;
    const xk = m.keyNear(xt, m.times[i]!) as { easing: Easing } | undefined;
    if (!xk || xk.easing.kind === "hold") continue;
    const dt = m.times[i + 1]! - m.times[i]!;
    const avg = dt > 0 ? m.chord[i]! / dt : 0;
    xk.easing = easingForSegment(avg, m.slopes[i]!, m.slopes[i + 1]!);
  }
}

function smoothMotionPath(
  xt: KeyframeTrack,
  yt: KeyframeTrack,
  keyIds: Set<string> | null,
): void {
  const m = measureMotionPath(xt, yt, keyIds);
  if (!m) return;
  const { times, pts } = m;
  for (let i = 0; i < times.length; i++) {
    if (!m.inSubset(times[i]!)) continue;
    const xk = m.keyNear(xt, times[i]!) as { spatial: SpatialTangents | null } | undefined;
    if (!xk) continue;
    // Catmull-Rom tangent: parallel to the prev→next chord, a sixth each side.
    const prev = pts[i - 1] ?? pts[i]!;
    const next = pts[i + 1] ?? pts[i]!;
    const dir = { x: (next.x - prev.x) / 6, y: (next.y - prev.y) / 6 };
    if (dir.x === 0 && dir.y === 0) {
      xk.spatial = null;
    } else {
      xk.spatial = {
        in: i > 0 ? { x: -dir.x, y: -dir.y } : null,
        out: i < times.length - 1 ? { x: dir.x, y: dir.y } : null,
      };
    }
  }
  // Temporal carrier: continuous speed through each interior key.
  smoothMotionTiming(xt, yt, keyIds);
}

/**
 * Smooth every track (or only the selected keys, when `keyIds` is given) so
 * motion flows continuously through interior keys. Position x/y are handled as
 * one motion path; all other numeric tracks are smoothed independently.
 */
export function smoothKeyframes(tracks: KeyframeTrack[], keyIds: Set<string> | null): void {
  const pos = positionTracks(tracks);
  if (pos) smoothMotionPath(pos.x, pos.y, keyIds);
  for (const track of tracks) {
    if (track.range) continue;
    if (pos && (track === pos.x || track === pos.y)) continue;
    smoothScalarTrack(track, keyIds);
  }
}
