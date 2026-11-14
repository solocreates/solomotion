import { describe, expect, it } from "vitest";
import { createEmptyDocument, createTrack } from "../factories";
import { addFlipbookCell, createFlipbook, flipbookRows } from "../drawing/flipbook";
import { frameFps, msToFrameIndex, quantizeMsToFrame } from "../timeline/fps";
import { childTimeOf, editPath, resolveEditContext } from ".";

/**
 * A 12fps flipbook inside a 30fps page — the rate pairing that broke, because
 * every other one of the sheet's frames begins between two of the page's.
 */
function scene(sheetFps: number, pageFps: number, cells: number) {
  const doc = createEmptyDocument();
  const page = doc.frames[0]!;
  page.fps = pageFps;
  const made = createFlipbook(doc, {
    parentFrameId: page.id,
    startMs: 0,
    width: page.width,
    height: page.height,
    fps: sheetFps,
  });
  // `createFlipbook` builds the owner clip; placing it is the caller's job.
  const host = createTrack("host");
  host.clips.push(made.clip);
  doc.tracks.unshift(host);
  // Real cells, through the real API: each gets its OWN drawing comp, which is
  // what makes standing inside one a two-hop path.
  for (let i = 1; i < cells; i++) addFlipbookCell(doc, made.flipbook.id, made.rowTrack.id);
  return { doc, page, sheetClip: made.clip, flipbookId: made.flipbook.id };
}

describe("an ancestor's instant is one its own clock can show you from", () => {
  for (const [sheetFps, pageFps] of [
    [12, 30],
    [12, 24],
    [8, 30],
    [24, 30],
    [12, 60],
  ] as const) {
    it(`reaches every frame of a ${sheetFps}fps sheet from a ${pageFps}fps page`, () => {
      const { doc, page, sheetClip, flipbookId } = scene(sheetFps, pageFps, 10);
      const cells = flipbookRows(doc, flipbookId)[0]!.cells;
      expect(cells.length).toBe(10);

      cells.forEach((cell, i) => {
        // Stand INSIDE the cell's drawing — where the app actually stands when
        // you click a frame, and one hop deeper than the sheet. That depth is
        // the point: `childTimeOf` clamps, so a parent instant that falls
        // BEFORE a cell still descends into it as time 0. Testing one hop up
        // hides that behind a frame-index comparison that happens to agree.
        const ctx = resolveEditContext(doc, editPath(page.id, [sheetClip.id, cell.id]), 0);
        expect(ctx).not.toBeNull();
        const rootMs = ctx!.frameTimes.get(page.id)!;

        // Now do exactly what the renderer does with that number: floor it to
        // the page's grid, step into the sheet, floor to the sheet's grid.
        const shown = quantizeMsToFrame(
          childTimeOf(doc, sheetClip, quantizeMsToFrame(rootMs, pageFps)),
          sheetFps,
        );
        expect(msToFrameIndex(shown, sheetFps), `cell ${i}`).toBe(
          msToFrameIndex(cell.startMs, frameFps(doc, doc.frames.find((f) => f.id === flipbookId)!)),
        );
      });
    });
  }

  it("leaves an already-addressable instant exactly as mapped", () => {
    const { doc, page, sheetClip } = scene(30, 30, 4);
    const ctx = resolveEditContext(doc, editPath(page.id, [sheetClip.id]), 100);
    // Same grid on both sides: nothing to repair, and nothing is touched.
    expect(ctx!.frameTimes.get(page.id)).toBe(100);
  });
});
