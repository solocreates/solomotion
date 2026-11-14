import { z } from "zod";

import { blendMode, layerEffectBase } from "./shared";

/**
 * PATTERN & SURFACE (v57) — the cards that rebuild the layer out of something
 * else: cells, dots, or a lit surface.
 *
 * Halftone and pixelate share a machine (sample the layer on a grid, draw a
 * mark per cell) and differ in what the mark is; bevel shares nothing with
 * them except the file, and is here because it is the third way to make a flat
 * layer read as an object rather than a picture.
 */
export const PATTERN_EFFECT_ARMS = [
  /**
   * Halftone — the layer redrawn as ink on a grid. Newsprint, comic dots, the
   * CMYK rosette, an LED matrix.
   *
   * `scatter` and `spread` are why this is more than a print filter. Once the
   * layer IS a field of discrete marks, moving those marks apart is a
   * disintegration: animate `spread` and the picture blows away into its own
   * dots, which is the single most-requested thing this card can do and costs
   * two extra numbers rather than a particle system.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("halftone"),
    shape: z.enum(["dot", "line", "square", "cross", "diamond"]).default("dot"),
    /** Grid spacing in px — the size of one ink cell. */
    size: z.number().min(1).max(400).default(12),
    /** Screen angle in degrees. 45 is the classic newsprint rosette. */
    angle: z.number().min(-180).max(180).default(45),
    /** 0 = hard ink, 1 = each mark fades out at its own edge. */
    softness: z.number().min(0).max(1).default(0.1),
    /** Pushes the tonal range — high contrast makes solid blacks and whites. */
    contrast: z.number().min(0).max(4).default(1),
    /**
     * How the ink is coloured. `color` keeps the layer's own hues per cell;
     * `riso` separates the picture into TWO inks (`inkColor`, `ink2Color`)
     * printed on `paperColor`, the second drum `misregister` px off (v111).
     */
    mode: z.enum(["mono", "duotone", "color", "cmyk", "riso"]).default("color"),
    inkColor: z.string().default("#101010"),
    /** Riso's second ink — the drum laid over the first. */
    ink2Color: z.string().default("#ff48b0"),
    /** Riso: how far the second drum lands off the first, px. */
    misregister: z.number().min(0).max(200).default(0),
    paperColor: z.string().default("#f4f0e6"),
    /** Random per-cell offset in px — hand-set type rather than a machine. */
    jitter: z.number().min(0).max(400).default(0),
    /** Pushes every mark away from the centre. Animate it to disintegrate. */
    spread: z.number().min(0).max(2000).default(0),
    /** Master wet/dry over the whole card. */
    mix: z.number().min(0).max(1).default(1),
    /** Ink the dark areas instead of the light ones. */
    invert: z.boolean().default(false),
    /** Keep the screen inside the layer's silhouette. */
    inside: z.boolean().default(true),
    /**
     * Lay `paperColor` under the marks in every ink mode, not only duotone — a
     * colour screen printed on paper, threads stitched into cloth. Off, the
     * gaps are empty and show whatever is beneath (v109).
     */
    paper: z.boolean().default(false),
  }),
  /**
   * Pixelate — the layer resampled onto a coarse grid. Mosaic censorship at one
   * end, an LED sign at the other; `gap` and `shape` are the whole distance
   * between them.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("pixelate"),
    /** Cell size in px. */
    size: z.number().min(1).max(600).default(18),
    /** Cell aspect: >1 is wide, <1 is tall. */
    aspect: z.number().min(0.1).max(10).default(1),
    shape: z.enum(["square", "dot", "diamond", "cross"]).default("square"),
    /** Space between cells, as a fraction of one. Turns a mosaic into a grid. */
    gap: z.number().min(0).max(0.9).default(0),
    /** Softens each cell's edge. */
    softness: z.number().min(0).max(1).default(0),
    /**
     * The BOARD behind the cells (v109) — what a gap shows. An LED sign is
     * emissive cells on a dark panel, so the gap must be the panel, not the
     * picture the cells came from (on an adjustment that is the plate). The
     * default is transparent, today's behaviour: gaps show what is beneath.
     */
    board: z.string().default("#00000000"),
    /** Master wet/dry over the whole card. */
    mix: z.number().min(0).max(1).default(1),
  }),
  /**
   * Bevel & emboss — a light source raking across the layer's own alpha,
   * treated as a height field.
   *
   * The same physical core as liquid glass (blur the alpha, take its gradient,
   * light the normals) with none of glass's cost, because it never looks at the
   * backdrop. That is a real distinction and it is why this is not a mode of
   * the glass card: bevel works on every layer at full frame rate, glass costs
   * a scene render beneath it.
   */
  z.object({
    ...layerEffectBase,
    type: z.literal("bevel"),
    style: z.enum(["inner", "outer", "pillow", "emboss"]).default("inner"),
    /** How far in from the edge the slope runs, in px. */
    depth: z.number().min(0).max(400).default(14),
    /** Slope steepness — how hard the light breaks across the edge. */
    strength: z.number().min(0).max(3).default(1),
    /** Key-light direction in degrees (−90 = from straight above). */
    angle: z.number().min(-180).max(180).default(-55),
    /** Key-light height: 0 grazes the surface, 90 hits it head-on. */
    elevation: z.number().min(0).max(90).default(45),
    /** Rounds the slope — a chisel at 0, a pillow at 1. */
    softness: z.number().min(0).max(1).default(0.4),
    highlightColor: z.string().default("#ffffff"),
    highlightOpacity: z.number().min(0).max(1).default(0.8),
    shadowColor: z.string().default("#000000"),
    shadowOpacity: z.number().min(0).max(1).default(0.6),
    highlightBlend: blendMode.default("screen"),
    shadowBlend: blendMode.default("multiply"),
  }),
] as const;
