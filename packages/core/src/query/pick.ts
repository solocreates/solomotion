import type { MotionDocument, Clip, Frame } from "../schema";
import { assignability, type ExprType } from "../expressions/types";
import { isUnderGroup, type DocNodeKind } from "./doc-index";

/**
 * THE PICK REGISTRY — "point this field at something", as data.
 *
 * Every field in the app that holds a reference — a constraint's target, a
 * Sound node's layer, a behavior's part, a modifier's path, a link, a
 * pick-whip — asks the same three questions: what MAY be picked here, what is
 * this stored key, and is the thing under the pointer one of them. They used
 * to be answered per field (a `Select` over `doc.tracks.flatMap(…)` with its
 * own idea of "same comp", "not audio", "not me"), so no two pickers agreed
 * and none of them could be driven from the canvas.
 *
 * Here they are answered once:
 *
 *   kind      a pickable family, contributed by ONE `registerPickProvider`
 *             call — layers, frames, pages, properties and variables are
 *             built in (`pick-providers.ts`); trackers plug in from the
 *             tracking module. A new family is a provider, never a switch.
 *   key       the node-key grammar, extended: `<prefix>:<id>` — `clip:<id>`,
 *             `frame:<id>`, `page:<id>` (the doc index's own keys), plus
 *             `prop:<clipId>/<path>`, `var:<id>`, `tracker:<id>`.
 *   filter    a `PickFilter` — plain data a field hands the picker, the pick
 *             mode and the agent alike. ONE predicate (`matchesPickFilter`)
 *             decides both the dropdown's rows and whether the canvas lights
 *             a layer up, so the two can never offer different things.
 */

/** The built-in families. Open-ended: a registered provider adds its own. */
export type BuiltinPickKind = "layer" | "frame" | "page" | "property" | "variable" | "tracker";
export type PickKind = BuiltinPickKind | (string & {});

export interface PickCandidate {
  /** `<prefix>:<id>` — unique across every kind. */
  key: string;
  kind: PickKind;
  /** The id after the prefix (a property's is `<clipId>/<path>`). */
  id: string;
  name: string;
  /** Where it lives — shown under the name, searched too. */
  where: string;
  /** Facets a filter can require (a layer's clip kind and capabilities). */
  tags: readonly string[];
  /** Lower-cased `name where`, what search scores against. */
  hay: string;
  /** The comp it lives in (a frame's own id for frame kinds). */
  frameId: string | null;
  pageId: string | null;
  /** The layer it is, or the layer it belongs to (a property). */
  clip?: Clip;
  frame?: Frame;
  /** A layer's / frame's doc-index kind — `world`, `component`, … — for glyphs. */
  node?: DocNodeKind;
  /** The layer that OWNS this candidate (a property's clip). */
  ownerId?: string;
  /** The value type, for candidates that are values (properties, variables). */
  type?: ExprType;
  /** A property's path on its owner. */
  path?: string;
  /** A grouping label ("Transform", an effect's name). */
  group?: string;
  /** For kinds with neither a clip nor a frame: a glyph id the UI maps. */
  glyph?: string;
}

/**
 * What a field may point at. Every facet is optional except `kinds`; an absent
 * facet does not constrain.
 */
export interface PickFilter {
  kinds: readonly PickKind[];
  /** In this comp only (a frame: this frame only). */
  frameId?: string;
  pageId?: string;
  /** Under this group, at any depth (a property: its layer is). */
  within?: string;
  /** Every one of these tags. */
  tags?: readonly string[];
  /** At least one of these tags. */
  anyTags?: readonly string[];
  /** Ids or keys to leave out — the field's own layer, typically. A layer id
   *  excludes that layer's properties too. */
  exclude?: readonly string[];
  /** On screen at this comp time. */
  atMs?: number;
  /** Auto-managed source comps (the "Nested" page). Default false. */
  includeInternal?: boolean;
  /** Properties of these layers only. Also what a property list is generated
   *  from — without it (or `frameId`) properties are not enumerated at all. */
  ofLayers?: readonly string[];
  /** A value candidate must be able to land in a field of this type. */
  fits?: ExprType | null;
  /** The last word, after every structural facet. */
  predicate?: (candidate: PickCandidate) => boolean;
}

export interface PickProvider {
  kind: PickKind;
  /** The key prefix this kind owns: keys are `<prefix>:<id>`. */
  prefix: string;
  /** What one is called — "layer", "tracker". The pick mode says "Pick a …". */
  noun: string;
  /**
   * Candidates of this kind, narrowed only as far as GENERATING them needs
   * (a property list is per layer, so `ofLayers`/`frameId` say which layers to
   * walk). The registry applies the whole filter afterwards.
   */
  candidates: (doc: MotionDocument, filter: PickFilter) => readonly PickCandidate[];
  /** One id → its candidate, whatever any filter says; null = it names nothing
   *  that exists (a broken reference). */
  resolve: (doc: MotionDocument, id: string) => PickCandidate | null;
}

// ── Keys ─────────────────────────────────────────────────────────────────────

/**
 * Prefixes the grammar knows before any provider registers. `tracker:` is
 * RESERVED for the tracking module: a stored `tracker:<id>` parses, reads as
 * an unavailable kind until its provider arrives, and no other provider may
 * take the prefix.
 */
const RESERVED_PREFIXES: ReadonlyMap<string, PickKind> = new Map([["tracker", "tracker"]]);

const KEY = /^([a-z][a-z0-9-]*):(\S+)$/;

export function pickKey(prefix: string, id: string): string {
  return `${prefix}:${id}`;
}

export function parsePickKey(key: string): { prefix: string; id: string } | null {
  const m = KEY.exec(key);
  return m ? { prefix: m[1]!, id: m[2]! } : null;
}

/** A property's key: `prop:<clipId>/<path>`. Ids never hold a `/`; paths may. */
export function propertyPickKey(clipId: string, path: string): string {
  return `prop:${clipId}/${path}`;
}

export function parsePropertyPickKey(key: string): { clipId: string; path: string } | null {
  const parsed = parsePickKey(key);
  if (parsed?.prefix !== "prop") return null;
  const slash = parsed.id.indexOf("/");
  if (slash <= 0 || slash === parsed.id.length - 1) return null;
  return { clipId: parsed.id.slice(0, slash), path: parsed.id.slice(slash + 1) };
}

// ── Registry ─────────────────────────────────────────────────────────────────

const byKind = new Map<PickKind, PickProvider>();
const byPrefix = new Map<string, PickProvider>();

/**
 * Add a pickable family. One call: its candidates appear in every object field
 * whose filter names the kind, light up in pick mode on any surface that tags
 * them, and resolve wherever a key of its prefix is stored. Registering a kind
 * again replaces it (hot reload, tests). Returns the unregister.
 */
export function registerPickProvider(provider: PickProvider): () => void {
  const owner = byPrefix.get(provider.prefix);
  if (owner && owner.kind !== provider.kind) {
    throw new Error(`Pick prefix "${provider.prefix}:" belongs to "${owner.kind}".`);
  }
  const reserved = RESERVED_PREFIXES.get(provider.prefix);
  if (reserved !== undefined && reserved !== provider.kind) {
    throw new Error(`Pick prefix "${provider.prefix}:" is reserved for "${reserved}".`);
  }
  const previous = byKind.get(provider.kind);
  if (previous && previous.prefix !== provider.prefix) byPrefix.delete(previous.prefix);
  byKind.set(provider.kind, provider);
  byPrefix.set(provider.prefix, provider);
  return () => {
    if (byKind.get(provider.kind) !== provider) return;
    byKind.delete(provider.kind);
    byPrefix.delete(provider.prefix);
  };
}

export function pickProvider(kind: PickKind): PickProvider | undefined {
  return byKind.get(kind);
}

/** The kind a key belongs to — known for a reserved prefix even before its
 *  provider registers; null for a key no grammar recognises. */
export function pickKindOfKey(key: string): PickKind | null {
  const parsed = parsePickKey(key);
  if (!parsed) return null;
  return byPrefix.get(parsed.prefix)?.kind ?? RESERVED_PREFIXES.get(parsed.prefix) ?? null;
}

/** "layer", "tracker" — what to call one of a kind, for the mode chip. */
export function pickNoun(kind: PickKind): string {
  return byKind.get(kind)?.noun ?? kind;
}

/**
 * What a stored key points at, or null when it points at nothing that exists
 * (deleted, or a kind whose provider is not loaded) — the broken-link state.
 */
export function resolvePick(doc: MotionDocument, key: string): PickCandidate | null {
  const parsed = parsePickKey(key);
  const provider = parsed ? byPrefix.get(parsed.prefix) : undefined;
  return parsed && provider ? provider.resolve(doc, parsed.id) : null;
}

/** Everything the filter admits, kinds in the filter's order. */
export function pickCandidates(doc: MotionDocument, filter: PickFilter): PickCandidate[] {
  const out: PickCandidate[] = [];
  for (const kind of filter.kinds) {
    const provider = byKind.get(kind);
    if (!provider) continue;
    for (const c of provider.candidates(doc, filter)) if (matchesPickFilter(doc, c, filter)) out.push(c);
  }
  return out;
}

/** May this key be picked under this filter? What the pick mode asks of the
 *  thing under the pointer — the SAME predicate the list is built with. */
export function pickAccepts(doc: MotionDocument, filter: PickFilter, key: string): boolean {
  const c = resolvePick(doc, key);
  return !!c && matchesPickFilter(doc, c, filter);
}

/**
 * THE predicate. Facets that a candidate cannot carry (a page has no clip, a
 * layer no type) constrain only the candidates that can.
 */
export function matchesPickFilter(doc: MotionDocument, c: PickCandidate, f: PickFilter): boolean {
  if (!f.kinds.includes(c.kind)) return false;
  if (f.exclude?.length && (f.exclude.includes(c.id) || f.exclude.includes(c.key) || (c.ownerId && f.exclude.includes(c.ownerId)))) return false;
  if (!f.includeInternal && c.tags.includes("internal")) return false;
  if (f.pageId && c.kind !== "page" && c.pageId !== f.pageId) return false;
  if (f.frameId && c.frameId !== f.frameId) return false;
  if (f.tags && !f.tags.every((t) => c.tags.includes(t))) return false;
  if (f.anyTags?.length && !f.anyTags.some((t) => c.tags.includes(t))) return false;
  if (f.within) {
    const id = c.ownerId ?? c.clip?.id;
    if (!id || !isUnderGroup(doc, id, f.within)) return false;
  }
  if (f.atMs !== undefined && c.clip && !(f.atMs >= c.clip.startMs && f.atMs < c.clip.startMs + c.clip.durationMs)) return false;
  if (f.ofLayers && c.kind === "property" && !(c.ownerId && f.ofLayers.includes(c.ownerId))) return false;
  if (f.fits !== undefined && f.fits !== null && c.type && assignability(c.type, f.fits) === "none") return false;
  return !f.predicate || f.predicate(c);
}

/** The noun phrase for a filter — "layer", "layer or frame". */
export function pickFilterNoun(filter: PickFilter): string {
  const nouns = [...new Set(filter.kinds.map(pickNoun))];
  if (nouns.length <= 1) return nouns[0] ?? "something";
  return `${nouns.slice(0, -1).join(", ")} or ${nouns[nouns.length - 1]}`;
}
