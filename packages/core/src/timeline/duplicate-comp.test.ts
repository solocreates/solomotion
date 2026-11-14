import { describe, expect, it } from "vitest";
import { createEmptyDocument, createShapeClip } from "../factories";
import { duplicateFrame } from "../components";
import { setKeyframe } from "../animation/keyframes";
import type { MotionDocument, Clip } from "../schema";
import { groupClips } from "./groups";
import { frameLayerTree, type LayerTreeNode } from "./layer-tree";
import { duplicateClips, locateClip } from "./ops";

/** A comp's layer tree as a shape: kinds, names and nesting — never ids. */
function shape(nodes: readonly LayerTreeNode[]): unknown[] {
  return nodes.map((n) => (n.type === "group" ? { group: n.clip.name, children: shape(n.children) } : n.clip.name));
}

function groupedComp(): { doc: MotionDocument; frameId: string; groupId: string } {
  const doc = createEmptyDocument("T");
  const frameId = doc.frames[0]!.id;
  const wing = createShapeClip({ frameId, shape: "rect", startMs: 0 });
  wing.name = "Wing";
  const body = createShapeClip({ frameId, shape: "ellipse", startMs: 0 });
  body.name = "Body";
  const sky = createShapeClip({ frameId, shape: "rect", startMs: 0 });
  sky.name = "Sky";
  // One clip per row, as a comp built by hand has them.
  doc.tracks[0]!.clips.push(wing);
  doc.tracks.push({ ...doc.tracks[0]!, id: "t2", clips: [body], transitions: [] });
  doc.tracks.push({ ...doc.tracks[0]!, id: "t3", clips: [sky], transitions: [] });
  const groupId = groupClips(doc, [wing.id, body.id], "Plane")!;
  const group = locateClip(doc, groupId)!.clip;
  setKeyframe(group.keyframes, "transform.x", 0, 0);
  setKeyframe(group.keyframes, "transform.x", 1000, 300);
  setKeyframe(group.keyframes, "transform.rotation", 1000, 20);
  return { doc, frameId, groupId };
}

const clipsOf = (doc: MotionDocument, frameId: string): Clip[] => doc.tracks.flatMap((t) => t.clips).filter((c) => c.frameId === frameId);

describe("duplicating a comp", () => {
  it("copies the layer tree whole: groups keep their members, their prefix and their keys", () => {
    const { doc, frameId, groupId } = groupedComp();
    const copyId = duplicateFrame(doc, frameId)!;
    expect(shape(frameLayerTree(doc, copyId))).toEqual(shape(frameLayerTree(doc, frameId)));

    const copies = clipsOf(doc, copyId);
    const ids = new Set(copies.map((c) => c.id));
    const group = copies.find((c) => c.kind === "group")!;
    expect(group.id.startsWith("group_")).toBe(true);
    expect(group.id).not.toBe(groupId);
    // Every row holding a copy names a group INSIDE the copy, or none.
    for (const t of doc.tracks) {
      if (!t.clips.some((c) => ids.has(c.id)) || !t.groupId) continue;
      expect(ids.has(t.groupId), `row ${t.id} names ${t.groupId}`).toBe(true);
    }
    // The motion is on the copied group, as on the original.
    expect(group.keyframes.map((k) => k.property).sort()).toEqual(["transform.rotation", "transform.x"]);
    // The original is untouched.
    const tree = frameLayerTree(doc, frameId);
    const original = tree.find((n) => n.type === "group");
    expect(original?.type === "group" && original.clip.id).toBe(groupId);
  });

  it("is repeatable — a copy of a copy is still whole", () => {
    const { doc, frameId } = groupedComp();
    const a = duplicateFrame(doc, frameId)!;
    const b = duplicateFrame(doc, a)!;
    expect(shape(frameLayerTree(doc, b))).toEqual(shape(frameLayerTree(doc, frameId)));
  });

  it("duplicating a group in place keeps the group's prefix too", () => {
    const { doc, groupId } = groupedComp();
    const { tops } = duplicateClips(doc, [groupId]);
    expect(tops[0]!.startsWith("group_")).toBe(true);
  });
});
