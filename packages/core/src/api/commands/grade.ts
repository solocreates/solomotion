import { z } from "zod";
import type { Clip, VisualClip } from "../../schema";
import {
  addOutsideOf,
  addParallelTo,
  clipGrades,
  ensureClipGrade,
  gradeCard,
  gradeNode,
  insertCorrectorAfter,
  outputNode,
  removeGradeNode,
} from "../../grade/ops";
import { LFX } from "../../animation/layer-effects";
import { nestClips } from "../../timeline/ops";
import { ApiError, defineCommand } from "../command";
import { requireClip } from "../lookup";
import { validClip } from "./edit";

/**
 * COLOUR — the grade graph, Resolve-style: Source → correctors → Output, with
 * parallel and outside nodes for secondaries. A corrector's payload is an
 * ORDINARY effect stack (wheels, curves, HSL, LUT-like looks), so grading
 * reuses every colour card the app has and every field keyframes at
 * `lfx.<card>.n.<node>.fx.<effect>.<field>`. The skill's colour chapter says
 * how to build a look from a feeling; these verbs are how.
 */

function visual(clip: Clip): VisualClip {
  if (clip.kind === "audio") throw new ApiError("Audio has no picture to grade.");
  return clip;
}

export const gradeRead = defineCommand({
  id: "grade.read",
  summary: "A layer's colour grade as a node list: each node's kind, name, effects, qualifier and windows, and how they connect.",
  effect: "read",
  input: z.object({ id: z.string() }),
  run(input, rt) {
    const clip = visual(requireClip(rt.doc(), input.id).clip);
    return clipGrades(clip).map(({ cardId, graph }) => ({
      cardId,
      nodes: graph.nodes.map((n) => ({
        id: n.id,
        kind: n.kind,
        name: n.name,
        ...(n.kind === "corrector"
          ? {
              effects: n.effects.map((e) => ({ id: e.id, type: e.type, enabled: e.enabled })),
              qualifier: n.key.qualifier.enabled,
              windows: n.key.windows.map((w) => w.id),
              opacity: n.opacity,
            }
          : {}),
      })),
      edges: graph.edges.map((e) => `${e.from.node} → ${e.to.node}${e.to.port === "key" ? " (key)" : ""}`),
    }));
  },
});

export const gradeNodeCmd = defineCommand({
  id: "grade.node",
  summary: "Add or remove a corrector node in a layer's grade — in series, in parallel, or as an outside (inverse-key) node.",
  details:
    "Adding the first node creates the grade card (Source → Corrector → Output). `after` = serial (default: before Output); `parallelTo` = a parallel branch mixed back in; `outsideOf` = the same key inverted (grade the background of a secondary). Returns node and card ids.",
  effect: "write",
  input: z.object({
    id: z.string(),
    op: z.enum(["add", "remove"]).default("add"),
    name: z.string().optional().describe("What this node does: \"Balance\", \"Skin\", \"Look\"."),
    after: z.string().optional(),
    parallelTo: z.string().optional(),
    outsideOf: z.string().optional(),
    nodeId: z.string().optional().describe("For remove."),
  }),
  run(input, rt) {
    let nodeId = "";
    let cardId = "";
    rt.write(input.op === "add" ? "Add grade node" : "Remove grade node", (d) => {
      const clip = visual(requireClip(d, input.id).clip);
      const fresh = !gradeCard(clip);
      const graph = ensureClipGrade(clip);
      cardId = gradeCard(clip)!.id;
      if (input.op === "remove") {
        if (!input.nodeId || !gradeNode(graph, input.nodeId)) throw new ApiError("Name an existing nodeId to remove.");
        removeGradeNode(graph, input.nodeId);
        nodeId = input.nodeId;
        return;
      }
      if (fresh && !input.parallelTo && !input.outsideOf) {
        // A new grade is born with one corrector already wired — that is the node.
        const first = graph.nodes.find((n) => n.kind === "corrector");
        if (first) {
          if (input.name) first.name = input.name;
          nodeId = first.id;
          return;
        }
      }
      const anchor = input.after ?? graph.edges.find((e) => e.to.node === outputNode(graph)?.id)?.from.node;
      const node = input.parallelTo
        ? addParallelTo(graph, input.parallelTo)
        : input.outsideOf
          ? addOutsideOf(graph, input.outsideOf)
          : anchor
            ? insertCorrectorAfter(graph, anchor, input.name ?? "")
            : null;
      if (!node) throw new ApiError("Could not place the node there.", "grade.read shows the node ids.");
      if (input.name) node.name = input.name;
      nodeId = node.id;
    });
    return { cardId, nodeId };
  },
});

export const gradeEffect = defineCommand({
  id: "grade.effect",
  summary: "Put a colour effect (wheels, curves, HSL, saturation, temperature…) inside a grade node.",
  details:
    "Any layer effect can live in a node; colour cards are the point. Returns the effect id and its keyframe path prefix. catalog.list layer-effects with query \"color\" shows the colour cards.",
  effect: "write",
  input: z.object({
    id: z.string(),
    nodeId: z.string(),
    type: z.string(),
    values: z.record(z.string(), z.unknown()).optional(),
  }),
  run(input, rt) {
    const def = LFX.def(input.type);
    if (!def) throw new ApiError(`No layer effect "${input.type}".`, "catalog.list layer-effects.");
    if (input.type === "grade") throw new ApiError("A grade cannot nest inside a grade node.");
    let effectId = "";
    let cardId = "";
    rt.write(`Grade: ${def.label}`, (d) => {
      const clip = visual(requireClip(d, input.id).clip);
      const card = gradeCard(clip);
      if (!card) throw new ApiError("This layer has no grade yet.", "grade.node add first.");
      const node = gradeNode(card.graph, input.nodeId);
      if (!node || node.kind !== "corrector") throw new ApiError(`No corrector "${input.nodeId}".`, "grade.read lists the nodes.");
      const effect = LFX.createFor(input.type as never, [clip.kind]);
      if (input.values) Object.assign(effect, input.values, { id: effect.id, type: effect.type });
      node.effects.push(effect);
      effectId = effect.id;
      cardId = card.id;
      validClip(clip, `Adding ${def.label} to the grade`);
    });
    return { effectId, path: `lfx.${cardId}.n.${input.nodeId}.fx.${effectId}.<field>` };
  },
});

export const layersNest = defineCommand({
  id: "layers.nest",
  summary: "Precompose layers into a nested comp (one layer on the outside, their own timeline inside). Pixels do not move.",
  effect: "write",
  details:
    "The new comp hugs the layers. `fullFrame: true` makes it this comp's size and centre instead, with the nested layer at identity — the World of a camera rig, whose box (and so the pivot of a Camera group holding it) must sit on the screen centre whatever is inside.",
  input: z.object({
    ids: z.array(z.string()).min(1),
    name: z.string().optional(),
    fullFrame: z.boolean().default(false).describe("The comp takes this comp's size and centre instead of hugging the layers."),
  }),
  run(input, rt) {
    for (const id of input.ids) requireClip(rt.doc(), id);
    let nested: string | null = null;
    rt.write("Nest layers", (d) => {
      nested = nestClips(d, input.ids, input.name, { fullFrame: input.fullFrame });
      if (!nested) throw new ApiError("Could not nest those layers.", "They must be unlocked visual layers in one comp.");
    });
    const clip = requireClip(rt.doc(), nested!).clip;
    return { id: nested, sourceFrameId: clip.kind === "nested" ? clip.sourceFrameId : null };
  },
});

export const GRADE_COMMANDS = [gradeRead, gradeNodeCmd, gradeEffect, layersNest];
