import { evaluateEasing } from "../easing";
import type { Frame } from "../schema/document";
import type { Clip } from "../schema/clips";
import type { KeyframeTrack } from "../schema/animation";
import { sampleKeyframes } from "./keyframes";
import type {
  ClipMotionBlur,
  MotionBlurSampling,
  MotionBlurSettings,
  ShutterWeighting,
} from "../schema/motion-blur";
import type { LayerEffect } from "../schema/layer-effects";
import { layerEffectReadsBackdrop } from "./layer-effects";
import { MOTION_EPSILON_PX, MOTION_FULL_PX, SAMPLE_SPACING_PX, type LayerMotion } from "./motion";

/**
 * THE PLAN — which instants does this layer's shutter see, and how much does
 * each weigh?
 *
 * Everything downstream of motion blur reads a `ShutterPlan` and nothing else.
 * The stage, the exporter and (later) a native adapter therefore cannot
 * disagree about what a shutter is: they disagree only about how fast they can
 * draw the samples it names, which is the `tier` field's whole job.
 *
 * Nothing here touches a canvas, a document mutation or a clock. Given the same
 * inputs it returns the same plan forever, which is what lets an export match a
 * preview frame-for-frame.
 */

/** One instant the shutter sees, and its share of the exposure. */
export interface ShutterSample {
  /** Clip-local time, ms. */
  timeMs: number;
  /** Share of the total exposure. The samples' weights sum to 1. */
  weight: number;
}

export interface ShutterPlan {
  samples: ShutterSample[];
  /** The exposure window in clip-local ms. */
  openMs: number;
  closeMs: number;
  /** Measured corner travel across the window — why this plan has this many samples. */
  motionPx: number;
  /** The measured motion itself, for the `velocity` tier and the expression globals. */
  motion: LayerMotion;
  /** What the renderer should actually do. Never higher than the surface allows. */
  tier: MotionBlurSampling;
  settings: MotionBlurSettings;
}

/**
 * What a SURFACE is willing to spend. The third level of the three-level model
 * (layer switch × comp master × render setting) — the one that is not stored in
 * the document, because it is a fact about the machine you are sitting at and
 * not about the project.
 *
 * `off` is not "disabled"; it is a budget of zero, which is why the same
 * resolution path handles a user switching preview off and the governor
 * deciding a frame took too long.
 */
export type MotionBlurPolicy =
  | { kind: "off" }
  /** Cap the tier — the governor and the stage's fast mode both land here. */
  | { kind: "capped"; maxTier: MotionBlurSampling; maxSamples?: number }
  /** Spend whatever the document asks for. Export, and the parked stage. */
  | { kind: "full" };

export const POLICY_OFF: MotionBlurPolicy = { kind: "off" };
export const POLICY_FULL: MotionBlurPolicy = { kind: "full" };
/** The stage's playback tier: exact direction, one cheap pass. */
export const POLICY_FAST: MotionBlurPolicy = { kind: "capped", maxTier: "velocity", maxSamples: 8 };

const TIER_ORDER: Record<MotionBlurSampling, number> = { velocity: 0, transform: 1, content: 2 };

const maxTier = (a: MotionBlurSampling, b: MotionBlurSampling): MotionBlurSampling =>
  TIER_ORDER[a] >= TIER_ORDER[b] ? a : b;

/**
 * The cheapest tier that can render this layer HONESTLY.
 *
 * `velocity` and `transform` both bank ONE render of the layer and move it
 * around — which is only valid while the layer's picture is a function of its
 * own pose. A MATERIAL breaks that assumption: liquid glass refracts what is
 * BEHIND it, and the scene behind it does not travel with it. Bank one render
 * and slide it and you drag the refracted backdrop along for the ride, so the
 * glass appears to wobble while it moves and snaps back the instant the blur
 * stops — a visible pop at exactly the moment the effect should be invisible.
 *
 * So a material floors at `content`, where every sample is a real render at a
 * real position and the backdrop stays where it belongs. Derived from the same
 * `readsBackdrop` declaration the renderer uses to decide whether to build a
 * backdrop at all: one fact about the effect, three consumers, no drift.
 */
export function shutterTierFloor(
  effects: readonly LayerEffect[] | undefined,
  /** The layer itself, for the second reason a picture is not a function of its pose. */
  clip?: ShutterClip,
): MotionBlurSampling {
  // A text sliding ALONG its path moves without its transform moving: the
  // pose is the host's and stays put while the letters travel the curve. Only
  // a re-render per sample sees that, so an animated offset floors at content.
  if (clip && pathTextSlides(clip)) return "content";
  if (!effects) return "velocity";
  return effects.some((fx) => fx.enabled && layerEffectReadsBackdrop(fx)) ? "content" : "velocity";
}

/** What the shutter needs to know about a layer to plan honestly. */
export type ShutterClip = Pick<Clip, "motionBlur"> & {
  effects?: readonly LayerEffect[];
  kind?: Clip["kind"];
  path?: unknown;
  keyframes?: readonly KeyframeTrack[];
  modulators?: readonly { target: string; enabled?: boolean }[];
};

/** Is this a text on a path whose ride along it is animated? */
export function pathTextSlides(clip: ShutterClip): boolean {
  if (clip.kind !== "text" || !clip.path) return false;
  const moves = (p: string) => p === "path.offset" || p === "path.rise";
  if (clip.keyframes?.some((t) => !t.range && moves(t.property) && t.keys.length > 1)) return true;
  return !!clip.modulators?.some((m) => moves(m.target) && m.enabled !== false);
}

/**
 * How far a text on a path TRAVELS along it between two instants, frame px —
 * the motion the quad measure cannot see, because the quad is the host's box
 * and the host is standing still. Folded into the measure by the painter so
 * the significance test and the sample count both know the letters moved.
 */
export function pathTextTravel(clip: ShutterClip, pathLengthPx: number, openMs: number, closeMs: number): number {
  if (!clip.keyframes || clip.kind !== "text" || !clip.path) return 0;
  const a = sampleKeyframes(clip.keyframes as KeyframeTrack[], openMs);
  const b = sampleKeyframes(clip.keyframes as KeyframeTrack[], closeMs);
  const spec = clip.path as { offset: number; rise: number };
  const n = (bag: Record<string, unknown>, k: string, d: number) => (typeof bag[k] === "number" ? (bag[k] as number) : d);
  const dOffset = Math.abs(n(b, "path.offset", spec.offset) - n(a, "path.offset", spec.offset)) * pathLengthPx;
  const dRise = Math.abs(n(b, "path.rise", spec.rise) - n(a, "path.rise", spec.rise));
  return Math.hypot(dOffset, dRise);
}

/** Steps the cheap tier smears over. Past this a straight line stops improving. */
export const VELOCITY_TIER_SAMPLES = 8;

/**
 * THE RESOLUTION — layer switch × comp master × render setting.
 *
 * Exactly After Effects' three levels, deliberately not reinvented: a layer
 * switch you flick constantly, a comp master that holds a whole project still,
 * and a render setting that belongs to the machine. `null` means this layer
 * does not blur, and every caller treats that as "draw it the ordinary way".
 *
 * This is the ONE place the three levels meet. Any surface that re-derived even
 * part of it would eventually disagree with the exporter about what ships.
 */
export function resolveMotionBlur(
  frame: Frame,
  clip: ShutterClip,
  policy: MotionBlurPolicy,
  /** Clip-local time — keyed `mblur.*` values are sampled here. */
  localMs?: number,
): { settings: MotionBlurSettings; tier: MotionBlurSampling; maxSamples: number } | null {
  if (policy.kind === "off") return null;
  if (!frame.motionBlur.enabled) return null;
  const own: ClipMotionBlur = clip.motionBlur;
  if (!own.enabled) return null;

  // `override: null` inherits the comp's settings. The comp object carries the
  // master switch alongside them, so strip it rather than letting a comp's
  // `enabled` masquerade as a settings field further down.
  const { enabled: _master, ...compSettings } = frame.motionBlur;
  const settings: MotionBlurSettings = keyedShutter(own.override ?? compSettings, clip, localMs);

  const capTier = policy.kind === "capped" ? policy.maxTier : "content";
  // The FLOOR is a correctness bound, the cap is a budget — so the floor is
  // applied first and the budget still gets the last word. A surface that
  // cannot afford an honest render draws an approximate one; it does not get
  // to draw a wrong one it could have afforded.
  const want = maxTier(settings.sampling, shutterTierFloor(clip.effects, clip));
  const tier: MotionBlurSampling = TIER_ORDER[want] <= TIER_ORDER[capTier] ? want : capTier;
  const maxSamples =
    policy.kind === "capped" && policy.maxSamples != null
      ? Math.min(settings.maxSamples, policy.maxSamples)
      : settings.maxSamples;

  return { settings, tier, maxSamples };
}

/**
 * The shutter AT AN INSTANT: keyed `mblur.*` fields sampled over the base
 * settings. Every numeric shutter field is a keyframe path — without this they
 * were keys the renderer never read, so a strength ramp (the only way to fade
 * blur in on a beat) silently did nothing.
 */
function keyedShutter(base: MotionBlurSettings, clip: ShutterClip, localMs: number | undefined): MotionBlurSettings {
  if (localMs === undefined || !clip.keyframes?.some((t) => t.property.startsWith("mblur."))) return base;
  const kf = sampleKeyframes(clip.keyframes as KeyframeTrack[], localMs);
  const out = { ...base };
  for (const k of ["shutterAngle", "shutterPhase", "strength", "amount"] as const) {
    const v = kf[`mblur.${k}`];
    if (typeof v === "number") out[k] = v;
  }
  return out;
}

/**
 * The weight one sample carries, at normalized position `u` across the open
 * shutter (0 = the instant it opened, 1 = the instant it closed).
 *
 * This is Blender's shutter curve, sold as looks rather than as a graph. It is
 * also the reason motion TRAILS are not a second feature: a trail is not a
 * different algorithm, it is a shutter that weighs the past more heavily than
 * the present, and a feature that shares this function can never drift from
 * the blur it is a cousin of.
 */
export function shutterWeight(weighting: ShutterWeighting, u: number, curve?: MotionBlurSettings["curve"]): number {
  switch (weighting) {
    case "box":
      return 1;
    case "ease": {
      // Gaussian about the centre, σ chosen so the ends land near 0.1 — soft
      // enough to hide a low sample count, not so soft that half the exposure
      // is thrown away.
      const d = (u - 0.5) / 0.32;
      return Math.exp(-0.5 * d * d);
    }
    case "trail":
      // Heaviest at the shutter's CLOSE and fading into the past: the subject
      // stays solid and drags a tail behind it. (It used to be `1 − u` —
      // heaviest at the open — which drew the comet backwards: a solid
      // ghost where the layer had been, fading out toward where it is.)
      return u;
    case "lead":
      // The mirror: solid at the open, fading out ahead into the future.
      return 1 - u;
    case "curve":
      return curve ? Math.max(0, evaluateEasing(curve, u)) : 1;
  }
}

/**
 * Build the plan, or return `null` when there is nothing worth integrating.
 *
 * `motion` is measured by the caller (which owns the pose sampler — see
 * `motion.ts`) across the window this function defines, so the two are computed
 * in the right order: the window comes from the shutter, the sample count comes
 * from what actually moved inside it.
 */
export function resolveShutter(
  opts: {
    /** ms per frame of the comp this layer lives in. */
    frameIntervalMs: number;
    /** Clip-local time of the frame being rendered. */
    localMs: number;
    settings: MotionBlurSettings;
    tier: MotionBlurSampling;
    maxSamples: number;
    /** The window as cut at a step (`cutShutterAtSteps`); default the settings' own. */
    window?: { openMs: number; closeMs: number };
  },
  /** Motion measured across `[openMs, closeMs]` — see `shutterWindow`. */
  motion: LayerMotion,
): ShutterPlan | null {
  const { settings, tier, maxSamples } = opts;
  const { openMs, closeMs } = opts.window ?? shutterWindow(opts.frameIntervalMs, opts.localMs, settings);
  if (closeMs <= openMs) return null;

  // THE SIGNIFICANCE TEST. `amount` scales the look, so it also scales what
  // counts as visible: a layer being exaggerated 4× deserves to blur at a
  // quarter of the travel.
  const effectivePx = motion.px * settings.amount;
  if (effectivePx < MOTION_EPSILON_PX) return null;

  // SAMPLE COUNT IS DERIVED, NEVER STORED. Below ~1.5px of travel per sample
  // the smears fuse into a continuum; above ~3px you see discrete ghosts. After
  // Effects makes you guess 16 or 32 and caps it with an "adaptive sample
  // limit"; measuring the travel spends exactly what the pixels need, so
  // `maxSamples` only ever protects the frame budget and never sets the look.
  //
  // The `velocity` tier gets a sample list like any other, but a short one: its
  // saving is not fewer draws, it is that each draw is a plain TRANSLATION
  // along the measured vector, so it never re-samples a keyframe, re-evaluates
  // a modulator or rebuilds a pose. Eight steps is where a straight-line smear
  // stops looking stepped, and going past that spends real time for a tier
  // whose whole job is to be cheap.
  const ideal = Math.ceil(effectivePx / SAMPLE_SPACING_PX);
  const ceiling = tier === "velocity" ? Math.min(maxSamples, VELOCITY_TIER_SAMPLES) : maxSamples;
  const n = Math.max(2, Math.min(ceiling, ideal));

  const samples: ShutterSample[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    // Sample at bin CENTRES, not at the window's ends. Sampling the endpoints
    // would double-count the shutter's edges across adjacent frames and make a
    // constant-velocity pan pulse once per frame.
    const u = n === 1 ? 0.5 : (i + 0.5) / n;
    const w = Math.max(0, shutterWeight(settings.weighting, u, settings.curve));
    samples.push({ timeMs: openMs + u * (closeMs - openMs), weight: w });
    total += w;
  }
  // A curve authored flat at zero would divide by nothing; fall back to uniform
  // rather than returning an invisible layer.
  if (total <= 1e-6) {
    for (const s of samples) s.weight = 1 / samples.length;
  } else {
    for (const s of samples) s.weight /= total;
  }

  // THE FADE. Strength follows speed between the epsilon and full travel, so
  // there is no frame where the layer jumps from crisp to smeared (smoothstep,
  // so the ramp has no corner of its own to see).
  const t = Math.min(1, Math.max(0, (effectivePx - MOTION_EPSILON_PX) / (MOTION_FULL_PX - MOTION_EPSILON_PX)));
  const fade = t * t * (3 - 2 * t);
  const faded = fade < 1 ? { ...settings, strength: settings.strength * fade } : settings;

  return { samples, openMs, closeMs, motionPx: motion.px, motion, tier, settings: faded };
}

/**
 * THE EXPOSURE — exactly how much of each picture the finished frame holds.
 *
 * A plan names instants; this names the SUM, so no renderer has a mixing rule
 * of its own to get wrong:
 *
 *   frame = crisp · C  +  smear · ⊕(weightsᵢ · Sᵢ)
 *
 * where C is the layer at the frame time, Sᵢ its picture at sample i, and ⊕ the
 * look's combine (a sum, a screen or a max). Everything is premultiplied, so
 * the sum is the physical one: a pixel's colour AND its coverage mix.
 *
 * ── Why the mix is a lerp and nothing else ──────────────────────────────────
 *
 * The renderer used to paint the crisp layer at full alpha and the smear OVER
 * it at `strength`. For opaque pixels that reads as a mix; for anything with
 * alpha below one — a glow, a soft shadow, a layer at 40% — it is
 * `c + s·c·(1 − c)`, brighter than both the still frame and the full smear.
 * Strength fades in with speed (see `resolveShutter`), so the brightening
 * landed on exactly the frames where a move starts and stops: one flash as a
 * glow began to travel, one as it settled, in every export. Here the two
 * shares always sum to the whole exposure, so the frame's light is conserved
 * at every strength, and there is no strength at which the crisp layer
 * switches off — it fades out continuously as the smear fades in.
 */
export interface ShutterExposure {
  /** How the samples pile up before the mix. `sum` covers average and add. */
  combine: "sum" | "screen" | "max";
  /** Each sample's share of the smear, in `plan.samples` order, each ≤ 1. */
  weights: number[];
  /** The frame-time picture's share of the finished frame. */
  crisp: number;
  /** The combined samples' share of the finished frame. */
  smear: number;
}

export function shutterExposure(plan: ShutterPlan): ShutterExposure {
  const { combine } = plan.settings;
  const strength = Math.min(1, Math.max(0, plan.settings.strength));
  // At `average` each sample brings its share and the shares sum to one. The
  // other modes are LOOKS: the heaviest sample lands at full strength and the
  // rest at their weighting's share of it, so overlapping exposures pile up
  // into light — tail-lights drawing a streak instead of averaging down into
  // grey. Scaled to the PEAK, not by the count: ×count then clamped at 1 cut
  // every weighting in half, so a trail came out a solid capsule that faded
  // only over its oldest half instead of a comet fading head to tail.
  const peak = combine === "average" ? 1 : Math.max(...plan.samples.map((s) => s.weight));
  const boost = peak > 1e-9 ? 1 / peak : 1;
  return {
    combine: combine === "screen" ? "screen" : combine === "max" ? "max" : "sum",
    weights: plan.samples.map((s) => Math.min(1, s.weight * boost)),
    crisp: 1 - strength,
    smear: strength,
  };
}

/**
 * EACH SAMPLE'S BIN, INTEGRATED — the sub-steps that turn N point samples into
 * a continuous exposure.
 *
 * A plan samples each bin of the shutter at its centre, and the count is
 * capped (`maxSamples`) because a sample is a POSE: an expression, a body, a
 * keyframe evaluated. Past the cap, point samples sit more than
 * `SAMPLE_SPACING_PX` apart and a fast move shows as ghosted copies instead
 * of a streak. A pose tier banks ONE picture and only re-places it, and a
 * placement is a quad on the GPU, so each bin is integrated whole: the
 * picture placed at `k` sub-steps across the bin, its placement interpolated
 * between the evaluated neighbours (extrapolated half a bin at the ends), `k`
 * as many as keep the steps under the spacing. For motion that is linear
 * across a bin this is the exact box; a curve is followed at the evaluated
 * samples, as before.
 *
 * Returns fractional sample indices (`at` = i ± ½ inside bin i) and weights:
 * a bin's weight is shared by its sub-steps when the exposure ADDS (`sum`,
 * `screen`), and carried by each when it takes the brightest (`max`), so a
 * trail is as bright as before. `binPx` is the travel of one bin in the pixels
 * the picture is placed in; `cap` bounds the sub-steps per bin.
 */
export function shutterSubsteps(
  weights: readonly number[],
  binPx: number,
  combine: ShutterExposure["combine"],
  cap = 32,
): Array<{ at: number; weight: number }> {
  const n = weights.length;
  const k = n < 2 ? 1 : Math.max(1, Math.min(cap, Math.ceil(binPx / SAMPLE_SPACING_PX)));
  const share = combine === "max" ? 1 : k;
  const out: Array<{ at: number; weight: number }> = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < k; j++) out.push({ at: i - 0.5 + (j + 0.5) / k, weight: weights[i]! / share });
  }
  return out;
}

/**
 * THE CUT — a shutter never exposes across a step.
 *
 * A HOLD key (a camera cut, a pose on twos, a teleport) changes a layer's
 * placement in no time at all. Motion blur integrates what the layer DOES
 * across the open shutter, and a step does nothing across it: it is two
 * pictures. A window straddling one averaged them, so every step landing
 * inside an open shutter came out as one frame of double exposure — a 50/50
 * ghost of the before and after, whatever ancestor (a camera group, a parent
 * rig, a nested comp's remap) held the key.
 *
 * So the window is cut at the step and keeps only the side the frame's own
 * instant is on. Found by MEASUREMENT, not by reading keyframes: a step can
 * live in any ancestor, an expression or a time remap, and the caller's
 * placement sampler already sees all of them. Halving an interval halves a
 * continuous move's travel but leaves a step's whole; after `STEP_BISECTIONS`
 * halvings an interval still holding most of the travel is a step.
 *
 * `at(t)` is the layer's placement at an instant, `dist` the travel between
 * two. Costs one extra sample for a moving layer (the midpoint test) and
 * `STEP_BISECTIONS` more only when that test says one half did all the moving.
 */
export function cutShutterAtSteps<P>(
  window: { openMs: number; closeMs: number },
  atMs: number,
  at: (t: number) => P,
  dist: (a: P, b: P) => number,
): { openMs: number; closeMs: number } {
  let { openMs, closeMs } = window;
  for (let pass = 0; pass < 2 && closeMs > openMs; pass++) {
    const pOpen = at(openMs);
    const pClose = at(closeMs);
    const total = dist(pOpen, pClose);
    if (total < MOTION_EPSILON_PX) break;
    // The gate: continuous motion splits its travel between the halves.
    const mid = (openMs + closeMs) / 2;
    const pMid = at(mid);
    const left = dist(pOpen, pMid);
    const right = dist(pMid, pClose);
    if (Math.max(left, right) < STEP_SHARE * total) break;
    let a = openMs, b = closeMs, pa = pOpen, pb = pClose;
    if (left >= right) { b = mid; pb = pMid; } else { a = mid; pa = pMid; }
    for (let i = 0; i < STEP_BISECTIONS; i++) {
      const m = (a + b) / 2;
      const pm = at(m);
      if (dist(pa, pm) >= dist(pm, pb)) { b = m; pb = pm; } else { a = m; pa = pm; }
    }
    if (dist(pa, pb) < STEP_SHARE * total) break; // a fast, smooth move: blur it
    // The frame's instant decides the side: it shows what its own pose shows.
    const pAt = at(atMs);
    const after = dist(pAt, pb) <= dist(pAt, pa);
    if (after) openMs = Math.min(b, Math.max(atMs, a));
    else closeMs = Math.max(a, Math.min(atMs, b));
  }
  return { openMs, closeMs };
}

/** How many halvings tell a step from a move (a 180° shutter at 60 fps: ~16 µs). */
const STEP_BISECTIONS = 9;
/** The share of the window's travel one infinitesimal interval must hold to be a step. */
const STEP_SHARE = 0.8;

/**
 * The exposure window in clip-local ms.
 *
 * `shutterAngle / 360` of one frame interval, opening at `shutterPhase / 360`.
 * The frame INTERVAL is the comp's own, which is the whole reason the shutter
 * is stored per-frame: a 180° shutter in a 12fps sheet is a five-times-longer
 * exposure than the same angle in a 60fps comp, and that is correct — a rate is
 * a grid, and the shutter is a fraction of one cell of it.
 */
export function shutterWindow(
  frameIntervalMs: number,
  localMs: number,
  settings: Pick<MotionBlurSettings, "shutterAngle" | "shutterPhase">,
): { openMs: number; closeMs: number } {
  const openMs = localMs + (settings.shutterPhase / 360) * frameIntervalMs;
  return { openMs, closeMs: openMs + (settings.shutterAngle / 360) * frameIntervalMs };
}
