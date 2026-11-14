"use client";

import { create } from "zustand";

/**
 * ONE HOVERED LAYER, shared by the Layers panel and the stage (D20).
 *
 * Hover a row → the stage outlines that layer; hover a layer on the stage → its
 * row lights. `source` says who is hovering, so each side shows only the OTHER
 * side's hover (a row under your pointer already has its CSS hover).
 *
 * A tiny store of its own rather than a session field: it changes on every
 * pointer move across rows, and nothing else in the session should re-render
 * for it. Rows read it through `useLayerHoveredOnStage`, a boolean per row, so
 * a hover change re-renders exactly the two rows involved.
 */
interface HoverLink {
  id: string | null;
  source: "layers" | "stage" | null;
  set: (id: string | null, source: "layers" | "stage") => void;
  /** Clear only if `source` still owns the hover (a leave racing an enter). */
  clear: (source: "layers" | "stage", id?: string) => void;
}

export const useHoverLink = create<HoverLink>((set, get) => ({
  id: null,
  source: null,
  set: (id, source) => {
    const s = get();
    if (s.id === id && s.source === source) return;
    set({ id, source: id ? source : null });
  },
  clear: (source, id) => {
    const s = get();
    if (s.source !== source || (id !== undefined && s.id !== id)) return;
    set({ id: null, source: null });
  },
}));

/** Is this layer hovered ON THE STAGE right now? (for its Layers row) */
export const useLayerHoveredOnStage = (id: string | null): boolean =>
  useHoverLink((s) => id != null && s.source === "stage" && s.id === id);
