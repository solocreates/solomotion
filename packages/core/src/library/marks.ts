/**
 * MARKS — what YOU think of a piece of content, across every project.
 *
 * Starring was implemented twice before this: the icons panel kept a list of
 * icon ids, the library browser kept a list of item ids, and neither could see
 * the other. Two lists answering one question is this codebase's most common
 * defect, and here it had a second symptom — a star was scoped to the browser
 * that drew it, so the same person's taste had to be rebuilt per content type
 * and evaporated entirely when a seventh browser appeared.
 *
 * So marks live once, here, over a NAMESPACED reference rather than a bare id.
 * Any browsable thing — an icon, a sound, a preset, whatever ships next — is
 * markable the day it registers a domain, with no new store, no new persistence
 * and no new UI.
 *
 * Three deliberate shapes:
 *
 *  • A VERDICT is one per item and exclusive. You cannot star and dislike the
 *    same sound; making that unrepresentable is better than validating it.
 *  • COLLECTIONS are many-to-many and are the only thing a user names. A star
 *    is not a collection called "Starred" — it is a verdict, it has a dedicated
 *    gesture, and folding the two would mean "unstar" and "remove from a list"
 *    became one undoable action with two meanings.
 *  • Nothing here holds CONTENT. A mark is a reference and a reference only, so
 *    starring 400 sounds costs 400 short strings and never a byte of audio.
 *    The catalogue stays the one place content lives.
 *
 * Device-wide and project-independent on purpose: taste follows the person, not
 * the file. This is the same call `textLookPrefs` already makes.
 */

/* -------------------------------------------------------------------------- */
/* References                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The content families that can be marked. A new one is an arm here plus a
 * browser that passes it — never a second store.
 *
 * Domains exist because ids are only unique WITHIN a catalogue. `lucide:play`
 * and a library item id have no reason to collide today and every reason to
 * eventually, and a taste list that silently merges two unrelated things is a
 * bug nobody would ever diagnose.
 */
export const MARK_DOMAINS = ["library", "icon", "font"] as const;
export type MarkDomain = (typeof MARK_DOMAINS)[number];

export interface MarkRef {
  domain: MarkDomain;
  id: string;
}

/** The storage key for a reference. `/` is safe: no domain contains one. */
export function markKey(ref: MarkRef): string {
  return `${ref.domain}/${ref.id}`;
}

export function parseMarkKey(key: string): MarkRef | null {
  const i = key.indexOf("/");
  if (i <= 0 || i === key.length - 1) return null;
  const domain = key.slice(0, i);
  return (MARK_DOMAINS as readonly string[]).includes(domain)
    ? { domain: domain as MarkDomain, id: key.slice(i + 1) }
    : null;
}

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A judgement. `disliked` is not a soft delete — the item stays in the
 * catalogue and stays findable by name. It is a ranking signal and a filter:
 * a library of ten thousand sounds where you cannot say "not this one, ever
 * again" makes you re-reject the same wrong sound every session.
 */
export type MarkVerdict = "starred" | "disliked";

export interface Collection {
  id: string;
  name: string;
  /** Mark keys, most recently added FIRST — a collection reads as a stack. */
  keys: string[];
  createdAt: number;
}

export interface MarksState {
  /** Mark key → verdict. Absent means no opinion, which is not the same as none. */
  verdicts: Record<string, MarkVerdict>;
  collections: Collection[];
}

export const EMPTY_MARKS: MarksState = { verdicts: {}, collections: [] };

/* -------------------------------------------------------------------------- */
/* Verdicts                                                                    */
/* -------------------------------------------------------------------------- */

export function verdictOf(state: MarksState, ref: MarkRef): MarkVerdict | null {
  return state.verdicts[markKey(ref)] ?? null;
}

/**
 * Set or clear a verdict. Passing the verdict an item already has CLEARS it,
 * so one gesture is both star and unstar — the behaviour every star button in
 * every tool already has, expressed once.
 */
export function setVerdict(state: MarksState, ref: MarkRef, verdict: MarkVerdict | null): MarksState {
  const key = markKey(ref);
  const next = { ...state.verdicts };
  if (verdict === null || next[key] === verdict) delete next[key];
  else next[key] = verdict;
  return { ...state, verdicts: next };
}

export function toggleVerdict(state: MarksState, ref: MarkRef, verdict: MarkVerdict): MarksState {
  return setVerdict(state, ref, verdict);
}

/**
 * Every key with this verdict in one domain, newest first.
 *
 * Insertion order of a plain object is the recency order here, and reversing it
 * is what makes the Starred shelf read like the icons panel's Recent: the last
 * thing you starred is the first thing you see, because it is overwhelmingly
 * the one you were about to use.
 */
export function keysWithVerdict(state: MarksState, verdict: MarkVerdict, domain?: MarkDomain): string[] {
  const out: string[] = [];
  for (const [key, v] of Object.entries(state.verdicts)) {
    if (v !== verdict) continue;
    if (domain && !key.startsWith(`${domain}/`)) continue;
    out.push(key);
  }
  return out.reverse();
}

/** The ids (domain stripped) with this verdict — what a browser filters on. */
export function idsWithVerdict(state: MarksState, verdict: MarkVerdict, domain: MarkDomain): string[] {
  const prefix = `${domain}/`;
  return keysWithVerdict(state, verdict, domain).map((k) => k.slice(prefix.length));
}

/* -------------------------------------------------------------------------- */
/* Collections                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Collections are deliberately MIXED-DOMAIN. "Trailer kit" holding six sounds
 * and four icons is the useful thing, and it falls out for free from marking a
 * reference rather than an id — splitting collections per content type would be
 * the same mistake this module exists to undo.
 */
export function createCollection(state: MarksState, name: string, id: string, now = Date.now()): MarksState {
  const clean = name.trim() || "Untitled";
  return { ...state, collections: [...state.collections, { id, name: clean, keys: [], createdAt: now }] };
}

export function renameCollection(state: MarksState, id: string, name: string): MarksState {
  const clean = name.trim();
  if (!clean) return state;
  return {
    ...state,
    collections: state.collections.map((c) => (c.id === id ? { ...c, name: clean } : c)),
  };
}

export function deleteCollection(state: MarksState, id: string): MarksState {
  return { ...state, collections: state.collections.filter((c) => c.id !== id) };
}

/** Add to the FRONT, and never twice. Re-adding promotes rather than duplicates. */
export function addToCollection(state: MarksState, id: string, ref: MarkRef): MarksState {
  const key = markKey(ref);
  return {
    ...state,
    collections: state.collections.map((c) =>
      c.id === id ? { ...c, keys: [key, ...c.keys.filter((k) => k !== key)] } : c,
    ),
  };
}

export function removeFromCollection(state: MarksState, id: string, ref: MarkRef): MarksState {
  const key = markKey(ref);
  return {
    ...state,
    collections: state.collections.map((c) =>
      c.id === id ? { ...c, keys: c.keys.filter((k) => k !== key) } : c,
    ),
  };
}

/** In, or out. One gesture for the menu's checkbox row. */
export function toggleInCollection(state: MarksState, id: string, ref: MarkRef): MarksState {
  return collectionHas(state, id, ref)
    ? removeFromCollection(state, id, ref)
    : addToCollection(state, id, ref);
}

export function collectionHas(state: MarksState, id: string, ref: MarkRef): boolean {
  const key = markKey(ref);
  return state.collections.find((c) => c.id === id)?.keys.includes(key) ?? false;
}

/** Which collections hold this item — the menu's tick marks. */
export function collectionsFor(state: MarksState, ref: MarkRef): Collection[] {
  const key = markKey(ref);
  return state.collections.filter((c) => c.keys.includes(key));
}

/** One collection's ids within a domain, in collection order. */
export function collectionIds(state: MarksState, id: string, domain: MarkDomain): string[] {
  const prefix = `${domain}/`;
  const c = state.collections.find((x) => x.id === id);
  if (!c) return [];
  return c.keys.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
}

/** How many of a collection's items belong to one domain — the rail's count. */
export function collectionCount(collection: Collection, domain?: MarkDomain): number {
  if (!domain) return collection.keys.length;
  const prefix = `${domain}/`;
  return collection.keys.filter((k) => k.startsWith(prefix)).length;
}

/* -------------------------------------------------------------------------- */
/* Ranking                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Apply taste to a list that is already in its own order.
 *
 * Disliked items are REMOVED rather than sunk: "I never want to see this again"
 * is the whole content of the gesture, and a browser that still shows it at the
 * bottom has not honoured it. Stars are promoted rather than extracted, so the
 * list keeps its shape and the things you like float to the top of it — the
 * same promote-don't-reshuffle rule `sort: "used"` already follows.
 *
 * `keyOf` is passed in so this works over icons, sounds and anything else
 * without knowing what they are.
 */
export function applyMarks<T>(
  items: readonly T[],
  state: MarksState,
  keyOf: (item: T) => MarkRef,
  options: { hideDisliked?: boolean; promoteStarred?: boolean } = {},
): T[] {
  const { hideDisliked = true, promoteStarred = true } = options;
  const starred: T[] = [];
  const rest: T[] = [];
  for (const item of items) {
    const v = state.verdicts[markKey(keyOf(item))];
    if (v === "disliked" && hideDisliked) continue;
    if (v === "starred" && promoteStarred) starred.push(item);
    else rest.push(item);
  }
  return promoteStarred ? [...starred, ...rest] : rest;
}
