import type { MotionDocument, Clip, VisualClip } from "../schema";
import type { CameraTracker, TrackBinding, Tracker } from "../schema/tracking";
import type { Vec2 } from "../schema/common";
import { isVisualClip } from "../clip-registry";
import { channelValueAt } from "../animation/channels";
import { clipLocalTime } from "../animation/evaluate";
import { groupChainMatrix } from "../timeline/group-space";
import { apply, applyInverse, IDENTITY } from "../navigation/matrix";
import { bakeClipValues } from "../nodes/resolve-clip";
import { regionReadout, type RegionReadout } from "./read";
import { cameraReadout } from "./camera/read-camera";

/**
 * THE FOLLOW — a layer riding a tracker, resolved into the document.
 *
 * This used to happen inside the renderer, after every other reader had
 * looked: the sticker drew on the face while its selection handles, its hit
 * box, the inspector and `layer("Sticker").x` all still said where it had been
 * placed. It now resolves where every driven value resolves — `resolvedDocAt`,
 * through `bakeClipValues` — so the followed pose is simply the layer's pose.
 *
 * Channels: position is ABSOLUTE (the tracked centre + `offset`, mapped into
 * the follower's own parent space so a follower inside a group still lands on
 * the point); scale, rotation and skew are RELATIVE to the frame the region
 * was drawn on, composed onto the follower's own keys. `perspective` is not
 * baked here — no transform field can hold a plane — the renderer carries the
 * layer on the plane through `trackPlaneMotion`, the same reader.
 *
 * `invert` is stabilisation: the footage counter-moves so the tracked point
 * holds where it was on the reference frame.
 */

/** Is anything in the document following a tracker that exists? Cheap gate for `resolvedDocAt`. */
export function documentHasFollowers(doc: MotionDocument): boolean {
  if (doc.trackers.length === 0) return false;
  for (const track of doc.tracks)
    for (const clip of track.clips) if (isVisualClip(clip) && clip.trackBinding?.enabled) return true;
  return false;
}

/** Resolve every follower in one comp at one comp instant. Untouched clips keep their identity. */
export function applyTrackFollow(doc: MotionDocument, compId: string, compMs: number): MotionDocument {
  if (!documentHasFollowers(doc)) return doc;
  let changedAny = false;
  const tracks = doc.tracks.map((track) => {
    let changed = false;
    const clips = track.clips.map((clip) => {
      if (clip.frameId !== compId || !isVisualClip(clip)) return clip;
      const binding = clip.trackBinding;
      if (!binding?.enabled) return clip;
      const tracker = doc.trackers.find((t) => t.id === binding.trackerId);
      if (!tracker) return clip;
      const next = followClip(doc, clip, tracker, binding, compId, compMs);
      if (next !== clip) changed = true;
      return next;
    });
    if (!changed) return track;
    changedAny = true;
    return { ...track, clips };
  });
  return changedAny ? { ...doc, tracks } : doc;
}

function followClip(
  doc: MotionDocument,
  clip: VisualClip,
  tracker: Tracker,
  binding: TrackBinding,
  compId: string,
  compMs: number,
): Clip {
  return bakeClipValues(clip, writesFor(doc, clip, tracker, binding, compId, compMs));
}

/**
 * What a follower's channels resolve to at one comp instant, as property
 * writes — the live follow bakes them, `flattenTrackBinding` keys them. Empty
 * when the clip follows nothing readable.
 */
export function followWrites(doc: MotionDocument, clip: VisualClip, compId: string, compMs: number): Writes {
  const binding = clip.trackBinding;
  const tracker = binding ? doc.trackers.find((t) => t.id === binding.trackerId) : undefined;
  return binding && tracker ? writesFor(doc, clip, tracker, binding, compId, compMs) : [];
}

function writesFor(
  doc: MotionDocument,
  clip: VisualClip,
  tracker: Tracker,
  binding: TrackBinding,
  compId: string,
  compMs: number,
): Writes {
  if (tracker.kind === "camera") return cameraWrites(doc, clip, tracker, binding, compId, compMs);
  // Depth places nothing: it is read by mattes, fog, blur and reliefs, never followed.
  if (tracker.kind === "depth") return [];
  const r = regionReadout(doc, tracker, { compId, compMs, smooth: binding.smooth });
  if (!r) return [];
  const local = clipLocalTime(clip, compMs) ?? 0;
  const base = (path: string, fallback: number) => {
    const v = channelValueAt(clip, path, local);
    return typeof v === "number" ? v : fallback;
  };
  return binding.invert ? stabilize(doc, clip, r, binding, base, compMs) : follow(doc, clip, r, binding, base, compMs);
}

export type Writes = Array<readonly [string, number]>;

/**
 * A world camera riding a camera solve: its placement IS the solved camera
 * (absolute — a match-moved camera has no "offset" worth keeping), and with
 * `lens` its focal length too. Only a camera clip takes the lens; any other
 * layer following a camera solve rides along as an object would (a light
 * clamped to the camera, a HUD card).
 */
function cameraWrites(doc: MotionDocument, clip: VisualClip, tracker: CameraTracker, binding: TrackBinding, compId: string, compMs: number): Writes {
  const r = cameraReadout(doc, tracker, compId, compMs);
  if (!r) return [];
  const has = (c: TrackBinding["channels"][number]) => binding.channels.includes(c);
  const writes: Writes = [];
  if (has("position")) writes.push(["x", r.position[0]], ["y", r.position[1]], ["z", r.position[2]]);
  if (has("rotation")) writes.push(["rotationX", r.rotation[0]], ["rotationY", r.rotation[1]], ["rotation", r.rotation[2]]);
  if (has("lens") && clip.kind === "camera") writes.push(["camera.focalLength", r.focalLength]);
  return writes;
}
type Base = (path: string, fallback: number) => number;

function follow(doc: MotionDocument, clip: VisualClip, r: RegionReadout, binding: TrackBinding, base: Base, compMs: number): Writes {
  const writes: Writes = [];
  const has = (c: TrackBinding["channels"][number]) => binding.channels.includes(c);
  if (has("position")) {
    const target = { x: r.position.x + binding.offset.x, y: r.position.y + binding.offset.y };
    const p = intoParentSpace(doc, clip, target, compMs);
    writes.push(["x", p.x], ["y", p.y]);
  }
  if (has("scale")) {
    const s = base("scale", clip.transform.scale);
    writes.push(["scale", s * r.scaleX]);
    // A uniform follower stays uniform unless the track itself squashed.
    if (clip.transform.scaleY != null || Math.abs(r.scaleX - r.scaleY) > 1e-3) {
      writes.push(["scaleY", base("scaleY", clip.transform.scaleY ?? s) * r.scaleY]);
    }
  }
  if (has("rotation")) writes.push(["rotation", base("rotation", clip.transform.rotation) + r.rotation]);
  if (has("skew")) writes.push(["skewX", base("skewX", clip.transform.skewX) + r.skew]);
  return writes;
}

/**
 * Counter-move the plate about the tracked point. Position alone is a
 * translation by the point's travel; with rotation and scale on, the plate also
 * turns and scales about the point so it holds still, which is what a person
 * means by "stabilise the horizon".
 */
function stabilize(doc: MotionDocument, clip: VisualClip, r: RegionReadout, binding: TrackBinding, base: Base, compMs: number): Writes {
  const has = (c: TrackBinding["channels"][number]) => binding.channels.includes(c);
  const now = r.position;
  const ref = apply(r.view.toComp, { x: r.reference.x, y: r.reference.y });
  const dRot = has("rotation") ? -r.rotation : 0;
  const k = has("scale") ? 1 / Math.max(1e-3, (r.scaleX + r.scaleY) / 2) : 1;
  const chain = groupChainMatrix(doc, clip.id, (g) => clipLocalTime(g, compMs) ?? 0);
  const pivot = apply(chain, { x: base("x", clip.transform.x), y: base("y", clip.transform.y) });
  const rad = (dRot * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = (pivot.x - now.x) * k;
  const dy = (pivot.y - now.y) * k;
  // Without the position channel the point is allowed to travel; only its turn and size are held.
  const centre = has("position") ? ref : now;
  const p = applyInverse(chain, { x: centre.x + dx * cos - dy * sin, y: centre.y + dx * sin + dy * cos });
  const writes: Writes = [
    ["x", p.x],
    ["y", p.y],
  ];
  if (dRot !== 0) writes.push(["rotation", base("rotation", clip.transform.rotation) + dRot]);
  if (k !== 1) writes.push(["scale", base("scale", clip.transform.scale) * k]);
  return writes;
}

/** A comp-space point as the position a clip must hold for its pivot to land there (group chain undone). */
function intoParentSpace(doc: MotionDocument, clip: VisualClip, p: Vec2, compMs: number): Vec2 {
  const chain = groupChainMatrix(doc, clip.id, (g) => clipLocalTime(g, compMs) ?? 0);
  return chain === IDENTITY ? p : applyInverse(chain, p);
}
