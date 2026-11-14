import { compFps, flipbookInContext, frameFps, type MotionDocument } from "@solomotion/core";

/**
 * THE TIME AXES — px-per-second across, row zoom down, PER SURFACE.
 *
 * The timeline and the flipbook sheet are the same kind of object (a scroller
 * with time on X and rows on Y) and they were sharing the same two numbers, so
 * they were never really two surfaces at all: zooming the sheet zoomed the
 * timeline, and every switch between them arrived at a zoom level chosen for
 * the other one. Worse, because a sheet frame is ~83ms wide and a timeline
 * second is 1000, the sheet could not use the shared number honestly — it
 * multiplied it by a private `56/90` fudge, which is why "the same zoom axes"
 * stepped at visibly different rates depending on which panel the pointer was
 * over.
 *
 * The axes are now a MEMORY keyed by surface — the same shape (and the same
 * reason) as `hopsByTab`, which remembers each tab's drill cursor. There is no
 * second stored copy of "the current zoom" to fall out of step with it: the
 * live value is DERIVED from the memory plus which surface is showing, so the
 * two cannot disagree.
 *
 * The DEFAULT is the other thing a surface owns. A timeline opens at 90 px/s;
 * a sheet opens at whatever px/s makes one animation frame `FRAME_PX` wide,
 * which is the same statement in the sheet's own unit. Both are px-per-second,
 * so every shared component — the playhead, the end bar, the dim overlay, the
 * ruler — keeps taking exactly one number and needs to know nothing about
 * frames.
 */

/** A comfortable cell at rest: wide enough to read a drawing, narrow enough
 *  that a second of animation fits on screen. */
export const SHEET_FRAME_PX = 56;
export const TIMELINE_PX_PER_SEC = 90;
export const DEFAULT_LANE_ZOOM = 1;

/** Bounds belong to the READER, never to the store — a persisted number must
 *  survive a ceiling moving under it (see docs/responsive-and-gestures.md). */
export const LANE_ZOOM_MIN = 0.4;
export const LANE_ZOOM_MAX = 2.5;

export interface TimeAxes {
  /** Horizontal: px per second of comp time. */
  pxPerSec: number;
  /** Vertical: multiplier over each row's own height. */
  laneZoom: number;
}

/**
 * The frame whose TIMELINE a given frame edits. A linked INSTANCE frame
 * (`instanceOf`) has no timeline of its own — its content IS its component
 * definition's (drawn via redirect) — so it resolves to that definition;
 * everything else edits itself. THE one seam so tabs, track-adding, reveal and
 * scrubbing all agree on "which timeline is this". Without it an instance frame
 * gets a phantom EMPTY timeline: a duplicate tab you can accidentally author
 * tracks/clips into that never belong to the component. One component, one
 * timeline, for every version.
 */
export function timelineHostOf(doc: MotionDocument, frameId: string): string {
  const frame = doc.frames.find((f) => f.id === frameId);
  if (frame?.instanceOf && doc.frames.some((f) => f.id === frame.instanceOf)) return frame.instanceOf;
  return frameId;
}

/**
 * The active composition the timeline shows: the session's active frame when it
 * still exists, else the first frame. Every timeline read routes through this.
 *
 * It lives HERE, with the axes, because the axes are keyed by it — see
 * `timeSurfaceOf`. It is pure (a document and an id in, an id out), so the
 * navigation slice can name the showing surface without the store ending up at
 * the end of a cycle through itself.
 */
export function activeCompId(doc: MotionDocument, activeFrameId: string | null): string {
  // An empty project has no comp to show: "" names nothing, and matches no clip.
  const raw = activeFrameId && doc.frames.some((f) => f.id === activeFrameId) ? activeFrameId : (doc.frames[0]?.id ?? "");
  return timelineHostOf(doc, raw);
}

/**
 * The surface the bottom region is showing, and the axes it opens at.
 *
 * ONE derivation, shared by the store's writers and the panels' readers, so
 * "which axes am I editing" can never be answered differently by the control
 * and the thing it controls.
 *
 * The id is the comp the timeline ACTUALLY shows (`activeCompId`), not the
 * nav's `activeFrameId`. Those are not the same thing: the nav is empty until
 * you deliberately navigate, and the timeline has always fallen back to the
 * document's first frame — so this returned `""` for the normal case of a
 * freshly opened project. An empty key is not a harmless one: the store wrote
 * every zoom into `zoomBySurface[""]` while the readers treated `""` as "no
 * surface" and answered with the defaults, so the timeline's zoom — both axes,
 * from the gesture, the dial and the keyboard alike — was recorded and then
 * discarded on the way back out. It looked like a race and was a key.
 *
 * Going through `activeCompId` also means an instance frame and its definition
 * share one zoom memory, which is right for the same reason they share one
 * timeline.
 */
export function timeSurfaceOf(
  doc: MotionDocument,
  activeFrameId: string | null,
  rootFrameId: string,
): { id: string; defaults: TimeAxes } {
  const flipbook = flipbookInContext(doc, activeFrameId);
  if (flipbook) {
    return {
      id: flipbook.id,
      defaults: {
        // px/s that makes one animation frame SHEET_FRAME_PX wide — the sheet's
        // own unit, expressed in everyone else's.
        pxPerSec: SHEET_FRAME_PX * frameFps(doc, flipbook),
        laneZoom: DEFAULT_LANE_ZOOM,
      },
    };
  }
  return {
    id: doc.frames.length > 0 ? activeCompId(doc, activeFrameId ?? rootFrameId) : "",
    defaults: { pxPerSec: TIMELINE_PX_PER_SEC, laneZoom: DEFAULT_LANE_ZOOM },
  };
}

/** The frame grid of a sheet at the current zoom — px per animation frame. */
export function framePx(pxPerSec: number, stepMs: number): number {
  return (pxPerSec * stepMs) / 1000;
}

/** How far a SHEET may zoom, in px/s, expressed as px-per-frame bounds — the
 *  honest limits for a grid of thumbnails rather than a ruler of seconds. */
export function sheetAxisBounds(stepMs: number): { min: number; max: number } {
  const perFrame = (px: number) => (px * 1000) / Math.max(1, stepMs);
  return { min: perFrame(10), max: perFrame(260) };
}

/** A comp's own frame rate, for surfaces that quantise to it. */
export function compRate(doc: MotionDocument, frameId: string): number {
  return compFps(doc, frameId);
}
