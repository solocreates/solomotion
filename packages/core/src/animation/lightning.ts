import type { KeyframeValue } from "../schema";
import type { LightningEffect } from "../schema/layer-effects";
import type { Modulator } from "../schema/modulators";
import { ownClockSec } from "./effect-base";
import { resolveEffectValues } from "./effect-values";
import { layerEffectPath, layerEffectTypeDef } from "./layer-effects";
import { sweepAt } from "./sweep";
import { rand01, randSigned, resolveTemporalStep, type TemporalClock } from "./temporal";

/**
 * THE LIGHTNING BRAIN — an arc, resolved to plain points.
 *
 * Same contract as the glass and analog brains: every decision that could be
 * made twice is made once, here, in pure arithmetic with no canvas anywhere
 * near it. The renderer that consumes this is deliberately stupid — "stroke
 * these polylines at these widths" — which is what makes a lightning bolt
 * testable without a DOM and what guarantees the export strikes exactly the
 * lightning the preview was approved from.
 *
 * FOUR MODES, ONE MACHINE. A bolt is a spine from A to B; a burst is N spines
 * out of a centre; an outline arc's spine is a stretch of the layer's own
 * outline; a fill arc's spine joins two random points inside the layer. Every
 * spine is then fractured the same way (recursive midpoint displacement —
 * amplitude halves per level, so `detail` reads as fine structure rather than
 * as more noise) and forked the same way. What differs is only where the
 * spine comes from.
 *
 * OUTLINE IS PATH-PRECISE. A shape or path layer hands its real vector
 * geometry to the resolver (in pass pixels), so at chaos 0 the arc lies
 * exactly on the stroke; its wander is low-frequency value noise along the
 * outline's normal, in pixels, so it hugs the path at any zoom. Layers with
 * no geometry (text, images) hand over a trace of their silhouette at draw
 * time instead — the same function, an argument arriving late.
 *
 * Randomness is a pure function of `(seed, step, index)` — never of a call
 * counter — so the same frame resolves the same bolt however many times it is
 * asked for. That matters more here than anywhere else in the app: a scrub, a
 * preview redraw and an export all ask for frame 37 independently.
 */

/** One stroked polyline. Points are NORMALISED (0..1) to the pass box. */
export interface LightningStrand {
  points: Array<{ x: number; y: number }>;
  /** Stroke width in DEVICE px, already scaled. */
  width: number;
  /** 0..1 — this strand's share of the card's intensity. */
  alpha: number;
}

export type LightningMode = "bolt" | "outline" | "fill" | "burst";

/**
 * The layer's outline, in PASS pixels — what outline and fill modes run on.
 * Supplied by the renderer: from the vector geometry when the layer has any,
 * from a silhouette trace otherwise.
 */
export interface LightningOutline {
  contours: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>;
  /** Per contour — a closed contour's last point joins back to its first. */
  closed: ReadonlyArray<boolean>;
  width: number;
  height: number;
}

/** Everything the geometry needs once the outline is known. */
export interface LightningSpec {
  mode: LightningMode;
  seed: number;
  detail: number;
  chaos: number;
  branches: number;
  branchLength: number;
  /** Core width in device px. */
  width: number;
  taper: number;
  count: number;
  span: number;
  /** Already advanced by `drift × time`; laps of the outline. */
  offset: number;
  flicker: number;
  /** Device px per frame px — sizes the wander and the sampling step. */
  scale: number;
}

export interface LightningParams {
  strands: LightningStrand[];
  /** Corona spread in device px. */
  glow: number;
  color: string;
  coreColor: string;
  intensity: number;
  blend: string;
  /** Clip the discharge to the layer's own alpha. */
  inside: boolean;
  mode: LightningMode;
  /**
   * OUTLINE / FILL WITHOUT GEOMETRY. A silhouette does not exist until the
   * layer has been drawn, and the stage list is built before that — so when
   * the layer has no vector outline the resolver cannot see the shape it is
   * supposed to follow. It hands over the SPEC and the renderer calls
   * `lightningStrandsFor` with a traced outline once it has one. Still one
   * brain, still a pure function of (seed, outline); only the argument
   * arrives late.
   */
  deferred: LightningSpec | null;
  /** 0..1 — how much of each strand has arrived (the strike draw-on). */
  growth: number;
}

/** Wander amplitude of an outline arc at chaos 1, in frame px. */
export const LIGHTNING_WANDER_PX = 18;

type Pt = { x: number; y: number };

/** Layer-space (−1..1 from the centre) → normalised (0..1) pass coordinates. */
function toUnit(v: number): number {
  return (v + 1) / 2;
}

/**
 * Displace the midpoint of every segment, recursively. `amp` is a FRACTION of
 * each segment's length and halves each level, so level 1 sets the arc's
 * overall wander and the rest is texture. Works in any coordinate space.
 */
function fracture(points: Pt[], levels: number, amp: number, seed: number, salt: number): Pt[] {
  let out = points;
  let a = amp;
  for (let level = 0; level < levels; level++) {
    const next: Pt[] = [out[0]!];
    for (let i = 0; i < out.length - 1; i++) {
      const p = out[i]!;
      const q = out[i + 1]!;
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const len = Math.hypot(dx, dy) || 1e-6;
      // Displace ALONG THE NORMAL only. Displacing freely lets a segment fold
      // back on itself, and a bolt that crosses itself reads as a scribble.
      const nx = -dy / len;
      const ny = dx / len;
      const jitter = randSigned(seed, salt, level, i) * a * len;
      next.push({ x: (p.x + q.x) / 2 + nx * jitter, y: (p.y + q.y) / 2 + ny * jitter });
      next.push(q);
    }
    out = next;
    a *= 0.5;
  }
  return out;
}

interface ShapeOpts {
  seed: number;
  salt: number;
  detail: number;
  chaos: number;
  branches: number;
  branchLength: number;
  width: number;
  taper: number;
}

/**
 * Forks leaving a finished spine. They leave from a real vertex of the spine,
 * never from a fresh point — a branch that starts beside the arc instead of
 * on it is the giveaway that a lightning generator is faking it. `reach` is
 * the longest fork, in the spine's own units.
 */
function forks(spine: Pt[], reach: number, o: ShapeOpts): LightningStrand[] {
  const out: LightningStrand[] = [];
  if (o.branches <= 0 || o.branchLength <= 0 || spine.length < 3) return out;
  for (let b = 0; b < o.branches; b++) {
    const at = 0.12 + rand01(o.seed, o.salt, 900, b) * 0.76;
    const idx = Math.min(spine.length - 2, Math.max(1, Math.round(at * (spine.length - 1))));
    const from = spine[idx]!;
    const along = spine[idx + 1]!;
    const dir = Math.atan2(along.y - from.y, along.x - from.x);
    const swing = randSigned(o.seed, o.salt, 901, b) * 1.1;
    const len = reach * o.branchLength * (0.35 + rand01(o.seed, o.salt, 902, b) * 0.65);
    const tip = { x: from.x + Math.cos(dir + swing) * len, y: from.y + Math.sin(dir + swing) * len };
    const fork = fracture([from, tip], Math.max(1, o.detail - 2), o.chaos * 0.45, o.seed, o.salt + 40 + b);
    // Forks are thinner and dimmer than the arc that spawned them, and the
    // further along the spine they leave, the less current they carry.
    const share = 1 - at * 0.5;
    out.push({
      points: fork,
      width: Math.max(0.4, o.width * (1 - o.taper * 0.55) * share),
      alpha: 0.35 + share * 0.4,
    });
  }
  return out;
}

/** A spine from a→b, fractured, plus its forks. Any coordinate space. */
function boltStrands(a: Pt, b: Pt, o: ShapeOpts): LightningStrand[] {
  const spine = fracture([a, b], o.detail, o.chaos * 0.35, o.seed, o.salt);
  const span = Math.hypot(b.x - a.x, b.y - a.y) || 1e-6;
  return [{ points: spine, width: o.width, alpha: 1 }, ...forks(spine, span, o)];
}

/**
 * Resolve a lightning card at one instant. `outline` is the layer's own
 * geometry in pass pixels, when the renderer has it; without it, outline and
 * fill modes come back DEFERRED and the renderer finishes them at draw time.
 */
export function resolveLightningParams(
  fx: LightningEffect,
  sampled: Record<string, KeyframeValue>,
  scale: number,
  timeSec: number,
  resolveColor: (c: string) => string,
  modulators: readonly Modulator[] | undefined,
  outline?: LightningOutline | null,
): LightningParams {
  const fields = layerEffectTypeDef("lightning")?.fields ?? [];
  const v = resolveEffectValues(fields, fx as unknown as Record<string, unknown>, sampled, (k) => layerEffectPath(fx.id, k), {
    scale,
    resolveColor,
    modulators,
    timeSec,
  });

  const clock: TemporalClock = {
    seed: Math.round(Number(v.seed) || 0),
    rate: Number(v.rate) || 24,
    jitter: Number(v.jitter) || 0,
    stutter: Number(v.stutter) || 0,
  };
  const own = ownClockSec(fx, timeSec);
  const step = resolveTemporalStep(clock, own);
  const growth = Math.max(0, Math.min(1, sweepAt(
    {
      position: Number(v.position) || 0,
      duration: Math.max(0, Number(v.duration) || 0),
      delay: Math.max(0, Number(v.delay) || 0),
      loop: fx.loop,
    },
    own,
  )));

  const modeRaw = String(v.mode);
  const mode: LightningMode =
    modeRaw === "outline" || modeRaw === "fill" || modeRaw === "burst" ? modeRaw : "bolt";
  const flicker = Math.max(0, Math.min(1, Number(v.flicker) || 0));
  const spec: LightningSpec = {
    mode,
    seed: step.seed,
    detail: Math.max(1, Math.round(Number(v.detail) || 6)),
    chaos: Math.max(0, Number(v.chaos) || 0),
    branches: Math.max(0, Math.round(Number(v.branches) || 0)),
    branchLength: Math.max(0, Number(v.branchLength) || 0),
    width: Math.max(0, Number(v.width) || 0),
    taper: Math.max(0, Math.min(1, Number(v.taper) || 0)),
    count: Math.max(1, Math.round(Number(v.count) || 1)),
    span: Math.max(0.02, Math.min(1, Number(v.span) || 1)),
    offset: (Number(v.offset) || 0) + (Number(v.drift) || 0) * own,
    flicker,
    scale,
  };

  let strands: LightningStrand[] = [];
  let deferred: LightningSpec | null = null;
  let flickered = false;
  if (mode === "bolt") {
    strands = boltStrands(
      { x: toUnit(Number(v.ax) || 0), y: toUnit(Number(v.ay) || 0) },
      { x: toUnit(Number(v.bx) || 0), y: toUnit(Number(v.by) || 0) },
      { ...spec, salt: 7 },
    );
  } else if (mode === "burst") {
    // A burst is N bolts leaving one point at even angles, each jittered — the
    // same machine, not a second one.
    const c = { x: toUnit(Number(v.bx) || 0), y: toUnit(Number(v.by) || 0) };
    const reach = 0.5 * (0.5 + spec.branchLength);
    for (let i = 0; i < spec.count; i++) {
      const a = (i / spec.count) * Math.PI * 2 + randSigned(spec.seed, 31, i) * 0.4;
      const r = reach * (0.6 + rand01(spec.seed, 32, i) * 0.4);
      strands.push(
        ...boltStrands(c, { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r }, { ...spec, salt: 7 + i * 13, branches: 0 }),
      );
    }
  } else if (outline && outline.contours.length > 0) {
    strands = lightningStrandsFor(spec, outline);
    flickered = true;
  } else {
    deferred = spec;
  }

  // The crackle: the whole discharge dims by a different amount every re-roll.
  const crackle = 1 - flicker * 0.6 * rand01(spec.seed, 91);
  return {
    strands: flickered ? strands : applyFlicker(strands, spec),
    glow: Math.max(0, Number(v.glow) || 0),
    color: String(v.color),
    coreColor: String(v.coreColor),
    intensity: Math.max(0, Number(v.intensity) || 0) * crackle,
    blend: String(v.blend),
    // Arcs across the inside of a shape are, by definition, inside it.
    inside: fx.inside || mode === "fill",
    mode,
    growth,
    deferred,
  };
}

/** Per-strand brightness jitter — each arc flickers on its own. */
function applyFlicker(strands: LightningStrand[], spec: LightningSpec): LightningStrand[] {
  if (spec.flicker <= 0.001) return strands;
  return strands.map((s, i) => ({ ...s, alpha: s.alpha * (1 - spec.flicker * 0.5 * rand01(spec.seed, 92, i)) }));
}

/**
 * Finish an outline or fill card against an outline — the renderer's half of
 * the deferred contract, and the resolver's own path when it had geometry.
 * Pure over `(spec, outline)`, so the two callers cannot disagree.
 */
export function lightningStrandsFor(spec: LightningSpec, outline: LightningOutline): LightningStrand[] {
  const px = spec.mode === "fill" ? fillStrands(spec, outline) : outlineStrands(spec, outline);
  const w = Math.max(1, outline.width);
  const h = Math.max(1, outline.height);
  return applyFlicker(
    px.map((s) => ({ ...s, points: s.points.map((p) => ({ x: p.x / w, y: p.y / h })) })),
    spec,
  );
}

// ── Outline mode ─────────────────────────────────────────────────────────────

/** A contour as cumulative arc lengths, closed contours with their seam. */
interface Walk {
  pts: Pt[];
  cum: number[];
  length: number;
}

function walkOf(contour: ReadonlyArray<Pt>, closed: boolean): Walk | null {
  if (contour.length < 2) return null;
  const pts = contour.slice();
  if (closed) {
    const a = pts[0]!;
    const z = pts[pts.length - 1]!;
    if (Math.hypot(a.x - z.x, a.y - z.y) > 1e-6) pts.push(a);
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1]!;
    const q = pts[i]!;
    cum.push(cum[i - 1]! + Math.hypot(q.x - p.x, q.y - p.y));
  }
  const length = cum[cum.length - 1]!;
  return length > 1e-6 ? { pts, cum, length } : null;
}

/** The point `s` px along a walk (clamped). */
function pointAt(walk: Walk, s: number): { p: Pt; nx: number; ny: number } {
  const { pts, cum } = walk;
  const t = Math.max(0, Math.min(walk.length, s));
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= t) lo = mid;
    else hi = mid;
  }
  const a = pts[lo]!;
  const b = pts[Math.min(pts.length - 1, lo + 1)]!;
  const seg = cum[lo + 1]! - cum[lo]! || 1e-6;
  const u = (t - cum[lo]!) / seg;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1e-6;
  return { p: { x: a.x + dx * u, y: a.y + dy * u }, nx: -dy / len, ny: dx / len };
}

/** Cosine-interpolated value noise in one dimension, −1..1. */
function noise1(seed: number, salt: number, x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = randSigned(seed, salt, i);
  const b = randSigned(seed, salt, i + 1);
  const u = (1 - Math.cos(f * Math.PI)) * 0.5;
  return a + (b - a) * u;
}

/**
 * Arcs running along the outline. Every contour is walked in turn as one long
 * path (so `offset` sweeps the whole shape), and an arc that would cross from
 * one contour to the next is split there rather than jumping the gap.
 */
function outlineStrands(spec: LightningSpec, outline: LightningOutline): LightningStrand[] {
  const walks: Walk[] = [];
  outline.contours.forEach((c, i) => {
    const w = walkOf(c, outline.closed[i] ?? true);
    if (w) walks.push(w);
  });
  const total = walks.reduce((s, w) => s + w.length, 0);
  if (walks.length === 0 || total <= 1e-6) return [];

  const out: LightningStrand[] = [];
  const step = Math.max(2, Math.min(8, spec.width * 1.5)) * Math.max(0.5, spec.scale);
  const amp = spec.chaos * LIGHTNING_WANDER_PX * spec.scale;
  const wavelength = 36 * spec.scale;
  const arcLen = spec.span * total;

  for (let i = 0; i < spec.count; i++) {
    const startFrac = ((spec.offset + i / spec.count) % 1 + 1) % 1;
    let s0 = startFrac * total;
    let remaining = arcLen;
    const salt = 7 + i * 17;
    // Walk `arcLen` px from `s0` across the concatenated contours, wrapping.
    let guard = 0;
    while (remaining > 1e-3 && guard++ < walks.length + 2) {
      // Locate the contour `s0` falls in.
      let base = 0;
      let wi = 0;
      for (; wi < walks.length; wi++) {
        if (s0 < base + walks[wi]!.length || wi === walks.length - 1) break;
        base += walks[wi]!.length;
      }
      const walk = walks[wi]!;
      const local = Math.min(walk.length, s0 - base);
      const take = Math.min(remaining, walk.length - local);
      if (take > 1e-3) {
        const n = Math.max(2, Math.ceil(take / step) + 1);
        const pts: Pt[] = [];
        for (let k = 0; k < n; k++) {
          const s = local + (take * k) / (n - 1);
          const { p, nx, ny } = pointAt(walk, s);
          if (amp > 0.001) {
            // Two octaves of value noise along the arc length — a wander that
            // hugs the path rather than a scribble beside it.
            const global = base + s;
            const d = amp * (noise1(spec.seed, salt, global / wavelength) * 0.7 + noise1(spec.seed, salt + 1, global / (wavelength * 0.37)) * 0.3);
            pts.push({ x: p.x + nx * d, y: p.y + ny * d });
          } else {
            pts.push(p);
          }
        }
        const fine = Math.max(0, spec.detail - 4);
        const spine = fine > 0 && spec.chaos > 0.001 ? fracture(pts, fine, spec.chaos * 0.25, spec.seed, salt + 3) : pts;
        const o: ShapeOpts = { ...spec, salt };
        out.push({
          points: spine,
          width: Math.max(0.4, spec.width * (0.75 + rand01(spec.seed, 57, i) * 0.5)),
          alpha: 0.7 + rand01(spec.seed, 58, i) * 0.3,
        });
        // Forks reach a fraction of the arc, never more than a hand's width.
        out.push(...forks(spine, Math.min(take, 300 * spec.scale), o));
      }
      remaining -= Math.max(take, 1e-3);
      s0 = (base + walk.length) % total;
    }
  }
  return out;
}

// ── Fill mode ────────────────────────────────────────────────────────────────

/** Even-odd point-in-polygon across every contour. */
function insideOutline(outline: LightningOutline, x: number, y: number): boolean {
  let inside = false;
  for (const c of outline.contours) {
    const n = c.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = c[i]!;
      const b = c[j]!;
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  }
  return inside;
}

/**
 * Arcs thrown across the inside of the shape: each joins two random interior
 * points. Rejection-sampled inside the outline's box with seeded draws, so the
 * same step always throws the same arcs.
 */
function fillStrands(spec: LightningSpec, outline: LightningOutline): LightningStrand[] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of outline.contours) {
    for (const p of c) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX) || maxX - minX < 1 || maxY - minY < 1) return [];
  const sample = (salt: number): Pt | null => {
    for (let t = 0; t < 24; t++) {
      const x = minX + rand01(spec.seed, salt, t, 0) * (maxX - minX);
      const y = minY + rand01(spec.seed, salt, t, 1) * (maxY - minY);
      if (insideOutline(outline, x, y)) return { x, y };
    }
    return null;
  };
  const out: LightningStrand[] = [];
  const minSpan = Math.min(maxX - minX, maxY - minY) * 0.25;
  for (let i = 0; i < spec.count; i++) {
    const a = sample(100 + i * 2);
    let b = sample(101 + i * 2);
    // Two points on top of each other make a spark, not an arc — retry once.
    if (a && b && Math.hypot(b.x - a.x, b.y - a.y) < minSpan) b = sample(150 + i * 2) ?? b;
    if (!a || !b) continue;
    out.push(...boltStrands(a, b, { ...spec, salt: 7 + i * 13 }));
  }
  return out;
}

/** Nothing to draw — checked before the renderer allocates anything. */
export function lightningIsNoop(p: LightningParams): boolean {
  if (p.intensity <= 0.001 || p.growth <= 0.001) return true;
  // A deferred card with no strands yet is NOT a noop — its outline arrives at
  // draw time. Culling it here is what would make outline mode silently never
  // render, which is exactly the bug this branch exists to avoid.
  return p.strands.length === 0 && !p.deferred;
}
