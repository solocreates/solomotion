import type { PathCommand } from "./geometry";
import { trimCommands, trimSubpaths } from "./trim";
import { applyModulators } from "../animation/modulators";
import type { KeyframeValue } from "../schema/animation";
import type { Modulator } from "../schema/modulators";
import {
  flattenCommands,
  pointsToCommands,
  polylineAt,
  polylinesToCommands,
  totalLength,
  valueNoise,
  type Polyline,
  type Pt,
} from "./polyline";
import {
  CLEAN_EDGES,
  FLAT_WAVE,
  NO_SCATTER,
  ROUND_NIB,
  UNIFORM_PROFILE,
  type StrokeMarker,
  type StrokeMarkerKind,
  type StrokeNib,
  type StrokeProfile,
  type StrokeRoughness,
  type StrokeScatter,
  type StrokeStyle,
  type StrokeWave,
} from "../schema/vector";

/**
 * THE stroke pipeline — one headless brain that turns a layer's outline plus
 * one `StrokeStyle` into geometry a rasterizer can draw:
 *
 *   outline → trim → offset → wave → dash → scatter | (nib + profile +
 *   roughness → ribbon) → caps + markers
 *
 * Everything downstream (the canvas renderer, SVG/Lottie export, the stroke
 * preview swatch in the inspector) asks THIS for the answer, so a dash offset
 * or a taper can never mean one thing on stage and another in the export.
 *
 * The plan is deliberately two-sided, because a stroke has two very different
 * costs. A uniform-width line is `ctx.stroke()` — GPU-fast, correct joins and
 * caps for free — so the plan hands back a centre line plus the dash pattern
 * and lets the rasterizer do it natively. Only a NON-uniform profile forces us
 * to bake a filled variable-width ribbon ourselves. Identity settings therefore
 * cost nothing: the expensive path is unreachable until you dial a taper.
 */

/** What to draw for one stroke entry. Exactly one of `path`/`ribbon` is set. */
export interface StrokePlan {
  /** Centre line to stroke natively (trim + wave applied). */
  path: PathCommand[] | null;
  /** Dash pattern + offset for the rasterizer; empty = solid. */
  dash: number[];
  dashOffset: number;
  /**
   * A filled outline to FILL instead of stroking — present only for a
   * non-uniform profile, with trim, wave and dash already baked in. When this
   * is set, `path` is null and `dash` is empty: never draw both.
   */
  ribbon: PathCommand[] | null;
  /** Endpoint decorations, positioned and sized, ready to FILL with the paint. */
  markers: PathCommand[];
}

const EMPTY_PLAN: StrokePlan = { path: null, dash: [], dashOffset: 0, ribbon: null, markers: [] };

/** True when the profile is the identity (uniform width) — the fast path gate.
 *  A measured width curve is never uniform, however flat it looks. */
export function isUniformProfile(p: StrokeProfile): boolean {
  return !p.samples?.length && p.startWidth === 1 && p.endWidth === 1;
}

/** True when the wave displaces nothing. */
export function isFlatWave(w: StrokeWave): boolean {
  return w.amplitude === 0;
}

/** True when both edges are perfectly clean (no grain, no erosion). */
export function isCleanEdges(r: StrokeRoughness): boolean {
  return r.amount === 0 && r.erode === 0;
}

/** True when the stroke is a continuous line rather than a spray of dabs. */
export function isNoScatter(sc: StrokeScatter): boolean {
  return sc.density <= 0;
}

/** True when the nib is round — i.e. direction does not modulate the width. */
export function isRoundNib(n: StrokeNib): boolean {
  return n.ratio >= 1;
}

/** True when the trim window is the whole path. */
export function isFullTrim(t: { start: number; end: number; offset: number }): boolean {
  return t.start === 0 && t.end === 1 && t.offset % 1 === 0;
}

/**
 * Does this stroke need the sampled (polyline) pipeline at all? Used by callers
 * that want to know whether a cheap native stroke will do before building
 * anything — the renderer's dirty check, the export fidelity report.
 */
export function needsSampling(s: StrokeStyle): boolean {
  return (
    !isUniformProfile(s.profile) ||
    !isFlatWave(s.wave) ||
    !isCleanEdges(s.roughness) ||
    !isNoScatter(s.scatter) ||
    !isRoundNib(s.nib) ||
    s.offset !== 0 ||
    s.markers.start.kind !== "none" ||
    s.markers.end.kind !== "none"
  );
}

/** Whether a stroke entry contributes any pixels at all. */
export function strokeIsVisible(s: StrokeStyle): boolean {
  return s.enabled && s.width > 0 && s.opacity > 0.001;
}

/**
 * The part of an outline a stroke INKS: a draw-on's per-subpath windows first
 * (how much has been drawn), then the stroke's own arc-length trim (the
 * design's window of that). Anything that runs along the DRAWN line — the
 * stroke plan, a lightning arc riding the outline — reads this one answer, so
 * a half-drawn logo sparks along the half that is drawn.
 */
export function inkedCommands(
  cmds: readonly PathCommand[],
  trim?: { start: number; end: number; offset: number },
  reveal?: ReadonlyArray<readonly [number, number, number?]>,
): PathCommand[] {
  let geom = (reveal ? trimSubpaths(cmds, reveal) : cmds) as PathCommand[];
  if (geom.length === 0 || !trim) return geom;
  const start = clamp01(trim.start);
  const end = clamp01(trim.end);
  if (!isFullTrim({ start, end, offset: trim.offset })) geom = trimCommands(geom, start, end, trim.offset);
  return geom;
}

/**
 * Build the draw plan for one stroke over `cmds` (the layer's outline in local
 * space). Pass a stroke whose animated scalars are ALREADY sampled — see
 * `sampleStroke`, which is the one place keyframe paths are decoded.
 */
export function buildStrokePlan(
  cmds: readonly PathCommand[],
  s: StrokeStyle,
  /**
   * A draw-on's per-subpath windows (`strandWindows`), applied BEFORE the
   * stroke's own trim. The reveal is the animation and the trim is the design:
   * a dash of light that chases a half-drawn logo should chase the half that
   * is drawn, so the design's window is cut from what the reveal has inked.
   */
  reveal?: ReadonlyArray<readonly [number, number, number?]>,
): StrokePlan {
  if (!strokeIsVisible(s) || cmds.length === 0) return EMPTY_PLAN;

  // 0 + 1. REVEAL, then TRIM — the part of the outline this stroke inks.
  let geom: readonly PathCommand[] = inkedCommands(cmds, s.trim, reveal);
  if (geom.length === 0) return EMPTY_PLAN;

  // 2a. OFFSET — slide the whole line sideways. Stacked at different offsets one
  //     shape becomes a rail, a double line or a hatch, and because it happens
  //     BEFORE the wave, an offset line waves about its own route rather than
  //     about the original path.
  let contours: Polyline[] | null = null;
  if (s.offset !== 0) {
    contours = flattenCommands(geom).map((pl) => offsetContour(pl, s.offset));
    geom = polylinesToCommands(contours);
    if (geom.length === 0) return EMPTY_PLAN;
  }

  // 2b. WAVE — displace the centre line along its own normal. This is the first
  //    stage that has to leave bézier space, so it flattens once and every
  //    later stage reuses those polylines.
  if (!isFlatWave(s.wave)) {
    contours = (contours ?? flattenCommands(geom)).map((pl) => waveContour(pl, s.wave));
    geom = polylinesToCommands(contours);
    if (geom.length === 0) return EMPTY_PLAN;
  }

  const markers = buildMarkers(contours ?? flattenCommands(geom), s);

  // 3. SCATTER — a spray of discrete marks rather than a line. It short-circuits
  //    everything below: there is no ribbon to taper, no edge to roughen and no
  //    dash to walk, because each dab is its own closed shape. Dabs land in the
  //    `ribbon` slot so every consumer keeps filling one path.
  if (!isNoScatter(s.scatter)) {
    const flat = contours ?? flattenCommands(geom);
    const dabs = scatterDabs(flat, s);
    return { path: null, dash: [], dashOffset: 0, ribbon: dabs.length ? dabs : null, markers };
  }

  // 4/5. DASH + RIBBON. A stroke with a uniform profile, a round nib and clean
  //      edges is a plain line: hand the dash to the rasterizer and stop, which
  //      keeps `ctx.stroke()` (and its free joins and caps) on the common path.
  //      Anything that varies the width ALONG or ACROSS the line has to bake a
  //      filled outline, since a filled outline cannot use `setLineDash`.
  if (isUniformProfile(s.profile) && isCleanEdges(s.roughness) && isRoundNib(s.nib)) {
    return { path: geom as PathCommand[], dash: s.dash, dashOffset: s.dashOffset, ribbon: null, markers };
  }

  const flat = contours ?? flattenCommands(geom);
  const pieces = s.dash.some((d) => d > 0) ? dashPieces(flat, s.dash, s.dashOffset) : flat.map(wholePiece);
  const ribbon: PathCommand[] = [];
  const total = totalLength(flat) || 1;
  for (const piece of pieces) {
    const poly = ribbonFor(piece, s, total);
    if (poly.length > 2) ribbon.push(...pointsToCommands(poly, true));
  }
  return { path: null, dash: [], dashOffset: 0, ribbon: ribbon.length ? ribbon : null, markers };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// ─────────────────────────────────────────────────────────────────────────────
// Wave

/**
 * Displace a contour along its own normal by the wave function.
 *
 * The contour is RESAMPLED first, at several stations per wavelength. Flattening
 * only guarantees enough points to describe the CURVE, and a straight segment
 * needs exactly two — so displacing the flattened points in place leaves a
 * straight line perfectly straight no matter what the wave says. Resampling is
 * what makes the wave a property of the stroke rather than of how curvy the
 * geometry happened to be.
 */
function waveContour(pl: Polyline, w: StrokeWave): Polyline {
  const wl = Math.max(1, w.wavelength);
  const stations = Math.max(pl.pts.length, Math.min(2000, Math.ceil((pl.length / wl) * WAVE_SAMPLES_PER_CYCLE) + 1));
  const pts: Pt[] = Array.from({ length: stations }, (_, i) => {
    const d = (pl.length * i) / (stations - 1);
    const at = polylineAt(pl, d);
    // Normal = tangent rotated 90°.
    const nx = -at.ty;
    const ny = at.tx;
    const phase = d / wl + w.phase;
    const smooth = Math.sin(phase * Math.PI * 2);
    const rough = valueNoise(phase, w.seed);
    let k = smooth * (1 - w.roughness) + rough * w.roughness;
    // Taper the displacement to zero at an OPEN path's ends, so a waved line
    // still starts and finishes where the geometry says it does (and its
    // markers still sit on the line).
    if (!pl.closed) k *= endFade(d, pl.length, wl);
    return { x: at.x + nx * k * w.amplitude, y: at.y + ny * k * w.amplitude };
  });
  if (pl.closed && pts.length > 1) pts[pts.length - 1] = { ...pts[0]! };
  return remeasure({ pts, closed: pl.closed, cum: [], length: 0 });
}

/**
 * Slide a contour sideways along its own normal.
 *
 * This is a NAIVE offset — each station moves perpendicular to the local
 * tangent — not a true Minkowski offset. On a curve whose radius is tighter
 * than the offset the inner side folds over itself, exactly as it does in every
 * "outline stroke" that skips the expensive path. That is the right trade here:
 * offsets are used at a few px to build rails and double lines, where the fold
 * is unreachable, and paying for exact offsetting would slow down every frame
 * of the common case to fix a shape nobody draws.
 */
function offsetContour(pl: Polyline, px: number): Polyline {
  const pts: Pt[] = pl.pts.map((_, i) => {
    const d = pl.cum[i] ?? 0;
    const at = polylineAt(pl, d);
    return { x: at.x - at.ty * px, y: at.y + at.tx * px };
  });
  if (pl.closed && pts.length > 1) pts[pts.length - 1] = { ...pts[0]! };
  return remeasure({ pts, closed: pl.closed, cum: [], length: 0 });
}

/** Stations per wavelength — enough that a sine reads smooth after flattening. */
const WAVE_SAMPLES_PER_CYCLE = 12;

/** 0 at both ends, 1 in the middle — over one wavelength or a tenth of the run. */
function endFade(d: number, len: number, wavelength: number): number {
  const ramp = Math.min(wavelength, len / 10) || 1;
  return Math.min(1, Math.min(d, len - d) / ramp);
}

function remeasure(pl: Polyline): Polyline {
  const cum = [0];
  let acc = 0;
  for (let i = 1; i < pl.pts.length; i++) {
    acc += Math.hypot(pl.pts[i]!.x - pl.pts[i - 1]!.x, pl.pts[i]!.y - pl.pts[i - 1]!.y);
    cum.push(acc);
  }
  pl.cum = cum;
  pl.length = acc;
  return pl;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dash + profile → ribbon

/** One drawn run: a contour plus the [from, to] slice of it that is inked, and
 *  where that slice sits in the WHOLE stroke (so the profile spans the stroke,
 *  not each dash). */
interface Piece {
  pl: Polyline;
  from: number;
  to: number;
  /** Arc length of every contour before this one — the profile's origin. */
  base: number;
}

function wholePiece(pl: Polyline): Piece {
  return { pl, from: 0, to: pl.length, base: 0 };
}

/** Walk the dash pattern along every contour, emitting the inked runs. */
function dashPieces(pls: readonly Polyline[], dash: readonly number[], offset: number): Piece[] {
  const pattern = dash.filter((d) => Number.isFinite(d) && d >= 0);
  const period = pattern.reduce((a, b) => a + b, 0);
  if (period <= 0) return pls.map(wholePiece);
  // An odd pattern repeats doubled, exactly like SVG's stroke-dasharray.
  const p = pattern.length % 2 === 0 ? pattern : [...pattern, ...pattern];
  const cycle = p.reduce((a, b) => a + b, 0);
  const out: Piece[] = [];
  let base = 0;
  for (const pl of pls) {
    // `-offset` so a rising offset marches the dashes FORWARD along the path,
    // which is what every host means by a dash offset.
    let d = -(((offset % cycle) + cycle) % cycle);
    let i = 0;
    let ink = true;
    while (d < pl.length) {
      const next = d + p[i % p.length]!;
      if (ink) {
        const from = Math.max(0, d);
        const to = Math.min(pl.length, next);
        if (to > from) out.push({ pl, from, to, base });
      }
      d = next;
      i++;
      ink = !ink;
    }
    base += pl.length;
  }
  return out;
}

/** Width multiplier at fraction `t` (0…1) of the whole stroke. A measured curve
 *  wins outright — it IS the width, not a modifier of the taper. */
export function profileAt(p: StrokeProfile, t: number): number {
  const s = p.samples;
  if (s && s.length > 0) {
    if (s.length === 1) return Math.max(0, s[0]!);
    const at = clamp01(t) * (s.length - 1);
    const i = Math.min(s.length - 2, Math.floor(at));
    return Math.max(0, mix(s[i]!, s[i + 1]!, at - i));
  }
  let w = 1;
  if (p.startLength > 0 && t < p.startLength) {
    w *= mix(p.startWidth, 1, eased(t / p.startLength, p.ease));
  }
  if (p.endLength > 0 && t > 1 - p.endLength) {
    w *= mix(1, p.endWidth, eased((t - (1 - p.endLength)) / p.endLength, p.ease));
  }
  return Math.max(0, w);
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** `ease` biases the ramp: −1 slams then eases, +1 eases then slams, 0 linear. */
function eased(t: number, ease: number): number {
  const u = clamp01(t);
  if (ease === 0) return u;
  const k = Math.abs(ease);
  const curve = ease > 0 ? u * u : 1 - (1 - u) * (1 - u);
  return mix(u, curve, k);
}

/** Points per ribbon: fine enough that a taper reads smooth, capped so a very
 *  long path can't blow up the frame budget. */
function ribbonSteps(len: number): number {
  return Math.max(6, Math.min(400, Math.ceil(len / 2)));
}

/** Build the closed variable-width outline for one inked run. */
function ribbonFor(piece: Piece, s: StrokeStyle, total: number): Pt[] {
  const run = piece.to - piece.from;
  if (run <= 1e-6) return [];
  const r = s.roughness;
  const rough = !isCleanEdges(r);
  // Grain finer than the sampling interval is grain you cannot see. When the
  // edges are noisy the ribbon is resampled against the NOISE scale, for the
  // same reason the wave resamples: otherwise the look silently depends on how
  // curvy the underlying geometry happened to be.
  const n = rough
    ? Math.max(ribbonSteps(run), Math.min(2000, Math.ceil((run / Math.max(0.5, r.scale)) * ROUGH_SAMPLES_PER_CYCLE)))
    : ribbonSteps(run);
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const d = piece.from + (run * i) / n;
    const at = polylineAt(piece.pl, d);
    const along = piece.base + d;
    let half = (s.width * profileAt(s.profile, along / total)) / 2;
    if (!isRoundNib(s.nib)) half *= nibFactor(at.tx, at.ty, s.nib);

    let lHalf = half;
    let rHalf = half;
    if (rough) {
      const x = along / Math.max(0.5, r.scale);
      // Two noise fields, blended by `spread`: at 0 both edges read the SAME
      // field and the ribbon keeps its weight while breathing; at 1 they are
      // independent and the line is chewed. One shared field plus a blend is
      // what makes that a single continuous dial rather than two modes.
      const shared = valueNoise(x, r.seed);
      const nl = valueNoise(x, r.seed + 977);
      const nr = valueNoise(x + 31.7, r.seed + 4211);
      lHalf = half + mix(shared, nl, r.spread) * r.amount;
      rHalf = half + mix(shared, nr, r.spread) * r.amount;
      if (r.erode > 0) {
        // Erosion pinches the ribbon SHUT where the tip is not touching. A
        // separate, coarser field so a stroke can be finely grainy and coarsely
        // broken at once — which is exactly what a dry brush looks like.
        const bite = (valueNoise(x * 0.4 + 11.3, r.seed + 8821) + 1) / 2;
        if (bite < r.erode) {
          const k = r.erode <= 0 ? 1 : bite / r.erode;
          lHalf *= k;
          rHalf *= k;
        }
      }
      lHalf = Math.max(0, lHalf);
      rHalf = Math.max(0, rHalf);
    }
    left.push({ x: at.x - at.ty * lHalf, y: at.y + at.tx * lHalf });
    right.push({ x: at.x + at.ty * rHalf, y: at.y - at.tx * rHalf });
  }
  right.reverse();
  return [...left, ...right];
}

/** Stations per noise cycle along a roughened edge. */
const ROUGH_SAMPLES_PER_CYCLE = 4;

/**
 * How wide a broad nib reads when travelling in direction (tx, ty).
 *
 * A flat nib held at `angleDeg` is at its widest across its edge and at its
 * thinnest along it, so the factor is the sine of the angle between the travel
 * direction and the nib, taken to the nib's thin/broad `ratio`. Perpendicular
 * gives 1 (full width), parallel gives `ratio` (the blade).
 */
function nibFactor(tx: number, ty: number, nib: StrokeNib): number {
  const a = Math.atan2(ty, tx) - (nib.angleDeg * Math.PI) / 180;
  return mix(nib.ratio, 1, Math.abs(Math.sin(a)));
}

/**
 * Stamp dabs along every contour — the spray/stipple family.
 *
 * `density` is dabs per 100px so a preset reads the same on a short letter as
 * on a long swash. Every jitter is seeded value noise rather than `Math.random`
 * for the reason the whole module is: a random spray would re-roll every frame
 * and BOIL during playback, and would differ between the canvas and the export.
 */
function scatterDabs(pls: readonly Polyline[], s: StrokeStyle): PathCommand[] {
  const sc = s.scatter;
  const step = 100 / Math.max(0.01, sc.density);
  const total = totalLength(pls) || 1;
  const out: PathCommand[] = [];
  const shape = sc.shape === "round" ? "circle" : sc.shape;
  let base = 0;
  let index = 0;
  for (const pl of pls) {
    for (let d = 0; d < pl.length; d += step, index++) {
      const at = polylineAt(pl, d);
      const k = index * 0.6180339887; // golden-ratio walk — decorrelates the fields
      const jitterAlong = valueNoise(k, sc.seed) * step * 0.5;
      const p = polylineAt(pl, Math.min(pl.length, Math.max(0, d + jitterAlong)));
      const across = valueNoise(k + 17.1, sc.seed + 613) * sc.spread;
      const grow = 1 + valueNoise(k + 41.9, sc.seed + 1319) * sc.sizeJitter;
      // Dabs taper with the profile too, so a spray can fade out like a line.
      const r = ((s.width * sc.size) / 2) * profileAt(s.profile, (base + d) / total) * Math.max(0, grow);
      if (r <= 0.01) continue;
      const cx = p.x - p.ty * across;
      const cy = p.y + p.tx * across;
      // Reuses the MARKER shape table: a dab and an endpoint decoration are the
      // same filled primitive, so there is one place circles and diamonds live.
      const pts = MARKER_SHAPES[shape](r * 2, r, r).map((q) => ({ x: cx + q.x, y: cy + q.y }));
      out.push(...pointsToCommands(pts, true));
    }
    base += pl.length;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint markers

/**
 * Where a stroke's endpoint decorations go: the start of the FIRST open contour
 * and the end of the LAST one. Closed contours have no ends, so a rectangle
 * never sprouts an arrowhead.
 */
function buildMarkers(pls: readonly Polyline[], s: StrokeStyle): PathCommand[] {
  if (s.markers.start.kind === "none" && s.markers.end.kind === "none") return [];
  const open = pls.filter((pl) => !pl.closed && pl.length > 0);
  if (open.length === 0) return [];
  const out: PathCommand[] = [];
  const first = open[0]!;
  const last = open[open.length - 1]!;
  if (s.markers.start.kind !== "none") {
    const at = polylineAt(first, 0);
    // A start marker points BACK along the path — outward, away from the line.
    out.push(...markerCommands(s.markers.start, at.x, at.y, Math.atan2(-at.ty, -at.tx), s.width));
  }
  if (s.markers.end.kind !== "none") {
    const at = polylineAt(last, last.length);
    out.push(...markerCommands(s.markers.end, at.x, at.y, Math.atan2(at.ty, at.tx), s.width));
  }
  return out;
}

/**
 * One endpoint decoration as a filled outline, built in a local space where the
 * tip sits at the origin and +x points OUTWARD, then rotated into place.
 *
 * The shape table is the only thing that knows about arrowheads: a new head is
 * one entry here and it works on stage, in the picker's preview and in every
 * export, with no switch anywhere else.
 */
export function markerCommands(
  marker: StrokeMarker,
  x: number,
  y: number,
  angle: number,
  strokeWidth: number,
): PathCommand[] {
  const L = Math.max(0, marker.size) * Math.max(0.01, strokeWidth);
  if (L <= 0 || marker.kind === "none") return [];
  const half = L / 2;
  const t = Math.max(0.5, strokeWidth); // bar/chevron thickness
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const placed = MARKER_SHAPES[marker.kind](L, half, t).map((p) => ({
    x: x + p.x * cos - p.y * sin,
    y: y + p.x * sin + p.y * cos,
  }));
  return pointsToCommands(placed, true);
}

/** Local-space outlines: tip at the origin, +x outward, in stroke-width units. */
const MARKER_SHAPES: Record<Exclude<StrokeMarkerKind, "none">, (L: number, half: number, t: number) => Pt[]> = {
  arrow: (L, half) => [
    { x: 0, y: 0 },
    { x: -L, y: half * 0.75 },
    { x: -L * 0.72, y: 0 },
    { x: -L, y: -half * 0.75 },
  ],
  triangle: (L, half) => [
    { x: 0, y: 0 },
    { x: -L, y: half * 0.7 },
    { x: -L, y: -half * 0.7 },
  ],
  // An open V of constant thickness — Figma's line arrow.
  "arrow-line": (L, half, t) => vee(L, half * 0.9, t),
  chevron: (L, half, t) => vee(L * 0.7, half * 0.9, t),
  circle: (_L, half) => ring(half, 0),
  square: (_L, half) => [
    { x: half, y: half },
    { x: -half, y: half },
    { x: -half, y: -half },
    { x: half, y: -half },
  ],
  diamond: (_L, half) => [
    { x: half, y: 0 },
    { x: 0, y: half },
    { x: -half, y: 0 },
    { x: 0, y: -half },
  ],
  bar: (_L, half, t) => [
    { x: t / 2, y: half },
    { x: -t / 2, y: half },
    { x: -t / 2, y: -half },
    { x: t / 2, y: -half },
  ],
};

/** A constant-thickness "V" with its point at the origin, opening backwards. */
function vee(L: number, spread: number, t: number): Pt[] {
  const ux = -L;
  const h = t / 2;
  // Outer edge out to each wing, inner edge back — the mitre is approximated by
  // offsetting along y, which is exact enough at these sizes.
  const k = Math.hypot(L, spread) / L;
  return [
    { x: 0, y: 0 },
    { x: ux, y: spread + h * k },
    { x: ux, y: spread - h * k },
    { x: -h * 2 * k, y: 0 },
    { x: ux, y: -spread + h * k },
    { x: ux, y: -spread - h * k },
  ];
}

/** A circle as a polygon — markers are filled outlines, so a polygon is enough
 *  and keeps the whole table one shape kind. */
function ring(r: number, cx: number): Pt[] {
  const pts: Pt[] = [];
  const n = 24;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return pts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyframe overlay

/**
 * Every animatable scalar of a stroke, as the `stroke.<id>.…` suffix that
 * addresses it. ONE list: the renderer samples through it, the inspector's ◆
 * cluster offers it, and the property registry synthesizes defs from it — so a
 * new animatable stroke field is one line here, not four edits in four files.
 */
export const STROKE_SCALAR_PATHS = [
  "width",
  "opacity",
  "dashLength",
  "dashGap",
  "dashOffset",
  "trim.start",
  "trim.end",
  "trim.offset",
  "profile.startWidth",
  "profile.endWidth",
  "profile.startLength",
  "profile.endLength",
  "profile.ease",
  "wave.amplitude",
  "wave.wavelength",
  "wave.phase",
  "wave.roughness",
  "offset",
  "roughness.amount",
  "roughness.scale",
  "roughness.spread",
  "roughness.erode",
  "scatter.density",
  "scatter.size",
  "scatter.sizeJitter",
  "scatter.spread",
  "nib.angleDeg",
  "nib.ratio",
  "markers.start.size",
  "markers.end.size",
] as const;
export type StrokeScalarPath = (typeof STROKE_SCALAR_PATHS)[number];

/** Read one scalar off a stroke by its `stroke.<id>.<sub>` suffix. */
export function strokeScalar(s: StrokeStyle, sub: string): number | undefined {
  switch (sub) {
    case "width": return s.width;
    case "opacity": return s.opacity;
    case "dashLength": return s.dash[0] ?? 0;
    case "dashGap": return s.dash[1] ?? s.dash[0] ?? 0;
    case "dashOffset": return s.dashOffset;
    case "trim.start": return s.trim.start;
    case "trim.end": return s.trim.end;
    case "trim.offset": return s.trim.offset;
    case "profile.startWidth": return s.profile.startWidth;
    case "profile.endWidth": return s.profile.endWidth;
    case "profile.startLength": return s.profile.startLength;
    case "profile.endLength": return s.profile.endLength;
    case "profile.ease": return s.profile.ease;
    case "wave.amplitude": return s.wave.amplitude;
    case "wave.wavelength": return s.wave.wavelength;
    case "wave.phase": return s.wave.phase;
    case "wave.roughness": return s.wave.roughness;
    case "offset": return s.offset;
    case "roughness.amount": return s.roughness.amount;
    case "roughness.scale": return s.roughness.scale;
    case "roughness.spread": return s.roughness.spread;
    case "roughness.erode": return s.roughness.erode;
    case "scatter.density": return s.scatter.density;
    case "scatter.size": return s.scatter.size;
    case "scatter.sizeJitter": return s.scatter.sizeJitter;
    case "scatter.spread": return s.scatter.spread;
    case "nib.angleDeg": return s.nib.angleDeg;
    case "nib.ratio": return s.nib.ratio;
    case "markers.start.size": return s.markers.start.size;
    case "markers.end.size": return s.markers.end.size;
    default: return undefined;
  }
}

/** Write one scalar onto a stroke, clamped to its schema range. */
export function setStrokeScalar(s: StrokeStyle, sub: string, v: number): void {
  switch (sub) {
    case "width": s.width = Math.max(0, v); return;
    case "opacity": s.opacity = clamp01(v); return;
    case "dashLength": {
      const gap = s.dash[1] ?? s.dash[0] ?? v;
      s.dash = v > 0 || gap > 0 ? [Math.max(0, v), gap] : [];
      return;
    }
    case "dashGap": {
      const len = s.dash[0] ?? v;
      s.dash = len > 0 || v > 0 ? [len, Math.max(0, v)] : [];
      return;
    }
    case "dashOffset": s.dashOffset = v; return;
    case "trim.start": s.trim.start = clamp01(v); return;
    case "trim.end": s.trim.end = clamp01(v); return;
    case "trim.offset": s.trim.offset = v; return;
    case "profile.startWidth": s.profile.startWidth = clampTo(v, 0, 4); return;
    case "profile.endWidth": s.profile.endWidth = clampTo(v, 0, 4); return;
    case "profile.startLength": s.profile.startLength = clamp01(v); return;
    case "profile.endLength": s.profile.endLength = clamp01(v); return;
    case "profile.ease": s.profile.ease = clampTo(v, -1, 1); return;
    case "wave.amplitude": s.wave.amplitude = Math.max(0, v); return;
    case "wave.wavelength": s.wave.wavelength = Math.max(1, v); return;
    case "wave.phase": s.wave.phase = v; return;
    case "wave.roughness": s.wave.roughness = clamp01(v); return;
    case "offset": s.offset = v; return;
    case "roughness.amount": s.roughness.amount = Math.max(0, v); return;
    case "roughness.scale": s.roughness.scale = Math.max(0.5, v); return;
    case "roughness.spread": s.roughness.spread = clamp01(v); return;
    case "roughness.erode": s.roughness.erode = Math.min(0.95, Math.max(0, v)); return;
    case "scatter.density": s.scatter.density = Math.max(0, v); return;
    case "scatter.size": s.scatter.size = Math.max(0, v); return;
    case "scatter.sizeJitter": s.scatter.sizeJitter = clamp01(v); return;
    case "scatter.spread": s.scatter.spread = Math.max(0, v); return;
    case "nib.angleDeg": s.nib.angleDeg = v; return;
    case "nib.ratio": s.nib.ratio = Math.min(1, Math.max(0.02, v)); return;
    case "markers.start.size": s.markers.start.size = Math.max(0, v); return;
    case "markers.end.size": s.markers.end.size = Math.max(0, v); return;
  }
}

const clampTo = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * A stroke with its animated scalars resolved at the playhead. `read` is handed
 * the FULL property path (`stroke.<id>.trim.end`) so it can be the renderer's
 * existing sampled-keyframe lookup with no adapter. Returns the stroke itself
 * when nothing is animated, so the common case allocates nothing.
 */
export function sampleStroke(s: StrokeStyle, read: (path: string) => number | undefined): StrokeStyle {
  let out: StrokeStyle | null = null;
  for (const sub of STROKE_SCALAR_PATHS) {
    const v = read(`stroke.${s.id}.${sub}`);
    if (v === undefined || v === strokeScalar(s, sub)) continue;
    if (!out) {
      // EVERY nested object is cloned. A shallow copy here would leave the
      // sampled stroke sharing `roughness`/`scatter`/`nib` with the document,
      // so writing an animated value would edit the saved document behind the
      // renderer's back — the classic "my preset changed by itself" bug.
      out = { ...s, dash: [...s.dash], trim: { ...s.trim }, profile: { ...s.profile }, wave: { ...s.wave },
        roughness: { ...s.roughness }, scatter: { ...s.scatter }, nib: { ...s.nib },
        markers: { start: { ...s.markers.start }, end: { ...s.markers.end } } };
    }
    setStrokeScalar(out, sub, v);
  }
  return out ?? s;
}

/**
 * A stroke resolved at an instant: keyframes first, then MODULATORS on top.
 *
 * That order is the app's universal one (`animation/modulators.ts`): a signal
 * modifies the already-animated value, so "trim it on, then shake it" is two
 * independent decisions rather than a choice between them. Routing strokes
 * through it is what makes `stroke.<id>.dashOffset` wiggle-able with nothing
 * stroke-specific written — the modulator brain already speaks property paths,
 * it was simply never asked about this family.
 *
 * One resolver, so the canvas, the exporter and the inspector's readout cannot
 * disagree about how wide a shaking stroke is on frame 137.
 */
export function resolveStrokeAt(
  stroke: StrokeStyle,
  opts: {
    /** Sampled keyframes at this instant, keyed by full property path. */
    sampled?: Record<string, KeyframeValue>;
    /** The host clip's modulator list (already scoped to the clip). */
    modulators?: readonly Modulator[];
    /** Clip-local seconds — the clock every modulator reads. */
    timeSec?: number;
  },
): StrokeStyle {
  const { sampled = {}, modulators, timeSec = 0 } = opts;
  const hasMods = !!modulators?.length;
  // Proportional scaling comes LAST, over the already-animated, already-
  // modulated width. That order is what makes "grow this line from 2 to 40 over
  // a second" grow the dashes and the wobble with it — scaling first would
  // measure the design against a width the frame never actually used.
  return strokeAtWidth(sampleStroke(stroke, (path) => {
    const keyed = sampled[path];
    const base = typeof keyed === "number" ? keyed : undefined;
    if (!hasMods) return base;
    const start = base ?? strokeScalar(stroke, path.slice(`stroke.${stroke.id}.`.length));
    if (start === undefined) return base;
    const out = applyModulators(modulators, path, start, timeSec, sampled);
    return out === start ? base : out;
  }));
}

/**
 * The scalars measured in PIXELS, and therefore the ones that have to grow with
 * the line. Everything absent from this list is already proportional (`profile`
 * and `trim` are fractions, `scatter.size` and the marker sizes are multiples of
 * the width, `nib` is an angle and a ratio) or is not a length at all.
 *
 * Listed once here rather than tested field by field at the call site: the next
 * px-dimensioned stage anyone adds to the pipeline scales correctly the moment
 * its name lands in this array, and cannot silently be the one field that stays
 * hairline while the rest of the stroke doubles.
 */
const STROKE_PX_SCALARS = [
  "dashLength",
  "dashGap",
  "dashOffset",
  "wave.amplitude",
  "wave.wavelength",
  "roughness.amount",
  "roughness.scale",
  "scatter.spread",
  "offset",
] as const;

/**
 * Resolve a stroke AT ITS SIZE: every pixel length in the pipeline multiplied by
 * `k = width / baseWidth`.
 *
 * This is the whole answer to "why does my line stop looking like my line when I
 * resize it". A look is authored at a width — 2px, dashed 6/4, wobbling 3px — and
 * every one of those numbers means something only relative to the 2. Drag the
 * width to 40 with them stored absolutely and the dashes and the wobble stay
 * where they were: same data, invisible design.
 *
 * `scatter.density` is the one INVERSE term, and it is not an exception so much
 * as the same rule read correctly. It counts dabs per 100px, so a stroke twice
 * as wide wants dabs twice as big and therefore half as many over the same
 * distance — scaling it upward would crowd the line into a solid bar exactly
 * when it was supposed to open up.
 *
 * Returns the stroke untouched when `baseWidth` is null (opted out) or the
 * factor is 1, so the ordinary case allocates nothing.
 */
export function strokeAtWidth(s: StrokeStyle): StrokeStyle {
  const base = s.baseWidth;
  if (base === null || base <= 0) return s;
  const k = s.width / base;
  if (!Number.isFinite(k) || k === 1 || k <= 0) return s;
  const out: StrokeStyle = {
    ...s,
    dash: [...s.dash],
    trim: { ...s.trim },
    profile: { ...s.profile },
    wave: { ...s.wave },
    roughness: { ...s.roughness },
    scatter: { ...s.scatter },
    nib: { ...s.nib },
    markers: { start: { ...s.markers.start }, end: { ...s.markers.end } },
  };
  for (const sub of STROKE_PX_SCALARS) {
    const v = strokeScalar(s, sub);
    if (v !== undefined && v !== 0) setStrokeScalar(out, sub, v * k);
  }
  if (s.scatter.density > 0) out.scatter.density = s.scatter.density / k;
  return out;
}

/** Identity check used by presets and the inspector's "is this dialled?" dots. */
export function isDefaultPipeline(s: StrokeStyle): boolean {
  return (
    isFullTrim(s.trim) &&
    s.dash.length === 0 &&
    s.dashOffset === 0 &&
    isUniformProfile(s.profile) &&
    isFlatWave(s.wave) &&
    isCleanEdges(s.roughness) &&
    isNoScatter(s.scatter) &&
    isRoundNib(s.nib) &&
    s.offset === 0 &&
    s.markers.start.kind === "none" &&
    s.markers.end.kind === "none"
  );
}

export { UNIFORM_PROFILE, FLAT_WAVE, CLEAN_EDGES, NO_SCATTER, ROUND_NIB };
