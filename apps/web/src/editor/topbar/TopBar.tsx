"use client";

import * as React from "react";
import { ChevronDown, Heart, Plus, Redo2, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useEdgeFade } from "@/components/ui/use-edge-fade";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { product } from "../product";
import { AppMenu } from "../menus/AppMenu";
import { ExportMenu } from "../export/ExportMenu";
import { useAppShell } from "../state/app-shell";
import { useHistoryInfo } from "../state/document-context";
import { redoActive, undoActive } from "../state/history";
import { displayName, useProjectName } from "../state/project-index";
import { useSession } from "../state/session";
import { useIsCompact } from "../state/use-shell-density";
import { useAiActivity } from "../state/ai-activity";
import { useSupport } from "../support/support-store";
import { ProjectsTab, useProjectRecords, useUnsaved } from "./ProjectSwitcher";

/**
 * THE TOP BAR — who you are with, what you have open, and the one action.
 *
 *   [ mark wordmark ] [ project | project | + ] ········ [ ↶ ↷ ] [ Support ] [ Export ▾ ]
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
  const Mark = busy ? product.Loader : product.Mark;

  return (
    <header data-topbar="" className="relative z-20 flex h-(--topbar-h) shrink-0 items-center gap-1 pl-1.5 pr-2">
      <AppMenu
        side="bottom"
        trigger={
          <button
            type="button"
            aria-label="Main menu"
            className="group flex h-8 shrink-0 items-center gap-2 rounded-md pl-1.5 pr-2 transition-colors hover:bg-hover"
          >
            <Mark size={20} className="size-5 shrink-0 transition-transform group-hover:scale-105" />
            {!compact && <product.Wordmark className="text-[0.9375rem] text-fg" />}
            <ChevronDown className="size-3 text-fg-faint transition-transform group-data-[state=open]:rotate-180" />
          </button>
        }
      />
      <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-line" />
      <ProjectTabs compact={compact} />
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <HistoryActions />
        <ProductEntry compact={compact} />
        <ExportAction />
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
    return (
      <Button variant="ghost" size="sm" onClick={() => useSupport.getState().setOpen(true)} aria-label="Support">
        <Heart className="size-3.5" />
        {!compact && "Support"}
      </Button>
    );
  }
  if (unlocked) return null;
  return (
    <Button variant="ghost" size="sm" onClick={() => product.entitlements.prompt(undefined, "topbar")}>
      Upgrade
    </Button>
  );
}

/** Export: the press opens the export dialog; the chevron offers the shortcuts. */
function ExportAction() {
  const inEditor = useAppShell((s) => s.view === "editor");
  if (!inEditor) return null;
  return (
    <div className="flex items-center">
      <Button size="sm" className="rounded-r-none pr-2.5" onClick={() => useSession.getState().setExportDialogOpen(true)}>
        Export
      </Button>
      <ExportMenu side="bottom" align="end">
        <Button size="sm" aria-label="More export options" className="rounded-l-none border-l border-[color-mix(in_srgb,var(--primary-foreground)_18%,transparent)] px-1.5">
          <ChevronDown className="size-3.5" />
        </Button>
      </ExportMenu>
    </div>
  );
}

/**
 * The open projects, as DOCUMENT tabs: quiet, the way an editor's files are.
 *
 * - An inactive tab is plain text, with a hairline between two inactive
 *   neighbours (never beside the active one or the one under your pointer).
 * - The active tab is a raised plate of the WORKSPACE's own plane (`bg-panel`)
 *   standing on the bar's bottom edge, so it reads as the top of the panels
 *   below it rather than a chip floating in the bar.
 * - × shows on hover and on the active tab (an unsaved dot holds its place
 *   until you hover). Middle-click closes too.
 * - A long name keeps its END (`MiddleName`): "Launch film v3" and
 *   "Launch film v4" stay two different tabs.
 * - The strip scrolls sideways with edge fades.
 *
 * `+` opens the searchable project grid (the app menu's Projects face).
 */
function ProjectTabs({ compact }: { compact: boolean }) {
  const tabs = useAppShell((s) => s.tabs);
  const current = useAppShell((s) => (s.view === "editor" ? (s.pendingProjectId ?? s.currentProjectId) : null));
  const row = React.useRef<HTMLDivElement>(null);
  useEdgeFade(row, "x");
  const shown = compact ? tabs.filter((t) => t === current) : tabs;

  return (
    <div className="flex h-full min-w-0 items-center gap-1">
      <div
        ref={row}
        role="tablist"
        aria-label="Open projects"
        data-fade-axis="x"
        className="edge-fade flex h-full min-w-0 items-end overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {shown.map((id) => (
          <ProjectTab key={id} id={id} active={id === current} />
        ))}
      </div>
      <NewTab />
    </div>
  );
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

function ProjectTab({ id, active }: { id: string; active: boolean }) {
  const name = displayName(useProjectName(id));
  const unsaved = useUnsaved();
  return (
    <div
      role="tab"
      aria-selected={active}
      data-project-tab=""
      tabIndex={0}
      title={name}
      onClick={() => !active && useAppShell.getState().openProject(id)}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && useAppShell.getState().openProject(id)}
      onAuxClick={(e) => e.button === 1 && useAppShell.getState().closeTab(id)}
      className={cn(
        "group/tab relative flex h-8 max-w-52 shrink-0 cursor-default items-center gap-1.5 pl-3 pr-1.5 text-body transition-colors",
        // The hairline sits on a tab's leading edge, and is not drawn first in
        // the strip, on the active plate, after it, or around the hovered tab.
        "before:absolute before:top-1/2 before:left-0 before:h-3.5 before:w-px before:-translate-y-1/2 before:bg-line",
        "first:before:hidden hover:before:hidden [[aria-selected=true]+&]:before:hidden [:hover+&]:before:hidden",
        active ? "rounded-t-lg bg-panel text-fg before:hidden" : "text-fg-muted hover:text-fg",
      )}
    >
      <MiddleName name={name} />
      <span className="relative grid size-4 shrink-0 place-items-center">
        {active && unsaved && <span aria-label="Unsaved" className="absolute size-1.5 rounded-full bg-fg-muted group-hover/tab:hidden" />}
        <button
          type="button"
          aria-label={`Close ${name}`}
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
            <button type="button" aria-label="Open a project" className="grid size-7 shrink-0 place-items-center rounded-md text-fg-muted transition-colors hover:bg-hover hover:text-fg">
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
