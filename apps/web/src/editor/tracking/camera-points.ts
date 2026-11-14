"use client";

import { create } from "zustand";

/**
 * THE SOLVE POINTS YOU PICKED — session state for the scene tools. Click dots
 * on the plate (⇧ adds); Ground takes three or more, Origin one, Scale two,
 * Text here any. Picking on another camera tracker starts a new set.
 */
interface CameraPointPick {
  trackerId: string | null;
  points: number[];
  toggle: (trackerId: string, index: number, additive: boolean) => void;
  set: (trackerId: string, points: number[]) => void;
  clear: () => void;
}

export const useCameraPoints = create<CameraPointPick>((set) => ({
  trackerId: null,
  points: [],
  toggle: (trackerId, index, additive) =>
    set((s) => {
      const same = s.trackerId === trackerId;
      const had = same && s.points.includes(index);
      if (!additive) return { trackerId, points: had && s.points.length === 1 ? [] : [index] };
      const base = same ? s.points : [];
      return { trackerId, points: had ? base.filter((p) => p !== index) : [...base, index] };
    }),
  set: (trackerId, points) => set({ trackerId, points }),
  clear: () => set({ trackerId: null, points: [] }),
}));
