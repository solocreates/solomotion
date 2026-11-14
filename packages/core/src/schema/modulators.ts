import { z } from "zod";

/**
 * MODULATORS (v46) — "make this number move on its own".
 *
 * A modulator binds a generated signal to any property path a clip understands
 * (`opacity`, `x`, `fill.<id>.opacity`, `lfx.<id>.pitch`, …). It is the fourth
 * and last answer to "what is this value right now?", and it deliberately sits
 * on TOP of the other three rather than beside them:
 *
 *   base value  →  keyframes override it  →  a node driver overrides that
 *                                         →  modulators MODIFY the result
 *
 * That ordering is the whole design. After Effects' `wiggle()` works on the
 * property's already-animated value, and anything else would make "animate it,
 * then add a shake" impossible — you would have to choose between the two.
 * `compose` decides how the signal lands (add a wobble, multiply a pulse, or
 * replace outright), so one record covers all three intents.
 *
 * Why this shape and not a node graph: a modulator is a one-dimensional scalar
 * over time. The node system is a general DAG and is the right home for
 * anything that needs to read OTHER values, do maths across properties, or fan
 * one source into many sinks. Modelling a single LFO as a graph would mean a
 * board, a node, two sockets and a driver token for what the user experiences
 * as "right-click → Wiggle". The two are not rivals: the signal maths lives in
 * `animation/temporal.ts`, so a future Wiggle NODE calls the identical
 * function and cannot drift from this.
 *
 * Every field here is itself keyframable through `mod.<id>.<field>`, which is
 * what makes "the shake ramps in over two seconds and then settles" one
 * keyframe pair instead of a feature request.
 */

/**
 * The signal shapes. Each is a function of time returning roughly −1..1, so
 * `amount` means the same thing whichever you pick and switching shapes never
 * makes a value jump by an order of magnitude.
 */
export const MODULATOR_SHAPES = ["wiggle", "random", "wave", "pulse", "ramp"] as const;
export type ModulatorShape = (typeof MODULATOR_SHAPES)[number];

/** How the generated signal combines with the value it is modulating. */
export const MODULATOR_COMPOSE = ["add", "multiply", "replace"] as const;
export type ModulatorCompose = (typeof MODULATOR_COMPOSE)[number];

export const modulatorSchema = z.object({
  id: z.string(),
  enabled: z.boolean().default(true),
  /**
   * The property path this drives — the SAME grammar as `keyframes` and
   * `drivers`, so anything the property registry can name can be modulated,
   * including fields of effects that did not exist when this was written.
   */
  target: z.string(),
  shape: z.enum(MODULATOR_SHAPES).default("wiggle"),
  compose: z.enum(MODULATOR_COMPOSE).default("add"),

  /** Amplitude, in the TARGET's own units (px for a position, 0..1 for opacity). */
  amount: z.number().default(1),
  /** Constant added to the signal — shifts a ±1 wobble into a 0..2 pulse. */
  offset: z.number().default(0),

  // The temporal clock, identical to the one the analog effects carry. `rate`
  // is the signal's frequency in Hz; `jitter`/`stutter` make the beat itself
  // irregular, which is what separates a machine from a hand.
  seed: z.number().int().min(0).max(99999).default(1),
  rate: z.number().min(0.01).max(120).default(2),
  jitter: z.number().min(0).max(1).default(0),
  stutter: z.number().min(0).max(1).default(0),

  /** Starting phase in degrees — offsets two modulators so they don't lock up. */
  phase: z.number().min(-3600).max(3600).default(0),
  /**
   * 0 = the signal HOLDS each beat and snaps to the next (sample-and-hold);
   * 1 = it glides continuously. Applies to every shape, so one dial takes a
   * sine from smooth to stepped and a random from strobe to drift.
   */
  smooth: z.number().min(0).max(1).default(1),

  /** Layers of finer, faster detail summed into the signal (wiggle/random). */
  octaves: z.number().min(1).max(6).default(1),
  /** How much each finer layer contributes. */
  roughness: z.number().min(0.05).max(0.95).default(0.5),
  /** Fraction of each cycle spent high (pulse only). */
  duty: z.number().min(0.01).max(0.99).default(0.5),

  /** Hard limits on the modulated RESULT. Null = unbounded. */
  clampMin: z.number().nullable().default(null),
  clampMax: z.number().nullable().default(null),
});

export type Modulator = z.infer<typeof modulatorSchema>;
