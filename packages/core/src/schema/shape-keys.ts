import { z } from "zod";

/**
 * SHAPE KEYS — drawn shapes a path or a mesh bends to (Blender's shape keys,
 * a 3D package's blendshapes / morph targets). ONE model for 2D and 3D; see
 * `docs/adr/characters/shape-keys.md` and core `shape-keys/`.
 *
 *   shape = base + Σ wᵢ · Δᵢ          (muted keys skipped; wᵢ is `key.<id>`)
 *
 * A key's Δ is stored RELATIVE TO ITS REFERENCE (`relativeTo`, absent = the
 * base), so the mix is a plain sum — exactly Blender's
 * `Σ wᵢ (Kᵢ − K_ref(i))` — and editing a reference carries every key built on
 * it along. `relativeTo` is an authoring frame, never a mix term.
 *
 * The delta is a discriminated union because a path and a mesh store points
 * differently; everything ELSE (weights, channels, mix, topology following,
 * authoring, agents) is one implementation.
 */

/**
 * A PATH key: per CONTOUR ID (so a key survives contours being reordered,
 * split off or promoted to their own layer), a flat run of 6 numbers per
 * anchor, in the clip's own space:
 *
 *   [dx, dy, dInX, dInY, dOutX, dOutY]
 *
 * `dx, dy` move the anchor. The handle terms are deltas of the handle's OFFSET
 * FROM ITS ANCHOR (not of its absolute position), so a key that only moves
 * anchors is zeros on the handles and the curve travels with its points, and
 * a corner (no handle) stays a corner unless the key itself grows an arm.
 * A contour missing from the map — or a run shorter than its points — is zero
 * there. Per-point depth (`z`) is not keyed.
 */
export const pathShapeDeltaSchema = z.object({
  kind: z.literal("path"),
  contours: z.record(z.string(), z.array(z.number())),
});
export type PathShapeDelta = z.infer<typeof pathShapeDeltaSchema>;

/**
 * A MESH key, SPARSE: `verts` are vertex indices (ascending, unique) and
 * `xyz` holds three numbers per listed vertex, in the object's own space. A
 * face's mouth keys move a few hundred of ten thousand vertices; storing only
 * those keeps an ARKit-sized set of 52 keys small enough for a document.
 */
export const meshShapeDeltaSchema = z.object({
  kind: z.literal("mesh"),
  verts: z.array(z.number().int().min(0)),
  xyz: z.array(z.number()),
});
export type MeshShapeDelta = z.infer<typeof meshShapeDeltaSchema>;

export const shapeDeltaSchema = z.discriminatedUnion("kind", [pathShapeDeltaSchema, meshShapeDeltaSchema]);
export type ShapeDelta = z.infer<typeof shapeDeltaSchema>;

/**
 * WHERE A KEY'S SHAPE LIVES (contract amendment 11):
 *
 *  - `delta` — stored here, in the document (a path, an editable mesh).
 *  - `asset` — an imported model's own morph target (glTF `targets[i]`, by
 *    index or by its name in `mesh.extras.targetNames`). Its vertices are in
 *    the blob store, not in core, so core only resolves the WEIGHT and hands
 *    it to the renderer and exporter (`EvaluatedGeometry.morphs`). Nothing to
 *    realign: the asset's topology is fixed.
 */
export const shapeKeySourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("delta"), delta: shapeDeltaSchema }),
  z.object({ kind: z.literal("asset"), target: z.union([z.number().int().min(0), z.string()]) }),
]);
export type ShapeKeySource = z.infer<typeof shapeKeySourceSchema>;

export const shapeKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The key this one is drawn ON TOP OF (a corrective on "Open"); absent = the base. */
  relativeTo: z.string().optional(),
  /** Muted keys sit out of the mix and keep their weight (Blender's checkbox). */
  mute: z.boolean().optional(),
  /**
   * The resting WEIGHT — the base slot of the `key.<id>` channel, what keys,
   * drivers and expressions override. Absent = 0. May overshoot (1.4) or go
   * negative: a weight is a factor, not a clamp.
   */
  value: z.number().optional(),
  source: shapeKeySourceSchema,
});
export type ShapeKey = z.infer<typeof shapeKeySchema>;

export const shapeKeysSchema = z.array(shapeKeySchema);
