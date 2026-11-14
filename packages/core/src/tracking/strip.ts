import type { MotionDocument, Clip } from "../schema";
import type { Tracker } from "../schema/tracking";
import { isTrackAnchor } from "../schema/tracking";
import { clipSourcePhaseAt } from "../timeline/ops";
import { cameraPoseAt } from "./camera/read-camera";
import { sampleTracker } from "./samples";

/**
 * WHAT A TRACK KNOWS, ALONG A CLIP BAR — the timeline's coverage strip, as data.
 *
 * Each cell is one slice of the clip's local time, read through its time map
 * (trim, speed, reverse, loop), so the strip under a retimed or split clip is
 * true of the frames that clip actually shows. Run-length merged, so a bar
 * draws a handful of rects however wide it is.
 *
 *   none     not analysed yet — what Track ▶ would solve
 *   solved   measured with confidence
 *   weak     measured, but the match was poor — where to look
 *   anchor   a frame you corrected by hand (a tick, not a span)
 */
export type TrackStripState = "none" | "solved" | "weak" | "anchor";

export interface TrackStripRun {
  state: TrackStripState;
  /** Fractions of the clip's duration, [from, to). */
  from: number;
  to: number;
}

/** Confidence below which a measured frame reads as weak — `trackHealth`'s own line. */
const WEAK = 0.5;
/** A camera frame whose points land further than this from where they were seen, px, reads as weak. */
const WEAK_CAMERA_PX = 1.5;

export function trackStrip(doc: MotionDocument, tracker: Tracker, clip: Clip, cells: number): TrackStripRun[] {
  const n = Math.max(1, Math.min(2048, Math.round(cells)));
  const coverage = tracker.analysis?.coverage ?? [];
  const anchors = tracker.kind === "region" ? tracker.samples.filter(isTrackAnchor).map((s) => s.timeMs) : [];
  // How sure the track is at a source time: a region's confidence, a camera solve's reprojection error.
  const weakAt = (sourceMs: number): boolean => {
    if (tracker.kind === "region") return (sampleTracker(tracker, sourceMs)?.confidence ?? 1) < WEAK;
    if (tracker.kind === "depth") return false;
    const p = tracker.solution ? cameraPoseAt(tracker.solution, sourceMs) : null;
    return !p || p.error > WEAK_CAMERA_PX;
  };
  const out: TrackStripRun[] = [];
  const sourceAt = (localMs: number) => (clip.kind === "image" ? 0 : clipSourcePhaseAt(doc, clip, Math.min(localMs, clip.durationMs - 0.01)).sourceMs);
  const step = clip.durationMs / n;
  // A cell spans the source time between its edges, so an anchor lands in
  // exactly one cell at any zoom. Across a loop's seam the edges jump; that
  // cell keeps to its own centre instead of claiming the whole file.
  const edges = Array.from({ length: n + 1 }, (_, k) => sourceAt(k * step));
  for (let i = 0; i < n; i++) {
    const sourceMs = sourceAt((i + 0.5) * step);
    const a = edges[i]!;
    const b = edges[i + 1]!;
    const seam = Math.abs(b - a) > step * 16;
    const lo = seam ? sourceMs : Math.min(a, b);
    const hi = seam ? sourceMs : Math.max(a, b);
    let state: TrackStripState = "none";
    if (anchors.some((t) => t >= lo - 0.5 && t < hi + 0.5)) state = "anchor";
    else if (coverage.some(([from, to]) => sourceMs >= from - 0.5 && sourceMs <= to + 0.5)) {
      state = weakAt(sourceMs) ? "weak" : "solved";
    }
    const from = i / n;
    const to = (i + 1) / n;
    const last = out[out.length - 1];
    if (last && last.state === state && last.to === from) last.to = to;
    else out.push({ state, from, to });
  }
  return out;
}
