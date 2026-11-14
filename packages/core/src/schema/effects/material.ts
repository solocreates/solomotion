import { z } from "zod";

import { layerEffectBase, ownMotion } from "./shared";

/**
 * Materials — the cards that read the pixels BEHIND the layer. Today that is
 * liquid glass alone, and it is a family rather than a card because the
 * capability (a backdrop snapshot, a distance field, a GL context) is what
 * makes it expensive, not the number of entries.
 */

/**
 * The BEZEL PROFILE — how the glass surface rises from its edge to its flat
 * top, as a function of distance from the edge. This is the one choice that
 * decides what the rim looks like, because the surface SLOPE is what bends the
 * light: a profile that goes vertical at the edge stretches the backdrop into
 * the streaks people mean by "liquid", one that stays shallow only smears it.
 *
 *   squircle  ⁴√(1 − (1−t)⁴) — flat-then-curve; Apple's, and the default.
 *   circle    √(1 − (1−t)²)  — a true quarter-round; harsher, more lens-like.
 *   lip       a raised rim with a shallow dish behind it.
 *   concave   a dish — light diverges, the backdrop pushes outward.
 */
export const GLASS_PROFILES = ["squircle", "circle", "lip", "concave"] as const;
export type GlassProfile = (typeof GLASS_PROFILES)[number];

export const MATERIAL_EFFECT_ARMS = [
  /**
   * Liquid glass (v45, rebuilt v76) — the MATERIAL effect. Unlike every other
   * card here, it reads the pixels BEHIND the layer.
   *
   * The physical model is a slab of glass whose top has a rounded BEZEL of
   * width `depth` running along the layer's silhouette: the middle of the pane
   * is flat and transmits the (frosted) backdrop untouched; the bezel tilts,
   * and light entering through it refracts (Snell, at `ior`) so the backdrop
   * seen through the rim is pulled toward the centre — hardest right at the
   * edge, where the profile goes vertical. That one fact is why the rim reads
   * as stretched glass rather than as a blurred stroke, and why it looks right
   * on a sharp rectangle, a 128px-radius card, a letter S and a hand-drawn
   * path alike: the bezel is measured as a DISTANCE FROM THE EDGE, never as a
   * blur of the shape.
   *
   * It works on ANY layer because it consumes nothing but alpha + backdrop —
   * shapes, text, vector paths, images, video, nested comps. Every numeric
   * field is keyframable through `lfx.<id>.<field>` like the rest.
   *
   * The v76 rebuild deleted `curvature`, `sheen`, `shade`, the edge line and
   * the light elevation: every one of them was a 2015 bevel dressed up as
   * glass. What remains is the Figma/Apple control set — refraction, depth,
   * dispersion, frost, a light with an angle, an intensity and a splay — and
   * the rest sits under Advanced.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("glass"),
    ...ownMotion(true),
    // ── The look ────────────────────────────────────────────────────────────
    /** How hard the bezel bends the backdrop. 0 = a frosted pane, 1 = a lens. */
    refraction: z.number().min(0).max(1).default(0.8),
    /** Bezel width in px — how far in from the edge the curve reaches. */
    depth: z.number().min(0).max(600).default(36),
    /** Chromatic splitting along the bezel — the prism fringe. */
    dispersion: z.number().min(0).max(1).default(0.35),
    /** Blur applied to the backdrop seen through the glass, in px. */
    frost: z.number().min(0).max(200).default(6),
    // ── Light ───────────────────────────────────────────────────────────────
    /** Where the light comes from, in degrees (−90 = straight above). */
    lightAngle: z.number().min(-180).max(180).default(-45),
    /** Brightness of the rim highlight. Past 1 it blows out. */
    light: z.number().min(0).max(2).default(0.8),
    /** How far the highlight spreads round the rim and into the pane. */
    splay: z.number().min(0).max(1).default(0.35),
    lightColor: z.string().default("#ffffff"),
    // ── Advanced: shape ─────────────────────────────────────────────────────
    profile: z.enum(GLASS_PROFILES).default("squircle"),
    /** Index of refraction — shapes how sharply the bend grows toward the edge. */
    ior: z.number().min(1).max(2.5).default(1.5),
    /** Shrink (+) or grow (−) the pane relative to the layer, px. */
    inset: z.number().min(-200).max(200).default(0),
    /**
     * Alpha counted as a whole pane. A 20%-opacity fill is still a full sheet
     * of glass, not a fifth of one — the layer's alpha is its TINT (see
     * `paint`), not its coverage.
     */
    coverage: z.number().min(0.02).max(1).default(0.1),
    /** Master wet/dry — blends the whole material over the untouched layer. */
    mix: z.number().min(0).max(1).default(1),
    // ── Advanced: tint ──────────────────────────────────────────────────────
    /**
     * How much of the layer's OWN paint shows over the glass, as a multiplier
     * on its alpha. The default drops an opaque fill to a 20% tint — what
     * Figma does to the fill when you add its glass, done without touching
     * yours — so an ordinary shape reads as glass the moment the card lands.
     */
    paint: z.number().min(0).max(1).default(0.2),
    tintColor: z.string().default("#ffffff"),
    tint: z.number().min(0).max(1).default(0),
    /** Saturation / brightness of the transmitted light. */
    saturation: z.number().min(0).max(3).default(1.08),
    brightness: z.number().min(0).max(3).default(1),
    // ── Advanced: surface ───────────────────────────────────────────────────
    /** Micro-frost grain on the surface. */
    noise: z.number().min(0).max(1).default(0),
    noiseScale: z.number().min(0.1).max(16).default(1),
    /** Liquid wobble — a travelling wave folded into the surface. */
    ripple: z.number().min(0).max(1).default(0),
    rippleScale: z.number().min(0.1).max(16).default(2),
    /** Wave phase in degrees (keyframe it, or let `rippleSpeed` drive it). */
    ripplePhase: z.number().default(0),
    /** Cycles per second added to the phase from the clip's own local time. */
    rippleSpeed: z.number().min(-8).max(8).default(0),
    /** Render scale of the material pass: 1 = full res, 0.5 = quarter cost. */
    quality: z.number().min(0.25).max(1).default(1),
    /** Rim highlight only — skips the (costlier) backdrop refraction. */
    edgeOnly: z.boolean().default(false),
  }),
] as const;
