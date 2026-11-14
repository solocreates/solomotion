import { z } from "zod";
import { defineCommand } from "./command";
import { CommandRegistry } from "./registry";
import { INSPECT_COMMANDS } from "./commands/inspect";
import { EDIT_COMMANDS } from "./commands/edit";
import { ANIMATE_COMMANDS } from "./commands/animate";
import { STRUCTURE_COMMANDS } from "./commands/structure";
import { FLIPBOOK_COMMANDS } from "./commands/flipbook";
import { GRADE_COMMANDS } from "./commands/grade";
import { LINK_COMMANDS } from "./commands/links";
import { hyperlinkCommands } from "./commands/hyperlinks";
import type { EngineIdentity } from "../identity";
import { WORLD_COMMANDS } from "./commands/world";
import { RIG_COMMANDS } from "./commands/rig";
import { POSE_COMMANDS } from "./commands/poses";
import { BEHAVIOR_COMMANDS } from "./commands/behaviors";
import { SHAPE_KEY_COMMANDS } from "./commands/shape-keys";
import { FACE_COMMANDS } from "./commands/faces";
import { INPUT_COMMANDS } from "./commands/inputs";
import { PHYSICS_COMMANDS } from "./commands/physics";
import { SCRIPT_COMMANDS, scriptReifyCommand } from "./commands/scripts";
import { MACHINE_COMMANDS } from "./commands/machines";
import { PERFORM_COMMANDS } from "./commands/perform";
import { TRACK_COMMANDS } from "./commands/tracking";
import { characterCommands } from "./commands/character";
export { makeCharacterStore } from "./commands/character";

export * from "./command";
export * from "./registry";
export * from "./zod-reflect";
export * from "./patch";
export * from "./lookup";
export { easingInputSchema, parseEasing } from "./values";
export { validClip, writeProperties } from "./commands/edit";
export { CATALOGS, listCatalog, type CatalogId } from "./commands/animate";

/**
 * Bump when a command is removed or changes meaning. Additions do not bump it:
 * a caller that never asked for a new verb is unaffected by its existence. The
 * skill records the version it was written against, so a report can say which
 * contract a mistake happened under.
 */
export const API_VERSION = 1;

/**
 * `$<n>` and `$<n>.<path>` inside a batch refer to the result of the n-th call
 * (0-based) — so "create a card, then a title inside it" is one round trip.
 */
function resolveRefs(value: unknown, results: unknown[]): unknown {
  if (typeof value === "string") {
    const m = /^\$(\d+)((?:\.[\w-]+|\[\d+\])*)$/.exec(value);
    if (!m) return value;
    let cur: unknown = results[Number(m[1])];
    for (const step of m[2]!.match(/[\w-]+|\d+/g) ?? []) {
      cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[step] : undefined;
    }
    return cur;
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, results));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, results)]));
  }
  return value;
}

/**
 * THE API — every document verb core knows, in one registry. A host adds its
 * own verbs to the returned instance (`register`), and every caller reads that
 * one instance. `identity` is the product the host is (identity.ts): with it,
 * a link verb knows the app's own web address and scheme; without it (a
 * headless template build), only a bare app path is the app's.
 */
export function createCommandApi(identity?: EngineIdentity): CommandRegistry {
  const api = new CommandRegistry();
  api.register(...INSPECT_COMMANDS, ...EDIT_COMMANDS, ...ANIMATE_COMMANDS, ...STRUCTURE_COMMANDS, ...FLIPBOOK_COMMANDS, ...GRADE_COMMANDS, ...LINK_COMMANDS, ...hyperlinkCommands(identity ?? null), ...WORLD_COMMANDS, ...RIG_COMMANDS, ...POSE_COMMANDS, ...BEHAVIOR_COMMANDS, ...SHAPE_KEY_COMMANDS, ...FACE_COMMANDS, ...INPUT_COMMANDS, ...PHYSICS_COMMANDS, ...SCRIPT_COMMANDS);
  api.register(...MACHINE_COMMANDS);
  api.register(...PERFORM_COMMANDS);
  api.register(...TRACK_COMMANDS);
  api.register(scriptReifyCommand(api));
  api.register(...characterCommands(api));
  api.register(
    defineCommand({
      id: "api.batch",
      summary: "Run several commands in one call, in order. Later calls can use earlier results: \"$0.id\".",
      details:
        "Stops at the first failure unless `continueOnError`. Use it for anything that is one idea in several steps — a card and its contents, a staggered set of keys across layers. Each result is returned in order.",
      effect: "write",
      input: z.object({
        calls: z.array(z.object({ command: z.string(), input: z.record(z.string(), z.unknown()).default({}) })).min(1).max(40),
        continueOnError: z.boolean().default(false),
      }),
      async run(input, rt) {
        const results: unknown[] = [];
        const out: unknown[] = [];
        for (const [i, call] of input.calls.entries()) {
          if (call.command === "api.batch" || call.command === "api_batch") {
            out.push({ ok: false, error: "Batches do not nest." });
            break;
          }
          const res = await api.call(call.command, resolveRefs(call.input, results), rt);
          results.push(res.ok ? res.value : null);
          out.push(res.ok ? { ok: true, value: res.value } : res);
          if (!res.ok && !input.continueOnError) {
            out.push({ stopped: `at call ${i}`, remaining: input.calls.length - i - 1 });
            break;
          }
        }
        return out;
      },
    }),
  );
  return api;
}
