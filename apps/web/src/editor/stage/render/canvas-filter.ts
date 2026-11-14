"use client";

import { applyColorAffines, colorAffineOf, filterCss, isIdentityFilterOp, type ColorAffine, type FilterOp } from "@solomotion/core";
import { hasCanvasFilter } from "./capabilities";
import { blurTo } from "./gaussian";
import { acquireTemp, releaseTemp, type Buf } from "./passes/buffers";

/**
 * THE ONE WAY TO DRAW THROUGH A FILTER.
 *
 * `drawFiltered(dst, src, ops)` is `drawImage` with a filter chain: on an
 * engine whose `ctx.filter` really filters (probed, `hasCanvasFilter`) it is
 * exactly that, on the GPU; on one that silently ignores it — WebKit, so every
 * iPad browser — the same ops run on the CPU (`blurTo`'s box blur, the spec's
 * colour matrices from core's `filter-ops`), and the picture is the same.
 *
 * Nothing in the renderer assigns `ctx.filter` itself. A seam that did was a
 * seam that vanished on an iPad: blur, adjust, a glow's bloom, a second shadow,
 * halftone softness — each one written straight onto the context, each one
 * absent without an error. A new seam that wants a filter calls this.
 */
export function drawFiltered(
  dst: CanvasRenderingContext2D,
  src: CanvasImageSource,
  ops: readonly FilterOp[],
  x = 0,
  y = 0,
  w?: number,
  h?: number,
): void {
  const live = ops.filter((op) => !isIdentityFilterOp(op));
  const { width: sw, height: sh } = sizeOf(src);
  const dw = w ?? sw;
  const dh = h ?? sh;
  const prev = dst.filter;
  if (live.length === 0 || sw <= 0 || sh <= 0) {
    dst.filter = "none";
    dst.drawImage(src, x, y, dw, dh);
    dst.filter = prev;
    return;
  }
  if (hasCanvasFilter()) {
    dst.filter = filterCss(live);
    dst.drawImage(src, x, y, dw, dh);
    dst.filter = prev;
    return;
  }
  const out = filterOnCpu(src, sw, sh, live);
  dst.filter = "none";
  dst.drawImage(out.canvas, 0, 0, sw, sh, x, y, dw, dh);
  dst.filter = prev;
  releaseTemp(out);
}

function sizeOf(src: CanvasImageSource): { width: number; height: number } {
  const s = src as { width?: number | SVGAnimatedLength; height?: number | SVGAnimatedLength; videoWidth?: number; videoHeight?: number; naturalWidth?: number; naturalHeight?: number };
  if (typeof s.videoWidth === "number" && s.videoWidth > 0) return { width: s.videoWidth, height: s.videoHeight ?? 0 };
  if (typeof s.naturalWidth === "number" && s.naturalWidth > 0) return { width: s.naturalWidth, height: s.naturalHeight ?? 0 };
  return { width: typeof s.width === "number" ? s.width : 0, height: typeof s.height === "number" ? s.height : 0 };
}

/** The ops, in order, on the CPU. Returns a temp buffer the caller releases. */
function filterOnCpu(src: CanvasImageSource, w: number, h: number, ops: readonly FilterOp[]): Buf {
  let cur = acquireTemp(w, h);
  cur.ctx.drawImage(src, 0, 0, w, h);
  let colour: ColorAffine[] = [];
  const flushColour = () => {
    if (colour.length === 0) return;
    const img = cur.ctx.getImageData(0, 0, w, h);
    applyColorAffines(img.data, colour);
    cur.ctx.putImageData(img, 0, 0);
    colour = [];
  };
  for (const op of ops) {
    const affine = colorAffineOf(op);
    if (affine) {
      colour.push(affine);
      continue;
    }
    flushColour();
    if (op.kind === "blur") {
      const next = acquireTemp(w, h);
      blurTo(next.ctx, cur.canvas, w, h, op.px);
      releaseTemp(cur);
      cur = next;
    } else if (op.kind === "dropShadow") {
      // CSS drop-shadow's length is a box-shadow blur — twice the deviation.
      const shade = acquireTemp(w, h);
      blurTo(shade.ctx, cur.canvas, w, h, op.blur / 2);
      shade.ctx.globalCompositeOperation = "source-in";
      shade.ctx.fillStyle = op.color;
      shade.ctx.fillRect(0, 0, w, h);
      shade.ctx.globalCompositeOperation = "source-over";
      const next = acquireTemp(w, h);
      next.ctx.drawImage(shade.canvas, op.x, op.y);
      next.ctx.drawImage(cur.canvas, 0, 0);
      releaseTemp(shade);
      releaseTemp(cur);
      cur = next;
    }
  }
  flushColour();
  return cur;
}

/** Blur only — the commonest ask, spelled out. */
export function drawBlurred(dst: CanvasRenderingContext2D, src: CanvasImageSource, px: number, x = 0, y = 0, w?: number, h?: number): void {
  drawFiltered(dst, src, [{ kind: "blur", px }], x, y, w, h);
}

/**
 * PAINT through a filter: `paint(ctx)` draws anything — paths, text, images —
 * and the whole of it is filtered as ONE picture. The paint lands in a buffer
 * carrying the destination's transform and alpha, and that buffer goes through
 * `drawFiltered` once — the GPU filter where the engine has one, the CPU ops
 * where it does not — composited with the destination's blend.
 *
 * Never `ctx.filter` around the paint itself. A context filter applies per
 * DRAW CALL, not per paint: a colour halftone fills each of its ~10,000 dots
 * on its own, and ten thousand filtered fills is ten thousand offscreen blur
 * layers. On Chrome (Metal and SwiftShader alike) that ran for seconds and
 * then LOST THE GPU CONTEXT — every 2D canvas on the page wiped, the stage and
 * its chrome gone black. One filtered `drawImage` is one layer whatever the
 * paint drew, and it is the same picture the CPU path always gave.
 *
 * `bounds` (in the CURRENT transform's space) keeps that buffer to what the
 * paint can reach: a blurred letter should cost a letter, not the canvas. It
 * is grown by the filter's own reach here; the caller pads for anything its
 * paint draws outside the box (an extrusion, a stroke).
 */
export function paintFiltered(
  dst: CanvasRenderingContext2D,
  ops: readonly FilterOp[],
  paint: (ctx: CanvasRenderingContext2D) => void,
  bounds?: { x: number; y: number; w: number; h: number },
): void {
  const live = ops.filter((op) => !isIdentityFilterOp(op));
  if (live.length === 0) {
    paint(dst);
    return;
  }
  const m = dst.getTransform();
  const cw = dst.canvas.width;
  const ch = dst.canvas.height;
  let ax = 0;
  let ay = 0;
  let bx = cw;
  let by = ch;
  if (bounds) {
    const reach = filterReach(live) * Math.max(1, (Math.hypot(m.a, m.b) + Math.hypot(m.c, m.d)) / 2);
    const pts = [
      m.transformPoint({ x: bounds.x, y: bounds.y }),
      m.transformPoint({ x: bounds.x + bounds.w, y: bounds.y }),
      m.transformPoint({ x: bounds.x, y: bounds.y + bounds.h }),
      m.transformPoint({ x: bounds.x + bounds.w, y: bounds.y + bounds.h }),
    ];
    ax = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.x)) - reach));
    ay = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.y)) - reach));
    bx = Math.min(cw, Math.ceil(Math.max(...pts.map((p) => p.x)) + reach));
    by = Math.min(ch, Math.ceil(Math.max(...pts.map((p) => p.y)) + reach));
    if (bx <= ax || by <= ay) return;
  }
  const w = bx - ax;
  const h = by - ay;
  const layer = acquireTemp(w, h);
  layer.ctx.setTransform(new DOMMatrix([1, 0, 0, 1, -ax, -ay]).multiply(m));
  layer.ctx.globalAlpha = dst.globalAlpha;
  // The blend is the destination's, applied ONCE as the layer lands (the
  // `save` below keeps it). Copying it into the empty layer as well applied it
  // twice — and an erase or a mask op there erased nothing, so it drew nothing.
  paint(layer.ctx);
  dst.save();
  dst.setTransform(1, 0, 0, 1, 0, 0);
  dst.globalAlpha = 1;
  drawFiltered(dst, layer.canvas, live, ax, ay);
  dst.restore();
  releaseTemp(layer);
}

/** How far past its input a filter chain can put ink, in its own px. */
function filterReach(ops: readonly FilterOp[]): number {
  let r = 0;
  for (const op of ops) {
    if (op.kind === "blur") r += op.px * 3;
    else if (op.kind === "dropShadow") r += Math.abs(op.x) + Math.abs(op.y) + op.blur * 1.5;
  }
  return Math.ceil(r) + 2;
}
