"use client";

import {
  gestureMods,
  watchMods,
  type Mods,
  NO_MODS,
  sameMods,
} from "../input/modifiers";
import { isApplePlatform } from "../input/pointer-env";

/**
 * Live drag MODIFIER tracking — the one reusable seam that makes ⇧/⌥/⌘ respond
 * DURING a drag, even with the pointer held perfectly still. Every hand-rolled
 * pointer gesture (stage layers, pen nodes, sheet cells) reads modifiers the
 * same way and re-applies itself the instant a modifier toggles, so "hold ⇧ to
 * constrain" and "hold ⌥ to duplicate" turn on/off in real time everywhere —
 * no gesture re-implements this.
 *
 * This file is now a THIN FACE over `input/modifiers`, and that indirection is
 * the whole reason touch works. It used to read `e.shiftKey` straight off the
 * event, which meant a modifier could only ever come from a keyboard — and a
 * tablet has none, so every constrain/duplicate/bypass gesture in the app was
 * unreachable with a finger. The store underneath merges the keyboard with the
 * on-screen modifier puck, so all forty of those gestures gained touch support
 * without any of them changing a line.
 *
 * The API is unchanged on purpose: callers ask the same question they always
 * did, and get an answer that now knows about more than a keyboard.
 */

/** ⇧ / ⌥ / ⌘⌃, from every source. Structurally the store's `Mods`. */
export type DragMods = Mods;

/**
 * Read the modifier state for a gesture. The event supplies the physical keys
 * at the instant the user acted; the puck's latch is unioned on top.
 */
export function readMods(e: {
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}): DragMods {
  return gestureMods(e);
}

/** Which modifier a user-configurable gesture (e.g. drag-out-of-group) binds to. */
export type ModifierKey = "meta" | "alt" | "shift";

/** Is the configured modifier currently held? One lookup for bindable gestures. */
export function modifierActive(mods: DragMods, which: ModifierKey): boolean {
  return mods[which];
}

/** Human label for a modifier key (settings UI, tooltips). ⌘ folds Ctrl. */
export function modifierLabel(which: ModifierKey): string {
  const mac = isApplePlatform();
  return which === "meta" ? (mac ? "⌘ Cmd" : "Ctrl") : which === "alt" ? (mac ? "⌥ Option" : "Alt") : "⇧ Shift";
}

export { sameMods, NO_MODS };

/**
 * Watch ⇧/⌥/⌘ while a drag is live. Calls `onChange(mods)` whenever any of them
 * toggles — from the keyboard OR the puck — and on window blur, which releases
 * everything so a tab-switch can never leave a modifier stuck on. `initial`
 * seeds the compare so the first real change fires. Returns a cleanup to run
 * on pointerup.
 */
export function watchDragModifiers(
  initial: DragMods,
  onChange: (mods: DragMods) => void,
): () => void {
  return watchMods(initial, onChange);
}
