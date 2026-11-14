import { describe, expect, it } from "vitest";
import { createEmptyDocument, createFrame, createNestedClip, createTextClip, createTrack } from "../factories";
import type { MotionDocument } from "../schema";
import { editPath, playheadInFrame, seekInFrame } from ".";

/**
 * root ─ sheet ▸ flipbook ─ cellA ▸ drawA
 *                        └ cellB ▸ drawB
 *
 * The shape the sheet actually has: a flipbook nested in a comp, two cells side
 * by side inside it, each opening into its own drawing.
 */
function sheetScene() {
  const doc: MotionDocument = createEmptyDocument();
  const rootId = doc.frames[0]!.id;
  const flipbook = createFrame({ name: "Flipbook", width: 400, height: 400, pageId: "__internal__" });
  const drawA = createFrame({ name: "A", width: 400, height: 400, pageId: "__internal__" });
  const drawB = createFrame({ name: "B", width: 400, height: 400, pageId: "__internal__" });
  doc.frames.push(flipbook, drawA, drawB);

  const sheet = createNestedClip({ frameId: rootId, sourceFrameId: flipbook.id, startMs: 1000, durationMs: 4000 });
  const cellA = createNestedClip({ frameId: flipbook.id, sourceFrameId: drawA.id, startMs: 0, durationMs: 500 });
  const cellB = createNestedClip({ frameId: flipbook.id, sourceFrameId: drawB.id, startMs: 500, durationMs: 500 });
  // Something in each drawing, so the frames have content spans.
  const inA = createTextClip({ frameId: drawA.id, text: "a", startMs: 0, durationMs: 500 });
  const inB = createTextClip({ frameId: drawB.id, text: "b", startMs: 0, durationMs: 500 });

  const track = createTrack("t");
  track.clips.push(sheet, cellA, cellB, inA, inB);
  doc.tracks.push(track);
  return { doc, rootId, flipbookId: flipbook.id, drawAId: drawA.id, sheet, cellA, cellB };
}

describe("playheadInFrame", () => {
  it("reads an ancestor's clock from where you stand", () => {
    const { doc, rootId, flipbookId, sheet, cellA } = sheetScene();
    // Standing inside cell A's drawing, 200ms in.
    const standing = editPath(rootId, [sheet.id, cellA.id]);
    // Sheet time is the cell's start plus the local offset...
    expect(playheadInFrame(doc, standing, 200, flipbookId)).toBe(200);
    // ...and root time adds the flipbook clip's own start.
    expect(playheadInFrame(doc, standing, 200, rootId)).toBe(1200);
  });

  it("reads a descendant's clock", () => {
    const { doc, rootId, flipbookId, drawAId, sheet } = sheetScene();
    const standing = editPath(rootId, [sheet.id]); // in the flipbook
    expect(playheadInFrame(doc, standing, 300, drawAId)).toBe(300);
    expect(playheadInFrame(doc, standing, 300, flipbookId)).toBe(300);
  });
});

describe("seekInFrame", () => {
  it("stays put when the instant is expressible where you stand", () => {
    const { doc, rootId, flipbookId, sheet, cellA } = sheetScene();
    const standing = editPath(rootId, [sheet.id, cellA.id]);
    const plan = seekInFrame(doc, standing, flipbookId, 300); // still inside cell A
    expect(plan.moved).toBe(false);
    expect(plan.path).toEqual(standing);
    expect(plan.playheadMs).toBe(300);
  });

  it("STEPS OUT rather than clamping when it is not", () => {
    const { doc, rootId, flipbookId, sheet, cellA } = sheetScene();
    const standing = editPath(rootId, [sheet.id, cellA.id]);
    // 700ms is inside cell B — cell A's local clock cannot express it, and the
    // old code's `childTimeOf` would have silently pinned it at A's edge.
    const plan = seekInFrame(doc, standing, flipbookId, 700);
    expect(plan.moved).toBe(true);
    expect(plan.path).toEqual(editPath(rootId, [sheet.id]));
    expect(plan.playheadMs).toBe(700);
  });

  it("maps DOWN without moving when addressing an ancestor from inside", () => {
    const { doc, rootId, sheet, cellA } = sheetScene();
    const standing = editPath(rootId, [sheet.id, cellA.id]);
    // Root time 1300 → flipbook 300 → cell A local 300.
    const plan = seekInFrame(doc, standing, rootId, 1300);
    expect(plan.moved).toBe(false);
    expect(plan.playheadMs).toBe(300);
  });

  it("prefers a prefix of where you stand over the document's ownership chain", () => {
    const { doc, flipbookId, cellA } = sheetScene();
    // The flipbook opened as its OWN root tab: its canonical `pathToFrame`
    // roots at the owner comp, and mapping against that would navigate the
    // user out of the tab they are looking at.
    const standing = editPath(flipbookId, [cellA.id]);
    const plan = seekInFrame(doc, standing, flipbookId, 200);
    expect(plan.moved).toBe(false);
    expect(plan.playheadMs).toBe(200);
    expect(playheadInFrame(doc, standing, 200, flipbookId)).toBe(200);
  });

  it("never returns a negative instant", () => {
    const { doc, rootId, flipbookId, sheet } = sheetScene();
    const plan = seekInFrame(doc, editPath(rootId, [sheet.id]), flipbookId, -50);
    expect(plan.playheadMs).toBe(0);
  });
});
