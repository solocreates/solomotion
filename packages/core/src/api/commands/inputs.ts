import { z } from "zod";
import type { MotionDocument } from "../../schema";
import { INPUT_TYPES, inputValueSchema } from "../../schema/inputs";
import { ApiError, defineCommand } from "../command";
import { resolveTargetFrame } from "../lookup";
import { findInputDef, inputDefsOf } from "../../components/inputs";
import { defineInput, exposeAsInput, inputBindings, keyableVariants, removeInput, reorderInput, updateInput } from "../../components/inputs-ops";

/**
 * COMPONENT INPUTS, FOR AGENTS — one verb for a comp's public interface
 * (docs/adr/characters/inputs.md). Setting an INSTANCE's value is not a verb
 * of its own: it is the ordinary channel `input.<id>` (or `input.<Name>`) on
 * the nested clip — `layer_set` writes it, `keyframes_set` keys it, drivers and
 * expressions drive it, exactly like any property.
 */

const draft = z
  .object({
    name: z.string(),
    type: z.enum(INPUT_TYPES),
    default: inputValueSchema,
    min: z.number(),
    max: z.number(),
    step: z.number().positive(),
    options: z.array(z.string()).min(1),
  })
  .partial();

function listOf(doc: MotionDocument, frameId: string) {
  return inputDefsOf(doc, frameId).map((d) => ({ ...d, path: `input.${d.id}`, bound: inputBindings(doc, frameId, d.id) }));
}

export const componentInputs = defineCommand({
  id: "component.inputs",
  summary:
    "A component's INPUTS — its keyable public knobs (Figma component properties): list, define, update, remove, reorder, expose a field inside it as one, or turn its variants into one keyable Choice.",
  details:
    "Types: number (min/max/step), bool, enum (options), text, color, trigger (fires on the frame of each key), layer (a layer id/name in the comp the INSTANCE sits in — `lipsync(input(\"Voice\"))` lets two instances speak two lines). " +
    "`expose` binds a field of a layer inside the comp (`layerId` + `property`, any path from layer_properties) to a new input named and typed from it. " +
    "`variants` (frameId = a component) builds a new component holding a switch of every variant, driven by a `Variant` enum input — key that instead of swapping instances. " +
    "Instances: set with layer_set {\"input.Mood\": \"Sad\"} (id or name), key with keyframes_set on `input.<id>`. Inside the comp, bind any field with expression.set(…, 'input(\"Mood\") == \"Sad\" ? 1 : 0') or read it in a state machine. Removing an input unbinds its fields (they keep the master's value) and drops every instance's keys for it.",
  effect: "write",
  input: z.object({
    action: z.enum(["list", "define", "update", "remove", "reorder", "expose", "variants"]),
    frameId: z.string().optional().describe("The comp that owns the inputs (default: the active comp; for expose, the layer's comp)"),
    input: z.string().optional().describe("An input's id or name (update / remove / reorder)"),
    def: draft.optional().describe("define: name + type (+ default, min/max/step, options); update: the fields to change"),
    index: z.number().int().min(0).optional().describe("reorder: the new position, 0 = top"),
    layerId: z.string().optional().describe("expose: the layer inside the comp"),
    property: z.string().optional().describe("expose: the field's path, e.g. opacity, fill.<id>, switch"),
    name: z.string().optional().describe("expose: the input's name (default: the field's label)"),
  }),
  run(input, rt) {
    const needInput = (doc: MotionDocument, frameId: string) => {
      if (!input.input) throw new ApiError("Say which input.", "`input`: its id or name.");
      const def = findInputDef(inputDefsOf(doc, frameId), input.input);
      if (!def) throw new ApiError(`No input "${input.input}".`, `Inputs: ${inputDefsOf(doc, frameId).map((d) => d.name).join(", ") || "none — define one"}.`);
      return def;
    };
    if (input.action === "expose") {
      if (!input.layerId || !input.property) throw new ApiError("Say which field.", "`layerId` and `property` (a path from layer_properties).");
      let result: { frameId: string; inputId: string } | null = null;
      rt.write("Expose as input", (d) => {
        try {
          const r = exposeAsInput(d, input.layerId!, input.property!, { name: input.name });
          result = { frameId: r.frameId, inputId: r.input.id };
        } catch (e) {
          throw new ApiError(e instanceof Error ? e.message : String(e), "layer_properties lists the paths a layer has.");
        }
      });
      const r = result!;
      return { frameId: r.frameId, inputId: r.inputId, inputs: listOf(rt.doc(), r.frameId) };
    }
    const frameId = resolveTargetFrame(rt, input.frameId).id;
    switch (input.action) {
      case "list":
        return { frameId, inputs: listOf(rt.doc(), frameId) };
      case "define": {
        if (!input.def?.type) throw new ApiError("Say the input's type.", `def.type: one of ${INPUT_TYPES.join(", ")}.`);
        let id = "";
        rt.write("Add input", (d) => {
          id = defineInput(d, frameId, { ...input.def!, type: input.def!.type! }).id;
        });
        return { frameId, inputId: id, inputs: listOf(rt.doc(), frameId) };
      }
      case "update": {
        const def = needInput(rt.doc(), frameId);
        rt.write("Edit input", (d) => void updateInput(d, frameId, def.id, input.def ?? {}));
        return { frameId, inputs: listOf(rt.doc(), frameId) };
      }
      case "remove": {
        const def = needInput(rt.doc(), frameId);
        let unbound = 0;
        rt.write("Remove input", (d) => void (unbound = removeInput(d, frameId, def.id)));
        return { frameId, removed: def.id, unbound, inputs: listOf(rt.doc(), frameId) };
      }
      case "reorder": {
        const def = needInput(rt.doc(), frameId);
        rt.write("Reorder inputs", (d) => void reorderInput(d, frameId, def.id, input.index ?? 0));
        return { frameId, inputs: listOf(rt.doc(), frameId) };
      }
      case "variants": {
        let made: ReturnType<typeof keyableVariants> = null;
        rt.write("Keyable variants", (d) => void (made = keyableVariants(d, frameId)));
        if (!made) throw new ApiError("That comp is not a component.", "component_list shows component frames; variants live in a component's set.");
        const m = made as NonNullable<ReturnType<typeof keyableVariants>>;
        return { ...m, inputs: listOf(rt.doc(), m.frameId) };
      }
    }
  },
});

export const INPUT_COMMANDS = [componentInputs];
