import { z } from "zod";

import { layerEffectBase, ownMotion, temporalClock } from "./shared";

/**
 * SURFACE (v109) — the texture family: the MATERIAL a picture is printed on or
 * made of. Paper, kraft, black card, linen, canvas, felt, cardboard, crumpled;
 * watercolour paper, modelling clay and blueprint paper (v111); newsprint,
 * wood and graph paper, and the MATERIAL ENGINE (v112): materials with a
 * BODY, a SHEEN, a GLOW and a FLOW, and a MORPH from one material to another.
 *
 * A material is not noise laid over a picture. It is a HEIGHT FIELD (fibres,
 * tooth, threads, ridges, folds) lit by a light from an angle, and an ALBEDO
 * (the fibres and flecks that are darker or lighter than the sheet). Both are
 * generated in core (`animation/surface.ts`) from a recipe per material, so
 * the stage, the exporter and a test read identical pixels.
 *
 * The material is a recipe TABLE, not a set of fields: what makes kraft kraft
 * (long fibres, flecks, a warm tone) is tuned once in code, and the card's
 * numbers are DIALS around that tuning (`scale`, `relief`, `tooth` are 1 at
 * the tuned value). That is why switching the material select alone gives a
 * finished material — and why a hundred materials would cost a hundred table
 * rows, not a hundred times this schema.
 *
 * THE PHYSICS DIALS (v112) follow the same rule. A recipe says how its
 * material behaves — felt rounds into a pillow, foil throws a rainbow, neon
 * is a glowing tube, marbling swirls the picture — and `body`, `sheen`,
 * `glow` and `flow` scale that behaviour, 1 = as tuned, 0 = off. They default
 * to 0 in the schema (a card saved before v112 keeps the flat look it was
 * approved with) and to 1 in `create()` (a new card is the finished material).
 *
 * THE MORPH. `to` names a second material and `morph` (keyable, 0..1) is how
 * far the first has become it; `morphStyle` is the shape of the front. Both
 * materials are evaluated whole and blended by the front, so felt becoming
 * foil is felt's pillow and fuzz giving way to foil's bevel and rainbow — not
 * a crossfade of two textures. A chain (paper → felt → foil) is hold keys on
 * `material`/`to` and a morph that runs 0→1 per link: `effects.morph` writes
 * it.
 */
export const SURFACE_MATERIALS = [
  "paper",
  "kraft",
  "blackCard",
  "linen",
  "canvas",
  "felt",
  "cardboard",
  "crumpled",
  "watercolor",
  "clay",
  "blueprint",
  "newsprint",
  "wood",
  "graph",
  // The material engine (v112): materials with a body, a sheen, a glow, a flow.
  "foil",
  "chrome",
  "neon",
  "stainedGlass",
  "frosted",
  "crystal",
  "soapFilm",
  "ferrofluid",
  "kintsugi",
  "tufted",
  "phosphor",
  "ricePaper",
  "marble",
] as const;
export type SurfaceMaterial = (typeof SURFACE_MATERIALS)[number];

/**
 * How the material meets the picture's colour.
 *
 *   lit       the picture keeps its colours; the material adds its light,
 *             tooth and fibres. The picture is MADE of the material.
 *   multiply  the picture is printed onto the material's own tone (×dye):
 *             kraft warms everything, a pink felt tints it.
 *   under     the material's sheet replaces the picture's GROUND — the flat
 *             background of an illustration, or what a layer's soft or
 *             semi-transparent paint lets through.
 *   blind     the shapes take the sheet's own tone; only their RELIEF shows —
 *             a blind emboss, a deboss with no ink (v112).
 */
export const SURFACE_COLOR_MODES = ["lit", "multiply", "under", "blind"] as const;
export type SurfaceColorMode = (typeof SURFACE_COLOR_MODES)[number];

/**
 * How a morph's front crosses the picture.
 *
 *   spread  blotches of the new material appear and grow until they meet —
 *           frost, rust, a stain: organic, from everywhere at once
 *   sweep   a ragged front crosses from the light's side to the far side
 *   fade    the whole picture turns at once
 */
export const SURFACE_MORPH_STYLES = ["spread", "sweep", "fade"] as const;
export type SurfaceMorphStyle = (typeof SURFACE_MORPH_STYLES)[number];

/** How a custom texture repeats across the sheet (see `texture`). */
export const SURFACE_TEXTURE_TILINGS = ["repeat", "mirror"] as const;
export type SurfaceTextureTiling = (typeof SURFACE_TEXTURE_TILINGS)[number];

/** `to`'s options: no second material, or any material. */
export const SURFACE_MORPH_TARGETS = ["none", ...SURFACE_MATERIALS] as const;

export const SURFACE_EFFECT_ARMS = [
  z.object({
    ...layerEffectBase,
    type: z.literal("surface"),
    // Mostly a SURFACE, so it arrives still (see `ownMotion`): a paper that
    // re-rolls is the stop-motion look, chosen, not the default.
    ...ownMotion(false),
    ...temporalClock,
    material: z.enum(SURFACE_MATERIALS).default("paper"),
    /**
     * YOUR OWN TEXTURE (v115): an image asset id ("" = the material's own
     * pattern). The picture REPLACES THE PATTERN — its light and dark become
     * the sheet's relief and tone — while `material` keeps deciding how the
     * sheet BEHAVES (felt's pillow, foil's rainbow, neon's tube). A scan of
     * crumpled paper, as chrome, is one pick and one select.
     */
    texture: z.string().default(""),
    /** 0..1 — how much of the texture's own COLOUR is printed; 0 = its relief and tone only. */
    textureColor: z.number().min(0).max(1).default(0),
    /** How the texture repeats: as it is, or mirrored so any picture tiles without a seam. */
    textureTiling: z.enum(SURFACE_TEXTURE_TILINGS).default("repeat"),
    /** × the material's tuned feature size (fibre length, thread pitch, fold size). */
    scale: z.number().min(0.25).max(8).default(1),
    /** × the tuned relief — how hard the light rakes the height field. 0 = flat. */
    relief: z.number().min(0).max(4).default(1),
    /** × the tuned fine tooth — the grain that catches light and breaks dry media. */
    tooth: z.number().min(0).max(4).default(1),
    /** Where the light comes from, degrees (−90 = straight above). */
    lightAngle: z.number().min(-180).max(180).default(-45),
    colorMode: z.enum(SURFACE_COLOR_MODES).default("lit"),
    /** Dyes the material's own tone. White leaves it its own colour. */
    dye: z.string().default("#ffffff"),
    /** 0..1 — how far the material eats the picture's edge (torn fibres, felt fuzz). */
    edge: z.number().min(0).max(1).default(0),
    /**
     * Thickness of the cut-out, px: the picture's shapes stand off the sheet
     * by this much. NEGATIVE presses them INTO it (v112): letterpress, deboss.
     */
    lift: z.number().min(-200).max(200).default(0),
    /** 0..1 — the shadow a lifted shape casts on what is under it. */
    shadow: z.number().min(0).max(1).default(0.5),
    /** 0..1 — the picture's ink skips the valleys of the tooth: chalk, dry brush, worn print. */
    breakup: z.number().min(0).max(1).default(0),
    /** × the material's tuned shape relief: felt's pillow, clay's dome, chrome's bulge, neon's tube. */
    body: z.number().min(0).max(4).default(0),
    /** × the material's tuned gloss: highlights, foil's rainbow, chrome's reflection. */
    sheen: z.number().min(0).max(4).default(0),
    /** × the material's tuned light: neon's tube and halo, a phosphor's bloom. */
    glow: z.number().min(0).max(4).default(0),
    /** × the material's tuned flow: how far marbling swirls, frost scatters, the picture. */
    flow: z.number().min(0).max(4).default(0),
    /** The material this one is becoming; `morph` says how far. */
    to: z.enum(SURFACE_MORPH_TARGETS).default("none"),
    /** 0..1 — how far `material` has become `to`. Key it. */
    morph: z.number().min(0).max(1).default(0),
    morphStyle: z.enum(SURFACE_MORPH_STYLES).default("spread"),
    /**
     * 0..1 — LIGHT stays clean (v4.26). A light in the picture (an ember, a
     * laser line, a lit sign) is not printed on the card: how far its pixels
     * pass through the material untouched. Which pixels are light is
     * `lightsFrom`'s answer. 0 = the material takes everything, as before.
     */
    lights: z.number().min(0).max(1).default(0),
    /**
     * WHAT IS LIGHT. `layers` (default): exactly the pixels of the layers that
     * emit light (`emitsLight` on a layer, a group or a nested comp), their
     * glow included — a white-hot core is as much a light as its halo.
     * `colour`: a guess from the picture, for flat media with no layers to
     * ask (a video, a photo): what has a colour (chroma) is light, white and
     * grey are not (`surfaceLightMask`).
     */
    lightsFrom: z.enum(["layers", "colour"]).default("layers"),
    /** Master wet/dry over the whole card. */
    mix: z.number().min(0).max(1).default(1),
  }),
] as const;
