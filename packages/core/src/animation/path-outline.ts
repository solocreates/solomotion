import type { PathClip, Subpath } from "../schema";
import { setPathGeometry } from "../pivot";
import { lendIdentity } from "../vector/contour-id";
import { copySubpaths } from "../vector/geometry";
import { propertyHasKeys, sampleKeyframes, setKeyframe } from "./keyframes";

/**
 * A PATH'S OUTLINE AT AN INSTANT — read and written the one way, by every
 * point editor (the canvas's node editor, the 3D edit mode, an agent).
 *
 * Two rules, both about what a person sees while dragging one point:
 *
 *  1. **Nothing else moves.** A path's pivot is a FRACTION of its box and the
 *     box is derived from the outline, so a bare write of the points moves the
 *     pivot — and with it every point the drag never touched (the line slid
 *     away under the cursor). The pivot is re-based across every change.
 *  2. **An animated outline morphs.** When the outline has keys (or record is
 *     on) the edit is a KEY at that instant, not a base write the keys would
 *     hide — the shape changes there and nothing else, anywhere.
 */

/** The outline the path shows at a local instant: its keyed shape there, else its base. */
export function pathOutlineAt(clip: PathClip, localMs: number): Subpath[] {
  if (!propertyHasKeys(clip.keyframes, "geometry")) return clip.subpaths;
  const v = sampleKeyframes(clip.keyframes.filter((t) => !t.range && t.property === "geometry"), localMs)["geometry"];
  return Array.isArray(v) ? (v as Subpath[]) : clip.subpaths;
}

/** Is a write at this instant a key (the outline animates, or recording) rather than the base? */
export function outlineWritesKey(clip: PathClip, record = false): boolean {
  return record || propertyHasKeys(clip.keyframes, "geometry");
}

/**
 * Write the outline a path should show at `localMs`. Returns what was written.
 *
 * A keyed write needs no pivot work of its own: baking a keyed outline (what
 * every renderer does, `setClipProperty` → `setPathGeometry`) re-bases the
 * pivot from the BASE box, so the pivot is absolute across the whole morph and
 * a new shape key moves exactly the points that changed.
 */
export function writePathOutline(clip: PathClip, next: Subpath[], localMs: number, opts: { record?: boolean } = {}): "key" | "base" {
  if (!outlineWritesKey(clip, opts.record)) {
    setPathGeometry(clip, lendIdentity(clip.subpaths, copySubpaths(next)));
    return "base";
  }
  setKeyframe(clip.keyframes, "geometry", localMs, copySubpaths(next));
  return "key";
}
