import { describe, expect, it } from "vitest";
import { createEmptyDocument, createFrame, createNestedClip, createTextClip, createTrack } from "../factories";
import type { MotionDocument } from "../schema";
import {
  editPath,
  isClipInScope,
  playheadBetweenPaths,
  resolveClipContext,
  selectableFrameIds,
  selectionPath,
} from ".";

/**
 * root ─ hop1 ▸ child ─ hop2 ▸ grand
 *  │                │             └ deep   (a text clip)
 *  └ top            └ mid
 * plus `other`, a frame on its own page with `stray` on it.
 */
function scene() {
  const doc: MotionDocument = createEmptyDocument();
  const rootId = doc.frames[0]!.id;
  const child = createFrame({ name: "Child", width: 400, height: 400, pageId: "__internal__" });
  const grand = createFrame({ name: "Grand", width: 200, height: 200, pageId: "__internal__" });
  const other = createFrame({ name: "Other", width: 300, height: 300, pageId: doc.frames[0]!.pageId });
  doc.frames.push(child, grand, other);

  const hop1 = createNestedClip({ frameId: rootId, sourceFrameId: child.id, startMs: 1000, durationMs: 4000 });
  const hop2 = createNestedClip({ frameId: child.id, sourceFrameId: grand.id, startMs: 500, durationMs: 3000 });
  const top = createTextClip({ frameId: rootId, text: "x", startMs: 0, durationMs: 5000 });
  const mid = createTextClip({ frameId: child.id, text: "x", startMs: 0, durationMs: 5000 });
  const deep = createTextClip({ frameId: grand.id, text: "x", startMs: 0, durationMs: 5000 });
  const stray = createTextClip({ frameId: other.id, text: "x", startMs: 0, durationMs: 5000 });

  const track = createTrack("t");
  track.clips.push(hop1, hop2, top, mid, deep, stray);
  doc.tracks.push(track);
  return { doc, rootId, childId: child.id, grandId: grand.id, otherId: other.id, hop1, hop2, top, mid, deep, stray };
}

describe("selectionPath", () => {
  it("a clip in the open timeline resolves to the path you are already on", () => {
    const { doc, rootId, top } = scene();
    const at = selectionPath(doc, editPath(rootId), top.id)!;
    expect(at.reach).toBe("target");
    expect(at.path.hops).toEqual([]);
  });

  it("reaches a clip INSIDE a nested comp without you having drilled in", () => {
    // The whole feature: inspecting a piece must not cost you your timeline.
    const { doc, rootId, hop1, mid } = scene();
    const at = selectionPath(doc, editPath(rootId), mid.id)!;
    expect(at.reach).toBe("inside");
    expect(at.path.hops).toEqual([hop1.id]);
    expect(at.descent).toBe(1);
  });

  it("reaches through two levels of nesting, shallowest route first", () => {
    const { doc, rootId, hop1, hop2, deep } = scene();
    const at = selectionPath(doc, editPath(rootId), deep.id)!;
    expect(at.path.hops).toEqual([hop1.id, hop2.id]);
    expect(at.descent).toBe(2);
  });

  it("a clip in a comp you drilled THROUGH truncates the path instead of navigating", () => {
    const { doc, rootId, hop1, hop2, top } = scene();
    const at = selectionPath(doc, editPath(rootId, [hop1.id, hop2.id]), top.id)!;
    expect(at.reach).toBe("ancestor");
    expect(at.path.hops).toEqual([]);
  });

  it("a clip nowhere near here answers with the document's own ancestry", () => {
    const { doc, rootId, otherId, stray } = scene();
    const at = selectionPath(doc, editPath(rootId), stray.id)!;
    expect(at.reach).toBe("elsewhere");
    expect(at.path.rootFrameId).toBe(otherId);
  });

  it("returns null for an id that is not a clip", () => {
    const { doc, rootId } = scene();
    expect(selectionPath(doc, editPath(rootId), "ghost")).toBeNull();
  });

  it("refuses to walk into a comp that instances itself", () => {
    // The cycle guard: without it a self-referential comp searches forever.
    const { doc, rootId, childId, stray } = scene();
    doc.tracks[0]!.clips.push(createNestedClip({ frameId: childId, sourceFrameId: childId, startMs: 0, durationMs: 1000 }));
    expect(selectionPath(doc, editPath(rootId), stray.id)!.reach).toBe("elsewhere");
  });

  it("does not see inside a FLAT nested clip — one seam gates every caller", () => {
    // `flat` means "presented as one opaque layer". The scope registry is where
    // that is decided, so selection inherits it without knowing the flag exists.
    const { doc, rootId, hop1, mid } = scene();
    hop1.flat = true;
    expect(selectionPath(doc, editPath(rootId), mid.id)!.reach).toBe("elsewhere");
  });
});

describe("isClipInScope", () => {
  it("is true for everything visible from here and false for another tab's layers", () => {
    const { doc, rootId, top, mid, deep, stray } = scene();
    const from = editPath(rootId);
    expect(isClipInScope(doc, from, top.id)).toBe(true);
    expect(isClipInScope(doc, from, mid.id)).toBe(true);
    expect(isClipInScope(doc, from, deep.id)).toBe(true);
    expect(isClipInScope(doc, from, stray.id)).toBe(false);
  });
});

describe("selectableFrameIds", () => {
  it("is the open timeline, its ancestors, and everything nested underneath", () => {
    const { doc, rootId, childId, grandId, otherId, hop1 } = scene();
    const ids = selectableFrameIds(doc, editPath(rootId, [hop1.id]));
    expect([...ids].sort()).toEqual([rootId, childId, grandId].sort());
    expect(ids.has(otherId)).toBe(false);
  });
});

describe("playheadBetweenPaths", () => {
  it("descending maps the instant DOWN through each hop's offset", () => {
    // hop1 starts at 1000, hop2 at 500 — so 2000 in root time is 1000 in the
    // child and 500 in the grandchild. Entering must never jump the picture.
    const { doc, rootId, hop1, hop2 } = scene();
    const root = editPath(rootId);
    expect(playheadBetweenPaths(doc, root, editPath(rootId, [hop1.id]), 2000)).toBe(1000);
    expect(playheadBetweenPaths(doc, root, editPath(rootId, [hop1.id, hop2.id]), 2000)).toBe(500);
  });

  it("ascending is the exact inverse", () => {
    const { doc, rootId, hop1, hop2 } = scene();
    const deep = editPath(rootId, [hop1.id, hop2.id]);
    expect(playheadBetweenPaths(doc, deep, editPath(rootId), 500)).toBe(2000);
  });

  it("an unrelated root answers with its OWN time — scrubbing one scene never moves another", () => {
    const { doc, rootId, otherId } = scene();
    expect(playheadBetweenPaths(doc, editPath(rootId), editPath(otherId), 1234)).toBe(0);
    doc.frames.find((f) => f.id === otherId)!.playheadMs = 800;
    expect(playheadBetweenPaths(doc, editPath(rootId), editPath(otherId), 1234)).toBe(800);
  });
});

describe("resolveClipContext", () => {
  it("gives a nested clip its OWN frame and its OWN local time, timeline unmoved", () => {
    const { doc, rootId, childId, mid } = scene();
    const from = editPath(rootId);
    const res = resolveClipContext(doc, from, 2000, mid.id)!;
    expect(res.ctx.target.id).toBe(childId);
    expect(res.ctx.targetTimeMs).toBe(1000);
    expect(res.reach).toBe("inside");
    // The caller's own path is untouched — that is the promise.
    expect(from.hops).toEqual([]);
  });

  it("maps the nested comp's world matrix, so a gizmo can be drawn on it", () => {
    const { doc, rootId, deep } = scene();
    const res = resolveClipContext(doc, editPath(rootId), 2000, deep.id)!;
    // Root frame sits at the origin by default and the hops are centred, so the
    // grandchild's top-left is inset by the centring of both hops.
    expect(res.ctx.depth).toBe(2);
    expect(Number.isFinite(res.ctx.matrix.e)).toBe(true);
  });

  it("a top-level clip resolves at depth 0 with the playhead untouched", () => {
    const { doc, rootId, top } = scene();
    const res = resolveClipContext(doc, editPath(rootId), 2000, top.id)!;
    expect(res.ctx.depth).toBe(0);
    expect(res.ctx.targetTimeMs).toBe(2000);
  });
});
