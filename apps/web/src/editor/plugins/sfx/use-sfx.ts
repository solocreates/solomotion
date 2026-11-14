"use client";

import * as React from "react";
import {
  SOUND_CATEGORIES,
  applyMarks,
  collectionIds,
  idsWithVerdict,
  searchLibrary,
  type IndexPack,
  type LibraryItem,
  type MarkRef,
  type MarksState,
} from "@solomotion/core";
import { libraryClient } from "../../library/client";
import { useMarksState } from "../../state/marks";
import { parseShelf, useSfxPrefs, type SfxShelf } from "./sfx-store";

/**
 * THE SOUND CATALOGUE, as the browser sees it.
 *
 * There is no second catalogue here and there must not be one: these hooks are
 * a VIEW over the same `LibraryClient`, the same `searchLibrary` matcher and
 * the same manifests the Library browser reads. What is different is the
 * question being asked — sound is browsed in series, one row at a time, where
 * visual content is scanned in parallel as a grid — and that is a presentation
 * difference, not a data one.
 *
 * Everything is LAZY, and laziness is the whole scalability story:
 *
 *   a pack shelf     one manifest
 *   a category       only packs whose index row lists that tag
 *   a search         only packs whose index `terms` could match
 *   the landing      no manifests at all — it lists PACKS
 *
 * So the cost of browsing does not grow with the catalogue. Ten thousand
 * sounds across two hundred packs still opens in one small index fetch, and a
 * search for "whoosh" still downloads only the packs that have one.
 */

/** Every sound item resolves to this mark reference. One domain, one rule. */
export const soundMark = (id: string): MarkRef => ({ domain: "library", id });

/* -------------------------------------------------------------------------- */
/* Packs                                                                       */
/* -------------------------------------------------------------------------- */

export interface SfxPacks {
  packs: IndexPack[];
  loading: boolean;
  error: boolean;
  retry: () => void;
}

let refreshTick = 0;
const refreshListeners = new Set<(n: number) => void>();

/**
 * Drop every cached manifest and re-fetch.
 *
 * The client keeps the root index for five minutes, which is right for a
 * catalogue that changes when we publish — but it means a session open across
 * a publish shows yesterday's shelves with no way out but a reload. One
 * affordance, shared by every hook here through a tick, so a refresh in the
 * header re-runs the pack list and the open shelf together rather than leaving
 * the two disagreeing.
 */
export function refreshSoundCatalogue(): void {
  libraryClient()?.invalidate();
  refreshTick++;
  for (const fn of refreshListeners) fn(refreshTick);
}

function useRefreshTick(): number {
  const [tick, setTick] = React.useState(refreshTick);
  React.useEffect(() => {
    refreshListeners.add(setTick);
    return () => void refreshListeners.delete(setTick);
  }, []);
  return tick;
}

/** The root index, sound packs only. One fetch per session, or per refresh. */
export function useSoundPacks(): SfxPacks {
  const [state, setState] = React.useState<{ packs: IndexPack[]; loading: boolean; error: boolean }>({
    packs: [],
    loading: true,
    error: false,
  });
  const tick = useRefreshTick();

  React.useEffect(() => {
    const client = libraryClient();
    if (!client) {
      setState({ packs: [], loading: false, error: true });
      return;
    }
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: false }));
    void client
      .index()
      .then((index) => {
        if (!alive) return;
        setState({
          packs: index.packs.filter((p) => p.kind === "sound"),
          loading: false,
          error: false,
        });
      })
      .catch(() => alive && setState({ packs: [], loading: false, error: true }));
    return () => {
      alive = false;
    };
  }, [tick]);

  return { ...state, retry: refreshSoundCatalogue };
}

/** Categories actually present in the catalogue, with counts. Derived from the
 *  index alone — no manifest is downloaded to draw the rail. */
export function useSoundCategories(packs: IndexPack[]): Array<{ id: string; sounds: number }> {
  return React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const pack of packs) {
      for (const [tag, n] of Object.entries(pack.tagCounts)) {
        if ((SOUND_CATEGORIES as readonly string[]).includes(tag)) {
          counts.set(tag, (counts.get(tag) ?? 0) + n);
        }
      }
    }
    // SOUNDS, not packs: "Impacts 412" is a shelf you can judge the size of,
    // where "Impacts 180" counting packs told you about the catalogue's
    // packaging rather than about impacts.
    return SOUND_CATEGORIES.filter((c) => counts.has(c)).map((id) => ({ id, sounds: counts.get(id)! }));
  }, [packs]);
}

/**
 * Packs, deepest first.
 *
 * The index arrives in pack-id order, which is alphabetical by whatever the
 * upstream slug happened to be — a fine ordering for a catalogue of twelve and
 * a meaningless one for a catalogue of three hundred, where the first screen
 * decides whether the archive looks worth browsing. Size is the only ranking
 * signal in the index that says anything at all about a pack you have never
 * opened, and it correlates with the packs people actually want: a 400-sound
 * collection is somebody's life's work, a 3-sound one is an offcut.
 */
export function packsBySize(packs: IndexPack[]): IndexPack[] {
  return [...packs].sort((a, b) => b.itemCount - a.itemCount || a.title.localeCompare(b.title));
}

/** How many packs the rail will name before it defers to the All packs shelf. */
const RAIL_PACKS = 10;

/**
 * The rail's pack shortlist.
 *
 * A rail that lists every pack is a navigation surface at twelve packs and a
 * wall at three hundred — the categories above it stop being reachable without
 * a scroll, which inverts the whole point of the rail. So the rail names the
 * few worth naming and hands the rest to the shelf that already exists for
 * exactly this: "All packs". Nothing becomes unreachable, and the shelves that
 * scale — categories, search, collections — stay on the first screen.
 */
export function useTopPacks(packs: IndexPack[]): IndexPack[] {
  return React.useMemo(() => packsBySize(packs).slice(0, RAIL_PACKS), [packs]);
}

/* -------------------------------------------------------------------------- */
/* Items                                                                       */
/* -------------------------------------------------------------------------- */

/** How many packs one category shelf will pull manifests for. */
const CATEGORY_PACKS = 24;

/**
 * Which packs a shelf needs, decided from the INDEX.
 *
 * This is the function that keeps the panel cheap, so it is worth being
 * explicit about: an id-addressed shelf (starred, a collection) names its packs
 * inside the ids it holds — `online:sound:<packId>/<entryId>` — so even
 * "everything I ever starred" fetches exactly the packs those stars are in.
 */
function packsForShelf(shelf: SfxShelf, packs: IndexPack[], ids: readonly string[]): IndexPack[] {
  switch (shelf.kind) {
    case "pack":
      return packs.filter((p) => p.id === shelf.id);
    case "category":
      // The packs a category is most MADE OF, not every pack containing one of
      // them. A shelf is a place to browse, and a browsable shelf is already
      // more rows than anyone scrolls; what the tail would add is a thousand
      // manifest fetches to reach the single stray click in somebody's zombie
      // pack. Nothing becomes unreachable — search spans the whole catalogue,
      // which is what a person looking for that one sound would use.
      return packs
        .map((p) => ({ pack: p, weight: p.tagCounts[shelf.id] ?? 0 }))
        .filter((x) => x.weight > 0)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, CATEGORY_PACKS)
        .map((x) => x.pack);
    case "starred":
    case "disliked":
    case "recent":
    case "collection": {
      const wanted = new Set<string>();
      for (const id of ids) {
        const packId = id.split(":").pop()?.split("/")[0];
        if (packId) wanted.add(packId);
      }
      return packs.filter((p) => wanted.has(p.id));
    }
    default:
      return [];
  }
}

/** The ids a mark-addressed shelf is made of, in the order it should show them. */
function shelfIds(shelf: SfxShelf, marks: MarksState, recent: readonly string[]): string[] {
  switch (shelf.kind) {
    case "starred":
      return idsWithVerdict(marks, "starred", "library");
    case "disliked":
      return idsWithVerdict(marks, "disliked", "library");
    case "collection":
      return collectionIds(marks, shelf.id, "library");
    case "recent":
      return [...recent];
    default:
      return [];
  }
}

export interface SfxResults {
  items: LibraryItem[];
  loading: boolean;
}

/**
 * The rows for the current shelf and search.
 *
 * Marks are applied LAST, over whatever the shelf and the matcher produced:
 * disliked sounds disappear and starred ones float, except on the shelves that
 * exist precisely to show them — a Disliked shelf that hid its own contents
 * would be a dead end with no way to undo a mistake.
 */
export function useSoundItems(query: string): SfxResults {
  const shelfRaw = useSfxPrefs((s) => s.shelf);
  const sort = useSfxPrefs((s) => s.sort);
  const recent = useSfxPrefs((s) => s.recent);
  const marks = useMarksState();
  const { packs } = useSoundPacks();
  const tick = useRefreshTick();
  const shelf = React.useMemo(() => parseShelf(shelfRaw), [shelfRaw]);

  const [fetched, setFetched] = React.useState<LibraryItem[]>([]);
  const [loading, setLoading] = React.useState(false);
  const text = query.trim();

  const ids = React.useMemo(() => shelfIds(shelf, marks, recent), [shelf, marks, recent]);
  const needed = React.useMemo(
    () => packsForShelf(shelf, packs, ids).map((p) => p.id),
    [shelf, packs, ids],
  );
  // Content-compared: `needed` is a fresh array every render, and re-fetching
  // on identity would make every keystroke a network request.
  const neededKey = needed.join(" ");

  React.useEffect(() => {
    const client = libraryClient();
    if (!client) return;
    let alive = true;

    // A search spans the WHOLE catalogue, whatever shelf you are on — the
    // matcher's own index-level filter keeps that cheap, and a search box that
    // silently only looked in one pack is the thing everybody complains about.
    if (text.length >= 2) {
      setLoading(true);
      const timer = window.setTimeout(() => {
        void client
          .search({ text, kinds: ["sound"], sort })
          .then((items) => alive && (setFetched(items), setLoading(false)))
          .catch(() => alive && (setFetched([]), setLoading(false)));
      }, 200);
      return () => {
        alive = false;
        window.clearTimeout(timer);
      };
    }

    const wanted = neededKey ? neededKey.split(" ") : [];
    if (!wanted.length) {
      setFetched([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    void Promise.all(wanted.map((id) => client.items(id).catch(() => [] as LibraryItem[])))
      .then((lists) => alive && (setFetched(lists.flat()), setLoading(false)))
      .catch(() => alive && (setFetched([]), setLoading(false)));
    return () => {
      alive = false;
    };
  }, [text, neededKey, sort, tick]);

  const items = React.useMemo(() => {
    let list = fetched;

    // An id-addressed shelf keeps ITS order (most recently starred first), not
    // the manifest's — that order is the whole content of the shelf.
    if (ids.length && !text) {
      const byId = new Map(list.map((i) => [i.id, i]));
      list = ids.map((id) => byId.get(id)).filter((i): i is LibraryItem => Boolean(i));
    } else if (text || shelf.kind === "category") {
      list = searchLibrary(list, {
        text,
        kinds: ["sound"],
        tags: shelf.kind === "category" ? [shelf.id] : undefined,
        sort,
      });
    }

    // On the shelves whose subject IS a verdict, taste must not filter.
    const literal = shelf.kind === "starred" || shelf.kind === "disliked";
    return literal ? list : applyMarks(list, marks, (i) => soundMark(i.id));
  }, [fetched, ids, text, shelf, sort, marks]);

  return { items, loading };
}
