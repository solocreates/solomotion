"use client";

import * as React from "react";
import {
  BRUSH_FAMILIES,
  FAMILY_LABEL,
  type BrushEngine,
  type BrushFamily,
  type BrushPreset,
} from "@solomotion/core";
import {
  Brush,
  Clock,
  Eraser,
  Folder,
  FolderPlus,
  Layers,
  Palette,
  Pencil,
  PenLine,
  PenTool,
  Plus,
  Sparkles,
  Spline,
  SprayCan,
  Star,
  Trash2,
  Copy,
  RotateCcw,
  Wand2,
  Zap,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { RailItem, RailSection } from "@/components/ui/rail-list";
import { RenameInput } from "@/components/ui/rename-input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useVirtualRows } from "@/components/ui/use-virtual-rows";
import { cn } from "@/lib/utils";
import { useIsFavorite, useWorkspace } from "../state/workspace";
import { useBrushLibrary, useDrawing, type BrushSlot } from "../drawing/drawing-store";
import { useBrushThumb } from "../drawing/brush-thumbs";

/**
 * THE brush browser — one two-pane library behind the pixel picker, the vector
 * picker and the eraser's picker.
 *
 * It is one component taking an `engine`, not three that look alike, because
 * the two libraries are the same library: the same folders, the same stars, the
 * same right-click, the same search. The only thing an engine changes is which
 * brushes are in the list and which shelves have anything on them — so that is
 * the only thing this takes as a prop.
 *
 * SHAPE. A sidebar of SETS on the left, full-width brush rows on the right,
 * each pane its own scroller and its own rounded surface on the app's shared
 * radius. A brush's identity is a STROKE, not an icon, so a row gives the
 * preview the whole width it can have — you choose a brush by recognising its
 * mark, and a 56px square cannot show you a taper.
 *
 * SPEED. Rows are virtualised and thumbnails are asynchronous (`brush-thumbs`),
 * so opening the library mounts a dozen rows and queues a dozen strokes rather
 * than running the engine ninety times before the first frame. Scrolling a
 * hundred brushes costs the same as scrolling ten.
 */

/** The sidebar's icon per family — a set you can find without reading. */
const FAMILY_ICON: Record<BrushFamily, React.ComponentType<{ className?: string }>> = {
  sketching: Pencil,
  inking: PenTool,
  painting: Brush,
  airbrushing: SprayCan,
  calligraphy: PenLine,
  texture: Layers,
  artistic: Palette,
  elements: Sparkles,
  abstract: Zap,
  retouch: Eraser,
  vector: Spline,
};

/**
 * A SET is anything the sidebar can select — a smart shelf, a family, or one of
 * the artist's folders. One union, so the list pane never asks *what kind* of
 * shelf it is showing: it asks a set to filter the brushes and renders whatever
 * comes back.
 */
type SetId = `all` | `starred` | `recent` | `edited` | `mine` | `family:${string}` | `folder:${string}`;

interface BrushSet {
  id: SetId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  match: (b: BrushPreset) => boolean;
  /** User folders can be renamed and deleted; smart shelves cannot. */
  folderId?: string;
}

const ROW_H = 74;
/**
 * The preview strip, in CSS px — and the thumbnail is rendered at exactly this
 * size, not a larger one scaled down. Rendering at 48 and displaying at 32 made
 * every brush a third thinner than it paints, which is the one thing a preview
 * must never do.
 */
const STRIP_W = 320;
const STRIP_H = 32;

export function BrushBrowser({
  engine,
  activeId,
  onPick,
  onEdit,
  className,
}: {
  engine: BrushEngine;
  activeId?: string;
  onPick: (brush: BrushPreset) => void;
  /** Open one in the studio. */
  onEdit: (brush: BrushPreset) => void;
  className?: string;
}) {
  const lib = useBrushLibrary();
  const pressure = useDrawing((s) => s.pressure);
  const isFavorite = useIsFavorite();
  const toggleFavorite = useWorkspace((s) => s.toggleFavorite);
  const [renamingId, setRenamingId] = React.useState<string | null>(null);

  // Open where you left off, and — the first time — on the shelf the armed
  // brush actually lives in. Landing on "All brushes" every time means
  // scrolling past ninety to reach the four you are using.
  const [set, setSetRaw] = React.useState<SetId>(() => {
    const remembered = lib.lastSet[engine];
    if (remembered) return remembered as SetId;
    const armed = activeId ? lib.brushById(activeId) : null;
    return armed ? (`family:${armed.family}` as SetId) : "all";
  });
  const setSet = React.useCallback(
    (next: SetId) => {
      setSetRaw(next);
      lib.setLastSet(engine, next);
    },
    [lib, engine],
  );
  const [query, setQuery] = React.useState("");
  const viewportRef = React.useRef<HTMLDivElement>(null);

  const brushes = React.useMemo(
    () => lib.allBrushes().filter((b) => b.engine === engine),
    [lib, engine],
  );

  /** Which sets have anything in them — an empty shelf is never offered. */
  const sets = React.useMemo<BrushSet[]>(() => {
    const families = BRUSH_FAMILIES.filter((f) => brushes.some((b) => b.family === f));
    return [
      { id: "all", label: "All brushes", icon: Brush, match: () => true },
      { id: "starred", label: "Starred", icon: Star, match: (b) => isFavorite(b.id) },
      { id: "recent", label: "Recent", icon: Clock, match: (b) => lib.recent.includes(b.id) },
      { id: "edited", label: "Customised", icon: Wand2, match: (b) => lib.isCustomized(b.id) },
      { id: "mine", label: "My brushes", icon: Sparkles, match: (b) => !b.builtIn },
      ...families.map<BrushSet>((f) => ({
        id: `family:${f}`,
        label: FAMILY_LABEL[f],
        icon: FAMILY_ICON[f],
        match: (b) => b.family === f,
      })),
      ...lib.folders.map<BrushSet>((f) => ({
        id: `folder:${f.id}`,
        label: f.name,
        icon: Folder,
        folderId: f.id,
        match: (b) => f.brushIds.includes(b.id),
      })),
    ];
  }, [brushes, isFavorite, lib]);

  const active = sets.find((s) => s.id === set) ?? sets[0]!;

  const shown = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = (b: BrushPreset) =>
      !q ||
      b.name.toLowerCase().includes(q) ||
      (b.group ?? "").toLowerCase().includes(q) ||
      FAMILY_LABEL[b.family].toLowerCase().includes(q);
    const list = brushes.filter((b) => hit(b) && active.match(b));
    // Recents keep their own order — that is the whole point of the shelf.
    if (active.id === "recent") {
      return [...list].sort((a, b) => lib.recent.indexOf(a.id) - lib.recent.indexOf(b.id));
    }
    return list;
  }, [brushes, query, active, lib.recent]);

  const rows = useVirtualRows({ count: shown.length, rowHeight: ROW_H, viewportRef });

  return (
    <div className={cn("flex min-h-0 gap-2 bg-background p-2", className)}>
      {/* The rail lives OUTSIDE the list it filters — the app's rule everywhere. */}
      <aside className="flex min-h-0 w-48 shrink-0 flex-col shell-card">
        <ScrollArea className="min-h-0 flex-1" viewportClassName="p-2">
          {sets.map((set, i) => {
            const previous = sets[i - 1];
            return (
              <React.Fragment key={set.id}>
                {set.id.startsWith("family:") && !previous?.id.startsWith("family:") && (
                  <RailSection label="Sets" />
                )}
                {set.id.startsWith("folder:") && !previous?.id.startsWith("folder:") && (
                  <RailSection
                    label="Folders"
                    action={{
                      icon: <FolderPlus />,
                      label: "New folder",
                      onClick: () => {
                        const folder = lib.addFolder("Folder");
                        setSet(`folder:${folder.id}`);
                        setRenamingId(folder.id);
                      },
                    }}
                  />
                )}
                <SetRow
                  set={set}
                  active={set.id === active.id}
                  count={brushes.filter(set.match).length}
                  renaming={renamingId === set.folderId}
                  onRename={setRenamingId}
                  onSelect={() => setSet(set.id)}
                />
              </React.Fragment>
            );
          })}
          {lib.folders.length === 0 && (
            <>
              <RailSection
                label="Folders"
                action={{
                  icon: <FolderPlus />,
                  label: "New folder",
                  onClick: () => {
                    const folder = lib.addFolder("Folder");
                    setSet(`folder:${folder.id}`);
                    setRenamingId(folder.id);
                  },
                }}
              />
              <p className="px-2 py-1.5 text-[11px] text-muted-foreground">No folders yet.</p>
            </>
          )}
        </ScrollArea>
      </aside>

      {/* ── Brushes ────────────────────────────────────────────────────── */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col shell-card">
        <header className="flex shrink-0 items-center gap-1.5 border-b border-border/50 p-2">
          <span className="hidden min-w-0 shrink truncate text-xs font-medium @[520px]:inline">
            {active.label}
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            spellCheck={false}
            className="h-(--control-h) min-w-0 flex-1 rounded-md border border-transparent bg-input/45 px-2 text-xs outline-none transition-colors hover:border-border focus:border-primary/60"
          />
          <button
            type="button"
            onClick={() => onEdit(lib.createBrush(engine))}
            className="flex h-(--control-h) items-center gap-1 rounded-md bg-primary/15 px-2 text-[11px] font-medium text-primary transition-colors hover:bg-primary/25 [&_svg]:size-3.5"
          >
            <Plus /> New
          </button>
        </header>

        <ScrollArea className="min-h-0 flex-1" viewportRef={viewportRef} viewportClassName="p-1.5">
          {shown.length === 0 ? (
            <p className="px-2 py-10 text-center text-[11px] text-muted-foreground">
              {query ? `Nothing matches “${query}”.` : "This set is empty."}
            </p>
          ) : (
            <>
              <div style={{ height: rows.padTop }} />
              {shown.slice(rows.start, rows.end).map((brush) => (
                <BrushRow
                  key={brush.id}
                  brush={brush}
                  active={brush.id === activeId}
                  pressure={pressure}
                  starred={isFavorite(brush.id)}
                  customised={lib.isCustomized(brush.id)}
                  onPick={() => onPick(brush)}
                  onEdit={() => onEdit(brush)}
                  onStar={() => toggleFavorite(brush.id)}
                />
              ))}
              <div style={{ height: rows.padBottom }} />
            </>
          )}
        </ScrollArea>

        <footer className="flex h-7 shrink-0 items-center gap-2 border-t border-border/50 px-2.5 text-[10px] text-muted-foreground">
          <span>{shown.length} shown</span>
          <span className="flex-1" />
          <span className="hidden @[420px]:inline">{brushes.length} in this library</span>
        </footer>
      </section>
    </div>
  );
}

/** One sidebar shelf — the app's rail item. Folders rename in place, like layers. */
function SetRow({
  set,
  active,
  count,
  renaming,
  onRename,
  onSelect,
}: {
  set: BrushSet;
  active: boolean;
  count: number;
  renaming?: boolean;
  onRename?: (id: string | null) => void;
  onSelect: () => void;
}) {
  const lib = useBrushLibrary();
  const Icon = set.icon;

  // A rename is an inline edit on the row, never a browser prompt: a modal that
  // steals focus to ask for a string is the thing every other rename in this
  // app already refuses to be.
  if (renaming && set.folderId) {
    return (
      <div className="flex h-8 w-full items-center gap-2 rounded-md pl-2 pr-2">
        <span className="flex size-4 shrink-0 items-center justify-center text-primary [&_svg]:size-3.5">
          <Icon />
        </span>
        <RenameInput
          initial={set.label}
          className="h-6 min-w-0 flex-1 rounded border border-primary/60 bg-input/45 px-1 text-xs outline-none"
          onCommit={(name) => {
            if (name.trim()) lib.renameFolder(set.folderId!, name.trim());
            onRename?.(null);
          }}
        />
      </div>
    );
  }

  return (
    <RailItem
      icon={<Icon />}
      label={set.label}
      count={count}
      active={active}
      onClick={onSelect}
      onDoubleClick={set.folderId ? () => onRename?.(set.folderId!) : undefined}
      menu={
        set.folderId ? (
          <>
            <ContextMenuItem onClick={() => onRename?.(set.folderId!)}>
              <Pencil /> Rename
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => lib.deleteFolder(set.folderId!)}
            >
              <Trash2 /> Delete folder
            </ContextMenuItem>
          </>
        ) : undefined
      }
    />
  );
}

/**
 * One brush, as a full-width row: its real stroke, its name, what it is.
 *
 * The thumbnail arrives asynchronously and the row renders a skeleton until it
 * does — which is what lets a hundred-brush set open instantly instead of
 * blocking on a hundred canvas encodes.
 */
function BrushRow({
  brush,
  active,
  pressure,
  starred,
  customised,
  onPick,
  onEdit,
  onStar,
}: {
  brush: BrushPreset;
  active: boolean;
  pressure: ReturnType<typeof useDrawing.getState>["pressure"];
  starred: boolean;
  customised: boolean;
  onPick: () => void;
  onEdit: () => void;
  onStar: () => void;
}) {
  const lib = useBrushLibrary();
  const eff = lib.effective(brush.id);
  const thumb = useBrushThumb({
    brush,
    width: STRIP_W,
    height: STRIP_H,
    size: eff.size,
    opacity: eff.opacity,
    pressure,
  });

  const row = (
    <div
      role="button"
      tabIndex={0}
      onClick={onPick}
      onDoubleClick={onEdit}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPick();
        }
      }}
      style={{ height: ROW_H - 6 }}
      className={cn(
        "group relative mb-1.5 flex w-full cursor-pointer flex-col justify-center overflow-hidden rounded-[--radius] border px-3 transition-colors",
        active
          ? "border-primary/70 bg-primary/5"
          : "border-transparent hover:border-border hover:bg-muted/30",
      )}
    >
      <div className="relative h-8 w-full">
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          // `contain`, never `cover`: a cropped sweep hides the taper, which is
          // often the whole difference between two brushes on this list.
          <img src={thumb} alt="" draggable={false} className="h-8 w-full object-contain object-left" />
        ) : (
          <div className="h-8 w-full animate-pulse rounded-[--radius] bg-foreground/5" />
        )}
      </div>
      <div className="flex items-center gap-1.5 pt-1">
        <span className={cn("min-w-0 truncate text-xs", active && "text-primary")}>{brush.name}</span>
        {customised && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="shrink-0 rounded-full bg-primary/15 px-1.5 text-[9px] leading-4 text-primary">
                Edited
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">Changed from the factory brush — right-click to reset</TooltipContent>
          </Tooltip>
        )}
        {!brush.builtIn && (
          <span className="shrink-0 rounded-full bg-foreground/10 px-1.5 text-[9px] leading-4 text-muted-foreground">
            Custom
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
          {brush.group ?? FAMILY_LABEL[brush.family]}
        </span>
        <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">{Math.round(eff.size)}px</span>
        <button
          type="button"
          aria-label={starred ? `Unstar ${brush.name}` : `Star ${brush.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onStar();
          }}
          className={cn(
            "shrink-0 rounded p-0.5 transition-opacity",
            starred ? "text-[#F5B843]" : "text-muted-foreground opacity-0 group-hover:opacity-100",
          )}
        >
          <Star className={cn("size-3", starred && "fill-current")} />
        </button>
      </div>
    </div>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onClick={onPick}>Use brush</ContextMenuItem>
        <ContextMenuItem onClick={onEdit}>
          <Wand2 /> Edit in Brush Studio
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => {
            const copy = lib.duplicateBrush(brush.id);
            if (copy) lib.openStudio(copy.id);
          }}
        >
          <Copy /> Duplicate
        </ContextMenuItem>
        <ContextMenuItem onClick={onStar}>
          <Star /> {starred ? "Unstar" : "Star"}
        </ContextMenuItem>
        {lib.folders.length > 0 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Folder /> Folders
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-44">
              {lib.folders.map((f) => (
                <ContextMenuCheckboxItem
                  key={f.id}
                  checked={f.brushIds.includes(brush.id)}
                  onCheckedChange={(v) => lib.setInFolder(f.id, brush.id, v === true)}
                >
                  {f.name}
                </ContextMenuCheckboxItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        {(customised || !brush.builtIn) && <ContextMenuSeparator />}
        {customised && (
          <ContextMenuItem onClick={() => lib.resetBrush(brush.id)}>
            <RotateCcw /> Reset to factory
          </ContextMenuItem>
        )}
        {!brush.builtIn && (
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => lib.deleteBrush(brush.id)}
          >
            <Trash2 /> Delete
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The slot a picked brush arms — the options bar's three tools. */
export type { BrushSlot };
