/**
 * SCOPES — the measurement half of colour work, headless.
 *
 * Nobody buys lift/gamma/gain. People buy being able to SEE what they are
 * doing, on this frame, right now: a waveform says whether the sky is clipped, a
 * parade says which channel is carrying the cast, a vectorscope says whether the
 * skin tone is on the line. A grading page without scopes is a set of sliders
 * and a hope.
 *
 * Everything here takes RGBA bytes and returns density planes. No canvas, no
 * DOM, no colours — the painter decides how a density becomes light, and that
 * split is what lets the same scope run in a test, in a worker, and over an
 * exported frame as a quality gate.
 *
 * REC.709 throughout, because that is the space the app composites in and a
 * scope that measures a different space than the renderer is a scope that lies.
 */

/** One decoded frame at whatever resolution the caller sampled it at. */
export interface ScopeSource {
  width: number;
  height: number;
  /** RGBA, row-major, 4 bytes per pixel. */
  data: Uint8ClampedArray;
}

export type ScopeKind = "histogram" | "waveform" | "parade" | "vectorscope";

export interface ScopeOptions {
  /** Cells across the scope's horizontal axis. */
  width: number;
  /** Cells down its vertical axis (the value axis, for the trace scopes). */
  height: number;
  /**
   * Read every Nth pixel. A scope is a statistic, and a statistic over 250k
   * samples is indistinguishable from one over 8 million — so the default is
   * derived from the frame's own size rather than fixed, and a 4K plate costs
   * the same as a 720p one. This is the difference between a scope that updates
   * while you drag a wheel and one you turn off.
   */
  stride?: number;
}

/**
 * A scope's result: one density plane per channel the scope separates.
 *
 *   histogram   3 planes (R,G,B), height 1 — a distribution, not a trace.
 *   waveform    1 plane  — luma against x.
 *   parade      3 planes — R, G and B each against x, painted side by side.
 *   vectorscope 1 plane  — Cb/Cr occupancy on a square grid.
 *
 * Densities are normalised 0..1 against the plane's own peak, which is what
 * makes a scope readable on both a dark frame and a bright one. `peak` is kept
 * so a caller that wants absolute counts still has them.
 */
export interface ScopeData {
  kind: ScopeKind;
  width: number;
  height: number;
  planes: Float32Array[];
  peak: number;
  /** Pixels actually read — the denominator for any percentage readout. */
  samples: number;
}

/** Rec.709 luma, 0..1, from 8-bit channels. */
export function luma709(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * A stride that keeps roughly `target` samples however big the frame is.
 * Rounded to a whole pixel step, never below 1, and deliberately not a power of
 * two: a stride that shares a factor with the frame width walks the same columns
 * forever and turns a waveform into a comb.
 */
export function strideFor(width: number, height: number, target = 240_000): number {
  const total = width * height;
  if (total <= target) return 1;
  const s = Math.round(total / target);
  // Nudge off any common factor with the row length so the walk precesses.
  return width % s === 0 ? s + 1 : s;
}

function planes(count: number, size: number): Float32Array[] {
  return Array.from({ length: count }, () => new Float32Array(size));
}

function normalise(list: Float32Array[]): number {
  let peak = 0;
  for (const p of list) for (let i = 0; i < p.length; i++) if (p[i]! > peak) peak = p[i]!;
  if (peak > 0) for (const p of list) for (let i = 0; i < p.length; i++) p[i]! /= peak;
  return peak;
}

/**
 * Compute a scope. One entry point for all four, because the callers — a panel
 * that switches scope with a tab, an export QC pass — genuinely want them
 * interchangeable, and because the pixel walk is the expensive part and it is
 * identical in every case.
 */
export function computeScope(src: ScopeSource, kind: ScopeKind, opts: ScopeOptions): ScopeData {
  const stride = Math.max(1, opts.stride ?? strideFor(src.width, src.height));
  switch (kind) {
    case "histogram":
      return histogram(src, opts, stride);
    case "waveform":
      return trace(src, opts, stride, "luma");
    case "parade":
      return trace(src, opts, stride, "rgb");
    case "vectorscope":
      return vectorscope(src, opts, stride);
  }
}

/** Distribution of each channel across `width` bins. Height is 1 — the painter
 *  draws the curve; a 2-D histogram would just be a picture of a 1-D one. */
function histogram(src: ScopeSource, opts: ScopeOptions, stride: number): ScopeData {
  const bins = Math.max(2, opts.width);
  const out = planes(3, bins);
  const d = src.data;
  const step = stride * 4;
  let samples = 0;
  for (let i = 0; i < d.length; i += step) {
    if (d[i + 3]! < 8) continue; // transparent pixels are not picture
    out[0]![((d[i]! * (bins - 1)) / 255) | 0]! += 1;
    out[1]![((d[i + 1]! * (bins - 1)) / 255) | 0]! += 1;
    out[2]![((d[i + 2]! * (bins - 1)) / 255) | 0]! += 1;
    samples++;
  }
  const peak = normalise(out);
  return { kind: "histogram", width: bins, height: 1, planes: out, peak, samples };
}

/**
 * Waveform / parade: value against horizontal position.
 *
 * The vertical axis is inverted on write (row 0 = full white) so the painter can
 * blit rows straight down. Putting that here rather than in the painter means
 * every painter agrees, and a scope drawn upside down is not a bug anyone enjoys
 * finding twice.
 */
function trace(src: ScopeSource, opts: ScopeOptions, stride: number, mode: "luma" | "rgb"): ScopeData {
  const w = Math.max(2, opts.width);
  const h = Math.max(2, opts.height);
  const count = mode === "luma" ? 1 : 3;
  const out = planes(count, w * h);
  const d = src.data;
  const xScale = (w - 1) / Math.max(1, src.width - 1);
  const vScale = h - 1;

  // Walk by pixel index but keep the column, so the x axis is the real x axis.
  for (let i = 0, px = 0; i < d.length; i += stride * 4, px += stride) {
    if (d[i + 3]! < 8) continue;
    const x = ((px % src.width) * xScale) | 0;
    if (mode === "luma") {
      const y = ((1 - luma709(d[i]!, d[i + 1]!, d[i + 2]!)) * vScale) | 0;
      out[0]![y * w + x]! += 1;
    } else {
      for (let c = 0; c < 3; c++) {
        const y = ((1 - d[i + c]! / 255) * vScale) | 0;
        out[c]![y * w + x]! += 1;
      }
    }
  }
  const peak = normalise(out);
  return { kind: mode === "luma" ? "waveform" : "parade", width: w, height: h, planes: out, peak, samples: 0 };
}

/**
 * Vectorscope — Cb/Cr occupancy, origin at the centre, on a square grid.
 *
 * Rec.709 chroma rather than a hue/sat polar plot, because the graticule people
 * read (the six colour targets, and above all the SKIN TONE LINE at ~123°) is
 * defined in Cb/Cr. A hue/sat plot looks similar and puts every target in the
 * wrong place, which makes it worse than no scope at all.
 */
function vectorscope(src: ScopeSource, opts: ScopeOptions, stride: number): ScopeData {
  const n = Math.max(8, Math.min(opts.width, opts.height));
  const out = planes(1, n * n);
  const d = src.data;
  const half = (n - 1) / 2;
  for (let i = 0; i < d.length; i += stride * 4) {
    if (d[i + 3]! < 8) continue;
    const r = d[i]! / 255;
    const g = d[i + 1]! / 255;
    const b = d[i + 2]! / 255;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    // Rec.709 Cb/Cr, each in −0.5..0.5.
    const cb = (b - y) / 1.8556;
    const cr = (r - y) / 1.5748;
    const px = (half + cb * 2 * half) | 0;
    const py = (half - cr * 2 * half) | 0;
    if (px < 0 || py < 0 || px >= n || py >= n) continue;
    out[0]![py * n + px]! += 1;
  }
  const peak = normalise(out);
  return { kind: "vectorscope", width: n, height: n, planes: out, peak, samples: 0 };
}

/**
 * The six colour targets a vectorscope graticule draws, in the SAME normalised
 * square the plane uses (0..1 across, y down). 75% bars, the broadcast
 * reference. Exported so the painter never re-derives them — a graticule that
 * disagrees with the trace by a few degrees is invisible and wrong.
 */
export const VECTORSCOPE_TARGETS: Array<{ label: string; x: number; y: number }> = (() => {
  const bars: Array<[string, number, number, number]> = [
    ["R", 0.75, 0, 0],
    ["Yl", 0.75, 0.75, 0],
    ["G", 0, 0.75, 0],
    ["Cy", 0, 0.75, 0.75],
    ["B", 0, 0, 0.75],
    ["Mg", 0.75, 0, 0.75],
  ];
  return bars.map(([label, r, g, b]) => {
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const cb = (b - y) / 1.8556;
    const cr = (r - y) / 1.5748;
    return { label, x: 0.5 + cb, y: 0.5 - cr };
  });
})();

/** The skin-tone line's angle, in radians measured from the +Cb axis, y up.
 *  Every colourist checks faces against it; it is a constant, not a preference. */
export const SKIN_TONE_ANGLE = (123 * Math.PI) / 180;
