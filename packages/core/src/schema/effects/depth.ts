import { z } from "zod";

import { layerEffectBase } from "./shared";

/**
 * The DEPTH family — cards that read how far each pixel of footage is from
 * the lens (a depth tracker's maps). Depth here is 0 at the nearest thing in
 * the shot and 1 at the farthest, measured across the whole shot, so a value
 * means the same on every frame.
 *
 * `source` names the FOOTAGE layer whose depth is read; empty = this layer's
 * own (Fog and Lens Blur on the plate itself). "Behind" is the one that reads
 * another layer's: a title cut where the plate stands in front of it.
 */
export const DEPTH_EFFECT_ARMS = [
  z.object({
    ...layerEffectBase,
    type: z.literal("fog"),
    source: z.string().default(""),
    color: z.string().default("#c8d0d9"),
    /** How thick it gets at full depth. */
    density: z.number().min(0).max(1).default(0.75),
    /** Depth where it begins, 0..1. */
    start: z.number().min(0).max(1).default(0.25),
    /** Depth where it reaches full density, 0..1. */
    end: z.number().min(0).max(1).default(1),
    mix: z.number().min(0).max(1).default(1),
  }),
  z.object({
    ...layerEffectBase,
    type: z.literal("lensBlur"),
    source: z.string().default(""),
    /** The depth in focus, 0..1. */
    focus: z.number().min(0).max(1).default(0.15),
    /** How far either side of it stays sharp, 0..1. */
    range: z.number().min(0).max(1).default(0.08),
    /** Blur at the most out-of-focus depth, px. */
    amount: z.number().min(0).max(200).default(16),
    mix: z.number().min(0).max(1).default(1),
  }),
  z.object({
    ...layerEffectBase,
    type: z.literal("depthMatte"),
    source: z.string().default(""),
    /** This layer's depth in the shot, 0..1: wherever the footage is nearer, the layer is behind it. */
    depth: z.number().min(0).max(1).default(0.5),
    /** How soft the cut is, in depth. */
    softness: z.number().min(0).max(0.5).default(0.03),
    /** Keep only where the footage is nearer (in front of the layer's depth). */
    invert: z.boolean().default(false),
  }),
] as const;
