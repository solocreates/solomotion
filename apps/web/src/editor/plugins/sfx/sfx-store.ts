"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  DEFAULT_PRELOAD,
  DEFAULT_SOUND_DROP,
  type AuditionLoop,
  type LibrarySort,
  type PreloadPolicy,
  type SoundDropDefaults,
} from "@solomotion/core";
import { NAMES } from "@/editor/names";

/**
 * What the sound browser remembers between sessions.
 *
 * Device-local, like every other panel preference: how far the preloader may
 * lean forward and what a dropped sound lands with are facts about YOU, not
 * about any document. The same call the icons panel makes about ink and size.
 *
 * MONITORING LEVEL AND THE EAR GUARD ARE NOT HERE. They moved to
 * `library/audition-prefs`, one layer below every browser, because they were
 * never facts about this panel — they are facts about the person listening,
 * and while they lived here the Library browser and the inspector's sound
 * picker played the same catalogue with no guard at all.
 *
 * Marks — stars, dislikes, collections — are deliberately NOT here. They live
 * in `state/marks` and span every catalogue, because a star on a sound and a
 * star on an icon are the same gesture and were two implementations before.
 */

/** Where the browser is pointed. Parsed rather than modelled as a union of
 *  fields, so a new shelf kind is a prefix and not a schema migration. */
export type SfxShelf =
  | { kind: "packs" }
  | { kind: "starred" }
  | { kind: "disliked" }
  | { kind: "recent" }
  | { kind: "category"; id: string }
  | { kind: "pack"; id: string }
  | { kind: "collection"; id: string };

export const shelfKey = (s: SfxShelf): string =>
  "id" in s ? `${s.kind}:${s.id}` : s.kind;

export function parseShelf(key: string): SfxShelf {
  const i = key.indexOf(":");
  if (i < 0) {
    return key === "starred" || key === "disliked" || key === "recent"
      ? { kind: key }
      : { kind: "packs" };
  }
  const kind = key.slice(0, i);
  const id = key.slice(i + 1);
  if (kind === "category" || kind === "pack" || kind === "collection") return { kind, id };
  return { kind: "packs" };
}

/** The defaults the Reset control returns to — one object, one source of truth. */
export const SFX_DEFAULTS = {
  loop: "off" as AuditionLoop,
  preload: DEFAULT_PRELOAD,
  drop: DEFAULT_SOUND_DROP,
  shelf: "packs",
  sort: "relevance" as LibrarySort,
  /**
   * Play a row the moment it is selected with the keyboard.
   *
   * On by default because that is what browsing a sound library IS — arrowing
   * down a list and hearing each one. Off exists for the case where you are
   * reading names looking for one you remember.
   */
  autoPlay: true,
  recent: [] as string[],
};

export interface SfxPrefs {
  loop: AuditionLoop;
  preload: PreloadPolicy;
  drop: SoundDropDefaults;
  shelf: string;
  sort: LibrarySort;
  autoPlay: boolean;
  /** Item ids, most recent first — the Recent shelf. */
  recent: string[];
}

interface SfxState extends SfxPrefs {
  set: (patch: Partial<SfxPrefs>) => void;
  setDrop: (patch: Partial<SoundDropDefaults>) => void;
  setPreload: (patch: Partial<PreloadPolicy>) => void;
  noteUsed: (id: string) => void;
  /** Back to the defaults above. Never touches marks — taste is not a filter. */
  reset: () => void;
}

const RECENT_MAX = 60;

export const useSfxPrefs = create<SfxState>()(
  persist(
    (set) => ({
      ...SFX_DEFAULTS,
      set: (patch) => set(patch),
      setDrop: (patch) => set((s) => ({ drop: { ...s.drop, ...patch } })),
      setPreload: (patch) => set((s) => ({ preload: { ...s.preload, ...patch } })),
      noteUsed: (id) =>
        set((s) => ({ recent: [id, ...s.recent.filter((r) => r !== id)].slice(0, RECENT_MAX) })),
      // Recent survives a reset: it is a record of what you did, not a filter
      // you set, and wiping it would be destroying data to clear a search box.
      reset: () => set((s) => ({ ...SFX_DEFAULTS, recent: s.recent })),
    }),
    { name: NAMES.storage.legacySfxPrefs, version: 1 },
  ),
);
