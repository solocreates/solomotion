import { z } from "zod";

/** All times in the document are integer-friendly milliseconds. */
export const millisecondsSchema = z.number().finite();

export const easingPresetNameSchema = z.enum([
  "ease-out",
  "ease-in",
  "ease-in-out",
  "ease-out-quart",
  "ease-out-expo",
  "ease-out-back",
  "ease-in-out-back",
  "ease-out-elastic",
]);
export type EasingPresetName = z.infer<typeof easingPresetNameSchema>;

/**
 * An easing reference. `bezier` carries the raw cubic-bezier control points so
 * custom curves survive export/import into any host app.
 *
 * `hold` keeps the key's value until the next key, then jumps (After Effects'
 * Toggle Hold, Lottie's `h: 1`). It is an easing rather than a flag on the key
 * because it answers the same question every easing answers — how the segment
 * LEAVING this key gets from its value to the next — and a flag beside an
 * easing would be two stored answers to it. Before it existed a switch was
 * written as two keys a millisecond apart, which is a cut disguised as a move:
 * twice the keys, and a ramp a retime could stretch into a visible fade.
 */
export const easingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("linear") }),
  z.object({ kind: z.literal("hold") }),
  z.object({ kind: z.literal("preset"), name: easingPresetNameSchema }),
  z.object({
    kind: z.literal("bezier"),
    values: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  }),
]);
export type Easing = z.infer<typeof easingSchema>;

export const vec2Schema = z.object({ x: z.number(), y: z.number() });
export type Vec2 = z.infer<typeof vec2Schema>;

/**
 * Layer/paint compositing modes — the exact Figma set, in Figma's menu order.
 * Every value maps 1:1 to a canvas `globalCompositeOperation` (only `normal`
 * differs: it is `source-over`); host adapters (Premiere/Resolve/Blender) map
 * from the same enum. Kept here in `common` because both a whole layer
 * (`visualClipBase.blendMode`) and an individual paint (fill/stroke) blend with
 * it — one vocabulary, no renderer-specific strings in the document.
 */
export const blendModeSchema = z.enum([
  "normal",
  "darken",
  "multiply",
  "color-burn",
  "lighten",
  "screen",
  "color-dodge",
  "overlay",
  "soft-light",
  "hard-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
]);
/** The blend modes as a plain list — for a picker's options, without a second
 *  hand-typed copy of the union going stale beside the schema. */
export const BLEND_MODES = blendModeSchema.options;
export type BlendMode = z.infer<typeof blendModeSchema>;

/**
 * A scale component. NEGATIVE IS LEGAL and is the ONE representation of a
 * mirrored layer — there is deliberately no `flipX`/`flipY` flag in the
 * document, because a flag plus a sign would be two stored fields for one fact
 * and would disagree as soon as a keyframe interpolated the scale. Zero is the
 * only forbidden value: a layer scaled to nothing renders nothing, hit-tests as
 * nothing, and can never be grabbed to undo it. See `resize.ts`.
 */
const scaleComponentSchema = z.number().refine((v) => v !== 0, {
  message: "scale must be non-zero (negative = mirrored)",
});

/**
 * A layer's PIVOT (anchor point): the point rotation, scale and shear happen
 * about, and the point `transform.x/y` positions.
 *
 * NORMALIZED to the layer's own box — 0 = left/top edge, 0.5 = center, 1 =
 * right/bottom edge — and deliberately unclamped, so a pivot can sit outside the
 * layer (a planet orbiting a sun off-screen). Normalized rather than pixels
 * because a pivot is a claim about the SHAPE ("spin about my bottom-right
 * corner"), which a pixel offset stops expressing the moment the layer is
 * resized, rescaled, re-wrapped or its media swapped. Same reasoning as CSS
 * `transform-origin`.
 *
 * `{0.5, 0.5}` (the center) is the identity and the default, which is exactly
 * how every document behaved before pivots existed — so no migration was needed.
 */
export const anchorSchema = z
  .object({ x: z.number(), y: z.number() })
  .default({ x: 0.5, y: 0.5 });
export type AnchorPoint = z.infer<typeof anchorSchema>;

export const transformSchema = z.object({
  x: z.number(),
  y: z.number(),
  /** Horizontal scale (the uniform scale for locked-aspect layers); negative = mirrored. */
  scale: scaleComponentSchema,
  /**
   * Vertical scale. `null` mirrors `scale` (uniform / locked aspect) — the
   * default, and what every legacy doc parses to, so no migration is needed.
   * Set independently when a layer is resized freely (non-uniform) OR when only
   * ONE axis is mirrored, Figma-style.
   */
  scaleY: scaleComponentSchema.nullable().default(null),
  rotation: z.number(),
  /**
   * Pseudo-3D shear (degrees), applied in the layer's own space AFTER scale and
   * BEFORE rotation — so the world map is T·R·K·S with the shear matrix
   * K = [[1, tan(skewX)], [tan(skewY), 1]]. `skewX` leans verticals (a point's x
   * shifts with its y), `skewY` leans horizontals. Combined with non-uniform
   * scale this reads as an object "viewed from the side". 0 = no shear, which is
   * what every legacy doc parses to — no migration needed. Kept in the affine
   * transform family on purpose: it keyframes, hit-tests, snaps and exports
   * through the SAME pipeline as scale/rotation (never a separate 3D path).
   */
  skewX: z.number().default(0),
  skewY: z.number().default(0),
  /** The pivot everything transforms about — see `anchorSchema`. */
  anchor: anchorSchema,
  /**
   * THE THIRD AXIS (v89) — 2D is 3D with one dimension resting. Optional and
   * absent = 0 (or uniform for `scaleZ`), so a flat layer carries nothing and
   * every older document is already correct. Read through `transform3d`.
   *
   * In a WORLD comp (Z-up, Blender) `z` is height; in a flat comp it is depth,
   * positive AWAY from the viewer (After Effects). `rotation` stays the Z
   * rotation in both; Euler order is Blender's XYZ (R = Rz·Ry·Rx). See
   * docs/adr/ADR-3d.md for why the two spaces differ by exactly one rotation.
   */
  z: z.number().optional(),
  rotationX: z.number().optional(),
  rotationY: z.number().optional(),
  /** null/absent mirrors `scale` (uniform), exactly like `scaleY`. */
  scaleZ: scaleComponentSchema.nullable().optional(),
});
export type Transform = z.infer<typeof transformSchema>;

/** A transform's 3D half with the absent fields resolved — THE reader. */
export function transform3d(t: Pick<Transform, "scale" | "z" | "rotationX" | "rotationY" | "scaleZ">): {
  z: number;
  rotationX: number;
  rotationY: number;
  scaleZ: number;
} {
  return { z: t.z ?? 0, rotationX: t.rotationX ?? 0, rotationY: t.rotationY ?? 0, scaleZ: t.scaleZ ?? t.scale };
}

/** Does this transform leave the picture plane (tilt or depth)? */
export function hasDepth(t: Pick<Transform, "z" | "rotationX" | "rotationY">): boolean {
  return (t.z ?? 0) !== 0 || (t.rotationX ?? 0) !== 0 || (t.rotationY ?? 0) !== 0;
}

/** Shear a layer-local point by skew angles (degrees): the K in T·R·K·S. */
export function shearPoint(
  x: number,
  y: number,
  skewXDeg: number,
  skewYDeg: number,
): { x: number; y: number } {
  const tx = Math.tan((skewXDeg * Math.PI) / 180);
  const ty = Math.tan((skewYDeg * Math.PI) / 180);
  return { x: x + tx * y, y: y + ty * x };
}

/** Inverse shear: undo `shearPoint` (world/rotated-local → pre-shear local). */
export function unshearPoint(
  x: number,
  y: number,
  skewXDeg: number,
  skewYDeg: number,
): { x: number; y: number } {
  const tx = Math.tan((skewXDeg * Math.PI) / 180);
  const ty = Math.tan((skewYDeg * Math.PI) / 180);
  const det = 1 - tx * ty;
  if (Math.abs(det) < 1e-6) return { x, y };
  return { x: (x - tx * y) / det, y: (y - ty * x) / det };
}
