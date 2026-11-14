"use client";

import { acquireTemp, nextOutput, releaseTemp, retainPixels, takeRetained } from "./buffers";

/**
 * THE DISPLACEMENT RESAMPLER — one bilinear sampler, four warp cards.
 *
 * Bulge, wave, twirl and lens distortion are the same machine: for each OUTPUT
 * pixel, ask where in the SOURCE it came from and sample there. Only that one
 * question differs between them. Writing four resamplers would have been four
 * chances to disagree about the three things that are easy to get wrong and
 * invisible until someone complains:
 *
 *   - EDGE HANDLING. Out of bounds returns transparent, not the clamped edge
 *     pixel. Clamping smears the border colour outward in a streak, which is
 *     the single most recognisable "cheap warp" artefact.
 *   - THE INVERSE DIRECTION. A warp is authored as "push the pixels outward",
 *     but a resampler needs "pull from further in". Each field below states the
 *     pull, and says so, because a sign error here produces a plausible-looking
 *     picture that is subtly wrong.
 *   - BILINEAR, NOT NEAREST. A magnifier at 3× on nearest neighbour is a
 *     mosaic, and no amount of softness hides it.
 *
 * `bounds` is what keeps it affordable. Bulge and twirl only touch a disc; a
 * layer is otherwise copied with one `drawImage` and the per-pixel loop runs
 * over a few hundred rows instead of a few thousand.
 */

/** Where output pixel (x, y) pulls from. Writes source coords into `out`. */
export type WarpField = (x: number, y: number, out: Float64Array) => void;

export interface RemapBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Sample `data` at a fractional position, bilinearly, into `rgba`.
 *
 * Premultiplication matters here and is the reason this is not four lines: a
 * canvas ImageData is UN-premultiplied, so interpolating a transparent pixel's
 * RGB (which is arbitrary, often black) against an opaque neighbour drags a
 * dark fringe along every soft edge. Weighting each channel by its own alpha
 * and dividing back out is what keeps a warped glow clean.
 */
export function sampleBilinear(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  x: number,
  y: number,
  rgba: Float64Array,
): void {
  if (x < -1 || y < -1 || x > w || y > h) {
    rgba[0] = rgba[1] = rgba[2] = rgba[3] = 0;
    return;
  }
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let j = 0; j < 2; j++) {
    const yy = y0 + j;
    if (yy < 0 || yy >= h) continue;
    const wy = j === 0 ? 1 - fy : fy;
    for (let i = 0; i < 2; i++) {
      const xx = x0 + i;
      if (xx < 0 || xx >= w) continue;
      const weight = wy * (i === 0 ? 1 - fx : fx);
      if (weight <= 0) continue;
      const o = (yy * w + xx) * 4;
      const av = data[o + 3]! / 255;
      const pw = weight * av;
      r += data[o]! * pw;
      g += data[o + 1]! * pw;
      b += data[o + 2]! * pw;
      a += weight * av;
    }
  }
  if (a <= 0.00001) {
    rgba[0] = rgba[1] = rgba[2] = rgba[3] = 0;
    return;
  }
  rgba[0] = r / a;
  rgba[1] = g / a;
  rgba[2] = b / a;
  rgba[3] = a * 255;
}

/**
 * A promise about a field that lets `remap` skip what cannot land ink: the
 * field is an AFFINE map (a shake, a twist) plus a wiggle no longer than
 * `slack` px. Then a tile's samples all come from the box its corners map to,
 * grown by the wiggle — and when the source is empty there, so is the tile.
 * A thin brush line on a comp-sized pixel layer is mostly empty, and pays only
 * for the tiles near its ink.
 */
export interface RemapSparse {
  slack: number;
}

const SPARSE_TILE = 16;

/** Tile occupancy of `data`'s alpha as a summed-area table, for O(1) "anything in this box?". */
function occupancyTable(data: Uint8ClampedArray, w: number, h: number): { cols: number; rows: number; sum: Int32Array } {
  const cols = Math.ceil(w / SPARSE_TILE);
  const rows = Math.ceil(h / SPARSE_TILE);
  const occ = new Uint8Array(cols * rows);
  for (let y = 0; y < h; y++) {
    const row = ((y / SPARSE_TILE) | 0) * cols;
    let i = y * w * 4 + 3;
    for (let x = 0; x < w; x++, i += 4) if (data[i] !== 0) occ[row + ((x / SPARSE_TILE) | 0)] = 1;
  }
  const sum = new Int32Array((cols + 1) * (rows + 1));
  for (let r = 0; r < rows; r++) {
    let line = 0;
    for (let c = 0; c < cols; c++) {
      line += occ[r * cols + c]!;
      sum[(r + 1) * (cols + 1) + c + 1] = sum[r * (cols + 1) + c + 1]! + line;
    }
  }
  return { cols, rows, sum };
}

/**
 * FLAT TILES: each tile's one colour (as the 32-bit pixel word), with `flat`
 * saying which tiles have one. A bounded warp of a flat neighbourhood returns
 * that colour at every pixel — bilinear between equal samples is the sample —
 * so such a tile is filled, never sampled. Paper-cut art is mostly flat fills:
 * a boiled hill's warp ran ~1 µs a pixel over a solid interior that came out
 * exactly as it went in.
 */
function flatTiles(words: Uint32Array, w: number, h: number, cols: number, rows: number): { colour: Uint32Array; flat: Uint8Array } {
  const colour = new Uint32Array(cols * rows);
  const flat = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const ya = r * SPARSE_TILE;
    const yb = Math.min(h, ya + SPARSE_TILE);
    for (let c = 0; c < cols; c++) {
      const xa = c * SPARSE_TILE;
      const xb = Math.min(w, xa + SPARSE_TILE);
      const first = words[ya * w + xa]!;
      let same = true;
      for (let y = ya; y < yb && same; y++) {
        const row = y * w;
        for (let x = xa; x < xb; x++) {
          if (words[row + x] !== first) {
            same = false;
            break;
          }
        }
      }
      if (same) {
        flat[r * cols + c] = 1;
        colour[r * cols + c] = first;
      }
    }
  }
  return { colour, flat };
}

/**
 * Run a warp field over an image. Pixels outside `bounds` are passed through
 * untouched, so a bounded warp costs what it covers; a `sparse` field also
 * skips every tile whose source neighbourhood is empty.
 */
export function remap(
  src: CanvasImageSource,
  w: number,
  h: number,
  field: WarpField,
  bounds?: RemapBounds,
  sparse?: RemapSparse,
): CanvasImageSource {
  if (w <= 0 || h <= 0) return src;
  const read = acquireTemp(w, h);
  read.ctx.drawImage(src, 0, 0);
  const source = read.ctx.getImageData(0, 0, w, h);
  const sdata = source.data;

  const x0 = Math.max(0, Math.floor(bounds?.x0 ?? 0));
  const y0 = Math.max(0, Math.floor(bounds?.y0 ?? 0));
  const x1 = Math.min(w, Math.ceil(bounds?.x1 ?? w));
  const y1 = Math.min(h, Math.ceil(bounds?.y1 ?? h));

  const out = nextOutput(w, h);
  if (x1 <= x0 || y1 <= y0) {
    out.ctx.drawImage(src, 0, 0);
    releaseTemp(read);
    return out.canvas;
  }

  const bw = x1 - x0;
  const bh = y1 - y0;
  const target = out.ctx.createImageData(bw, bh);
  const tdata = target.data;
  const rgba = new Float64Array(4);
  const at = new Float64Array(2);
  const run = (ax: number, ay: number, bx: number, by: number) => {
    for (let y = ay; y < by; y++) {
      for (let x = ax; x < bx; x++) {
        // Sample at the pixel CENTRE. Sampling at the corner shifts the whole
        // image half a pixel, which is invisible until you toggle the effect.
        field(x + 0.5, y + 0.5, at);
        sampleBilinear(sdata, w, h, at[0]!, at[1]!, rgba);
        const o = ((y - y0) * bw + (x - x0)) * 4;
        tdata[o] = rgba[0]!;
        tdata[o + 1] = rgba[1]!;
        tdata[o + 2] = rgba[2]!;
        tdata[o + 3] = rgba[3]!;
      }
    }
  };

  if (!sparse) {
    run(x0, y0, x1, y1);
  } else {
    const occ = occupancyTable(sdata, w, h);
    const stride = occ.cols + 1;
    const flats = flatTiles(new Uint32Array(sdata.buffer, sdata.byteOffset, w * h), w, h, occ.cols, occ.rows);
    const twords = new Uint32Array(tdata.buffer, tdata.byteOffset, bw * bh);
    /** One colour over the whole source box, or null. Out of bounds samples transparent, so the box must lie inside. */
    const flatColour = (minX: number, minY: number, maxX: number, maxY: number): number | null => {
      if (minX < 0 || minY < 0 || maxX >= w || maxY >= h) return null;
      const ca = Math.floor(minX / SPARSE_TILE);
      const cb = Math.floor(maxX / SPARSE_TILE);
      const ra = Math.floor(minY / SPARSE_TILE);
      const rb = Math.floor(maxY / SPARSE_TILE);
      const first = ra * occ.cols + ca;
      if (!flats.flat[first]) return null;
      const c = flats.colour[first]!;
      for (let r = ra; r <= rb; r++) for (let q = ca; q <= cb; q++) if (!flats.flat[r * occ.cols + q] || flats.colour[r * occ.cols + q] !== c) return null;
      return c;
    };
    const grow = 2 * Math.max(0, sparse.slack) + 2;
    for (let ty = y0; ty < y1; ty += SPARSE_TILE) {
      const tby = Math.min(y1, ty + SPARSE_TILE);
      for (let tx = x0; tx < x1; tx += SPARSE_TILE) {
        const tbx = Math.min(x1, tx + SPARSE_TILE);
        // Where the tile's corners sample from; the affine part maps the tile
        // inside their box, the wiggle reaches `slack` past it (both ends).
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const [cx, cy] of [[tx, ty], [tbx, ty], [tx, tby], [tbx, tby]] as const) {
          field(cx, cy, at);
          minX = Math.min(minX, at[0]!);
          maxX = Math.max(maxX, at[0]!);
          minY = Math.min(minY, at[1]!);
          maxY = Math.max(maxY, at[1]!);
        }
        const c0 = Math.max(0, Math.floor((minX - grow) / SPARSE_TILE));
        const c1 = Math.min(occ.cols, Math.floor((maxX + grow) / SPARSE_TILE) + 1);
        const r0 = Math.max(0, Math.floor((minY - grow) / SPARSE_TILE));
        const r1 = Math.min(occ.rows, Math.floor((maxY + grow) / SPARSE_TILE) + 1);
        if (c1 <= c0 || r1 <= r0) continue;
        const inked = occ.sum[r1 * stride + c1]! - occ.sum[r0 * stride + c1]! - occ.sum[r1 * stride + c0]! + occ.sum[r0 * stride + c0]!;
        // An empty neighbourhood samples nothing: the tile stays transparent,
        // exactly as the per-pixel loop would have left it.
        if (inked === 0) continue;
        // A flat one samples one colour everywhere: fill it (`flatTiles`).
        const flat = flatColour(minX - grow, minY - grow, maxX + grow, maxY + grow);
        if (flat === null) {
          run(tx, ty, tbx, tby);
          continue;
        }
        for (let y = ty; y < tby; y++) twords.fill(flat, (y - y0) * bw + (tx - x0), (y - y0) * bw + (tbx - x0));
      }
    }
  }

  // The untouched remainder first, then the warped window over it — one
  // `drawImage` instead of copying millions of pixels through the loop.
  if (bw !== w || bh !== h) out.ctx.drawImage(src, 0, 0);
  out.ctx.putImageData(target, x0, y0);
  releaseTemp(read);
  return out.canvas;
}

/** Read an image's pixels into an ImageData you may edit and hand back. */
export function readPixels(src: CanvasImageSource, w: number, h: number): { image: ImageData; buf: ReturnType<typeof acquireTemp> | null } {
  // The pass before this one may still be holding exactly these pixels — see
  // `retainPixels`. A hit skips a readback; a miss is the original path.
  const handed = takeRetained(src, w, h);
  if (handed) return { image: handed, buf: null };
  const buf = acquireTemp(w, h);
  buf.ctx.drawImage(src, 0, 0);
  return { image: buf.ctx.getImageData(0, 0, w, h), buf };
}

/** Put edited pixels into a fresh output buffer. */
export function writePixels(image: ImageData, w: number, h: number): CanvasImageSource {
  const out = nextOutput(w, h);
  out.ctx.putImageData(image, 0, 0);
  // These pixels and that canvas now agree, so the next pass in the chain can
  // have them instead of reading them back.
  retainPixels(out.canvas, image);
  return out.canvas;
}
