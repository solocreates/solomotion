"use client";

import {
  clipEnd,
  drilledFlipbookCell,
  fitsInTrack,
  frameContentDurationMs,
  frameFps,
  locateClip,
  locateFrame,
  moveClip,
  moveClipToNewLane,
  type DocumentStore,
  DEFAULT_FPS,
  frameStepMs,
} from "@solomotion/core";
import { DEFAULT_LANE_HEIGHT } from "../timeline/timeline-utils";
import { timelineViewport } from "../timeline/timeline-viewport";
import { nudgeTargets } from "../stage/nudge-target";
import { nudgeSelected } from "./clip-actions";
import { useSession } from "./session";

/**
 * Smart arrow-key gestures — ONE headless dispatcher for the whole workspace.
 *
 * These live outside the shortcut registry on purpose: they're contextual (a
 * lattice of focus × selection × modifier), not a flat list of user-editable
 * combos. `handleArrowNav` reads `session.focusedPanel` and routes to the panel
 * the user last touched:
 *
 *   CANVAS focus
 *     ←→↑↓            nudge the selection                  (⇧ = ×10, ⌘/Ctrl = ÷10)
 *                     — inside a layer that is its POINTS (vector nodes, shape
 *                       corners); outside, the layer(s) themselves
 *     ←→ (nothing sel) scrub the playhead                  (⇧ = ×10 frames)
 *
 *   TIMELINE focus
 *     ←→              scrub the playhead                   (⇧ = ×10 frames)
 *     ↑↓              scroll the lanes vertically          (⇧ = ×3 rows)
 *     ⌥ ←→            jump to prev/next clip edge (any track)
 *     ⌘/Ctrl ←→       (clip sel) move the clip in time     (⇧ = ×10 frames)
 *     ⌘/Ctrl ←→       (nothing)  jump to timeline start/end
 *     ⌘/Ctrl ↑↓       (clip sel) move the clip up/down a track
 *
 * ⇧ is the universal "bigger step" modifier, canvas or timeline, and ⌘/Ctrl its
 * mirror image — the "finer step" one. The step sizes are constants below — the
 * single place to tune the whole system, and every nudgeable thing (layers,
 * vector nodes, shape corners) is measured with the same `arrowStep`, so none of
 * them can drift apart into its own hardcoded pixel count.
 *
 * Returns true when it handled the event (caller should preventDefault).
 */

const ARROWS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

const NUDGE_PX = 1;
/** ⇧ = a big step, ⌘/Ctrl = a fine one. Both are multipliers on `NUDGE_PX`. */
const NUDGE_COARSE = 10;
const NUDGE_FINE = 0.1;
const PLAYHEAD_STEP_FRAMES = 1;
const PLAYHEAD_STEP_FRAMES_SHIFT = 10;
const CLIP_STEP_FRAMES = 1;
const CLIP_STEP_FRAMES_SHIFT = 10;
const SCROLL_ROWS_SHIFT = 3;

interface ArrowIntent {
  horizontal: boolean;
  /** −1 = left/up, +1 = right/down. */
  dir: -1 | 1;
  /** ⌘ (mac) or Ctrl. */
  mod: boolean;
  alt: boolean;
  shift: boolean;
}

export function handleArrowNav(e: KeyboardEvent, store: DocumentStore): boolean {
  if (!ARROWS.has(e.key)) return false;
  const intent: ArrowIntent = {
    horizontal: e.key === "ArrowLeft" || e.key === "ArrowRight",
    dir: e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1,
    mod: e.metaKey || e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
  };
  // The curves panel handles its own arrows while keyframes are selected
  // (its wrapper's onKeyDown stops propagation); anything that falls through
  // behaves like the timeline it lives in.
  return useSession.getState().focusedPanel !== "canvas"
    ? timelineNav(store, intent)
    : canvasNav(store, intent);
}

// ── Canvas ───────────────────────────────────────────────────────────────────

/**
 * ONE distance for every arrow nudge in the app — a layer, a vector node, a
 * shape's corner. In WORLD units (comp pixels), so a nudge is the same physical
 * step whatever the zoom, and the same step whatever you happen to be moving.
 */
function arrowStep(shift: boolean, mod: boolean): number {
  return NUDGE_PX * (shift ? NUDGE_COARSE : 1) * (mod ? NUDGE_FINE : 1);
}

function canvasNav(store: DocumentStore, { horizontal, dir, mod, alt, shift }: ArrowIntent): boolean {
  const session = useSession.getState();
  if (alt) return false; // ⌥ stays free on the canvas (it's a timeline gesture)
  const step = arrowStep(shift, mod);
  const dx = horizontal ? dir * step : 0;
  const dy = horizontal ? 0 : dir * step;

  // INSIDE a layer, the arrows belong to the points you selected there, and the
  // layer must not move around them — you didn't select the layer. The interior
  // editors register how to move their own selection (see `nudge-target.ts`).
  if (nudgeTargets.nudge(dx, dy)) return true;
  // Inside an editor but with nothing selected: still claimed. Falling through
  // would drag the whole layer out from under someone who is editing its points
  // — the exact surprise this branch exists to prevent.
  if (session.vectorEditClipId || session.shapeEditClipId) return true;

  if (session.selectedClipIds.length > 0) {
    nudgeSelected(store, dx, dy);
    return true;
  }
  // Nothing to nudge → left/right scrub the playhead (up/down do nothing here).
  if (horizontal && !mod) {
    stepPlayhead(store, dir, shift);
    return true;
  }
  return false;
}

// ── Timeline ─────────────────────────────────────────────────────────────────

function timelineNav(store: DocumentStore, { horizontal, dir, mod, alt, shift }: ArrowIntent): boolean {
  const session = useSession.getState();
  const clipId = session.selectedClipIds.length === 1 ? session.selectedClipIds[0]! : null;

  if (horizontal) {
    if (mod && clipId) {
      moveClipInTime(store, clipId, dir, shift);
      return true;
    }
    if (mod) {
      // Jump to the very start / content end of the active comp.
      const doc = store.getState();
      const compId = session.activeFrameId ?? doc.frames[0]?.id;
      session.setPlaying(false);
      session.setPlayhead(dir < 0 || !compId ? 0 : frameContentDurationMs(doc, compId));
      return true;
    }
    if (alt) {
      jumpToClipEdge(store, dir);
      return true;
    }
    stepPlayhead(store, dir, shift);
    return true;
  }

  // Vertical.
  if (mod && clipId) {
    moveClipTrack(store, clipId, dir);
    return true;
  }
  const rows = shift ? SCROLL_ROWS_SHIFT : 1;
  timelineViewport.scrollByY(dir * rows * DEFAULT_LANE_HEIGHT);
  return true;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

/** Step the playhead by whole frames, snapped to the frame grid so it stays crisp. */
/**
 * One animation frame in the ACTIVE comp's time — honors a per-frame fps
 * override, so a 12 fps flipbook steps by 12ths while the document runs 30.
 * The single step unit for every frame-quantized arrow gesture.
 */
function activeFrameMs(store: DocumentStore): number {
  const doc = store.getState();
  const frame = locateFrame(doc, useSession.getState().activeFrameId ?? "") ?? doc.frames[0];
  return frameStepMs(frame ? frameFps(doc, frame) : DEFAULT_FPS);
}

function stepPlayhead(store: DocumentStore, dir: -1 | 1, shift: boolean): void {
  const session = useSession.getState();
  const steps = shift ? PLAYHEAD_STEP_FRAMES_SHIFT : PLAYHEAD_STEP_FRAMES;
  session.setPlaying(false);

  // Drilled into a flipbook cell? The flipbook is the time authority for ALL
  // its cells (one shared timeline), so keyboard scrubbing must move in
  // flipbook-GLOBAL time and cross cell boundaries — exactly like the sheet
  // ruler's mouse drag (FlipbookPanel.scrubTo). Stepping before the cell's
  // start no longer clamps at its local 0: it ascends to the flipbook.
  const doc = store.getState();
  const drilled = drilledFlipbookCell(doc, session.activeFrameId);
  if (drilled) {
    const { flipbook, cell } = drilled;
    // Frame stepping is SHEET time, always — asking the time authority for the
    // current instant in the sheet's clock and handing the next one back. The
    // branch this replaced added `cell.startMs` by hand, then chose between two
    // different writers depending on whether the answer stayed inside the cell:
    // a third copy of a mapping that must have exactly one.
    const stepMs = frameStepMs(frameFps(doc, flipbook));
    const globalCur = session.playheadIn(flipbook.id);
    const globalNext = Math.max(0, (Math.round(globalCur / stepMs) + dir * steps) * stepMs);
    session.seekIn(flipbook.id, globalNext);
    return;
  }

  const frameMs = activeFrameMs(store);
  const curFrame = Math.round(session.playheadMs / frameMs);
  session.setPlayhead((curFrame + dir * steps) * frameMs);
}

function moveClipInTime(store: DocumentStore, clipId: string, dir: -1 | 1, shift: boolean): void {
  const frameMs = activeFrameMs(store);
  const steps = shift ? CLIP_STEP_FRAMES_SHIFT : CLIP_STEP_FRAMES;
  store.update(
    "Move clip",
    (d) => {
      const loc = locateClip(d, clipId);
      if (!loc) return;
      const curFrame = Math.round(loc.clip.startMs / frameMs);
      moveClip(d, clipId, Math.max(0, (curFrame + dir * steps) * frameMs));
    },
    // Repeated presses coalesce into one undo step (like nudge).
    { mergeKey: `arrow-move-${clipId}` },
  );
}

/**
 * Move the clip one track toward the top (dir −1) or bottom (dir +1). Past the
 * first/last lane it spawns a fresh track at that edge (Resolve-style); an
 * adjacent track that can't fit the clip is a no-op (no empty undo entry).
 */
function moveClipTrack(store: DocumentStore, clipId: string, dir: -1 | 1): void {
  const doc = store.getState();
  const loc = locateClip(doc, clipId);
  if (!loc) return;
  const idx = doc.tracks.findIndex((t) => t.id === loc.track.id);
  const targetIdx = idx + dir;
  const edge = targetIdx < 0 ? "top" : targetIdx >= doc.tracks.length ? "bottom" : null;
  if (edge) {
    store.update("Move clip to track", (d) => void moveClipToNewLane(d, clipId, loc.clip.startMs, edge));
    return;
  }
  const target = doc.tracks[targetIdx]!;
  if (target.locked || !fitsInTrack(target, null, loc.clip.startMs, loc.clip.durationMs, loc.clip.frameId)) {
    return;
  }
  store.update("Move clip to track", (d) => void moveClip(d, clipId, loc.clip.startMs, target.id));
}

/** Jump the playhead to the nearest clip start/end (any track in the active comp). */
function jumpToClipEdge(store: DocumentStore, dir: -1 | 1): void {
  const session = useSession.getState();
  const doc = store.getState();
  const compId = session.activeFrameId ?? doc.frames[0]?.id;
  const edges = new Set<number>([0]);
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.frameId !== compId) continue;
      edges.add(Math.round(clip.startMs));
      edges.add(Math.round(clipEnd(clip)));
    }
  }
  const sorted = [...edges].sort((a, b) => a - b);
  const cur = session.playheadMs;
  const eps = 0.5;
  const targetMs =
    dir > 0
      ? sorted.find((t) => t > cur + eps)
      : [...sorted].reverse().find((t) => t < cur - eps);
  if (targetMs == null) return;
  session.setPlaying(false);
  session.setPlayhead(targetMs);
}
