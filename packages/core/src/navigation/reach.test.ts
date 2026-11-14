import { describe, expect, it } from "vitest";
import { createEmptyDocument, createFrame, createNestedClip, createTrack } from "../factories";
import { editPath, HERE, reachableFrameIds } from ".";

/** root ▸ a ▸ a1, with `b` a second comp nested beside `a1` inside `a`. */
function scene() {
  const doc = createEmptyDocument();
  const rootId = doc.frames[0]!.id;
  const a = createFrame({ name: "A", pageId: "__internal__" });
  const a1 = createFrame({ name: "A1", pageId: "__internal__" });
  const b = createFrame({ name: "B", pageId: "__internal__" });
  doc.frames.push(a, a1, b);
  const hopA = createNestedClip({ frameId: rootId, sourceFrameId: a.id, startMs: 0, durationMs: 1000 });
  const hopA1 = createNestedClip({ frameId: a.id, sourceFrameId: a1.id, startMs: 0, durationMs: 1000 });
  const hopB = createNestedClip({ frameId: a.id, sourceFrameId: b.id, startMs: 0, durationMs: 1000 });
  const track = createTrack("t");
  track.clips.push(hopA, hopA1, hopB);
  doc.tracks.push(track);
  return { doc, rootId, a, a1, b, hopA };
}

describe("depth reach", () => {
  it("defaults to this comp and nothing else", () => {
    const { doc, rootId, hopA, a } = scene();
    expect(reachableFrameIds(doc, editPath(rootId, [hopA.id]), HERE)).toEqual([a.id]);
  });

  it("reaches OUT toward the root, nearest first", () => {
    const { doc, rootId, hopA, a } = scene();
    const path = editPath(rootId, [hopA.id]);
    expect(reachableFrameIds(doc, path, { up: 1, down: 0 })).toEqual([a.id, rootId]);
    // Asking for more than there is stops at the root rather than repeating it.
    expect(reachableFrameIds(doc, path, { up: 9, down: 0 })).toEqual([a.id, rootId]);
  });

  it("reaches IN a whole level at a time, not depth-first down one branch", () => {
    const { doc, rootId, hopA, a, a1, b } = scene();
    const path = editPath(rootId, [hopA.id]);
    const one = reachableFrameIds(doc, path, { up: 0, down: 1 });
    expect(one[0]).toBe(a.id);
    expect(new Set(one.slice(1))).toEqual(new Set([a1.id, b.id]));
  });

  it("never lists a comp twice, however it is reached", () => {
    const { doc, rootId, hopA } = scene();
    const ids = reachableFrameIds(doc, editPath(rootId, [hopA.id]), { up: 4, down: 4 });
    expect(new Set(ids).size).toBe(ids.length);
  });
});
