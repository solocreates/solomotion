import { describe, it, expect } from "vitest";
import {
  createEmptyDocument,
  createShapeClip,
  createTrack,
  createCarrierTrack,
  createVideoClip,
} from "../factories";
import { groupClips, groupClipById, clipsInGroup, groupOfClip } from "./groups";
import { applyCompositeMode } from "./group-composite";
import { frameLanes, frameLayerTree, type LayerTreeNode } from "./layer-tree";
import { cleanupEmptyTracks, emptyTrackCount, locateClip, restackUnits } from "./ops";
import { sortLayers, reverseLayers } from "./layer-sort";
import { layerGapCandidates, resolveLayerGap, type LayerDropRow } from "./layer-drop";
import { clipRenderLocalTime } from "../animation/evaluate";
import type { MotionDocument, ShapeClip } from "../schema";

const frameIdOf = (doc: MotionDocument) => doc.frames[0]!.id;
const laneOf = (doc: MotionDocument, id: string) =>
  doc.tracks.findIndex((t) => t.clips.some((c) => c.id === id));

/** N named shapes, each on its own lane, top-first. */
function shapes(doc: MotionDocument, names: string[]): ShapeClip[] {
  return names.map((name) => {
    const clip = createShapeClip({ frameId: frameIdOf(doc), shape: "rect", startMs: 0 }) as ShapeClip;
    clip.name = name;
    clip.durationMs = 1000;
    const lane = createTrack(`lane-${name}`);
    lane.clips.push(clip);
    doc.tracks.push(lane);
    return clip;
  });
}

/** The drop-row projection a layers list would hand the resolver. */
function rowsOf(doc: MotionDocument, frameId: string): LayerDropRow[] {
  const out: LayerDropRow[] = [];
  const walk = (nodes: LayerTreeNode[], depth: number, parent: string | null) => {
    for (const node of nodes) {
      const base = {
        key: node.clip.id,
        frameId,
        parentGroupId: parent,
        depth,
        trackIndex: node.trackIndex,
        collapsed: false,
        inert: false,
        audio: false,
      };
      if (node.type === "group") {
        out.push({
          ...base,
          kind: "group",
          groupId: node.clip.id,
          interiorTop: node.interiorTop,
        });
        walk(node.children, depth + 1, node.clip.id);
      } else {
        out.push({
          ...base,
          kind: "clip",
          groupId: null,
          interiorTop: node.trackIndex,
        });
      }
    }
  };
  walk(frameLayerTree(doc, frameId), 1, null);
  return out;
}

describe("zombie lanes", () => {
  it("a restack takes its own carrier lane with it", () => {
    const doc = createEmptyDocument();
    const [a, b] = shapes(doc, ["a", "b"]);
    // Give `a` an AUTO carrier, the lane every restack mints.
    const carrier = createCarrierTrack();
    carrier.clips.push(doc.tracks.find((t) => t.clips.some((c) => c.id === a!.id))!.clips.pop()!);
    doc.tracks = doc.tracks.filter((t) => t.clips.length > 0 || t.name !== "lane-a");
    doc.tracks.unshift(carrier);
    const before = doc.tracks.length;

    restackUnits(doc, [{ kind: "clip", id: a!.id }], { trackIndex: laneOf(doc, b!.id) + 1 });

    // One lane minted, one vacated carrier swept: the stack is not taller.
    expect(doc.tracks.length).toBe(before);
    expect(laneOf(doc, a!.id)).toBeGreaterThan(laneOf(doc, b!.id));
  });

  it("a user-made lane the clip left still survives the restack", () => {
    const doc = createEmptyDocument();
    const [a, b] = shapes(doc, ["a", "b"]); // shapes() uses createTrack → auto:false
    const before = doc.tracks.length;
    restackUnits(doc, [{ kind: "clip", id: a!.id }], { trackIndex: laneOf(doc, b!.id) + 1 });
    expect(doc.tracks.length).toBe(before + 1); // the emptied user lane stays
  });

  it("the explicit sweep takes the lanes the automatic prune will not", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    shapes(doc, ["a"]);
    const spare = createTrack("spare", fid); // a "+ Track" nobody used
    doc.tracks.push(spare);
    // The document's three starter lanes are empty and homed to this comp too.
    expect(emptyTrackCount(doc, fid)).toBe(4);
    expect(cleanupEmptyTracks(doc, fid)).toBe(4);
    expect(doc.tracks.length).toBe(1);
    expect(doc.tracks[0]!.clips.length).toBe(1);
  });

  it("never sweeps another comp's lanes, and never empties the document", () => {
    const doc = createEmptyDocument();
    const other = { ...doc.frames[0]!, id: "frame_other", name: "Other" };
    doc.frames.push(other);
    doc.tracks = [createTrack("mine", frameIdOf(doc)), createTrack("theirs", other.id)];
    expect(cleanupEmptyTracks(doc, frameIdOf(doc))).toBe(1);
    expect(doc.tracks.map((t) => t.name)).toEqual(["theirs"]);
    // A comp whose only lanes are its own empties keeps one to stand on.
    const solo = createEmptyDocument();
    solo.tracks = [createTrack("only", frameIdOf(solo))];
    expect(cleanupEmptyTracks(solo, frameIdOf(solo))).toBe(0);
    expect(solo.tracks.length).toBe(1);
  });
});

describe("a group's rows are its own", () => {
  it("a top-level lane wedged among a group's rows in the array is still drawn at the top level", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    doc.tracks = []; // start from a clean stack
    const [a, b] = shapes(doc, ["a", "b"]);
    const gid = groupClips(doc, [a!.id, b!.id])!;
    // A blank top-level lane wedged between the group's two rows.
    const spare = createTrack("spare", fid);
    doc.tracks.splice(laneOf(doc, a!.id) + 1, 0, spare);

    const lanes = frameLanes(doc, fid);
    const rows = lanes.map((l) => l.track.id);
    const gLane = rows.indexOf(doc.tracks.find((t) => t.clips.some((c) => c.id === gid))!.id);
    const aLane = rows.indexOf(doc.tracks.find((t) => t.clips.some((c) => c.id === a!.id))!.id);
    const bLane = rows.indexOf(doc.tracks.find((t) => t.clips.some((c) => c.id === b!.id))!.id);
    const spareRow = rows.indexOf(spare.id);

    // The band reads: the group's lane, then its rows, uninterrupted.
    expect(gLane).toBeLessThan(aLane);
    expect(aLane).toBe(bLane - 1);
    expect(spareRow).toBeGreaterThan(bLane);
    expect(lanes[spareRow]!.depth).toBe(0);
  });
});

describe("where a dragged layer lands", () => {
  it("offers an exit at every enclosing level from the last row of a nest", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    const [a, b, c] = shapes(doc, ["a", "b", "c"]);
    const inner = groupClips(doc, [b!.id, c!.id])!;
    const outer = groupClips(doc, [a!.id, inner])!;

    const rows = rowsOf(doc, frameIdOf(doc));
    const gap = rows.length; // past the very last row (c, deepest)
    const plans = layerGapCandidates(doc, rows, {
      gapIndex: gap,
      pointerDepth: 0,
      units: [{ kind: "clip", id: a!.id }],
      audio: false,
    });
    const dests = plans.map((p) => p.groupId);
    expect(dests).toContain(inner); // stay inside
    expect(dests).toContain(outer); // one level out
    expect(dests).toContain(null); // all the way out to the comp

    // Aiming far left picks the shallowest reading — the way out of everything.
    const out = resolveLayerGap(doc, rows, {
      gapIndex: gap,
      pointerDepth: 0,
      units: [{ kind: "clip", id: c!.id }],
      audio: false,
    })!;
    expect(out.groupId).toBeNull();
  });

  it("a layer can leave a MASK group, which is the same gap arithmetic", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    const [stencil, content] = shapes(doc, ["stencil", "content"]);
    const gid = applyCompositeMode(doc, [stencil!.id, content!.id], "mask")!;
    expect(groupClipById(doc, gid)!.mode).toBe("mask");

    const rows = rowsOf(doc, frameIdOf(doc));
    const plan = resolveLayerGap(doc, rows, {
      gapIndex: rows.length,
      pointerDepth: 0,
      units: [{ kind: "clip", id: content!.id }],
      audio: false,
    })!;
    expect(plan.groupId).toBeNull();

    restackUnits(doc, [{ kind: "clip", id: content!.id }], plan.target);
    expect(groupOfClip(doc, content!.id)).toBeNull();
  });

  it("a drop inside a composite group adopts the side it landed beside", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    const [stencil, content, loose] = shapes(doc, ["stencil", "content", "loose"]);
    const gid = applyCompositeMode(doc, [stencil!.id, content!.id], "mask")!;
    const members = clipsInGroup(doc, gid);
    expect(members.length).toBe(2);

    const rows = rowsOf(doc, frameIdOf(doc));
    const stencilRow = rows.findIndex((r) => r.key === stencil!.id);
    const isStencil = (key: string) => {
      const found = locateClip(doc, key)?.clip;
      return found && found.kind !== "audio" ? found.isStencil : null;
    };
    // The gap right under the stencil member means "join the stencil".
    const plan = resolveLayerGap(
      doc,
      rows,
      { gapIndex: stencilRow + 1, pointerDepth: 2, units: [{ kind: "clip", id: loose!.id }], audio: false },
      isStencil,
    )!;
    expect(plan.groupId).toBe(gid);
    expect(plan.target.isStencil).toBe(true);
  });

  it("refuses to drop a group into itself", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    const [a, b] = shapes(doc, ["a", "b"]);
    const gid = groupClips(doc, [a!.id, b!.id])!;
    const rows = rowsOf(doc, frameIdOf(doc));
    const plans = layerGapCandidates(doc, rows, {
      gapIndex: rows.findIndex((r) => r.key === a!.id),
      pointerDepth: 2,
      units: [{ kind: "group", id: gid }],
      audio: false,
    });
    expect(plans.every((p) => p.groupId !== gid)).toBe(true);
  });
});

describe("sorting the stack", () => {
  it("sorts by name without scattering a group", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    const [c, a, b] = shapes(doc, ["c", "a", "b"]);
    const gid = groupClips(doc, [a!.id, b!.id])!;
    // The group is named so it has to travel PAST `c` — a sort that moves
    // nothing proves nothing about whether the group moved whole.
    groupClipById(doc, gid)!.name = "abc";
    expect(laneOf(doc, c!.id)).toBeLessThan(laneOf(doc, gid));

    expect(sortLayers(doc, frameIdOf(doc), "name", "asc")).toBe(true);
    // "abc" now sorts above "c", and the group took its members with it.
    expect(laneOf(doc, gid)).toBeLessThan(laneOf(doc, c!.id));
    expect(laneOf(doc, gid)).toBeLessThan(laneOf(doc, a!.id));
    expect(Math.abs(laneOf(doc, a!.id) - laneOf(doc, b!.id))).toBe(1);
    expect(laneOf(doc, b!.id)).toBeLessThan(laneOf(doc, c!.id));
  });

  it("sorts a group's own members too", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    const [b, a] = shapes(doc, ["b", "a"]);
    const gid = groupClips(doc, [b!.id, a!.id])!;
    expect(laneOf(doc, b!.id)).toBeLessThan(laneOf(doc, a!.id));
    sortLayers(doc, frameIdOf(doc), "name", "asc");
    expect(laneOf(doc, a!.id)).toBeLessThan(laneOf(doc, b!.id));
    expect(laneOf(doc, gid)).toBeLessThan(laneOf(doc, a!.id));
  });

  it("leaves other comps' lanes exactly where they were", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    const other = { ...doc.frames[0]!, id: "frame_other", name: "Other" };
    doc.frames.push(other);
    const [b, a] = shapes(doc, ["b", "a"]);
    const foreign = createTrack("foreign");
    const alien = createShapeClip({ frameId: other.id, shape: "rect", startMs: 0 });
    foreign.clips.push(alien);
    doc.tracks.splice(1, 0, foreign); // wedged between the two sortable lanes
    sortLayers(doc, frameIdOf(doc), "name", "asc");
    expect(doc.tracks[1]).toBe(foreign);
    expect(laneOf(doc, a!.id)).toBeLessThan(laneOf(doc, b!.id));
  });

  it("sorting twice by the same key changes nothing the second time", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    shapes(doc, ["b", "a", "c"]);
    sortLayers(doc, frameIdOf(doc), "name", "asc");
    expect(sortLayers(doc, frameIdOf(doc), "name", "asc")).toBe(false);
  });

  it("reverse flips the stack, groups included", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    const [a, b] = shapes(doc, ["a", "b"]);
    reverseLayers(doc, frameIdOf(doc));
    expect(laneOf(doc, b!.id)).toBeLessThan(laneOf(doc, a!.id));
  });
});

describe("a clip that has ended has ended", () => {
  it("a lone video shows nothing past its own out point", () => {
    const doc = createEmptyDocument();
    const clip = createVideoClip({ frameId: frameIdOf(doc), assetId: "a", startMs: 0, durationMs: 1000 });
    const track = createTrack("v");
    track.clips.push(clip);
    expect(clipRenderLocalTime(track, clip, 500)).not.toBeNull();
    // Past the end there is no gap to fill — the layer is simply over.
    expect(clipRenderLocalTime(track, clip, 1500)).toBeNull();
    expect(clipRenderLocalTime(track, clip, 999_999)).toBeNull();
  });

  it("but an INTERNAL gap still fills, so a montage never flashes", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    const first = createVideoClip({ frameId: fid, assetId: "a", startMs: 0, durationMs: 1000 });
    const second = createVideoClip({ frameId: fid, assetId: "b", startMs: 2000, durationMs: 1000 });
    const track = createTrack("v");
    track.clips.push(first, second);
    // In the gap: the NEXT shot's first frame, held.
    expect(clipRenderLocalTime(track, first, 1500)).toBeNull();
    expect(clipRenderLocalTime(track, second, 1500)).toEqual({ local: 0, held: true });
    // Before the first clip: still nothing.
    expect(clipRenderLocalTime(track, first, -10)).toBeNull();
    // After the last: nothing.
    expect(clipRenderLocalTime(track, second, 3500)).toBeNull();
  });
});

describe("a restack lands where it was aimed, whatever the array order", () => {
  it("dropping a loose layer at an index among a group's rows keeps it at the top level", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    doc.tracks = [];
    const [a, b, loose] = shapes(doc, ["a", "b", "loose"]);
    const gid = groupClips(doc, [a!.id, b!.id])!;
    restackUnits(doc, [{ kind: "clip", id: loose!.id }], {
      trackIndex: laneOf(doc, a!.id) + 1,
      frameId: fid,
      groupId: null,
    });
    const lanes = frameLanes(doc, fid);
    const depthOf = (id: string) =>
      lanes.find((l) => l.track.clips.some((c) => c.id === id))!.depth;
    expect(depthOf(loose!.id)).toBe(0);
    expect(groupOfClip(doc, loose!.id)).toBeNull();
    // The group's rows still read as one band, in order.
    const rowOf = (id: string) => lanes.findIndex((l) => l.track.clips.some((c) => c.id === id));
    expect(rowOf(b!.id)).toBe(rowOf(a!.id) + 1);
    expect(gid).toBeTruthy();
  });
});

describe("a composite takes as many layers as you give it", () => {
  it("adding to an existing union extends it instead of nesting another group", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    const [a, b, c] = shapes(doc, ["a", "b", "c"]);
    const gid = applyCompositeMode(doc, [a!.id, b!.id], "union")!;
    expect(clipsInGroup(doc, gid).length).toBe(2);

    // Select the union AND a loose sibling, ask for Union again.
    const same = applyCompositeMode(doc, [gid, c!.id], "union");
    expect(same).toBe(gid); // the SAME group — no wrapper
    expect(clipsInGroup(doc, gid).sort()).toEqual([a!.id, b!.id, c!.id].sort());
    // …and no second group was created anywhere.
    expect(doc.tracks.flatMap((t) => t.clips).filter((x) => x.kind === "group").length).toBe(1);
  });

  it("a newcomer joins a mask as CONTENT, and the stencil is untouched", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    const [stencil, content, extra] = shapes(doc, ["stencil", "content", "extra"]);
    const gid = applyCompositeMode(doc, [stencil!.id, content!.id], "mask")!;
    const roleOf = (id: string) => {
      const clip = locateClip(doc, id)!.clip;
      return clip.kind !== "audio" ? clip.isStencil : null;
    };
    expect(roleOf(stencil!.id)).toBe(true);

    expect(applyCompositeMode(doc, [gid, extra!.id], "mask")).toBe(gid);
    expect(roleOf(extra!.id)).toBe(false);
    expect(roleOf(stencil!.id)).toBe(true);
    expect(clipsInGroup(doc, gid).length).toBe(3);
  });

  it("a DIFFERENT mode is genuinely a new operation, so it wraps", () => {
    const doc = createEmptyDocument();
    doc.tracks = [];
    const [a, b, c] = shapes(doc, ["a", "b", "c"]);
    const union = applyCompositeMode(doc, [a!.id, b!.id], "union")!;
    const outer = applyCompositeMode(doc, [union, c!.id], "subtract");
    expect(outer).not.toBe(union);
    expect(groupClipById(doc, union)!.mode).toBe("union");
    expect(groupClipById(doc, outer!)!.mode).toBe("subtract");
    expect(groupOfClip(doc, union)).toBe(outer);
  });
});
