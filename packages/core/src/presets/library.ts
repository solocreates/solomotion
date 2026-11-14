import { createId } from "../ids";
import { effectPresetKindFor } from "../animation/effect-base";
import type { StoredPreset } from "../schema/presets";

/**
 * THE preset library — one headless brain behind every "save this look and use
 * it again" surface in the app.
 *
 * A preset is a NAMED PATCH over some kind of thing. `kind` is a free-form
 * namespace ("effect:glass", "effect:colorGrade", and — later — "textStyle",
 * "animation", "clipStack"), so a new preset-able concept is a new namespace
 * string plus a UI that already exists, never a new storage/merge/search
 * implementation. That's the whole design: this file owns list/search/create/
 * rename/delete/apply ONCE and knows nothing about effects.
 *
 * Three scopes, one order of precedence when names collide (they may — a
 * project may shadow an app preset deliberately):
 *
 *   builtin  — shipped in code, never editable
 *   app      — this user, every project (host stores it; localStorage on web)
 *   project  — travels inside the project document (`doc.presets`)
 *
 * Scope is DERIVED from where the entry lives, never stored on the entry, so
 * copying a preset between scopes can't leave a stale label behind.
 */

export type PresetScope = "builtin" | "app" | "project";

/** Scope tabs, in the order the picker renders them. */
export const PRESET_SCOPES: ReadonlyArray<{ id: PresetScope; label: string; hint: string }> = [
  { id: "builtin", label: "Built-in", hint: "Ships with the app" },
  { id: "project", label: "This project", hint: "Saved in this document — travels with the file" },
  { id: "app", label: "All projects", hint: "Saved on this device for every project" },
];

/** A preset as the UI consumes it: stored data + the scope it was found in. */
export interface Preset<T = unknown> {
  id: string;
  kind: string;
  name: string;
  scope: PresetScope;
  data: T;
  /** Two-stop swatch [from, to] the picker paints as this preset's chip. */
  chip: [string, string] | null;
  /** Heading inside the picker ("Apple", "Cinematic", …). */
  group: string | null;
  tags: string[];
  createdAt: number;
  /**
   * The frame rate a LOOK holds its layer on — set on the layer's own `fps`
   * when the look is applied (on a frame's effects, that holds the whole
   * frame: see `frameEvalTimeMs`). Built-in only: a stop-motion look is a
   * claim about time as much as about texture, and smooth motion under a
   * re-rolling sheet is the fake it exists to avoid. A saved look is its
   * cards; it never touches time.
   */
  fps?: number;
}

/** One place presets come from. `entries` is the raw stored list for a scope. */
export interface PresetSource {
  scope: PresetScope;
  entries: readonly StoredPreset[];
}

/** Normalize a stored entry into a scoped preset (fills legacy nulls). */
function hydrate(entry: StoredPreset, scope: PresetScope): Preset {
  return {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    scope,
    data: entry.data,
    chip: entry.chip ?? null,
    group: entry.group ?? null,
    tags: entry.tags ?? [],
    createdAt: entry.createdAt ?? 0,
    // Only a built-in carries a rate (see `Preset.fps`); a stored one cannot.
    ...builtinRate(entry, scope),
  };
}

/** A built-in's rate (`Preset.fps`). Stored entries have no such field to read. */
function builtinRate(entry: StoredPreset | Preset, scope: PresetScope): { fps?: number } {
  return scope === "builtin" && "fps" in entry && typeof entry.fps === "number" ? { fps: entry.fps } : {};
}

/**
 * Every preset of `kind` across the given sources, optionally filtered by a
 * free-text query (name, group and tags — the same fuzzy-ish contains match the
 * effect palette uses). Order: source order, then newest-first inside a scope,
 * so a freshly saved preset lands at the top of its tab.
 */
export function collectPresets<T = unknown>(
  sources: readonly PresetSource[],
  kind: string,
  query = "",
): Preset<T>[] {
  const q = query.trim().toLowerCase();
  const out: Preset<T>[] = [];
  for (const src of sources) {
    const hits = src.entries
      .filter((e) => e.kind === kind)
      .map((e) => hydrate(e, src.scope) as Preset<T>)
      .filter((p) => !q || matches(p, q));
    // Builtins keep their authored order (curated); user scopes go newest-first.
    if (src.scope !== "builtin") hits.sort((a, b) => b.createdAt - a.createdAt);
    out.push(...hits);
  }
  return out;
}

function matches(p: Preset, q: string): boolean {
  if (p.name.toLowerCase().includes(q)) return true;
  if (p.group?.toLowerCase().includes(q)) return true;
  return p.tags.some((t) => t.toLowerCase().includes(q));
}

/** Group presets under their `group` heading, preserving first-seen order. */
export function groupPresets<T>(presets: readonly Preset<T>[]): Array<{ group: string | null; items: Preset<T>[] }> {
  const order: Array<string | null> = [];
  const map = new Map<string | null, Preset<T>[]>();
  for (const p of presets) {
    if (!map.has(p.group)) {
      map.set(p.group, []);
      order.push(p.group);
    }
    map.get(p.group)!.push(p);
  }
  return order.map((group) => ({ group, items: map.get(group)! }));
}

/**
 * A new stored preset. `data` is deep-cloned so later edits to the source
 * object can't mutate the saved copy — the classic "my preset changed by
 * itself" bug.
 */
export function makePreset<T>(kind: string, name: string, data: T, meta: Partial<Pick<Preset, "chip" | "group" | "tags">> = {}): StoredPreset {
  return {
    id: createId("pst"),
    kind,
    name: name.trim() || "Untitled preset",
    data: structuredClone(data) as unknown,
    chip: meta.chip ?? null,
    group: meta.group ?? null,
    tags: meta.tags ?? [],
    createdAt: Date.now(),
  };
}

/** Insert (or replace by id) into a stored list — used by both writable scopes. */
export function upsertPreset(list: readonly StoredPreset[], entry: StoredPreset): StoredPreset[] {
  const i = list.findIndex((e) => e.id === entry.id);
  if (i < 0) return [...list, entry];
  const next = list.slice();
  next[i] = entry;
  return next;
}

export function removePreset(list: readonly StoredPreset[], id: string): StoredPreset[] {
  return list.filter((e) => e.id !== id);
}

export function renamePreset(list: readonly StoredPreset[], id: string, name: string): StoredPreset[] {
  return list.map((e) => (e.id === id ? { ...e, name: name.trim() || e.name } : e));
}

/**
 * Apply a preset patch onto a target object, protecting its IDENTITY keys.
 * Presets carry values, never identity: applying "Frosted" to a card must not
 * change which card it is (`id`), what it is (`type`) or whether it's on
 * (`enabled`) — that's the one rule every preset kind shares, so it lives here
 * instead of in each caller.
 */
export const PRESET_IDENTITY_KEYS = ["id", "type", "enabled", "group"] as const;

export function applyPresetPatch<T extends object>(target: T, patch: unknown): T {
  if (!patch || typeof patch !== "object") return target;
  const next: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if ((PRESET_IDENTITY_KEYS as readonly string[]).includes(k)) continue;
    next[k] = v;
  }
  return next as T;
}

/** The patch a preset should store for a target: everything but its identity. */
export function presetPatchFrom<T extends object>(target: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(target as Record<string, unknown>)) {
    if ((PRESET_IDENTITY_KEYS as readonly string[]).includes(k)) continue;
    out[k] = structuredClone(v);
  }
  return out;
}

/** Namespace for one effect type's presets — the ONE place this string forms. */
/**
 * WHICH PRESET these values currently ARE — or `null` for a custom look.
 *
 * The picker used to be write-only: you applied "Frosted panel" and the button
 * still said "Presets", so nothing in the UI could tell you what you were
 * looking at, whether you had drifted off it, or which of ten glass looks was
 * live. This is the read side.
 *
 * It is a COMPARISON, not a stored id, and that is the whole design. An id
 * written onto the effect would be a second source of truth that goes stale the
 * instant a slider moves — you would have to invalidate it on every field write,
 * from every surface (inspector, keyframes, node drivers, property paste), and
 * the one that forgot would leave the card lying about itself forever. Derived
 * state cannot go stale.
 *
 * The comparison is decidable only because of an invariant the library already
 * enforces: **a preset is a complete value patch, never a sparse one** (see
 * `builtin-effects.ts`). Every field the effect has is in `data`, so "are these
 * the same look?" is a full field-by-field equality and never a guess about
 * what an absent key meant.
 *
 * Cost is bounded and tiny: it bails on the first mismatching field, so a
 * non-matching preset costs one or two comparisons, and the whole sweep over a
 * few dozen presets is microseconds — cheap enough to derive on every render
 * rather than cache and re-invalidate.
 *
 * Domain-agnostic on purpose: it compares plain values, so it works for the
 * sound stack's cards the day they register, with nothing added here.
 */
export function activePreset<T = unknown>(
  presets: readonly Preset<T>[],
  values: Record<string, unknown> | readonly unknown[],
): Preset<T> | null {
  for (const preset of presets) {
    if (presetMatches(preset.data, values)) return preset;
  }
  return null;
}

/** Field-by-field equality between a preset's patch and a set of values. */
function presetMatches(data: unknown, values: Record<string, unknown> | readonly unknown[]): boolean {
  if (!data || typeof data !== "object") return false;
  // A STACK preset is a list: it matches a stack of the same length whose
  // entries agree as looks. A three-card stack is never "the same look" as a
  // two-card preset that happens to be its prefix.
  if (Array.isArray(data) || Array.isArray(values)) {
    return Array.isArray(data) && Array.isArray(values) && data.length > 0 && sameValue(data, values);
  }
  const patch = data as Record<string, unknown>;
  const target = values as Record<string, unknown>;
  let compared = 0;
  for (const key in patch) {
    // Identity never participates: two cards holding the same look are the same
    // look, whatever their ids are.
    if (key === "id" || key === "type" || key === "enabled") continue;
    if (!sameValue(patch[key], target[key])) return false;
    compared++;
  }
  // An empty patch matches everything, which would make every custom look read
  // as that preset. Nothing is not a look.
  return compared > 0;
}

/**
 * Keys that are identity WHEREVER they appear, however deep. An `id` is never a
 * look — two EQ bands at 1 kHz are the same band whatever they are called — and
 * `type`/`enabled` are identity only at the TOP level, where they say which
 * card this is rather than what it sounds like. Nested, both are real values (a
 * band's `type` IS its shape; a band's `enabled` IS part of the curve), which is
 * why the deep pass skips only the id.
 */
const NESTED_IDENTITY_KEYS: readonly string[] = ["id"];

/**
 * Structural equality, identity-blind.
 *
 * It used to bottom out at `a === b`, which is fine for the flat number/colour
 * fields most effects have and silently WRONG for any field that holds a list or
 * an object — two structurally identical band arrays are never the same
 * reference, so the comparison returned false forever. That is why the EQ card
 * always read "Custom": applying a preset genuinely changed the bands, and the
 * picker could not see that it had. Every future array-valued field (a curve, a
 * stop list, a set of taps) would have had the same bug.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") {
    // Authored values are decimals off sliders; an exact === would call a look
    // custom over floating-point dust the user cannot see or fix.
    return Math.abs(a - b) < 1e-6;
  }
  // Colours are the one string that varies only in case (#FFF vs #fff).
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => sameValue(v, b[i]));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
    for (const k of keys) {
      if (NESTED_IDENTITY_KEYS.includes(k)) continue;
      if (!sameValue(ao[k], bo[k])) return false;
    }
    return true;
  }
  return a === b;
}

export function effectPresetKind(effectType: string): string {
  return effectPresetKindFor("layer", effectType);
}
