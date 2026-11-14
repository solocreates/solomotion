/**
 * PIXEL PARTS — a paint layer that has been SEPARATED into pieces.
 *
 * ## The model, in one sentence
 *
 * A part IS a `raster` clip and a separated paint layer IS a `group` of them.
 *
 * That is a design decision rather than an implementation detail: the
 * alternative — sub-entities living inside one raster clip — would have needed
 * its own transform, its own keyframe tracks, its own effect stack, its own
 * lock/hide, its own selection, its own inspector and its own row in the layer
 * tree, all of it a second, worse copy of machinery that already exists and is
 * already animated, exported and undoable. A part that is a clip inherits every
 * one of those for free, and a group that is a clip (`groupClipSchema`) gives
 * the whole layer a transform, keyframes and an effect stack of its own that
 * the parts ride inside.
 *
 * ## Parts are MADE, never guessed
 *
 * The brush does not split anything. A stroke lands on the layer you pointed
 * at, exactly as a vector stroke lands on the path clip you pointed at, and the
 * drawing stays one surface until you ask for otherwise.
 *
 * It briefly worked the other way — a mark landing far from the rest of a layer
 * opened a new part on its own — and the lesson is worth keeping: a tool that
 * sometimes makes a new object and sometimes does not, on a rule the person
 * cannot see, is a tool nobody can aim. "Sometimes it makes a new clip,
 * sometimes not" was the whole of the complaint and the whole of the design.
 *
 * Splitting is `Separate`: one command, the same word and place vector art
 * uses, and it splits on what is ACTUALLY THERE — the connected regions of the
 * layer's own alpha (see `drawing/raster-split.ts`). That is the honest answer
 * to "what are the pieces of this drawing", and it is an answer the person
 * asked for at a moment of their choosing.
 */

import type { MotionDocument, Clip, GroupClip, RasterClip } from "../schema";
import { clipFrameBounds, locateClip } from "../timeline/ops";
import { clipsInGroup, groupClipById, groupOfClip, isGroupClip } from "../timeline/groups";

/** A box in FRAME-CENTRE coordinates — the space a clip's transform lives in. */
export interface PartBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/* ------------------------------------------------------------------ lookups */

/**
 * Every raster clip directly inside a group, bottom-first (lane order).
 *
 * ONE pass over the tracks, not one `locateClip` per member. The difference is
 * not academic: this runs on every pointer-down, and `locateClip` scans every
 * clip in the document — so a face made of forty parts paid forty full scans
 * before the brush had drawn a pixel.
 */
export function partsOf(doc: MotionDocument, groupId: string): RasterClip[] {
  const want = new Set(clipsInGroup(doc, groupId));
  if (want.size === 0) return [];
  const byId = new Map<string, RasterClip>();
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind === "raster" && want.has(clip.id)) byId.set(clip.id, clip);
    }
  }
  // `clipsInGroup` is already in lane order; keep it.
  const out: RasterClip[] = [];
  for (const id of clipsInGroup(doc, groupId)) {
    const clip = byId.get(id);
    if (clip) out.push(clip);
  }
  return out;
}

/**
 * Is this group a PAINT LAYER made of parts?
 *
 * A group qualifies when every member is a raster clip — which is exactly what
 * splitting produces and exactly what a person would call "one drawing". A
 * group that also holds a text layer is somebody's composition, and a brush
 * stroke has no business rearranging it, so routing declines and paints into
 * the selected layer alone.
 */
export function isPartGroup(doc: MotionDocument, clip: Clip | null | undefined): clip is GroupClip {
  if (!isGroupClip(clip)) return false;
  const ids = clipsInGroup(doc, clip.id);
  if (ids.length === 0) return false;
  // One pass, same reason as `partsOf`: this is on the pointer-down path.
  const want = new Set(ids);
  let raster = 0;
  for (const track of doc.tracks) {
    for (const c of track.clips) {
      if (!want.has(c.id)) continue;
      if (c.kind !== "raster") return false;
      raster++;
    }
  }
  return raster === ids.length;
}

/** The part group a raster layer belongs to, or null if it stands alone. */
export function partGroupOf(doc: MotionDocument, clipId: string): GroupClip | null {
  const groupId = groupOfClip(doc, clipId);
  const group = groupClipById(doc, groupId);
  return isPartGroup(doc, group) ? group : null;
}

/**
 * The union box of several parts — the size and position a MERGE produces.
 *
 * Merging is the inverse of splitting and it is lossy on purpose: many boxes
 * become one, so the result is their extent. Returns null for a selection that
 * spans nothing measurable.
 */
export function mergedPartBox(doc: MotionDocument, clipIds: readonly string[]): PartBox | null {
  let box: PartBox | null = null;
  for (const id of clipIds) {
    const clip = locateClip(doc, id)?.clip;
    if (clip?.kind !== "raster") continue;
    const b = clipFrameBounds(doc, clip);
    if (!b) continue;
    box = box
      ? {
          minX: Math.min(box.minX, b.minX),
          minY: Math.min(box.minY, b.minY),
          maxX: Math.max(box.maxX, b.maxX),
          maxY: Math.max(box.maxY, b.maxY),
        }
      : { ...b };
  }
  return box;
}

/**
 * Can these clips be merged into one part? Two or more raster clips in the same
 * comp, and none of them rotated or sheared out of the surface's own grid.
 *
 * The refusal is honest rather than cautious: merging composites pixels into a
 * shared buffer, and a rotated part's pixels would have to be RESAMPLED to get
 * there — the drawing would come back slightly softer than it went in, every
 * time, with no way to undo the loss short of undoing the merge. Rotate the
 * group instead; that costs nothing and is what a group is for.
 */
export function canMergeParts(doc: MotionDocument, clipIds: readonly string[]): boolean {
  const clips: RasterClip[] = [];
  for (const id of clipIds) {
    const clip = locateClip(doc, id)?.clip;
    if (clip?.kind !== "raster") return false;
    clips.push(clip);
  }
  if (clips.length < 2) return false;
  const frameId = clips[0]!.frameId;
  return clips.every(
    (c) =>
      c.frameId === frameId &&
      c.transform.rotation === 0 &&
      c.transform.skewX === 0 &&
      c.transform.skewY === 0,
  );
}
