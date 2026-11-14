"use client";

import { create } from "zustand";

/**
 * THE window manager — one headless, app-agnostic stacking registry for every
 * floating surface (plugin windows, floating panels, the variables window, rail
 * flyouts… anything). It knows nothing about what a window IS; it only tracks
 * focus order by opaque id, exactly like a desktop window manager. Whatever you
 * touch last comes to the front; a freshly-opened window opens on top. There is
 * no per-feature z-index any more — each surface registers an id, raises it on
 * interaction, and reads `windowZIndex` for its CSS z. Reuse it for any future
 * floating thing; ids just need to be unique (prefix by feature, e.g. `plugin:x`).
 */

/** Floating windows live in [BASE, CAP] so they always sit BELOW shadcn/Radix
 *  portals (z-50) — a picker/menu opened from inside a window still paints on
 *  top of it. The frontmost window gets the highest value, capped at CAP. */
export const WINDOW_Z_BASE = 30;
export const WINDOW_Z_CAP = 49;

interface WindowManagerStore {
  /** Window ids, bottom → top. The LAST entry is frontmost. */
  order: string[];
  /** Add a window on top (no-op if already present — use `raise` to refocus). */
  register: (id: string) => void;
  /** Remove a window (on close/unmount). */
  unregister: (id: string) => void;
  /** Bring a window to the front (on any interaction). */
  raise: (id: string) => void;
}

export const useWindowManager = create<WindowManagerStore>((set) => ({
  order: [],
  register: (id) =>
    set((s) => (s.order.includes(id) ? s : { order: [...s.order, id] })),
  unregister: (id) =>
    set((s) => (s.order.includes(id) ? { order: s.order.filter((w) => w !== id) } : s)),
  raise: (id) =>
    set((s) => {
      if (s.order[s.order.length - 1] === id) return s; // already frontmost
      const rest = s.order.filter((w) => w !== id);
      return { order: [...rest, id] };
    }),
}));

/** The CSS z-index for `id` given the current stack order — frontmost highest,
 *  clamped into the window band. Unknown ids fall to the base. Pure so it can be
 *  called in render from an `order` selector. */
export function windowZIndex(order: readonly string[], id: string): number {
  const rank = order.indexOf(id);
  if (rank < 0) return WINDOW_Z_BASE;
  return Math.min(WINDOW_Z_CAP, WINDOW_Z_BASE + rank);
}
