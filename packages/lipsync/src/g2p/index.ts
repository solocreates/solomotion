/**
 * `@solomotion/lipsync/g2p` — English grapheme-to-phoneme (lazy entry).
 *
 * dictionary (CMUdict exceptions) → morphology over the dictionary (plurals,
 * possessives, -ed, -ing, -er, -ly, contractions, un-) → NRL letter-to-sound
 * rules for everything else. Text normalisation handles numbers (cardinals,
 * decimals, ordinals, years, decades, times, money, percent), symbols,
 * camelCase, acronyms and punctuation pauses.
 */
import type { G2PToken, LanguageImpl, PauseMark } from "../language";
import { parseArpabet, type Phoneme, type PhonemeToken } from "../phonemes";
import { DICT_SOURCE, LETTER_NAMES } from "./dict";
import { ruleWord } from "./rules";

export { ruleWord } from "./rules";

function parsePron(s: string): PhonemeToken[] {
  const out: PhonemeToken[] = [];
  for (const sym of s.trim().split(/\s+/)) {
    const p = parseArpabet(sym);
    if (p && p.phoneme !== "SIL") out.push(p.stress !== undefined ? { phoneme: p.phoneme, stress: p.stress } : { phoneme: p.phoneme });
  }
  return out;
}

let dict: Map<string, PhonemeToken[]> | null = null;
function dictionary(): Map<string, PhonemeToken[]> {
  if (!dict) {
    dict = new Map();
    for (const line of DICT_SOURCE.split("\n")) {
      const sp = line.indexOf(" ");
      if (sp > 0) dict.set(line.slice(0, sp), parsePron(line.slice(sp + 1)));
    }
  }
  return dict;
}

/** Dictionary only (lower-case key); null when unknown. */
export function lookup(word: string): PhonemeToken[] | null {
  return dictionary().get(word.toLowerCase().replace(/’/g, "'")) ?? null;
}

// ── Morphology ────────────────────────────────────────────────────────────────

const last = (ps: PhonemeToken[]): Phoneme | undefined => ps[ps.length - 1]?.phoneme;
const VOICELESS = new Set<Phoneme>(["P", "T", "K", "F", "TH"]);
const SIBILANT = new Set<Phoneme>(["S", "Z", "SH", "ZH", "CH", "JH"]);
const sSuffix = (base: PhonemeToken[]): PhonemeToken[] => {
  const l = last(base);
  if (l && SIBILANT.has(l)) return [...base, { phoneme: "IH", stress: 0 }, { phoneme: "Z" }];
  return [...base, { phoneme: l && VOICELESS.has(l) ? "S" : "Z" }];
};
const edSuffix = (base: PhonemeToken[]): PhonemeToken[] => {
  const l = last(base);
  if (l === "T" || l === "D") return [...base, { phoneme: "IH", stress: 0 }, { phoneme: "D" }];
  return [...base, { phoneme: l && (VOICELESS.has(l) || SIBILANT.has(l)) && l !== "Z" && l !== "ZH" && l !== "JH" ? "T" : "D" }];
};
const SUFFIXES: [string, string][] = [
  ["er", "ER0"], ["est", "AH0 S T"], ["ly", "L IY0"], ["ness", "N AH0 S"], ["ment", "M AH0 N T"],
  ["ful", "F AH0 L"], ["less", "L AH0 S"], ["ing", "IH0 NG"],
];

/** Stems a suffix may have eaten: walk·ed, mak(e)·ing, stop(p)·ed, happ(y)→i·ly. */
function stems(stem: string): string[] {
  const out = [stem, `${stem}e`];
  if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) out.push(stem.slice(0, -1));
  if (stem.endsWith("i")) out.push(`${stem.slice(0, -1)}y`);
  return out;
}

function morph(w: string): PhonemeToken[] | null {
  const find = (stem: string) => {
    for (const s of stems(stem)) {
      const hit = lookup(s);
      if (hit && s.length >= 2) return hit;
    }
    return null;
  };
  const tail = (suffix: string, build: (b: PhonemeToken[]) => PhonemeToken[]) => {
    if (!w.endsWith(suffix) || w.length <= suffix.length + 1) return null;
    const b = find(w.slice(0, -suffix.length));
    return b ? build(b) : null;
  };
  return (
    tail("n't", (b) => [...b, { phoneme: "AH", stress: 0 }, { phoneme: "N" }, { phoneme: "T" }]) ??
    tail("'s", sSuffix) ??
    tail("'ll", (b) => [...b, { phoneme: "L" }]) ??
    tail("'re", (b) => [...b, { phoneme: "ER", stress: 0 }]) ??
    tail("'ve", (b) => [...b, { phoneme: "V" }]) ??
    tail("'d", (b) => [...b, { phoneme: "D" }]) ??
    (w.endsWith("s'") ? morph(w.slice(0, -1)) : null) ??
    tail("ies", (b) => sSuffix(b)) ??
    (/(s|x|z|ch|sh)es$/.test(w) ? tail("es", sSuffix) : null) ??
    tail("s", sSuffix) ??
    tail("ed", edSuffix) ??
    SUFFIXES.reduce<PhonemeToken[] | null>((hit, [sfx, pron]) => hit ?? tail(sfx, (b) => [...b, ...parsePron(pron)]), null) ??
    (w.startsWith("un") && w.length > 4 && lookup(w.slice(2)) ? [{ phoneme: "AH", stress: 0 }, { phoneme: "N" }, ...lookup(w.slice(2))!] : null)
  );
}

// ── Numbers ───────────────────────────────────────────────────────────────────

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES: [number, string][] = [[1e12, "trillion"], [1e9, "billion"], [1e6, "million"], [1e3, "thousand"]];

/** A non-negative integer in words ("1,204" → one thousand two hundred four). */
export function numberWords(n: number): string[] {
  if (!Number.isFinite(n) || n < 0) return [];
  n = Math.floor(n);
  if (n < 20) return [ONES[n]!];
  if (n < 100) return n % 10 ? [TENS[Math.floor(n / 10)]!, ONES[n % 10]!] : [TENS[n / 10]!];
  if (n < 1000) return [ONES[Math.floor(n / 100)]!, "hundred", ...(n % 100 ? numberWords(n % 100) : [])];
  for (const [scale, name] of SCALES) {
    if (n >= scale) {
      const head = Math.floor(n / scale);
      const rest = n % scale;
      return [...numberWords(head), name, ...(rest ? numberWords(rest) : [])];
    }
  }
  return [];
}

/** 1999 → nineteen ninety nine; 2007 → two thousand seven; 2026 → twenty twenty six. */
function yearWords(n: number): string[] {
  if (n >= 2000 && n < 2010) return numberWords(n);
  const hi = Math.floor(n / 100);
  const lo = n % 100;
  if (lo === 0) return [...numberWords(hi), "hundred"];
  return [...numberWords(hi), ...(lo < 10 ? ["oh", ONES[lo]!] : numberWords(lo))];
}

const ORDINAL_IRREGULAR: Record<string, string> = { one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth" };
function ordinalize(words: string[]): string[] {
  const out = words.slice();
  const w = out[out.length - 1]!;
  out[out.length - 1] = ORDINAL_IRREGULAR[w] ?? (w.endsWith("y") ? `${w.slice(0, -1)}ieth` : `${w}th`);
  return out;
}

/** Spoken words for a numeric token, or null when it isn't one. */
export function expandNumber(token: string): string[] | null {
  let m = /^(\d+)(st|nd|rd|th)$/i.exec(token);
  if (m) return ordinalize(numberWords(Number(m[1])));
  m = /^(\d+0)'?s$/.exec(token);
  if (m) {
    const n = Number(m[1]);
    const w = n >= 1100 && n < 2100 && m[1]!.length === 4 ? yearWords(n) : numberWords(n);
    const l = w[w.length - 1]!;
    w[w.length - 1] = l.endsWith("y") ? `${l.slice(0, -1)}ies` : `${l}s`;
    return w;
  }
  m = /^(\d{1,2}):(\d{2})$/.exec(token);
  if (m) {
    const mins = Number(m[2]);
    return [...numberWords(Number(m[1])), ...(mins === 0 ? ["o'clock"] : mins < 10 ? ["oh", ONES[mins]!] : numberWords(mins))];
  }
  m = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/.exec(token);
  if (!m) return null;
  const intStr = m[1]!.replace(/,/g, "");
  const n = Number(intStr);
  const whole = !m[1]!.includes(",") && !m[2] && intStr.length === 4 && n >= 1100 && n < 2100 ? yearWords(n) : numberWords(n);
  if (!m[2]) return whole;
  return [...whole, "point", ...[...m[2]].map((d) => ONES[Number(d)]!)];
}

// ── Words and text ────────────────────────────────────────────────────────────

type Source = "dict" | "morph" | "rules" | "spell";

function spell(word: string): PhonemeToken[] {
  return [...word.toLowerCase()].flatMap((c) => (LETTER_NAMES[c] ? parsePron(LETTER_NAMES[c]!) : []));
}

/** One plain word (letters/apostrophes) → phonemes + where they came from. */
export function pronounce(raw: string, allCapsText = false): { phonemes: PhonemeToken[]; source: Source } {
  const word = raw.replace(/’/g, "'");
  const acro = /^([A-Z]{2,5})('?s)?$/.exec(word);
  if (acro && !allCapsText) {
    // "FBI", "AI", "TVs", "NASA's": spell short or vowelless all-caps words.
    const letters = acro[1]!;
    if (letters.length <= 3 || !/[AEIOUY]/.test(letters)) {
      const spelled = spell(letters);
      return { phonemes: acro[2] ? sSuffix(spelled) : spelled, source: "spell" };
    }
  }
  const letters = word.replace(/[^A-Za-z]/g, "");
  const w = word.toLowerCase();
  const hit = lookup(w);
  if (hit) return { phonemes: hit, source: "dict" };
  const m = morph(w);
  if (m) return { phonemes: m, source: "morph" };
  if (letters.length === 1) return { phonemes: parsePron(LETTER_NAMES[letters.toLowerCase()] ?? ""), source: "spell" };
  return { phonemes: ruleWord(w), source: "rules" };
}

const PAUSE: Record<string, PauseMark> = { ",": ",", ";": ",", ":": ",", "—": ",", "–": ",", "-": ",", ".": ".", "…": ".", "?": "?", "!": "!" };

/** Text with symbols spelled out: "$5" → "5 dollars", "50%" → "50 percent", "a&b" → "a and b". */
function normalizeSymbols(text: string): string {
  return text
    .replace(/\$(\d[\d,]*(?:\.\d+)?)/g, "$1 dollars")
    .replace(/(\d)\s*%/g, "$1 percent")
    .replace(/#(\d)/g, "number $1")
    .replace(/&/g, " and ")
    .replace(/\+/g, " plus ")
    .replace(/@/g, " at ")
    .replace(/(^|\s)-(\d)/g, "$1minus $2")
    .replace(/([A-Za-z0-9])-(?=[A-Za-z0-9])/g, "$1 ")
    .replace(/([a-z])([A-Z])/g, "$1 $2");
}

function phonemize(text: string): G2PToken[] {
  const norm = normalizeSymbols(text);
  const letters = norm.replace(/[^A-Za-z]/g, "");
  const allCaps = letters.length > 8 && letters === letters.toUpperCase();
  const out: G2PToken[] = [];
  for (const m of norm.matchAll(/\d{1,2}:\d{2}|\d+(?:,\d{3})*(?:\.\d+)?(?:st|nd|rd|th|'?s)?|[A-Za-z]+(?:['’][A-Za-z]+)*['’]?|[.!?,;:…—–-]+/g)) {
    const tok = m[0];
    if (/^[.!?,;:…—–-]+$/.test(tok)) {
      const mark = [...tok].map((c) => PAUSE[c]).find((p) => p === "?" || p === "!") ?? PAUSE[tok[0]!];
      if (mark) {
        const prev = out[out.length - 1];
        if (prev?.kind === "pause") { if (mark !== ",") prev.mark = mark; }
        else if (prev) out.push({ kind: "pause", mark });
      }
      continue;
    }
    const nums = expandNumber(tok.replace(/[’]/g, "'"));
    if (nums) {
      for (const w of nums) out.push({ kind: "word", text: w, ...pronounce(w) });
      continue;
    }
    out.push({ kind: "word", text: tok, ...pronounce(tok, allCaps) });
  }
  return out;
}

/** Every phoneme of one written token as a transcriber returns it ("42" → forty two, "GIF's"). */
export function wordPhonemes(word: string): PhonemeToken[] {
  return phonemize(word).flatMap((t) => (t.kind === "word" ? t.phonemes : []));
}

export const english: LanguageImpl = { id: "en", phonemize, wordPhonemes };
export { english as impl, phonemize };
