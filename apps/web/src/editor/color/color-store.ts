"use client";

import { create } from "zustand";
import type { Camera, ScopeKind } from "@solomotion/core";

/**
 * EPHEMERAL COLOR PAGE STATE.
 *
 * The same split every other surface here makes: the GRAPH lives in the
 * undoable document (on its `grade` effect card), and this holds only the view
 * — which node you are correcting, which scope you are reading, where the board
 * camera sits. None of it is undoable, none of it dirties the document, and
 * none of it is persisted: which node you had selected is not a property of the
 * file.
 *
 * The board camera IS kept per graph for the session, like the node board's,
 * so closing and reopening the page lands where you left it.
 */

export type CorrectorTab = "grade" | "key" | "windows";

interface ColorState {
  open: boolean;
  /** The clip being graded — resolved from selection, pinned while you work. */
  clipId: string | null;
  /** The grade card on that clip (a clip may carry several). */
  cardId: string | null;
  selectedNodeId: string | null;
  /** Highlighted wire, for delete/detach. */
  selectedEdgeId: string | null;
  tab: CorrectorTab;
  scope: ScopeKind;
  /**
   * Paint the selected node's MATTE over the picture instead of the picture.
   * Every grading app has this and it is not a nicety: a key you cannot see is
   * a key you tune by guessing.
   */
  showMatte: boolean;
  /** Per-graph board camera. */
  views: Record<string, Camera>;

  setOpen: (open: boolean) => void;
  toggle: () => void;
  setTarget: (clipId: string | null, cardId: string | null) => void;
  selectNode: (id: string | null) => void;
  selectEdge: (id: string | null) => void;
  setTab: (tab: CorrectorTab) => void;
  setScope: (scope: ScopeKind) => void;
  setShowMatte: (on: boolean) => void;
  setView: (graphId: string, camera: Camera) => void;
}

export const useColorStore = create<ColorState>((set) => ({
  open: false,
  clipId: null,
  cardId: null,
  selectedNodeId: null,
  selectedEdgeId: null,
  tab: "grade",
  scope: "waveform",
  showMatte: false,
  views: {},

  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
  setTarget: (clipId, cardId) =>
    set((s) =>
      s.clipId === clipId && s.cardId === cardId
        ? {}
        : { clipId, cardId, selectedNodeId: null, selectedEdgeId: null },
    ),
  selectNode: (id) => set({ selectedNodeId: id, selectedEdgeId: null }),
  selectEdge: (id) => set({ selectedEdgeId: id, selectedNodeId: null }),
  setTab: (tab) => set({ tab }),
  setScope: (scope) => set({ scope }),
  setShowMatte: (showMatte) => set({ showMatte }),
  setView: (graphId, camera) => set((s) => ({ views: { ...s.views, [graphId]: camera } })),
}));
