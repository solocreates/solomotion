/**
 * The canonical VISEME set — the mouth-shape vocabulary every phoneme engine
 * classifies into and every mapping UI offers slots for. It is the classic
 * Preston Blair / Rhubarb alphabet (each entry lists its Rhubarb letter), so
 * mouth art drawn for any standard lip-sync tool maps 1:1.
 *
 * Engines declare which subset they can actually EMIT (`PhonemeEngine.emits`) —
 * a pure-DSP engine can hear "open vs round vs closed" but not "tongue up",
 * while a transcript-assisted engine can emit everything. UIs read `emits` to
 * gray out slots an engine will never produce, instead of hard-coding a set.
 */

export const VISEME_IDS = ["X", "MBP", "AI", "E", "O", "U", "FV", "L", "S"] as const;
export type VisemeId = (typeof VISEME_IDS)[number];

export interface VisemeInfo {
  id: VisemeId;
  /** Short display name for a mapping slot. */
  name: string;
  /** The sounds this shape covers — shown as the slot's hint. */
  sounds: string;
  /** Example word with the sound emphasized. */
  example: string;
  /** Rhubarb Lip Sync letter, for people bringing existing mouth art. */
  rhubarb: string;
}

export const VISEMES: Record<VisemeId, VisemeInfo> = {
  X: { id: "X", name: "Rest", sounds: "silence", example: "…", rhubarb: "X" },
  MBP: { id: "MBP", name: "M B P", sounds: "m · b · p", example: "mom", rhubarb: "A" },
  S: { id: "S", name: "S T Z", sounds: "s · t · z · ch", example: "sea", rhubarb: "B" },
  E: { id: "E", name: "E", sounds: "eh · ee", example: "bee", rhubarb: "C" },
  AI: { id: "AI", name: "A I", sounds: "ah · eye", example: "car", rhubarb: "D" },
  O: { id: "O", name: "O", sounds: "oh · aw", example: "go", rhubarb: "E" },
  U: { id: "U", name: "U W", sounds: "oo · w", example: "you", rhubarb: "F" },
  FV: { id: "FV", name: "F V", sounds: "f · v", example: "five", rhubarb: "G" },
  L: { id: "L", name: "L", sounds: "l · th", example: "love", rhubarb: "H" },
};

/** All visemes in mapping-slot display order (rest first, then by mouth openness). */
export const VISEME_ORDER: readonly VisemeId[] = ["X", "MBP", "S", "E", "AI", "O", "U", "FV", "L"];

/**
 * Visually-nearest substitutes, tried in order when a viseme has no art. Lets
 * a partial mapping (even just rest + open + closed) still produce a gap-free
 * mouth track — the classic "3-shape lip sync" degrades gracefully out of the
 * same pipeline.
 */
export const VISEME_FALLBACKS: Record<VisemeId, readonly VisemeId[]> = {
  X: ["MBP"],
  MBP: ["X"],
  S: ["E", "AI"],
  E: ["AI", "S"],
  AI: ["E", "O"],
  O: ["AI", "U"],
  U: ["O", "AI"],
  FV: ["S", "E", "AI"],
  L: ["AI", "E"],
};

/**
 * Resolve the art for a viseme through a (possibly partial) mapping: its own
 * slot first, then its fallback chain. Null = nothing usable mapped at all.
 */
export function resolveVisemeArt<T>(
  mapping: Partial<Record<VisemeId, T | null | undefined>>,
  viseme: VisemeId,
): T | null {
  const own = mapping[viseme];
  if (own != null) return own;
  for (const fb of VISEME_FALLBACKS[viseme]) {
    const v = mapping[fb];
    if (v != null) return v;
  }
  return null;
}
