import type { KeyframeValue } from "../schema";
import type { Modulator } from "../schema/modulators";
import type { GlassEffect } from "../schema/layer-effects";
import { GLASS_PROFILES, type GlassProfile } from "../schema/effects/material";
import { ownClockSec } from "./effect-base";
import { resolveEffectValues } from "./effect-values";
import { layerEffectPath, layerEffectTypeDef } from "./layer-effects";

/**
 * The liquid-glass MATERIAL brain — pure math, no pixels.
 *
 * Everything the renderer needs is derived here so the GPU path, the CPU
 * fallback and any future adapter agree by construction instead of by
 * copy-paste. The pixel engines are then dumb: take these numbers, a distance
 * field and two images, write one.
 *
 * THE MODEL, in one paragraph. The layer's silhouette is turned into a SIGNED
 * DISTANCE FIELD — every pixel knows how far it is from the nearest edge and
 * in which direction. Across the first `depth` px inside the edge the surface
 * rises along a BEZEL PROFILE (`glassBezel`); its slope there is the surface
 * tilt, and a ray entering tilted glass refracts by Snell's law at `ior`, so
 * the backdrop seen through the rim is sampled from further in — hardest at
 * the very edge, where a squircle goes vertical, which is what stretches the
 * background into the streaks that make liquid glass read as liquid. Past the
 * bezel the surface is flat and only frost, tint and the layer's own paint
 * apply. The highlight is the same slope lit from `lightAngle`, on both sides
 * of the pane (the far side dimmer), spread by `splay`.
 *
 * Why a distance field and not a blurred alpha (the v45 model): a blur of a
 * sharp corner is a rounded blob whose ramp is neither the right width nor in
 * the right place, so the rim detached from every square corner and the
 * band's gradient peaked in its MIDDLE — a bevel. Distance is exact at any
 * corner radius, including none.
 */

export interface GlassParams {
  /** Master wet/dry. 0 = the effect is a no-op (the renderer skips it). */
  mix: number;
  /** 0..1 — displacement strength; the slab thickness in units of `depth`. */
  refraction: number;
  /** Bezel width in DEVICE px (already scaled). */
  depth: number;
  dispersion: number;
  /** Backdrop blur in device px. */
  frost: number;
  /** Unit light direction in screen space (x right, y DOWN). */
  light: [number, number];
  lightIntensity: number;
  splay: number;
  lightColor: string;
  profile: GlassProfile;
  ior: number;
  /** Pane edge shift in device px: >0 shrinks the pane, <0 grows it. */
  insetPx: number;
  /** Outward growth in device px — what the layer buffer must be padded by. */
  outsetPx: number;
  coverage: number;
  /** Multiplier on the layer's own alpha when its paint composites over the glass. */
  paint: number;
  tintColor: string;
  tint: number;
  saturation: number;
  brightness: number;
  noise: number;
  noiseScale: number;
  ripple: number;
  rippleScale: number;
  /** Total wave phase in radians (authored phase + speed × local time). */
  phase: number;
  /** Render scale of the material pass, 0.25..1. */
  quality: number;
  edgeOnly: boolean;
  /**
   * How far from the edge (device px) the distance field must be resolved:
   * the bezel, plus any grow/shrink, plus the direction soften. Past this the
   * surface is flat and the field may stop early — which is what keeps a
   * 4000px pane as cheap as a 40px one.
   */
  reach: number;
  /**
   * Radius (device px) over which the field's DIRECTION is smoothed. At a
   * sharp corner the nearest-edge direction flips 90° across the diagonal;
   * blending it over a fraction of the bezel turns that crease into the
   * rounded corner a real bezel would have, while the distance — and so the
   * bezel's extent — stays exact.
   */
  soften: number;
}

const DEG = Math.PI / 180;

/**
 * Resolve one glass card at a moment in time. `sampled` carries the clip's
 * evaluated `lfx.` keyframes (so every field animates), `scale` is device px
 * per frame px, and `timeSec` is the clip's LOCAL time — which is what makes
 * `rippleSpeed` deterministic: the same frame always renders the same wave,
 * in preview and in export, whatever order frames are rendered in.
 */
export function resolveGlassParams(
  fx: GlassEffect,
  sampled: Record<string, KeyframeValue>,
  scale: number,
  timeSec: number,
  resolveColor: (c: string) => string = (c) => c,
  /** The owning clip's modulators — every glass field is bindable like any other. */
  modulators?: readonly Modulator[],
): GlassParams {
  const fields = layerEffectTypeDef("glass")?.fields ?? [];
  const v = resolveEffectValues(fields, fx as unknown as Record<string, unknown>, sampled, (k) => layerEffectPath(fx.id, k), {
    scale,
    modulators,
    timeSec,
    resolveColor,
  });
  const num = (k: string, fallback = 0) => (typeof v[k] === "number" ? (v[k] as number) : fallback);
  const str = (k: string, fallback: string) => (typeof v[k] === "string" ? (v[k] as string) : fallback);

  const depth = Math.max(0, num("depth"));
  const inset = num("inset");
  const az = num("lightAngle") * DEG;
  const profileRaw = str("profile", "squircle");
  const profile = (GLASS_PROFILES as readonly string[]).includes(profileRaw) ? (profileRaw as GlassProfile) : "squircle";
  // A quarter of the bezel is enough to round a crease without visibly
  // shifting where the highlight sits; capped so a 600px lens does not ask
  // for a 150px blur.
  const soften = Math.min(32 * scale, depth * 0.45);

  return {
    mix: clamp(num("mix", 1), 0, 1),
    refraction: clamp(num("refraction"), 0, 1),
    depth,
    dispersion: clamp(num("dispersion"), 0, 1),
    frost: Math.max(0, num("frost")),
    // Figma's dial: −90° is straight above, −45° top-left, 0° from the left.
    light: [-Math.cos(az), Math.sin(az)],
    lightIntensity: Math.max(0, num("light")),
    splay: clamp(num("splay"), 0, 1),
    lightColor: str("lightColor", "#ffffff"),
    profile,
    ior: Math.max(1, num("ior", 1.5)),
    insetPx: inset,
    outsetPx: Math.max(0, -inset),
    coverage: clamp(num("coverage", 0.1), 0.02, 1),
    paint: clamp(num("paint", 1), 0, 1),
    tintColor: str("tintColor", "#ffffff"),
    tint: clamp(num("tint"), 0, 1),
    saturation: Math.max(0, num("saturation", 1)),
    brightness: Math.max(0, num("brightness", 1)),
    noise: clamp(num("noise"), 0, 1),
    noiseScale: Math.max(0.1, num("noiseScale", 1)),
    ripple: clamp(num("ripple"), 0, 1),
    rippleScale: Math.max(0.1, num("rippleScale", 1)),
    phase: (num("ripplePhase") + num("rippleSpeed") * 360 * ownClockSec(fx, timeSec)) * DEG,
    quality: clamp(num("quality", 1), 0.25, 1),
    edgeOnly: fx.edgeOnly,
    reach: depth + Math.abs(inset) + soften + 2,
    soften,
  };
}

/** True when the card would paint nothing — the renderer's early-out. */
export function glassIsNoop(p: GlassParams): boolean {
  return p.mix <= 0.002;
}

/**
 * Does this instance's output change with time on its own? Glass carries no
 * temporal clock; it moves only when its ripple is being driven. Stated here
 * (not as a type-level flag) because a type-level "yes" made every glass card
 * run the effect editor's preview clock — a full document re-render per frame
 * — while the user was paused, nudging a slider on a pane that never moved.
 */
export function glassMoves(fx: Pick<GlassEffect, "rippleSpeed" | "ripple">): boolean {
  return fx.ripple > 0.001 && fx.rippleSpeed !== 0;
}

// ── The profile, shared with the CPU fallback and stated once for the shader ─

/**
 * The bezel at `t` ∈ [0, 1] (0 = the edge, 1 = the top of the bezel): the
 * surface HEIGHT (0..1, or dipping below for a lip) and its SLOPE — the tangent
 * of the surface tilt, in height-per-bezel-width. The slope is what the
 * renderer refracts by; the height only matters for the `lip` blend.
 *
 * Convex profiles go vertical at t = 0. The slope is clamped rather than left
 * infinite so the very first pixel refracts at the critical angle instead of
 * at NaN, which is exactly what a real bezel's finite curvature would give.
 */
export function glassBezel(t: number, profile: GlassProfile): { height: number; slope: number } {
  const u = clamp(t, 0, 1);
  const x = 1 - u; // distance from the top of the bezel, 0..1
  const convex = (kind: "squircle" | "circle") => {
    if (kind === "circle") {
      const h = Math.sqrt(Math.max(0, 1 - x * x));
      return { height: h, slope: Math.min(MAX_SLOPE, h > 1e-4 ? x / h : MAX_SLOPE) };
    }
    const x4 = x * x * x * x;
    const h = Math.pow(Math.max(0, 1 - x4), 0.25);
    const h3 = h * h * h;
    return { height: h, slope: Math.min(MAX_SLOPE, h3 > 1e-5 ? (x * x * x) / h3 : MAX_SLOPE) };
  };
  switch (profile) {
    case "circle":
      return convex("circle");
    case "concave": {
      const c = convex("squircle");
      return { height: 1 - c.height, slope: -c.slope };
    }
    case "lip": {
      // A rim that rises like a squircle, then dishes gently behind it. The
      // dish is the concave profile faded in past the crest, so the slope
      // turns negative (light diverges) toward the middle of the bezel.
      const c = convex("squircle");
      const w = smootherstep(u);
      const dish = { height: 0.85 + 0.15 * (1 - c.height), slope: -0.15 * c.slope };
      return {
        height: c.height * (1 - w) + dish.height * w,
        slope: c.slope * (1 - w) + dish.slope * w,
      };
    }
    default:
      return convex("squircle");
  }
}

/** Steepest slope a bezel may report — tan(~86°). */
export const MAX_SLOPE = 14;

/**
 * Snell's law for a ray arriving straight down onto a surface tilted by
 * `slope` (tan θ₁): how far, per unit of slab thickness, the ray lands from
 * where it entered — tan θ₂. Signed with the slope, so a concave dish pushes
 * the sample the other way.
 */
export function glassRefract(slope: number, ior: number): number {
  const theta1 = Math.atan(Math.abs(slope));
  const s = Math.sin(theta1) / Math.max(1, ior);
  const theta2 = Math.asin(Math.min(1, s));
  return Math.sign(slope) * Math.tan(theta2);
}

/**
 * The displacement, in px, of the backdrop sample at `dist` px inside the
 * edge. The slab's effective thickness is `refraction × depth`; a pane with
 * no bezel bends nothing.
 */
export function glassDisplacementPx(dist: number, p: Pick<GlassParams, "depth" | "refraction" | "ior" | "profile">): number {
  if (p.depth <= 0.01 || dist >= p.depth) return 0;
  const { slope } = glassBezel(dist / p.depth, p.profile);
  return glassRefract(slope, p.ior) * p.refraction * p.depth;
}

function smootherstep(t: number): number {
  const u = clamp(t, 0, 1);
  return u * u * u * (u * (u * 6 - 15) + 10);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
