import type { z } from "zod";
import { describeDropped, droppedKeys, schemaKeysAt } from "./unknown-keys";
import {
  ApiError,
  type CommandContext,
  type CommandDef,
  type CommandEffect,
  type CommandResult,
  type CommandRuntime,
} from "./command";
import { fillMissingIds, toJsonSchema, type JsonSchema } from "./zod-reflect";
import { createId } from "../ids";
import type { MotionDocument } from "../schema";
import { locateClip } from "../timeline/ops";

/**
 * THE COMMAND REGISTRY — the set of verbs the app answers to.
 *
 * Core registers the document verbs; the web host registers the verbs only it
 * can perform (render, select, import) into the same instance. Every consumer
 * reads the one list: the agent turns it into tools, the plugin bridge into
 * gated methods, a docs generator into a reference. Adding a verb is one
 * `register()`, never a new switch in each consumer.
 */

// The registry holds commands of every input type; `run` is only ever called
// with input its own schema produced, so the erased signature is sound.
export type AnyCommand = CommandDef<z.ZodTypeAny, unknown>;

export interface ToolSpec {
  /** Provider-safe name (`^[a-zA-Z0-9_-]{1,64}$`): the id with dots as `_`. */
  name: string;
  commandId: string;
  description: string;
  effect: CommandEffect;
  inputSchema: JsonSchema;
}

/** Provider tool names forbid dots; ids keep them because they read better. */
export function toolNameOf(commandId: string): string {
  return commandId.replace(/\./g, "_");
}

export class CommandRegistry {
  private readonly commands = new Map<string, AnyCommand>();
  private readonly listeners = new Set<() => void>();

  register(...defs: AnyCommand[]): this {
    for (const def of defs) {
      if (this.commands.has(def.id)) throw new Error(`Command "${def.id}" is already registered.`);
      this.commands.set(def.id, def);
    }
    this.emit();
    return this;
  }

  /** Replace-or-add — for hosts that re-register on hot reload. */
  upsert(...defs: AnyCommand[]): this {
    for (const def of defs) this.commands.set(def.id, def);
    this.emit();
    return this;
  }

  unregister(id: string): void {
    if (this.commands.delete(id)) this.emit();
  }

  get(id: string): AnyCommand | undefined {
    return this.commands.get(id) ?? this.commands.get(id.replace(/_/g, "."));
  }

  list(): AnyCommand[] {
    return [...this.commands.values()];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  /** Every command as a provider tool definition. */
  toolSpecs(filter?: (def: AnyCommand) => boolean): ToolSpec[] {
    return this.list()
      .filter((d) => !filter || filter(d))
      .map((d) => ({
        name: toolNameOf(d.id),
        commandId: d.id,
        description: d.details ? `${d.summary}\n\n${d.details}` : d.summary,
        effect: d.effect,
        inputSchema: objectSchema(toJsonSchema(d.input, TOOL_SCHEMA_DEPTH)),
      }));
  }

  /**
   * Validate and run one command. Never throws: a caller — especially a model
   * — needs a result it can read and correct from, so input problems come
   * back as `input` errors naming the offending field, and a caller-fixable
   * refusal as an `api` error with a hint.
   */
  async call(id: string, raw: unknown, ctx: CommandContext): Promise<CommandResult> {
    const def = this.get(id);
    if (!def) {
      const near = this.list()
        .map((d) => d.id)
        .filter((c) => c.split(".")[0] === id.replace(/_/g, ".").split(".")[0]);
      return {
        ok: false,
        kind: "input",
        error: `Unknown command "${id}".`,
        hint: near.length ? `Did you mean one of: ${near.join(", ")}?` : "Call api.commands to list what exists.",
      };
    }
    const unset = unsetAddress(raw);
    if (unset) {
      return {
        ok: false,
        kind: "input",
        error: `${unset} is undefined. Left out, it means the focused or selected one; passed as undefined it is almost always a value that did not exist.`,
        hint: "Nothing was changed. Check the field the call that made it returned (frame.create gives `id`, world.create `frameId`), or leave the key out to mean the focused one.",
      };
    }
    // New things inside an input — a text effect, a paint, a stop — need no
    // invented ids: they are minted here for every verb, as layer.patch does.
    // The input's own top-level `id` is a reference and is never minted.
    const input = raw && typeof raw === "object" ? structuredClone(raw) : raw;
    fillMissingIds(def.input, input, (prefix) => createId(prefix), "item", 0, false);
    const parsed = def.input.safeParse(input ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        kind: "input",
        error: parsed.error.issues
          .slice(0, 6)
          .map((i) => `${i.path.length ? i.path.join(".") : "(input)"}: ${i.message}`)
          .join("; "),
        hint: "Fix the named fields and call again. api.describe shows any type in full.",
      };
    }
    // A field the schema does not have was silently stripped; say so instead of acting without it.
    const dropped = droppedKeys(raw ?? {}, parsed.data).map((d) => {
      const declared = schemaKeysAt(def.input, d.path, raw);
      return declared.length ? { ...d, known: declared } : d;
    });
    if (dropped.length) {
      return {
        ok: false,
        kind: "input",
        error: describeDropped(dropped),
        hint: "Nothing was changed. Rename or remove those fields (api.describe shows the exact shape) and call again.",
      };
    }
    try {
      const rt = runtimeFor(ctx);
      const value = await def.run(resolveLayerNames(parsed.data, rt.doc()), rt);
      return { ok: true, value: value ?? null };
    } catch (err) {
      if (err instanceof ApiError) return { ok: false, kind: "api", error: err.message, hint: err.hint };
      return { ok: false, kind: "internal", error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * How deep a tool's input schema is spelled out. Past it a slot is left open
 * (`{}`) and the schema is re-checked by zod on the way in anyway — the model
 * reaches for api.describe when it needs the deep shape, instead of every
 * request paying for a 30-arm effect union it will not use.
 */
const TOOL_SCHEMA_DEPTH = 4;

/**
 * Providers require an OBJECT at the top of a tool's input. A command whose
 * input is a tagged union (`layer.create` by kind) is flattened into one object
 * — every arm's fields, the tag as an enum, and a note on which fields belong
 * to which tag — because a top-level `anyOf` is rejected or ignored by most of
 * them. zod still validates the real union on the way in.
 */
function objectSchema(schema: JsonSchema): JsonSchema {
  if (schema.type === "object") return schema;
  const arms = Array.isArray(schema.anyOf) ? (schema.anyOf as JsonSchema[]) : [];
  if (!arms.length || !arms.every((a) => a.type === "object")) return { type: "object", properties: {} };
  const properties: Record<string, JsonSchema> = {};
  const owners: Record<string, string[]> = {};
  let tagKey: string | null = null;
  const tags: unknown[] = [];
  for (const arm of arms) {
    const props = (arm.properties ?? {}) as Record<string, JsonSchema>;
    const tag = Object.entries(props).find(([, p]) => "const" in p);
    if (tag) {
      tagKey = tag[0];
      tags.push(tag[1].const);
    }
    for (const [key, prop] of Object.entries(props)) {
      if (key === tagKey) continue;
      properties[key] ??= prop;
      (owners[key] ??= []).push(String(tag?.[1].const ?? "?"));
    }
  }
  if (tagKey) properties[tagKey] = { type: "string", enum: tags };
  for (const [key, who] of Object.entries(owners)) {
    if (who.length < arms.length) {
      const prop = properties[key]!;
      properties[key] = { ...prop, description: `${prop.description ? `${prop.description} ` : ""}(${tagKey}: ${who.join("|")})` };
    }
  }
  return { type: "object", properties, ...(tagKey ? { required: [tagKey] } : {}) };
}

/**
 * The keys that ADDRESS what a command acts on. Each one, left out, falls back
 * to the focused comp or the selection — so a key that is present but
 * `undefined` (a script reading `made.id` off a result that calls it
 * `frameId`) silently edited whatever was in focus. Over JSON such a key
 * vanishes on the way; in-process, it arrives and is refused.
 */
const ADDRESS_KEYS = ["id", "ids", "frameId", "clipId", "groupId", "pageId", "trackId", "worldId"] as const;

function unsetAddress(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  for (const k of ADDRESS_KEYS) if (Object.prototype.hasOwnProperty.call(raw, k) && (raw as Record<string, unknown>)[k] === undefined) return k;
  return null;
}

export function runtimeFor(ctx: CommandContext): CommandRuntime {
  return {
    ...ctx,
    doc: () => ctx.store.getState(),
    write(label, recipe) {
      const grouped = ctx.historyKey !== undefined;
      return ctx.store.update(
        `${ctx.actor} · ${grouped ? (ctx.historyLabel ?? label) : label}`,
        recipe,
        // A grouped write is an agent session's (chat turn, MCP turn, quick
        // action) — the person's ⌘Z can then step around it (`undoOwn`).
        grouped ? { mergeKey: ctx.historyKey, mergeWindowMs: Infinity, author: "agent" } : undefined,
      );
    },
  };
}

/**
 * Layers are addressable by exact, unique NAME everywhere (requireClip), but a
 * command that validated `ids` and then handed the raw list to a timeline op
 * passed the names through — `layers.group ["Card", "Label"]` failed with "must
 * be visual layers" while the same ids worked. Every `ids` input is a list of
 * layer ids, so they are resolved here, once, for every command — and so is a
 * single `id` (timeline.trim crashed on a name) unless a comp owns that name.
 * An id that names nothing is left as it is for the command's own error.
 */
function resolveLayerNames<T>(input: T, doc: MotionDocument): T {
  const src = input as { id?: unknown; ids?: unknown };
  if (src?.ids === undefined && src?.id === undefined) return input;
  const one = (id: unknown) => {
    if (typeof id !== "string" || locateClip(doc, id)) return id;
    if (doc.frames.some((f) => f.id === id || f.name === id)) return id; // a comp's name is a comp
    const byName = doc.tracks.flatMap((t) => t.clips).filter((c) => c.name === id);
    return byName.length === 1 ? byName[0]!.id : id;
  };
  const out = { ...input } as { id?: unknown; ids?: unknown };
  if (src.ids !== undefined) out.ids = Array.isArray(src.ids) ? src.ids.map(one) : one(src.ids);
  if (src.id !== undefined) out.id = one(src.id);
  return out as T;
}
