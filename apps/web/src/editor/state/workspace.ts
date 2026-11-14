"use client";

import * as React from "react";

import { create } from "zustand";
import {
  INHERIT_PREFS,
  createId,
  normalizeSnapshot,
  type LibrarySnapshot,
  type TextLookPrefs,
} from "@solomotion/core";

/**
 * Workspace store — ACCOUNT / APP-LEVEL data, distinct from the per-project
 * document (undoable, exported) and from ephemeral session state (tool,
 * selection, playhead). This is the stuff that follows the user across every
 * project: their saved library components, custom categories, favourites and
 * custom frame presets. Persisted to localStorage so it survives reloads today,
 * and is the natural seam for account sync later.
 *
 * Rule of thumb used across the app:
 *   • Reusable assets & preferences  → here (app level).
 *   • A document's clips/frames       → the document store (project level).
 *   • Tool / selection / record mode  → the session store (ephemeral).
 */

/** A cheap, self-contained preview for a saved library card (no canvas needed). */
export interface LibraryItemPreview {
  text: string;
  fontFamily?: string;
  fontWeight?: number;
  italic?: boolean;
  color?: string;
  /** Animation preset id for the CSS gallery loop, if the source had one. */
  animId?: string;
  highlight?: string | null;
}

/** A user-saved library component: any selection turned into a reusable asset. */
export interface CustomLibraryItem {
  id: string;
  name: string;
  /** Category name — a built-in template category or a user-created one. */
  category: string;
  createdAt: number;
  snapshot: LibrarySnapshot;
  preview: LibraryItemPreview | null;
  /**
   * Set when this arrived from the online catalogue. There is no separate
   * downloads store — a downloaded component IS a saved component, and this
   * records where it came from so the browser shows one card, not two.
   */
  originId?: string | null;
}

/** A user-defined artboard size, merged on top of the core presets. */
export interface CustomFramePreset {
  id: string;
  name: string;
  width: number;
  height: number;
}

interface WorkspaceState {
  customTemplates: CustomLibraryItem[];
  /** Extra library categories the user created (beyond the built-in set). */
  customCategories: string[];
  /** Favourited item ids — built-in template ids, animation ids, or custom ids. */
  favorites: string[];
  customFramePresets: CustomFramePreset[];
  /** User-defined workspace colors — offered by every color-dot picker (markers, tracks, …). */
  customColors: string[];
  /** Per-panel zoom level (1 = 100%), keyed by a stable panel id. Drives the
   *  headless reusable panel-zoom (see use-panel-zoom). */
  panelZoom: Record<string, number>;
  /**
   * What the text-look browser applies ON TOP of a preset — a primary colour
   * and a typing voice, both inheriting by default.
   *
   * App level, not document level, and that is the whole point: this is how
   * YOU place text, across every project, the way a brush's size follows you
   * rather than the drawing. It is also read by the preview cards, so the grid
   * you scroll is the palette you chose rather than the one the presets were
   * authored in.
   */
  textLookPrefs: TextLookPrefs;

  addCustomTemplate: (input: {
    name: string;
    category: string;
    snapshot: LibrarySnapshot;
    preview: LibraryItemPreview | null;
    originId?: string | null;
  }) => CustomLibraryItem;
  renameCustomTemplate: (id: string, name: string) => void;
  recategorizeCustomTemplate: (id: string, category: string) => void;
  deleteCustomTemplate: (id: string) => void;

  addCategory: (name: string) => void;
  deleteCategory: (name: string) => void;

  isFavorite: (id: string) => boolean;
  toggleFavorite: (id: string) => void;

  addFramePreset: (input: { name: string; width: number; height: number }) => CustomFramePreset;
  deleteFramePreset: (id: string) => void;

  addCustomColor: (color: string) => void;
  removeCustomColor: (color: string) => void;

  /** Set a panel's zoom level (persisted). 1 removes the entry to keep it tidy. */
  setPanelZoom: (panelId: string, level: number) => void;

  setTextLookPrefs: (patch: Partial<TextLookPrefs>) => void;
}

const STORAGE_KEY = "tm-workspace-v1";

interface Persisted {
  customTemplates: CustomLibraryItem[];
  customCategories: string[];
  favorites: string[];
  customFramePresets: CustomFramePreset[];
  customColors: string[];
  panelZoom: Record<string, number>;
  textLookPrefs: TextLookPrefs;
}

const EMPTY: Persisted = {
  customTemplates: [],
  customCategories: [],
  favorites: [],
  customFramePresets: [],
  customColors: [],
  panelZoom: {},
  textLookPrefs: INHERIT_PREFS,
};

function load(): Persisted {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      // Snapshots lift to the current shape on read (v1 → v2), and an entry
      // that cannot be read is skipped rather than poisoning the library.
      customTemplates: Array.isArray(parsed.customTemplates)
        ? parsed.customTemplates.flatMap((t) => {
            const snapshot = normalizeSnapshot(t.snapshot);
            return snapshot ? [{ ...t, snapshot }] : [];
          })
        : [],
      customCategories: Array.isArray(parsed.customCategories) ? parsed.customCategories : [],
      favorites: Array.isArray(parsed.favorites) ? parsed.favorites : [],
      customFramePresets: Array.isArray(parsed.customFramePresets) ? parsed.customFramePresets : [],
      customColors: Array.isArray(parsed.customColors) ? parsed.customColors : [],
      panelZoom: parsed.panelZoom && typeof parsed.panelZoom === "object" ? parsed.panelZoom : {},
      // Each arm is checked rather than trusted: this is a discriminated union
      // coming back out of localStorage, where a half-written custom colour or
      // a renamed mode from an older build would otherwise reach the resolver
      // as a shape it has no arm for.
      textLookPrefs: {
        color: readColorPref(parsed.textLookPrefs?.color),
        sound: readSoundPref(parsed.textLookPrefs?.sound),
      },
    };
  } catch {
    return EMPTY;
  }
}

function readColorPref(v: unknown): TextLookPrefs["color"] {
  if (v && typeof v === "object" && (v as { mode?: string }).mode === "custom") {
    const c = v as { ink?: unknown; accent?: unknown };
    if (typeof c.ink === "string") {
      return { mode: "custom", ink: c.ink, accent: typeof c.accent === "string" ? c.accent : null };
    }
  }
  return { mode: "inherit" };
}

function readSoundPref(v: unknown): TextLookPrefs["sound"] {
  const mode = (v as { mode?: string } | undefined)?.mode;
  if (mode === "off") return { mode: "off" };
  if (mode === "custom") {
    const s = v as Extract<TextLookPrefs["sound"], { mode: "custom" }>;
    if (s.voice && typeof s.voice.pack === "string") return s;
  }
  return { mode: "inherit" };
}

function persist(state: Persisted): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota / private mode — the workspace just won't persist this change.
  }
}

export const useWorkspace = create<WorkspaceState>((set, get) => {
  /** Persist the app-level slice after any mutation. */
  const save = (patch: Partial<Persisted>) =>
    set((s) => {
      const next = {
        customTemplates: patch.customTemplates ?? s.customTemplates,
        customCategories: patch.customCategories ?? s.customCategories,
        favorites: patch.favorites ?? s.favorites,
        customFramePresets: patch.customFramePresets ?? s.customFramePresets,
        customColors: patch.customColors ?? s.customColors,
        panelZoom: patch.panelZoom ?? s.panelZoom,
        textLookPrefs: patch.textLookPrefs ?? s.textLookPrefs,
      };
      persist(next);
      return next;
    });

  const initial = load();
  return {
    ...initial,

    addCustomTemplate: (input) => {
      const item: CustomLibraryItem = {
        id: createId("libitem"),
        name: input.name.trim() || "Untitled",
        category: input.category,
        createdAt: Date.now(),
        snapshot: input.snapshot,
        preview: input.preview,
        originId: input.originId ?? null,
      };
      save({ customTemplates: [item, ...get().customTemplates] });
      return item;
    },
    renameCustomTemplate: (id, name) =>
      save({
        customTemplates: get().customTemplates.map((t) =>
          t.id === id ? { ...t, name: name.trim() || t.name } : t,
        ),
      }),
    recategorizeCustomTemplate: (id, category) =>
      save({
        customTemplates: get().customTemplates.map((t) => (t.id === id ? { ...t, category } : t)),
      }),
    deleteCustomTemplate: (id) =>
      save({
        customTemplates: get().customTemplates.filter((t) => t.id !== id),
        favorites: get().favorites.filter((f) => f !== id),
      }),

    addCategory: (name) => {
      const trimmed = name.trim();
      if (!trimmed || get().customCategories.includes(trimmed)) return;
      save({ customCategories: [...get().customCategories, trimmed] });
    },
    deleteCategory: (name) =>
      save({ customCategories: get().customCategories.filter((c) => c !== name) }),

    isFavorite: (id) => get().favorites.includes(id),
    toggleFavorite: (id) => {
      const has = get().favorites.includes(id);
      save({
        favorites: has ? get().favorites.filter((f) => f !== id) : [...get().favorites, id],
      });
    },

    addFramePreset: (input) => {
      const preset: CustomFramePreset = {
        id: createId("fpreset"),
        name: input.name.trim() || `${input.width}×${input.height}`,
        width: Math.max(16, Math.round(input.width)),
        height: Math.max(16, Math.round(input.height)),
      };
      save({ customFramePresets: [...get().customFramePresets, preset] });
      return preset;
    },
    deleteFramePreset: (id) =>
      save({ customFramePresets: get().customFramePresets.filter((p) => p.id !== id) }),

    addCustomColor: (color) => {
      const c = color.toUpperCase();
      if (get().customColors.includes(c)) return;
      save({ customColors: [...get().customColors, c] });
    },
    removeCustomColor: (color) =>
      save({ customColors: get().customColors.filter((c) => c !== color.toUpperCase()) }),

    setPanelZoom: (panelId, level) => {
      const next = { ...get().panelZoom };
      // 1× is the default — drop the key so the store stays tidy and defaults win.
      if (Math.abs(level - 1) < 1e-3) delete next[panelId];
      else next[panelId] = level;
      save({ panelZoom: next });
    },

    setTextLookPrefs: (patch) => save({ textLookPrefs: { ...get().textLookPrefs, ...patch } }),
  };
});

/**
 * The prefs for a NON-REACT caller — the drop handlers and the apply path,
 * which run from a pointer gesture rather than from a render. Reading the store
 * here rather than threading prefs through six signatures is deliberate: this
 * is app-level state with one writer, and the alternative is every future drop
 * surface having to remember to pass it.
 */
export function textLookPrefs(): TextLookPrefs {
  return useWorkspace.getState().textLookPrefs;
}

/** Derive a card preview from a snapshot's first text clip. */
export function previewFromSnapshot(snapshot: LibrarySnapshot): LibraryItemPreview | null {
  const clip = snapshot.clips.find((c) => c.kind === "text");
  if (!clip) return null;
  const style = clip.style;
  const text = clip.text;
  return {
    text: text.slice(0, 28) || clip.name,
    // Library previews are standalone (no document to resolve against); a bound
    // family/weight falls back to a literal for the tiny card.
    fontFamily: typeof style.fontFamily === "string" ? style.fontFamily : undefined,
    fontWeight: typeof style.fontWeight === "number" ? style.fontWeight : 400,
    italic: style.italic,
    color: style.color,
    animId: clip.kind === "text" ? (clip.animations.in?.preset ?? undefined) : undefined,
    highlight: style.highlight?.color ?? null,
  };
}

/**
 * A favourites predicate that actually RE-RENDERS.
 *
 * `useWorkspace((s) => s.isFavorite)` selects a function whose reference never
 * changes, so starring something updated the store and redrew nothing — the
 * star simply did not respond. Selecting the ARRAY is the fix, and putting it
 * here rather than at each call site is what stops the next surface from
 * reintroducing it: the tempting call is the broken one.
 */
export function useIsFavorite(): (id: string) => boolean {
  const favorites = useWorkspace((s) => s.favorites);
  return React.useCallback((id: string) => favorites.includes(id), [favorites]);
}
