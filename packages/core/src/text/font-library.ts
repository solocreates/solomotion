/**
 * THE FONT LIBRARY — what a family IS, as a browser sees it, whichever source
 * it came from.
 *
 * `font-faces` answers the renderer's question (which FACE draws this glyph).
 * This answers the chooser's: what families exist, what they feel like, which
 * weights and scripts they carry, and which of them match what you asked for.
 * The inspector's quick picker and the Fonts window are two sizes of one
 * browser, and both ask this module — so a filter, a sort or a weight count can
 * never mean one thing in the popover and another in the window.
 *
 * Sources are a union arm, not a code path. Google, the OS and your uploads
 * already arrive as the same `FontFamilyMeta`; a foundry catalogue added later
 * is one more arm in `FONT_SOURCES` plus a loader that produces this shape.
 * Nothing below branches on where a family came from.
 *
 * Pure data; no DOM. The catalogue JSON is fetched and parsed by the app.
 */

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

export type FontCategory = "sans" | "serif" | "display" | "hand" | "mono";

export const FONT_CATEGORIES: ReadonlyArray<{ id: FontCategory; label: string }> = [
  { id: "sans", label: "Sans" },
  { id: "serif", label: "Serif" },
  { id: "display", label: "Display" },
  { id: "hand", label: "Handwriting" },
  { id: "mono", label: "Mono" },
];

/**
 * Where a family's bytes come from. Also the order the picker lists them in:
 * your own files first, then the machine, then the catalogues.
 */
export type FontSourceId = "yours" | "system" | "google";

export const FONT_SOURCES: ReadonlyArray<{ id: FontSourceId; label: string }> = [
  { id: "yours", label: "Your fonts" },
  { id: "system", label: "On this device" },
  { id: "google", label: "Google Fonts" },
];

export interface FontFamilyMeta {
  family: string;
  source: FontSourceId;
  /** Null when nobody told us — an OS font or an upload has no classification. */
  category: FontCategory | null;
  /** Upright weights the family ships, ascending. Never empty. */
  weights: number[];
  /** Italic weights, ascending. Empty = no italic. */
  italics: number[];
  /** The `wght` axis, when the family is variable on it. */
  variable: { min: number; max: number } | null;
  /** Other registered axes (`wdth`, `opsz`, `slnt`, …). */
  axes: string[];
  /** Writing systems (Google subset ids: `latin`, `arabic`, `japanese`, …). */
  scripts: string[];
  /** Google's "feeling" scores above the bar — Playful, Calm, Business, … */
  feelings: string[];
  /** Style classifications — Geometric, Didone, Handwritten, Pixel, … */
  styles: string[];
  designer: string | null;
  year: number | null;
  /**
   * Popularity rank; lower is more used. Your uploads rank first (-1); an OS
   * family Google does not know ranks after the whole catalogue.
   */
  popularity: number;
  trending: number;
}

/* -------------------------------------------------------------------------- */
/* The packed catalogue                                                        */
/* -------------------------------------------------------------------------- */

const CATEGORY_BY_INDEX: FontCategory[] = ["sans", "serif", "display", "hand", "mono"];

/**
 * Row layout of `scripts/fonts/build-google-catalog.mjs`:
 *
 *   [family, category, upright digits, italic digits, wghtMin, wghtMax,
 *    otherAxes, scriptIdx[], tagIdx[], designerIdx, yearAdded, trendingRank]
 *
 * Weights are hundreds as digits ("1345789"), `wghtMin/Max` are 0 for a
 * static family, and a tag is `f:` (feeling) or `s:` (style) plus its name.
 * Rows arrive in popularity order, which is what `popularity` records.
 */
type PackedRow = [string, number, string, string, number, number, string, number[], number[], number, number, number];

interface PackedCatalog {
  v: 1;
  scripts: string[];
  tags: string[];
  designers: string[];
  fonts: PackedRow[];
}

const digits = (s: string) => [...s].map((c) => Number(c) * 100);

export function decodeFontCatalog(json: string, source: FontSourceId = "google"): FontFamilyMeta[] {
  const cat = JSON.parse(json) as PackedCatalog;
  return cat.fonts.map((row, i) => {
    const [family, category, up, it, min, max, axes, scripts, tagIds, designer, year, trending] = row;
    const tags = tagIds.map((t) => cat.tags[t]!);
    const italics = digits(it);
    const weights = digits(up);
    return {
      family,
      source,
      category: CATEGORY_BY_INDEX[category] ?? null,
      // An italic-only family still draws at SOME weight; report those, so
      // nothing downstream has to special-case an empty ladder.
      weights: weights.length > 0 ? weights : italics.length > 0 ? italics : [400],
      italics,
      variable: max > min ? { min, max } : null,
      axes: axes ? axes.split(",") : [],
      scripts: scripts.map((s) => cat.scripts[s]!),
      feelings: tags.filter((t) => t.startsWith("f:")).map((t) => t.slice(2)),
      styles: tags.filter((t) => t.startsWith("s:")).map((t) => t.slice(2)),
      designer: designer >= 0 ? (cat.designers[designer] ?? null) : null,
      year: year || null,
      popularity: i,
      trending,
    };
  });
}

/** Where a family nobody ranked sorts: after every ranked one. */
export const UNRANKED = 1_000_000;

/**
 * A family we only know by the faces it has — an upload, an OS family. Weights
 * default to a plain Regular until the faces say otherwise.
 */
export function localFamilyMeta(
  family: string,
  source: FontSourceId,
  faces: ReadonlyArray<{ weight: number; italic: boolean }>,
): FontFamilyMeta {
  const uniq = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);
  const weights = uniq(faces.filter((f) => !f.italic).map((f) => f.weight));
  const italics = uniq(faces.filter((f) => f.italic).map((f) => f.weight));
  return {
    family,
    source,
    category: null,
    weights: weights.length > 0 ? weights : italics.length > 0 ? italics : [400],
    italics,
    variable: null,
    axes: [],
    scripts: [],
    feelings: [],
    styles: [],
    designer: null,
    year: null,
    popularity: source === "yours" ? -1 : UNRANKED,
    trending: 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Weights                                                                     */
/* -------------------------------------------------------------------------- */

/** How many faces — what Google calls "styles". A variable family counts as its named instances. */
export function styleCount(meta: FontFamilyMeta): number {
  return meta.weights.length + meta.italics.length;
}

/** Lightest and heaviest weight the family can draw. */
export function weightRange(meta: FontFamilyMeta): { min: number; max: number } {
  if (meta.variable) return meta.variable;
  return { min: meta.weights[0] ?? 400, max: meta.weights[meta.weights.length - 1] ?? 400 };
}

/**
 * The weight this family will ACTUALLY draw for `want`: any value on a
 * variable axis, else the closest shipped weight (ties go heavier, which is
 * what CSS matching does above 500 and what a person asking for "bolder"
 * expects).
 */
export function drawableWeight(meta: FontFamilyMeta, want: number, italic = false): number {
  if (meta.variable) return Math.round(Math.min(meta.variable.max, Math.max(meta.variable.min, want)));
  const ladder = italic && meta.italics.length > 0 ? meta.italics : meta.weights;
  let best = ladder[0] ?? 400;
  for (const w of ladder) {
    if (Math.abs(w - want) < Math.abs(best - want) || (Math.abs(w - want) === Math.abs(best - want) && w > best)) best = w;
  }
  return best;
}

/**
 * The weights a chooser offers: every shipped weight, and on a variable axis
 * every hundred inside it (a 100–900 axis ships named instances at each).
 */
export function offeredWeights(meta: FontFamilyMeta): number[] {
  if (!meta.variable) return meta.weights;
  const out: number[] = [];
  for (let w = Math.ceil(meta.variable.min / 100) * 100; w <= meta.variable.max; w += 100) out.push(w);
  return out.length > 0 ? out : meta.weights;
}

export const WEIGHT_NAMES: Readonly<Record<number, string>> = {
  100: "Thin",
  200: "ExtraLight",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "SemiBold",
  700: "Bold",
  800: "ExtraBold",
  900: "Black",
};

export function weightName(w: number): string {
  return WEIGHT_NAMES[w] ?? String(w);
}

/* -------------------------------------------------------------------------- */
/* Scripts                                                                     */
/* -------------------------------------------------------------------------- */

const SCRIPT_LABELS: Readonly<Record<string, string>> = {
  latin: "Latin",
  cyrillic: "Cyrillic",
  greek: "Greek",
  arabic: "Arabic",
  hebrew: "Hebrew",
  devanagari: "Devanagari",
  bengali: "Bengali",
  tamil: "Tamil",
  telugu: "Telugu",
  thai: "Thai",
  khmer: "Khmer",
  japanese: "Japanese",
  korean: "Korean",
  "chinese-simplified": "Chinese (Simplified)",
  "chinese-traditional": "Chinese (Traditional)",
  "chinese-hongkong": "Chinese (Hong Kong)",
};

export function scriptLabel(id: string): string {
  return SCRIPT_LABELS[id] ?? id.split("-").map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
}

/**
 * A line of real text in each script, for families that cannot draw their own
 * name — a Japanese face asked to set "Noto Sans JP" draws Latin fallback,
 * which previews nothing.
 */
const SCRIPT_SAMPLES: Readonly<Record<string, string>> = {
  arabic: "الخط العربي جميل",
  hebrew: "אבגד הוזח טיכל",
  devanagari: "सभी मनुष्य स्वतंत्र",
  bengali: "সকল মানুষ স্বাধীন",
  tamil: "அனைத்து மனிதர்களும்",
  telugu: "ప్రతిపత్తిస్వత్వముల",
  thai: "มนุษย์ทั้งหลายเกิดมา",
  khmer: "មនុស្សទាំងអស់",
  japanese: "あいうえお 日本語",
  korean: "모든 인간은 태어날",
  "chinese-simplified": "人人生而自由",
  "chinese-traditional": "人人生而自由",
  "chinese-hongkong": "人人生而自由",
  cyrillic: "Съешь же ещё",
  greek: "Όλοι οι άνθρωποι",
};

/** True when the family can set Latin — i.e. its own name is a fair specimen. */
export function drawsLatin(meta: FontFamilyMeta): boolean {
  return meta.scripts.length === 0 || meta.scripts.includes("latin");
}

/**
 * What to set in a family by default: your text when you typed some, the
 * script you are filtering by, else its own native script, else nothing
 * (the caller shows the name).
 */
export function nativeSample(meta: FontFamilyMeta, script?: string | null): string | null {
  if (script && script !== "latin" && meta.scripts.includes(script)) return SCRIPT_SAMPLES[script] ?? null;
  if (drawsLatin(meta)) return null;
  for (const s of meta.scripts) if (SCRIPT_SAMPLES[s]) return SCRIPT_SAMPLES[s]!;
  return null;
}

/* -------------------------------------------------------------------------- */
/* Query                                                                       */
/* -------------------------------------------------------------------------- */

export type FontSort = "popular" | "trending" | "newest" | "name";

export interface FontQuery {
  /** Words; every one must match the name, designer, category, feeling or style. */
  text?: string;
  sources?: readonly FontSourceId[];
  categories?: readonly FontCategory[];
  /** ALL of these feelings (a font that is Playful AND Cute). */
  feelings?: readonly string[];
  styles?: readonly string[];
  script?: string | null;
  /** Only families that can draw this weight for real (a variable axis counts). */
  weight?: number | null;
  variableOnly?: boolean;
  italicOnly?: boolean;
  sort?: FontSort;
}

function canDraw(meta: FontFamilyMeta, w: number): boolean {
  if (meta.variable) return w >= meta.variable.min && w <= meta.variable.max;
  return meta.weights.includes(w);
}

const categoryLabel = (c: FontCategory | null) => FONT_CATEGORIES.find((x) => x.id === c)?.label ?? "";

function haystack(meta: FontFamilyMeta): string {
  return [meta.family, meta.designer ?? "", categoryLabel(meta.category), ...meta.feelings, ...meta.styles]
    .join(" ")
    .toLowerCase();
}

/**
 * Filter and order a family list. Name matches outrank tag matches, and a name
 * that STARTS with what you typed outranks one that merely contains it — so
 * "mono" puts Monoton and Monomakh above every font that happens to be
 * monospaced, and "inter" finds Inter before Inter Tight before Winter.
 */
export function queryFonts(list: readonly FontFamilyMeta[], q: FontQuery): FontFamilyMeta[] {
  const words = (q.text ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const phrase = words.join(" ");
  const sources = q.sources?.length ? new Set(q.sources) : null;
  const categories = q.categories?.length ? new Set(q.categories) : null;

  const scored: Array<{ meta: FontFamilyMeta; rank: number }> = [];
  for (const meta of list) {
    if (sources && !sources.has(meta.source)) continue;
    if (categories && (!meta.category || !categories.has(meta.category))) continue;
    if (q.feelings?.length && !q.feelings.every((f) => meta.feelings.includes(f))) continue;
    if (q.styles?.length && !q.styles.every((s) => meta.styles.includes(s))) continue;
    if (q.script && !meta.scripts.includes(q.script)) continue;
    if (q.weight != null && !canDraw(meta, q.weight)) continue;
    if (q.variableOnly && !meta.variable) continue;
    if (q.italicOnly && meta.italics.length === 0) continue;
    let rank = 0;
    if (words.length > 0) {
      const name = meta.family.toLowerCase();
      if (name === phrase) rank = 0;
      else if (name.startsWith(phrase)) rank = 1;
      else if (name.includes(phrase)) rank = 2;
      else {
        const hay = haystack(meta);
        if (!words.every((w) => hay.includes(w))) continue;
        rank = 3;
      }
    }
    scored.push({ meta, rank });
  }

  const sort = q.sort ?? "popular";
  const order = (a: FontFamilyMeta, b: FontFamilyMeta): number => {
    if (sort === "name") return a.family.localeCompare(b.family);
    if (sort === "newest") return (b.year ?? 0) - (a.year ?? 0) || a.popularity - b.popularity;
    if (sort === "trending") return (a.trending || Infinity) - (b.trending || Infinity) || a.popularity - b.popularity;
    return a.popularity - b.popularity || a.family.localeCompare(b.family);
  };
  scored.sort((a, b) => a.rank - b.rank || order(a.meta, b.meta));
  return scored.map((s) => s.meta);
}

/**
 * How many families carry each value of a facet, across `list` — the numbers
 * beside every filter, so a chip that would empty the list says so first.
 */
export function facetCounts(
  list: readonly FontFamilyMeta[],
  facet: "feelings" | "styles" | "scripts" | "category",
): Map<string, number> {
  const out = new Map<string, number>();
  for (const meta of list) {
    const values = facet === "category" ? (meta.category ? [meta.category] : []) : meta[facet];
    for (const v of values) out.set(v, (out.get(v) ?? 0) + 1);
  }
  return out;
}
