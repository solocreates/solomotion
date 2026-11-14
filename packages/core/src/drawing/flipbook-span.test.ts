import { describe, expect, it } from "vitest";
import { createEmptyDocument } from "../factories";
import {
  addFlipbookCellAt,
  createFlipbook,
  duplicateFlipbookCell,
  flipbookRows,
  healFlipbookSpan,
  syncFlipbookLoopSpan,
} from "./flipbook";
import { clipEnd } from "../timeline/ops";
import { createTrack } from "../factories";

function sheet() {
  const doc = createEmptyDocument();
  const made = createFlipbook(doc, { parentFrameId: doc.frames[0]!.id, startMs: 0, width: 1080, height: 1920 });
  // `createFlipbook` builds the owner clip; placing it is the caller's job, and
  // `ownerNestedOf` finds it by walking the tracks.
  const host = createTrack("host");
  host.clips.push(made.clip);
  doc.tracks.unshift(host);
  return { doc, flipbookId: made.flipbook.id, owner: made.clip };
}

/** The end of the last cell in the sheet, in sheet time. */
function sheetEnd(doc: ReturnType<typeof sheet>["doc"], flipbookId: string): number {
  let end = 0;
  for (const row of flipbookRows(doc, flipbookId)) {
    for (const c of row.cells) end = Math.max(end, clipEnd(c));
  }
  return end;
}

describe("a flipbook's owner clip covers the sheet it holds", () => {
  it("grows as cells are added past its end", () => {
    const { doc, flipbookId, owner } = sheet();
    const row = flipbookRows(doc, flipbookId)[0]!;
    for (let i = 0; i < 30; i++) {
      addFlipbookCellAt(doc, flipbookId, row.track.id, sheetEnd(doc, flipbookId));
    }
    // Every cell is inside the clip's span, so every one of them can render.
    expect(owner.durationMs).toBeGreaterThanOrEqual(sheetEnd(doc, flipbookId));
  });

  it("grows even when a loop CYCLE has been chosen", () => {
    // The cycle is how long one repeat lasts; the box is how long the clip
    // exists. Conflating them made half a drawing stop rendering.
    const { doc, flipbookId, owner } = sheet();
    owner.playback = { ...owner.playback, loopLengthMs: 500 };
    const row = flipbookRows(doc, flipbookId)[0]!;
    for (let i = 0; i < 20; i++) {
      addFlipbookCellAt(doc, flipbookId, row.track.id, sheetEnd(doc, flipbookId));
    }
    expect(owner.durationMs).toBeGreaterThanOrEqual(sheetEnd(doc, flipbookId));
  });

  it("heals a document whose sheet already outgrew its clip", () => {
    const { doc, flipbookId, owner } = sheet();
    const row = flipbookRows(doc, flipbookId)[0]!;
    for (let i = 0; i < 12; i++) {
      addFlipbookCellAt(doc, flipbookId, row.track.id, sheetEnd(doc, flipbookId));
    }
    // Break it the way the old guard did.
    owner.durationMs = 1000;
    expect(healFlipbookSpan(doc, flipbookId)).toBe(true);
    expect(owner.durationMs).toBeGreaterThanOrEqual(sheetEnd(doc, flipbookId));
    // Idempotent: nothing left to do on a healthy sheet.
    expect(healFlipbookSpan(doc, flipbookId)).toBe(false);
  });

  it("never SHRINKS a clip somebody deliberately made longer", () => {
    const { doc, flipbookId, owner } = sheet();
    owner.durationMs = 60_000;
    syncFlipbookLoopSpan(doc, flipbookId);
    expect(owner.durationMs).toBe(60_000);
  });

  it("a duplicated cell still lands inside the clip", () => {
    const { doc, flipbookId, owner } = sheet();
    const first = flipbookRows(doc, flipbookId)[0]!.cells[0]!;
    for (let i = 0; i < 10; i++) duplicateFlipbookCell(doc, first.id);
    expect(owner.durationMs).toBeGreaterThanOrEqual(sheetEnd(doc, flipbookId));
  });
});
