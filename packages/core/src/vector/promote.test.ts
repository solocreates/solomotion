import { describe, expect, it } from "vitest";
import { produce } from "immer";
import { createEmptyDocument, createPathClip, createTrack } from "../factories";
import { solidPaint } from "../schema";
import { emptyOverlay } from "../schema/scope";
import { locateClip, replaceClipInPlace } from "../timeline/ops";
import { VECTOR_SOURCE_TAG } from "../navigation/scope";
import { anchorLocal } from "../transform-map";
import { pathBox } from "../pivot";
import type { MotionDocument, PathClip } from "../schema";
import { extractContours, mergeVectorClips, pathClipRegions, promotePathClip, vectorMergeLoss } from "./promote";

const pt = (x: number, y: number) => ({ x, y, hIn: null, hOut: null });
const box = (x: number, y: number, w: number, h: number) => ({
  closed: true,
  points: [pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h)],
});
/** A box wound the other way — a hole under either fill rule. */
const hole = (x: number, y: number, w: number, h: number) => ({
  closed: true,
  points: [pt(x, y), pt(x, y + h), pt(x + w, y + h), pt(x + w, y)],
});

function docWith(subpaths: ReturnType<typeof box>[]): { doc: MotionDocument; clip: PathClip } {
  const doc = createEmptyDocument();
  const clip = createPathClip({
    frameId: doc.frames[0]!.id,
    subpaths,
    startMs: 0,
    durationMs: 2000,
    name: "Logo",
  });
  const track = createTrack("t");
  track.clips.push(clip);
  doc.tracks.push(track);
  return { doc, clip };
}

describe("pathClipRegions", () => {
  it("returns null when the artwork is already one piece", () => {
    const { clip } = docWith([box(0, 0, 10, 10)]);
    expect(pathClipRegions(clip)).toBeNull();
  });

  it("copies geometry VERBATIM — promotion must not move a pixel", () => {
    const { clip } = docWith([box(0, 0, 10, 10), box(50, 0, 10, 10)]);
    const pieces = pathClipRegions(clip)!;
    expect(pieces).toHaveLength(2);
    expect(pieces[0]!.subpaths[0]!.points.map((p) => [p.x, p.y])).toEqual(
      clip.subpaths[0]!.points.map((p) => [p.x, p.y]),
    );
    // Same transform, so the same coordinates land in the same place.
    expect(pieces[0]!.transform.x).toBe(clip.transform.x);
    expect(pieces[1]!.transform.y).toBe(clip.transform.y);
  });

  it("keeps the pivot's LOCAL POINT, not its fraction", () => {
    // Each piece has a different box, so holding the fraction would name a
    // different point and a rotated layer would visibly jump apart.
    const { clip } = docWith([box(0, 0, 10, 10), box(50, 0, 10, 10)]);
    clip.transform.anchor = { x: 0, y: 0 };
    const before = anchorLocal(clip.transform.anchor, pathBox(clip.subpaths));
    for (const piece of pathClipRegions(clip)!) {
      const after = anchorLocal(piece.transform.anchor, pathBox(piece.subpaths));
      expect(after.x).toBeCloseTo(before.x, 6);
      expect(after.y).toBeCloseTo(before.y, 6);
    }
  });

  it("gives every piece its own identity — ids never collide", () => {
    const { clip } = docWith([box(0, 0, 10, 10), box(50, 0, 10, 10)]);
    const pieces = pathClipRegions(clip)!;
    const ids = new Set(pieces.flatMap((p) => [p.id, ...p.subpaths.map((s) => s.id)]));
    expect(ids.size).toBe(4);
    expect(pieces[0]!.id).not.toBe(clip.id);
  });

  it("keeps a hole with the outline it is a hole in — under either fill rule", () => {
    // A hole cannot have its own colour, so it is not a piece of artwork.
    const donut = () => docWith([box(0, 0, 100, 100), hole(25, 25, 50, 50)]).clip;
    const a = donut();
    a.fillRule = "nonzero";
    expect(pathClipRegions(a)).toBeNull();
    const b = donut();
    b.fillRule = "evenodd";
    expect(pathClipRegions(b)).toBeNull();
  });
});

describe("promotePathClip", () => {
  it("produces a vector GROUP — one lane in, one lane out", () => {
    // Twelve root lanes is not "more control", it is a comp you cannot read.
    const { doc, clip } = docWith([box(0, 0, 10, 10), box(50, 0, 10, 10)]);
    // What must not grow is the PARENT timeline. `nestClips` keeps the pieces
    // on their carriers (z-order survives) — those lanes now serve the group's
    // own comp and no longer show here, which is the whole point.
    const parentLanes = (d: MotionDocument, frameId: string) =>
      d.tracks.filter((t) => t.clips.some((c) => c.frameId === frameId)).length;
    const lanesBefore = parentLanes(doc, clip.frameId);
    const laneOfSource = locateClip(doc, clip.id)!.trackIndex;
    const res = promotePathClip(doc, clip.id)!;
    expect(res.nestedId).not.toBeNull();
    expect(res.pieceIds).toHaveLength(2);
    expect(parentLanes(doc, clip.frameId)).toBe(lanesBefore);
    const group = locateClip(doc, res.nestedId!)!;
    expect(group.clip.kind).toBe("nested");
    // Same lane, same slot: the layers you did not touch have not moved.
    expect(group.trackIndex).toBe(laneOfSource);
    expect(group.clip.frameId).toBe(clip.frameId);
  });

  it("puts the pieces INSIDE the group, tagged as vector artwork", () => {
    const { doc, clip } = docWith([box(0, 0, 10, 10), box(50, 0, 10, 10)]);
    const res = promotePathClip(doc, clip.id)!;
    const group = locateClip(doc, res.nestedId!)!.clip;
    expect(group.kind === "nested" && group.sourceFrameId).toBeTruthy();
    const inside = group.kind === "nested" ? group.sourceFrameId : "";
    for (const id of res.pieceIds) {
      const piece = locateClip(doc, id)!.clip;
      expect(piece.frameId).toBe(inside);
      // They span their group and follow when it is trimmed.
      expect(piece.kind !== "audio" && piece.fillDuration).toBe(true);
    }
    const frame = doc.frames.find((f) => f.id === inside)!;
    expect(frame.sourceTag).toBe(VECTOR_SOURCE_TAG);
  });

  it("keeps the source's name on the group", () => {
    const { doc, clip } = docWith([box(0, 0, 10, 10), box(50, 0, 10, 10)]);
    const res = promotePathClip(doc, clip.id)!;
    expect(locateClip(doc, res.nestedId!)!.clip.name).toBe("Logo");
  });

  it("adds a SIBLING, not another level, when already inside a vector group", () => {
    // Cutting a piece in two inside a group means "another piece", never
    // "another group".
    const { doc, clip } = docWith([box(0, 0, 10, 10), box(50, 0, 10, 10)]);
    doc.frames[0]!.sourceTag = VECTOR_SOURCE_TAG;
    const res = promotePathClip(doc, clip.id)!;
    expect(res.nestedId).toBeNull();
    expect(res.pieceIds).toHaveLength(2);
    for (const id of res.pieceIds) {
      expect(locateClip(doc, id)!.clip.frameId).toBe(clip.frameId);
    }
  });

  it("is a no-op on artwork that is already one piece", () => {
    const { doc, clip } = docWith([box(0, 0, 10, 10)]);
    expect(promotePathClip(doc, clip.id)).toBeNull();
    expect(locateClip(doc, clip.id)).not.toBeNull();
  });

  it("refuses a clip that is not a path", () => {
    const { doc } = docWith([box(0, 0, 10, 10)]);
    expect(promotePathClip(doc, "nope")).toBeNull();
  });
});

describe("replaceClipInPlace", () => {
  it("reuses the source's lane and slot, and never deletes a track", () => {
    // A structural edit is not permission to rearrange the timeline. The first
    // version minted lanes at the TOP and dropped the one it emptied, which
    // re-ordered whole comps.
    const { doc, clip } = docWith([box(0, 0, 10, 10)]);
    const above = createTrack("above");
    const below = createTrack("below");
    doc.tracks.unshift(above);
    doc.tracks.push(below);
    const a = createPathClip({ frameId: clip.frameId, subpaths: [box(0, 0, 1, 1)], startMs: 0, name: "A" });
    const b = createPathClip({ frameId: clip.frameId, subpaths: [box(0, 0, 1, 1)], startMs: 0, name: "B" });

    const lane = locateClip(doc, clip.id)!.trackIndex;
    expect(replaceClipInPlace(doc, clip.id, [a, b])).toBe(true);
    expect(locateClip(doc, clip.id)).toBeNull();
    // `above` is still index 0 and `below` is still last: nothing above moved,
    // nothing was removed, and the sibling landed directly under the source.
    expect(doc.tracks[0]).toBe(above);
    expect(doc.tracks[doc.tracks.length - 1]).toBe(below);
    expect(locateClip(doc, a.id)!.trackIndex).toBe(lane);
    expect(locateClip(doc, b.id)!.trackIndex).toBe(lane + 1);
  });

  it("refuses an unknown clip and an empty replacement list", () => {
    const { doc, clip } = docWith([box(0, 0, 10, 10)]);
    expect(replaceClipInPlace(doc, "ghost", [])).toBe(false);
    expect(replaceClipInPlace(doc, clip.id, [])).toBe(false);
  });
});

describe("extractContours", () => {
  it("gives one piece its own layer, with a COPY of everything it inherited", () => {
    // Inherit-by-default, override-when-asked — with no second style system.
    const { doc, clip } = docWith([box(0, 0, 10, 10), box(50, 0, 10, 10)]);
    clip.opacity = 0.4;
    const takeId = clip.subpaths[1]!.id;
    const id = extractContours(doc, clip.id, [takeId])!;
    const piece = locateClip(doc, id)!.clip;
    expect(piece.kind).toBe("path");
    expect(piece.kind === "path" && piece.subpaths).toHaveLength(1);
    // Identical the instant it happens: it just has somewhere of its own to
    // put the change you are about to make.
    expect(piece.kind !== "audio" && piece.opacity).toBe(0.4);
    expect(piece.kind !== "audio" && piece.transform.x).toBe(clip.transform.x);
  });

  it("leaves the remainder behind, minus exactly what was taken", () => {
    const { doc, clip } = docWith([box(0, 0, 10, 10), box(50, 0, 10, 10)]);
    const takeId = clip.subpaths[1]!.id;
    extractContours(doc, clip.id, [takeId]);
    const rest = locateClip(doc, clip.id)!.clip;
    expect(rest.kind === "path" && rest.subpaths.map((c) => c.id)).toEqual([clip.subpaths[0]!.id]);
  });

  it("paints above the remainder, so the pixels do not move", () => {
    const { doc, clip } = docWith([box(0, 0, 10, 10), box(50, 0, 10, 10)]);
    const lane = locateClip(doc, clip.id)!.trackIndex;
    const id = extractContours(doc, clip.id, [clip.subpaths[1]!.id])!;
    expect(locateClip(doc, id)!.trackIndex).toBe(lane);
    expect(locateClip(doc, clip.id)!.trackIndex).toBe(lane + 1);
  });

  it("new CLIP id, but the contour KEEPS its identity — that is the point", () => {
    // A contour id is what a live selection, a clipboard payload, a morph
    // correspondence and an undo step hold across a structural edit. Extraction
    // is a structural edit, so the id has to survive it: whatever was pointing
    // at that piece is still pointing at it, one layer over.
    const { doc, clip } = docWith([box(0, 0, 10, 10), box(50, 0, 10, 10)]);
    const takeId = clip.subpaths[1]!.id;
    const id = extractContours(doc, clip.id, [takeId])!;
    const piece = locateClip(doc, id)!.clip;
    expect(piece.id).not.toBe(clip.id);
    expect(piece.kind === "path" && piece.subpaths[0]!.id).toBe(takeId);
  });

  it("refuses ALL the contours — that is a rename, not an override", () => {
    const { doc, clip } = docWith([box(0, 0, 10, 10), box(50, 0, 10, 10)]);
    expect(extractContours(doc, clip.id, clip.subpaths.map((c) => c.id))).toBeNull();
  });

  it("refuses an empty request and an unknown clip", () => {
    const { doc, clip } = docWith([box(0, 0, 10, 10), box(50, 0, 10, 10)]);
    expect(extractContours(doc, clip.id, [])).toBeNull();
    expect(extractContours(doc, "ghost", ["x"])).toBeNull();
  });
});

describe("mergeVectorClips — the inverse of separating", () => {
  it("collapses a vector group back to ONE pen-editable path layer, in its lane", () => {
    const { doc, clip } = docWith([box(0, 0, 10, 10), box(50, 0, 10, 10)]);
    const lane = locateClip(doc, clip.id)!.trackIndex;
    const res = promotePathClip(doc, clip.id)!;
    const merged = mergeVectorClips(doc, [res.nestedId!])!;
    const out = locateClip(doc, merged)!;
    expect(out.clip.kind).toBe("path");
    expect(out.clip.kind === "path" && out.clip.subpaths).toHaveLength(2);
    expect(out.trackIndex).toBe(lane);
    // The group is gone — merging is a merge, not a flag.
    expect(locateClip(doc, res.nestedId!)).toBeNull();
  });

  it("split → merge → split is a round trip", () => {
    const { doc, clip } = docWith([box(0, 0, 10, 10), box(50, 0, 10, 10)]);
    const first = promotePathClip(doc, clip.id)!;
    const merged = mergeVectorClips(doc, [first.nestedId!])!;
    const again = promotePathClip(doc, merged)!;
    expect(again.pieceIds).toHaveLength(2);
  });

  it("a piece that differed keeps differing — as a per-contour override", () => {
    // Merging must not silently repaint one piece in the other's colour.
    const { doc, clip } = docWith([box(0, 0, 10, 10), box(50, 0, 10, 10)]);
    clip.fills = [solidPaint("#ff0000")];
    const res = promotePathClip(doc, clip.id)!;
    const second = locateClip(doc, res.pieceIds[1]!)!.clip;
    if (second.kind === "path") second.fills = [solidPaint("#00ff00")];
    const merged = mergeVectorClips(doc, [res.nestedId!])!;
    const out = locateClip(doc, merged)!.clip;
    expect(out.kind === "path" && Object.keys(out.contourStyles).length).toBe(1);
  });

  it("merges sibling path layers that were never a group", () => {
    const { doc, clip } = docWith([box(0, 0, 10, 10)]);
    const other = createPathClip({ frameId: clip.frameId, subpaths: [box(50, 0, 10, 10)], startMs: 0, name: "B" });
    const t = createTrack("t2");
    t.clips.push(other);
    doc.tracks.push(t);
    const merged = mergeVectorClips(doc, [clip.id, other.id])!;
    const out = locateClip(doc, merged)!.clip;
    expect(out.kind === "path" && out.subpaths).toHaveLength(2);
  });

  it("returns null with nothing to merge, and passes a lone clip through", () => {
    const { doc, clip } = docWith([box(0, 0, 10, 10)]);
    expect(mergeVectorClips(doc, [])).toBeNull();
    expect(mergeVectorClips(doc, [clip.id])).toBe(clip.id);
  });
});

describe("naming", () => {
  it("a group inherits the layer's name — never 'Nested clip'", () => {
    const { doc, clip } = docWith([box(0, 0, 10, 10), box(50, 0, 10, 10)]);
    const res = promotePathClip(doc, clip.id)!;
    expect(locateClip(doc, res.nestedId!)!.clip.name).toBe("Logo");
    const frame = doc.frames.find((f) => f.name === "Logo");
    expect(frame).toBeTruthy();
  });
});

describe("merging carries the GROUP, not just the geometry", () => {
  it("the survivor keeps the group's span, keyframes, effects and in/out", () => {
    const { doc, clip } = docWith([box(0, 0, 10, 10), box(50, 0, 10, 10)]);
    const res = promotePathClip(doc, clip.id)!;
    const group = locateClip(doc, res.nestedId!)!.clip;
    if (group.kind !== "nested") throw new Error("separating must yield a group");
    group.startMs = 1200;
    group.durationMs = 3400;
    group.keyframes = [{ id: "k1", property: "opacity", range: null, keys: [] }];
    group.opacity = 0.5;
    const merged = mergeVectorClips(doc, [res.nestedId!])!;
    const out = locateClip(doc, merged)!.clip;
    if (out.kind !== "path") throw new Error("merge must yield a path clip");
    // Animating the group and then merging must not silently drop the animation.
    expect(out.startMs).toBe(1200);
    expect(out.durationMs).toBe(3400);
    expect(out.keyframes).toHaveLength(1);
    expect(out.opacity).toBe(0.5);
  });

  it("reports what a merge would discard — and nothing right after a separate", () => {
    const { doc, clip } = docWith([box(0, 0, 10, 10), box(50, 0, 10, 10)]);
    const res = promotePathClip(doc, clip.id)!;
    const group = locateClip(doc, res.nestedId!)!.clip;
    expect(vectorMergeLoss(doc, group)).toEqual([]);
    const piece = locateClip(doc, res.pieceIds[0]!)!.clip;
    piece.keyframes = [{ id: "k2", property: "x", range: null, keys: [] }];
    expect(vectorMergeLoss(doc, group).join()).toContain("keyframes");
  });

  it("produces a clip that survives structuredClone (no immer proxies leak)", () => {
    // Merging runs INSIDE an immer producer in the app, and assembles a new clip
    // out of style overlays read off drafts. A proxy smuggled into stored data
    // throws DataCloneError far from here, so reproduce the real conditions.
    const { doc, clip } = docWith([box(0, 0, 10, 10), box(50, 0, 10, 10)]);
    clip.fills = [solidPaint("#ff0000")];
    const separated = produce(doc, (d) => {
      const res = promotePathClip(d, clip.id)!;
      const second = locateClip(d, res.pieceIds[1]!)!.clip;
      if (second.kind !== "path") return;
      second.fills = [solidPaint("#00ff00")];
      // A per-contour override, which is what real imported SVG art carries —
      // this is the value that used to reach storage still wrapped in a draft.
      const ov = emptyOverlay();
      ov.added.fills = [solidPaint("#0000ff")];
      second.contourStyles[second.subpaths[0]!.id] = ov;
      // CURVE HANDLES are the actual leak: `hIn`/`hOut` are nested objects, so
      // reading them off a draft yields proxies that a shallow point copy then
      // carries into stored data. A box of straight lines never reproduced it.
      for (const id of res.pieceIds) {
        const piece = locateClip(d, id)!.clip;
        if (piece.kind !== "path") continue;
        for (const sp of piece.subpaths)
          for (const point of sp.points) {
            point.hIn = { x: point.x - 2, y: point.y };
            point.hOut = { x: point.x + 2, y: point.y };
          }
      }
    });
    const groupId = separated.tracks.flatMap((t) => t.clips).find((c) => c.kind === "nested")!.id;
    let mergedId: string | null = null;
    const after = produce(separated, (d) => {
      mergedId = mergeVectorClips(d, [groupId]);
    });
    expect(() => structuredClone(locateClip(after, mergedId!)!.clip)).not.toThrow();
  });
});

describe("separating does not churn the parent's lanes", () => {
  const parentLanes = (doc: MotionDocument, frameId: string) =>
    doc.tracks.filter((t) => t.clips.some((c) => c.frameId === frameId)).length;

  it("one layer in, ONE layer out — the parent's lane count is unchanged", () => {
    const { doc, clip } = docWith([box(0, 0, 10, 10), box(50, 0, 10, 10), box(100, 0, 10, 10)]);
    const before = parentLanes(doc, clip.frameId);
    const res = promotePathClip(doc, clip.id)!;
    expect(res.pieceIds).toHaveLength(3);
    // The pieces are born INSIDE the group, so the parent never grew a lane per
    // piece — the create-then-prune churn that left zombie lanes behind.
    expect(parentLanes(doc, clip.frameId)).toBe(before);
  });

  it("leaves no NEW empty lane behind the group", () => {
    const { doc, clip } = docWith([box(0, 0, 10, 10), box(50, 0, 10, 10)]);
    const before = doc.tracks.filter((t) => t.clips.length === 0).length;
    promotePathClip(doc, clip.id);
    expect(doc.tracks.filter((t) => t.clips.length === 0)).toHaveLength(before);
  });

  it("the pieces' lanes sit directly below the group's, in PAINT order", () => {
    const { doc, clip } = docWith([box(0, 0, 10, 10), box(50, 0, 10, 10), box(100, 0, 10, 10)]);
    const res = promotePathClip(doc, clip.id)!;
    const groupLane = locateClip(doc, res.nestedId!)!.trackIndex;
    // `pieceIds` is paint order (subpath order), lanes run topmost-first, so the
    // FIRST contour must land in the LAST lane — the split is not allowed to
    // turn the artwork inside out.
    const n = res.pieceIds.length;
    for (const [i, id] of res.pieceIds.entries())
      expect(locateClip(doc, id)!.trackIndex).toBe(groupLane + (n - i));
  });

  it("split then merge is a round trip — the stack comes back the way it went in", () => {
    const { doc, clip } = docWith([box(0, 0, 10, 10), box(50, 0, 10, 10), box(100, 0, 10, 10)]);
    const before = clip.subpaths.map((c) => c.points[0]!.x);
    const res = promotePathClip(doc, clip.id)!;
    const mergedId = mergeVectorClips(doc, [res.nestedId!])!;
    const merged = locateClip(doc, mergedId)!.clip as PathClip;
    expect(merged.subpaths.map((c) => c.points[0]!.x)).toEqual(before);
  });
});

describe("the root timeline shows ONE clip for a vector group", () => {
  it("no piece of the group is a clip of the parent comp", () => {
    // The user-visible promise, stated headlessly: whatever the Layers panel is
    // showing, the parent comp's own clip list is the group and nothing else.
    // A piece belongs to the group's comp, so a timeline that filters by frame
    // can never draw it here — which is why the lanes are gone, not gated.
    const { doc, clip } = docWith([box(0, 0, 10, 10), box(50, 0, 10, 10), box(100, 0, 10, 10)]);
    const parentFrame = clip.frameId;
    const res = promotePathClip(doc, clip.id)!;

    const inParent = doc.tracks.flatMap((t) => t.clips).filter((c) => c.frameId === parentFrame);
    expect(inParent).toHaveLength(1);
    expect(inParent[0]!.id).toBe(res.nestedId);
    for (const id of res.pieceIds) {
      expect(locateClip(doc, id)!.clip.frameId).not.toBe(parentFrame);
    }
  });
});
