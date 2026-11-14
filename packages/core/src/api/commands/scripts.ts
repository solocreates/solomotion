import { z } from "zod";
import { scriptRunModeSchema } from "../../schema";
import { findScript, saveScript, scriptPath } from "../../scripts/files";
import { ApiError, defineCommand } from "../command";
import type { CommandRegistry } from "../registry";
import { requireClip, requireFrame, resolveTargetFrame } from "../lookup";
import { reify, type ReifyTarget } from "../../scripts/reify";
import "../../scripts/reify-printers";

/**
 * The project's scripts as document verbs. Running one is the host's
 * (`script.run`) — it needs the worker; reading and writing files does not.
 */

const scriptList = defineCommand({
  id: "script.list",
  summary: "The project's script files: path, id, size, run mode.",
  effect: "read",
  input: z.object({}),
  run(_input, rt) {
    const doc = rt.doc();
    return doc.scripts.map((s) => ({ id: s.id, path: scriptPath(doc, s), lines: s.source.split("\n").length, onRun: s.onRun }));
  },
});

const scriptRead = defineCommand({
  id: "script.read",
  summary: "A script file's source.",
  effect: "read",
  input: z.object({ script: z.string().describe("Path (`intro/title.js`), file name or id.") }),
  run(input, rt) {
    const doc = rt.doc();
    const s = findScript(doc, input.script);
    if (!s) throw new ApiError(`No script "${input.script}".`, "script.list shows every path.");
    return { id: s.id, path: scriptPath(doc, s), onRun: s.onRun, source: s.source };
  },
});

const scriptSave = defineCommand({
  id: "script.save",
  summary: "Create a script file, or overwrite one, at a path. Folders are made as needed.",
  details:
    "Save a script the person should keep and re-run — it appears in the Scripts panel. For a one-off, call script.run with `code` instead and leave the project's files alone.",
  effect: "write",
  input: z.object({
    path: z.string().min(1).describe("`intro/title.js` — `.js` is added when missing."),
    source: z.string(),
    onRun: scriptRunModeSchema.optional().describe("replace (default): a re-run removes what the last run created. append: every run adds."),
  }),
  run(input, rt) {
    let out = { id: "", path: "" };
    rt.write("Save script", (d) => {
      const s = saveScript(d, input.path, input.source);
      if (input.onRun) s.onRun = input.onRun;
      out = { id: s.id, path: scriptPath(d, s) };
    });
    return out;
  },
});

export const SCRIPT_COMMANDS = [scriptList, scriptRead, scriptSave];

/**
 * `script.reify` — layers, a comp, or one machine as the `ac.*` code that
 * rebuilds it (scripts/reify.ts). Read it, edit it, run it: a saved file whose
 * ledger owns the target (`save`) edits it in place on its first replace run.
 * Made per registry because the round trip is measured against its verbs.
 */
export function scriptReifyCommand(registry: CommandRegistry) {
  return defineCommand({
    id: "script.reify",
    summary: "Print layers, a comp, or a state machine as the ac.* script that rebuilds it — read the code, edit it, run it in replace mode.",
    details:
      "Default target: the selection. The code is measured on a copy of the project: `exact` says it rebuilds the target (ids aside); `warnings` lists anything it cannot say. `save` (a path) keeps it as a script that OWNS the target — its first replace run removes the originals and rebuilds them from the code, so editing the code IS editing the layers. See references/code-bridge.md.",
    effect: "write",
    input: z.object({
      layers: z.array(z.string()).optional().describe("Layer ids or names; omitted = the selection."),
      comp: z.string().optional().describe("A whole comp (id or name), printed as frame.create + its layers."),
      machine: z.object({ frameId: z.string().optional(), name: z.string() }).optional().describe("One state machine of a comp (the board's Code tab)."),
      save: z.string().optional().describe("Save as a script at this path that owns what it prints."),
    }),
    async run(input, rt) {
      const doc = rt.doc();
      let target: ReifyTarget;
      if (input.machine) {
        const frame = input.machine.frameId ? requireFrame(doc, input.machine.frameId) : resolveTargetFrame(rt);
        target = { part: "machine", frameId: frame.id, id: input.machine.name };
      } else if (input.comp) target = { comp: requireFrame(doc, input.comp).id };
      else {
        const ids = (input.layers ?? [...rt.session.selection()]).map((id) => requireClip(doc, id).clip.id);
        if (!ids.length) throw new ApiError("Nothing to print.", "Pass `layers`, `comp` or `machine`, or select layers first.");
        target = { layers: ids };
      }
      let out: Awaited<ReturnType<typeof reify>>;
      try {
        out = await reify(doc, target, { registry });
      } catch (e) {
        throw new ApiError(e instanceof Error ? e.message : String(e));
      }
      let saved: { id: string; path: string } | undefined;
      if (input.save) {
        const path = input.save;
        rt.write("Save script", (d) => {
          const s = saveScript(d, path, out.code);
          s.onRun = "replace";
          s.output = { clipIds: [...out.owns.clipIds], frameIds: [...out.owns.frameIds] };
          saved = { id: s.id, path: scriptPath(d, s) };
        });
      }
      return { code: out.code, exact: out.exact, ...(out.warnings.length ? { warnings: out.warnings } : {}), ...(saved ? { saved } : {}) };
    },
  });
}
