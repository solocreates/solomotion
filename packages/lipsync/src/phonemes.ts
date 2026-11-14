import type { VisemeId } from "./visemes";

/**
 * The PHONEME layer — ARPAbet, the 39-symbol alphabet of CMUdict, which every
 * English G2P, forced aligner and most phoneme models speak. A language that
 * needs sounds outside it maps them to the nearest ARPAbet symbol: visemes are
 * far coarser than phonemes, so the mouth never notices.
 *
 * Phonemes are what engines REASON in (timing weights, coarticulation, the
 * Test Voice's formant targets); visemes are what mouths SHOW. `PHONEMES[p]`
 * is the one table joining the two.
 */

export const ARPABET = [
  // vowels
  "AA", "AE", "AH", "AO", "AW", "AY", "EH", "ER", "EY", "IH", "IY", "OW", "OY", "UH", "UW",
  // consonants
  "B", "CH", "D", "DH", "F", "G", "HH", "JH", "K", "L", "M", "N", "NG", "P", "R", "S", "SH",
  "T", "TH", "V", "W", "Y", "Z", "ZH",
] as const;
export type Phoneme = (typeof ARPABET)[number];

/** Silence on a phoneme timeline (pauses, leading/trailing room tone). */
export const SILENCE = "SIL" as const;
export type PhonemeOrSilence = Phoneme | typeof SILENCE;

/** CMUdict stress: 0 unstressed, 1 primary, 2 secondary. Vowels only. */
export type Stress = 0 | 1 | 2;

export type PhonemeClass =
  | "vowel"
  | "diphthong"
  | "stop"
  | "affricate"
  | "fricative"
  | "aspirate"
  | "nasal"
  | "liquid"
  | "glide";

export interface PhonemeInfo {
  id: Phoneme;
  class: PhonemeClass;
  voiced: boolean;
  /** The mouth shape (for a diphthong, where it STARTS). */
  viseme: VisemeId;
  /** Diphthongs only: the shape the glide ends on. */
  glide?: VisemeId;
  /**
   * "Transparent" phonemes take the mouth of the sound after them — an H is
   * breathed through the vowel's lips ("who" is round from the start).
   */
  transparent?: boolean;
  /** Relative duration weight inside a word (≈ mean ms in conversational English). */
  weight: number;
  ipa: string;
  example: string;
}

const P = (
  id: Phoneme,
  cls: PhonemeClass,
  voiced: boolean,
  viseme: VisemeId,
  weight: number,
  ipa: string,
  example: string,
  extra: Partial<PhonemeInfo> = {},
): PhonemeInfo => ({ id, class: cls, voiced, viseme, weight, ipa, example, ...extra });

/**
 * Viseme choices follow the Preston Blair / Papagayo convention the canonical
 * set descends from (`S` doubles as the generic "teeth together" consonant
 * shape — Blair's "etc", Rhubarb's B), with two deliberate refinements: IH and
 * Y take the spread `E` (Blair's chart opens them to AI, which reads as
 * shouting), and TH/DH take `L` (tongue visible at the teeth).
 */
export const PHONEMES: Record<Phoneme, PhonemeInfo> = {
  AA: P("AA", "vowel", true, "AI", 120, "ɑ", "father"),
  AE: P("AE", "vowel", true, "AI", 120, "æ", "cat"),
  AH: P("AH", "vowel", true, "AI", 75, "ʌ", "but"),
  AO: P("AO", "vowel", true, "O", 120, "ɔ", "law"),
  AW: P("AW", "diphthong", true, "AI", 150, "aʊ", "cow", { glide: "U" }),
  AY: P("AY", "diphthong", true, "AI", 150, "aɪ", "eye", { glide: "E" }),
  EH: P("EH", "vowel", true, "E", 85, "ɛ", "bed"),
  ER: P("ER", "vowel", true, "E", 110, "ɝ", "bird"),
  EY: P("EY", "diphthong", true, "E", 130, "eɪ", "say"),
  IH: P("IH", "vowel", true, "E", 70, "ɪ", "sit"),
  IY: P("IY", "vowel", true, "E", 105, "i", "bee"),
  OW: P("OW", "diphthong", true, "O", 130, "oʊ", "go", { glide: "U" }),
  OY: P("OY", "diphthong", true, "O", 150, "ɔɪ", "boy", { glide: "E" }),
  UH: P("UH", "vowel", true, "U", 70, "ʊ", "book"),
  UW: P("UW", "vowel", true, "U", 105, "u", "you"),
  B: P("B", "stop", true, "MBP", 60, "b", "bat"),
  CH: P("CH", "affricate", false, "S", 90, "tʃ", "chip"),
  D: P("D", "stop", true, "S", 50, "d", "dog"),
  DH: P("DH", "fricative", true, "L", 40, "ð", "this"),
  F: P("F", "fricative", false, "FV", 90, "f", "fan"),
  G: P("G", "stop", true, "S", 60, "ɡ", "go"),
  HH: P("HH", "aspirate", false, "S", 55, "h", "hat", { transparent: true }),
  JH: P("JH", "affricate", true, "S", 80, "dʒ", "jam"),
  K: P("K", "stop", false, "S", 70, "k", "cat"),
  L: P("L", "liquid", true, "L", 60, "l", "love"),
  M: P("M", "nasal", true, "MBP", 70, "m", "mom"),
  N: P("N", "nasal", true, "S", 60, "n", "no"),
  NG: P("NG", "nasal", true, "S", 70, "ŋ", "sing"),
  P: P("P", "stop", false, "MBP", 70, "p", "pat"),
  R: P("R", "liquid", true, "S", 60, "ɹ", "red"),
  S: P("S", "fricative", false, "S", 100, "s", "sea"),
  SH: P("SH", "fricative", false, "S", 100, "ʃ", "she"),
  T: P("T", "stop", false, "S", 60, "t", "top"),
  TH: P("TH", "fricative", false, "L", 80, "θ", "thin"),
  V: P("V", "fricative", true, "FV", 60, "v", "van"),
  W: P("W", "glide", true, "U", 60, "w", "we"),
  Y: P("Y", "glide", true, "E", 50, "j", "yes"),
  Z: P("Z", "fricative", true, "S", 80, "z", "zoo"),
  ZH: P("ZH", "fricative", true, "S", 80, "ʒ", "vision"),
};

export function isPhoneme(s: string): s is Phoneme {
  return Object.prototype.hasOwnProperty.call(PHONEMES, s);
}

export function isVowel(p: Phoneme): boolean {
  const c = PHONEMES[p].class;
  return c === "vowel" || c === "diphthong";
}

/** One phoneme of a pronunciation (no time yet). */
export interface PhonemeToken {
  phoneme: Phoneme;
  /** Vowels only. */
  stress?: Stress;
}

/** A phoneme placed in time — what aligners, AI models and the Test Voice emit. */
export interface TimedPhoneme {
  phoneme: PhonemeOrSilence;
  startMs: number;
  endMs: number;
  stress?: Stress;
}

/**
 * Duration weight of a phoneme inside its word: the class mean, stretched for
 * a stressed vowel and squeezed for an unstressed one (a schwa is short).
 */
export function phonemeWeight(t: PhonemeToken): number {
  const info = PHONEMES[t.phoneme];
  if (info.class !== "vowel" && info.class !== "diphthong") return info.weight;
  const s = t.stress ?? 1;
  return info.weight * (s === 1 ? 1.15 : s === 2 ? 1 : 0.65);
}

/** The viseme a phoneme shows (a diphthong's starting shape). */
export function phonemeToViseme(p: PhonemeOrSilence): VisemeId {
  return p === SILENCE ? "X" : PHONEMES[p].viseme;
}

// ── Parsing what other tools say ──────────────────────────────────────────────

/**
 * Parse one ARPAbet symbol as CMUdict, aligners and phoneme models print it:
 * any case, stress digit optional ("ah0", "AH1"), silence spelled any common
 * way ("sil", "sp", "spn", "pau", "" ). Null when it is not ARPAbet.
 */
export function parseArpabet(raw: string): { phoneme: PhonemeOrSilence; stress?: Stress } | null {
  const s = raw.trim().toUpperCase();
  if (s === "" || s === "SIL" || s === "SP" || s === "SPN" || s === "PAU" || s === "<SIL>" || s === "H#") {
    return { phoneme: SILENCE };
  }
  const m = /^([A-Z]{1,2})([012])?$/.exec(s);
  if (!m) return null;
  const sym = m[1]!;
  // Common aliases from older ARPAbet variants (TIMIT, NRL).
  const alias: Record<string, Phoneme> = { AX: "AH", AXR: "ER", IX: "IH", UX: "UW", DX: "D", NX: "N", EL: "L", EM: "M", EN: "N", WH: "W", HV: "HH", Q: "T" };
  const p = isPhoneme(sym) ? sym : alias[sym];
  if (!p) return null;
  const stress = m[2] !== undefined ? (Number(m[2]) as Stress) : sym === "AX" ? 0 : undefined;
  return stress !== undefined && isVowel(p) ? { phoneme: p, stress } : { phoneme: p };
}

/**
 * IPA → ARPAbet, longest symbol first, so phoneme models that print IPA
 * (wav2vec2-phoneme, Allosaurus, espeak) plug into the same timeline. Length
 * marks, stress marks and tie bars are dropped; unknown symbols return null.
 */
const IPA_TABLE: [string, Phoneme, Stress?][] = [
  ["t͡ʃ", "CH"], ["d͡ʒ", "JH"], ["tʃ", "CH"], ["dʒ", "JH"],
  ["aɪ", "AY"], ["aʊ", "AW"], ["eɪ", "EY"], ["oʊ", "OW"], ["əʊ", "OW"], ["ɔɪ", "OY"],
  ["ɝ", "ER"], ["ɚ", "ER", 0], ["ər", "ER", 0], ["ɜr", "ER"], ["ɜ", "ER"],
  ["ɑ", "AA"], ["ɒ", "AA"], ["a", "AA"], ["æ", "AE"], ["ʌ", "AH"], ["ə", "AH", 0], ["ɐ", "AH", 0],
  ["ɔ", "AO"], ["ɛ", "EH"], ["e", "EY"], ["ɪ", "IH"], ["ɨ", "IH"], ["i", "IY"], ["o", "OW"],
  ["ʊ", "UH"], ["u", "UW"], ["ɯ", "UW"], ["y", "UW"], ["ø", "UH"], ["œ", "EH"],
  ["b", "B"], ["d", "D"], ["ð", "DH"], ["f", "F"], ["ɡ", "G"], ["g", "G"], ["h", "HH"], ["ɦ", "HH"],
  ["k", "K"], ["l", "L"], ["ɫ", "L"], ["m", "M"], ["n", "N"], ["ŋ", "NG"], ["p", "P"],
  ["ɹ", "R"], ["r", "R"], ["ɾ", "D"], ["ʁ", "R"], ["s", "S"], ["ʃ", "SH"], ["t", "T"], ["θ", "TH"],
  ["v", "V"], ["w", "W"], ["j", "Y"], ["z", "Z"], ["ʒ", "ZH"], ["x", "HH"], ["ʔ", "T"], ["ç", "HH"],
];

export function ipaToArpabet(ipa: string): PhonemeToken[] | null {
  const s = ipa.normalize("NFC").replace(/[ˈˌːˑ‿.\s]/g, "");
  const out: PhonemeToken[] = [];
  outer: for (let i = 0; i < s.length; ) {
    for (const [sym, p, stress] of IPA_TABLE) {
      if (s.startsWith(sym, i)) {
        out.push(stress !== undefined ? { phoneme: p, stress } : isVowel(p) ? { phoneme: p, stress: 1 } : { phoneme: p });
        i += sym.length;
        continue outer;
      }
    }
    // A combining diacritic we don't model (nasalisation, aspiration…): skip it.
    if (/[̀-ͯʰ-˿]/.test(s[i]!)) { i++; continue; }
    return null;
  }
  return out;
}
