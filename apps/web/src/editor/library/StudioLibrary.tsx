"use client";

import * as React from "react";
import type { LibraryItem, LibraryKind, LibrarySort } from "@solomotion/core";
import { ArrowRight, ArrowUpRight, ChevronLeft, ChevronRight, Loader2, Star, Upload } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { usePluginWindows } from "../plugins/plugin-windows";
import { BrowserFilters, BrowserSearch } from "../panels/BrowserControls";
import {
  LIBRARY_SORTS,
  SHELF_PLUGIN,
  SHELVES,
  shelfLabel,
  useLibraryFilterGroups,
  useRail,
  type LibraryDoorProps,
  type LibraryEmptyProps,
  type LibrarySectionedProps,
  type LibraryToolbarProps,
} from "./library-kit";
import { openPublisher } from "./PublishDialog";
import { TextLookPrefsBar } from "./TextLookPrefs";
import { useLibraryResults, useLibraryUi } from "./use-library";

/**
 * THE STUDIO LIBRARY — the `studio` composition (`ProductIdentity.browsers`).
 *
 * Type does the navigating. The shelves are an INDEX — words with mono counts
 * and the accent underline, the grammar Studio Home's places use — not a strip
 * of glyphs on plates. The chosen shelf is also a token in the search field,
 * so the field always says what it searches, and ⌫ on an empty field leaves
 * the shelf. Section heads are the site's eyebrow. Cards are frames on the
 * dot field (`LibraryCard tile="frame"`). Every behaviour is the kit's.
 */

const ICON_ACTION =
  "flex size-(--control-h) shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-hover hover:text-fg [&_svg]:size-3.5";

export function StudioToolbar({ starredOnly, onToggleStarred, loading, zoom }: LibraryToolbarProps) {
  const ui = useLibraryUi();
  const { groups, clear } = useLibraryFilterGroups();

  return (
    <div className="shrink-0 border-b border-line">
      <div className="flex items-center gap-0.5 px-2 pb-1 pt-2">
        <BrowserSearch
          value={ui.text}
          onChange={ui.setText}
          loading={loading}
          scope={ui.kind ? shelfLabel(ui.kind) : undefined}
          onLeaveScope={() => ui.setKind(null)}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Starred only"
              aria-pressed={starredOnly}
              onClick={onToggleStarred}
              className={cn(ICON_ACTION, starredOnly && "text-warning hover:text-warning")}
            >
              <Star className={cn(starredOnly && "fill-current")} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Starred</TooltipContent>
        </Tooltip>
        <BrowserFilters
          view={ui.view}
          onView={ui.setView}
          zoom={zoom}
          sort={ui.sort}
          sorts={LIBRARY_SORTS}
          onSort={(v) => ui.setSort(v as LibrarySort)}
          groups={groups}
          onClear={clear}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" aria-label="Publish to the library" onClick={() => openPublisher()} className={ICON_ACTION}>
              <Upload />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Publish</TooltipContent>
        </Tooltip>
      </div>

      <ShelfIndex />
      <FacetWords />
      {ui.kind === "text" && <TextLookPrefsBar />}
    </div>
  );
}

/**
 * The shelves as words. A shelf reading zero dims rather than vanishes: an
 * index that changes length as you type is one you cannot aim at. The strip
 * scrolls sideways with soft edges, so a seventh shelf costs nothing.
 */
function ShelfIndex() {
  const ui = useLibraryUi();
  const { countsByKind, items } = useLibraryResults();
  const total = ui.kind === null ? items.length : Object.values(countsByKind).reduce((a, b) => a + b, 0);
  const navRef = React.useRef<HTMLElement>(null);
  const activeRef = React.useRef<HTMLButtonElement>(null);
  // Keep the chosen shelf in view inside the strip (never `scrollIntoView`,
  // which would scroll the panel and the window along with it).
  React.useEffect(() => {
    const nav = navRef.current;
    const el = activeRef.current;
    if (!nav || !el) return;
    const left = el.offsetLeft - 8;
    const right = el.offsetLeft + el.offsetWidth + 16;
    if (left < nav.scrollLeft) nav.scrollLeft = left;
    else if (right > nav.scrollLeft + nav.clientWidth) {
      // Start the strip on a whole word, never half a neighbour.
      const need = right - nav.clientWidth;
      const first = [...nav.children].find((c) => (c as HTMLElement).offsetLeft >= need) as HTMLElement | undefined;
      nav.scrollLeft = Math.min(el.offsetLeft, first?.offsetLeft ?? need) - 4;
    }
  }, [ui.kind]);

  const entries: Array<{ kind: LibraryKind | null; label: string; count: number }> = [
    { kind: null, label: "All", count: total },
    ...SHELVES.map((s) => ({ kind: s.kind, label: s.label, count: countsByKind[s.kind] ?? 0 })),
  ];

  return (
    <nav
      ref={navRef}
      aria-label="Shelves"
      className="tm-rail relative flex h-9 items-stretch overflow-x-auto px-1 [mask-image:linear-gradient(90deg,transparent,#000_10px,#000_calc(100%-16px),transparent)]"
    >
      {entries.map((e) => {
        const on = ui.kind === e.kind;
        return (
          <button
            key={e.kind ?? "all"}
            ref={on ? activeRef : undefined}
            type="button"
            aria-pressed={on}
            disabled={e.count === 0 && !on}
            onClick={() => ui.setKind(e.kind === null || on ? null : e.kind)}
            className={cn(
              "relative flex shrink-0 items-baseline gap-1 self-stretch px-2 pt-2.5 text-body outline-none transition-colors",
              "focus-visible:text-fg disabled:pointer-events-none disabled:opacity-35",
              on
                ? "text-fg after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary"
                : "text-fg-muted hover:text-fg",
            )}
          >
            {e.label}
            <span className="font-mono text-meta tabular-nums text-fg-faint">{e.count}</span>
          </button>
        );
      })}
    </nav>
  );
}

/**
 * A shelf's own vocabulary as mono words — a fade, a spin, something loud.
 * Generic: it reads the facets the library counts, so every shelf gets one.
 * A tag on EVERY item narrows nothing and is dropped.
 */
function FacetWords() {
  const ui = useLibraryUi();
  const { facets, facetTotal } = useLibraryResults();
  if (ui.kind === null) return null;
  const shown = facets.filter((f) => f.count < facetTotal).slice(0, 12);
  if (shown.length < 2) return null;

  const word = (on: boolean) =>
    cn(
      "flex shrink-0 items-center gap-1 rounded-(--r-xs) px-1.5 py-1 font-mono text-meta lowercase transition-colors",
      on ? "text-fg" : "text-fg-faint hover:text-fg",
    );
  const dot = (on: boolean) => <span aria-hidden className={cn("size-1 rounded-full", on ? "bg-primary" : "bg-transparent")} />;

  return (
    <div className="tm-rail flex gap-0.5 overflow-x-auto px-1.5 pb-2 pt-1">
      <button type="button" onClick={() => ui.clearTags()} aria-pressed={ui.tags.length === 0} className={word(ui.tags.length === 0)}>
        {dot(ui.tags.length === 0)}
        all
      </button>
      {shown.map((f) => {
        const on = ui.tags.includes(f.tag);
        return (
          <button key={f.tag} type="button" onClick={() => ui.toggleTag(f.tag)} aria-pressed={on} className={word(on)}>
            {dot(on)}
            {f.tag}
            <span className="tabular-nums opacity-60">{f.count}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Cards a home section shows before its door ("All →"). */
const SECTION_CAP = 12;

/**
 * Every shelf at once, each an eyebrow over one rail of frames. A card takes
 * most of the rail's width, so the next one is cut at the edge — the cut card
 * is what says "this moves" without a scrollbar.
 */
export function StudioSectioned({ items, cardFor, onOpen }: LibrarySectionedProps) {
  const groups = React.useMemo(() => {
    const map = new Map<LibraryKind, LibraryItem[]>();
    for (const item of items) {
      const list = map.get(item.kind);
      if (list) list.push(item);
      else map.set(item.kind, [item]);
    }
    return map;
  }, [items]);

  return (
    <div className="flex flex-col gap-7 pt-1">
      {SHELVES.map(({ kind, label }) => {
        const list = groups.get(kind);
        if (!list?.length) return null;
        return (
          <StudioShelf key={kind} label={label} total={list.length} onOpen={() => onOpen(kind)}>
            {list.slice(0, SECTION_CAP).map((item) => cardFor(item, "grid"))}
          </StudioShelf>
        );
      })}
    </div>
  );
}

function StudioShelf({
  label,
  total,
  onOpen,
  children,
}: {
  label: string;
  total: number;
  onOpen: () => void;
  children: React.ReactNode;
}) {
  const { railRef, overflow, pan } = useRail(children);
  const arrow =
    "flex size-5 items-center justify-center rounded-(--r-xs) text-fg-faint transition-colors hover:bg-hover hover:text-fg [&_svg]:size-3";

  return (
    <section className="group/shelf">
      <div className="mb-2.5 flex items-center gap-2 px-0.5">
        <h3 className="flex min-w-0 items-baseline gap-1.5 font-mono text-meta uppercase tracking-[0.12em]">
          <span className="truncate text-primary">{label}</span>
          <span className="tabular-nums text-fg-faint">{total}</span>
        </h3>
        <div className="ml-auto flex items-center gap-0.5">
          {overflow && (
            <div className="flex items-center opacity-0 transition-opacity group-hover/shelf:opacity-100 focus-within:opacity-100">
              <button type="button" aria-label={`Scroll ${label} left`} onClick={() => pan(-1)} className={arrow}>
                <ChevronLeft />
              </button>
              <button type="button" aria-label={`Scroll ${label} right`} onClick={() => pan(1)} className={arrow}>
                <ChevronRight />
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={onOpen}
            aria-label={`All ${label}`}
            className="flex items-center gap-1 rounded-(--r-xs) px-1 font-mono text-meta text-fg-muted transition-colors hover:text-fg [&_svg]:size-3"
          >
            All <ArrowRight />
          </button>
        </div>
      </div>
      <div ref={railRef} className="tm-rail -mx-0.5 flex snap-x snap-mandatory gap-2.5 overflow-x-auto scroll-smooth px-0.5 pb-0.5">
        {React.Children.map(children, (child, i) => (
          <div key={i} className="w-[68%] max-w-52 shrink-0 snap-start">
            {child}
          </div>
        ))}
      </div>
    </section>
  );
}

/** The door into a kind's full catalogue: one quiet line, drawn inside that shelf only. */
export function StudioDoor({ kind, query, count }: LibraryDoorProps) {
  const door = SHELF_PLUGIN[kind];
  if (!door) return null;
  return (
    <button
      type="button"
      onClick={() => usePluginWindows.getState().open(door.pluginId, query ? { q: query } : undefined)}
      className="group mb-3 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left ring-1 ring-inset ring-line transition-colors hover:bg-hover"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body text-fg">{query ? `“${query}” in all ${door.label}` : `All ${door.label}`}</span>
        <span className="block truncate font-mono text-meta text-fg-faint">
          {count > 0 ? `${count.toLocaleString()} online` : "the full catalogue"}
        </span>
      </span>
      <ArrowUpRight className="size-3.5 shrink-0 text-fg-faint transition-colors group-hover:text-primary" />
    </button>
  );
}

export function StudioEmpty({ loading, query, starred }: LibraryEmptyProps) {
  if (loading) {
    return (
      <div className="flex justify-center py-12 text-fg-faint">
        <Loader2 className="size-3.5 animate-spin" />
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-1.5 px-3 py-12 text-center">
      <p className="font-mono text-meta uppercase tracking-[0.12em] text-primary">
        {starred ? "Starred" : query ? "No match" : "Empty"}
      </p>
      <p className="text-body text-fg-muted">{starred ? "Star what you reach for." : query ? `Nothing for “${query}”` : "Nothing here yet."}</p>
    </div>
  );
}
