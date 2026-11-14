"use client";

import * as React from "react";
import {
  LIBRARY_SOURCE_LABELS,
  type LibraryItem,
  type LibraryKind,
  type LibrarySort,
  type LibrarySource,
} from "@solomotion/core";
import {
  ArrowLeftRight,
  ArrowUpRight,
  Component,
  Film,
  LayoutTemplate,
  ChevronLeft,
  ChevronRight,
  Library as LibraryIcon,
  Loader2,
  Music,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Star,
  Type,
  Upload,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BrowserFilters, BrowserSearch, type FilterGroup } from "../panels/BrowserControls";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { useDocStore } from "../state/document-context";
import { useWorkspace } from "../state/workspace";
import { usePanelZoom } from "../state/use-panel-zoom";
import { DRAG_OUT_SURFACE, useDragOut } from "../panels/drag-out";
import { libraryClient } from "./client";
import { usePluginWindows } from "../plugins/plugin-windows";
import { LibraryCard } from "./LibraryCard";
import { isDraggable, libraryDragFor, applyLibraryItem } from "./library-actions";
import { TEMPLATES_OFFERED } from "./templates";
import { auditionItem } from "./audition";
import { useLibraryFocus, useLibraryResults, useLibraryUi } from "./use-library";
import { openPublisher } from "./PublishDialog";
import { TextLookPrefsBar } from "./TextLookPrefs";

/**
 * THE LIBRARY — one browser for everything.
 *
 * It replaced four tabs (Presets / Media / Custom / Starred) that were four
 * different answers to one question, none of which could show you content you
 * had not already downloaded. The shelves below are the same six `LibraryKind`s
 * the model defines, so adding a seventh — visuals, icons, LUTs — is a provider
 * and a glyph, not another tab.
 *
 * The shape is a sticky SHELF BAR over one dense grid of previews. Not
 * sections with headings, and not carousels: a heading over four cards spends a
 * third of a narrow panel saying a word the icons already say, and a row you
 * have to scroll sideways hides most of a shelf to show you a label. The bar is
 * always reachable, the grid is always previews, and "All" is a real shelf so
 * the panel is never a menu you have to get past.
 */

/**
 * Browse order: the vocabulary first — the looks, motion and cuts you reach for
 * on almost every layer — then sounds, then the things that are already YOURS.
 * You do not browse for your own components; you go and get them.
 */
/**
 * A shelf whose full catalogue lives in a dedicated BROWSER.
 *
 * The Library shows what a project already HAS — every shelf here is yours,
 * and the online catalogue only joins in when you search. Seven hundred sound
 * effects are not something to scroll past on the way to your components, so
 * the shelf does not try to be the place they live; the CATEGORY says where
 * they are. Inside a shelf there is room for a real card; on the home rails
 * there is not, and a growing label crammed into a 6-inch header row wraps
 * onto three lines the moment the panel narrows.
 */
const SHELF_PLUGIN: Partial<Record<LibraryKind, { pluginId: string; label: string; icon: React.ComponentType<{ className?: string }> }>> = {
  sound: { pluginId: "sfx", label: "sound effects", icon: Music },
};

/**
 * The door into a kind's full catalogue, drawn only INSIDE that kind's shelf.
 *
 * A dashed panel rather than a filled one: it is an opening, not an item, and
 * a solid card here would read as one more thing in the grid. Fixed height and
 * a single row, so no label length can make it reflow.
 */
function CatalogueDoor({
  kind,
  query,
  count,
}: {
  kind: LibraryKind;
  query: string;
  count: number;
}) {
  const door = SHELF_PLUGIN[kind];
  if (!door) return null;
  const Icon = door.icon;
  return (
    <button
      type="button"
      onClick={() => usePluginWindows.getState().open(door.pluginId, query ? { q: query } : undefined)}
      className="group mb-2 flex w-full items-center gap-2.5 rounded-lg border border-dashed border-border/70 px-3 py-2.5 text-left transition-colors hover:border-primary/50 hover:bg-muted/30"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted/50 text-muted-foreground transition-colors group-hover:text-primary">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">
          {query ? `Search “${query}” in all ${door.label}` : `Browse all ${door.label}`}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {count > 0 ? `${count.toLocaleString()} online` : "The full catalogue"}
        </span>
      </span>
      <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
    </button>
  );
}

const SHELVES: Array<{ kind: LibraryKind; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { kind: "text", label: "Text looks", icon: Type },
  { kind: "animation", label: "Animations", icon: Sparkles },
  { kind: "transition", label: "Transitions", icon: ArrowLeftRight },
  { kind: "sound", label: "Sounds", icon: Music },
  { kind: "component", label: "Components", icon: Component },
  { kind: "media", label: "Media", icon: Film },
  ...(TEMPLATES_OFFERED ? [{ kind: "template" as const, label: "Templates", icon: LayoutTemplate }] : []),
];

const SOURCES: LibrarySource[] = ["user", "project", "builtin", "downloaded", "online"];

/**
 * "Most used" leads, because in a project you have been working in for an hour
 * the thing you want next is overwhelmingly something you already reached for.
 * It promotes rather than reshuffles — see `searchLibrary`.
 */
const LIBRARY_SORTS = [
  { value: "used", label: "Most used here" },
  { value: "relevance", label: "Best match" },
  { value: "name", label: "Name" },
  { value: "newest", label: "Newest" },
] as const;

/** How many cards render before the scroll sentinel asks for more. */
const PAGE = 60;

/**
 * The natural width of a card, in CSS px. There is no size SETTING beside it:
 * panel zoom already scales the whole content continuously, so a small/medium/
 * large picker was a second, coarser dial for the one thing zoom does better —
 * and two controls for one fact means they disagree the moment you touch either.
 * Zoom is the dial; these are what it starts from.
 */
const TILE_PX = 104;

export function LibraryBrowser() {
  const store = useDocStore();
  const ui = useLibraryUi();
  const results = useLibraryResults();
  // What the panel is aimed at. Cards read it to mark themselves ON; the apply
  // path reads the SAME projection to decide where a click lands, so the mark
  // and the edit can never disagree about which slot is in play.
  const focus = useLibraryFocus();
  const { startDragOut, ghostNode } = useDragOut();
  const favorites = useWorkspace((s) => s.favorites);
  const toggleFavorite = useWorkspace((s) => s.toggleFavorite);
  const deleteCustom = useWorkspace((s) => s.deleteCustomTemplate);
  const [busy, setBusy] = React.useState<ReadonlySet<string>>(new Set());
  const viewportRef = React.useRef<HTMLDivElement>(null);
  // The SAME panel-zoom primitive the media library uses: ⌘-scroll, pinch, ⌘±,
  // ⌘0, persisted per panel. Written once, claimed here — a second zoom
  // implementation would be a second set of gestures to keep in step.
  const zoom = usePanelZoom("library", {
    scrollRef: viewportRef,
    isActive: () => Boolean(viewportRef.current?.matches(":hover")),
  });
  const [limit, setLimit] = React.useState(PAGE);
  const [starredOnly, setStarredOnly] = React.useState(false);

  const searching = ui.text.trim().length > 0 || ui.tags.length > 0;
  // HOME is a real place, not a dump of everything. A flat list of four hundred
  // items is not a library; it is a stock photo site. So the first screen shows
  // the shelves, each wearing four of its own previews, and every one of them
  // is one click deep.

  React.useEffect(() => setLimit(PAGE), [ui.kind, ui.text, ui.tags, ui.sources, ui.packId]);

  const use = async (item: LibraryItem) => {
    setBusy((s) => new Set(s).add(item.id));
    await applyLibraryItem(store, item);
    setBusy((s) => {
      const next = new Set(s);
      next.delete(item.id);
      return next;
    });
  };

  /**
   * Audition. Only audition.
   *
   * This used to acquire as well — "hearing a sound already costs the bytes,
   * keeping them is free" — and the reasoning was wrong in a way you could see
   * on screen. Adopting an online sound makes a LOCAL item, and the local item
   * is a second card: click a search result to hear it and a near-identical
   * row appeared beside it, with the original's waveform going quiet because
   * the thing playing was now something else. It also pushed an undo step for
   * a gesture the user reads as "listen".
   *
   * Auditioning is not acquiring — the rule `audition.ts` opens with, and the
   * rule the sound browser has always followed. Acquiring is Use, ⏎, or a drag:
   * three deliberate acts, none of them a click.
   */
  const play = (item: LibraryItem) => auditionItem(item);

  const cardFor = (item: LibraryItem) => (
    <LibraryCard
      key={item.id}
      item={item}
      view={ui.view}
      draggable={isDraggable(item)}
      starred={favorites.includes(item.id)}
      active={focus.activeIds.has(item.id)}
      busy={busy.has(item.id)}
      onUse={() => void use(item)}
      onPlay={() => play(item)}
      onToggleStar={() => toggleFavorite(item.id)}
      onDragStart={(e, press) => {
        // LAZY. `libraryDragFor` adopts an un-owned sound as a document asset
        // so its bytes can stream in behind the gesture, so calling it here
        // would import a file — and push an undo step — on every plain click.
        // That is what put a second, identical sound card in the list the
        // instant you touched one.
        startDragOut(e, {
          drag: () => libraryDragFor(store, item),
          label: item.name,
          // The CARD decides what a short press means, because it is the card
          // that knows a sound should play and a video should not. The browser
          // answering "import it" here made every click an import.
          onClick: press,
        });
      }}
      onDelete={
        item.source === "user" || (item.source === "downloaded" && item.kind !== "sound")
          ? () => {
              deleteCustom(item.id.split(":").pop()!);
              toast(`Deleted “${item.name}”`);
            }
          : undefined
      }
    />
  );

  // Free: the root index is already fetched for the pack chips, so the door
  // can say how much is behind it without a request of its own.
  const onlineCount = React.useMemo(
    () => results.packs.filter((p) => p.kind === ui.kind).reduce((n, p) => n + p.itemCount, 0),
    [results.packs, ui.kind],
  );

  const visible = React.useMemo(() => {
    const list = starredOnly ? results.items.filter((i) => favorites.includes(i.id)) : results.items;
    return list;
  }, [results.items, starredOnly, favorites]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar
        starredOnly={starredOnly}
        onToggleStarred={() => setStarredOnly((v) => !v)}
        loading={results.loadingOnline}
        zoom={zoom}
      />

      {results.onlineError && (
        <button
          type="button"
          onClick={() => {
            libraryClient()?.invalidate();
            ui.setText(ui.text);
          }}
          className="flex shrink-0 items-center gap-1.5 border-b bg-amber-500/10 px-2.5 py-1 text-left text-[10px] text-amber-500/90 hover:bg-amber-500/15"
        >
          <RefreshCw className="size-3" /> Offline — retry
        </button>
      )}

      {/* One `touch-action` on the VIEWPORT covers every card, and the next
          card someone adds cannot forget it. `pan-y` keeps the one-finger
          scroll a browser needs and hands the sideways drag — the direction the
          stage and timeline are in — to the drag-out controller. */}
      <ScrollArea
        viewportRef={viewportRef}
        className="min-h-0 flex-1"
        viewportClassName={DRAG_OUT_SURFACE}
      >
        <div className="p-2" style={zoom.style}>
          {visible.length === 0 ? (
            <Empty loading={results.loadingOnline} query={ui.text} starred={starredOnly} />
          ) : ui.kind === null ? (
            // Across every shelf at once — grouped, never mixed. One flat list
            // of a text look, a whoosh and someone's saved lower-third is not a
            // result set, it is a pile.
            <Sectioned items={visible} cardFor={cardFor} onOpen={(k) => ui.setKind(k)} />
          ) : (
            <>
              <CatalogueDoor kind={ui.kind} query={ui.text} count={onlineCount} />
              <Grid items={visible.slice(0, limit)} view={ui.view} cardFor={cardFor} />
              {visible.length > limit && (
                <More onVisible={() => setLimit((n) => n + PAGE)} remaining={visible.length - limit} />
              )}
            </>
          )}
        </div>
      </ScrollArea>
      {ghostNode}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Toolbar({
  starredOnly,
  onToggleStarred,
  loading,
  zoom,
}: {
  starredOnly: boolean;
  onToggleStarred: () => void;
  loading: boolean;
  zoom: ReturnType<typeof usePanelZoom>;
}) {
  const ui = useLibraryUi();
  const { facets } = useLibraryResults();

  /**
   * Tags as a CHECKBOX GROUP, not `#hashtag` chips.
   *
   * The hash was decoration: these are the same words the facet rail shows
   * without one, and a `#` in a filter list reads like syntax you are supposed
   * to type somewhere. Capped, because a filter list that grows with the
   * catalogue eventually IS the catalogue — the rail under the shelf bar is
   * where a shelf's own vocabulary lives, and this is the long tail.
   */
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

  return (
    <div className="shrink-0 border-b">
      <div className="flex items-center gap-1 p-2">
        <BrowserSearch value={ui.text} onChange={ui.setText} loading={loading} />

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Starred only"
              aria-pressed={starredOnly}
              onClick={onToggleStarred}
              className={cn(
                "flex size-(--control-h) shrink-0 items-center justify-center rounded-md transition-colors [&_svg]:size-3.5",
                starredOnly
                  ? "material-glass-raised text-amber-400"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
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
          onClear={() => {
            ui.clearTags();
            for (const src of ui.sources) ui.toggleSource(src);
          }}
        />

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Publish to the library"
              onClick={() => openPublisher()}
              className="flex size-(--control-h) shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-3.5"
            >
              <Upload />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Publish</TooltipContent>
        </Tooltip>
      </div>

      <ShelfBar />
      <FacetRail />
      {/* The look dials belong to the TEXT shelf and appear with it — a control
          that can only affect one kind of item has no business sitting over the
          others. Same rule the facet rail already follows. */}
      {ui.kind === "text" && <TextLookPrefsBar />}
    </div>
  );
}

/**
 * THE SHELF BAR — the app's tab grammar, applied to the library.
 *
 * It used to be a row of 24px chips: a glyph, a number, and a tooltip you had
 * to hover to learn what the glyph meant. Six unlabelled icons in a row is a
 * puzzle, not navigation — you cannot scan it, you cannot learn it, and at a
 * glance it reads as toolbar decoration rather than as the thing that changes
 * what the panel is showing.
 *
 * So it becomes what the rails already are: a bigger icon with its LABEL under
 * it, and `material-glass-raised` for the armed one — the same object as the
 * armed tool, the open panel and the selected inspector tab. One armed state,
 * learned once.
 *
 * Width is a layer of one formula, not a second layout. Below `COMPACT_TABS_PX`
 * the labels drop and the icons stay, in the same components, in the same
 * order — no `isMobile` branch and no alternate tree. The strip scrolls
 * horizontally through `ScrollArea` either way, so a seventh shelf costs
 * nothing and a narrow panel never hides one behind an overflow menu.
 */
const COMPACT_TABS_PX = 280;

function ShelfBar() {
  const ui = useLibraryUi();
  const { countsByKind, items } = useLibraryResults();
  const ref = React.useRef<HTMLDivElement>(null);
  const [labels, setLabels] = React.useState(true);

  // The panel's own width decides, not the window's — this panel can be docked
  // narrow beside a wide window, or floated wide inside a small one.
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setLabels(el.clientWidth >= COMPACT_TABS_PX));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const total = ui.kind === null ? items.length : Object.values(countsByKind).reduce((a, b) => a + b, 0);

  return (
    <div ref={ref}>
      <ScrollArea orientation="horizontal" className="shrink-0 pb-1">
        <div className="flex gap-0.5 px-1.5">
          <ShelfButton
            label="All"
            icon={<LibraryIcon />}
            count={total}
            labelled={labels}
            active={ui.kind === null}
            onClick={() => ui.setKind(null)}
          />
          {SHELVES.map(({ kind, label, icon: Icon }) => (
            <ShelfButton
              key={kind}
              label={label}
              icon={<Icon />}
              count={countsByKind[kind]}
              labelled={labels}
              active={ui.kind === kind}
              onClick={() => ui.setKind(ui.kind === kind ? null : kind)}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

/**
 * THE FACET RAIL — a shelf's own vocabulary, one row under the shelf bar.
 *
 * Opening "Animations" used to hand you thirty-five tiles and a filter popover
 * two clicks away with the categories filed under "Tags". The families are how
 * anyone actually browses motion — a fade, a spin, something loud — so they
 * belong on the surface, next to the thing they narrow.
 *
 * Generic on purpose, and NOT an animations special case: it reads the facets
 * the library already counts, so transitions get their dissolves and wipes,
 * text looks get their categories and sounds get their packs from the same six
 * lines. A seventh shelf gets a rail by existing.
 *
 * A tag carried by EVERY item in the pool is dropped: on the animations shelf
 * that is the word "animation", which narrows nothing and would sit first
 * because it is also the most common. Facets are counted before tag filtering,
 * so the row does not collapse to the one chip you just pressed.
 */
function FacetRail() {
  const ui = useLibraryUi();
  const { facets, facetTotal } = useLibraryResults();
  if (ui.kind === null) return null;

  const shown = facets.filter((f) => f.count < facetTotal).slice(0, 12);
  if (shown.length < 2) return null;

  return (
    <div className="tm-rail flex gap-1 overflow-x-auto px-1.5 pb-1.5">
      <button
        type="button"
        onClick={() => ui.clearTags()}
        aria-pressed={ui.tags.length === 0}
        className={cn(
          "shrink-0 rounded-full px-2.5 py-1 text-[10px] font-medium transition-colors",
          ui.tags.length === 0
            ? "material-glass-raised text-primary"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        All
      </button>
      {shown.map((f) => (
        <button
          key={f.tag}
          type="button"
          onClick={() => ui.toggleTag(f.tag)}
          aria-pressed={ui.tags.includes(f.tag)}
          className={cn(
            "flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-medium capitalize transition-colors",
            ui.tags.includes(f.tag)
              ? "material-glass-raised text-primary"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {f.tag}
          <span className="tabular-nums opacity-60">{f.count}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * One shelf tab. The COUNT is the quiet part: it sits under the label at low
 * contrast, because it answers "is there anything in there" — worth knowing,
 * never worth reading first. A shelf reading zero is telling you the truth
 * about your search rather than about itself, so it dims rather than vanishes:
 * a strip that changes length as you type is a strip you cannot aim at.
 */
function ShelfButton({
  label,
  icon,
  count,
  active,
  labelled,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  count: number;
  active: boolean;
  labelled: boolean;
  onClick: () => void;
}) {
  const button = (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      disabled={count === 0 && !active}
      className={cn(
        "flex shrink-0 flex-col items-center justify-center gap-1 rounded-lg px-2.5 py-1.5 transition-colors outline-none",
        "focus-visible:ring-1 focus-visible:ring-primary/60",
        "[&_svg]:size-4.5",
        active
          ? "material-glass-raised text-primary"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-30",
      )}
    >
      {icon}
      {labelled && (
        <span className="flex items-baseline gap-1 text-[10px] font-medium leading-none">
          {label}
          <span className="tabular-nums opacity-50">{count}</span>
        </span>
      )}
    </button>
  );

  // The tooltip is the label's stand-in, so it only exists while the label does
  // not. A tooltip repeating text already on screen is noise that also delays
  // the pointer.
  if (labelled) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="bottom">
        {label} · {count}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The one layout for a run of cards, so grid and list differ in exactly one
 * place. Columns FOLLOW the width rather than being declared, which is what
 * makes zoom and a resized panel both change how many fit — a fixed column
 * count turns zoom into "the same two tiles, bigger".
 */
function Grid({
  items,
  view,
  cardFor,
}: {
  items: LibraryItem[];
  view: "grid" | "list";
  cardFor: (item: LibraryItem) => React.ReactNode;
}) {
  if (view === "list") return <div className="flex flex-col gap-0.5">{items.map(cardFor)}</div>;
  return (
    <div
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${TILE_PX}px, 1fr))` }}
    >
      {items.map(cardFor)}
    </div>
  );
}

/**
 * Every shelf at once — each one LINE, scrolled sideways.
 *
 * "All" answers a different question from a shelf does: not "what sounds are
 * there" but "what KINDS of thing are there, and is any of it for me". A
 * wrapping grid answers neither — six sections that each reflow to three rows
 * turn the one screen that is supposed to show breadth into the longest scroll
 * in the app, and the sixth shelf is never seen.
 *
 * So a shelf is a rail: one line, always, whatever the view mode, with cards
 * bigger than the grid's because a rail has the width to spare and a preview
 * you can actually read is the entire point of showing it here. Vertical space
 * buys BREADTH (more shelves visible at once), horizontal scroll buys DEPTH
 * within one, and the header is the door to the rest.
 */
const SECTION_CAP = 12;

/**
 * Rail cards run considerably larger than grid tiles. A rail spends its width
 * on ONE line, so it can afford to; and on the home screen these cards ARE the
 * screen, so a preview you can read at a glance is the whole job.
 */
const RAIL_PX = 196;

function Sectioned({
  items,
  cardFor,
  onOpen,
}: {
  items: LibraryItem[];
  cardFor: (item: LibraryItem) => React.ReactNode;
  onOpen: (kind: LibraryKind) => void;
}) {
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
    <div className="flex flex-col gap-6">
      {SHELVES.map(({ kind, label, icon: Icon }) => {
        const list = groups.get(kind);
        if (!list?.length) return null;
        return (
          <Shelf
            key={kind}
            label={label}
            icon={<Icon className="size-3.5 shrink-0" />}
            total={list.length}
            onOpen={() => onOpen(kind)}
          >
            {list.slice(0, SECTION_CAP).map(cardFor)}
          </Shelf>
        );
      })}
    </div>
  );
}

/**
 * One shelf: a header that is the door, and a snapping rail under it.
 *
 * The arrows only exist while the rail actually overflows, and only on hover —
 * a control for something that cannot happen is worse than no control. Native
 * overflow does the work, so trackpads, shift-scroll, touch and the keyboard
 * all pan it without a line of code, and the arrows are a convenience on top
 * rather than the mechanism.
 */
function Shelf({
  label,
  icon,
  total,
  onOpen,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  total: number;
  onOpen: () => void;
  children: React.ReactNode;
}) {
  const railRef = React.useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = React.useState(false);

  // Whether the rail can pan at all — re-measured when the panel resizes or the
  // card size changes, which is exactly when the answer can differ.
  React.useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const measure = () => setOverflow(el.scrollWidth > el.clientWidth + 4);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [children]);

  const pan = (dir: 1 | -1) => {
    const el = railRef.current;
    if (el) el.scrollBy({ left: dir * Math.max(160, el.clientWidth * 0.8), behavior: "smooth" });
  };

  return (
    <section className="group/shelf">
      <div className="mb-2 flex items-center gap-2 px-0.5">
        <button
          type="button"
          onClick={onOpen}
          className="flex min-w-0 items-center gap-1.5 rounded text-left text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground"
        >
          {icon}
          <span className="text-[12px] font-semibold tracking-tight text-foreground">{label}</span>
          <span className="text-[11px] tabular-nums opacity-60">{total}</span>
        </button>

        <div className="ml-auto flex items-center gap-0.5">
          {overflow && (
            <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/shelf:opacity-100 focus-within:opacity-100">
              <button
                type="button"
                aria-label={`Scroll ${label} left`}
                onClick={() => pan(-1)}
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
              >
                <ChevronLeft />
              </button>
              <button
                type="button"
                aria-label={`Scroll ${label} right`}
                onClick={() => pan(1)}
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
              >
                <ChevronRight />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* The rail. Scrollbar hidden because the arrows, the snap and the cut-off
          card at the edge already say it moves — and a horizontal bar under
          every shelf would out-shout the shelves. */}
      <div
        ref={railRef}
        className="tm-rail -mx-0.5 flex snap-x snap-mandatory gap-2 overflow-x-auto scroll-smooth px-0.5 pb-0.5"
      >
        {React.Children.map(children, (child, i) => (
          <div key={i} className="shrink-0 snap-start" style={{ width: RAIL_PX }}>
            {child}
          </div>
        ))}
      </div>
    </section>
  );
}

function More({ onVisible, remaining }: { onVisible: () => void; remaining: number }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) onVisible();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [onVisible]);
  return (
    <div ref={ref} className="py-3 text-center text-[10px] text-muted-foreground">
      {remaining} more
    </div>
  );
}

function Empty({ loading, query, starred }: { loading: boolean; query: string; starred: boolean }) {
  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-[11px] text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
      </div>
    );
  }
  return (
    <p className="px-3 py-10 text-center text-[11px] text-muted-foreground">
      {starred ? "No stars yet" : query ? `No match for “${query}”` : "Empty"}
    </p>
  );
}
