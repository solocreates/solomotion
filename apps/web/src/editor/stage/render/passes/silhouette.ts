"use client";

import type { LightningOutline } from "@solomotion/core";
import { acquireTemp, releaseTemp } from "./buffers";

/**
 * THE LAYER'S OUTLINE, as points — traced from alpha at draw time.
 *
 * Some effects need to run ALONG a layer rather than over it (lightning's edge
 * mode today; a crawling marquee or a path-following particle tomorrow). Every
 * one of them wants the same thing and would otherwise write the same tracer,
 * so it lives here once.
 *
 * Two decisions worth stating:
 *
 *  - IT TRACES A DOWNSAMPLED MASK. A 3840px layer traced at full resolution
 *    yields ten thousand points to describe a shape a hundred would carry, and
 *    costs a full-frame `getImageData`. 320px on the long side is plenty for
 *    something that is about to be displaced by a noise field anyway — and
 *    a vector layer never comes here at all: its real geometry is handed to
 *    the brain up front (see `vectorOutline` in draw-frame).
 *  - IT DILATES FIRST. A word of text is a dozen separate glyph contours, and
 *    an arc that crawls around one letter of six reads as a bug. Growing the
 *    mask by a couple of cells welds neighbouring glyphs into one silhouette,
 *    which is both the better picture and the one people mean by "around it".
 */

const TRACE_MAX = 320;

/** Moore-neighbour offsets, clockwise from east. */
const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

/**
 * The outer contours of a layer's alpha — every separate blob, in PASS
 * pixels — as the outline the lightning brain runs on, or null when there is
 * nothing solid enough to trace. Holes are not traced: an arc crawls round
 * the outside of a letter, which is what "around it" means.
 */
export function traceSilhouette(src: CanvasImageSource, w: number, h: number): LightningOutline | null {
  if (w <= 0 || h <= 0) return null;
  const scale = Math.min(1, TRACE_MAX / Math.max(w, h));
  const tw = Math.max(4, Math.round(w * scale));
  const th = Math.max(4, Math.round(h * scale));

  const small = acquireTemp(tw, th);
  // The dilation is a cheap 8-way smear rather than a proper morphological
  // pass: at this resolution the difference is under a pixel and the point is
  // only to close the gaps between glyphs.
  small.ctx.imageSmoothingQuality = "high";
  for (const [dx, dy] of NEIGHBOURS) small.ctx.drawImage(src, dx, dy, w, h, 0, 0, tw, th);
  small.ctx.drawImage(src, 0, 0, w, h, 0, 0, tw, th);
  const data = small.ctx.getImageData(0, 0, tw, th).data;
  releaseTemp(small);

  const solid = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < tw && y < th && data[(y * tw + x) * 4 + 3]! > 64;
  // Pixels already claimed by a traced contour, plus every pixel of the blob
  // they enclose (flood-filled), so a second seed never re-traces a blob.
  const claimed = new Uint8Array(tw * th);

  const contours: Array<Array<{ x: number; y: number }>> = [];
  const sx = w / tw;
  const sy = h / th;
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      if (!solid(x, y) || claimed[y * tw + x]) continue;
      // The first unclaimed solid pixel in scan order is on the outer contour
      // of its own blob.
      const pts = traceFrom(x, y, solid, tw, th);
      claimBlob(x, y, solid, claimed, tw, th);
      if (pts.length < 8) continue;
      // Thin the contour: consecutive pixels are a step apart, and a path
      // this dense makes every downstream displacement invisible.
      const stride = Math.max(1, Math.floor(pts.length / 400));
      const thinned = stride === 1 ? pts : pts.filter((_, i) => i % stride === 0);
      contours.push(thinned.map((p) => ({ x: (p.x + 0.5) * sx, y: (p.y + 0.5) * sy })));
    }
  }
  if (contours.length === 0) return null;
  return { contours, closed: contours.map(() => true), width: w, height: h };
}

/** Moore-neighbour trace of one blob's outer contour from a scan-order seed. */
function traceFrom(
  sx: number,
  sy: number,
  solid: (x: number, y: number) => boolean,
  tw: number,
  th: number,
): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  let cx = sx;
  let cy = sy;
  // Entered from the west, so the search starts looking north-west and walks
  // clockwise — the standard Moore start that keeps the trace outside the blob.
  let dir = 6;
  const maxSteps = tw * th * 4;
  for (let step = 0; step < maxSteps; step++) {
    points.push({ x: cx, y: cy });
    let moved = false;
    for (let k = 0; k < 8; k++) {
      const d = (dir + k) % 8;
      const [ox, oy] = NEIGHBOURS[d]!;
      const nx = cx + ox;
      const ny = cy + oy;
      if (!solid(nx, ny)) continue;
      cx = nx;
      cy = ny;
      // Back up two so the next search starts just behind where we came from,
      // which is what keeps the walk hugging the boundary instead of cutting
      // across the interior.
      dir = (d + 6) % 8;
      moved = true;
      break;
    }
    if (!moved) break;
    if (cx === sx && cy === sy && points.length > 8) break;
  }
  return points;
}

/** Flood-fill (4-way) the blob under a seed into `claimed`. */
function claimBlob(
  sx: number,
  sy: number,
  solid: (x: number, y: number) => boolean,
  claimed: Uint8Array,
  tw: number,
  th: number,
): void {
  const stack = [sy * tw + sx];
  claimed[sy * tw + sx] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % tw;
    const y = (i - x) / tw;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= tw || ny >= th) continue;
      const j = ny * tw + nx;
      if (claimed[j] || !solid(nx, ny)) continue;
      claimed[j] = 1;
      stack.push(j);
    }
  }
}
