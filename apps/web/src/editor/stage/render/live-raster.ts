"use client";

import {
  partitionScene,
  type MotionDocument,
  type Clip,
  type Frame,
  type ScenePartition,
} from "@solomotion/core";

/**
 * THE INCREMENTAL SCENE — what the stage draws while one part of it is changing.
 *
 * Most of what a person does changes ONE layer, and the renderer had no way to
 * say so: every edit meant "re-render everything". `partitionScene` (core) cuts
 * the scene into everything painted BELOW what is changing, the changing run,
 * and everything ABOVE it — and refuses outright whenever that cut would lie.
 * This file is what turns that partition into pixels: the outer two thirds are
 * baked to rasters once, and every tick is then two blits plus one real render
 * of the handful of layers actually in play.
 *
 * It began as the drag fast path and the generalisation is the point. Dragging
 * a layer is one way to change one layer; typing in a text box, pulling a pen
 * node, nudging a slider and working inside a nested comp are others, and the
 * scene around them is equally constant. The caller decides what may change
 * (`editScopeClipIds` reads it off the navigation); this file does not care how
 * it was decided.
 *
 * ── It is a deferral, never a cache ─────────────────────────────────────────
 *
 * The bread is verified every single tick, not assumed: with the document store
 * on immer, an untouched clip keeps its object identity, so "did anything
 * except the changing layers change?" is a reference comparison rather than a
 * guess. Anything else at all — an added duplicate, a decoded video frame, a
 * moved playhead — and the bake is thrown away and the stage renders for real.
 * The cost of a wrong guess is a re-bake, never a wrong picture, which is what
 * lets the caller be generous about what it thinks may change.
 */

interface Baked {
  belowCanvas: HTMLCanvasElement;
  aboveCanvas: HTMLCanvasElement;
  /** Backing-store size the two rasters were painted at. */
  width: number;
  height: number;
  /**
   * Everything about WHERE the bake was painted that is not the document —
   * the camera, and for a surface that is not parked on the playhead, the
   * instant and render scale. One opaque string, so a second surface can
   * state its own without this file learning about it.
   */
  viewKey: string;
  /** Identity of every clip that is NOT changing, at bake time. */
  rest: Map<string, Clip>;
  /** Doc slices that can change any layer without touching a clip object. */
  frames: readonly Frame[];
}

export interface ScenePaint {
  /**
   * Paint the page with only these clips, onto `target`. `board` draws frame
   * fills/shadows. The stage's ONE painter, handed a destination — so a slice
   * goes through the identical code path as a real render (same transforms,
   * same chrome suppression, same everything) without a second renderer that
   * could disagree, and without the visible canvas being used as scratch.
   */
  paintSlice: (target: CanvasRenderingContext2D, only: ReadonlySet<string>, board: boolean) => void;
  width: number;
  height: number;
}

/** One tick's plan: blit, render the changing run, blit. */
export interface IncrementalFrame {
  blitBelow: (ctx: CanvasRenderingContext2D) => void;
  changingOnly: ReadonlySet<string>;
  blitAbove: (ctx: CanvasRenderingContext2D) => void;
}

export interface IncrementalScene {
  /**
   * Prepare (or re-use) the bake for this tick. Returns null when the surface
   * should just render normally — which is the answer for every refusal, and
   * the default whenever anything is uncertain.
   */
  prepare: (
    doc: MotionDocument,
    frames: readonly Frame[],
    changing: ReadonlySet<string>,
    viewKey: string,
    paint: ScenePaint,
  ) => IncrementalFrame | null;
  /** The edit ended — the next tick renders the whole scene for real. */
  end: () => void;
}

const PAYOFF_ALPHA = 0.3;
/** Below this, a bake is not surviving long enough to pay for itself. */
const MIN_PAYOFF = 1;

/**
 * A SURFACE'S OWN incremental scene. The stage has one; the effect editor's
 * preview has another — different framing, different pixels, the same cut and
 * the same verification. Two surfaces sharing one module-level bake would
 * throw each other's away on every tick.
 */
export function createIncrementalScene(): IncrementalScene {
  let cut: ScenePartition | null = null;

  /**
   * DOES BAKING ACTUALLY PAY HERE?
   *
   * A bake is roughly one full render's work, split in two: `below` and `above`
   * together cover every layer that is not changing. It buys nothing on the tick
   * it happens — it pays only when the NEXT tick reuses it. Reused once it breaks
   * even; reused many times it is the whole point; reused never it is a straight
   * doubling, because that tick pays the bake AND the changing render.
   *
   * That last case is not hypothetical, and it shipped: the bake is tied to the
   * camera (it holds device pixels at one view), so panning invalidates it. While
   * this only ran during a layer drag that could not happen — you are not panning
   * and dragging at once. The moment it was generalised to any edit, "in text
   * mode, panning" became two full renders per tick where there had been one.
   *
   * So the deal is measured rather than assumed. Every bake records how many
   * ticks the PREVIOUS one survived, and a run of bakes that die immediately
   * turns partitioning off until the scene stops fighting it. A mechanism that
   * can make things worse has to be able to notice.
   */
  let reusesSinceBake = 0;
  let payoff = 2;

  function notePayoff(): void {
    payoff = payoff * (1 - PAYOFF_ALPHA) + reusesSinceBake * PAYOFF_ALPHA;
    reusesSinceBake = 0;
  }

  /** The scene changed shape — forget what we learned about the old one. */
  function resetPayoff(): void {
    payoff = 2;
    reusesSinceBake = 0;
  }
  let baked: Baked | null = null;

  /** The edit ended — the next tick renders the whole scene for real. */
  function end(): void {
    cut = null;
    baked = null;
    resetPayoff();
  }

  /**
   * Is the bake still the truth? Everything except the changing clips must be the
   * object it was — which immer makes exact rather than approximate.
   */
  function stillValid(doc: MotionDocument, viewKey: string, width: number, height: number): boolean {
    const b = baked;
    const c = cut;
    if (!b || !c) return false;
    if (b.width !== width || b.height !== height) return false;
    if (b.viewKey !== viewKey) return false;
    if (b.frames !== doc.frames) return false;
    let seen = 0;
    for (const t of doc.tracks) {
      for (const clip of t.clips) {
        if (c.changing.has(clip.id)) continue;
        if (b.rest.get(clip.id) !== clip) return false;
        seen++;
      }
    }
    // A clip appeared or vanished (⌥-duplicate mid-drag, a delete) — the bake
    // was cut around a scene that no longer exists.
    return seen === b.rest.size;
  }


  function prepare(
    doc: MotionDocument,
    frames: readonly Frame[],
    changing: ReadonlySet<string>,
    viewKey: string,
    paint: ScenePaint,
  ): IncrementalFrame | null {
    if (!cut || !setsEqual(cut.requested, changing)) {
      cut = partitionScene(doc, frames, changing);
      baked = null;
      resetPayoff();
    }
    if (!cut) return null;
    // Refuse while the bake is not surviving long enough to be worth making. It
    // recovers as soon as the edit scope changes (`resetPayoff`), so this is a
    // back-off and not a latch.
    if (payoff < MIN_PAYOFF) return null;

    if (!stillValid(doc, viewKey, paint.width, paint.height)) {
      notePayoff();
      if (payoff < MIN_PAYOFF) return null;
      const c = cut;
      const belowCanvas = baked?.belowCanvas ?? document.createElement("canvas");
      const aboveCanvas = baked?.aboveCanvas ?? document.createElement("canvas");
      // BELOW carries the board — frame fills and drop shadows — so the stage is
      // painted exactly once, underneath everything, as it always was.
      if (!bakeInto(belowCanvas, paint, c.below, true)) return null;
      if (!bakeInto(aboveCanvas, paint, c.above, false)) return null;
      const rest = new Map<string, Clip>();
      for (const t of doc.tracks) for (const clip of t.clips) if (!c.changing.has(clip.id)) rest.set(clip.id, clip);
      baked = {
        belowCanvas,
        aboveCanvas,
        width: paint.width,
        height: paint.height,
        viewKey,
        rest,
        frames: doc.frames,
      };
    }

    reusesSinceBake++;
    const b = baked!;
    return {
      blitBelow: (ctx) => blit(ctx, b.belowCanvas),
      changingOnly: cut.changing,
      blitAbove: (ctx) => blit(ctx, b.aboveCanvas),
    };
  }

  return { prepare, end };
}

/** The stage's. */
const stageScene = createIncrementalScene();
export const prepareIncrementalScene = stageScene.prepare;
export const endIncrementalScene = stageScene.end;

function blit(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(canvas, 0, 0);
  ctx.restore();
}

/**
 * Render one slice of the page into its own raster, at the live canvas size.
 *
 * Straight into the slice's own canvas — never via the visible one. Staging a
 * slice on the canvas the user is looking at means every re-bake momentarily
 * IS the picture on screen: half the scene, for however long the render takes.
 * On a heavy board that is tens of milliseconds of the layers below your
 * cursor simply not being there, which is what a "blink" is.
 */
function bakeInto(canvas: HTMLCanvasElement, paint: ScenePaint, only: ReadonlySet<string>, board: boolean): boolean {
  if (canvas.width !== paint.width || canvas.height !== paint.height) {
    canvas.width = paint.width;
    canvas.height = paint.height;
  }
  const c2d = canvas.getContext("2d");
  if (!c2d) return false;
  c2d.setTransform(1, 0, 0, 1, 0, 0);
  c2d.clearRect(0, 0, canvas.width, canvas.height);
  paint.paintSlice(c2d, only, board);
  return true;
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
