"use client";

import { addFlipbookCellAt, type Clip, type DocumentStore } from "@solomotion/core";
import { useSession } from "../state/session";
import { focusFlipbookCell } from "./flipbook-focus";

/**
 * MAKE THE ARMED SLOT REAL — the ONE deferred-creation seam on a flipbook.
 *
 * Clicking an empty slot on the sheet only ARMS it. Creating a frame on the
 * click would litter the sheet with blank cells every time somebody clicked
 * around it, so the frame is born from the first gesture that actually puts
 * something in it — and then it is born headlessly, with no dialog and no
 * second click.
 *
 * "The first gesture that puts something in it" is the part that had drifted.
 * This lived privately inside `DrawingOverlay`, so it was true of the brush,
 * the pen and the bucket and of nothing else: a rectangle, a text box or a
 * dropped image aimed at the same armed slot was made in the SHEET instead,
 * one level up, floating over every frame at once. A rule that applies to some
 * tools is not a rule, it is a coincidence — the whole of "drawing works but
 * shapes go somewhere weird".
 *
 * Returns true when a frame was created. Focus moves into it through
 * `focusFlipbookCell`, the same gesture a click on a real cell performs, so a
 * mark born in a void lands on exactly the moment that click would have.
 * Selection-only tools (lasso, magic wand) deliberately do NOT call this —
 * selecting nothing should never conjure a blank frame.
 */
export function materializeArmedCell(store: DocumentStore): boolean {
  const session = useSession.getState();
  const slot = session.selectedFlipbookVoid;
  if (!slot) return false;
  const sheet = store.getState().frames.find((f) => f.id === slot.flipbookId);
  if (!sheet || sheet.mode !== "flipbook") return false;

  let created: Clip | null = null;
  store.update("Add frame", (d) => {
    const made = addFlipbookCellAt(d, slot.flipbookId, slot.trackId, slot.ms);
    if (made?.clip.kind === "nested") created = made.clip;
  });
  if (!created) return false;

  focusFlipbookCell(store.getState(), created);
  session.setSelectedFlipbookVoid(null); // the slot is a frame now
  return true;
}
