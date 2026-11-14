/**
 * THE CODE A REIFIED SCRIPT IS MADE OF — a tiny IR, and the one printer that
 * turns it into JavaScript a person or a model reads.
 *
 * Printers never write strings of code. They emit CALLS (a registry verb and a
 * plain JSON input) whose values may hold two kinds of reference:
 *
 *   Ref   a value the script only knows at run time: `card.id`,
 *         `glow.effectId`, `heroBone.Arm`
 *   Tpl   a string built from refs: `` `lfx.${glow.effectId}.radius` ``
 *
 * Keeping the program as data is what lets the SAME statements be executed
 * in-process (to measure what they make) and printed (to be read), so the two
 * can never disagree.
 */

/** A value the script reads from an earlier result. */
export class Ref {
  constructor(
    readonly binding: Binding,
    readonly path: readonly (string | number)[] = [],
  ) {}
  /** A deeper step: `card.at("fills", 0)` → `card.fills[0]`. */
  at(...steps: (string | number)[]): Ref {
    return new Ref(this.binding, [...this.path, ...steps]);
  }
}

/** A string interpolated from literal parts and refs. */
export class Tpl {
  constructor(readonly parts: readonly (string | Ref)[]) {}
}

/** A `const` the script may declare. Declared only when something reads it. */
export interface Binding {
  name: string;
  used: boolean;
}

export type Stmt =
  | { t: "call"; command: string; input: Record<string, unknown>; bind: Binding; owner?: string }
  /** `const heroBone = Object.fromEntries(hero.bones.map((b) => [b.name, b.id]));` */
  | { t: "names"; bind: Binding; from: Ref }
  | { t: "comment"; text: string }
  | { t: "gap" };

// ── Running the IR (in-process) ──────────────────────────────────────────────

export type Scope = Map<Binding, unknown>;

function step(value: unknown, key: string | number): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string | number, unknown>)[key] : undefined;
}

/** A value with every Ref/Tpl replaced by what it reads in `scope`. */
export function resolveValue(value: unknown, scope: Scope): unknown {
  if (value instanceof Ref) return value.path.reduce<unknown>((v, k) => step(v, k), scope.get(value.binding));
  if (value instanceof Tpl) return value.parts.map((p) => (typeof p === "string" ? p : String(resolveValue(p, scope)))).join("");
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, scope));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveValue(v, scope)]));
  }
  return value;
}

/** `names` statement semantics, shared by the runner and the printer's text. */
export function nameMap(list: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(list)) for (const b of list as Array<{ name?: unknown; id?: unknown }>) if (typeof b?.name === "string") out[b.name] = String(b.id);
  return out;
}

// ── Printing ─────────────────────────────────────────────────────────────────

const IDENT = /^[A-Za-z_$][\w$]*$/;

/**
 * Characters that make code read differently from how it runs — bidi
 * overrides and isolates (the "Trojan source" class) and the line separators.
 * A right-to-left NAME stays as written; only the invisible controls escape.
 */
const INVISIBLE = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C\u2028\u2029]/g;
const hex = (c: string) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;

/** Text safe to put in a `//` comment: no invisible controls, no line breaks. */
export function commentText(s: string): string {
  return s.replace(/\s*[\r\n]+\s*/g, " ").replace(INVISIBLE, hex);
}

/** A string as a literal: double quotes, or single when that saves escaping (`'layer("Title").x'`). */
export function stringLiteral(s: string): string {
  const json = JSON.stringify(s).replace(INVISIBLE, hex);
  if (!s.includes('"') || s.includes("'")) return json;
  return `'${json.slice(1, -1).replace(/\\"/g, '"')}'`;
}

function keyLiteral(k: string): string {
  return IDENT.test(k) ? k : stringLiteral(k);
}

function refText(r: Ref): string {
  r.binding.used = true;
  let out = r.binding.name;
  for (const s of r.path) out += typeof s === "number" ? `[${s}]` : IDENT.test(s) ? `.${s}` : `[${stringLiteral(s)}]`;
  return out;
}

function tplText(t: Tpl): string {
  const body = t.parts
    .map((p) => (typeof p === "string" ? p.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${").replace(INVISIBLE, hex) : `\${${refText(p)}}`))
    .join("");
  return `\`${body}\``;
}

function numberText(n: number): string {
  if (Object.is(n, -0)) return "-0";
  if (!Number.isFinite(n)) return Number.isNaN(n) ? "NaN" : n > 0 ? "Infinity" : "-Infinity";
  return String(n);
}

const WIDTH = 96;

/** A value as JavaScript, inline when it fits on a line, otherwise one entry per line. */
export function valueText(v: unknown, indent = ""): string {
  if (v instanceof Ref) return refText(v);
  if (v instanceof Tpl) return tplText(v);
  if (v === undefined) return "undefined";
  if (v === null || typeof v === "boolean") return String(v);
  if (typeof v === "number") return numberText(v);
  if (typeof v === "string") return stringLiteral(v);
  const inner = `${indent}  `;
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    const items = v.map((x) => valueText(x, inner));
    const flat = `[${items.join(", ")}]`;
    if (flat.length + indent.length <= WIDTH && !flat.includes("\n")) return flat;
    return `[\n${items.map((i) => `${inner}${i},`).join("\n")}\n${indent}]`;
  }
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
  if (!entries.length) return "{}";
  const items = entries.map(([k, x]) => `${keyLiteral(k)}: ${valueText(x, inner)}`);
  const flat = `{ ${items.join(", ")} }`;
  if (flat.length + indent.length <= WIDTH && !flat.includes("\n")) return flat;
  return `{\n${items.map((i) => `${inner}${i},`).join("\n")}\n${indent}}`;
}

/** Mark every binding a statement list reads, so only those are declared. */
function markUsed(value: unknown): void {
  if (value instanceof Ref) value.binding.used = true;
  else if (value instanceof Tpl) value.parts.forEach(markUsed);
  else if (Array.isArray(value)) value.forEach(markUsed);
  else if (value && typeof value === "object") Object.values(value).forEach(markUsed);
}

/** The program as JavaScript, run the way the worker runs a script (`ac`, `here`, top-level await). */
export function printProgram(stmts: readonly Stmt[], header: readonly string[] = []): string {
  for (const s of stmts) if (s.t === "call" || s.t === "names") s.bind.used = false;
  for (const s of stmts) if (s.t === "call") markUsed(s.input);
  // A name map is declared only when something reads it — and only then does it read its source.
  for (const s of stmts) if (s.t === "names" && s.bind.used) markUsed(s.from);
  const lines: string[] = header.map((h) => `// ${commentText(h)}`);
  if (lines.length) lines.push("");
  let lastGap = true;
  for (const s of stmts) {
    if (s.t === "gap") {
      if (!lastGap) lines.push("");
      lastGap = true;
      continue;
    }
    lastGap = false;
    if (s.t === "comment") lines.push(`// ${commentText(s.text)}`);
    else if (s.t === "names") {
      if (s.bind.used) lines.push(`const ${s.bind.name} = Object.fromEntries(${refText(s.from)}.map((b) => [b.name, b.id]));`);
    } else {
      const call = `await ac.${s.command}(${valueText(s.input)});`;
      lines.push(s.bind.used ? `const ${s.bind.name} = ${call}` : call);
    }
  }
  while (lines.at(-1) === "") lines.pop();
  return `${lines.join("\n")}\n`;
}

// ── Names ────────────────────────────────────────────────────────────────────

const RESERVED = new Set(
  (
    "ac console here await break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public arguments eval undefined NaN Infinity Object Math JSON Array String Number Boolean Promise globalThis"
  ).split(" "),
);

/**
 * Readable, unique, deterministic variable names: "Hero card" → `heroCard`,
 * a second "Hero card" → `heroCard2`. A name with no Latin letters in it (an
 * Arabic title, an emoji) falls back to the layer's kind — `text`, `text2`.
 */
export class Namer {
  private readonly taken = new Set<string>(RESERVED);

  name(hint: string, fallback: string): string {
    const base = camel(hint) || camel(fallback) || "value";
    let name = RESERVED.has(base) ? `${base}Layer` : base;
    for (let n = 2; this.taken.has(name); n++) name = `${base}${n}`;
    this.taken.add(name);
    return name;
  }
}

function camel(s: string): string {
  const words = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (!words.length) return "";
  const out = words.map((w, i) => (i === 0 ? w[0]!.toLowerCase() + w.slice(1) : w[0]!.toUpperCase() + w.slice(1))).join("");
  const clipped = out.slice(0, 32);
  return /^[0-9]/.test(clipped) ? `_${clipped}` : clipped;
}
