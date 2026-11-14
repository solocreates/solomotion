"use client";

import { create } from "zustand";

/**
 * The track-header / property-tree GUTTER width.
 *
 * Two surfaces line up against it — the timeline's track headers and the graph
 * panel's property tree — so clip names and property names sit in the same
 * column. It used to be `React.useState` inside `Timeline`, which made the
 * timeline the owner and the graph a prop-taker: the graph could only exist as
 * the timeline's child, and that is a large part of why Keyframes and Curves
 * could not be opened on their own.
 *
 * Lifted here it belongs to neither. Either surface can render alone, both stay
 * aligned when both are up, and the resize handle keeps writing to one place.
 */

const KEY = "tm-header-w";
export const MIN_HEADER_W = 104;
export const MAX_HEADER_W = 480;
const DEFAULT_HEADER_W = 168;

function load(): number {
  if (typeof window === "undefined") return DEFAULT_HEADER_W;
  const v = Number(window.localStorage.getItem(KEY));
  return Number.isFinite(v) && v >= MIN_HEADER_W ? Math.min(MAX_HEADER_W, v) : DEFAULT_HEADER_W;
}

interface HeaderWidthState {
  width: number;
  /** Live value during a drag — persisted by `commit` when the drag ends, so a
   *  resize doesn't write to localStorage on every pointer move. */
  set: (width: number) => void;
  commit: () => void;
}

export const useHeaderWidth = create<HeaderWidthState>((set, get) => ({
  width: load(),
  set: (width) => set({ width: Math.min(MAX_HEADER_W, Math.max(MIN_HEADER_W, width)) }),
  commit: () => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(KEY, String(get().width));
    } catch {
      /* a full quota must never break a resize */
    }
  },
}));
