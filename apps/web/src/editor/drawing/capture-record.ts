"use client";

import {
  canGrowRaster,
  growRasterClip,
  CAPTURE_PROPERTY,
  captureSurface,
  createId,
  locateClip,
  captureFps,
  captureLocalMs,
  planCapture,
  setKeyframe,
  type MotionDocument,
  type CaptureSeed,
  type RasterClip,
} from "@solomotion/core";
import { cloneSurfacePixels, writeSurface, type StrokeTx } from "./raster-store";

/**
 * Recording a PIXEL drawing over time — the web side of drawing/capture.
 *
 * The headless brain (`planCapture`) answers one question: does this stroke edit
 * the frame at the playhead, start a new one seeded from the frame before it, or
 * start a new blank one? This file is only the projection of that answer onto a
 * paint surface, plus the commit that stamps the key.
 *
 * Undo is per-frame: a snapshot has its own revision in `clip.captureRevs`,
 * bumped in the same doc update as the stroke, and `syncSurfacesToDocument` seeks
 * each snapshot surface to it — exactly how a plain raster layer's single `rev`
 * works, one per frame.
 *
 * A VECTOR layer is not here: it records through `geometry` keyframes, which is
 * the channel record mode, per-key easing, the curve editor and undo already
 * drive. Outlines tween; bitmaps can only hold.
 *
 * `planRasterDraw` is PURE (it decides; it doesn't write). The caller seeds,
 * paints, then commits inside the rev-bump update — one undo step for key +
 * pixels + revision together.
 */

export interface CaptureContext {
  doc: MotionDocument;
  clipId: string;
  /**
   * The raw playhead. Deliberately NOT a clip-local time: the local time a frame
   * is authored at has to come off the render clock (`captureLocalMs`), and a
   * caller handed that subtraction would sooner or later do it in raw ms and
   * write a frame the renderer cannot address.
   */
  playheadMs: number;
  recording: boolean;
  seed: CaptureSeed;
}

// ── Raster projection ───────────────────────────────────────────────────────

export interface DrawPlan {
  /** The surface to paint into (a snapshot, or the plain layer surface). */
  surfaceId: string;
  /** Its current revision (for the stroke's RasterTarget baseline). */
  rev: number;
  width: number;
  height: number;
  /** Clone these pixels into `surfaceId` before painting (a new frame's seed). */
  seedFrom: string | null;
  /** A brand-new blank surface must be materialised before painting. */
  seedBlank: boolean;
  /** Stamp a capture key here on commit (a NEW frame); null = editing existing. */
  keyTimeMs: number | null;
  /** A capture snapshot (bump captureRevs) vs the plain layer surface (bump rev). */
  isSnapshot: boolean;
  /** May this write grow the layer? Core `canGrowRaster`, asked ONCE, here,
   *  for the surface actually being written; pass it to `beginStroke`. */
  grows: boolean;
}

/** The plan for a layer with no capture in play — its own surface. */
export function liveDrawPlan(
  clip: Pick<RasterClip, "surfaceId" | "rev" | "width" | "height" | "crop" | "captureRevs">,
): DrawPlan {
  return {
    surfaceId: clip.surfaceId,
    rev: clip.rev,
    width: clip.width,
    height: clip.height,
    seedFrom: null,
    seedBlank: false,
    keyTimeMs: null,
    isSnapshot: false,
    grows: canGrowRaster(clip, "layer"),
  };
}

/** Decide where a stroke on a raster clip at clip-local `localMs` should paint. */
export function planRasterDraw(ctx: CaptureContext): DrawPlan | null {
  const loc = locateClip(ctx.doc, ctx.clipId);
  if (!loc || loc.clip.kind !== "raster") return null;
  const clip = loc.clip;
  const width = clip.width;
  const height = clip.height;
  const plan = planCapture({
    tracks: clip.keyframes,
    localMs: captureLocalMs(ctx.doc, clip, ctx.playheadMs),
    fps: captureFps(ctx.doc, clip),
    recording: ctx.recording,
    seed: ctx.seed,
    liveValue: clip.surfaceId,
  });

  if (plan.kind === "live") return liveDrawPlan(clip);
  // A snapshot never grows: every frame of a recording shares the layer's box.
  const grows = canGrowRaster(clip, "snapshot");
  if (plan.kind === "edit") {
    const sid = captureSurface(plan.value);
    return { surfaceId: sid, rev: clip.captureRevs?.[sid] ?? 0, width, height, seedFrom: null, seedBlank: false, keyTimeMs: null, isSnapshot: true, grows };
  }
  const seedFrom = plan.seedFrom ? captureSurface(plan.seedFrom) || null : null;
  return { surfaceId: createId("snap"), rev: 0, width, height, seedFrom, seedBlank: !seedFrom, keyTimeMs: plan.keyTimeMs, isSnapshot: true, grows };
}

/** Materialise the target surface before painting (clone the seed, or blank). */
export function seedDrawSurface(plan: DrawPlan): void {
  if (plan.seedFrom) cloneSurfacePixels(plan.seedFrom, plan.surfaceId, plan.width, plan.height);
  else if (plan.seedBlank) writeSurface(plan.surfaceId, plan.width, plan.height, () => {});
}

/**
 * Finalise a committed raster stroke: stamp the capture key for a new frame and
 * bump the frame's revision. Call INSIDE the same `store.update` that journals
 * the stroke, so key + pixels + revision are one undo step.
 */
export function commitDrawSurface(
  d: MotionDocument,
  clipId: string,
  plan: DrawPlan,
  nextRev: number,
  /**
   * The committed write. Its `pad` — the room the surface gained — lands HERE,
   * in the same update that bumps `rev`: a box one revision out of step with
   * its pixels is drawn squashed, and puts every earlier mark in the wrong
   * place on undo. Required, so no tool can commit pixels and forget geometry.
   */
  tx: Pick<StrokeTx, "pad">,
): void {
  const loc = locateClip(d, clipId);
  if (!loc || loc.clip.kind !== "raster") return;
  const clip = loc.clip;
  if (plan.keyTimeMs !== null) setKeyframe(clip.keyframes, CAPTURE_PROPERTY, plan.keyTimeMs, plan.surfaceId);
  if (plan.isSnapshot) {
    (clip.captureRevs ??= {})[plan.surfaceId] = nextRev;
  } else {
    clip.rev = nextRev;
  }
  growRasterClip(clip, tx.pad);
}
