"use client";

import { create } from "zustand";
import {
  makePreset,
  removePreset as removeFrom,
  renamePreset as renameIn,
  upsertPreset,
  type StoredPreset,
  legacyStrokePatch,
} from "@solomotion/core";
import { NAMES } from "@/editor/names";

/**
 * The APP scope of the preset library — presets that follow the user across
 * every project on this device. (The other two scopes: `builtin` lives in core,
 * `project` lives in `doc.presets` and travels with the file.)
 *
 * Storage is plain localStorage behind a zustand store so React re-renders the
 * moment a preset is saved from anywhere — a right-click on a card, the
 * picker's "+", a future library panel. Nothing here knows what a preset
 * CONTAINS; that is the kind's business.
 */

const KEY = NAMES.storage.presets;
/** The pre-library "saved effects" list, folded in once on first read. */
const LEGACY_KEY = NAMES.storage.legacySavedEffects;

interface PresetStore {
  entries: StoredPreset[];
  save: (kind: string, name: string, data: unknown, meta?: Parameters<typeof makePreset>[3]) => StoredPreset;
  remove: (id: string) => void;
  rename: (id: string, name: string) => void;
  /** Replace the whole list — the import path's one write. */
  replaceAll: (entries: StoredPreset[]) => void;
}

function read(): StoredPreset[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    // Device presets ride the same field rename the document did (v85).
    if (raw) {
      return (JSON.parse(raw) as StoredPreset[]).map((p) =>
        p.kind === "effect:stroke" && p.data && typeof p.data === "object"
          ? { ...p, data: legacyStrokePatch(p.data as Record<string, unknown>) }
          : p,
      );
    }
  } catch {
    return [];
  }
  // One-time migration: the old bespoke "saved effects" become presets of the
  // effect's own kind, so nobody loses a look they saved before the library.
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (!legacy) return [];
    const list = JSON.parse(legacy) as Array<{ label: string; effect: Record<string, unknown> }>;
    const migrated = list
      .filter((e) => e?.effect && typeof e.effect.type === "string")
      .map((e) => {
        const { id: _id, type, enabled: _enabled, ...data } = e.effect;
        return makePreset(`effect:${String(type)}`, e.label, data, { group: "Saved" });
      });
    write(migrated);
    return migrated;
  } catch {
    return [];
  }
}

function write(entries: StoredPreset[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // A non-persistent session is fine — the presets just live for this tab.
  }
}

export const useAppPresets = create<PresetStore>((set, get) => ({
  entries: read(),
  save: (kind, name, data, meta) => {
    const entry = makePreset(kind, name, data, meta);
    const entries = upsertPreset(get().entries, entry);
    write(entries);
    set({ entries });
    return entry;
  },
  remove: (id) => {
    const entries = removeFrom(get().entries, id);
    write(entries);
    set({ entries });
  },
  rename: (id, name) => {
    const entries = renameIn(get().entries, id, name);
    write(entries);
    set({ entries });
  },
  replaceAll: (entries) => {
    write(entries);
    set({ entries });
  },
}));
