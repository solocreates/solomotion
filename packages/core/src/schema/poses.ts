import { z } from "zod";
import { easingSchema } from "./common";
import { keyframeValueSchema } from "./animation";

/**
 * POSES (Characters 2.0) — a part with NAMED STATES: a mouth's visemes, an
 * eye's open / half / closed, brows, hands. One model whatever a pose does:
 * swap drawings (`switch` on a switch group), morph (`key.<id>` on a path or
 * mesh), move bones (`bone.<id>.<channel>`) — or a mix. That is how ONE lip
 * sync drives every kind of mouth. See docs/adr/ADR-characters.md ("PoseSet").
 *
 * A set lives on a GROUP (`group.poses`) and owns every path any of its poses
 * names. Which pose is showing is the ordinary discrete channel
 * `pose.<setId>` on that group (a NAME), so keys, expressions, machines and
 * lip sync all choose poses alike; the eased blend between poses (PoseMix) is
 * DERIVED at evaluation, never stored.
 */

/** One value a pose sets: ANY animatable path on any clip in the group's subtree (the group itself included). */
export const poseValueSchema = z.object({
  clipId: z.string(),
  path: z.string(),
  value: keyframeValueSchema,
});
export type PoseValue = z.infer<typeof poseValueSchema>;

export const poseSchema = z.object({
  id: z.string(),
  name: z.string().default("Pose"),
  values: z.array(poseValueSchema).default([]),
});
export type Pose = z.infer<typeof poseSchema>;

/**
 * The eased morph between poses. Floats, colours and outlines blend over `ms`
 * through `ease`; discrete values (a switch, text, a flag) take the new pose
 * at the START of the blend, so lip timing stays exact.
 */
export const poseBlendSchema = z.object({
  ms: z.number().min(0).max(2000).default(120),
  ease: easingSchema.default({ kind: "preset", name: "ease-in-out" }),
  /**
   * How a change between two poses LOOKS (Characters 3.0): `morph` eases every
   * value that can be eased (bones, shape keys, colours, outlines) and swaps
   * drawings at the start; `swap` changes everything at once, like a cut.
   * Absent = morph.
   */
  mode: z.enum(["morph", "swap"]).optional(),
});
export type PoseBlend = z.infer<typeof poseBlendSchema>;

/**
 * A blend for ONE pair of poses, over the set's own: Open → Closed snaps in
 * 40 ms while Closed → Open eases back in 160. `from`/`to` are pose names or
 * ids, `*` for any. The most specific match wins (both named > one > none).
 */
export const poseTransitionSchema = z.object({
  from: z.string().default("*"),
  to: z.string().default("*"),
  ms: z.number().min(0).max(2000).default(120),
  ease: easingSchema.optional(),
  mode: z.enum(["morph", "swap"]).optional(),
});
export type PoseTransition = z.infer<typeof poseTransitionSchema>;

export const poseSetSchema = z.object({
  id: z.string(),
  name: z.string().default("Poses"),
  /**
   * The vocabulary its names speak (`visemes`, `eyes`, `brows`, `hands`,
   * `emotions` — `rig/vocabulary.ts`, a registry). Unknown names resolve through
   * its fallbacks before falling to the first pose. Null = names only.
   */
  vocabulary: z.string().nullable().default(null),
  blend: poseBlendSchema.default({}),
  poses: z.array(poseSchema).default([]),
  /**
   * The stored BASE of `pose.<setId>` (mirrors `switch.show`) — the pose shown
   * when nothing keys or drives the channel; a driver bakes into it and
   * un-keying freezes into it. "" = the first pose.
   */
  show: z.string().default(""),
  /**
   * The PART this set is about (Characters 3.0) — the clip its poses change:
   * the Mouth group, Eye.L, a hand. Pose pictures frame it, "Add pose" puts
   * new drawings in it, the Parts list groups by it. Null = derived from what
   * the poses name.
   */
  part: z.string().nullable().optional(),
  /** Per-pair blends over `blend` (Characters 3.0). Absent = none. */
  transitions: z.array(poseTransitionSchema).optional(),
});
export type PoseSet = z.infer<typeof poseSetSchema>;
