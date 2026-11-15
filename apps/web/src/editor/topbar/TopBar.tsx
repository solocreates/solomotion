"use client";

import * as React from "react";
import { ArrowUpRight, ChevronDown, Plus, Redo2, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useEdgeFade } from "@/components/ui/use-edge-fade";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { beginHeldDrag } from "../input/hold-to-drag";
import { HELD_DRAG_SURFACE } from "../input/use-multi-touch";
import { subscribePointerEnd } from "../input/pointer-gestures";
import { solveListInsert, type Span } from "../workspace/list-insert";
import { useFlip } from "../workspace/use-flip";
import { product } from "../product";
import { AppMenu } from "../menus/AppMenu";
import { BrandTrigger } from "../menus/BrandTrigger";
import { ExportMenu } from "../export/ExportMenu";
import { useAppShell } from "../state/app-shell";
import { useHistoryInfo } from "../state/document-context";
import { redoActive, undoActive } from "../state/history";
import { displayName, useProjectName } from "../state/project-index";
import { useSession } from "../state/session";
import { useIsCompact } from "../state/use-shell-density";
import { useAiActivity } from "../state/ai-activity";
import { SupportButton } from "../support/SupportButton";
import { ProjectsTab, useProjectRecords, useUnsaved } from "./ProjectSwitcher";

/**
 * THE TOP BAR — who you are with, what you have open, and the one action.
 *
 *   [ logo ▾ ] │ [ project ] [ project ] [ + ] ··················· [ ↶ ↷ ] [ Support ] [ Export ▾ ]
 *
 * Two zones: the logo and the open projects read left to right, the actions
 * keep the right. The projects are badges on the bar's centre line, the same
 * height as `+` — not tabs hanging from the bar's bottom edge (that read as
 * attached to the stage) and not centred in the window (that floated them
 * away from the logo that owns them).
 *
 * It owns one row of the window and takes room from nothing: the rails and
 * the workspace start below it, so opening a project tab never moves a panel.
 * The mark IS the app menu (as it was at the top of the left rail), and it
 * turns while the app is working on something — an agent at a layer, an
 * export — the product's own loader in place of its mark.
 *
 * The project tabs are the open-projects list (`app-shell`). They are
 * DOCUMENTS, not a segmented control, so they do not wear the theme's tab part
 * (a pill or a playhead marks a choice between views, not an open file): see
 * `ProjectTabs`. Projects are IDs over one resident document; switching is
 * opening.
 *
 * Nothing else earns a place on the right. Search was a ⌘K chip here and read
 * as a sticker: ⌘K still opens the palette, and search lives in the `+`
 * popover and the app menu. The one accent is Export.
 *
 * Undo and redo sit here, beside the projects they act on: they are the
 * document's, not a panel's (the rail's foot keeps the app's own: workspace
 * and settings). Compact keeps the mark, the project you are in, undo and
 * Export.
 */
export function TopBar() {
  const compact = useIsCompact();
  const busy = useAiActivity((s) => Object.keys(s.jobs).length > 0);

  return (
    <header
      data-topbar=""
      className="relative z-20 flex h-(--topbar-h) shrink-0 items-center gap-1 pl-1.5 pr-2"
    >
      <AppMenu side="bottom" trigger={<BrandTrigger compact={compact} busy={busy} />} />
      <span aria-hidden className="mx-1.5 h-4 w-px shrink-0 bg-line" />
      <ProjectTabs compact={compact} />
      <div className="ml-auto flex shrink-0 items-center justify-end gap-1 pl-2">
        <HistoryActions />
        <ProductEntry compact={compact} />
        <ExportAction compact={compact} />
      </div>
    </header>
  );
}

/** Undo and redo, labelled with the step they would take. */
function HistoryActions() {
  const history = useHistoryInfo();
  const button = (label: string, disabled: boolean, onClick: () => void, Icon: typeof Undo2) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          className="flex size-7 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-35"
        >
          <Icon className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
  return (
    <div className="mr-1 flex items-center">
      {button(history.undoLabel ? `Undo ${history.undoLabel}` : "Undo", !history.canUndo, undoActive, Undo2)}
      {button(history.redoLabel ? `Redo ${history.redoLabel}` : "Redo", !history.canRedo, redoActive, Redo2)}
    </div>
  );
}

/** Support (an open product) or the way to the licence (a paid one) — quiet either way. */
function ProductEntry({ compact }: { compact: boolean }) {
  const unlocked = product.entitlements.useHas();
  if (product.entry === "support") {
    return <SupportButton compact={compact} />;
  }
  if (unlocked) return null;
  return (
    <Button variant="ghost" size="sm" onClick={() => product.entitlements.prompt(undefined, "topbar")}>
      Upgrade
    </Button>
  );
}

/**
 * Export: ONE accent control in two parts. The press opens the export dialog;
 * the chevron, a quieter segment of the same plate, offers the shortcuts. The
 * seam is a short inset rule, not a border, so it reads as one object with a
 * second door rather than two buttons glued together. Compact: the arrow alone.
 */
function ExportAction({ compact }: { compact: boolean }) {
  const inEditor = useAppShell((s) => s.view === "editor");
  if (!inEditor) return null;
  return (
    <div className="ml-1 flex items-center">
      <Button
        variant="accent"
        size="sm"
        aria-label="Export"
        className={cn("gap-1.5 rounded-r-none font-semibold", compact ? "px-2" : "pl-2.5 pr-3")}
        onClick={() => useSession.getState().setExportDialogOpen(true)}
      >
        <ArrowUpRight className="size-4" />
        {!compact && "Export"}
      </Button>
      <ExportMenu side="bottom" align="end">
        <Button
          variant="accent"
          size="sm"
          aria-label="More export options"
          className="relative rounded-l-none px-1.5 before:absolute before:inset-y-1.5 before:left-0 before:w-px before:bg-[color-mix(in_srgb,var(--primary-foreground)_22%,transparent)] data-[state=open]:brightness-95"
        >
          <ChevronDown className="size-3.5 transition-transform in-data-[state=open]:rotate-180" />
        </Button>
      </ExportMenu>
    </div>
  );
}

/**
 * The open projects, as badges beside the logo.
 *
 * - Each is a control-height badge on the bar's centre line, aligned with `+`.
 *   An inactive one is quiet ink that takes a hover plate; the active one is
 *   armed (`material-glass-raised`), the app's one look for "this is on".
 * - × shows on hover and on the active tab (an unsaved dot holds its place
 *   until you hover). Middle-click closes too; right-click has the rest.
 * - Drag sorts, live, the way a browser's tabs do: the held tab follows the
 *   pointer and its neighbours part around it (`useTabSort`).
 * - A long name keeps its END (`MiddleName`): "Launch film v3" and
 *   "Launch film v4" stay two different tabs.
 * - Badges shrink (their names cut in the middle) before the strip scrolls
 *   sideways with edge fades — one tab on a phone is never clipped.
 *
 * `+` opens the searchable project grid (the app menu's Projects face).
 */
function ProjectTabs({ compact }: { compact: boolean }) {
  const tabs = useAppShell((s) => s.tabs);
  const current = useAppShell((s) => (s.view === "editor" ? (s.pendingProjectId ?? s.currentProjectId) : null));
  const row = React.useRef<HTMLDivElement>(null);
  useEdgeFade(row, "x");
  const shown = compact ? tabs.filter((t) => t === current) : tabs;
  const sort = useTabSort(row, shown);
  useFlip(row);

  return (
    <div className="flex min-w-0 items-center gap-1">
      <div
        ref={row}
        role="tablist"
        aria-label="Open projects"
        data-fade-axis="x"
        className="edge-fade flex min-w-0 items-center gap-0.5 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {sort.order.map((id) => (
          <ProjectTab
            key={id}
            id={id}
            active={id === current}
            dragging={sort.dragging === id}
            onPointerDown={(e) => sort.press(e, id)}
            suppressClick={sort.suppressClick}
          />
        ))}
      </div>
      <NewTab />
    </div>
  );
}

/**
 * LIVE TAB SORTING. One press → `beginHeldDrag` (a tab strip is a horizontal
 * scroller, so on touch the scope defers: a finger that moves at once scrolls
 * the strip, one that rests lifts the tab); the slot is `solveListInsert`
 * against the other tabs' rects, the same solver the rails and dock strips
 * use; the neighbours slide by `useFlip`. Only the release commits
 * (`reorderTabs`); a lost or superseded pointer puts everything back.
 */
function useTabSort(row: React.RefObject<HTMLDivElement | null>, tabs: readonly string[]) {
  const [drag, setDrag] = React.useState<{ id: string; slot: number } | null>(null);
  // A press that turned into a drag must not also activate the tab it began on.
  const suppressClick = React.useRef(false);
  const replace = React.useRef<(() => void) | null>(null);

  const order = React.useMemo(() => {
    if (!drag) return tabs;
    const rest = tabs.filter((t) => t !== drag.id);
    rest.splice(drag.slot, 0, drag.id);
    return rest;
  }, [tabs, drag]);

  const press = (e: React.PointerEvent<HTMLElement>, id: string) => {
    if (e.button !== 0 || tabs.length < 2) return;
    const box = row.current;
    const el = e.currentTarget;
    if (!box) return;
    const from = tabs.indexOf(id);
    const others: Span[] = Array.from(box.querySelectorAll<HTMLElement>("[data-project-tab]"))
      .filter((t) => t !== el)
      .map((t) => {
        const r = t.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      });
    const width = el.getBoundingClientRect().width;
    const grabX = e.clientX - el.getBoundingClientRect().left;
    const held = beginHeldDrag(e, { axis: "x" });
    const pointerId = e.pointerId;
    let slot = from;
    let live = false;
    let lastX = e.clientX;

    // Follow the pointer: the transform is whatever separates where the tab
    // should be from where layout put it — both read as client rects, so the
    // offset parent never enters into it.
    let shift = 0;
    const place = (clientX: number) => {
      const laidOut = el.getBoundingClientRect().left - shift;
      shift = clientX - grabX - laidOut;
      el.style.transform = `translateX(${shift}px)`;
    };
    replace.current = () => place(lastX);
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId || !held.update(ev.clientX, ev.clientY)) return;
      if (!live) {
        live = true;
        suppressClick.current = true;
      }
      lastX = ev.clientX;
      // The held tab's CENTRE is what you aim with, not the point you grabbed.
      slot = solveListInsert(others, "x", { x: ev.clientX - grabX + width / 2, y: ev.clientY }, slot, width);
      setDrag((d) => (d && d.id === id && d.slot === slot ? d : { id, slot }));
      place(ev.clientX);
    };
    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", move);
      unsubscribe();
      held.end();
      el.style.transform = "";
      replace.current = null;
      setDrag(null);
      if (live && commit && slot !== from) useAppShell.getState().reorderTabs(from, slot);
      // The click that follows this release is the drag's, not a selection.
      if (live) setTimeout(() => (suppressClick.current = false), 0);
    };
    const unsubscribe = subscribePointerEnd((pid, reason) => {
      if (pid === pointerId) finish(reason === "up");
    });
    window.addEventListener("pointermove", move);
  };

  // The reorder moved the held tab's layout slot under it: put it back under
  // the pointer before paint, so it never jumps a tab's width for a frame.
  React.useLayoutEffect(() => {
    if (drag) replace.current?.();
  }, [drag]);

  return { order, dragging: drag?.id ?? null, press, suppressClick };
}

/**
 * A name cut in the MIDDLE without measuring: the head truncates, the tail
 * (its last word, up to 8 characters) never does. When the name fits, the two
 * spans read as one.
 */
function MiddleName({ name }: { name: string }) {
  const cut = Math.max(name.length - 8, name.lastIndexOf(" ") + 1);
  if (cut <= 4 || name.length <= 14) return <span className="truncate">{name}</span>;
  return (
    <span className="flex min-w-0">
      <span className="truncate">{name.slice(0, cut)}</span>
      <span className="shrink-0 whitespace-pre">{name.slice(cut)}</span>
    </span>
  );
}

function ProjectTab({
  id,
  active,
  dragging,
  onPointerDown,
  suppressClick,
}: {
  id: string;
  active: boolean;
  dragging: boolean;
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  suppressClick: React.RefObject<boolean>;
}) {
  const name = displayName(useProjectName(id));
  const unsaved = useUnsaved();
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="tab"
          aria-selected={active}
          data-project-tab={id}
          // The held tab follows the pointer by its own transform; FLIP is for
          // the neighbours parting around it.
          data-flip={dragging ? undefined : id}
          tabIndex={0}
          title={name}
          onPointerDown={onPointerDown}
          onClick={() => !active && !suppressClick.current && useAppShell.getState().openProject(id)}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && useAppShell.getState().openProject(id)}
          onAuxClick={(e) => e.button === 1 && useAppShell.getState().closeTab(id)}
          className={cn(
            "group/tab relative flex h-(--control-h) min-w-16 max-w-52 shrink cursor-default items-center gap-1 rounded-md pl-2.5 pr-1 text-body transition-colors",
            HELD_DRAG_SURFACE,
            active ? "material-glass-raised text-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
            // Lifted: above its neighbours, on a plate of its own while it travels.
            dragging && "material-glass-raised z-10 text-fg",
          )}
        >
          <MiddleName name={name} />
          <span className="relative grid size-4 shrink-0 place-items-center">
            {active && unsaved && <span aria-label="Unsaved" className="absolute size-1.5 rounded-full bg-fg-muted group-hover/tab:hidden" />}
            <button
              type="button"
              aria-label={`Close ${name}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                useAppShell.getState().closeTab(id);
              }}
              className={cn(
                "grid size-4 place-items-center rounded-sm text-fg-faint transition-opacity hover:bg-hover hover:text-fg",
                active && !unsaved ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100",
              )}
            >
              <X className="size-3" />
            </button>
          </span>
        </div>
      </ContextMenuTrigger>
      <TabMenu id={id} />
    </ContextMenu>
  );
}

/** A tab's right-click: the closes a browser offers, nothing it does not. */
function TabMenu({ id }: { id: string }) {
  const tabs = useAppShell((s) => s.tabs);
  const shell = useAppShell.getState;
  const last = tabs.indexOf(id) === tabs.length - 1;
  return (
    <ContextMenuContent className="w-48">
      <ContextMenuItem onSelect={() => shell().closeTab(id)}>Close</ContextMenuItem>
      <ContextMenuItem disabled={tabs.length < 2} onSelect={() => shell().closeOthers(id)}>
        Close others
      </ContextMenuItem>
      <ContextMenuItem disabled={last} onSelect={() => shell().closeToRight(id)}>
        Close to the right
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => shell().closeAll()}>Close all</ContextMenuItem>
    </ContextMenuContent>
  );
}

/** `+`: new, open, recent and every project, searchable. */
function NewTab() {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const records = useProjectRecords(open);
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setQuery("");
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="Open a project" className="grid size-(--control-h) shrink-0 place-items-center rounded-md text-fg-muted transition-colors hover:bg-hover hover:text-fg">
              <Plus className="size-4" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">New or open a project</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" sideOffset={6} className="w-[21rem]">
        <ProjectsTab query={query} setQuery={setQuery} records={records} focusFirst={false} searchSeq={0} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
