"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { FontCategory, FontSort, FontSourceId } from "@solomotion/core";
import { NAMES } from "@/editor/names";

/**
 * What the font browsers remember — device-wide, outside any document.
 *
 * One store for both sizes of the browser (the inspector's quick picker and
 * the Fonts window), so a font you used in one is Recent in the other and the
 * specimen text you typed follows you from the window back into the popover.
 * Taste follows the person, not the file; stars and collections live in
 * `state/marks` beside every other catalogue's, for the same reason.
 *
 * `lastFont` is the one per-project fact: the family a NEW text layer starts
 * in, so a project picks up where you left it rather than snapping back to the
 * built-in default. It is still not in the document — it must never touch
 * undo history or ship inside an export.
 */

/** Where a browser is pointed. A prefix, so a new shelf is one arm rather than a migration. */
export type FontShelf =
  | { kind: "all" }
  | { kind: "starred" }
  | { kind: "recent" }
  | { kind: "project" }
  | { kind: "source"; id: FontSourceId }
  | { kind: "category"; id: FontCategory }
  | { kind: "collection"; id: string };

export const fontShelfKey = (s: FontShelf): string => ("id" in s ? `${s.kind}:${s.id}` : s.kind);

export function parseFontShelf(key: string): FontShelf {
  const i = key.indexOf(":");
  if (i < 0) return key === "starred" || key === "recent" || key === "project" ? { kind: key } : { kind: "all" };
  const kind = key.slice(0, i);
  const id = key.slice(i + 1);
  if (kind === "source" && (id === "yours" || id === "system" || id === "google")) return { kind, id };
  if (kind === "category" && ["sans", "serif", "display", "hand", "mono"].includes(id)) {
    return { kind, id: id as FontCategory };
  }
  if (kind === "collection" && id) return { kind, id };
  return { kind: "all" };
}

const RECENT_MAX = 24;
export const SPECIMEN_SIZE = { min: 16, max: 160, initial: 48 } as const;

interface FontPrefs {
  lastFont: Record<string, string>;
  /** Families, most recent first. */
  recent: string[];
  /** The line every card sets. Empty = each family's own default. */
  sample: string;
  size: number;
  /** The weight every card is set in; null = each family's Regular, with its ramp. */
  weight: number | null;
  shelf: string;
  sort: FontSort;
  noteUsed: (family: string) => void;
  set: (patch: Partial<Pick<FontPrefs, "sample" | "size" | "weight" | "shelf" | "sort">>) => void;
}

/** The pre-store key: a plain `{projectId: family}` map. Read once, left in place. */
function adoptLastFont(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(NAMES.storage.legacyLastFont);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export const useFontPrefs = create<FontPrefs>()(
  persist(
    (set, get) => ({
      lastFont: adoptLastFont(),
      recent: [],
      sample: "",
      size: SPECIMEN_SIZE.initial,
      weight: null,
      shelf: "all",
      sort: "popular",
      noteUsed: (family) =>
        set({ recent: [family, ...get().recent.filter((f) => f !== family)].slice(0, RECENT_MAX) }),
      set: (patch) => set(patch),
    }),
    { name: NAMES.storage.fontPrefs, version: 1 },
  ),
);

/** The last font chosen in this project, or null if none yet / no project. */
export function getLastFont(projectId: string | null | undefined): string | null {
  if (!projectId) return null;
  return useFontPrefs.getState().lastFont[projectId] ?? null;
}

/**
 * A family was CHOSEN — from any browser, for any layer. Remembered as recent
 * everywhere and as this project's next default.
 */
export function noteFontChosen(projectId: string | null | undefined, family: string): void {
  const s = useFontPrefs.getState();
  s.noteUsed(family);
  if (projectId) useFontPrefs.setState({ lastFont: { ...s.lastFont, [projectId]: family } });
}
