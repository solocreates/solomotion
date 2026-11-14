"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { layerSpecFromPreset, type IconStyle, type LayerAnimationSpec } from "@solomotion/core";
import { NAMES } from "@/editor/names";

/**
 * What the icons panel remembers between sessions — the DEFAULTS an icon
 * lands with and the shortcuts a person builds up. Device-local like every
 * other panel preference: none of it is a fact about a document.
 *
 * `color` may be a `var:` token, exactly as any colour slot in the document
 * may. A studio that keeps its brand ink in a variable drops every icon
 * already linked to it.
 */

export type IconStyleFilter = IconStyle | "all";

export interface IconsPrefs {
  /** Ink for `currentColor`. A literal or a `var:` token. */
  color: string;
  /** Landing size in frame px (the icon's longer side). */
  size: number;
  /** Line width for stroke icons, in the icon's own units; null = as drawn. */
  strokeWidth: number | null;
  /** Default entrance / exit applied to the placed layer. */
  animIn: LayerAnimationSpec | null;
  animOut: LayerAnimationSpec | null;
  /** Icon ids (`prefix:name`). */
  favorites: string[];
  recent: string[];
  /** Grid filter the panel opens with. */
  style: IconStyleFilter;
  /** Last place browsed — a set prefix, or one of the fixed shelves. */
  shelf: string;
}

interface IconsState extends IconsPrefs {
  set: (patch: Partial<IconsPrefs>) => void;
  toggleFavorite: (id: string) => void;
  noteUsed: (id: string) => void;
}

const RECENT_MAX = 48;

export const useIconsPrefs = create<IconsState>()(
  persist(
    (set) => ({
      color: "#F4F2ED",
      size: 128,
      strokeWidth: null,
      // A motion tool's icons arrive moving: the entrance starts on Draw On,
      // one chip away from none.
      animIn: layerSpecFromPreset("draw"),
      animOut: null,
      favorites: [],
      recent: [],
      style: "all",
      shelf: "all",
      set: (patch) => set(patch),
      toggleFavorite: (id) =>
        set((s) => ({
          favorites: s.favorites.includes(id) ? s.favorites.filter((f) => f !== id) : [id, ...s.favorites],
        })),
      noteUsed: (id) => set((s) => ({ recent: [id, ...s.recent.filter((r) => r !== id)].slice(0, RECENT_MAX) })),
    }),
    { name: NAMES.storage.iconsPrefs, version: 1 },
  ),
);
