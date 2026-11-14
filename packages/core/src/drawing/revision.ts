import type { MotionDocument, Clip } from "../schema";
import { clipsUnderGroup } from "../timeline/groups";

/**
 * Comp content revisions — the ONE invalidation truth for anything cached per
 * comp (flipbook cell thumbnails, drawing previews, layer thumbs). A revision
 * is a stable hash of everything that changes a comp's rendered pixels: its
 * clips (raster `rev` included — that's how paint strokes invalidate), its
 * frame's size/background, and — recursively — every nested source comp.
 *
 * Because documents are immutable snapshots (immer), revisions memoize per
 * (document object, frameId): computing them during render is free after the
 * first ask. A cache compares its stored rev string and re-renders only on a
 * real change — no timers, no "maybe stale" flags, no races by construction.
 */

const cache = new WeakMap<MotionDocument, Map<string, string>>();

/**
 * One CLIP's content revision — the same invalidation truth as a comp's, at
 * the grain of a single layer.
 *
 * A clip that is its own preview source (a shape, a path, a pixel layer) has
 * no comp to hash, and hashing its whole comp would throw its cached picture
 * away every time a neighbouring layer moved. Memoized per (document, clipId)
 * exactly like `compContentRevision`, and folded through the SAME `foldClip`,
 * so a nested clip's revision still covers its source comp recursively.
 */
export function clipContentRevision(doc: MotionDocument, clipId: string): string {
  let perDoc = clipCache.get(doc);
  if (!perDoc) {
    perDoc = new Map();
    clipCache.set(doc, perDoc);
  }
  const hit = perDoc.get(clipId);
  if (hit !== undefined) return hit;
  const parts: string[] = [];
  for (const track of doc.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (!clip) continue;
    foldClip(clip, doc, new Set<string>(), parts);
    break;
  }
  const joined = parts.join("\u0000");
  const rev = `${fnv1a(joined).toString(36)}-${joined.length.toString(36)}`;
  perDoc.set(clipId, rev);
  return rev;
}

const clipCache = new WeakMap<MotionDocument, Map<string, string>>();

/**
 * The revision of what a layer LOOKS like — its own content and, for a group,
 * every layer under it (members are edited apart from the group, so the
 * group's own revision never moves when its art does). The key every picture
 * of a layer is cached under: the timeline's strip, the Face pad, the layers
 * panel. A group poster keyed on the group alone kept its first picture while
 * its members were redrawn.
 */
export function clipPictureRevision(doc: MotionDocument, clipId: string): string {
  let perDoc = pictureCache.get(doc);
  if (!perDoc) pictureCache.set(doc, (perDoc = new Map()));
  const hit = perDoc.get(clipId);
  if (hit !== undefined) return hit;
  const own = clipContentRevision(doc, clipId);
  const members = clipsUnderGroup(doc, clipId);
  let rev = own;
  if (members.length) {
    const parts = [own];
    for (const id of members) parts.push(clipContentRevision(doc, id));
    const joined = parts.join("\u0000");
    rev = `${fnv1a(joined).toString(36)}-${joined.length.toString(36)}`;
  }
  perDoc.set(clipId, rev);
  return rev;
}

const pictureCache = new WeakMap<MotionDocument, Map<string, string>>();

/** FNV-1a over a string — tiny, stable, good enough for cache keys. */
function fnv1a(str: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A clip object's own hash. The clip IS the render input — serialised
 * wholesale, so nothing is missed (keyframes, paints, effects, transforms,
 * raster revs…). Remembered per clip OBJECT when it is frozen: the store's
 * documents are immutable and structurally shared, so an edit re-hashes only
 * the clips it actually replaced. Hashing per document instead re-serialised a
 * 44-part character on every bone-drag move to learn that 43 parts were the
 * same.
 */
const ownRevisions = new WeakMap<Clip, string>();
function ownRevision(clip: Clip): string {
  const hit = ownRevisions.get(clip);
  if (hit !== undefined) return hit;
  const json = JSON.stringify(clip);
  const rev = `${fnv1a(json).toString(36)}.${fnv1a(json, 0x9dc5811c).toString(36)}.${json.length.toString(36)}`;
  if (Object.isFrozen(clip)) ownRevisions.set(clip, rev);
  return rev;
}

function foldClip(clip: Clip, doc: MotionDocument, guard: Set<string>, parts: string[]): void {
  parts.push(ownRevision(clip));
  if (clip.kind === "nested" && !guard.has(clip.sourceFrameId)) {
    parts.push(compContentRevision(doc, clip.sourceFrameId, guard));
  }
  if (clip.kind === "waveform") parts.push(clip.targetClipId);
  if (clip.kind === "trace") parts.push(clip.trace.source.clipId ?? "");
}

/**
 * The revision string for one comp. Cheap after the first call per document
 * snapshot. `_guard` breaks nested-comp cycles (defensive; the editor already
 * prevents creating them).
 */
export function compContentRevision(
  doc: MotionDocument,
  frameId: string,
  _guard?: Set<string>,
): string {
  let perDoc = cache.get(doc);
  if (!perDoc) {
    perDoc = new Map();
    cache.set(doc, perDoc);
  }
  const hit = perDoc.get(frameId);
  if (hit !== undefined) return hit;

  const guard = _guard ?? new Set<string>();
  guard.add(frameId);
  const parts: string[] = [];
  const frame = doc.frames.find((f) => f.id === frameId);
  if (frame) {
    parts.push(
      `${frame.width}x${frame.height}:${frame.background}:${JSON.stringify(frame.fills)}:${JSON.stringify(frame.strokes)}`,
    );
  }
  for (const track of doc.tracks) {
    let touches = false;
    for (const clip of track.clips) {
      if (clip.frameId !== frameId) continue;
      if (!touches) {
        touches = true;
        // Track-level knobs that change rendering of this comp's clips.
        parts.push(`t:${track.hidden}:${track.muted}:${track.loop}`);
      }
      foldClip(clip, doc, guard, parts);
    }
  }
  const joined = parts.join("\u0000");
  const rev = `${fnv1a(joined).toString(36)}-${fnv1a(joined, 0x9dc5811c).toString(36)}-${joined.length.toString(36)}`;
  perDoc.set(frameId, rev);
  return rev;
}
