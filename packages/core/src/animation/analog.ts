import type { KeyframeValue } from "../schema";
import type { Modulator } from "../schema/modulators";
import type {
  EffectBlendMode,
  FilmDamageEffect,
  GrainEffect,
  NoiseEffect,
  ScanlinesEffect,
} from "../schema/layer-effects";
import { ownClockSec } from "./effect-base";
import { resolveEffectValues } from "./effect-values";
import { layerEffectPath, layerEffectTypeDef } from "./layer-effects";
import {
  fbm2,
  rand01,
  randSigned,
  resolveTemporalStep,
  steppedValue,
  valueNoise2,
  type FbmOptions,
  type NoiseShape,
  type TemporalClock,
  type TemporalStep,
} from "./temporal";

/**
 * The ANALOG brains — grain, film damage, scanlines and noise, resolved to
 * plain numbers and plain geometry. Same contract as the glass material brain
 * next door: every decision that could be made twice is made once, here, so the
 * canvas renderer, the exporter and any future GPU or native backend cannot
 * disagree about what a frame looks like.
 *
 * The renderers that consume these are deliberately stupid — "draw these 84
 * circles, these 3 lines, this mask at this phase". That is what makes the
 * whole family testable without a canvas, and it is why a speck of dust is a
 * `{x, y, r}` here rather than a `ctx.arc` somewhere in the draw path.
 *
 * Two conventions run through every resolver:
 *  - positions are NORMALIZED (0..1) to the pass box, sizes are DEVICE px
 *    (already multiplied by the render scale), so a look survives zoom and
 *    export resolution unchanged;
 *  - anything random is a function of the effect's temporal step, never of the
 *    render loop — see `temporal.ts`.
 */

/** Pull the clock out of any card that carries it. */
function clockOf(v: Record<string, number | string>): TemporalClock {
  return {
    seed: Math.round(Number(v.seed) || 0),
    rate: Number(v.rate) || 24,
    jitter: Number(v.jitter) || 0,
    stutter: Number(v.stutter) || 0,
  };
}

/** Resolve a card's fields with keyframes, colour variables and px scaling applied. */
function valuesOf(
  type: Parameters<typeof layerEffectTypeDef>[0],
  fx: Record<string, unknown>,
  id: string,
  sampled: Record<string, KeyframeValue>,
  scale: number,
  timeSec: number,
  resolveColor: (c: string) => string,
  modulators: readonly Modulator[] | undefined,
): Record<string, number | string> {
  const fields = layerEffectTypeDef(type)?.fields ?? [];
  return resolveEffectValues(fields, fx, sampled, (k) => layerEffectPath(id, k), {
    scale,
    resolveColor,
    modulators,
    timeSec,
  });
}

// ── Film grain ───────────────────────────────────────────────────────────────

export interface GrainParams {
  amount: number;
  /** Grain cell size in device px (already scaled). */
  cell: number;
  aspect: number;
  /** Blur radius applied to the tile, device px. */
  softness: number;
  chroma: number;
  blend: EffectBlendMode;
  /** The seed for THIS gate open — the renderer caches its tile against it. */
  seed: number;
}

export function resolveGrainParams(
  fx: GrainEffect,
  sampled: Record<string, KeyframeValue>,
  scale: number,
  timeSec: number,
  resolveColor: (c: string) => string = (c) => c,
  modulators?: readonly Modulator[],
): GrainParams {
  const v = valuesOf("grain", fx as unknown as Record<string, unknown>, fx.id, sampled, scale, timeSec, resolveColor, modulators);
  const step = resolveTemporalStep(clockOf(v), ownClockSec(fx, timeSec));
  return {
    amount: clamp01(Number(v.amount)),
    // `size` is authored as a multiplier and flagged `scaled`, so it arrives in
    // device px already; the floor keeps a sub-pixel cell from degenerating into
    // a flat grey wash at low zoom.
    cell: Math.max(0.5, Number(v.size)),
    aspect: Math.max(0.1, Number(v.aspect)),
    softness: Math.max(0, Number(v.softness)),
    chroma: clamp01(Number(v.chroma)),
    blend: v.blend as EffectBlendMode,
    seed: step.seed,
  };
}

export function grainIsNoop(p: GrainParams): boolean {
  return p.amount < 0.002;
}

// ── Film damage ──────────────────────────────────────────────────────────────

/** One speck of debris. `x`/`y` are 0..1 of the pass box; `r` is device px. */
export interface FilmSpeck {
  x: number;
  y: number;
  r: number;
  alpha: number;
  /** Dirt on the print prints black; dirt on the negative prints white. */
  dark: boolean;
}

/** One wear line, as a segment in 0..1 box space with a device-px width. */
export interface FilmScratch {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  width: number;
  alpha: number;
  /** 0..1 — feathering, applied by the renderer as a blur proportional to width. */
  softness: number;
}

/** One fibre, as a polyline of 0..1 box-space points. */
export interface FilmHair {
  points: Array<{ x: number; y: number }>;
  width: number;
  alpha: number;
}

export interface FilmDamageParams {
  mix: number;
  specks: FilmSpeck[];
  scratches: FilmScratch[];
  scratchColor: string;
  hairs: FilmHair[];
  /** Exposure multiplier from flicker; 1 = untouched. */
  exposure: number;
  /** Gate weave, in device px / radians — applied to the whole layer. */
  weaveX: number;
  weaveY: number;
  weaveRotate: number;
  /**
   * The print slipping in the gate, as a fraction of the box height (0 = no
   * slip). Kept separate from `weaveY` — which is device px — because a slip is
   * a fraction of the FRAME and only the renderer knows how tall that is.
   */
  jumpOffset: number;
  /** Where the splice bar sits (0..1 of the box), or null when not slipping. */
  spliceAt: number | null;
  spliceIntensity: number;
  inside: boolean;
}

/** Salts — one per random channel, so two draws from a step can't collide. */
const CH = {
  weaveX: 1,
  weaveY: 2,
  weaveRot: 3,
  flicker: 4,
  jump: 5,
  jumpDir: 6,
  splice: 7,
} as const;

/** How many specks a `dust` of 1.0 scatters. Tuned against 1080p framing. */
const MAX_SPECKS = 240;

export function resolveFilmDamageParams(
  fx: FilmDamageEffect,
  sampled: Record<string, KeyframeValue>,
  scale: number,
  timeSec: number,
  resolveColor: (c: string) => string = (c) => c,
  modulators?: readonly Modulator[],
): FilmDamageParams {
  const v = valuesOf("filmDamage", fx as unknown as Record<string, unknown>, fx.id, sampled, scale, timeSec, resolveColor, modulators);
  const clock = clockOf(v);
  const own = ownClockSec(fx, timeSec);
  const step = resolveTemporalStep(clock, own);

  const dust = clamp01(Number(v.dust));
  const dustSize = Math.max(0.5, Number(v.dustSize));
  const dustBias = Math.max(-1, Math.min(1, Number(v.dustBias)));
  const dustSoftness = clamp01(Number(v.dustSoftness));

  // Debris: re-scattered every gate open, addressed by (stepSeed, index) so the
  // same instant always produces the same specks without storing any of them.
  const specks: FilmSpeck[] = [];
  const count = Math.round(dust * dust * MAX_SPECKS); // squared: fine control low down
  for (let i = 0; i < count; i++) {
    // Size distribution is cubed so most debris is small and the occasional
    // mote is big — a flat distribution reads as confetti, not as dirt.
    const t = rand01(step.seed, i, 11);
    specks.push({
      x: rand01(step.seed, i, 12),
      y: rand01(step.seed, i, 13),
      r: dustSize * (0.15 + 0.85 * t * t * t) * (1 + dustSoftness),
      alpha: 0.35 + 0.65 * rand01(step.seed, i, 14),
      // bias −1 → all white, +1 → all black, 0 → an even mix.
      dark: rand01(step.seed, i, 15) < (dustBias + 1) / 2,
    });
  }

  // Scratches: position PERSISTS (a scratch is worn into the print, it doesn't
  // teleport each frame) and only wanders, on smooth noise. Only their
  // brightness re-rolls per step, which is the flicker real scratches have as
  // the light catches them.
  const scratchCount = Math.round(Math.max(0, Number(v.scratches)));
  const scratchWidth = Math.max(0.2, Number(v.scratchWidth));
  const scratchLength = clamp01(Number(v.scratchLength));
  const scratchDrift = Math.max(0, Number(v.scratchDrift));
  const scratchOpacity = clamp01(Number(v.scratchOpacity));
  const scratchTilt = (Number(v.scratchAngle) * Math.PI) / 180;
  const scratches: FilmScratch[] = [];
  for (let i = 0; i < scratchCount; i++) {
    const baseX = rand01(clock.seed, i, 21);
    // The wander is unit-noise over seconds, so `drift` reads as "device px of
    // travel per second" — the field's declared unit, not an arbitrary gain.
    const wander = scratchDrift * valueNoise2(own, i * 13.7, clock.seed) * 0.5;
    const centreY = 0.5 + randSigned(clock.seed, i, 22) * (1 - scratchLength) * 0.5;
    const half = scratchLength / 2;
    const dx = Math.tan(scratchTilt) * half;
    scratches.push({
      x0: baseX + wander,
      y0: centreY - half,
      x1: baseX + wander + dx * 2,
      y1: centreY + half,
      width: scratchWidth,
      alpha: scratchOpacity * (0.3 + 0.7 * rand01(step.seed, i, 23)),
      softness: clamp01(Number(v.scratchSoftness)),
    });
  }

  // Hairs: a fibre caught in the gate, so it DOES resettle every open. Built as
  // a short random walk with a persistent curl bias, which is what stops it
  // reading as a straight line with noise on it.
  const hairCount = Math.round(Math.max(0, Number(v.hairs)));
  const hairSize = clamp01(Number(v.hairSize));
  const hairs: FilmHair[] = [];
  const HAIR_SEGMENTS = 9;
  for (let i = 0; i < hairCount; i++) {
    const points: Array<{ x: number; y: number }> = [];
    let x = rand01(step.seed, i, 31);
    let y = rand01(step.seed, i, 32);
    let dir = rand01(step.seed, i, 33) * Math.PI * 2;
    const curl = randSigned(step.seed, i, 34) * 0.9;
    const segment = hairSize / HAIR_SEGMENTS;
    for (let s = 0; s <= HAIR_SEGMENTS; s++) {
      points.push({ x, y });
      dir += curl + randSigned(step.seed, i, 40 + s) * 0.35;
      x += Math.cos(dir) * segment;
      y += Math.sin(dir) * segment;
    }
    hairs.push({
      points,
      width: Math.max(0.2, Number(v.hairWidth)),
      alpha: clamp01(Number(v.hairOpacity)),
    });
  }

  // Flicker & weave both read the SAME step, because on a real projector one
  // mechanism drives both — the gate opening.
  const flicker = clamp01(Number(v.flicker));
  const exposure = 1 + steppedValue(clock, step, CH.flicker, clamp01(Number(v.flickerSmooth))) * flicker * 0.45;

  const weaveSmooth = clamp01(Number(v.weaveSmooth));
  const weaveY = steppedValue(clock, step, CH.weaveY, weaveSmooth) * Math.max(0, Number(v.weaveY));

  // A jump is the print slipping in the gate: an extra vertical offset for one
  // step, with the splice bar riding through at the seam.
  const jumpChance = fx.splices ? clamp01(Number(v.jump)) : 0;
  const jumping = jumpChance > 0 && rand01(step.seed, CH.jump) < jumpChance;
  const jumpDir = rand01(step.seed, CH.jumpDir) < 0.5 ? -1 : 1;
  const jumpOffset = jumping ? jumpDir * clamp01(Number(v.jumpAmount)) : 0;
  const spliceAt = jumping ? rand01(step.seed, CH.splice) : null;

  return {
    mix: clamp01(Number(v.mix)),
    specks,
    scratches,
    scratchColor: String(v.scratchColor),
    hairs,
    exposure: Math.max(0, exposure),
    weaveX: steppedValue(clock, step, CH.weaveX, weaveSmooth) * Math.max(0, Number(v.weaveX)),
    weaveY,
    weaveRotate: (steppedValue(clock, step, CH.weaveRot, weaveSmooth) * Math.max(0, Number(v.weaveRotate)) * Math.PI) / 180,
    jumpOffset,
    spliceAt,
    spliceIntensity: clamp01(Number(v.splice)),
    inside: fx.inside,
  };
}

export function filmDamageIsNoop(p: FilmDamageParams): boolean {
  return p.mix < 0.002;
}

// ── Scanlines ────────────────────────────────────────────────────────────────

export type ScanlineShape = "line" | "dot" | "slot" | "grille";

export interface ScanlineParams {
  mix: number;
  amount: number;
  color: string;
  blend: EffectBlendMode;
  boost: number;
  shape: ScanlineShape;
  /** Mask orientation in radians (already rotated 90° for a grille). */
  angleRad: number;
  /** Period in device px. */
  pitch: number;
  aspect: number;
  thickness: number;
  softness: number;
  /** Total phase shift in device px — authored offset plus the roll at this time. */
  offset: number;
  /** Phosphor smear along the scan direction, device px. */
  bleed: number;
  curvature: number;
  /** Exposure multiplier from flicker; 1 = untouched. */
  exposure: number;
  /** How strongly alternate lines are dimmed, and which parity is dim now. */
  interlace: number;
  interlaceOdd: boolean;
  inside: boolean;
}

export function resolveScanlineParams(
  fx: ScanlinesEffect,
  sampled: Record<string, KeyframeValue>,
  scale: number,
  timeSec: number,
  resolveColor: (c: string) => string = (c) => c,
  modulators?: readonly Modulator[],
): ScanlineParams {
  const v = valuesOf("scanlines", fx as unknown as Record<string, unknown>, fx.id, sampled, scale, timeSec, resolveColor, modulators);
  const clock = clockOf(v);
  const own = ownClockSec(fx, timeSec);
  const step = resolveTemporalStep(clock, own);
  const shape = v.shape as ScanlineShape;

  const flicker = clamp01(Number(v.flicker));
  // Screen flicker is mains-driven and abrupt, so it takes the hard step (no
  // smoothing) — unlike a projector lamp, which breathes.
  const exposure = 1 + randSigned(step.seed, 71) * flicker * 0.35;

  return {
    mix: clamp01(Number(v.mix)),
    amount: clamp01(Number(v.amount)),
    color: String(v.color),
    blend: v.blend as EffectBlendMode,
    boost: Math.max(0, Number(v.boost)),
    shape,
    // A grille IS the line mask stood on its side. Rotating here rather than
    // branching in the renderer keeps the mask generator down to one function.
    angleRad: ((Number(v.angle) + (shape === "grille" ? 90 : 0)) * Math.PI) / 180,
    pitch: Math.max(1, Number(v.pitch)),
    aspect: Math.max(0.1, Number(v.aspect)),
    thickness: Math.max(0.02, Math.min(0.98, Number(v.thickness))),
    softness: clamp01(Number(v.softness)),
    // Roll is CONTINUOUS (it is a phase, not a random draw), so it reads raw
    // time and slides smoothly however coarse the clock is.
    offset: Number(v.offset) + Number(v.roll) * timeSec,
    bleed: Math.max(0, Number(v.bleed)),
    curvature: clamp01(Number(v.curvature)),
    exposure: Math.max(0, exposure),
    interlace: clamp01(Number(v.interlace)),
    // Which field is dark alternates with the STEP, so `rate` is literally the
    // field rate — set it to 60 and you get 60Hz judder.
    interlaceOdd: (step.index & 1) === 1,
    inside: fx.inside,
  };
}

export function scanlinesIsNoop(p: ScanlineParams): boolean {
  return p.mix < 0.002 || (p.amount < 0.002 && p.boost < 0.002 && p.curvature < 0.002 && p.bleed < 0.05);
}

// ── Noise ────────────────────────────────────────────────────────────────────

export interface NoiseParams {
  mix: number;
  amount: number;
  blend: EffectBlendMode;
  chroma: number;
  lowColor: string;
  highColor: string;
  /** Feature size in device px. */
  scale: number;
  aspect: number;
  fbm: FbmOptions;
  contrast: number;
  brightness: number;
  /** Field seed — fixed across steps so `evolve` morphs instead of re-rolling. */
  seed: number;
  /** Scroll offsets in device px. */
  offsetX: number;
  offsetY: number;
  /** Displacement amplitude in device px. */
  displace: number;
  inside: boolean;
}

export function resolveNoiseParams(
  fx: NoiseEffect,
  sampled: Record<string, KeyframeValue>,
  scale: number,
  timeSec: number,
  resolveColor: (c: string) => string = (c) => c,
  modulators?: readonly Modulator[],
): NoiseParams {
  const v = valuesOf("noise", fx as unknown as Record<string, unknown>, fx.id, sampled, scale, timeSec, resolveColor, modulators);
  const clock = clockOf(v);
  const own = ownClockSec(fx, timeSec);
  const step = resolveTemporalStep(clock, own);

  return {
    mix: clamp01(Number(v.mix)),
    amount: clamp01(Number(v.amount)),
    blend: v.blend as EffectBlendMode,
    chroma: clamp01(Number(v.chroma)),
    lowColor: String(v.lowColor),
    highColor: String(v.highColor),
    scale: Math.max(1, Number(v.scale)),
    aspect: Math.max(0.1, Number(v.aspect)),
    fbm: {
      shape: v.shape as NoiseShape,
      octaves: Number(v.octaves),
      gain: Number(v.roughness),
      lacunarity: Number(v.lacunarity),
      // Evolution advances by STEP, not by raw time: that is what makes the
      // field hold still through a gate open and then boil forward, so `rate`
      // controls stop-motion vs. liquid with one number.
      evolve: Number(v.evolve) * step.index,
    },
    contrast: Math.max(0, Number(v.contrast)),
    brightness: Number(v.brightness),
    // The field's own seed stays fixed across steps — re-seeding per step would
    // replace the whole field every beat (TV static), which is what `evolve`
    // set very high gives you deliberately.
    seed: clock.seed,
    offsetX: Number(v.driftX) * own,
    offsetY: Number(v.driftY) * own,
    displace: Math.max(0, Number(v.displace)),
    inside: fx.inside,
  };
}

export function noiseIsNoop(p: NoiseParams): boolean {
  return p.mix < 0.002 || (p.amount < 0.002 && p.displace < 0.05);
}

// ── Shared sampling ──────────────────────────────────────────────────────────

/**
 * Sample the noise field at a device-space point, in 0..1. The ONE place the
 * scale/aspect/drift/contrast chain is applied, so the overlay pass and the
 * displacement pass read the identical field — generating it twice, with the
 * two copies drifting apart by a stray `contrast`, is exactly the bug this
 * function exists to make impossible.
 */
export function sampleNoiseField(p: NoiseParams, x: number, y: number, channel = 0): number {
  const sx = (x + p.offsetX) / (p.scale * p.aspect);
  const sy = (y + p.offsetY) / p.scale;
  // Colour static offsets each channel into a different region of the SAME
  // field rather than seeding three fields — one generator, three views.
  const off = channel * p.chroma * 37.13;
  const raw = fbm2(sx + off, sy + off * 0.7, p.seed, p.fbm);
  const shaped = Math.tanh(raw * p.contrast) * 0.5 + 0.5 + p.brightness * 0.5;
  return shaped < 0 ? 0 : shaped > 1 ? 1 : shaped;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}
