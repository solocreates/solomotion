"use client";

import { create } from "zustand";

/**
 * IS ⇧ DOWN — the one answer, for the stroke and for the chrome that reports it.
 *
 * ⇧ reverses smoothing while you draw (core `effectiveSmoothing`), and the
 * handle's toggle has to light up while it is held or the modifier is invisible
 * until you look at the line you already drew. A ref inside the drawing overlay
 * could tell the stroke but not React; a second key listener in the handle
 * would be a second answer to "is it down", and the two would disagree the
 * first time one of them missed a blur.
 *
 * So: one store, written by the overlay's existing listener (which is already
 * capture-phase and already survives pointer capture), read by everyone. The
 * stroke reads it through `getState()` on the render path, which costs a
 * property lookup and no re-render.
 */
export const useShiftHeld = create<{ held: boolean; set: (held: boolean) => void }>((set) => ({
  held: false,
  set: (held) => set((s) => (s.held === held ? {} : { held })),
}));

/** For the render loop and anything else outside React. */
export const shiftHeld = (): boolean => useShiftHeld.getState().held;
