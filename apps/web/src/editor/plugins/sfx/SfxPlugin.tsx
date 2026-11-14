"use client";

import * as React from "react";
import {
  SOUND_CATEGORY_LABELS,
  collectionCount,
  guardTrimDb,
  idsWithVerdict,
  verdictOf,
  type IndexPack,
  type LibraryItem,
  type LibrarySort,
  type SoundCategory,
} from "@solomotion/core";
import {
  Clock,
  Copy,
  Download,
  EarOff,
  FolderPlus,
  Pencil,
  Layers,
  Link2,
  Loader2,
  Music,
  Pause,
  Play,
  RefreshCw,
  Repeat,
  Repeat1,
  RotateCcw,
  Search,
  Shield,
  SkipBack,
  SkipForward,
  Sliders,
  Star,
  ThumbsDown,
  Volume2,
  WifiOff,
  X,
} from "lucide-react";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { NumberInput } from "@/components/ui/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Range } from "@/components/ui/range";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { RailItem, RailSection } from "@/components/ui/rail-list";
import { RenameInput } from "@/components/ui/rename-input";
import { collectionDropProps, useCollectionDrop } from "../../library/collection-drop";
import { useAuditionPrefs } from "../../library/audition-prefs";
import { useVirtualRows } from "@/components/ui/use-virtual-rows";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { PeaksWave } from "../../library/PeaksWave";
import { MarkMenu } from "../../library/MarkMenu";
import { libraryClient } from "../../library/client";
import { libraryDragFor } from "../../library/library-actions";
import { DRAG_OUT_PROPS, DRAG_OUT_SURFACE, useDragOut } from "../../panels/drag-out";
import { usePluginWindows } from "../plugin-windows";
import { useDocStore } from "../../state/document-context";
import { useMarks, useMarksState } from "../../state/marks";
import { placeLibrarySound } from "./sound-place";
import { parseShelf, shelfKey, useSfxPrefs, type SfxShelf } from "./sfx-store";
import {
  packsBySize,
  refreshSoundCatalogue,
  soundMark,
  useSoundCategories,
  useSoundItems,
  useSoundPacks,
  useTopPacks,
} from "./use-sfx";
import { useAudition, type AuditionSound } from "./use-audition";

/**
 * THE SOUND BROWSER — every sound effect in the catalogue, one row at a time.
 *
 * Why this is a LIST and the library is a grid: sound is read in series. You
 * cannot glance at eight sounds the way you glance at eight icons — you play
 * one, then the next, then back — so the surface that works is a queue with a
 * transport, not a wall of tiles. The data underneath is the same catalogue,
 * the same `LibraryClient`, the same matcher and the same marks; only the
 * question being asked is different.
 *
 * The layout is the app's rail grammar (`Rail | shell-card`), the same one the
 * Icons and Variables windows use, so nothing here has to be learned twice.
 *
 * KEYBOARD. The window declares `data-capture-keys`, which is the app's
 * existing opt-in for "this surface owns raw keystrokes" — so Space plays a
 * SOUND here and never reaches the global playback shortcut. That is a seam
 * that already existed, claimed, not a new one invented for this panel.
 */

const ROW_H = 44;

/**
 * An icon button that explains itself.
 *
 * `title` is the browser's tooltip, and it is the wrong control here: it waits
 * a second, it is unstyled, it cannot hold a keyboard hint, and on touch it
 * never appears at all. Every icon-only control in this panel goes through the
 * app's own `Tooltip`, and the `aria-label` comes along for free because the
 * two are the same string.
 */
function Hint({ label, children }: { label: React.ReactNode; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export default function SfxPlugin() {
  const prefs = useSfxPrefs();
  const monitor = useAuditionPrefs();
  const shelf = React.useMemo(() => parseShelf(prefs.shelf), [prefs.shelf]);
  const [query, setQuery] = React.useState("");

  // Opened WITH a question — the Library handing its search box over, and one
  // day a filter. Keyed on the intent's token rather than its contents, so
  // being handed the same query twice still re-aims the panel: the second time
  // is exactly when someone is sure it should work.
  const intent = usePluginWindows((s) => s.intents.sfx);
  React.useEffect(() => {
    if (!intent) return;
    if (intent.params.q !== undefined) setQuery(intent.params.q);
    if (intent.params.shelf !== undefined) useSfxPrefs.getState().set({ shelf: intent.params.shelf });
  }, [intent?.at]);
  const { packs, loading: packsLoading, error, retry } = useSoundPacks();
  const { items, loading } = useSoundItems(query);
  const { startDragOut: beginDrag, ghostNode } = useDragOut();
  // Every row that can be dragged onto the timeline can also be dropped into a
  // collection in the rail beside it. One wrapper, shared with the icons browser.
  const { startDragOut, dropId } = useCollectionDrop(beginDrag);

  const sounds = React.useMemo<AuditionSound[]>(() => {
    const client = libraryClient();
    return items
      .filter((i) => i.blob && client)
      .map((i) => ({
        id: i.id,
        url: client!.url(i.blob!.path),
        durationMs: i.preview.type === "peaks" ? i.preview.durationMs : 0,
        loudnessDb: i.preview.type === "peaks" ? i.preview.loudnessDb : null,
        bytes: i.blob!.bytes,
      }));
  }, [items]);

  const audition = useAudition({
    sounds,
    loop: prefs.loop,
    volume: monitor.volume,
    guard: monitor.guard,
    preload: prefs.preload,
  });

  const current = React.useMemo(
    () => items.find((i) => i.id === audition.currentId) ?? null,
    [items, audition.currentId],
  );

  const store = useDocStore();
  const place = React.useCallback(
    (item: LibraryItem) => {
      placeLibrarySound(store, item, prefs.drop, monitor.guard);
      prefs.noteUsed(item.id);
      toast(`${item.name} → timeline`);
    },
    [store, prefs],
  );

  // Selecting with the keyboard auditions as you go — which is what browsing a
  // sound library IS. `autoPlay` off turns the arrows into pure navigation.
  const moveSelection = React.useCallback(
    (delta: number) => {
      if (prefs.autoPlay) {
        delta > 0 ? audition.next() : audition.prev();
        return;
      }
      const at = items.findIndex((i) => i.id === audition.currentId);
      const next = items[Math.max(0, Math.min(items.length - 1, at + delta))];
      if (next) audition.play(next.id);
    },
    [prefs.autoPlay, audition, items],
  );

  const mark = useMarks((s) => s.mark);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // A field inside the panel keeps its own keys — the search box must be
    // typeable, and "s" must not star a sound while someone spells "swoosh".
    if ((e.target as HTMLElement).closest("input, textarea, [contenteditable]")) {
      if (e.key === "Escape") (e.target as HTMLElement).blur();
      return;
    }
    const hit = (fn: () => void) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    switch (e.key) {
      case " ":
        return hit(() => audition.toggle());
      case "ArrowDown":
        return hit(() => moveSelection(1));
      case "ArrowUp":
        return hit(() => moveSelection(-1));
      case "ArrowRight":
        return hit(() => audition.nudge(e.shiftKey ? 5 : 1));
      case "ArrowLeft":
        return hit(() => audition.nudge(e.shiftKey ? -5 : -1));
      case "Enter":
        return current ? hit(() => place(current)) : undefined;
      case "s":
      case "S":
        return current ? hit(() => mark(soundMark(current.id), "starred")) : undefined;
      case "d":
      case "D":
        return current ? hit(() => mark(soundMark(current.id), "disliked")) : undefined;
      case "l":
      case "L":
        return hit(() =>
          prefs.set({ loop: prefs.loop === "off" ? "all" : prefs.loop === "all" ? "one" : "off" }),
        );
      case "Escape":
        return hit(() => audition.stop());
    }
  };

  // A keyboard handler on an element nothing ever focuses is a keyboard handler
  // that never runs. Clicking a ROW does not focus anything (a row is a div, and
  // its buttons blur the moment the pointer leaves), so the panel claims focus
  // itself on any press inside it and on open. Without this, every shortcut
  // below silently does nothing — which is exactly what it did the first time.
  const rootRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      ref={rootRef}
      // The app's existing "this surface owns raw keystrokes" opt-in. Without
      // it, Space would reach the global shortcut and toggle TIMELINE playback
      // while you are auditioning a sound.
      data-capture-keys=""
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerDownCapture={(e) => {
        // Never steal focus from something that wants it — the search box, a
        // number field, an open menu.
        const el = e.target as HTMLElement;
        if (el.closest("input, textarea, [contenteditable], [role='menu']")) return;
        rootRef.current?.focus({ preventScroll: true });
      }}
      className="flex min-h-0 flex-1 gap-2 bg-background p-2 outline-none"
    >
      <div className="hidden w-52 shrink-0 @[640px]:flex">
        <Rail
          packs={packs}
          shelf={shelf}
          dropId={dropId}
          onSelect={(s) => useSfxPrefs.getState().set({ shelf: shelfKey(s) })}
        />
      </div>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col shell-card">
        <Header query={query} onQuery={setQuery} shelf={shelf} packs={packs} />
        {error ? (
          <Offline retry={retry} />
        ) : loading || packsLoading ? (
          <Busy />
        ) : shelf.kind === "packs" && !query ? (
          <PackShelf packs={packs} onOpen={(id) => useSfxPrefs.getState().set({ shelf: `pack:${id}` })} />
        ) : items.length === 0 ? (
          <Empty shelf={shelf} query={query} />
        ) : (
          <SoundList
            items={items}
            audition={audition}
            onPlace={place}
            startDragOut={startDragOut}
          />
        )}
        <Player item={current} audition={audition} onPlace={place} />
      </section>
      {ghostNode}
    </div>
  );
}

/* ---------------------------------------------------------------------- rail */

function Rail({
  packs,
  shelf,
  dropId,
  onSelect,
}: {
  packs: IndexPack[];
  shelf: SfxShelf;
  /** The collection a drag is hovering, drawn as a drop ring. */
  dropId: string | null;
  onSelect: (s: SfxShelf) => void;
}) {
  const marks = useMarksState();
  const newCollection = useMarks((s) => s.newCollection);
  const removeCollection = useMarks((s) => s.remove);
  const renameCollection = useMarks((s) => s.rename);
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const recent = useSfxPrefs((s) => s.recent);
  const categories = useSoundCategories(packs);
  const starred = idsWithVerdict(marks, "starred", "library").length;
  const disliked = idsWithVerdict(marks, "disliked", "library").length;
  const is = (s: SfxShelf) => shelfKey(shelf) === shelfKey(s);
  const shortlist = useTopPacks(packs);

  return (
    <nav className="flex min-h-0 w-full flex-col shell-card p-1.5">
      <ScrollArea className="min-h-0 flex-1">
        <RailItem
          icon={<Layers />}
          label="All packs"
          count={packs.length}
          active={is({ kind: "packs" })}
          onClick={() => onSelect({ kind: "packs" })}
        />
        <RailItem
          icon={<Clock />}
          label="Recent"
          count={recent.length}
          active={is({ kind: "recent" })}
          onClick={() => onSelect({ kind: "recent" })}
        />
        <RailItem
          icon={<Star />}
          label="Starred"
          count={starred}
          active={is({ kind: "starred" })}
          onClick={() => onSelect({ kind: "starred" })}
        />
        <RailItem
          icon={<ThumbsDown />}
          label="Disliked"
          count={disliked}
          active={is({ kind: "disliked" })}
          onClick={() => onSelect({ kind: "disliked" })}
        />

        {categories.length > 0 && <RailSection label="Categories" />}
        {categories.map((c) => (
          <RailItem
            key={c.id}
            icon={<Music />}
            label={SOUND_CATEGORY_LABELS[c.id as SoundCategory] ?? c.id}
            count={c.sounds}
            active={is({ kind: "category", id: c.id })}
            onClick={() => onSelect({ kind: "category", id: c.id })}
          />
        ))}

        <RailSection
          label="Collections"
          action={{
            icon: <FolderPlus />,
            label: "New collection",
            // Make it, then name it. A `window.prompt` is a modal browser
            // dialog that steals focus, cannot be styled, cannot be cancelled
            // with anything but its own button, and asks for the one thing the
            // user has not decided yet — what an empty collection is called.
            // Creating it and opening the row for editing is the same number
            // of keystrokes and leaves something behind if you walk away.
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
                onCommit={(name) => {
                  if (name.trim()) renameCollection(c.id, name.trim());
                  setRenaming(null);
                }}
              />
            </div>
          ) : (
            // The drop target is the wrapper, not the button: the pointer-drag
            // system hit-tests with `elementFromPoint`, and a row's label or
            // count would otherwise be a hole in its own collection.
            <div key={c.id} {...collectionDropProps(c.id)}>
              <RailItem
                icon={<FolderPlus />}
                label={c.name}
                count={collectionCount(c, "library")}
                active={is({ kind: "collection", id: c.id })}
                onClick={() => onSelect({ kind: "collection", id: c.id })}
                onDoubleClick={() => setRenaming(c.id)}
                onDropActive={dropId === c.id}
                menu={
                  <>
                    <ContextMenuItem onSelect={() => setRenaming(c.id)}>
                      <Pencil />
                      Rename
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      className="text-destructive focus:text-destructive"
                      onSelect={() => removeCollection(c.id)}
                    >
                      <X />
                      Delete “{c.name}”
                    </ContextMenuItem>
                  </>
                }
              />
            </div>
          ),
        )}

        {shortlist.length > 0 && <RailSection label="Packs" />}
        {shortlist.map((p) => (
          <RailItem
            key={p.id}
            icon={<Music />}
            label={p.title}
            count={p.itemCount}
            active={is({ kind: "pack", id: p.id })}
            onClick={() => onSelect({ kind: "pack", id: p.id })}
          />
        ))}
        {packs.length > shortlist.length && (
          <RailItem
            icon={<Layers />}
            label={`${packs.length - shortlist.length} more…`}
            active={false}
            onClick={() => onSelect({ kind: "packs" })}
          />
        )}
      </ScrollArea>
    </nav>
  );
}

/* -------------------------------------------------------------------- header */

const SORTS: Array<{ value: LibrarySort; label: string }> = [
  { value: "relevance", label: "Best match" },
  { value: "name", label: "Name" },
  { value: "newest", label: "Newest" },
];

function Header({
  query,
  onQuery,
  shelf,
  packs,
}: {
  query: string;
  onQuery: (q: string) => void;
  shelf: SfxShelf;
  packs: IndexPack[];
}) {
  const prefs = useSfxPrefs();
  const monitor = useAuditionPrefs();
  const where =
    shelf.kind === "pack"
      ? (packs.find((p) => p.id === shelf.id)?.title ?? "Pack")
      : shelf.kind === "category"
        ? (SOUND_CATEGORY_LABELS[shelf.id as SoundCategory] ?? shelf.id)
        : null;

  return (
    <header className="flex shrink-0 items-center gap-1.5 border-b border-border/50 px-2 py-1.5">
      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={where ? `Search ${where}…` : "Search every sound…"}
          className="h-[var(--control-h)] w-full rounded-md bg-muted/40 pl-7 pr-7 text-xs outline-none placeholder:text-muted-foreground/70 focus:bg-muted/60"
        />
        {query && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => onQuery("")}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      <Select value={prefs.sort} onValueChange={(v) => prefs.set({ sort: v as LibrarySort })}>
        <SelectTrigger aria-label="Sort" className="w-28 shrink-0 text-[11px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SORTS.map((s) => (
            <SelectItem key={s.value} value={s.value}>
              {s.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Hint label="Check for new packs">
        <button
          type="button"
          aria-label="Refresh catalogue"
          onClick={refreshSoundCatalogue}
          className="flex size-[var(--control-h)] items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        >
          <RefreshCw className="size-3.5" />
        </button>
      </Hint>

      <Settings />
    </header>
  );
}

/* ------------------------------------------------------------------ settings */

function Settings() {
  const prefs = useSfxPrefs();
  const monitor = useAuditionPrefs();
  return (
    <Popover>
      <Hint label="Sound settings">
        <PopoverTrigger
          aria-label="Sound settings"
          className="flex size-[var(--control-h)] items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        >
          <Sliders className="size-3.5" />
        </PopoverTrigger>
      </Hint>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
          <span className="text-xs font-medium">Sound settings</span>
          <Hint label="Every setting back to its default">
            <button
              type="button"
              // Reset means "this panel, back to defaults", and the monitor
              // level and guard are on this panel's screen even though they
              // are owned a layer below it.
              onClick={() => {
                prefs.reset();
                monitor.reset();
              }}
              className="flex items-center gap-1 rounded text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <RotateCcw className="size-3" />
              Reset
            </button>
          </Hint>
        </div>

        <div className="grid gap-2.5 px-3 py-2.5">
          <Row label="Protect my ears" hint="Ducks anything louder than the ceiling. Never makes a sound louder.">
            <Switch
              checked={monitor.guard.enabled}
              onCheckedChange={(enabled) => monitor.setGuard({ enabled })}
            />
          </Row>
          {monitor.guard.enabled && (
            <Row label="Ceiling" hint="Perceived loudness, in dB.">
              <NumberInput
                value={monitor.guard.ceilingDb}
                onChange={(ceilingDb) => monitor.setGuard({ ceilingDb })}
                min={-40}
                max={0}
                step={1}
                unit="dB"
              />
            </Row>
          )}

          <Row label="Preload next" hint="Warms the sounds ahead of you, one at a time, only while you keep listening.">
            <Switch
              checked={prefs.preload.enabled}
              onCheckedChange={(enabled) => prefs.setPreload({ enabled })}
            />
          </Row>
          <Row label="Play on select" hint="Arrow keys audition as they move.">
            <Switch checked={prefs.autoPlay} onCheckedChange={(autoPlay) => prefs.set({ autoPlay })} />
          </Row>

          <div className="mt-1 border-t border-border/50 pt-2 text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground/70">
            When a sound lands
          </div>
          <Row label="Hit on playhead" hint="Starts the clip early so the sound STRIKES where you dropped it.">
            <Switch
              checked={prefs.drop.alignHit}
              onCheckedChange={(alignHit) => prefs.setDrop({ alignHit })}
            />
          </Row>
          <Row label="Fade in">
            <NumberInput
              value={prefs.drop.fadeInMs}
              onChange={(fadeInMs) => prefs.setDrop({ fadeInMs })}
              min={0}
              max={5000}
              step={10}
              unit="ms"
            />
          </Row>
          <Row label="Fade out">
            <NumberInput
              value={prefs.drop.fadeOutMs}
              onChange={(fadeOutMs) => prefs.setDrop({ fadeOutMs })}
              min={0}
              max={5000}
              step={10}
              unit="ms"
            />
          </Row>
          <Row label="Gain">
            <NumberInput
              value={prefs.drop.gainDb}
              onChange={(gainDb) => prefs.setDrop({ gainDb })}
              min={-24}
              max={12}
              step={0.5}
              unit="dB"
            />
          </Row>
          <Row label="Pitch">
            <NumberInput
              value={prefs.drop.pitchSemitones}
              onChange={(pitchSemitones) => prefs.setDrop({ pitchSemitones })}
              min={-24}
              max={24}
              step={1}
              unit="st"
            />
          </Row>
          <Row
            label="Match audition level"
            hint="Carries the ear guard's correction — not your monitoring volume — onto the clip."
          >
            <Switch
              checked={prefs.drop.matchAuditionLevel}
              onCheckedChange={(matchAuditionLevel) => prefs.setDrop({ matchAuditionLevel })}
            />
          </Row>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-[var(--control-h)] items-center gap-2">
      {hint ? (
        <Hint label={hint}>
          <span className="min-w-0 flex-1 cursor-help truncate text-xs text-muted-foreground decoration-dotted underline-offset-4 hover:underline">
            {label}
          </span>
        </Hint>
      ) : (
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{label}</span>
      )}
      <div className="w-28 shrink-0">{children}</div>
    </div>
  );
}

/* ----------------------------------------------------------------- pack shelf */

function PackShelf({ packs, onOpen }: { packs: IndexPack[]; onOpen: (id: string) => void }) {
  const ordered = React.useMemo(() => packsBySize(packs), [packs]);
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="grid gap-1.5 p-2 @[520px]:grid-cols-2">
        {ordered.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onOpen(p.id)}
            className="group flex flex-col gap-0.5 rounded-lg border border-border/50 px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
          >
            <span className="truncate text-xs font-medium group-hover:text-primary">{p.title}</span>
            {p.blurb && <span className="truncate text-[11px] text-muted-foreground">{p.blurb}</span>}
            <span className="mt-0.5 font-mono text-[10px] tabular-nums text-muted-foreground/60">
              {p.itemCount} sounds · {(p.bytes / 1e6).toFixed(1)} MB
              {p.publisher ? ` · ${p.publisher.name}` : ""}
            </span>
          </button>
        ))}
      </div>
    </ScrollArea>
  );
}

/* ----------------------------------------------------------------------- list */

type Audition = ReturnType<typeof useAudition>;
type DragStarter = ReturnType<typeof useDragOut>["startDragOut"];

function SoundList({
  items,
  audition,
  onPlace,
  startDragOut,
}: {
  items: LibraryItem[];
  audition: Audition;
  onPlace: (item: LibraryItem) => void;
  startDragOut: DragStarter;
}) {
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const rows = useVirtualRows({ count: items.length, rowHeight: ROW_H, viewportRef });

  // Keep the armed row on screen when the keyboard moves it. Without this,
  // holding ArrowDown plays sounds you cannot see.
  React.useEffect(() => {
    const at = items.findIndex((i) => i.id === audition.currentId);
    const el = viewportRef.current;
    if (at < 0 || !el) return;
    const top = at * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  }, [audition.currentId, items]);

  return (
    <ScrollArea className="min-h-0 flex-1" viewportRef={viewportRef}>
      <div style={{ paddingTop: rows.padTop, paddingBottom: rows.padBottom }}>
        {items.slice(rows.start, rows.end).map((item) => (
          <SoundRow
            key={item.id}
            item={item}
            playing={audition.currentId === item.id && audition.playing}
            armed={audition.currentId === item.id}
            loading={audition.currentId === item.id && audition.loading}
            onToggle={() => audition.toggle(item.id)}
            onPlace={() => onPlace(item)}
            startDragOut={startDragOut}
          />
        ))}
      </div>
    </ScrollArea>
  );
}

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

function SoundRow({
  item,
  playing,
  armed,
  loading,
  onToggle,
  onPlace,
  startDragOut,
}: {
  item: LibraryItem;
  playing: boolean;
  armed: boolean;
  loading: boolean;
  onToggle: () => void;
  onPlace: () => void;
  startDragOut: DragStarter;
}) {
  const store = useDocStore();
  const marks = useMarksState();
  const mark = useMarks((s) => s.mark);
  const target = soundMark(item.id);
  const verdict = verdictOf(marks, target);
  const peaks = item.preview.type === "peaks" ? item.preview : null;

  return (
    <MarkMenu target={target} label={item.name} extra={<RowExtras item={item} onPlace={onPlace} />}>
      <div
        {...DRAG_OUT_PROPS}
        onPointerDown={(e) =>
          startDragOut(e, {
            drag: () => libraryDragFor(store, item),
            label: item.name,
            onClick: onToggle,
            // Drop it on a collection in the rail instead of on the timeline.
            collect: target,
          })
        }
        onDoubleClick={onPlace}
        style={{ height: ROW_H }}
        className={cn(
          "group flex cursor-grab items-center gap-2 px-2 transition-colors",
          DRAG_OUT_SURFACE,
          armed ? "material-glass-raised" : "hover:bg-muted/40",
          verdict === "disliked" && "opacity-45",
        )}
      >
        <button
          type="button"
          aria-label={playing ? `Pause ${item.name}` : `Play ${item.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-full transition-colors",
            armed ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
          )}
        >
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : playing ? (
            <Pause className="size-3.5 fill-current" />
          ) : (
            <Play className="size-3.5 fill-current" />
          )}
        </button>

        <div className="min-w-0 flex-[0_0_11rem]">
          <div className="truncate text-xs">{item.name}</div>
          <div className="truncate text-[10px] text-muted-foreground/70">
            {item.tags.slice(0, 3).join(" · ")}
          </div>
        </div>

        {peaks ? (
          <PeaksWave
            peaks={peaks.peaks}
            durationMs={peaks.durationMs}
            hitMs={peaks.hitMs}
            playing={playing}
            className={cn(
              "h-6 min-w-0 flex-1",
              armed ? "text-primary" : "text-muted-foreground/60",
            )}
          />
        ) : (
          <div className="min-w-0 flex-1" />
        )}

        <span className="w-12 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground/60">
          {peaks ? fmtMs(peaks.durationMs) : ""}
        </span>

        <button
          type="button"
          aria-label={verdict === "starred" ? "Unstar" : "Star"}
          aria-pressed={verdict === "starred"}
          onClick={(e) => {
            e.stopPropagation();
            mark(target, "starred");
          }}
          className={cn(
            "shrink-0 transition-opacity",
            verdict === "starred"
              ? "text-primary opacity-100"
              : "text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground",
          )}
        >
          <Star className={cn("size-3.5", verdict === "starred" && "fill-current")} />
        </button>
      </div>
    </MarkMenu>
  );
}

/** The surface-specific half of a row's context menu. */
function RowExtras({ item, onPlace }: { item: LibraryItem; onPlace: () => void }) {
  const url = item.blob ? libraryClient()?.url(item.blob.path) : null;
  const copy = (text: string, what: string) => {
    void navigator.clipboard.writeText(text).then(
      () => toast(`${what} copied`),
      () => toast(`Couldn’t copy the ${what.toLowerCase()}`),
    );
  };
  return (
    <>
      <ContextMenuItem onSelect={onPlace}>
        <Play />
        Add at playhead
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => copy(item.id, "Sound id")}>
        <Copy />
        Copy id
      </ContextMenuItem>
      {url && (
        <>
          <ContextMenuItem onSelect={() => copy(url, "Link")}>
            <Link2 />
            Copy link
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => {
              const a = document.createElement("a");
              a.href = url;
              a.download = `${item.name}.m4a`;
              a.click();
            }}
          >
            <Download />
            Download
          </ContextMenuItem>
        </>
      )}
    </>
  );
}

/* --------------------------------------------------------------------- player */

const LOOP_ICON = { off: Repeat, all: Repeat, one: Repeat1 } as const;
const LOOP_LABEL = { off: "Loop off", all: "Loop all", one: "Loop one" } as const;

function Player({
  item,
  audition,
  onPlace,
}: {
  item: LibraryItem | null;
  audition: Audition;
  onPlace: (item: LibraryItem) => void;
}) {
  const prefs = useSfxPrefs();
  const monitor = useAuditionPrefs();
  const marks = useMarksState();
  const mark = useMarks((s) => s.mark);
  const peaks = item?.preview.type === "peaks" ? item.preview : null;
  const verdict = item ? verdictOf(marks, soundMark(item.id)) : null;
  const LoopIcon = LOOP_ICON[prefs.loop];
  const trimDb = guardTrimDb(peaks?.loudnessDb ?? null, monitor.guard);

  const waveRef = React.useRef<HTMLDivElement>(null);
  const headRef = React.useRef<HTMLDivElement>(null);

  // The playhead is drawn from rAF against the engine's clock, never from
  // React state: re-rendering a 600-row list sixty times a second is the
  // fastest way to make a browser feel broken.
  React.useEffect(() => {
    if (!audition.playing || !peaks?.durationMs) return;
    let raf = 0;
    const tick = () => {
      const head = headRef.current;
      if (head) {
        const t = Math.max(0, Math.min(1, audition.positionMs() / peaks.durationMs));
        head.style.transform = `translateX(${t * 100}%)`;
        head.style.opacity = "1";
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      if (headRef.current) headRef.current.style.opacity = "0";
    };
  }, [audition, audition.playing, peaks?.durationMs]);

  const cycleLoop = () =>
    prefs.set({ loop: prefs.loop === "off" ? "all" : prefs.loop === "all" ? "one" : "off" });

  return (
    <footer className="grid shrink-0 gap-1.5 border-t border-border/50 px-2.5 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <Transport
          playing={audition.playing}
          onPrev={audition.prev}
          onToggle={() => audition.toggle()}
          onNext={audition.next}
        />

        <div
          ref={waveRef}
          onPointerDown={(e) => {
            const box = waveRef.current?.getBoundingClientRect();
            if (box && box.width) audition.seekTo((e.clientX - box.left) / box.width);
          }}
          className="relative h-9 min-w-0 flex-1 cursor-pointer overflow-hidden rounded-md bg-muted/30 px-1"
        >
          {peaks ? (
            <PeaksWave
              peaks={peaks.peaks}
              durationMs={peaks.durationMs}
              hitMs={peaks.hitMs}
              className="h-full w-full text-primary/70"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground">
              Pick a sound
            </div>
          )}
          <div
            ref={headRef}
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0 w-px bg-primary opacity-0"
          />
        </div>

        <Hint label={<>{LOOP_LABEL[prefs.loop]} · <b>L</b></>}>
        <button
          type="button"
          aria-label={LOOP_LABEL[prefs.loop]}
          aria-pressed={prefs.loop !== "off"}
          onClick={cycleLoop}
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md transition-colors",
            prefs.loop === "off"
              ? "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              : "material-glass-raised text-primary",
          )}
        >
          <LoopIcon className="size-3.5" />
        </button>
        </Hint>

        <Volume trimDb={trimDb} />
      </div>

      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-xs font-medium">{item?.name ?? "Nothing playing"}</span>
            {trimDb < -0.5 && (
              <Hint label={`Held ${Math.abs(trimDb).toFixed(0)} dB down so it does not hurt`}>
                <span className="flex shrink-0 cursor-help items-center gap-0.5 rounded material-chip px-1 font-mono text-[9px] tabular-nums text-muted-foreground">
                  <Shield className="size-2.5" />
                  {trimDb.toFixed(0)}
                </span>
              </Hint>
            )}
          </div>
          <div className="truncate font-mono text-[10px] tabular-nums text-muted-foreground/70">
            {peaks
              ? `${fmtMs(peaks.durationMs)} · hit ${fmtMs(peaks.hitMs)}${
                  peaks.loudnessDb != null ? ` · ${peaks.loudnessDb.toFixed(1)} dB` : ""
                }${item?.publisher ? ` · ${item.publisher.name}` : ""}`
              : "Space plays · ↑↓ moves · ←→ scrubs · ⏎ adds"}
          </div>
        </div>

        {item && (
          <>
            <IconToggle
              label={<>{verdict === "starred" ? "Unstar" : "Star"} · <b>S</b></>}
              active={verdict === "starred"}
              onClick={() => mark(soundMark(item.id), "starred")}
            >
              <Star className={cn("size-3.5", verdict === "starred" && "fill-current")} />
            </IconToggle>
            <IconToggle
              label={<>{verdict === "disliked" ? "Undo dislike" : "Dislike — hide it everywhere"} · <b>D</b></>}
              active={verdict === "disliked"}
              onClick={() => mark(soundMark(item.id), "disliked")}
            >
              <ThumbsDown className={cn("size-3.5", verdict === "disliked" && "fill-current")} />
            </IconToggle>
            <Hint label={<>Add at the playhead · <b>⏎</b></>}>
              <button
                type="button"
                onClick={() => onPlace(item)}
                className="h-7 shrink-0 rounded-md material-glass px-2.5 text-[11px] transition-colors hover:text-primary"
              >
                Add
              </button>
            </Hint>
          </>
        )}
      </div>
    </footer>
  );
}

function Transport({
  playing,
  onPrev,
  onToggle,
  onNext,
}: {
  playing: boolean;
  onPrev: () => void;
  onToggle: () => void;
  onNext: () => void;
}) {
  const btn =
    "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground";
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Hint label={<>Previous · <b>↑</b></>}>
        <button type="button" aria-label="Previous" onClick={onPrev} className={btn}>
          <SkipBack className="size-3.5" />
        </button>
      </Hint>
      <Hint label={<>{playing ? "Pause" : "Play"} · <b>Space</b></>}>
        <button
          type="button"
          aria-label={playing ? "Pause" : "Play"}
          onClick={onToggle}
          className="flex size-8 shrink-0 items-center justify-center rounded-full material-glass-raised text-primary transition-colors"
        >
          {playing ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current" />}
        </button>
      </Hint>
      <Hint label={<>Next · <b>↓</b></>}>
        <button type="button" aria-label="Next" onClick={onNext} className={btn}>
          <SkipForward className="size-3.5" />
        </button>
      </Hint>
    </div>
  );
}

function Volume({ trimDb }: { trimDb: number }) {
  const prefs = useSfxPrefs();
  const monitor = useAuditionPrefs();
  const guarded = monitor.guard.enabled;
  return (
    <div className="flex w-36 shrink-0 items-center gap-1.5">
      <Hint
        label={
          guarded
            ? `Protecting your ears — nothing plays louder than ${monitor.guard.ceilingDb} dB`
            : "Ear guard off — loud sounds play at full level"
        }
      >
        <button
          type="button"
          aria-label={guarded ? "Ear guard on" : "Ear guard off"}
          aria-pressed={guarded}
          onClick={() => monitor.setGuard({ enabled: !guarded })}
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md transition-colors",
            guarded
              ? "material-glass-raised text-primary"
              : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
          )}
        >
          {guarded ? <Shield className="size-3.5" /> : <EarOff className="size-3.5" />}
        </button>
      </Hint>
      <Range
        aria-label="Volume"
        value={monitor.volume}
        onChange={(volume) => monitor.setVolume(volume)}
        min={0}
        max={1}
        step={0.01}
        className="min-w-0 flex-1"
      />
      <Volume2
        className={cn("size-3 shrink-0", trimDb < -0.5 ? "text-primary" : "text-muted-foreground/50")}
      />
    </div>
  );
}

function IconToggle({
  label,
  active,
  onClick,
  children,
}: {
  label: React.ReactNode;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Hint label={label}>
      <button
        type="button"
        aria-label={typeof label === "string" ? label : undefined}
        aria-pressed={active}
        onClick={onClick}
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md transition-colors",
          active ? "text-primary" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
        )}
      >
        {children}
      </button>
    </Hint>
  );
}

/* ---------------------------------------------------------------------- empty */

function Empty({ shelf, query }: { shelf: SfxShelf; query: string }) {
  const text = query
    ? "Nothing matches."
    : shelf.kind === "starred"
      ? "Star a sound to keep it here."
      : shelf.kind === "disliked"
        ? "Sounds you dislike are hidden everywhere else, and listed here."
        : shelf.kind === "recent"
          ? "Sounds you add show up here."
          : shelf.kind === "collection"
            ? "Right-click any sound to add it."
            : "Nothing here yet.";
  return <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">{text}</div>;
}

function Busy() {
  return (
    <div className="flex flex-1 items-center justify-center text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
    </div>
  );
}

function Offline({ retry }: { retry: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
      <WifiOff className="size-5" />
      <span>The sound catalogue is unreachable.</span>
      <button
        type="button"
        onClick={retry}
        className="rounded-md material-glass px-2.5 py-1 text-[11px] transition-colors hover:text-primary"
      >
        Try again
      </button>
    </div>
  );
}
