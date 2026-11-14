"use client";

import { cellPaintTargetId, type MotionDocument, type Clip } from "@solomotion/core";
import { useSession } from "../state/session";

/**
 * FOCUS A FLIPBOOK CELL — the ONE gesture, for every surface that has one.
 *
 * Clicking a cell, double-clicking it, adding one, pasting one, drawing into a
 * void slot and undoing a delete all mean the same thing: *that frame is the
 * one I am working on now*. Four files each said it in their own words, and all
 * four said it with a literal `0` for the time — which is precisely why
 * focusing a frame moved the playhead, and moving the playhead refocused a
 * frame, each undoing the other on the next tick.
 *
 * It is two verbs in a fixed order, and the order is the whole design:
 *
 *   seekIn(sheet, cell.startMs)   WHICH MOMENT — in the sheet's own clock.
 *   revealFrame(cell's drawing)   WHERE I STAND — carrying that instant down
 *                                 through the cell's trim and speed, because
 *                                 every navigation verb carries the instant.
 *
 * Standing somewhere can no longer move the moment, so there is nothing left
 * for the two to fight about.
 */
export function focusFlipbookCell(doc: MotionDocument, cell: Clip): void {
  if (cell.kind !== "nested") return;
  const session = useSession.getState();
  session.seekIn(cell.frameId, cell.startMs);
  session.revealFrame(cell.sourceFrameId, undefined, { pinTabs: false });
  session.select([cellPaintTargetId(doc, cell)]);
}
