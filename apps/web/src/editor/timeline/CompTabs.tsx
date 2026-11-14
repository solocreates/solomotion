"use client";

import * as React from "react";
import { Film, Pin, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { TabIndicator, useTabIndicator } from "@/components/ui/tab-indicator";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { flipbookOf, pageOfFrame } from "@solomotion/core";
import { useDoc } from "../state/document-context";
import { useSession } from "../state/session";
import { switchPage } from "../state/frame-nav";
import { focusStageOnBounds } from "../stage/stage-focus";
import { activeCompId, timelineHostOf } from "./timeline-utils";
import { capturePointer } from "../input/capture-pointer";
import { beginHeldDrag } from "../input/hold-to-drag";
import { subscribePointerEnd } from "../input/pointer-gestures";

/**
 * Timeline tabs + drill breadcrumb. Tabs are GLOBAL — every timeline you open
 * stays in the strip regardless of which page you're on, so paging/drilling
 * never rearranges it out from under you (opt into per-page filtering in
 * Settings). Tabs drag-reorder like browser tabs, click switches (and refocuses
 * the stage on that comp), right-click opens a context menu, and a tab can be
 * PINNED so it's immune to "close others" and always shown. A flipbook is ONE
 * tab (any cell inside collapses to it). Hidden only when there's nothing worth
 * showing (≤1 tab and nothing pinned).
 */
export function CompTabs() {
  const doc = useDoc();
  const nav = useSession((s) => s.nav);
  const activeFrameId = useSession((s) => s.activeFrameId);
  const activePageId = useSession((s) => s.activePageId);
  const open = useSession((s) => s.openTimelineIds);
  const pinned = useSession((s) => s.pinnedTimelineIds);
  const followPage = useSession((s) => s.tabsFollowActivePage);
  const stripRef = React.useRef<HTMLDivElement | null>(null);
  // The tabs PART: the theme's dialect draws the active tab (the playhead
  // dialect slides the accent bar under its name), like every other tab row.
  useTabIndicator(stripRef);

  // A flipbook is ONE tab (any cell collapses to it); a linked instance frame
  // collapses to its component definition (it has no timeline of its own). So
  // drilling cells / opening instances never multiplies tabs or spawns an empty
  // one — one component, one timeline.
  const tabOf = (id: string) => timelineHostOf(doc, flipbookOf(doc, id)?.id ?? id);
  // A tab IS a root comp; where you are inside it is the tab's own cursor,
  // remembered per tab and restored on switch. So the active tab is the nav's
  // root — not wherever the drill currently stands, which is what used to make
  // switching tabs look like it had thrown your place away.
  const compId = tabOf(nav.path.rootFrameId || activeCompId(doc, activeFrameId));
  const frameOf = React.useCallback((id: string) => doc.frames.find((f) => f.id === id), [doc.frames]);
  const frameName = (id: string) => frameOf(id)?.name ?? "?";
  const pinnedSet = new Set(pinned);

  const tabIds: string[] = [];
  for (const raw of [...open, compId]) {
    const id = tabOf(raw);
    if (tabIds.includes(id)) continue;
    const frame = frameOf(id);
    if (!frame) continue;
    // Per-page filtering (opt-in) hides tabs from other pages — but the active
    // comp and every pinned tab always show, so you're never left tab-less.
    if (followPage && id !== compId && !pinnedSet.has(id) && pageOfFrame(doc, frame) !== activePageId) continue;
    tabIds.push(id);
  }
  if (tabIds.length <= 1 && pinned.length === 0) return null;

  /** Switch to a tab AND refocus the stage on its comp (reuses the smart-focus
   *  foundation), so a tab click lands you looking at the right frame + time. */
  const switchTo = (id: string) => {
    const session = useSession.getState();
    session.openTimeline(id);
    // Focus on where the navigation actually LANDED (its root), which may not
    // be the id asked for: opening a comp that is somebody's private inside
    // re-roots through its owner rather than showing an orphan artboard.
    const landed = useSession.getState().nav.path.rootFrameId;
    const f = frameOf(landed);
    if (!f) return;
    const pageId = pageOfFrame(doc, f);
    // Only real pages are switchable — an internal source comp belongs to none.
    if (doc.pages.some((p) => p.id === pageId)) switchPage(doc, pageId, { frameId: f.id });
    focusStageOnBounds({ minX: f.x, minY: f.y, maxX: f.x + f.width, maxY: f.y + f.height });
  };

  /**
   * Click switches; a horizontal drag reorders (live, browser-tab style).
   *
   * The strip scrolls horizontally, which is the same gesture, so the scope
   * arbitrates rather than a private 4px threshold: a swipe moves through the
   * tabs, a brief hold then reorders one. Teardown is `subscribePointerEnd`,
   * which covers cancel and a lost pointer — this listened for `pointerup`
   * alone and leaked its move handler on every interrupted touch.
   */
  const tabPointerDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    const tab = e.currentTarget as HTMLElement;
    capturePointer(tab, e.pointerId);
    const arm = beginHeldDrag(e, { axis: "x" });
    let dragged = false;
    const onMove = (ev: PointerEvent) => {
      if (!arm.update(ev.clientX, ev.clientY)) return;
      if (!dragged) {
        dragged = true;
        // Pseudo-tab (active-but-unpinned) becomes a real tab the moment you drag it.
        if (!useSession.getState().openTimelineIds.includes(id))
          useSession.getState().moveTimelineTab(id, tabIds.indexOf(id));
      }
      const strip = stripRef.current;
      if (!strip) return;
      // Insertion index = how many OTHER tabs' centers sit left of the pointer.
      const others = Array.from(strip.querySelectorAll<HTMLElement>("[data-tab-id]")).filter(
        (el) => el.dataset.tabId !== id,
      );
      let to = 0;
      for (const el of others) {
        const r = el.getBoundingClientRect();
        if (ev.clientX > r.left + r.width / 2) to++;
      }
      const ids = useSession.getState().openTimelineIds;
      if (ids.indexOf(id) !== to) useSession.getState().moveTimelineTab(id, to);
    };
    const off = subscribePointerEnd((pid, reason) => {
      if (pid !== e.pointerId) return;
      arm.end();
      off();
      tab.removeEventListener("pointermove", onMove);
      // Switching is what a CLICK does. A swipe the strip took, or a pointer
      // that never came back, is not one.
      if (!dragged && reason === "up" && !arm.abandoned() && id !== compId) switchTo(id);
    });
    tab.addEventListener("pointermove", onMove);
  };

  return (
    <div className="flex h-8 shrink-0 items-center gap-1 bg-panel px-1.5">
      <div ref={stripRef} role="tablist" aria-label="Open timelines" data-part="tabs" className="flex h-full min-w-0 items-center gap-0.5 overflow-x-auto">
        <TabIndicator />
        {tabIds.map((id) => {
          const active = id === compId;
          const isPinned = pinnedSet.has(id);
          return (
            <ContextMenu key={id}>
              <ContextMenuTrigger asChild>
                <div
                  data-tab-id={id}
                  role="tab"
                  aria-selected={active}
                  onPointerDown={(e) => tabPointerDown(e, id)}
                  data-part="tab"
                  className={cn(
                    "group/tab flex h-full shrink-0 cursor-pointer select-none items-center gap-1 px-2 text-xs",
                    active && "font-medium",
                  )}
                >
                  {isPinned ? (
                    <Pin className="size-3 shrink-0 fill-current text-primary" />
                  ) : (
                    <Film className="size-3 shrink-0 opacity-70" />
                  )}
                  <span className="max-w-36 truncate">{frameName(id)}</span>
                  {/* Depth pip: this tab has a cursor parked inside it. Says
                      "you left off two levels down in here" at a glance, and
                      makes the restore-on-switch behaviour discoverable. */}
                  {active && nav.path.hops.length > 0 && (
                    <span
                      title={`${nav.path.hops.length} level${nav.path.hops.length > 1 ? "s" : ""} in`}
                      className="rounded bg-primary/15 px-1 text-[10px] font-medium leading-4 text-primary"
                    >
                      {nav.path.hops.length}
                    </span>
                  )}
                  {/* A pinned tab keeps its slot (no accidental close); unpinned
                      tabs show the × on hover. */}
                  {!isPinned && (
                    <button
                      type="button"
                      aria-label={`Close ${frameName(id)} timeline`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        useSession.getState().closeTimeline(id);
                      }}
                      className="rounded-sm p-px opacity-0 transition-opacity hover:bg-foreground/10 group-hover/tab:opacity-70"
                    >
                      <X className="size-3" />
                    </button>
                  )}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onClick={() => useSession.getState().togglePinTimeline(id)}>
                  {isPinned ? "Unpin tab" : "Pin tab"}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem disabled={isPinned} onClick={() => useSession.getState().closeTimeline(id)}>
                  Close
                </ContextMenuItem>
                <ContextMenuItem onClick={() => useSession.getState().closeOtherTimelines(id)}>
                  Close others
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>
      <div className="flex-1" />
    </div>
  );
}
