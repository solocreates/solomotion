"use client";

import { cursors, resizeCursor } from "@solomotion/ui/cursors";
import * as React from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  clipEdgeDecors,
  edgeRefKey,
  audioGainAt,
  clampStartInTrack,
  clipEnd,
  audioNeedsBakeLive,
  clipAudioSignature,
  clipHasSound,
  clipEffectSummary,
  clipPlaybackOf,
  componentFrameOfClip,
  dbToGain,
  EASING_PRESET_LABELS,
  findKeyframe,
  expandLinkedSelection,
  resolvePressSelection,
  frameContentDurationMs,
  gainToDb,
  groupAncestry,
  groupOfClip,
  getPreset,
  isClipLocked,
  locateClip,
  clipSpeedCurve,
  loopCycleWallMs,
  loopSpanMs,
  wallTimeForSourceMs,
  type VisualClip,
  moveClip,
  moveClipOverwrite,
  moveClipsToNewLanes,
  nestedIsAudioOnly,
  pruneEmptiedTracks,
  pruneGroups,
  mergeCoincidentKeyframes,
  moveKeyframe,
  isCaptionClip,
  propertyDef,
  reissueClipIds,
  clipSourceCapacityMs,
  CAPTURE_PROPERTY,
  SPEED_PROPERTY,
  isRetimed,
  remapClipRefsAfterCopy,
  removeClipKeyframes,
  rollEdit,
  segmentTextCached,
  setClipPlayback,
  setKeyframe,
  setKeyframeEasing,
  snapTime,
  sourceTimeAt,
  duplicateClips,
  trimClip,
  groupEdgeFollowers,
  COMPOSITE_MODES,
  modeUsesStencil,
  groupModeOf,
  unitCountOf,
  type MotionDocument,
  type Track,
  type AudioClip,
    type NestedClip,
  type VideoClip,
  type Clip,
  type ClipPlayback,
  type EasingPresetName,
  type Keyframe,
  budgetFor,
  compFps,
  frameStepMs,
  layerShowsFootage,
} from "@solomotion/core";
import { ReferenceBadge, useIsReferenced } from "../drawing/reference-menu";
import {
  Box,
  Camera,
  Lightbulb, Move3d, ArrowLeftRight, AudioLines, Scissors as Scissors, Brush, Captions, ChevronDown, ChevronRight, Clapperboard, Component, Contrast, EyeOff, Film, Group as GroupIcon, Image as ImageIcon, Loader2, Lock, PenTool, Repeat, Shapes, Spline, Trash2, Type, Volume2, VolumeX, Zap } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { EasingPicker } from "@/components/ui/easing-editor";
import { NumberInput } from "@/components/ui/number-input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { HELD_DRAG_SURFACE } from "../input/use-multi-touch";
import {
  EdgeChip,
  presetsFor,
  retargetEdgeDecor,
  setEdgeDecorDuration,
} from "./edge-decor";
import { placeClip } from "@solomotion/core";
import { useDocSelector, useDocStore, useDocWhen } from "../state/document-context";
import { clipLocalClamped } from "../inspector/animatable";
import { compSubject, hasAnyCoverage, hasFrame, mediaCachingAllowed, mediaSubject } from "../cache/cache-status";
import { layerCoverageSpans } from "../stage/render/layer-cache";
import { useLayerCost } from "../preview/use-layer-costs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCacheStatusVersion, useCachingEnabled } from "../cache/use-cache-status";
import { clipLoopNaturalSpanMs, clipSourceMs, videoCacheStatusAt } from "../stage/render/media-cache";
import { CoverageStrip } from "../tracking/CoverageStrip";
import { clipStripPeaks, drawWaveform, getAudioBufferForAsset, nestedClipPeaks, onAudioBufferReady } from "../audio/waveform";
import { ensureClipBake, hasClipBake, useBakeVersion } from "../audio/audio-bake";
import { ClipPosterStrip } from "../preview/ClipPosterStrip";
import { useStripWindow } from "../preview/use-poster";
import { useAiWorkOn } from "../state/ai-activity";
import { useSession } from "../state/session";
import { rectSweepAllowed } from "../state/use-sweep-select";
import { claimPointer } from "../input/pointer-gestures";
import { beginHeldDrag } from "../input/hold-to-drag";
import { type DragMods, modifierActive, readMods, watchDragModifiers } from "../state/drag-modifiers";
import { applyEnter, openClipEditor, resolveEnter } from "../state/focus-model";
import { collectSnapCandidates, fitCanvasBacking, openTimelineRows, pxToTime, timeToPx, RULER_HEIGHT, type TimelineRow } from "./timeline-utils";
import { createEdgeAutoScroll } from "./edge-autoscroll";
import { timelineViewport } from "./timeline-viewport";
import { capturePointer } from "../input/capture-pointer";
import { beginScrubDrag } from "./scrub";
import {
  ClipChromeLayer,
  ClipChromeProvider,
  clipDetail,
  clipEdgeReveal,
  EDGE_GRIP_WIDTH,
  useClipChrome,
} from "./clip-chrome";
import { CueRibbon } from "./CueRibbon";
import { RETIME_BAND_LIFT, RetimeBand } from "./RetimeBand";

/**
 * One clip on the timeline. Owns its drag/trim gestures; every mutation goes
 * through the document store so gestures are single undo steps (mergeKey).
 * ⌥drag duplicates. Selected clips show their keyframes as draggable
 * diamonds — click one to edit its time/value/easing in place.
 */

interface ClipViewProps {
  clip: Clip;
  trackLocked: boolean;
  pxPerSec: number;
  /** The lane's rendered height — the poster tier and its legibility floor. */
  laneHeightPx: number;
  /** The timeline row under a clientY — lane, group caption or ghost. */
  rowAtClientY: (clientY: number) => TimelineRow | null;
  /** Past the first/last lane → which end to spawn a new track on (drop only). */
  laneEdgeAtClientY: (clientY: number) => "top" | "bottom" | null;
}

/**
 * A GROUP's disclosure, on the bar itself: the one place a group is always on
 * screen, whatever lane it moved to. Opens its band beneath this lane; the
 * band's caption, a double-click on empty space in the band, and the layers
 * list all fold it back.
 *
 * The ONE deliberate exception to the chrome rule: a labelled control with its
 * own cursor rather than an overlay you discover by pressing, because folding a
 * group you have not selected is an everyday move.
 */
function GroupBarChevron({ groupId }: { groupId: string }) {
  const collapsed = useSession((s) => s.collapsedIds.includes(groupId));
  return (
    <button
      type="button"
      // It rides the clip's sticky head (see the paint layer), so it is always
      // beside the name. The head starts past the TRIM ZONE, never on it: at
      // the bar's edge it sat on the in-point grip and beat it, so a group was
      // the one clip whose head could not be dragged. `pointer-events-auto`
      // re-opens it inside the inert paint layer — the one control that does.
      className="pointer-events-auto relative z-10 -my-1 flex h-5 w-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-foreground/60 hover:bg-foreground/10 hover:text-foreground"
      aria-label={collapsed ? "Open group" : "Fold group"}
      aria-expanded={!collapsed}
      title={collapsed ? "Open group" : "Fold group"}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        useSession.getState().toggleCollapsed(groupId);
      }}
    >
      {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
    </button>
  );
}

/**
 * The composite badges: a group's MODE on its own bar, and the STENCIL mark on
 * the members doing the operating.
 *
 * Legibility, not decoration. Union / subtract / intersect / exclude / mask have
 * existed since v26 and were invisible on the timeline — a subtract group read
 * exactly like a plain one, and the layer acting as the cutter looked like every
 * other layer. Both facts are one glance now, in the two places a person is
 * already looking. The paint tools create mask groups routinely, so these show
 * up in ordinary projects rather than only in vector work.
 */
function CompositeBadge({ doc, clip }: { doc: MotionDocument; clip: Clip }) {
  if (clip.kind === "group") {
    if (clip.mode === "pass") return null;
    const label = COMPOSITE_MODES.find((m) => m.mode === clip.mode)?.label ?? clip.mode;
    return (
      <span className="material-chip shrink-0 rounded px-1 text-[9px] leading-4 tracking-wide uppercase" title={`${label} group`}>
        {label}
      </span>
    );
  }
  if (clip.kind === "audio" || !clip.isStencil) return null;
  // Only a mark inside a mode that HAS sides — the flag is meaningless in a
  // plain or union group, and showing it there would be a lie.
  if (!modeUsesStencil(groupModeOf(doc, groupOfClip(doc, clip.id)))) return null;
  return <Scissors className="size-3 shrink-0 text-foreground/60" aria-label="Stencil" />;
}

type ClipStyle = { bg: string; border: string; icon: React.ReactNode };

/** A caption reads as a caption even though it IS a text clip (see `clipIcon`). */
const CAPTION_STYLE: ClipStyle = {
  bg: "bg-[color:var(--clip-caption)]",
  border: "border-[color:var(--clip-caption-border)]/50",
  icon: <Captions className="size-3 shrink-0 opacity-80" />,
};

const KIND_STYLES: Record<Clip["kind"], ClipStyle> = {
  text: {
    bg: "bg-[color:var(--clip-text)]",
    border: "border-[color:var(--clip-text-border)]/50",
    icon: <Type className="size-3 shrink-0 opacity-80" />,
  },
  audio: {
    bg: "bg-[color:var(--clip-audio)]",
    border: "border-[color:var(--clip-audio-border)]/50",
    icon: <AudioLines className="size-3 shrink-0 opacity-80" />,
  },
  nested: {
    bg: "bg-[color:var(--clip-text)]",
    border: "border-[color:var(--clip-text-border)]/50",
    icon: <Film className="size-3 shrink-0 opacity-80" />,
  },
  // A group is the CONTAINER of the rows beneath it, so it reads as structure —
  // the lane's own value with a hairline — rather than competing with the
  // coloured clips it holds.
  group: {
    bg: "bg-[color:var(--clip-group)]",
    border: "border-[color:var(--clip-group-border)]/40",
    icon: <GroupIcon className="size-3 shrink-0 opacity-80" />,
  },
  image: {
    bg: "bg-[color:var(--clip-caption)]",
    border: "border-[color:var(--clip-caption-border)]/50",
    icon: <ImageIcon className="size-3 shrink-0 opacity-80" />,
  },
  video: {
    bg: "bg-[color:var(--clip-audio)]",
    border: "border-[color:var(--clip-audio-border)]/50",
    icon: <Clapperboard className="size-3 shrink-0 opacity-80" />,
  },
  shape: {
    bg: "bg-[color:var(--clip-caption)]",
    border: "border-[color:var(--clip-caption-border)]/50",
    icon: <Shapes className="size-3 shrink-0 opacity-80" />,
  },
  path: {
    bg: "bg-[color:var(--clip-caption)]",
    border: "border-[color:var(--clip-caption-border)]/50",
    icon: <PenTool className="size-3 shrink-0 opacity-80" />,
  },
  waveform: {
    bg: "bg-[color:var(--clip-audio)]",
    border: "border-[color:var(--clip-audio-border)]/50",
    icon: <AudioLines className="size-3 shrink-0 opacity-80" />,
  },
  trace: {
    bg: "bg-[color:var(--clip-caption)]",
    border: "border-[color:var(--clip-caption-border)]/50",
    icon: <Spline className="size-3 shrink-0 opacity-80" />,
  },
  raster: {
    bg: "bg-[color:var(--clip-shape,#2C3A2E)]",
    border: "border-[color:var(--clip-shape-border,#7BD88F)]/50",
    icon: <Brush className="size-3 shrink-0 opacity-80" />,
  },
  // A processor layer — its own violet accent (used by no other kind) plus a
  // diagonal-stripe sheen (see `adjustment` overlay below) so it reads at a
  // glance as "this grades the layers beneath it," not as ordinary content.
  // The 3D kinds (v89). Blender's outliner colours: objects orange, cameras
  // and lights the warm yellow-green of its data icons — readable at a glance
  // in a camera track cut between angles.
  mesh: {
    bg: "bg-[color-mix(in_srgb,#F29A4A_20%,var(--track-lane))]",
    border: "border-[#F29A4A]/50",
    icon: <Box className="size-3 shrink-0 opacity-80" />,
  },
  camera: {
    bg: "bg-[color-mix(in_srgb,#9CC27A_22%,var(--track-lane))]",
    border: "border-[#9CC27A]/55",
    icon: <Camera className="size-3 shrink-0 opacity-80" />,
  },
  light: {
    bg: "bg-[color-mix(in_srgb,#E6C35C_20%,var(--track-lane))]",
    border: "border-[#E6C35C]/50",
    icon: <Lightbulb className="size-3 shrink-0 opacity-80" />,
  },
  empty: {
    bg: "bg-[color-mix(in_srgb,#9AA3B2_18%,var(--track-lane))]",
    border: "border-[#9AA3B2]/50",
    icon: <Move3d className="size-3 shrink-0 opacity-80" />,
  },
  adjustment: {
    bg: "bg-[#2E2640]",
    border: "border-[#A78BFA]/50",
    icon: <Contrast className="size-3 shrink-0 opacity-90 text-[#C4B5FD]" />,
  },
};

/**
 * The processor sheen: faint diagonal hazard-stripes across an adjustment clip's
 * body. Purely decorative (pointer-events-none), it's the visual grammar that
 * distinguishes a "grades what's below" layer from a content layer.
 */
const ADJUSTMENT_SHEEN =
  "repeating-linear-gradient(45deg, rgba(196,181,253,0.14) 0px, rgba(196,181,253,0.14) 1px, transparent 1px, transparent 9px)";

/** A clip's lane fill, as a class — the minimap paints clips in the colours the lanes do. */
export function clipFillClass(clip: Clip): string {
  return (isCaptionClip(clip) ? CAPTION_STYLE : KIND_STYLES[clip.kind]).bg;
}

export const ClipView = React.memo(function ClipView({
  clip,
  trackLocked,
  pxPerSec,
  laneHeightPx,
  rowAtClientY,
  laneEdgeAtClientY,
}: ClipViewProps) {
  const store = useDocStore();
  // What a clip bar reads besides its own clip (a prop): its lane neighbours
  // (the roll seam), the group it sits in (the composite badge), and the comps
  // and media it stands for. A nested clip also reads INSIDE its comp (audio
  // only? sound?), so for one any edit counts. Everything else sits still while
  // another layer changes — a bone drag no longer re-renders every bar.
  const doc = useDocWhen((d) => {
    if (clip.kind === "nested") return [d.tracks, d.frames, d.assets];
    const group = groupOfClip(d, clip.id);
    return [locateClip(d, clip.id)?.track.clips, group ? locateClip(d, group)?.clip : null, d.frames, d.assets];
  });
  const selected = useSession((s) => s.selectedClipIds.includes(clip.id));
  const referenced = useIsReferenced({ kind: "clip", id: clip.id });
  const aiWork = useAiWorkOn(clip.id);
  // Combined lock: the track's own flag OR this clip's own per-layer flag —
  // `isClipLocked` (core) is the one place that ORs them together; here we
  // only have the track's flag as a prop, so OR it with the clip directly.
  const locked = trackLocked || clip.locked;

  const left = timeToPx(clip.startMs, pxPerSec);
  const width = Math.max(timeToPx(clip.durationMs, pxPerSec), 8);

  // The clip touching this one's right edge in the same lane + comp (no gap) —
  // the pair a roll edit adjusts. Drives the seam grip.
  const rightNeighborId = React.useMemo(() => {
    const loc = locateClip(doc, clip.id);
    if (!loc) return null;
    const end = clipEnd(clip);
    let best: { id: string; start: number } | null = null;
    for (const other of loc.track.clips) {
      if (other.id === clip.id || other.frameId !== clip.frameId) continue;
      if (other.startMs >= end - 1 && (!best || other.startMs < best.start)) {
        best = { id: other.id, start: other.startMs };
      }
    }
    return best && Math.abs(best.start - end) <= 1 ? best.id : null;
  }, [doc, clip]);

  // The clip touching this one's LEFT edge in the same lane + comp (no gap).
  // The seam grip lives on the RIGHT clip (which renders on top), so this side
  // owns the roll gesture — reliably hittable, never a stray move underneath.
  const leftNeighborId = React.useMemo(() => {
    const loc = locateClip(doc, clip.id);
    if (!loc) return null;
    let best: { id: string; end: number } | null = null;
    for (const other of loc.track.clips) {
      if (other.id === clip.id || other.frameId !== clip.frameId) continue;
      const oEnd = clipEnd(other);
      if (oEnd <= clip.startMs + 1 && (!best || oEnd > best.end)) {
        best = { id: other.id, end: oEnd };
      }
    }
    return best && Math.abs(best.end - clip.startMs) <= 1 ? best.id : null;
  }, [doc, clip]);

  const startGesture = (
    e: React.PointerEvent,
    kind: "move" | "trim-start" | "trim-end",
  ) => {
    if (locked || e.button !== 0) return;
    e.stopPropagation();
    capturePointer((e.currentTarget as HTMLElement), e.pointerId);
    /*
     * WHICH KIND OF CLAIM, and this distinction is the whole fix.
     *
     * A TRIM is meaningful while stationary — you put a finger on the edge and
     * then push — so it owns the hold, and the long-press menu must stand down
     * or you get the trim AND a context menu on top of it.
     *
     * A MOVE is not. It claims only so the browser will not scroll the lanes
     * out from under it, and it must NOT own the hold: pressing and holding a
     * clip to open its menu is the single most ordinary thing you do to a clip,
     * and claiming `"hold"` here deleted it on every clip in the app. If the
     * press turns into a real drag, movement stands the long press down by
     * itself — which is what movement is for.
     */
    claimPointer(e.pointerId, kind === "move" ? "drag" : "hold");
    /*
     * MOVING A CLIP OBEYS THE GESTURE SCOPE, like everything else that lives
     * inside something scrollable.
     *
     * The lanes scroll, so a finger here DEFERS: a fast swipe across the
     * timeline moves you through it, and a brief hold then a drag moves the
     * clip. A mouse and a pen still grab instantly — the scope decides, this
     * gesture does not.
     *
     * It also aborts the moment a second finger lands, which is what stops a
     * two-finger zoom from dragging whichever clip the first finger was
     * resting on. `abandoned` latches, so the release below commits nothing.
     */
    const arm = beginHeldDrag(e);

    const session = useSession.getState();
    // Shared canvas-style click selection (identical brain to the stage), so a
    // ⇧-click adds/removes a clip the same way here as it does on the canvas.
    // Linked selection (DaVinci): touching one member picks the whole link group
    // so the multi-select drag moves them together.
    let selectOnClick: string[] | null = null;
    if (kind === "move") {
      const picked = session.linkedSelection
        ? expandLinkedSelection(store.getState(), [clip.id])
        : [clip.id];
      // Clips never overlap, so "on the selection" is simply "this clip is selected".
      const res = resolvePressSelection(session.selectedClipIds, picked, e.shiftKey, session.selectedClipIds.includes(clip.id));
      if (res.changed) session.select(res.selection);
      selectOnClick = res.onClick;
    }

    // Horizontal scroll offset at grab time. Edge auto-scroll (below) can pan the
    // lanes under a held cursor; folding the scroll delta into the time math keeps
    // the clip pinned to the pointer as new time scrolls into view — without it,
    // auto-scrolling right would reveal time the clip never travels to.
    const startScrollLeft = timelineViewport.el?.scrollLeft ?? 0;
    const docAtStart = store.getState();
    const sessionNow0 = useSession.getState();
    // The clips this gesture operates on. Move drags the (already link-expanded)
    // selection; a TRIM group-trims the same set — every selected clip's matching
    // edge moves by the SAME delta as the dragged one. A trim on a clip that
    // isn't part of the selection just trims that clip.
    const operateIds = (
      kind === "move"
        ? sessionNow0.selectedClipIds
        : sessionNow0.selectedClipIds.includes(clip.id)
          ? sessionNow0.linkedSelection
            ? expandLinkedSelection(docAtStart, sessionNow0.selectedClipIds)
            : sessionNow0.selectedClipIds
          : [clip.id]
    ).filter((id) => {
      const l = locateClip(docAtStart, id);
      return l && !isClipLocked(l.track, l.clip);
    });
    const movingIds = operateIds.length > 0 ? operateIds : [clip.id];
    const trimIds = kind === "move" ? [] : movingIds;
    // Track-row origins so a MULTI drag moves the whole set vertically by the
    // SAME number of rows — free 2-axis movement that preserves the set's
    // arrangement, exactly like a single clip hopping tracks. Rows are the
    // LANE rows on screen (a group's band rows included), frozen at start.
    const laneRows = openTimelineRows(docAtStart).filter((r): r is TimelineRow & { kind: "lane" } => r.kind === "lane");
    const trackRowById = new Map(laneRows.map((r, i) => [r.track.id, i] as const));
    const leadOriginRow = trackRowById.get(locateClip(docAtStart, clip.id)?.track.id ?? "") ?? 0;
    // Origin edge per clip: startMs for move & trim-start, out-point for trim-end.
    const origins = new Map<string, number>();
    const originRow = new Map<string, number>();
    // The group each clip started in — the SCOPE a plain drag stays inside.
    const originScope = new Map<string, string | null>();
    // Tracks the dragged clips START on — the only candidates for auto-prune on
    // release (so a manual empty track, which no clip left, is never swept).
    const sourceTrackIds = new Set<string>();
    for (const id of movingIds) {
      const l = locateClip(docAtStart, id);
      if (l) {
        origins.set(id, kind === "trim-end" ? clipEnd(l.clip) : l.clip.startMs);
        originRow.set(id, trackRowById.get(l.track.id) ?? 0);
        originScope.set(id, l.track.groupId);
        sourceTrackIds.add(l.track.id);
      }
    }
    /*
     * WHERE A DRAG MAY LAND — the scope rule.
     *
     * A clip never LEAVES its group by a plain drag: the rows it may take are
     * its own group's and any group nested deeper inside it, and pushing past
     * the band's edges makes a new row there rather than falling out. Dropping
     * INTO a group from outside is always free — you aimed at a tinted band.
     * The drag-out modifier releases the rule, and then any row is fair. Two
     * facts chose this shape: leaving by accident is the everyday slip (the
     * band's first and last rows are one row from the outside), and entering
     * is never an accident.
     */
    const ancestryOf = new Map<string, string[]>();
    const chain = (scope: string | null): string[] => {
      if (!scope) return [];
      let c = ancestryOf.get(scope);
      if (!c) {
        c = groupAncestry(docAtStart, scope);
        ancestryOf.set(scope, c);
      }
      return c;
    };
    const mayLand = (clipId: string, targetScope: string | null, released: boolean): boolean => {
      if (released) return true;
      const from = originScope.get(clipId) ?? null;
      if (!from) return true;
      return targetScope === from || chain(targetScope).includes(from);
    };
    /** The nearest lane row a clip may take, given the row the pointer wants. */
    const clampRow = (clipId: string, want: number, released: boolean): number | "top" | "bottom" => {
      const ok = (i: number) => {
        const r = laneRows[i];
        return !!r && mayLand(clipId, r.scope?.id ?? null, released);
      };
      if (ok(want)) return want;
      let first = -1;
      let last = -1;
      laneRows.forEach((_, i) => {
        if (!ok(i)) return;
        if (first < 0) first = i;
        last = i;
      });
      if (first < 0) return want;
      if (want < first) return "top";
      if (want > last) return "bottom";
      for (let d = 1; d < laneRows.length; d++) {
        if (ok(want - d)) return want - d;
        if (ok(want + d)) return want + d;
      }
      return want;
    };
    const origStart = clip.startMs;
    const origEnd = clip.startMs + clip.durationMs;
    /*
     * THE PRE-DRAG BASELINE — the whole track list, not just its clips.
     *
     * A move is re-derived from scratch on every frame rather than nudged from
     * the last one: restore the world as it was before the press, then apply
     * the drag as it stands now. That is what lets OVERWRITE be honest (a
     * neighbour is eaten only while the clip actually covers it, and backing
     * out un-eats it) and it is what lets ⌥ be LIVE (below).
     *
     * It snapshots `tracks` entire, because both of those effects can add and
     * remove LANES, not only clips — a ⌥-stamp of a group mints carrier rows
     * for its members. Restoring clips alone left those rows behind as empty
     * lanes nobody asked for.
     */
    const cloneTracks = (tracks: readonly Track[]) => tracks.map((t) => structuredClone(t));
    const baseline = kind === "move" ? cloneTracks(docAtStart.tracks) : null;
    /*
     * ⌥-DRAG IS "LEAVE A COPY BEHIND", and that is the whole architecture of it.
     *
     * It used to fork copies on the first movement and then drag THOSE — which
     * meant a second placement rule (each copy on a fresh lane above its
     * source), a latch that could not be undone when ⌥ was released, and ids
     * that changed under the selection mid-gesture. Dragging a clip forward
     * along its own lane spawned a track, because the copy had already been
     * put on one before the direction of the drag was even known.
     *
     * So invert it: the ORIGINAL is what you drag — through the one move path
     * below, with its snapping, its overwrite, its lane hops and its
     * past-the-edge spawn, none of it reimplemented — and ⌥ simply STAMPS a
     * copy back at the origin. Every question the old shape had to answer
     * separately answers itself: drag forward on the lane and the clip lands
     * forward on the lane, because that is where an ordinary move lands.
     *
     * And because the stamp is part of the baseline rather than part of the
     * drag, ⌥ is live in both directions: press it and the copy appears, let go
     * and it is gone, exactly as it behaves on the stage. `stampedBaseline` is
     * the baseline WITH the copy, built once and reused, so the ids under React and
     * under the selection never churn.
     */
    /**
     * The stamp, as VALUES — built once, applied after the move, every frame ⌥
     * is down.
     *
     * `homed` are the copies that go straight back onto the lane their source
     * just left. `rows` are the lanes the stamp has to bring with it: a GROUP
     * is its rows, so a copied group's members ride copied carriers or they
     * are members of the original.
     */
    let stamp: { rows: { index: number; track: Track }[]; homed: { clip: Clip; trackId: string }[] } | null = null;
    const buildStamp = () => {
      // A detached copy of the pre-drag stack, so the stamp is a value the
      // frame can lay down rather than something the draft has to be walked
      // into. `duplicateClips` touches only tracks, which is all this document
      // has of its own.
      const stampDoc: MotionDocument = { ...docAtStart, tracks: cloneTracks(baseline!) };
      // The SAME copying op ⌘D uses — descendants, fresh ids, links re-linked
      // to each other, membership re-pointed at the copied group.
      const { tops } = duplicateClips(stampDoc, movingIds);
      const homed: { clip: Clip; trackId: string }[] = [];
      tops.forEach((copyId, i) => {
        const srcId = movingIds[i];
        const src = srcId ? locateClip(docAtStart, srcId) : null;
        const loc = locateClip(stampDoc, copyId);
        if (!src || !loc) return;
        /*
         * ⌘D's PLACEMENT IS NOT ⌥-DRAG'S, and this is the difference.
         *
         * A duplicate-in-place must overlap its source, so a fresh lane above
         * it is the only correct z. A ⌥-drag's copy does not overlap anything:
         * the original is leaving, and the lane it leaves is exactly where the
         * copy belongs. Minting one anyway is what made dragging a clip
         * forward along its own track spawn a track above it every time.
         *
         * A GROUP is the exception, and not an arbitrary one — a group IS a
         * set of rows, so a copy of it is a copy of those rows and they come
         * along. Everything else is lifted off the lane `duplicateClips` minted
         * and re-placed below.
         */
        if (src.clip.kind === "group") return;
        loc.track.clips.splice(loc.clipIndex, 1);
        homed.push({ clip: loc.clip, trackId: src.track.id });
      });
      // Whatever is left of the minted lanes — the group rows — with the place
      // in the stack they were minted at. Lanes emptied by the lift above are
      // dropped before the indices are read, so they stay true.
      const had = new Set(baseline!.map((t) => t.id));
      stampDoc.tracks = stampDoc.tracks.filter((t) => had.has(t.id) || t.clips.length > 0);
      const rows = stampDoc.tracks
        .map((track, index) => ({ index, track }))
        .filter((r) => !had.has(r.track.id));
      return { rows, homed };
    };
    /**
     * Lay the stamp down — AFTER the originals have moved, into the lanes they
     * vacated. `placeClip` decides the rest with the one rule the whole app
     * uses: its own lane when the move really did free it, a fresh lane right
     * above when the drag was too short to and the two would overlap.
     */
    const applyStamp = (d: MotionDocument) => {
      if (!stamp) stamp = buildStamp();
      for (const r of stamp.rows) d.tracks.splice(r.index, 0, structuredClone(r.track));
      for (const h of stamp.homed) placeClip(d, structuredClone(h.clip), { preferredTrackId: h.trackId });
    };
    /*
     * RESTORE, cheaply. Replacing `d.tracks` outright is correct but records a
     * patch holding every track on every pointer move; the lanes themselves
     * only change when ⌥ stamps a group's rows or a lane is spawned, so the
     * common frame restores clip lists in place and leaves the array alone.
     */
    const restoreTracks = (d: MotionDocument, base: Track[]) => {
      const same =
        d.tracks.length === base.length && d.tracks.every((t, i) => t.id === base[i]!.id);
      if (!same) {
        d.tracks = cloneTracks(base);
        return;
      }
      for (let i = 0; i < base.length; i++) d.tracks[i]!.clips = base[i]!.clips.map((c) => structuredClone(c));
    };
    const snapCandidates = collectSnapCandidates(
      docAtStart,
      clip.frameId,
      new Set(movingIds),
      session.playheadMs,
      session.snapSettings,
    );
    /*
     * A ⌥-drag's own edges are magnets. The moving clips are excluded from the
     * candidates above (a clip cannot snap to itself), but under ⌥ their
     * PRE-DRAG edges are where the stamp is standing — and "drag forward until
     * it sits flush after the original" is the gesture ⌥-drag exists for. Kept
     * separate so they are only in play while ⌥ actually is.
     */
    const stampCandidates =
      kind === "move"
        ? movingIds.flatMap((id) => {
            const l = locateClip(docAtStart, id);
            return l ? [l.clip.startMs, clipEnd(l.clip)] : [];
          })
        : [];
    const mergeKey = `clip-${kind}-${clip.id}-${e.pointerId}`;
    let moved = false;
    // Dragging past a scope's edge spawns a new row there — but only on
    // release, so mid-drag jitter never litters the stack.
    let pendingNewLane: { edge: "top" | "bottom"; scope: string | null } | null = null;
    // The exact clips (with their dragged start times) a release past the edge
    // will move onto fresh lanes — mirrors the live ghost preview.
    let pendingLaneMoves: { clipId: string; startMs: number }[] = [];
    // Live pointer + modifier state, so the gesture re-runs on a modifier toggle
    // even with the pointer held perfectly still (real-time drag-out preview).
    let lastX = e.clientX;
    let lastY = e.clientY;
    let curMods = readMods(e);
    // Whether the LAST applied frame was free to leave its scope — a group it
    // emptied is swept on release, never mid-drag (the drag may come back).
    let lastReleased = false;

    const apply = () => {
      const scrollDx = (timelineViewport.el?.scrollLeft ?? startScrollLeft) - startScrollLeft;
      // Travel since the drag ARMED, not since the press: the slop a gesture
      // spends proving it is a drag is the price of recognising it, not part
      // of it, and charging the clip for it makes the clip leap on pickup.
      const travel = arm.delta(lastX, lastY);
      const travelX = travel.x;
      let dMs = pxToTime(travelX + scrollDx, pxPerSec);
      // ⇧ Y-axis lock: constrain to track movement only, no time shift
      if (curMods.shift) dMs = 0;
      // A drag straight up or down is still a drag — it changes rows.
      if (!moved && travelX === 0 && travel.y === 0 && scrollDx === 0) return;
      moved = true;
      const sessionNow = useSession.getState();
      const snapping = sessionNow.snapping;
      const threshold = pxToTime(sessionNow.snapSettings.thresholdPx, pxPerSec);
      let snappedTo: number | null = null;

      if (kind === "move") {
        // ⌥ is read LIVE, like every other modifier in a drag: holding it
        // stamps a copy at the origin, letting go takes it away again, and the
        // clip under the cursor never changes identity.
        const stamping = curMods.alt;

        // Snap the dragged clip's edges; apply the common delta to the rest.
        // Under ⌥ the origin's own edges join the magnets — that is where the
        // copy is standing.
        const magnets = stamping ? [...snapCandidates, ...stampCandidates] : snapCandidates;
        let lead = origStart + dMs;
        if (snapping) {
          const snappedStart = snapTime(lead, magnets, threshold);
          const snappedEnd = snapTime(lead + clip.durationMs, magnets, threshold);
          if (snappedStart !== lead) {
            lead = snappedStart;
            snappedTo = snappedStart;
          } else if (snappedEnd !== lead + clip.durationMs) {
            lead = snappedEnd - clip.durationMs;
            snappedTo = snappedEnd;
          }
        }
        const delta = lead - origStart;
        const leadId = clip.id;
        const released = modifierActive(curMods, useSession.getState().dragOutModifier);
        lastReleased = released;
        // The row the pointer is over, as a LANE index the whole set shifts by.
        // A group's caption reads as "just above its first row"; a ghost row
        // keeps the resolution that armed it; past the end is past the end.
        const over = rowAtClientY(lastY);
        const leadWant: number | "top" | "bottom" | null = (() => {
          if (!over) return null;
          if (over.kind === "lane") return trackRowById.get(over.track.id) ?? null;
          const all = openTimelineRows(store.getState());
          const at = all.indexOf(over);
          for (let i = at + 1; i < all.length; i++) {
            const r = all[i]!;
            if (r.kind === "lane") return trackRowById.get(r.track.id) ?? null;
          }
          return laneRows.length; // nothing beneath: past the last lane
        })();
        // Past the COMP's edge: the top/bottom of the whole stack. Only a clip
        // free to leave its scope may spawn a lane there.
        const compEdge = laneEdgeAtClientY(lastY);
        let edge: { edge: "top" | "bottom"; scope: string | null } | null = null;
        if (compEdge && mayLand(leadId, null, released)) edge = { edge: compEdge, scope: null };
        else if (over?.kind === "group" && mayLand(leadId, over.group.id, released)) {
          // A band's caption IS "a new first row inside this group".
          edge = { edge: "top", scope: over.group.id };
        } else if (typeof leadWant === "number") {
          const clamped = clampRow(leadId, leadWant, released);
          if (clamped === "top" || clamped === "bottom") edge = { edge: clamped, scope: originScope.get(leadId) ?? null };
        }
        pendingNewLane = edge;
        // Live preview only — nothing is created until release commits it. Each
        // moving clip previews at its dragged time on a RELATIVE new-lane row
        // (topmost source row → row 0), so the ghost shows all the new tracks.
        if (edge) {
          const distinctRows = [...new Set(movingIds.map((id) => originRow.get(id) ?? 0))].sort((a, b) => a - b);
          const dNow = store.getState();
          pendingLaneMoves = movingIds.map((id) => ({ clipId: id, startMs: (origins.get(id) ?? 0) + delta }));
          useSession.getState().setPendingNewLane({
            ...edge,
            clips: movingIds.map((id) => ({
              startMs: (origins.get(id) ?? 0) + delta,
              durationMs: locateClip(dNow, id)?.clip.durationMs ?? clip.durationMs,
              row: distinctRows.indexOf(originRow.get(id) ?? 0),
            })),
          });
        } else {
          pendingLaneMoves = [];
          useSession.getState().setPendingNewLane(null);
        }
        // The row the cursor is over shifts the WHOLE set by that many rows,
        // each clip then clamped to the rows ITS scope allows, so the set moves
        // vertically as one and keeps its shape — the vertical twin of the
        // shared time delta. Suppressed past an edge (the set is spawning new
        // lanes there).
        let trackDeltaRows = 0;
        if (!edge && typeof leadWant === "number") trackDeltaRows = leadWant - leadOriginRow;
        const targetTrackFor = (id: string): string | undefined => {
          if (edge || trackDeltaRows === 0) return undefined; // stay in-lane
          const or = originRow.get(id);
          if (or === undefined) return undefined;
          const want = Math.max(0, Math.min(laneRows.length - 1, or + trackDeltaRows));
          const nr = clampRow(id, want, released);
          return typeof nr === "number" ? laneRows[nr]?.track.id : undefined;
        };
        // Overwrite ALWAYS (not just snapping-off): pushing a clip into another
        // trims/eats it, period. Snapping still magnets the edges for alignment,
        // but it never blocks the carve. Spawning a new lane opts out — there is
        // nothing on a lane that does not exist yet to carve.
        const overwrite = !edge;

        store.update(
          stamping ? "Duplicate clip" : "Move clip",
          (d) => {
            // THE FRAME IS REBUILT, NEVER NUDGED: restore the world as it was
            // before the press — with or without ⌥'s stamp, whichever is true
            // right now — and then apply the drag as it stands. Eaten
            // neighbours come back the instant we stop covering them, and ⌥
            // toggling is just a different baseline.
            restoreTracks(d, baseline!);
            const guard = new Set(origins.keys());
            for (const [id, orig] of origins) {
              const track = targetTrackFor(id);
              if (overwrite) moveClipOverwrite(d, id, orig + delta, track, guard);
              else moveClip(d, id, orig + delta, track);
            }
            // LAST, so the copy lands in the hole the move just made — and so
            // the carve above can never eat it. Overwrite is a rule about what
            // a clip does to the neighbours it lands on, and the copy this very
            // gesture left behind is not a neighbour.
            if (stamping) applyStamp(d);
          },
          { mergeKey },
        );
      } else {
        const edge = kind === "trim-start" ? "start" : "end";
        let t = (edge === "start" ? origStart : origEnd) + dMs;
        if (snapping) {
          const snapped = snapTime(t, snapCandidates, threshold);
          if (snapped !== t) snappedTo = snapped;
          t = snapped;
        }
        // A multi trim applies the dragged clip's delta to every selected clip's
        // own edge; each clamps independently (min duration, neighbours, source 0).
        const delta = t - (edge === "start" ? origStart : origEnd);
        store.update(
          "Trim clip",
          (d) => {
            // A GROUP already carries the descendants flush with its edge
            // (`groupEdgeFollowers`). One of them being selected TOO must not
            // trim it a second time — the delta would land twice and the layer
            // would run away from the edge that was dragged. Named from the
            // pre-trim document, for the same reason core names them there.
            const carried = new Set<string>();
            for (const id of trimIds) {
              const l = locateClip(d, id);
              if (l && l.clip.kind === "group") {
                for (const f of groupEdgeFollowers(d, l.clip, edge)) carried.add(f);
              }
            }
            for (const id of trimIds) {
              if (carried.has(id)) continue;
              const o = origins.get(id);
              if (o !== undefined) trimClip(d, id, edge, o + delta);
            }
          },
          { mergeKey },
        );
      }
      sessionNow.setSnapIndicator(snappedTo);
    };

    // Drag a clip toward the top/bottom fold and the lanes auto-scroll to reveal
    // what's beyond it — then, once pinned at the boundary, the same edge arms
    // the new-track placeholder. Each scroll frame re-runs apply() so the ghost,
    // the hovered track, and the past-edge test all resolve against the freshly
    // revealed rows. Move-only: trims don't hop tracks. RULER_HEIGHT insets the
    // top zone below the sticky ruler so it maps to real lanes.
    const autoScroll =
      kind === "move"
        ? createEdgeAutoScroll({
            getViewport: () => timelineViewport.el,
            contentTopInset: RULER_HEIGHT,
            onScroll: () => apply(),
          })
        : null;

    // Pointer moves feed apply() the live cursor + modifiers; a modifier toggle
    // (⌘ pressed/released with the pointer held still) re-runs it too, so the
    // drag-out preview turns on/off in real time — the shared gesture spine.
    const onMove = (ev: PointerEvent) => {
      if (!arm.update(ev.clientX, ev.clientY)) return;
      lastX = ev.clientX;
      lastY = ev.clientY;
      curMods = readMods(ev);
      autoScroll?.update(ev.clientX, ev.clientY);
      apply();
    };
    const stopMods = watchDragModifiers(curMods, (m: DragMods) => {
      curMods = m;
      if (moved) apply();
    });

    const onUp = () => {
      arm.end();
      useSession.getState().setSnapIndicator(null);
      useSession.getState().setPendingNewLane(null);
      autoScroll?.stop();
      stopMods();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      // A clip that LEFT its group may have emptied it: sweep on release,
      // folded into the same undo step (mergeKey).
      if (kind === "move" && moved && lastReleased) {
        store.update("Move clip", (d) => pruneGroups(d), { mergeKey });
      }
      // A press that never moved is a CLICK, and a click resolves the selection
      // it deferred — ⇧'s toggle, or a link group's expansion — the same rule
      // the stage uses. A ⇧-drag instead constrained the move above (Y-axis lock).
      if (selectOnClick && !moved) {
        session.select(selectOnClick);
      }
      // A trim that stretched a play-once MEDIA clip past its footage asks
      // what fills the extra time (loop / stretch speed / freeze) — on
      // release, so mid-drag never nags.
      if (kind === "trim-end" && moved) {
        const dNow = store.getState();
        const lNow = locateClip(dNow, clip.id);
        const capacity = lNow ? clipSourceCapacityMs(dNow, lNow.clip) : null;
        if (lNow && capacity !== null && lNow.clip.durationMs > capacity + 1) {
          useSession.getState().setFootageOverrun(clip.id);
        }
      }
      // Commit the new-lane move on release (drag-past-edge) — the WHOLE set
      // lands on fresh lanes (one per distinct source row), preserving its
      // arrangement, so a linked video+audio push spawns both tracks at once.
      if (kind === "move" && moved && pendingNewLane && pendingLaneMoves.length > 0) {
        const target = pendingNewLane;
        store.update(
          target.edge === "top" ? "Move to new track above" : "Move to new track below",
          (d) => {
            moveClipsToNewLanes(d, pendingLaneMoves, target.edge, target.scope);
            pruneGroups(d);
          },
          { mergeKey },
        );
      }
      // Auto-remove any track the dragged clip(s) LEFT empty — on release only,
      // folded into the drag's one undo step (same mergeKey), gated on the
      // setting. Manual empty tracks aren't candidates (no clip left them).
      if (kind === "move" && moved && useSession.getState().autoDeleteEmptyTracks) {
        store.update("Remove empty track", (d) => pruneEmptiedTracks(d, sourceTrackIds), { mergeKey });
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Roll edit: drag the shared seam to trim BOTH clips at once (DaVinci-style),
  // leaving the pair's outer span put and the media in sync. The grip lives on
  // the right clip (the seam), so `leftId` is its left neighbour, `boundary0`
  // the seam. Each edge's own handle still trims just one side.
  const startRoll = (e: React.PointerEvent, leftId: string, rightId: string, boundary0: number) => {
    if (locked || e.button !== 0) return;
    e.stopPropagation();
    capturePointer((e.currentTarget as HTMLElement), e.pointerId);
    // The roll grip is a handle: meaningful while stationary, so it owns the
    // hold and no menu opens on top of it.
    claimPointer(e.pointerId, "hold");
    const session = useSession.getState();
    const startX = e.clientX;
    const snapCandidates = collectSnapCandidates(
      store.getState(),
      clip.frameId,
      new Set([leftId, rightId]),
      session.playheadMs,
      session.snapSettings,
    );
    const mergeKey = `roll-${leftId}-${rightId}-${e.pointerId}`;

    const onMove = (ev: PointerEvent) => {
      let t = boundary0 + pxToTime(ev.clientX - startX, pxPerSec);
      let snappedTo: number | null = null;
      if (useSession.getState().snapping) {
        const threshold = pxToTime(session.snapSettings.thresholdPx, pxPerSec);
        const snapped = snapTime(t, snapCandidates, threshold);
        if (snapped !== t) snappedTo = snapped;
        t = snapped;
      }
      store.update("Roll edit", (d) => void rollEdit(d, leftId, rightId, t), { mergeKey });
      useSession.getState().setSnapIndicator(snappedTo);
    };
    const onUp = () => {
      useSession.getState().setSnapIndicator(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // An audio-only nested comp reads AS audio on the timeline (audio tint + waves
  // + AudioLines) — same nested kind, capability-driven look.
  const audioNested = nestedIsAudioOnly(doc, clip);
  const styles = audioNested ? KIND_STYLES.audio : isCaptionClip(clip) ? CAPTION_STYLE : KIND_STYLES[clip.kind];
  // A nested clip that instances a component reads as a component (purple ◈),
  // distinct from a plain nested comp (Film) — Figma's instance recognizability.
  const isInstance = clip.kind === "nested" && !audioNested && componentFrameOfClip(doc, clip) != null;
  const icon = isInstance ? <Component className="size-3 shrink-0 text-[#B79BFF]" /> : styles.icon;
  // How much this row can legibly hold — the ONE reading of "is this lane
  // small", shared with every overlay through `ClipChromeProvider`.
  const detail = clipDetail(laneHeightPx);
  /*
   * WHAT REVEALS THE TRIM GRIPS on a clip this wide — the one rule, from the
   * clip surface contract. On a wide clip hover still offers them, because the
   * body is plainly the larger target. On a SHORT one they wait for the
   * selection, exactly like every other overlay on the clip, so an unselected
   * short clip is one object you pick up and move. See `clipEdgeReveal`.
   */
  const gripsOnHover = clipEdgeReveal(width) === "hover";
  // One expression for all three grips (trim in, trim out, roll), so they can
  // never disagree about when the clip's edges are reachable. A grip that is
  // not revealed is not merely invisible — it must not answer a pointer, or
  // the press it swallows is exactly the bug this closes.
  const GRIP_REVEAL = selected
    ? "opacity-100"
    : gripsOnHover
      ? "opacity-0 group-hover:opacity-100 grip-needs-select"
      : "pointer-events-none opacity-0";
  // A caption's cue ribbon owns the clip's top edge; the title sits under it
  // rather than through it.
  const ribbon = isCaptionClip(clip) && clip.caption.cues.length > 0;

  return (
    <ClipChromeProvider active={selected && !locked} laneHeightPx={laneHeightPx} widthPx={width}>
    <div
      data-clip-drop-id={clip.id}
      className={cn(
        // A clip is arbitrated by TIME, not by hit-target: `startGesture`
        // runs through `beginHeldDrag`, so a quick swipe across the lanes
        // scrolls them even when it starts on a clip, and a brief hold then
        // moves the clip. `DRAG_SURFACE` used to be here and contradicted
        // that outright — it told the browser never to scroll from a clip, so
        // the swipe this gesture politely declined had nowhere to go.
        "group absolute top-1 bottom-1 rounded-md border text-left",
        HELD_DRAG_SURFACE,
        styles.bg,
        styles.border,
        selected && "ring-2 ring-primary border-transparent",
        locked ? "cursor-not-allowed opacity-60" : "cursor-grab active:cursor-grabbing",
        clip.hidden && "opacity-40",
      )}
      style={{ left, width }}
      onPointerDown={(e) => startGesture(e, "move")}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (locked) return;
        // The SAME unified drill brain the stage uses: step one level in per
        // double-click (group → … → leaf clip → the clip's own editor). Groups
        // and selection behave identically on both surfaces; only the terminal
        // editor step is surface-specific.
        const session = useSession.getState();
        const action = resolveEnter(store.getState(), clip, {
          enteredGroupId: session.enteredGroupId,
          selectedClipIds: session.selectedClipIds,
        });
        // Timeline nicety: landing on the leaf clip scrubs the playhead to it.
        if (action.type === "selectClip") session.setPlayhead(clip.startMs);
        const edit = applyEnter(action, session);
        if (!edit) return; // drilled a group / selected — nothing more to open
        // Same terminal opener the stage uses. Canvas-only editors (glyphs,
        // nodes, corners, crop) simply open on the canvas for the clip you
        // double-clicked here — one gesture, one destination, either surface.
        openClipEditor(store, clip, edit.mode);
      }}
    >
      {/* An AI job is working on this clip: the same ring and sheen as the canvas. */}
      {aiWork && <div className="ai-work-bar z-10 rounded-md" title={`${aiWork.label}${aiWork.progress ? ` · ${aiWork.progress}` : ""}`} />}
      {/* THE PAINT LAYER — pictures, waveforms, structure marks, the label.
          Inert by construction: nothing in here is a control, so nothing in
          here may intercept the press that picks the clip up. See
          `clip-chrome.tsx` for the rule this is one half of. The one
          exception is a group's fold chevron, which rides the head below.

          `overflow-clip`, never `overflow-hidden`: hidden makes this box a
          scroll container, and a scroll container is what `position: sticky`
          sticks to — the head would stick to the clip and never move. Clip
          crops the same pixels without becoming one, so the head sticks to the
          LANES' scroller. */}
      <div className="pointer-events-none absolute inset-0 overflow-clip rounded-md">
        {/* Pictures first: everything else on the clip is chrome ON them. */}
        <ClipPosterStrip clip={clip} pxPerSec={pxPerSec} heightPx={laneHeightPx} />
        <ClipDecorations clip={clip} pxPerSec={pxPerSec} audioNested={audioNested} />
        <SourceCycleMarks clip={clip} pxPerSec={pxPerSec} doc={doc} />
        {clip.kind === "adjustment" && (
          <div className="pointer-events-none absolute inset-0" style={{ backgroundImage: ADJUSTMENT_SHEEN }} />
        )}
        {(clip.kind === "video" || clip.kind === "nested") && <ClipCacheStrip clip={clip} pxPerSec={pxPerSec} />}
        {/* THE STACK, drawn as the stack: the layer's kept pixels on the top
            edge, its decoded footage just beneath. Two facts, two lines — the
            finished frames of the whole comp live on the ruler. */}
        {clip.kind !== "audio" && (
          <>
            <RenderBar clip={clip} pxPerSec={pxPerSec} />
            <ClipCost clip={clip} />
          </>
        )}

        <div
          className={cn(
            "relative flex h-full flex-col justify-center px-2",
            // A group's head opens with its chevron, which must clear the trim grip.
            clip.kind === "group" && "pl-(--hit-grip)",
            ribbon && detail !== "micro" && "pt-3",
          )}
        >
          {/* THE HEAD — chevron, name, badges, the line under them — STICKS to
              the left of the lanes while the clip runs on past it, so a clip
              you have scrolled into the middle of still says what it is. The
              browser does the work (no per-scroll JS, no React), and a sticky
              box cannot leave its container: as the clip's END arrives, the
              head is pushed out with it rather than drawn past it. */}
          <div className="sticky left-1.5 flex w-max max-w-full flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            {clip.kind === "group" && <GroupBarChevron groupId={clip.id} />}
            {icon}
            <span className="truncate text-[11px] font-medium leading-tight text-foreground/90">
              {clip.name}
            </span>
            {/* Sound badge on ANY clip that carries sound — a text with typing
                sound, a nested comp holding audio, an unmuted video. Muted
                (audioMix) shows the crossed-out icon. Audio clips already read
                as sound (waveform + AudioLines), so they're excluded. */}
            {clip.kind !== "audio" &&
              clipHasSound(doc, clip) &&
              (clip.audioMix.muted ? (
                <VolumeX className="size-3 shrink-0 text-foreground/40" />
              ) : (
                <Volume2 className="size-3 shrink-0 text-primary/90" />
              ))}
            {clip.kind === "audio" && audioNeedsBakeLive(clip) && <HeavyAudioBadge clip={clip} />}
            {/* WHAT THIS GROUP DOES, and WHICH SIDE this layer is on — the two
                facts the composite modes never showed where the work happens.
                A subtract used to look exactly like a plain group, and nothing
                said which member was the base. */}
            <CompositeBadge doc={doc} clip={clip} />
            <EffectBadge clip={clip} />
            {/* Referenced by the paint tools — the same mark the layers panel
                and the track header wear, so it is learned once. */}
            <ReferenceBadge on={referenced} />
            {clip.locked && <Lock className="ml-auto size-3 shrink-0 text-foreground/60" />}
            {clip.hidden && <EyeOff className="ml-auto size-3 shrink-0 text-foreground/60" />}
          </div>
          {detail === "full" && clip.kind === "text" && clip.animations.in && (
            <span className="truncate font-mono text-[9px] uppercase tracking-wide text-foreground/50">
              {getPreset(clip.animations.in.preset)?.label ?? clip.animations.in.preset}
              {" · "}
              {clip.animations.in.unit}
            </span>
          )}
          {detail === "full" && clip.kind === "nested" && (
            <span className="truncate font-mono text-[9px] uppercase tracking-wide text-foreground/50">
              nested{clip.playback.loop !== "none" ? ` · ${clip.playback.loop}` : ""}
            </span>
          )}
          {detail === "full" && clip.kind === "adjustment" && (
            <span className="truncate font-mono text-[9px] uppercase tracking-wide text-[#C4B5FD]/70">
              {clip.scope.reach === "all" ? "all layers" : "below"}
              {clip.scope.filter.mode !== "all" ? ` · ${clip.scope.filter.mode}` : ""}
              {clip.effects.length ? ` · ${clip.effects.length} fx` : " · empty"}
            </span>
          )}
          </div>
        </div>
      </div>

      {/* THE CHROME LAYER — everything you can GRAB. Paints always, answers a
          pointer only once the clip is selected, and every overlay inherits
          that without asking. A cue ribbon, an animation chip, a keyframe
          diamond, an envelope point and whatever is added next all stop
          stealing the press that picks the clip up. */}
      <ClipChromeLayer clipped>
        <ClipEdgeChips clip={clip} pxPerSec={pxPerSec} />
        {(clip.kind === "video" || clip.kind === "image") && <ClipTrackStrips clip={clip} widthPx={width} />}
      </ClipChromeLayer>
      <ClipChromeLayer>
        {/* Caption cues as real segments — both edges of every one of them
            draggable, the last included (see `dragCueEdge`). */}
        {isCaptionClip(clip) && <CueRibbon clip={clip} pxPerSec={pxPerSec} />}

        {/* The clip's SPEED, drawn where the speed is: the rate on the runs
            that hold one, a line where it ramps, a hatch where it holds, and
            the speed keyframes themselves as the handles on that line. */}
        <RetimeBand clip={clip} pxPerSec={pxPerSec} />

        {/* Keyframes (selected clips only — kept outside the overflow clip).
            Audio included: gain/EQ keys behave and edit like any other clip.
            `playback.speed` is deliberately absent: its keys are the retime
            band's handles, and two rows of handles for one track is two records
            of one fact. */}
        {selected && clip.keyframes.some((t) => t.property !== SPEED_PROPERTY && t.keys.length > 0) && (
          <KeyframeLane clip={clip} pxPerSec={pxPerSec} retimed={isRetimed(clip)} />
        )}

        {/* Audio volume envelope — DaVinci-style line with draggable gain points
            and fade-in/out handles, drawn over the waveform. SELECTED ONLY: an
            unselected clip is one object you pick up, and a line you could
            grab through it was how moving a small sound clip nudged its level. */}
        {clip.kind === "audio" && selected && !locked && <AudioEnvelope clip={clip} pxPerSec={pxPerSec} />}

        <LoopCycleHandle clip={clip} pxPerSec={pxPerSec} doc={doc} />
      </ClipChromeLayer>

      {/* Trim / roll handles. At a seam the three zones sit side by side:
          trim-out (left clip) · roll (straddling, on the right clip) · trim-in
          (right clip). The trim handles step inward when a neighbour touches so
          the seam centre is always the roll. */}
      {!locked && (
        <>
          {/*
            TRIM GRIPS.

            Two changes from the hover-only strip these used to be, and both
            are about the same structural fact: a touch device has NO HOVER, so
            a control revealed by hover does not exist there. Trimming was
            reachable on a tablet only by guessing where an invisible 8px strip
            was. (Their WIDTH gives way on a narrow clip — `EDGE_GRIP_WIDTH`.)

              · SELECTION reveals them. Selecting a clip is the gesture that
                says "this is the one I am working on", and it is available to
                every pointer. Hover still reveals them for a mouse, so nothing
                is lost and nothing new has to be learned.
              · the HIT AREA is `coarse`-sized while the GRIP stays small. A
                finger needs ~15px of target; the eye needs 3px of mark. Those
                are different numbers and conflating them is how touch targets
                end up as ugly slabs. The target grows, the drawing does not.
              · and on a coarse pointer the zone WAITS for the selection too
                (`grip-needs-select`). 15px of invisible trim at each end of
                every clip is what made picking a clip up on a tablet trim it
                instead. A mouse keeps hover-to-trim: 8px, and a cursor that
                says so.
          */}
          <div
            title="Trim in-point"
            className={cn(
              "group/edge absolute inset-y-0 cursor-trim-start touch-none transition-opacity",
              leftNeighborId ? "left-1.5" : "left-0",
              GRIP_REVEAL,
            )}
            style={{ width: EDGE_GRIP_WIDTH }}
            onPointerDown={(e) => startGesture(e, "trim-start")}
          >
            <div
              className={cn(
                "absolute inset-y-1 left-0.5 w-1 rounded-full transition-colors group-hover/edge:bg-primary",
                selected ? "bg-primary" : "bg-foreground/40",
              )}
            />
          </div>
          <div
            title="Trim out-point"
            className={cn(
              "group/edge absolute inset-y-0 cursor-trim-end touch-none transition-opacity",
              rightNeighborId ? "right-1.5" : "right-0",
              GRIP_REVEAL,
            )}
            style={{ width: EDGE_GRIP_WIDTH }}
            onPointerDown={(e) => startGesture(e, "trim-end")}
          >
            <div
              className={cn(
                "absolute inset-y-1 right-0.5 w-1 rounded-full transition-colors group-hover/edge:bg-primary",
                selected ? "bg-primary" : "bg-foreground/40",
              )}
            />
          </div>
          {/* Roll grip: on the RIGHT clip (renders on top), straddling the seam
              so it's reliably hittable — never a stray move underneath. */}
          {leftNeighborId && (
            <div
              title="Roll — trim both clips at the seam"
              onPointerDown={(e) => startRoll(e, leftNeighborId, clip.id, clip.startMs)}
              style={{ zIndex: 40, cursor: cursors.colResize, width: EDGE_GRIP_WIDTH }}
              className={cn(
                "group/roll absolute inset-y-1.5 left-0 -translate-x-1/2 touch-none transition-opacity",
                GRIP_REVEAL,
              )}
            >
              <div className="absolute inset-y-0 left-1/2 flex -translate-x-1/2 flex-col justify-center gap-0.5">
                <span className="mx-auto h-full w-px bg-amber-300/70 transition-colors group-hover/roll:bg-amber-300" />
              </div>
            </div>
          )}
        </>
      )}
    </div>
    </ClipChromeProvider>
  );
});

/**
 * Where a source-backed clip's loop repeats — video, audio, nested/component
 * clips (and, once wired, animated images), gated by the SAME registry
 * (`clipPlaybackOf`) `PlaybackSection` uses, so it appears/disappears exactly
 * in step with the "Loop" dropdown. A play-once clip always has an exact
 * ending — no handle, nothing to drag. Distinct from the trim handles: it
 * doesn't resize the clip's own box, it marks how much of that box is ONE
 * pass before the source repeats (`loopLengthMs` on `clip.playback` — see
 * `loopSpanMs`/`loopCycleWallMs` in core, the shared brain every clip kind's
 * render path reads).
 */
function LoopCycleHandle({ clip, pxPerSec, doc }: { clip: Clip; pxPerSec: number; doc: MotionDocument }) {
  const store = useDocStore();
  const playback = clipPlaybackOf(clip);
  if (!playback || playback.loop === "none") return null;

  const natural = clipLoopNaturalSpanMs(doc, clip);
  const wallMs = Math.min(clip.durationMs, Math.max(20, loopCycleWallMs(playback, natural, clipSpeedCurve(clip))));

  const drag = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    capturePointer((e.currentTarget as HTMLElement), e.pointerId);
    const startX = e.clientX;
    const startMs = wallMs;
    const onMove = (ev: PointerEvent) => {
      const next = Math.max(20, Math.min(clip.durationMs, startMs + pxToTime(ev.clientX - startX, pxPerSec)));
      store.update(
        "Loop cycle length",
        (d) => {
          const loc = locateClip(d, clip.id);
          if (loc) setClipPlayback(loc.clip, { loopLengthMs: Math.round(next) });
        },
        { mergeKey: `loop-cycle-${clip.id}` },
      );
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const reset = (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    store.update("Reset loop cycle", (d) => {
      const loc = locateClip(d, clip.id);
      if (loc) setClipPlayback(loc.clip, { loopLengthMs: null });
    });
  };

  const Icon = playback.loop === "pingpong" ? ArrowLeftRight : Repeat;

  return (
    <div
      title={`One loop cycle ends here (${(wallMs / 1000).toFixed(2)}s) — drag to change, double-click to reset to natural length`}
      onPointerDown={drag}
      onDoubleClick={reset}
      onContextMenu={reset}
      style={{ left: timeToPx(wallMs, pxPerSec), zIndex: 35 }}
      className="group/loop absolute inset-y-0 -translate-x-1/2 cursor-ew-resize px-1"
    >
      <div className="mx-auto h-full w-px bg-teal-400/70 transition-colors group-hover/loop:bg-teal-400" />
      <Icon className="pointer-events-none absolute left-1/2 top-0.5 size-2.5 -translate-x-1/2 text-teal-400/80 transition-colors group-hover/loop:text-teal-400" />
    </div>
  );
}

// ── Keyframe lane ─────────────────────────────────────────────────────────────
// Keys sharing a time render as ONE diamond. Click to select (⇧ adds), drag the
// strip to marquee a range, and drag any selected diamond to move them all.
// Right-click → set easing / delete for the whole selection; double-click opens
// the inline time/value/easing editor. A group keyframe stays a group keyframe.

interface KeyStack {
  timeMs: number;
  keys: Array<{ key: Keyframe; property: string }>;
}

function stackKeys(clip: Clip): KeyStack[] {
  const byTime = new Map<number, KeyStack>();
  for (const track of clip.keyframes) {
    // The speed track has its own, better handles on the retime band — where
    // the value it holds is actually legible. One track, one row of handles.
    if (track.property === SPEED_PROPERTY) continue;
    for (const k of track.keys) {
      const slot = Math.round(k.timeMs);
      let stack = byTime.get(slot);
      if (!stack) {
        stack = { timeMs: k.timeMs, keys: [] };
        byTime.set(slot, stack);
      }
      stack.keys.push({ key: k, property: track.property });
    }
  }
  return [...byTime.values()].sort((a, b) => a.timeMs - b.timeMs);
}

function KeyframeLane({
  clip,
  pxPerSec,
  retimed,
}: {
  clip: Clip;
  pxPerSec: number;
  /** A retime band owns the clip's bottom edge — sit above it, not on it. */
  retimed?: boolean;
}) {
  const store = useDocStore();
  const lift = retimed ? RETIME_BAND_LIFT : 0;
  const [editing, setEditing] = React.useState<number | null>(null); // stack time slot
  const [marquee, setMarquee] = React.useState<{ x: number; w: number } | null>(null);
  const laneRef = React.useRef<HTMLDivElement>(null);
  // Keyframe selection is GLOBAL (session) so the timeline marquee and the
  // clipboard operate on the same set.
  const selectedIds = useSession((s) => s.selectedKeyframeIds);
  const selected = React.useMemo(() => new Set(selectedIds), [selectedIds]);
  const setSel = (next: Set<string>) => useSession.getState().setSelectedKeyframes([...next]);

  const stacks = stackKeys(clip);
  const stackSelected = (stack: KeyStack) => stack.keys.every((k) => selected.has(k.key.id));
  const selectedStackCount = stacks.filter(stackSelected).length;

  const applyEasing = (name: EasingPresetName, ids: string[]) =>
    store.update("Set easing", (d) => {
      const loc = locateClip(d, clip.id);
      if (loc) for (const id of ids) setKeyframeEasing(loc.clip.keyframes, id, { kind: "preset", name });
    });
  const deleteKeys = (ids: string[]) => {
    const local = clipLocalClamped(clip, useSession.getState().playheadMs);
    store.update("Delete keyframes", (d) => {
      const loc = locateClip(d, clip.id);
      if (loc) removeClipKeyframes(loc.clip, ids, local);
    });
    setSel(new Set());
  };

  const dragStack = (e: React.PointerEvent, stack: KeyStack) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    capturePointer((e.currentTarget as HTMLElement), e.pointerId);

    // Selection: ⇧ toggles this stack; a plain press on an unselected stack
    // selects just it. Dragging then moves EVERY selected key together.
    const wasSelected = stackSelected(stack);
    let sel = selected;
    if (e.shiftKey) {
      sel = new Set(selected);
      for (const k of stack.keys) (wasSelected ? sel.delete(k.key.id) : sel.add(k.key.id));
      setSel(sel);
    } else if (!wasSelected) {
      sel = new Set(stack.keys.map((k) => k.key.id));
      setSel(sel);
    }

    const startX = e.clientX;
    const origins = new Map<string, number>();
    for (const s of stacks) for (const k of s.keys) if (sel.has(k.key.id)) origins.set(k.key.id, k.key.timeMs);
    if (origins.size === 0) for (const k of stack.keys) origins.set(k.key.id, k.key.timeMs);

    const anchorTime = stack.timeMs;
    const mergeKey = `key-drag-${stack.keys[0]!.key.id}-${e.pointerId}`;
    const sessionAtStart = useSession.getState();
    const ownAbs = clip.startMs + anchorTime;
    const snapCandidates = collectSnapCandidates(
      store.getState(),
      clip.frameId,
      new Set(),
      sessionAtStart.playheadMs,
      sessionAtStart.snapSettings,
    ).filter((c) => Math.abs(c - ownAbs) > 0.5);
    let moved = false;

    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) < 3) return;
      moved = true;
      const sessionNow = useSession.getState();
      let dMs = pxToTime(ev.clientX - startX, pxPerSec);
      let snappedTo: number | null = null;
      if (sessionNow.snapping) {
        const threshold = pxToTime(sessionNow.snapSettings.thresholdPx, pxPerSec);
        const anchorAbs = clip.startMs + anchorTime + dMs;
        const snapped = snapTime(anchorAbs, snapCandidates, threshold);
        if (snapped !== anchorAbs) {
          snappedTo = snapped;
          dMs = snapped - (clip.startMs + anchorTime);
        }
      }
      store.update(
        "Move keyframes",
        (d) => {
          const loc = locateClip(d, clip.id);
          if (!loc) return;
          for (const [id, t0] of origins) {
            // merge:false — keys stacked transiently at a clamp edge must
            // survive the drag; coincidences collapse once on drop below.
            moveKeyframe(loc.clip.keyframes, id, Math.max(0, Math.min(clip.durationMs, t0 + dMs)), {
              merge: false,
            });
          }
        },
        { mergeKey },
      );
      sessionNow.setSnapIndicator(snappedTo);
    };
    const onUp = () => {
      useSession.getState().setSnapIndicator(null);
      if (moved) {
        store.update(
          "Move keyframes",
          (d) => {
            const loc = locateClip(d, clip.id);
            if (loc) mergeCoincidentKeyframes(loc.clip.keyframes, new Set(origins.keys()));
          },
          { mergeKey },
        );
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Rubber-band along the keyframe strip — select a run of keyframes by time.
  const startMarquee = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // One predicate, shared with every other marquee in the app: a finger and a
    // pen scroll, and an armed lasso owns the pointer outright.
    if (!rectSweepAllowed(e)) return;
    e.stopPropagation();
    const lane = laneRef.current;
    if (!lane) return;
    const rect = lane.getBoundingClientRect();
    capturePointer(lane, e.pointerId);
    const startX = e.clientX - rect.left;
    const base = e.shiftKey ? new Set(selected) : new Set<string>();
    if (!e.shiftKey) setSel(new Set());
    let dragged = false;
    const onMove = (ev: PointerEvent) => {
      const curX = ev.clientX - rect.left;
      if (!dragged && Math.abs(curX - startX) < 3) return;
      dragged = true;
      const x0 = Math.min(startX, curX);
      const x1 = Math.max(startX, curX);
      setMarquee({ x: x0, w: x1 - x0 });
      const hit = new Set(base);
      for (const s of stacks) {
        const px = timeToPx(s.timeMs, pxPerSec);
        if (px >= x0 && px <= x1) for (const k of s.keys) hit.add(k.key.id);
      }
      setSel(hit);
    };
    const onUp = () => {
      setMarquee(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const editingStack = editing !== null ? stacks.find((s) => Math.round(s.timeMs) === editing) : undefined;

  return (
    <>
      {/* Marquee strip behind the diamonds — empty-space drags select a range. */}
      <div
        ref={laneRef}
        className="absolute inset-x-2 z-0 h-3"
        style={{ bottom: lift }}
        onPointerDown={startMarquee}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {marquee && (
          <div
            className="pointer-events-none absolute inset-y-0 rounded-sm bg-primary/15 ring-1 ring-primary/50"
            style={{ left: marquee.x, width: marquee.w }}
          />
        )}
      </div>

      {stacks.map((stack) => {
        const multi = stack.keys.length > 1;
        // A capture snapshot reads as an upright rounded "frame", not a rotated
        // keyframe diamond — but it drags/selects/deletes through the exact same
        // machinery (it IS a keyframe on the `capture` track).
        const isCapture = stack.keys.every((k) => k.property === CAPTURE_PROPERTY);
        const isSel = stackSelected(stack);
        const targetIds = () => (isSel && selected.size ? [...selected] : stack.keys.map((k) => k.key.id));
        const title = `${stack.keys
          .map((k) => propertyDef(k.property)?.label ?? k.property)
          .join(" · ")} @ ${(stack.timeMs / 1000).toFixed(2)}s`;
        return (
          <ContextMenu key={Math.round(stack.timeMs)}>
            <ContextMenuTrigger asChild>
              <div
                title={title}
                className={cn(
                  "absolute z-10 -translate-x-1/2 cursor-ew-resize border shadow-[0_1px_3px_rgba(0,0,0,0.45)] transition-transform hover:scale-125",
                  isCapture ? "rounded-[2px]" : "rotate-45 rounded-[3px]",
                  multi ? "size-3" : "size-2.5",
                  isSel
                    ? "border-white/90 bg-white ring-2 ring-primary"
                    : editing === Math.round(stack.timeMs)
                      ? "border-background/70 bg-foreground"
                      : "border-background/70 bg-primary",
                )}
                style={{ left: timeToPx(stack.timeMs, pxPerSec), bottom: lift + 2 }}
                onPointerDown={(e) => dragStack(e, stack)}
                onContextMenu={() => {
                  if (!isSel) setSel(new Set(stack.keys.map((k) => k.key.id)));
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setEditing(Math.round(stack.timeMs));
                }}
              />
            </ContextMenuTrigger>
            <ContextMenuContent className="w-48">
              <ContextMenuSub>
                <ContextMenuSubTrigger>Set easing</ContextMenuSubTrigger>
                <ContextMenuSubContent>
<ScrollArea className="max-h-72">
                  {Object.entries(EASING_PRESET_LABELS).map(([name, label]) => (
                    <ContextMenuItem key={name} onClick={() => applyEasing(name as EasingPresetName, targetIds())}>
                      {label}
                    </ContextMenuItem>
                  ))}
                </ScrollArea>
        </ContextMenuSubContent>
              </ContextMenuSub>
              <ContextMenuItem onClick={() => setEditing(Math.round(stack.timeMs))}>Edit…</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => deleteKeys(targetIds())}
              >
                Delete {isSel && selectedStackCount > 1 ? `${selectedStackCount} keyframes` : "keyframe"}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
      {editingStack && (
        <KeyframeEditorPopover
          clip={clip}
          stack={editingStack}
          pxPerSec={pxPerSec}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function KeyframeEditorPopover({
  clip,
  stack,
  pxPerSec,
  onClose,
}: {
  clip: Clip;
  stack: KeyStack;
  pxPerSec: number;
  onClose: () => void;
}) {
  const store = useDocStore();
  const keyIds = stack.keys.map((k) => k.key.id);
  const first = stack.keys[0]!;

  const mutate = (label: string, fn: (tracks: Clip["keyframes"]) => void, mergeKey?: string) =>
    store.update(
      label,
      (d) => {
        const loc = locateClip(d, clip.id);
        if (loc) fn(loc.clip.keyframes);
      },
      mergeKey ? { mergeKey: `${mergeKey}-${keyIds[0]}` } : undefined,
    );

  return (
    <Popover open onOpenChange={(open) => !open && onClose()}>
      <PopoverAnchor asChild>
        <div
          className="pointer-events-none absolute bottom-0 size-px"
          style={{ left: timeToPx(stack.timeMs, pxPerSec) }}
        />
      </PopoverAnchor>
      <PopoverContent className="w-60 space-y-2 p-2.5" side="top" sideOffset={8}>
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold">
            {stack.keys.length === 1
              ? propertyDef(first.property)?.label ?? first.property
              : `${stack.keys.length} keyframes`}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Delete keyframes"
            className="size-5 text-muted-foreground hover:text-destructive"
            onClick={() => {
              const local = clipLocalClamped(clip, useSession.getState().playheadMs);
              store.update("Delete keyframe", (d) => {
                const loc = locateClip(d, clip.id);
                if (loc) removeClipKeyframes(loc.clip, keyIds, local);
              });
              onClose();
            }}
          >
            <Trash2 className="size-3" />
          </Button>
        </div>

        <PropLine label="Time">
          <NumberInput
            value={stack.timeMs / 1000}
            min={0}
            max={clip.durationMs / 1000}
            step={0.01}
            precision={2}
            unit="s"
            onChange={(v) =>
              mutate(
                "Move keyframes",
                (tracks) => {
                  for (const id of keyIds) moveKeyframe(tracks, id, v * 1000);
                },
                "key-time",
              )
            }
          />
        </PropLine>

        {stack.keys.map(({ key, property }) => {
          const def = propertyDef(property);
          if (typeof key.value !== "number") return null;
          return (
            <PropLine key={key.id} label={def?.label ?? property}>
              <NumberInput
                value={key.value}
                min={def?.min}
                max={def?.max}
                step={def?.step ?? 1}
                precision={2}
                onChange={(v) =>
                  mutate(
                    "Edit keyframe",
                    (tracks) => {
                      const f = findKeyframe(tracks, key.id);
                      if (f) f.key.value = v;
                    },
                    `key-value-${key.id}`,
                  )
                }
              />
            </PropLine>
          );
        })}

        <div>
          <span className="mb-1 block text-[10px] text-muted-foreground">
            Easing out of {stack.keys.length === 1 ? "this key" : "these keys"}
          </span>
          <EasingPicker
            value={first.key.easing}
            onChange={(easing) =>
              mutate("Keyframe easing", (tracks) => {
                for (const id of keyIds) setKeyframeEasing(tracks, id, easing);
              })
            }
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function PropLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[56px_1fr] items-center gap-1.5">
      <span className="truncate text-[10px] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/**
 * WHERE a clip's source repeats, and where it stops advancing.
 *
 * The flipbook sheet has always shown its row's repeats as ghosted cells, and
 * the answer for every other source-backed clip is the same idea drawn at
 * timeline scale: a hairline at each cycle boundary, and a shaded stretch
 * where a play-once clip has outrun its media and is holding one frame.
 *
 * It is deliberately INDEPENDENT of the poster strip. Posters show the
 * pictures and can be switched off for performance; this shows the STRUCTURE,
 * which is information the clip's own geometry does not carry and which a user
 * needs whether or not they are paying for thumbnails. When both are on they
 * agree by construction — the boundaries come from the same
 * `loopCycleWallMs`/natural-span pair the poster plan samples through, and the
 * same one `LoopCycleHandle` drags.
 *
 * The first boundary is skipped: that one is the draggable handle, and drawing
 * a second line under it would only make the handle look broken.
 */
function SourceCycleMarks({ clip, pxPerSec, doc }: { clip: Clip; pxPerSec: number; doc: MotionDocument }) {
  const playback = clipPlaybackOf(clip);
  if (!playback) return null;
  const natural = clipLoopNaturalSpanMs(doc, clip);
  if (natural <= 0) return null;
  const curve = clipSpeedCurve(clip);
  const wallMs = loopCycleWallMs(playback, natural, curve);
  if (!(wallMs > 20)) return null;

  // Play-once: there are no repeats, only a run-out. Everything past the
  // source's end is one frozen frame, and that is worth saying out loud.
  if (playback.loop === "none") {
    if (wallMs >= clip.durationMs - 1) return null;
    const left = timeToPx(wallMs, pxPerSec);
    return (
      <div
        className="pointer-events-none absolute inset-y-0 bg-black/25"
        style={{ left, width: Math.max(0, timeToPx(clip.durationMs, pxPerSec) - left) }}
        title={`Media ends at ${(wallMs / 1000).toFixed(2)}s — the rest holds this frame`}
      >
        <div className="absolute inset-y-0 left-0 w-px bg-amber-300/60" />
      </div>
    );
  }

  // Each boundary is where the SOURCE wraps — through the speed curve, so a
  // freeze or a ramp in any cycle moves the boundaries after it.
  const span = loopSpanMs(playback, natural, curve);
  const marks: number[] = [];
  for (let k = 2; marks.length < 64; k++) {
    const t = curve ? wallTimeForSourceMs(curve, k * span) : k * wallMs;
    if (t === null || t >= clip.durationMs - 1) break;
    marks.push(t);
  }
  if (marks.length === 0) return null;
  return (
    <>
      {marks.map((t) => (
        <div
          key={t}
          className="pointer-events-none absolute inset-y-0 w-px bg-teal-400/40"
          style={{ left: timeToPx(t, pxPerSec) }}
        />
      ))}
    </>
  );
}

/**
 * `fx` — this layer is being processed.
 *
 * A poster paints a clip's SOURCE and never its effect stack (the picture's
 * cache identity depends on it; see `preview/poster`), so the one thing the
 * clip still owes the user is that the stack exists. A count and the names on
 * hover is the whole job: enough to know something is applied and to
 * recognise it, never enough to pretend it is a preview.
 *
 * Disabled cards do not count — the badge answers "is this being processed
 * right now", and `clipEffectSummary` is the one place that decides so the
 * badge and its tooltip cannot disagree.
 */
function EffectBadge({ clip }: { clip: Clip }) {
  // An adjustment layer's whole purpose is its stack, and its subtitle already
  // prints the count — a badge would say it twice.
  if (clip.kind === "adjustment" || !("effects" in clip)) return null;
  const summary = clipEffectSummary(clip.effects);
  if (summary.count === 0) return null;
  return (
    <span
      title={`${summary.count} effect${summary.count > 1 ? "s" : ""}: ${summary.labels.join(", ")}`}
      className="ml-auto shrink-0 rounded-[3px] bg-[#A78BFA]/20 px-1 font-mono text-[8px] font-semibold uppercase leading-[13px] tracking-wide text-[#C4B5FD]"
    >
      fx{summary.count > 1 ? ` ${summary.count}` : ""}
    </span>
  );
}

/**
 * The PAINTED half of a clip's contents: waveforms and schematic bars. Purely
 * pictorial — anything you can grab lives in the chrome layer instead (see
 * `clip-chrome.tsx`), which is why the cue ticks and the animation chips that
 * used to live here have moved out.
 */
function ClipDecorations({ clip, pxPerSec, audioNested }: { clip: Clip; pxPerSec: number; audioNested?: boolean }) {
  // Schematic audio bars — used by synth-pack audio AND audio-only nested comps
  // (which have no single asset to draw a real waveform from).
  const schematicBars = (
    <div
      className="absolute inset-0 opacity-25"
      style={{
        backgroundImage:
          "repeating-linear-gradient(90deg, var(--clip-audio-border) 0 2px, transparent 2px 7px)",
        maskImage: "linear-gradient(180deg, transparent 15%, black 50%, transparent 85%)",
      }}
    />
  );
  if (audioNested && clip.kind === "nested") return <NestedWaveformStrip clip={clip} />;
  if (clip.kind === "audio") {
    // Imported audio draws its REAL waveform (shared decode + painter);
    // synth-pack clips keep the schematic bars.
    if (clip.source.type === "asset") {
      return <WaveformStrip clip={clip} assetId={clip.source.assetId} />;
    }
    return schematicBars;
  }

  return null;
}

/**
 * Every decoration living ON this clip — whole-LAYER in/out animations and, for
 * text, the per-GLYPH ones — drawn by the SAME chip a transition
 * uses. `clipEdgeDecors` is the one place that knows what a clip carries, so
 * adding a third grain later is a core change, not a timeline change.
 */
function ClipEdgeChips({ clip, pxPerSec }: { clip: Clip; pxPerSec: number }) {
  const store = useDocStore();
  const fps = useDocSelector((d) => compFps(d, clip.frameId));
  const selectedClipIds = useSession((s) => s.selectedClipIds);
  const decors = clipEdgeDecors(clip);
  if (!decors.length) return null;
  const isText = clip.kind === "text";
  // Clip-local px: the chips live inside the clip's own box.
  const clipWidth = timeToPx(clip.durationMs, pxPerSec);

  return (
    <>
      {decors.map((decor) => {
        const width = Math.max(10, Math.min(clipWidth, timeToPx(decor.durationMs, pxPerSec)));
        // Both grains on one edge share the band, stacked — glyph animation on
        // top (it is the inner, finer one), whole-layer beneath it.
        const sameSide = decors.filter((d) => d.side === decor.side);
        // The handle is always at the span's INNER boundary — the only edge that
        // can move, since the outer one is the clip's own start or end.
        const handle = decor.side === "in" ? "end" : "start";
        return (
          <EdgeChip
            key={edgeRefKey(decor.ref)}
            decor={decor}
            left={decor.side === "in" ? 0 : Math.max(0, clipWidth - width)}
            width={width}
            fps={fps}
            row={{ index: sameSide.indexOf(decor), count: sameSide.length }}
            handles={[handle]}
            onResize={(_edge, deltaMs) =>
              store.update(
                "Animation duration",
                (d) => {
                  setEdgeDecorDuration(d, decor.ref, decor.durationMs + (handle === "end" ? deltaMs : -deltaMs));
                },
                { mergeKey: `edge-dur-${edgeRefKey(decor.ref)}` },
              )
            }
            presets={presetsFor(decor.kind, isText)}
            onRetarget={(presetId) =>
              store.update("Change animation", (d) => {
                retargetEdgeDecor(d, decor.ref, presetId);
              })
            }
            onSetDuration={(ms) =>
              store.update("Animation duration", (d) => {
                setEdgeDecorDuration(d, decor.ref, ms);
              })
            }
            store={store}
            pasteTargets={selectedClipIds.length ? selectedClipIds : [clip.id]}
          />
        );
      })}
    </>
  );
}

/**
 * THE LAYER BAR — this layer's own kept pixels, and nothing else's.
 *
 * It used to be derived from the COMPOSITE cache: green wherever the whole
 * frame was cached and the clip was on screen. So every clip's bar was really
 * the comp's bar, and editing any one layer erased all of them at once — the
 * exact opposite of what a stack of caches is for. Now each bar is its layer's
 * own entry in the layer cache (`layer:<clip>`, clip-local time): edit the top
 * layer and only its bar goes dark; the ones beneath keep theirs, because their
 * pixels really are still there.
 *
 * A cheap layer shows nothing, honestly — it is not kept per instant, because
 * rendering it costs less than keeping it. A steady layer shows one unbroken
 * run: one buffer covers the stretch.
 */
function RenderBar({ clip, pxPerSec }: { clip: VisualClip; pxPerSec: number }) {
  const version = useCacheStatusVersion();
  const enabled = useCachingEnabled();
  // A nested bar maps through its comp's length; nothing else in the document moves it.
  const doc = useDocWhen((d) => [d.frames]);
  const ref = React.useRef<HTMLCanvasElement | null>(null);

  React.useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const width = Math.max(1, Math.round((clip.durationMs / 1000) * pxPerSec));
    const { scaleX } = fitCanvasBacking(canvas, width, 2);
    ctx.setTransform(scaleX, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, 2);
    if (!enabled) return;
    ctx.fillStyle = "rgba(64,187,110,0.95)";
    // A NESTED CLIP SHOWS ITS COMP'S PICTURES — kept once, in the comp-picture
    // store, whichever depth made them — through its own time map (trim,
    // speed, loop, reverse), sampled per pixel.
    if (clip.kind === "nested") {
      const subject = compSubject(clip.sourceFrameId);
      if (hasAnyCoverage(subject)) {
        let runFrom = -1;
        for (let x = 0; x <= width; x++) {
          const on = x < width && hasFrame(subject, clipSourceMs(doc, clip, ((x + 0.5) / pxPerSec) * 1000));
          if (on && runFrom < 0) runFrom = x;
          else if (!on && runFrom >= 0) {
            ctx.fillRect(runFrom, 0, x - runFrom, 2);
            runFrom = -1;
          }
        }
      }
    }
    // Its own kept pixels — see `layerCoverageSpans`.
    for (const [a, b] of layerCoverageSpans(clip.id)) {
      const x0 = (a / 1000) * pxPerSec;
      const x1 = (b / 1000) * pxPerSec;
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), 2);
    }
  }, [clip, doc, enabled, pxPerSec, version]);

  return (
    <canvas
      ref={ref}
      className="pointer-events-none absolute inset-x-0 top-0 z-10"
      style={{ height: 2, width: "100%" }}
      aria-hidden
    />
  );
}

/**
 * WHAT THIS LAYER COSTS, on the layer — including a GROUP, which is the whole
 * reason this exists.
 *
 * A flat list of leaf costs is exactly where an expensive group hides: you can
 * read every row and still not see that the four cheap layers inside one
 * container are being composited through a glass material and a goo pass. The
 * renderer brackets a group around its children, so a group's number IS its
 * subtree's — which is the number a person needs to decide what to pre-compose,
 * cache or turn off.
 *
 * SHOWN ONLY WHEN IT IS INFORMATION. A badge on every clip is chrome nobody
 * reads; a badge that appears exactly on the layers eating a visible share of
 * the frame is a finding. The threshold is a share of the comp's own frame
 * budget rather than a fixed millisecond count, because 8ms is most of a frame
 * at 60fps and a third of one at 24.
 */
const COST_SHARE = 0.2;

function ClipCost({ clip }: { clip: VisualClip }) {
  const fps = useDocSelector((d) => compFps(d, clip.frameId));
  const cost = useLayerCost(clip.id);
  if (!cost) return null;
  const budget = budgetFor(fps);
  if (cost.totalMs < budget * COST_SHARE) return null;
  const heavy = cost.totalMs >= budget;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "pointer-events-auto absolute right-1 top-1 z-20 rounded px-1 font-mono text-2xs tabular-nums",
            heavy ? "bg-destructive/20 text-destructive" : "bg-warning/20 text-warning",
          )}
        >
          {cost.totalMs >= 10 ? Math.round(cost.totalMs) : cost.totalMs.toFixed(1)}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        {`${cost.totalMs.toFixed(1)} ms a frame at the current preview resolution`}
        {clip.kind === "group" ? ", this group and everything in it" : ""}
        {cost.lastSource === "cached" ? " — currently served from the layer cache" : ""}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Per-clip MEDIA cache status: a hairline along the clip's top edge — green
 * where the frame is decoded and ready, red where a seek still stands in the
 * way. Follows the clip's own cache policy (always/never beat the timeline
 * switch), and disappears entirely when caching isn't in effect.
 */
function ClipCacheStrip({ clip, pxPerSec }: { clip: VideoClip | NestedClip; pxPerSec: number }) {
  // A video reads its asset; a nested comp reads everything inside it.
  const doc = useDocWhen((d) => (clip.kind === "video" ? [d.assets, d.frames] : [d.tracks, d.frames, d.assets]));
  const cachingOn = useCachingEnabled();
  const version = useCacheStatusVersion();
  const ref = React.useRef<HTMLCanvasElement | null>(null);
  // Only what is on screen, the same window the clip's pictures use.
  const stripWindow = useStripWindow(clip.startMs, clip.durationMs, pxPerSec);
  // A nested comp with no footage anywhere inside has no media cache to show —
  // and asking costs a recursive walk per sample. Core memoises the answer.
  const visible =
    clip.kind === "video"
      ? mediaCachingAllowed(clip.id)
      : clip.cachePolicy !== "never" && (cachingOn || clip.cachePolicy === "always") && layerShowsFootage(doc, clip);

  React.useEffect(() => {
    if (!visible || !stripWindow) return;
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const fromPx = stripWindow.fromPx;
    const width = Math.max(1, Math.round(stripWindow.toPx - fromPx));
    const { scaleX } = fitCanvasBacking(canvas, width, 2);
    ctx.setTransform(scaleX, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, 2);
    // SOLID RUNS, the same as every other cache bar in the app. This one drew
    // dots while the composite bar beside it drew a line, which read as two
    // different kinds of readiness rather than one convention sampled twice.
    const colourAt =
      clip.kind === "video"
        ? (() => {
            const assetDurationMs = doc.assets.find((a) => a.id === clip.assetId)?.durationMs ?? null;
            return (x: number): string => {
              let src = clipSourceMs(doc, clip, (x / pxPerSec) * 1000);
              if (assetDurationMs !== null) src = Math.min(src, Math.max(0, assetDurationMs - 34));
              return hasFrame(mediaSubject(clip.id), src) ? "rgba(64,187,110,0.95)" : "rgba(229,72,77,0.55)";
            };
          })()
        : (() => {
            // Nested: the SAME nested-aware question the parent bar asks, at
            // this clip's inner time — parent and child views always agree.
            const source = doc.frames.find((f) => f.id === clip.sourceFrameId);
            return (x: number): string | null => {
              if (!source) return null;
              const status = videoCacheStatusAt(doc, source, clipSourceMs(doc, clip, (x / pxPerSec) * 1000));
              if (!status) return null;
              return status === "green" ? "rgba(64,187,110,0.95)" : "rgba(229,72,77,0.55)";
            };
          })();

    // ONE SAMPLE PER FRAME, never per pixel: readiness cannot change between
    // two instants the comp never shows, and a zoomed-in 35 s clip is tens of
    // thousands of pixels.
    const pitchPx = Math.max(1, (frameStepMs(compFps(doc, clip.frameId)) * pxPerSec) / 1000);
    let runFrom = -1;
    let runColour: string | null = null;
    const flush = (to: number) => {
      if (runFrom >= 0 && runColour) {
        ctx.fillStyle = runColour;
        ctx.fillRect(runFrom, 0, Math.max(1, to - runFrom), 2);
      }
      runFrom = -1;
      runColour = null;
    };
    const first = Math.floor(fromPx / pitchPx) * pitchPx;
    for (let x = first; x < fromPx + width; x += pitchPx) {
      const c = colourAt(Math.max(0, x));
      const at = Math.max(0, x - fromPx);
      if (c !== runColour) {
        flush(at);
        if (c) {
          runFrom = at;
          runColour = c;
        }
      }
    }
    flush(width);
  }, [clip, doc, pxPerSec, version, visible, cachingOn, stripWindow]);

  if (!visible || !stripWindow) return null;
  return (
    <canvas
      ref={ref}
      className="pointer-events-none absolute top-[2px] z-10"
      style={{ height: 2, left: stripWindow.fromPx, width: stripWindow.toPx - stripWindow.fromPx }}
      aria-hidden
    />
  );
}

/**
 * Real waveform for an imported-audio clip — mapped through the clip's playback
 * so trim-in, speed, loop/ping-pong and reverse all show truthfully, and scaled
 * by the volume envelope so louder sections stand taller and fades taper. Reads
 * through the SAME `windowPeaks` foundation the waveform-visualizer plugin
 * renders (via `clipStripPeaks`), so the strip and the visualizer stay in sync;
 * the shape is memoized per clip-sound state, so repaints are cheap.
 */
function WaveformStrip({ clip, assetId }: { clip: AudioClip; assetId: string }) {
  const ref = React.useRef<HTMLCanvasElement | null>(null);
  const clipRef = React.useRef(clip);
  clipRef.current = clip;

  React.useEffect(() => {
    const paint = () => {
      const canvas = ref.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      const c = clipRef.current;
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 1) return;
      const dpr = window.devicePixelRatio || 1;
      // Draw in the SAME dpr-scaled logical units handed to fitCanvasBacking —
      // otherwise the wave fills only 1/dpr of the backing store (the exact-half
      // "ends at the middle" bug on Retina). bins stay in CSS px (bar count).
      const w = rect.width * dpr;
      const h = rect.height * dpr;
      const { scaleX, scaleY } = fitCanvasBacking(canvas, w, h);
      ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const buffer = getAudioBufferForAsset(assetId);
      if (!buffer) return; // repaints on decode
      const bins = Math.max(12, Math.floor(rect.width / 2));
      const color = getComputedStyle(canvas).getPropertyValue("--clip-audio-border").trim() || "#6FA97A";
      // ONE foundation: the strip reads through `clipStripPeaks`, now built on the
      // SAME `windowPeaks` the visualizer plugin renders — so speed / trim /
      // loop / reverse show truthfully, the wave fills edge-to-edge, and the two
      // surfaces can never drift. The shape is memoized per clip-sound state, so
      // this repaints cheaply. Envelope scales each column (fades taper).
      const peaks = clipStripPeaks(assetId, buffer, bins, c.trimInMs, c.durationMs, c.playback, (localMs) =>
        audioGainAt(c, localMs),
      );
      ctx.globalAlpha = 0.65;
      drawWaveform(ctx, peaks, { x: 0, y: dpr, w, h: h - 2 * dpr }, color);
    };
    // No dep array: repaints each render. ClipView is memoized on `clip`, so a
    // trim / gain / fade / keyframe / zoom / speed change re-renders and repaints
    // here; the memoized shape keeps it cheap.
    paint();
    return onAudioBufferReady(paint);
  });

  return <canvas ref={ref} className="pointer-events-none absolute inset-0 h-full w-full" />;
}

/**
 * A REAL summed waveform for an audio-only nested clip — the same painter, fed by
 * `nestedClipPeaks` (which reuses the export inventory to gather every voice
 * inside the comp). Repaints on decode; no placeholder bars.
 */
function NestedWaveformStrip({ clip }: { clip: NestedClip }) {
  const doc = useDocWhen((d) => [d.tracks, d.assets]);
  const ref = React.useRef<HTMLCanvasElement | null>(null);
  const clipRef = React.useRef(clip);
  clipRef.current = clip;
  React.useEffect(() => {
    const paint = () => {
      const canvas = ref.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 1) return;
      const dpr = window.devicePixelRatio || 1;
      // Draw in the SAME dpr-scaled units handed to fitCanvasBacking (see WaveformStrip).
      const w = rect.width * dpr;
      const h = rect.height * dpr;
      const { scaleX, scaleY } = fitCanvasBacking(canvas, w, h);
      ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const bins = Math.max(12, Math.floor(rect.width / 2));
      const peaks = nestedClipPeaks(doc, clipRef.current, bins);
      const color = getComputedStyle(canvas).getPropertyValue("--clip-audio-border").trim() || "#6FA97A";
      ctx.globalAlpha = 0.65;
      drawWaveform(ctx, peaks, { x: 0, y: dpr, w, h: h - 2 * dpr }, color);
    };
    paint();
    return onAudioBufferReady(paint);
  });
  return <canvas ref={ref} className="pointer-events-none absolute inset-0 h-full w-full" />;
}

// ── Audio volume envelope ─────────────────────────────────────────────────────
// The DaVinci volume line: a curve over the clip (keyframes × fades) with
// draggable gain points and fade-in/out handles. The SVG root is
// pointer-events:none, so only the line/points/handles catch events — empty
// space falls through to the clip's own move gesture. Vertical position is dB.

const ENV_TOP_DB = 12;
const ENV_BOTTOM_DB = -48;
const ENV_RANGE = ENV_TOP_DB - ENV_BOTTOM_DB;
const ENV_MAX_GAIN = dbToGain(ENV_TOP_DB);

/** Linear gain → 0..1 fraction from the top of the clip. */
function gainToFrac(gain: number): number {
  if (gain <= 0) return 1;
  const db = Math.max(ENV_BOTTOM_DB, Math.min(ENV_TOP_DB, gainToDb(gain)));
  return (ENV_TOP_DB - db) / ENV_RANGE;
}

/** 0..1 fraction from the top → linear gain (clamped to the boost ceiling). */
function fracToGain(frac: number): number {
  const db = ENV_TOP_DB - Math.max(0, Math.min(1, frac)) * ENV_RANGE;
  return Math.max(0, Math.min(ENV_MAX_GAIN, dbToGain(db)));
}

/** Measure an element's live pixel size (envelope maths need real px, not %). */
function useMeasure<T extends HTMLElement>(): [React.RefCallback<T>, { w: number; h: number }] {
  const [size, setSize] = React.useState({ w: 0, h: 0 });
  const obs = React.useRef<ResizeObserver | null>(null);
  const ref = React.useCallback((el: T | null) => {
    obs.current?.disconnect();
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize((s) => (s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height }));
    });
    ro.observe(el);
    obs.current = ro;
  }, []);
  return [ref, size];
}

function AudioEnvelope({ clip, pxPerSec }: { clip: AudioClip; pxPerSec: number }) {
  const store = useDocStore();
  const chrome = useClipChrome();
  const [ref, { w, h }] = useMeasure<HTMLDivElement>();
  const width = Math.max(timeToPx(clip.durationMs, pxPerSec), 8);

  const gainTrack = clip.keyframes.find((t) => !t.range && t.property === "gain");
  const keys = React.useMemo(
    () => (gainTrack ? [...gainTrack.keys].sort((a, b) => a.timeMs - b.timeMs) : []),
    [gainTrack],
  );

  // Sampled curve across the clip (fades included) — pure visual.
  const curve = React.useMemo(() => {
    if (w <= 0 || h <= 0) return "";
    const step = Math.max(2, Math.floor(w / 48));
    let d = "";
    for (let x = 0; x <= w; x += step) {
      const localMs = (x / w) * clip.durationMs;
      const y = gainToFrac(audioGainAt(clip, localMs)) * h;
      d += `${d ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    }
    return d;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip, w, h, pxPerSec]);

  const yToGain = (clientY: number, rectTop: number) => fracToGain((clientY - rectTop) / (h || 1));

  /**
   * The clip's box, read once per gesture. Every envelope drag maps the pointer
   * against it and runs through `beginScrubDrag` — the one lifecycle that also
   * ends on `pointercancel`, a lost pointer and a second finger. The trio these
   * used to write by hand tore down on `pointerup` alone, which on touch leaks
   * the move listener for the rest of the session (docs/responsive-and-gestures).
   */
  const clipRectOf = (e: React.PointerEvent) =>
    (e.currentTarget as SVGElement).closest("[data-clip-drop-id]")!.getBoundingClientRect();

  // Drag a single gain keyframe in 2D (time + value).
  const dragPoint = (e: React.PointerEvent, keyId: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const clipRect = clipRectOf(e);
    const mergeKey = `audio-gain-pt-${keyId}-${e.pointerId}`;
    beginScrubDrag(e, (clientX, clientY) => {
      const tMs = Math.max(0, Math.min(clip.durationMs, pxToTime(clientX - clipRect.left, pxPerSec)));
      const value = fracToGain((clientY - clipRect.top) / (clipRect.height || 1));
      store.update(
        "Adjust volume",
        (d) => {
          const loc = locateClip(d, clip.id);
          const track = loc?.clip.keyframes.find((t) => !t.range && t.property === "gain");
          const k = track?.keys.find((kk) => kk.id === keyId);
          if (!track || !k) return;
          k.timeMs = tMs;
          k.value = value;
          track.keys.sort((a, b) => a.timeMs - b.timeMs);
        },
        { mergeKey },
      );
    });
  };

  // Add a gain keyframe at a click position (right-click "anywhere" on the line).
  const addKeyAt = (clientX: number, clientY: number, el: HTMLElement) => {
    const rect = el.closest("[data-clip-drop-id]")!.getBoundingClientRect();
    const localMs = Math.max(0, Math.min(clip.durationMs, pxToTime(clientX - rect.left, pxPerSec)));
    const gain = fracToGain((clientY - rect.top) / (rect.height || 1));
    store.update("Add volume keyframe", (d) => {
      const loc = locateClip(d, clip.id);
      if (loc) setKeyframe(loc.clip.keyframes, "gain", localMs, gain);
    });
  };

  // Drag the flat line (no keys) up/down → base gain.
  const dragBase = (e: React.PointerEvent) => {
    if (e.button !== 0 || keys.length > 0) return;
    e.stopPropagation();
    const rectTop = clipRectOf(e).top;
    const mergeKey = `audio-gain-base-${clip.id}-${e.pointerId}`;
    beginScrubDrag(e, (_clientX, clientY) => {
      const gain = yToGain(clientY, rectTop);
      store.update(
        "Adjust volume",
        (d) => {
          const loc = locateClip(d, clip.id);
          if (loc?.clip.kind === "audio") loc.clip.gain = gain;
        },
        { mergeKey },
      );
    });
  };

  // Drag a fade handle horizontally to set its duration.
  const dragFade = (e: React.PointerEvent, side: "in" | "out") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const rectLeft = clipRectOf(e).left;
    const mergeKey = `audio-fade-${side}-${clip.id}-${e.pointerId}`;
    beginScrubDrag(e, (clientX) => {
      const xMs = pxToTime(clientX - rectLeft, pxPerSec);
      const dur =
        side === "in"
          ? Math.max(0, Math.min(clip.durationMs, xMs))
          : Math.max(0, Math.min(clip.durationMs, clip.durationMs - xMs));
      store.update(
        side === "in" ? "Fade in" : "Fade out",
        (d) => {
          const loc = locateClip(d, clip.id);
          if (loc?.clip.kind === "audio") {
            if (side === "in") loc.clip.fadeIn.durationMs = dur;
            else loc.clip.fadeOut.durationMs = dur;
          }
        },
        { mergeKey },
      );
    });
  };

  const removeKey = (keyId: string) => {
    const local = clipLocalClamped(clip, useSession.getState().playheadMs);
    store.update("Delete volume keyframe", (d) => {
      const loc = locateClip(d, clip.id);
      if (loc) removeClipKeyframes(loc.clip, [keyId], local);
    });
  };

  const fadeInX = timeToPx(clip.fadeIn.durationMs, pxPerSec);
  const fadeOutX = width - timeToPx(clip.fadeOut.durationMs, pxPerSec);
  // A narrow clip keeps its line and loses its knobs — they would sit on the
  // trim grips and on each other. Zoom in to reach them. The answer comes from
  // the clip's own chrome contract, not from a second reading of the width.
  const handles = h > 0 && chrome.handles;

  return (
    <div ref={ref} className="pointer-events-none absolute inset-0 z-20">
      <svg
        width={width}
        height={h}
        className="pointer-events-none absolute inset-0 overflow-visible"
      >
        {/* Fill under the curve. */}
        {curve && h > 0 && (
          <path
            d={`${curve}L${width},${h}L0,${h}Z`}
            style={{ fill: "var(--clip-audio-border)", fillOpacity: 0.12 }}
          />
        )}
        {/* Visible line. */}
        {curve && (
          <path d={curve} style={{ stroke: "var(--clip-audio-border)" }} strokeWidth={1.5} fill="none" />
        )}
        {/* Fat transparent hit line: left-drag adjusts level, right-click adds a key. */}
        {curve && (
          <path
            d={curve}
            stroke="transparent"
            strokeWidth={12}
            fill="none"
            style={{ pointerEvents: "stroke", cursor: keys.length ? cursors.arrow : resizeCursor(90) }}
            onPointerDown={dragBase}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              addKeyAt(e.clientX, e.clientY, e.currentTarget as unknown as HTMLElement);
            }}
          />
        )}

        {/* Fade handles (top corners). */}
        {handles && (
          <>
            <circle
              cx={Math.max(0, Math.min(width, fadeInX))}
              cy={3}
              r={4}
              className="fill-amber-300 stroke-background"
              strokeWidth={1}
              style={{ pointerEvents: "auto", cursor: resizeCursor(0) }}
              onPointerDown={(e) => dragFade(e, "in")}
            >
              <title>Fade in — drag to set length</title>
            </circle>
            <circle
              cx={Math.max(0, Math.min(width, fadeOutX))}
              cy={3}
              r={4}
              className="fill-amber-300 stroke-background"
              strokeWidth={1}
              style={{ pointerEvents: "auto", cursor: resizeCursor(0) }}
              onPointerDown={(e) => dragFade(e, "out")}
            >
              <title>Fade out — drag to set length</title>
            </circle>
          </>
        )}

        {/* Gain keyframe points. */}
        {handles &&
          keys.map((k) => {
            const g = typeof k.value === "number" ? k.value : clip.gain;
            return (
              <circle
                key={k.id}
                cx={timeToPx(k.timeMs, pxPerSec)}
                cy={gainToFrac(g) * h}
                r={4}
                style={{ fill: "#fff", stroke: "var(--clip-audio-border)", pointerEvents: "auto", cursor: cursors.grab }}
                strokeWidth={1.5}
                onPointerDown={(e) => dragPoint(e, k.id)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  removeKey(k.id);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  removeKey(k.id);
                }}
              >
                <title>{`${dbLabelShort(g)} dB @ ${(k.timeMs / 1000).toFixed(2)}s — drag to adjust, dbl-click to delete`}</title>
              </circle>
            );
          })}
      </svg>
    </div>
  );
}

function dbLabelShort(gain: number): string {
  if (gain <= 0) return "−∞";
  const db = gainToDb(gain);
  return `${db > 0 ? "+" : ""}${db.toFixed(1)}`;
}

/**
 * The "this voice is being processed / is cached" badge on a heavy audio clip
 * (reverse / pitch). Spins while the offline bake runs, then shows a static
 * ⚡ once the processed buffer is cached — the headless equivalent of the video
 * cache bars, so heavy audio DSP is visibly "rendered once, then instant."
 */
function HeavyAudioBadge({ clip }: { clip: AudioClip }) {
  useBakeVersion(); // repaint when a bake finishes
  // Proactively bake visible heavy clips so the DSP is ready before playback
  // (and the badge resolves) even if the clip is never scrubbed to.
  const sig = clipAudioSignature(clip);
  React.useEffect(() => void ensureClipBake(clip), [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = hasClipBake(clip);
  return ready ? (
    <Zap className="size-3 shrink-0 text-primary/80" aria-label="Processed (cached)" />
  ) : (
    <Loader2 className="size-3 shrink-0 animate-spin text-foreground/50" aria-label="Processing…" />
  );
}

/**
 * What the footage's trackers know, along the bar — one thin strip per tracker
 * (up to three), from the same `CoverageStrip` the Track tab draws: solved in
 * the tracker's colour, shaky in amber, fixed frames as ticks, and a moving
 * head while one is tracking. Read through THIS clip's time map, so a split or
 * retimed half shows its own frames.
 */
function ClipTrackStrips({ clip, widthPx }: { clip: Clip & { assetId: string }; widthPx: number }) {
  const doc = useDocWhen((d) => [d.trackers, d.assets, d.frames]);
  const trackers = doc.trackers.filter((t) => t.source.assetId === clip.assetId).slice(0, 3);
  if (!trackers.length || widthPx < 24) return null;
  const cells = Math.max(8, Math.min(512, Math.round(widthPx / 3)));
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-1 bottom-0.5 flex flex-col gap-px">
      {trackers.map((t) => (
        <CoverageStrip key={t.id} doc={doc} tracker={t} clip={clip} cells={cells} className="h-[2px] text-foreground" />
      ))}
    </div>
  );
}
