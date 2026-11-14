import type { MotionDocument, Clip, VisualClip } from "../schema";
import type {
  TrackBinding,
  TrackChannel,
  TrackRegion,
  TrackSample,
  TrackSolve,
  TrackShape,
  TrackSource,
  TrackSpan,
  Tracker,
  RegionTracker,
} from "../schema/tracking";
import { isVisualClip } from "../clip-registry";
import { createId } from "../ids";
import { setKeyframe } from "../animation/keyframes";
import { clipLocalTime } from "../animation/evaluate";
import { compFps } from "../timeline/fps";
import { mergeAnchors } from "./solve";
import { pinSample, sampleTracker, unpinSample } from "./samples";
import { regionFromShape, toSubpaths } from "./contour";
import { nextTrackerColor } from "./palette";
import { followWrites } from "./follow";
import type { Vec2 } from "../schema/common";
import { channelValueAt } from "../animation/channels";
import { applyInverse, type Mat2D } from "../navigation/matrix";
import type { Contour } from "../schema/vector";
import { subpathBounds } from "../vector/geometry";
import { footageAt, footageMatrix, footageTimeAt, pictureAssetOf } from "./footage";
import { homographyFromQuads, poseFromHomography } from "./pose";
import { readTrack } from "./read";
import { referenceSample } from "./samples";

/**
 * DOCUMENT OPS for trackers and bindings — every mutation the editor performs,
 * kept in core so preview, export and undo share one truth. All mutate in place
 * (call inside a `document-store` update, which snapshots for undo), so a whole
 * gesture collapses to ONE user-visible undo step.
 *
 * Note what is NOT here any more: creating, placing, binding and deleting a
 * "handle" shape clip. A tracker owns its region (see `schema/tracking`), so
 * making one no longer touches a track, a lane or the timeline at all.
 */

/** Find a visual clip by id anywhere in the document. */
export function findVisualClip(doc: MotionDocument, clipId: string): VisualClip | null {
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.id === clipId && isVisualClip(clip)) return clip;
    }
  }
  return null;
}

export function getTracker(doc: MotionDocument, trackerId: string): Tracker | null {
  return doc.trackers.find((t) => t.id === trackerId) ?? null;
}

/** The tracker if it is a REGION tracker — what the 2D verbs (region, pins, runs) act on. */
export function getRegionTracker(doc: MotionDocument, trackerId: string): RegionTracker | null {
  const t = getTracker(doc, trackerId);
  return t?.kind === "region" ? t : null;
}

const SHAPE_LABEL: Record<TrackShape, string> = {
  rect: "Box track",
  ellipse: "Object track",
  polygon: "Polygon track",
  path: "Path track",
};

export const DEFAULT_SOLVE: TrackSolve = {
  method: "auto",
  colors: [],
  channels: ["position", "scale"],
  accuracy: 0.5,
  cadence: { mode: "auto", maxStride: 4, doubtPx: 0.75 },
  analysisEdge: 1280,
  detail: 16,
  adaptive: true,
};

export interface CreateTrackerInput {
  source: TrackSource;
  /** The clip it was drawn on — the placement hint (see `footage.ts`). */
  via?: string | null;
  region: TrackRegion;
  /** Where the region was drawn — the solve's origin. SOURCE ms. */
  referenceMs: number;
  solve?: Partial<TrackSolve>;
  name?: string;
}

/**
 * Create and register a tracker. No samples yet — the solve fills them.
 *
 * `referenceMs` is required rather than defaulted to zero, because defaulting
 * it is precisely the bug v77 removed: a region drawn at four seconds and
 * matched against frame zero is tracking a frame nobody looked at.
 */
export function createTracker(doc: MotionDocument, input: CreateTrackerInput): RegionTracker {
  const tracker: RegionTracker = {
    kind: "region",
    id: createId("tracker"),
    name: input.name ?? `${SHAPE_LABEL[input.region.shape]} ${doc.trackers.length + 1}`,
    color: nextTrackerColor(doc.trackers.length),
    source: input.source,
    via: input.via ?? null,
    region: input.region,
    solve: { ...DEFAULT_SOLVE, ...input.solve },
    samples: [],
    referenceMs: Math.max(0, input.referenceMs),
    analysis: null,
    dirty: true,
  };
  doc.trackers.push(tracker);
  return tracker;
}

/** A default region of a given shape, sized to a fraction of the source box. */
export function defaultRegion(shape: TrackShape, sourceWidth: number, sourceHeight: number): TrackRegion {
  const w = Math.max(24, Math.round(sourceWidth / 4));
  const h = Math.max(24, Math.round(sourceHeight / 4));
  return {
    shape,
    subpaths: toSubpaths(regionFromShape(shape, w, h)),
    feather: Math.round(Math.min(w, h) * 0.1),
    expand: 0,
    invert: false,
  };
}

/** Mark the bake stale and bump the freshness version. One helper, so nothing
 *  edits a tracker and forgets to light up "Re-solve". */
function touch(tracker: Tracker): void {
  tracker.dirty = true;
  // A changed region or solve makes every measured span stale: coverage empties
  // so the next run re-solves everything, while the samples stay readable (and
  // the pins stay pinned) until it does.
  if (tracker.analysis) tracker.analysis = { ...tracker.analysis, version: tracker.analysis.version + 1, coverage: [] };
}

/** Replace the region's geometry (a pen edit, a resize, a shape swap). */
export function setTrackerRegion(doc: MotionDocument, trackerId: string, patch: Partial<TrackRegion>): void {
  const tracker = getRegionTracker(doc, trackerId);
  if (!tracker) return;
  tracker.region = { ...tracker.region, ...patch };
  // Matte-only fields describe the EDGE, not the match — changing a feather must
  // not demand a re-solve, or the affordance cries wolf and stops being read.
  const geometryChanged = patch.subpaths != null || patch.shape != null;
  if (geometryChanged) touch(tracker);
}

/** Change the solve settings (method, channels, accuracy, detail). */
export function setTrackerSolve(doc: MotionDocument, trackerId: string, patch: Partial<TrackSolve>): void {
  const tracker = getRegionTracker(doc, trackerId);
  if (!tracker) return;
  tracker.solve = { ...tracker.solve, ...patch };
  touch(tracker);
}

/** Move the reference frame — re-seed the solve from where you are now. */
export function setTrackerReference(doc: MotionDocument, trackerId: string, referenceMs: number): void {
  const tracker = getRegionTracker(doc, trackerId);
  if (!tracker) return;
  tracker.referenceMs = Math.max(0, referenceMs);
  touch(tracker);
}

/**
 * Pin channels at a time — a hand correction. Anything not supplied is read
 * from the interpolated track, so fixing the position leaves the scale alone.
 */
export function pinTrackSample(
  doc: MotionDocument,
  trackerId: string,
  timeMs: number,
  channels: TrackChannel[],
  patch: Parameters<typeof pinSample>[3],
): void {
  const tracker = getRegionTracker(doc, trackerId);
  if (!tracker) return;
  pinSample(tracker, timeMs, channels, patch);
  tracker.dirty = true;
}

/** Release a correction (all channels, or some). */
export function unpinTrackSample(
  doc: MotionDocument,
  trackerId: string,
  timeMs: number,
  channels?: TrackChannel[],
): void {
  const tracker = getRegionTracker(doc, trackerId);
  if (!tracker) return;
  unpinSample(tracker, timeMs, channels);
  tracker.dirty = true;
}

/**
 * Commit a run's samples, preserving the user's pinned channels
 * (`mergeAnchors`) and widening coverage by the spans the run solved. Samples
 * outside `solved` are kept as they were — a run that tracked forward from the
 * playhead leaves everything behind it alone. The reference is NOT moved.
 */
export function commitTrackerRun(
  doc: MotionDocument,
  trackerId: string,
  fresh: TrackSample[],
  solved: TrackSpan[],
  engine = "cpu",
): void {
  const tracker = getRegionTracker(doc, trackerId);
  if (!tracker) return;
  const inSolved = (t: number) => solved.some(([a, b]) => t >= a - 0.5 && t <= b + 0.5);
  const keep = tracker.samples.filter((s) => !inSolved(s.timeMs) || s.pinned.length > 0);
  const merged = mergeAnchors(keep, [...fresh, ...keep.filter((s) => s.pinned.length === 0)]);
  tracker.samples = dedupeByTime(merged);
  const coverage = mergeSpans([...(tracker.analysis?.coverage ?? []), ...solved]);
  tracker.analysis = {
    version: tracker.analysis?.version ?? 0,
    engine,
    coverage,
    at: Date.now(),
  };
  tracker.dirty = false;
}

/** Forget every measurement (pins kept) — "Clear track". */
export function clearTrackerSamples(doc: MotionDocument, trackerId: string): void {
  const tracker = getTracker(doc, trackerId);
  if (!tracker) return;
  if (tracker.kind === "camera") tracker.solution = null;
  else if (tracker.kind === "depth") tracker.maps = null;
  else tracker.samples = tracker.samples.filter((s) => s.pinned.length > 0);
  if (tracker.analysis) tracker.analysis = { ...tracker.analysis, coverage: [] };
  tracker.dirty = true;
}

/** Sorted, merged, non-overlapping spans. */
export function mergeSpans(spans: TrackSpan[]): TrackSpan[] {
  const sorted = spans.filter(([a, b]) => b >= a).sort((x, y) => x[0] - y[0]);
  const out: TrackSpan[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** The parts of `[from, to]` that `coverage` does not hold — what a resumed run still has to solve. */
export function uncoveredSpans(coverage: TrackSpan[], from: number, to: number): TrackSpan[] {
  const out: TrackSpan[] = [];
  let cursor = from;
  for (const [a, b] of mergeSpans(coverage)) {
    if (b < cursor) continue;
    if (a > to) break;
    if (a > cursor) out.push([cursor, Math.min(a, to)]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < to) out.push([cursor, to]);
  return out;
}

function dedupeByTime(samples: TrackSample[]): TrackSample[] {
  const out: TrackSample[] = [];
  for (const s of samples) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.timeMs - s.timeMs) < 0.5) {
      // A pin beats a measurement at the same instant.
      if (s.pinned.length >= last.pinned.length) out[out.length - 1] = s;
    } else out.push(s);
  }
  return out;
}

/** Clip ids whose transform is currently driven by a tracker. */
export function clipsBoundToTracker(doc: MotionDocument, trackerId: string): string[] {
  const ids: string[] = [];
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (isVisualClip(clip) && clip.trackBinding?.trackerId === trackerId) ids.push(clip.id);
    }
  }
  return ids;
}

/**
 * Remove a tracker, unbinding every clip AND detaching every grade window that
 * referenced it. A dangling reference in a grade would key nothing and look like
 * a broken correction, which is worse than a window that fell back to its shape.
 */
export function removeTracker(doc: MotionDocument, trackerId: string): void {
  const i = doc.trackers.findIndex((t) => t.id === trackerId);
  if (i === -1) return;
  doc.trackers.splice(i, 1);
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (isVisualClip(clip) && clip.trackBinding?.trackerId === trackerId) clip.trackBinding = null;
    }
  }
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      const effects = (clip as Partial<VisualClip>).effects;
      if (!effects) continue;
      for (const e of effects) {
        if (e.type !== "grade") continue;
        for (const node of e.graph.nodes) {
          if (node.kind !== "corrector") continue;
          node.key.windows = node.key.windows.filter(
            (w) => !((w.source.type === "tracker" || w.source.type === "depth") && w.source.trackerId === trackerId),
          );
        }
      }
    }
  }
}

/** Make a clip follow a tracker. */
export function bindClipToTracker(
  doc: MotionDocument,
  clipId: string,
  trackerId: string,
  patch?: Partial<TrackBinding>,
): void {
  const clip = findVisualClip(doc, clipId);
  if (!clip) return;
  clip.trackBinding = {
    trackerId,
    channels: patch?.channels ?? ["position"],
    offset: patch?.offset ?? { x: 0, y: 0 },
    smooth: patch?.smooth ?? 0,
    invert: patch?.invert ?? false,
    enabled: patch?.enabled ?? true,
  };
}

/** Update fields of an existing binding. */
export function updateClipBinding(doc: MotionDocument, clipId: string, patch: Partial<TrackBinding>): void {
  const clip = findVisualClip(doc, clipId);
  if (!clip?.trackBinding) return;
  clip.trackBinding = { ...clip.trackBinding, ...patch };
}

/** Drop a clip's track binding (stop following). */
export function unbindClip(doc: MotionDocument, clipId: string): void {
  const clip = findVisualClip(doc, clipId);
  if (clip) clip.trackBinding = null;
}

/**
 * Flatten a follow into ordinary keyframes — one per frame of the follower's
 * span, at the comp's rate — and drop the binding. The keys are exactly what
 * the live follow resolved, because they come from the same writes.
 */
export function flattenTrackBinding(doc: MotionDocument, clipId: string): boolean {
  const clip = findVisualClip(doc, clipId);
  if (!clip?.trackBinding) return false;
  const step = 1000 / Math.max(1, compFps(doc, clip.frameId));
  const keys: Array<[number, ReadonlyArray<readonly [string, number]>]> = [];
  for (let t = clip.startMs; t < clip.startMs + clip.durationMs; t += step) {
    const local = clipLocalTime(clip, t);
    if (local === null) continue;
    keys.push([local, followWrites(doc, clip, clip.frameId, t)]);
  }
  clip.trackBinding = null;
  for (const [local, writes] of keys) for (const [path, value] of writes) setKeyframe(clip.keyframes, path, local, value);
  return true;
}

/** True when a clip is currently following a tracker (for chrome/badges). */
export function isClipTracked(clip: Clip): boolean {
  return isVisualClip(clip) && clip.trackBinding != null && clip.trackBinding.enabled;
}

/** The tracked pose at a source time, for overlays and readouts. */
export function trackerPoseAt(tracker: RegionTracker, sourceMs: number): TrackSample | null {
  return sampleTracker(tracker, sourceMs);
}

// ── Speed ↔ accuracy: the one dial ───────────────────────────────────────────

export type TrackQuality = "fast" | "balanced" | "precise" | "exact";

/**
 * The stops of the Speed ↔ Accuracy dial — each one writes every knob it
 * stands for, and `qualityOf` reads the dial back off the knobs ("custom" once
 * someone has moved one by hand). One table, so the panel, the API and the
 * skill name the same four settings.
 */
export const TRACK_QUALITIES: Record<TrackQuality, Pick<TrackSolve, "accuracy" | "cadence" | "analysisEdge">> = {
  fast: { accuracy: 0.3, cadence: { mode: "auto", maxStride: 8, doubtPx: 1.5 }, analysisEdge: 720 },
  balanced: { accuracy: 0.5, cadence: { mode: "auto", maxStride: 4, doubtPx: 0.75 }, analysisEdge: 1280 },
  precise: { accuracy: 0.75, cadence: { mode: "auto", maxStride: 2, doubtPx: 0.4 }, analysisEdge: 1920 },
  exact: { accuracy: 1, cadence: { mode: "every", maxStride: 1, doubtPx: 0.25 }, analysisEdge: 0 },
};

export function qualityOf(solve: TrackSolve): TrackQuality | "custom" {
  for (const [id, q] of Object.entries(TRACK_QUALITIES) as Array<[TrackQuality, (typeof TRACK_QUALITIES)[TrackQuality]]>) {
    if (
      q.accuracy === solve.accuracy &&
      q.analysisEdge === solve.analysisEdge &&
      q.cadence.mode === solve.cadence.mode &&
      q.cadence.maxStride === solve.cadence.maxStride &&
      q.cadence.doubtPx === solve.cadence.doubtPx
    )
      return id;
  }
  return "custom";
}

// ── Authoring in COMP space ──────────────────────────────────────────────────

export interface CompRegion {
  shape: TrackShape;
  /** Centre in comp (frame-centre-local) px — where the stage and `view.render` put it. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees, on screen. */
  rotation?: number;
  /**
   * The outline as DRAWN (a pen or polygon region), centred on `x, y`, comp px.
   * Absent = the parametric `shape` at `width × height`. Carried into source
   * pixels through the placement's inverse — handles included — so what you
   * traced on screen is exactly what is tracked.
   */
  contours?: Contour[];
}

/**
 * Create a tracker from a region drawn ON SCREEN: on the footage layer `clipId`,
 * at comp time `compMs`. The region is carried into the footage's own pixels
 * and time through the clip's placement and time map, so the stage, the API
 * and a person all draw in the space they see. The drawn pose becomes the
 * reference sample, pinned — it is the one frame known to be right.
 */
export function createTrackerAt(
  doc: MotionDocument,
  input: { clipId: string; compMs: number; region: CompRegion; solve?: Partial<TrackSolve>; name?: string },
): RegionTracker | null {
  const clip = findVisualClip(doc, input.clipId);
  const assetId = clip ? pictureAssetOf(clip) : null;
  if (!clip || !assetId) return null;
  const sourceMs = footageTimeAt(doc, clip, input.compMs);
  if (sourceMs === null) return null;
  const M = footageMatrix(doc, clip, input.compMs);
  const k = Math.sqrt(Math.abs(M.a * M.d - M.b * M.c)) || 1;
  const footRot = (Math.atan2(M.b, M.a) * 180) / Math.PI;
  const c = applyInverse(M, { x: input.region.x, y: input.region.y });
  const drawn = input.region.contours?.length ? contoursToSource(input.region.contours, input.region, M, c) : null;
  const region: TrackRegion = {
    shape: input.region.shape,
    subpaths: toSubpaths(drawn ?? regionFromShape(input.region.shape, Math.max(4, input.region.width / k), Math.max(4, input.region.height / k))),
    feather: 0,
    expand: 0,
    invert: false,
  };
  const tracker = createTracker(doc, {
    source: { kind: "asset", assetId },
    via: clip.id,
    region,
    referenceMs: sourceMs,
    solve: input.solve,
    name: input.name,
  });
  tracker.samples = [
    { timeMs: sourceMs, x: c.x, y: c.y, scale: 1, scaleY: null, rotation: drawn ? 0 : (input.region.rotation ?? 0) - footRot, skew: 0, perspective: null, warp: null, confidence: 1, pinned: ["position"] },
  ];
  return tracker;
}

/**
 * A drawn outline (comp px, centred on `at`) → region-local source px about the
 * source centre `c`. Anchors and handles are both absolute positions, so both
 * go through the inverse placement. The pose's rotation is then 0 — the
 * orientation is in the points.
 */
function contoursToSource(contours: Contour[], at: Vec2, M: Mat2D, c: Vec2): Contour[] {
  const local = (p: Vec2): Vec2 => {
    const s = applyInverse(M, { x: at.x + p.x, y: at.y + p.y });
    return { x: s.x - c.x, y: s.y - c.y };
  };
  return contours.map((ct) => ({
    closed: true,
    points: ct.points.map((p) => ({ ...p, ...local(p), hIn: p.hIn ? local(p.hIn) : null, hOut: p.hOut ? local(p.hOut) : null })),
  }));
}

/**
 * A HAND CORRECTION at a comp instant, in comp space: move the tracked point
 * to `position`, and/or pin the surface's four `corners` (top-left, top-right,
 * bottom-right, bottom-left). Pins only what was given; the solver keeps the
 * rest. Returns the source time pinned — the `around` a re-solve should use —
 * or null when the footage is not on screen then.
 */
export function correctTrackerAt(
  doc: MotionDocument,
  trackerId: string,
  compId: string,
  compMs: number,
  fix: { position?: Vec2; corners?: [Vec2, Vec2, Vec2, Vec2]; rotation?: number; scale?: number },
): number | null {
  const tracker = getRegionTracker(doc, trackerId);
  if (!tracker) return null;
  const view = footageAt(doc, tracker, compId, compMs);
  if (!view) return null;
  const at = sampleTracker(tracker, view.sourceMs);
  if (fix.corners) {
    const b = subpathBounds(tracker.region.subpaths);
    if (!b) return null;
    const from = [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }];
    const H = homographyFromQuads(from, fix.corners.map((p) => applyInverse(view.toComp, p)));
    const pose = H ? poseFromHomography(H) : null;
    if (!pose) return null;
    pinSample(tracker, view.sourceMs, ["position", "scale", "rotation", "skew", "perspective"], {
      x: pose.x,
      y: pose.y,
      scale: pose.scale,
      scaleY: pose.scaleY,
      rotation: pose.rotation,
      skew: pose.skew ?? 0,
      perspective: pose.perspective ?? null,
    });
  } else {
    const channels: TrackChannel[] = [];
    const patch: Parameters<typeof pinSample>[3] = {};
    if (fix.position) {
      const p = applyInverse(view.toComp, fix.position);
      channels.push("position");
      patch.x = p.x;
      patch.y = p.y;
    }
    if (fix.rotation != null && at) {
      channels.push("rotation");
      patch.rotation = (referenceSample(tracker)?.rotation ?? 0) + fix.rotation;
    }
    if (fix.scale != null && at) {
      channels.push("scale");
      patch.scale = (referenceSample(tracker)?.scale ?? 1) * fix.scale;
    }
    if (channels.length === 0) return null;
    pinSample(tracker, view.sourceMs, channels, patch);
  }
  tracker.dirty = true;
  return view.sourceMs;
}

/**
 * Make a layer follow a tracker WITHOUT JUMPING: the offset is whatever keeps
 * it exactly where it is at `compMs` (pass `snap` to put it on the point
 * instead). Stabilise is the footage following its own tracker, inverted.
 */
export function followTracker(
  doc: MotionDocument,
  clipId: string,
  trackerId: string,
  compMs: number,
  patch: Partial<TrackBinding> & { snap?: boolean } = {},
): boolean {
  const clip = findVisualClip(doc, clipId);
  const tracker = getTracker(doc, trackerId);
  if (!clip || !tracker) return false;
  const { snap, ...binding } = patch;
  let offset = binding.offset ?? { x: 0, y: 0 };
  const channels = binding.channels ?? ["position"];
  if (!snap && !binding.offset && !binding.invert && channels.includes("position")) {
    const here = readTrack(doc, tracker, "position", { compId: clip.frameId, compMs });
    if (here && typeof here === "object") {
      const local = clipLocalTime(clip, compMs) ?? 0;
      const x = channelValueAt(clip, "x", local);
      const y = channelValueAt(clip, "y", local);
      offset = { x: (typeof x === "number" ? x : clip.transform.x) - here.x, y: (typeof y === "number" ? y : clip.transform.y) - here.y };
    }
  }
  bindClipToTracker(doc, clipId, trackerId, { ...binding, channels, offset });
  return true;
}
