/**
 * POSE VOCABULARIES — the names a part's poses speak, and what to show when a
 * name has no pose. A registry, not a switch: `{ id, label, names, aliases,
 * fallbacks, mirror?, alphabets? }`, so a plugin or a pack adds a vocabulary
 * with one `registerVocabulary`.
 *
 * Matching is case- and punctuation-insensitive (`"A I"`, `"ai"` and `"AI"`
 * are one name) and accepts aliases (`rest` is the viseme `X`, `shut` is the
 * eye `Closed`). Unknown names walk the vocabulary's fallbacks; the caller
 * then falls to the first pose — a character never loses its mouth.
 *
 * VISEMES are `@solomotion/lipsync`'s canonical set and fallbacks, imported (its
 * root entry is side-effect free; engines load lazily). Foreign alphabets
 * (Rhubarb, Preston Blair, Oculus/ARKit…) and the ARKit blendshape weights live
 * in that package too (`fromAlphabet`, `ARKIT_VISEME_WEIGHTS`) — one table.
 */
import { VISEME_FALLBACKS, VISEME_ORDER, fromAlphabet } from "@solomotion/lipsync";

export interface Vocabulary {
  id: string;
  label: string;
  /** The canonical names, in display order (a face pad lays its cells out in this order). */
  names: readonly string[];
  /** Other spellings of a canonical name — matched like the name itself. */
  aliases?: Readonly<Record<string, readonly string[]>>;
  /** Visually nearest substitutes, tried in order (and theirs after them). */
  fallbacks: Readonly<Record<string, readonly string[]>>;
  /** Names that are each other's mirror (a glance left ↔ right). Sides in names are `rig/sides.ts`'s job. */
  mirror?: Readonly<Record<string, string>>;
  /**
   * A foreign alphabet's name as a canonical name — asked for EXPLICITLY
   * (`translatePoseName`), never matched implicitly, because their letters
   * collide (Rhubarb's `E` is the canonical `O`).
   */
  translate?: (alphabet: string, name: string) => string | null;
}

/** Lowercase, letters and digits only — the one comparison every name match uses. */
export function normalizePoseName(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

// ── Registry ─────────────────────────────────────────────────────────────────

const registry = new Map<string, Vocabulary>();
const lookups = new WeakMap<Vocabulary, Map<string, string>>();

export function registerVocabulary(v: Vocabulary): void {
  registry.set(v.id, v);
}

export function vocabularyById(id: string | null | undefined): Vocabulary | null {
  return id ? (registry.get(id) ?? null) : null;
}

export function listVocabularies(): Vocabulary[] {
  return [...registry.values()];
}

/** normalized spelling → canonical name; the first spelling registered wins. */
function lookupOf(v: Vocabulary): Map<string, string> {
  let map = lookups.get(v);
  if (map) return map;
  map = new Map();
  for (const n of v.names) if (!map.has(normalizePoseName(n))) map.set(normalizePoseName(n), n);
  for (const n of v.names) for (const a of v.aliases?.[n] ?? []) if (!map.has(normalizePoseName(a))) map.set(normalizePoseName(a), n);
  lookups.set(v, map);
  return map;
}

/** The canonical name a spelling means in this vocabulary, or null. */
export function canonicalPoseName(vocab: Vocabulary | string | null | undefined, name: string): string | null {
  const v = typeof vocab === "string" ? vocabularyById(vocab) : vocab;
  if (!v) return null;
  return lookupOf(v).get(normalizePoseName(name)) ?? null;
}

/** A foreign alphabet's name (`rhubarb` `"D"`, `oculus` `"aa"`) as this vocabulary's canonical name. */
export function translatePoseName(vocab: Vocabulary | string, alphabet: string, name: string): string | null {
  const v = typeof vocab === "string" ? vocabularyById(vocab) : vocab;
  return v?.translate?.(alphabet, name) ?? null;
}

/**
 * THE NAME RULE — which of `available` a wanted name shows:
 *  1. the same name, ignoring case and punctuation;
 *  2. in a vocabulary: the pose whose name means the same canonical name
 *     (an alias counts on either side), then its fallbacks, breadth first;
 *  3. null — the caller shows the first pose.
 */
export function resolvePoseName(
  vocab: Vocabulary | string | null | undefined,
  wanted: string,
  available: readonly string[],
): string | null {
  const want = normalizePoseName(wanted);
  if (!want) return null;
  const direct = available.find((a) => normalizePoseName(a) === want);
  if (direct !== undefined) return direct;
  const v = typeof vocab === "string" ? vocabularyById(vocab) : (vocab ?? null);
  if (!v) return null;
  const start = canonicalPoseName(v, wanted);
  if (!start) return null;
  const byCanon = new Map<string, string>();
  for (const a of available) {
    const c = canonicalPoseName(v, a);
    if (c && !byCanon.has(c)) byCanon.set(c, a);
  }
  const queue = [start];
  const seen = new Set<string>();
  while (queue.length) {
    const c = queue.shift()!;
    if (seen.has(c)) continue;
    seen.add(c);
    const hit = byCanon.get(c);
    if (hit !== undefined) return hit;
    queue.push(...(v.fallbacks[c] ?? []));
  }
  return null;
}

/** The mirror of a pose NAME in a vocabulary (a glance left → right), or null. */
export function mirrorPoseName(vocab: Vocabulary | string | null | undefined, name: string): string | null {
  const v = typeof vocab === "string" ? vocabularyById(vocab) : (vocab ?? null);
  const c = v ? canonicalPoseName(v, name) : null;
  return c && v?.mirror?.[c] ? v.mirror[c]! : null;
}

// ── Built-in vocabularies ────────────────────────────────────────────────────

export const VISEMES_VOCABULARY: Vocabulary = {
  id: "visemes",
  label: "Mouth (visemes)",
  names: VISEME_ORDER,
  aliases: {
    // Preston Blair's and Oculus/ARKit-15's names that do not collide with the canonical ones.
    X: ["rest", "sil", "silence", "neutral", "idle"],
    MBP: ["m", "b", "p", "pp", "closedlips"],
    AI: ["a", "aa", "ah", "ai"],
    E: ["ee", "eh", "i", "ih"],
    O: ["oh", "ow", "aw"],
    U: ["oo", "w", "wq", "uw", "ou"],
    FV: ["f", "v", "ff"],
    L: ["th", "nn"],
    S: ["s", "t", "z", "ch", "sh", "ss", "dd", "kk", "rr", "etc", "cdgknrsthyz", "consonant"],
  },
  fallbacks: VISEME_FALLBACKS,
  translate: (alphabet, name) => fromAlphabet(alphabet, name),
};
export const EYES_VOCABULARY: Vocabulary = {
  id: "eyes",
  label: "Eyes",
  names: ["Open", "Half", "Closed", "Wide", "Squint", "Happy"],
  aliases: {
    Open: ["opened", "neutral", "normal", "default"],
    Half: ["halfopen", "halfclosed", "halfshut", "mid", "sleepy", "droopy"],
    Closed: ["close", "shut", "blink", "blinking"],
    Wide: ["wideopen", "surprised", "big"],
    Squint: ["narrow", "squinting"],
    Happy: ["smile", "smiling", "joy"],
  },
  fallbacks: {
    Open: ["Wide", "Half"],
    Half: ["Squint", "Closed", "Open"],
    Closed: ["Half", "Squint", "Happy"],
    Wide: ["Open"],
    Squint: ["Half", "Closed"],
    Happy: ["Squint", "Closed", "Half"],
  },
};

export const BROWS_VOCABULARY: Vocabulary = {
  id: "brows",
  label: "Brows",
  names: ["Neutral", "Raised", "Lowered", "Angry", "Sad", "Skeptical"],
  aliases: {
    Neutral: ["rest", "normal", "default"],
    Raised: ["up", "high", "surprised"],
    Lowered: ["down", "low", "furrowed", "frown"],
    Angry: ["mad", "cross"],
    Sad: ["worried", "concerned", "upset"],
    Skeptical: ["quizzical", "doubt", "oneup"],
  },
  fallbacks: {
    Neutral: [],
    Raised: ["Neutral"],
    Lowered: ["Angry", "Neutral"],
    Angry: ["Lowered", "Neutral"],
    Sad: ["Raised", "Neutral"],
    Skeptical: ["Raised", "Neutral"],
  },
};

export const HANDS_VOCABULARY: Vocabulary = {
  id: "hands",
  label: "Hands",
  names: ["Relaxed", "Open", "Fist", "Point", "Thumb", "Peace", "Wave"],
  aliases: {
    Relaxed: ["rest", "idle", "neutral", "natural"],
    Open: ["palm", "flat", "stop", "spread"],
    Fist: ["closed", "grab", "grip", "punch"],
    Point: ["pointing", "index"],
    Thumb: ["thumbsup", "thumbup"],
    Peace: ["victory", "v", "two"],
    Wave: ["hi", "hello", "bye"],
  },
  fallbacks: {
    Relaxed: ["Open"],
    Open: ["Relaxed", "Wave"],
    Fist: ["Relaxed"],
    Point: ["Fist", "Relaxed"],
    Thumb: ["Fist", "Relaxed"],
    Peace: ["Point", "Open"],
    Wave: ["Open", "Relaxed"],
  },
};

export const EMOTIONS_VOCABULARY: Vocabulary = {
  id: "emotions",
  label: "Emotions",
  names: ["Neutral", "Happy", "Sad", "Angry", "Surprised", "Afraid", "Disgusted"],
  aliases: {
    Neutral: ["rest", "calm", "default"],
    Happy: ["joy", "smile", "glad"],
    Sad: ["unhappy", "cry", "crying"],
    Angry: ["mad", "rage", "furious"],
    Surprised: ["surprise", "shock", "shocked", "wow"],
    Afraid: ["scared", "fear", "fearful"],
    Disgusted: ["disgust", "gross", "yuck"],
  },
  fallbacks: {
    Neutral: [],
    Happy: ["Neutral"],
    Sad: ["Neutral"],
    Angry: ["Neutral"],
    Surprised: ["Neutral"],
    Afraid: ["Surprised", "Sad", "Neutral"],
    Disgusted: ["Angry", "Neutral"],
  },
};

for (const v of [VISEMES_VOCABULARY, EYES_VOCABULARY, BROWS_VOCABULARY, HANDS_VOCABULARY, EMOTIONS_VOCABULARY]) registerVocabulary(v);
