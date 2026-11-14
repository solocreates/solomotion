import type { MotionDocument, Clip, Track } from "../schema";
import { isSettledDocument } from "./settled";

/**
 * THE PER-COMP INDEX — which clips live in each comp, where each comp's
 * content ends, and which nested clips show each comp. Built once per
 * IMMUTABLE document.
 *
 * Every one of these questions used to be a scan of every clip in the project,
 * and they are asked from inside loops: per nested level of a target walk, per
 * source-time mapping, per pixel of a timeline bar. A scan inside a walk inside
 * a sweep is how a 900-layer film turned one paint of a cache hairline into
 * seconds. Only a FROZEN document is memoised — the store freezes every
 * snapshot, and frozen is what makes staleness impossible (the same rule as
 * `scopeIndex`); a draft is simply indexed again.
 */
export interface FrameClipEntry {
  track: Track;
  clip: Clip;
  /** The track's index in `doc.tracks` — its z row. */
  row: number;
}

interface FrameIndex {
  /** Per comp, in document order (tracks, then clips) — the renderer's order. */
  clips: Map<string, FrameClipEntry[]>;
  /** Per comp, the last clip end (0 = no clips). */
  contentEnd: Map<string, number>;
  /** Per SOURCE comp, the nested clips that show it. */
  nestedBySource: Map<string, Clip[]>;
  /** Every clip by id, and the row (track index) it sits on. */
  byId: Map<string, Clip>;
  rowOf: Map<string, number>;
}

const memo = new WeakMap<MotionDocument, FrameIndex>();
const EMPTY: readonly FrameClipEntry[] = [];

function frameIndex(doc: MotionDocument): FrameIndex {
  const cacheable = isSettledDocument(doc);
  if (cacheable) {
    const hit = memo.get(doc);
    if (hit) return hit;
  }
  const clips = new Map<string, FrameClipEntry[]>();
  const contentEnd = new Map<string, number>();
  const nestedBySource = new Map<string, Clip[]>();
  const byId = new Map<string, Clip>();
  const rowOf = new Map<string, number>();
  doc.tracks.forEach((track, row) => {
    for (const clip of track.clips) {
      byId.set(clip.id, clip);
      rowOf.set(clip.id, row);
      let list = clips.get(clip.frameId);
      if (!list) clips.set(clip.frameId, (list = []));
      list.push({ track, clip, row });
      contentEnd.set(clip.frameId, Math.max(contentEnd.get(clip.frameId) ?? 0, clip.startMs + clip.durationMs));
      if (clip.kind === "nested") {
        let shown = nestedBySource.get(clip.sourceFrameId);
        if (!shown) nestedBySource.set(clip.sourceFrameId, (shown = []));
        shown.push(clip);
      }
    }
  });
  const index = { clips, contentEnd, nestedBySource, byId, rowOf };
  if (cacheable) memo.set(doc, index);
  return index;
}

/** Every clip in a comp with its track, in document order. */
export function frameClipEntries(doc: MotionDocument, frameId: string): readonly FrameClipEntry[] {
  return frameIndex(doc).clips.get(frameId) ?? EMPTY;
}

/** The last clip end in a comp, 0 when it has none. */
export function frameContentEndMs(doc: MotionDocument, frameId: string): number {
  return frameIndex(doc).contentEnd.get(frameId) ?? 0;
}

/** The nested clips that show a comp. */
export function nestedClipsShowing(doc: MotionDocument, frameId: string): readonly Clip[] {
  return frameIndex(doc).nestedBySource.get(frameId) ?? [];
}

/** A clip by id, from the per-document index. */
export function clipByIdIn(doc: MotionDocument, clipId: string): Clip | undefined {
  return frameIndex(doc).byId.get(clipId);
}

/** The track row a clip sits on (−1 when it is not in the document). */
export function clipRowIn(doc: MotionDocument, clipId: string): number {
  return frameIndex(doc).rowOf.get(clipId) ?? -1;
}

/**
 * A clip-by-id lookup to HOLD for a while (a property reader, a bake). On a
 * frozen document it is the shared index; on a draft it is indexed once, here,
 * rather than once per lookup.
 */
export function clipLookup(doc: MotionDocument): (clipId: string) => Clip | undefined {
  const byId = frameIndex(doc).byId;
  return (id) => byId.get(id);
}
