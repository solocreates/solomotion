/**
 * Frame rate — the one brain (v48).
 *
 * ## The model, in one line
 *
 * **Time is milliseconds. A frame rate is a GRID, never a time.**
 *
 * Every time value in the document — clip starts, durations, keyframe times,
 * marker positions, cue times — is milliseconds, and nothing here ever
 * changes one. A rate answers a different question: *where are the legible
 * instants in this comp?* It is what the ruler ticks on, what ⇦/⇨ steps by,
 * what the curve and dope-sheet grids draw, what snapping magnetises to, and
 * what the exporter iterates on. That is all it is.
 *
 * ## Why that makes nesting correct for free
 *
 * The obvious design — a document rate that comps inherit and may override —
 * forces a question at every boundary: when a 12fps flipbook is nested inside
 * a 60fps comp, whose rate wins, and does the child get resampled? Every
 * answer to that is a bug, because it makes a rate load-bearing for *timing*,
 * and then changing a rate silently retimes artwork.
 *
 * Because a rate here is only a grid, the question never arises. The parent
 * asks the child for its state at some millisecond; the child answers from its
 * own millisecond-addressed content. A 12fps flipbook holds each cell for
 * 83.33ms no matter what the parent runs at; a 60fps parent samples it every
 * 16.67ms and sees the same cell about five times, which is exactly what a
 * 12fps drawing nested in a 60fps sequence should look like. Two sibling comps
 * at different rates compose the same way. Nothing negotiates, nothing
 * inherits, nothing resamples — so nothing can drift.
 *
 * The single deliberate exception is {@link retimeFlipbookCells}, where the
 * user is asking to re-cut drawings onto a new grid. That is an explicit
 * authoring operation, not a consequence of a rate living somewhere.
 *
 * ## Where a rate lives
 *
 * On the frame, concretely (`frame.fps`), and nowhere else. There is no
 * document-global rate to inherit from or disagree with — see the v48
 * migration for the disagreements that removing it fixed.
 */

import type { MotionDocument, Clip, Frame } from "../schema";
import { frameEffectClip } from "./frame-effects";

/**
 * The rate a brand-new frame is born at, and the answer when a lookup is
 * handed an id that names no frame. 30 because that is what the app has always
 * defaulted to; nothing else depends on the particular value.
 */
export const DEFAULT_FPS = 30;

/** Legal range for a rate. Wide on purpose — 2fps sheets and 240fps slow-mo are both real work. */
export const MIN_FPS = 1;
export const MAX_FPS = 240;
/**
 * A LAYER's rate may go far below a comp's: 0.5 is a slide every two seconds,
 * 1/3 a picture every three. A comp needs a playable grid; a layer only needs
 * to know when its next picture starts (see `clipFrameTime`).
 */
export const MIN_LAYER_FPS = 0.1;

/**
 * A rate offered as a one-click choice, with the reason anyone would pick it.
 * Presets are a convenience layer over an open numeric field — the field is
 * the real control, and any positive rate in range is equally valid.
 */
export interface FpsPreset {
  fps: number;
  /** What this rate is FOR. Shown beside the number; this is what makes the list pickable. */
  label: string;
}

/**
 * Ordered slowest → fastest, because the list reads as a spectrum from
 * "hand-drawn" to "high frame rate" and picking is a judgement about where on
 * that spectrum the comp sits.
 */
export const FPS_PRESETS: readonly FpsPreset[] = [
  { fps: 8, label: "Rough / thumbnail" },
  { fps: 12, label: "Hand-drawn animation" },
  { fps: 15, label: "Limited animation" },
  { fps: 23.976, label: "Film (NTSC pulldown)" },
  { fps: 24, label: "Film" },
  { fps: 25, label: "PAL broadcast" },
  { fps: 29.97, label: "NTSC broadcast" },
  { fps: 30, label: "Standard video" },
  { fps: 50, label: "PAL high frame rate" },
  { fps: 59.94, label: "NTSC high frame rate" },
  { fps: 60, label: "Smooth / UI motion" },
  { fps: 120, label: "High frame rate" },
];

/**
 * Coerce anything a user could type or drag into a legal rate.
 *
 * Rounded to 3dp rather than to an integer: the broadcast rates are 23.976 and
 * 29.97, and an `.int()` field cannot express either. 3dp is enough for every
 * real rate (including the 1001-denominator family) and stops a drag gesture
 * from persisting float noise like `29.970000000000002`.
 */
export function normalizeFps(value: number, min = MIN_FPS): number {
  if (!Number.isFinite(value)) return DEFAULT_FPS;
  const clamped = Math.min(MAX_FPS, Math.max(min, value));
  return Math.round(clamped * 1000) / 1000;
}

/** This frame's rate. The one reader — never touch `frame.fps` directly. */
export function frameFps(_doc: MotionDocument, frame: Frame): number {
  return normalizeFps(frame.fps);
}

/**
 * The rate of the comp with this id, or {@link DEFAULT_FPS} if the id names no
 * frame. The by-id form exists because most callers (timeline, shortcuts,
 * export) hold an id, and leaving them to resolve the frame themselves is how
 * a stray `?? doc.fps` fallback gets reintroduced.
 */
export function compFps(doc: MotionDocument, frameId: string | null | undefined): number {
  if (!frameId) return DEFAULT_FPS;
  const frame = doc.frames.find((f) => f.id === frameId);
  return frame ? frameFps(doc, frame) : DEFAULT_FPS;
}

/** Duration of one frame at this rate, in ms. The grid unit. */
export function frameStepMs(fps: number): number {
  return 1000 / normalizeFps(fps);
}

/**
 * How far BELOW a grid instant a time may sit and still count as that instant.
 *
 * Grid times are reached by different arithmetic and do not land on the same
 * float: `index * step` gives 83.33333… for the second cell of a 12fps sheet,
 * {@link snapMsToFrame} stores 83.333, and a repacked flipbook row reaches it
 * by summing holds. Without a tolerance the floor below drops those times into
 * the PREVIOUS frame, and a clip starting there is invisible on the very frame
 * it starts — the render clock never addresses its first instant.
 *
 * And people and agents write WHOLE MILLISECONDS: frame 4 of a 30fps comp
 * is 133.33…ms, and every caller that rounds writes 133. At a 0.01ms
 * tolerance that 133 floored into frame 3 — `layer.create {startMs: 133}`
 * came back at 100, a nest ran a frame early and a frame off the content its
 * `trimInMs` named. Whole-ms rounding is off by at most half a millisecond, so
 * the tolerance is half a millisecond plus the representation error: 0.51ms,
 * still 8x smaller than the shortest legal frame step (4.17ms at 240fps), so
 * it can never absorb a real edit. One constant, so the render clock and
 * authoring agree on which frame a time is.
 */
export const GRID_EPSILON_MS = 0.51;

/** Which frame index a time falls in (floor — a time inside frame 3 IS frame 3). */
export function msToFrameIndex(ms: number, fps: number): number {
  return Math.floor((ms + GRID_EPSILON_MS) / frameStepMs(fps));
}

/**
 * The time a frame index starts at — the ONE representation of a grid instant.
 *
 * Rounded to 3dp because that is how a grid time is STORED: {@link snapMsToFrame}
 * writes it into the document, and the raw `index * step` is a DIFFERENT float
 * for the same instant (166.66666… vs 166.667). Two representations of one fact
 * is the defect, not the rounding: the render clock resolved to the raw product
 * while the clip carried the stored value, so on the clip's own first frame the
 * clock sat a ten-thousandth of a millisecond BEFORE its start and the layer was
 * invisible until the next frame. Everything grid-shaped derives from here, so
 * there is only ever one value to compare.
 *
 * The ≤0.0005ms this moves an instant off the mathematical grid is four orders
 * below anything visible or audible, and cannot accumulate — every instant is
 * computed from its index, never summed.
 */
export function frameIndexToMs(index: number, fps: number): number {
  return Math.round(index * frameStepMs(fps) * 1000) / 1000;
}

/**
 * Snap a time onto the nearest instant of this comp's grid.
 *
 * Nearest index, then {@link frameIndexToMs} — so a snapped time is bit-for-bit
 * the value the render clock resolves to, and "the clip starts on this frame"
 * is a comparison that can actually succeed. {@link GRID_EPSILON_MS} covers the
 * other direction: times reached by a running sum of holds rather than by an
 * index land just short of the boundary, and the floor has to recognise them.
 */
export function snapMsToFrame(ms: number, fps: number): number {
  return frameIndexToMs(Math.round(ms / frameStepMs(fps)), fps);
}

/**
 * Quantize a time onto the frame it FALLS IN — the render clock.
 *
 * This is what makes a rate mean something you can see. `drawFrameContent`
 * runs every time through here against the comp being drawn, so a 2fps comp
 * genuinely renders on twos: every instant inside a 500ms frame resolves to
 * that frame's start, and the picture holds until the next one. Playback,
 * scrubbing, export and thumbnails share the function, so they cannot disagree
 * about which frame a moment belongs to.
 *
 * FLOOR, not nearest — a frame is a span you are inside of, and holding is what
 * a frame rate does. {@link snapMsToFrame} rounds instead, because an editing
 * gesture is trying to LAND on the closest frame; these are genuinely different
 * questions and conflating them puts the playhead a frame ahead of the picture.
 */
export function quantizeMsToFrame(ms: number, fps: number): number {
  if (ms <= 0) return 0;
  return frameIndexToMs(msToFrameIndex(ms, fps), fps);
}

/**
 * The instant comp `frameId` is actually SHOWING at `timeMs` — the render clock
 * ({@link quantizeMsToFrame}) resolved for a comp id, and therefore the answer
 * to "when is NOW, for something I am about to author into this comp?".
 *
 * A comp only ever exists at grid instants: `drawFrameContent` quantizes every
 * time through the render clock, so the picture on screen is the frame the
 * playhead is INSIDE, not the playhead's own millisecond. Content written at
 * the raw playhead can therefore begin between two grid instants, where the
 * render clock can never address it — a layer created mid-frame is invisible
 * until you step forward, and a clip shorter than one frame is invisible for
 * good. Authoring goes through here so what you make starts on the frame you
 * are looking at.
 *
 * FLOOR (inherited from the render clock), never nearest: rounding UP would
 * put a new layer one frame ahead of the picture and reproduce exactly the
 * invisibility this exists to prevent.
 */
export function compRenderTimeMs(
  doc: MotionDocument,
  frameId: string | null | undefined,
  timeMs: number,
): number {
  const frame = frameId ? doc.frames.find((f) => f.id === frameId) : undefined;
  return frame ? frameEvalTimeMs(doc, frame, timeMs) : quantizeMsToFrame(Math.max(0, timeMs), DEFAULT_FPS);
}

/**
 * The instant a STATIC frame shows (its local ms), or null for a frame that
 * has time. The one reader of `stillMs`, so "absent = 0" lives here only.
 */
export function frameStillMs(frame: Pick<Frame, "mode" | "stillMs">): number | null {
  return frame.mode === "static" ? Math.max(0, frame.stillMs ?? 0) : null;
}

/**
 * THE RENDER CLOCK — the instant a frame's content is EVALUATED at when it is
 * asked for `timeMs`. Two rules, one function:
 *
 *  - a comp with time floors to its own frame grid (see `quantizeMsToFrame`);
 *  - a STATIC frame answers with its still, whatever it is asked. That is the
 *    whole of what "static" means to the picture: nested in a timeline it
 *    holds, stepped by a flipbook it holds, exported it is one image, and a
 *    timeline child inside it shows the one moment the still maps it to.
 *
 * Every consumer that turns "a time" into "what this comp looks like" goes
 * through here — the renderer (root and every nested descent), the picture
 * caches' keys, authoring (`compRenderTimeMs`), the edit context's path
 * times. A static check anywhere else is a second answer that will drift.
 *
 * `fps` overrides the rate for the root of an export that re-rates its comp.
 */
export function frameEvalTimeMs(
  doc: MotionDocument,
  frame: Frame,
  timeMs: number,
  fps: number = frameFps(doc, frame),
): number {
  const still = frameStillMs(frame);
  const t = quantizeMsToFrame(Math.max(0, still ?? timeMs), fps);
  return still === null ? heldFrameTimeMs(doc, frame.id, t) : t;
}

const HOLDS = new WeakMap<MotionDocument["tracks"], Map<string, ReturnType<typeof frameEffectClip>>>();

/**
 * POSTERIZE TIME (v109) — a frame whose OWN effects run at their own rate is
 * held on that rate: every layer under them shows the picture of the last
 * step, the way After Effects' Posterize Time on an adjustment layer holds
 * the comp. 12 on a 30 fps comp is stop motion that still exports at 30.
 *
 * Before this, a frame-effects clip's `fps` stepped only the grade itself —
 * its keys and its texture's re-rolls — while the animation under it glided
 * smoothly, which is exactly the fake a stop-motion look exists to avoid. It
 * is the same field, now honest about what it covers. A scoped adjustment
 * cannot do this (it would have to show some layers at another instant than
 * the rest); a single layer has its own `fps` for that.
 *
 * The step grid starts at the clip's start, as a layer's own rate does
 * (`clipFrameTime`), and only applies while the clip is live.
 */
export function heldFrameTimeMs(doc: MotionDocument, frameId: string, timeMs: number): number {
  // Asked on every render and every inspector read: the answer is a fact
  // about one immutable track list, so it is looked up once per list.
  let byFrame = HOLDS.get(doc.tracks);
  if (!byFrame) HOLDS.set(doc.tracks, (byFrame = new Map()));
  let fx = byFrame.get(frameId);
  if (fx === undefined) byFrame.set(frameId, (fx = frameEffectClip(doc, frameId)));
  if (!fx?.fps || timeMs < fx.startMs || timeMs >= fx.startMs + fx.durationMs) return timeMs;
  const step = 1000 / fx.fps;
  return fx.startMs + Math.floor((timeMs - fx.startMs) / step + 1e-6) * step;
}

/** How many whole frames a duration spans at this rate (at least one). */
export function durationInFrames(durationMs: number, fps: number): number {
  return Math.max(1, Math.round(durationMs / frameStepMs(fps)));
}

// Changing a rate is a document MUTATION, so `setFrameFps` (and the flipbook
// re-cut it delegates to) live in ./ops beside `reconcileFillClips`, which the
// re-cut has to run. This module stays pure: values, grids and presets only.

/**
 * A clip's duration in whole animation frames of the comp it sits in — the
 * flipbook sheet's "hold" count.
 */
export function cellFrameCount(doc: MotionDocument, frame: Frame, clip: Clip): number {
  return durationInFrames(clip.durationMs, frameFps(doc, frame));
}

/**
 * Format a rate for display: integers bare (`24`), broadcast rates to their
 * meaningful decimals (`29.97`), never with trailing zeroes.
 */
export function formatFps(fps: number): string {
  const n = normalizeFps(fps);
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}
