import { gestureMods } from "@/editor/input/modifiers";

/**
 * THE modifier contract for every draggable value in the app.
 *
 * It exists because there were three of them. A number field read ⇧ as ×10
 * (coarser), the slider brain read ⇧ as fine travel with snapping off, and the
 * knob read ⇧ as "snap to detents" — so the one key a person learns did three
 * different things in one panel, two of them opposites. That is not a styling
 * problem you can fix by picking a favourite; it is three implementations of
 * one idea, and the fix is to have one.
 *
 * The contract, and why each key means what it does:
 *
 *   ⇧  FINE — slower travel, snapping off. The modifier you hold when you are
 *      trying to hit an exact value, so anything that would pull you toward a
 *      round one has to let go while it is down.
 *   ⌃  SNAP — force the value onto the step or the nearest checkpoint. The
 *      inverse of ⇧, for when round is exactly what you want.
 *   ⌥  COARSE — ×10, for crossing a range quickly.
 *
 * Nothing else reads these keys directly. If a control needs drag modifiers, it
 * calls this, and it cannot invent a fourth meaning by accident.
 *
 * This is the SEMANTIC layer. What is physically held lives one level down in
 * `input/modifiers`, which merges the keyboard with the on-screen puck — so a
 * scrubby number field gets fine-drag from a finger on a tablet, through the
 * same three lines that give it fine-drag from ⇧ on a laptop. Reading the raw
 * event here (as this file used to) would have made the keyboard the only
 * possible source, and quietly excluded every touch device from precision.
 */
export interface DragModifiers {
  fine: boolean;
  snap: boolean;
  coarse: boolean;
}

/** Read the contract off any pointer or keyboard event. */
export function dragModifiers(e: {
  shiftKey: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}): DragModifiers {
  // ⌘ is the Mac hand for ⌃; the store already folds them into one `meta`, so
  // there is no per-platform branch at any call site.
  const m = gestureMods(e);
  return { fine: m.shift, snap: m.meta, coarse: m.alt };
}

/** Step multiplier for a nudge or a scrub, from the modifiers. */
export function stepFactor(m: DragModifiers): number {
  if (m.fine) return 0.1;
  if (m.coarse) return 10;
  return 1;
}
