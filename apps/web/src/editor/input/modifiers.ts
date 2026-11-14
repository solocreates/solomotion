"use client";

import * as React from "react";

/**
 * THE MODIFIER STATE — ⇧ / ⌥ / ⌘⌃ — from every source that can produce them.
 *
 * Two things forced this to become a store rather than a function of an event.
 *
 * First, there were already two readers. `editor/state/drag-modifiers.ts`
 * answered "which physical keys are down" and `components/ui/drag-modifiers.ts`
 * answered "what does that MEAN for a draggable value" (fine / snap / coarse),
 * and both read the raw event independently. Two independent readers of one
 * fact will disagree eventually, and there was no seam where a third source
 * could be added to both at once.
 *
 * Second — and this is the reason it had to change now — a touch device has no
 * modifier keys at all. Every "hold ⇧ to constrain", "hold ⌥ to duplicate",
 * "⌘ to bypass snapping" gesture in the app is simply unreachable with a
 * finger. The fix is NOT a touch-specific code path in each gesture; that is
 * forty gestures each growing a second implementation. The fix is that
 * modifiers stop being a property of the event and become a property of the
 * APP, with two writers:
 *
 *     physical keyboard  ─┐
 *                         ├─→  modifiers  ─→  every gesture, unchanged
 *     the touch puck     ─┘
 *
 * A gesture that already called `readMods(e)` gains full touch support without
 * a line of change. That is the whole design.
 *
 * The physical half still reads the EVENT when one is available, because an
 * event carries the truth at the moment the gesture happened — a keydown that
 * arrived between the pointer event and our handler would otherwise apply a
 * modifier the user had not yet pressed when they pressed the button.
 */

export interface Mods {
  shift: boolean;
  alt: boolean;
  /** ⌘ on Apple platforms OR Ctrl elsewhere. One concept, both keys. */
  meta: boolean;
}

export const NO_MODS: Mods = { shift: false, alt: false, meta: false };

export const sameMods = (a: Mods, b: Mods) =>
  a.shift === b.shift && a.alt === b.alt && a.meta === b.meta;

const anyMod = (m: Mods) => m.shift || m.alt || m.meta;

/** Merge two modifier sets — held on either side counts as held. */
const union = (a: Mods, b: Mods): Mods => ({
  shift: a.shift || b.shift,
  alt: a.alt || b.alt,
  meta: a.meta || b.meta,
});

/** Read the physical keys off any pointer/mouse/keyboard event. */
export function eventMods(e: {
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}): Mods {
  return { shift: !!e.shiftKey, alt: !!e.altKey, meta: !!e.metaKey || !!e.ctrlKey };
}

// ── The store ───────────────────────────────────────────────────────────────

let keyboard: Mods = NO_MODS;
let virtual: Mods = NO_MODS;
let merged: Mods = NO_MODS;
const subscribers = new Set<() => void>();

function recompute() {
  const next = union(keyboard, virtual);
  if (sameMods(next, merged)) return;
  merged = next;
  for (const fn of subscribers) fn();
}

/** What is held right now, from every source. Safe to call outside React. */
export function currentMods(): Mods {
  return merged;
}

/**
 * The modifiers for a gesture, given the event that started (or continued) it.
 *
 * The event wins for the physical keys — it is the state at the instant the
 * user acted — and the virtual latch is unioned on top. Passing no event is
 * legitimate for the sources that have none: a keyboard-driven re-apply, a
 * modifier that changed mid-drag with the pointer still.
 */
export function gestureMods(e?: {
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}): Mods {
  return e ? union(eventMods(e), virtual) : merged;
}

/** Whether any modifier is latched by touch — the puck's own armed state. */
export function virtualMods(): Mods {
  return virtual;
}

/**
 * Latch or release a virtual modifier. The puck is the only caller today; a
 * future on-screen keyboard row or a pedal would be the same call.
 */
export function setVirtualMod(which: keyof Mods, on: boolean): void {
  if (virtual[which] === on) return;
  virtual = { ...virtual, [which]: on };
  recompute();
}

/** Set every virtual modifier at once (the puck's radial commits one state). */
export function setVirtualMods(next: Mods): void {
  if (sameMods(next, virtual)) return;
  virtual = next;
  recompute();
}

export function clearVirtualMods(): void {
  setVirtualMods(NO_MODS);
}

export function subscribeMods(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/**
 * Track the physical keyboard, app-wide. Mounted once at the shell root (see `Editor.tsx`).
 *
 * Blur clears everything: a ⌘-Tab away with ⌘ held never delivers the keyup,
 * and a modifier stuck on is worse than one that missed — every subsequent
 * drag silently duplicates, constrains or bypasses snapping with no way to see
 * why. The virtual latch is cleared too, for the same reason.
 */
export function startModifierTracking(): () => void {
  if (typeof window === "undefined") return () => {};
  const fromKey = (e: KeyboardEvent) => {
    const next = eventMods(e);
    if (sameMods(next, keyboard)) return;
    keyboard = next;
    recompute();
  };
  const release = () => {
    if (!anyMod(keyboard) && !anyMod(virtual)) return;
    keyboard = NO_MODS;
    virtual = NO_MODS;
    recompute();
  };
  window.addEventListener("keydown", fromKey);
  window.addEventListener("keyup", fromKey);
  window.addEventListener("blur", release);
  return () => {
    window.removeEventListener("keydown", fromKey);
    window.removeEventListener("keyup", fromKey);
    window.removeEventListener("blur", release);
    release();
  };
}

/** The React face — re-renders on any modifier change, physical or virtual. */
export function useMods(): Mods {
  return React.useSyncExternalStore(subscribeMods, currentMods, () => NO_MODS);
}

/**
 * Watch modifiers for the duration of a drag — the seam that makes "hold ⇧ to
 * constrain" turn on and off with the pointer held perfectly still.
 *
 * It now fires for the PUCK as well as the keyboard, which is exactly the point:
 * latching Shift mid-drag on a tablet re-applies the live gesture the same way
 * pressing the key does on a laptop. Returns a cleanup to run on pointer-up.
 */
export function watchMods(initial: Mods, onChange: (mods: Mods) => void): () => void {
  let last = initial;
  return subscribeMods(() => {
    const next = currentMods();
    if (sameMods(next, last)) return;
    last = next;
    onChange(next);
  });
}


// ── Making the app's modifiers NATURAL ──────────────────────────────────────

/**
 * TEACH THE EVENT ITSELF ABOUT THE ON-SCREEN MODIFIERS.
 *
 * `readMods(e)` / `dragModifiers(e)` / `gestureMods(e)` are the right way to
 * ask, and roughly forty gestures use them. Selection does not — and could not
 * reasonably be made to. `e.shiftKey` is read directly in the stage's click
 * resolver, the timeline's, the layers list, the filer, the variables table,
 * the node board, every list that supports shift-range and ⌘-toggle, and inside
 * component libraries we do not own. Converting them one by one is a list that
 * is never finished, and the item nobody converted is the one someone reports:
 * "I latched ⇧ on the puck and multi-select still did not work."
 *
 * So instead of teaching every reader about the puck, the EVENT is taught about
 * it. `shiftKey` and friends are accessor properties on `MouseEvent.prototype`;
 * this wraps them so they report the physical key OR the latched one. Every
 * reader in the application — including ones written next year, and ones we did
 * not write at all — becomes correct without knowing this file exists.
 *
 * That is the same move `input/modifiers.ts` already made once and the reason
 * touch modifiers work at all: make the modifier a property of the APP rather
 * than of the keyboard. This finishes it, at the only seam that reaches
 * everything.
 *
 * Three properties of the design worth stating, because a prototype patch
 * deserves the scrutiny:
 *
 *  · it only ever turns a modifier ON. The physical key is still authoritative
 *    when held, so nothing a keyboard user does can be masked.
 *  · it is applied to `MouseEvent.prototype` alone, which `PointerEvent` and
 *    `DragEvent` inherit from — one definition for every pointer gesture and
 *    every click. `KeyboardEvent` is left alone on purpose; see below.
 *  · nothing is latched unless the puck latched it, so on a desktop every
 *    getter returns exactly what it returned before.
 */
export function startModifierProjection(): () => void {
  if (typeof window === "undefined") return () => {};

  const FIELDS = [
    ["shiftKey", "shift"],
    ["altKey", "alt"],
    ["metaKey", "meta"],
  ] as const;

  const restore: Array<() => void> = [];

  /*
   * MouseEvent ONLY — `PointerEvent` and `DragEvent` inherit from it, so one
   * definition covers every pointer gesture and every click in the app.
   *
   * `KeyboardEvent` is deliberately NOT patched. The physical-key tracker reads
   * `e.shiftKey` off keydown/keyup to maintain the keyboard half of the merged
   * state; teaching those events about the latch would fold the latch into the
   * keyboard half, and releasing the puck would then leave a modifier stuck
   * until the next real keypress. A projection must never feed the source it
   * projects from.
   */
  for (const proto of [MouseEvent.prototype] as const) {
    for (const [prop, mod] of FIELDS) {
      const own = Object.getOwnPropertyDescriptor(proto, prop);
      // Not an accessor on this prototype (or already patched): leave it alone
      // rather than guessing at the shape.
      if (!own?.get || !own.configurable) continue;
      const original = own.get;
      Object.defineProperty(proto, prop, {
        ...own,
        get(this: Event) {
          return original.call(this) || virtualMods()[mod];
        },
      });
      restore.push(() => Object.defineProperty(proto, prop, own));
    }
  }

  return () => {
    for (const undo of restore) undo();
  };
}
