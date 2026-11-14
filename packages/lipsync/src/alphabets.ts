import type { PhonemeOrSilence } from "./phonemes";
import { VISEME_IDS, type VisemeId } from "./visemes";

/**
 * VISEME ALPHABETS — the mouth sets other tools and rigs are drawn for, as
 * mapping tables from (and back to) the canonical nine. One registry, so a
 * studio's in-house set is one `registerVisemeAlphabet` call, not a switch.
 *
 *  - `fromViseme` is TOTAL over the canonical nine (a test asserts it): any
 *    engine's cues can drive any alphabet's mouth.
 *  - `fromPhoneme` is the finer route, used when phonemes are known (align,
 *    Test Voice, a remote phoneme model): alphabets with MORE shapes than nine
 *    (Disney's TH, Oculus' DD/kk/nn) only light those up from phonemes.
 *  - `toViseme` reads a shape name back (an AI viseme stream, art named for
 *    another tool) — matched case- and punctuation-insensitively, with aliases.
 */

export interface AlphabetShape {
  id: string;
  name: string;
  /** Other spellings that mean this shape ("rest", "sil", "neutral"…). */
  aliases?: readonly string[];
}

export interface VisemeAlphabet {
  id: string;
  label: string;
  shapes: readonly AlphabetShape[];
  fromViseme: Readonly<Record<VisemeId, string>>;
  fromPhoneme?: Readonly<Partial<Record<PhonemeOrSilence, string>>>;
  toViseme: Readonly<Record<string, VisemeId>>;
}

const alphabets = new Map<string, VisemeAlphabet>();

export function registerVisemeAlphabet(a: VisemeAlphabet): void {
  alphabets.set(a.id, a);
}
export function visemeAlphabet(id: string): VisemeAlphabet | undefined {
  return alphabets.get(id);
}
export function listVisemeAlphabets(): VisemeAlphabet[] {
  return [...alphabets.values()];
}

/** "M B P", "mbp", "M/B/P" and "m-b-p" all read as one name. */
export function normalizeShapeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The alphabet's shape for a canonical viseme — or, when the phoneme is known, the finer one. */
export function toAlphabet(alphabetId: string, viseme: VisemeId, phoneme?: PhonemeOrSilence): string | null {
  const a = alphabets.get(alphabetId);
  if (!a) return null;
  return (phoneme !== undefined ? a.fromPhoneme?.[phoneme] : undefined) ?? a.fromViseme[viseme];
}

/** A shape name in any alphabet (or the canonical set itself) → canonical viseme. */
export function fromAlphabet(alphabetId: string, shape: string): VisemeId | null {
  const want = normalizeShapeName(shape);
  const a = alphabets.get(alphabetId);
  if (a) {
    for (const s of a.shapes) {
      if (normalizeShapeName(s.id) === want || normalizeShapeName(s.name) === want || s.aliases?.some((x) => normalizeShapeName(x) === want)) {
        return a.toViseme[s.id] ?? null;
      }
    }
    return null;
  }
  return canonicalViseme(shape);
}

/** Canonical ids by name, case/punctuation-insensitive ("m b p" → MBP, "rest" → X). */
export function canonicalViseme(shape: string): VisemeId | null {
  const want = normalizeShapeName(shape);
  for (const v of VISEME_IDS) if (normalizeShapeName(v) === want) return v;
  const alias: Record<string, VisemeId> = { rest: "X", sil: "X", silence: "X", neutral: "X", closed: "MBP", wq: "U", etc: "S", th: "L" };
  return alias[want] ?? null;
}

// ── Built-in alphabets ────────────────────────────────────────────────────────

const shape = (id: string, name: string, aliases?: string[]): AlphabetShape => (aliases ? { id, name, aliases } : { id, name });

/** Rhubarb Lip Sync's letters A–H + X (the canonical set IS Rhubarb's, renamed). */
registerVisemeAlphabet({
  id: "rhubarb",
  label: "Rhubarb (A–H, X)",
  shapes: [
    shape("X", "Idle", ["rest"]), shape("A", "Closed (M B P)"), shape("B", "Clenched teeth (K S T)"),
    shape("C", "Open (EH AE)"), shape("D", "Wide open (AA)"), shape("E", "Rounded (AO ER)"),
    shape("F", "Puckered (UW OW W)"), shape("G", "F V"), shape("H", "L"),
  ],
  fromViseme: { X: "X", MBP: "A", S: "B", E: "C", AI: "D", O: "E", U: "F", FV: "G", L: "H" },
  toViseme: { X: "X", A: "MBP", B: "S", C: "E", D: "AI", E: "O", F: "U", G: "FV", H: "L" },
});

/** Preston Blair's ten — the classic animation chart (WQ split from U). */
registerVisemeAlphabet({
  id: "preston-blair",
  label: "Preston Blair (10)",
  shapes: [
    shape("rest", "Rest", ["x"]), shape("MBP", "M B P"), shape("etc", "Etc (C D G K N R S T Y Z)"),
    shape("E", "E"), shape("AI", "A I"), shape("O", "O"), shape("U", "U"), shape("WQ", "W Q"),
    shape("FV", "F V"), shape("L", "L"),
  ],
  fromViseme: { X: "rest", MBP: "MBP", S: "etc", E: "E", AI: "AI", O: "O", U: "U", FV: "FV", L: "L" },
  fromPhoneme: { W: "WQ" },
  toViseme: { rest: "X", MBP: "MBP", etc: "S", E: "E", AI: "AI", O: "O", U: "U", WQ: "U", FV: "FV", L: "L" },
});

/** The twelve-shape studio chart: Blair's ten + TH and CH/J/SH apart. */
registerVisemeAlphabet({
  id: "disney-12",
  label: "Disney (12)",
  shapes: [
    shape("rest", "Rest", ["x"]), shape("MBP", "M B P"), shape("AI", "A I"), shape("E", "E"),
    shape("O", "O"), shape("U", "U"), shape("WQ", "W Q"), shape("FV", "F V"), shape("L", "L"),
    shape("TH", "Th"), shape("CHJSH", "Ch J Sh"), shape("etc", "Etc (C D G K N R S T Y Z)"),
  ],
  fromViseme: { X: "rest", MBP: "MBP", S: "etc", E: "E", AI: "AI", O: "O", U: "U", FV: "FV", L: "L" },
  fromPhoneme: { W: "WQ", TH: "TH", DH: "TH", CH: "CHJSH", JH: "CHJSH", SH: "CHJSH", ZH: "CHJSH" },
  toViseme: { rest: "X", MBP: "MBP", AI: "AI", E: "E", O: "O", U: "U", WQ: "U", FV: "FV", L: "L", TH: "L", CHJSH: "S", etc: "S" },
});

/** Oculus / Meta OVR LipSync's 15 (the set VRChat and most 3D avatars ship). */
registerVisemeAlphabet({
  id: "oculus",
  label: "Oculus / Meta (15)",
  shapes: [
    shape("sil", "Silence", ["rest", "x"]), shape("PP", "P B M"), shape("FF", "F V"), shape("TH", "Th"),
    shape("DD", "T D"), shape("kk", "K G"), shape("CH", "Ch J Sh"), shape("SS", "S Z"), shape("nn", "N L"),
    shape("RR", "R"), shape("aa", "A"), shape("E", "E"), shape("ih", "I"), shape("oh", "O"), shape("ou", "U"),
  ],
  fromViseme: { X: "sil", MBP: "PP", FV: "FF", L: "nn", S: "SS", E: "E", AI: "aa", O: "oh", U: "ou" },
  fromPhoneme: {
    SIL: "sil", P: "PP", B: "PP", M: "PP", F: "FF", V: "FF", TH: "TH", DH: "TH", T: "DD", D: "DD",
    K: "kk", G: "kk", NG: "kk", CH: "CH", JH: "CH", SH: "CH", ZH: "CH", S: "SS", Z: "SS", N: "nn", L: "nn",
    R: "RR", AA: "aa", AE: "aa", AH: "aa", AY: "aa", AW: "aa", EH: "E", EY: "E", ER: "E",
    IH: "ih", IY: "ih", Y: "ih", AO: "oh", OW: "oh", OY: "oh", UW: "ou", UH: "ou", W: "ou",
  },
  toViseme: {
    sil: "X", PP: "MBP", FF: "FV", TH: "L", DD: "S", kk: "S", CH: "S", SS: "S", nn: "L", RR: "S",
    aa: "AI", E: "E", ih: "E", oh: "O", ou: "U",
  },
});

// ── ARKit blendshape weights (3D faces, shape-key mouths) ─────────────────────

/** The ARKit / Apple face-tracking blendshapes a viseme moves. */
export const ARKIT_MOUTH_SHAPES = [
  "jawOpen", "mouthClose", "mouthFunnel", "mouthPucker", "mouthSmileLeft", "mouthSmileRight",
  "mouthStretchLeft", "mouthStretchRight", "mouthRollLower", "mouthRollUpper", "mouthShrugUpper",
  "mouthShrugLower", "mouthPressLeft", "mouthPressRight", "mouthLowerDownLeft", "mouthLowerDownRight",
  "mouthUpperUpLeft", "mouthUpperUpRight", "tongueOut",
] as const;
export type ArkitShape = (typeof ARKIT_MOUTH_SHAPES)[number];
export type ArkitWeights = Readonly<Partial<Record<ArkitShape, number>>>;

type Sided = "mouthSmile" | "mouthStretch" | "mouthPress" | "mouthLowerDown" | "mouthUpperUp";
const sym = <B extends Sided>(base: B, v: number) =>
  ({ [`${base}Left`]: v, [`${base}Right`]: v }) as Record<`${B}Left` | `${B}Right`, number>;

/**
 * Per-viseme ARKit weights, 0..1, symmetric. Tuned so a neutral ARKit head
 * (Ready Player Me, MetaHuman-to-ARKit, VRM perfect-sync) reads each viseme:
 * jaw carries openness, funnel/pucker carry rounding, press/roll carry the
 * closures. Omitted shapes are 0. Drive `jawOpen` additionally from
 * `loudness()` for emphasis — these are the shapes, not the performance.
 */
export const ARKIT_VISEME_WEIGHTS: Readonly<Record<VisemeId, ArkitWeights>> = {
  X: { jawOpen: 0.02 },
  MBP: { jawOpen: 0.04, mouthClose: 0.06, ...sym("mouthPress", 0.5), mouthRollLower: 0.3, mouthRollUpper: 0.2 },
  S: { jawOpen: 0.08, ...sym("mouthStretch", 0.3), ...sym("mouthSmile", 0.15), ...sym("mouthLowerDown", 0.2), ...sym("mouthUpperUp", 0.2) },
  E: { jawOpen: 0.2, ...sym("mouthSmile", 0.35), ...sym("mouthStretch", 0.35), ...sym("mouthLowerDown", 0.3), ...sym("mouthUpperUp", 0.25) },
  AI: { jawOpen: 0.6, ...sym("mouthLowerDown", 0.4), ...sym("mouthUpperUp", 0.2), ...sym("mouthStretch", 0.15) },
  O: { jawOpen: 0.4, mouthFunnel: 0.6, mouthPucker: 0.2 },
  U: { jawOpen: 0.12, mouthPucker: 0.85, mouthFunnel: 0.35 },
  FV: { jawOpen: 0.08, mouthRollLower: 0.55, ...sym("mouthUpperUp", 0.3), mouthShrugUpper: 0.15 },
  L: { jawOpen: 0.3, tongueOut: 0.25, ...sym("mouthLowerDown", 0.2), ...sym("mouthStretch", 0.1) },
};

/** A full weight vector for one viseme (every shape present, zeros filled). */
export function arkitWeights(viseme: VisemeId): Record<ArkitShape, number> {
  const out = {} as Record<ArkitShape, number>;
  const w = ARKIT_VISEME_WEIGHTS[viseme];
  for (const s of ARKIT_MOUTH_SHAPES) out[s] = w[s] ?? 0;
  return out;
}
