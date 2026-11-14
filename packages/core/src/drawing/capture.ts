import { evaluateEasing } from "../easing";
import { compFps, compRenderTimeMs, msToFrameIndex } from "../timeline/fps";
import type { MotionDocument, KeyframeTrack, KeyframeValue } from "../schema";

/**
 * The CAPTURE engine — recordable drawing over time, for EVERY draw engine (v41,
 * generalized v42).
 *
 * A "capture" is nothing more than an ordinary keyframe track whose property is
 * `CAPTURE_PROPERTY` and whose discrete values are `surfaceId`s — snapshots of
 * the layer's pixels at that moment. Each surface is already content-addressed,
 * undo-aware and persisted (drawing/raster-store), so recording a drawing over
 * time needs NO new storage, NO new history and NO schema migration.
 *
 * This is the PIXEL model, and deliberately only that. A vector layer records
 * itself through `geometry` keyframes — the morph channel it has always had —
 * because an outline can interpolate and a bitmap cannot: holding is what frames
 * do for pixels, tweening is what they do for vectors. Briefly there was a
 * second capture track carrying subpath snapshots, which is the same fact stored
 * twice under two rules; `geometry` won because record mode, easing per key, the
 * curve editor and undo already worked on it.
 *
 * It is a lightweight SIBLING of the flipbook comp (drawing/flipbook), not a
 * replacement — it reuses the same low-level brains (raster-store, stroke-engine,
 * path-fit, onion) without the cell container, so a single layer can "draw itself
 * on" as part of a composition.
 *
 * The property is registered `discrete` in animation/properties, so the sampler
 * holds a snapshot until the next key (crisp FBF). `captureStateAt` additionally
 * exposes the neighbouring snapshot + an eased mix so an optional crossfade
 * ("just fade") dissolves between frames through ONE composite path.
 */

/** The animatable-property key a capture track lives under. */
export const CAPTURE_PROPERTY = "capture";

/** The clip-local capture track (whole-clip, non-empty), if this clip records. */
export function captureTrack(tracks: KeyframeTrack[]): KeyframeTrack | undefined {
  return tracks.find(
    (t) => t.property === CAPTURE_PROPERTY && !t.range && t.keys.length > 0,
  );
}

/** Whether a clip's drawing is recorded over time (has ≥1 capture snapshot). */
export function isCaptureClip(tracks: KeyframeTrack[]): boolean {
  return captureTrack(tracks) !== undefined;
}

/**
 * Every `surfaceId` a clip's capture track references — the set of snapshots the
 * raster store must keep alive (persistence) and free when the clip dies (GC).
 * Deduped, key-order preserved. Vector snapshots carry their own geometry and
 * own no surfaces, so they contribute nothing here by construction.
 */
export function captureSurfaceIds(tracks: KeyframeTrack[]): string[] {
  const track = tracks.find((t) => t.property === CAPTURE_PROPERTY);
  if (!track) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const key of track.keys) {
    if (typeof key.value === "string" && key.value && !seen.has(key.value)) {
      seen.add(key.value);
      ids.push(key.value);
    }
  }
  return ids;
}

/** What the renderer draws for a capture clip at a given clip-local time. */
export interface CaptureState {
  /** The snapshot showing at this time (the held frame). */
  value: KeyframeValue;
  /** During a crossfade, the snapshot to dissolve toward (else null). */
  next: KeyframeValue | null;
  /** Eased dissolve factor 0→1 from `value` to `next` (0 = hold). */
  mix: number;
}

/** A capture snapshot read as a raster surface id ("" when it isn't one). */
export function captureSurface(value: KeyframeValue | null | undefined): string {
  return typeof value === "string" ? value : "";
}

/**
 * Resolve which snapshot(s) show at clip-local `timeMs`.
 *
 * - Before the first key: `null` — nothing has been drawn yet, so the layer is
 *   blank. This is what makes a drawing "appear over time" (handwriting, a build
 *   on animation); a layer that should be visible from the start simply puts its
 *   first snapshot at t=0.
 * - Hold (default): returns the key at/just-before `timeMs`, `mix: 0`.
 * - Crossfade: within a segment, `mix` eases (via the leaving key's easing) from
 *   the earlier snapshot to the later — one dissolve path for every layer kind.
 */
export function captureStateAt(
  track: KeyframeTrack,
  timeMs: number,
  crossfade: boolean,
): CaptureState | null {
  const keys = track.keys;
  if (keys.length === 0) return null;

  const first = keys[0]!;
  if (timeMs < first.timeMs) return null;

  const last = keys[keys.length - 1]!;
  if (timeMs >= last.timeMs) return { value: last.value, next: null, mix: 0 };

  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (timeMs >= a.timeMs && timeMs < b.timeMs) {
      if (!crossfade) return { value: a.value, next: null, mix: 0 };
      const span = b.timeMs - a.timeMs;
      const t = span <= 0 ? 0 : (timeMs - a.timeMs) / span;
      return { value: a.value, next: b.value, mix: evaluateEasing(a.easing, t) };
    }
  }

  // Unreachable given the guards above, but keeps the return total.
  return { value: last.value, next: null, mix: 0 };
}

// ── The seed policy: what a NEW recorded frame starts from ───────────────────

/**
 * When a stroke lands somewhere no frame exists yet, a frame is born — and this
 * is the ONE decision that says what it contains before you touch it.
 *
 * A union rather than a boolean: "start from the previous frame" and "start
 * empty" are the two classic cel-animation workflows (build-on vs. redraw), and
 * the set is open — a future "trace the onion ghost" or "start from a reference"
 * arm is one entry here and one entry in `CAPTURE_SEEDS`, not a new flag.
 */
export type CaptureSeed = "continue" | "blank";

/** Everything a surface needs to render the seed choice — no UI-side switch. */
export interface CaptureSeedDef {
  seed: CaptureSeed;
  /** Control label. */
  label: string;
  /** What the NEXT new frame will do, said plainly (tooltip / HUD line). */
  hint: string;
}

export const CAPTURE_SEEDS: readonly CaptureSeedDef[] = [
  {
    seed: "continue",
    label: "Continue",
    hint: "New frames start from the drawing before them — keep building.",
  },
  {
    seed: "blank",
    label: "Blank",
    hint: "New frames start empty — redraw from scratch each time.",
  },
];

export const DEFAULT_CAPTURE_SEED: CaptureSeed = "continue";

/**
 * Where the next stroke lands on a recordable layer. Three states, and only
 * three, so no surface can invent a fourth:
 *
 *  - `live`  — this layer is not recording: paint its own content, as always.
 *  - `edit`  — a frame already sits at the playhead: paint into that snapshot.
 *  - `new`   — no frame here yet: one is born, containing `seedFrom` (the held
 *              snapshot for "continue", `null` for "blank").
 *
 * Pure. The raster projection materialises `seedFrom` by cloning pixels; the
 * vector projection copies subpaths. Both then commit a key at `keyTimeMs`.
 */
export type CapturePlan =
  | { kind: "live" }
  | { kind: "edit"; keyTimeMs: number; value: KeyframeValue }
  | { kind: "new"; keyTimeMs: number; seedFrom: KeyframeValue | null };

/**
 * THE capture frame a moment addresses — and the ONE answer to it.
 *
 * A capture frame is a FRAME, not a millisecond. `drawFrameContent` quantizes
 * every time onto the comp's grid before it samples anything, so the picture on
 * screen is the frame the playhead is INSIDE. Anything that compares a playhead
 * against key times in raw milliseconds is asking a different question than the
 * renderer is answering, and will disagree with the picture by one frame.
 *
 * That disagreement is what made a snapshot fail to appear on the very frame it
 * was drawn on — its key landed a fraction of a millisecond after the grid
 * instant the render clock floors to, so the frame before it kept showing until
 * you stepped forward — and what made every onion ghost point one frame too far
 * back.
 *
 * Planning, the HUD and onion skinning all resolve through here, so they cannot
 * drift from the renderer or from each other. Comparing frame INDICES rather
 * than raw times also means keys written off-grid by an earlier build still
 * resolve to the frame they visually occupy.
 */
export interface CaptureCursor {
  /** Index of the frame HELD at this time; -1 before the first frame exists. */
  index: number;
  /** A frame BEGINS on this render frame — draw here and you edit it, not add. */
  onFrame: boolean;
}

export function captureCursor(
  times: readonly number[],
  localMs: number,
  fps: number,
): CaptureCursor {
  const want = msToFrameIndex(Math.max(0, localMs), fps);
  let index = -1;
  let onFrame = false;
  for (let i = 0; i < times.length; i++) {
    const at = msToFrameIndex(times[i]!, fps);
    if (at > want) break;
    index = i;
    onFrame = at === want;
  }
  return { index, onFrame };
}

/**
 * The clip-local time to author a capture frame at — the render clock's own
 * instant, never the raw playhead.
 *
 * Content written at the raw playhead can begin between two grid instants where
 * the render clock can never address it (see `compRenderTimeMs`). A capture key
 * is exactly that kind of content, so every planner takes its time from here.
 */
export function captureLocalMs(
  doc: MotionDocument,
  clip: { frameId: string; startMs: number },
  playheadMs: number,
): number {
  return compRenderTimeMs(doc, clip.frameId, playheadMs) - clip.startMs;
}

/** The comp frame rate a clip's capture frames are cut on. */
export function captureFps(doc: MotionDocument, clip: { frameId: string }): number {
  return compFps(doc, clip.frameId);
}

export interface PlanCaptureInput {
  tracks: KeyframeTrack[];
  /** Clip-local time ON THE RENDER CLOCK — always from `captureLocalMs`. */
  localMs: number;
  /** The comp's rate: what makes "the same frame" a decidable question. */
  fps: number;
  /** Record armed — the only thing that turns a plain layer into a recording. */
  recording: boolean;
  seed: CaptureSeed;
  /**
   * The layer's CURRENT content as a snapshot value (surfaceId / subpaths).
   * Only read for the very first recorded frame of a still-plain layer, so that
   * arming Record and drawing continues what is already on screen instead of
   * silently blanking it.
   */
  liveValue: KeyframeValue;
}

export function planCapture(input: PlanCaptureInput): CapturePlan {
  const { tracks, recording, seed, liveValue, fps } = input;
  const track = captureTrack(tracks);
  if (!track && !recording) return { kind: "live" };

  const keys = track?.keys ?? [];
  const cursor = captureCursor(keys.map((k) => k.timeMs), input.localMs, fps);
  if (cursor.onFrame) {
    const here = keys[cursor.index]!;
    return { kind: "edit", keyTimeMs: here.timeMs, value: here.value };
  }

  const keyTimeMs = Math.max(0, input.localMs);
  if (seed === "blank") return { kind: "new", keyTimeMs, seedFrom: null };
  // Continue: the snapshot HELD here (the frame to the left). With no track yet,
  // the layer's own content is what the first frame continues.
  const left = cursor.index >= 0 ? keys[cursor.index]!.value : null;
  return { kind: "new", keyTimeMs, seedFrom: left ?? (track ? null : liveValue) };
}

/**
 * The capture frame times of a clip, ascending — the FBF frame list a scrubber,
 * an onion walk or a frame-step shortcut reads. Empty for a plain layer.
 */
export function captureFrameTimes(tracks: KeyframeTrack[]): number[] {
  const track = captureTrack(tracks);
  return track ? track.keys.map((k) => k.timeMs).sort((a, b) => a - b) : [];
}
