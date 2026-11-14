import { z } from "zod";

/**
 * BEHAVIORS (Characters 3.0) — the live half of a character: what it does on
 * its own while you direct it. Lip sync, blinking, breathing, an idle loop, a
 * glance, a state machine. The whole model is docs/adr/ADR-characters-3.md;
 * the short of it:
 *
 *  - A behavior is an INSTANCE of the `behavior` domain of the one effect
 *    registry (`behaviors/registry.ts` → `BEHAVIOR`): `{ id, type, enabled,
 *    ...fields }`, flat like a modifier, so the stack UI, presets, the
 *    floating editor and agents read every kind from its registry entry, and
 *    every number keys at `bhv.<id>.<field>` like any other channel.
 *  - It lives in an ORDERED list on the character group (`group.behaviors`).
 *    A behavior that drives a POSE SET (`set`) answers "which pose now" only
 *    while it is ACTIVE — Blink while shut, Lip sync while a voice plays — and
 *    later ones win where two are; where none is active your own keys show.
 *    One that drives CHANNELS (Breathe, Sway, Glance) adds onto what the
 *    channel holds, so a hand move still lands on top.
 *  - It NEVER writes keys. A person's change to it is an OVERRIDE span, kept
 *    on the behavior in the group's own time, so regenerating it (a new seed,
 *    a new rate, new audio) keeps every change; baking is explicit.
 */

/**
 * One change a person made to a behavior: from `fromMs` to `toMs` (GROUP-
 * LOCAL ms, `toMs` exclusive) it shows `pose` — or, `null`, stands aside so
 * whatever is beneath (your keys, an earlier behavior) shows. Spans of one
 * behavior never overlap: a new one cuts what it covers out of the old.
 */
export const behaviorOverrideSchema = z.object({
  id: z.string(),
  fromMs: z.number(),
  toMs: z.number(),
  pose: z.string().nullable().default(null),
});
export type BehaviorOverride = z.infer<typeof behaviorOverrideSchema>;

/** One step of a Cycle: hold `pose` for `ms`. */
export const behaviorStepSchema = z.object({
  pose: z.string(),
  ms: z.number().min(1).max(600_000).default(500),
});
export type BehaviorStep = z.infer<typeof behaviorStepSchema>;

/**
 * FLAT, exactly like a modifier: the registry declares each type's fields and
 * defaults, so a new behavior is one registry entry and no schema change, and
 * every reader resolves through it (`behaviorValue`) — a missing field reads
 * as its default. Two keys are structured and named here: `overrides` (every
 * kind) and `steps` (a Cycle's sequence).
 */
export interface Behavior {
  id: string;
  type: string;
  enabled: boolean;
  overrides?: BehaviorOverride[];
  steps?: BehaviorStep[];
  /** Its fields, flat (the registry says which): numbers, names, ids, flags. */
  [field: string]: string | number | boolean | BehaviorOverride[] | BehaviorStep[] | undefined;
}

const behaviorObject = z
  .object({
    id: z.string(),
    type: z.string(),
    enabled: z.boolean().default(true),
    overrides: z.array(behaviorOverrideSchema).optional(),
    steps: z.array(behaviorStepSchema).optional(),
  })
  .catchall(z.union([z.number(), z.string(), z.boolean()]));
export const behaviorSchema = behaviorObject as unknown as z.ZodType<Behavior, z.ZodTypeDef, unknown>;
