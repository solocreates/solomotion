import { describe, expect, it } from "vitest";
import { createEmptyDocument, createTrack } from "../factories";
import { addFlipbookCell, createFlipbook, flipbookRows, rowCellAt } from "./flipbook";
import { clipLocalTime } from "../animation/evaluate";
import { compRenderTimeMs, frameIndexToMs } from "../timeline/fps";

/** A sheet at `fps` with `n` one-frame cells, placed in a host track. */
function sheet(fps: number, n: number) {
  const doc = createEmptyDocument();
  const made = createFlipbook(doc, {
    parentFrameId: doc.frames[0]!.id,
    startMs: 0,
    width: 1080,
    height: 1920,
    fps,
  });
  // `createFlipbook` builds the owner clip; placing it is the caller's job.
  const host = createTrack("host");
  host.clips.push(made.clip);
  doc.tracks.unshift(host);
  const rowTrack = made.rowTrack.id;
  for (let i = 1; i < n; i++) addFlipbookCell(doc, made.flipbook.id, rowTrack);
  return { doc, flipbookId: made.flipbook.id };
}

describe("which cell a row shows", () => {
  /**
   * THE INVARIANT, and the bug this file exists for.
   *
   * The sheet, the breadcrumb, the layers panel and the paint target all ask
   * `rowCellAt`. The PICTURE is painted by the renderer's own span test on the
   * quantised clock. If those two disagree for even one frame index you are
   * standing on one cell and looking at another — which is exactly how it read,
   * and why it looked random rather than broken: at 12fps it was every third
   * frame, at 24fps a different third, at 30fps none of them.
   */
  for (const fps of [12, 24, 30, 8, 23.976, 29.97]) {
    it(`agrees with the renderer at every frame index (${fps}fps)`, () => {
      const { doc, flipbookId } = sheet(fps, 24);
      const row = flipbookRows(doc, flipbookId)[0]!;
      expect(row.cells).toHaveLength(24);
      for (let i = 0; i < 24; i++) {
        const t = frameIndexToMs(i, fps);
        const shown = rowCellAt(doc, flipbookId, row, t);
        // What the renderer paints: the clip covering the quantised instant.
        const q = compRenderTimeMs(doc, flipbookId, t);
        const painted = row.cells.find((c) => clipLocalTime(c, q) !== null) ?? null;
        expect(painted, `frame ${i} at ${fps}fps paints nothing`).not.toBeNull();
        expect(shown?.id, `frame ${i} at ${fps}fps`).toBe(painted?.id);
      }
    });

    it(`gives each cell exactly one frame, gaplessly (${fps}fps)`, () => {
      const { doc, flipbookId } = sheet(fps, 12);
      const cells = flipbookRows(doc, flipbookId)[0]!.cells;
      cells.forEach((cell, i) => {
        // Bit-for-bit: a cell's end IS the next cell's start, and its start IS
        // the grid instant the render clock resolves that frame to.
        expect(cell.startMs).toBe(frameIndexToMs(i, fps));
        expect(cell.startMs + cell.durationMs).toBe(frameIndexToMs(i + 1, fps));
      });
    });
  }

  /**
   * A playhead is not on a grid instant most of the time — it is scrubbed,
   * played and stepped to whatever millisecond. Every one of those must resolve
   * to the cell the render clock is holding, since that is the picture on the
   * glass. (Within `GRID_EPSILON_MS` of a boundary the clock counts the time as
   * the boundary; the sheet follows the clock rather than the arithmetic.)
   */
  it("follows the render clock at arbitrary instants, not just grid ones", () => {
    const { doc, flipbookId } = sheet(12, 8);
    const row = flipbookRows(doc, flipbookId)[0]!;
    for (let ms = 0; ms < 8 * (1000 / 12); ms += 1.7) {
      const q = compRenderTimeMs(doc, flipbookId, ms);
      const painted = row.cells.find((c) => clipLocalTime(c, q) !== null) ?? null;
      expect(rowCellAt(doc, flipbookId, row, ms)?.id, `at ${ms}ms`).toBe(painted?.id);
    }
  });
});
