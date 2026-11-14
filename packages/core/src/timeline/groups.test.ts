import { describe, it, expect } from "vitest";
import { createAudioClip, createEmptyDocument, createShapeClip, createTrack } from "../factories";
import {
  canUngroup,
  clipsUnderGroup,
  groupClipById,
  groupClips,
  groupOfClip,
  groupRows,
  insertTrackNear,
  moveClipsToScope,
  pruneGroups,
  pullClipsOutOneLevel,
  ungroupClips,
} from "./groups";
import { applyCompositeMode, swapGroupRoles } from "./group-composite";
import { planGroupRetime, withinGroupWindow } from "./group-time";
import { groupCarriesLook, groupNeedsIsolation, groupTintFills } from "./group-paint";
import { clipsInGroup } from "./groups";
import { layoutSpecSchema } from "../schema/relations";
import { frameLanes, frameLayerTree, frameRows } from "./layer-tree";
import { trimClip, splitClip, moveClip, moveClipOverwrite, duplicateClips, moveClipsToNewLanes, restackUnits } from "./ops";
import { parseDocument, serializeDocument } from "../io";
import { solidPaint } from "../schema/vector";
import type { MotionDocument, Clip, ShapeClip } from "../schema";

const frameIdOf = (doc: MotionDocument) => doc.frames[0]!.id;

/** N shapes, each on its own lane, spanning [start, start+dur). */
function shapes(doc: MotionDocument, specs: Array<{ start: number; dur: number }>): ShapeClip[] {
  const out: ShapeClip[] = [];
  specs.forEach((spec, i) => {
    const clip = createShapeClip({ frameId: frameIdOf(doc), shape: "rect", startMs: spec.start }) as ShapeClip;
    clip.durationMs = spec.dur;
    const lane = createTrack(`lane${i}`);
    lane.clips.push(clip);
    doc.tracks.push(lane);
    out.push(clip);
  });
  return out;
}

const find = (doc: MotionDocument, id: string): Clip =>
  doc.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
const laneOf = (doc: MotionDocument, id: string) => doc.tracks.findIndex((t) => t.clips.some((c) => c.id === id));
const trackOf = (doc: MotionDocument, id: string) => doc.tracks.find((t) => t.clips.some((c) => c.id === id))!;

describe("a group is one layer, and its rows are its own", () => {
  it("spans what it holds, takes the topmost member's z, and holds its members on rows that name it", () => {
    const doc = createEmptyDocument();
    const [a, b] = shapes(doc, [{ start: 1000, dur: 2000 }, { start: 2000, dur: 3000 }]);
    const gid = groupClips(doc, [a!.id, b!.id])!;
    const group = groupClipById(doc, gid)!;

    expect(group.startMs).toBe(1000);
    expect(group.durationMs).toBe(4000); // 1000 → 5000
    // Membership is the row: both members sit on rows scoped to the group.
    expect(trackOf(doc, a!.id).groupId).toBe(gid);
    expect(trackOf(doc, b!.id).groupId).toBe(gid);
    expect(groupOfClip(doc, a!.id)).toBe(gid);
    // The group clip itself is on a lane of the comp — not of its own interior.
    expect(trackOf(doc, gid).groupId).toBeNull();
    // Two source lanes → two rows, in the same order.
    expect(groupRows(doc, gid).map((r) => r.clips[0]!.id)).toEqual([a!.id, b!.id]);
  });

  it("keeps a source lane's identity when every clip on it joins", () => {
    const doc = createEmptyDocument();
    const [a, b] = shapes(doc, [{ start: 0, dur: 1000 }, { start: 0, dur: 1000 }]);
    const laneA = trackOf(doc, a!.id);
    laneA.name = "Hero";
    laneA.color = "#ff0000";
    const gid = groupClips(doc, [a!.id, b!.id])!;
    // Re-scoped in place — name, colour and the transitions it held survive.
    expect(trackOf(doc, a!.id)).toBe(laneA);
    expect(laneA.groupId).toBe(gid);
    expect(laneA.name).toBe("Hero");
  });

  it("shares a lane with a non-member when the group fits beside it", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    const [a, b] = shapes(doc, [{ start: 0, dur: 1000 }, { start: 0, dur: 1000 }]);
    const later = createShapeClip({ frameId: fid, shape: "rect", startMs: 5000 }) as ShapeClip;
    trackOf(doc, a!.id).clips.push(later);
    const lanes = doc.tracks.length;
    const gid = groupClips(doc, [a!.id, b!.id])!;
    // `a` left, the group (0→1000) fits beside `later` (5000→), so it lands there.
    expect(trackOf(doc, gid)).toBe(trackOf(doc, later.id));
    // …and `b`'s lane was re-scoped, `a` got a minted row: lanes + 1.
    expect(doc.tracks.length).toBe(lanes + 1);
  });

  it("moves as one thing: dragging the group carries everything inside", () => {
    const doc = createEmptyDocument();
    const [a, b] = shapes(doc, [{ start: 1000, dur: 2000 }, { start: 2000, dur: 2000 }]);
    const gid = groupClips(doc, [a!.id, b!.id])!;

    moveClip(doc, gid, 3000); // +2000
    expect(groupClipById(doc, gid)!.startMs).toBe(3000);
    expect(find(doc, a!.id).startMs).toBe(3000);
    expect(find(doc, b!.id).startMs).toBe(4000); // relative timing preserved
  });

  it("and through OVERWRITE too — the path a timeline drag actually takes", () => {
    const doc = createEmptyDocument();
    const [a, b] = shapes(doc, [{ start: 1000, dur: 2000 }, { start: 2000, dur: 2000 }]);
    const gid = groupClips(doc, [a!.id, b!.id])!;
    moveClipOverwrite(doc, gid, 3000);
    expect(groupClipById(doc, gid)!.startMs).toBe(3000);
    expect(find(doc, a!.id).startMs).toBe(3000);
    expect(find(doc, b!.id).startMs).toBe(4000);
  });

  it("a group moves to ANY lane, and its rows do not care", () => {
    const doc = createEmptyDocument();
    const [a, b, c] = shapes(doc, [{ start: 0, dur: 1000 }, { start: 0, dur: 1000 }, { start: 5000, dur: 1000 }]);
    const gid = groupClips(doc, [a!.id, b!.id])!;
    const rowsBefore = groupRows(doc, gid).map((r) => r.id);
    // Drag the bar onto c's lane (it fits: c is at 5000).
    expect(moveClip(doc, gid, 0, trackOf(doc, c!.id).id)).toBe(true);
    expect(trackOf(doc, gid)).toBe(trackOf(doc, c!.id));
    expect(groupRows(doc, gid).map((r) => r.id)).toEqual(rowsBefore);
    expect(new Set(clipsUnderGroup(doc, gid))).toEqual(new Set([a!.id, b!.id]));
  });

  it("two groups on one lane are siblings at one depth", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    const [a, b, c, d] = shapes(doc, [
      { start: 0, dur: 1000 },
      { start: 0, dur: 1000 },
      { start: 3000, dur: 1000 },
      { start: 3000, dur: 1000 },
    ]);
    const g1 = groupClips(doc, [a!.id, b!.id])!;
    const g2 = groupClips(doc, [c!.id, d!.id])!;
    moveClip(doc, g2, 3000, trackOf(doc, g1).id);
    expect(trackOf(doc, g1)).toBe(trackOf(doc, g2));
    const tree = frameLayerTree(doc, fid);
    expect(tree.map((n) => n.clip.id)).toEqual([g1, g2]);
    expect(tree.every((n) => n.type === "group" && n.children.length === 2)).toBe(true);
    // The row list puts each band under the shared lane, in time order.
    const rows = frameRows(doc, fid);
    const bands = rows.filter((r) => r.kind === "group").map((r) => (r.kind === "group" ? r.group.id : ""));
    expect(bands).toEqual([g1, g2]);
  });
});

describe("the group's window", () => {
  it("trimming the group carries the layers FLUSH with the edge, and only those", () => {
    const doc = createEmptyDocument();
    const [a, b] = shapes(doc, [{ start: 0, dur: 2000 }, { start: 2000, dur: 3000 }]);
    const gid = groupClips(doc, [a!.id, b!.id])!;
    expect(groupClipById(doc, gid)!.durationMs).toBe(5000);

    // `b` ends WITH the group, so the group's end is `b`'s end: it shortens
    // rather than being hidden behind the window.
    trimClip(doc, gid, "end", 3000);
    expect(groupClipById(doc, gid)!.durationMs).toBe(3000);
    expect(find(doc, b!.id).startMs).toBe(2000);
    expect(find(doc, b!.id).durationMs).toBe(1000);
    // `a` ends inside the window at 2000 — its timing is its own business.
    expect(find(doc, a!.id).startMs).toBe(0);
    expect(find(doc, a!.id).durationMs).toBe(2000);

    // The head carries `a` for the same reason, and leaves `b` alone.
    trimClip(doc, gid, "start", 1000);
    expect(groupClipById(doc, gid)!.startMs).toBe(1000);
    expect(find(doc, a!.id).startMs).toBe(1000);
    expect(find(doc, a!.id).durationMs).toBe(1000);
    expect(find(doc, b!.id).startMs).toBe(2000);
  });

  it("a layer that is NOT flush stays put — the window hides it", () => {
    const doc = createEmptyDocument();
    const [a, b] = shapes(doc, [{ start: 0, dur: 2000 }, { start: 2000, dur: 3000 }]);
    const gid = groupClips(doc, [a!.id, b!.id])!;
    // Pull `b` clear of the group's end first: now nothing is flush with it.
    trimClip(doc, b!.id, "end", 4000);

    trimClip(doc, gid, "end", 3000);
    expect(find(doc, b!.id).durationMs).toBe(2000);
    expect(withinGroupWindow(doc, b!.id, 3500)).toBe(false);
    expect(withinGroupWindow(doc, b!.id, 2500)).toBe(true);
  });

  it("the carry is recursive, and stops at a sub-group that is not flush", () => {
    const doc = createEmptyDocument();
    const [deep, shallow] = shapes(doc, [{ start: 0, dur: 5000 }, { start: 0, dur: 4000 }]);
    const flushInner = groupClips(doc, [deep!.id])!;
    const shortInner = groupClips(doc, [shallow!.id])!;
    const outer = groupClips(doc, [flushInner, shortInner])!;
    expect(groupClipById(doc, outer)!.durationMs).toBe(5000);

    trimClip(doc, outer, "end", 3000);
    // The flush sub-group follows, and so does the leaf inside it.
    expect(groupClipById(doc, flushInner)!.durationMs).toBe(3000);
    expect(find(doc, deep!.id).durationMs).toBe(3000);
    // The sub-group that ends early is a boundary: neither it nor its leaf moves.
    expect(groupClipById(doc, shortInner)!.durationMs).toBe(4000);
    expect(find(doc, shallow!.id).durationMs).toBe(4000);
  });

  it("a follower clamps on its own limits and then stops following", () => {
    const doc = createEmptyDocument();
    const [a] = shapes(doc, [{ start: 0, dur: 5000 }]);
    const gid = groupClips(doc, [a!.id])!;
    // 20ms of group is below any clip's floor: the group gets it, the member
    // stops at 50ms rather than inverting.
    trimClip(doc, gid, "end", 20);
    expect(groupClipById(doc, gid)!.durationMs).toBe(50);
    expect(find(doc, a!.id).durationMs).toBe(50);
  });

  it("a descendant outside the group's span does not render, at any depth", () => {
    const doc = createEmptyDocument();
    const [a, b, c] = shapes(doc, [{ start: 0, dur: 1000 }, { start: 5000, dur: 1000 }, { start: 0, dur: 6000 }]);
    const inner = groupClips(doc, [a!.id, b!.id])!;
    const outer = groupClips(doc, [inner, c!.id])!;
    expect(withinGroupWindow(doc, b!.id, 5500)).toBe(true);
    groupClipById(doc, outer)!.durationMs = 2000;
    expect(withinGroupWindow(doc, b!.id, 5500)).toBe(false);
    expect(withinGroupWindow(doc, a!.id, 500)).toBe(true);
  });

  it("a retime scales the contents rather than time-mapping the group", () => {
    const doc = createEmptyDocument();
    const [a, b] = shapes(doc, [{ start: 1000, dur: 1000 }, { start: 2000, dur: 1000 }]);
    const gid = groupClips(doc, [a!.id, b!.id])!;

    const edits = planGroupRetime(doc, gid, 2);
    const byId = new Map(edits.map((e) => [e.clipId, e]));
    expect(byId.get(gid)!.startMs).toBe(1000);
    expect(byId.get(a!.id)!.durationMs).toBe(2000);
    expect(byId.get(b!.id)!.startMs).toBe(3000);
  });
});

describe("splitting a group", () => {
  it("cuts the contents too — two groups, each holding its own half", () => {
    const doc = createEmptyDocument();
    const [a, b] = shapes(doc, [{ start: 0, dur: 4000 }, { start: 0, dur: 4000 }]);
    const gid = groupClips(doc, [a!.id, b!.id])!;

    const rightId = splitClip(doc, gid, 2000)!;
    expect(rightId).toBeTruthy();
    // The container is cut…
    expect(groupClipById(doc, gid)!.durationMs).toBe(2000);
    expect(groupClipById(doc, rightId)!.startMs).toBe(2000);
    // …and so is every member, each half landing in the group that owns it.
    const left = clipsInGroup(doc, gid).map((id) => find(doc, id));
    const right = clipsInGroup(doc, rightId).map((id) => find(doc, id));
    expect(left).toHaveLength(2);
    expect(right).toHaveLength(2);
    expect(left.every((c) => c.startMs === 0 && c.durationMs === 2000)).toBe(true);
    expect(right.every((c) => c.startMs === 2000 && c.durationMs === 2000)).toBe(true);
  });

  it("is recursive, and a member entirely past the cut moves whole", () => {
    const doc = createEmptyDocument();
    const [deep, late] = shapes(doc, [{ start: 0, dur: 4000 }, { start: 3000, dur: 1000 }]);
    const inner = groupClips(doc, [deep!.id])!;
    const outer = groupClips(doc, [inner, late!.id])!;

    const rightId = splitClip(doc, outer, 2000)!;
    // The sub-group straddled the cut, so it was cut in turn — and its own leaf
    // with it, at any depth.
    const rightMembers = clipsInGroup(doc, rightId);
    const rightInner = rightMembers.map((id) => find(doc, id)).find((c) => c.kind === "group")!;
    expect(rightInner.startMs).toBe(2000);
    expect(rightInner.durationMs).toBe(2000);
    expect(clipsInGroup(doc, rightInner.id).map((id) => find(doc, id))).toEqual([
      expect.objectContaining({ startMs: 2000, durationMs: 2000 }),
    ]);
    // `late` lies entirely after the cut: moved, not split.
    const moved = find(doc, late!.id);
    expect(moved.startMs).toBe(3000);
    expect(moved.durationMs).toBe(1000);
    expect(clipsInGroup(doc, rightId)).toContain(late!.id);
    expect(clipsInGroup(doc, outer)).not.toContain(late!.id);
  });
});

describe("the group's tint", () => {
  it("is the group's own paint, worn over the members, and writes into none of them", () => {
    const doc = createEmptyDocument();
    const [a, b] = shapes(doc, [{ start: 0, dur: 1000 }, { start: 0, dur: 1000 }]);
    b!.fills = [solidPaint("#00ff00")];
    const group = groupClipById(doc, groupClips(doc, [a!.id, b!.id])!)!;
    group.fills = [solidPaint("#ff0000")];

    // The tint is the group's list, whole — it does not care what the members
    // have, which is the fix: every clip is born with a fill, so a rule that
    // only reached EMPTY children reached nothing.
    expect(groupTintFills(group)).toEqual(group.fills);
    // …and nothing was written into a member, so ungrouping restores them.
    expect(b!.fills[0]).toMatchObject({ color: "#00ff00" });

    group.fills = [];
    expect(groupTintFills(group)).toEqual([]);
  });

  it("a CONTAINER's fill is its box, not a tint — so it never recolours a member", () => {
    const doc = createEmptyDocument();
    const [a, b] = shapes(doc, [{ start: 0, dur: 1000 }, { start: 0, dur: 1000 }]);
    const group = groupClipById(doc, groupClips(doc, [a!.id, b!.id])!)!;
    group.fills = [solidPaint("#ff0000")];
    group.layout = layoutSpecSchema.parse({});

    expect(groupTintFills(group)).toEqual([]);
    // It still has a box to draw, so a serializer must not drop it.
    expect(groupCarriesLook(group)).toBe(true);
  });

  it("a tint buys isolation; a plain group costs nothing until it has to", () => {
    const doc = createEmptyDocument();
    const [a, b] = shapes(doc, [{ start: 0, dur: 1000 }, { start: 0, dur: 1000 }]);
    const group = groupClipById(doc, groupClips(doc, [a!.id, b!.id])!)!;
    expect(groupNeedsIsolation(group)).toBe(false);
    group.opacity = 0.5;
    expect(groupNeedsIsolation(group)).toBe(true);
    group.opacity = 1;
    group.strokes = [];
    group.mode = "subtract";
    expect(groupNeedsIsolation(group)).toBe(true);
    group.mode = "pass";
    expect(groupNeedsIsolation(group)).toBe(false);
    // A tint is composited ATOP the members, so it needs them as one picture.
    group.fills = [solidPaint("#ff0000")];
    expect(groupNeedsIsolation(group)).toBe(true);
  });
});

describe("rows and the tree agree", () => {
  it("a group's band sits under its lane, and collapsing it hides only what is inside", () => {
    const doc = createEmptyDocument();
    const [a, b, c] = shapes(doc, [
      { start: 0, dur: 1000 },
      { start: 0, dur: 1000 },
      { start: 0, dur: 1000 },
    ]);
    const gid = groupClips(doc, [a!.id, b!.id])!;
    const fid = frameIdOf(doc);

    const open = frameLanes(doc, fid);
    const rowOf = (id: string) => open.findIndex((l) => l.track.clips.some((x) => x.id === id));
    expect(open[rowOf(gid)]!.depth).toBe(0);
    expect(open[rowOf(a!.id)]!.depth).toBe(1);
    expect(open[rowOf(a!.id)]!.scope?.id).toBe(gid);
    expect(open[rowOf(b!.id)]!.depth).toBe(1);
    expect(open[rowOf(c!.id)]!.depth).toBe(0);
    expect(rowOf(gid)).toBeLessThan(rowOf(a!.id));

    const shut = frameLanes(doc, fid, new Set([gid]));
    expect(shut.some((l) => l.track.clips.some((x) => x.id === a!.id))).toBe(false);
    expect(shut.some((l) => l.track.clips.some((x) => x.id === gid))).toBe(true);
    // Collapsing cannot move what is ABOVE the group.
    expect(shut.findIndex((l) => l.track.clips.some((x) => x.id === gid))).toBe(rowOf(gid));
  });

  it("the layer tree places a group at its OWN lane, children by their rows' order", () => {
    const doc = createEmptyDocument();
    const [a, b] = shapes(doc, [{ start: 0, dur: 1000 }, { start: 0, dur: 1000 }]);
    const gid = groupClips(doc, [a!.id, b!.id])!;
    const tree = frameLayerTree(doc, frameIdOf(doc));
    const node = tree.find((n) => n.type === "group")!;
    if (node.type !== "group") throw new Error("expected a group node");
    expect(node.clip.id).toBe(gid);
    expect(node.trackIndex).toBe(laneOf(doc, gid));
    expect(node.children.map((c) => c.clip.id)).toEqual([a!.id, b!.id]);
    // The interior insert points bracket the group's rows.
    expect(node.interiorTop).toBe(laneOf(doc, a!.id));
    expect(node.interiorEnd).toBe(laneOf(doc, b!.id) + 1);
  });

  it("rows scattered through doc.tracks still read in their own order", () => {
    const doc = createEmptyDocument();
    const [a, b, c] = shapes(doc, [{ start: 0, dur: 1000 }, { start: 0, dur: 1000 }, { start: 0, dur: 1000 }]);
    const gid = groupClips(doc, [a!.id, b!.id])!;
    // Shove `b`'s row to the very end of the array — behind c's lane.
    const rowB = trackOf(doc, b!.id);
    doc.tracks.splice(doc.tracks.indexOf(rowB), 1);
    doc.tracks.push(rowB);
    const tree = frameLayerTree(doc, frameIdOf(doc));
    const node = tree.find((n) => n.type === "group")!;
    if (node.type !== "group") throw new Error("expected a group node");
    expect(node.children.map((n) => n.clip.id)).toEqual([a!.id, b!.id]);
    expect(tree.map((n) => n.clip.id)).toEqual([gid, c!.id]);
  });
});

describe("moving between scopes", () => {
  it("pushes a member past the band's edge onto a NEW ROW inside the group", () => {
    const doc = createEmptyDocument();
    const [a, b] = shapes(doc, [{ start: 0, dur: 1000 }, { start: 0, dur: 1000 }]);
    const gid = groupClips(doc, [a!.id, b!.id])!;
    const made = moveClipsToNewLanes(doc, [{ clipId: b!.id, startMs: 0 }], "top", gid);
    expect(made).toHaveLength(1);
    expect(trackOf(doc, b!.id).groupId).toBe(gid);
    expect(groupRows(doc, gid)[0]!.id).toBe(made[0]);
  });

  it("a clip leaves for the parent scope at the group's z, and an emptied group goes", () => {
    const doc = createEmptyDocument();
    const [a, b] = shapes(doc, [{ start: 0, dur: 1000 }, { start: 0, dur: 1000 }]);
    const gid = groupClips(doc, [a!.id, b!.id])!;
    pullClipsOutOneLevel(doc, [a!.id]);
    expect(groupOfClip(doc, a!.id)).toBeNull();
    expect(laneOf(doc, a!.id)).toBeLessThan(laneOf(doc, gid));
    expect(clipsUnderGroup(doc, gid)).toEqual([b!.id]);
    pullClipsOutOneLevel(doc, [b!.id]);
    expect(groupClipById(doc, gid)).toBeNull();
  });

  it("a clip dropped into a group takes one of its rows; a nested group brings its rows", () => {
    const doc = createEmptyDocument();
    const [a, b, c, d] = shapes(doc, [
      { start: 0, dur: 1000 },
      { start: 0, dur: 1000 },
      { start: 0, dur: 1000 },
      { start: 0, dur: 1000 },
    ]);
    const g1 = groupClips(doc, [a!.id, b!.id])!;
    const g2 = groupClips(doc, [c!.id, d!.id])!;
    moveClipsToScope(doc, [g2], g1);
    expect(groupOfClip(doc, g2)).toBe(g1);
    expect(groupOfClip(doc, c!.id)).toBe(g2);
    expect(new Set(clipsUnderGroup(doc, g1))).toEqual(new Set([a!.id, b!.id, g2, c!.id, d!.id]));
    // A group never moves into its own interior.
    moveClipsToScope(doc, [g1], g2);
    expect(groupOfClip(doc, g1)).toBeNull();
  });

  it("the layers list's restack of a whole group is one clip's move", () => {
    const doc = createEmptyDocument();
    const [a, b, c] = shapes(doc, [{ start: 0, dur: 1000 }, { start: 0, dur: 1000 }, { start: 0, dur: 1000 }]);
    const gid = groupClips(doc, [a!.id, b!.id])!;
    const rows = groupRows(doc, gid).map((r) => r.id);
    restackUnits(doc, [{ kind: "group", id: gid }], { trackIndex: doc.tracks.length, groupId: null });
    expect(laneOf(doc, gid)).toBeGreaterThan(laneOf(doc, c!.id));
    expect(groupRows(doc, gid).map((r) => r.id)).toEqual(rows);
  });
});

describe("emptying and healing", () => {
  it("a group with nothing in it is deleted, its rows and its lane with it", () => {
    const doc = createEmptyDocument();
    const [a, b] = shapes(doc, [{ start: 0, dur: 1000 }, { start: 0, dur: 1000 }]);
    const gid = groupClips(doc, [a!.id, b!.id])!;
    const lanes = doc.tracks.length;

    for (const row of groupRows(doc, gid)) row.clips = [];
    pruneGroups(doc);
    expect(groupClipById(doc, gid)).toBeNull();
    // Two empty rows + the group's own (now empty, auto) lane.
    expect(doc.tracks.length).toBe(lanes - 3);
  });

  it("a row pointing at a dead group heals to the top level, keeping what it holds", () => {
    const doc = createEmptyDocument();
    const [a] = shapes(doc, [{ start: 0, dur: 1000 }]);
    trackOf(doc, a!.id).groupId = "nope";
    pruneGroups(doc);
    expect(trackOf(doc, a!.id).groupId).toBeNull();
    expect(find(doc, a!.id)).toBeTruthy();
  });
});

describe("the migrations", () => {
  it("v66 lifts a groups table onto lanes and keeps the composite picture", () => {
    const built = createEmptyDocument();
    const [cutter, base] = shapes(built, [{ start: 0, dur: 2000 }, { start: 500, dur: 3000 }]);
    cutter!.id = "cutter";
    base!.id = "base";
    const raw = JSON.parse(serializeDocument(built)) as Record<string, unknown>;
    raw.version = 65;
    raw.groups = [{ id: "g1", name: "Boolean", mode: "subtract", parentId: null }];
    for (const track of raw.tracks as Array<{ clips: Array<Record<string, unknown>> }>) {
      for (const clip of track.clips) {
        if (clip.id === "cutter" || clip.id === "base") clip.groupId = "g1";
        delete clip.isStencil;
      }
    }

    const doc = parseDocument(JSON.stringify(raw));

    const group = groupClipById(doc, "g1")!;
    expect(group.kind).toBe("group");
    expect(group.mode).toBe("subtract");
    expect(group.startMs).toBe(0);
    expect(group.durationMs).toBe(3500);
    expect(laneOf(doc, "g1")).toBeLessThan(laneOf(doc, "cutter"));
    expect(new Set(clipsUnderGroup(doc, "g1"))).toEqual(new Set(["cutter", "base"]));
    // v71: membership arrived on the rows.
    expect(trackOf(doc, "cutter").groupId).toBe("g1");
    expect(trackOf(doc, "g1").groupId).toBeNull();

    const asStencil = (id: string) => {
      const c = find(doc, id);
      return c.kind !== "audio" && c.isStencil;
    };
    expect(asStencil("cutter")).toBe(true);
    expect(asStencil("base")).toBe(false);
    expect(() => parseDocument(serializeDocument(doc))).not.toThrow();
  });

  it("v71 splits a lane that held two groups' clips, and drops clip.groupId", () => {
    const built = createEmptyDocument();
    const [a, b, c, d] = shapes(built, [
      { start: 0, dur: 1000 },
      { start: 0, dur: 1000 },
      { start: 0, dur: 1000 },
      { start: 0, dur: 1000 },
    ]);
    const g1 = groupClips(built, [a!.id, b!.id])!;
    const g2 = groupClips(built, [c!.id, d!.id])!;
    const raw = JSON.parse(serializeDocument(built)) as { version: number; tracks: Array<{ groupId: string | null; clips: Array<Record<string, unknown>> }> };
    raw.version = 70;
    // Wind back to v70's shape: membership on the clips, and one lane holding
    // a clip of each group (the healing state the old model tolerated).
    const bClip = raw.tracks.flatMap((t) => t.clips).find((x) => x.id === b!.id)!;
    for (const track of raw.tracks) {
      track.clips = track.clips.filter((x) => x.id !== b!.id);
      track.groupId = null;
      for (const clip of track.clips) clip.groupId = clip.id === a!.id ? g1 : clip.id === c!.id || clip.id === d!.id ? g2 : clip.id === g1 || clip.id === g2 ? null : clip.groupId ?? null;
    }
    bClip.groupId = g1;
    raw.tracks.find((t) => t.clips.some((x) => x.id === c!.id))!.clips.push(bClip);

    const doc = parseDocument(JSON.stringify(raw));
    expect(groupOfClip(doc, a!.id)).toBe(g1);
    expect(groupOfClip(doc, b!.id)).toBe(g1);
    expect(groupOfClip(doc, c!.id)).toBe(g2);
    expect(trackOf(doc, b!.id)).not.toBe(trackOf(doc, c!.id));
    expect("groupId" in find(doc, a!.id)).toBe(false);
  });
});

describe("lanes the tree cannot speak for", () => {
  it("an AUDIO lane is still a row — the tree is visual order, not the row list", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    const [shape] = shapes(doc, [{ start: 0, dur: 1000 }]);
    const audio = createAudioClip({ frameId: fid, startMs: 0, durationMs: 1000 });
    const lane = createTrack("Sound");
    lane.clips.push(audio);
    doc.tracks.push(lane);
    const rows = frameLanes(doc, fid);
    expect(rows.some((l) => l.track.id === lane.id)).toBe(true);
    expect(rows.some((l) => l.track.clips.some((c) => c.id === shape!.id))).toBe(true);
  });

  it("an audio lane survives a collapse that has nothing to do with it", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    const [a, b] = shapes(doc, [{ start: 0, dur: 1000 }, { start: 0, dur: 1000 }]);
    const gid = groupClips(doc, [a!.id, b!.id])!;
    const lane = createTrack("Sound");
    lane.clips.push(createAudioClip({ frameId: fid, startMs: 0, durationMs: 1000 }));
    doc.tracks.push(lane);
    const rows = frameLanes(doc, fid, new Set([gid]));
    expect(rows.some((l) => l.track.id === lane.id)).toBe(true);
    expect(rows.some((l) => l.track.clips.some((c) => c.id === a!.id))).toBe(false);
  });

  it("an empty row added inside a group is a row of that group", () => {
    const doc = createEmptyDocument();
    const fid = frameIdOf(doc);
    const [a, b] = shapes(doc, [{ start: 0, dur: 1000 }, { start: 0, dur: 1000 }]);
    const gid = groupClips(doc, [a!.id, b!.id])!;
    const memberLane = trackOf(doc, a!.id);

    const newId = insertTrackNear(doc, { frameId: fid, nearTrackId: memberLane.id, where: "below" });
    const made = doc.tracks.find((t) => t.id === newId)!;
    expect(made.groupId).toBe(gid);
    expect(groupRows(doc, gid).map((r) => r.id)[1]).toBe(newId);

    const rows = frameLanes(doc, fid);
    const row = rows.find((l) => l.track.id === newId)!;
    expect(row.depth).toBe(1);
    expect(row.scope?.id).toBe(gid);
    expect(frameLanes(doc, fid, new Set([gid])).some((l) => l.track.id === newId)).toBe(false);
  });
});

describe("duplicating", () => {
  it("keeps a copy of a MEMBER in the group, on a fresh row above the source", () => {
    const doc = createEmptyDocument();
    const [a, b] = shapes(doc, [{ start: 0, dur: 1000 }, { start: 0, dur: 1000 }]);
    const gid = groupClips(doc, [a!.id, b!.id])!;
    const sourceLane = laneOf(doc, a!.id);

    const { tops } = duplicateClips(doc, [a!.id]);
    expect(groupOfClip(doc, tops[0]!)).toBe(gid);
    expect(laneOf(doc, tops[0]!)).toBe(sourceLane);
  });

  it("duplicating a GROUP brings its contents, as a second independent group", () => {
    const doc = createEmptyDocument();
    const [a, b] = shapes(doc, [{ start: 0, dur: 1000 }, { start: 500, dur: 1500 }]);
    const gid = groupClips(doc, [a!.id, b!.id])!;

    const { created, tops } = duplicateClips(doc, [gid]);
    expect(tops).toHaveLength(1);
    const copyId = tops[0]!;
    expect(copyId).not.toBe(gid);

    const members = clipsUnderGroup(doc, copyId);
    expect(members).toHaveLength(2);
    for (const id of members) {
      expect(groupOfClip(doc, id)).toBe(copyId);
      expect(created).toContain(id);
    }
    expect(new Set(clipsUnderGroup(doc, gid))).toEqual(new Set([a!.id, b!.id]));
    const copy = find(doc, copyId);
    expect(copy.startMs).toBe(find(doc, gid).startMs);
    expect(copy.durationMs).toBe(find(doc, gid).durationMs);
  });

  it("a NESTED group duplicates whole, at every depth", () => {
    const doc = createEmptyDocument();
    const [a, b, c] = shapes(doc, [
      { start: 0, dur: 1000 },
      { start: 0, dur: 1000 },
      { start: 0, dur: 1000 },
    ]);
    const inner = groupClips(doc, [a!.id, b!.id])!;
    const outer = groupClips(doc, [inner, c!.id])!;

    const { tops } = duplicateClips(doc, [outer]);
    const copyId = tops[0]!;
    const under = clipsUnderGroup(doc, copyId);
    expect(under).toHaveLength(4);
    const innerCopy = under.find((id) => find(doc, id).kind === "group")!;
    expect(innerCopy).not.toBe(inner);
    expect(clipsUnderGroup(doc, innerCopy)).toHaveLength(2);
    expect(under).not.toContain(inner);
    expect(under).not.toContain(a!.id);
  });
});

describe("getting back out of a composite", () => {
  const maskedPair = (): { doc: MotionDocument; gid: string; a: ShapeClip; b: ShapeClip } => {
    const doc = createEmptyDocument();
    const [a, b] = shapes(doc, [{ start: 0, dur: 1000 }, { start: 0, dur: 1000 }]);
    const gid = applyCompositeMode(doc, [a!.id, b!.id], "mask")!;
    return { doc, gid, a: a!, b: b! };
  };

  it("a selected GROUP can be ungrouped", () => {
    const { doc, gid } = maskedPair();
    expect(groupOfClip(doc, gid)).toBeNull();
    expect(canUngroup(doc, [gid])).toBe(true);
    ungroupClips(doc, [gid]);
    expect(groupClipById(doc, gid)).toBeNull();
  });

  it("ungrouping leaves its members as plain layers at the group's z", () => {
    const { doc, gid, a, b } = maskedPair();
    const [below] = shapes(doc, [{ start: 0, dur: 1000 }]);
    const groupLane = laneOf(doc, gid);
    ungroupClips(doc, [gid]);
    expect(groupOfClip(doc, a.id)).toBeNull();
    expect(groupOfClip(doc, b.id)).toBeNull();
    expect(laneOf(doc, a.id)).toBe(groupLane);
    expect(laneOf(doc, a.id)).toBeLessThan(laneOf(doc, below!.id));
  });

  it("a composite of a group and a layer nests the group — relations of relations", () => {
    const doc = createEmptyDocument();
    const [a, b, c] = shapes(doc, [{ start: 0, dur: 1000 }, { start: 0, dur: 1000 }, { start: 0, dur: 1000 }]);
    const union = applyCompositeMode(doc, [a!.id, b!.id], "union")!;
    const sub = applyCompositeMode(doc, [union, c!.id], "subtract")!;
    expect(sub).not.toBe(union);
    expect(groupOfClip(doc, union)).toBe(sub);
    expect(groupOfClip(doc, c!.id)).toBe(sub);
    expect(groupClipById(doc, union)!.mode).toBe("union");
    expect(groupClipById(doc, sub)!.mode).toBe("subtract");
  });

  it("a selection with nothing grouped cannot ungroup", () => {
    const doc = createEmptyDocument();
    const [a] = shapes(doc, [{ start: 0, dur: 1000 }]);
    expect(canUngroup(doc, [a!.id])).toBe(false);
  });

  it("swapping roles inverts every member at once", () => {
    const { doc, gid, a, b } = maskedPair();
    const stencilFirst = (find(doc, a.id) as ShapeClip).isStencil;
    expect(swapGroupRoles(doc, gid)).toBe(true);
    expect((find(doc, a.id) as ShapeClip).isStencil).toBe(!stencilFirst);
    expect((find(doc, b.id) as ShapeClip).isStencil).toBe(stencilFirst);
  });

  it("never swaps a group into having no stencil at all", () => {
    const { doc, gid, a, b } = maskedPair();
    for (const id of [a.id, b.id]) (find(doc, id) as ShapeClip).isStencil = true;
    swapGroupRoles(doc, gid);
    const stencils = [a, b].filter((c) => (find(doc, c.id) as ShapeClip).isStencil);
    expect(stencils).toHaveLength(1);
  });

  it("a plain or union group has no sides to swap", () => {
    const doc = createEmptyDocument();
    const [a, b] = shapes(doc, [{ start: 0, dur: 1000 }, { start: 0, dur: 1000 }]);
    const gid = applyCompositeMode(doc, [a!.id, b!.id], "union")!;
    expect(swapGroupRoles(doc, gid)).toBe(false);
  });

  it("a nested composite keeps its own roles when the parent swaps", () => {
    const { doc, gid, a, b } = maskedPair();
    const [c, d] = shapes(doc, [{ start: 0, dur: 1000 }, { start: 0, dur: 1000 }]);
    const inner = applyCompositeMode(doc, [c!.id, d!.id], "subtract")!;
    moveClipsToScope(doc, [inner], gid);
    const roles = (ids: string[]) => ids.map((id) => (find(doc, id) as ShapeClip).isStencil);
    const innerBefore = roles([c!.id, d!.id]);
    const outerBefore = roles([a.id, b.id]);
    swapGroupRoles(doc, gid);
    expect(roles([c!.id, d!.id])).toEqual(innerBefore);
    expect(roles([a.id, b.id])).toEqual(outerBefore.map((v) => !v));
  });
});
