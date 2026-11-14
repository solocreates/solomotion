import { z } from "zod";

/**
 * READING A SCHEMA AS DATA — the reflection half of the command API.
 *
 * The document is zod-validated end to end, which means its schemas already are
 * the most complete, most current description of what every layer can hold.
 * Anything written by hand beside them (a reference page, a tool description, a
 * skill paragraph) is a copy that starts drifting the day it is written. So the
 * API describes itself FROM the schemas: a command's input becomes the JSON
 * Schema a model provider wants, and any document type becomes a compact
 * signature an agent can read without us explaining it.
 *
 * Deliberately a small walker over zod's own definitions rather than a
 * dependency: we need exactly two projections, both depth-limited so a 30-arm
 * effect union cannot explode a tool list, and neither needs the long tail of
 * zod features this codebase does not use.
 */

type AnyZod = z.ZodTypeAny;

/** The def's type name, typed loosely: zod's first-party kinds are all we switch on. */
function kindOf(schema: AnyZod): string {
  return (schema._def as { typeName?: string }).typeName ?? "";
}

/** Peel wrappers that do not change the value's shape. */
export function unwrap(schema: AnyZod): { inner: AnyZod; optional: boolean; nullable: boolean; defaultValue?: unknown } {
  let inner = schema;
  let optional = false;
  let nullable = false;
  let defaultValue: unknown;
  for (let guard = 0; guard < 16; guard++) {
    const k = kindOf(inner);
    if (k === "ZodOptional") {
      optional = true;
      inner = (inner as z.ZodOptional<AnyZod>).unwrap();
    } else if (k === "ZodNullable") {
      nullable = true;
      inner = (inner as z.ZodNullable<AnyZod>).unwrap();
    } else if (k === "ZodDefault") {
      optional = true;
      const def = (inner as z.ZodDefault<AnyZod>)._def;
      try {
        defaultValue = def.defaultValue();
      } catch {
        defaultValue = undefined;
      }
      inner = def.innerType;
    } else if (k === "ZodEffects") {
      inner = (inner as z.ZodEffects<AnyZod>).innerType();
    } else if (k === "ZodBranded") {
      inner = (inner as z.ZodBranded<AnyZod, string>).unwrap();
    } else if (k === "ZodReadonly") {
      inner = (inner._def as { innerType: AnyZod }).innerType;
    } else if (k === "ZodCatch") {
      inner = (inner._def as { innerType: AnyZod }).innerType;
    } else if (k === "ZodPipeline") {
      inner = (inner._def as { in: AnyZod }).in;
    } else if (k === "ZodLazy") {
      inner = (inner as z.ZodLazy<AnyZod>).schema;
    } else break;
  }
  return { inner, optional, nullable, defaultValue };
}

// ── JSON Schema (tool inputs) ────────────────────────────────────────────────

export type JsonSchema = { [key: string]: unknown };

/**
 * A command's input as JSON Schema (draft 2020-12 subset every provider
 * accepts). Object properties that carry a default or are optional are left
 * out of `required`, which is how the model learns what it may omit.
 */
export function toJsonSchema(schema: AnyZod, maxDepth = 12): JsonSchema {
  return walkJson(schema, maxDepth);
}

function withDescription(out: JsonSchema, schema: AnyZod): JsonSchema {
  if (schema.description && out.description === undefined) out.description = schema.description;
  return out;
}

function walkJson(schema: AnyZod, depth: number): JsonSchema {
  const described = schema.description;
  const { inner, nullable, defaultValue } = unwrap(schema);
  let out = depth <= 0 ? {} : jsonOf(inner, depth);
  if (nullable) out = { anyOf: [out, { type: "null" }] };
  if (defaultValue !== undefined && isJsonable(defaultValue)) out.default = defaultValue;
  if (described) out.description = described;
  return withDescription(out, inner);
}

function isJsonable(v: unknown): boolean {
  try {
    return JSON.stringify(v).length < 400;
  } catch {
    return false;
  }
}

function jsonOf(schema: AnyZod, depth: number): JsonSchema {
  const def = schema._def as Record<string, unknown>;
  switch (kindOf(schema)) {
    case "ZodString": {
      const out: JsonSchema = { type: "string" };
      for (const check of (def.checks as Array<{ kind: string; value?: number }>) ?? []) {
        if (check.kind === "min") out.minLength = check.value;
        if (check.kind === "max") out.maxLength = check.value;
      }
      return out;
    }
    case "ZodNumber": {
      const out: JsonSchema = { type: "number" };
      for (const check of (def.checks as Array<{ kind: string; value?: number; inclusive?: boolean }>) ?? []) {
        if (check.kind === "int") out.type = "integer";
        if (check.kind === "min") out[check.inclusive ? "minimum" : "exclusiveMinimum"] = check.value;
        if (check.kind === "max") out[check.inclusive ? "maximum" : "exclusiveMaximum"] = check.value;
      }
      return out;
    }
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodLiteral":
      return { const: def.value };
    case "ZodEnum":
      return { type: "string", enum: [...(def.values as string[])] };
    case "ZodNativeEnum":
      return { enum: Object.values(def.values as Record<string, unknown>) };
    case "ZodArray": {
      const out: JsonSchema = { type: "array", items: walkJson(def.type as AnyZod, depth - 1) };
      if (def.minLength) out.minItems = (def.minLength as { value: number }).value;
      if (def.maxLength) out.maxItems = (def.maxLength as { value: number }).value;
      return out;
    }
    case "ZodTuple":
      return {
        type: "array",
        prefixItems: (def.items as AnyZod[]).map((i) => walkJson(i, depth - 1)),
        minItems: (def.items as AnyZod[]).length,
        maxItems: (def.items as AnyZod[]).length,
      };
    case "ZodObject": {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const properties: JsonSchema = {};
      const required: string[] = [];
      for (const [key, field] of Object.entries(shape)) {
        properties[key] = walkJson(field, depth - 1);
        if (!unwrap(field).optional) required.push(key);
      }
      const out: JsonSchema = { type: "object", properties };
      if (required.length) out.required = required;
      const catchall = def.catchall as AnyZod | undefined;
      if (def.unknownKeys === "passthrough" || (catchall && kindOf(catchall) !== "ZodNever")) {
        out.additionalProperties = catchall && kindOf(catchall) !== "ZodNever" ? walkJson(catchall, depth - 1) : true;
      }
      return out;
    }
    case "ZodRecord":
      return { type: "object", additionalProperties: walkJson(def.valueType as AnyZod, depth - 1) };
    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const options = [...((def.options as AnyZod[] | Map<unknown, AnyZod>) instanceof Map
        ? (def.options as Map<unknown, AnyZod>).values()
        : (def.options as AnyZod[]))];
      return { anyOf: options.map((o) => walkJson(o, depth - 1)) };
    }
    case "ZodIntersection": {
      return { allOf: [walkJson(def.left as AnyZod, depth - 1), walkJson(def.right as AnyZod, depth - 1)] };
    }
    default:
      // any / unknown / lazy past the depth limit: an open slot, which is the
      // honest description of "we are not going to spell this out here".
      return {};
  }
}

// ── Signatures (reading the document) ────────────────────────────────────────

export interface SignatureOptions {
  /** How many levels of nested objects to expand before writing `{…}`. */
  depth?: number;
  /** Cap on union arms listed before `| …N more`. */
  maxArms?: number;
}

/**
 * A schema as a compact TypeScript-flavoured signature — the cheapest text a
 * model can read to learn a shape. Optional fields end in `?`, defaults show as
 * `= value`, ranges as `(min..max)`, and anything deeper than `depth` collapses
 * to `{…}` with a path the caller can pass back to drill in.
 */
export function schemaSignature(schema: AnyZod, options: SignatureOptions = {}): string {
  return sig(schema, options.depth ?? 2, options.maxArms ?? 8, "");
}

function rangeOf(schema: AnyZod): string {
  if (kindOf(schema) !== "ZodNumber") return "";
  let lo: number | undefined;
  let hi: number | undefined;
  let int = false;
  for (const check of (schema._def.checks as Array<{ kind: string; value?: number }>) ?? []) {
    if (check.kind === "min") lo = check.value;
    if (check.kind === "max") hi = check.value;
    if (check.kind === "int") int = true;
  }
  const r = lo !== undefined || hi !== undefined ? ` (${lo ?? ""}..${hi ?? ""})` : "";
  return (int ? " int" : "") + r;
}

function sig(schema: AnyZod, depth: number, maxArms: number, indent: string): string {
  const { inner, nullable } = unwrap(schema);
  const body = sigInner(inner, depth, maxArms, indent);
  return nullable ? `${body} | null` : body;
}

function sigInner(schema: AnyZod, depth: number, maxArms: number, indent: string): string {
  const def = schema._def as Record<string, unknown>;
  switch (kindOf(schema)) {
    case "ZodString":
      return "string";
    case "ZodNumber":
      return "number" + rangeOf(schema);
    case "ZodBoolean":
      return "boolean";
    case "ZodLiteral":
      return JSON.stringify(def.value);
    case "ZodEnum":
      return (def.values as string[]).map((v) => JSON.stringify(v)).join(" | ");
    case "ZodArray": {
      const item = sig(def.type as AnyZod, depth, maxArms, indent);
      return /[|&]/.test(item) && !item.startsWith("{") ? `Array<${item}>` : `${item}[]`;
    }
    case "ZodTuple":
      return `[${(def.items as AnyZod[]).map((i) => sig(i, depth, maxArms, indent)).join(", ")}]`;
    case "ZodRecord":
      return `Record<string, ${sig(def.valueType as AnyZod, depth, maxArms, indent)}>`;
    case "ZodObject": {
      if (depth <= 0) return "{…}";
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const next = indent + "  ";
      const lines = Object.entries(shape).map(([key, field]) => {
        const { optional, defaultValue } = unwrap(field);
        const dflt =
          defaultValue !== undefined && isJsonable(defaultValue) && JSON.stringify(defaultValue).length <= 40
            ? ` = ${JSON.stringify(defaultValue)}`
            : "";
        const doc = field.description ? `  // ${field.description}` : "";
        return `${next}${key}${optional ? "?" : ""}: ${sig(field, depth - 1, maxArms, next)}${dflt}${doc}`;
      });
      return lines.length ? `{\n${lines.join("\n")}\n${indent}}` : "{}";
    }
    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const options = [...((def.options as AnyZod[] | Map<unknown, AnyZod>) instanceof Map
        ? (def.options as Map<unknown, AnyZod>).values()
        : (def.options as AnyZod[]))];
      const disc = def.discriminator as string | undefined;
      // A tagged union too deep to expand is named by its tags — which is
      // exactly what a caller needs to drill into the one arm it wants.
      if (disc && depth <= 0) {
        const tags = options.map((o) => JSON.stringify(literalOf(o, disc)));
        return `{ ${disc}: ${clampArms(tags, maxArms).join(" | ")}, … }`;
      }
      const arms = options.map((o) => sig(o, depth, maxArms, indent));
      return clampArms(arms, maxArms).join(" | ");
    }
    case "ZodIntersection":
      return `${sig(def.left as AnyZod, depth, maxArms, indent)} & ${sig(def.right as AnyZod, depth, maxArms, indent)}`;
    case "ZodAny":
    case "ZodUnknown":
      return "unknown";
    default:
      return "unknown";
  }
}

function clampArms(arms: string[], max: number): string[] {
  return arms.length > max ? [...arms.slice(0, max), `…${arms.length - max} more`] : arms;
}

function literalOf(schema: AnyZod, key: string): unknown {
  const { inner } = unwrap(schema);
  if (kindOf(inner) !== "ZodObject") return "?";
  const field = (inner as z.ZodObject<z.ZodRawShape>).shape[key];
  return field ? (unwrap(field).inner._def as { value?: unknown }).value : "?";
}

// ── Navigation ───────────────────────────────────────────────────────────────

/**
 * The sub-schema at a dotted path — `style.highlight`, `effects[]`,
 * `effects[type=glass]`, `fills[].gradient`. `[]` steps into an array's item;
 * `[key=value]` picks one arm of a tagged union. Returns null when the path
 * does not exist, which the describe command reports with the keys that do.
 */
export function schemaAt(schema: AnyZod, path: string): AnyZod | null {
  let cur: AnyZod = schema;
  const steps = path.match(/[^.[\]]+|\[[^\]]*\]/g) ?? [];
  for (const step of steps) {
    const { inner } = unwrap(cur);
    if (step === "[]") {
      if (kindOf(inner) !== "ZodArray") return null;
      cur = (inner._def as { type: AnyZod }).type;
      continue;
    }
    const pick = /^\[(\w+)=([^\]]+)\]$/.exec(step);
    if (pick) {
      const arm = armOf(inner, pick[1]!, pick[2]!);
      if (!arm) return null;
      cur = arm;
      continue;
    }
    if (kindOf(inner) === "ZodRecord") {
      cur = (inner._def as { valueType: AnyZod }).valueType;
      continue;
    }
    if (kindOf(inner) === "ZodArray" && /^\d+$/.test(step)) {
      cur = (inner._def as { type: AnyZod }).type;
      continue;
    }
    if (kindOf(inner) !== "ZodObject") return null;
    const field = (inner as z.ZodObject<z.ZodRawShape>).shape[step];
    if (!field) return null;
    cur = field;
  }
  return cur;
}

function armOf(schema: AnyZod, key: string, value: string): AnyZod | null {
  const { inner } = unwrap(schema);
  const k = kindOf(inner);
  // Stepping into an array's union is the common case (`effects[type=glass]`).
  const target = k === "ZodArray" ? unwrap((inner._def as { type: AnyZod }).type).inner : inner;
  const tk = kindOf(target);
  if (tk !== "ZodUnion" && tk !== "ZodDiscriminatedUnion") return null;
  const def = target._def as { options: AnyZod[] | Map<unknown, AnyZod> };
  const options = [...(def.options instanceof Map ? def.options.values() : def.options)];
  return options.find((o) => String(literalOf(o, key)) === value) ?? null;
}

/** The keys an object schema offers at a path — for "did you mean" errors. */
export function keysAt(schema: AnyZod): string[] {
  const { inner } = unwrap(schema);
  return kindOf(inner) === "ZodObject" ? Object.keys((inner as z.ZodObject<z.ZodRawShape>).shape) : [];
}

// ── Ids ──────────────────────────────────────────────────────────────────────

/**
 * Give every object the schema says must carry an `id` one, where the value
 * lacks it — so a caller inserting a fill, a gradient stop or an effect never
 * has to invent identifiers. The prefix comes from the field holding the list
 * (`fills` → `fill_…`), which is cosmetic: ids are opaque everywhere.
 * Mutates `value`.
 */
export function fillMissingIds(
  schema: AnyZod,
  value: unknown,
  mint: (prefix: string) => string,
  hint = "item",
  depth = 0,
  /** False leaves the outermost object's own `id` alone — a command input's `id` names an existing thing. */
  mintRoot = true,
): void {
  if (depth > 24 || value === null || typeof value !== "object") return;
  const { inner } = unwrap(schema);
  const k = kindOf(inner);
  if (k === "ZodArray") {
    const item = (inner._def as { type: AnyZod }).type;
    for (const v of value as unknown[]) fillMissingIds(item, v, mint, hint.replace(/s$/, ""), depth + 1);
    return;
  }
  if (k === "ZodUnion" || k === "ZodDiscriminatedUnion") {
    const def = inner._def as { options: AnyZod[] | Map<unknown, AnyZod>; discriminator?: string };
    const options = [...(def.options instanceof Map ? def.options.values() : def.options)];
    const tag = def.discriminator ? (value as Record<string, unknown>)[def.discriminator] : undefined;
    const arm = (tag !== undefined && options.find((o) => String(literalOf(o, def.discriminator!)) === String(tag))) || options.find((o) => kindOf(unwrap(o).inner) === "ZodObject");
    if (arm) fillMissingIds(arm, value, mint, hint, depth + 1, mintRoot);
    return;
  }
  if (k === "ZodRecord") {
    const item = (inner._def as { valueType: AnyZod }).valueType;
    for (const v of Object.values(value as Record<string, unknown>)) fillMissingIds(item, v, mint, hint, depth + 1);
    return;
  }
  if (k !== "ZodObject" || Array.isArray(value)) return;
  const shape = (inner as z.ZodObject<z.ZodRawShape>).shape;
  const rec = value as Record<string, unknown>;
  const idField = shape.id;
  if (mintRoot && idField && kindOf(unwrap(idField).inner) === "ZodString" && !unwrap(idField).optional && (rec.id === undefined || rec.id === "")) {
    rec.id = mint(hint);
  }
  for (const [key, field] of Object.entries(shape)) {
    if (key in rec) fillMissingIds(field, rec[key], mint, key, depth + 1);
  }
}
