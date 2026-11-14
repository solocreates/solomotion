"use client";

import * as React from "react";
import { create } from "zustand";
import {
  clipEnd,
  flipbookInContext,
  isClipInScope,
  locateClip,
  treeRevealForClip,
  treeRevealForFrame,
  type AABB,
  type MotionDocument,
  type DocumentStore,
  type TreeReveal,
} from "@solomotion/core";
import { revealCompForClip, timelineEndMs } from "../timeline/timeline-utils";
import { timelineView } from "../timeline/timeline-view";
import { timelineViewport } from "../timeline/timeline-viewport";
import { focusStageOnBounds, isStageBoundsFullyVisible, revealStageBounds, stageBoundsOfClip } from "../stage/stage-focus";
import { audioCollapseId, useSession } from "./session";
import { switchPage } from "./frame-nav";

/**
 * SHOW WHAT IS SELECTED — on every surface, from one place.
 *
 * The canvas, the timeline and the layers list are three views of one
 * selection. Pick something in any of them (or follow a link to it, or let an
 * agent pick it) and the other two should be looking at it. They used to each
 * try on their own, at their own moment, and the gaps were the bugs: the layers
 * list scrolled to a row that did not exist yet because its group was folded,
 * or its page was not the one showing; the timeline's row reveal guessed two
 * animation frames for the unfold to land; and only the timeline setting could
 * unfold anything at all.
 *
 * So the work is split by what it IS rather than by who noticed:
 *
 *  1. STRUCTURE — make the target's row exist. Core answers where it lives
 *     (`treeRevealForClip`: page, comp, nested instances, groups); this opens
 *     exactly that, always, because a selection you cannot find in the list is
 *     a selection you cannot act on. Figma unfolds the layer tree the same way.
 *  2. CAMERAS — stage and timeline time. Opt-in (`focusStage` / `focusTime`)
 *     and polite: only when the target is not on screen at all, so a
 *     deliberate pan or zoom is never fought.
 *  3. ROWS — published as a sequenced request (`useSelectionReveal`). Each list
 *     scrolls its own viewport AFTER its own commit, when the row is really
 *     there — no frame-counting, and a row that turns up later (you open the
 *     comp the selection lives in) still comes into view then.
 *
 * Settled, not live: a marquee or a multi-clip drag flickers the selection
 * through intermediate sets, and nothing may move mid-gesture.
 *
 * A NAVIGATION (a followed link, ⌘P, a page switch, "go to definition") is the
 * same reveal with the politeness turned off — you asked to go there — so the
 * verbs that navigate end in `revealAsNavigation()` instead of each moving the
 * camera their own way.
 */

const SETTLE_MS = 140;

/** What the lists should bring into view, once the selection has settled. */
export interface SelectionReveal {
  /** Bumps per settle, so asking for the same row twice still fires. */
  seq: number;
  /** The primary selected clip (the last one — the inspector's rule). */
  clipId: string | null;
  /** The primary selected comp, when no clip is selected. */
  frameId: string | null;
  /** Whether the timeline follows too (`focusTime`). The layers list always does. */
  timelineRow: boolean;
}

interface RevealStore {
  reveal: SelectionReveal;
  /** Bumped by `revealAsNavigation`; answered on the next settle. */
  navSeq: number;
}

export const useSelectionReveal = create<RevealStore>(() => ({
  reveal: { seq: 0, clipId: null, frameId: null, timelineRow: false },
  navSeq: 0,
}));

/**
 * End every navigation verb with this, AFTER it has selected where it went: the
 * stage frames the selection unless all of it is already on screen, whatever
 * the smart-focus switches say.
 */
export function revealAsNavigation(): void {
  useSelectionReveal.setState((s) => ({ navSeq: s.navSeq + 1 }));
}

/** Installed once, by the editor shell. */
export function useSelectionRevealConductor(store: DocumentStore): void {
  React.useEffect(() => {
    let lastKey = "";
    let answeredNav = useSelectionReveal.getState().navSeq;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = () => {
      timer = undefined;
      const navSeq = useSelectionReveal.getState().navSeq;
      const navigate = navSeq !== answeredNav;
      answeredNav = navSeq;
      reveal(store.getState(), navigate);
    };
    const schedule = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(settle, ms);
    };

    const unsubSession = useSession.subscribe((s) => {
      const key = `${s.selectedClipIds.join(",")}|${s.selectedFrameIds.join(",")}`;
      if (key === lastKey) return;
      lastKey = key;
      schedule(SETTLE_MS);
    });
    // A navigation has nothing to settle — the verb already landed — so it is
    // answered on the next task, after the verb's own state writes.
    const unsubNav = useSelectionReveal.subscribe((s, prev) => {
      if (s.navSeq !== prev.navSeq) schedule(0);
    });
    return () => {
      unsubSession();
      unsubNav();
      if (timer) clearTimeout(timer);
    };
  }, [store]);
}

function reveal(doc: MotionDocument, navigate: boolean): void {
  const session = useSession.getState();
  const clipIds = session.selectedClipIds;
  const primaryClip = clipIds.length ? (locateClip(doc, clipIds[clipIds.length - 1]!)?.clip ?? null) : null;
  const primaryFrameId = primaryClip ? null : (session.selectedFrameIds[session.selectedFrameIds.length - 1] ?? null);

  // 1. STRUCTURE. Every selected clip gets its row; the PRIMARY one decides the
  //    page, since one page shows at a time.
  const trees = clipIds
    .map((id) => treeRevealForClip(doc, session.nav.path, id))
    .filter((t): t is TreeReveal => t != null);
  const primaryTree = primaryClip
    ? (trees[trees.length - 1] ?? null)
    : primaryFrameId
      ? treeRevealForFrame(doc, primaryFrameId)
      : null;
  if (primaryTree?.pageId && primaryTree.pageId !== (session.activePageId ?? doc.pages[0]?.id)) {
    switchPage(doc, primaryTree.pageId, { frameId: primaryTree.rootFrameId });
  }
  session.openTreeRows(
    trees.flatMap((t) => [t.rootFrameId, ...t.groups, ...(t.audioFrameId ? [audioCollapseId(t.audioFrameId)] : [])]),
    trees.flatMap((t) => t.instances),
  );

  // 3 (published first, so it is never skipped by an early return below).
  useSelectionReveal.setState((s) => ({
    reveal: { seq: s.reveal.seq + 1, clipId: primaryClip?.id ?? null, frameId: primaryFrameId, timelineRow: session.focusTime },
  }));

  // NEVER move a camera inside a flipbook or drawing. There the MAIN frame is
  // the flipbook artboard itself and it must stay put — selecting a cell (or
  // its child layer) picks the paint target, it is NOT a navigation, so the
  // camera must not pan and, above all, `focusTime`'s revealCompForClip must
  // not drill into the cell's comp (that spawned stray tabs, reset the stage to
  // 0,0, and yanked the playhead back on every scrub). The flipbook panel owns
  // the playhead here.
  const activeFrame = doc.frames.find((f) => f.id === session.activeFrameId);
  if (activeFrame && flipbookInContext(doc, activeFrame.id)) return;

  // 2. CAMERAS — one exactly-one target, Figma's singular "active layer"; a
  //    marquee of twenty has no single place to frame. A navigation always
  //    names one.
  const single = navigate || clipIds.length + session.selectedFrameIds.length === 1;
  if (!single) return;

  if (navigate || session.focusStage) {
    const bounds = primaryClip ? stageBoundsOfClip(doc, primaryClip.id) : primaryFrameId ? frameBounds(doc, primaryFrameId) : null;
    // A NAVIGATION was asked for, so it may frame the target (fit). A plain
    // selection is not: it never moves the camera while any part shows, and
    // off screen it is the smallest pan, never a zoom (D16).
    if (bounds && navigate) {
      if (!isStageBoundsFullyVisible(bounds)) focusStageOnBounds(bounds);
    } else if (bounds) revealStageBounds(bounds);
  }

  if (primaryClip && session.focusTime) focusTimelineOn(doc, primaryClip.id);
}

/**
 * The timeline's time half: the open comp scrolls to the clip and the playhead
 * lands on it. A clip in ANOTHER tab reveals its comp, because a selection you
 * cannot see is a selection you cannot act on; one you can already see from
 * here — in the open timeline or nested under it — does not drill, because
 * selecting a layer is not a navigation.
 */
function focusTimelineOn(doc: MotionDocument, clipId: string): void {
  const session = useSession.getState();
  const clip = locateClip(doc, clipId)?.clip;
  if (!clip) return;
  const reachable = isClipInScope(doc, session.nav.path, clip.id) || revealCompForClip(doc, clip.id);
  // Playhead and range only mean something in the comp the timeline shows.
  if (!reachable || clip.frameId !== useSession.getState().activeFrameId) return;
  const start = clip.startMs;
  const end = clipEnd(clip);
  const s = useSession.getState();
  // Never yanks a playhead already on it, never fights a running transport.
  if (!(s.playheadMs >= start && s.playheadMs < end) && !s.playing) s.setPlayhead(start);
  timelineView.focusRange(
    { startMs: start, endMs: end },
    timelineViewport.el?.clientWidth ?? 0,
    { startMs: 0, endMs: timelineEndMs(doc, clip.frameId) },
  );
}

function frameBounds(doc: MotionDocument, frameId: string): AABB | null {
  const f = doc.frames.find((x) => x.id === frameId);
  return f ? { minX: f.x, minY: f.y, maxX: f.x + f.width, maxY: f.y + f.height } : null;
}
