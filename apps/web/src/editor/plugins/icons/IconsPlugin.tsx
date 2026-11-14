"use client";

import * as React from "react";
import {
  LAYER_ANIMATION_PRESETS,
  getPreset,
  iconBodyStyle,
  iconId,
  iconSetNeedsAttribution,
  iconSvg,
  iconTags,
  parseIconId,
  resolveColor,
  type IconData,
  type IconRef,
  type IconSet,
  type IconSetIndex,
  type IconStyle,
  type LayerAnimationSpec,
} from "@solomotion/core";
import {
  ArrowRightFromLine,
  ArrowRightToLine,
  Clock,
  Layers,
  Loader2,
  Plus,
  Search,
  Star,
  WifiOff,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { NumberInput } from "@/components/ui/number-input";
import { Range } from "@/components/ui/range";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { RailItem, RailSection } from "@/components/ui/rail-list";
import { useVirtualRows } from "@/components/ui/use-virtual-rows";
import { ZoomControl } from "@/components/ui/zoom-control";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { DocColorInput } from "../../inspector/DocColorInput";
import { LayerAnimationEditor } from "../../inspector/LayerAnimate";
import { useTypeToFocus } from "../../input/use-type-to-focus";
import {
  DRAG_OUT_PROPS,
  DRAG_OUT_SURFACE,
  useDragOut,
} from "../../panels/drag-out";
import { placeAboveSelection, placeSnapshot } from "../../state/clip-actions";
import { useDoc, useDocStore } from "../../state/document-context";
import { useSession } from "../../state/session";
import { usePanelZoom } from "../../state/use-panel-zoom";
import { snapshotDrag } from "../../state/snapshot-drag";
import { activeCompId } from "../../timeline/timeline-utils";
import { iconCatalog } from "./icon-catalog";
import { iconClips, iconDisplayName } from "./icon-clips";
import { useIconsPrefs, type IconStyleFilter } from "./icons-store";
import { useIconData, useIconSets } from "./use-icon-data";
import { settleSvg } from "./settle-svg";
import { AnimationPreview, useIntroPlay } from "../../ui/PosePreview";

/**
 * THE ICONS PANEL — every open-source icon set, one browser.
 *
 * The layout is the Variables window's grammar, because it is the same kind of
 * thing: a rail of places on the left that lives OUTSIDE what it filters, one
 * card on the right with a search, a grid and a footer, all on the shell
 * ground. Nothing here has to be learned twice.
 *
 * Nothing is loaded until it is looked at. The set list is one small fetch;
 * a set's names arrive when its shelf opens; bodies arrive per visible tile
 * (batched), and everything fetched is kept in the browser's cache for the
 * next session. A search runs server-side, so "arrow" over 370,000 icons
 * downloads only the arrows.
 *
 * An icon lands as the vector layers it is (see `icon-clips.ts`): drag it to
 * the stage or a lane, double-click it, or press Insert. The footer holds the
 * defaults every icon lands with — ink, size, pen, entrance, exit — the same
 * controls the inspector uses for a placed layer.
 */

/* ------------------------------------------------------------------ data */

/** Where the panel is: home, a fixed shelf, a family of sets, or one set. */
type Shelf =
  "all" | "favorites" | "recent" | { set: string } | { group: string };

const shelfKey = (s: Shelf): string =>
  typeof s === "string" ? s : "set" in s ? `set:${s.set}` : `group:${s.group}`;
const parseShelf = (key: string): Shelf =>
  key === "favorites" || key === "recent"
    ? key
    : key.startsWith("set:")
      ? { set: key.slice(4) }
      : key.startsWith("group:")
        ? { group: key.slice(6) }
        : "all";

/** Upstream's set categories, in the order a person looks for them. */
const SET_GROUPS: Array<{
  label: string;
  match: (c: string | null) => boolean;
}> = [
  { label: "Interface", match: (c) => c !== null && c.startsWith("UI") },
  { label: "Material", match: (c) => c === "Material" },
  { label: "Emoji", match: (c) => c === "Emoji" },
  { label: "Logos", match: (c) => c === "Logos" || c === "Programming" },
  { label: "Flags & maps", match: (c) => c === "Flags / Maps" },
  { label: "Thematic", match: (c) => c === "Thematic" || c === null },
  { label: "Archive", match: (c) => c === "Archive / Unmaintained" },
];

/**
 * The sets, by prefix, for anything under the panel that builds a drop. A
 * tile knows its icon's prefix and nothing else, and a drop must carry the
 * set's licence and author — so the map the panel already derives is shared
 * downward rather than fetched again per tile.
 */
const IconSetsContext = React.createContext<ReadonlyMap<string, IconSet>>(new Map());
const useIconSet = (prefix: string): IconSet | null => React.useContext(IconSetsContext).get(prefix) ?? null;


function useSetIndex(prefix: string | null): IconSetIndex | null {
  const [index, setIndex] = React.useState<IconSetIndex | null>(null);
  React.useEffect(() => {
    if (!prefix) return;
    let live = true;
    setIndex(null);
    iconCatalog()
      .index(prefix)
      .then((i) => live && setIndex(i))
      .catch(
        () =>
          live &&
          setIndex({ prefix, categories: [], uncategorized: [], all: [] }),
      );
    return () => {
      live = false;
    };
  }, [prefix]);
  return prefix ? index : null;
}

/** A debounced, cancellable search; `null` while nothing has been asked. */
function useIconSearch(
  query: string,
  style: IconStyleFilter,
  enabled: boolean,
) {
  const [state, setState] = React.useState<{
    icons: IconRef[];
    total: number;
    busy: boolean;
    failed: boolean;
  }>({
    icons: [],
    total: 0,
    busy: false,
    failed: false,
  });
  const q = query.trim();
  React.useEffect(() => {
    if (!enabled || !q) {
      setState({ icons: [], total: 0, busy: false, failed: false });
      return;
    }
    let live = true;
    setState((s) => ({ ...s, busy: true, failed: false }));
    const t = setTimeout(() => {
      iconCatalog()
        .search({
          query: q,
          style: style === "stroke" || style === "fill" ? style : undefined,
          palette:
            style === "color" ? true : style === "all" ? undefined : false,
          limit: 999,
        })
        .then(
          (r) =>
            live &&
            setState({
              icons: r.icons,
              total: r.total,
              busy: false,
              failed: false,
            }),
        )
        .catch(
          () =>
            live &&
            setState({ icons: [], total: 0, busy: false, failed: true }),
        );
    }, 180);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, style, enabled]);
  return state;
}

/* ------------------------------------------------------------------- panel */

export default function IconsPlugin() {
  const { sets, error, retry } = useIconSets();
  const prefs = useIconsPrefs();
  const shelf = parseShelf(prefs.shelf);
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState<IconRef | null>(null);
  const { startDragOut, ghostNode } = useDragOut();

  const setShelf = (s: Shelf) => {
    prefs.set({ shelf: shelfKey(s) });
    setSelected(null);
  };

  const setByPrefix = React.useMemo(
    () => new Map((sets ?? []).map((s) => [s.prefix, s])),
    [sets],
  );
  // THE SAME zoom every browser panel has — ⌘-scroll, pinch, ⌘±, ⌘0, the
  // dial — persisted for this panel. It scales the TILE rather than the CSS
  // `zoom` the library uses, because a virtualised grid measures its rows in
  // real pixels. The gesture hosts on the card, which outlives every shelf.
  const cardRef = React.useRef<HTMLElement>(null);
  const zoom = usePanelZoom("icons", {
    scrollRef: cardRef,
    min: 0.6,
    max: 2.4,
    isActive: () => Boolean(cardRef.current?.matches(":hover")),
  });
  const currentSet =
    typeof shelf === "object" && "set" in shelf
      ? (setByPrefix.get(shelf.set) ?? null)
      : null;

  return (
    <IconSetsContext.Provider value={setByPrefix}>
    <div className="flex min-h-0 flex-1 gap-2 bg-background p-2">
      <div className="hidden w-52 shrink-0 @[640px]:flex">
        <SetsRail
          sets={sets}
          shelf={shelf}
          onSelect={setShelf}
          favorites={prefs.favorites.length}
          recent={prefs.recent.length}
        />
      </div>

      <section
        ref={cardRef}
        className="flex min-h-0 min-w-0 flex-1 flex-col shell-card"
      >
        <Header
          query={query}
          onQuery={setQuery}
          style={prefs.style}
          onStyle={(style) => prefs.set({ style })}
          currentSet={currentSet}
          shelf={shelf}
          onShelf={setShelf}
          zoom={zoom}
        />
        {error ? (
          <Offline retry={retry} />
        ) : !sets ? (
          <Busy />
        ) : (
          <Grid
            sets={sets}
            shelf={shelf}
            query={query}
            style={prefs.style}
            selected={selected}
            onSelect={setSelected}
            onOpenSet={(prefix) => setShelf({ set: prefix })}
            onGroup={(group) => setShelf({ group })}
            startDragOut={startDragOut}
            tile={Math.round(TILE * zoom.level)}
          />
        )}
        <Footer
          selected={selected}
          set={selected ? (setByPrefix.get(selected.prefix) ?? null) : null}
        />
      </section>
      {ghostNode}
    </div>
    </IconSetsContext.Provider>
  );
}

/* -------------------------------------------------------------------- rail */

function SetsRail({
  sets,
  shelf,
  onSelect,
  favorites,
  recent,
}: {
  sets: IconSet[] | null;
  shelf: Shelf;
  onSelect: (s: Shelf) => void;
  favorites: number;
  recent: number;
}) {
  const [filter, setFilter] = React.useState("");
  const f = filter.trim().toLowerCase();
  const shown = (sets ?? []).filter(
    (s) => !f || s.name.toLowerCase().includes(f) || s.prefix.includes(f),
  );
  const groups = SET_GROUPS.map((g) => ({
    ...g,
    sets: shown.filter((s) => g.match(s.category)),
  })).filter((g) => g.sets.length > 0);
  const activeSet =
    typeof shelf === "object" && "set" in shelf ? shelf.set : null;
  const activeGroup =
    typeof shelf === "object" && "group" in shelf ? shelf.group : null;

  return (
    <aside className="flex min-h-0 w-full flex-col shell-card">
      <div className="shrink-0 p-2 pb-0">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Find a set"
          spellCheck={false}
          className="h-(--control-h) w-full rounded-md border border-transparent bg-input/45 px-2 text-xs outline-none transition-colors hover:border-border focus:border-primary/60"
        />
      </div>
      <ScrollArea className="min-h-0 flex-1" viewportClassName="p-2">
        {!f && (
          <>
            <RailSection label="Browse" />
            <RailItem
              icon={<Layers />}
              label="All icons"
              active={shelf === "all"}
              onClick={() => onSelect("all")}
            />
            <RailItem
              icon={<Star />}
              label="Starred"
              count={favorites}
              active={shelf === "favorites"}
              onClick={() => onSelect("favorites")}
            />
            <RailItem
              icon={<Clock />}
              label="Recent"
              count={recent}
              active={shelf === "recent"}
              onClick={() => onSelect("recent")}
            />
          </>
        )}
        {groups.map((g) => (
          <React.Fragment key={g.label}>
            <RailSection
              label={g.label}
              action={{
                icon: <Layers />,
                label: `All ${g.label.toLowerCase()} sets`,
                onClick: () => onSelect({ group: g.label }),
              }}
            />
            {activeGroup === g.label && (
              <div className="mx-2 mb-1 h-px bg-primary/40" />
            )}
            {g.sets.map((s) => (
              <RailItem
                key={s.prefix}
                icon={<SetGlyph set={s} />}
                label={s.name}
                count={s.total}
                active={activeSet === s.prefix}
                onClick={() => onSelect({ set: s.prefix })}
              />
            ))}
          </React.Fragment>
        ))}
        {sets && shown.length === 0 && (
          <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
            No set matches.
          </p>
        )}
      </ScrollArea>
    </aside>
  );
}

/** A set's first sample icon, as its rail glyph. */
function SetGlyph({ set }: { set: IconSet }) {
  const name = set.samples[0];
  const data = useIconData({ prefix: set.prefix, name: name ?? "" });
  if (!name || !data)
    return (
      <span className="block size-3.5 rounded-sm bg-muted-foreground/30" />
    );
  return <IconArt data={data} className="size-3.5" />;
}

/* ------------------------------------------------------------------ header */

const STYLE_CHIPS: Array<{ value: IconStyleFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "stroke", label: "Line" },
  { value: "fill", label: "Solid" },
  { value: "color", label: "Colour" },
];

function Header({
  query,
  onQuery,
  style,
  onStyle,
  currentSet,
  shelf,
  onShelf,
  zoom,
}: {
  query: string;
  onQuery: (q: string) => void;
  style: IconStyleFilter;
  onStyle: (s: IconStyleFilter) => void;
  currentSet: IconSet | null;
  shelf: Shelf;
  onShelf: (s: Shelf) => void;
  zoom: ReturnType<typeof usePanelZoom>;
}) {
  const ref = React.useRef<HTMLInputElement>(null);
  useTypeToFocus(ref);
  const title = currentSet
    ? currentSet.name
    : typeof shelf === "object" && "group" in shelf
      ? shelf.group
      : shelf === "favorites"
        ? "Starred"
        : shelf === "recent"
          ? "Recent"
          : "All icons";
  // Inside a set the style is the set's; the chips only mean something across sets.
  const chips =
    !currentSet &&
    (shelf === "all" || typeof shelf === "object" || !!query.trim());
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/50 p-2">
      {typeof shelf === "object" && (
        <button
          type="button"
          onClick={() => onShelf("all")}
          className="hidden h-(--control-h) items-center rounded-md px-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground @[640px]:flex"
        >
          All
          <span className="mx-1 opacity-50">/</span>
        </button>
      )}
      <span className="hidden min-w-0 shrink truncate text-xs font-medium @[640px]:inline">
        {title}
      </span>
      <div className="flex h-(--control-h) min-w-32 flex-1 items-center gap-1.5 rounded-md border border-transparent bg-input/45 px-2 transition-colors focus-within:border-primary/60 hover:border-border">
        <Search className="size-3.5 shrink-0 text-muted-foreground/70" />
        <input
          ref={ref}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={
            currentSet ? `Search ${currentSet.name}` : "Search every set"
          }
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
        />
      </div>
      {chips && (
        <div className="flex shrink-0 gap-0.5">
          {STYLE_CHIPS.map((c) => (
            <button
              key={c.value}
              type="button"
              onClick={() => onStyle(c.value)}
              className={cn(
                "h-6 rounded-md px-2 text-[11px] transition-colors",
                style === c.value
                  ? "material-glass-raised text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
      {/* THE zoom dial — the same instrument the library and the media grid
          use — lives with the search, so it is there on every shelf without
          costing a row of its own. */}
      <ZoomControl
        value={zoom.level}
        min={zoom.min}
        max={zoom.max}
        scale="log"
        size="sm"
        length={72}
        title="Drag, scroll or ± ; double-click to reset"
        aria-label="Icon size"
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={zoom.setLevel}
        onReset={zoom.reset}
      />
    </header>
  );
}

/* -------------------------------------------------------------------- grid */

const TILE = 60;

type DragStarter = ReturnType<typeof useDragOut>["startDragOut"];

function Grid({
  sets,
  shelf,
  query,
  style,
  selected,
  onSelect,
  onOpenSet,
  onGroup,
  startDragOut,
  tile,
}: {
  sets: IconSet[];
  shelf: Shelf;
  query: string;
  style: IconStyleFilter;
  selected: IconRef | null;
  onSelect: (ref: IconRef) => void;
  onOpenSet: (prefix: string) => void;
  onGroup: (label: string) => void;
  startDragOut: DragStarter;
  /** Cell size in px — the panel's zoom applied to the base tile. */
  tile: number;
}) {
  const prefs = useIconsPrefs();
  const q = query.trim().toLowerCase();
  const setPrefix =
    typeof shelf === "object" && "set" in shelf ? shelf.set : null;
  const group =
    typeof shelf === "object" && "group" in shelf ? shelf.group : null;
  const index = useSetIndex(setPrefix);
  const search = useIconSearch(
    query,
    style,
    setPrefix === null && (shelf === "all" || group !== null || !!q),
  );
  const [category, setCategory] = React.useState<string | null>(null);

  // WHAT THE GRID LISTS — one derivation per shelf, all of them a flat list of
  // refs so the tiles below never know where a name came from.
  const refs = React.useMemo<IconRef[] | null>(() => {
    if (setPrefix) {
      if (!index) return null;
      const cat = category
        ? index.categories.find((c) => c.name === category)
        : null;
      const names = cat ? cat.icons : index.all;
      const list = q ? names.filter((n) => n.includes(q)) : names;
      return list.map((name) => ({ prefix: setPrefix, name }));
    }
    if (shelf === "favorites" || shelf === "recent") {
      const ids = shelf === "favorites" ? prefs.favorites : prefs.recent;
      return ids
        .map(parseIconId)
        .filter((r): r is IconRef => !!r && (!q || r.name.includes(q)));
    }
    return q ? search.icons : [];
  }, [
    setPrefix,
    index,
    category,
    q,
    shelf,
    prefs.favorites,
    prefs.recent,
    search.icons,
  ]);

  React.useEffect(() => setCategory(null), [setPrefix]);

  // Columns follow the viewport's width. Measured through a CALLBACK ref, so
  // the observer attaches the moment the scroller mounts — which happens after
  // a spinner, after a search, after a shelf change — and not on a render the
  // effect happened to run in.
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const [cols, setCols] = React.useState(8);
  const tileRef = React.useRef(TILE);
  const observer = React.useRef<ResizeObserver | null>(null);
  const attachViewport = React.useCallback((el: HTMLDivElement | null) => {
    viewportRef.current = el;
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const measure = () =>
      setCols(Math.max(2, Math.floor((el.clientWidth - 8) / tileRef.current)));
    measure();
    observer.current = new ResizeObserver(measure);
    observer.current.observe(el);
  }, []);
  React.useEffect(() => () => observer.current?.disconnect(), []);

  tileRef.current = tile;
  React.useEffect(() => {
    const el = viewportRef.current;
    if (el) setCols(Math.max(2, Math.floor((el.clientWidth - 8) / tile)));
  }, [tile]);

  const rows = refs ? Math.ceil(refs.length / cols) : 0;
  const v = useVirtualRows({
    count: rows,
    rowHeight: tile,
    viewportRef,
    overscan: 3,
  });

  // HOME — the families, each a row you can scroll sideways, until something
  // is typed. A family shelf is that family's sets, all of them.
  const styled = sets.filter((s) => style === "all" || s.style === style);
  if (shelf === "all" && !q)
    return (
      <Home
        sets={styled}
        onOpen={onOpenSet}
        onGroup={onGroup}
        scale={tile / TILE}
      />
    );
  if (group !== null && !q) {
    const fam = SET_GROUPS.find((g) => g.label === group);
    return (
      <SetCovers
        sets={fam ? styled.filter((s) => fam.match(s.category)) : []}
        onOpen={onOpenSet}
        scale={tile / TILE}
      />
    );
  }
  if (!refs || (search.busy && refs.length === 0)) return <Busy />;
  if (search.failed) return <Offline />;

  const categories = index?.categories ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {categories.length > 0 && (
        <div className="tm-rail flex shrink-0 gap-1 overflow-x-auto border-b border-border/50 px-2 py-1.5">
          <Chip
            label="All"
            active={category === null}
            onClick={() => setCategory(null)}
          />
          {categories.map((c) => (
            <Chip
              key={c.name}
              label={c.name}
              count={c.icons.length}
              active={category === c.name}
              onClick={() => setCategory(c.name)}
            />
          ))}
        </div>
      )}
      {refs.length === 0 ? (
        <Empty shelf={shelf} query={q} />
      ) : (
        <ScrollArea
          className={cn("min-h-0 flex-1", DRAG_OUT_SURFACE)}
          viewportRef={attachViewport}
          viewportClassName="p-1"
        >
          <div style={{ height: v.padTop }} />
          <div
            className="grid"
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
          >
            {refs.slice(v.start * cols, v.end * cols).map((ref) => (
              <Tile
                key={iconId(ref)}
                icon={ref}
                size={tile}
                selected={
                  !!selected &&
                  selected.prefix === ref.prefix &&
                  selected.name === ref.name
                }
                onSelect={onSelect}
                startDragOut={startDragOut}
              />
            ))}
          </div>
          <div style={{ height: v.padBottom }} />
        </ScrollArea>
      )}
      <div className="flex h-6 shrink-0 items-center gap-2 border-t border-border/50 px-2.5 text-[10px] text-muted-foreground">
        <span>
          {refs.length.toLocaleString()}{" "}
          {search.total > refs.length
            ? `of ${search.total.toLocaleString()} `
            : ""}
          icons
        </span>
        {search.busy && <Loader2 className="size-3 animate-spin" />}
      </div>
    </div>
  );
}

function Chip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] transition-colors",
        active
          ? "material-glass-raised text-primary"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      {count !== undefined && (
        <span className="font-mono tabular-nums opacity-50">{count}</span>
      )}
    </button>
  );
}

/** How many covers a home row shows before it hands over to "View all". */
const HOME_ROW = 10;

/**
 * HOME. One row per family, scrolled sideways, capped — never every set of
 * every family in one wall. A family with more than a row's worth ends in a
 * "View all", which opens the family shelf: that family's sets, every one.
 */
function Home({
  sets,
  onOpen,
  onGroup,
  scale,
}: {
  sets: IconSet[];
  onOpen: (prefix: string) => void;
  onGroup: (label: string) => void;
  /** The panel's zoom — a card grows with the tiles. */
  scale: number;
}) {
  const groups = SET_GROUPS.map((g) => ({
    ...g,
    sets: sets.filter((s) => g.match(s.category)),
  })).filter((g) => g.sets.length > 0);
  return (
    <ScrollArea className="min-h-0 flex-1" viewportClassName="py-1">
      {groups.map((g) => (
        <section key={g.label} className="py-1.5">
          <div className="flex items-center gap-2 px-3 pb-1.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground/80">
              {g.label}
            </h3>
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground/50">
              {g.sets.length}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => onGroup(g.label)}
              className="text-[11px] text-muted-foreground transition-colors hover:text-primary"
            >
              View all
            </button>
          </div>
          <div className="tm-rail flex gap-2 overflow-x-auto px-3 pb-1">
            {g.sets.slice(0, HOME_ROW).map((s) => (
              <SetCard
                key={s.prefix}
                set={s}
                onOpen={onOpen}
                className="shrink-0"
                style={{ width: 160 * scale }}
              />
            ))}
            {g.sets.length > HOME_ROW && (
              <button
                type="button"
                onClick={() => onGroup(g.label)}
                className="flex w-24 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border/60 text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
              >
                <span className="text-sm font-medium">
                  +{g.sets.length - HOME_ROW}
                </span>
                more
              </button>
            )}
          </div>
        </section>
      ))}
    </ScrollArea>
  );
}

/** A family's sets, all of them, wrapped to the width. */
function SetCovers({
  sets,
  onOpen,
  scale,
}: {
  sets: IconSet[];
  onOpen: (prefix: string) => void;
  scale: number;
}) {
  return (
    <ScrollArea className="min-h-0 flex-1" viewportClassName="p-2">
      <div
        className="grid gap-2"
        style={{
          gridTemplateColumns: `repeat(auto-fill, minmax(${Math.round(150 * scale)}px, 1fr))`,
        }}
      >
        {sets.map((s) => (
          <SetCard key={s.prefix} set={s} onOpen={onOpen} />
        ))}
      </div>
    </ScrollArea>
  );
}

/** A set's cover: four samples, the name, the count and the licence. */
function SetCard({
  set: s,
  onOpen,
  className,
  style,
}: {
  set: IconSet;
  onOpen: (prefix: string) => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type="button"
      style={style}
      onClick={() => onOpen(s.prefix)}
      className={cn(
        "group flex flex-col gap-1.5 rounded-lg border border-border/50 p-2 text-left transition-colors hover:border-primary/50 hover:bg-muted/30",
        className,
      )}
    >
      <div className="grid grid-cols-4 gap-1">
        {s.samples.slice(0, 4).map((name) => (
          <Cover key={name} icon={{ prefix: s.prefix, name }} />
        ))}
      </div>
      <div className="min-w-0">
        <div className="truncate text-xs font-medium">{s.name}</div>
        <div className="truncate text-[10px] text-muted-foreground">
          {s.total.toLocaleString()} · {s.license.title}
        </div>
      </div>
    </button>
  );
}

function Cover({ icon }: { icon: IconRef }) {
  const data = useIconData(icon);
  return (
    <div className="flex aspect-square items-center justify-center rounded-md bg-muted/40 text-foreground/85">
      {data ? <IconArt data={data} className="size-5" /> : null}
    </div>
  );
}

/** The icon, inked in the current preview colour. */
function IconArt({
  data,
  className,
  color,
  style,
}: {
  data: IconData;
  className?: string;
  color?: string;
  style?: React.CSSProperties;
}) {
  // The preview is the drop: the same pen override the layers will land with,
  // so a thinner line in the dial is a thinner line in every tile.
  const pen = useIconsPrefs((s) => s.strokeWidth);
  // Settled: a set's own SMIL animation never plays here — ours does, on hover.
  const markup = React.useMemo(
    () => settleSvg(iconSvg(data, { strokeWidth: pen ?? undefined })),
    [data, pen],
  );
  return (
    <span
      className={cn("inline-block [&>svg]:size-full", className)}
      style={{ ...style, ...(color ? { color } : {}) }}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}

/**
 * An icon that PLAYS its default entrance while `playing` — the real artwork
 * under the real preset, through the same `AnimationPreview` the Animate tab
 * uses, so a hovered tile shows exactly what the layer will do. With no
 * entrance set it is simply the icon.
 */
function IconPlay({
  data,
  ink,
  px,
  playing,
}: {
  data: IconData;
  ink: string;
  px: number;
  playing: boolean;
}) {
  const animIn = useIconsPrefs((s) => s.animIn);
  const art = (
    <IconArt data={data} color={ink} style={{ width: px, height: px }} />
  );
  if (!animIn) return art;
  return (
    <AnimationPreview
      presetId={animIn.preset}
      spec={animIn}
      playing={playing}
      scale={px / 128}
      art={art}
    />
  );
}

/** One grid cell: press to select, drag to drop, double-click to insert. */
function Tile({
  icon,
  size,
  selected,
  onSelect,
  startDragOut,
}: {
  icon: IconRef;
  /** Cell size in px; the glyph takes ~40% of it. */
  size: number;
  selected: boolean;
  onSelect: (ref: IconRef) => void;
  startDragOut: DragStarter;
}) {
  const data = useIconData(icon);
  const set = useIconSet(icon.prefix);
  const doc = useDoc();
  const store = useDocStore();
  const ink = usePreviewInk();
  const id = iconId(icon);
  const name = iconDisplayName(icon);
  const [hovered, setHovered] = React.useState(false);

  const build = () => {
    const opts = dropOptions(useIconsPrefs.getState());
    return data && set ? iconClips(doc, icon, set, data, opts) : null;
  };

  // A native title, not a Radix tooltip: a hundred mounted tiles would be a
  // hundred tooltip roots rebuilt on every scroll, for a label the browser
  // already knows how to show.
  return (
    <button
      type="button"
      aria-label={name}
      title={name}
      aria-pressed={selected}
      disabled={data === null}
      {...DRAG_OUT_PROPS}
      onPointerDown={(e) => {
        if (!data) return;
        startDragOut(e, {
          drag: () => {
            const built = build();
            return built
              ? snapshotDrag(built.name, built.snapshot, built.preview)
              : null;
          },
          label: name,
          onClick: () => onSelect(icon),
        });
      }}
      onDoubleClick={() => {
        const built = build();
        if (built) insertIcon(store, built, id);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          const built = build();
          if (built) insertIcon(store, built, id);
        }
      }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      className={cn(
        "flex aspect-square items-center justify-center rounded-md text-foreground/85 transition-colors",
        "hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60",
        selected && "material-glass-raised",
        data === null && "opacity-30",
      )}
      style={{ width: size - 4, height: size - 4, touchAction: "pan-y" }}
    >
      {data ? (
        <IconPlay data={data} ink={ink} px={size * 0.42} playing={hovered} />
      ) : data === null ? (
        <span className="size-6 rounded bg-muted/40" />
      ) : null}
    </button>
  );
}

function Empty({ shelf, query }: { shelf: Shelf; query: string }) {
  const text = query
    ? "Nothing matches."
    : shelf === "favorites"
      ? "Star an icon to keep it here."
      : shelf === "recent"
        ? "Icons you place show up here."
        : "Type to search.";
  return (
    <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
      {text}
    </div>
  );
}

function Busy() {
  return (
    <div className="flex flex-1 items-center justify-center text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
    </div>
  );
}

function Offline({ retry }: { retry?: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
      <WifiOff className="size-5" />
      <span>The icon catalogue is unreachable.</span>
      {retry && (
        <button
          type="button"
          onClick={retry}
          className="rounded-md material-glass px-2.5 py-1 text-[11px] transition-colors hover:text-primary"
        >
          Try again
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ footer */

function Footer({
  selected,
  set,
}: {
  selected: IconRef | null;
  set: IconSet | null;
}) {
  const prefs = useIconsPrefs();
  const store = useDocStore();
  const doc = useDoc();
  const data = useIconData(selected ?? { prefix: "", name: "" });
  const ink = usePreviewInk();
  const id = selected ? iconId(selected) : null;
  const starred = !!id && prefs.favorites.includes(id);
  const style: IconStyle | null = data
    ? iconBodyStyle(data.body)
    : (set?.style ?? null);

  const insert = () => {
    if (!selected || !data || !set) return;
    const built = iconClips(doc, selected, set, data, dropOptions(prefs));
    if (built) insertIcon(store, built, iconId(selected));
  };
  // The chosen icon introduces itself once, and again under the pointer.
  const [hover, setHover] = React.useState(false);
  const intro = useIntroPlay(hover, 2400);
  const playKey = `${id}:${prefs.animIn?.preset ?? ""}`;

  return (
    <footer className="grid shrink-0 gap-2 border-t border-border/50 px-2.5 py-2">
      {/* Row one: the chosen icon and the one action. */}
      <div className="flex min-w-0 items-center gap-2.5">
        <div
          className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted/40 text-foreground/90"
          onPointerEnter={() => setHover(true)}
          onPointerLeave={() => setHover(false)}
        >
          {selected && data ? (
            <IconPlay
              key={playKey}
              data={data}
              ink={ink}
              px={28}
              playing={intro}
            />
          ) : (
            <Plus className="size-4 text-muted-foreground/50" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          {selected ? (
            <>
              <div className="flex items-center gap-1.5">
                <span className="truncate text-xs font-medium">
                  {iconDisplayName(selected)}
                </span>
                <button
                  type="button"
                  aria-label={starred ? "Unstar" : "Star"}
                  aria-pressed={starred}
                  onClick={() => id && prefs.toggleFavorite(id)}
                  className={cn(
                    "shrink-0 text-muted-foreground transition-colors hover:text-foreground",
                    starred && "text-primary",
                  )}
                >
                  <Star className={cn("size-3.5", starred && "fill-current")} />
                </button>
              </div>
              <div className="flex flex-wrap gap-x-1.5 text-[10px] text-muted-foreground">
                {iconTags(selected, style ? { style } : null)
                  .slice(0, 6)
                  .map((t) => (
                    <span key={t}>#{t}</span>
                  ))}
              </div>
              {set && (
                <div className="truncate text-[10px] text-muted-foreground/70">
                  {set.name} · {set.license.title}
                  {iconSetNeedsAttribution(set)
                    ? ` · credit ${set.author.name}`
                    : ""}
                </div>
              )}
            </>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              Pick an icon
            </span>
          )}
        </div>
        <button
          type="button"
          disabled={!selected || !data}
          onClick={insert}
          className="flex h-(--control-h) shrink-0 items-center gap-1 rounded-md bg-primary/15 px-2.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/25 disabled:opacity-40 [&_svg]:size-3.5"
        >
          <Plus /> Insert
        </button>
      </div>

      {/* Row two: the defaults every icon lands with — one strip, the same
          shape at every width, scrolling sideways rather than wrapping. */}
      <div className="tm-rail flex items-center gap-1.5 overflow-x-auto">
        <DocColorInput
          value={prefs.color}
          onChange={(color) => prefs.set({ color })}
          className="w-24 shrink-0"
        />
        <NumberInput
          value={prefs.size}
          min={8}
          max={2048}
          step={4}
          precision={0}
          unit="px"
          onChange={(size) => prefs.set({ size })}
          className="w-20 shrink-0"
        />
        <PenControl
          value={prefs.strokeWidth}
          onChange={(strokeWidth) => prefs.set({ strokeWidth })}
          disabled={style === "fill" || style === "color"}
        />
        <EdgeControl
          phase="in"
          spec={prefs.animIn}
          onChange={(animIn) => prefs.set({ animIn })}
        />
        <EdgeControl
          phase="out"
          spec={prefs.animOut}
          onChange={(animOut) => prefs.set({ animOut })}
        />
      </div>
    </footer>
  );
}

/** Line width for stroke icons — off means "as the set drew it". */
function PenControl({
  value,
  onChange,
  disabled,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  disabled: boolean;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="flex h-(--control-h) items-center gap-1.5 rounded-md border border-border/60 px-2 text-[11px] transition-colors hover:border-border disabled:opacity-40"
        >
          <span className="text-muted-foreground">Pen</span>
          <span className="font-mono tabular-nums">
            {value === null ? "auto" : value}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-2">
        <div className="flex items-center justify-between pb-2 text-[11px]">
          <span>Override the set&apos;s line</span>
          <Switch
            checked={value !== null}
            onCheckedChange={(on) => onChange(on ? 2 : null)}
          />
        </div>
        <Range
          label="Width"
          value={value ?? 2}
          min={0.5}
          max={4}
          step={0.25}
          defaultValue={2}
          precision={2}
          disabled={value === null}
          onChange={onChange}
        />
      </PopoverContent>
    </Popover>
  );
}

/** An entrance or exit, as a chip that opens the SAME editor the inspector uses. */
function EdgeControl({
  phase,
  spec,
  onChange,
}: {
  phase: "in" | "out";
  spec: LayerAnimationSpec | null;
  onChange: (spec: LayerAnimationSpec | null) => void;
}) {
  const def = spec ? getPreset(spec.preset) : undefined;
  const Icon = phase === "in" ? ArrowRightToLine : ArrowRightFromLine;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={phase === "in" ? "Entrance" : "Exit"}
          className={cn(
            "flex h-(--control-h) items-center gap-1.5 rounded-md border border-border/60 px-2 text-[11px] transition-colors hover:border-border [&_svg]:size-3.5",
            def && "text-primary",
          )}
        >
          <Icon />
          <span className={cn(!def && "text-muted-foreground")}>
            {def ? def.label : phase === "in" ? "In" : "Out"}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <LayerAnimationEditor
          spec={spec}
          phase={phase}
          presets={LAYER_ANIMATION_PRESETS}
          onChange={onChange}
        />
      </PopoverContent>
    </Popover>
  );
}

/* ----------------------------------------------------------------- shared */

/** The ink tiles preview in — the pref, with a variable resolved through the document. */
function usePreviewInk(): string {
  const doc = useDoc();
  const color = useIconsPrefs((s) => s.color);
  return React.useMemo(() => resolveColor(doc, color), [doc, color]);
}

function dropOptions(p: ReturnType<typeof useIconsPrefs.getState>) {
  return {
    color: p.color,
    size: p.size,
    strokeWidth: p.strokeWidth,
    animIn: p.animIn,
    animOut: p.animOut,
  };
}

/** Place built icon layers at the playhead, above the selection, in the open comp. */
function insertIcon(
  store: ReturnType<typeof useDocStore>,
  built: NonNullable<ReturnType<typeof iconClips>>,
  id: string,
) {
  const session = useSession.getState();
  const doc = store.getState();
  const frameId = activeCompId(doc, session.activeFrameId);
  const lead = built.snapshot.group ?? built.snapshot.clips[0];
  const placement = lead
    ? placeAboveSelection(doc, {
        ...lead,
        frameId,
        startMs: session.playheadMs,
      })
    : {};
  const ids = placeSnapshot(
    store,
    built.name,
    built.snapshot,
    { frameId, startMs: session.playheadMs },
    placement,
  );
  if (ids.length === 0) return toast.error("Nothing drawable in that icon");
  useIconsPrefs.getState().noteUsed(id);
  toast(`${built.name} added`);
}
