"use client";

import { create } from "zustand";
import { useWindowManager } from "@/components/ui/window-manager";
import { resolveRuntimePlugin } from "./plugins-store";

/**
 * WHERE each plugin is currently showing — the one answer, so the two ways to
 * show a plugin can't disagree.
 *
 * A plugin runs either in a floating window or DOCKED in the Plugins panel, and
 * never in both: two mounts of one plugin is two React trees for a built-in and
 * two bridged iframes for an installed one, i.e. two writers on one document.
 * That is a whole class of bug (the same shape as two owners fighting over one
 * `currentTime`), so it is made unrepresentable here rather than defended
 * against downstream — `open` undocks, `dock` closes the window.
 *
 * Ephemeral like the rest of the session. STACKING is not here: every window
 * competes in the ONE shared window manager (`useWindowManager`), keyed by
 * `plugin:<id>`, so the last-touched window wins z across plugins and panels.
 */
export interface PluginWindowState {
  pluginId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
}

/**
 * WHAT a plugin was opened TO DO — a query, a shelf, a filter.
 *
 * Opaque string pairs, deliberately: the store must not learn what "q" means
 * to the sound browser, or every plugin that wants to be opened with context
 * becomes an edit here. It is the shape of a URL's query string, and it scales
 * the same way — a new parameter is a new key, understood by exactly the one
 * plugin that reads it.
 *
 * `at` is a monotonic token rather than a consumed flag. A plugin that is
 * ALREADY open must still react when you hand it a new query, and "consume
 * once on mount" cannot express that — it would silently do nothing the second
 * time, which is precisely when the user is sure it should work.
 */
export interface PluginIntent {
  at: number;
  params: Record<string, string>;
}

let intentToken = 0;

/** The window-manager id for a plugin window (shared, globally-unique namespace). */
export function pluginWindowId(pluginId: string): string {
  return `plugin:${pluginId}`;
}

interface PluginWindowsStore {
  windows: PluginWindowState[];
  /** The plugin running INSIDE the Plugins panel, if any. */
  docked: string | null;
  /** Latest intent per plugin — what it was most recently opened to do. */
  intents: Record<string, PluginIntent | undefined>;
  open: (pluginId: string, params?: Record<string, string>) => void;
  /** Run a plugin in the Plugins panel (closing its window if it had one). */
  dock: (pluginId: string) => void;
  /** Back to the plugin list. */
  undock: () => void;
  close: (pluginId: string) => void;
  closeAll: () => void;
  minimizeAll: () => void;
  toggleMinimized: (pluginId: string) => void;
  setBounds: (pluginId: string, patch: Partial<Pick<PluginWindowState, "x" | "y" | "width" | "height">>) => void;
}

export const usePluginWindows = create<PluginWindowsStore>((set, get) => ({
  windows: [],
  docked: null,
  intents: {},

  dock: (pluginId) => {
    const plugin = resolveRuntimePlugin(pluginId);
    if (!plugin || !plugin.enabled) return;
    set((s) => ({ docked: pluginId, windows: s.windows.filter((w) => w.pluginId !== pluginId) }));
  },

  undock: () => set({ docked: null }),

  open: (pluginId, params) => {
    if (params) {
      set((s) => ({
        intents: { ...s.intents, [pluginId]: { at: ++intentToken, params } },
      }));
    }
    // Windowing a docked plugin MOVES it — the panel drops back to its list.
    if (get().docked === pluginId) set({ docked: null });
    const existing = get().windows.find((w) => w.pluginId === pluginId);
    if (existing) {
      // Re-opening = surface it (un-minimize + raise), never a second window.
      set((s) => ({
        windows: s.windows.map((w) => (w.pluginId === pluginId ? { ...w, minimized: false } : w)),
      }));
      useWindowManager.getState().raise(pluginWindowId(pluginId));
      return;
    }
    const plugin = resolveRuntimePlugin(pluginId);
    if (!plugin || !plugin.enabled) return;
    const { width, height } = plugin.window;
    // Cascade new windows from the top-right, clear of the inspector.
    const n = get().windows.length;
    const x = Math.max(16, (typeof window !== "undefined" ? window.innerWidth : 1200) - width - 340 - n * 24);
    const y = 72 + n * 24;
    set((s) => ({ windows: [...s.windows, { pluginId, x, y, width, height, minimized: false }] }));
  },

  close: (pluginId) =>
    set((s) => ({
      windows: s.windows.filter((w) => w.pluginId !== pluginId),
      docked: s.docked === pluginId ? null : s.docked,
    })),
  closeAll: () => set({ windows: [], docked: null }),
  minimizeAll: () => set((s) => ({ windows: s.windows.map((w) => ({ ...w, minimized: true })) })),

  toggleMinimized: (pluginId) =>
    set((s) => ({
      windows: s.windows.map((w) => (w.pluginId === pluginId ? { ...w, minimized: !w.minimized } : w)),
    })),

  setBounds: (pluginId, patch) =>
    set((s) => ({
      windows: s.windows.map((w) => (w.pluginId === pluginId ? { ...w, ...patch } : w)),
    })),
}));
