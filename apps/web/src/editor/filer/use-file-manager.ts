"use client";

import * as React from "react";
import { createStore, useStore } from "zustand";
import type { FilerAdapter, FilerTrashEntry } from "./model/adapter";
import { resolvePaste, type FilerClipboard } from "./model/clipboard";
import {
  clickSelect,
  EMPTY_SELECTION,
  marqueeSelect,
  pruneSelection,
  selectAll as selectAllModel,
  setSelection as setSelectionModel,
  type SelectionState,
} from "../state/selection-model";
import {
  computeView,
  type FilerItem,
  type FilerTree,
  type FilerView,
  type SearchSpec,
  type SortSpec,
} from "./model/tree";

/**
 * The headless file manager — one per surface. Binds a `FilerAdapter` (data) to
 * all the ephemeral UI state (current folder, selection, clipboard, sort,
 * search, inline-rename) and exposes intent methods that mutate through the
 * adapter and reload. It's a plain zustand store so window-level handlers (drag,
 * keyboard, marquee) can read the latest state via `.getState()` without stale
 * closures — the same pattern the editor's session store uses. All selection
 * goes through the pure model; nothing item-specific lives here.
 */

export interface FilerState<T> {
  tree: FilerTree<T>;
  loading: boolean;
  currentFolderId: string | null;
  selection: SelectionState;
  clipboard: FilerClipboard | null;
  sort: SortSpec;
  search: SearchSpec;
  /** Node currently being renamed inline, if any. */
  renamingId: string | null;
  /** Recently-Deleted overlay contents (null = not open). */
  trash: FilerTrashEntry<T>[] | null;

  // navigation & toolbar
  refresh: () => Promise<void>;
  navigate: (folderId: string | null) => void;
  setSort: (sort: SortSpec) => void;
  setSearch: (query: string) => void;
  setRecursive: (recursive: boolean) => void;
  /** Show every item, folders ignored (Recents). Navigating turns it off. */
  setFlat: (flat: boolean) => void;

  // selection
  view: () => FilerView<T>;
  clickNode: (id: string, mods: { shift?: boolean; meta?: boolean }) => void;
  setSelection: (ids: string[]) => void;
  marquee: (hits: string[], additive: boolean) => void;
  selectAll: () => void;
  clearSelection: () => void;

  // activation & mutations
  activate: (id: string) => void;
  /** Create a folder in the current folder; returns its id. */
  newFolder: (name: string) => Promise<string>;
  beginRename: (id: string) => void;
  commitRename: (id: string, name: string) => Promise<void>;
  cancelRename: () => void;
  move: (ids: string[], targetParentId: string | null) => Promise<void>;
  cut: () => void;
  copy: () => void;
  paste: (targetFolderId?: string | null) => Promise<void>;
  duplicateSelection: () => Promise<void>;
  trashNodes: (ids: string[]) => Promise<void>;

  // recently deleted
  openTrash: () => Promise<void>;
  closeTrash: () => void;
  restore: (rootIds: string[]) => Promise<void>;
  purge: (rootIds: string[]) => Promise<void>;
}

export type FilerStore<T> = ReturnType<typeof createFilerStore<T>>;

export function createFilerStore<T>(adapter: FilerAdapter<T>) {
  return createStore<FilerState<T>>((set, get) => {
    const currentView = () => {
      const s = get();
      return computeView(s.tree, s.currentFolderId, s.sort, s.search);
    };
    const clearClipIfCut = () => {
      const clip = get().clipboard;
      if (clip?.mode === "cut") set({ clipboard: null });
    };

    return {
      tree: { folders: [], items: [] },
      loading: true,
      currentFolderId: null,
      selection: EMPTY_SELECTION,
      clipboard: null,
      sort: { key: "updated", dir: "desc" },
      search: { query: "", recursive: false },
      renamingId: null,
      trash: null,

      refresh: async () => {
        const tree = await adapter.load();
        set((s) => {
          const valid = new Set<string>([...tree.folders, ...tree.items].map((n) => n.id));
          return { tree, loading: false, selection: pruneSelection(s.selection, valid) };
        });
      },

      navigate: (folderId) =>
        set({
          currentFolderId: folderId,
          selection: EMPTY_SELECTION,
          search: { ...get().search, query: "", flat: false },
          renamingId: null,
        }),

      setSort: (sort) => set({ sort }),
      setSearch: (query) => set((s) => ({ search: { ...s.search, query }, selection: EMPTY_SELECTION })),
      setRecursive: (recursive) => set((s) => ({ search: { ...s.search, recursive } })),
      setFlat: (flat) =>
        set((s) => ({ search: { ...s.search, flat, query: "" }, selection: EMPTY_SELECTION, currentFolderId: flat ? null : s.currentFolderId })),

      view: currentView,

      clickNode: (id, mods) =>
        set((s) => ({ selection: clickSelect(currentView().order, s.selection, id, mods) })),
      setSelection: (ids) => set({ selection: setSelectionModel(ids) }),
      marquee: (hits, additive) => set((s) => ({ selection: marqueeSelect(s.selection, hits, additive) })),
      selectAll: () => set({ selection: selectAllModel(currentView().order) }),
      clearSelection: () => set({ selection: EMPTY_SELECTION }),

      activate: (id) => {
        const s = get();
        if (s.tree.folders.some((f) => f.id === id)) {
          get().navigate(id);
          return;
        }
        const item = s.tree.items.find((it) => it.id === id);
        if (item) adapter.open(item);
      },

      newFolder: async (name) => {
        const id = await adapter.createFolder(get().currentFolderId, name);
        await get().refresh();
        return id;
      },

      beginRename: (id) => set({ renamingId: id }),
      commitRename: async (id, name) => {
        set({ renamingId: null });
        await adapter.rename(id, name);
        await get().refresh();
      },
      cancelRename: () => set({ renamingId: null }),

      move: async (ids, targetParentId) => {
        if (ids.length === 0) return;
        await adapter.move(ids, targetParentId);
        set({ selection: EMPTY_SELECTION });
        await get().refresh();
      },

      cut: () => {
        const ids = [...get().selection.selected];
        if (ids.length) set({ clipboard: { mode: "cut", ids } });
      },
      copy: () => {
        const ids = [...get().selection.selected];
        if (ids.length) set({ clipboard: { mode: "copy", ids } });
      },
      paste: async (targetFolderId) => {
        const clip = get().clipboard;
        if (!clip) return;
        const target = targetFolderId !== undefined ? targetFolderId : get().currentFolderId;
        const op = resolvePaste(clip, target);
        if (op.type === "move") await adapter.move(op.ids, op.targetParentId);
        else if (adapter.duplicate) await adapter.duplicate(op.ids);
        else return;
        set({ clipboard: op.type === "move" ? null : get().clipboard, selection: EMPTY_SELECTION });
        await get().refresh();
      },

      duplicateSelection: async () => {
        if (!adapter.duplicate) return;
        const ids = [...get().selection.selected];
        if (!ids.length) return;
        await adapter.duplicate(ids);
        await get().refresh();
      },

      trashNodes: async (ids) => {
        if (!ids.length) return;
        await adapter.trash(ids);
        clearClipIfCut();
        set({ selection: EMPTY_SELECTION });
        await get().refresh();
      },

      openTrash: async () => {
        if (adapter.loadTrash) set({ trash: await adapter.loadTrash() });
      },
      closeTrash: () => set({ trash: null }),
      restore: async (rootIds) => {
        if (!adapter.restore || !adapter.loadTrash) return;
        await adapter.restore(rootIds);
        set({ trash: await adapter.loadTrash() });
        await get().refresh();
      },
      purge: async (rootIds) => {
        if (!adapter.purge || !adapter.loadTrash) return;
        await adapter.purge(rootIds);
        set({ trash: await adapter.loadTrash() });
      },
    };
  });
}

/** Create + load a manager for the lifetime of the mounting component. */
export function useFilerManager<T>(adapter: FilerAdapter<T>): FilerStore<T> {
  const store = React.useMemo(() => createFilerStore(adapter), [adapter]);
  React.useEffect(() => {
    void store.getState().refresh();
  }, [store]);
  return store;
}

/** Subscribe to a slice of a filer store. */
export function useFiler<T, S>(store: FilerStore<T>, selector: (s: FilerState<T>) => S): S {
  return useStore(store, selector);
}
