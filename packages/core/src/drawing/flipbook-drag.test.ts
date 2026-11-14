import { describe, expect, it } from "vitest";
import { createEmptyDocument, createFrame, createNestedClip, createRasterClip, createTrack } from "../factories";
import type { MotionDocument } from "../schema";
import { applyFlipbookDragPlan, planFlipbookCellDrag, planFlipbookCellResize } from "./flipbook-drag";

const STEP = 1000 / 12; // one frame at the default 12fps sheet

/** A sheet whose row holds cells at the given frame indices, one frame each. */
function sheet(rowsSpec: number[][]) {
  const doc: MotionDocument = createEmptyDocument();
  const fb = createFrame({ name: "Flipbook", width: 100, height: 100, pageId: "__internal__" });
  fb.mode = "flipbook";
  fb.fps = 12;
  doc.frames.push(fb);
  const rows = rowsSpec.map((frames, r) => {
    const track = createTrack(`row${r}`);
    track.homeCompId = fb.id;
    const cells = frames.map((f) => {
      const drawing = createFrame({ name: `d${r}-${f}`, width: 100, height: 100, pageId: "__internal__" });
      drawing.mode = "static";
      doc.frames.push(drawing);
      return createNestedClip({
        frameId: fb.id,
        sourceFrameId: drawing.id,
        startMs: f * STEP,
        durationMs: STEP,
      });
    });
    track.clips.push(...cells);
    doc.tracks.push(track);
    return cells;
  });
  return { doc, fbId: fb.id, rows };
}

/** Frame indices each cell occupies after a plan is applied. */
function framesOf(doc: MotionDocument, ids: string[]): number[] {
  const all = doc.tracks.flatMap((t) => t.clips);
  return ids.map((id) => Math.round((all.find((c) => c.id === id)?.startMs ?? 0) / STEP));
}

describe("planFlipbookCellDrag", () => {
  it("REORDERS when dragged into a run — the row neither grows nor gaps", () => {
    // frames 0..9, contiguous. Drag the SECOND cell into the middle.
    const { doc, fbId, rows } = sheet([[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]]);
    const cells = rows[0]!;
    const mover = cells[1]!;
    const plan = planFlipbookCellDrag(doc, fbId, [mover.id], 4 * STEP); // 1 → 5
    applyFlipbookDragPlan(doc, plan);
    // The cells it passed shuffle BACK into the slot it vacated; the mover
    // takes frame 5; nothing after frame 5 moves at all. Every frame 0..9 is
    // still occupied — no hole, no growth.
    expect(framesOf(doc, cells.map((c) => c.id))).toEqual([0, 5, 1, 2, 3, 4, 6, 7, 8, 9]);
  });

  it("reorders the same way dragging LEFT", () => {
    const { doc, fbId, rows } = sheet([[0, 1, 2, 3, 4, 5]]);
    const cells = rows[0]!;
    const mover = cells[4]!;
    const plan = planFlipbookCellDrag(doc, fbId, [mover.id], -3 * STEP); // 4 → 1
    applyFlipbookDragPlan(doc, plan);
    expect(framesOf(doc, cells.map((c) => c.id))).toEqual([0, 2, 3, 4, 1, 5]);
  });

  it("swaps two neighbours when dragged one slot", () => {
    const { doc, fbId, rows } = sheet([[0, 1, 2]]);
    const [a, b, c] = rows[0]!;
    const plan = planFlipbookCellDrag(doc, fbId, [a!.id], STEP);
    applyFlipbookDragPlan(doc, plan);
    expect(framesOf(doc, [a!.id, b!.id, c!.id])).toEqual([1, 0, 2]);
  });

  it("lets a real GAP absorb the chain, leaving the far side alone", () => {
    // frames 0,1, gap at 2, then 3.
    const { doc, fbId, rows } = sheet([[0, 1, 3]]);
    const [a, b, c] = rows[0]!;
    const plan = planFlipbookCellDrag(doc, fbId, [a!.id], STEP);
    applyFlipbookDragPlan(doc, plan);
    // A takes frame 1, B falls back into the slot A left, C never moves.
    expect(framesOf(doc, [a!.id, b!.id, c!.id])).toEqual([1, 0, 3]);
  });

  it("drops into a deliberate VOID without disturbing anything after it", () => {
    // 0, then a three-frame gap, then 4.
    const { doc, fbId, rows } = sheet([[0, 4]]);
    const [a, b] = rows[0]!;
    const plan = planFlipbookCellDrag(doc, fbId, [a!.id], 2 * STEP);
    applyFlipbookDragPlan(doc, plan);
    expect(framesOf(doc, [a!.id, b!.id])).toEqual([2, 4]);
  });

  it("drops into empty space without disturbing anything", () => {
    const { doc, fbId, rows } = sheet([[0, 1]]);
    const [a, b] = rows[0]!;
    const plan = planFlipbookCellDrag(doc, fbId, [a!.id], 5 * STEP);
    applyFlipbookDragPlan(doc, plan);
    expect(framesOf(doc, [a!.id, b!.id])).toEqual([5, 1]);
  });

  it("moves a multi-selection as one block, keeping its internal shape", () => {
    const { doc, fbId, rows } = sheet([[0, 1, 2, 3]]);
    const [a, b, c, d] = rows[0]!;
    // Drag A and C (a gapped pair) two frames right.
    const plan = planFlipbookCellDrag(doc, fbId, [a!.id, c!.id], 2 * STEP);
    applyFlipbookDragPlan(doc, plan);
    expect(framesOf(doc, [a!.id, c!.id])).toEqual([2, 4]);
    // And nothing else moves: the slots the block vacated are exactly the ones
    // B and D already sat in, so there is nothing to displace. A rule that
    // shoved them anyway would be rearranging rather than reordering.
    expect(framesOf(doc, [b!.id, d!.id])).toEqual([1, 3]);
  });

  it("falls FORWARD when the hole cannot absorb the chain", () => {
    // Nothing to the left to fall into: the row starts at frame 0.
    const { doc, fbId, rows } = sheet([[0, 1]]);
    const [a, b] = rows[0]!;
    // Drag the SECOND cell one frame right, onto empty space — no chain at all.
    // Then drag the first onto the second with the row pinned at zero.
    const plan = planFlipbookCellDrag(doc, fbId, [b!.id], -STEP);
    applyFlipbookDragPlan(doc, plan);
    // B wants frame 0, A falls forward because there is no room behind it.
    expect(framesOf(doc, [b!.id, a!.id])).toEqual([0, 1]);
  });

  it("never shoves a LOCKED cell, in either direction", () => {
    const { doc, fbId, rows } = sheet([[0, 1, 2, 3]]);
    const [a, b, c, d] = rows[0]!;
    doc.tracks.flatMap((t) => t.clips).find((x) => x.id === c!.id)!.locked = true;
    // Landing ON the locked cell is refused outright.
    expect(planFlipbookCellDrag(doc, fbId, [a!.id], 2 * STEP).starts.size).toBe(0);
    // Landing beside it still works, and the locked cell holds its frame.
    const plan = planFlipbookCellDrag(doc, fbId, [a!.id], STEP);
    applyFlipbookDragPlan(doc, plan);
    expect(framesOf(doc, [c!.id])).toEqual([2]);
    expect(framesOf(doc, [a!.id, b!.id, d!.id])).toEqual([1, 0, 3]);
  });

  it("clamps the GROUP at zero, never compressing it", () => {
    const { doc, fbId, rows } = sheet([[2, 4]]);
    const [a, b] = rows[0]!;
    const plan = planFlipbookCellDrag(doc, fbId, [a!.id, b!.id], -10 * STEP);
    applyFlipbookDragPlan(doc, plan);
    // The leading cell stops at 0 and the pair keeps its two-frame gap.
    expect(framesOf(doc, [a!.id, b!.id])).toEqual([0, 2]);
  });

  it("plans each row independently — a mover in one never collides with another", () => {
    const { doc, fbId, rows } = sheet([[0, 1], [0, 1]]);
    const [a0, b0] = rows[0]!;
    const [a1, b1] = rows[1]!;
    const plan = planFlipbookCellDrag(doc, fbId, [a0!.id], STEP);
    applyFlipbookDragPlan(doc, plan);
    expect(framesOf(doc, [a0!.id, b0!.id])).toEqual([1, 0]); // reordered
    expect(framesOf(doc, [a1!.id, b1!.id])).toEqual([0, 1]); // untouched
  });

  it("on a COPY the originals stay and are pushed like anyone else", () => {
    const { doc, fbId, rows } = sheet([[0, 1]]);
    const [a, b] = rows[0]!;
    const plan = planFlipbookCellDrag(doc, fbId, [a!.id], STEP, { copy: true });
    applyFlipbookDragPlan(doc, plan);
    // A is NOT moved (the copy will land at frame 1); B is pushed off frame 1.
    expect(framesOf(doc, [a!.id])).toEqual([0]);
    expect(framesOf(doc, [b!.id])).toEqual([2]);
  });

  it("quantises to the frame grid", () => {
    const { doc, fbId, rows } = sheet([[0]]);
    const [a] = rows[0]!;
    const plan = planFlipbookCellDrag(doc, fbId, [a!.id], STEP * 1.4);
    expect(plan.deltaMs).toBeCloseTo(STEP, 5);
  });

  it("is a no-op for a zero drag", () => {
    const { doc, fbId, rows } = sheet([[0, 1, 2]]);
    const plan = planFlipbookCellDrag(doc, fbId, [rows[0]![0]!.id], 0);
    expect(plan.starts.size).toBe(0);
  });
});

/** Frame index + hold count, for reading a resize's result. */
function spansOf(doc: MotionDocument, ids: string[]): Array<[number, number]> {
  const all = doc.tracks.flatMap((t) => t.clips);
  return ids.map((id) => {
    const c = all.find((x) => x.id === id)!;
    return [Math.round(c.startMs / STEP), Math.round(c.durationMs / STEP)] as [number, number];
  });
}

describe("planFlipbookCellResize", () => {
  it("grows a hold and RIPPLES the cells touching it", () => {
    const { doc, fbId, rows } = sheet([[0, 1, 2]]);
    const [a, b, c] = rows[0]!;
    applyFlipbookDragPlan(doc, planFlipbookCellResize(doc, fbId, [a!.id], "hold", 2 * STEP));
    expect(spansOf(doc, [a!.id, b!.id, c!.id])).toEqual([
      [0, 3],
      [3, 1],
      [4, 1],
    ]);
  });

  it("stops the ripple at the first real GAP, which absorbs the change", () => {
    // 0, 1, then a gap, then 4.
    const { doc, fbId, rows } = sheet([[0, 1, 4]]);
    const [a, b, c] = rows[0]!;
    applyFlipbookDragPlan(doc, planFlipbookCellResize(doc, fbId, [a!.id], "hold", STEP));
    // B is touching so it moves; the gap before C absorbs the rest.
    expect(spansOf(doc, [a!.id, b!.id, c!.id])).toEqual([
      [0, 2],
      [2, 1],
      [4, 1],
    ]);
  });

  it("shrinks a hold and pulls the chain back with it", () => {
    const { doc, fbId, rows } = sheet([[0, 1, 2]]);
    const [a, b, c] = rows[0]!;
    applyFlipbookDragPlan(doc, planFlipbookCellResize(doc, fbId, [a!.id], "hold", 3 * STEP));
    applyFlipbookDragPlan(doc, planFlipbookCellResize(doc, fbId, [a!.id], "hold", -2 * STEP));
    expect(spansOf(doc, [a!.id, b!.id, c!.id])).toEqual([
      [0, 2],
      [2, 1],
      [3, 1],
    ]);
  });

  it("never shrinks a cell below one frame", () => {
    const { doc, fbId, rows } = sheet([[0, 1]]);
    const [a] = rows[0]!;
    applyFlipbookDragPlan(doc, planFlipbookCellResize(doc, fbId, [a!.id], "hold", -99 * STEP));
    expect(spansOf(doc, [a!.id])).toEqual([[0, 1]]);
  });

  it("trims the START, holding the end still", () => {
    const { doc, fbId, rows } = sheet([[0, 4]]);
    const [, b] = rows[0]!;
    applyFlipbookDragPlan(doc, planFlipbookCellResize(doc, fbId, [b!.id], "start", -2 * STEP));
    // Starts two frames earlier and is three frames long; the end never moved.
    expect(spansOf(doc, [b!.id])).toEqual([[2, 3]]);
  });

  it("will not let a start trim cross the cell before it", () => {
    const { doc, fbId, rows } = sheet([[0, 1]]);
    const [a, b] = rows[0]!;
    applyFlipbookDragPlan(doc, planFlipbookCellResize(doc, fbId, [b!.id], "start", -5 * STEP));
    expect(spansOf(doc, [a!.id, b!.id])).toEqual([
      [0, 1],
      [1, 1],
    ]);
  });

  it("will not let a start trim swallow its own end", () => {
    const { doc, fbId, rows } = sheet([[0]]);
    const [a] = rows[0]!;
    applyFlipbookDragPlan(doc, planFlipbookCellResize(doc, fbId, [a!.id], "hold", 3 * STEP));
    applyFlipbookDragPlan(doc, planFlipbookCellResize(doc, fbId, [a!.id], "start", 99 * STEP));
    expect(spansOf(doc, [a!.id])).toEqual([[3, 1]]);
  });

  it("resizes a whole selection by the same frame delta", () => {
    const { doc, fbId, rows } = sheet([[0, 5]]);
    const [a, b] = rows[0]!;
    applyFlipbookDragPlan(doc, planFlipbookCellResize(doc, fbId, [a!.id, b!.id], "hold", STEP));
    expect(spansOf(doc, [a!.id, b!.id])).toEqual([
      [0, 2],
      [5, 2],
    ]);
  });

  it("refuses to resize a LOCKED cell", () => {
    const { doc, fbId, rows } = sheet([[0, 1]]);
    const [a] = rows[0]!;
    doc.tracks.flatMap((t) => t.clips).find((x) => x.id === a!.id)!.locked = true;
    const plan = planFlipbookCellResize(doc, fbId, [a!.id], "hold", 2 * STEP);
    expect(plan.durations.size).toBe(0);
  });
});

describe("applyFlipbookDragPlan", () => {
  it("re-spans the fill layers INSIDE a cell when its length changes", () => {
    // The bug this pins: a cell's layers are `fillDuration` — they span the
    // drawing, and the drawing's span is the cell's. Retime the cell without
    // re-spanning them and the paint stops partway through the hold, which on a
    // layer with an out-animation reads as the frame going dim by itself.
    const { doc, fbId, rows } = sheet([[0]]);
    const cell = rows[0]![0]!;
    const paint = createRasterClip({ frameId: cell.sourceFrameId, width: 100, height: 100 });
    paint.fillDuration = true;
    paint.startMs = 0;
    paint.durationMs = STEP;
    doc.tracks[doc.tracks.length - 1]!.clips.push(paint);

    applyFlipbookDragPlan(doc, planFlipbookCellResize(doc, fbId, [cell.id], "hold", 4 * STEP));

    const after = doc.tracks.flatMap((t) => t.clips).find((c) => c.id === paint.id)!;
    expect(Math.round(after.durationMs / STEP)).toBe(5);
  });

  it("leaves fill layers alone when only the cell's START moves", () => {
    const { doc, fbId, rows } = sheet([[0, 4]]);
    const [a] = rows[0]!;
    const paint = createRasterClip({ frameId: a!.sourceFrameId, width: 100, height: 100 });
    paint.fillDuration = true;
    paint.startMs = 0;
    paint.durationMs = STEP;
    doc.tracks[doc.tracks.length - 1]!.clips.push(paint);

    applyFlipbookDragPlan(doc, planFlipbookCellDrag(doc, fbId, [a!.id], 2 * STEP));

    const after = doc.tracks.flatMap((t) => t.clips).find((c) => c.id === paint.id)!;
    expect(Math.round(after.durationMs / STEP)).toBe(1);
  });
});
