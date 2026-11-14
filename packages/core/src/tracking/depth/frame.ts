import type { MotionDocument, Clip } from "../../schema";
import type { DepthTracker } from "../../schema/tracking";
import { clipSourcePhaseAt } from "../../timeline/ops";
import { depthGeneration, noteDepthChanged } from "./generation";

/**
 * A DEPTH FRAME — one picture's nearness, and how every consumer reads it.
 *
 * Values are NEARNESS in 0..1 across the whole shot (0 = the far end, 1 = the
 * nearest thing), stored as 16-bit, row-major, at the map's own size, laid
 * over the SOURCE frame edge to edge — so a reader asks in normalised source
 * coordinates (u, v in 0..1) and never cares what size the map is.
 *
 * The maps are kept by the host (they are heavy derived data, like a sound's
 * analysis) and reach core through ONE installed reader, so Fog, Lens Blur,
 * a depth matte, a grade window and a relief all read the same frame.
 */

export interface DepthFrame {
  width: number;
  height: number;
  /** Nearness × 65535. */
  data: Uint16Array;
}

export type DepthReader = (tracker: DepthTracker, sourceMs: number) => DepthFrame | null;

let reader: DepthReader | null = null;

/** The host's store: memory, or null while it loads (asking starts the load). */
export function installDepthReader(fn: DepthReader | null): void {
  reader = fn;
  noteDepthChanged();
}

export { noteDepthChanged, depthGeneration };

/** The map nearest a source time (maps are per source frame), or null. */
export function readDepthFrame(tracker: DepthTracker, sourceMs: number): DepthFrame | null {
  const m = tracker.maps;
  if (!m || !m.times.length || !reader) return null;
  return reader(tracker, nearestTime(m.times, sourceMs));
}

export function nearestTime(times: readonly number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  if (t <= times[0]!) return times[0]!;
  if (t >= times[hi]!) return times[hi]!;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) lo = mid;
    else hi = mid;
  }
  return t - times[lo]! <= times[hi]! - t ? times[lo]! : times[hi]!;
}

/** Nearness at normalised source coordinates, bilinear, 0..1. */
export function nearnessAt(f: DepthFrame, u: number, v: number): number {
  const x = Math.min(f.width - 1, Math.max(0, u * f.width - 0.5));
  const y = Math.min(f.height - 1, Math.max(0, v * f.height - 0.5));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(f.width - 1, x0 + 1);
  const y1 = Math.min(f.height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const r0 = y0 * f.width;
  const r1 = y1 * f.width;
  const a = f.data[r0 + x0]!;
  const b = f.data[r0 + x1]!;
  const c = f.data[r1 + x0]!;
  const d = f.data[r1 + x1]!;
  return (a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy) / 65535;
}

/**
 * A smooth ramp across a band of nearness: 0 at `from`, 1 at `to`. With
 * `from` < `to` it rises toward the camera (fog that thins as things come
 * near is `depthRamp(n, near, far)` read the other way round).
 */
export function depthRamp(n: number, from: number, to: number): number {
  if (Math.abs(to - from) < 1e-6) return n >= to ? 1 : 0;
  const t = Math.min(1, Math.max(0, (n - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

/** The depth tracker serving an asset — the first with maps (a footage has one depth, normally). */
export function depthTrackerFor(doc: MotionDocument, assetId: string): DepthTracker | null {
  let fallback: DepthTracker | null = null;
  for (const t of doc.trackers) {
    if (t.kind !== "depth" || t.source.assetId !== assetId) continue;
    if (t.maps) return t;
    fallback ??= t;
  }
  return fallback;
}

/** The depth of what a clip shows at a clip-local time — the footage's own map, through its time map. */
export function depthForClip(doc: MotionDocument, clip: Clip, localMs: number): { tracker: DepthTracker; frame: DepthFrame } | null {
  if (clip.kind !== "video" && clip.kind !== "image") return null;
  const tracker = depthTrackerFor(doc, clip.assetId);
  if (!tracker?.maps) return null;
  const sourceMs = clip.kind === "image" ? 0 : clipSourcePhaseAt(doc, clip, localMs).sourceMs;
  const frame = readDepthFrame(tracker, sourceMs);
  return frame ? { tracker, frame } : null;
}
