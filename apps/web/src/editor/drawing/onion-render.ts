"use client";

import {
  captureOnionGhosts,
  flipbookOnionAt,
  hopMatrix,
  hopPoseAt,
  multiply,
  onionGhosts,
  toArray,
  type MotionDocument,
  type EditContext,
  type Frame,
  type Mat2D,
  type OnionGhost,
  type OnionSettings,
} from "@solomotion/core";
import { drawFrameContent } from "../stage/render/draw-frame";

/**
 * Onion ghost rendering — an EDITOR overlay, deliberately outside the export
 * draw contract (ghosts must never render into an export). The stage calls
 * this right after painting the active drawing's frame: each ghost renders into
 * a scratch buffer, tints toward its past/future color, and composites at its
 * falloff alpha.
 *
 * Both ghost sources land here through the SAME tint/composite path — a
 * flipbook cell's drawing comp, and a single recorded layer at a neighbouring
 * capture frame. The only difference is what gets drawn into the scratch, which
 * is four lines below; everything that makes onion skinning *look* like onion
 * skinning is written once.
 */

let scratch: HTMLCanvasElement | null = null;

export function drawOnionGhosts(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  drawingFrame: Frame,
  settings: OnionSettings,
): void {
  drawGhostList(ctx, doc, onionGhosts(doc, drawingFrame.id, settings), drawingFrame.width, drawingFrame.height, settings);
}

/**
 * Composite a precomputed ghost list into the current transform, sized to
 * `width`×`height` (a cell drawing's dimensions, or the host comp's for a
 * recorded layer). Shared by the drilled-in drawing view (`drawOnionGhosts`),
 * the flipbook sheet — including EMPTY cells, where the ghosts are anchored to a
 * neighbor's pose (see `flipbookOnionAt`) — and recorded layers on the timeline.
 */
export function drawGhostList(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  ghosts: OnionGhost[],
  width: number,
  height: number,
  settings: OnionSettings,
): void {
  if (ghosts.length === 0) return;

  if (!scratch) scratch = document.createElement("canvas");
  if (scratch.width !== width || scratch.height !== height) {
    scratch.width = width;
    scratch.height = height;
  }
  const sctx = scratch.getContext("2d")!;

  for (const ghost of ghosts) {
    const source = doc.frames.find(
      (f) => f.id === (ghost.source === "drawing" ? ghost.drawingFrameId : ghost.frameId),
    );
    if (!source) continue;
    sctx.clearRect(0, 0, scratch.width, scratch.height);
    sctx.save();
    // A drawing ghost is a whole comp at its own time zero; a capture ghost is
    // ONE layer, drawn at the neighbouring frame's time — so its pose, effects
    // and opacity match the live layer without a second render path.
    drawFrameContent(
      sctx,
      doc,
      source,
      ghost.source === "capture" ? ghost.timeMs : 0,
      ghost.source === "capture"
        ? { transparent: true, only: new Set([ghost.clipId]) }
        : { transparent: true },
    );
    // Tint: colorize the ghost's own pixels toward the direction color.
    if (settings.tintStrength > 0) {
      sctx.globalCompositeOperation = "source-atop";
      sctx.globalAlpha = settings.tintStrength;
      sctx.fillStyle = ghost.color;
      sctx.fillRect(0, 0, scratch.width, scratch.height);
    }
    sctx.restore();

    ctx.save();
    ctx.globalAlpha = ghost.alpha;
    ctx.drawImage(scratch, 0, 0);
    ctx.restore();
  }
}


/** What the stage knows that onion skinning needs. */
export interface OnionStageState {
  playing: boolean;
  playheadMs: number;
  selectedClipIds: readonly string[];
  selectedFlipbookVoid: { flipbookId: string; trackId: string; ms: number } | null;
}

/**
 * ONION SKIN, drawn once, in WORLD space, for whatever you are editing.
 *
 * Ghosts belong to the EDIT TARGET, not to an artboard. They used to be painted
 * inside one frame's own draw pass, gated on `f.id === activeFrameId` — which
 * worked only while a drilled drawing surface was painted as a free-standing
 * artboard at its own page coordinates. The moment editing happens in place
 * (where it always happens now) that frame is never its own `f` in the page
 * loop, so the gate never fired and the ghosts silently stopped existing.
 *
 * So the ghosts ride the SAME chain the artwork rides: `ctx.matrix`, composed
 * with one more hop when the target is a flipbook SHEET and the ghosts are
 * anchored to a cell's pose. That hop is `hopMatrix` — the renderer's own
 * formula, pivot and shear included — instead of the translate/rotate/scale
 * this file used to re-derive, which ghosted a cell with a moved pivot half a
 * box away from the cell it was ghosting.
 *
 * Editor-only chrome: deliberately outside `drawFrameContent`, so an export can
 * never pick it up. Playback hides it (the classic onion rule).
 *
 * `g` must be in SCREEN space; the view matrix is applied here.
 */
export function drawOnionSkin(
  g: CanvasRenderingContext2D,
  doc: MotionDocument,
  state: OnionStageState,
  ctx: EditContext,
  view: { scale: number; tx: number; ty: number },
  settings: OnionSettings,
): void {
  if (!settings.enabled || state.playing) return;
  const target = ctx.target;

  const paint = (m: Mat2D, ghosts: OnionGhost[], width: number, height: number) => {
    if (ghosts.length === 0) return;
    g.save();
    g.transform(view.scale, 0, 0, view.scale, view.tx, view.ty);
    g.transform(...toArray(m));
    drawGhostList(g, doc, ghosts, width, height, settings);
    g.restore();
  };

  if (target.mode !== "flipbook") {
    paint(ctx.matrix, onionGhosts(doc, target.id, settings), target.width, target.height);
    return;
  }

  {
    // Sheet view: ghost the surrounding frames through the current slot's pose —
    // resolved even for an EMPTY cell (a void, or a blank cell not yet drawn),
    // so onion skinning still shows while you are about to draw.
    const v = state.selectedFlipbookVoid;
    const onSheet = v?.flipbookId === target.id;
    const plan = flipbookOnionAt(
      doc,
      target.id,
      state.playheadMs,
      state.selectedClipIds,
      onSheet ? v!.trackId : null,
      onSheet ? v!.ms : null,
      settings,
    );
    const drawing = plan ? doc.frames.find((x) => x.id === plan.anchorCell.sourceFrameId) : null;
    if (!plan || !drawing) return;
    const pose = hopPoseAt(plan.anchorCell, ctx.targetTimeMs);
    paint(multiply(ctx.matrix, hopMatrix(pose, target, drawing)), plan.ghosts, drawing.width, drawing.height);
    return;
  }

  // A RECORDED layer on an ordinary comp: ghost its neighbouring capture frames
  // in place. Same settings, same look, same pod — the only thing that differs
  // from a flipbook is where the frames live.
  for (const id of state.selectedClipIds) {
    paint(ctx.matrix, captureOnionGhosts(doc, id, ctx.targetTimeMs, settings), target.width, target.height);
  }
}
