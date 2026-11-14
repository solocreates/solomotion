import { z } from "zod";

import { blendMode, layerEffectBase, ownMotion, sweepClock, temporalClock } from "./shared";

/**
 * LIGHT & OPTICS (v57) — the family that ADDS light rather than restyling what
 * is already there.
 *
 * Every card here paints something that was not in the layer's pixels: a band
 * travelling across it, rays leaving it, the lens's own response to it, an arc
 * struck through it. That is why they are a family and not four entries under
 * Stylize — they all composite additively, they all want a colour and an
 * intensity, and most of them MOVE, which means they all lean on one of the two
 * clocks in `shared.ts` instead of each inventing a notion of time.
 *
 * They are also the app's answer to the plugins people install After Effects
 * for. A shine, a god ray, a flare and a lightning generator are not exotic;
 * they are the four things a motion designer reaches for on the first day, and
 * a tool that makes you leave for them is a tool you leave.
 */
export const LIGHT_EFFECT_ARMS = [
  /**
   * Shine — a band of light travelling across the layer, masked to its own
   * silhouette. The metallic sweep on a logo, the swipe over a glass card, the
   * shimmer that runs through a title as it lands.
   *
   * It carries the SWEEP CLOCK, which is the whole design: `duration` makes the
   * band cross on its own from the clip's local time, so a preset can ship a
   * finished animation without a single keyframe, and `position` still
   * keyframes for the times you want to place it by hand. Both paths add, the
   * way glass's ripple already does.
   *
   * `count` and `gap` exist because the classic look is TWO bands — a wide one
   * with a narrow one chasing it — and building that from two stacked cards
   * means keeping two durations in sync by hand forever.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("shine"),
    ...sweepClock,
    ...ownMotion(true),
    /** Travel direction in degrees; the band sits across it. */
    angle: z.number().min(-180).max(180).default(-20),
    /** Band thickness in px. */
    width: z.number().min(0).max(3000).default(140),
    /** 0 = a hard bar of light, 1 = a soft gradient with no edge at all. */
    softness: z.number().min(0).max(1).default(0.6),
    /** How many bands travel together. */
    count: z.number().int().min(1).max(6).default(1),
    /** Spacing between bands, as a fraction of the travel. */
    gap: z.number().min(0.01).max(1).default(0.18),
    /** Each following band's share of the first one's strength. */
    falloff: z.number().min(0).max(1).default(0.55),
    color: z.string().default("#ffffff"),
    /** Band strength. Past 1 the core blows out into a specular hit. */
    intensity: z.number().min(0).max(3).default(1),
    /** Blurs the band — the dial from a chrome edge to a soft sheen. */
    bloom: z.number().min(0).max(300).default(14),
    blend: blendMode.default("screen"),
    /** Keep the light inside the layer's silhouette (off = a free light bar). */
    inside: z.boolean().default(true),
  }),
  /**
   * Light rays — volumetric shafts leaving the layer's own bright areas.
   *
   * The physical model is a radial smear of the pixels that survive
   * `threshold`, accumulated outward from a movable source. Because the rays
   * are made OF the layer, a multicoloured logo throws multicoloured shafts and
   * a retint carries into them with nothing to update — the same reasoning that
   * made Glow's `auto` mode the default.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("lightRays"),
    /** Source X as a fraction of half-width (−1..1, 0 = middle). */
    centerX: z.number().min(-2).max(2).default(0),
    centerY: z.number().min(-2).max(2).default(0),
    /** Ray reach, as a fraction of the layer's span. */
    length: z.number().min(0).max(1).default(0.45),
    intensity: z.number().min(0).max(3).default(1),
    /** How fast a shaft dims along its length. 1 is linear. */
    decay: z.number().min(0.1).max(4).default(1.1),
    /** Only pixels brighter than this emit. Lower it to make everything glow. */
    threshold: z.number().min(0).max(1).default(0.5),
    /** `auto` casts the layer's own colours; `solid` casts `color`. */
    mode: z.enum(["auto", "solid"]).default("auto"),
    color: z.string().default("#ffe9a8"),
    /** AUTO only — pushes the borrowed colours before they are cast. */
    saturation: z.number().min(0).max(4).default(1.3),
    /** Steps along a ray. Fewer is cheaper and reads as banded shafts. */
    samples: z.number().int().min(4).max(96).default(28),
    blend: blendMode.default("lighter"),
    /** Cast the shafts BEHIND the layer instead of over it. */
    behind: z.boolean().default(false),
  }),
  /**
   * Lens flare — the camera's own response to a bright point: an anamorphic
   * streak, an iris halo, and ghosts marching back through the optical axis.
   *
   * Its centre is in the layer's own coordinates and can sit outside it, which
   * is what lets a flare be parented to a moving highlight and swing its ghosts
   * across the frame the way a real lens does.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("lensFlare"),
    centerX: z.number().min(-3).max(3).default(-0.4),
    centerY: z.number().min(-3).max(3).default(-0.3),
    brightness: z.number().min(0).max(3).default(1),
    /** Overall flare size in px. */
    size: z.number().min(0).max(4000).default(280),
    color: z.string().default("#ffe9c0"),
    /** Length of the horizontal anamorphic streak, 0 = none. */
    streak: z.number().min(0).max(1).default(0.7),
    streakColor: z.string().default("#6fb6ff"),
    streakAngle: z.number().min(-180).max(180).default(0),
    /** The soft round halo at the source. */
    halo: z.number().min(0).max(1).default(0.45),
    /** How many ghost irises march back along the optical axis. */
    ghosts: z.number().int().min(0).max(12).default(5),
    /** How far the ghosts travel; negative sends them the other way. */
    ghostSpread: z.number().min(-2).max(2).default(0.75),
    /** Colour separation across the ghost chain — the rainbow in a cheap lens. */
    ghostChroma: z.number().min(0).max(1).default(0.6),
    blend: blendMode.default("lighter"),
    /** Clip the whole flare to the layer's silhouette. */
    inside: z.boolean().default(false),
  }),
  /**
   * Lightning — the arc generator, and the reason nobody should have to install
   * a plugin for one.
   *
   * `mode` is what makes it one card instead of four. A bolt between two
   * points, a discharge running along the layer's own outline, arcs thrown
   * across the inside of its shape, and a burst out of a centre are the same
   * recursive midpoint-displaced polyline sampled off a different spine — so
   * they are an enum, not four effects with four sets of drifting fields.
   *
   * `outline` (v76) is PATH-PRECISE: on a shape or path layer it follows the
   * actual vector geometry — chaos 0 sits exactly on the stroke — and on any
   * other layer it follows a trace of the silhouette. `span`, `offset` and
   * `drift` place the arcs along that outline and move them without a key.
   *
   * The geometry itself lives in `animation/lightning.ts`, resolved from the
   * temporal clock, so a strike is a pure function of (seed, time) and an
   * export is the same lightning the preview was approved from.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("lightning"),
    ...temporalClock,
    ...sweepClock,
    ...ownMotion(true),
    mode: z.enum(["bolt", "outline", "fill", "burst"]).default("bolt"),
    /** Bolt endpoints, in layer space (−1..1 from the centre). */
    ax: z.number().min(-2).max(2).default(-0.8),
    ay: z.number().min(-2).max(2).default(-0.6),
    bx: z.number().min(-2).max(2).default(0.8),
    by: z.number().min(-2).max(2).default(0.6),
    /** How many arcs at once (outline, fill and burst). */
    count: z.number().int().min(1).max(24).default(1),
    /** OUTLINE — fraction of the outline each arc covers. 1 = the whole edge. */
    span: z.number().min(0.02).max(1).default(1),
    /** OUTLINE — where along the outline the first arc starts (0..1). */
    offset: z.number().min(-2).max(2).default(0),
    /** OUTLINE — laps per second added to `offset` from the clip's own time. */
    drift: z.number().min(-4).max(4).default(0),
    /** How far the arc wanders off its spine. */
    chaos: z.number().min(0).max(1).default(0.5),
    /** Levels of recursive subdivision — the arc's fine structure. */
    detail: z.number().int().min(1).max(9).default(6),
    /** How many forks leave each arc. */
    branches: z.number().int().min(0).max(24).default(5),
    /** Fork length as a fraction of the arc. */
    branchLength: z.number().min(0).max(1).default(0.4),
    /** Core thickness in px. */
    width: z.number().min(0).max(60).default(3),
    /** How much the arc thins toward its far end. */
    taper: z.number().min(0).max(1).default(0.6),
    /** Brightness randomness per re-roll — the crackle of a live arc. */
    flicker: z.number().min(0).max(1).default(0.25),
    /** The hot centre of the arc. */
    coreColor: z.string().default("#ffffff"),
    /** The corona around it — this is the colour the strike reads as. */
    color: z.string().default("#8fc4ff"),
    /** Corona spread in px. */
    glow: z.number().min(0).max(300).default(22),
    intensity: z.number().min(0).max(3).default(1),
    blend: blendMode.default("lighter"),
    /** Keep the discharge inside the layer's silhouette. */
    inside: z.boolean().default(false),
  }),
] as const;
