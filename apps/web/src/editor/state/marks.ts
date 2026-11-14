"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  EMPTY_MARKS,
  addToCollection,
  createCollection,
  createId,
  deleteCollection,
  removeFromCollection,
  renameCollection,
  setVerdict,
  toggleInCollection,
  toggleVerdict,
  verdictOf,
  type Collection,
  type MarkDomain,
  type MarkRef,
  type MarkVerdict,
  type MarksState,
} from "@solomotion/core";
import { NAMES } from "@/editor/names";

/**
 * The device's MARKS — stars, dislikes and collections over every catalogue.
 *
 * The store is a thin, persisted shell around core's pure operations: every
 * mutation is `state = op(state, …)`, so the rules about what a verdict means
 * and how a collection orders itself live in one testable place and this file
 * only decides WHERE they are kept.
 *
 * Kept device-wide, outside any document, because taste follows the person.
 * Opening a different project must not lose the sound you starred this morning,
 * and putting a list of catalogue ids inside a slice file would also mean
 * sending it to whoever you share the project with.
 */

interface MarksStore extends MarksState {
  verdict: (ref: MarkRef) => MarkVerdict | null;
  mark: (ref: MarkRef, verdict: MarkVerdict) => void;
  clearMark: (ref: MarkRef) => void;
  newCollection: (name: string, seed?: MarkRef) => string;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  toggleIn: (id: string, ref: MarkRef) => void;
  addTo: (id: string, ref: MarkRef) => void;
  removeFrom: (id: string, ref: MarkRef) => void;
}

/**
 * The two lists this store replaced, folded in on first run.
 *
 * `useWorkspace.favorites` starred library items; `<ns>-icons-prefs`
 * starred icons. Both were the same idea scoped to one browser. Reading them
 * here — rather than writing a migration into each old store — keeps the
 * adoption in the place that knows the new shape, and means neither legacy
 * store needs to learn about marks in order to be retired.
 *
 * Read once, never written back: the old keys are left alone so a downgrade
 * still finds its data.
 */
function adoptLegacy(): MarksState {
  if (typeof window === "undefined") return EMPTY_MARKS;
  const verdicts: Record<string, MarkVerdict> = {};
  const take = (raw: string | null, pick: (parsed: unknown) => unknown, domain: MarkDomain) => {
    if (!raw) return;
    try {
      const ids = pick(JSON.parse(raw));
      if (!Array.isArray(ids)) return;
      for (const id of ids) if (typeof id === "string") verdicts[`${domain}/${id}`] = "starred";
    } catch {
      /* a corrupt legacy blob is simply not adopted */
    }
  };
  take(
    window.localStorage.getItem("tm-workspace-v1"),
    (p) => (p as { favorites?: unknown }).favorites,
    "library",
  );
  take(
    window.localStorage.getItem(NAMES.storage.iconsPrefs),
    (p) => (p as { state?: { favorites?: unknown } }).state?.favorites,
    "icon",
  );
  return { verdicts, collections: [] };
}

export const useMarks = create<MarksStore>()(
  persist(
    (set, get) => ({
      ...adoptLegacy(),

      verdict: (ref) => verdictOf(get(), ref),
      mark: (ref, verdict) => set((s) => toggleVerdict(s, ref, verdict)),
      clearMark: (ref) => set((s) => setVerdict(s, ref, null)),

      newCollection: (name, seed) => {
        const id = createId("coll");
        set((s) => {
          const made = createCollection(s, name, id);
          return seed ? addToCollection(made, id, seed) : made;
        });
        return id;
      },
      rename: (id, name) => set((s) => renameCollection(s, id, name)),
      remove: (id) => set((s) => deleteCollection(s, id)),
      toggleIn: (id, ref) => set((s) => toggleInCollection(s, id, ref)),
      addTo: (id, ref) => set((s) => addToCollection(s, id, ref)),
      removeFrom: (id, ref) => set((s) => removeFromCollection(s, id, ref)),
    }),
    { name: NAMES.storage.marks, version: 1 },
  ),
);

/**
 * A stable snapshot of the pure state, for the core helpers that take one
 * (`applyMarks`, `collectionsFor`, `idsWithVerdict`).
 *
 * Selecting the two fields rather than the whole store is what keeps a card
 * that only reads marks from re-rendering every time an unrelated action
 * identity is recreated.
 */
export function useMarksState(): MarksState {
  const verdicts = useMarks((s) => s.verdicts);
  const collections = useMarks((s) => s.collections);
  return { verdicts, collections };
}

export function useCollections(): Collection[] {
  return useMarks((s) => s.collections);
}
