import type { MotionDocument, Clip, ClipKind, KeyframeTrack } from "../schema";
import { clipLocalTime } from "../animation/evaluate";
import { isClipHidden, isClipLocked } from "../timeline/ops";
import { expandToDescendants } from "../timeline/groups";
import { captureCursor, captureFps, captureFrameTimes, captureLocalMs, type CaptureSeed } from "./capture";

/**
 * Where a paint gesture lands — the ONE headless rule that keeps the drawing
 * tools from branching on clip kind themselves (v41).
 *
 * A brush/eraser/bucket/lasso stroke, or a pen/shape draw, always aims at the
 * SELECTED layer when that layer can receive it; otherwise it spawns the right
 * new clip. So "pixel layer selected + brush → paints there (and, with Record
 * armed, snapshots there)" and "vector pen while a pixel layer is selected →
 * can't live in pixels → new vector clip" both fall out of one table. This
 * generalizes the flipbook's selection-first paint target to the whole timeline
 * (reusing the idea, not the cell container).
 */

/**
 * The two families of paint tools by what they PRODUCE:
 *  - `raster`: brush, eraser, bucket, lasso — pixels.
 *  - `vector`: pen, shape tools — geometry.
 */
export type PaintToolCategory = "raster" | "vector";

/** The resolved destination for a paint gesture. */
export type PaintTarget =
  /**
   * Edit an existing clip. `surface: "own"` writes the clip's native pixels/
   * geometry (a raster layer, or appending to a path). `surface: "overlay"`
   * writes a NON-DESTRUCTIVE paint overlay attached to the clip (image, video,
   * or a vector clip painted over) — the original media is never mutated.
   */
  | { kind: "edit"; clipId: string; surface: "own" | "overlay" }
  /** Nothing suitable is selected — create this clip kind and paint into it. */
  | { kind: "new"; clipKind: "raster" | "path" };

/**
 * Clip kinds that accept a paint overlay without being raster themselves.
 *
 * Everything the renderer can DRAW belongs here, and that is the point: you can
 * paint on a photo, a video, a GIF, a nested comp, a graded adjustment or a
 * vector outline, and in every case the media is untouched and the marks live
 * on their own layer beside it. A closed set rather than "not audio" so a new
 * visual clip kind is one entry and inherits the whole behaviour.
 */
const OVERLAY_KINDS: ReadonlySet<ClipKind> = new Set<ClipKind>([
  "image",
  "video",
  "shape",
  "path",
  "nested",
  "text",
  "adjustment",
  "waveform",
  "trace",
]);

/**
 * Resolve where a paint gesture should land.
 *
 * @param selected the currently selected clip (id + kind), or null.
 * @param tool     the family of the active tool.
 */
export function resolvePaintTarget(
  selected: { id: string; kind: ClipKind } | null,
  tool: PaintToolCategory,
): PaintTarget {
  if (tool === "raster") {
    // Pixels go straight into a raster layer's own surface.
    if (selected?.kind === "raster") return { kind: "edit", clipId: selected.id, surface: "own" };
    // Onto an image/video/vector clip → non-destructive overlay.
    if (selected && OVERLAY_KINDS.has(selected.kind)) {
      return { kind: "edit", clipId: selected.id, surface: "overlay" };
    }
    // Text / caption / audio / nested / waveform / nothing → fresh pixel layer.
    return { kind: "new", clipKind: "raster" };
  }

  // Vector geometry can only live in a path clip — append to a selected one,
  // else spawn a new path (drawing vector "into" pixels is impossible).
  if (selected?.kind === "path") return { kind: "edit", clipId: selected.id, surface: "own" };
  return { kind: "new", clipKind: "path" };
}

/** Where a multi-layer tool reads from / acts on. */
export type LayerScope = "current" | "all";

/** What a stroke does to a clip, by what the clip is made of. */
export type StrokeMedium = "raster" | "vector";

/** One clip a stroke will land on, with the medium that decides how. */
export interface StrokeTarget {
  clipId: string;
  medium: StrokeMedium;
  /** The comp it lives in — not always the one you are standing in (see reach). */
  frameId: string;
}

function strokeMediumOf(clip: Clip): StrokeMedium | null {
  if (clip.kind === "raster") return "raster";
  if (clip.kind === "path" || clip.kind === "shape") return "vector";
  return null;
}

/**
 * Every clip a destructive stroke (the eraser today, any future scrub/smudge)
 * may touch right now — THE headless answer to "this layer vs all layers",
 * written once instead of once per tool.
 *
 * Topmost first, and never a layer you cannot see or edit: hidden, locked, or
 * not on screen at `timeMs` is not a target — which is what makes "all layers"
 * mean *all layers you can actually SEE*, the promise the switch makes on
 * screen. Without the time gate the eraser reached clips parked elsewhere on
 * the timeline, invisibly.
 *
 *  - `all`      → every visible, unlocked, erasable clip in reach.
 *  - `current`  → the selected ones among those; with nothing usable selected,
 *                 the topmost one, so the tool still has somewhere to land.
 *
 * `frameIds` is a RANGE, not a frame: the comp you are standing in, plus
 * however far out and in the reach setting allows (`reachableFrameIds`). It is
 * ordered near-to-far, and the results come back in that order, so "the topmost
 * one" still means the topmost one HERE rather than in some cousin comp.
 *
 * A selected GROUP means its members, at any depth. That is what makes "this
 * layer" keep meaning one thing once a paint layer is made of PARTS: the group
 * is the layer a person selected and pointed the eraser at, and erasing only
 * the container — which paints nothing — would rub out nothing at all.
 *
 * `timeMs` null skips the time gate, for a frame whose layers have no
 * independent timeline life of their own — a flipbook cell's drawing, where the
 * whole frame IS the moment and its layers just fill it.
 *
 * The medium rides along so the caller never re-asks what kind each clip was:
 * pixels erase as pixels, outlines cut as geometry, in one gesture.
 */
export function resolveStrokeTargets(
  doc: MotionDocument,
  frameIds: string | readonly string[],
  selectedIds: readonly string[],
  scope: LayerScope,
  timeMs: number | null = null,
): StrokeTarget[] {
  const frames = typeof frameIds === "string" ? [frameIds] : frameIds;
  const live: StrokeTarget[] = [];
  for (const frameId of frames) {
    for (const track of doc.tracks) {
      for (const clip of track.clips) {
        if (clip.frameId !== frameId) continue;
        if (isClipLocked(track, clip) || isClipHidden(track, clip)) continue;
        if (timeMs !== null && !clip.fillDuration && clipLocalTime(clip, timeMs) === null) continue;
        const medium = strokeMediumOf(clip);
        if (medium) live.push({ clipId: clip.id, medium, frameId });
      }
    }
  }
  if (scope === "all") return live;
  const selected = new Set(expandToDescendants(doc, selectedIds));
  const picked = live.filter((t) => selected.has(t.clipId));
  return picked.length > 0 ? picked : live.slice(0, 1);
}

/**
 * What a paint gesture with a REFERENCE should make when there is nothing
 * selected to paint into.
 *
 * Two facts fall out of the reference and neither is a new mechanism:
 *
 *  - MEDIUM. A tool with no opinion of its own (the bucket) follows what it is
 *    filling against — vector line art gets a vector fill, pixels get pixels.
 *    A tool that HAS an opinion (the pixel brush, the vector brush) keeps it,
 *    which is what makes "paint inside a vector outline with a pixel brush"
 *    work: it spawns a pixel layer and the stencil confines it. The reference
 *    decides the shape of the world, never the material of the mark.
 *
 *  - TIMING. The layer is cut to the reference's span, so a mark made inside
 *    somebody's outline lasts exactly as long as the outline does. Without it
 *    every stroke over a reference needs retiming by hand, which is the whole
 *    reason drawing over a reference used to feel like fighting the timeline.
 *
 * Returns the same `PaintTarget` union, so every caller that already handled
 * "new" handles this with no branch.
 */
export function resolveReferencePaintTarget(
  selected: { id: string; kind: ClipKind } | null,
  tool: PaintToolCategory | "auto",
  reference: { vector: boolean; raster: boolean },
): PaintTarget {
  if (tool !== "auto") return resolvePaintTarget(selected, tool);
  // The bucket: follow the artwork. Mixed reads as vector — a traced outline
  // over a photo is fine; a bitmap poured into line art throws away the
  // resolution the line art has.
  return resolvePaintTarget(selected, reference.vector ? "vector" : "raster");
}
