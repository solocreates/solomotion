"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { Check, ChevronRight, Download, FilePlus2, FolderOpen, PencilLine, Search, X } from "lucide-react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { RenameInput } from "@/components/ui/rename-input";
import { cn } from "@/lib/utils";
import { useAppShell } from "../state/app-shell";
import { useSession } from "../state/session";
import { displayName, renameProject, useProjectIndex, useProjectName } from "../state/project-index";
import { listProjects, type ProjectRecord } from "../state/project-store";
import { hasUnsavedChanges, subscribeUnsaved } from "../state/autosave";
import { softKeyboardLikely, useTypeToFocus } from "../input/use-type-to-focus";
import { installDocumentTitle } from "./document-title";
import { useNow } from "../runtime/use-now";

/** Wall-clock "now" for relative edit times, ticking while the menu is open. */
const useWallClock = () => useNow(true, Date.now, 30_000);

installDocumentTitle();

/**
 * THE PROJECT SWITCHER — the top of the logo menu (v5 redesign, D2 revised).
 *
 * There is no tab strip and no project header: a strip eats the stage's width
 * the moment a few projects are open, and a header above Layers costs a row on
 * every screen to say something the window title already says. Projects are
 * switched where the app's other "which file" verbs live — the mark.
 *
 * The logo menu has two faces. MENU: the project you are in (header), one row
 * of recent thumbnails, then the app's commands. PROJECTS: every project,
 * searchable, as cards. Typing anywhere in the menu goes to Projects — so the
 * mark is also the fastest way to find any project you have ever made.
 *
 * Every fact is read, never held: the open set and order from `useAppShell`,
 * names from the project index, records (thumbnails, edit times) from the
 * project store — loaded when the menu OPENS, never on mount.
 */

/** How many recent projects the Menu face shows — one row. The Projects face has the rest. */
const RECENT_COUNT = 4;

// ── shared state ───────────────────────────────────────────────────────────

/**
 * A request to open the logo menu from outside it (⌘⇧O). Every mounted
 * AppMenu watches `seq`; the one whose trigger is on screen answers.
 */
export const useLogoMenuRequest = create<{ seq: number; at: "recent" | null; request: (at: "recent" | null) => void }>(
  (set) => ({ seq: 0, at: null, request: (at) => set((s) => ({ seq: s.seq + 1, at })) }),
);

/** Does the open project have edits not yet on disk? Only it can: switching flushes. */
export function useUnsaved(): boolean {
  return React.useSyncExternalStore(subscribeUnsaved, hasUnsavedChanges, () => false);
}

/** Every live project record, read when `active` turns on. */
export function useProjectRecords(active: boolean): ProjectRecord[] | null {
  const [records, setRecords] = React.useState<ProjectRecord[] | null>(null);
  React.useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void listProjects().then((all) => {
      if (!cancelled) setRecords(all);
    });
    return () => {
      cancelled = true;
    };
  }, [active]);
  return records;
}

const relative = typeof Intl !== "undefined" ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "narrow" }) : null;

/** "5m ago", "yesterday" — the quiet meta at the end of a Recent row. */
export function editedAgo(ts: number, now = Date.now()): string {
  const s = Math.round((ts - now) / 1000);
  const abs = Math.abs(s);
  if (!relative) return "";
  if (abs < 60) return "just now";
  if (abs < 3600) return relative.format(Math.round(s / 60), "minute");
  if (abs < 86400) return relative.format(Math.round(s / 3600), "hour");
  if (abs < 86400 * 30) return relative.format(Math.round(s / 86400), "day");
  if (abs < 86400 * 365) return relative.format(Math.round(s / (86400 * 30)), "month");
  return relative.format(Math.round(s / (86400 * 365)), "year");
}

// ── pieces ─────────────────────────────────────────────────────────────────

function Thumb({ src, className }: { src: string | null | undefined; className?: string }) {
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" className={cn("shrink-0 rounded-xs border border-line bg-raised object-cover", className)} />
  ) : (
    <span aria-hidden className={cn("shrink-0 rounded-xs border border-line bg-raised", className)} />
  );
}

function DirtyDot({ className }: { className?: string }) {
  return (
    <span
      aria-label="Unsaved changes"
      title="Saving…"
      className={cn("size-1.5 shrink-0 rounded-full bg-fg-muted", className)}
    />
  );
}

/** Which face of the logo menu is showing: the app's commands, or every project. */
export type LogoMenuTab = "menu" | "projects";

/** A project's live name (the index is fresher than a record read on open). */
function ProjectName({ id, className }: { id: string; className?: string }) {
  return <span className={cn("min-w-0 truncate", className)}>{displayName(useProjectName(id))}</span>;
}

/**
 * THE HEADER — the project you are in. Name (click to rename), whether your
 * work is safe, and the one verb a finished piece wants: Export.
 */
export function ProjectHero({ id, record }: { id: string; record: ProjectRecord | undefined }) {
  const raw = useProjectName(id);
  const ready = useProjectIndex((s) => s.ready);
  const unsaved = useUnsaved();
  const now = useWallClock();
  const [renaming, setRenaming] = React.useState(false);
  const name = raw === null && !ready ? "" : displayName(raw);
  return (
    <div className="flex items-center gap-2.5 p-1.5">
      <Thumb src={record?.thumbnail} className="aspect-[16/10] h-auto w-16 rounded-sm" />
      {/* Keys typed here belong to the name field, not to the menu. */}
      <div className="min-w-0 flex-1" onKeyDown={(e) => renaming && e.key !== "Escape" && e.stopPropagation()}>
        {renaming ? (
          <RenameInput
            initial={raw ?? ""}
            onCommit={(next) => {
              setRenaming(false);
              void renameProject(id, next);
            }}
            className="h-(--control-h-sm) w-full min-w-0 rounded-sm border border-primary/60 bg-input px-1 text-title"
            spellCheck={false}
          />
        ) : (
          <button
            type="button"
            title="Rename"
            onClick={() => setRenaming(true)}
            className="group/name flex h-(--control-h-sm) w-full min-w-0 items-center gap-1.5 rounded-sm px-1 text-left text-title text-fg hover:bg-hover"
          >
            <span className="min-w-0 truncate">{name}</span>
            <PencilLine className="size-3.5 shrink-0 text-fg-faint opacity-0 group-hover/name:opacity-100" />
          </button>
        )}
        <div className="flex h-4 items-center gap-1 px-1 text-meta text-fg-faint">
          {unsaved ? (
            <>
              <DirtyDot /> Saving…
            </>
          ) : (
            <>
              <Check className="size-3 text-success" /> Saved
              {record && <span>· {editedAgo(record.updatedAt, now)}</span>}
            </>
          )}
        </div>
      </div>
      <DropdownMenuItem
        onSelect={() => useSession.getState().setExportDialogOpen(true)}
        className="min-h-(--control-h-sm) shrink-0 gap-1.5 rounded-md bg-primary/15 px-2.5 py-0 font-medium text-primary focus:bg-primary/25 focus:text-primary [&_svg]:size-3.5"
      >
        <Download /> Export
      </DropdownMenuItem>
    </div>
  );
}

/**
 * RECENT — one row of thumbnails, never a list. A list of recents is what made
 * the menu run off the bottom of the screen; the full set lives one tab over.
 */
export function RecentStrip({
  records,
  exclude,
  onAll,
}: {
  records: ProjectRecord[] | null;
  exclude: readonly string[];
  onAll: () => void;
}) {
  const now = useWallClock();
  const recent = (records ?? []).filter((r) => !exclude.includes(r.id)).slice(0, RECENT_COUNT);
  if (records && recent.length === 0) return null;
  return (
    <>
      <div className="flex h-6 items-center px-2">
        <span className="text-meta text-fg-muted">Recent</span>
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            onAll();
          }}
          className="ml-auto min-h-0 gap-0.5 px-1.5 py-0.5 text-meta text-fg-faint focus:text-fg [&_svg]:size-3"
        >
          All projects <ChevronRight />
        </DropdownMenuItem>
      </div>
      <div className="grid grid-cols-4 gap-0.5 px-0.5 pb-1">
        {records
          ? recent.map((r, i) => (
              <DropdownMenuItem
                key={r.id}
                data-first={i === 0 ? "recent" : undefined}
                title={`${displayName(r.name)} · ${editedAgo(r.updatedAt, now)}`}
                onSelect={() => useAppShell.getState().openProject(r.id)}
                className="flex-col items-stretch gap-1 p-1"
              >
                <Thumb src={r.thumbnail} className="aspect-[16/10] h-auto w-full" />
                <ProjectName id={r.id} className="text-meta" />
              </DropdownMenuItem>
            ))
          : Array.from({ length: RECENT_COUNT }, (_, i) => (
              <div key={i} className="flex flex-col gap-1 p-1">
                <Thumb src={null} className="aspect-[16/10] h-auto w-full animate-pulse" />
                <span className="h-3.5" />
              </div>
            ))}
      </div>
    </>
  );
}

function ProjectCard({
  record,
  current,
  open,
}: {
  record: ProjectRecord;
  current: boolean;
  open: boolean;
}) {
  const now = useWallClock();
  return (
    <DropdownMenuItem
      onSelect={() => useAppShell.getState().openProject(record.id)}
      className={cn(
        "group/card relative flex-col items-stretch gap-1.5 p-1.5",
        current && "bg-selection text-selection-fg focus:bg-selection-hover focus:text-selection-fg",
      )}
    >
      <Thumb src={record.thumbnail} className="aspect-[16/10] h-auto w-full" />
      <span className="flex min-w-0 items-center gap-1.5">
        <ProjectName id={record.id} className="flex-1 text-label" />
        <span className={cn("shrink-0 text-meta", current ? "text-selection-fg/70" : "text-fg-faint")}>
          {current ? "Here" : open ? "Open" : editedAgo(record.updatedAt, now)}
        </span>
      </span>
      {open && (
        <button
          type="button"
          tabIndex={-1}
          aria-label="Close project"
          title="Close"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            // The card stays — and the menu stays open — when only × was meant.
            e.stopPropagation();
            e.preventDefault();
            useAppShell.getState().closeTab(record.id);
          }}
          className="material-chip absolute right-2.5 top-2.5 flex size-5 items-center justify-center rounded-sm text-fg-muted opacity-0 hover:text-fg group-hover/card:opacity-100 group-focus/card:opacity-100 [&_svg]:size-3"
        >
          <X />
        </button>
      )}
    </DropdownMenuItem>
  );
}

/**
 * PROJECTS — every project, searchable, in one place. Open ones first (they are
 * one click from where you are), then by last edit. Typing anywhere in the
 * logo menu lands here with the keystroke already in the field.
 */
export function ProjectsTab({
  query,
  setQuery,
  records,
  focusFirst,
  searchSeq,
}: {
  query: string;
  setQuery: (q: string) => void;
  records: ProjectRecord[] | null;
  /** ⌘⇧O: land on the first card rather than in the field. */
  focusFirst: boolean;
  /** Bumped when a keystroke elsewhere in the menu was routed into the field. */
  searchSeq: number;
}) {
  const tabs = useAppShell((s) => s.tabs);
  const view = useAppShell((s) => s.view);
  const currentId = useAppShell((s) => (s.view === "editor" ? (s.pendingProjectId ?? s.currentProjectId) : null));
  const searchRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  // On touch the first printable key focuses the field, so opening never raises a keyboard.
  useTypeToFocus(searchRef, !focusFirst && softKeyboardLikely());
  React.useEffect(() => {
    if (focusFirst || (softKeyboardLikely() && searchSeq === 0)) return;
    const raf = requestAnimationFrame(() => {
      const el = searchRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
    return () => cancelAnimationFrame(raf);
  }, [focusFirst, searchSeq]);
  React.useEffect(() => {
    if (!focusFirst || !records) return;
    listRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [focusFirst, records]);

  const q = query.trim().toLowerCase();
  const list = React.useMemo(() => {
    const all = (records ?? []).filter((r) => !q || displayName(r.name).toLowerCase().includes(q));
    const rank = (id: string) => (id === currentId ? 0 : tabs.includes(id) ? 1 : 2);
    return all.sort((a, b) => rank(a.id) - rank(b.id) || b.updatedAt - a.updatedAt);
  }, [records, q, tabs, currentId]);

  return (
    <div>
      <div className="px-1 pb-1" onKeyDown={(e) => e.key !== "Escape" && e.stopPropagation()}>
        <label className="flex h-(--control-h) items-center gap-1.5 rounded-md bg-input px-2 text-fg-muted focus-within:text-fg">
          <Search className="size-3.5 shrink-0" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                listRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
              } else if (e.key === "Enter" && list[0]) {
                e.preventDefault();
                useAppShell.getState().openProject(list[0].id);
              }
            }}
            placeholder="Search projects"
            aria-label="Search projects"
            className="min-w-0 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-fg-faint"
          />
          {records && <span className="shrink-0 text-meta tabular-nums text-fg-faint">{list.length}</span>}
        </label>
      </div>
      <ScrollArea viewportRef={listRef} viewportClassName="max-h-[min(26rem,52vh)]">
        {list.length > 0 ? (
          <div className="grid grid-cols-2 gap-0.5 p-0.5">
            {list.map((r) => (
              <ProjectCard key={r.id} record={r} current={r.id === currentId} open={tabs.includes(r.id)} />
            ))}
          </div>
        ) : (
          <div className="px-2 py-6 text-center text-body text-fg-faint">
            {!records ? "Loading…" : q ? "No projects match" : "No projects yet"}
          </div>
        )}
      </ScrollArea>
      <DropdownMenuSeparator />
      <div className="flex gap-0.5">
        <DropdownMenuItem className="flex-1" onSelect={() => useAppShell.getState().openNewProject()}>
          <FilePlus2 /> New project
        </DropdownMenuItem>
        {view === "editor" && (
          <DropdownMenuItem
            className="flex-1"
            onSelect={() => {
              useAppShell.getState().setHomeSection("projects");
              useAppShell.getState().goHome();
            }}
          >
            <FolderOpen /> Manage on Home
          </DropdownMenuItem>
        )}
      </div>
    </div>
  );
}

// ── keyboard: ⌃Tab overlay and ⌘⇧O ──────────────────────────────────────────

let owner: symbol | null = null;

/**
 * The app-wide keys, mounted by whichever AppMenu mounts first (there can be
 * two: the left rail's and the compact dock's) so a key never acts twice.
 */
export function ProjectSwitcherKeys() {
  const [token] = React.useState(() => Symbol("switcher"));
  const [mine, setMine] = React.useState(false);
  React.useEffect(() => {
    if (owner) return;
    owner = token;
    setMine(true);
    return () => {
      if (owner === token) owner = null;
    };
  }, [token]);
  return mine ? <CycleOverlay /> : null;
}

/**
 * ⌃Tab / ⌃⇧Tab — step through open projects in a small centred overlay, like
 * ⌘Tab: hold Control, tap Tab, release to switch; Escape cancels. A desktop
 * browser keeps ⌃Tab for its own tabs, so on the web this reaches the page
 * only in the installed app (PWA window, Tauri). ⌘⇧O opens the logo menu at
 * Recent, which works everywhere.
 */
function CycleOverlay() {
  const tabs = useAppShell((s) => s.tabs);
  const [at, setAt] = React.useState<number | null>(null);
  const atRef = React.useRef<number | null>(null);
  atRef.current = at;
  const records = useProjectRecords(at !== null);

  React.useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && !e.altKey && e.code === "KeyO") {
        e.preventDefault();
        useLogoMenuRequest.getState().request("recent");
        return;
      }
      if (atRef.current !== null && e.key === "Escape") {
        e.preventDefault();
        setAt(null);
        return;
      }
      if (e.key !== "Tab" || !e.ctrlKey || e.metaKey || e.altKey) return;
      const s = useAppShell.getState();
      if (s.tabs.length < 2) return;
      e.preventDefault();
      const n = s.tabs.length;
      const base = atRef.current ?? Math.max(0, s.tabs.indexOf(s.pendingProjectId ?? s.currentProjectId ?? ""));
      setAt((base + (e.shiftKey ? -1 : 1) + n) % n);
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key !== "Control" || atRef.current === null) return;
      const id = useAppShell.getState().tabs[atRef.current];
      setAt(null);
      if (id) useAppShell.getState().openProject(id);
    };
    const cancel = () => setAt(null);
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
      window.removeEventListener("blur", cancel);
    };
  }, []);

  if (at === null || typeof document === "undefined") return null;
  const thumbs = new Map((records ?? []).map((r) => [r.id, r.thumbnail]));
  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div
        role="listbox"
        aria-label="Switch project"
        className="material-popover pointer-events-auto flex max-w-full gap-1 overflow-x-auto rounded-xl p-2"
      >
        {tabs.map((id, i) => (
          <CycleCard
            key={id}
            id={id}
            thumb={thumbs.get(id)}
            selected={i === at}
            onPick={() => {
              setAt(null);
              useAppShell.getState().openProject(id);
            }}
          />
        ))}
      </div>
    </div>,
    document.body,
  );
}

function CycleCard({ id, thumb, selected, onPick }: { id: string; thumb: string | null | undefined; selected: boolean; onPick: () => void }) {
  const name = displayName(useProjectName(id));
  const ref = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);
  return (
    <button
      ref={ref}
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onPick}
      className={cn(
        "flex w-32 shrink-0 flex-col gap-1.5 rounded-lg p-1.5 text-left",
        selected ? "bg-selection text-selection-fg" : "text-fg-muted hover:bg-hover",
      )}
    >
      <Thumb src={thumb} className="aspect-[16/10] h-auto w-full" />
      <span className="truncate px-0.5 text-label">{name}</span>
    </button>
  );
}
