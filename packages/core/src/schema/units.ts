import { z } from "zod";

/**
 * THE UNITS A LENGTH CAN BE WRITTEN IN (v114). Two families, and the split is
 * the whole design:
 *
 * - **Comp-relative** — `px` (the default), `fw`/`fh` (1% of the comp's width
 *   / height), `%` (of the parent box along the field's axis). These are
 *   LAYOUT units, CSS's `%`: they size a thing before its transforms, so a
 *   group scaled ×2 shows a `50fw` box at 100% of the comp, as CSS would.
 * - **Screen-relative** — `spx` (one OUTPUT pixel), `vw`/`vh`/`vmin`/`vmax`
 *   (1% of the output frame). These are the NON-SCALING units, SVG's
 *   `vector-effect: non-scaling-stroke` for every field: the value is divided
 *   by every scale between the field and the output — the layer's own, its
 *   groups', every nested comp it is seen through — so a 2 spx line is two
 *   pixels of the export at ×1 and at ×13 000.
 *
 * "Output" is the frame being rendered (the export, the comp on the stage);
 * the stage's own zoom is a magnifier over it and never part of the maths.
 */
export const LENGTH_UNITS = ["px", "spx", "fw", "fh", "vw", "vh", "vmin", "vmax", "%"] as const;
export const lengthUnitSchema = z.enum(LENGTH_UNITS);
export type LengthUnit = z.infer<typeof lengthUnitSchema>;

/** A length with its unit — a bound's value (`{ value: 1, unit: "spx" }`). */
export const lengthSchema = z.object({ value: z.number(), unit: lengthUnitSchema });
export type Length = z.infer<typeof lengthSchema>;

/**
 * HOW ONE FIELD'S NUMBER IS MEANT — its unit, and optional BOUNDS, each a
 * length in a unit of its own: CSS `clamp(1spx, 0.2fw, 6spx)`, "a fifth of a
 * percent of the frame, never under one screen pixel or over six". So a line
 * can grow with the frame and still never vanish in a deep zoom or blow up in
 * a push. Bounds are applied after the value is in px, through the same frame.
 */
export const lengthSpecSchema = z.object({
  unit: lengthUnitSchema,
  min: lengthSchema.optional(),
  max: lengthSchema.optional(),
});
export type LengthSpec = z.infer<typeof lengthSpecSchema>;
