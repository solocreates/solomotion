"use client";

import { create } from "zustand";
import { isEditorId } from "../workspace/editor-registry";
import { useLayout } from "../workspace/store";

/**
 * Floating panels — now a VIEW of the layout tree's `floating` list, kept for
 * the callers that speak this API (the Window menu's counts, "minimize all",
 * "close all").
 *
 * It used to be its own store with its own idea of where a panel lived, which
 * is why popping a panel out had to reach into the sidebar and hide it by
 * hand, and why re-docking only knew one destination (the panel's hard-coded
 * side). The tree owns all of that now: floating is one of three hosts, and a
 * floating panel remembers its HOME region.
 */

export interface FloatingPanelState {
  panelId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
}

/** The window-manager id for a floating panel. */
export function panelWindowId(panelId: string): string {
  return `panel:${panelId}`;
}

interface FloatingPanelsStore {
  windows: FloatingPanelState[];
  open: (panelId: string, at?: { x: number; y: number }) => void;
  /** Close = return HOME (a floating editor is never lost). */
  close: (panelId: string) => void;
  closeAll: () => void;
  minimizeAll: () => void;
  isFloating: (panelId: string) => boolean;
}

const project = () =>
  useLayout.getState().ws.floating.map((f) => ({
    panelId: f.editor,
    x: f.bounds.x,
    y: f.bounds.y,
    width: f.bounds.width,
    height: f.bounds.height,
    minimized: !!f.minimized,
  }));

export const useFloatingPanels = create<FloatingPanelsStore>((_, get) => ({
  windows: project(),
  open: (panelId, at) => {
    if (isEditorId(panelId)) useLayout.getState().float(panelId, at);
  },
  close: (panelId) => {
    if (isEditorId(panelId)) useLayout.getState().home(panelId);
  },
  closeAll: () => {
    for (const w of get().windows) if (isEditorId(w.panelId)) useLayout.getState().home(w.panelId);
  },
  minimizeAll: () =>
    useLayout.getState().apply((ws) => ({ ...ws, floating: ws.floating.map((f) => ({ ...f, minimized: true })) })),
  isFloating: (panelId) => get().windows.some((w) => w.panelId === panelId),
}));

// One writer: the tree. This store only mirrors it.
let last = useLayout.getState().ws.floating;
useLayout.subscribe((s) => {
  if (s.ws.floating === last) return;
  last = s.ws.floating;
  useFloatingPanels.setState({ windows: project() });
});
