import type { MotionDocument, Clip, NestedClip, Track, Transform, Transition, Vec2 } from "../schema";
import { basisOfTransform, centerOffset } from "../transform-map";
import { createTrack } from "../factories";
import { isComponentFrame, gcOrphanNestedSources } from "../components";
import { cloneClip, locateClip, reissueClipIds, sortTrackClips } from "./ops";
import { remapTransitions } from "./transitions";

/**
 * Decompose (un-nest) — the headless inverse of `nestClips`, for ANY nested
 * clip. It extracts the source comp's clips back onto the PARENT timeline where
 * they visually/temporally were (pixels & timing don't move), then removes the
 * nested wrapper. Collisions never eat neighbors: the extracted lanes are
 * INSERTED as new tracks at the wrapper's z-position, pushing existing tracks
 * aside. Works uniformly for audio-only (no geometry), video, and mixed comps.
 * A shared/component source is CLONED (other instances stay intact); a private
 * source is MOVED and its now-orphan frame is GC'd.
 */

/**
 * Compose a parent (nested-clip) transform with a child's local transform so the
 * child, re-parented to the outer comp, lands in the exact same place. Inverts
 * the draw-frame nesting math (source content centered under the clip pose):
 * `outer = parent.pos + R(parent.rot)·(child.pos · parent.scale)`, scales
 * multiply, rotations add. `scaleY: null` means "uniform" (mirror `scale`).
 */
export function composeTransforms(
  parent: Transform,
  child: Transform,
  /**
   * World offset from the parent's POSITION to the center of its content — zero
   * for the default center pivot, non-zero once the parent's pivot is moved (its
   * position no longer sits at the middle of the frame it draws). Children are
   * laid out relative to that center, so it has to be added back when they are
   * lifted out. See `centerOffset` in transform-map.
   */
  parentCenterOffset: Vec2 = { x: 0, y: 0 },
): Transform {
  const pScale = parent.scale;
  const pScaleY = parent.scaleY ?? parent.scale;
  const cScale = child.scale;
  const cScaleY = child.scaleY ?? child.scale;
  const rad = (parent.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const lx = child.x * pScale;
  const ly = child.y * pScaleY;
  return {
    x: parent.x + parentCenterOffset.x + (lx * cos - ly * sin),
    y: parent.y + parentCenterOffset.y + (lx * sin + ly * cos),
    scale: cScale * pScale,
    scaleY: child.scaleY == null && parent.scaleY == null ? null : cScaleY * pScaleY,
    rotation: child.rotation + parent.rotation,
    // Skew composes additively — exact when the parent comp is unskewed (the
    // usual case, so a child's shear passes through untouched); a best-effort
    // sum otherwise, in the same spirit as the rotation approximation above.
    skewX: child.skewX + parent.skewX,
    skewY: child.skewY + parent.skewY,
    // The child's pivot is normalized to the CHILD's own box, which un-nesting
    // doesn't change — so it carries over untouched.
    anchor: { ...child.anchor },
  };
}

/** Re-base one extracted child onto the parent comp (mutates the child). */
function rebaseChild(child: Clip, nested: NestedClip, parentCenterOffset: Vec2): void {
  const speed = Math.max(0.01, nested.playback.speed);
  // Time: the child's source time maps to parent output time through the
  // wrapper's trim-in + speed. Loop/reverse are approximated as a forward map.
  const newStart = nested.startMs + (child.startMs - nested.trimInMs) / speed;
  child.startMs = Math.max(0, Math.round(newStart));
  // A fill-duration child spanned the nested comp — pin it to the wrapper's span.
  if (child.fillDuration) {
    child.fillDuration = false;
    child.durationMs = nested.durationMs;
  } else {
    child.durationMs = Math.max(1, Math.round(child.durationMs / speed));
  }
  child.frameId = nested.frameId;

  if (child.kind === "audio") return; // no geometry to compose

  const composed = composeTransforms(nested.transform, child.transform, parentCenterOffset);
  // x/y keyframes: with no parent rotation the axes stay independent (scale +
  // shift). Under rotation the axes couple; keyframed positions on a rotated
  // wrapper are left at their base offset (rare) — the base pose is exact.
  if (nested.transform.rotation === 0) {
    const pScale = nested.transform.scale;
    const pScaleY = nested.transform.scaleY ?? nested.transform.scale;
    for (const kf of child.keyframes) {
      if (kf.property !== "x" && kf.property !== "y") continue;
      const s = kf.property === "x" ? pScale : pScaleY;
      const base = kf.property === "x" ? nested.transform.x : nested.transform.y;
      for (const key of kf.keys) if (typeof key.value === "number") key.value = base + key.value * s;
    }
  }
  child.transform = composed;
}

export function decomposeNestedClip(doc: MotionDocument, clipId: string): boolean {
  const loc = locateClip(doc, clipId);
  if (!loc || loc.clip.kind !== "nested") return false;
  const nested = loc.clip;
  const source = doc.frames.find((f) => f.id === nested.sourceFrameId);
  if (!source) return false;

  // Clone (leave the source intact) when it's a component or referenced by
  // another nested clip; otherwise move the real clips out.
  const referencedElsewhere = doc.tracks.some((t) =>
    t.clips.some((c) => c.kind === "nested" && c.id !== nested.id && c.sourceFrameId === source.id),
  );
  const clone = isComponentFrame(source) || referencedElsewhere;

  // Grab the source comp's clips grouped by their track, in top→bottom order, so
  // the extracted lanes keep their relative stacking.
  const groups: { children: Clip[]; transitions: Transition[] }[] = [];
  for (const track of doc.tracks) {
    const children = track.clips.filter((c) => c.frameId === source.id);
    if (children.length > 0) groups.push({ children, transitions: track.transitions.filter((t) => t.frameId === source.id) });
  }
  if (groups.length === 0) {
    // Empty comp — just drop the wrapper.
    loc.track.clips.splice(loc.clipIndex, 1);
    gcOrphanNestedSources(doc);
    return true;
  }

  // When moving, take the real children off their source tracks FIRST — keyed
  // by clip id, BEFORE `rebaseChild` retargets their frameId to the parent (a
  // frameId-keyed filter would then miss them and leave duplicates behind).
  if (!clone) {
    const childIds = new Set(groups.flatMap((g) => g.children).map((c) => c.id));
    for (const track of doc.tracks) {
      track.clips = track.clips.filter((c) => !childIds.has(c.id));
      track.transitions = track.transitions.filter((t) => t.frameId !== source.id);
    }
  }

  // The wrapper's pivot may sit anywhere; its CONTENT is still centered on the
  // frame, so lifting children out has to add back the pivot→center offset.
  const parentCenterOffset = centerOffset(
    basisOfTransform(nested.transform, { width: source.width, height: source.height, cx: 0, cy: 0 }),
  );
  // Build the new parent lanes (clone fresh, or the now-detached real objects).
  // The cuts between the children come out with them. A transition is a record
  // on the lane naming its two clips, so it has to be carried by the op that
  // knows the lane — left behind, the re-anchor pass would find its clips gone
  // and drop it, and a nested clip released back onto the timeline would lose
  // every dissolve its author put between its clips. Its span is in the
  // source's time, so it stretches through the wrapper's speed like a clip.
  const speed = Math.max(0.01, nested.playback.speed);
  const newTracks: Track[] = groups.map(({ children, transitions }) => {
    const nt = createTrack("Layer", nested.frameId);
    const idMap = new Map<string, string>();
    for (const child of children) {
      const c = clone ? (reissueClipIds(cloneClip(child)) as Clip) : child;
      idMap.set(child.id, c.id);
      rebaseChild(c, nested, parentCenterOffset);
      nt.clips.push(c);
    }
    sortTrackClips(nt);
    nt.transitions = remapTransitions(transitions, idMap, source.id, nested.frameId).map((t) => ({
      ...t,
      durationMs: Math.round(t.durationMs / speed),
      splitMs: Math.round(t.splitMs / speed),
    }));
    return nt;
  });

  // Remove the wrapper and splice the extracted lanes in at its z-position,
  // pushing the existing tracks aside (never overlapping/eating clips).
  const wrapLoc = locateClip(doc, nested.id);
  if (wrapLoc) wrapLoc.track.clips.splice(wrapLoc.clipIndex, 1);
  const insertAt = wrapLoc ? wrapLoc.trackIndex : doc.tracks.length;
  doc.tracks.splice(insertAt, 0, ...newTracks);

  gcOrphanNestedSources(doc);
  return true;
}
