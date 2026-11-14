import { z } from "zod";
import { fxToken, parseFxToken } from "../../schema";
import { addExpression, documentCheckEnv, expressionById, setExpressionSource } from "../../expressions/document";
import { analyzeExpression } from "../../expressions/bind";
import { functionsByCategory } from "../../expressions/functions";
import { globalsByCategory } from "../../expressions/globals";
import { applyTransitionToClips, findTransition } from "../../timeline/transitions";
import { TRANSITION_PRESETS } from "../../animation/transitions";
import { ApiError, defineCommand } from "../command";
import { requireClip } from "../lookup";
import { easingInputSchema, parseEasing } from "../values";
import { assertPath, canonicalPath, knownPaths } from "./edit";

/**
 * LINKS AND CUTS — values that come from somewhere else, and the seams between
 * clips.
 *
 * An EXPRESSION drives a property from a formula (`wiggle(2, 8)`,
 * `layer("Title").x + 40`, `#time * 90`), bound through the same `drivers` map
 * variables and node graphs use — so a driven property keeps its own base value
 * and keys underneath, and unbinding restores them. A TRANSITION sits on a cut
 * between two clips on a lane, or on a lone clip's head or tail.
 */

export const expressionSet = defineCommand({
  id: "expression.set",
  summary: "Drive a property with an expression (a formula evaluated every frame), or remove one.",
  details:
    "The source is checked before it is bound; a type or syntax error comes back with the message. expression.reference lists every function and #global. `source: null` unbinds, restoring the property's own value and keys. Returns the expression id — bind the same id to several properties to link them.",
  effect: "write",
  input: z.object({
    id: z.string(),
    property: z.string().describe("Any path from layer.properties."),
    source: z.string().nullable(),
    expressionId: z.string().optional().describe("Reuse an existing expression instead of writing a new one."),
    name: z.string().optional().describe("The expression's label in the project's table; omitted = \"<layer> · <property>\"."),
  }),
  run(input, rt) {
    const doc = rt.doc();
    const clip = requireClip(doc, input.id).clip;
    const property = canonicalPath(clip, input.property, doc);
    assertPath(clip, property, knownPaths(clip, doc));
    if (input.source !== null && !input.expressionId) {
      const { check } = analyzeExpression(input.source, documentCheckEnv(doc, null));
      const errors = check.diagnostics.filter((d) => d.severity === "error");
      if (errors.length) {
        throw new ApiError(
          `The expression does not check: ${errors.map((d) => d.message).join("; ")}.`,
          "expression.reference lists the functions and globals.",
        );
      }
    }
    let expressionId: string | null = null;
    rt.write(input.source === null ? "Remove expression" : "Set expression", (d) => {
      const c = requireClip(d, input.id).clip;
      const drivers = { ...(c.drivers ?? {}) };
      if (input.source === null && !input.expressionId) {
        delete drivers[property];
      } else {
        const existing = input.expressionId ? expressionById(d, input.expressionId) : undefined;
        if (input.expressionId && !existing) throw new ApiError(`No expression "${input.expressionId}".`);
        const current = parseFxToken(drivers[property]);
        const expr = existing ?? (current ? expressionById(d, current) : undefined);
        if (expr && input.source !== null && !input.expressionId) setExpressionSource(d, expr.id, input.source);
        const id = expr?.id ?? addExpression(d, input.source ?? "", input.name ?? `${c.name} · ${property}`).id;
        drivers[property] = fxToken(id);
        expressionId = id;
      }
      c.drivers = Object.keys(drivers).length ? drivers : undefined;
    });
    return { expressionId, property: property };
  },
});

export const expressionReference = defineCommand({
  id: "expression.reference",
  summary: "The expression language: every function (with signature and an example) and every #global.",
  effect: "read",
  input: z.object({ category: z.string().optional() }),
  run(input) {
    const want = input.category?.toLowerCase();
    return {
      functions: functionsByCategory()
        .filter((g) => !want || g.category.toLowerCase().includes(want))
        .map((g) => ({
          category: g.category,
          functions: g.functions.map((f) => ({
            name: f.name,
            params: f.params.map((p) => (p.optional ? `${p.name}?` : p.name)),
            does: f.describe,
            ...(f.example ? { e: f.example } : {}),
          })),
        })),
      globals: globalsByCategory()
        .filter((g) => !want || g.category.toLowerCase().includes(want))
        .map((g) => ({ category: g.category, globals: g.globals.map((x) => ({ name: `#${x.name}`, type: x.type, does: x.describe })) })),
    };
  },
});

export const transitionAdd = defineCommand({
  id: "transition.add",
  summary: "Put a transition on the cuts of clips — between two abutting clips, or on a lone clip's head/tail.",
  details:
    "`edge` in = the clip's start, out = its end, any = both. Clips sharing a cut get one transition, not two. catalog.list transitions shows the presets.",
  effect: "write",
  input: z.object({
    ids: z.array(z.string()).min(1),
    preset: z.string(),
    edge: z.enum(["in", "out", "any"]).default("any"),
    durationMs: z.number().positive().optional(),
    easing: easingInputSchema.optional(),
    params: z.record(z.string(), z.number()).optional(),
    color: z.string().optional(),
  }),
  run(input, rt) {
    if (!TRANSITION_PRESETS.some((p) => p.id === input.preset)) {
      throw new ApiError(`No transition "${input.preset}".`, "catalog.list transitions.");
    }
    let count = 0;
    rt.write("Add transition", (d) => {
      for (const id of input.ids) requireClip(d, id);
      count = applyTransitionToClips(
        d,
        input.ids,
        input.preset,
        {
          ...(input.durationMs ? { durationMs: input.durationMs } : {}),
          ...(input.easing ? { easing: parseEasing(input.easing) } : {}),
          ...(input.params ? { params: input.params } : {}),
          ...(input.color ? { color: input.color } : {}),
        },
        input.edge,
      );
      if (!count) throw new ApiError("No cut there had room for a transition.", "Clips need handle room on the lane at that edge.");
    });
    return { added: count };
  },
});

export const transitionRemove = defineCommand({
  id: "transition.remove",
  summary: "Remove a transition by id (layer.get on a clip does not list them; layers.list flags clips that have them).",
  effect: "write",
  input: z.object({ transitionId: z.string() }),
  run(input, rt) {
    rt.write("Remove transition", (d) => {
      const found = findTransition(d, input.transitionId);
      if (!found) throw new ApiError(`No transition "${input.transitionId}".`);
      found.track.transitions = found.track.transitions.filter((t) => t.id !== input.transitionId);
    });
    return { removed: input.transitionId };
  },
});

export const LINK_COMMANDS = [expressionSet, expressionReference, transitionAdd, transitionRemove];
