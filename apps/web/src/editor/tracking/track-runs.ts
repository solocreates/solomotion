"use client";

import { create } from "zustand";
import type { RunScope, TrackSample } from "@solomotion/core";

/**
 * LIVE ANALYSIS RUNS — session state, never the document (no undo spam).
 *
 * A run belongs to the APP, not to the panel that started it. It used to be a
 * panel's `useState` plus an abort on unmount, so switching inspector tabs
 * killed a two-minute track; and the stage overlay, the timeline strip and the
 * activity ring each had to be told about it separately. Now every surface
 * reads this one store: the panel's transport, the outline moving on the
 * canvas, the strip's solving head.
 */
export interface TrackRun {
  state: "running" | "paused";
  scope: RunScope;
  done: number;
  total: number;
  /** The latest measured frame, source px / source ms. */
  live: TrackSample | null;
  /** What a long solve is doing now ("Following features — frame 40 of 300", "Finding the lens"). */
  note: string | null;
}

interface TrackRuns {
  runs: Record<string, TrackRun>;
  set: (trackerId: string, patch: Partial<TrackRun> & Pick<TrackRun, "scope">) => void;
  patch: (trackerId: string, patch: Partial<TrackRun>) => void;
  end: (trackerId: string) => void;
}

export const useTrackRuns = create<TrackRuns>((set) => ({
  runs: {},
  set: (id, run) => set((s) => ({ runs: { ...s.runs, [id]: { state: "running", done: 0, total: 0, live: null, note: null, ...run } } })),
  patch: (id, patch) => set((s) => (s.runs[id] ? { runs: { ...s.runs, [id]: { ...s.runs[id]!, ...patch } } } : s)),
  end: (id) =>
    set((s) => {
      if (!s.runs[id]) return s;
      const { [id]: _gone, ...rest } = s.runs;
      return { runs: rest };
    }),
}));

/** One tracker's run, or null — a selector, so a surface re-renders for its own tracker only. */
export const useTrackRun = (trackerId: string | null | undefined): TrackRun | null =>
  useTrackRuns((s) => (trackerId ? (s.runs[trackerId] ?? null) : null));
