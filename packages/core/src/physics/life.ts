import type { MotionDocument } from "../schema";
import { clipEnd, isClipHidden, locateClip } from "../timeline/ops";
import { clipAncestorGroups } from "../timeline/groups";

/**
 * WHEN A LAYER IS IN THE SIMULATION — one answer for a flat comp and a world.
 *
 * A body (or a field) exists while its layer is on the timeline: from its
 * clip's start to its end, inside every group around it. Before that it is
 * not there to be hit; after it, whatever rested on it falls. Hidden (the eye)
 * is not there at all, the way the renderer and a world already treat it — an
 * invisible collider is a body at opacity 0, not a hidden one.
 *
 * Comp milliseconds, `[from, to)`. Null when the layer never takes part.
 */
export function bodyLife(doc: MotionDocument, clipId: string): { from: number; to: number } | null {
  const at = locateClip(doc, clipId);
  if (!at || isClipHidden(at.track, at.clip)) return null;
  let from = at.clip.startMs, to = clipEnd(at.clip);
  for (const g of clipAncestorGroups(doc, clipId)) {
    const gt = locateClip(doc, g.id)?.track;
    if (!gt || isClipHidden(gt, g)) return null;
    from = Math.max(from, g.startMs);
    to = Math.min(to, clipEnd(g));
  }
  return to > from ? { from, to } : null;
}
