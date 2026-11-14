import type { MotionDocument, VisualClip } from "../schema";
import { clipSourcePhaseAt } from "../timeline/ops";
import type { Contour } from "../schema/vector";
import type { Vec2 } from "../schema/common";
import type { RegionTracker, Tracker, TrackerKind, TrackSample } from "../schema/tracking";
import { subpathBounds } from "../vector/geometry";
import { apply, type Mat2D } from "../navigation/matrix";
import { contourAtPose } from "./contour";
import { clipShowsSource, footageAt, sourceToLocalMatrix, type FootageView } from "./footage";
import { referenceSample, sampleTracker, solvedAt } from "./samples";
import { cameraReadout, type CameraReadout } from "./camera/read-camera";
import { nearestTime } from "./depth/frame";
import { invertHomography, multiplyHomography, poseHomography, poseOf, posePoint, shortestArc, type Homography } from "./pose";

/**
 * THE ONE READER — what a tracker says at a comp instant, in that comp's space.
 *
 * Every consumer asks here: a layer following a track (`follow.ts`), the
 * `track()` expression, the Track node, a grade's power window, the stage
 * overlay, `track.inspect`. So a sticker, a sentence and a graph reading the
 * same tracker cannot disagree, and a fix to the maths is a fix everywhere.
 *
 * What can be read is a READINGS table per kind — the `SOUND_FEATURES` pattern:
 * the Track node's outputs, the expression members, autocomplete and the API's
 * vocabulary are all this list. Reading ids are written into documents
 * (`track("Face").topLeft`), so they can be added to, never renamed.
 */

export type TrackReadingType = "vec2" | "float" | "bool";

export interface TrackReadingDef {
  id: string;
  label: string;
  type: TrackReadingType;
  describe: string;
}

export type TrackValue = number | boolean | Vec2;

/** A region reading: its public face plus how it is read off the readout. */
export interface RegionReadingDef extends TrackReadingDef {
  read(r: RegionReadout): TrackValue;
}

/** What a region tracker answers. Positions are in the consumer comp's space (where `transform.x/y` live). */
export const REGION_READINGS: readonly RegionReadingDef[] = [
  { id: "position", label: "Position", type: "vec2", read: (r) => r.position, describe: "Where the tracked thing's centre is, in this comp’s space — set a layer’s position to it to stick it on." },
  { id: "x", label: "X", type: "float", read: (r) => r.position.x, describe: "The centre's x." },
  { id: "y", label: "Y", type: "float", read: (r) => r.position.y, describe: "The centre's y." },
  { id: "scale", label: "Scale", type: "float", read: (r) => (r.scaleX + r.scaleY) / 2, describe: "How much bigger it is than on the frame it was drawn — 1 = the same." },
  { id: "scaleX", label: "Scale X", type: "float", read: (r) => r.scaleX, describe: "Width change since the drawn frame." },
  { id: "scaleY", label: "Scale Y", type: "float", read: (r) => r.scaleY, describe: "Height change since the drawn frame." },
  { id: "rotation", label: "Rotation", type: "float", read: (r) => r.rotation, describe: "Degrees turned since the drawn frame." },
  { id: "skew", label: "Skew", type: "float", read: (r) => r.skew, describe: "Degrees sheared since the drawn frame — a surface seen at an angle." },
  { id: "topLeft", label: "Top left", type: "vec2", read: (r) => r.corners[0], describe: "The tracked surface's top-left corner — a corner pin's first point." },
  { id: "topRight", label: "Top right", type: "vec2", read: (r) => r.corners[1], describe: "The tracked surface's top-right corner." },
  { id: "bottomRight", label: "Bottom right", type: "vec2", read: (r) => r.corners[2], describe: "The tracked surface's bottom-right corner." },
  { id: "bottomLeft", label: "Bottom left", type: "vec2", read: (r) => r.corners[3], describe: "The tracked surface's bottom-left corner." },
  { id: "confidence", label: "Confidence", type: "float", read: (r) => r.confidence, describe: "How sure the track is here, 0–1. Fade something out where a track is weak." },
  { id: "solved", label: "Measured", type: "bool", read: (r) => r.solved, describe: "True on a frame the tracker actually measured; false where it is interpolated between two." },
];

/**
 * THE KINDS — one entry per tracker kind, typed as a Record over the schema's
 * union so adding an arm (camera, depth) does not compile until it says what
 * it can be read for.
 */
export interface TrackKindDef {
  label: string;
  readings: readonly TrackReadingDef[];
}

/** What a camera solve answers — the solved camera in the consumer comp's WORLD (a world comp showing the plate). */
export interface CameraReadingDef extends TrackReadingDef {
  read(r: CameraReadout): TrackValue;
}

export const CAMERA_READINGS: readonly CameraReadingDef[] = [
  { id: "x", label: "X", type: "float", read: (r) => r.position[0], describe: "The camera's x in the world." },
  { id: "y", label: "Y", type: "float", read: (r) => r.position[1], describe: "The camera's y in the world (depth away from the start)." },
  { id: "z", label: "Z", type: "float", read: (r) => r.position[2], describe: "The camera's height in the world." },
  { id: "rotationX", label: "Tilt", type: "float", read: (r) => r.rotation[0], describe: "Rotation about X, degrees (Blender XYZ) — 90 looks level." },
  { id: "rotationY", label: "Roll", type: "float", read: (r) => r.rotation[1], describe: "Rotation about Y, degrees." },
  { id: "rotation", label: "Pan", type: "float", read: (r) => r.rotation[2], describe: "Rotation about Z (up), degrees." },
  { id: "focalLength", label: "Lens", type: "float", read: (r) => r.focalLength, describe: "The solved lens in mm on a 36 mm sensor across the frame's long side." },
  { id: "error", label: "Error", type: "float", read: (r) => r.error, describe: "How far the solve's points land from where they were seen here, px — under 1 is a good solve." },
  { id: "solved", label: "Measured", type: "bool", read: (r) => r.solved, describe: "True on a frame the solve placed; false across a gap it interpolates." },
];

/** What a depth tracker answers as values — little: its maps are read by effects, mattes and reliefs (`depthForClip`). */
export const DEPTH_READINGS: readonly TrackReadingDef[] = [
  { id: "solved", label: "Measured", type: "bool", describe: "True where the footage has a depth map at this instant." },
];

export const TRACK_KINDS: Record<TrackerKind, TrackKindDef> = {
  region: { label: "Track", readings: REGION_READINGS },
  camera: { label: "Camera", readings: CAMERA_READINGS },
  depth: { label: "Depth", readings: DEPTH_READINGS },
};

export function trackReadings(tracker: Pick<Tracker, "kind">): readonly TrackReadingDef[] {
  return TRACK_KINDS[tracker.kind].readings;
}

export function trackReadingDef(kind: TrackerKind, id: string): TrackReadingDef | undefined {
  return TRACK_KINDS[kind].readings.find((r) => r.id === id);
}

/** Where a reading is asked from: the consumer's comp and its comp time. */
export interface TrackAt {
  compId: string;
  compMs: number;
  /** 0..1 jitter smoothing over neighbouring measurements (a follower's `smooth`). */
  smooth?: number;
}

/**
 * Everything a region tracker says at one instant, in comp space — computed
 * once and read field by field (an expression reading `.x`, `.y` and
 * `.rotation` pays for one placement, not three).
 */
export interface RegionReadout {
  view: FootageView;
  sample: TrackSample;
  reference: TrackSample;
  position: Vec2;
  scaleX: number;
  scaleY: number;
  rotation: number;
  skew: number;
  corners: [Vec2, Vec2, Vec2, Vec2];
  confidence: number;
  solved: boolean;
}

const memo = new WeakMap<MotionDocument, Map<string, RegionReadout | null>>();
const MEMO_LIMIT = 512;

/** The full readout, or null when the tracker has no data or no clip shows its footage then. */
export function regionReadout(doc: MotionDocument, tracker: RegionTracker, at: TrackAt): RegionReadout | null {
  const key = `${tracker.id}|${at.compId}|${at.compMs}|${at.smooth ?? 0}`;
  let cache = memo.get(doc);
  if (!cache) memo.set(doc, (cache = new Map()));
  if (cache.has(key)) return cache.get(key)!;
  const out = computeReadout(doc, tracker, at);
  if (cache.size >= MEMO_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, out);
  return out;
}

function computeReadout(doc: MotionDocument, tracker: RegionTracker, at: TrackAt): RegionReadout | null {
  if (tracker.samples.length === 0) return null;
  const view = footageAt(doc, tracker, at.compId, at.compMs);
  if (!view) return null;
  const sample = smoothedSample(tracker, view.sourceMs, at.smooth ?? 0);
  const reference = referenceSample(tracker);
  if (!sample || !reference) return null;
  const pose = poseOf(sample);
  const b = subpathBounds(tracker.region.subpaths) ?? { minX: -0.5, minY: -0.5, maxX: 0.5, maxY: 0.5 };
  const corner = (x: number, y: number) => apply(view.toComp, posePoint({ x, y }, pose));
  const refScaleY = reference.scaleY ?? reference.scale;
  return {
    view,
    sample,
    reference,
    position: apply(view.toComp, { x: sample.x, y: sample.y }),
    scaleX: reference.scale > 0 ? sample.scale / reference.scale : 1,
    scaleY: refScaleY > 0 ? (sample.scaleY ?? sample.scale) / refScaleY : 1,
    rotation: sample.rotation - reference.rotation,
    skew: (sample.skew ?? 0) - (reference.skew ?? 0),
    corners: [corner(b.minX, b.minY), corner(b.maxX, b.minY), corner(b.maxX, b.maxY), corner(b.minX, b.maxY)],
    confidence: sample.pinned.length ? 1 : sample.confidence,
    solved: solvedAt(tracker, view.sourceMs),
  };
}

/** One reading. Null when nothing can be said (no data, footage not on screen, unknown id). */
export function readTrack(doc: MotionDocument, tracker: Tracker, reading: string, at: TrackAt): TrackValue | null {
  switch (tracker.kind) {
    case "region": {
      const def = REGION_READINGS.find((d) => d.id === reading);
      const r = def ? regionReadout(doc, tracker, at) : null;
      return def && r ? def.read(r) : null;
    }
    case "camera": {
      const def = CAMERA_READINGS.find((d) => d.id === reading);
      const r = def ? cameraReadout(doc, tracker, at.compId, at.compMs) : null;
      return def && r ? def.read(r) : null;
    }
    case "depth": {
      if (reading !== "solved") return null;
      const view = footageAt(doc, tracker, at.compId, at.compMs);
      if (!view || !tracker.maps) return view ? false : null;
      const t = nearestTime(tracker.maps.times, view.sourceMs);
      return Math.abs(t - view.sourceMs) < 40;
    }
  }
}

/** The value a reading has when nothing can be said — what an expression sees before a track exists. */
export function emptyReading(type: TrackReadingType): TrackValue {
  return type === "vec2" ? { x: 0, y: 0 } : type === "bool" ? false : 0;
}

// ── Non-scalar readings: the matte and the plane ─────────────────────────────

/**
 * THE MATTE READING — the tracked outline in comp space at one instant. What a
 * grade's power window draws, warp and all.
 */
export function trackContour(doc: MotionDocument, tracker: Tracker, at: TrackAt): Contour[] | null {
  if (tracker.kind !== "region") return null;
  const r = regionReadout(doc, tracker, at);
  if (!r) return null;
  const m = r.view.toComp;
  const map = (p: Vec2) => apply(m, p);
  return contourAtPose(tracker.region, poseOf(r.sample)).map((c) => ({
    closed: c.closed,
    points: c.points.map((p) => ({
      ...p,
      ...map(p),
      hIn: p.hIn ? map(p.hIn) : null,
      hOut: p.hOut ? map(p.hOut) : null,
    })),
  }));
}

/**
 * The tracked outline in a CLIP'S OWN local space at a clip-local time — what a
 * pass running inside that layer's buffer (a grade window on the footage
 * itself) draws. Null unless the clip shows the tracker's source.
 */
export function trackContourInClip(doc: MotionDocument, tracker: Tracker, clip: VisualClip, localMs: number): Contour[] | null {
  if (tracker.kind !== "region") return null;
  if (!clipShowsSource(clip, tracker.source) || tracker.samples.length === 0) return null;
  const sourceMs = clip.kind === "image" ? 0 : clipSourcePhaseAt(doc, clip, localMs).sourceMs;
  const sample = sampleTracker(tracker, sourceMs);
  if (!sample) return null;
  const m = sourceToLocalMatrix(doc, clip, localMs);
  const map = (p: Vec2) => apply(m, p);
  return contourAtPose(tracker.region, poseOf(sample)).map((c) => ({
    closed: c.closed,
    points: c.points.map((p) => ({ ...p, ...map(p), hIn: p.hIn ? map(p.hIn) : null, hOut: p.hOut ? map(p.hOut) : null })),
  }));
}

/**
 * THE PLANE'S MOTION in comp space since the reference frame — the homography
 * a layer pinned to the surface is drawn through (corner pin): anything placed
 * on the plane at the reference frame is carried exactly as the plane moves,
 * perspective included. Null when there is nothing to read.
 */
export function trackPlaneMotion(doc: MotionDocument, tracker: Tracker, at: TrackAt): Homography | null {
  if (tracker.kind !== "region") return null;
  const r = regionReadout(doc, tracker, at);
  if (!r) return null;
  const Hnow = multiplyHomography(affineAsHomography(r.view.toComp), poseHomography(poseOf(r.sample)));
  const Href = multiplyHomography(affineAsHomography(r.view.toComp), poseHomography(poseOf(r.reference)));
  const inv = invertHomography(Href);
  return inv ? multiplyHomography(Hnow, inv) : null;
}

export function affineAsHomography(m: Mat2D): Homography {
  return [m.a, m.c, m.e, m.b, m.d, m.f, 0, 0, 1];
}

// ── Smoothing ────────────────────────────────────────────────────────────────

/**
 * Average the MEASURED samples in a window around `sourceMs` — a follower's
 * jitter smoothing. Kept on raw samples rather than re-interpolating, so it
 * genuinely de-noises the bake instead of smoothing an already-smooth curve.
 * Aspect, skew, perspective and warp are shape facts and are not averaged.
 */
function smoothedSample(tracker: RegionTracker, sourceMs: number, smooth: number): TrackSample | null {
  const at = sampleTracker(tracker, sourceMs);
  if (!at || smooth <= 0) return at;
  const s = tracker.samples;
  const radius = Math.max(1, Math.round(smooth * 4));
  let ci = 0;
  let bestD = Infinity;
  for (let i = 0; i < s.length; i++) {
    const d = Math.abs(s[i]!.timeMs - sourceMs);
    if (d < bestD) {
      bestD = d;
      ci = i;
    }
  }
  let n = 0;
  let x = 0;
  let y = 0;
  let scale = 0;
  let rot = 0;
  let conf = 0;
  const around = s[ci]!.rotation;
  for (let i = Math.max(0, ci - radius); i <= Math.min(s.length - 1, ci + radius); i++) {
    const k = s[i]!;
    x += k.x;
    y += k.y;
    scale += k.scale;
    // Unwrapped about the centre sample, so 179° and −179° average to 180°, not 0°.
    rot += around + shortestArc(around, k.rotation);
    conf += k.pinned.length ? 1 : k.confidence;
    n++;
  }
  return { ...at, x: x / n, y: y / n, scale: scale / n, rotation: rot / n, confidence: conf / n, pinned: [] };
}
