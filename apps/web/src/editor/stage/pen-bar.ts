"use client";

import * as React from "react";
import { create } from "zustand";

/**
 * The PEN CHANNEL — how the pen's live edit context reaches the stage's tool
 * options bar.
 *
 * The pen used to render its own floating capsule from inside `VectorOverlay`,
 * positioned by hand ("the stage's `top` chrome slot, by hand", said the
 * comment) with its own radius, its own blur, its own border and its own
 * accent-filled armed state. So the app had two tool bars over one canvas that
 * agreed about nothing, and the pen — the tool with the most to say — was the
 * one tool whose options were not in the tool options bar.
 *
 * The reason it was stuck there is real: the bar's content depends on the live
 * node selection, which lives deep inside the overlay. This is that dependency
 * turned around. The overlay PUBLISHES what it knows; the bar subscribes. Same
 * move the inspector's tabs made when the rail outside needed to drive state
 * that was `useState` inside — a surface outside a component cannot read into
 * it, so the component pushes out.
 */

/** Every verb the pen/node editor exposes — the shared action vocabulary the
 *  toolbar, the keyboard, and the right-click menu all speak. */
export type PenAction =
  | "smooth"
  | "corner"
  | "mirror"
  | "reset"
  | "average"
  | "alignL"
  | "alignH"
  | "alignR"
  | "alignT"
  | "alignV"
  | "alignB"
  | "break"
  | "deleteSeg"
  | "duplicateSeg"
  | "insertPoint"
  | "toLine"
  | "toCurve"
  | "deleteNode"
  | "close"
  | "open"
  | "reverse"
  | "simplify"
  | "join"
  | "cut";

/** What the current selection supports — drives which actions are shown.
 *  `editing` separates "the pen is armed" from "a path is open for editing";
 *  the bar is the pen's home either way, but only one of them has geometry
 *  for the whole-path verbs to act on. */
export interface PenToolbarCtx {
  editing: boolean;
  nodeCount: number;
  singleNode: boolean;
  adjacentPair: boolean;
  /** The selected segment's current shape — null when none is selected. Lets a
   *  menu offer the conversion that applies instead of both of them. */
  segment: "line" | "curve" | null;
  endpointPair: boolean;
  anyClosed: boolean;
  anyOpen: boolean;
  cutActive: boolean;
}

/** The latched vector-edit mode (D12). ⌘ held is a momentary Bend in Move. */
export type VectorMode = "move" | "bend";

interface PenBarStore {
  /** null = the pen has nothing to say; the bar shows only its defaults. */
  ctx: PenToolbarCtx | null;
  mode: VectorMode;
  setMode: (mode: VectorMode) => void;
  dispatch: (a: PenAction) => void;
  publish: (ctx: PenToolbarCtx | null, dispatch: (a: PenAction) => void) => void;
}

function sameCtx(a: PenToolbarCtx | null, b: PenToolbarCtx | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.editing === b.editing &&
    a.nodeCount === b.nodeCount &&
    a.singleNode === b.singleNode &&
    a.adjacentPair === b.adjacentPair &&
    a.segment === b.segment &&
    a.endpointPair === b.endpointPair &&
    a.anyClosed === b.anyClosed &&
    a.anyOpen === b.anyOpen &&
    a.cutActive === b.cutActive
  );
}

export const usePenBar = create<PenBarStore>((set, get) => ({
  ctx: null,
  dispatch: () => {},
  mode: "move",
  setMode: (mode) => set({ mode }),
  publish: (ctx, dispatch) => {
    // The overlay recomputes its context every render; only a real CHANGE may
    // reach the store, or the bar re-renders on every pointer move of a drag.
    if (sameCtx(get().ctx, ctx) && get().dispatch === dispatch) return;
    set({ ctx, dispatch });
  },
}));

/** Called by the overlay each render; publishes after paint, never during. */
export function usePublishPenBar(ctx: PenToolbarCtx | null, dispatch: (a: PenAction) => void): void {
  React.useEffect(() => {
    usePenBar.getState().publish(ctx, dispatch);
  });
  React.useEffect(() => () => usePenBar.getState().publish(null, () => {}), []);
}
