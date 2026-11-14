"use client";

import { rand01, twoInkSeparator } from "@solomotion/core";
import { drawBlurred, paintFiltered } from "../canvas-filter";
import { acquireTemp, nextOutput, releaseTemp, shiftClamped } from "./buffers";
import { readPixels, writePixels } from "./resample";
import type { PassFn } from "./types";

/**
 * PATTERN & SURFACE — halftone, pixelate, bevel.
 *
 * Halftone and pixelate share the same first move: DOWNSAMPLE the layer to one
 * pixel per cell, which the GPU does for free through `drawImage`, and read the
 * cell colours out of that tiny image instead of averaging millions of pixels
 * in JavaScript. A 1920×1080 layer at a 10px screen is 192×108 reads — which
 * is why a halftone can run during playback at all.
 */

// ── Halftone ─────────────────────────────────────────────────────────────────
/** The four process angles. A real rosette is what stops CMYK reading as mud. */
const CMYK_SCREENS: Array<{ angle: number; color: string; channel: 0 | 1 | 2 | 3 }> = [
  { angle: 15, color: "#00ffff", channel: 0 },
  { angle: 75, color: "#ff00ff", channel: 1 },
  { angle: 0, color: "#ffff00", channel: 2 },
  { angle: 45, color: "#000000", channel: 3 },
];

/**
 * ADD one mark to the current path — never fill it. A screen is thousands of
 * dots in one ink, and a fill per dot was a draw call per dot: a 1080² layer at
 * a 14 px screen is ~12,000 fills, which is where a halftone's half second a
 * frame went. The caller fills once per ink (`screenOnce`). Rects share the
 * path's winding, so a cross's two bars union under the nonzero rule.
 */
function addMark(
  ctx: CanvasRenderingContext2D,
  shape: string,
  x: number,
  y: number,
  r: number,
  cell: number,
  cos = 1,
  sin = 0,
): void {
  switch (shape) {
    case "square":
      ctx.rect(x - r, y - r, r * 2, r * 2);
      break;
    case "line":
      // Tone carried by line WEIGHT, which is what an engraving does — a line
      // screen that varies length instead would read as a dashed grid. The
      // segment runs ALONG the screen angle (a hair longer than its cell, so
      // neighbours weld): an axis-aligned box at 32° broke every line into a
      // staircase that read as woven cloth, not a burin cut.
      {
        const hl = cell / 2 + 0.35;
        const ax = cos * hl;
        const ay = sin * hl;
        const nx = -sin * r;
        const ny = cos * r;
        ctx.moveTo(x - ax + nx, y - ay + ny);
        ctx.lineTo(x + ax + nx, y + ay + ny);
        ctx.lineTo(x + ax - nx, y + ay - ny);
        ctx.lineTo(x - ax - nx, y - ay - ny);
        ctx.closePath();
      }
      break;
    case "cross":
      ctx.rect(x - cell / 2, y - r * 0.5, cell, r);
      ctx.rect(x - r * 0.5, y - cell / 2, r, cell);
      break;
    case "diamond":
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      break;
    default:
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
  }
}

function screenOnce(
  ctx: CanvasRenderingContext2D,
  small: ImageData,
  cols: number,
  rows: number,
  cell: number,
  angle: number,
  w: number,
  h: number,
  p: Extract<import("./types").LfxPass, { kind: "halftone" }>,
  /**
   * What sets a cell's ink: luminance, one CMYK channel, or — for a riso drum —
   * a function of the cell's byte offset returning that drum's coverage.
   */
  channel: 0 | 1 | 2 | 3 | "luma" | ((o: number) => number),
): void {
  const rad = (angle * Math.PI) / 180;
  const cx = w / 2;
  const cy = h / 2;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const maxR = (cell / 2) * Math.SQRT2;
  const data = small.data;
  const perDot = p.mode === "color";
  if (!perDot) ctx.beginPath();
  // A line screen is drawn ROW BY ROW as one tapered ribbon per unbroken run
  // (`addRibbon`), not a quad per cell: the quads overlapped their neighbours
  // so the lines would weld, and ~37,000 overlapping contours in one path cost
  // the rasteriser a second a frame at 1080² (dots, which do not overlap, took
  // 20 ms). A ribbon is also what a burin cut is — the weight swells and thins
  // along the line instead of stepping cell by cell.
  const ribbons = p.shape === "line" && !perDot;
  const run: number[] = [];

  for (let j = 0; j < rows; j++) {
    if (ribbons) addRibbon(ctx, run, cell, cos, sin);
    for (let i = 0; i < cols; i++) {
      const o = (j * cols + i) * 4;
      const a = data[o + 3]! / 255;
      if (a <= 0.004) {
        if (ribbons) addRibbon(ctx, run, cell, cos, sin);
        continue;
      }
      let v: number;
      if (typeof channel === "function") {
        v = channel(o);
      } else if (channel === "luma") {
        v = (0.2126 * data[o]! + 0.7152 * data[o + 1]! + 0.0722 * data[o + 2]!) / 255;
      } else if (channel === 3) {
        v = 1 - Math.max(data[o]!, data[o + 1]!, data[o + 2]!) / 255;
      } else {
        v = 1 - data[o + channel]! / 255;
      }
      // WHICH WAY THE DOTS GROW is a property of the MODE, not a constant.
      // Ink modes lay down more ink where the layer is DARK — that is what ink
      // does. Colour mode keeps each cell's own colour, so its dots have to
      // grow where the layer is BRIGHT, or a white logo screens as nothing and
      // the black background it never had screens as solid.
      const coverage = p.mode === "color" ? v : 1 - v;
      let tone = channel === "luma" ? (p.invert ? 1 - coverage : coverage) : typeof channel === "function" && p.invert ? 1 - v : v;
      tone = Math.min(1, Math.max(0, Math.pow(tone, 1 / Math.max(0.05, p.contrast))));
      // A dot's ink is its AREA (∝ r²), so its radius follows √tone. A line's
      // ink is its WEIGHT (∝ r): √tone there drew paper-white at 45 % ink and
      // turned every engraving into a grey screen. Lines touch at tone 1.
      const r = p.shape === "line" ? (cell / 2) * tone * a : maxR * Math.sqrt(tone) * a;
      if (r <= 0.05) {
        if (ribbons) addRibbon(ctx, run, cell, cos, sin);
        continue;
      }

      // Cell centre in SCREEN space, rotated back into layer space. Rotating
      // the grid (not the image) is what keeps the marks square to the screen
      // angle, which is the entire point of a screen angle.
      const gx = (i - cols / 2 + 0.5) * cell;
      const gy = (j - rows / 2 + 0.5) * cell;
      let x = cx + gx * cos - gy * sin;
      let y = cy + gx * sin + gy * cos;

      if (p.jitter > 0.01) {
        x += (rand01(1471, i, j) * 2 - 1) * p.jitter;
        y += (rand01(2531, i, j) * 2 - 1) * p.jitter;
      }
      if (p.spread > 0.01) {
        // Push outward from the centre. Animating this is the disintegration:
        // the picture keeps its dots and loses its shape.
        const dx = x - cx;
        const dy = y - cy;
        const d = Math.hypot(dx, dy) || 1;
        const push = p.spread * (0.35 + rand01(3617, i, j) * 0.65);
        x += (dx / d) * push;
        y += (dy / d) * push;
      }
      // Colour mode is the only one that repaints per cell, so it is the only
      // one that fills per dot; every other mode set its one ink before the
      // loop and fills its whole screen once, below.
      if (perDot) {
        ctx.fillStyle = `rgb(${data[o]},${data[o + 1]},${data[o + 2]})`;
        ctx.beginPath();
        addMark(ctx, p.shape, x, y, r, cell, cos, sin);
        ctx.fill();
      } else if (ribbons) run.push(x, y, r);
      else addMark(ctx, p.shape, x, y, r, cell, cos, sin);
    }
  }
  if (ribbons) addRibbon(ctx, run, cell, cos, sin);
  if (!perDot) ctx.fill();
}

/**
 * ADD one line-screen run — consecutive cells of one row, as `[x, y, r]`
 * triples — as a single closed ribbon: down one side through every cell's
 * weight, back up the other. The ends reach half a cell past the end cells,
 * as each cell's own segment did. Empties `run`.
 */
function addRibbon(ctx: CanvasRenderingContext2D, run: number[], cell: number, cos: number, sin: number): void {
  const n = run.length / 3;
  if (n === 0) return;
  const hl = cell / 2 + 0.35;
  const ax = cos * hl;
  const ay = sin * hl;
  // The normal to the line, per unit of weight.
  const nx = -sin;
  const ny = cos;
  const last = (n - 1) * 3;
  ctx.moveTo(run[0]! - ax + nx * run[2]!, run[1]! - ay + ny * run[2]!);
  for (let k = 0; k < n; k++) ctx.lineTo(run[k * 3]! + nx * run[k * 3 + 2]!, run[k * 3 + 1]! + ny * run[k * 3 + 2]!);
  ctx.lineTo(run[last]! + ax + nx * run[last + 2]!, run[last + 1]! + ay + ny * run[last + 2]!);
  ctx.lineTo(run[last]! + ax - nx * run[last + 2]!, run[last + 1]! + ay - ny * run[last + 2]!);
  for (let k = n - 1; k >= 0; k--) ctx.lineTo(run[k * 3]! - nx * run[k * 3 + 2]!, run[k * 3 + 1]! - ny * run[k * 3 + 2]!);
  ctx.lineTo(run[0]! - ax - nx * run[2]!, run[1]! - ay - ny * run[2]!);
  ctx.closePath();
  run.length = 0;
}

function halftonePass(p: Extract<import("./types").LfxPass, { kind: "halftone" }>, src: CanvasImageSource, w: number, h: number): CanvasImageSource {
  if (p.mix <= 0.001 || p.size < 1) return src;
  const cell = Math.max(1, p.size);
  // The grid is sized to the layer's DIAGONAL so a rotated screen still covers
  // the corners — a screen angle that leaves bare triangles is the classic bug.
  const diag = Math.hypot(w, h);
  const cols = Math.max(1, Math.ceil(diag / cell) + 2);
  const rows = cols;
  // One sample of the layer PER SCREEN ANGLE. Every screen used to read the
  // grid sampled at the card's own angle, so a CMYK screen drawn 75° round
  // printed the picture rotated by 75° against the others.
  const sample = (deg: number) => sampleScreen(src, w, h, cell, cols, rows, deg);

  const ink = acquireTemp(w, h);
  // Paper under the marks: always in duotone, and in any mode when asked —
  // without it the gaps are empty and, on an adjustment, show the plate.
  if (p.paper) {
    ink.ctx.fillStyle = p.paperColor;
    ink.ctx.fillRect(0, 0, w, h);
  }
  // The dots soften; the paper under them does not.
  paintFiltered(ink.ctx, p.softness > 0.01 ? [{ kind: "blur", px: cell * p.softness * 0.35 }] : [], (c) => {
    if (p.mode === "cmyk") {
      // Process inks are subtractive: four screens MULTIPLY into each other,
      // which is what builds a rosette instead of four flat overlays.
      c.globalCompositeOperation = "multiply";
      for (const screen of CMYK_SCREENS) {
        c.fillStyle = screen.color;
        screenOnce(c, sample(p.angle + screen.angle), cols, rows, cell, p.angle + screen.angle, w, h, p, screen.channel);
      }
      c.globalCompositeOperation = "source-over";
    } else if (p.mode === "riso") {
      // Two drums. Each cell's colour is SEPARATED into the two inks
      // (core `twoInkSeparator`), each drum screened at its own angle, and
      // the second lands `misregister` px off — the offset a riso prints.
      const paper = rgbTuple(p.paperColor);
      const inks = [rgbTuple(p.inkColor), rgbTuple(p.ink2Color)] as const;
      const separate = twoInkSeparator(paper, inks[0], inks[1]);
      const off = p.misregister;
      // The second drum reads the picture MOVED, its edges repeated
      // (`shiftClamped`). Moving its marks instead left a strip `off` px wide
      // along two sides with no second ink — a thin line of the first ink down
      // the frame's edge on every whole-frame Riso.
      const moved = off > 0 ? shiftClamped(src, w, h, off * 0.8, off * 0.6) : null;
      c.globalCompositeOperation = "multiply";
      inks.forEach((ink, drum) => {
        const deg = p.angle + drum * RISO_DRUM_ANGLE;
        const small = drum === 1 && moved ? sampleScreen(moved.canvas, w, h, cell, cols, rows, deg) : sample(deg);
        const d = small.data;
        const coverage = (o: number) => separate(d[o]!, d[o + 1]!, d[o + 2]!)[drum]!;
        c.fillStyle = `rgb(${ink[0]}, ${ink[1]}, ${ink[2]})`;
        screenOnce(c, small, cols, rows, cell, deg, w, h, p, coverage);
      });
      if (moved) releaseTemp(moved);
      c.globalCompositeOperation = "source-over";
    } else {
      c.fillStyle = p.mode === "color" ? "#ffffff" : p.inkColor;
      screenOnce(c, sample(p.angle), cols, rows, cell, p.angle, w, h, p, "luma");
    }
  });

  if (p.inside) {
    ink.ctx.globalCompositeOperation = "destination-in";
    ink.ctx.drawImage(src, 0, 0);
    ink.ctx.globalCompositeOperation = "source-over";
  }

  const out = nextOutput(w, h);
  if (p.mix < 0.999) out.ctx.drawImage(src, 0, 0);
  out.ctx.globalAlpha = p.mix;
  out.ctx.drawImage(ink.canvas, 0, 0);
  out.ctx.globalAlpha = 1;
  releaseTemp(ink);
  return out.canvas;
}

// ── Pixelate ─────────────────────────────────────────────────────────────────
function pixelatePass(p: Extract<import("./types").LfxPass, { kind: "pixelate" }>, src: CanvasImageSource, w: number, h: number): CanvasImageSource {
  if (p.mix <= 0.001 || p.size < 1) return src;
  const cw = Math.max(1, p.size * Math.max(0.1, p.aspect));
  const ch = Math.max(1, p.size);
  const cols = Math.max(1, Math.ceil(w / cw));
  const rows = Math.max(1, Math.ceil(h / ch));

  // One pixel per CELL, read on the cells' own grid. Squeezing the whole
  // picture into cols × rows instead made each cell read a slightly narrower
  // strip than it covers, so the mosaic drifted off the picture by up to a cell
  // toward the right and bottom edges. The picture is laid on a canvas exactly
  // the grid's size first — the last cells hang past its edge and read the
  // edge repeated, as the halftone screen does — and that is shrunk to one
  // pixel per cell in a single whole-pixel draw. (Shrinking under a transform,
  // or in pieces with fractional edges, left a dimmed last column where the
  // pieces' antialiased edges overlapped.)
  const gridW = cols * cw;
  const gridH = rows * ch;
  const grid = acquireTemp(Math.ceil(gridW), Math.ceil(gridH));
  drawEdgeRepeated(grid.ctx, src, w, h, gridW - w, gridH - h, false);
  const small = acquireTemp(cols, rows);
  small.ctx.imageSmoothingQuality = "high";
  small.ctx.drawImage(grid.canvas, 0, 0, gridW, gridH, 0, 0, cols, rows);
  releaseTemp(grid);

  const cells = acquireTemp(w, h);
  // The BOARD: the unlit panel behind every cell that has anything in it. An
  // LED is an emissive cell on a dark panel — leaving the gap empty showed
  // the picture the cells were sampled from (on an adjustment, the plate), so
  // a lit sign read as a blurred mosaic.
  const board = boardColor(p.board);
  if (p.shape === "square" && p.gap <= 0.001) {
    // The plain mosaic is a scale-up with smoothing off — no per-cell drawing
    // at all, which is why the common case is effectively free.
    cells.ctx.imageSmoothingEnabled = false;
    cells.ctx.drawImage(small.canvas, 0, 0, cols, rows, 0, 0, cols * cw, rows * ch);
    cells.ctx.imageSmoothingEnabled = true;
  } else {
    const data = small.ctx.getImageData(0, 0, cols, rows).data;
    const inset = p.gap * 0.5;
    if (board) {
      cells.ctx.fillStyle = board;
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          if (data[(j * cols + i) * 4 + 3]! > 1) cells.ctx.rect(i * cw, j * ch, cw, ch);
        }
      }
      cells.ctx.fill();
      cells.ctx.beginPath();
    }
    paintFiltered(cells.ctx, p.softness > 0.01 ? [{ kind: "blur", px: Math.min(cw, ch) * p.softness * 0.3 }] : [], (c) => {
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const o = (j * cols + i) * 4;
        const a = data[o + 3]! / 255;
        if (a <= 0.004) continue;
        c.fillStyle = `rgba(${data[o]},${data[o + 1]},${data[o + 2]},${a})`;
        const x = i * cw + cw / 2;
        const y = j * ch + ch / 2;
        const rx = (cw / 2) * (1 - inset * 2);
        const ry = (ch / 2) * (1 - inset * 2);
        if (p.shape === "dot") {
          c.beginPath();
          c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
          c.fill();
        } else if (p.shape === "diamond") {
          c.beginPath();
          c.moveTo(x, y - ry);
          c.lineTo(x + rx, y);
          c.lineTo(x, y + ry);
          c.lineTo(x - rx, y);
          c.closePath();
          c.fill();
        } else if (p.shape === "cross") {
          c.fillRect(x - rx, y - ry * 0.34, rx * 2, ry * 0.68);
          c.fillRect(x - rx * 0.34, y - ry, rx * 0.68, ry * 2);
        } else {
          c.fillRect(x - rx, y - ry, rx * 2, ry * 2);
        }
      }
    }
    });
  }
  releaseTemp(small);

  const out = nextOutput(w, h);
  if (p.mix < 0.999) out.ctx.drawImage(src, 0, 0);
  out.ctx.globalAlpha = p.mix;
  out.ctx.drawImage(cells.canvas, 0, 0);
  out.ctx.globalAlpha = 1;
  releaseTemp(cells);
  return out.canvas;
}

// ── Bevel & emboss ───────────────────────────────────────────────────────────
// The layer's alpha, blurred, IS the height field; its gradient gives the
// surface normal; the normal against the light gives the shading. The same
// physical core as liquid glass, minus the backdrop — which is why it costs a
// blur and a pixel loop instead of a scene render and a GL context.
function bevelPass(p: Extract<import("./types").LfxPass, { kind: "bevel" }>, src: CanvasImageSource, w: number, h: number): CanvasImageSource {
  if (p.depth <= 0.01 || p.strength <= 0.001) return src;
  const blurPx = Math.max(0.5, p.depth * (0.35 + p.softness * 0.9));
  const height = acquireTemp(w, h);
  drawBlurred(height.ctx, src, blurPx);
  const hd = height.ctx.getImageData(0, 0, w, h).data;

  const { image: srcImg, buf: srcBuf } = readPixels(src, w, h);
  const sd = srcImg.data;
  const shade = acquireTemp(w, h);
  const shadeImg = shade.ctx.createImageData(w, h);
  const od = shadeImg.data;

  const rad = (p.angle * Math.PI) / 180;
  const elev = (p.elevation * Math.PI) / 180;
  const lx = Math.cos(rad) * Math.cos(elev);
  const ly = Math.sin(rad) * Math.cos(elev);
  const lz = Math.sin(elev);
  // The gradient step scales with the slope width, or a deep bevel reads as a
  // hairline: the normal has to be measured across the ramp, not across a pixel.
  const step = Math.max(1, Math.round(blurPx * 0.6));
  const gain = p.strength * 6;
  const hi = hexRgb(p.highlightColor);
  const lo = hexRgb(p.shadowColor);
  const invert = p.style === "pillow" ? -1 : 1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const coverage = p.style === "outer" ? 255 - hd[o + 3]! : sd[o + 3]!;
      if (coverage <= 1 && p.style !== "outer") continue;
      const xl = Math.max(0, x - step);
      const xr = Math.min(w - 1, x + step);
      const yt = Math.max(0, y - step);
      const yb = Math.min(h - 1, y + step);
      const gx = (hd[(y * w + xr) * 4 + 3]! - hd[(y * w + xl) * 4 + 3]!) / 255;
      const gy = (hd[(yb * w + x) * 4 + 3]! - hd[(yt * w + x) * 4 + 3]!) / 255;
      const slope = Math.hypot(gx, gy);
      if (slope < 0.002) continue;
      // The normal tilts AWAY from rising alpha, so the lit side is the one the
      // surface climbs toward.
      const nx = -gx * gain * invert;
      const ny = -gy * gain * invert;
      const len = Math.hypot(nx, ny, 1);
      const lambert = (nx * lx + ny * ly + lz) / len;
      const lit = Math.max(0, lambert - lz) / Math.max(0.001, 1 - lz);
      const dark = Math.max(0, lz - lambert) / Math.max(0.001, lz + 0.001);
      const mask = p.style === "outer" ? Math.min(1, slope * 4) : sd[o + 3]! / 255;
      const a = (lit * p.highlightOpacity + dark * p.shadowOpacity) * mask;
      if (a <= 0.002) continue;
      const useHi = lit >= dark;
      const c = useHi ? hi : lo;
      od[o] = c.r;
      od[o + 1] = c.g;
      od[o + 2] = c.b;
      od[o + 3] = Math.min(255, a * 255);
    }
  }
  shade.ctx.putImageData(shadeImg, 0, 0);
  releaseTemp(height);
  releaseTemp(srcBuf);

  const out = nextOutput(w, h);
  if (p.style !== "emboss") out.ctx.drawImage(src, 0, 0);
  // Highlights screen and shadows multiply by default, both declared on the
  // card — the two halves of a bevel genuinely want different operators, and
  // baking that in is what makes "Metal" and "Letterpress" different presets
  // rather than different effects.
  out.ctx.globalCompositeOperation = (p.style === "emboss" ? "source-over" : p.highlightBlend) as GlobalCompositeOperation;
  out.ctx.drawImage(shade.canvas, 0, 0);
  out.ctx.globalCompositeOperation = "source-over";
  releaseTemp(shade);
  return out.canvas;
}

/** The board colour, or null when it is clear (nothing to paint). */
function boardColor(c: string): string | null {
  const t = c.trim().toLowerCase();
  if (!t || t === "transparent") return null;
  if (/^#([0-9a-f]{4}|[0-9a-f]{8})$/.test(t) && /^#(?:[0-9a-f]{3}0|[0-9a-f]{6}00)$/.test(t)) return null;
  return c;
}

/** The second riso drum's screen angle, from the first. */
const RISO_DRUM_ANGLE = 30;

/**
 * The layer sampled one pixel per halftone cell, through the INVERSE of the
 * screen's rotation, so cell (i, j) reads the pixels its mark will cover.
 */
function sampleScreen(src: CanvasImageSource, w: number, h: number, cell: number, cols: number, rows: number, deg: number): ImageData {
  const sampler = acquireTemp(cols, rows);
  sampler.ctx.imageSmoothingQuality = "high";
  sampler.ctx.translate(cols / 2, rows / 2);
  sampler.ctx.rotate((-deg * Math.PI) / 180);
  sampler.ctx.scale(1 / cell, 1 / cell);
  sampler.ctx.translate(-w / 2, -h / 2);
  // A screen cell straddling the picture's edge reads past it. Past the edge is
  // nothing, so that cell's dot shrank and every whole-frame screen had a pale
  // rim. The edge is REPEATED out to two cells (clamp-to-edge, as `shiftClamped`
  // does for a moved drum); a sprite's edge is clear, so it repeats nothing.
  drawEdgeRepeated(sampler.ctx, src, w, h, cell * 2, cell * 2, true);
  sampler.ctx.setTransform(1, 0, 0, 1, 0, 0);
  const small = sampler.ctx.getImageData(0, 0, cols, rows);
  releaseTemp(sampler);
  return small;
}

/**
 * Draw `src` with its edge pixels REPEATED `padX` / `padY` out past the right
 * and bottom (and, `both`, the left and top) — clamp-to-edge for a sampler
 * whose cells hang past the picture. Then the picture itself.
 */
function drawEdgeRepeated(g: CanvasRenderingContext2D, src: CanvasImageSource, w: number, h: number, padX: number, padY: number, both: boolean): void {
  if (padX > 0) g.drawImage(src, w - 1, 0, 1, h, w, 0, padX, h);
  if (padY > 0) g.drawImage(src, 0, h - 1, w, 1, 0, h, w, padY);
  if (padX > 0 && padY > 0) g.drawImage(src, w - 1, h - 1, 1, 1, w, h, padX, padY);
  if (both) {
    g.drawImage(src, 0, 0, 1, h, -padX, 0, padX, h);
    g.drawImage(src, 0, 0, w, 1, 0, -padY, w, padY);
    g.drawImage(src, 0, 0, 1, 1, -padX, -padY, padX, padY);
    g.drawImage(src, w - 1, 0, 1, 1, w, -padY, padX, padY);
    g.drawImage(src, 0, h - 1, 1, 1, -padX, h, padX, padY);
  }
  g.drawImage(src, 0, 0, w, h);
}

function rgbTuple(hex: string): [number, number, number] {
  const c = hexRgb(hex);
  return [c.r, c.g, c.b];
}

function hexRgb(hex: string): { r: number; g: number; b: number } {
  const s = hex.trim().replace(/^#/, "");
  const wide = s.length <= 4 ? s.split("").map((c) => c + c).join("") : s;
  return {
    r: parseInt(wide.slice(0, 2), 16) || 0,
    g: parseInt(wide.slice(2, 4), 16) || 0,
    b: parseInt(wide.slice(4, 6), 16) || 0,
  };
}

export const halftone: PassFn<"halftone"> = (p, src, w, h) => halftonePass(p, src, w, h);
export const pixelate: PassFn<"pixelate"> = (p, src, w, h) => pixelatePass(p, src, w, h);
export const bevel: PassFn<"bevel"> = (p, src, w, h) => bevelPass(p, src, w, h);
