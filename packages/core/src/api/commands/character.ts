import { z } from "zod";
import { ApiError, defineCommand, type CommandContext } from "../command";
import type { CommandRegistry } from "../registry";
import { requireClip } from "../lookup";
import type { DocumentStore } from "../../history/document-store";
import { detectParts, isPartRole, PART_ROLES, type PartOverrides } from "../../rig/parts";
import { lifeOf, planBringToLife, printPlan, resolvePlanRefs } from "../../rig/alive";

/**
 * CHARACTERS, FOR AGENTS — "Make character" as two verbs: `character.detect`
 * reads which layer is what; `character.bringToLife` runs the plan
 * (`rig/alive.ts`) through this same registry as ONE undo step, or returns it
 * (`dryRun`) with its script. The Life toggles in the Character tab are the
 * same verb with one behavior set.
 */

const overrides = z
  .record(z.string(), z.string().nullable())
  .optional()
  .describe(`Corrections: a role → a layer id or name (null drops the role). Roles: ${PART_ROLES.join(" ")}`);

function parseOverrides(doc: Parameters<typeof requireClip>[0], raw: Record<string, string | null> | undefined): PartOverrides | undefined {
  if (!raw) return undefined;
  const out: PartOverrides = {};
  for (const [role, id] of Object.entries(raw)) {
    if (!isPartRole(role)) throw new ApiError(`No role "${role}".`, `Roles: ${PART_ROLES.join(", ")}.`);
    out[role] = id === null ? null : requireClip(doc, id).clip.id;
  }
  return out;
}

let runs = 0;

export function characterCommands(api: CommandRegistry) {
  const detect = defineCommand({
    id: "character.detect",
    summary: "Which layer of a character is its head, each eye, pupil, brow, the mouth (and its shapes), body, arms, hands, legs — with confidence and a reason.",
    details:
      "Pass a group (rig or not) or a component instance. Reads names in many languages and conventions (Eye_L, left eye, ojo izquierdo, 左目), the lip-sync viseme tag, switches whose members are visemes/Rhubarb letters/eye states/hand poses, and the layout (a mirrored pair high in the head = eyes). Sides: .L is the CHARACTER's left (screen right). Never changes anything.",
    effect: "read",
    input: z.object({ id: z.string(), overrides }),
    run(input, rt) {
      const doc = rt.doc();
      const map = detectParts(doc, input.id, { overrides: parseOverrides(doc, input.overrides) });
      if (!map) throw new ApiError(`"${requireClip(doc, input.id).clip.name}" is not a character.`, "Pass a group of its layers, or a component instance.");
      return {
        figure: map.figure,
        parts: Object.values(map.parts).map((p) => ({
          role: p!.role,
          id: p!.clipId,
          name: p!.name,
          confidence: p!.confidence,
          reason: p!.reason,
          ...(p!.members && { shapes: p!.members.map((m) => `${m.name}=${m.pose}`) }),
        })),
        life: lifeOf(doc, input.id, map),
      };
    },
  });

  const bringToLife = defineCommand({
    id: "character.bringToLife",
    summary: "Make character: one call makes a group (or instance) blink, breathe, nod and talk — pose sets for mouth/eyes/brows/hands from what it finds, wired as one undo step.",
    details:
      "Defaults: blink, breathe, nod, talk on; look off. true turns a behavior on, false off (the Life toggles). `voice`: an audio clip id (default: the one bound, else one overlapping the character; null: none). `dryRun` returns the plan and its script without changing anything. Running it again plans nothing new. An instance talks through its comp's `Voice` input, set here on the instance.",
    effect: "write",
    input: z.object({
      id: z.string(),
      blink: z.boolean().optional(),
      breathe: z.boolean().optional(),
      nod: z.boolean().optional(),
      look: z.boolean().optional().describe("Pupil pads that look at a Look control (drag it, or Perform)"),
      talk: z.boolean().optional(),
      voice: z.string().nullable().optional(),
      blinkEvery: z.number().min(0.5).max(30).optional().describe("Seconds between blinks (default 4)"),
      overrides,
      dryRun: z.boolean().default(false),
    }),
    async run(input, rt) {
      const doc = rt.doc();
      const { id, dryRun, overrides: raw, voice, ...behaviors } = input;
      const plan = planBringToLife(doc, id, { ...behaviors, voice: voice === undefined ? undefined : voice === null ? null : requireClip(doc, voice).clip.id, overrides: parseOverrides(doc, raw) });
      if (!plan) throw new ApiError(`"${requireClip(doc, id).clip.name}" is not a character.`, "Pass a group of its layers, or a component instance.");
      const summary = {
        life: plan.life,
        voice: plan.voice,
        parts: Object.values(plan.parts.parts).map((p) => `${p!.role}: ${p!.name}`),
      };
      if (dryRun) return { ...summary, steps: plan.steps, script: printPlan(plan) };
      // ONE undo step: an agent's turn already groups; a person's click gets its own key.
      const sub: CommandContext = rt.historyKey !== undefined || GROUPED in rt.store ? rt : { ...rt, store: makeCharacterStore(rt.store, `make-character:${++runs}`) };
      const results: unknown[] = [];
      for (const [i, step] of plan.steps.entries()) {
        const res = await api.call(step.verb, resolvePlanRefs(step.input, results), sub);
        if (!res.ok) throw new ApiError(`Step ${i + 1} (${step.verb}, ${step.why}) failed: ${res.error}`, res.hint);
        results.push(res.value);
      }
      return { ...summary, ran: plan.steps.length };
    },
  });

  return [detect, bringToLife];
}

const GROUPED = Symbol("make-character");

/**
 * A store whose every write merges into one entry labelled "Make character".
 * A host that places art first (a flat picture's mouth and lids) writes
 * through the same one, so the whole gesture is one undo step.
 */
export function makeCharacterStore(store: DocumentStore, key: string, label = "Make character"): DocumentStore {
  const out: DocumentStore = { ...store, update: (_label, recipe) => store.update(label, recipe, { mergeKey: key, mergeWindowMs: Infinity }) };
  return Object.assign(out, { [GROUPED]: true });
}
