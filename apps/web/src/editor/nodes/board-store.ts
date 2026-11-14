"use client";

import { create } from "zustand";
import type { Camera, GraphEdge, GraphNode } from "@solomotion/core";

/**
 * Ephemeral NODE-BOARD UI state. The board is SELECTION-DRIVEN: `isOpen` toggles
 * it, and `activeGraphId` is the graph resolved from the current selection
 * (each layer/frame owns its own node tree — see `NodeBoardHost`). The GRAPH
 * data lives in the undoable document store (`doc.graphs`); this holds only the
 * view-layer bits — selection, the node clipboard, and the per-graph board
 * camera (session-level, never undoable), mirroring how session state sits
 * beside the document elsewhere.
 */

export interface NodeClipboard {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface BoardState {
  /** Is the node board showing (over the stage slot)? */
  isOpen: boolean;
  /** The graph currently shown — resolved from selection by the host. */
  activeGraphId: string | null;
  /**
   * A one-shot request to reveal one node tree: pin `graphId` (overriding the
   * selection-driven graph) and center/select `nodeId`. Set by "open in nodes"
   * from a sidebar driver chip; cleared once the board centers on it, or on the
   * next real selection change. This is the reusable "open board AT a node" seam.
   */
  focus: { graphId: string; nodeId: string } | null;
  selectedNodeIds: string[];
  selectedEdgeId: string | null;
  clipboard: NodeClipboard | null;
  /** Per-graph board camera — ephemeral (survives close/reopen in a session, not
   *  undoable, never dirties the document), like the timeline's session zoom. */
  views: Record<string, Camera>;
  /** Minimap visibility + which corner it docks to (board view preferences). */
  minimapVisible: boolean;
  minimapCorner: "tl" | "tr" | "bl" | "br";

  open: () => void;
  close: () => void;
  /** Open the board pinned to a graph, centered on one node (from a driver chip). */
  focusOnNode: (graphId: string, nodeId: string) => void;
  /** Drop the focus pin — the board returns to selection-driven resolution. */
  clearFocus: () => void;
  setMinimapVisible: (v: boolean) => void;
  setMinimapCorner: (c: "tl" | "tr" | "bl" | "br") => void;
  /** Point the board at a graph; clears node selection when it actually changes. */
  setActiveGraph: (id: string | null) => void;
  setView: (graphId: string, camera: Camera) => void;
  select: (ids: string[], additive?: boolean) => void;
  toggle: (id: string) => void;
  selectEdge: (id: string | null) => void;
  clearSelection: () => void;
  setClipboard: (c: NodeClipboard | null) => void;
}

export const useBoardStore = create<BoardState>((set) => ({
  isOpen: false,
  activeGraphId: null,
  focus: null,
  selectedNodeIds: [],
  selectedEdgeId: null,
  clipboard: null,
  views: {},
  minimapVisible: true,
  // Bottom-left by default — the settings gear owns bottom-right (mirroring the
  // main stage), so the map never collides with it.
  minimapCorner: "bl",

  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false, focus: null, selectedNodeIds: [], selectedEdgeId: null }),
  focusOnNode: (graphId, nodeId) =>
    set({ isOpen: true, activeGraphId: graphId, focus: { graphId, nodeId }, selectedNodeIds: [nodeId], selectedEdgeId: null }),
  clearFocus: () => set((s) => (s.focus ? { focus: null } : {})),
  setMinimapVisible: (v) => set({ minimapVisible: v }),
  setMinimapCorner: (c) => set({ minimapCorner: c }),
  setActiveGraph: (id) =>
    set((s) => (s.activeGraphId === id ? {} : { activeGraphId: id, selectedNodeIds: [], selectedEdgeId: null })),
  setView: (graphId, camera) => set((s) => ({ views: { ...s.views, [graphId]: camera } })),
  select: (ids, additive) =>
    set((s) => ({
      selectedNodeIds: additive ? [...new Set([...s.selectedNodeIds, ...ids])] : ids,
      selectedEdgeId: null,
    })),
  toggle: (id) =>
    set((s) => ({
      selectedNodeIds: s.selectedNodeIds.includes(id)
        ? s.selectedNodeIds.filter((x) => x !== id)
        : [...s.selectedNodeIds, id],
      selectedEdgeId: null,
    })),
  selectEdge: (id) => set({ selectedEdgeId: id, selectedNodeIds: [] }),
  clearSelection: () => set({ selectedNodeIds: [], selectedEdgeId: null }),
  setClipboard: (c) => set({ clipboard: c }),
}));
