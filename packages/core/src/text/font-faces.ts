/**
 * WHAT A FONT ACTUALLY IS: a family plus a set of FACES.
 *
 * Every font surface in the app had been keyed by FAMILY ALONE — one uploaded
 * blob per family, one embedded blob per system family, one cache entry per
 * family in the outliner. A family is not a font. "Inter" is nine weights and
 * their italics, and collapsing them is not a missing feature, it is three
 * separate wrong answers:
 *
 *   registering ONE `FontFace("Helvetica", regularBytes)` SHADOWS the installed
 *   family, so the browser stops matching the OS's real Bold and synthesises a
 *   smeared one instead — embedding a system font made it look WORSE
 *
 *   the outliner caches by `family|weight|italic` but resolved bytes by family,
 *   so every export of bold text outlined the REGULAR face, silently
 *
 *   an upload was named from its FILE NAME, so `Inter-Bold.otf` became a family
 *   called "Inter Bold" that no weight dropdown could ever reach
 *
 * So this module is the one place that knows how faces are named, keyed and
 * chosen. It is pure arithmetic over strings and numbers — no DOM, no canvas,
 * no font binary — so the editor, the exporter and a test all resolve a face
 * identically.
 */

import type { MotionDocument } from "../schema/document";
import type { Clip, KeyframeTrack } from "../schema";
import { resolveFontFamily } from "../variables";
import { CAPTION_STATES } from "../schema/clips";
import { layersDrawnBy } from "../io/slice";

/** The two axes every host can express: CSS `font-weight` and `font-style`. */
export interface FaceStyle {
  /** CSS weight, 100–1000. */
  weight: number;
  italic: boolean;
}

/** A face, identified. `family` is the CSS family the face belongs to. */
export interface FaceId extends FaceStyle {
  family: string;
}

/**
 * The named weight ladder, as the type industry actually spells it.
 *
 * Ordered longest-first at the match site so "Extra Light" wins over "Light"
 * and "Semibold" over "Bold" — the substring trap that turns a 600 into a 700
 * and a 200 into a 300.
 */
const WEIGHT_NAMES: readonly (readonly [string, number])[] = [
  ["extrablack", 950],
  ["ultrablack", 950],
  ["extrabold", 800],
  ["ultrabold", 800],
  ["extralight", 200],
  ["ultralight", 200],
  ["semibold", 600],
  ["demibold", 600],
  ["semilight", 350],
  ["black", 900],
  ["heavy", 900],
  ["medium", 500],
  ["normal", 400],
  ["regular", 400],
  ["light", 300],
  ["thin", 100],
  ["hairline", 100],
  ["book", 400],
  ["roman", 400],
  ["bold", 700],
];

const ITALIC_NAMES = ["italic", "oblique", "kursiv", "cursiva"];

/**
 * A face's style string — a `name` table subfamily, or what the Local Font
 * Access API reports — resolved to weight and italic.
 *
 * "Bold Italic", "SemiBold", "Condensed Extra Light Oblique", "W7", "700" all
 * arrive here, from every OS and foundry, which is exactly why the parsing
 * lives in one tested function rather than at each of the three call sites that
 * used to need it.
 */
export function parseFaceStyle(style: string): FaceStyle {
  const s = style.toLowerCase().replace(/[\s_-]+/g, "");
  const italic = ITALIC_NAMES.some((n) => s.includes(n));
  // A numeric weight is unambiguous and beats every name. Two spellings are in
  // the wild: the CSS number itself ("350", "W700"), and the Japanese foundry
  // grade ("W3", "W6") which is that number over a hundred.
  const num = /(?:^|[^0-9])(\d{3,4})(?:[^0-9]|$)/.exec(s);
  if (num && Number(num[1]) >= 100 && Number(num[1]) <= 1000) {
    return { weight: clampWeight(Number(num[1])), italic };
  }
  const grade = /(?:^|[^a-z0-9])w([1-9])(?:[^0-9]|$)/.exec(s);
  if (grade) return { weight: clampWeight(Number(grade[1]) * 100), italic };
  for (const [name, weight] of WEIGHT_NAMES) {
    if (s.includes(name)) return { weight, italic };
  }
  return { weight: 400, italic };
}

/** OpenType `OS/2.usWeightClass` is already a CSS weight — just out of range sometimes. */
export function clampWeight(weight: number): number {
  if (!Number.isFinite(weight)) return 400;
  return Math.min(1000, Math.max(1, Math.round(weight)));
}

/**
 * THE key a face is stored and cached under, everywhere.
 *
 * One string, one format. The outliner's cache, the custom-font database and
 * the system-font embed registry all use it, so "do we already have this face?"
 * cannot be answered two ways.
 */
export function faceKey(family: string, weight: number, italic: boolean): string {
  return `${family}|${clampWeight(weight)}|${italic ? 1 : 0}`;
}

/**
 * Pick the face closest to what was asked for — CSS font matching, minus the
 * parts (stretch, variation axes) this app has no UI for yet.
 *
 * Italic is decided first and absolutely: a real upright at the wrong weight is
 * a better answer than an italic the user did not ask for, and vice versa —
 * synthesising a slant is the host's job, and it can only do it if we hand it
 * an upright. Within a slant, CSS's own rule: at/under 400 prefer lighter and
 * fall back to heavier, above 500 prefer heavier and fall back to lighter, and
 * 400/500 try each other first. Ties break toward the smaller step.
 *
 * Returns null only for an empty list, so a caller that has ANY face always
 * gets one — a family that ships a single weight still renders.
 */
export function bestFace<T extends FaceStyle>(faces: readonly T[], want: FaceStyle): T | null {
  if (faces.length === 0) return null;
  const slant = faces.filter((f) => f.italic === want.italic);
  const pool = slant.length > 0 ? slant : faces;
  let best = pool[0]!;
  let bestScore = Infinity;
  for (const f of pool) {
    const score = weightDistance(f.weight, want.weight);
    if (score < bestScore) {
      best = f;
      bestScore = score;
    }
  }
  return best;
}

/**
 * How far `have` is from `want` under CSS's weight-matching preference, as a
 * single number small-is-better — so the caller is one `Math.min` and not a
 * three-branch search repeated per surface.
 *
 * The direction preference is encoded as a penalty an order of magnitude larger
 * than any in-direction distance (weights span 1000), so a preferred-direction
 * face always wins over a nearer one in the wrong direction.
 */
function weightDistance(have: number, want: number): number {
  const d = Math.abs(have - want);
  if (have === want) return 0;
  const preferHeavier = want >= 500 ? have > want : want > 400 ? have < want : have < want;
  // 400 and 500 are each other's first fallback before anything else.
  if ((want === 400 && have === 500) || (want === 500 && have === 400)) return 1;
  return d + (preferHeavier ? 0 : 10_000);
}

// ── What a document actually asks its host to load ───────────────────────────

/** One face a document renders, with the text it renders in it. */
export interface FontUse extends FaceId {
  /**
   * Every character drawn in this face — what a host needs to force-fetch the
   * right `unicode-range` subsets (Persian, CJK…) rather than the Latin default.
   */
  text: string;
}

/**
 * EVERY FACE A DOCUMENT RENDERS — the one walk, and the reason it exists.
 *
 * This question had two answers: `collectFontFamilies`, which the `.motion`
 * bundler used to decide which font files to ship, and an inline loop in the
 * stage that decided what to load for the canvas. They disagreed — the bundler
 * saw only base styles, so a caption whose focus word used a second family
 * shipped a project that opened without it — and being family-only, neither
 * could say which WEIGHT anything needed.
 *
 * One walk: base style, every range overlay, a caption's focus overlay, and
 * every KEYED value of a face axis (family, weight, italic — whole-layer and
 * range keys alike), each resolved through the variable layer so a bound
 * family is the family that renders. A key is a face the layer shows at some
 * instant; seeing only the resting style loaded the first family of a
 * keyframed font swap and drew every later key in a fallback. Pure; the
 * exporter and the stage share it.
 */
export function documentFontUsage(doc: MotionDocument, frameId?: string): FontUse[] {
  // One comp: what it and the comps it nests draw — a render of it waits for those, and names only those.
  return fontUsageOf(doc, frameId ? layersDrawnBy(doc, frameId) : doc.tracks.flatMap((t) => t.clips));
}

/** The same walk over some layers only — what one text layer needs to be measured. */
export function fontUsageOf(doc: MotionDocument, clips: Iterable<Clip>): FontUse[] {
  const byKey = new Map<string, FontUse>();
  const add = (family: string, weight: number, italic: boolean, text: string) => {
    const resolved = resolveFontFamily(doc, family);
    const key = faceKey(resolved, weight, italic);
    const hit = byKey.get(key);
    if (hit) {
      if (!hit.text.includes(text)) hit.text += text;
    } else byKey.set(key, { family: resolved, weight: clampWeight(weight), italic, text });
  };
  /** Every face in the product of three axes — which pairs meet depends on time, so all of them can. */
  const addAll = (axes: FaceAxes, text: string) => {
    for (const family of axes.families) {
      if (!family) continue;
      for (const weight of axes.weights) for (const italic of axes.italics) add(family, weight, italic, text);
    }
  };

  for (const clip of clips) {
    if (clip.kind !== "text") continue;
    const base = clip.style;
    // A bound value is a token until it is resolved, and only numbers and
    // booleans can be asked for here — a bound weight falls back to the base
    // face, which is the face the layer had before the binding existed.
    const layerKeys = clip.keyframes.filter((t) => !t.range);
    const layer: FaceAxes = {
      families: distinct([typeof base.fontFamily === "string" ? base.fontFamily : "", ...keyed(layerKeys, "fontFamily", isString)]),
      weights: distinct([typeof base.fontWeight === "number" ? base.fontWeight : 400, ...keyed(layerKeys, "fontWeight", isNumber)]),
      italics: distinct([base.italic === true, ...keyed(layerKeys, "italic", isBoolean)]),
    };
    // Keyed content is drawn too, and its characters pick the subsets.
    const text = distinct([clip.text, ...keyed(layerKeys, "text", isString)]).join("");
    addAll(layer, text);

    // An overlay changes ONE axis at a time, so an unset axis inherits the
    // layer's faces rather than silently resetting to 400 upright — which is
    // what makes "this word is a different family, same weight" load the
    // right file.
    const overlays = [
      ...clip.ranges.map((r) => r.overlay.props),
      ...(clip.caption ? CAPTION_STATES.map((st) => clip.caption!.states[st].overlay.props) : []),
    ];
    for (const props of overlays) {
      addAll(
        {
          families: typeof props.fontFamily === "string" ? [props.fontFamily] : layer.families,
          weights: typeof props.fontWeight === "number" ? [props.fontWeight] : layer.weights,
          italics: typeof props.italic === "boolean" ? [props.italic] : layer.italics,
        },
        text,
      );
    }

    // Range keys: an axis a range keys takes each keyed value, against every
    // face the rest of the layer (or an overlay on that span) can pair it with.
    const rangeKeys = clip.keyframes.filter((t) => t.range);
    if (rangeKeys.length) {
      const around: FaceAxes = {
        families: distinct([...layer.families, ...overlays.map((p) => p.fontFamily).filter(isString)]),
        weights: distinct([...layer.weights, ...overlays.map((p) => p.fontWeight).filter(isNumber)]),
        italics: distinct([...layer.italics, ...overlays.map((p) => p.italic).filter(isBoolean)]),
      };
      const families = keyed(rangeKeys, "fontFamily", isString);
      const weights = keyed(rangeKeys, "fontWeight", isNumber);
      const italics = keyed(rangeKeys, "italic", isBoolean);
      addAll(
        {
          families: families.length ? families : around.families,
          weights: weights.length ? distinct([...weights, ...around.weights]) : around.weights,
          italics: italics.length ? distinct([...italics, ...around.italics]) : around.italics,
        },
        text,
      );
    }
  }
  return [...byKey.values()];
}

interface FaceAxes {
  families: string[];
  weights: number[];
  italics: boolean[];
}

const isString = (v: unknown): v is string => typeof v === "string";
const isNumber = (v: unknown): v is number => typeof v === "number";
const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
const distinct = <T>(values: T[]): T[] => [...new Set(values)];

/** Every value keyed on `property` across these tracks that passes `is`. */
function keyed<T>(tracks: readonly KeyframeTrack[], property: string, is: (v: unknown) => v is T): T[] {
  const out: T[] = [];
  for (const t of tracks) {
    if (t.property !== property) continue;
    for (const k of t.keys) if (is(k.value)) out.push(k.value);
  }
  return out;
}

/**
 * Every font FAMILY a document renders — `documentFontUsage` collapsed.
 *
 * Kept because the `.motion` bundler genuinely asks a family-level question
 * ("which of the host's registered uploads travel with this project?"), and
 * because it is the shape that predates faces. It is now derived rather than
 * walked a second time, so it cannot drift from the face list again.
 */
export function collectFontFamilies(doc: MotionDocument): Set<string> {
  return new Set(documentFontUsage(doc).map((u) => u.family));
}
