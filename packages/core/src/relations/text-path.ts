import type { MotionDocument, TextClip, TextPathSpec } from "../schema";
import { textPathSpecSchema } from "../schema";
import { isPathHost } from "../text/on-path";
import { hostLocalTime, sampledTransform } from "./resolve";

/**
 * TEXT-ON-PATH OPS — the two writes, and the one rule a delete owes.
 *
 * Deliberately free of `timeline/ops` so `deleteClip` can call `detach` without
 * an import cycle; both walk `doc.tracks` themselves, which is the whole cost.
 */

/**
 * Bind a text to a host's outline. The text's own transform is left as it was
 * — it is DRIVEN while bound, and comes back on detach only if the caller asks
 * (`detachTextFromPath` bakes the host's instead, which is what "keep it where
 * I can see it" means).
 *
 * Returns false when the host is not a shape or path in the same comp.
 */
export function bindTextToPath(
  doc: MotionDocument,
  text: TextClip,
  hostClipId: string,
  spec: Partial<Omit<TextPathSpec, "hostClipId">> = {},
): boolean {
  const host = findClip(doc, hostClipId);
  if (!isPathHost(host) || host.frameId !== text.frameId) return false;
  text.path = textPathSpecSchema.parse({ ...(text.path ?? {}), ...spec, hostClipId });
  return true;
}

/**
 * Take a text off its path, leaving it EXACTLY where it renders at `compMs`:
 * the host's transform at that instant becomes the text's own, its now-dead
 * transform keys are dropped, and the glyphs lay out straight from there.
 * Without the bake the text would jump back to wherever it was before it was
 * bound — a place nobody has looked at since.
 */
export function detachTextFromPath(doc: MotionDocument, text: TextClip, compMs: number): void {
  if (!text.path) return;
  const host = findClip(doc, text.path.hostClipId);
  if (isPathHost(host)) {
    text.transform = sampledTransform(host, hostLocalTime(host, compMs));
    text.keyframes = text.keyframes.filter((t) => t.range || !TRANSFORM_PATHS.has(t.property));
  }
  text.path = null;
}

/** Every text riding `hostId` is detached, baked at the host's rest pose. */
export function detachTextsFromHost(doc: MotionDocument, hostId: string): void {
  const host = findClip(doc, hostId);
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== "text" || clip.path?.hostClipId !== hostId) continue;
      detachTextFromPath(doc, clip, host ? host.startMs : 0);
    }
  }
}

const TRANSFORM_PATHS = new Set(["x", "y", "scale", "scaleY", "rotation", "skewX", "skewY", "anchor.x", "anchor.y"]);

function findClip(doc: MotionDocument, id: string) {
  for (const track of doc.tracks) for (const clip of track.clips) if (clip.id === id) return clip;
  return undefined;
}
