import {
  clipLocalTime,
  diffAsSplice,
  keyedText,
  locateClip,
  propertyHasKeys,
  setKeyframe,
  spliceClipText,
  splitGraphemes,
  type DocumentStore,
} from "@solomotion/core";
import { clipLocalClamped } from "../inspector/animatable";
import { useSession } from "./session";

/**
 * THE ONE WAY typed words land in a text layer — the stage's inline editor and
 * the 3D viewport's both call this, so a word typed in a world keys, records
 * and keeps its styled ranges exactly as one typed on the flat canvas.
 *
 * Diffs against the EFFECTIVE text (what is shown — content can be keyed),
 * then follows the animatable rule: a keyframe at the playhead when the text is
 * keyed or record mode is armed; otherwise the base string, with style ranges
 * remapped to the splice. Returns the splice so a caller can place its caret,
 * or null when nothing changed.
 */
export function commitTextContent(store: DocumentStore, clipId: string, next: string): { at: number; inserted: number } | null {
  const loc = locateClip(store.getState(), clipId);
  if (!loc || loc.clip.kind !== "text") return null;
  const c0 = loc.clip;
  const playheadMs = useSession.getState().playheadMs;
  const prev = keyedText(c0, clipLocalTime(c0, playheadMs) ?? 0);
  if (next === prev) return null;
  const splice = diffAsSplice(
    splitGraphemes(prev).map((g) => g.char),
    splitGraphemes(next).map((g) => g.char),
  );
  const keyed = useSession.getState().recording || propertyHasKeys(c0.keyframes, "text");
  store.update(
    "Edit text",
    (d) => {
      const l = locateClip(d, clipId);
      if (!l || l.clip.kind !== "text") return;
      // The pivot holds its point on its own — the store keeps every text's
      // pivot through content edits (core `holdTextPivots`).
      if (keyed) setKeyframe(l.clip.keyframes, "text", clipLocalClamped(l.clip, playheadMs), next);
      else {
        spliceClipText(l.clip, next, splice);
        l.clip.name = next.slice(0, 24) || "Text";
      }
    },
    { mergeKey: `edit-text-${clipId}` },
  );
  return { at: splice.at, inserted: splice.inserted };
}
