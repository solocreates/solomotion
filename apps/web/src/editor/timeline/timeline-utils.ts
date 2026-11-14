"use client";

import type { Clip, FrameGroupRow, FrameLaneRow, GroupClip, TimelineMarker, Track, MotionDocument } from "@solomotion/core";
import { useSession, type PendingNewLane } from "../state/session";
import { laneZoomNow } from "./use-time-axes";
import { clipLocalTimeAtSource, clipSourceTimeAt, compDurationMs, frameContentDurationMs, frameDurationMs, frameRows, locateClip } from "@solomotion/core";

export const RULER_HEIGHT = 28;

/** Default lane height; tracks can override via `heightPx` (drag-resizable). */
export const DEFAULT_LANE_HEIGHT = 56;

/** Range for the vertical (track-height) zoom multiplier — kept in sync with
 *  the literal clamp in `session.ts`'s `setLaneZoom`. */
// The row axis's bounds live with the axis (`time-axes.ts`), beside the
// horizontal ones; re-exported here so the ~20 existing call sites are unmoved.
export { LANE_ZOOM_MIN as MIN_LANE_ZOOM, LANE_ZOOM_MAX as MAX_LANE_ZOOM } from "./time-axes";

// "Which comp is the timeline showing" moved to `time-axes.ts` for the same
// reason the bounds did: it is PURE, and the navigation slice needs it to name
// the surface whose zoom it is remembering. Importing it the other way round
// would put the store at the end of a cycle through itself. Re-exported so the
// existing call sites are unmoved.
import { activeCompId, timelineHostOf } from "./time-axes";
export { activeCompId, timelineHostOf };

/**
 * A track never renders shorter than this, no matter how far zoomed out —
 * a floor on the RENDERED height only, not on `heightPx` itself. A track
 * someone had already dragged down small (schema floor is 24) would
 * otherwise shrink past legibility once `laneZoom` multiplies it too. Zoom
 * back up (laneZoom → 1) and the track returns to exactly the height it was
 * manually set to; nothing here ever touches `heightPx`.
 */
export const MIN_RENDERED_LANE_HEIGHT = 24;

/**
 * How deep into the bottom band a drag must jam — once edge auto-scroll has
 * pinned the lanes at max scroll — to arm the "new track below" slot. The lanes
 * sit flush against the window, so this is reached from INSIDE the viewport, not
 * past its edge. Kept smaller than the auto-scroll hot zone so revealing real
 * tracks (scroll) always happens before spawning a new one (arm).
 */
export const NEW_LANE_ARM_PX = 28;

/** A track's own `heightPx` (or the default) scaled by the shared vertical
 *  zoom — relative per-track sizing survives zooming in/out together. */
/** A lane's drawn height. A view passes the zoom it subscribed to (`useLaneZoom`). */
export function laneHeight(track: Track, zoom: number = laneZoomNow()): number {
  const base = track.heightPx ?? DEFAULT_LANE_HEIGHT;
  return Math.max(MIN_RENDERED_LANE_HEIGHT, base * zoom);
}

export function timeToPx(ms: number, pxPerSec: number): number {
  return (ms / 1000) * pxPerSec;
}

export function pxToTime(px: number, pxPerSec: number): number {
  return (px / pxPerSec) * 1000;
}

/**
 * Browsers cap a canvas's backing-store dimensions (commonly ~16384px, lower
 * on some mobile/WebKit builds) even though CSS can stretch the element far
 * past that — a per-clip strip (waveform, cache status) zoomed in enough
 * blows past it and setTransform/fillRect throw InvalidStateError. Clamp the
 * backing store here and hand back the scale the caller needs so it can keep
 * drawing in its own logical pixel units; the browser then stretches the
 * (lower-res) result back up to the full CSS size instead of crashing —
 * imperceptible in practice since nothing on screen resolves more detail than
 * the viewport's own pixel width anyway.
 */
export const MAX_CANVAS_DIM = 16384;

export function fitCanvasBacking(
  canvas: HTMLCanvasElement,
  logicalWidth: number,
  logicalHeight: number,
): { scaleX: number; scaleY: number } {
  const safeW = Math.max(1, logicalWidth);
  const safeH = Math.max(1, logicalHeight);
  const w = Math.min(MAX_CANVAS_DIM, Math.max(1, Math.round(safeW)));
  const h = Math.min(MAX_CANVAS_DIM, Math.max(1, Math.round(safeH)));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  return { scaleX: w / safeW, scaleY: h / safeH };
}



/**
 * Navigate the timeline to the comp that HOLDS a clip — the headless "open the
 * right tab" primitive. If the clip already lives in the open comp it's a no-op;
 * otherwise it drills through the nesting tree (deduping tabs). Both smart-focus
 * (auto, on selection) and the Layers panel (clicking a nested child) call this,
 * so a clip anywhere in the nesting tree can be revealed with one call. Returns
 * false only when the clip can't be located.
 */
export function revealCompForClip(
  doc: MotionDocument,
  clipId: string,
  opts?: { playheadMs?: number },
): boolean {
  const loc = locateClip(doc, clipId);
  if (!loc) return false;
  const target = loc.clip.frameId;
  const session = useSession.getState();
  if (target === activeCompId(doc, session.activeFrameId)) {
    if (opts?.playheadMs !== undefined) session.setPlayhead(opts.playheadMs);
    return true;
  }
  if (!doc.frames.some((f) => f.id === target)) return false;
  session.revealFrame(target, opts?.playheadMs);
  return true;
}

/** Height of the thin row that heads an open group's band. */
export const GROUP_CAPTION_HEIGHT = 20;

/**
 * ONE ROW of the timeline, with its vertical extent — the single answer to
 * "what is at this y", which the lane list, the header column, the drag
 * targeting, the marquee and the drop ghost all read.
 *
 *  lane    a track: the comp's own, or a row of an open group's band
 *  group   the thin caption heading an open group's band
 *  ghost   the placeholder row a drag past a scope's edge would create
 *
 * The ghost is a row here, deliberately: a placeholder that only existed in
 * the DOM shifted every lane beneath it while the hit test still counted from
 * the top, so a drag armed past the edge measured against rows that had
 * already moved. One list, one y-map.
 */
export type TimelineRow = (
  | (FrameLaneRow & { height: number })
  | (FrameGroupRow & { height: number })
  /** One pose set of a character in PARTS view — its performance, block by block (`characterLanes`). */
  | { kind: "pose"; group: GroupClip; setId: string; depth: number; height: number }
  | { kind: "ghost"; edge: "top" | "bottom"; scope: string | null; ghostRow: number; depth: number; height: number }
) & { top: number };

/** A pose lane: tall enough for its pose pictures, zoomed with the lanes. */
export const POSE_LANE_HEIGHT = 40;
export function poseLaneHeight(): number {
  return Math.max(MIN_RENDERED_LANE_HEIGHT, POSE_LANE_HEIGHT * laneZoomNow());
}

/** Does this group's band show its PERFORMANCE (pose lanes) rather than its layers? Parts is the default for a character. */
export function showsParts(group: GroupClip, layersIds: readonly string[] = useSession.getState().characterLayersIds): boolean {
  return !!group.poses?.length && !layersIds.includes(group.id);
}

/** The height a ghost (new-lane) row renders at — a default lane, zoomed. */
export function ghostLaneHeight(): number {
  return Math.max(MIN_RENDERED_LANE_HEIGHT, DEFAULT_LANE_HEIGHT * laneZoomNow());
}

/**
 * The rows the timeline displays for one comp, top to bottom, each with its
 * `top` and `height` — `frameRows` (the structure) plus this surface's row
 * heights and the pending new-lane placeholders.
 *
 * Order is the layer tree's: the comp's lanes, and beneath any lane an OPEN
 * group's caption and rows, spliced in where the group's bar sits. Collapsing
 * a group hides its band and nothing else, so opening one can never move what
 * is above it.
 */
export function timelineRows(
  doc: MotionDocument,
  compId: string,
  collapsed: ReadonlySet<string> = new Set(useSession.getState().collapsedIds),
  pending: PendingNewLane | null = useSession.getState().pendingNewLane,
  layersIds: readonly string[] = useSession.getState().characterLayersIds,
  laneZoom: number = laneZoomNow(),
): TimelineRow[] {
  const out: TimelineRow[] = [];
  let y = 0;
  const push = (row: Omit<TimelineRow, "top">): void => {
    out.push({ ...row, top: y } as TimelineRow);
    y += row.height;
  };
  const ghost = (edge: "top" | "bottom", scope: string | null, ghostRow: number, depth: number): Omit<TimelineRow, "top"> =>
    ({ kind: "ghost", edge, scope, ghostRow, depth, height: ghostLaneHeight() }) as Omit<TimelineRow, "top">;
  const ghosts = (edge: "top" | "bottom", scope: string | null, depth: number): void => {
    if (!pending || pending.edge !== edge || (pending.scope ?? null) !== scope) return;
    const count = Math.max(1, ...pending.clips.map((c) => c.row + 1));
    for (let i = 0; i < count; i++) push(ghost(edge, scope, i, depth));
  };

  const structure = frameRows(doc, compId, collapsed);
  ghosts("top", null, 0);
  // A band's bottom ghost goes after its LAST row, which is the row before the
  // next row of depth ≤ the caption's — found by looking ahead.
  const bandEnd = (i: number): number => {
    const head = structure[i]!;
    let j = i + 1;
    while (j < structure.length && structure[j]!.depth > head.depth) j++;
    return j;
  };
  const closeAt = new Map<number, Array<{ scope: string; depth: number }>>();
  for (let i = 0; i < structure.length; i++) {
    const row = structure[i]!;
    for (const close of closeAt.get(i) ?? []) ghosts("bottom", close.scope, close.depth);
    if (row.kind === "lane") {
      push({ ...row, height: laneHeight(row.track, laneZoom) });
      continue;
    }
    push({ ...row, height: GROUP_CAPTION_HEIGHT });
    // A CHARACTER in Parts view: its band is its performance — one lane per
    // pose set — and its layer rows step aside (Parts | Layers on the caption).
    if (showsParts(row.group, layersIds)) {
      for (const set of row.group.poses ?? []) push({ kind: "pose", group: row.group, setId: set.id, depth: row.depth + 1, height: poseLaneHeight() } as Omit<TimelineRow, "top">);
      const end = bandEnd(i);
      for (const close of closeAt.get(end) ?? []) ghosts("bottom", close.scope, close.depth);
      closeAt.delete(end);
      i = end - 1;
      continue;
    }
    ghosts("top", row.group.id, row.depth + 1);
    const end = bandEnd(i);
    closeAt.set(end, [...(closeAt.get(end) ?? []), { scope: row.group.id, depth: row.depth + 1 }]);
  }
  for (const close of closeAt.get(structure.length) ?? []) ghosts("bottom", close.scope, close.depth);
  ghosts("bottom", null, 0);
  return out;
}

/** The rows of the OPEN comp's timeline — the one answer to "which row is at y". */
export function openTimelineRows(doc: MotionDocument): TimelineRow[] {
  return timelineRows(doc, activeCompId(doc, useSession.getState().activeFrameId));
}

/** Just the lane rows' tracks, in render order, for callers that count rows. */
export function openTimelineTracks(doc: MotionDocument): Track[] {
  return openTimelineRows(doc)
    .filter((r): r is TimelineRow & { kind: "lane" } => r.kind === "lane")
    .map((r) => r.track);
}

/** The row under a y (in lanes-content space), or null past the end. */
export function rowAtY(rows: readonly TimelineRow[], y: number): TimelineRow | null {
  if (y < 0) return null;
  for (const row of rows) if (y < row.top + row.height) return row;
  return null;
}

/**
 * The timeline's END for a comp: where the draggable end bar sits, where
 * playback loops, and where the dimmed "past the end" area begins — ONE value
 * so all three always agree (drag the bar and everything follows). A privately-
 * owned nested comp ends at its owner clip's duration; a single-frame doc at
 * the doc duration; any other frame at its explicit per-frame duration or, with
 * none set, its content end (the last clip) so the bar hugs the content instead
 * of floating in empty space. A clip that overflows past this is NOT counted —
 * that's the point: the bar trims playback even over a longer clip.
 */
export function timelineEndMs(doc: MotionDocument, compId: string): number {
  const frame = doc.frames.find((f) => f.id === compId);
  return frame ? frameDurationMs(doc, frame) : doc.durationMs;
}

/** Timeline content span for one comp: its duration, always past its last clip. */
export function timelineSpanMs(doc: MotionDocument, compId: string): number {
  // A private nested comp shows its OWNER clip's duration (compDurationMs), so
  // drilling into a nested clip shows a ruler as long as that clip — its fill
  // children then read as full-width.
  const end = Math.max(compDurationMs(doc, compId), frameContentDurationMs(doc, compId));
  return end + 2000;
}

/**
 * One marker, plus where it sits on THIS comp's ruler. `native` markers live
 * here (`marker.frameId === compId`) and are the fully-interactive pins —
 * drag/rename/color/delete all act on the real record. Non-native markers are
 * merged in from an ancestor or descendant comp (see `visibleMarkers`):
 * `timeMs` is a time-mapped PROJECTION, shown read-only.
 */
export interface VisibleMarker {
  marker: TimelineMarker;
  timeMs: number;
  native: boolean;
}

/**
 * One nesting step DOWN: a time in the ancestor timeline that hosts `clip`,
 * projected into `clip`'s source comp's own local time — speed/loop/pingpong/
 * trim aware, the same math the renderer uses to place nested content. Null
 * when the time falls outside the clip's visible span.
 */
function projectIntoNestedClip(doc: MotionDocument, clip: Clip, hostLocalMs: number): number | null {
  if (clip.kind !== "nested") return null;
  const local = hostLocalMs - clip.startMs;
  if (local < 0 || local > clip.durationMs) return null;
  return clipSourceTimeAt(doc, clip, local);
}

/**
 * The inverse, first-cycle only — loop/pingpong make the true inverse
 * many-valued, so (like Parent Preview) this picks the editing-intuitive first
 * pass. A nested clip's own local time, projected UP into the ancestor
 * timeline it's placed on. Null when that projection lands outside the clip's
 * visible span (a marker before the trim-in, or a looped one past the end).
 */
function projectUpThroughNestedClip(doc: MotionDocument, clip: Clip, sourceLocalMs: number): number | null {
  if (clip.kind !== "nested") return null;
  const up = clipLocalTimeAtSource(doc, clip, sourceLocalMs);
  // The inverse clamps; a marker it had to clamp is not inside the instance.
  if (clipSourceTimeAt(doc, clip, up) !== sourceLocalMs) return null;
  return clip.startMs + up;
}

/** Every ancestor along `path`'s own markers, projected down to the comp at the end of the path. */
function ancestorMarkersInto(doc: MotionDocument, path: Array<{ frameId: string; clipId: string }>): VisibleMarker[] {
  const out: VisibleMarker[] = [];
  for (let i = 0; i < path.length; i++) {
    let atLevel: VisibleMarker[] = doc.markers
      .filter((m) => m.frameId === path[i]!.frameId)
      .map((marker) => ({ marker, timeMs: marker.timeMs, native: false }));
    // Walk down one nested-clip hop per remaining path entry to reach the target comp.
    for (let j = i; j < path.length; j++) {
      const clip = locateClip(doc, path[j]!.clipId)?.clip ?? null;
      const next: VisibleMarker[] = [];
      for (const vm of atLevel) {
        const down = clip ? projectIntoNestedClip(doc, clip, vm.timeMs) : null;
        if (down !== null) next.push({ marker: vm.marker, timeMs: down, native: false });
      }
      atLevel = next;
    }
    out.push(...atLevel);
  }
  return out;
}

/** Every descendant nested comp's own markers, projected up into `compId`'s local time. */
function descendantMarkersInto(doc: MotionDocument, compId: string, ancestorsOnPath: ReadonlySet<string>): VisibleMarker[] {
  const out: VisibleMarker[] = [];
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.frameId !== compId || clip.kind !== "nested") continue;
      const childId = clip.sourceFrameId;
      if (ancestorsOnPath.has(childId)) continue; // guards against a self-nesting cycle
      const nextPath = new Set(ancestorsOnPath).add(childId);
      const childOwn: VisibleMarker[] = [
        ...doc.markers.filter((m) => m.frameId === childId).map((marker) => ({ marker, timeMs: marker.timeMs, native: false })),
        ...descendantMarkersInto(doc, childId, nextPath),
      ];
      for (const vm of childOwn) {
        const up = projectUpThroughNestedClip(doc, clip, vm.timeMs);
        if (up !== null) out.push({ marker: vm.marker, timeMs: up, native: false });
      }
    }
  }
  return out;
}

/**
 * Markers visible on `compId`'s ruler: its own (always, fully interactive),
 * plus — while the "merge markers" setting is on — every ancestor along the
 * current drill path and every descendant nested comp, time-mapped in and
 * shown read-only. Off by default: each timeline only ever shows its own.
 */
export function visibleMarkers(
  doc: MotionDocument,
  compId: string,
  merge: boolean = useSession.getState().mergeMarkers,
  timelinePath: Array<{ frameId: string; clipId: string }> = useSession.getState().timelinePath,
): VisibleMarker[] {
  const own: VisibleMarker[] = doc.markers
    .filter((m) => m.frameId === compId)
    .map((marker) => ({ marker, timeMs: marker.timeMs, native: true }));
  if (!merge) return own;
  return [
    ...own,
    ...ancestorMarkersInto(doc, timelinePath),
    ...descendantMarkersInto(doc, compId, new Set([compId])),
  ];
}

/**
 * Snap candidate times per the user's snap settings, scoped to the open comp:
 * zero and the comp end always; clip edges, the playhead, and keyframe times
 * (absolute) as toggled.
 */
export function collectSnapCandidates(
  doc: MotionDocument,
  compId: string,
  excludeClipIds: Set<string>,
  playheadMs: number,
  settings: { toClips: boolean; toPlayhead: boolean; toKeyframes: boolean },
): number[] {
  const candidates: number[] = [0, compDurationMs(doc, compId)];
  if (settings.toPlayhead) candidates.push(playheadMs);
  // Markers are magnets while shown — plug-and-play with every drag that
  // already snaps (clips, trims, the playhead itself). Merged-in echoes snap
  // too, so aligning to a parent/child beat works from anywhere.
  if (useSession.getState().markersEnabled) {
    for (const vm of visibleMarkers(doc, compId)) candidates.push(vm.timeMs);
  }
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.frameId !== compId || excludeClipIds.has(clip.id)) continue;
      if (settings.toClips) candidates.push(clip.startMs, clip.startMs + clip.durationMs);
      if (settings.toKeyframes) {
        for (const kf of clip.keyframes) {
          for (const key of kf.keys) candidates.push(clip.startMs + key.timeMs);
        }
      }
    }
  }
  return candidates;
}

