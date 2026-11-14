import { current, isDraft } from "immer";
import { sameValue } from "../presets/library";

/**
 * THE SELECTION BRAIN — what several things have in common, and how one edit
 * reaches all of them.
 *
 * A multi-selection is not a special panel; it is the same panel asked about N
 * objects instead of one. Every field that N objects share is shown, with the
 * value they agree on or MIXED where they do not, and an edit to it lands on
 * all N. That contract has to hold for a scalar (opacity), for a LIST of
 * objects (an effect stack, a fill list) and for anything nested inside one of
 * those (a gradient's third stop, a stroke's dash pattern) — "deeply", or the
 * panel is lying about part of what it shows.
 *
 * So this module knows nothing about effects or paints. It works on plain
 * values and lists of `{ id, … }` entries, with three ideas:
 *
 *   mergeValues        N values → the one they agree on, or MIXED
 *   sharedList         N lists  → the entries they share (by INDEX and kind)
 *                                 and, per entry, the paths that are mixed
 *   propagateListEdit  an edit made to the PRIMARY list, replayed onto a
 *                      sibling — add, remove, reorder, retype and any field
 *                      change, however deep — without the editor knowing
 *                      there was a sibling at all
 *
 * The last one is what lets a single-clip editor (the effect stack, the paint
 * list, the stroke stack) become a multi-clip editor with no forked code: the
 * host runs the same mutation against the primary's list, then asks this to
 * diff and replay. Ids are the only thing that never propagate — a sibling's
 * entry keeps its own id, so keyframe tracks stay addressed.
 *
 * Index-parallel on purpose. Two layers that both carry [shadow, glow] share
 * those two cards; a layer with [glow] alone shares nothing with them. Figma
 * makes the same call: matching by position and kind is the only pairing a
 * person can predict, and matching by name or by "closest" is a guess that
 * edits the wrong card the day it guesses wrong.
 */

/**
 * A detached deep copy. The lists this module diffs and replays usually arrive
 * as immer DRAFTS (the edit runs inside `store.update`), and `structuredClone`
 * refuses a Proxy outright — so a draft is resolved to its current plain value
 * first. Every clone in the selection brain, and in the hosts built on it,
 * goes through here for that reason.
 */
export function cloneValue<T>(v: T): T {
  return structuredClone(isDraft(v) ? (current(v) as T) : v);
}

/** The sentinel a field shows when the selection disagrees about it. */
export const MIXED: unique symbol = Symbol("mixed");
export type Mixed = typeof MIXED;

export function isMixed<T>(v: T | Mixed): v is Mixed {
  return v === MIXED;
}

/** Deep, identity-blind, float-tolerant equality (the library's rule). */
export const valuesEqual: (a: unknown, b: unknown) => boolean = sameValue;

/** N values → the one they all hold, or MIXED. An empty set is `undefined`. */
export function mergeValues<T>(values: readonly T[]): T | Mixed | undefined {
  if (values.length === 0) return undefined;
  const first = values[0]!;
  for (let i = 1; i < values.length; i++) if (!valuesEqual(first, values[i])) return MIXED;
  return first;
}

/** Keys that are identity wherever they appear — never a "value" to compare. */
const IDENTITY_KEYS: ReadonlySet<string> = new Set(["id"]);

/**
 * Every dotted path at which two values DISAGREE, deeply. A path is as deep as
 * the disagreement is precise: two gradients differing in one stop's colour
 * report `stops.2.color`; two arrays of different length report the array,
 * because there is no per-element story to tell. Ids are skipped — two entries
 * are compared as looks, not as identities.
 */
export function diffPaths(a: unknown, b: unknown, prefix = ""): string[] {
  const out: string[] = [];
  walk(a, b, prefix, out);
  return out;
}

function walk(a: unknown, b: unknown, path: string, out: string[]): void {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      out.push(path);
      return;
    }
    for (let i = 0; i < a.length; i++) walk(a[i], b[i], join(path, String(i)), out);
    return;
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (IDENTITY_KEYS.has(k)) continue;
      if (!(k in a) || !(k in b)) {
        out.push(join(path, k));
        continue;
      }
      walk(a[k], b[k], join(path, k), out);
    }
    return;
  }
  if (!valuesEqual(a, b)) out.push(path);
}

function join(prefix: string, seg: string): string {
  return prefix ? `${prefix}.${seg}` : seg;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Read a dotted path off a plain value (array indices are numeric segments). */
export function readPath(obj: unknown, path: string): unknown {
  if (path === "") return obj;
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Write a dotted path into a plain value, cloning the value written. */
export function writePath(obj: unknown, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur === null || typeof cur !== "object") return;
    cur = (cur as Record<string, unknown>)[parts[i]!];
  }
  if (cur === null || typeof cur !== "object") return;
  (cur as Record<string, unknown>)[parts[parts.length - 1]!] = cloneValue(value);
}

// ── Lists ────────────────────────────────────────────────────────────────────

/** One entry the whole selection carries, with what it disagrees about. */
export interface SharedEntry<T> {
  index: number;
  /** The primary's entry — the object the panel renders and edits. */
  primary: T;
  /** Dotted paths (relative to the entry) where the siblings differ. */
  mixed: ReadonlySet<string>;
}

export interface SharedList<T> {
  entries: SharedEntry<T>[];
  /**
   * The lists do not all have the same shape: one is longer, or holds a
   * different kind at some index. The shared entries above are still exact;
   * this is the honest flag a panel shows so nobody wonders where a card went.
   */
  uneven: boolean;
}

/**
 * The entries N lists share, by index and kind. `kindOf` names the
 * discriminant — an effect's `type`, a paint's `type` — so a shadow at index 1
 * pairs only with a shadow at index 1.
 */
export function sharedList<T extends object>(
  lists: readonly (readonly T[])[],
  kindOf: (entry: T) => unknown = (e) => (e as { type?: unknown }).type,
): SharedList<T> {
  if (lists.length === 0) return { entries: [], uneven: false };
  const primary = lists[0]!;
  const entries: SharedEntry<T>[] = [];
  let uneven = lists.some((l) => l.length !== primary.length);
  for (let i = 0; i < primary.length; i++) {
    const p = primary[i]!;
    const kind = kindOf(p);
    const siblings: T[] = [];
    let shared = true;
    for (let n = 1; n < lists.length; n++) {
      const s = lists[n]![i];
      if (s === undefined || kindOf(s) !== kind) {
        shared = false;
        break;
      }
      siblings.push(s);
    }
    if (!shared) {
      uneven = true;
      continue;
    }
    const mixed = new Set<string>();
    for (const s of siblings) for (const path of diffPaths(p, s)) mixed.add(path);
    entries.push({ index: i, primary: p, mixed });
  }
  return { entries, uneven };
}

/**
 * Re-address a path that names an entry BY ID (`lfx.<id>.blur`, `fill.<id>`,
 * `stroke.<id>.width`) from the primary's list to a sibling's: the segment
 * equal to the primary entry's id becomes the sibling entry's id at the same
 * index. `null` when the sibling has no entry there — the write skips it.
 */
export function remapEntryPath<T extends { id: string }>(
  path: string,
  from: readonly T[],
  to: readonly T[],
): string | null {
  const segs = path.split(".");
  for (let s = 0; s < segs.length; s++) {
    const i = from.findIndex((e) => e.id === segs[s]);
    if (i < 0) continue;
    const twin = to[i];
    if (!twin) return null;
    segs[s] = twin.id;
    return segs.join(".");
  }
  return path;
}

export interface PropagatedEdit<T> {
  list: T[];
  /** Ids of the sibling's entries that were dropped (their tracks go with them). */
  removedIds: string[];
}

/**
 * Replay the edit that turned `before` into `after` onto `target`.
 *
 * Entries are paired by id between `before` and `after` (the primary's own
 * ids are stable across an edit), and by INDEX between `before` and `target`.
 * Then, for each entry in `after`, in `after`'s order:
 *
 *   still there, same kind   the target's twin, with every path that changed
 *                            written onto it — a field, a nested stop, a dash
 *                            list. The twin keeps its id.
 *   still there, new kind    the twin is REPLACED by a fresh copy of the new
 *                            entry: a solid that became a gradient shares no
 *                            fields with what it was.
 *   new                      a fresh copy (via `clone`, which mints the id).
 *
 * Entries `before` had that `after` lacks are removed from the target; entries
 * the target had beyond `before`'s length are kept, after everything else, in
 * their own order — a sibling with a longer stack does not lose its extras
 * because the primary never had them.
 */
export function propagateListEdit<T extends { id: string }>(
  before: readonly T[],
  after: readonly T[],
  target: readonly T[],
  clone: (entry: T) => T,
  kindOf: (entry: T) => unknown = (e) => (e as { type?: unknown }).type,
): PropagatedEdit<T> {
  const indexBefore = new Map<string, number>();
  before.forEach((e, i) => indexBefore.set(e.id, i));

  const list: T[] = [];
  for (const a of after) {
    const j = indexBefore.get(a.id);
    if (j === undefined) {
      list.push(clone(a));
      continue;
    }
    const twin = target[j];
    if (twin === undefined) continue; // the sibling never had this one
    const b = before[j]!;
    if (kindOf(b) !== kindOf(a)) {
      list.push(clone(a));
      continue;
    }
    const changed = diffPaths(b, a);
    if (changed.length === 0) {
      list.push(twin);
      continue;
    }
    const next = cloneValue(twin);
    for (const path of changed) {
      if (path === "") continue;
      writePath(next, path, readPath(a, path));
    }
    list.push(next);
  }
  // Extras the sibling carried past the primary's length stay, in order.
  for (let i = before.length; i < target.length; i++) list.push(target[i]!);

  const kept = new Set(list.map((e) => e.id));
  const removedIds = target.filter((e) => !kept.has(e.id)).map((e) => e.id);
  return { list, removedIds };
}
