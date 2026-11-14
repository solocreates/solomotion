import { identity } from "@/editor/identity";
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { hoverTooltip, type Tooltip } from "@codemirror/view";
import { scriptCallable, scriptHere, scriptSignature, visibleFrames, type MotionDocument, type CommandRegistry, type JsonSchema, type ScriptHere } from "@solomotion/core";

/**
 * WHAT THE EDITOR KNOWS — completions and hovers read from the live registry
 * and the open document, never from a list kept beside them.
 *
 *  • `ac.` and `ac.layer.` → namespaces and verbs, each with its summary.
 *  • inside `ac.layer.create({ │ })` → that verb's input keys, typed.
 *  • inside a string → the key's enum (`kind: "│"`), else the project's
 *    layers, comps and media by NAME, inserting the id.
 *
 * Loaded only with the editor chunk.
 */

export interface CompletionDeps {
  registry: () => CommandRegistry;
  doc: () => MotionDocument | null;
  /** The focused comp — what `here` will be when Run is pressed. */
  focus: () => string | null;
}

const HERE_FIELDS = ["frameId", "name", "width", "height", "fps", "durationMs"] as const satisfies ReadonlyArray<keyof ScriptHere>;

type Props = Record<string, JsonSchema>;

/** A verb's input keys, union arms merged — the same flattening tool specs use. */
function inputProps(registry: CommandRegistry, id: string): Props {
  const spec = registry.toolSpecs((d) => d.id === id)[0];
  return ((spec?.inputSchema.properties ?? {}) as Props) ?? {};
}

function typeOf(p: JsonSchema): string {
  if (Array.isArray(p.enum)) return (p.enum as unknown[]).map((v) => JSON.stringify(v)).slice(0, 6).join(" | ");
  if (typeof p.type === "string") return p.type;
  if (Array.isArray(p.anyOf)) return (p.anyOf as JsonSchema[]).map(typeOf).join(" | ");
  return "";
}

/**
 * The innermost `ac.<id>({` whose object the cursor sits in, top level only,
 * and the key being typed if the cursor is inside a string value. A small
 * scanner rather than the syntax tree: mid-typing the code is rarely valid,
 * and this has to answer anyway.
 */
function callAt(text: string): { id: string; key: string | null; inString: boolean } | null {
  let depth = 0;
  let inString: string | null = null;
  let stringKeyStart = -1;
  // Forward pass to know whether the cursor is inside a string.
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === inString) inString = null;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      stringKeyStart = i;
    }
  }
  const head = inString ? text.slice(0, stringKeyStart) : text;
  for (let i = head.length - 1; i >= 0; i--) {
    const ch = head[i]!;
    if (ch === "}" || ch === ")" || ch === "]") depth++;
    else if (ch === "{" || ch === "(" || ch === "[") {
      if (depth > 0) {
        depth--;
        continue;
      }
      if (ch !== "{") return null;
      const m = /\bac\.([\w.]+)\(\s*$/.exec(head.slice(0, i));
      if (!m) return null;
      const key = inString ? (/([\w$]+)\s*:\s*\[?\s*$/.exec(head)?.[1] ?? null) : null;
      return { id: m[1]!, key, inString: !!inString };
    }
  }
  return null;
}

function entityOptions(doc: MotionDocument): Completion[] {
  const out: Completion[] = [];
  for (const f of visibleFrames(doc)) out.push({ label: f.name, apply: f.id, detail: `comp · ${f.width}×${f.height}`, type: "class", boost: 2 });
  for (const t of doc.tracks) for (const c of t.clips) out.push({ label: c.name || c.id, apply: c.id, detail: `${c.kind} layer`, type: "variable", boost: 1 });
  for (const a of doc.assets) out.push({ label: a.name, apply: a.id, detail: `${a.kind} · media`, type: "constant" });
  return out;
}

export function acCompletions(deps: CompletionDeps) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const before = ctx.state.sliceDoc(Math.max(0, ctx.pos - 4000), ctx.pos);
    const registry = deps.registry();

    // here.<field> — the comp this run lands in
    const hereField = /\bhere\.([\w$]*)$/.exec(before);
    if (hereField) {
      const doc = deps.doc();
      const here = doc ? scriptHere(doc, deps.focus()) : null;
      return {
        from: ctx.pos - hereField[1]!.length,
        options: HERE_FIELDS.map((f) => ({ label: f, type: "property", detail: here ? String(here[f]) : undefined })),
        validFor: /^[\w$]*$/,
      };
    }

    // ac.<ns>.<verb>
    const member = /\bac((?:\.[\w$]+)*)\.([\w$]*)$/.exec(before);
    if (member) {
      const prefix = member[1]!.slice(1);
      const from = ctx.pos - member[2]!.length;
      const seen = new Map<string, Completion>();
      for (const def of registry.list().filter(scriptCallable)) {
        if (prefix && !def.id.startsWith(`${prefix}.`)) continue;
        const rest = prefix ? def.id.slice(prefix.length + 1) : def.id;
        const [head, ...tail] = rest.split(".");
        if (!head || seen.has(head)) continue;
        seen.set(
          head,
          tail.length
            ? { label: head, type: "namespace" }
            : { label: head, type: def.effect === "read" ? "method" : "function", detail: def.effect === "read" ? "read" : undefined, info: () => infoNode(def.summary, scriptSignature(def, 2)), apply: `${head}()`, boost: def.effect === "read" ? 0 : 1 },
        );
      }
      if (!prefix) {
        seen.set("help", { label: "help", type: "function", detail: "docs", apply: "help()" });
        seen.set("call", { label: "call", type: "function", detail: "(id, input)", apply: "call()" });
      }
      return { from, options: [...seen.values()], validFor: /^[\w$]*$/ };
    }

    const call = callAt(before);
    if (call) {
      const props = inputProps(registry, call.id);
      if (call.inString) {
        const word = /[^"'`]*$/.exec(before)![0];
        const from = ctx.pos - word.length;
        const prop = call.key ? props[call.key] : undefined;
        const items = prop?.items as JsonSchema | undefined;
        const enumValues = (prop?.enum ?? items?.enum) as unknown[] | undefined;
        if (enumValues) return { from, options: enumValues.map((v) => ({ label: String(v), type: "enum" })) };
        const doc = deps.doc();
        return doc ? { from, options: entityOptions(doc), validFor: /^[^"'`]*$/ } : null;
      }
      const key = ctx.matchBefore(/[\w$]*$/);
      if (!key) return null;
      // A key position: what precedes the word is `{` or `,`, across line breaks.
      if (!/[{,]$/.test(before.slice(0, before.length - (ctx.pos - key.from)).trimEnd())) return null;
      return {
        from: key.from,
        options: Object.entries(props).map(([name, p]) => ({
          label: name,
          type: "property",
          detail: typeOf(p),
          info: typeof p.description === "string" ? p.description : undefined,
          apply: `${name}: `,
        })),
        validFor: /^[\w$]*$/,
      };
    }

    const word = ctx.matchBefore(/[\w$]+/);
    if (!word || (word.from === word.to && !ctx.explicit)) return null;
    return {
      from: word.from,
      options: [
        { label: "ac", type: "variable", detail: `${identity.name} API`, boost: 3 },
        { label: "console", type: "variable" },
        { label: "here", type: "variable", detail: "the comp this run lands in", boost: 2 },
      ],
      validFor: /^[\w$]*$/,
    };
  };
}

function infoNode(summary: string, signature: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "cm-ac-info";
  const p = document.createElement("p");
  p.textContent = summary;
  const pre = document.createElement("pre");
  pre.textContent = signature;
  el.append(p, pre);
  return el;
}

/** Hover a verb (`ac.layer.create`) for its summary and full input shape. */
export function acHover(deps: CompletionDeps) {
  return hoverTooltip((view, pos): Tooltip | null => {
    const line = view.state.doc.lineAt(pos);
    const re = /\bac\.([\w.]+)/g;
    for (let m = re.exec(line.text); m; m = re.exec(line.text)) {
      const start = line.from + m.index;
      const end = start + m[0].length;
      if (pos < start || pos > end) continue;
      const def = deps.registry().get(m[1]!);
      if (!def) return null;
      return { pos: start, end, above: true, create: () => ({ dom: infoNode(def.summary, scriptSignature(def, 2)) }) };
    }
    return null;
  });
}
