"use client";

import { create } from "zustand";
import type { GraphTab } from "./GraphPanel";

/**
 * The ONE headless owner of the keyframe/curve editor's open state + which tab
 * it shows. Lifted out of Timeline local state so every surface agrees on it:
 * the timeline-header segmented control, the in-panel tabs, and the Window
 * menu all read and drive THIS. Only one tab is ever active — Keyframes (the
 * dope sheet) OR Curves (the value graph) — never both; `toggle` opens a tab,
 * or closes the editor when you click the tab it's already showing.
 */

interface GraphEditorState {
  open: boolean;
  tab: GraphTab;
  /** Segmented-control / Window behavior: open TO `tab`, or close if it's already the shown tab. */
  toggle: (tab: GraphTab) => void;
  /** Open the editor on a specific tab (used by the Window menu + shortcuts). */
  show: (tab: GraphTab) => void;
  setTab: (tab: GraphTab) => void;
  setOpen: (open: boolean) => void;
}

export const useGraphEditor = create<GraphEditorState>((set) => ({
  open: false,
  tab: "keys",
  toggle: (tab) => set((s) => (s.open && s.tab === tab ? { open: false } : { open: true, tab })),
  show: (tab) => set({ open: true, tab }),
  setTab: (tab) => set({ tab }),
  setOpen: (open) => set({ open }),
}));
