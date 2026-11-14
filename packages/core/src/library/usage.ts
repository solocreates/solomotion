import type { MotionDocument } from "../schema";
import { libraryItemId } from "./item";

/**
 * HOW OFTEN THIS PROJECT USES EACH LIBRARY ITEM — the signal behind "most
 * used" sorting, and behind promoting what you actually reach for.
 *
 * Counted from the document, never stored. A tally kept alongside the clips
 * would be a second copy of a fact the clips already hold, and it would drift
 * the first time anything changed a preset by a route that forgot to increment
 * it — an undo, a paste, a plugin, a bundle import. Deriving it costs one pass
 * over the clips, which is nothing next to being wrong.
 *
 * Keyed by LIBRARY ITEM ID, not by preset id, so the browser can look a card up
 * directly and no caller has to know how an id is spelled. `libraryItemId` is
 * the one speller, shared with the catalogue.
 */
export function libraryUsage(doc: MotionDocument): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (id: string) => counts.set(id, (counts.get(id) ?? 0) + 1);

  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind === "audio") {
        // A voice is addressed by pack OR by asset — the same discriminated
        // source the sound shelf browses, so both count as a use of the card.
        if (clip.source.type === "asset") bump(libraryItemId("project", "sound", clip.source.assetId));
        else bump(libraryItemId("builtin", "sound", clip.source.pack));
        continue;
      }
      const visual = clip as { animIn?: { preset: string } | null; animOut?: { preset: string } | null };
      if (visual.animIn) bump(libraryItemId("builtin", "animation", visual.animIn.preset));
      if (visual.animOut) bump(libraryItemId("builtin", "animation", visual.animOut.preset));

      if (clip.kind === "text") {
        // Only the MOTION counts here. A text clip does not record which
        // template it is wearing — applying one copies the style in and the
        // provenance is gone — so there is nothing to attribute the look to.
        // See `libraryFocus`, which cannot mark a text card active for the
        // same reason.
        if (clip.animations.in) bump(libraryItemId("builtin", "animation", clip.animations.in.preset));
        if (clip.animations.out) bump(libraryItemId("builtin", "animation", clip.animations.out.preset));
      }
      if ("assetId" in clip && typeof clip.assetId === "string" && clip.assetId) {
        bump(libraryItemId("project", "media", clip.assetId));
      }
    }
    for (const tr of track.transitions ?? []) {
      bump(libraryItemId("builtin", "transition", tr.preset));
    }
  }
  return counts;
}
