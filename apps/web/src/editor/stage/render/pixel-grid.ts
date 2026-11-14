"use client";

/**
 * Figma-style pixel grid — hairlines on every world-integer coordinate, fading
 * in past ~4× zoom and fully visible by ~10×. Drawn in SCREEN space over the
 * frame content and under the selection chrome, so it never touches how
 * layers render: raster pixels show their true cells, vectors stay vector.
 */

/** Zoom (css px per world px) where the grid starts fading in / is fully on. */
export const PIXEL_GRID_MIN_SCALE = 4;
const FULL_SCALE = 10;
const MAX_ALPHA = 0.22;

export function drawPixelGrid(
  ctx: CanvasRenderingContext2D,
  view: { scale: number; tx: number; ty: number },
  cssW: number,
  cssH: number,
): void {
  if (view.scale < PIXEL_GRID_MIN_SCALE) return;
  const alpha =
    Math.min((view.scale - PIXEL_GRID_MIN_SCALE) / (FULL_SCALE - PIXEL_GRID_MIN_SCALE), 1) *
    MAX_ALPHA;

  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const x0 = Math.floor(-view.tx / view.scale);
  const x1 = Math.ceil((cssW - view.tx) / view.scale);
  const y0 = Math.floor(-view.ty / view.scale);
  const y1 = Math.ceil((cssH - view.ty) / view.scale);

  ctx.save();
  ctx.strokeStyle = `rgba(140,140,150,${alpha})`;
  ctx.lineWidth = 1 / dpr; // one device pixel, regardless of zoom
  ctx.beginPath();
  for (let wx = x0; wx <= x1; wx++) {
    const sx = view.tx + wx * view.scale;
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, cssH);
  }
  for (let wy = y0; wy <= y1; wy++) {
    const sy = view.ty + wy * view.scale;
    ctx.moveTo(0, sy);
    ctx.lineTo(cssW, sy);
  }
  ctx.stroke();
  ctx.restore();
}
