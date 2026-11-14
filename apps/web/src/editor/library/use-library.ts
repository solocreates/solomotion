"use client";

import * as React from "react";
import { create } from "zustand";
import {
  libraryFocus,
  libraryUsage,
  localLibrary,
  mergeLibrary,
  searchLibrary,
  tagFacets,
  type IndexPack,
  type LibraryItem,
  type LibraryKind,
  type LibraryQuery,
  type LibrarySort,
  type LibraryFocus,
  type LibrarySource,
} from "@solomotion/core";
import { useDocSelector, useDocWhen } from "../state/document-context";
import { useSession } from "../state/session";
import { useWorkspace } from "../state/workspace";
import { useAppSounds } from "../audio/app-sounds";
import { hasOnlineLibrary, libraryClient } from "./client";
import { builtinTemplates, TEMPLATES_OFFERED } from "./templates";
import { NAMES } from "@/editor/names";

/**
 * The browser's state and its data, kept apart on purpose.
 *
 * `useLibraryUi` is what the user is looking at — the query, the shelf, the
 * chips, grid-or-list. It is a store rather than component state because the
 * SAME browser renders docked in the sidebar and floating in a window, and a
 * filter you set in one and lost in the other would be a bug you could feel.
 *
 * `useLibraryItems` is the answer to that query. Local items are derived
 * synchronously from the document, the workspace and this device's sounds;
 * online items are fetched, debounced, and folded in with `mergeLibrary` so a
 * downloaded item appears once. Both halves go through ONE ranking pass, which
 * is why local and online results interleave by relevance instead of sitting in
 * two lists that make you look twice.
 */

export type LibraryView = "grid" | "list";

interface LibraryUiState {
  /** Null = the root, where the shelves are offered as sections. */
  kind: LibraryKind | null;
  text: string;
  tags: string[];
  sources: LibrarySource[];
  sort: LibrarySort;
  view: LibraryView;
  /** Set while browsing INTO one online pack. */
  packId: string | null;

  setKind: (kind: LibraryKind | null) => void;
  setText: (text: string) => void;
  toggleTag: (tag: string) => void;
  clearTags: () => void;
  toggleSource: (source: LibrarySource) => void;
  setSort: (sort: LibrarySort) => void;
  setView: (view: LibraryView) => void;
  openPack: (packId: string | null) => void;
  reset: () => void;
}

const VIEW_KEY = NAMES.storage.libraryView;

/**
 * LIST is the default, and grid is the opt-in — the opposite of what shipped.
 *
 * The library's root shelf is a browse surface: eight categories, fifty-odd
 * items, each a name plus one line about what it does. In grid that is a wall
 * of ~200px cards, most of them a coloured rectangle or a two-word preview that
 * says nothing a name wouldn't, and you scroll past four items per screen in a
 * 280px sidebar. In list you see fifteen, with the name and the blurb doing the
 * work. Grid earns its space when the THUMBNAIL is the content (transitions,
 * text looks you recognise on sight) — so it stays one click away, and the
 * choice is remembered.
 */
function storedView(): LibraryView {
  if (typeof window === "undefined") return "list";
  return window.localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "list";
}

export const useLibraryUi = create<LibraryUiState>((set, get) => ({
  kind: null,
  text: "",
  tags: [],
  sources: [],
  sort: "relevance",
  view: storedView(),
  packId: null,

  setKind: (kind) => set({ kind, packId: null, tags: [] }),
  setText: (text) => set({ text }),
  toggleTag: (tag) =>
    set((s) => ({
      tags: s.tags.includes(tag) ? s.tags.filter((t) => t !== tag) : [...s.tags, tag],
    })),
  clearTags: () => set({ tags: [] }),
  toggleSource: (source) =>
    set((s) => ({
      sources: s.sources.includes(source)
        ? s.sources.filter((x) => x !== source)
        : [...s.sources, source],
    })),
  setSort: (sort) => set({ sort }),
  setView: (view) => {
    if (typeof window !== "undefined") window.localStorage.setItem(VIEW_KEY, view);
    set({ view });
  },
  openPack: (packId) => set({ packId, kind: packId ? get().kind : get().kind }),
  reset: () => set({ kind: null, text: "", tags: [], sources: [], packId: null }),
}));

/**
 * How often this project uses each item — recomputed only while the sort that
 * needs it is on.
 *
 * Counting is one pass over the clips, which is cheap, but doing it on every
 * document change for a ranking nobody asked for is still work for nothing.
 */
function useLibraryUsage(enabled: boolean): ReadonlyMap<string, number> | undefined {
  const doc = useDocWhen((d) => (enabled ? [d.tracks] : []));
  return React.useMemo(() => (enabled ? libraryUsage(doc) : undefined), [doc, enabled]);
}

/** The live query, assembled from the UI state. */
export function useLibraryQuery(): LibraryQuery {
  const { kind, text, tags, sources, sort, packId } = useLibraryUi();
  const usage = useLibraryUsage(sort === "used");
  return React.useMemo(
    () => ({
      text,
      tags,
      sources,
      sort,
      usage,
      packId: packId ?? undefined,
      kinds: kind ? [kind] : undefined,
    }),
    [kind, text, tags, sources, sort, usage, packId],
  );
}

/** Everything on this machine, as library items. Pure, synchronous, offline. */
export function useLocalLibrary(): LibraryItem[] {
  // The project's own items are its components (frames) and its media (assets).
  const doc = useDocWhen((d) => [d.frames, d.assets]);
  const saved = useWorkspace((s) => s.customTemplates);
  const deviceSounds = useAppSounds();
  return React.useMemo(
    () => localLibrary({ doc, userItems: saved, deviceSounds, templates: builtinTemplates }),
    [doc, saved, deviceSounds],
  );
}

interface OnlineState {
  items: LibraryItem[];
  packs: IndexPack[];
  loading: boolean;
  error: string | null;
}

const IDLE: OnlineState = { items: [], packs: [], loading: false, error: null };

/**
 * Is this query actually LOOKING for something?
 *
 * The distinction is the whole of the fix below. An empty query matches every
 * pack in the catalogue, so `search` on open downloaded every manifest there
 * is — fine at sixteen sounds, and at seven hundred it is most of a megabyte
 * fetched to draw a number beside the word "Sounds".
 */
function isSearching(query: LibraryQuery): boolean {
  return Boolean(query.text?.trim() || query.tags?.length || query.packId);
}

/**
 * The online half. Debounced, cancel-safe, and silent when there is no
 * catalogue configured — the local library is never blocked on the network.
 *
 * The catalogue is SEARCHED, never listed. That is the rule `useOnlineSounds`
 * already stated — "an online sound is not a kind of catalogue entry, it is a
 * search result" — and this is where it was not being followed. With nothing
 * typed, the browser shows what you OWN, which is what a library you have not
 * asked a question of should show; the moment you type, the whole catalogue
 * joins in, ranked by the same matcher.
 *
 * The root index is still fetched either way: it is 10 KB, it is what the pack
 * chips are drawn from, and it is the one request that does not grow with the
 * catalogue.
 */
export function useOnlineLibrary(query: LibraryQuery): OnlineState {
  const [state, setState] = React.useState<OnlineState>(IDLE);
  // A Map does not survive `JSON.stringify`, and `usage` is a LOCAL ranking
  // signal the server neither receives nor cares about — leaving it in the key
  // would make every re-count look like a new query and re-fetch the catalogue.
  const { usage: _usage, ...remote } = query;
  const key = JSON.stringify(remote);

  React.useEffect(() => {
    const client = libraryClient();
    if (!client) return;
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    const searching = isSearching(query);
    const timer = window.setTimeout(() => {
      void Promise.all([searching ? client.search(query) : Promise.resolve([]), client.index()])
        .then(([items, index]) => {
          if (alive) setState({ items, packs: index.packs, loading: false, error: null });
        })
        .catch((err: unknown) => {
          if (alive)
            setState({
              items: [],
              packs: [],
              loading: false,
              error: err instanceof Error ? err.message : "Library unreachable",
            });
        });
    }, 180);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return hasOnlineLibrary ? state : IDLE;
}

export interface LibraryResults {
  items: LibraryItem[];
  /** Tag chips for what is currently in scope. */
  facets: Array<{ tag: string; count: number }>;
  packs: IndexPack[];
  loadingOnline: boolean;
  onlineError: string | null;
  /** Counts per shelf, for the root sections. Ignores the kind filter. */
  countsByKind: Record<LibraryKind, number>;
  /**
   * How many items `facets` was counted against — the same set, before any tag
   * filter. Carried rather than re-derived because it is what tells a facet
   * apart from a label: a tag on EVERY item in the pool narrows nothing, and a
   * chip that cannot change the result is a chip that should not be drawn.
   */
  facetTotal: number;
}

export function useLibraryResults(): LibraryResults {
  const query = useLibraryQuery();
  const local = useLocalLibrary();
  const online = useOnlineLibrary(query);

  return React.useMemo(() => {
    const all = mergeLibrary(local, online.items);
    const merged = TEMPLATES_OFFERED ? all : all.filter((i) => i.kind !== "template");
    const items = searchLibrary(merged, query);
    const counts = { sound: 0, text: 0, animation: 0, transition: 0, component: 0, media: 0, template: 0 };
    // Shelf counts ignore the shelf filter — otherwise every section but the
    // open one reads zero, which is the least useful number on the screen.
    for (const item of searchLibrary(merged, { ...query, kinds: undefined })) counts[item.kind]++;
    const facetPool = searchLibrary(merged, { ...query, tags: [] });
    return {
      items,
      facets: tagFacets(facetPool),
      facetTotal: facetPool.length,
      packs: online.packs,
      loadingOnline: online.loading,
      onlineError: online.error,
      countsByKind: counts,
    };
  }, [local, online, query]);
}

/**
 * What the library is currently aimed at — the selection, live.
 *
 * Derived on every render from the document and the session, never stored. A
 * "currently active preset" field would be a second copy of what the clips
 * already say, and the two would part company the first time a clip changed by
 * any other route (a drop, an undo, the inspector, a plugin).
 */
export function useLibraryFocus(): LibraryFocus {
  const selectedClipIds = useSession((s) => s.selectedClipIds);
  const selectedEdgeDecor = useSession((s) => s.selectedEdgeDecor);
  // Subscribed to the ANSWER, not to the selected clips: posing a selected
  // character rewrites its clip on every move and changes nothing the library
  // marks, so the cards must not hear about it.
  return useDocSelector((d) => libraryFocus(d, { selectedClipIds, selectedEdgeDecor }), sameFocus);
}

const focusSignature = (f: LibraryFocus) =>
  JSON.stringify([f.clipIds, f.pinned, f.slot, f.decors.map((x) => [x.ref, x.side, x.presetId, x.durationMs]), [...f.activeIds].sort()]);
const sameFocus = (a: LibraryFocus, b: LibraryFocus) => a === b || focusSignature(a) === focusSignature(b);
