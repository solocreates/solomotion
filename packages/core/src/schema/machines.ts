import { z } from "zod";

/**
 * STATE MACHINES (Characters 2.0) — Rive-style logic a comp carries:
 * `frame.machines`. The whole design is docs/adr/characters/machines.md; the
 * short of it:
 *
 *  - A machine has LAYERS that run side by side (Rive's layers); each layer is
 *    in exactly one state at any instant. The board draws Entry, Any State and
 *    Exit beside the states, but they are not stored: Entry is `layer.entry`,
 *    Any State is a transition `from: "any"`, Exit is a transition `to: "exit"`.
 *  - A transition fires when ALL its conditions hold (none = always) and, with
 *    `exitTime`, only once the state has run that long. Order is priority: Any
 *    State transitions first, then the state's own, each in list order.
 *  - Evaluation is a deterministic fold over the comp's frame steps from its
 *    start (`machines/evaluate.ts`). Nothing is baked and the machine writes
 *    nothing: `state("Machine")` reads the state at an instant, and a state's
 *    `pose` output is read by `statePose()` on the pose set it names.
 *
 * Ids `any` and `exit` are reserved — they are the two pseudo-states.
 */

export const MACHINE_ANY = "any";
export const MACHINE_EXIT = "exit";

/** Comparison for an input condition. Floats compare with a tolerance (see `compareValues`). */
export const machineOpSchema = z.enum(["==", "!=", "<", "<=", ">", ">="]);
export type MachineOp = z.infer<typeof machineOpSchema>;

export const machineConditionSchema = z.discriminatedUnion("kind", [
  /** A component input compared with a value — number, bool, enum/text or colour. */
  z.object({
    kind: z.literal("input"),
    input: z.string(),
    op: machineOpSchema.default("=="),
    value: z.union([z.number(), z.boolean(), z.string()]),
  }),
  /** A trigger input: true in the frame step its key lands in, and only once per layer. */
  z.object({ kind: z.literal("trigger"), input: z.string() }),
  /** Is a voice layer speaking (`speaking(layer)`), or silent with `is: false`. */
  z.object({ kind: z.literal("speaking"), layer: z.string(), is: z.boolean().default(true) }),
  /** How long the layer has been in its current state, ms. */
  z.object({ kind: z.literal("time"), op: machineOpSchema.default(">="), ms: z.number().min(0) }),
]);
export type MachineCondition = z.infer<typeof machineConditionSchema>;
/** A condition as written (defaults optional: `op` is `==`, `is` is true). */
export type MachineConditionInput = z.input<typeof machineConditionSchema>;

/**
 * What a state SHOWS. `pose` names a pose of a PoseSet (by set id and pose
 * name); `none` shows nothing of its own. A third arm, `action` (a marker
 * range of the comp's own timeline played from entry), is designed in the area
 * ADR and lands as one more arm here.
 */
export const machineOutputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("pose"), set: z.string(), pose: z.string() }),
]);
export type MachineOutput = z.infer<typeof machineOutputSchema>;

export const machineStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Where its card sits on the machine board (board units). */
  x: z.number().default(0),
  y: z.number().default(0),
  output: machineOutputSchema.default({ kind: "none" }),
});
export type MachineState = z.infer<typeof machineStateSchema>;

export const machineTransitionSchema = z.object({
  id: z.string(),
  /** A state id, or `any` (fires from whichever state the layer is in). */
  from: z.string(),
  /** A state id, or `exit` (the layer ends: no state, no output). */
  to: z.string(),
  conditions: z.array(machineConditionSchema).default([]),
  /** How long the blend into `to` takes, ms — exposed to whatever blends (PoseMix). */
  durationMs: z.number().min(0).default(0),
  /** Fire only once the state has run this long, ms (Rive's exit time). */
  exitTime: z.number().min(0).optional(),
});
export type MachineTransition = z.infer<typeof machineTransitionSchema>;

export const machineLayerSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The state the layer starts in; "" = none (an empty layer). */
  entry: z.string().default(""),
  states: z.array(machineStateSchema).default([]),
  transitions: z.array(machineTransitionSchema).default([]),
});
export type MachineLayer = z.infer<typeof machineLayerSchema>;

export const machineSchema = z.object({
  id: z.string(),
  name: z.string(),
  layers: z.array(machineLayerSchema).default([]),
});
export type Machine = z.infer<typeof machineSchema>;
