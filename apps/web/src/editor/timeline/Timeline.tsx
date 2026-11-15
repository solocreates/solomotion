"use client";

import * as React from "react";
import {
  compOwnerNested,
  openGroupChain,
  insertTrackNear,
  groupRows,
  ungroupClips,
  type GroupClip,
  type DocumentStore,
  formatTimecode,
  isClipLocked,
  locateClip,
  niceTickIntervalMs,
  setFrameDurationMs,
  formatTime,
  snapTime,
  type Clip,
  type Frame,
  type LoopMode,
  type VideoClip,
  type FrameLaneRow,
  type Track,
  type MotionDocument,
  compFps,
  snapshotSpanMs,
} from "@solomotion/core";
import { resolveDragSnapshot } from "../state/snapshot-drag";
import {
  Box,
  ArrowLeftRight,
  ArrowLeftToLine,
  ArrowRightToLine,
  AudioLines,
  Bookmark,
  BookmarkPlus,
  Brackets,
  Brush,
  Captions,
  Contrast,
  ChevronDown,
  Circle,
  Database,
  Combine,
  Eye,
  EyeOff,
  Layers2,
  Lock,
  Link2,
  LockOpen,
  Magnet,
  Repeat,
  Pause,
  Play,
  Plus,
  Scissors,
  SkipBack,
  Trash2,
  Type,
  Volume2,
  VolumeX,
  Orbit,
  Sparkles,
  Wind,
} from "lucide-react";
import { addWorldAtPlayhead } from "../world/make-3d";
import { openGenerate } from "../agent/generate-bus";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NumberInput } from "@/components/ui/number-input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { isForeignEvent } from "@/lib/portal-events";
import { formatCombo, useCombo } from "../state/shortcut-registry";
import { importFilesAsClips, placeAssetClips } from "../assets/import";
import { clipForAsset } from "@solomotion/core";
import { importDroppedFiles } from "../io/slice-file";
import { soundEngine } from "../audio/sound-engine";
import { useDoc, useDocSelector, useDocStore } from "../state/document-context";
import { addAdjustmentLayer, addClipAtPlayhead, addDrawingAtPlayhead, addFlipbookAtPlayhead, placeComponentInstance, placeLibraryItem, splitAtPlayhead, textPresetClip } from "../state/clip-actions";
import { placeClip } from "@solomotion/core";
import { ClipMenuItems, EmptyAreaMenuItems } from "../menus/selection-menu";
import { ReferenceBadge, ReferenceMenuItem, useIsReferenced } from "../drawing/reference-menu";
import { useSession, type LibraryDrag } from "../state/session";
import { createPlayheadMover } from "./playhead-motion";
import { syncEnteredGroup } from "../state/use-group-focus";
import { useHoldMenu } from "../state/use-hold-menu";
import { WorkspaceColorPicker } from "../ui/WorkspaceColorPicker";
import { ClipView } from "./ClipView";
import { applyAnimationDrop, applyTransition, describePresetDrop, gapAt, resolvePresetDrop } from "@solomotion/core";
import { toast } from "@/lib/toast";
import { TransitionLayer } from "./TransitionLayer";
import { PresetDropPreview, PRESET_DROP_TOLERANCE_PX, dragPresetKind } from "./PresetDropPreview";
import { applyLibraryItemToClip, libraryDropAppliesTo, libraryDropTargets } from "../library/apply-to-clip";
import { CompTabs } from "./CompTabs";
import { HeaderAction, HeaderDivider, HeaderGroup, HeaderToggle, LoopToggle } from "./header-controls";
import { addEmitter, addForce } from "../physics/actions";
import { lookIcon } from "../physics/emitter-icons";
import { EMITTER_LOOKS } from "@solomotion/core";
import { useTimeSurface } from "./use-time-surface";
import { laneZoomNow, pxPerSecNow, useLaneZoom, usePxPerSec } from "./use-time-axes";
import { drawnTimeWidth, timelineView, useClientWidth } from "./timeline-view";
import { useHeaderWidth, MIN_HEADER_W, MAX_HEADER_W } from "./header-width";
import { TrackListTools } from "./TrackListTools";
import { beginPlayheadScrub, SCRUB_SURFACE } from "./scrub";
import { useSweepSelect, rectSweepAllowed } from "../state/use-sweep-select";
import { LassoTools } from "../input/LassoTools";
import { LanesMinimap, TimeZoomMenu, useZoomPrefs } from "./TimeZoomBar";
import { ZoomBar, type ZoomBarMarker } from "../workspace/ZoomBar";
import { rowsAxis, timeAxis } from "./view-axes";
import { FootageOverrunDialog } from "./FootageOverrunDialog";
import { compSubject, hasAnyCoverage, hasFrame, setCachingEnabled } from "../cache/cache-status";
import { CachePanel } from "../cache/CachePanel";
import { setPostersEnabled } from "../preview/poster-cache";
import { useCacheStatusVersion, useCachingEnabled } from "../cache/use-cache-status";
import { addMarkerAtPlayhead, deleteMarkers } from "./markers";
import { timelineViewport } from "./timeline-viewport";
import { useIsCompact } from "../state/use-shell-density";
import { useSelectionReveal } from "../state/selection-reveal";
import { setWorkRangeBound, toggleWorkRange, useWorkRange } from "./work-range";
import {
  activeCompId,
  collectSnapCandidates,
  DEFAULT_LANE_HEIGHT,
  fitCanvasBacking,
  ghostLaneHeight,
  GROUP_CAPTION_HEIGHT,
  laneHeight,
  NEW_LANE_ARM_PX,
  openTimelineRows,
  pxToTime,
  rowAtY,
  RULER_HEIGHT,
  timelineEndMs,
  timelineRows,
  showsParts,
  timelineSpanMs,
  timeToPx,
  type TimelineRow,
  visibleMarkers,
} from "./timeline-utils";
import { PoseLaneHeader, PoseLaneRow } from "./PoseLanes";
import { capturePointer } from "../input/capture-pointer";
import { beginHeldDrag } from "../input/hold-to-drag";
import { subscribePointerEnd } from "../input/pointer-gestures";

/**
 * The timeline: ruler + playhead + tracks of clips. Scrub, drag, trim,
 * split (⌘B), marquee-select, ⌥drag duplicate, snap, zoom (⌘/Ctrl+wheel),
 * draggable keyframes with per-key easing. All edits are undoable steps.
 *
 * The playhead and timecode update via direct DOM writes — playback never
 * re-renders the React tree.
 */

/**
 * Add a lane where the user is LOOKING — above (or below) the selected layer's
 * lane, inheriting its group.
 *
 * "Add a track" used to mean "unshift one at the very top of the comp", which
 * is the one place it is almost never wanted: you are working at row six, and
 * the new row appears off-screen at row zero. Relative placement also makes
 * "add a track inside this group" fall out with no separate concept — the new
 * lane inherits the reference lane's group through `insertTrackNear`.
 */
export function addTrackNearSelection(
  store: DocumentStore,
  compId: string,
  where: "above" | "below",
): void {
  const session = useSession.getState();
  const doc = store.getState();
  const anchor = session.selectedClipIds[0] ? locateClip(doc, session.selectedClipIds[0]) : null;
  const near = anchor?.clip.frameId === compId ? anchor.track.id : null;
  store.update("Add track", (d) => {
    insertTrackNear(d, { frameId: compId, nearTrackId: near, where, name: `Track ${d.tracks.length + 1}` });
  });
}

export function Timeline() {
  const doc = useDoc();
  const store = useDocStore();
  const pxPerSec = usePxPerSec();
  const laneZoom = useLaneZoom();
  const splitCombo = useCombo("edit.split");
  const snapping = useSession((s) => s.snapping);
  const selectedClipIds = useSession((s) => s.selectedClipIds);
  const recording = useSession((s) => s.recording);
  const clipPreviews = useSession((s) => s.clipPreviews);
  const activeFrameId = useSession((s) => s.activeFrameId);

  // Same shape for clip pictures: the session holds the preference, the
  // headless store holds the bitmaps, and switching off frees them here rather
  // than leaving them parked for a switch-on that may never come.
  React.useEffect(() => {
    setPostersEnabled(clipPreviews);
  }, [clipPreviews]);
  // Track-header column width — ONE seam shared with the graph panel's
  // property tree so clip names and property names stay in the same gutter.
  const headerW = useHeaderWidth((s) => s.width);
  // D19: on a phone the header column scrolls WITH the lanes; the time
  // authority learns its width as an inset so every follower and hit test
  // still reads time from zero.
  const compact = useIsCompact();
  React.useLayoutEffect(() => {
    timelineView.setInset(compact ? headerW : 0);
  }, [compact, headerW]);
  React.useEffect(() => () => timelineView.setInset(0), []);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const headersRef = React.useRef<HTMLDivElement>(null);
  const lanesRef = React.useRef<HTMLDivElement>(null);

  // Publish the lanes viewport so keyboard-nav can scroll it vertically (↑↓).
  React.useEffect(() => timelineViewport.register(scrollRef.current), []);

  // Join the shared horizontal view (zoom + scroll authority for the timeline
  // AND the graph panel). The lanes register first, so they're the reference
  // scroller. applyPendingScroll runs in a LAYOUT effect — after React has
  // committed the new content width on zoom, before paint — which is what
  // makes cursor-anchored zoom land exactly instead of racing an rAF.
  React.useEffect(() => timelineView.registerScroller(scrollRef.current), []);
  React.useLayoutEffect(() => timelineView.applyPendingScroll(), [pxPerSec]);

  // The timeline shows ONE composition — the open comp's tracks and clips.
  const compId = activeCompId(doc, activeFrameId);
  const collapsedIds = useSession((s) => s.collapsedIds);
  const characterLayersIds = useSession((s) => s.characterLayersIds);
  const pendingNewLane = useSession((s) => s.pendingNewLane);
  // ONE row list — the comp's lanes, each open group's caption and rows spliced
  // beneath the lane its bar sits on, and the new-lane placeholders — with a
  // `top` and `height` per row. The header column, the lanes, every hit test
  // and the drop ghost read this same list, so a row index can never mean two
  // things at once. Lane heights follow the subscribed `laneZoom`.
  const rows = React.useMemo(
    () => timelineRows(doc, compId, new Set(collapsedIds), pendingNewLane, characterLayersIds, laneZoom),
    [doc, compId, collapsedIds, pendingNewLane, laneZoom, characterLayersIds],
  );

  // THE SELECTION'S ROW comes into view — once its lane exists in THIS list,
  // which may be a commit or two after the request (its group unfolding, its
  // comp's tab opening). An effect runs after the commit, so the lane is in the
  // DOM when it measures; no frame-counting. See `state/selection-reveal.ts`.
  const reveal = useSelectionReveal((s) => s.reveal);
  const revealLaneId =
    reveal.timelineRow && reveal.clipId && rows.some((r) => r.kind === "lane" && r.track.clips.some((c) => c.id === reveal.clipId))
      ? reveal.clipId
      : null;
  React.useEffect(() => {
    if (revealLaneId) timelineViewport.revealClipRow(revealLaneId);
  }, [reveal.seq, revealLaneId]);


  // Media dragged from the library and released over the lanes places a clip at
  // the dropped time in the open comp (state read fresh — no stale closure).
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onDrop = (e: Event) => {
      const { clientX, clientY, drag } = (
        e as CustomEvent<{ clientX: number; clientY: number; drag: LibraryDrag }>
      ).detail;
      if (!drag) return;
      const d = store.getState();
      const cid = activeCompId(d, useSession.getState().activeFrameId);
      const frame = d.frames.find((f) => f.id === cid);
      if (!frame) return;
      const x = timelineView.contentX(clientX, el);
      const startMs = Math.max(0, Math.round(pxToTime(x, pxPerSecNow())));

      // Both preset families land POSITIONALLY on the lane under the cursor:
      // a transition on the nearest cut, an animation on the half of the clip
      // aimed at. One resolver decides, the same one the drag ghost previewed,
      // so a drop can never do something the ghost did not promise.
      const presetKind = dragPresetKind(drag);
      if (presetKind) {
        const over = rowAtClientY(clientY);
        const lane = over?.kind === "lane" ? over.track : null;
        if (!lane) return;
        const tolerance = pxToTime(PRESET_DROP_TOLERANCE_PX, pxPerSecNow());
        const target = resolvePresetDrop(lane, cid, startMs, { kind: presetKind, id: drag.id }, tolerance);
        if (!target) {
          // Both families now fail in exactly one place — off the clips — so
          // one sentence covers both and neither can imply a rule the other
          // does not obey.
          toast(`Drop ${presetKind === "transition" ? "a transition" : "an animation"} on a clip`);
          return;
        }
        store.update(`Add ${drag.label}`, (doc) => {
          if (target.kind === "transition") applyTransition(doc, target.target, drag.id);
          else applyAnimationDrop(doc, target, drag.id);
        });
        toast(describePresetDrop(target, drag.label));
        return;
      }

      // Dropped PAST an edge → spawn a fresh track there, the same placeholder
      // the drag previewed (and that the intra-timeline clip drag commits from).
      // `MediaDropGhost` armed `pendingNewLane` while dragging; read it here, then
      // clear it (its own effect also clears on the release re-render).
      const pending = useSession.getState().pendingNewLane;
      const newLaneEdge = pending?.edge;
      useSession.getState().setPendingNewLane(null);
      // Otherwise which row the cursor is over — drop LANDS in that track (and
      // so in that track's group), matching the MediaDropGhost preview; a
      // group's caption means the top of its band; past the bottom → the last
      // lane.
      let preferredTrackId: string | undefined;
      let groupId: string | null = pending?.scope ?? null;
      let edge = newLaneEdge;
      if (!edge) {
        const over = rowAtClientY(clientY) ?? lastLaneRow();
        if (over?.kind === "lane") {
          preferredTrackId = over.track.id;
          groupId = over.scope?.id ?? null;
        } else if (over?.kind === "group") {
          edge = "top";
          groupId = over.group.id;
        }
      }
      const placement = edge ? { newLaneEdge: edge, groupId } : { preferredTrackId, groupId };
      // A component drops as an INSTANCE at the dropped time.
      if (drag.kind === "component") {
        placeComponentInstance(store, drag.id, { frameId: cid, startMs, ...placement });
        return;
      }
      // A snapshot — saved component, icon, any panel's clips — lands at the
      // dropped time on the lane the ghost previewed.
      if (drag.kind === "snapshot") {
        placeLibraryItem(store, drag.id, { frameId: cid, startMs }, placement);
        return;
      }
      // Drop-to-RESTYLE, same rule the canvas obeys: a template released ONTO a
      // layer it can change restyles that layer instead of creating a second
      // one. The shared predicate decides, so the timeline, the canvas and the
      // layers tree cannot disagree about what "onto a layer" means.
      const overClipId = (document.elementFromPoint(clientX, clientY) as Element | null)
        ?.closest("[data-clip-drop-id]")
        ?.getAttribute("data-clip-drop-id");
      if (overClipId && libraryDropAppliesTo(d, drag, overClipId)) {
        const targets = libraryDropTargets(overClipId, useSession.getState().selectedClipIds);
        applyLibraryItemToClip(store, drag, targets);
        useSession.getState().select([...targets]);
        toast(`${drag.label} applied`);
        return;
      }
      // A TEXT PRESET (template / animation) drops as a fresh text layer at the
      // dropped lane+time — the exact placement media/components use, so what the
      // ghost previewed is what lands. Same `textPresetClip` seam as the stage.
      const preset = textPresetClip(drag, { frameId: cid, startMs });
      if (preset) {
        store.update(drag.kind === "template" ? "Add template" : "Add text clip", (doc) =>
          placeClip(doc, preset, placement),
        );
        useSession.getState().select([preset.id]);
        return;
      }
      const asset = d.assets.find((a) => a.id === drag.id);
      if (!asset) return;
      // Split-aware placement (video keeps its sound as a linked audio lane).
      void placeAssetClips(
        store,
        asset,
        { frameId: cid, startMs },
        { width: frame.width, height: frame.height },
        placement,
      );
    };
    el.addEventListener("tm-library-drop", onDrop);
    return () => el.removeEventListener("tm-library-drop", onDrop);
  }, [store]);

  const spanMs = timelineSpanMs(doc, compId);

  // THE ZOOM BARS. The axes read state that has one owner each (timelineView,
  // pxPerSec, laneZoom); the markers say where the selection is on both.
  const minimapOn = useZoomPrefs((s) => s.minimap);
  const spanRef = React.useRef(spanMs);
  spanRef.current = spanMs;
  const timeAx = React.useMemo(() => timeAxis(() => spanRef.current), []);
  const rowsAx = React.useMemo(() => rowsAxis(() => scrollRef.current, RULER_HEIGHT), []);
  const { xMarkers, yMarkers } = React.useMemo(() => {
    const x: ZoomBarMarker[] = [];
    const y: ZoomBarMarker[] = [];
    if (selectedClipIds.length) {
      const picked = new Set(selectedClipIds);
      for (const r of rows) {
        if (r.kind !== "lane") continue;
        const hits = r.track.clips.filter((c) => picked.has(c.id));
        if (!hits.length) continue;
        y.push({ start: r.top / laneZoom, size: r.height / laneZoom });
        for (const c of hits) x.push({ start: c.startMs, size: c.durationMs });
      }
    }
    return { xMarkers: x, yMarkers: y };
  }, [rows, selectedClipIds, laneZoom]);
  // The scroller less the compact header column: the time the lanes show.
  const scrollerW = useClientWidth(scrollRef);
  const contentWidth = drawnTimeWidth(spanMs, pxPerSec, scrollerW - (compact ? headerW : 0));
  const drawnMs = pxToTime(contentWidth, pxPerSec);

  // Every gesture this surface has — ⌘/pinch zooms time, ⌥ zooms rows, two
  // fingers pinch and pan — through the ONE hook the flipbook sheet also uses.
  // X goes via the shared cursor-anchored controller (clamped to the whole
  // timeline duration so it can't fling into empty space past the end); Y is a
  // plain multiplier on `laneZoom`.
  const surface = useTimeSurface(scrollRef, {
    onZoomTime: (factor, centerX) => timelineView.zoom(centerX, factor, { startMs: 0, endMs: spanMs }),
    onZoomRows: (factor) => useSession.getState().setLaneZoom(laneZoomNow() * factor),
  });

  // Built once, mounted in whichever column the density puts it in.
  const headerRows = <>{rows.map((row) =>
            row.kind === "lane" ? (
              <TrackHeader key={row.track.id} track={row.track} depth={row.depth} inGroup={!!row.scope} />
            ) : row.kind === "group" ? (
              <GroupCaptionHeader key={`g-${row.group.id}`} groupId={row.group.id} name={row.group.name} frameId={row.group.frameId} height={row.height} depth={row.depth} rows={row.rows} character={!!row.group.poses?.length} parts={showsParts(row.group, characterLayersIds)} />
            ) : row.kind === "pose" ? (
              <PoseLaneHeader key={`p-${row.group.id}-${row.setId}`} group={row.group} setId={row.setId} height={row.height} indentPx={row.depth * NEST_STEP_PX} />
            ) : (
              <NewLaneGhostHeader key={`ghost-${row.edge}-${row.scope ?? "comp"}-${row.ghostRow}`} row={row} />
            ),
          )}</>;

  const syncHeaderScroll = () => {
    if (headersRef.current && scrollRef.current) {
      headersRef.current.scrollTop = scrollRef.current.scrollTop;
    }
  };

  /** The row under a client y — lane, group caption or ghost; null past the end. */
  const rowAtClientY = React.useCallback(
    (clientY: number): TimelineRow | null => {
      const lanes = lanesRef.current;
      if (!lanes) return null;
      return rowAtY(openTimelineRows(store.getState()), clientY - lanes.getBoundingClientRect().top);
    },
    [store],
  );
  /** The last lane row — where a drop past the bottom lands. */
  const lastLaneRow = React.useCallback((): TimelineRow | null => {
    const all = openTimelineRows(store.getState());
    for (let i = all.length - 1; i >= 0; i--) if (all[i]!.kind === "lane") return all[i]!;
    return null;
  }, [store]);
  const trackIdAtClientY = React.useCallback(
    (clientY: number): string | null => {
      const row = rowAtClientY(clientY);
      return row?.kind === "lane" ? row.track.id : null;
    },
    [rowAtClientY],
  );

  // Dragging a clip above the first lane / below the last spawns a new track at
  // that end (a small dead-zone past the edge, so it's intentional, not jitter).
  // Measured against the VISIBLE scroll viewport, not the full (possibly much
  // taller, off-screen) lanes content — a comp with more tracks than fit was
  // otherwise unreachable at the bottom, since that edge could sit well below
  // the browser window and no real cursor position could ever cross it. Only
  // armed at the actual scroll boundary, so a mid-scroll overshoot means
  // "scroll further", not "spawn a track".
  const laneEdgeAtClientY = React.useCallback((clientY: number): "top" | "bottom" | null => {
    const scroll = scrollRef.current;
    if (!scroll) return null;
    const rect = scroll.getBoundingClientRect();
    const visibleTop = rect.top + RULER_HEIGHT;
    // The bottom ghost row itself adds DEFAULT_LANE_HEIGHT to scrollHeight
    // without moving scrollTop — left uncorrected, showing it would
    // immediately read as "no longer scrolled to the bottom" and flicker the
    // ghost off, which would flicker it back on, forever. Discount its own
    // height so the boundary check stays about the REAL content.
    const pendingBottom = useSession.getState().pendingNewLane;
    const ghostLaneCount =
      pendingBottom?.edge === "bottom" && pendingBottom.scope === null
        ? Math.max(1, ...pendingBottom.clips.map((c) => c.row + 1))
        : 0;
    const bottomGhostPad = ghostLaneCount * ghostLaneHeight();
    if (scroll.scrollTop <= 0 && clientY < visibleTop - 6) return "top";
    // Arm the bottom slot from INSIDE the last band — not past the physical edge.
    // The lanes usually sit flush against the window bottom, so `clientY > bottom`
    // is unreachable; edge auto-scroll instead pins us at max scroll, and jamming
    // the cursor into the final NEW_LANE_ARM_PX there is the "make a track below"
    // intent. The scroll-boundary guard keeps it off while there's still content
    // to reveal, so scroll-then-arm never overlap (no flicker).
    if (
      scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - bottomGhostPad - 1 &&
      clientY > rect.bottom - NEW_LANE_ARM_PX
    ) {
      return "bottom";
    }
    return null;
  }, []);

  // ── Marquee selection over the lanes ─────────────────────────────────────
  const [marquee, setMarquee] = React.useState<{ x: number; y: number; w: number; h: number } | null>(null);

  /*
   * THE LASSO, beside the rect sweep rather than instead of it.
   *
   * The rectangle above is model-based (time × track arithmetic) and carries a
   * real behaviour the DOM cannot express: landing on PART of exactly one clip
   * selects that clip's keyframes instead of the clip. Replacing it with the
   * shared hook would have deleted that.
   *
   * So the two coexist, split by which is armed, and the lasso uses the shared
   * `useSweepSelect` against `data-clip-drop-id` — the attribute clips already
   * carried for drag-and-drop. Nothing was added to the markup to make free
   * selection work here.
   */
  const lassoBase = React.useRef<string[]>([]);
  const lasso = useSweepSelect(lanesRef, "data-clip-drop-id", {
    onDragStart: (additive) => {
      lassoBase.current = additive ? useSession.getState().selectedClipIds : [];
    },
    onSweep: (ids) =>
      useSession.setState({
        selectedClipIds: [...new Set([...lassoBase.current, ...ids])],
        selectedFrameIds: [],
      }),
    onClear: () => useSession.getState().clearSelection(),
  });

  const startMarquee = (e: React.PointerEvent) => {
    // Only on empty lane space (clips stop propagation).
    if (e.button !== 0) return;
    // One predicate, shared with every other marquee in the app: a finger and a
    // pen scroll, and an armed lasso owns the pointer outright.
    if (!rectSweepAllowed(e)) return;

    const lanes = lanesRef.current;
    if (!lanes) return;
    capturePointer((e.currentTarget as HTMLElement), e.pointerId);
    const rect = lanes.getBoundingClientRect();
    const start = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const base = e.shiftKey ? useSession.getState().selectedClipIds : [];
    if (!e.shiftKey) useSession.getState().clearSelection();
    let moved = false;
    // Where the press landed, for the gap resolution on release below.
    const pressRow = rowAtClientY(e.clientY);
    const pressTime = pxToTime(start.x, pxPerSecNow());

    const onMove = (ev: PointerEvent) => {
      const cur = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
      if (!moved && Math.hypot(cur.x - start.x, cur.y - start.y) < 4) return;
      moved = true;
      const r = {
        x: Math.min(start.x, cur.x),
        y: Math.min(start.y, cur.y),
        w: Math.abs(start.x - cur.x),
        h: Math.abs(start.y - cur.y),
      };
      setMarquee(r);
      const d = store.getState();
      const pps = pxPerSecNow();
      const t0 = pxToTime(r.x, pps);
      const t1 = pxToTime(r.x + r.w, pps);
      const comp = activeCompId(d, useSession.getState().activeFrameId);
      const hitClips: Clip[] = [];
      for (const row of openTimelineRows(d)) {
        if (row.kind !== "lane" || row.top + row.height < r.y || row.top > r.y + r.h) continue;
        const track = row.track;
        for (const clip of track.clips) {
          if (clip.frameId !== comp || isClipLocked(track, clip)) continue;
          if (clip.startMs < t1 && clip.startMs + clip.durationMs > t0) hitClips.push(clip);
        }
      }

      // Smart target: a rect that lands on PART of exactly one clip selects that
      // clip's keyframes inside it. Enclosing the whole clip (or hitting several,
      // or ⇧-adding) selects clips — the same rectangle, two behaviours.
      const solo = hitClips.length === 1 && !e.shiftKey ? hitClips[0]! : null;
      const enclosesSolo = !!solo && t0 <= solo.startMs && t1 >= solo.startMs + solo.durationMs;
      if (solo && !enclosesSolo && solo.keyframes.length > 0) {
        const keyIds: string[] = [];
        for (const tr of solo.keyframes) {
          for (const k of tr.keys) {
            const abs = solo.startMs + k.timeMs;
            if (abs >= t0 && abs <= t1) keyIds.push(k.id);
          }
        }
        useSession.setState({ selectedClipIds: [solo.id], selectedFrameIds: [], selectedKeyframeIds: keyIds });
        return;
      }
      useSession.setState({
        selectedClipIds: [...new Set([...base, ...hitClips.map((c) => c.id)])],
        selectedFrameIds: [],
        selectedKeyframeIds: [],
      });
    };
    const onUp = () => {
      setMarquee(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      /*
       * A PRESS THAT NEVER MOVED, on a lane → that spot is the selection: the
       * lane is now where a paste lands, and if the spot lies in a hole, the
       * hole is what Delete closes (`laneSpot`).
       *
       * Resolved on RELEASE rather than on the press, for the same reason the
       * ⇧-toggle is: until the pointer lets go, this gesture might still be a
       * marquee, and a lane that lit up under a rubber band would be lying about
       * what is selected. Nothing is rendered into the lane to catch this click
       * either — a hit box over every hole would be the exact bug the clip
       * chrome layer just fixed, eating the drag that starts on empty space.
       */
      if (moved || e.shiftKey || !pressRow || pressRow.kind !== "lane") return;
      const d = store.getState();
      useSession.getState().setLaneSpot({
        trackId: pressRow.track.id,
        frameId: activeCompId(d, useSession.getState().activeFrameId),
        startMs: Math.max(0, pressTime),
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Right-click aims the shared menu at the clip under the cursor (and
  // selects it, Figma-style) or at empty lane space.
  const [menuOnClip, setMenuOnClip] = React.useState(false);
  const onLanesContextMenu = (e: React.MouseEvent) => {
    // Portalled floating layers are React descendants of the lanes — a
    // right-click in a popover must not re-target the SELECTION (see
    // lib/portal-events).
    if (isForeignEvent(scrollRef.current, e)) return;
    const el = (e.target as HTMLElement).closest("[data-clip-drop-id]");
    const clipId = el?.getAttribute("data-clip-drop-id");
    if (clipId) {
      const session = useSession.getState();
      if (!session.selectedClipIds.includes(clipId)) session.select([clipId]);
      setMenuOnClip(true);
    } else {
      setMenuOnClip(false);
      // Right-clicking a lane picks the spot, exactly as a left-click does, so
      // "Paste here" and "Close gap" act on what the pointer is over rather
      // than on whatever happened to be picked before the menu opened.
      const lanes = lanesRef.current;
      const row = rowAtClientY(e.clientY);
      if (lanes && row?.kind === "lane") {
        const d = store.getState();
        const x = e.clientX - lanes.getBoundingClientRect().left;
        useSession.getState().setLaneSpot({
          trackId: row.track.id,
          frameId: activeCompId(d, useSession.getState().activeFrameId),
          startMs: Math.max(0, pxToTime(x, pxPerSecNow())),
        });
      }
    }
  };

  return (
    <div
      className="flex h-full flex-col bg-panel"
      data-timeline
      // Touching the timeline routes arrow-key gestures here (keyboard-nav.ts).
      onPointerDownCapture={() => useSession.getState().setFocusedPanel("timeline")}
    >
      {/* Comp tabs + drill breadcrumb (only when nesting is in play) */}
      <CompTabs />
      {/* HEADER. Read left to right it is: transport · time · edit tools ·
          (spacer) · add · zoom. Every control resolves to `--control-h` and the
          only separator is `HeaderDivider`, so the groups read as groups.
          Controls hold their size and the bar scrolls X on a narrow window
          rather than squeezing icons out of shape. */}
      <div
        className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto overflow-y-hidden border-b px-2 *:shrink-0"
        style={{ scrollbarWidth: "none" }}
      >
        <Transport />
        <RecordControl recording={recording} />
        <CachingControl />
        <HeaderDivider />
        <TimeDisplay fps={compFps(doc, compId)} />
        <DurationField />
        <FrameLoopField />
        <HeaderDivider />
        <HeaderAction
          icon={<Scissors />}
          ariaLabel="Split at playhead"
          tooltip="Split at playhead"
          combo={splitCombo ?? undefined}
          onClick={() => splitAtPlayhead(store)}
        />
        <SnapControl snapping={snapping} />
        <LinkedSelectionControl />
        <MarkersControl compId={compId} />
        <RangeControl compId={compId} />
        <div className="flex-1" />
        {/* In the right-hand ACTION cluster, beside Track and Clip. It was in
            the middle of the edit tools as a bare icon, which put a
            hover-explained glyph among controls that change how a drag behaves
            — and it is neither of those things. It is something you turn on to
            do a thing, and it is labelled. */}
        <LassoTools
          selectedCount={selectedClipIds.length}
          onDeselect={() => useSession.getState().clearSelection()}
        />
        <HeaderDivider />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => addTrackNearSelection(store, compId, "above")}
            >
              <Plus /> Track
            </Button>
          </TooltipTrigger>
          <TooltipContent>New lane above the selected layer — any clip rides any lane</TooltipContent>
        </Tooltip>
        <DropdownMenu>
          {/* Tooltip must wrap the TRIGGER, not sit inside it: a Radix Tooltip
              root renders no DOM and drops foreign props, so a
              DropdownMenuTrigger asChild around it never reaches the button —
              the menu simply doesn't open. Innermost slot = the real Button. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" size="xs">
                  <Plus /> Clip
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Add a clip at the playhead</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => addClipAtPlayhead(store, "text")}>
              <Type /> Text
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => addClipAtPlayhead(store, "caption")}>
              <Captions /> Caption
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => addClipAtPlayhead(store, "audio")}>
              <AudioLines /> Sound
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => addDrawingAtPlayhead(store)}>
              <Brush /> Drawing
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => addFlipbookAtPlayhead(store)}>
              <Layers2 /> Flipbook
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => addWorldAtPlayhead(store)}>
              <Box /> 3D world
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => addAdjustmentLayer(store)}>
              <Contrast /> Adjustment layer
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => addForce(store, "wind")}>
              <Wind /> Force field
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Orbit /> Particles
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {/* A sub look (crackle, splash) throws from another card: it lives on a card's picker, not here. */}
                {EMITTER_LOOKS.filter((look) => look.type !== "sub").map((look) => {
                  const Icon = lookIcon(look.id);
                  return (
                    <DropdownMenuItem key={look.id} onClick={() => addEmitter(store, look.id)}>
                      <Icon /> {look.name}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            {/* Made by AI, landed here at the playhead — one dialog, the agent's own verbs. */}
            <DropdownMenuItem onClick={() => openGenerate("image")}>
              <Sparkles /> AI image…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => openGenerate("video")}>
              <Sparkles /> AI video…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => openGenerate("speech")}>
              <Sparkles /> AI voiceover…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => openGenerate("sound")}>
              <Sparkles /> AI sound effect…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => openGenerate("music")}>
              <Sparkles /> AI music…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Record-mode indicator: a breathing transparent→primary→transparent
          wash across the top of the timeline (Figma Motion style). */}
      <div
        aria-hidden
        className={cn(
          "relative h-0.5 shrink-0 overflow-hidden transition-opacity duration-200",
          recording ? "opacity-100" : "opacity-0",
        )}
      >
        {/* Breathing only while recording: an infinite animation hidden at
            opacity 0 still restyled and repainted the page every frame. */}
        <div className={cn("absolute inset-0 bg-[linear-gradient(90deg,transparent,var(--primary),transparent)]", recording && "tm-record-glow")} />
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        {/* Track headers — wheel here scrolls the lanes; lanes scroll syncs back.
            COMPACT (D19): the column moves INSIDE the lanes' scroller instead,
            ahead of time zero, so a swipe slides the names away and gives time
            the whole width; swiping back reveals them. Not sticky, on purpose. */}
        {!compact && (
        <div
          ref={headersRef}
          className="relative shrink-0 overflow-hidden border-r bg-panel"
          style={{ width: headerW }}
          onWheel={(e) => {
            if (scrollRef.current) scrollRef.current.scrollTop += e.deltaY;
          }}
        >
          {/* The corner above the lane headers — list-level tools (sort, tidy
              up), not lane-level ones. See `TrackListTools`. */}
          <div style={{ height: RULER_HEIGHT }} className="flex items-center border-b">
            <TrackListTools compId={compId} />
          </div>
          {headerRows}
          <HeaderWidthHandle />
        </div>
        )}

        {/* Lanes + ruler, and the rows bar (or minimap) at their right */}
        <div className="flex min-w-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                ref={scrollRef}
                data-timeline-drop
                onScroll={() => {
                  syncHeaderScroll();
                  timelineView.onScroll();
                }}
                onContextMenuCapture={onLanesContextMenu}
                // `surface.className` carries the viewport's touch-action — see
                // `useTimeSurface` for why it belongs here and not on each of
                // the dozen draggables inside.
                className={cn("tm-scroll-owned relative h-full w-full overflow-auto", surface.className)}
                onDragOver={(e) => {
                  if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
                }}
                onDrop={(e) => {
                  // Files dropped on the lanes import into the open comp at the
                  // cursor's time — media as clips, slice files nested as
                  // instances — through the one shared dispatcher.
                  const files = Array.from(e.dataTransfer?.files ?? []);
                  if (files.length === 0) return;
                  e.preventDefault();
                  const el = scrollRef.current!;
                  const x = timelineView.contentX(e.clientX, el);
                  const startMs = Math.max(0, pxToTime(x, pxPerSec));
                  const trackId = trackIdAtClientY(e.clientY) ?? undefined;
                  void importDroppedFiles(store, files, {
                    media: { frameId: compId, startMs, placement: { preferredTrackId: trackId } },
                    data: { intoComp: { frameId: compId, startMs, trackId } },
                  });
                }}
              >
                <div className={compact ? "flex min-h-full" : "contents"} style={compact ? { width: headerW + contentWidth } : undefined}>
                {compact && (
                  <div className="relative shrink-0 border-r bg-panel" style={{ width: headerW }}>
                    <div style={{ height: RULER_HEIGHT }} className="sticky top-0 z-20 flex items-center border-b bg-panel">
                      <TrackListTools compId={compId} />
                    </div>
                    {headerRows}
                  </div>
                )}
                <div className="relative flex min-h-full flex-col" style={{ width: contentWidth }}>
                  <Ruler spanMs={spanMs} drawnMs={drawnMs} pxPerSec={pxPerSec} compId={compId} />
                  {/*
                   * flex-1: the lanes column fills whatever's left of the panel
                   * below the ruler (min-h-full on the row above makes that a
                   * real height to grow into) instead of collapsing to exactly
                   * the tracks' own content height — a comp with 1 track no
                   * longer looks like the whole panel shrank to fit it. A fixed-
                   * height sibling like CurvesPanel (sticky, explicit height,
                   * no flex-grow) still gets its own room first; lanes only take
                   * what's left. Real content taller than the panel still grows
                   * past 100% and scrolls, same as before.
                   */}
                  <div
                    ref={lanesRef}
                    /*
                     * `isolate z-0` — the lanes are a LAYER, under the ruler.
                     *
                     * Without it the lanes column and the sticky ruler are
                     * siblings in one stacking context, so every z-index inside
                     * a lane competes with the ruler's own `z-20` directly: a
                     * clip's animation/transition chip (z-20, later in the DOM),
                     * its resize hint (z-30) and its trim handles (35, 40) all
                     * won, and slid over the time axis while you dragged them.
                     *
                     * Raising the ruler would only move the fight — the next
                     * overlay someone adds inside a lane starts it again. A
                     * stacking context ends it by construction: everything in
                     * the lanes now composites among ITSELF and the whole layer
                     * sits below the ruler, whatever numbers it uses inside.
                     * The playhead is deliberately a SIBLING of this box, not a
                     * child, because it is the one mark that spans both.
                     */
                    className={cn("relative isolate z-0 flex-1", lasso.surfaceClassName)}
                    onPointerDown={(e) => {
                      lasso.onPointerDown(e);
                      startMarquee(e);
                    }}
                    onDoubleClick={(e) => {
                      // Double-click empty space CLOSES what is open right
                      // there: inside a band, that band's group; on a lane,
                      // every open group whose bar sits on it. Local and
                      // predictable — the groups you left open elsewhere stay
                      // open. An entered group leaves as it folds (Figma:
                      // click outside to leave a group).
                      const s = useSession.getState();
                      const over = rowAtClientY(e.clientY);
                      const fold: string[] = [];
                      if (over?.kind === "lane" && over.scope) fold.push(over.scope.id);
                      else if (over?.kind === "group") fold.push(over.group.id);
                      else if (over?.kind === "lane") {
                        for (const c of over.track.clips) {
                          if (c.kind === "group" && c.frameId === compId && !s.collapsedIds.includes(c.id)) fold.push(c.id);
                        }
                      }
                      if (fold.length === 0 && s.enteredGroupId) fold.push(s.enteredGroupId);
                      for (const id of fold) s.setCollapsed(id, true);
                      // Folding a row you are inside steps the context out to
                      // the deepest open group that is still showing — one
                      // level for its own row, more when an ancestor folded.
                      const chain = openGroupChain(store.getState(), s.enteredGroupId);
                      const outermostFolded = chain.reduce((k, id, i) => (fold.includes(id) ? i : k), -1);
                      if (outermostFolded >= 0) {
                        const next = chain[outermostFolded + 1] ?? null;
                        s.retreatToGroup(next, chain.slice(outermostFolded + 1));
                      }
                    }}
                  >
                    {/* The polygon, in the lanes' own coordinate space. */}
                    {lasso.marqueeNode}
                    {/* Each open group's WINDOW, drawn under its rows — exactly
                        the bar's span, so what the band shows is what the group
                        shows. Behind the lanes, so nothing on them is covered. */}
                    <GroupBands rows={rows} pxPerSec={pxPerSec} />
                    {rows.map((row) =>
                      row.kind === "lane" ? (
                        <TrackLane
                          key={row.track.id}
                          track={row.track}
                          height={row.height}
                          depth={row.depth}
                          inGroup={!!row.scope}
                          compId={compId}
                          pxPerSec={pxPerSec}
                          rowAtClientY={rowAtClientY}
                          laneEdgeAtClientY={laneEdgeAtClientY}
                        />
                      ) : row.kind === "group" ? (
                        <GroupCaptionLane key={`g-${row.group.id}`} groupId={row.group.id} startMs={row.group.startMs} durationMs={row.group.durationMs} height={row.height} depth={row.depth} pxPerSec={pxPerSec} />
                      ) : row.kind === "pose" ? (
                        <PoseLaneRow key={`p-${row.group.id}-${row.setId}`} group={row.group} setId={row.setId} height={row.height} pxPerSec={pxPerSec} style={nestStyle(row.depth)} />
                      ) : (
                        <NewLaneGhostLane key={`ghost-${row.edge}-${row.scope ?? "comp"}-${row.ghostRow}`} row={row} pxPerSec={pxPerSec} />
                      ),
                    )}
                    <TimelineDimOverlay pxPerSec={pxPerSec} compId={compId} />
                    <EndBar pxPerSec={pxPerSec} />
                    <RangeBars pxPerSec={pxPerSec} compId={compId} />
                    <SnapIndicator pxPerSec={pxPerSec} />
                    <MediaDropGhost
                      scrollRef={scrollRef}
                      lanesRef={lanesRef}
                      pxPerSec={pxPerSec}
                      compId={compId}
                      laneEdgeAtClientY={laneEdgeAtClientY}
                    />
                    {marquee && (
                      <div
                        className="pointer-events-none absolute z-40 border border-primary/70 bg-primary/10"
                        style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
                      />
                    )}
                  </div>
                  <Playhead pxPerSec={pxPerSec} spanMs={spanMs} scrollRef={scrollRef} />
                </div>
                </div>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              {menuOnClip ? <ClipMenuItems store={store} /> : <EmptyAreaMenuItems store={store} />}
            </ContextMenuContent>
          </ContextMenu>
        </div>
        <ZoomBar
          axis={rowsAx}
          orientation="y"
          label="Tracks — scroll and row height"
          markers={yMarkers}
          wide={minimapOn}
          background={minimapOn ? (extent) => <LanesMinimap rows={rows} extent={extent} laneZoom={laneZoom} spanMs={spanMs} /> : undefined}
          className={cn("shrink-0 border-l border-line", minimapOn ? "w-16 px-1" : "w-3.5")}
          style={{ marginTop: RULER_HEIGHT }}
        />
        </div>
      </div>
      {/* The zoom row: the magnifier under the track names, the time bar under
          the lanes — so the bar's width IS the lanes' viewport. */}
      <div className="flex h-6 shrink-0 items-center border-t border-line bg-panel">
        <div className="flex shrink-0 items-center px-1" style={{ width: compact ? undefined : headerW }}>
          <TimeZoomMenu time={timeAx} rows minimap />
        </div>
        <ZoomBar
          axis={timeAx}
          orientation="x"
          label="Time — scroll and zoom"
          markers={xMarkers}
          playhead
          className="mx-2.5 h-full flex-1"
        />
        <div className={cn("shrink-0", minimapOn ? "w-16" : "w-3.5")} />
      </div>
      </div>

      <FootageOverrunDialog />
    </div>
  );
}

/** Drag seam on the header gutter's right edge — resizes BOTH the track
 *  headers and the graph panel's property tree (one shared width). */
function HeaderWidthHandle() {
  // Reads and writes the shared gutter store directly — the handle is the
  // store's editor, so threading the value down through Timeline only made
  // Timeline look like the owner of something it no longer owns.
  return (
    <div
      className="absolute inset-y-0 right-0 z-30 w-1.5 translate-x-1/2 cursor-ew-resize transition-colors hover:bg-primary/40"
      onPointerDown={(e) => {
        e.preventDefault();
        capturePointer((e.currentTarget as Element), e.pointerId);
        const startX = e.clientX;
        const startW = useHeaderWidth.getState().width;
        const onMove = (ev: PointerEvent) => {
          useHeaderWidth.getState().set(Math.max(MIN_HEADER_W, Math.min(MAX_HEADER_W, startW + (ev.clientX - startX))));
        };
        const onUp = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          useHeaderWidth.getState().commit();
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      }}
    />
  );
}

/**
 * A translucent preview of the clip a dragged media asset would create, shown
 * in the lane under the cursor at the exact time it will land. Same asset →
 * same duration/label the drop produces, so what you see is what drops.
 */
function MediaDropGhost({
  scrollRef,
  lanesRef,
  pxPerSec,
  compId,
  laneEdgeAtClientY,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  lanesRef: React.RefObject<HTMLDivElement | null>;
  pxPerSec: number;
  compId: string;
  laneEdgeAtClientY: (clientY: number) => "top" | "bottom" | null;
}) {
  // Follows a drag the browser reports outside React, reading the live stores
  // every render by design. Memoising it would pin the ghost.
  "use no memo";
  const drag = useSession((s) => s.libraryDrag);
  const pos = useSession((s) => s.libraryDragPos);
  // Only a drag places anything at the playhead: subscribed to nothing
  // otherwise, or this ghost re-rendered every frame of playback.
  const playheadMs = useSession((s) => (s.libraryDrag ? s.playheadMs : 0));
  const doc = useDoc();

  const scroll = scrollRef.current;
  const lanes = lanesRef.current;
  const bounds = scroll?.getBoundingClientRect();
  const kind = drag?.kind;
  const overStage = pos?.over === "stage";
  const overTimeline = pos?.over === "timeline";
  // Media AND text presets get the same live lane ghost — the exact clip they'd
  // drop, previewed. Components/custom snapshots place on release but don't
  // preview here (multi-clip / instance, no single outline).
  //
  // PRESET drags are the exception, and it is a rule not a special case: over
  // the TIMELINE they modify an existing clip rather than creating one — an
  // animation lands on a clip's in/out edge, a transition on a cut — so
  // `PresetDropPreview` owns the preview there and shows the real placement.
  // A clip-shaped ghost would be promising something the drop will not do.
  // Over the STAGE an animation genuinely does create a text clip, so the ghost
  // stays correct there.
  const previewable =
    kind === "media" ||
    kind === "template" ||
    kind === "snapshot" ||
    (kind === "anim" && !overTimeline);
  // Preview over BOTH surfaces: over the timeline the clip lands where the cursor
  // is; over the STAGE it lands at the PLAYHEAD (a canvas drop always starts at
  // the current time) on the top lane — so you see exactly what will drop either
  // way. The past-edge new-lane placeholder is timeline-only.
  const active = previewable && (overStage || overTimeline) && !!scroll && !!lanes && !!bounds;
  const frame = active ? doc.frames.find((f) => f.id === compId) : undefined;
  const asset = active && kind === "media" ? doc.assets.find((a) => a.id === drag!.id) : undefined;

  // The clip a drop would create — its duration drives BOTH the in-lane ghost
  // and the past-edge placeholder, so what you see is exactly what drops. One
  // seam per kind: `clipForAsset` for media, `textPresetClip` for presets.
  const startMs = !active
    ? 0
    : overStage
      ? Math.max(0, Math.round(playheadMs))
      : Math.max(0, Math.round(pxToTime(pos!.x - lanes!.getBoundingClientRect().left, pxPerSec)));
  const clip: { durationMs: number } | null =
    !active || !frame
      ? null
      : kind === "media"
        ? asset
          ? clipForAsset(asset, { frameId: compId, startMs }, { width: frame.width, height: frame.height })
          : null
        : kind === "snapshot"
          ? // A snapshot lands as one thing spanning its latest clip — the
            // group's bar, or the single layer's.
            (() => {
              const hit = resolveDragSnapshot(drag!.id);
              return hit ? { durationMs: snapshotSpanMs(hit.snapshot) } : null;
            })()
          : textPresetClip(drag!, { frameId: compId, startMs });
  const label = asset?.name ?? drag?.label ?? "";

  // Cursor within the timeline column horizontally, pushed past the top/bottom
  // edge → arm the SHARED `pendingNewLane` placeholder (the same one the clip
  // drag uses); its ghost lane/header render the preview, so nothing to draw here.
  const overColumn = !!active && overTimeline && pos!.x >= bounds!.left && pos!.x <= bounds!.right;
  // The SAME row list the lanes render from, or the ghost lands on a different
  // row than the one under the cursor. A group's caption is the top of its
  // band: hovering it previews a new first row inside that group.
  const laneRows = timelineRows(doc, compId, new Set(useSession.getState().collapsedIds), null);
  const yLocal = overColumn && lanes ? pos!.y - lanes.getBoundingClientRect().top : NaN;
  const under = overColumn ? rowAtY(laneRows, yLocal) : null;
  const edge: { edge: "top" | "bottom"; scope: string | null } | null =
    overColumn && clip
      ? under?.kind === "group"
        ? { edge: "top", scope: under.group.id }
        : (() => {
            const e = laneEdgeAtClientY(pos!.y);
            return e ? { edge: e, scope: null } : null;
          })()
      : null;
  const durationMs = clip?.durationMs ?? 0;
  const edgeKey = edge ? `${edge.edge}:${edge.scope ?? ""}` : "";
  React.useEffect(() => {
    if (!edge) return;
    useSession.getState().setPendingNewLane({ ...edge, clips: [{ startMs, durationMs, row: 0 }] });
    return () => useSession.getState().setPendingNewLane(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edgeKey, startMs, durationMs]);

  if (!active || !frame || !clip) return null;
  // Past an edge: the placeholder row shows the clip — don't double-draw.
  if (edge) return null;

  // Which lane the ghost sits on: over the stage it's the TOP lane (where a
  // canvas drop lands); over the timeline it's the lane under the cursor (past
  // the bottom → the last lane). Same content-space math for both.
  const laneOnly = laneRows.filter((r) => r.kind === "lane");
  let lane: TimelineRow | undefined;
  if (overStage) {
    lane = laneOnly[0];
  } else {
    if (pos!.y < bounds!.top || pos!.y > bounds!.bottom || !overColumn) return null;
    lane = under?.kind === "lane" ? under : laneOnly[laneOnly.length - 1];
  }
  const top = lane?.top ?? 0;
  const height = lane?.height ?? 44;

  return (
    <div
      className="pointer-events-none absolute z-50 flex items-center overflow-hidden rounded-md border-2 border-dashed border-primary/80 bg-primary/20 px-2 text-[11px] font-medium text-foreground/90"
      style={{
        left: timeToPx(startMs, pxPerSec),
        width: Math.max(timeToPx(clip.durationMs, pxPerSec), 8),
        top: top + 4,
        height: Math.max(height - 8, 12),
      }}
    >
      <span className="truncate">{label}</span>
    </div>
  );
}

/**
 * Live preview of the track a clip drag-past-the-edge would create, shown in
 * the LANES column: a placeholder row plus the dragged clips' own outlines at
 * their free-drag positions. A row of the ONE row list (`timelineRows`), so it
 * sits exactly where the drop will put the new lane — the comp's edge, or the
 * first/last row of a group's band. Purely derived from ephemeral session
 * state; no document mutation happens until the drop commits it via
 * `moveClipsToNewLanes`, so dragging back onto a real row before releasing
 * just clears this and nothing was ever created.
 */
function NewLaneGhostLane({ row, pxPerSec }: { row: TimelineRow & { kind: "ghost" }; pxPerSec: number }) {
  const pending = useSession((s) => s.pendingNewLane);
  if (!pending) return null;
  return (
    <div
      className="relative border-b border-dashed border-primary/50 bg-primary/5"
      style={{ height: row.height, ...nestStyle(row.depth) }}
    >
      {pending.clips
        .filter((c) => c.row === row.ghostRow)
        .map((c, i) => (
          <div
            key={i}
            className="pointer-events-none absolute top-1 bottom-1 rounded-md border-2 border-dashed border-primary/70 bg-primary/20"
            style={{
              left: timeToPx(c.startMs, pxPerSec),
              width: Math.max(timeToPx(c.durationMs, pxPerSec), 8),
            }}
          />
        ))}
    </div>
  );
}

/** The same preview's row in the HEADERS column, kept in lockstep so the two
 * columns' rows line up (see `NewLaneGhostLane`). */
function NewLaneGhostHeader({ row }: { row: TimelineRow & { kind: "ghost" } }) {
  return (
    <div
      className="flex items-center border-b border-dashed border-primary/50 bg-primary/5 px-2 text-[11px] font-medium text-primary/80"
      style={{ height: row.height }}
    >
      {row.depth > 0 && <span className="shrink-0" style={{ width: row.depth * NEST_STEP_PX }} aria-hidden />}
      {row.scope ? "New row" : "New track"}
    </div>
  );
}

/**
 * The WINDOWS of every open group, painted under their rows.
 *
 * Each box spans exactly the group's bar in time and exactly its band in
 * height (caption through last row, nested bands included), so the band reads
 * as "what this bar shows": a member outside the box is a member the group
 * is not showing right now. Drawn from the row list, so it follows the bar
 * live while it is dragged or trimmed — the drag writes the document, the
 * rows re-measure, the box moves. No pointer events: it is a picture, and the
 * rows above it keep every gesture they had.
 */
function GroupBands({ rows, pxPerSec }: { rows: TimelineRow[]; pxPerSec: number }) {
  const bands: Array<{ group: GroupClip; top: number; height: number; depth: number }> = [];
  rows.forEach((row, i) => {
    if (row.kind !== "group") return;
    let j = i + 1;
    while (j < rows.length && rows[j]!.depth > row.depth) j++;
    const last = rows[j - 1]!;
    bands.push({ group: row.group, top: row.top, height: last.top + last.height - row.top, depth: row.depth });
  });
  if (bands.length === 0) return null;
  return (
    <>
      {bands.map((b) => (
        <div
          key={b.group.id}
          aria-hidden
          className="pointer-events-none absolute z-0 rounded-md border"
          // Tokens, not utilities: `color:var(--x)/25` is not a colour Tailwind
          // can mix, and the two shades are one pair in globals.css.
          style={{
            left: timeToPx(b.group.startMs, pxPerSec),
            width: Math.max(timeToPx(b.group.durationMs, pxPerSec), 4),
            top: b.top,
            height: b.height,
            background: "var(--group-band)",
            borderColor: "var(--group-band-border)",
          }}
        />
      ))}
    </>
  );
}

/**
 * The thin row heading an open group's band, in the LANES column: a strip
 * exactly the bar's span, so the band's window has a top edge you can read —
 * and a drop target that means "a new first row inside this group".
 */
// Memoised on primitives, like `TrackHeader`: the group object is new whenever
// the group changes at all (a bone pose), and a caption shows only its span.
const GroupCaptionLane = React.memo(function GroupCaptionLane({
  groupId,
  startMs,
  durationMs,
  height,
  depth,
  pxPerSec,
}: {
  groupId: string;
  startMs: number;
  durationMs: number;
  height: number;
  depth: number;
  pxPerSec: number;
}) {
  return (
    <div data-group-caption={groupId} className="relative border-b border-border/40" style={{ height, ...nestStyle(depth + 1) }}>
      <div
        className="pointer-events-none absolute top-1 bottom-1 rounded-sm"
        style={{
          background: "var(--group-band-border)",
          left: timeToPx(startMs, pxPerSec),
          width: Math.max(timeToPx(durationMs, pxPerSec), 4),
        }}
      />
    </div>
  );
});

/**
 * The band's head in the HEADERS column — the group's name, a chevron that
 * folds the band, how many rows it holds, and the group's own menu. The whole
 * row is the disclosure target: the chevron is the affordance, the row is the
 * hit area.
 */
const GroupCaptionHeader = React.memo(function GroupCaptionHeader({
  groupId,
  name,
  frameId,
  height,
  depth,
  rows,
  character = false,
  parts = false,
}: {
  groupId: string;
  name: string;
  frameId: string;
  height: number;
  depth: number;
  rows: number;
  /** A group with pose sets: its band can show its performance (Parts) or its layers. */
  character?: boolean;
  parts?: boolean;
}) {
  const store = useDocStore();
  const group = { id: groupId, name, frameId };
  const [renaming, setRenaming] = React.useState(false);
  const referenced = useIsReferenced({ kind: "group", id: group.id });
  const fold = () => useSession.getState().setCollapsed(group.id, true);
  const addRow = (edge: "top" | "bottom") =>
    store.update("Add row", (d) => {
      const own = groupRows(d, group.id);
      const near = edge === "top" ? own[0] : own[own.length - 1];
      insertTrackNear(d, {
        frameId: group.frameId,
        nearTrackId: near?.id ?? null,
        where: edge === "top" ? "above" : "below",
        groupId: group.id,
        name: `Row ${own.length + 1}`,
      });
    });
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className="relative flex cursor-pointer select-none items-center gap-1 border-b border-border/40 pr-2 text-[11px] hover:bg-accent/30"
          style={{ height, paddingLeft: 8 + depth * NEST_STEP_PX }}
          onClick={fold}
          title={`${group.name} — click to fold`}
        >
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          <ReferenceBadge on={referenced} />
          {renaming ? (
            <input
              autoFocus
              defaultValue={group.name}
              onFocus={(e) => e.target.select()}
              onBlur={(e) => {
                const name = e.target.value.trim();
                if (name && name !== group.name) {
                  store.update("Rename group", (d) => {
                    const g = locateClip(d, group.id)?.clip;
                    if (g) g.name = name;
                  });
                }
                setRenaming(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setRenaming(false);
              }}
              onClick={(e) => e.stopPropagation()}
              className="h-4 min-w-0 flex-1 rounded border border-primary/60 bg-input/45 px-1 text-[11px] outline-none"
              spellCheck={false}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate font-semibold text-foreground/80">{group.name}</span>
          )}
          {character ? (
            <PartsLayersSwitch groupId={groupId} parts={parts} />
          ) : (
            <span className="shrink-0 font-mono text-[9px] text-muted-foreground max-md:hidden">
              {rows} {rows === 1 ? "row" : "rows"}
            </span>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem onClick={fold}>Fold group</ContextMenuItem>
        <ContextMenuItem onClick={() => useSession.getState().select([group.id])}>Select group</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => addRow("top")}>Add row at top</ContextMenuItem>
        <ContextMenuItem onClick={() => addRow("bottom")}>Add row at bottom</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => setRenaming(true)}>Rename group</ContextMenuItem>
        <ReferenceMenuItem target={{ kind: "group", id: group.id }} />
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() => {
            store.update("Ungroup", (d) => ungroupClips(d, [group.id]));
            syncEnteredGroup(store.getState());
          }}
        >
          Ungroup
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

/**
 * PARTS | LAYERS on a character's caption: its band shows its performance
 * (one lane per pose set) or its raw layer rows. One segmented control, the
 * armed side raised; a press here never folds the band behind it.
 */
function PartsLayersSwitch({ groupId, parts }: { groupId: string; parts: boolean }) {
  const set = (layers: boolean) => useSession.getState().setCharacterLayers(groupId, layers);
  const seg = (on: boolean) => cn("rounded-[3px] px-1.5 leading-4 transition-colors", on ? "material-glass-raised text-foreground" : "text-muted-foreground hover:text-foreground");
  return (
    <span className="flex shrink-0 items-center rounded-[4px] bg-foreground/[0.05] p-px text-2xs" onClick={(e) => e.stopPropagation()}>
      <button type="button" className={seg(parts)} aria-pressed={parts} title="Show the performance — a lane per pose set" onClick={() => set(false)}>
        Parts
      </button>
      <button type="button" className={seg(!parts)} aria-pressed={!parts} title="Show the layers it is made of" onClick={() => set(true)}>
        Layers
      </button>
    </span>
  );
}

/** Play / jump-to-start, living where editors expect them — in the timeline. */
/**
 * Transport, exported because the FLIPBOOK SHEET is a timeline too.
 *
 * The sheet had grown its own bare play/pause button with its own size, its own
 * hover treatment, no jump-to-start and no shortcut hint — a near-miss of this
 * one, four lines away from it in the tree. The rule for the whole header is
 * the same rule as everywhere else in this codebase: the second surface that
 * needs a control imports the first one's. Nothing here is timeline-specific;
 * they all read the session, which the sheet shares.
 */
export function Transport() {
  const playing = useSession((s) => s.playing);
  const homeCombo = useCombo("playback.home");
  const toggleCombo = useCombo("playback.toggle");
  return (
    <div className="flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Jump to start"
            onClick={() => useSession.getState().setPlayhead(0)}
          >
            <SkipBack />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Jump to start
          {homeCombo && <span className="ml-1.5 font-mono text-[10px]">{formatCombo(homeCombo)}</span>}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* At rest Play is a neutral control: Export is the one accent fill.
              Playing is LIVE, the accent's other meaning, carried on the icon. */}
          <Button
            variant={playing ? "ghost" : "secondary"}
            size="icon-sm"
            className={cn("rounded-full", playing && "material-glass-raised text-primary")}
            aria-label={playing ? "Pause" : "Play"}
            onClick={() => {
              soundEngine.ensure();
              useSession.getState().togglePlaying();
            }}
          >
            {playing ? <Pause /> : <Play />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {playing ? "Pause" : "Play"}
          {toggleCombo && <span className="ml-1.5 font-mono text-[10px]">{formatCombo(toggleCombo)}</span>}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

/**
 * Current-time readout: direct DOM writes during playback (zero re-renders),
 * horizontal drag scrubs frame by frame, click to type a time.
 *
 * `frameId` names WHOSE CLOCK is being read and written, exactly as it does for
 * `<Playhead>`. Omit it on a surface showing the comp you stand in. The
 * flipbook sheet passes the flipbook's, because a sheet is always measured in
 * sheet frames — drilled into cell 12's drawing, the sheet's own ruler said
 * frame 12 while this readout said 0:00:00, which are both true and only one of
 * them is what the panel is about.
 */
export function TimeDisplay({ fps, frameId }: { fps: number; frameId?: string }) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const [typing, setTyping] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  /** The instant this readout shows and edits, in its own frame's clock. */
  const readMs = React.useCallback(
    () => (frameId ? useSession.getState().playheadIn(frameId) : useSession.getState().playheadMs),
    [frameId],
  );
  const writeMs = React.useCallback(
    (ms: number) => {
      const session = useSession.getState();
      if (frameId) session.seekIn(frameId, ms);
      else session.setPlayhead(ms);
    },
    [frameId],
  );

  React.useEffect(() => {
    if (typing) return;
    // Written only when the string changes, into the text node it already has:
    // `textContent` replaced the node on every session change — an insert, a
    // layout and a paint per frame of playback, even when the frame had not
    // changed.
    const write = () => {
      const el = ref.current;
      if (!el) return;
      const next = formatTimecode(readMs(), fps);
      const node = el.firstChild;
      if (node?.nodeType === Node.TEXT_NODE) {
        if (node.nodeValue !== next) node.nodeValue = next;
      } else el.textContent = next;
    };
    write();
    return useSession.subscribe(write);
  }, [fps, typing, readMs]);

  /*
   * This readout sits in a horizontally scrolling toolbar, so it cannot simply
   * take every press: a swipe along the bar is how you reach the controls off
   * the end of it. It had its own 3px threshold, no `pointercancel` and no
   * `blur`, which is the leak the timeline has now been bitten by three times.
   *
   * Both are one call each now. `beginHeldDrag` reads the gesture scope — a
   * quick swipe scrolls the bar, a brief hold then scrubs — and
   * `subscribePointerEnd` covers up, cancel and lost with no trio to forget.
   */
  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    capturePointer((e.currentTarget as HTMLElement), e.pointerId);
    const arm = beginHeldDrag(e, { axis: "x" });
    const startMs = readMs();
    const frameMs = 1000 / fps;
    let moved = false;
    let base = e.clientX;
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      if (!arm.update(ev.clientX, ev.clientY)) return;
      if (!moved) {
        moved = true;
        // Rebase, so the travel spent earning the gesture is not also scrubbed.
        base = ev.clientX;
        // Playback stops when the scrub STARTS, not when a finger lands: a
        // swipe past the readout must not pause what you are watching.
        useSession.getState().setPlaying(false);
      }
      writeMs(Math.max(0, startMs + Math.round((ev.clientX - base) / 2) * frameMs));
    };
    const off = subscribePointerEnd((id, reason) => {
      if (id !== e.pointerId) return;
      arm.end();
      off();
      window.removeEventListener("pointermove", onMove);
      // Type only on a real release that was never a swipe. A cancelled or lost
      // pointer is not a click, and putting a keyboard over the timeline after
      // a scroll is worse than the scrub this just declined to do.
      if (!moved && reason === "up" && !arm.abandoned()) {
        setDraft((readMs() / 1000).toFixed(2));
        setTyping(true);
      }
    });
    window.addEventListener("pointermove", onMove);
  };

  if (typing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => setTyping(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const v = parseTimeInput(draft);
            if (v !== null) writeMs(v);
            setTyping(false);
          }
          if (e.key === "Escape") setTyping(false);
          e.stopPropagation();
        }}
        data-num
        className="h-6 w-19 rounded border border-primary/60 bg-input/45 px-1 text-center text-xs outline-none"
        aria-label="Current time (seconds)"
      />
    );
  }
  return (
    <span
      ref={ref}
      title="Drag to scrub · click to type"
      onPointerDown={scrub}
      data-num
      className="min-w-19 cursor-ew-resize select-none px-1 text-center text-xs text-foreground"
    />
  );
}

/** Parse "12", "12.5", "1:23" or "1:23.5" into ms. */
function parseTimeInput(raw: string): number | null {
  const t = raw.trim();
  const colon = t.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
  if (colon) return (parseInt(colon[1]!, 10) * 60 + parseFloat(colon[2]!)) * 1000;
  const secs = parseFloat(t);
  return Number.isFinite(secs) ? Math.max(0, secs * 1000) : null;
}

/**
 * The editable duration of a comp. A comp PRIVATELY owned by exactly one
 * nested clip (`compOwnerNested`) has no duration of its own — its length
 * IS that clip's duration in the parent timeline (`compDurationMs` is the
 * read side of this same relationship). Editing it here — end bar or field —
 * writes the OWNER CLIP's duration instead, so the parent's clip box resizes
 * with it: one shared value, edited from either side. Every other comp
 * (root, a component definition, one shared by several instances) has no
 * single instance to bind to, so it keeps its own frame-level override.
 */
export function useCompDuration(doc: MotionDocument, frame: Frame) {
  const store = useDocStore();
  const owner = compOwnerNested(doc, frame.id);
  const effective = timelineEndMs(doc, frame.id);
  const setDuration = React.useCallback(
    (ms: number, mergeKey?: string) => {
      // ONE writer, in core (`setFrameDurationMs`): it knows the private-owner,
      // single-frame and per-frame-override cases AND reconciles every clip
      // that tracks the comp. This used to be three branches here that
      // reconciled on exactly one of them, which is why growing an ordinary
      // comp left its adjustment layers at their old length.
      store.update(
        "Frame duration",
        (d) => setFrameDurationMs(d, frame.id, ms),
        mergeKey ? { mergeKey } : undefined,
      );
    },
    [store, frame.id],
  );
  return { effective, owner, setDuration };
}

/**
 * Total duration of the active comp — scrub/type to change it (see
 * `useCompDuration`). Pass `frame` to bind to a specific comp instead of
 * `activeFrameId` (e.g. a flipbook sheet, where the active frame is whatever
 * cell the user last drilled into, not the flipbook itself).
 */
export function DurationField({ frame: frameProp }: { frame?: Frame } = {}) {
  const doc = useDoc();
  const activeFrameId = useSession((s) => s.activeFrameId);
  const frame = frameProp ?? doc.frames.find((f) => f.id === activeFrameId) ?? doc.frames[0]!;
  const { effective, owner, setDuration } = useCompDuration(doc, frame);

  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground">
      <span>/</span>
      <NumberInput
        value={effective / 1000}
        min={0.5}
        // No upper cap — a comp can be as long as you like (the old 600s / 10min
        // ceiling was arbitrary). The duration-aware zoom keeps long edits legible.
        step={0.1}
        precision={1}
        unit="s"
        title={
          owner
            ? `Duration of “${frame.name}” — bound to its clip's duration in the parent timeline`
            : doc.frames.length > 1
              ? `Duration of “${frame.name}” — each frame has its own`
              : "Duration"
        }
        className="w-16"
        onChange={(v) => setDuration(v * 1000, `frame-dur-${frame.id}`)}
      />
    </div>
  );
}

const LOOP_ORDER: LoopMode[] = ["none", "loop", "pingpong"];
const LOOP_LABEL: Record<LoopMode, string> = { none: "Play once", loop: "Loop", pingpong: "Ping-pong" };

/**
 * The active frame's loop mode, beside its duration. Each frame (timeline) has
 * its own; click to cycle none → loop → ping-pong. Nested instances of the frame
 * inherit this as their default playback (overridable per instance).
 */
function FrameLoopField() {
  const doc = useDoc();
  const store = useDocStore();
  const activeFrameId = useSession((s) => s.activeFrameId);
  const frame = doc.frames.find((f) => f.id === activeFrameId) ?? doc.frames[0]!;
  return (
    <LoopToggle
      label="Frame"
      mode={frame.loop}
      onChange={(next) =>
        store.update("Frame loop mode", (d) => {
          const f = d.frames.find((x) => x.id === frame.id);
          if (f) f.loop = next;
        })
      }
    />
  );
}

/**
 * Record-mode toggle. When armed, moving/editing any layer writes keyframes at
 * the playhead instead of the base value (see writeAnimatable). The dot glows
 * red and pulses so the mode is unmistakable.
 */
function RecordControl({ recording }: { recording: boolean }) {
  const combo = useCombo("view.recording");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Record keyframes"
          aria-pressed={recording}
          onClick={() => useSession.getState().toggleRecording()}
          className={cn(
            "flex size-7 items-center justify-center rounded-md transition-colors [&_svg]:size-3.5",
            recording
              ? "bg-destructive/15 text-destructive"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <Circle className={cn("fill-current", recording && "tm-record-pulse")} />
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {recording ? "Recording — edits write keyframes" : "Record keyframes at the playhead"}
        {combo && <span className="ml-1.5 font-mono text-[10px]">{formatCombo(combo)}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * THE CACHE ICON. Click switches caching on and off — the one switch every
 * cache obeys (`cache-status.ts`). Right-click opens the cache panel in place:
 * the same component as the stage's Cache tab, so the two can never disagree.
 */
function CachingControl() {
  const enabled = useCachingEnabled();
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <PopoverAnchor asChild>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Cache"
              aria-pressed={enabled}
              onClick={() => setCachingEnabled(!enabled)}
              onContextMenu={(e) => {
                e.preventDefault();
                setOpen(true);
              }}
              className={cn(
                "flex size-7 items-center justify-center rounded-md transition-colors [&_svg]:size-3.5",
                enabled ? "text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <Database />
            </button>
          </TooltipTrigger>
        </PopoverAnchor>
        <TooltipContent>{enabled ? "Cache on · right-click for settings" : "Cache off · right-click for settings"}</TooltipContent>
      </Tooltip>
      <PopoverContent side="bottom" align="start" sideOffset={6} className="w-64 p-2">
        <CachePanel />
      </PopoverContent>
    </Popover>
  );
}

/** The render bar's height under the ruler. */
const CACHE_BAR_H = 3;

/**
 * THE BAR UNDER THE RULER — which instants of this comp play from the cache:
 * kept finished frames under Frames, built instants under Layers.
 *
 * One fact, one bar. Decoded footage is its own fact and lives on its own clip;
 * a layer's kept pixels live on that layer's clip. Mixing them into one strip
 * here was a bar that could be green while the frame still had to be rendered.
 * Gaps with nothing in them are never green — there is nothing there to keep.
 */
function CacheBar({ compId, pxPerSec, spanMs }: { compId: string; pxPerSec: number; spanMs: number }) {
  const version = useCacheStatusVersion();
  const enabled = useCachingEnabled();
  const canvasRef = React.useRef<HTMLCanvasElement>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = Math.max(1, Math.round((spanMs / 1000) * pxPerSec));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { scaleX } = fitCanvasBacking(canvas, width, CACHE_BAR_H);
    ctx.setTransform(scaleX, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, CACHE_BAR_H);
    const subject = compSubject(compId);
    // Frames mode: kept frames. Layers mode: built instants (every unit kept).
    // Either way, green is "this instant plays from the cache".
    if (!enabled || !hasAnyCoverage(subject)) return;
    // Solid runs, sampled per pixel — the convention every cache bar shares.
    ctx.fillStyle = "rgba(64,187,110,0.95)";
    let runFrom = -1;
    for (let x = 0; x <= width; x++) {
      const on = x < width && hasFrame(subject, (x / pxPerSec) * 1000);
      if (on && runFrom < 0) runFrom = x;
      else if (!on && runFrom >= 0) {
        ctx.fillRect(runFrom, 0, Math.max(1, x - runFrom), CACHE_BAR_H);
        runFrom = -1;
      }
    }
  }, [compId, enabled, pxPerSec, spanMs, version]);

  return (
    <canvas
      ref={canvasRef}
      // AS WIDE AS WHAT IT DREW. The drawing covers the timeline's span; the
      // ruler also holds trailing room past the end, so `100%` stretched the
      // bar by a factor that changed with every zoom — green in the wrong place.
      className="pointer-events-none absolute bottom-0 left-0"
      style={{ height: CACHE_BAR_H, width: Math.max(1, Math.round((spanMs / 1000) * pxPerSec)) }}
      aria-hidden
    />
  );
}

/**
 * Linked-selection toggle (DaVinci's chain link). On = selecting a linked clip
 * pulls in its group (audio + waveform, a/v pairs) so they travel together;
 * off = pick members individually. The link data itself is untouched.
 */
function LinkedSelectionControl() {
  const linked = useSession((s) => s.linkedSelection);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Linked selection"
          aria-pressed={linked}
          onClick={() => useSession.getState().setLinkedSelection(!linked)}
          className={cn(
            "flex size-7 items-center justify-center rounded-md transition-colors [&_svg]:size-4",
            linked
              ? "material-glass-raised text-primary"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <Link2 />
        </button>
      </TooltipTrigger>
      <TooltipContent>Linked selection — linked clips select together</TooltipContent>
    </Tooltip>
  );
}

/**
 * The working range (DaVinci in/out): a master toggle that, once on, reveals
 * the [ / ] buttons to set the in/out at the playhead. Grouped in one pill.
 */
export function RangeControl({ compId }: { compId: string }) {
  const doc = useDoc();
  const enabled = useSession((s) => s.workRangeEnabled);
  const inCombo = useCombo("range.in");
  const outCombo = useCombo("range.out");

  return (
    <HeaderGroup>
      <HeaderToggle
        icon={<Brackets />}
        pressed={enabled}
        onToggle={() => toggleWorkRange(doc, compId)}
        ariaLabel="Working range"
        tooltip="Working range — loop & export just a section"
      />
      {enabled && (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Set range in point"
                onClick={() =>
                  setWorkRangeBound(doc, compId, "start", useSession.getState().playheadMs)
                }
              >
                <ArrowRightToLine />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Set range in
              {inCombo && <span className="ml-1.5 font-mono text-[10px]">{formatCombo(inCombo)}</span>}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Set range out point"
                onClick={() =>
                  setWorkRangeBound(doc, compId, "end", useSession.getState().playheadMs)
                }
              >
                <ArrowLeftToLine />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Set range out
              {outCombo && <span className="ml-1.5 font-mono text-[10px]">{formatCombo(outCombo)}</span>}
            </TooltipContent>
          </Tooltip>
        </>
      )}
    </HeaderGroup>
  );
}

/** Magnet toggle + its settings (right-click or the caret): what snaps, how eagerly. */
export function SnapControl({ snapping }: { snapping: boolean }) {
  const settings = useSession((s) => s.snapSettings);
  const combo = useCombo("view.snap");

  return (
    <HeaderToggle
      icon={<Magnet />}
      pressed={snapping}
      onToggle={() => useSession.getState().setSnapping(!snapping)}
      ariaLabel="Snapping"
      tooltip="Toggle snapping"
      combo={combo}
      popover={
        <div className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1.5 text-xs">
          <div className="col-span-2 text-xs font-semibold">Snapping</div>
          <span className="text-muted-foreground">Strength</span>
          <NumberInput
            value={settings.thresholdPx}
            min={2}
            max={40}
            precision={0}
            unit="px"
            className="w-16"
            onChange={(v) => useSession.getState().setSnapSettings({ thresholdPx: v })}
          />
          <span className="text-muted-foreground">Clip edges</span>
          <Switch
            checked={settings.toClips}
            onCheckedChange={(v) => useSession.getState().setSnapSettings({ toClips: v })}
          />
          <span className="text-muted-foreground">Playhead</span>
          <Switch
            checked={settings.toPlayhead}
            onCheckedChange={(v) => useSession.getState().setSnapSettings({ toPlayhead: v })}
          />
          <span className="text-muted-foreground">Keyframes</span>
          <Switch
            checked={settings.toKeyframes}
            onCheckedChange={(v) => useSession.getState().setSnapSettings({ toKeyframes: v })}
          />
        </div>
      }
    />
  );
}

/**
 * One lane and everything on it, memoised on the TRACK. Rows are rebuilt on
 * every edit; a lane whose track object did not change has nothing new to
 * draw, so a drag on one layer re-renders one lane, not all of them.
 */
const TrackLane = React.memo(function TrackLane({
  track,
  height,
  depth,
  inGroup,
  compId,
  pxPerSec,
  rowAtClientY,
  laneEdgeAtClientY,
}: {
  track: Track;
  height: number;
  depth: number;
  inGroup: boolean;
  compId: string;
  pxPerSec: number;
  rowAtClientY: (clientY: number) => TimelineRow | null;
  laneEdgeAtClientY: (clientY: number) => "top" | "bottom" | null;
}) {
  return (
    <div
      data-lane={track.id}
      className={cn("relative border-b border-border/60", inGroup ? "bg-transparent" : "bg-track-lane", track.hidden && "opacity-50")}
      style={{ height, ...nestStyle(depth) }}
    >
      {track.clips
        .filter((clip: Clip) => clip.frameId === compId)
        .map((clip: Clip) => (
          <ClipView
            key={clip.id}
            clip={clip}
            trackLocked={track.locked}
            pxPerSec={pxPerSec}
            laneHeightPx={height}
            rowAtClientY={rowAtClientY}
            laneEdgeAtClientY={laneEdgeAtClientY}
          />
        ))}
      <LaneSpotMark trackId={track.id} pxPerSec={pxPerSec} />
      {/* Cut transitions sit ABOVE the clips: they straddle two of them, so
          they belong to the lane, not to either. */}
      <TransitionLayer track={track} frameId={compId} pxPerSec={pxPerSec} />
      <PresetDropPreview track={track} frameId={compId} pxPerSec={pxPerSec} />
    </div>
  );
});

/**
 * THE LANE SPOT, painted. Two marks, one selection:
 *  · the whole lane wears a faint wash — this is the track a paste or a new
 *    layer lands on, and it has to be visible from across the room or the
 *    targeting is a rule nobody can see;
 *  · inside a live hole, the hatch — the gap Delete would close. Hatched, not
 *    ringed: an empty rectangle with a ring reads as a placeholder waiting for
 *    content, and a gap is the opposite, a thing you are about to remove.
 * Nothing here answers a pointer. The press that picks a spot is the lanes'
 * own marquee gesture (`startMarquee`); this only paints the answer.
 */
function LaneSpotMark({ trackId, pxPerSec }: { trackId: string; pxPerSec: number }) {
  const spot = useSession((s) => s.laneSpot);
  const mine = spot && spot.trackId === trackId ? spot : null;
  // Only the lane holding the spot reads the document, and only for its gap.
  const live = useDocSelector(
    (d) => (mine ? gapAt(d, mine.trackId, mine.frameId, mine.startMs) : null),
    (a, b) => a === b || (!!a && !!b && a.startMs === b.startMs && a.endMs === b.endMs),
  );
  if (!mine) return null;
  return (
    <>
      <div
        className="pointer-events-none absolute inset-0 z-0 bg-primary/5 shadow-[inset_2px_0_0_0_var(--primary)]"
        aria-hidden
      />
      {live && (
        <div
          className="pointer-events-none absolute inset-y-1 z-10 rounded-sm ring-1 ring-inset ring-primary/70"
          style={{
            left: timeToPx(live.startMs, pxPerSec),
            width: Math.max(2, timeToPx(live.endMs - live.startMs, pxPerSec)),
            backgroundImage:
              "repeating-linear-gradient(45deg, color-mix(in oklab, var(--primary) 26%, transparent) 0 4px, transparent 4px 8px)",
          }}
          aria-hidden
        />
      )}
    </>
  );
}

/** The active snap target, flashed as a line while dragging. */
function SnapIndicator({ pxPerSec }: { pxPerSec: number }) {
  const ms = useSession((s) => s.snapIndicatorMs);
  if (ms === null) return null;
  return (
    <div
      className="pointer-events-none absolute bottom-0 top-0 z-30 w-px bg-primary/80"
      style={{ left: timeToPx(ms, pxPerSec) }}
    />
  );
}

/**
 * The end-of-timeline bar — per-comp, draggable (see `useCompDuration`). Pass
 * `frame` to bind to a specific comp instead of `activeFrameId` (a flipbook
 * sheet must always show the FLIPBOOK's own end, even while drilled into a
 * cell's drawing — that's what `activeFrameId` points at then). `offsetPx`
 * shifts the bar right by a fixed amount, for callers with a leading gutter
 * the root Timeline's lanes don't have (e.g. the sheet's row-header column).
 */
export function EndBar({
  pxPerSec,
  frame: frameProp,
  offsetPx = 0,
}: {
  pxPerSec: number;
  frame?: Frame;
  offsetPx?: number;
}) {
  const doc = useDoc();
  const activeFrameId = useSession((s) => s.activeFrameId);
  const frame: Frame = frameProp ?? doc.frames.find((f) => f.id === activeFrameId) ?? doc.frames[0]!;
  const { effective, owner, setDuration } = useCompDuration(doc, frame);

  const drag = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    capturePointer((e.currentTarget as HTMLElement), e.pointerId);
    const startX = e.clientX;
    const startMs = effective;
    const onMove = (ev: PointerEvent) => {
      const t = Math.max(500, startMs + pxToTime(ev.clientX - startX, pxPerSec));
      setDuration(Math.round(t / 10) * 10, `frame-dur-drag-${frame.id}`);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div
      className="group/end absolute bottom-0 top-0 z-20 -translate-x-1/2 cursor-ew-resize px-1"
      style={{ left: offsetPx + timeToPx(effective, pxPerSec) }}
      onPointerDown={drag}
      title={
        owner
          ? `End of “${frame.name}” — bound to its clip's duration in the parent timeline`
          : `End of “${frame.name}” — drag to change its duration`
      }
    >
      {/* Just the line now — the faded "past the end" overlay marks the end,
          so the old off-center head is gone. */}
      <div className="h-full w-px bg-foreground/30 transition-colors group-hover/end:bg-primary" />
    </div>
  );
}

/**
 * The dimmed, disabled-looking regions of the lanes: everything OUTSIDE the
 * working range when one is active, otherwise everything PAST the timeline end
 * bar. One overlay, one look — the "not part of what plays/renders" area always
 * reads the same. Pointer-events-none so clips underneath stay editable.
 * `offsetPx` shifts everything right, for callers with a leading gutter the
 * root Timeline's lanes don't have (e.g. the flipbook sheet's row headers).
 */
export function TimelineDimOverlay({
  pxPerSec,
  compId,
  offsetPx = 0,
}: {
  pxPerSec: number;
  compId: string;
  offsetPx?: number;
}) {
  const doc = useDoc();
  const range = useWorkRange(compId);
  const cls = "pointer-events-none absolute bottom-0 top-0 z-10 bg-background/60";
  if (range) {
    return (
      <>
        {range.startMs > 0 && (
          <div className={cls} style={{ left: offsetPx, width: timeToPx(range.startMs, pxPerSec) }} />
        )}
        <div className={cls} style={{ left: offsetPx + timeToPx(range.endMs, pxPerSec), right: 0 }} />
      </>
    );
  }
  return (
    <div className={cls} style={{ left: offsetPx + timeToPx(timelineEndMs(doc, compId), pxPerSec), right: 0 }} />
  );
}

/** The two draggable in/out brackets that bound the working range on the lanes. */
function RangeBars({ pxPerSec, compId }: { pxPerSec: number; compId: string }) {
  const range = useWorkRange(compId);
  if (!range) return null;

  const drag = (bound: "start" | "end") => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    capturePointer((e.currentTarget as HTMLElement), e.pointerId);
    const startX = e.clientX;
    const startMs = bound === "start" ? range.startMs : range.endMs;
    const onMove = (ev: PointerEvent) => {
      const raw = Math.max(0, startMs + pxToTime(ev.clientX - startX, pxPerSec));
      const s = useSession.getState();
      const cur = s.workRange;
      if (!cur || cur.compId !== compId) return;
      if (bound === "start") {
        s.setWorkRange({ compId, startMs: Math.min(Math.round(raw), cur.endMs - 100), endMs: cur.endMs });
      } else {
        s.setWorkRange({ compId, startMs: cur.startMs, endMs: Math.max(Math.round(raw), cur.startMs + 100) });
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const handle = (bound: "start" | "end") => (
    <div
      key={bound}
      className="group/range absolute bottom-0 top-0 z-20 -translate-x-1/2 cursor-ew-resize px-1.5"
      style={{ left: timeToPx(bound === "start" ? range.startMs : range.endMs, pxPerSec) }}
      onPointerDown={drag(bound)}
      title={bound === "start" ? "Range in — drag or press [" : "Range out — drag or press ]"}
    >
      <div className="h-full w-0.5 bg-primary/80 transition-colors group-hover/range:bg-primary" />
      <div
        className={cn(
          "absolute top-0 h-3.5 w-1.5 bg-primary",
          bound === "start" ? "left-1/2 rounded-r-sm" : "right-1/2 rounded-l-sm",
        )}
      />
    </div>
  );

  return (
    <>
      {handle("start")}
      {handle("end")}
    </>
  );
}

/** Add a lane beside this one, inheriting its group. */
function addTrackBeside(store: DocumentStore, track: Track, where: "above" | "below"): void {
  const compId = activeCompId(store.getState(), useSession.getState().activeFrameId);
  store.update("Add track", (d) => {
    insertTrackNear(d, {
      frameId: compId,
      nearTrackId: track.id,
      where,
      name: `Track ${d.tracks.length + 1}`,
    });
  });
}

/**
 * The nesting mark on a lane: one rail down the left edge per enclosing group.
 *
 * BACKGROUND ONLY — deliberately no padding, no wrapper, no inset. A lane's
 * clips are positioned absolutely from TIME, so padding on the lane would move
 * its containing block and slide every clip in it off the ruler; and a box
 * drawn around a RUN of lanes is a box that has to be re-measured every time one
 * of them changes height. A rail painted into each row's own background nests to
 * any depth, costs no layout, and cannot fall out of sync with the ruler.
 */
const NEST_STEP_PX = 10;
function nestStyle(depth: number): React.CSSProperties {
  if (depth <= 0) return {};
  const rails = Array.from({ length: depth }, (_, i) => ({
    image: "linear-gradient(to right, var(--nest-rail) 0 1px, transparent 1px)",
    pos: `${i * NEST_STEP_PX + 4}px 0`,
  }));
  return {
    // Inline rather than a utility class: the lane already carries
    // `bg-track-lane`, and two Tailwind utilities setting one property resolve
    // by STYLESHEET order, not by the order you list them — a fight that
    // typechecks perfectly and loses at random.
    backgroundColor: "var(--nest-lane)",
    backgroundImage: rails.map((r) => r.image).join(","),
    backgroundPosition: rails.map((r) => r.pos).join(","),
    backgroundRepeat: "repeat-y",
    backgroundSize: `${NEST_STEP_PX}px 100%`,
  };
}

const TrackHeader = React.memo(function TrackHeader({ track, depth, inGroup }: { track: Track; depth: number; inGroup: boolean }) {
  const store = useDocStore();
  const laneZoom = useLaneZoom();
  // A row INSIDE a group: the same header, indented, and its menu says "row".
  // Primitives, not the row: rows are rebuilt on every edit, and the group a row
  // sits in is a new object whenever that group changes (a bone pose) — memo
  // on either and every header in a posed character re-rendered per move.
  const noun = inGroup ? "row" : "track";
  const [renaming, setRenaming] = React.useState(false);
  // `laneHeight` below reads `laneZoom` internally (via getState(), not
  // reactively) so its return value is always fresh — but this component is
  // memoized on `track` alone, so without subscribing here it simply
  // wouldn't RE-RENDER when laneZoom changes, leaving the header row frozen
  // at its old height while the lane it fronts resizes. Same fix shape as
  // the ghost-lane rows.
  useLaneZoom();
  const referenced = useIsReferenced({ kind: "track", id: track.id });
  const toggle = (label: string, fn: (t: Track) => void, mergeKey?: string) =>
    store.update(
      label,
      (d) => {
        const t = d.tracks.find((x) => x.id === track.id);
        if (t) fn(t);
      },
      mergeKey ? { mergeKey: `${mergeKey}-${track.id}` } : undefined,
    );

  const deleteTrack = () =>
    store.update("Delete track", (d) => {
      const i = d.tracks.findIndex((x) => x.id === track.id);
      if (i >= 0) d.tracks.splice(i, 1);
    });

  /** Drag the header's bottom edge to resize the lane. */
  const resizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    capturePointer(target, e.pointerId);
    const startY = e.clientY;
    // Base (unzoomed) height — `laneHeight` bakes in `laneZoom`, and the
    // delta below must too, or dragging at anything but 1x zoom would move
    // the edge faster/slower than the cursor.
    const orig = track.heightPx ?? DEFAULT_LANE_HEIGHT;
    const onMove = (ev: PointerEvent) => {
      const zoom = laneZoomNow();
      const h = Math.round(Math.min(240, Math.max(28, orig + (ev.clientY - startY) / zoom)));
      toggle("Resize track", (t) => void (t.heightPx = h), "track-h");
    };
    const onUp = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className="relative flex items-center gap-1.5 border-b border-border/60 px-2"
          style={{ height: laneHeight(track, laneZoom) }}
        >
          {/* Nesting: one indent step per enclosing group, so the rows read as
              the tree they are. Padding on the ROW, never a margin on the label
              — the row still spans the full width, so hover, hit target and the
              lane-height grip are unaffected at any depth. */}
          {depth > 0 && <span className="shrink-0" style={{ width: depth * NEST_STEP_PX }} aria-hidden />}
          {/* Workspace tint dot (right-click to change). */}
          <span
            className="size-2.5 shrink-0 rounded-full border border-border/70"
            style={{ background: track.color ?? "transparent" }}
          />
          <ReferenceBadge on={referenced} />
          {renaming ? (
            <input
              autoFocus
              defaultValue={track.name}
              onFocus={(e) => e.target.select()}
              onBlur={(e) => {
                const name = e.target.value.trim();
                if (name && name !== track.name) toggle(`Rename ${noun}`, (t) => void (t.name = name));
                setRenaming(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setRenaming(false);
              }}
              onClick={(e) => e.stopPropagation()}
              className="h-5 min-w-0 flex-1 rounded border border-primary/60 bg-input/45 px-1 text-xs outline-none"
              spellCheck={false}
            />
          ) : (
            <span
              className="min-w-0 flex-1 truncate text-xs font-medium max-md:hidden"
              onDoubleClick={() => setRenaming(true)}
              title={track.name}
            >
              {track.name}
            </span>
          )}
          <button
            className="rounded p-0.5 text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              toggle(track.hidden ? "Show track" : "Hide track", (t) => void (t.hidden = !t.hidden));
            }}
            aria-label="Toggle visibility"
          >
            {track.hidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
          <button
            className="rounded p-0.5 text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              toggle(track.muted ? "Unmute track" : "Mute track", (t) => void (t.muted = !t.muted));
            }}
            aria-label="Toggle mute"
          >
            {track.muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
          </button>
          <button
            className="rounded p-0.5 text-muted-foreground hover:text-foreground max-md:hidden"
            onClick={(e) => {
              e.stopPropagation();
              toggle(track.locked ? "Unlock track" : "Lock track", (t) => void (t.locked = !t.locked));
            }}
            aria-label="Toggle lock"
          >
            {track.locked ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
          </button>
          {/* Lane-height grip. */}
          <div
            onPointerDown={resizeStart}
            onClick={(e) => e.stopPropagation()}
            className="absolute inset-x-0 -bottom-1 z-10 h-2 cursor-row-resize"
            aria-label="Resize track height"
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        {/* Placement is RELATIVE, and the new lane inherits THIS one's scope —
            so on a row inside a group these two make rows of that group, with
            no separate command and no separate concept. */}
        <ContextMenuItem onClick={() => addTrackBeside(store, track, "above")}>
          Add {noun} above
        </ContextMenuItem>
        <ContextMenuItem onClick={() => addTrackBeside(store, track, "below")}>
          Add {noun} below
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => setRenaming(true)}>Rename {noun}</ContextMenuItem>
        {/* A whole track as one reference — every clip and outline on it, now
            and later. The reason references are a LIST of sources rather than a
            layer id: a track is already many clips. */}
        <ReferenceMenuItem target={{ kind: "track", id: track.id }} />
        <div className="px-2 py-1.5">
          <WorkspaceColorPicker
            value={track.color}
            onChange={(c) => toggle("Track color", (t) => void (t.color = t.color === c ? null : c))}
          />
        </div>
        <ContextMenuItem
          onClick={() => toggle("Reset track height", (t) => void (t.heightPx = null))}
          disabled={track.heightPx === null}
        >
          Reset height
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem className="text-destructive focus:text-destructive" onClick={deleteTrack}>
          <Trash2 /> Delete {noun}{track.clips.length > 0 ? ` (${track.clips.length} clips)` : ""}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

const Ruler = React.memo(function Ruler({ spanMs, drawnMs, pxPerSec, compId }: { spanMs: number; drawnMs: number; pxPerSec: number; compId: string }) {
  const store = useDocStore();
  const interval = niceTickIntervalMs(pxPerSec);
  const ticks: number[] = [];
  // Counted across everything drawn, runway included: time past the last clip
  // is still time you can scrub to and drop into.
  for (let t = 0; t <= drawnMs; t += interval) ticks.push(t);

  return (
    <div
      // SCRUB_SURFACE, not decoration: the ruler sits inside the timeline's
      // horizontal scroller, so without `touch-none` a finger or a Pencil
      // dragged along it pans that scroller instead of moving the playhead.
      className={cn("sticky top-0 z-20 cursor-col-resize border-b bg-panel", SCRUB_SURFACE)}
      style={{ height: RULER_HEIGHT }}
      onPointerDown={(e) => beginPlayheadScrub(e, store, pxPerSec)}
    >
      {/* Minor ticks: quarters of the labelled interval, ONE gradient rather
          than four elements per second of timeline. */}
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-1"
        style={{
          backgroundImage: "linear-gradient(to right, var(--border) 1px, transparent 1px)",
          backgroundSize: `${timeToPx(interval / 4, pxPerSec)}px 100%`,
        }}
      />
      {ticks.map((t) => (
        <div key={t} className="absolute bottom-0 top-0" style={{ left: timeToPx(t, pxPerSec) }}>
          <div className="absolute bottom-0 h-2.5 w-px bg-foreground/20" />
          {/* The ruler speaks the code face: a measure, read like one. */}
          <span className="absolute left-1 top-1 font-mono text-[9px] tabular-nums tracking-tight text-fg-faint">
            {formatTime(t)}
          </span>
        </div>
      ))}
      <RulerMarkers pxPerSec={pxPerSec} />
      {/* Part of the ruler, not beside it: the ruler is sticky and opaque, so a
          sibling bar sat underneath it — drawn, and never seen. */}
      <CacheBar compId={compId} pxPerSec={pxPerSec} spanMs={spanMs} />
    </div>
  );
});

/**
 * Marker pins on the ruler — bookmarks at exact times. Click selects (⇧
 * toggles, ⌫ deletes the selection), drag moves the selection together (snaps
 * like everything else), double-click opens the editor. Hidden entirely while
 * markers are toggled off; they come back untouched.
 */
function RulerMarkers({ pxPerSec }: { pxPerSec: number }) {
  const store = useDocStore();
  const doc = useDoc();
  const enabled = useSession((s) => s.markersEnabled);
  const activeFrameId = useSession((s) => s.activeFrameId);
  const selectedMarkerIds = useSession((s) => s.selectedMarkerIds);
  const merge = useSession((s) => s.mergeMarkers);
  const timelinePath = useSession((s) => s.timelinePath);
  const compId = activeCompId(doc, activeFrameId);
  const [editing, setEditing] = React.useState<string | null>(null);
  if (!enabled) return null;
  const visible = visibleMarkers(doc, compId, merge, timelinePath);
  const markers = visible.filter((vm) => vm.native).map((vm) => vm.marker);
  const echoes = merge ? visible.filter((vm) => !vm.native) : [];

  const pinPointerDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    capturePointer(target, e.pointerId);
    const session = useSession.getState();
    // Grabbing a selected pin drags the whole selection; otherwise just this one.
    const moving = new Set(session.selectedMarkerIds.includes(id) ? session.selectedMarkerIds : [id]);
    const orig = new Map<string, number>();
    for (const m of store.getState().markers) if (moving.has(m.id)) orig.set(m.id, m.timeMs);
    const candidates = collectSnapCandidates(store.getState(), compId, new Set(), session.playheadMs, {
      ...session.snapSettings,
      toPlayhead: true,
    });
    const threshold = pxToTime(session.snapSettings.thresholdPx, pxPerSec);
    const startX = e.clientX;
    let dragged = false;
    const onMove = (ev: PointerEvent) => {
      const dxPx = ev.clientX - startX;
      if (!dragged && Math.abs(dxPx) < 3) return;
      dragged = true;
      const anchor = orig.get(id) ?? 0;
      const raw = Math.max(0, anchor + pxToTime(dxPx, pxPerSec));
      const t = useSession.getState().snapping ? snapTime(raw, candidates, threshold) : raw;
      const delta = t - anchor;
      store.update(
        "Move marker",
        (d) => {
          for (const m of d.markers) {
            const o = orig.get(m.id);
            if (o !== undefined) m.timeMs = Math.max(0, Math.round(o + delta));
          }
        },
        { mergeKey: `marker-${id}-${e.pointerId}` },
      );
    };
    const onUp = (ev: PointerEvent) => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      if (dragged) return;
      // Plain click: select (⇧ toggles in/out of the selection). A plain click
      // also opens the editor popover so color/name are one click away — the pin
      // is 10px wide and double-clicking it was undiscoverable.
      const s = useSession.getState();
      if (ev.shiftKey) {
        const set = new Set(s.selectedMarkerIds);
        if (set.has(id)) set.delete(id);
        else set.add(id);
        s.setSelectedMarkers([...set]);
      } else {
        s.setSelectedMarkers([id]);
        setEditing(id);
      }
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
  };

  return (
    <>
      {markers.map((m) => {
        const selected = selectedMarkerIds.includes(m.id);
        return (
          <Popover key={m.id} open={editing === m.id} onOpenChange={(o) => setEditing(o ? m.id : null)}>
            <PopoverAnchor asChild>
              <button
                type="button"
                aria-label={m.name || "Marker"}
                title={m.name || formatTime(m.timeMs)}
                onPointerDown={(e) => pinPointerDown(e, m.id)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  useSession.getState().setSelectedMarkers([m.id]);
                  setEditing(m.id);
                }}
                className={cn(
                  "absolute bottom-0 z-10 -translate-x-1/2 cursor-ew-resize transition-transform",
                  selected && "scale-125",
                )}
                style={{ left: timeToPx(m.timeMs, pxPerSec) }}
              >
                {/* Bookmark: a flag with a notched bottom. */}
                <svg width="10" height="14" viewBox="0 0 10 14" className="drop-shadow-sm">
                  <path
                    d="M1 1h8v12l-4-3.2L1 13z"
                    fill={m.color}
                    stroke={selected ? "#fff" : "rgba(0,0,0,0.35)"}
                    strokeWidth={selected ? 1 : 0.5}
                  />
                </svg>
              </button>
            </PopoverAnchor>
            <PopoverContent
              align="start"
              sideOffset={6}
              className="w-60 space-y-2 p-2.5"
              onOpenAutoFocus={(e) => e.preventDefault()}
            >
              <input
                value={m.name}
                placeholder="Marker name"
                onChange={(e) =>
                  store.update(
                    "Rename marker",
                    (d) => {
                      const x = d.markers.find((mm) => mm.id === m.id);
                      if (x) x.name = e.target.value;
                    },
                    { mergeKey: `marker-name-${m.id}` },
                  )
                }
                className="h-7 w-full rounded-md border border-transparent bg-input/45 px-1.5 text-xs outline-none transition-colors hover:border-border focus:border-primary/60"
                spellCheck={false}
              />
              <div className="flex items-start gap-1">
                <WorkspaceColorPicker
                  value={m.color}
                  onChange={(c) =>
                    store.update("Marker color", (d) => {
                      const x = d.markers.find((mm) => mm.id === m.id);
                      if (x) x.color = c;
                    })
                  }
                  className="flex-1"
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Delete marker"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    setEditing(null);
                    deleteMarkers(store, [m.id]);
                  }}
                >
                  <Trash2 />
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground">
                at {formatTime(m.timeMs)} — drag to move · click selects · ⌫ deletes
              </p>
            </PopoverContent>
          </Popover>
        );
      })}
      {echoes.map((vm) => {
        const home = doc.frames.find((f) => f.id === vm.marker.frameId);
        return (
          <div
            key={`echo-${vm.marker.id}`}
            className="absolute bottom-0 z-[9] -translate-x-1/2 opacity-45"
            style={{ left: timeToPx(vm.timeMs, pxPerSec) }}
            title={`${vm.marker.name || "Marker"} — from “${home?.name ?? "another comp"}”`}
          >
            <svg width="10" height="14" viewBox="0 0 10 14" className="drop-shadow-sm">
              <path
                d="M1 1h8v12l-4-3.2L1 13z"
                fill={vm.marker.color}
                stroke="rgba(0,0,0,0.35)"
                strokeWidth={0.5}
                strokeDasharray="1.5,1"
              />
            </svg>
          </div>
        );
      })}
    </>
  );
}

/**
 * Markers toggle (right-click for merge settings) + add-at-playhead, visible
 * while markers are on.
 */
function MarkersControl(_props: { compId: string }) {
  const store = useDocStore();
  const enabled = useSession((s) => s.markersEnabled);
  const merge = useSession((s) => s.mergeMarkers);
  const addCombo = useCombo("marker.add");
  return (
    <HeaderGroup>
      <HeaderToggle
        icon={<Bookmark />}
        pressed={enabled}
        onToggle={() => useSession.getState().setMarkersEnabled(!enabled)}
        ariaLabel="Markers"
        tooltip="Markers — off hides them all (they keep their places)"
        popover={
          <>
            <div className="text-xs font-semibold">Markers</div>
            <label className="flex items-center justify-between gap-2 text-xs">
              <span className="text-muted-foreground">Global (merge parent/child)</span>
              <Switch checked={merge} onCheckedChange={(v) => useSession.getState().setMergeMarkers(v)} />
            </label>
            <p className="text-[10px] text-muted-foreground">
              {merge
                ? "Every ancestor and nested comp's markers show here too, time-mapped in — drag/edit still only ever moves the original."
                : "Off — this timeline only shows markers placed directly on it."}
            </p>
          </>
        }
      />
      {enabled && (
        <>
          {/* Global markers, right next to the toggle — merges every parent &
              nested comp's markers onto this ruler (right-click the marker
              toggle for the same setting + a fuller explanation). */}
          <HeaderToggle
            icon={<Combine />}
            pressed={merge}
            onToggle={() => useSession.getState().setMergeMarkers(!merge)}
            ariaLabel="Global markers"
            tooltip="Global markers — merge every parent & nested comp's markers here"
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Add marker at playhead"
                onClick={() => addMarkerAtPlayhead(store)}
              >
                <BookmarkPlus />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Add marker at playhead {addCombo ? `(${formatCombo(addCombo)})` : ""}</TooltipContent>
          </Tooltip>
        </>
      )}
    </HeaderGroup>
  );
}

/**
 * Playhead — position driven by direct DOM transform, no React re-renders,
 * plus autoscroll to keep itself in view during playback. Shared verbatim by
 * the Timeline (its own usage below, unchanged) and the FlipbookPanel sheet —
 * ONE follow-the-playhead brain instead of a second hand-rolled one.
 */
export function Playhead({
  pxPerSec,
  spanMs,
  scrollRef,
  offsetPx = 0,
  frameId,
  colorClassName = "bg-primary",
}: {
  pxPerSec: number;
  spanMs: number;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** Gutter to shift past (e.g. the sheet's sticky row-header column). */
  offsetPx?: number;
  /**
   * WHOSE CLOCK this ruler is drawn against. Omit for a surface that shows the
   * comp you are standing in (the timeline, always). The flipbook sheet passes
   * the flipbook's id, because it stays drawn in SHEET time even while you are
   * drilled two levels down inside a cell's paint layer — and asking the one
   * time authority is the whole of it.
   *
   * This replaced a static `msOffset` the sheet computed itself and passed as a
   * prop: a number captured at render, describing a drill that changes DURING
   * the very gesture that reads it.
   */
  frameId?: string;
  /** Tailwind color class for the line + flag, so callers can keep their own accent. */
  colorClassName?: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    // Running, the compositor carries it (see `playhead-motion.ts`).
    const mover = createPlayheadMover();
    const apply = () => {
      const el = ref.current;
      if (!el) return;
      const s = useSession.getState();
      const ms = frameId ? s.playheadIn(frameId) : s.playheadMs;
      const left = offsetPx + timeToPx(Math.min(ms, spanMs), pxPerSec);
      mover.place(el, left, s.playing);
      // Keep the playhead visible while playing.
      // Through the time authority, so the header inset (compact) is
      // accounted for once rather than re-derived from scrollLeft here.
      if (s.playing && scrollRef.current) {
        const from = timelineView.scrollLeft();
        const visibleRight = from + timelineView.viewportWidth();
        if (left > visibleRight - 40 || left < from) {
          timelineView.panBy(Math.max(0, left - 80) - from);
        }
      }
    };
    apply();
    const unsubscribe = useSession.subscribe(apply);
    return () => {
      unsubscribe();
      mover.dispose();
    };
  }, [pxPerSec, spanMs, scrollRef, offsetPx, frameId]);

  return (
    <div ref={ref} className="pointer-events-none absolute bottom-0 top-0 z-30 will-change-transform" style={{ left: 0 }}>
      <div className={cn("absolute bottom-0 top-0 w-px", colorClassName)} />
      {/* THE NOTCH: a pointed tab on the ruler, its tip ON the line, so the
          exact frame is where the point is, not somewhere in a blob. STICKY,
          so it stays on the ruler while the lanes scroll under it. */}
      <div
        className={cn("sticky top-0 -ml-[4.5px] h-[11px] w-2.5", colorClassName)}
        style={{ clipPath: "polygon(0 0, 100% 0, 100% 58%, 50% 100%, 0 58%)" }}
      />
    </div>
  );
}
