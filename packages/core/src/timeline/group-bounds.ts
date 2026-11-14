import { clipRenderLocalTime } from "../animation/evaluate";
import { sampleKeyframes } from "../animation/keyframes";
import { layerPoseAt } from "../animation/layer-animation";
import type { MotionDocument, Clip, GroupClip, KeyframeValue, Transform, VisualClip } from "../schema";
import { trackLocalTime } from "../drawing/flipbook";
import type { LayerBox } from "../transform-map";
import { clipBox, groupBoxWith, layersBoxWith } from "./ops";
import { rigShaping2d } from "../rig/bind";
import { hiddenBySwitch } from "./switch";

/**
 * A GROUP'S BOX AT A MOMENT — the live half of the split `groupBoxWith`
 * documents.
 *
 * It is the reducer in `ops.ts` handed a CLOCK, exactly as `flattenClipsToPath`
 * is handed one to draw the group's silhouette. That is the point of building
 * it this way: the outline a group's stroke runs along and the box its
 * selection chrome draws are the same measurement of the same members at the
 * same instant, so they cannot disagree — and "my stroke is over there and my
 * handles are over here" stops being a thing that can happen.
 *
 * It lives beside the reducer rather than inside it because the clock needs the
 * animation modules and `ops.ts` is upstream of them.
 */

function num(values: Record<string, KeyframeValue>, key: string, base: number): number {
  const v = values[key];
  return typeof v === "number" ? v : base;
}

/** A member's keyframed transform at one instant — sampled, never declared. */
function placedTransform(clip: VisualClip, values: Record<string, KeyframeValue>): Transform {
  const t = clip.transform;
  const scale = num(values, "scale", t.scale);
  const scaleY = t.scaleY == null ? scale : num(values, "scaleY", t.scaleY);
  return {
    ...t,
    x: num(values, "x", t.x),
    y: num(values, "y", t.y),
    rotation: num(values, "rotation", t.rotation),
    scale,
    scaleY,
    skewX: num(values, "skewX", t.skewX),
    skewY: num(values, "skewY", t.skewY),
    anchor: { x: num(values, "anchor.x", t.anchor.x), y: num(values, "anchor.y", t.anchor.y) },
  };
}

/** The clock, built once per query: track-local time, span-aware, per clip. */
function placementAt(doc: MotionDocument, atMs: number): (clip: Clip) => Transform | null {
  const trackOf = new Map<string, (typeof doc.tracks)[number]>();
  for (const track of doc.tracks) for (const clip of track.clips) trackOf.set(clip.id, track);
  const memo = new Map<string, Transform | null>();
  return (clip) => {
    const hit = memo.get(clip.id);
    if (hit !== undefined) return hit;
    let out: Transform | null = null;
    const track = trackOf.get(clip.id);
    if (track && !track.hidden && !clip.hidden && clip.kind !== "audio" && !hiddenBySwitch(doc, track, clip, atMs)) {
      const local = clipRenderLocalTime(track, clip, trackLocalTime(track, clip.frameId, atMs));
      if (local) {
        const values = sampleKeyframes(clip.keyframes, local.local);
        const pose = layerPoseAt(clip as VisualClip, local.local);
        const base = placedTransform(clip as VisualClip, values);
        const baseScaleY = base.scaleY ?? base.scale;
        // The in/out pose is a delta about the pivot: its offset adds, its turn
        // and its scale multiply. Same composition `withLayer` paints.
        out = {
          ...base,
          x: base.x + pose.dx,
          y: base.y + pose.dy,
          rotation: base.rotation + pose.rotation,
          scale: base.scale * pose.scale,
          scaleY: baseScaleY * pose.scale,
        };
      }
    }
    memo.set(clip.id, out);
    return out;
  };
}

/**
 * The group's box at `atMs` (comp time), falling back to the authored box when
 * nothing inside it is on screen — a group with no visible members still has to
 * be selectable, and a zero box is not a thing anyone can grab.
 */
export function groupBoxAt(doc: MotionDocument, group: GroupClip, atMs: number): LayerBox {
  return groupBoxWith(doc, group, placementAt(doc, atMs), rigShaping2d(doc, localTimeAt(doc, atMs)) ?? undefined) ?? clipBox(doc, group);
}

/**
 * WHERE SOME LAYERS ARE AT A MOMENT — placed by what they wear then and
 * carried by their rig (a hand on a raised arm is up there, not where its
 * transform rests), in comp-centre px. What a pose tile frames, so the Left
 * hand tile shows the left hand wherever the arm took it.
 */
export function layersBoxAt(doc: MotionDocument, clips: readonly Clip[], atMs: number): LayerBox | null {
  return layersBoxWith(doc, clips, placementAt(doc, atMs), rigShaping2d(doc, localTimeAt(doc, atMs)) ?? undefined);
}

/** The same clock as a layer's local time — what a rig's pose is read at. */
function localTimeAt(doc: MotionDocument, atMs: number): (clip: Clip) => number {
  return (clip) => {
    const track = doc.tracks.find((t) => t.clips.some((c) => c.id === clip.id));
    if (!track) return atMs - clip.startMs;
    return clipRenderLocalTime(track, clip, trackLocalTime(track, clip.frameId, atMs))?.local ?? atMs - clip.startMs;
  };
}
