import type { MotionDocument, Clip, Track } from "../schema";
import { clipsUnderGroup } from "./groups";
import { frameHasOpaquePaper, nestedClipsContent } from "./nested-window";
import { traceSamplesOf } from "../trace/samples";

/**
 * EVERY DOCUMENT OBJECT THIS LAYER'S PICTURE IS MADE OF, beyond the clip itself.
 *
 * A leaf layer IS its clip: change the clip and identity says so. A CONTAINER
 * is not. A group's picture is its members'; a nested comp's picture is another
 * frame's whole tree — and a component instance is a nested clip, so the same
 * sentence covers it. Move a rectangle inside a glass group, or edit a layer
 * inside a component, and the container clip is untouched. Keyed on its own
 * identity alone, the cache would serve the old picture forever.
 *
 * ONE walk for both containers, recursive, so the cases that compose — a group
 * inside a component, a component inside a group, a comp nested two deep — are
 * correct because they are the same code and not because someone remembered
 * them. `seen` guards the cycle a self-referencing comp would otherwise make.
 *
 * A TRACE is the third: its picture is its source's history, which no field of
 * the trace clip holds. It contributes the sample store its points come from
 * (`traceSamplesOf`), which is replaced exactly when an edit could move any
 * source — so a clock keyed after the trace was made re-draws it.
 *
 * Rows contribute too, but only the FIELDS OF A ROW THAT REACH THE PICTURE:
 * `hidden`, the lane loop, and the transitions on it. Not the row object.
 *
 * That distinction is the whole difference between a cache that works and one
 * that looks broken. A row also carries its name, its colour, its height and
 * its LOCK, and under immer every one of those replaces the row object — so
 * pushing the object meant locking a track, or dragging its lane taller,
 * discarded every cached pixel of every group on it and re-rendered the lot.
 * Locking a heavy background layer is the exact thing a person does to make an
 * editor faster, and it was making it slower.
 */
/** The only three things about a ROW that change what it paints. */
function pushRowState(track: Track, out: unknown[]): void {
  out.push(track.hidden, track.loop, track.transitions);
}

export function layerContentRefs(doc: MotionDocument, clip: Clip, out: unknown[] = [], seen = new Set<string>()): unknown[] {
  if (seen.has(clip.id)) return out;
  seen.add(clip.id);

  if (clip.kind === "trace") {
    out.push(traceSamplesOf(doc));
    return out;
  }

  if (clip.kind === "group") {
    const members = new Set(clipsUnderGroup(doc, clip.id));
    for (const track of doc.tracks) {
      let carries = false;
      for (const c of track.clips) {
        if (!members.has(c.id)) continue;
        out.push(c);
        carries = true;
        layerContentRefs(doc, c, out, seen);
      }
      if (carries) pushRowState(track, out);
    }
    return out;
  }

  if (clip.kind === "nested") {
    for (const track of doc.tracks) {
      let carries = false;
      for (const c of track.clips) {
        if (c.frameId !== clip.sourceFrameId) continue;
        out.push(c);
        carries = true;
        layerContentRefs(doc, c, out, seen);
      }
      if (carries) pushRowState(track, out);
    }
    // The frame itself: its size and background are part of what a nested comp
    // draws, and neither lives on any clip.
    const src = doc.frames.find((f) => f.id === clip.sourceFrameId);
    out.push(src ?? null);
    return out;
  }

  return out;
}


const footageMemo = new WeakMap<MotionDocument, Map<string, boolean>>();
const blendMemo = new WeakMap<MotionDocument, Map<string, boolean>>();

/**
 * Does anything INSIDE this container blend with what lies beneath it (a
 * non-normal blend mode at any depth)? Such a container is pass-through: its
 * members composite straight onto the scene below, so drawing it into a buffer
 * of its own first would change the picture. Leaves answer false.
 *
 * A nested comp seen through its window over an OPAQUE paper is not
 * pass-through, whatever blends inside it: its members blend with the paper,
 * never with the parent (`frameHasOpaquePaper`). That is every scene with a
 * background — a riso print's multiply inks, a neon sign's screen glow — and it
 * is what lets such a scene be kept as one picture when it is nested.
 */
export function layerBlendsThrough(doc: MotionDocument, clip: Clip): boolean {
  if (clip.kind !== "group" && clip.kind !== "nested") return false;
  let memo = blendMemo.get(doc);
  if (!memo) blendMemo.set(doc, (memo = new Map()));
  const hit = memo.get(clip.id);
  if (hit !== undefined) return hit;
  const source = clip.kind === "nested" ? doc.frames.find((f) => f.id === clip.sourceFrameId) : undefined;
  if (clip.kind === "nested" && source && nestedClipsContent(clip, source) && frameHasOpaquePaper(source)) {
    memo.set(clip.id, false);
    return false;
  }
  const blends = layerContentRefs(doc, clip).some((r) => {
    const mode = (r as { blendMode?: unknown } | null)?.blendMode;
    return typeof mode === "string" && mode !== "normal";
  });
  memo.set(clip.id, blends);
  return blends;
}

/**
 * Does this layer SHOW FOOTAGE — is it a video, or a container (group, nested
 * comp, component instance) holding one at any depth? Footage is the one input
 * whose picture comes from a decoder with a clock of its own, so it is what
 * decides how a layer may be kept while the transport runs. Memoised per
 * document: asked on every layer draw.
 */
export function layerShowsFootage(doc: MotionDocument, clip: Clip): boolean {
  if (clip.kind === "video") return true;
  if (clip.kind !== "group" && clip.kind !== "nested") return false;
  let memo = footageMemo.get(doc);
  if (!memo) footageMemo.set(doc, (memo = new Map()));
  const hit = memo.get(clip.id);
  if (hit !== undefined) return hit;
  const shows = layerContentRefs(doc, clip).some((r) => (r as { kind?: unknown } | null)?.kind === "video");
  memo.set(clip.id, shows);
  return shows;
}
