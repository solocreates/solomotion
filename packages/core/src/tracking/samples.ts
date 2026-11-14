import type { RegionTracker, TrackChannel, TrackSample } from "../schema/tracking";
import { isTrackAnchor } from "../schema/tracking";
import type { Vec2 } from "../schema/common";
import { lerpPose, poseOf } from "./pose";

/**
 * READING A BAKE. Pure over a tracker's `samples` array — interpolation for
 * playback, health for the confidence readout, and the correction ops. Every
 * consumer (driver, overlay, health bar, exporter) samples through HERE, so
 * preview, export and the UI can never disagree about where a track is.
 */

const EPS = 0.5; // ms — two samples closer than this are "the same time".

/** Index of the last sample at or before `ms` (−1 if all are after). */
function floorIndex(samples: TrackSample[], ms: number): number {
  let lo = 0;
  let hi = samples.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]!.timeMs <= ms) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** Blend two warps. Length mismatch (the detail dial moved mid-track) falls back
 *  to the nearer one rather than interleaving two different vertex counts. */
function lerpWarp(a: Vec2[] | null, b: Vec2[] | null, t: number): Vec2[] | null {
  if (!a) return b && t >= 0.5 ? b : null;
  if (!b) return t < 0.5 ? a : null;
  if (a.length !== b.length) return t < 0.5 ? a : b;
  return a.map((p, i) => ({ x: p.x + (b[i]!.x - p.x) * t, y: p.y + (b[i]!.y - p.y) * t }));
}

/**
 * Uniform Catmull–Rom on one axis — the position between two
 * measured frames. Linear interpolation is exact when every frame is measured
 * and visibly wrong when the cadence skipped three: a curving path turns into
 * a polygon whose corners are the measurements. Catmull–Rom passes through
 * every measurement and carries the velocity across them.
 */
function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/**
 * The pose at a source time. Measured frames are returned as stored; between
 * two of them the pose is interpolated — position along a Catmull–Rom spline
 * through the neighbours, everything else linearly (rotation the short way).
 * Ends HOLD. Null when there are no samples.
 *
 * The returned sample carries `pinned: []` even when it sits on an anchor's
 * time: an interpolated reading is not itself a user correction, and anything
 * that round-trips one back into the array would otherwise mint anchors nobody
 * placed.
 */
export function sampleTracker(tracker: RegionTracker, sourceMs: number): TrackSample | null {
  const s = tracker.samples;
  if (s.length === 0) return null;
  if (s.length === 1 || sourceMs <= s[0]!.timeMs) return s[0]!;
  if (sourceMs >= s[s.length - 1]!.timeMs) return s[s.length - 1]!;
  const i = floorIndex(s, sourceMs);
  const a = s[i]!;
  const b = s[i + 1]!;
  const span = b.timeMs - a.timeMs;
  if (Math.abs(sourceMs - a.timeMs) < EPS) return a;
  if (Math.abs(sourceMs - b.timeMs) < EPS) return b;
  const t = span <= EPS ? 0 : (sourceMs - a.timeMs) / span;
  const pose = lerpPose(poseOf(a), poseOf(b), t);
  const p0 = s[i - 1] ?? a;
  const p3 = s[i + 2] ?? b;
  return {
    timeMs: sourceMs,
    x: catmull(p0.x, a.x, b.x, p3.x, t),
    y: catmull(p0.y, a.y, b.y, p3.y, t),
    scale: pose.scale,
    scaleY: pose.scaleY,
    rotation: pose.rotation,
    skew: pose.skew ?? 0,
    perspective: pose.perspective ?? null,
    warp: lerpWarp(a.warp, b.warp, t),
    confidence: Math.min(a.confidence, b.confidence),
    pinned: [],
  };
}

/** Is there a MEASURED sample at this source time (not an interpolation)? */
export function solvedAt(tracker: RegionTracker, sourceMs: number, toleranceMs = EPS): boolean {
  const s = tracker.samples;
  const i = floorIndex(s, sourceMs + toleranceMs);
  return i >= 0 && Math.abs(s[i]!.timeMs - sourceMs) <= toleranceMs;
}

/** The sample deltas are measured against — the frame the region was drawn on. */
export function referenceSample(tracker: RegionTracker): TrackSample | null {
  if (tracker.samples.length === 0) return null;
  return sampleTracker(tracker, tracker.referenceMs) ?? tracker.samples[0]!;
}

export interface TrackHealthSpan {
  fromMs: number;
  toMs: number;
}
export interface TrackHealth {
  /** Mean confidence over all samples (0..1). */
  average: number;
  worst: number;
  /** Contiguous runs below the threshold — "review here". */
  weakSpans: TrackHealthSpan[];
  clean: boolean;
  /** How many frames the user has corrected by hand. */
  anchors: number;
}

/**
 * Confidence readout. An ANCHOR counts as fully confident — the user vouched for
 * it — which is also what makes the health bar improve as you correct, instead
 * of reporting the same bad number after you have fixed the problem.
 */
export function trackHealth(tracker: RegionTracker, threshold = 0.5): TrackHealth {
  const s = tracker.samples;
  if (s.length === 0) return { average: 0, worst: 0, weakSpans: [], clean: true, anchors: 0 };
  let sum = 0;
  let worst = 1;
  let anchors = 0;
  const spans: TrackHealthSpan[] = [];
  let open: TrackHealthSpan | null = null;
  for (const sample of s) {
    const pinned = isTrackAnchor(sample);
    if (pinned) anchors++;
    const c = pinned ? 1 : sample.confidence;
    sum += c;
    if (c < worst) worst = c;
    if (c < threshold) {
      if (open) open.toMs = sample.timeMs;
      else open = { fromMs: sample.timeMs, toMs: sample.timeMs };
    } else if (open) {
      spans.push(open);
      open = null;
    }
  }
  if (open) spans.push(open);
  return { average: sum / s.length, worst, weakSpans: spans, clean: spans.length === 0, anchors };
}

/**
 * Pin one or more CHANNELS at a time — the correction primitive.
 *
 * The caller supplies only the channels it is changing; everything else is read
 * from the interpolated track so a position fix does not jolt the scale. Pins
 * accumulate, so nudging the position and then the rotation at one frame leaves
 * both pinned rather than the second replacing the first.
 */
export function pinSample(
  tracker: RegionTracker,
  timeMs: number,
  channels: TrackChannel[],
  patch: Partial<Pick<TrackSample, "x" | "y" | "scale" | "scaleY" | "rotation" | "skew" | "perspective" | "warp">>,
): void {
  const at = sampleTracker(tracker, timeMs);
  const s = tracker.samples;
  const i = floorIndex(s, timeMs);
  const existing = i >= 0 && Math.abs(s[i]!.timeMs - timeMs) < EPS ? s[i]! : null;
  const base: TrackSample = existing ??
    at ?? { timeMs, x: 0, y: 0, scale: 1, scaleY: null, rotation: 0, skew: 0, perspective: null, warp: null, confidence: 1, pinned: [] };

  const next: TrackSample = {
    ...base,
    ...patch,
    timeMs,
    confidence: 1,
    pinned: [...new Set([...(existing?.pinned ?? []), ...channels])],
  };
  if (existing) s[i] = next;
  else s.splice(i + 1, 0, next);
}

/**
 * Release channels at a frame. Dropping the last one removes the anchor
 * entirely, so the sample goes back to being an ordinary solved reading rather
 * than a pin with nothing pinned — a state that would keep the solver away from
 * a frame for no reason anybody could see.
 */
export function unpinSample(tracker: RegionTracker, timeMs: number, channels?: TrackChannel[]): void {
  const s = tracker.samples;
  const i = floorIndex(s, timeMs + EPS);
  const sample = i >= 0 && Math.abs(s[i]!.timeMs - timeMs) < EPS ? s[i]! : null;
  if (!sample || !isTrackAnchor(sample)) return;
  const keep = channels ? sample.pinned.filter((c) => !channels.includes(c)) : [];
  if (keep.length === 0) s.splice(i, 1);
  else s[i] = { ...sample, pinned: keep };
}

/** Every frame the user has corrected, for the timeline's anchor pips. */
export function anchorTimes(tracker: RegionTracker): number[] {
  return tracker.samples.filter(isTrackAnchor).map((s) => s.timeMs);
}
