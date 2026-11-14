"use client";

import { StrokeEngine, resolveColor, type DocumentStore, type PenSample, type RasterClip } from "@solomotion/core";
import { armedBrushFor, useBrushLibrary, useDrawing } from "../drawing/drawing-store";
import { commitDrawSurface, liveDrawPlan, planRasterDraw, seedDrawSurface, type DrawPlan } from "../drawing/capture-record";
import { abortStroke, beginStroke, commitStroke, paintIntoRaster, surfaceCanvas, type StrokeTx } from "../drawing/raster-store";
import { grainGatedBuffer, stampDabs } from "../drawing/dab-painter";
import { useSession } from "../state/session";
import { repaintPlanePicture } from "./plane-picture";

/**
 * PAINTING ON A PICTURE IN SPACE — the pixel brush, on a pixel layer standing
 * in a world. Nothing about the paint is 3D's own: the dabs come from core's
 * StrokeEngine with the armed pixel brush at its live size and pressure, are
 * stamped by the canvas's own dab painter into a stroke buffer, and land
 * through the same transaction the flat canvas uses (`paintIntoRaster` →
 * `commitStroke` → `commitDrawSurface`): one undo step, record-mode
 * snapshots honoured. What is 3D's alone is WHERE the pen is — the viewport
 * hands surface pixels, found by casting the pointer onto the layer's plane.
 *
 * While the pen is down the surface shows the stroke as it will commit (the
 * untouched pixels under the buffer at the stroke's opacity), so a stroke on a
 * tilted card is seen as it is painted.
 */
export class PlanePaint {
  readonly clipId: string;
  private readonly plan: DrawPlan;
  private readonly clip: RasterClip;
  private readonly tx: StrokeTx;
  private engine: StrokeEngine;
  private readonly brush = armedBrushFor("raster");
  private readonly color: string;
  private readonly opacity: number;
  private readonly buffer: HTMLCanvasElement;
  private readonly bufferCtx: CanvasRenderingContext2D;
  private readonly before: HTMLCanvasElement;
  private dirty: { x0: number; y0: number; x1: number; y1: number } | null = null;

  constructor(
    private readonly store: DocumentStore,
    source: RasterClip,
    private readonly onChange: () => void,
  ) {
    this.clipId = source.id;
    const session = useSession.getState();
    const drawing = useDrawing.getState();
    this.plan =
      planRasterDraw({ doc: store.getState(), clipId: source.id, playheadMs: session.playheadMs, recording: session.recording, seed: drawing.capture.seed }) ?? liveDrawPlan(source);
    seedDrawSurface(this.plan);
    this.clip = { ...source, surfaceId: this.plan.surfaceId, rev: this.plan.rev };
    this.tx = beginStroke(this.clip);
    this.engine = this.freshEngine();
    this.color = resolveColor(store.getState(), drawing.brush.color);
    this.opacity = useBrushLibrary.getState().effective(this.brush.id).opacity;
    this.buffer = document.createElement("canvas");
    this.buffer.width = this.clip.width;
    this.buffer.height = this.clip.height;
    this.bufferCtx = this.buffer.getContext("2d")!;
    // The pixels before the stroke, to composite under it as it grows.
    this.before = document.createElement("canvas");
    this.before.width = this.clip.width;
    this.before.height = this.clip.height;
    this.before.getContext("2d")!.drawImage(surfaceCanvas(this.clip), 0, 0);
  }

  private freshEngine(): StrokeEngine {
    const eff = useBrushLibrary.getState().effective(this.brush.id);
    return new StrokeEngine(this.brush, useDrawing.getState().pressure, eff.size, 1, Date.now() & 0xffff);
  }

  /**
   * The pen crossed a SEAM (on a mesh, the texture jumps to another part of
   * the comp): finish this run of the stroke and start the next where the pen
   * is now — one stroke, one undo step, never a line across the texture.
   */
  jump(): void {
    this.stamp(this.engine.finish());
    this.engine = this.freshEngine();
  }

  /** One pen sample, in the layer's surface pixels. */
  feed(sample: PenSample): void {
    this.stamp(this.engine.feed(sample));
  }

  private stamp(dabs: ReturnType<StrokeEngine["feed"]>): void {
    if (!dabs.length) return;
    const r = stampDabs({ ctx: this.bufferCtx }, dabs, this.brush, this.color);
    if (!r) return;
    // The layer does not grow from a 3D stroke: paint lands on the picture you aimed at.
    const c = { x0: Math.max(0, Math.floor(r.x0)), y0: Math.max(0, Math.floor(r.y0)), x1: Math.min(this.clip.width, Math.ceil(r.x1)), y1: Math.min(this.clip.height, Math.ceil(r.y1)) };
    if (c.x1 <= c.x0 || c.y1 <= c.y0) return;
    this.dirty = this.dirty ? { x0: Math.min(this.dirty.x0, c.x0), y0: Math.min(this.dirty.y0, c.y0), x1: Math.max(this.dirty.x1, c.x1), y1: Math.max(this.dirty.y1, c.y1) } : c;
    this.composite(c);
  }

  /** Under a region: the pixels as they were, then the stroke at its opacity — exactly what will commit. */
  private composite(r: { x0: number; y0: number; x1: number; y1: number }): void {
    const w = r.x1 - r.x0, h = r.y1 - r.y0;
    paintIntoRaster(this.tx, r, (ctx) => {
      ctx.clearRect(r.x0, r.y0, w, h);
      ctx.drawImage(this.before, r.x0, r.y0, w, h, r.x0, r.y0, w, h);
      ctx.globalAlpha = this.opacity;
      ctx.drawImage(grainGatedBuffer(this.buffer, this.brush), r.x0, r.y0, w, h, r.x0, r.y0, w, h);
    });
    repaintPlanePicture(this.clipId);
    this.onChange();
  }

  /** It was never a stroke (a second finger landed — a pinch): the pixels go back, nothing is recorded. */
  cancel(): void {
    abortStroke(this.tx);
    repaintPlanePicture(this.clipId);
    this.onChange();
  }

  /** The pen lifts: the stroke is one undo step. */
  end(): void {
    this.stamp(this.engine.finish());
    const next = this.clip.rev + 1;
    if (this.dirty && commitStroke(this.tx, next)) {
      this.store.update("Brush stroke", (d) => commitDrawSurface(d, this.clipId, this.plan, next, this.tx));
    } else commitStroke(this.tx, next);
    repaintPlanePicture(this.clipId);
    this.onChange();
  }
}
