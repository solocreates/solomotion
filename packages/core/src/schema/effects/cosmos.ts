import { z } from "zod";

import { layerEffectBase, ownMotion } from "./shared";

/**
 * COSMOS (v107) — the Space category. Two kinds of card, one family because
 * they are one chunk of renderer and one subject:
 *
 *  - cards that BEND what is behind the layer (`readsBackdrop`, like glass):
 *    a gravitational lens, a travelling shockwave. They replace their layer's
 *    own picture with the warped backdrop — the carrier is a placement (a
 *    small circle is the usual one); its paint is never drawn.
 *  - cards that PAINT a piece of sky into the layer's silhouette: a star's
 *    photosphere, a starfield, a nebula. A full-frame rectangle with Nebula is
 *    a nebula; a circle with Star is a star.
 *
 * Radii are px of the document (scaled like every px field), measured from the
 * layer's centre.
 */
export const COSMOS_EFFECT_ARMS = [
  /**
   * GRAVITATIONAL LENS — a point mass's deflection, the backdrop seen at
   * β = θ − strength·θE²/θ: everything behind is pushed out of the middle and
   * wrapped round it, a source directly behind becomes an EINSTEIN RING at
   * `radius`, and inside it the far side's image appears flipped (the
   * secondary image). A pure black SHADOW (a black hole's is 2.6× its
   * horizon) with a thin PHOTON RING burning at its edge. An accretion disk
   * drawn behind the lens arcs over its top and under its bottom as a
   * consequence of the warp — nothing draws an arc.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("lens"),
    /** The Einstein radius, px: where a source straight behind becomes a ring. */
    radius: z.number().min(0).max(4000).default(230),
    /** How much of that bend there is, 0..1 — key it up from 0 to watch space start to curve. */
    strength: z.number().min(0).max(1).default(1),
    /** The black shadow's radius, px (0 = a lens with no hole: a galaxy, dark matter). */
    shadow: z.number().min(0).max(4000).default(92),
    /** The photon ring's brightness at the shadow's edge. */
    ring: z.number().min(0).max(4).default(1),
    /** Its width, px. */
    ringWidth: z.number().min(0.5).max(200).default(3),
    ringColor: z.string().default("#ffe2bd"),
    /** The soft light hugging the shadow outside the ring. */
    glow: z.number().min(0).max(2).default(0.35),
    /** How far the bend reaches before it settles, × the Einstein radius. */
    reach: z.number().min(1.5).max(10).default(4),
  }),
  /**
   * SHOCKWAVE — a ring of compressed space travelling out from the layer's
   * centre, refracting what is behind it: the backdrop is pushed outward on
   * the ring's leading edge and pulled in on its trailing edge (the derivative
   * of a Gaussian, the way a pressure front bends light), with a slight
   * chromatic split and a thin bright front. Key `radius` to make it travel,
   * `strength` down to let it die. Like the lens it replaces its carrier's
   * picture, and outside the ring the backdrop shows untouched.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("shockwave"),
    /** Where the front is, px from the centre. */
    radius: z.number().min(0).max(8000).default(300),
    /** The ring's thickness, px. */
    width: z.number().min(1).max(2000).default(60),
    /** How far it pushes the backdrop, px. */
    strength: z.number().min(-400).max(400).default(36),
    /** Red and blue bent apart, 0..1. */
    chroma: z.number().min(0).max(1).default(0.35),
    /** A thin bright front. */
    light: z.number().min(0).max(2).default(0.25),
    color: z.string().default("#cfe3ff"),
  }),
  /**
   * STAR — a photosphere painted into the layer's silhouette (a circle is the
   * star; its size is the disc). Granulation that BOILS (convection cells: bright
   * granules, dark lanes), limb darkening (the edge is cooler and dimmer), a
   * corona past the edge, and its colour from `temperature` through core's one
   * `blackbody` — key 5,800 K → 30,000 K and it goes from sunlight to blue-white.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("star"),
    ...ownMotion(true),
    /** Surface temperature, K. */
    temperature: z.number().min(1000).max(50000).default(5800),
    /** How bright it reads — past 1 the middle burns toward white. */
    brightness: z.number().min(0).max(4).default(1.2),
    /** A convection cell's size, × the star's radius (the Sun ≈ 0.04; a red supergiant's few giant cells ≈ 0.25). */
    granulation: z.number().min(0.005).max(0.6).default(0.03),
    /** How strongly the cells show. */
    contrast: z.number().min(0).max(1).default(0.6),
    /** How fast the surface boils, per second. */
    boil: z.number().min(0).max(8).default(0.35),
    /** Limb darkening: how much dimmer and redder the edge is. */
    limb: z.number().min(0).max(1).default(0.65),
    /** The corona's brightness past the edge. */
    corona: z.number().min(0).max(4).default(0.6),
    /** How far the corona reaches, × the radius. */
    coronaSize: z.number().min(0).max(6).default(0.9),
    seed: z.number().int().min(0).max(99999).default(1),
  }),
  /**
   * STARFIELD — a real-looking sky in the layer's silhouette (the layer's own
   * paint is the space between the stars). Seeded; a realistic magnitude
   * distribution (≈2.8× as many stars each magnitude fainter, so a few bright
   * ones and thousands at the edge of seeing); spectral colours from
   * blackbodies of real star types; twinkle; diffraction spikes on the
   * brightest few; a faint galactic band; and DEPTH — each star has its own
   * distance, so keying `driftX/driftY` moves near stars more than far ones
   * (parallax), wrapping forever.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("starfield"),
    ...ownMotion(true),
    /** Stars per million px of the document. */
    density: z.number().min(0).max(20000).default(1800),
    brightness: z.number().min(0).max(4).default(1),
    /** A star's core size, px. */
    size: z.number().min(0.3).max(12).default(1.1),
    /** How much of each star's spectral colour shows (0 = all white). */
    spectral: z.number().min(0).max(1).default(0.65),
    /** Scintillation: how much each star flickers. */
    twinkle: z.number().min(0).max(1).default(0.25),
    /** Twinkle changes per second. */
    rate: z.number().min(1).max(60).default(12),
    /** Diffraction spikes on the brightest stars. */
    spikes: z.number().min(0).max(2).default(0.6),
    spikeAngle: z.number().min(-180).max(180).default(45),
    /** A faint band of the galaxy across the sky. */
    band: z.number().min(0).max(1).default(0.35),
    bandAngle: z.number().min(-180).max(180).default(-28),
    /** Where the sky has drifted to, px — near stars move the full amount, the farthest a fifth (parallax). */
    driftX: z.number().min(-100000).max(100000).default(0),
    driftY: z.number().min(-100000).max(100000).default(0),
    seed: z.number().int().min(0).max(99999).default(1),
  }),
  /**
   * NEBULA — glowing gas painted into the layer's silhouette: domain-warped
   * fractal noise (filaments that fold into each other, not blobs), a colour
   * ramp from its faint edge to its hot core, and dark DUST lanes cutting
   * across it. Its light ADDS to the layer's own paint (the sky behind). Still
   * by default; key `evolve`, or let it flow with `speed`.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("nebula"),
    ...ownMotion(false),
    /** The size of its largest clouds, px. */
    scale: z.number().min(20).max(6000).default(620),
    /** Octaves of detail. */
    detail: z.number().int().min(1).max(8).default(6),
    /** How hard the gas folds into filaments. */
    warp: z.number().min(0).max(3).default(1),
    /** How much of the sky has gas. */
    coverage: z.number().min(0).max(1).default(0.5),
    /** Its glow. */
    brightness: z.number().min(0).max(4).default(1.4),
    /** Faint edge → body → hot core. */
    colorA: z.string().default("#2a1366"),
    colorB: z.string().default("#c23a78"),
    colorC: z.string().default("#ffd2a1"),
    /** Dark dust lanes across it. */
    dust: z.number().min(0).max(1).default(0.55),
    /** The third axis of the noise — key it to make the clouds evolve. */
    evolve: z.number().min(-1000).max(1000).default(0),
    /** Evolution per second while it moves on its own. */
    speed: z.number().min(-4).max(4).default(0.04),
    /** Where the gas has drifted to, px. */
    driftX: z.number().min(-100000).max(100000).default(0),
    driftY: z.number().min(-100000).max(100000).default(0),
    seed: z.number().int().min(0).max(99999).default(1),
  }),
] as const;
