"use client";

import * as React from "react";
import { LIBRARY_SOURCE_LABELS, type LibraryItem, type LibraryKind, type LibrarySource } from "@solomotion/core";
import { ArrowLeftRight, Component, Film, LayoutTemplate, Music, Sparkles, Type } from "lucide-react";
import type { FilterGroup } from "../panels/BrowserControls";
import type { usePanelZoom } from "../state/use-panel-zoom";
import { TEMPLATES_OFFERED } from "./templates";
import { useLibraryResults, useLibraryUi } from "./use-library";

/**
 * THE LIBRARY KIT — what every Library layout shares: the shelves, the sorts,
 * the filter groups and the rail behaviour. `LibraryBrowser` owns the state and
 * the card wiring; a layout (`ProductIdentity.browsers`) only composes these.
 */

/**
 * A shelf whose full catalogue lives in a dedicated BROWSER.
 *
 * The Library shows what a project already HAS — every shelf here is yours,
 * and the online catalogue only joins in when you search. Seven hundred sound
 * effects are not something to scroll past on the way to your components, so
 * the shelf does not try to be the place they live; the CATEGORY says where
 * they are.
 */
export const SHELF_PLUGIN: Partial<
  Record<LibraryKind, { pluginId: string; label: string; icon: React.ComponentType<{ className?: string }> }>
> = {
  sound: { pluginId: "sfx", label: "sound effects", icon: Music },
};

/**
 * Browse order: the vocabulary first — the looks, motion and cuts you reach for
 * on almost every layer — then sounds, then the things that are already YOURS.
 */
export const SHELVES: Array<{ kind: LibraryKind; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { kind: "text", label: "Text looks", icon: Type },
  { kind: "animation", label: "Animations", icon: Sparkles },
  { kind: "transition", label: "Transitions", icon: ArrowLeftRight },
  { kind: "sound", label: "Sounds", icon: Music },
  { kind: "component", label: "Components", icon: Component },
  { kind: "media", label: "Media", icon: Film },
  ...(TEMPLATES_OFFERED ? [{ kind: "template" as const, label: "Templates", icon: LayoutTemplate }] : []),
];

export const shelfLabel = (kind: LibraryKind) => SHELVES.find((s) => s.kind === kind)?.label ?? kind;

const SOURCES: LibrarySource[] = ["user", "project", "builtin", "downloaded", "online"];

/**
 * "Most used" leads, because in a project you have been working in for an hour
 * the thing you want next is overwhelmingly something you already reached for.
 * It promotes rather than reshuffles — see `searchLibrary`.
 */
export const LIBRARY_SORTS = [
  { value: "used", label: "Most used here" },
  { value: "relevance", label: "Best match" },
  { value: "name", label: "Name" },
  { value: "newest", label: "Newest" },
] as const;

/**
 * Tags as a CHECKBOX GROUP, not `#hashtag` chips.
 *
 * The hash was decoration: these are the same words the facet rail shows
 * without one, and a `#` in a filter list reads like syntax you are supposed
 * to type somewhere. Capped, because a filter list that grows with the
 * catalogue eventually IS the catalogue — the rail under the shelf bar is
 * where a shelf's own vocabulary lives, and this is the long tail.
 */
export function useLibraryFilterGroups(): { groups: FilterGroup[]; clear: () => void } {
  const ui = useLibraryUi();
  const { facets } = useLibraryResults();
  const groups: FilterGroup[] = [
    {
      id: "source",
      label: "Source",
      options: SOURCES.map((src) => ({ value: src, label: LIBRARY_SOURCE_LABELS[src] })),
      selected: ui.sources,
      onToggle: (v) => ui.toggleSource(v as LibrarySource),
    },
    {
      id: "tags",
      label: "Tags",
      options: facets.slice(0, 14).map((f) => ({ value: f.tag, label: f.tag, count: f.count })),
      selected: ui.tags,
      onToggle: (v) => ui.toggleTag(v),
    },
  ];
  const clear = () => {
    ui.clearTags();
    for (const src of ui.sources) ui.toggleSource(src);
  };
  return { groups, clear };
}

/**
 * A rail that pans sideways: whether it overflows (re-measured when the panel
 * or the cards resize, which is exactly when the answer can differ) and a pan
 * by most of a screen. Native overflow does the work, so trackpads,
 * shift-scroll, touch and the keyboard all pan it; arrows are a convenience.
 */
export function useRail(deps: unknown) {
  const railRef = React.useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = React.useState(false);
  React.useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const measure = () => setOverflow(el.scrollWidth > el.clientWidth + 4);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [deps]);
  const pan = (dir: 1 | -1) => {
    const el = railRef.current;
    if (el) el.scrollBy({ left: dir * Math.max(160, el.clientWidth * 0.8), behavior: "smooth" });
  };
  return { railRef, overflow, pan };
}

/** What a layout is handed: the page's state, never the card wiring. */
export interface LibraryToolbarProps {
  starredOnly: boolean;
  onToggleStarred: () => void;
  loading: boolean;
  zoom: ReturnType<typeof usePanelZoom>;
}

export type CardFor = (item: LibraryItem, view?: "grid" | "list") => React.ReactNode;

export interface LibrarySectionedProps {
  items: LibraryItem[];
  cardFor: CardFor;
  onOpen: (kind: LibraryKind) => void;
}

export interface LibraryDoorProps {
  kind: LibraryKind;
  query: string;
  count: number;
}

export interface LibraryEmptyProps {
  loading: boolean;
  query: string;
  starred: boolean;
}

/** One Library composition. `tile` is how a card draws (see `LibraryCard`). */
export interface LibraryLayout {
  Toolbar: React.ComponentType<LibraryToolbarProps>;
  Sectioned: React.ComponentType<LibrarySectionedProps>;
  Door: React.ComponentType<LibraryDoorProps>;
  Empty: React.ComponentType<LibraryEmptyProps>;
  tile: "plate" | "frame";
}
