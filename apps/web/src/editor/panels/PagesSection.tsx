"use client";

import * as React from "react";
import {
  COMPONENTS_PAGE_NAME,
  COMPONENTS_VIEW_ID,
  componentFrames,
  createPage,
  deleteFrame,
  framesOnPage,
  isComponentsView,
  pageOfFrame,
  type MotionDocument,
} from "@solomotion/core";
import { Box, ChevronRight, Component, FileText, Plus } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DRAG_SURFACE } from "../input/use-multi-touch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { openWorldFrame, worldEntries } from "../world/make-3d";
import { toast } from "@/lib/toast";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { goToPage } from "../state/frame-nav";
import { NAMES } from "@/editor/names";

/**
 * Figma-style pages, above the layers list. The canvas shows one page at a
 * time; each page holds its own frames (and so its own layers). Precomposed
 * "nested clip" comps live on the auto-managed "Nested" page — out of sight
 * until you want them. Click switches, double-click renames, right-click
 * renames/deletes, + adds.
 */
export function PagesSection({ doc }: { doc: MotionDocument }) {
  const store = useDocStore();
  const activePageId = useSession((s) => s.activePageId);
  const currentId = activePageId ?? doc.pages[0]!.id;
  const [renaming, setRenaming] = React.useState<string | null>(null);

  const switchTo = (pageId: string) => goToPage(store.getState(), pageId);

  // The virtual Components view — a dynamic gallery of every component, listed
  // WITHOUT moving or duplicating any frame. Only shown once you have one.
  const componentCount = componentFrames(doc).length;
  const componentsActive = isComponentsView(currentId);

  const addPage = () => {
    const page = createPage(`Page ${doc.pages.length + 1}`);
    store.update("Add page", (d) => void d.pages.push(page));
    goToPage(store.getState(), page.id);
  };

  const rename = (pageId: string, name: string) => {
    const trimmed = name.trim();
    if (trimmed) {
      store.update("Rename page", (d) => {
        const p = d.pages.find((x) => x.id === pageId);
        if (p) p.name = trimmed;
      });
    }
    setRenaming(null);
  };

  const deletePage = (pageId: string) => {
    const d = store.getState();
    if (d.pages.length <= 1) return;
    const doomed = framesOnPage(d, pageId);
    if (doomed.length >= d.frames.length) {
      toast.error("Can't delete the page holding the project's only frames");
      return;
    }
    store.update("Delete page", (dd) => {
      for (const f of framesOnPage(dd, pageId)) deleteFrame(dd, f.id);
      dd.pages = dd.pages.filter((p) => p.id !== pageId);
    });
    if (currentId === pageId) switchTo(store.getState().pages[0]!.id);
  };

  const pane = usePagesPane();
  const currentName = componentsActive ? COMPONENTS_PAGE_NAME : (doc.pages.find((p) => p.id === currentId)?.name ?? "");
  // The active page is always in view — on open, on switch, after a resize.
  const listRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    listRef.current?.querySelector("[data-active-page]")?.scrollIntoView({ block: "nearest" });
  }, [currentId, pane.collapsed]);

  return (
    <div className="relative shrink-0 border-b border-line">
      <div className="flex h-(--control-h) items-center gap-1 pl-3 pr-2">
        <button
          type="button"
          onClick={() => pane.setCollapsed(!pane.collapsed)}
          aria-expanded={!pane.collapsed}
          className="group flex min-w-0 flex-1 items-center gap-1 text-left text-label text-fg-muted transition-colors hover:text-fg"
        >
          Pages
          <ChevronRight className={cn("size-3 shrink-0 text-fg-faint transition-transform", !pane.collapsed && "rotate-90")} />
          {/* Folded, the header still says where you are. */}
          {pane.collapsed && <span className="min-w-0 truncate font-normal text-fg">{currentName}</span>}
        </button>
        <button
          type="button"
          aria-label="Add page"
          onClick={addPage}
          className="flex size-(--control-h-sm) items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <Plus className="size-3.5" />
        </button>
      </div>
      {!pane.collapsed && (
      <ScrollArea className="min-h-0" style={{ maxHeight: pane.height }} viewportRef={listRef}>
      <div className="px-1.5 pb-2">
      {/* Real pages. A legacy auto "Components" page (from the old relocate-model)
          is hidden — its frames now surface through the virtual view below. */}
      {doc.pages.filter((p) => p.name !== COMPONENTS_PAGE_NAME).map((page) => {
        const active = page.id === currentId;
        const frameCount = doc.frames.reduce((n, f) => n + (pageOfFrame(doc, f) === page.id ? 1 : 0), 0);
        return (
          <ContextMenu key={page.id}>
            <ContextMenuTrigger asChild>
              <div
                role="button"
                tabIndex={0}
                {...(active ? { "data-active-page": "" } : {})}
                /* Hold a layer drag over a page and the canvas switches to it
                   (`input/spring-load.ts`) — the file-manager gesture, so
                   carrying artwork to another page is one continuous move
                   rather than drop-here, switch, pick it up again. Only when
                   it is not already the page you are on. */
                {...(active ? {} : { "data-spring-load": `page:${page.id}` })}
                onClick={() => {
                  if (!active) switchTo(page.id);
                }}
                onDoubleClick={() => setRenaming(page.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !active) switchTo(page.id);
                }}
                className={cn(
                  "flex h-(--control-h) cursor-pointer select-none items-center gap-2 rounded-lg px-1.5 text-body transition-colors",
                  active ? "bg-selection text-selection-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
                )}
              >
                <FileText className={cn("size-3.5 shrink-0", !active && "text-fg-faint")} />
                {renaming === page.id ? (
                  <input
                    autoFocus
                    defaultValue={page.name}
                    onFocus={(e) => e.target.select()}
                    onBlur={(e) => rename(page.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") setRenaming(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="h-5 min-w-0 flex-1 rounded-sm border border-primary/60 bg-input px-1 text-body outline-none"
                    spellCheck={false}
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate">{page.name}</span>
                )}
                <span className="text-meta tabular-nums text-fg-faint">{frameCount}</span>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-48">
              <ContextMenuItem onClick={() => setRenaming(page.id)}>Rename page</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                disabled={doc.pages.length <= 1}
                className="text-destructive focus:text-destructive"
                onClick={() => deletePage(page.id)}
              >
                Delete page{frameCount > 0 ? ` (${frameCount} frames)` : ""}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}

      {/* Virtual Components view — a live gallery of every component, wherever it
          lives. Not a real page: nothing is moved or duplicated. */}
      {componentCount > 0 && (
        <div
          role="button"
          tabIndex={0}
          onClick={() => {
            if (!componentsActive) switchTo(COMPONENTS_VIEW_ID);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !componentsActive) switchTo(COMPONENTS_VIEW_ID);
          }}
          title="Every component, wherever it lives — nothing is moved"
          className={cn(
            "flex h-(--control-h) cursor-pointer select-none items-center gap-2 rounded-lg px-1.5 text-body transition-colors",
            componentsActive ? "bg-selection text-selection-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
          )}
        >
          <Component className="size-3.5 shrink-0 text-(--kind-component)" />
          <span className="min-w-0 flex-1 truncate">{COMPONENTS_PAGE_NAME}</span>
          <span className="text-meta tabular-nums text-fg-faint">{componentCount}</span>
        </div>
      )}
      <WorldsRow doc={doc} />
      </div>
      </ScrollArea>
      )}
      {!pane.collapsed && <PaneResizer height={pane.height} onHeight={pane.setHeight} />}
    </div>
  );
}

// ── The pane's own size ─────────────────────────────────────────────────────

/**
 * PAGES ARE A PANE, NOT A HEADER. They used to sit above the layers list at
 * whatever height they came to, which assumed two or three pages: a project
 * with thirty pushed the layers off the bottom of the panel and nothing
 * scrolled them back. Now the pane scrolls itself, you drag its bottom edge to
 * size it (Figma's divider), double-click that edge to go back to the default,
 * and fold it to one line that still names the current page. Per viewer, in
 * storage — a convenience, never part of a document.
 */
const PANE_KEY = NAMES.storage.pagesPane;
const DEFAULT_H = 6 * 28 + 8;
const MIN_H = 2 * 28 + 8;

function readPane(): { height: number; collapsed: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(PANE_KEY) ?? "null") as { height?: unknown; collapsed?: unknown } | null;
    return {
      height: typeof v?.height === "number" && v.height >= MIN_H ? v.height : DEFAULT_H,
      collapsed: v?.collapsed === true,
    };
  } catch {
    return { height: DEFAULT_H, collapsed: false };
  }
}

function usePagesPane() {
  const [pane, setPane] = React.useState(() => (typeof window === "undefined" ? { height: DEFAULT_H, collapsed: false } : readPane()));
  const save = (next: { height: number; collapsed: boolean }) => {
    setPane(next);
    try {
      localStorage.setItem(PANE_KEY, JSON.stringify(next));
    } catch {
      // Private window: the size lasts the session.
    }
  };
  return {
    ...pane,
    setCollapsed: (collapsed: boolean) => save({ ...pane, collapsed }),
    setHeight: (height: number) => save({ ...pane, height }),
  };
}

function PaneResizer({ height, onHeight }: { height: number; onHeight: (h: number) => void }) {
  const [live, setLive] = React.useState<number | null>(null);
  const start = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const y0 = e.clientY;
    // Never more than most of the panel: the layers below must stay reachable.
    const panel = el.closest("[data-layers-panel]")?.clientHeight ?? window.innerHeight;
    const max = Math.max(MIN_H, panel * 0.7);
    let h = height;
    const move = (ev: PointerEvent) => {
      h = Math.round(Math.min(max, Math.max(MIN_H, height + ev.clientY - y0)));
      setLive(h);
      onHeight(h);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      setLive(null);
      onHeight(h);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      title="Drag to size · double-click for the default"
      onPointerDown={start}
      onDoubleClick={() => onHeight(DEFAULT_H)}
      className={cn(
        DRAG_SURFACE,
        "absolute inset-x-0 -bottom-1 z-10 h-2 cursor-ns-resize after:absolute after:inset-x-0 after:top-1/2 after:h-px after:bg-primary after:opacity-0 after:transition-opacity hover:after:opacity-60",
        live !== null && "after:opacity-100",
      )}
    />
  );
}

/**
 * THE PROJECT'S 3D WORLDS — beside Components, every world wherever it lives
 * (most are nested inside a comp, out of sight on the Nested page). Not a page
 * of its own: worlds are scenes you step INTO, so the row lists them and a
 * pick takes you straight into that world's viewport, in its comp's context.
 */
function WorldsRow({ doc }: { doc: MotionDocument }) {
  const store = useDocStore();
  const [open, setOpen] = React.useState(false);
  const worlds = React.useMemo(() => worldEntries(doc), [doc]);
  if (worlds.length === 0) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Every 3D world in the project — pick one to step into it"
          className="flex h-(--control-h) w-full cursor-pointer select-none items-center gap-2 rounded-lg px-1.5 text-left text-body text-fg-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <Box className="size-3.5 shrink-0 text-(--kind-world)" />
          <span className="min-w-0 flex-1 truncate">3D worlds</span>
          <span className="text-meta tabular-nums text-fg-faint">{worlds.length}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" className="w-64 p-1">
        <div className="px-2 pb-1 pt-2 text-meta font-medium text-fg-muted">3D worlds</div>
        <div className="max-h-72 overflow-y-auto">
          {worlds.map(({ frame, parent }) => (
            <button
              key={frame.id}
              type="button"
              onClick={() => {
                setOpen(false);
                openWorldFrame(store, frame.id);
              }}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left transition-colors hover:bg-hover"
            >
              <Box className="size-3.5 shrink-0 text-(--kind-world)" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body">{frame.name || "World"}</span>
                <span className="block truncate text-meta text-fg-muted">{parent ? `in ${parent.name || "a comp"}` : "Artboard"}</span>
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
