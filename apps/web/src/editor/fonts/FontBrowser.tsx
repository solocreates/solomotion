"use client";

import * as React from "react";
import {
  FONT_CATEGORIES,
  collectionCount,
  createTextClip,
  documentFontUsage,
  facetCounts,
  idsWithVerdict,
  queryFonts,
  scriptLabel,
  weightName,
  type FaceStyle,
  type FontCategory,
  type FontFamilyMeta,
  type FontQuery,
  type FontSort,
} from "@solomotion/core";
import {
  ArrowUpRight,
  Clock,
  FileText,
  FolderPlus,
  HardDrive,
  Layers,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Star,
  Trash2,
  Type,
  Upload,
  X,
} from "lucide-react";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { Range } from "@/components/ui/range";
import { RailItem, RailSection } from "@/components/ui/rail-list";
import { RenameInput } from "@/components/ui/rename-input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useVirtualRows } from "@/components/ui/use-virtual-rows";
import { cn } from "@/lib/utils";
import { useDocStore } from "../state/document-context";
import { useMarks, useMarksState } from "../state/marks";
import { SPECIMEN_SIZE, fontShelfKey, parseFontShelf, useFontPrefs, type FontShelf } from "../state/font-prefs";
import { DRAG_OUT_SURFACE, useDragOut } from "../panels/drag-out";
import { snapshotDrag } from "../state/snapshot-drag";
import { FONT_FILE_ACCEPT, fontMark, uploadFontFiles } from "./font-actions";
import { FontCard, FontRow, ROW_H, cardHeight } from "./font-rows";
import { fontPickPatch, openFontLibrary, useFontLibrary } from "./library";
import { ensureFont } from "../stage/render/fonts";

/**
 * THE FONT BROWSER — one component, two sizes.
 *
 *   compact    the quick picker in the inspector and the text options bar:
 *              search, your starred and recent fonts on top, every source in
 *              its own titled section, a footer that never scrolls away
 *
 *   explorer   the Fonts window: shelves on a rail, big specimens you can type
 *              into, size and weight you set once for every card, the weight
 *              ramp of each family, filters by feeling, style and script
 *
 * They are one component because they are one browser. The list, the
 * reconciliation of sources, the stars, the recents and the pick all come from
 * the same hooks — the window is the picker with room, not a second picker.
 *
 * WHAT A PICK LANDS ON is the `target`: the host decides (the inspector's
 * scope, the options bar's pending style, the Fonts window's selection) and
 * the browser only calls `pick`. With no target the window's cards offer to
 * start a text layer in the font instead.
 */

export interface FontTarget {
  /** What a pick lands on, in a few words ("Title", "3 layers", "“quick”"). */
  label?: string | null;
  family: string | undefined;
  weight: number | undefined;
  italic: boolean | undefined;
  pick: (family: string, face?: FaceStyle) => void;
  /** Live, non-committal preview on hover; `null` reverts. */
  preview?: (family: string | null) => void;
}

/* ----------------------------------------------------------------- model */

/** The families IN the open document, in the order the document first uses them. */
function useProjectFamilies(): string[] {
  const store = useDocStore();
  const cache = React.useRef<{ key: string; list: string[] }>({ key: "", list: [] });
  const read = React.useCallback(() => {
    const list = [...new Set(documentFontUsage(store.getState()).map((u) => u.family))];
    const key = list.join("\u0000");
    if (key !== cache.current.key) cache.current = { key, list };
    return cache.current.list;
  }, [store]);
  return React.useSyncExternalStore(store.subscribe, read, read);
}

interface Filters {
  feelings: string[];
  styles: string[];
  script: string | null;
  variableOnly: boolean;
  italicOnly: boolean;
}

const NO_FILTERS: Filters = { feelings: [], styles: [], script: null, variableOnly: false, italicOnly: false };

const filtersActive = (f: Filters) =>
  f.feelings.length > 0 || f.styles.length > 0 || f.script !== null || f.variableOnly || f.italicOnly;

/** Everything a shelf, a query and the filters narrow the library to. */
function useFontList(shelf: FontShelf, query: string, filters: Filters, sort: FontSort) {
  const library = useFontLibrary();
  const marks = useMarksState();
  const recent = useFontPrefs((s) => s.recent);
  const project = useProjectFamilies();

  const starred = React.useMemo(() => new Set(idsWithVerdict(marks, "starred", "font")), [marks]);

  const base = React.useMemo(() => {
    const byFamily = new Map(library.map((m) => [m.family, m]));
    const ordered = (families: readonly string[]) =>
      families.map((f) => byFamily.get(f)).filter((m): m is FontFamilyMeta => !!m);
    switch (shelf.kind) {
      case "starred":
        return library.filter((m) => starred.has(m.family));
      case "recent":
        return ordered(recent);
      case "project":
        return ordered(project);
      case "source":
        return library.filter((m) => m.source === shelf.id);
      case "category":
        return library.filter((m) => m.category === shelf.id);
      case "collection": {
        const c = marks.collections.find((x) => x.id === shelf.id);
        return ordered((c?.keys ?? []).filter((k) => k.startsWith("font/")).map((k) => k.slice(5)));
      }
      default:
        return library;
    }
  }, [library, shelf, starred, recent, project, marks.collections]);

  const q: FontQuery = React.useMemo(
    () => ({
      text: query,
      feelings: filters.feelings,
      styles: filters.styles,
      script: filters.script,
      variableOnly: filters.variableOnly,
      italicOnly: filters.italicOnly,
      sort,
    }),
    [query, filters, sort],
  );

  const shown = React.useMemo(() => {
    // A personal shelf keeps its own order until you search or sort it.
    const keepOrder = (shelf.kind === "recent" || shelf.kind === "project" || shelf.kind === "collection") && !query;
    const list = queryFonts(base, keepOrder ? { ...q, sort: "popular" } : q);
    if (!keepOrder) return list;
    const at = new Map(base.map((m, i) => [m.family, i]));
    return list.sort((a, b) => at.get(a.family)! - at.get(b.family)!);
  }, [base, q, shelf.kind, query]);

  return { library, base, shown, starred, recent, project };
}

/**
 * A pick, and the hover preview that reverts when nothing was picked.
 *
 * A preview waits for its FACE before it touches the stage (up to a beat):
 * previewing a family the canvas has not loaded draws the fallback first and
 * the real face a moment later — a flash on the artwork for every row the
 * pointer rests on. Unmounting without a pick reverts, however the browser
 * was closed.
 */
function usePickAndPreview(target: FontTarget | null, delay: number) {
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const wanted = React.useRef<string | null>(null);
  const shown = React.useRef<string | null>(null);
  const latest = React.useRef(target);
  latest.current = target;
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const preview = React.useCallback((family: string | null) => {
    const t = latest.current;
    if (!t?.preview) return;
    clear();
    wanted.current = family;
    if (family === null) {
      if (shown.current !== null) t.preview(null);
      shown.current = null;
      return;
    }
    // Dwell first: sweeping the pointer across twenty rows must not re-lay
    // the stage twenty times.
    timer.current = setTimeout(() => {
      const face = ensureFont(family, { weight: t.weight, italic: t.italic });
      const beat = new Promise<void>((r) => setTimeout(r, 350));
      void Promise.race([face, beat]).then(() => {
        if (wanted.current !== family) return;
        shown.current = family;
        latest.current?.preview?.(family);
      });
    }, delay);
  }, [delay]);
  React.useEffect(
    () => () => {
      clear();
      if (shown.current !== null) latest.current?.preview?.(null);
    },
    [],
  );
  const pick = React.useCallback((family: string, face?: FaceStyle) => {
    clear();
    wanted.current = null;
    if (shown.current !== null) latest.current?.preview?.(null);
    shown.current = null;
    latest.current?.pick(family, face);
  }, []);
  return { pick, preview };
}

/** `value`, once it has stopped changing for `ms` — what a fetch should follow. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** Keep row `index` inside the viewport when the keyboard moves past an edge. */
function revealRow(viewport: HTMLElement | null, index: number, rowH: number) {
  if (!viewport || index < 0) return;
  const top = index * rowH;
  if (top < viewport.scrollTop) viewport.scrollTop = top;
  else if (top + rowH > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = top + rowH - viewport.clientHeight;
}

function useUpload(onAdded: (family: string, face: FaceStyle) => void) {
  const ref = React.useRef<HTMLInputElement>(null);
  const input = (
    <input
      ref={ref}
      type="file"
      multiple
      accept={FONT_FILE_ACCEPT}
      className="hidden"
      onChange={(e) => {
        const files = e.target.files ? [...e.target.files] : [];
        e.target.value = "";
        void uploadFontFiles(files).then((face) => {
          if (face) onAdded(face.family, { weight: face.weight, italic: face.italic });
        });
      }}
    />
  );
  return { open: () => ref.current?.click(), input };
}

/* -------------------------------------------------------------- compact */

type Entry = { kind: "header"; key: string; label: string; count?: number } | { kind: "font"; key: string; meta: FontFamilyMeta };

const SECTION_LABEL: Record<string, string> = {
  starred: "Starred",
  recent: "Recent",
  project: "In this project",
  yours: "Your fonts",
  system: "On this device",
  google: "Google Fonts",
};

export function CompactFontBrowser({
  target,
  onClose,
  onBrowse,
}: {
  target: FontTarget | null;
  onClose: () => void;
  /** Open the Fonts window, handing it what you typed. */
  onBrowse?: (query: string) => void;
}) {
  const [query, setQuery] = React.useState("");
  const { shown, starred, recent, project, library } = useFontList({ kind: "all" }, query, NO_FILTERS, "popular");
  const { pick, preview } = usePickAndPreview(target, 110);
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    openFontLibrary();
    searchRef.current?.focus({ preventScroll: true });
  }, []);

  const entries = React.useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    if (query.trim()) {
      for (const meta of shown) out.push({ kind: "font", key: meta.family, meta });
      return out;
    }
    const byFamily = new Map(library.map((m) => [m.family, m]));
    const section = (id: string, metas: FontFamilyMeta[], count?: number) => {
      if (metas.length === 0) return;
      out.push({ kind: "header", key: `h:${id}`, label: SECTION_LABEL[id]!, count });
      for (const meta of metas) out.push({ kind: "font", key: `${id}:${meta.family}`, meta });
    };
    const pick = (families: Iterable<string>, max = Infinity) =>
      [...families]
        .map((f) => byFamily.get(f))
        .filter((m): m is FontFamilyMeta => !!m)
        .slice(0, max);
    section("starred", pick(starred));
    section("recent", pick(recent.filter((f) => !starred.has(f)), 6));
    section("project", pick(project.filter((f) => !starred.has(f) && !recent.slice(0, 6).includes(f))));
    for (const source of ["yours", "system", "google"] as const) {
      const metas = shown.filter((m) => m.source === source);
      section(source, metas, source === "google" ? metas.length : undefined);
    }
    return out;
  }, [query, shown, library, starred, recent, project]);

  const fontIndexes = React.useMemo(() => entries.flatMap((e, i) => (e.kind === "font" ? [i] : [])), [entries]);
  const current = target?.family;
  // By ROW KEY, not family: a starred font is in two sections at once, and the
  // highlight must stay on the row under the pointer.
  const [activeKey, setActiveKey] = React.useState<string | null>(null);
  const active = activeKey ? entries.findIndex((e) => e.key === activeKey) : -1;
  // Open on the current font — the row you are about to move away from — and
  // re-aim when a search reshapes the list. Never on hover.
  React.useLayoutEffect(() => {
    const at = query.trim() ? fontIndexes[0] ?? -1 : entries.findIndex((e) => e.kind === "font" && e.meta.family === current && !e.key.startsWith("starred:") && !e.key.startsWith("recent:") && !e.key.startsWith("project:"));
    setActiveKey(at >= 0 ? entries[at]!.key : null);
    // Centred, so the fonts either side of the current one are in view.
    const vp = viewportRef.current;
    if (vp && at > 0 && !query.trim()) vp.scrollTop = Math.max(0, at * ROW_H - vp.clientHeight / 2 + ROW_H / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries.length === 0, query]);

  const rows = useVirtualRows({ count: entries.length, rowHeight: ROW_H, viewportRef });
  const upload = useUpload((family, face) => {
    pick(family, face);
    onClose();
  });

  const choose = React.useCallback(
    (meta: FontFamilyMeta) => {
      pick(meta.family);
      onClose();
    },
    [pick, onClose],
  );
  const hover = React.useCallback(
    (meta: FontFamilyMeta, key: string) => {
      setActiveKey(key);
      preview(meta.family);
    },
    [preview],
  );

  const step = (dir: 1 | -1) => {
    if (fontIndexes.length === 0) return;
    const at = fontIndexes.indexOf(active);
    const next = fontIndexes[at < 0 ? (dir > 0 ? 0 : fontIndexes.length - 1) : Math.max(0, Math.min(fontIndexes.length - 1, at + dir))]!;
    setActiveKey(entries[next]!.key);
    revealRow(viewportRef.current, next, ROW_H);
    const e = entries[next];
    if (e?.kind === "font") preview(e.meta.family);
  };

  return (
    <div className="flex h-[min(30rem,70vh)] w-[19rem] flex-col" onPointerLeave={() => preview(null)}>
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 p-1.5">
        <label className="flex h-(--control-h) min-w-0 flex-1 items-center gap-1.5 rounded-md bg-input/45 px-2 text-muted-foreground focus-within:ring-1 focus-within:ring-ring">
          <Search className="size-3.5 shrink-0" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                step(e.key === "ArrowDown" ? 1 : -1);
              } else if (e.key === "Enter") {
                const hit = entries[active];
                if (hit?.kind === "font") {
                  e.preventDefault();
                  choose(hit.meta);
                }
              }
            }}
            placeholder={library.length > 40 ? `Search ${library.length.toLocaleString()} fonts` : "Search fonts"}
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          {query && (
            <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="hover:text-foreground">
              <X className="size-3.5" />
            </button>
          )}
        </label>
      </div>

      <ScrollArea className="min-h-0 flex-1" viewportRef={viewportRef} viewportClassName="px-1.5 py-1">
        <div role="listbox" aria-label="Fonts">
          <div style={{ height: rows.padTop }} />
          {entries.slice(rows.start, rows.end).map((e, i) =>
            e.kind === "header" ? (
              <div
                key={e.key}
                style={{ height: ROW_H }}
                className="flex items-end gap-1.5 px-2 pb-1.5 text-2xs font-semibold uppercase tracking-[0.09em] text-muted-foreground/70"
              >
                <span>{e.label}</span>
                {e.count !== undefined && <span className="font-mono font-normal tabular-nums opacity-70">{e.count.toLocaleString()}</span>}
              </div>
            ) : (
              <FontRow
                key={e.key}
                rowKey={e.key}
                meta={e.meta}
                active={rows.start + i === active}
                selected={e.meta.family === current}
                onPick={choose}
                onHover={hover}
              />
            ),
          )}
          <div style={{ height: rows.padBottom }} />
          {entries.length === 0 && (
            <p className="px-3 py-8 text-center text-xs text-muted-foreground">
              {library.length === 0 ? "Loading fonts…" : `Nothing called “${query}”.`}
            </p>
          )}
        </div>
      </ScrollArea>

      {/* The footer never scrolls: adding a font is always one reach away. */}
      <div className="flex shrink-0 items-center gap-1 border-t border-border/60 p-1.5">
        <button
          type="button"
          onClick={upload.open}
          className="flex h-(--control-h) items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
        >
          <Upload /> Upload
        </button>
        <span className="flex-1" />
        {onBrowse && (
          <button
            type="button"
            onClick={() => {
              preview(null);
              onBrowse(query);
            }}
            className="flex h-(--control-h) items-center gap-1.5 rounded-md px-2 text-xs font-medium material-glass-raised text-primary transition-[filter] hover:brightness-110 [&_svg]:size-3.5"
          >
            Browse fonts <ArrowUpRight />
          </button>
        )}
        {upload.input}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- explorer */

const SORTS: Array<{ id: FontSort; label: string }> = [
  { id: "popular", label: "Popular" },
  { id: "trending", label: "Trending" },
  { id: "newest", label: "Newest" },
  { id: "name", label: "A–Z" },
];

/** The feelings worth a chip, in the order a designer reaches for them. */
const FEELINGS = [
  "Calm",
  "Business",
  "Playful",
  "Sophisticated",
  "Futuristic",
  "Vintage",
  "Artistic",
  "Loud",
  "Cute",
  "Happy",
  "Excited",
  "Fancy",
  "Childlike",
  "Rugged",
  "Innovative",
];

const CATEGORY_ICON: Record<FontCategory, string> = { sans: "Aa", serif: "Aa", display: "Aa", hand: "Aa", mono: "{}" };
const CATEGORY_FACE: Record<FontCategory, React.CSSProperties> = {
  sans: { fontFamily: "var(--font-inter), system-ui, sans-serif" },
  serif: { fontFamily: "ui-serif, Georgia, serif" },
  display: { fontFamily: "var(--font-space-grotesk), system-ui, sans-serif", fontWeight: 700 },
  hand: { fontFamily: "ui-serif, Georgia, serif", fontStyle: "italic" },
  mono: { fontFamily: "var(--font-jetbrains-mono), ui-monospace, monospace" },
};

export function ExplorerFontBrowser({
  target,
  initialQuery,
  onAddText,
}: {
  target: FontTarget | null;
  initialQuery?: string;
  /** No target: start a text layer set in this font, with the specimen line. */
  onAddText: (family: string, text: string, face?: FaceStyle) => void;
}) {
  const prefs = useFontPrefs();
  const shelf = React.useMemo(() => parseFontShelf(prefs.shelf), [prefs.shelf]);
  const setShelf = (s: FontShelf) => useFontPrefs.getState().set({ shelf: fontShelfKey(s) });
  const [query, setQuery] = React.useState(initialQuery ?? "");
  React.useEffect(() => {
    if (initialQuery !== undefined) setQuery(initialQuery);
  }, [initialQuery]);
  const [filters, setFilters] = React.useState<Filters>(NO_FILTERS);
  const { shown, base, library, starred, recent, project } = useFontList(shelf, query, filters, prefs.sort);
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const rowH = cardHeight(prefs.size);
  const settledSample = useSettled(prefs.sample, 280);
  const rows = useVirtualRows({ count: shown.length, rowHeight: rowH, viewportRef, threshold: 12 });
  const [active, setActive] = React.useState(-1);

  React.useEffect(() => {
    openFontLibrary();
  }, []);
  // A new list starts at the top — scrolled halfway down "Serif" is not where
  // "Mono" should open.
  React.useEffect(() => {
    if (viewportRef.current) viewportRef.current.scrollTop = 0;
    setActive(-1);
  }, [prefs.shelf, query, filters, prefs.sort]);

  const use = React.useCallback(
    (meta: FontFamilyMeta, face?: FaceStyle) => {
      if (target) target.pick(meta.family, face);
      else onAddText(meta.family, useFontPrefs.getState().sample, face);
    },
    [target, onAddText],
  );
  const select = React.useCallback((meta: FontFamilyMeta) => setActive(shown.indexOf(meta)), [shown]);

  // The SAME drag-out every library panel uses (Icons, text looks, media): a
  // card drags out as a snapshot holding one text layer set in its face and
  // your line, so the stage and the timeline receive it with no font-specific
  // drop code, and a rail collection can take it as a reference.
  const { startDragOut, ghostNode } = useDragOut();
  const press = React.useCallback(
    (e: React.PointerEvent, meta: FontFamilyMeta) =>
      startDragOut(e, {
        drag: () => {
          const prefsNow = useFontPrefs.getState();
          const clip = createTextClip({
            frameId: "",
            text: prefsNow.sample || meta.family,
            startMs: 0,
            style: fontPickPatch(meta.family, { weight: prefsNow.weight ?? undefined }),
          });
          return snapshotDrag(meta.family, { v: 2, clips: [clip], group: null });
        },
        label: meta.family,
        collect: fontMark(meta.family),
        onClick: () => select(meta),
      }),
    [startDragOut, select],
  );

  const upload = useUpload((family, face) => {
    setShelf({ kind: "source", id: "yours" });
    if (target) target.pick(family, face);
  });

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input, textarea, [contenteditable]")) {
      if (e.key === "Escape") (e.target as HTMLElement).blur();
      return;
    }
    const hit = (fn: () => void) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    const move = (d: number) => {
      const next = Math.max(0, Math.min(shown.length - 1, (active < 0 ? -1 : active) + d));
      setActive(next);
      revealRow(viewportRef.current, next, rowH);
    };
    if (e.key === "ArrowDown") return hit(() => move(1));
    if (e.key === "ArrowUp") return hit(() => move(-1));
    const meta = shown[active];
    if (!meta) return;
    if (e.key === "Enter") return hit(() => use(meta));
    if (e.key === "s" || e.key === "S") return hit(() => useMarks.getState().mark({ domain: "font", id: meta.family }, "starred"));
  };

  const scripts = React.useMemo(() => {
    const counts = facetCounts(base, "scripts");
    return [...counts.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
  }, [base]);
  const styles = React.useMemo(() => {
    const counts = facetCounts(base, "styles");
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [base]);
  const feelingCounts = React.useMemo(() => facetCounts(queryFonts(base, { ...filters, feelings: [] }), "feelings"), [base, filters]);

  return (
    <div
      ref={rootRef}
      data-capture-keys=""
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerDownCapture={(e) => {
        // Claim keys for the window, never stealing focus from a field or a menu.
        if ((e.target as HTMLElement).closest("input, textarea, [contenteditable], [role='menu']")) return;
        rootRef.current?.focus({ preventScroll: true });
      }}
      className="@container flex min-h-0 flex-1 gap-2 bg-background p-2 outline-none"
    >
      <div className="hidden w-52 shrink-0 @[680px]:flex">
        <FontRail
          shelf={shelf}
          onSelect={setShelf}
          counts={{
            all: library.length,
            starred: starred.size,
            recent: recent.length,
            project: project.length,
            yours: library.filter((m) => m.source === "yours").length,
            system: library.filter((m) => m.source === "system").length,
            google: library.filter((m) => m.source === "google").length,
          }}
          categoryCount={(c) => library.filter((m) => m.category === c).length}
          onUpload={upload.open}
        />
      </div>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col shell-card">
        {/* ── The specimen bar: what every card sets, and how. ─────────── */}
        <header className="flex shrink-0 flex-col gap-1.5 border-b border-border/50 p-2">
          <div className="flex items-center gap-1.5">
            <label className="flex h-(--control-h) min-w-0 flex-1 items-center gap-1.5 rounded-md bg-input/45 px-2 text-muted-foreground focus-within:ring-1 focus-within:ring-ring">
              <Search className="size-3.5 shrink-0" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search fonts, designers, feelings"
                spellCheck={false}
                className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
              {query && (
                <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="hover:text-foreground">
                  <X className="size-3.5" />
                </button>
              )}
            </label>
            <Select value={prefs.sort} onValueChange={(v) => useFontPrefs.getState().set({ sort: v as FontSort })}>
              <SelectTrigger className="h-(--control-h) w-28 shrink-0 text-xs" aria-label="Sort">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORTS.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex h-(--control-h) min-w-0 flex-1 items-center gap-1.5 rounded-md bg-input/45 px-2 text-muted-foreground focus-within:ring-1 focus-within:ring-ring">
              <Type className="size-3.5 shrink-0" />
              <input
                value={prefs.sample}
                onChange={(e) => useFontPrefs.getState().set({ sample: e.target.value })}
                placeholder="Type something"
                spellCheck={false}
                className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
            </label>
            <div className="w-32 shrink-0 @[640px]:w-40">
              <Range
                label="Size"
                value={prefs.size}
                min={SPECIMEN_SIZE.min}
                max={SPECIMEN_SIZE.max}
                step={1}
                scale="log"
                unit="px"
                defaultValue={SPECIMEN_SIZE.initial}
                onChange={(v) => useFontPrefs.getState().set({ size: Math.round(v) })}
              />
            </div>
            <div className="w-32 shrink-0 @[640px]:w-40">
              <Range
                label="Weight"
                value={prefs.weight ?? 0}
                min={0}
                max={900}
                step={100}
                defaultValue={0}
                format={(v) => (v < 100 ? "Auto" : weightName(v))}
                onChange={(v) => useFontPrefs.getState().set({ weight: v < 100 ? null : v })}
              />
            </div>
          </div>
          <FilterBar
            filters={filters}
            onChange={setFilters}
            feelingCounts={feelingCounts}
            scripts={scripts}
            styles={styles}
          />
        </header>

        <ScrollArea className={cn("min-h-0 flex-1", DRAG_OUT_SURFACE)} viewportRef={viewportRef} viewportClassName="px-1.5 pt-1.5">
          <div role="listbox" aria-label="Fonts">
            <div style={{ height: rows.padTop }} />
            {shown.slice(rows.start, rows.end).map((meta, i) => (
              <FontCard
                key={meta.family}
                meta={meta}
                sample={prefs.sample}
                settledSample={settledSample}
                script={filters.script}
                size={prefs.size}
                weight={prefs.weight}
                active={rows.start + i === active}
                selected={meta.family === target?.family}
                canUse={!!target}
                onUse={use}
                onPress={press}
              />
            ))}
            <div style={{ height: rows.padBottom }} />
          </div>
          {shown.length === 0 && (
            <EmptyShelf
              shelf={shelf}
              searching={!!query || filtersActive(filters)}
              loading={library.length === 0}
              onReset={() => {
                setQuery("");
                setFilters(NO_FILTERS);
              }}
              onUpload={upload.open}
            />
          )}
        </ScrollArea>

        <footer className="flex h-8 shrink-0 items-center gap-2 border-t border-border/50 px-2.5 text-2xs text-muted-foreground">
          <span className="tabular-nums">
            {shown.length.toLocaleString()} {shown.length === 1 ? "family" : "families"}
          </span>
          <span className="flex-1" />
          {target?.label ? (
            <span className="min-w-0 truncate">
              Applies to <span className="text-foreground">{target.label}</span>
            </span>
          ) : (
            <span className="min-w-0 truncate">No text selected</span>
          )}
          <button
            type="button"
            onClick={upload.open}
            className="flex h-6 items-center gap-1 rounded-md px-1.5 text-foreground/80 transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3"
          >
            <Upload /> Upload fonts
          </button>
          {upload.input}
        </footer>
      </section>
      {ghostNode}
    </div>
  );
}

/* ------------------------------------------------------------------ rail */

function FontRail({
  shelf,
  onSelect,
  counts,
  categoryCount,
  onUpload,
}: {
  shelf: FontShelf;
  onSelect: (s: FontShelf) => void;
  counts: Record<"all" | "starred" | "recent" | "project" | "yours" | "system" | "google", number>;
  categoryCount: (c: FontCategory) => number;
  onUpload: () => void;
}) {
  const marks = useMarksState();
  const newCollection = useMarks((s) => s.newCollection);
  const removeCollection = useMarks((s) => s.remove);
  const renameCollection = useMarks((s) => s.rename);
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const is = (s: FontShelf) => fontShelfKey(s) === fontShelfKey(shelf);
  const item = (s: FontShelf, icon: React.ReactNode, label: string, count?: number) => (
    <RailItem key={fontShelfKey(s)} icon={icon} label={label} count={count} active={is(s)} onClick={() => onSelect(s)} />
  );

  return (
    <nav className="flex min-h-0 w-full flex-col shell-card p-1.5">
      <ScrollArea className="min-h-0 flex-1">
        {item({ kind: "all" }, <Layers />, "All fonts", counts.all)}
        {item({ kind: "starred" }, <Star />, "Starred", counts.starred)}
        {item({ kind: "recent" }, <Clock />, "Recent", counts.recent)}
        {item({ kind: "project" }, <FileText />, "In this project", counts.project)}

        <RailSection label="Sources" action={{ icon: <Plus />, label: "Upload fonts", onClick: onUpload }} />
        {item({ kind: "source", id: "yours" }, <Upload />, "Your fonts", counts.yours)}
        {item({ kind: "source", id: "system" }, <HardDrive />, "On this device", counts.system)}
        {item({ kind: "source", id: "google" }, <Sparkles />, "Google Fonts", counts.google)}

        <RailSection label="Categories" />
        {FONT_CATEGORIES.map((c) =>
          item(
            { kind: "category", id: c.id },
            <span className="text-2xs leading-none" style={CATEGORY_FACE[c.id]}>
              {CATEGORY_ICON[c.id]}
            </span>,
            c.label,
            categoryCount(c.id),
          ),
        )}

        <RailSection
          label="Collections"
          action={{
            icon: <FolderPlus />,
            label: "New collection",
            onClick: () => {
              const id = newCollection("Untitled");
              onSelect({ kind: "collection", id });
              setRenaming(id);
            },
          }}
        />
        {marks.collections.map((c) =>
          renaming === c.id ? (
            <div key={c.id} className="px-1 py-0.5 pl-2">
              <RenameInput
                initial={c.name}
                className="h-7 w-full rounded border border-primary/60 bg-input/45 px-1.5 text-xs outline-none"
                onCommit={(name) => {
                  if (name.trim()) renameCollection(c.id, name.trim());
                  setRenaming(null);
                }}
              />
            </div>
          ) : (
            <RailItem
              key={c.id}
              icon={<FolderPlus />}
              label={c.name}
              count={collectionCount(c, "font")}
              active={is({ kind: "collection", id: c.id })}
              onClick={() => onSelect({ kind: "collection", id: c.id })}
              onDoubleClick={() => setRenaming(c.id)}
              menu={
                <>
                  <ContextMenuItem onSelect={() => setRenaming(c.id)}>
                    <Pencil /> Rename
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    className="text-destructive focus:text-destructive"
                    onSelect={() => {
                      removeCollection(c.id);
                      if (is({ kind: "collection", id: c.id })) onSelect({ kind: "all" });
                    }}
                  >
                    <Trash2 /> Delete collection
                  </ContextMenuItem>
                </>
              }
            />
          ),
        )}
      </ScrollArea>
    </nav>
  );
}

/* --------------------------------------------------------------- filters */

function Chip({
  on,
  count,
  onClick,
  children,
}: {
  on: boolean;
  count?: number;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      disabled={!on && count === 0}
      className={cn(
        "flex h-6 shrink-0 items-center gap-1 rounded-(--r-sm) px-2.5 text-xs transition-colors disabled:opacity-35",
        on ? "material-glass-raised text-primary" : "bg-foreground/[0.05] text-muted-foreground hover:bg-foreground/[0.09] hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function FilterBar({
  filters,
  onChange,
  feelingCounts,
  scripts,
  styles,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
  feelingCounts: Map<string, number>;
  scripts: Array<[string, number]>;
  styles: Array<[string, number]>;
}) {
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {/* The scroller is INSIDE the row, so the selects beside it never scroll away. */}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [mask-image:linear-gradient(90deg,#000_92%,transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {FEELINGS.map((f) => (
          <Chip
            key={f}
            on={filters.feelings.includes(f)}
            count={feelingCounts.get(f) ?? 0}
            onClick={() => onChange({ ...filters, feelings: toggle(filters.feelings, f) })}
          >
            {f}
          </Chip>
        ))}
      </div>
      <Select
        value={filters.styles[0] ?? "__any"}
        onValueChange={(v) => onChange({ ...filters, styles: v === "__any" ? [] : [v] })}
      >
        <SelectTrigger className={cn("h-6 w-auto shrink-0 gap-1 rounded-(--r-sm) px-2.5 text-xs", filters.styles.length && "text-primary")} aria-label="Style">
          <SelectValue placeholder="Style" />
        </SelectTrigger>
        <SelectContent className="max-h-80">
          <SelectItem value="__any">Any style</SelectItem>
          {styles.map(([s, n]) => (
            <SelectItem key={s} value={s}>
              {s} <span className="ml-1 text-muted-foreground tabular-nums">{n}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={filters.script ?? "__any"}
        onValueChange={(v) => onChange({ ...filters, script: v === "__any" ? null : v })}
      >
        <SelectTrigger className={cn("h-6 w-auto shrink-0 gap-1 rounded-(--r-sm) px-2.5 text-xs", filters.script && "text-primary")} aria-label="Language">
          <SelectValue placeholder="Language" />
        </SelectTrigger>
        <SelectContent className="max-h-80">
          <SelectItem value="__any">Any language</SelectItem>
          {scripts.map(([s, n]) => (
            <SelectItem key={s} value={s}>
              {scriptLabel(s)} <span className="ml-1 text-muted-foreground tabular-nums">{n}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Chip on={filters.variableOnly} onClick={() => onChange({ ...filters, variableOnly: !filters.variableOnly })}>
        Variable
      </Chip>
      <Chip on={filters.italicOnly} onClick={() => onChange({ ...filters, italicOnly: !filters.italicOnly })}>
        <span className="italic">Italic</span>
      </Chip>
      {filtersActive(filters) && (
        <button
          type="button"
          aria-label="Clear filters"
          onClick={() => onChange(NO_FILTERS)}
          className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
        >
          <X />
        </button>
      )}
    </div>
  );
}

function EmptyShelf({
  shelf,
  searching,
  loading,
  onReset,
  onUpload,
}: {
  shelf: FontShelf;
  searching: boolean;
  loading: boolean;
  onReset: () => void;
  onUpload: () => void;
}) {
  let text = "Nothing here yet.";
  let action: React.ReactNode = null;
  if (loading) text = "Loading fonts…";
  else if (searching) {
    text = "No font matches.";
    action = <EmptyAction onClick={onReset}>Clear search and filters</EmptyAction>;
  } else if (shelf.kind === "starred") text = "Star a font and it lives here.";
  else if (shelf.kind === "recent") text = "Fonts you use show up here.";
  else if (shelf.kind === "project") text = "This project doesn't set any text yet.";
  else if (shelf.kind === "collection") text = "Right-click a font to add it here.";
  else if (shelf.kind === "source" && shelf.id === "yours") {
    text = "Your own fonts, on every project.";
    action = (
      <EmptyAction onClick={onUpload}>
        <Upload className="size-3.5" /> Upload fonts
      </EmptyAction>
    );
  } else if (shelf.kind === "source" && shelf.id === "system") text = "This browser can't list your installed fonts.";
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <p className="text-sm text-muted-foreground">{text}</p>
      {action}
    </div>
  );
}

function EmptyAction({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-(--control-h) items-center gap-1.5 rounded-md px-3 text-xs font-medium material-glass-raised text-primary hover:brightness-110"
    >
      {children}
    </button>
  );
}
