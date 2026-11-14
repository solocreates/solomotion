import type { MotionDocument } from "../schema";
import { deleteClip, locateClip, pruneEmptiedTracks } from "./ops";
import { deleteFlipbookCell } from "../drawing/flipbook";
import { gcOrphanNestedSources } from "../components";

/**
 * THE delete — what removing layers means, for every door that can do it (⌫,
 * the context menu, the agent). Call inside a document update with ids already
 * widened to a group's contents (`expandToDescendants`).
 *
 * Flipbook cells delete through the flipbook brain, so the row closes its gap
 * and the cell's private drawing comp goes with it; the last instance of a
 * private nested comp takes its orphaned source frame along; and, when asked,
 * lanes the delete emptied are pruned — only those, so a lane the user left
 * empty on purpose survives. Returns the paint-surface ids the host must drop,
 * since pixel storage is not the document's to touch.
 */
export function deleteLayers(
  d: MotionDocument,
  ids: readonly string[],
  options: { pruneEmptiedTracks?: boolean } = {},
): { orphanSurfaces: string[] } {
  const orphanSurfaces: string[] = [];
  const sourceTrackIds = new Set<string>();
  for (const id of ids) {
    const loc = locateClip(d, id);
    if (!loc) continue;
    sourceTrackIds.add(loc.track.id);
    const parent = d.frames.find((f) => f.id === loc.clip.frameId);
    if (loc.clip.kind === "nested" && parent?.mode === "flipbook") {
      orphanSurfaces.push(...(deleteFlipbookCell(d, id) ?? []));
      continue;
    }
    deleteClip(d, id);
  }
  gcOrphanNestedSources(d);
  if (options.pruneEmptiedTracks) pruneEmptiedTracks(d, sourceTrackIds);
  return { orphanSurfaces };
}
