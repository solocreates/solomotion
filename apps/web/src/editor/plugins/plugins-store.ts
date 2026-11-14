"use client";

import { create } from "zustand";
import { BUILTIN_PLUGINS } from "./registry";
import { iconDataUrl } from "./plugin-bundle";
import { dbDeletePlugin, dbGetAllPlugins, dbPutPlugin } from "./plugin-db";
import {
  toRuntimeFromBuiltin,
  toRuntimeFromInstalled,
  type InstalledPlugin,
  type RuntimePlugin,
} from "./plugin-model";

/**
 * The ONE registry the app reads: built-in plugins (always first) merged with the
 * user's installed ones. `plugins` is derived and recomputed on every change, so
 * the dock, the menu and the manager all render the same list from one source.
 * Installed plugins persist in IndexedDB; the built-ins are static.
 */

function mergeRuntime(installed: InstalledPlugin[]): RuntimePlugin[] {
  const builtins = BUILTIN_PLUGINS.map(toRuntimeFromBuiltin);
  const external = installed
    .slice()
    .sort((a, b) => a.installedAt - b.installedAt)
    .map((p) => toRuntimeFromInstalled(p, iconDataUrl(p.manifest, p.files)));
  return [...builtins, ...external];
}

interface PluginsState {
  installed: InstalledPlugin[];
  /** Built-ins + installed, unified. The single list every surface renders. */
  plugins: RuntimePlugin[];
  hydrated: boolean;

  hydrate: () => Promise<void>;
  /** Insert or replace by manifest id (install / update / reload). */
  upsert: (record: InstalledPlugin) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
}

export const usePlugins = create<PluginsState>((set, get) => ({
  installed: [],
  plugins: mergeRuntime([]),
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    const installed = await dbGetAllPlugins().catch(() => [] as InstalledPlugin[]);
    set({ installed, plugins: mergeRuntime(installed), hydrated: true });
  },

  upsert: async (record) => {
    await dbPutPlugin(record);
    const installed = [...get().installed.filter((p) => p.manifest.id !== record.manifest.id), record];
    set({ installed, plugins: mergeRuntime(installed) });
  },

  remove: async (id) => {
    await dbDeletePlugin(id);
    const installed = get().installed.filter((p) => p.manifest.id !== id);
    set({ installed, plugins: mergeRuntime(installed) });
  },

  setEnabled: async (id, enabled) => {
    const cur = get().installed.find((p) => p.manifest.id === id);
    if (!cur) return;
    await get().upsert({ ...cur, enabled, updatedAt: Date.now() });
  },
}));

/** Non-hook resolver for the window layer (plugin-windows / dock). */
export function resolveRuntimePlugin(id: string): RuntimePlugin | undefined {
  return usePlugins.getState().plugins.find((p) => p.id === id);
}
