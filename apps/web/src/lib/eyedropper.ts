"use client";

import { create } from "zustand";

/**
 * The headless eyedropper — a promise-based color-pick service ANY control can
 * call. `beginEyedrop()` activates the stage's glass-loupe overlay (mounted by
 * Stage) and resolves with the picked hex, or null on cancel. Because the
 * overlay samples the REAL stage canvas, the value is exactly what's rendered
 * at this playback moment — videos, keyed layers, effects and all.
 *
 * The color picker uses it automatically when a surface is mounted (falling
 * back to the browser EyeDropper elsewhere), and the `I` shortcut copies a
 * sampled color to the clipboard.
 */

interface EyedropStore {
  /** A pick is in progress — the overlay renders while true. */
  active: boolean;
  /** Number of mounted loupe surfaces (0 → fall back to native EyeDropper). */
  surfaces: number;
  begin: () => Promise<string | null>;
  finish: (hex: string | null) => void;
  registerSurface: () => () => void;
}

let pending: ((hex: string | null) => void) | null = null;

export const useEyedrop = create<EyedropStore>((set, get) => ({
  active: false,
  surfaces: 0,
  begin: () => {
    pending?.(null); // a new request supersedes any dangling one
    return new Promise<string | null>((resolve) => {
      pending = resolve;
      set({ active: true });
    });
  },
  finish: (hex) => {
    const resolve = pending;
    pending = null;
    set({ active: false });
    resolve?.(hex);
  },
  registerSurface: () => {
    set((s) => ({ surfaces: s.surfaces + 1 }));
    return () => {
      set((s) => ({ surfaces: s.surfaces - 1 }));
      if (get().surfaces === 0 && get().active) get().finish(null);
    };
  },
}));

/** Start a canvas pick — resolves with "#rrggbb" or null when cancelled. */
export function beginEyedrop(): Promise<string | null> {
  return useEyedrop.getState().begin();
}

/** True when a stage loupe is mounted and can serve picks. */
export function hasEyedropSurface(): boolean {
  return useEyedrop.getState().surfaces > 0;
}

/** `hasEyedropSurface` for a view: re-renders when a loupe mounts or goes. */
export function useHasEyedropSurface(): boolean {
  return useEyedrop((s) => s.surfaces > 0);
}
