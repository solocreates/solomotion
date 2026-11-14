import { z } from "zod";
import { droppedKeys, nearest } from "./unknown-keys";
import { ApiError } from "./command";

/**
 * STRUCTURAL EDITS BY PATH — the API's answer to "and anything else".
 *
 * The verbs cover what has rules the document cannot state (placement, keys,
 * ranges, grouping). Everything else a layer holds is plain, schema-validated
 * data, and naming a verb for each of its hundreds of fields would be the
 * nine-file switch this codebase refuses to write. So a patch edits the data
 * directly — and the SCHEMA, not this file, decides what is legal: the edited
 * object is re-parsed before anything is committed, and a failure comes back
 * naming the field.
 *
 * Paths are dotted, with array steps as `[2]` (an index), `[id=fx_1]` (the
 * element with that id — stable across reorders, so prefer it), `[-]` (append
 * position for `insert`), or `[type=glass]` (the first element of that type).
 */

export const patchOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("set"),
    path: z.string().min(1),
    value: z.unknown().describe("Any JSON value; replaces what is there."),
  }),
  z.object({
    op: z.literal("merge"),
    path: z.string().describe("Object to shallow-merge into; empty = the root."),
    value: z.record(z.string(), z.unknown()),
  }),
  z.object({
    op: z.literal("insert"),
    path: z.string().min(1).describe("An array, e.g. `effects` or `fills`."),
    index: z.number().int().optional().describe("Position; omitted = append."),
    value: z.unknown(),
  }),
  z.object({ op: z.literal("remove"), path: z.string().min(1) }),
  z.object({
    op: z.literal("move"),
    path: z.string().min(1).describe("The array element to move, e.g. `effects[id=fx_1]`."),
    to: z.number().int().describe("Its new index."),
  }),
]);
export type PatchOp = z.infer<typeof patchOpSchema>;

type Step = { key: string } | { index: number } | { match: [string, string] } | { append: true };

function parsePath(path: string): Step[] {
  const steps: Step[] = [];
  for (const token of path.match(/[^.[\]]+|\[[^\]]*\]/g) ?? []) {
    if (token.startsWith("[")) {
      const body = token.slice(1, -1).trim();
      if (body === "-") steps.push({ append: true });
      else if (/^-?\d+$/.test(body)) steps.push({ index: Number(body) });
      else {
        const eq = body.indexOf("=");
        if (eq <= 0) throw new ApiError(`Bad path step "${token}" in "${path}".`, "Use [2], [id=…], [type=…] or [-].");
        steps.push({ match: [body.slice(0, eq), body.slice(eq + 1)] });
      }
    } else if (/^\d+$/.test(token)) steps.push({ index: Number(token) });
    else steps.push({ key: token });
  }
  return steps;
}

type Container = Record<string, unknown> | unknown[];

function isContainer(v: unknown): v is Container {
  return typeof v === "object" && v !== null;
}

function resolveIndex(arr: unknown[], step: Step, path: string): number {
  if ("index" in step) return step.index < 0 ? arr.length + step.index : step.index;
  if ("match" in step) {
    const [k, v] = step.match;
    const i = arr.findIndex((el) => isContainer(el) && String((el as Record<string, unknown>)[k]) === v);
    if (i < 0) {
      const have = arr
        .map((el) => (isContainer(el) ? (el as Record<string, unknown>)[k] : undefined))
        .filter((x) => x !== undefined);
      throw new ApiError(`Nothing at "${path}".`, have.length ? `Available ${k}s: ${have.join(", ")}.` : `The list is empty.`);
    }
    return i;
  }
  throw new ApiError(`"[-]" only works as the last step of an insert.`);
}

function stepInto(cur: unknown, step: Step, path: string): unknown {
  if (Array.isArray(cur)) {
    const i = resolveIndex(cur, step, path);
    if (i < 0 || i >= cur.length) throw new ApiError(`Index out of range in "${path}" (length ${cur.length}).`);
    return cur[i];
  }
  if (isContainer(cur) && "key" in step) {
    if (!(step.key in cur)) {
      throw new ApiError(`No field "${step.key}" in "${path}".`, `Fields here: ${Object.keys(cur).join(", ")}.`);
    }
    return (cur as Record<string, unknown>)[step.key];
  }
  throw new ApiError(`Cannot step into "${path}" — it is not an object or list.`);
}

/** Walk to the parent of the last step, returning it and that step. */
function parentOf(root: unknown, path: string): { parent: unknown; last: Step } {
  const steps = parsePath(path);
  if (!steps.length) throw new ApiError("Empty path.");
  let cur = root;
  for (let i = 0; i < steps.length - 1; i++) cur = stepInto(cur, steps[i]!, path);
  return { parent: cur, last: steps[steps.length - 1]! };
}

/** Apply patch ops to a plain (unfrozen) JSON object, in order. Mutates. */
export function applyPatchOps(root: Record<string, unknown>, ops: readonly PatchOp[]): void {
  for (const op of ops) {
    if (op.op === "merge") {
      // Merging into an optional object that was never written (a path's
      // `material` before it has one) creates it — like `insert` creates an
      // optional list. A typo'd key is still refused after validation.
      const steps = op.path ? parsePath(op.path) : [];
      let target: unknown = root;
      steps.forEach((s, i) => {
        const last = i === steps.length - 1;
        if (last && "key" in s && isContainer(target) && !Array.isArray(target) && !(s.key in target)) (target as Record<string, unknown>)[s.key] = {};
        target = stepInto(target, s, op.path);
      });
      if (!isContainer(target) || Array.isArray(target)) throw new ApiError(`"${op.path}" is not an object; merge needs one.`);
      Object.assign(target, op.value);
      continue;
    }
    // `set list[-]` is an append too — one path, one meaning, missing list or not.
    if (op.op === "insert" || (op.op === "set" && /\[\s*-\s*\]$/.test(op.path))) {
      // An optional list that was never written (a layer's `modulators`) is an
      // empty list, not a missing field — create it. A typo'd key is caught by
      // `refuseDroppedKeys` after validation, so this cannot invent fields.
      // `effects[-]` names the END of the list, which is where an insert with
      // no index goes anyway — the same path `set` accepts, so read it as the
      // list itself rather than refusing the spelling every agent reaches for.
      const steps = parsePath(op.path);
      const appendStep = steps.length > 1 && "append" in steps[steps.length - 1]!;
      if (appendStep) steps.pop();
      if (!steps.length) throw new ApiError("Empty path.");
      let parent: unknown = root;
      for (let i = 0; i < steps.length - 1; i++) parent = stepInto(parent, steps[i]!, op.path);
      const last = steps[steps.length - 1]!;
      if (isContainer(parent) && !Array.isArray(parent) && "key" in last && (parent as Record<string, unknown>)[last.key] === undefined) {
        (parent as Record<string, unknown>)[last.key] = [];
      }
      const arr = stepInto(parent, last, op.path);
      if (!Array.isArray(arr)) throw new ApiError(`"${op.path}" is not a list; insert needs one.`);
      const index = op.op === "insert" ? op.index : undefined;
      const at = index === undefined || appendStep ? arr.length : Math.max(0, Math.min(arr.length, index));
      arr.splice(at, 0, op.value);
      continue;
    }
    const { parent, last } = parentOf(root, op.path);
    if (op.op === "move") {
      if (!Array.isArray(parent)) throw new ApiError(`"${op.path}" is not an element of a list.`);
      const from = resolveIndex(parent, last, op.path);
      const [item] = parent.splice(from, 1);
      parent.splice(Math.max(0, Math.min(parent.length, op.to)), 0, item);
      continue;
    }
    if (Array.isArray(parent)) {
      if ("append" in last) {
        if (op.op === "remove") throw new ApiError(`Cannot remove "[-]".`);
        parent.push(op.value);
        continue;
      }
      const i = resolveIndex(parent, last, op.path);
      if (i < 0 || i >= parent.length) throw new ApiError(`Index out of range in "${op.path}" (length ${parent.length}).`);
      if (op.op === "remove") parent.splice(i, 1);
      else parent[i] = op.value;
      continue;
    }
    if (!isContainer(parent) || !("key" in last)) throw new ApiError(`Cannot write "${op.path}".`);
    if (op.op === "remove") delete (parent as Record<string, unknown>)[last.key];
    else (parent as Record<string, unknown>)[last.key] = op.value;
  }
}

/**
 * Validation strips keys a schema does not know, so a patch that writes one
 * would "succeed" and change nothing — `{type:"glow", values:{size:22}}` (the
 * effects.add shape) stored a default glow without a word. Compare what the
 * ops touched with what survived validation and refuse anything dropped, by
 * path, listing the fields that do exist there. Only touched subtrees are
 * checked, so legacy data elsewhere in the layer never trips it.
 */
export function refuseDroppedKeys(raw: Record<string, unknown>, parsed: unknown, ops: readonly PatchOp[]): void {
  const kept = (isContainer(parsed) && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
  const roots = new Set(rootKeysOf(ops).flatMap((k) => k.split(",")).filter(Boolean));
  // A ROOT key the schema does not know vanished whole — the old walk only
  // looked inside keys that survived, so `materal` was accepted and ignored.
  const dropped = [...roots]
    .flatMap((key) => (raw[key] === undefined ? [] : key in kept ? droppedKeys(raw[key], kept[key], key) : [{ path: key, known: Object.keys(kept) }]))
    .slice(0, 4);
  if (dropped.length) {
    const first = dropped[0]!;
    const leaf = first.path.split(/[.[]/).pop()!.replace(/]$/, "");
    const near = nearest(leaf, first.known);
    throw new ApiError(
      `Unknown field${dropped.length > 1 ? "s" : ""} ${dropped.map((d) => `"${d.path}"`).join(", ")} — nothing was saved.${near ? ` Did you mean "${near}"?` : ""}`,
      `Fields there: ${first.known.join(", ")}. Effect and paint fields are flat on the card (not under "values").`,
    );
  }
}

/** The top-level keys a patch touches — for refusing ones owned by a verb. */
export function rootKeysOf(ops: readonly PatchOp[]): string[] {
  return ops.map((op) => {
    const first = parsePath(op.path)[0];
    return first && "key" in first ? first.key : op.op === "merge" && !op.path ? Object.keys(op.value).join(",") : "";
  });
}

/** zod issues as one readable line per problem. */
export function formatIssues(error: z.ZodError, prefix = ""): string {
  return error.issues
    .slice(0, 6)
    .map((i) => `${prefix}${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
