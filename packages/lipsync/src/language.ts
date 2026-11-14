import type { PhonemeToken } from "./phonemes";

/**
 * The LANGUAGE seam. A language turns text into ARPAbet phonemes (sounds
 * outside ARPAbet map to the nearest symbol — visemes are coarser than any
 * phoneme set). Registration is metadata; `load()` dynamic-imports the
 * dictionary and rules, so English costs nothing until a transcript needs it.
 */

/** A pause in the text and the intonation it implies. */
export type PauseMark = "," | "." | "?" | "!";

export type G2PToken =
  | {
      kind: "word";
      /** The spoken form ("forty" for part of "42"; the original word otherwise). */
      text: string;
      phonemes: PhonemeToken[];
      /** Where the pronunciation came from — "rules" means a guess. */
      source: "dict" | "morph" | "rules" | "spell";
    }
  | { kind: "pause"; mark: PauseMark };

export interface LanguageImpl {
  id: string;
  /** Normalise + tokenise + phonemise running text (numbers, punctuation, casing). */
  phonemize(text: string): G2PToken[];
  /** All phonemes of one written token as a transcriber returns it ("42" → forty two). */
  wordPhonemes(word: string): PhonemeToken[];
}

export interface Language {
  id: string;
  label: string;
  load(): Promise<LanguageImpl>;
}

const languages = new Map<string, Language>();
const loadedLanguages = new Map<string, Promise<LanguageImpl>>();

export function registerLanguage(lang: Language): void {
  languages.set(lang.id, lang);
  loadedLanguages.delete(lang.id);
}
export function listLanguages(): Language[] {
  return [...languages.values()];
}
/** Load a language (memoised). "en-US" falls back to "en". */
export function loadLanguage(id: string): Promise<LanguageImpl> {
  const lang = languages.get(id) ?? languages.get(id.split(/[-_]/)[0]!.toLowerCase());
  if (!lang) return Promise.reject(new Error(`No language "${id}"`));
  let p = loadedLanguages.get(lang.id);
  if (!p) {
    p = lang.load();
    loadedLanguages.set(lang.id, p);
    p.catch(() => loadedLanguages.delete(lang.id));
  }
  return p;
}
