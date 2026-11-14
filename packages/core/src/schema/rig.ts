import { z } from "zod";

/**
 * RIGGING (v90) — bones that bend art, in a flat comp and in a world alike.
 * The whole model is in docs/adr/ADR-rigging.md; the short of it:
 *
 *  - A RIG lives on a GROUP (`group.rig`) — the character IS the group (Moho's
 *    bone layer, Blender's armature with its meshes parented). The group's own
 *    transform moves art and bones together; its members are the art.
 *  - BONES are data with stable ids, each with an explicit REST (where it was
 *    drawn) and a POSE (how far it has turned, moved and stretched since).
 *    The pose is a set of ordinary animatable paths — `bone.<id>.rotation` —
 *    so keyframes, drivers, expressions, modulators and the node board all
 *    move bones with no code of their own.
 *  - Members are BOUND BY DEFAULT. A member with no `bind` follows the bones
 *    the way its shape suggests (one bone rigidly, or several smoothly with
 *    automatic weights); `bind` only records what a person changed.
 *
 * Space: a root bone's rest is written in the RIG's space — the space its
 * group's members are written in (frame-centre px in a flat comp; the world's
 * units, Z up, in a world). A child's rest is in its PARENT BONE's frame, whose
 * origin is the parent's head and whose +X runs along the parent toward its
 * tail — so a child joined at the tip stands at `x = parent.length, y = 0`.
 */

/**
 * A bone's REST — the pose it was drawn in, which is also what the art is
 * bound to. Not animatable (rest is setup, Blender's edit bones): moving a
 * bone's rest re-derives the automatic weights and never moves the art.
 */
export const boneRestSchema = z.object({
  /** The head, in the parent bone's frame (a root: the rig's space). */
  x: z.number().default(0),
  y: z.number().default(0),
  /** Depth, in a world (absent = 0: a flat comp's bones lie in its plane). */
  z: z.number().optional(),
  /**
   * The angle in the parent's frame, degrees. In a flat comp the one angle a
   * bone has (0 points right, positive turns clockwise on screen — the canvas'
   * own sense). In a world it is the turn about Z (heading).
   */
  rotation: z.number().default(0),
  /** A world bone's pitch (about its Y), degrees. Absent = 0. */
  rotationY: z.number().optional(),
  /** A world bone's ROLL — the turn about its own length (X), degrees. Absent = 0. */
  rotationX: z.number().optional(),
  /** Head to tail, in the rig's units. */
  length: z.number().min(0).default(100),
});
export type BoneRest = z.infer<typeof boneRestSchema>;

/**
 * A bone's POSE — a DELTA from rest, so identity is rest and "reset pose" is
 * clearing it. Every field is an animatable path `bone.<id>.<field>`.
 *
 *  - `x/y/z` move the head in the PARENT's frame (a root: the rig's space), so
 *    `bone.hip.y = -20` lifts the hips 20 px whatever way the hip bone points.
 *  - `rotation` (and `rotationY`, `rotationX` in a world) turns the bone about
 *    its head, on top of its rest angle.
 *  - `scale` stretches ALONG the bone (squash and stretch), `scaleY` across it;
 *    null follows `scale`, exactly like a layer's linked scale. Children ride
 *    the stretch: a longer upper arm carries the elbow out.
 */
export const bonePoseSchema = z.object({
  x: z.number().default(0),
  y: z.number().default(0),
  z: z.number().optional(),
  rotation: z.number().default(0),
  rotationY: z.number().optional(),
  rotationX: z.number().optional(),
  scale: z.number().default(1),
  scaleY: z.number().nullable().default(null),
  scaleZ: z.number().nullable().optional(),
});
export type BonePose = z.infer<typeof bonePoseSchema>;

/**
 * INVERSE KINEMATICS on a bone (Spine's and Rive's model: a constraint on the
 * chain, a TARGET bone in the same rig). The tip of this bone reaches for the
 * target's head; `chain` bones turn — this one and its parents — and the rest
 * of the rig follows them. Animate one control bone, not three rotations.
 *
 * Self-contained by design: the target and pole are bones of THIS rig, so a
 * rig's pose is a function of the rig alone — exact on any frame, cached on
 * one key, the same in 2D and 3D. (A layer outside the rig drives a bone the
 * ordinary way: a driver or the node board on its channels.)
 */
export const boneIkSchema = z.object({
  /** The bone whose HEAD this bone's tip reaches for — usually a control bone. */
  target: z.string(),
  /** How many bones turn: 1 = only this one, 2 = this and its parent (an arm, a leg). */
  chain: z.number().int().min(1).max(16).default(2),
  /** A bone the first bend points toward (a knee at its control). Null = the side it bends at rest. */
  pole: z.string().nullable().default(null),
  /** Bend the other way — a straight chain's only way to say which side, without a pole. */
  flip: z.boolean().default(false),
  /** How much IK wins over the keyed angles, 0..1. Keyed at `bone.<id>.ik`. */
  mix: z.number().min(0).max(1).default(1),
});
export type BoneIk = z.infer<typeof boneIkSchema>;

/** A channel's allowed range, `[min, max]` (equal ends LOCK it). */
const rangeSchema = z.tuple([z.number(), z.number()]);

/**
 * LIMITS (v91) — the range each pose channel may take, applied wherever the
 * pose is READ (keys, drivers, modulators, drags and agents alike), so a limit
 * can never be animated past. Blender's Limit Location / Rotation / Scale on
 * one bone.
 *
 * A limit is also how a CONTROL becomes a slider or a pad: lock `y` to
 * `[0, 0]` and give `x` `[0, 100]` and the bone is a slider along its parent's
 * X; give both a range and it is a 2D pad (an eye target, a mouth control).
 * The canvas draws the track or the box from the limits — there is no
 * separate "slider" kind to keep in step with them.
 */
export const boneLimitsSchema = z
  .object({
    x: rangeSchema,
    y: rangeSchema,
    z: rangeSchema,
    rotation: rangeSchema,
    rotationX: rangeSchema,
    rotationY: rangeSchema,
    scale: rangeSchema,
    scaleY: rangeSchema,
    scaleZ: rangeSchema,
  })
  .partial();
export type BoneLimits = z.infer<typeof boneLimitsSchema>;

/**
 * How a bone is DRAWN while posing (v91) — Blender's custom bone shapes. A
 * deforming bone is a `bone`; a CONTROL reads best as the thing you grab: a
 * `circle` (a root, a hip), a `square`, a `diamond` (an IK target), a `cross`
 * (a mover). Display only: a shape never changes what the bone does.
 */
export const boneShapeSchema = z.enum(["bone", "circle", "square", "diamond", "cross"]);
export type BoneShape = z.infer<typeof boneShapeSchema>;

/**
 * What a bone constraint points at: a bone of THIS rig (its posed head) or a
 * fixed POINT in the rig's space. Self-contained like IK, so a rig's pose is a
 * function of the rig alone; a layer outside it moves a control bone the
 * ordinary way (a driver on its x/y). A dangling id is no target.
 */
export const boneTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bone"), bone: z.string() }),
  z.object({ kind: z.literal("point"), x: z.number(), y: z.number(), z: z.number().optional() }),
]);
export type BoneTarget = z.infer<typeof boneTargetSchema>;

const constraintBase = {
  /** Stable: its influence keys at `bone.<boneId>.con.<id>`. */
  id: z.string(),
  enabled: z.boolean().default(true),
  /** How much it wins over the keyed pose, 0..1 — keyable. */
  influence: z.number().min(0).max(1).default(1),
  target: boneTargetSchema,
};

/**
 * BONE CONSTRAINTS (4.1) — a LIST of instances on a bone, evaluated in list
 * order after IK, parents first, by the one evaluator (`rig/pose.ts`). Every
 * result is written back through the bone's own channels and held inside its
 * LIMITS, so a constraint can never take a bone where a key could not.
 *
 *  - `look` — a pupil: the head SLIDES toward the target, at most `radius`
 *    from where its keys put it, and inside the ellipse its pad limits draw
 *    (x/y, and z in a world). A target on the head is no move (never NaN).
 *  - `track` — Blender's Damped Track: the bone TURNS so its tail points at
 *    the target, the short way (a head watching a ball; an eyeball in 3D).
 *    Its rotation limits hold the turn.
 */
export const boneConstraintSchema = z.discriminatedUnion("type", [
  z.object({
    ...constraintBase,
    type: z.literal("look"),
    /** The farthest the head slides from its keyed place (channel units); null = only the pad limits hold it. */
    radius: z.number().min(0).nullable().default(null),
  }),
  z.object({ ...constraintBase, type: z.literal("track") }),
]);
export type BoneConstraint = z.infer<typeof boneConstraintSchema>;
export type BoneConstraintType = BoneConstraint["type"];

export const boneSchema = z.object({
  id: z.string(),
  name: z.string().default("Bone"),
  /** The parent bone's id; null = a root, placed in the rig's own space. */
  parent: z.string().nullable().default(null),
  rest: boneRestSchema.default({}),
  /** Absent = at rest. */
  pose: bonePoseSchema.optional(),
  /**
   * Does it bend art? Off for CONTROL bones — an IK target, a root that only
   * moves the rest — so they are posed and keyed like any bone but never pull
   * on a vertex (Blender's Deform switch).
   */
  deform: z.boolean().default(true),
  ik: boneIkSchema.nullable().default(null),
  /** How it is drawn while posing (v91). */
  shape: boneShapeSchema.default("bone"),
  /** The shape's size in the rig's units; null = from the bone's length. */
  size: z.number().positive().nullable().default(null),
  /** Its colour on the canvas (`#rrggbb`) — sides of a character told apart; null = by role. */
  color: z.string().nullable().default(null),
  /** The range each pose channel may take (v91); null = free. */
  limits: boneLimitsSchema.nullable().default(null),
  /** Look / track constraints, in evaluation order (4.1). Absent = none. */
  constraints: z.array(boneConstraintSchema).optional(),
});
export type Bone = z.infer<typeof boneSchema>;

export const rigSchema = z.object({
  /** Parents before children is NOT required — the evaluator orders them. */
  bones: z.array(boneSchema).default([]),
  /**
   * Draw the bones on the canvas and in the viewport. They are guides either
   * way: never in a render, an export or a poster.
   */
  showBones: z.boolean().default(true),
  /**
   * JOINT BLEND, 0..1 — how far the automatic weights soften around a joint:
   * 0 creases at the joint like a hinge, 1 bends over most of the shorter
   * bone like rubber hose. Only joints soften; a limb stays whole.
   */
  blend: z.number().min(0).max(1).default(0.35),
});
export type Rig = z.infer<typeof rigSchema>;

// ── Binding ─────────────────────────────────────────────────────────────────

/**
 * A WEIGHT STROKE — one pass of the weight brush, kept as the stroke rather
 * than as numbers on vertices. Replayed in order over whatever geometry the
 * layer has NOW (its silhouette grid, a mesh after an edit, a body after
 * refinement), so paint survives re-meshing, resizing and new points, where
 * per-vertex weights would be lost or misaligned.
 *
 * Space: the layer's OWN space — a 2D layer's local px (origin-relative, the
 * space its geometry is authored in), a mesh's object space.
 */
export const weightStrokeSchema = z.object({
  bone: z.string(),
  /**
   * `add` pushes this bone's weight up, `subtract` down, `replace` toward
   * `strength` itself, `smooth` evens weights out with their neighbours.
   */
  mode: z.enum(["add", "subtract", "replace", "smooth"]).default("add"),
  /** 0..1 — how far one dab moves a weight (replace: the weight it moves to). */
  strength: z.number().min(0).max(1).default(0.5),
  /** The brush's radius, in the layer's own units. */
  radius: z.number().positive().default(24),
  /** The dabs, flattened `x, y, z, pressure` quads (z = 0 on a 2D layer). */
  points: z.array(z.number()).default([]),
});
export type WeightStroke = z.infer<typeof weightStrokeSchema>;

/**
 * HOW A MEMBER OF A RIG FOLLOWS ITS BONES. Absent = `auto`.
 *
 *  - `auto`: decided by the art — a piece only one bone runs through RIDES that
 *    bone whole (a hand, a hat: a placement, so it stays crisp and its picture
 *    is never re-rendered); a piece several bones run through BENDS with
 *    automatic weights (a whole-body picture, a long arm drawn as one path).
 *  - `smooth`: always bends, weights automatic plus `paint`.
 *  - `rigid`: always rides one bone — `bone`, or the one running most through it.
 *  - `none`: ignores the bones and only moves with the group.
 */
export const bindSchema = z.object({
  mode: z.enum(["auto", "smooth", "rigid", "none"]).default("auto"),
  /** The bone a rigid member rides; null = the one that runs most through it. */
  bone: z.string().nullable().default(null),
  /** Painted refinements, replayed over the automatic weights in order. */
  paint: z.array(weightStrokeSchema).default([]),
});
export type Bind = z.infer<typeof bindSchema>;
