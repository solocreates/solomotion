import { describe, expect, it } from "vitest";
import { createAudioClip, createEmptyDocument, createFrame, createNestedClip, createTextClip, createTrack } from "../factories";
import { groupClips } from "../timeline/groups";
import type { MotionDocument } from "../schema";
import { editPath, treeRevealForClip, treeRevealForFrame } from ".";

/**
 * root ─ inst ▸ child ─ [outer ▸ [inner ▸ deep]]
 *  └ top            plus `other`, a second page, holding `stray`.
 */
function scene() {
  const doc: MotionDocument = createEmptyDocument();
  const rootId = doc.frames[0]!.id;
  const child = createFrame({ name: "Child", width: 400, height: 400, pageId: "__internal__" });
  doc.pages.push({ ...doc.pages[0]!, id: "page-2", name: "Two" });
  const other = createFrame({ name: "Other", width: 300, height: 300, pageId: "page-2" });
  doc.frames.push(child, other);

  const inst = createNestedClip({ frameId: rootId, sourceFrameId: child.id, startMs: 0, durationMs: 4000 });
  const top = createTextClip({ frameId: rootId, text: "x", startMs: 0, durationMs: 4000 });
  const deep = createTextClip({ frameId: child.id, text: "x", startMs: 0, durationMs: 4000 });
  const sib = createTextClip({ frameId: child.id, text: "x", startMs: 0, durationMs: 4000 });
  const stray = createTextClip({ frameId: other.id, text: "x", startMs: 0, durationMs: 4000 });
  const voice = createAudioClip({ frameId: rootId, startMs: 0, durationMs: 4000 });
  const tracks = [inst, top, deep, sib, stray, voice].map((c) => {
    const t = createTrack("t");
    t.clips.push(c);
    return t;
  });
  doc.tracks.push(...tracks);
  const inner = groupClips(doc, [deep.id], "Inner")!;
  const outer = groupClips(doc, [inner, sib.id], "Outer")!;
  return { doc, rootId, otherId: other.id, inst, top, deep, stray, voice, inner, outer };
}

describe("treeRevealForClip", () => {
  it("a top-level layer needs only its comp open", () => {
    const { doc, rootId, top } = scene();
    expect(treeRevealForClip(doc, editPath(rootId), top.id)).toEqual({
      pageId: doc.pages[0]!.id,
      rootFrameId: rootId,
      instances: [],
      groups: [],
      audioFrameId: null,
    });
  });

  it("opens the nested instance, then every enclosing group outermost first", () => {
    const { doc, rootId, inst, deep, inner, outer } = scene();
    const r = treeRevealForClip(doc, editPath(rootId), deep.id)!;
    expect(r.rootFrameId).toBe(rootId);
    expect(r.instances).toEqual([inst.id]);
    expect(r.groups).toEqual([outer, inner]);
  });

  it("names the page of a layer that lives elsewhere — the list has to go there", () => {
    const { doc, rootId, otherId, stray } = scene();
    const r = treeRevealForClip(doc, editPath(rootId), stray.id)!;
    expect(r.pageId).toBe("page-2");
    expect(r.rootFrameId).toBe(otherId);
  });

  it("sound is listed in its comp's audio section", () => {
    const { doc, rootId, voice } = scene();
    expect(treeRevealForClip(doc, editPath(rootId), voice.id)!.audioFrameId).toBe(rootId);
  });

  it("null for an id that is not a clip", () => {
    const { doc, rootId } = scene();
    expect(treeRevealForClip(doc, editPath(rootId), "ghost")).toBeNull();
  });
});

describe("treeRevealForFrame", () => {
  it("a comp on a page shows on that page; one on the internal shelf has none", () => {
    const { doc, otherId, inst } = scene();
    expect(treeRevealForFrame(doc, otherId)!.pageId).toBe("page-2");
    expect(treeRevealForFrame(doc, (inst as { sourceFrameId: string }).sourceFrameId)!.pageId).toBeNull();
  });
});
