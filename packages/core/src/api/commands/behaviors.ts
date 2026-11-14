import { z } from "zod";
import type { MotionDocument, GroupClip } from "../../schema";
import { ApiError, defineCommand } from "../command";
import { requireClip } from "../lookup";
import { BEHAVIOR, behaviorDef } from "../../behaviors/registry";
import { addBehavior, behaviorIn, describeBehavior, overrideBehavior, removeBehavior, reorderBehavior, resetBehaviorOverrides, updateBehavior } from "../../behaviors/ops";
import { characterLanes } from "../../rig/character-lanes";
import { poseEnvAt } from "../../evaluate/resolved-doc";

/**
 * BEHAVIORS, FOR AGENTS (Characters 3.0) — what a character does on its own:
 * Lip sync, Blink, Glance, Breathe, Sway, Nod with voice, Cycle, State machine.
 * A stack on the character group; each drives a pose set (only while active)
 * or adds onto channels. A person's change is an OVERRIDE span — kept when the
 * behavior regenerates. See references/behaviors.md.
 */

const field = z.union([z.number(), z.string(), z.boolean()]);
const stepSpec = z.object({ pose: z.string(), ms: z.number().min(1) });

function requireCharacter(doc: MotionDocument, id: string): GroupClip {
  const c = requireClip(doc, id).clip;
  if (c.kind !== "group") throw new ApiError(`"${c.name}" is not a character group.`, "Behaviors live on the group that is the character.");
  return c;
}

function requireBehavior(doc: MotionDocument, groupId: string, ref: string) {
  const g = requireCharacter(doc, groupId);
  const b = behaviorIn(g, ref);
  if (!b) throw new ApiError(`No behavior "${ref}" on "${g.name}".`, `Behaviors: ${(g.behaviors ?? []).map((x) => `${behaviorDef(x.type)?.label ?? x.type} (${x.id})`).join(", ") || "none — behaviors.add makes one"}.`);
  return { group: g, behavior: b };
}

const TYPES = () =>
  BEHAVIOR.types.map((d) => ({
    type: d.type,
    label: d.label,
    does: d.blurb,
    drives: d.drives,
    fields: [...d.fields.map((f) => ({ key: f.key, kind: f.kind === "ref" ? `ref:${f.ref}` : f.kind, ...(f.min !== undefined && { min: f.min }), ...(f.max !== undefined && { max: f.max }), ...(f.unit && { unit: f.unit }), ...(f.options && { options: f.options.map((o) => o.value) }) })), ...(d.toggles ?? []).map((t) => ({ key: t.key, kind: "toggle" }))],
  }));

export const behaviorsInspect = defineCommand({
  id: "behaviors.inspect",
  summary: "A character's behaviors (what each drives, its fields, its overrides) and, with `blocks`, what each pose set shows block by block and who decided it.",
  details:
    "`types: true` lists every behavior kind and its fields. Block `source`: keyed (your keys), base (the resting pose), live (a behavior — `behavior` names it — or a driver); `overridden: true` where a person's override decided it. Times are comp ms.",
  effect: "read",
  input: z.object({ groupId: z.string().optional(), blocks: z.boolean().default(false), fromMs: z.number().min(0).optional(), toMs: z.number().min(0).optional(), types: z.boolean().default(false) }),
  run(input, rt) {
    const doc = rt.doc();
    if (!input.groupId) return { types: TYPES() };
    const g = requireCharacter(doc, input.groupId);
    const lanes = input.blocks
      ? characterLanes(doc, g.id, input.fromMs !== undefined || input.toMs !== undefined ? { fromMs: input.fromMs ?? 0, toMs: input.toMs ?? Infinity } : undefined, (t) => poseEnvAt(doc, t, g.frameId))
      : [];
    return {
      groupId: g.id,
      behaviors: (g.behaviors ?? []).map((b) => describeBehavior(g, b)),
      ...(input.blocks && {
        lanes: lanes.map((l) => ({
          set: l.name,
          blocks: l.blocks.map((b) => ({ fromMs: Math.round(b.fromMs), toMs: Math.round(b.toMs), pose: b.name, source: b.source, ...(b.behaviorId && { behavior: b.behaviorId }), ...(b.overridden && { overridden: true }) })),
        })),
      }),
      ...(input.types && { types: TYPES() }),
    };
  },
});

export const behaviorsAdd = defineCommand({
  id: "behaviors.add",
  summary: "Add a behavior to a character — lipSync, blink, glance, breathe, sway, nod, cycle or machine — tailored to it (the set its kind is for, its Closed/Half poses, its bones); `fields` override any of that.",
  details:
    "Set behaviors take `set` (a pose set's name or id). Channel behaviors take `layer` (\"\" = the character) and `channel` (\"bone.<id>.scale\", \"rotation\", \"y\", \"scaleY\"…; \"\" = the kind's default bone). A cycle takes `steps: [{pose, ms}]`. Order matters for set behaviors: a later one wins where two are active.",
  effect: "write",
  input: z.object({ groupId: z.string(), type: z.string(), set: z.string().optional(), fields: z.record(field).optional(), steps: z.array(stepSpec).optional(), index: z.number().int().min(0).optional() }),
  run(input, rt) {
    if (!behaviorDef(input.type)) throw new ApiError(`No behavior kind "${input.type}".`, `Kinds: ${BEHAVIOR.types.map((d) => d.type).join(", ")}.`);
    let made: ReturnType<typeof addBehavior> = null;
    rt.write(`Add ${behaviorDef(input.type)!.label}`, (d) => {
      requireCharacter(d, input.groupId);
      made = addBehavior(d, input.groupId, input.type, { ...(input.fields ?? {}), ...(input.set !== undefined && { set: input.set }) }, { index: input.index, steps: input.steps });
    });
    const b = made as ReturnType<typeof addBehavior>;
    if (!b) throw new ApiError("The behavior could not be added.");
    const g = requireCharacter(rt.doc(), input.groupId);
    const drives = behaviorDef(input.type)!.drives;
    const warn = drives === "set" && input.type !== "machine" && !b.set ? `No pose set fits a ${behaviorDef(input.type)!.label} — pass \`set\`.` : undefined;
    return { behavior: describeBehavior(g, behaviorIn(g, b.id)!), ...(warn && { warning: warn }) };
  },
});

export const behaviorsUpdate = defineCommand({
  id: "behaviors.update",
  summary: "Change a behavior: its fields (null clears one to its default), `enabled`, a cycle's `steps`, or its place in the stack (`index`).",
  effect: "write",
  input: z.object({ groupId: z.string(), id: z.string(), fields: z.record(field.nullable()).optional(), enabled: z.boolean().optional(), steps: z.array(stepSpec).optional(), index: z.number().int().min(0).optional() }),
  run(input, rt) {
    rt.write("Change behavior", (d) => {
      const { behavior } = requireBehavior(d, input.groupId, input.id);
      updateBehavior(d, input.groupId, behavior.id, { ...(input.fields ?? {}), ...(input.enabled !== undefined && { enabled: input.enabled }), ...(input.steps && { steps: input.steps }) });
      if (input.index !== undefined) reorderBehavior(d, input.groupId, behavior.id, input.index);
    });
    const { group, behavior } = requireBehavior(rt.doc(), input.groupId, input.id);
    return { behavior: describeBehavior(group, behavior) };
  },
});

export const behaviorsRemove = defineCommand({
  id: "behaviors.remove",
  summary: "Remove a behavior from a character (its keyed fields and overrides go with it).",
  effect: "write",
  input: z.object({ groupId: z.string(), id: z.string() }),
  run(input, rt) {
    rt.write("Remove behavior", (d) => {
      const { behavior } = requireBehavior(d, input.groupId, input.id);
      removeBehavior(d, input.groupId, behavior.id);
    });
    return { removed: true };
  },
});

export const behaviorsOverride = defineCommand({
  id: "behaviors.override",
  summary: "Override a behavior over comp `fromMs`–`toMs`: show `pose` there (a blink you add, a cycle step you change), or `pose: null` to make it stand aside (no blink here). `reset: true` puts the range — or, without one, all of it — back to automatic.",
  details: "Overrides are kept when the behavior regenerates (a new seed, rate or recording). For one block, poses.block (split, change, trim, slide, delete) writes the override for you; speech.fix corrects the voice's own reading (it travels with the voice).",
  effect: "write",
  input: z.object({ groupId: z.string(), id: z.string(), fromMs: z.number().min(0).optional(), toMs: z.number().min(0).optional(), pose: z.string().nullable().optional(), reset: z.boolean().default(false) }),
  run(input, rt) {
    let n = 0;
    rt.write(input.reset ? "Back to automatic" : "Override behavior", (d) => {
      const { group, behavior } = requireBehavior(d, input.groupId, input.id);
      const span = input.fromMs !== undefined && input.toMs !== undefined ? { fromMs: input.fromMs - group.startMs, toMs: input.toMs - group.startMs } : null;
      if (input.reset) n = resetBehaviorOverrides(d, input.groupId, behavior.id, span ?? undefined);
      else {
        if (!span || !(span.toMs > span.fromMs)) throw new ApiError("Give `fromMs` < `toMs` (comp ms).");
        if (input.pose === undefined) throw new ApiError("Say which `pose` shows there, or `pose: null` to stand aside.");
        n = overrideBehavior(d, input.groupId, behavior.id, { ...span, pose: input.pose }) ? 1 : 0;
      }
    });
    return input.reset ? { reset: n } : { overridden: n === 1 };
  },
});

export const BEHAVIOR_COMMANDS = [behaviorsInspect, behaviorsAdd, behaviorsUpdate, behaviorsRemove, behaviorsOverride];
