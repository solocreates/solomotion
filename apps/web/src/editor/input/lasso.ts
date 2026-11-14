"use client";

import { create } from "zustand";

/**
 * THE LASSO — an app-level selection MODE, not a per-panel tool.
 *
 * Free-form selection is the same idea in the timeline, the flipbook sheet, the
 * curve editor, the node board, the layers list and the media grid: draw a
 * shape, take what falls inside it, add it to what you already had. Every one
 * of those panels could grow its own toggle, its own armed flag and its own
 * polygon code — six near-misses of one idea, which is this codebase's most
 * expensive defect class.
 *
 * So the ARM is one boolean here, and the behaviour is one hook
 * (`use-sweep-select`). Any surface that already tags its items with a data
 * attribute — and they all do, because the marquee needed that first — gets
 * the lasso by passing that attribute. Adding the seventh surface is one line.
 *
 * Why an explicit mode rather than a gesture:
 *
 * A lasso and a scroll both want "drag from empty space with one finger", and
 * unlike scroll-vs-drag-a-clip there is no hit-target difference for the
 * browser to arbitrate on — the same empty pixels mean both things. Any
 * implicit rule (hold first, two fingers, draw slowly) makes a gesture whose
 * meaning you cannot predict before committing to it. An armed tool is
 * honest: while it is on, dragging draws; while it is off, dragging scrolls.
 * Procreate, Photoshop and Illustrator all use a mode here for the same
 * reason.
 *
 * Deliberately NOT persisted. A selection mode is something you are doing right
 * now, and coming back to the app to find one-finger scrolling replaced by a
 * lasso would read as broken.
 */
interface LassoState {
  armed: boolean;
  setArmed: (armed: boolean) => void;
  toggle: () => void;
}

export const useLasso = create<LassoState>((set) => ({
  armed: false,
  setArmed: (armed) => set({ armed }),
  toggle: () => set((s) => ({ armed: !s.armed })),
}));

/** Read the arm outside React (the sweep hook's pointer handlers need it). */
export const lassoArmed = () => useLasso.getState().armed;
