"use client";

import type { WaveformStyle, WaveformTemplate } from "@solomotion/core";

/**
 * THE waveform-visualizer painter. The stage renderer (preview AND export),
 * the plugin's live previews and the preset thumbnails all draw through
 * `paintWaveform` — one function, so what you pick is what you preview is
 * what you export, by construction. Painters are pure: style + peaks + a
 * box, no time, no DOM.
 */

export const WAVEFORM_TEMPLATES: Array<{ id: WaveformTemplate; label: string }> = [
  { id: "bars", label: "Bars" },
  { id: "line", label: "Line" },
  { id: "area", label: "Area" },
  { id: "circular", label: "Circular" },
  { id: "dots", label: "Dots" },
];

/** Neighbor-averaging smoothing — 0 leaves peaks raw, 1 flows like liquid. */
export function smoothPeaks(peaks: Float32Array, amount: number): Float32Array {
  const radius = Math.round(amount * Math.max(1, peaks.length * 0.04));
  if (radius <= 0) return peaks;
  const out = new Float32Array(peaks.length);
  for (let i = 0; i < peaks.length; i++) {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(peaks.length - 1, i + radius); j++) {
      sum += peaks[j]!;
      n++;
    }
    out[i] = sum / n;
  }
  return out;
}

/** Deterministic synthetic peaks — preset thumbnails before any audio decodes. */
export function demoPeaks(bins: number): Float32Array {
  const peaks = new Float32Array(bins);
  for (let i = 0; i < bins; i++) {
    const t = i / bins;
    const beat = Math.max(0, Math.sin(t * Math.PI * 8)) ** 3;
    const flow = 0.35 + 0.3 * Math.sin(t * Math.PI * 3 + 1.2);
    const jitter = 0.18 * Math.abs(Math.sin(i * 12.9898) * 43758.5453 % 1);
    peaks[i] = Math.min(1, beat * 0.55 + flow + jitter);
  }
  return peaks;
}

/**
 * Paint peaks into a w×h box at (0,0) in the current ctx space. `resolve`
 * maps color tokens (`var:` or hex) to CSS colors — pass identity outside
 * the document renderer.
 */
export function paintWaveform(
  ctx: CanvasRenderingContext2D,
  style: WaveformStyle,
  rawPeaks: Float32Array,
  w: number,
  h: number,
  resolve: (color: string) => string = (c) => c,
): void {
  const peaks = smoothPeaks(rawPeaks, style.smoothing);
  const colorA = resolve(style.color);
  const colorB = style.color2 ? resolve(style.color2) : null;

  ctx.save();
  if (style.glow > 0) {
    // Canvas shadows blur in DEVICE px — scale by the current transform so the
    // glow is the same at any zoom and in exports (same trick as layer effects).
    const m = ctx.getTransform();
    const scale = (Math.hypot(m.a, m.b) + Math.hypot(m.c, m.d)) / 2 || 1;
    ctx.shadowColor = colorA;
    ctx.shadowBlur = style.glow * scale;
    // Self-contained: never inherit an ambient shadow offset from the caller —
    // the glow must stay centered on the bars at every zoom level.
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }

  // ORIENTATION seam — flip / rotate the WHOLE visualizer around the box center,
  // once, so every template painter (and export) inherits it for free. Bars grow
  // sideways at 90°, mirror at flipX/flipY. Peaks and glow all follow.
  const flipX = style.flipX ? -1 : 1;
  const flipY = style.flipY ? -1 : 1;
  if (flipX !== 1 || flipY !== 1 || (style.rotateDeg ?? 0) !== 0) {
    ctx.translate(w / 2, h / 2);
    if (style.rotateDeg) ctx.rotate((style.rotateDeg * Math.PI) / 180);
    ctx.scale(flipX, flipY);
    ctx.translate(-w / 2, -h / 2);
  }

  if (style.template === "bars") paintBars(ctx, style, peaks, w, h, colorA, colorB);
  else if (style.template === "line") paintLine(ctx, style, peaks, w, h, colorA, colorB);
  else if (style.template === "area") paintArea(ctx, style, peaks, w, h, colorA, colorB);
  else if (style.template === "circular") paintCircular(ctx, style, peaks, w, h, colorA, colorB);
  else paintDots(ctx, style, peaks, w, h, colorA, colorB);
  ctx.restore();
}

function level(style: WaveformStyle, peak: number): number {
  return Math.min(1, peak * style.amplitude);
}

function verticalGradient(
  ctx: CanvasRenderingContext2D,
  h: number,
  colorA: string,
  colorB: string | null,
): string | CanvasGradient {
  if (!colorB) return colorA;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, colorB);
  g.addColorStop(1, colorA);
  return g;
}

function paintBars(
  ctx: CanvasRenderingContext2D,
  style: WaveformStyle,
  peaks: Float32Array,
  w: number,
  h: number,
  colorA: string,
  colorB: string | null,
): void {
  ctx.fillStyle = verticalGradient(ctx, h, colorA, colorB);
  const slot = w / peaks.length;
  const barW = Math.max(1, slot * style.barFill);
  for (let i = 0; i < peaks.length; i++) {
    const v = level(style, peaks[i]!);
    const barH = Math.max(2, v * h);
    const x = i * slot + (slot - barW) / 2;
    const y = style.mirror ? (h - barH) / 2 : h - barH;
    const r = Math.min(barW / 2, barH / 2) * style.roundness;
    ctx.beginPath();
    ctx.roundRect(x, y, barW, barH, r);
    ctx.fill();
  }
}

/** Envelope points (bin centers → heights), shared by line + area. */
function envelope(style: WaveformStyle, peaks: Float32Array, w: number, h: number) {
  const pts: Array<{ x: number; y: number }> = [];
  const mid = h / 2;
  for (let i = 0; i < peaks.length; i++) {
    const v = level(style, peaks[i]!);
    const x = ((i + 0.5) / peaks.length) * w;
    pts.push({ x, y: style.mirror ? mid - (v * h) / 2 : h - v * h });
  }
  return pts;
}

/**
 * Trace a smooth curve through points (midpoint quadratics — Apple-style flow).
 * `move` starts a fresh subpath (a separate stroked line); pass `false` to
 * CONTINUE the current path with a line into the first point — which is what a
 * filled area needs so the upper + lower envelopes read as ONE closed region.
 * (A stray `moveTo` there splits the fill and the canvas auto-closes each half
 * with a diagonal — the "broken bowtie" the mirror-area presets used to show.)
 */
function traceCurve(
  ctx: CanvasRenderingContext2D,
  pts: Array<{ x: number; y: number }>,
  move = true,
): void {
  if (pts.length === 0) return;
  if (move) ctx.moveTo(pts[0]!.x, pts[0]!.y);
  else ctx.lineTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i]!.x + pts[i + 1]!.x) / 2;
    const my = (pts[i]!.y + pts[i + 1]!.y) / 2;
    ctx.quadraticCurveTo(pts[i]!.x, pts[i]!.y, mx, my);
  }
  const last = pts[pts.length - 1]!;
  ctx.lineTo(last.x, last.y);
}

function paintLine(
  ctx: CanvasRenderingContext2D,
  style: WaveformStyle,
  peaks: Float32Array,
  w: number,
  h: number,
  colorA: string,
  colorB: string | null,
): void {
  const pts = envelope(style, peaks, w, h);
  ctx.strokeStyle = verticalGradient(ctx, h, colorA, colorB);
  ctx.lineWidth = style.thickness;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  traceCurve(ctx, pts);
  if (style.mirror) {
    // The lower envelope, mirrored around the center line — a SEPARATE stroked
    // line, so it starts its own subpath (move = true).
    const mid = h / 2;
    const lower = pts.map((p) => ({ x: p.x, y: mid + (mid - p.y) })).reverse();
    traceCurve(ctx, lower, true);
  }
  ctx.stroke();
}

function paintArea(
  ctx: CanvasRenderingContext2D,
  style: WaveformStyle,
  peaks: Float32Array,
  w: number,
  h: number,
  colorA: string,
  colorB: string | null,
): void {
  const pts = envelope(style, peaks, w, h);
  ctx.fillStyle = verticalGradient(ctx, h, colorA, colorB);
  ctx.beginPath();
  traceCurve(ctx, pts);
  if (style.mirror) {
    // CONTINUE the same path down the right edge into the lower envelope, so
    // upper + lower close into one filled region (move = false = no subpath break).
    const mid = h / 2;
    const lower = pts.map((p) => ({ x: p.x, y: mid + (mid - p.y) })).reverse();
    traceCurve(ctx, lower, false);
  } else {
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
  }
  ctx.closePath();
  ctx.fill();
}

function paintCircular(
  ctx: CanvasRenderingContext2D,
  style: WaveformStyle,
  peaks: Float32Array,
  w: number,
  h: number,
  colorA: string,
  colorB: string | null,
): void {
  const cx = w / 2;
  const cy = h / 2;
  const outerMax = Math.min(w, h) / 2;
  const r0 = style.innerRadius * outerMax;
  const maxLen = Math.max(2, outerMax - r0);
  let stroke: string | CanvasGradient = colorA;
  if (colorB) {
    const g = ctx.createRadialGradient(cx, cy, r0, cx, cy, outerMax);
    g.addColorStop(0, colorA);
    g.addColorStop(1, colorB);
    stroke = g;
  }
  ctx.strokeStyle = stroke;
  ctx.lineWidth = style.thickness;
  ctx.lineCap = style.roundness > 0.5 ? "round" : "butt";
  const span = (style.spanDeg * Math.PI) / 180;
  const a0 = (style.startAngleDeg * Math.PI) / 180;
  ctx.beginPath();
  for (let i = 0; i < peaks.length; i++) {
    const v = level(style, peaks[i]!);
    const a = a0 + span * ((i + 0.5) / peaks.length);
    const len = Math.max(2, v * maxLen);
    // Mirror = spokes grow both ways from the ring; else outward only.
    const rIn = style.mirror ? Math.max(2, r0 - len * 0.35) : r0;
    const rOut = r0 + len;
    ctx.moveTo(cx + Math.cos(a) * rIn, cy + Math.sin(a) * rIn);
    ctx.lineTo(cx + Math.cos(a) * rOut, cy + Math.sin(a) * rOut);
  }
  ctx.stroke();
}

function paintDots(
  ctx: CanvasRenderingContext2D,
  style: WaveformStyle,
  peaks: Float32Array,
  w: number,
  h: number,
  colorA: string,
  colorB: string | null,
): void {
  const cols = peaks.length;
  const slot = w / cols;
  const dotR = Math.min(style.thickness, slot * style.barFill * 0.5);
  const rowStep = dotR * 2 + Math.max(1, dotR * 0.8);
  const rows = Math.max(3, Math.floor(h / rowStep));
  const fill = verticalGradient(ctx, h, colorA, colorB);
  for (let i = 0; i < cols; i++) {
    const v = level(style, peaks[i]!);
    const lit = Math.round(v * rows);
    const x = i * slot + slot / 2;
    for (let r = 0; r < rows; r++) {
      // EQ matrix: dots light up from the bottom (or outward from center).
      const litHere = style.mirror ? Math.abs(r - (rows - 1) / 2) <= lit / 2 && lit > 0 : rows - 1 - r < lit;
      const y = h - rowStep / 2 - r * rowStep;
      ctx.globalAlpha = litHere ? 1 : 0.12;
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(x, style.mirror ? h / 2 + (r - (rows - 1) / 2) * rowStep : y, dotR, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

// ── Presets ──────────────────────────────────────────────────────────────────

export interface WaveformPreset {
  id: string;
  name: string;
  category: WaveformCategory;
  style: Partial<WaveformStyle>;
}

/**
 * Preset categories, in intentional tab order (not derived, so the order is a
 * design decision). Every preset belongs to exactly one.
 */
export const WAVEFORM_PRESET_CATEGORIES = [
  "Music",
  "Podcast",
  "Minimal",
  "Cinematic",
  "Neon",
  "Radial",
  "Retro",
  "Ambient",
] as const;
export type WaveformCategory = (typeof WAVEFORM_PRESET_CATEGORIES)[number];

/** Ready-made looks — every preset is just values over the same style bag. */
export const WAVEFORM_PRESETS: WaveformPreset[] = [
  // ── Music ──────────────────────────────────────────────────────────────────
  { id: "classic-bars", name: "Classic Bars", category: "Music", style: { mode: "spectrum", template: "bars", color: "#8b5cf6", color2: "#ec4899", barCount: 64, barFill: 0.65, roundness: 0.4, mirror: true } },
  { id: "spotify-pulse", name: "Spotify Pulse", category: "Music", style: { mode: "spectrum", template: "bars", color: "#1DB954", color2: null, barCount: 48, barFill: 0.55, roundness: 1, mirror: true } },
  { id: "deep-bass", name: "Deep Bass", category: "Music", style: { mode: "spectrum", template: "bars", color: "#ff0080", color2: "#7928ca", barCount: 32, barFill: 0.8, roundness: 0.6, amplitude: 1.6, glow: 22, mirror: true } },
  { id: "dot-matrix", name: "Dot Matrix EQ", category: "Music", style: { mode: "spectrum", template: "dots", color: "#facc15", color2: "#f97316", barCount: 32, thickness: 5, mirror: false } },
  { id: "candy-pop", name: "Candy Pop", category: "Music", style: { mode: "spectrum", template: "bars", color: "#f472b6", color2: "#38bdf8", barCount: 40, barFill: 0.7, roundness: 1, glow: 8, mirror: true } },
  { id: "bass-drop", name: "Bass Drop", category: "Music", style: { mode: "spectrum", template: "bars", color: "#fb7185", color2: "#f59e0b", barCount: 24, barFill: 0.9, roundness: 0.3, amplitude: 2, mirror: false } },

  // ── Podcast ────────────────────────────────────────────────────────────────
  { id: "podcast-clean", name: "Podcast Clean", category: "Podcast", style: { mode: "waveform", template: "bars", color: "#e2e8f0", color2: null, barCount: 96, barFill: 0.5, roundness: 1, amplitude: 0.85, mirror: true } },
  { id: "broadcast-area", name: "Broadcast Area", category: "Podcast", style: { mode: "waveform", template: "area", color: "#64748b", color2: "#cbd5e1", smoothing: 0.5, amplitude: 0.9, mirror: true } },
  { id: "voice-note", name: "Voice Note", category: "Podcast", style: { mode: "waveform", template: "bars", color: "#38bdf8", color2: null, barCount: 72, barFill: 0.45, roundness: 1, amplitude: 1, mirror: true } },
  { id: "studio-line", name: "Studio Line", category: "Podcast", style: { mode: "waveform", template: "line", color: "#a3e635", color2: null, thickness: 2.5, smoothing: 0.55, mirror: true, barCount: 140 } },
  { id: "interview-warm", name: "Interview Warm", category: "Podcast", style: { mode: "waveform", template: "area", color: "#b45309", color2: "#fbbf24", smoothing: 0.6, amplitude: 0.9, mirror: true } },

  // ── Minimal ────────────────────────────────────────────────────────────────
  { id: "minimal-line", name: "Minimal Line", category: "Minimal", style: { mode: "waveform", template: "line", color: "#e2e8f0", color2: null, thickness: 2, smoothing: 0.6, mirror: true, barCount: 128 } },
  { id: "apple-glow", name: "Apple Glow", category: "Minimal", style: { mode: "waveform", template: "line", color: "#60a5fa", color2: "#c084fc", thickness: 3.5, smoothing: 0.7, glow: 16, mirror: true, barCount: 96 } },
  { id: "hairline", name: "Hairline", category: "Minimal", style: { mode: "waveform", template: "line", color: "#f8fafc", color2: null, thickness: 1.5, smoothing: 0.8, mirror: false, amplitude: 0.7, barCount: 160 } },
  { id: "mono-dots", name: "Mono Dots", category: "Minimal", style: { mode: "spectrum", template: "dots", color: "#cbd5e1", color2: null, barCount: 28, thickness: 4, mirror: true } },
  { id: "ghost-area", name: "Ghost Area", category: "Minimal", style: { mode: "waveform", template: "area", color: "#94a3b8", color2: "#f1f5f9", smoothing: 0.7, amplitude: 0.8, mirror: true } },

  // ── Cinematic ──────────────────────────────────────────────────────────────
  { id: "cinematic-swell", name: "Cinematic Swell", category: "Cinematic", style: { mode: "waveform", template: "area", color: "#7c2d12", color2: "#f97316", smoothing: 0.8, amplitude: 1.2, windowMs: 3000, mirror: true } },
  { id: "night-drive", name: "Night Drive", category: "Cinematic", style: { mode: "spectrum", template: "bars", color: "#312e81", color2: "#a78bfa", barCount: 80, barFill: 0.45, roundness: 0.8, glow: 10, mirror: true } },
  { id: "gold-hour", name: "Gold Hour", category: "Cinematic", style: { mode: "waveform", template: "area", color: "#78350f", color2: "#fcd34d", smoothing: 0.75, amplitude: 1.1, glow: 6, windowMs: 2500, mirror: true } },
  { id: "trailer-hit", name: "Trailer Hit", category: "Cinematic", style: { mode: "spectrum", template: "bars", color: "#1e293b", color2: "#f43f5e", barCount: 56, barFill: 0.6, roundness: 0.2, amplitude: 1.5, glow: 14, mirror: true } },
  { id: "cold-line", name: "Cold Line", category: "Cinematic", style: { mode: "waveform", template: "line", color: "#38bdf8", color2: "#1e3a8a", thickness: 3, smoothing: 0.7, glow: 10, mirror: true, barCount: 110 } },

  // ── Neon ───────────────────────────────────────────────────────────────────
  { id: "neon-bars", name: "Neon Bars", category: "Neon", style: { mode: "spectrum", template: "bars", color: "#22d3ee", color2: "#a855f7", barCount: 48, barFill: 0.55, roundness: 1, glow: 26, mirror: true } },
  { id: "cyber-line", name: "Cyber Line", category: "Neon", style: { mode: "waveform", template: "line", color: "#22ff88", color2: "#00e5ff", thickness: 3, smoothing: 0.5, glow: 28, mirror: true, barCount: 100 } },
  { id: "hot-pink", name: "Hot Pink", category: "Neon", style: { mode: "spectrum", template: "bars", color: "#ec4899", color2: "#f97316", barCount: 36, barFill: 0.65, roundness: 1, glow: 24, amplitude: 1.3, mirror: true } },
  { id: "laser-dots", name: "Laser Dots", category: "Neon", style: { mode: "spectrum", template: "dots", color: "#a3e635", color2: "#22d3ee", barCount: 30, thickness: 5, glow: 18, mirror: true } },
  { id: "acid-area", name: "Acid Area", category: "Neon", style: { mode: "waveform", template: "area", color: "#7c3aed", color2: "#22d3ee", smoothing: 0.6, amplitude: 1.2, glow: 20, mirror: true } },

  // ── Radial ─────────────────────────────────────────────────────────────────
  { id: "neon-ring", name: "Neon Ring", category: "Radial", style: { mode: "spectrum", template: "circular", color: "#22d3ee", color2: null, barCount: 96, thickness: 3, glow: 30, innerRadius: 0.55, mirror: false } },
  { id: "synthwave-sun", name: "Synthwave Sun", category: "Radial", style: { mode: "spectrum", template: "circular", color: "#f472b6", color2: "#818cf8", barCount: 72, thickness: 4, glow: 18, innerRadius: 0.45, mirror: true } },
  { id: "vinyl", name: "Vinyl", category: "Radial", style: { mode: "spectrum", template: "circular", color: "#fbbf24", color2: "#ef4444", barCount: 120, thickness: 2.5, innerRadius: 0.62, spanDeg: 360, mirror: false } },
  { id: "half-dome", name: "Half Dome", category: "Radial", style: { mode: "spectrum", template: "circular", color: "#38bdf8", color2: "#a855f7", barCount: 64, thickness: 4, glow: 12, innerRadius: 0.4, startAngleDeg: -180, spanDeg: 180, mirror: false } },
  { id: "pulse-orb", name: "Pulse Orb", category: "Radial", style: { mode: "waveform", template: "circular", color: "#34d399", color2: "#facc15", barCount: 100, thickness: 3, glow: 16, innerRadius: 0.5, amplitude: 1, mirror: true } },

  // ── Retro ──────────────────────────────────────────────────────────────────
  { id: "vu-meter", name: "VU Meter", category: "Retro", style: { mode: "spectrum", template: "dots", color: "#f59e0b", color2: "#ef4444", barCount: 20, thickness: 6, mirror: false } },
  { id: "8bit", name: "8-Bit", category: "Retro", style: { mode: "spectrum", template: "bars", color: "#22c55e", color2: null, barCount: 24, barFill: 0.85, roundness: 0, mirror: false } },
  { id: "boombox", name: "Boombox", category: "Retro", style: { mode: "spectrum", template: "bars", color: "#f97316", color2: "#fde047", barCount: 28, barFill: 0.7, roundness: 0.15, amplitude: 1.2, mirror: true } },
  { id: "tape-line", name: "Tape Line", category: "Retro", style: { mode: "waveform", template: "line", color: "#eab308", color2: "#b45309", thickness: 2.5, smoothing: 0.4, mirror: true, barCount: 120 } },

  // ── Ambient ────────────────────────────────────────────────────────────────
  { id: "healing-circle", name: "Healing Circle", category: "Ambient", style: { mode: "waveform", template: "circular", color: "#34d399", color2: null, barCount: 120, thickness: 2, amplitude: 0.7, smoothing: 0.8, windowMs: 4000, innerRadius: 0.6, mirror: false } },
  { id: "ocean-breath", name: "Ocean Breath", category: "Ambient", style: { mode: "waveform", template: "area", color: "#0f766e", color2: "#2dd4bf", smoothing: 0.9, amplitude: 0.8, windowMs: 5000, mirror: true } },
  { id: "aurora", name: "Aurora", category: "Ambient", style: { mode: "waveform", template: "area", color: "#6366f1", color2: "#22d3ee", smoothing: 0.85, amplitude: 0.9, glow: 10, windowMs: 4000, mirror: true } },
  { id: "soft-rain", name: "Soft Rain", category: "Ambient", style: { mode: "waveform", template: "line", color: "#a5b4fc", color2: "#e0e7ff", thickness: 2, smoothing: 0.9, amplitude: 0.7, mirror: true, barCount: 150 } },
  { id: "zen-ring", name: "Zen Ring", category: "Ambient", style: { mode: "waveform", template: "circular", color: "#f0abfc", color2: "#c4b5fd", barCount: 140, thickness: 1.5, smoothing: 0.85, amplitude: 0.6, innerRadius: 0.68, glow: 8, mirror: false } },
];
