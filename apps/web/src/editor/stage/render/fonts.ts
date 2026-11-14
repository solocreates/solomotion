"use client";

/**
 * Font loading for the RENDERER: Google families by name (exact faces), and
 * locally registered font FACES — uploads and embedded system faces alike,
 * persisted in IndexedDB and re-registered on boot. Every successful load bumps
 * `fontsVersion` so canvas layout caches invalidate.
 *
 * A family is a set of faces, and `@solomotion/core`'s `font-faces` module owns
 * what that means (keys, style parsing, matching). This file is the browser
 * half: `FontFace` registration, IndexedDB, and the Google stylesheet dance.
 */

import { bestFace, clampWeight, faceKey, parseFaceStyle, shapeArabicGraphemes, type FaceStyle } from "@solomotion/core";
import { googleMeta, loadGoogleCatalog, googleCatalogLoaded } from "../../fonts/google-catalog";
import { FACE_STORE, LEGACY_STORE, idbDelete, idbGet, idbGetAll, idbPut } from "../../fonts/font-db";

/**
 * Families the app treats as the OS's even before the OS has been asked — the
 * web-safe trio every platform ships. Everything else the machine has arrives
 * through the Local Font Access query (`system-fonts.ts`).
 */
export const BUILTIN_SYSTEM_FAMILIES: readonly string[] = ["Arial", "Georgia", "Helvetica"];

let fontsVersionCounter = 0;
export function fontsVersion(): number {
  return fontsVersionCounter;
}

/**
 * WHICH FAMILIES each bump was about. A version alone says "some font landed",
 * and the stage could only answer that by throwing away every picture it held
 * — the frame cache and the layer cache, in either mode. The editor's own
 * chrome loads faces too (JetBrains Mono for a timecode, a dozen display faces
 * for the Library's text-look previews), each `loadingdone` bumped this, and
 * so pausing — when the panels redraw and a preview scrolls into view — purged
 * a cache the person had just built. Naming the families lets a consumer ask
 * "does anything I draw use one of these?" and keep everything when the answer
 * is no.
 */
type FontChange = ReadonlySet<string> | "all";
const changes: Array<{ version: number; families: FontChange }> = [];
const CHANGE_LOG = 64;
const familyKey = (family: string) => family.replace(/^["']|["']$/g, "").trim().toLowerCase();

function bumpFontsVersion(families: Iterable<string> | "all" = "all") {
  fontsVersionCounter += 1;
  changes.push({ version: fontsVersionCounter, families: families === "all" ? "all" : new Set([...families].map(familyKey)) });
  if (changes.length > CHANGE_LOG) changes.splice(0, changes.length - CHANGE_LOG);
  for (const l of fontListeners) l();
}

/**
 * The families (lower-cased) whose faces changed after `since`, or "all" when
 * a change could not say — or is too old to still be on record.
 */
export function fontFamiliesChangedSince(since: number): FontChange {
  if (since >= fontsVersionCounter) return new Set();
  const first = changes[0];
  if (!first || first.version > since + 1) return "all";
  const out = new Set<string>();
  for (const c of changes) {
    if (c.version <= since) continue;
    if (c.families === "all") return "all";
    for (const f of c.families) out.add(f);
  }
  return out;
}

/** True when a change touches a family in `used` (any case, quoted or not). */
export function fontChangeTouches(change: FontChange, used: Iterable<string>): boolean {
  if (change === "all") return true;
  if (change.size === 0) return false;
  for (const f of used) if (change.has(familyKey(f))) return true;
  return false;
}

/**
 * Signal that something font-shaped became available — a custom upload, a
 * finished web-font load, or a parsed OUTLINE font. The render loop cannot
 * await a font, so it paints what it can and repaints when this fires; without
 * it a glyph whose outline arrived late would keep its fallback until the next
 * unrelated redraw. Name the family when you know it.
 */
export function notifyFontsChanged(families?: Iterable<string>): void {
  bumpFontsVersion(families ?? "all");
}

/**
 * Subscribe to font PIXELS changing (new faces, finished loads) — the render
 * loop's signal. It fires on every face that finishes loading anywhere, which
 * is exactly right for a canvas and exactly wrong for a list: a browser that
 * re-rendered on it redrew a hundred rows per scroll. Lists subscribe to
 * `subscribeFontRegistry`, which fires only when the SET of local families
 * changes.
 */
const fontListeners = new Set<() => void>();
export function subscribeFonts(cb: () => void): () => void {
  fontListeners.add(cb);
  return () => void fontListeners.delete(cb);
}

const registryListeners = new Set<() => void>();
let registrySnapshot: readonly CustomFont[] = [];
/** Fires when a local face is added or removed — what the font browsers list. */
export function subscribeFontRegistry(cb: () => void): () => void {
  registryListeners.add(cb);
  return () => void registryListeners.delete(cb);
}
/** A stable snapshot of every local face, for `useSyncExternalStore`. */
export function fontRegistrySnapshot(): readonly CustomFont[] {
  return registrySnapshot;
}
function registryChanged(): void {
  registrySnapshot = customFonts;
  for (const l of [...registryListeners]) l();
}

// ── Loading fonts for real use ───────────────────────────────────────────────

/** Per family: the stylesheet, settled once it has loaded (or failed). */
const sheets = new Map<string, Promise<void>>();

/**
 * Per face, every CHARACTER already fetched for it.
 *
 * Google serves a face as many `unicode-range` files (latin, latin-ext,
 * cyrillic, arabic, …) and the browser fetches one only when something asks
 * for a character inside it. The DOM asks by rendering; a canvas never does.
 * So this loader has to ask, character by character, for whatever the canvas
 * will draw — and it used to remember what it had asked for by a coarse
 * SCRIPT bucket instead, with all of Latin and Latin-Extended in one. Once a
 * face had loaded for "Hello", a later "ł", "ő" or "ş" counted as already
 * loaded, its file was never fetched, and those letters were drawn in some
 * other font: the "a few letters come from another font" bug. Tracking the
 * characters themselves makes the question exact.
 */
const coveredChars = new Map<string, Set<string>>();
/** In flight per face — every document change re-asks, and a load takes longer than a keystroke. */
const loadingFaces = new Map<string, Promise<void>>();

/**
 * The characters the canvas will actually DRAW for `text` — not the text.
 *
 * Arabic and Persian are shaped into presentation forms (U+FExx) before they
 * are drawn (`arabic-shape`), and a display case transform can draw letters
 * the text does not contain. Asking the browser for the raw text loaded the
 * wrong glyphs: the inline editor (DOM, raw letters) showed the face while the
 * canvas beside it drew a fallback.
 */
function drawnChars(text: string): Set<string> {
  const chars = [...text];
  const out = new Set<string>();
  for (const c of chars) out.add(c);
  for (const c of text.toUpperCase()) out.add(c);
  for (const c of text.toLowerCase()) out.add(c);
  for (const c of shapeArabicGraphemes(chars)) for (const u of c) out.add(u);
  out.delete("\n");
  return out;
}

/**
 * The css2 axis spec for a family: its real axis RANGE when it is variable —
 * so 437 renders as 437, not as whichever named instance is nearest — else
 * the exact tuples it ships. A family the catalogue does not know gets a broad
 * guess (a missing weight is answered with the nearest one).
 */
function axisSpec(family: string): string {
  const meta = googleMeta(family);
  if (!meta) return "ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;1,400;1,700";
  if (meta.variable) {
    const r = `${meta.variable.min}..${meta.variable.max}`;
    return meta.italics.length > 0 ? `ital,wght@0,${r};1,${r}` : `wght@${r}`;
  }
  const tuples = [...meta.weights.map((w) => `0,${w}`), ...meta.italics.map((w) => `1,${w}`)];
  return `ital,wght@${tuples.join(";")}`;
}

export interface FontLoadRequest {
  /** The text that will be set — decides which script subsets are fetched. */
  text?: string;
  weight?: number;
  italic?: boolean;
}

/**
 * Make a face drawable on the canvas: the family's stylesheet (once), then the
 * EXACT face asked for.
 *
 * It used to load the stylesheet and probe 400, 600 and 700 whatever the text
 * used. A canvas does not fetch a face by drawing with it, so every other
 * weight — 800, 900, a light 300, any value on a variable axis — never loaded:
 * the heavy end of the weight menu drew the nearest face that HAD loaded, and
 * "from some weight up nothing gets thicker" was the result. The document walk
 * (`ensureDocumentFaces`) now names every face a layer renders, and this loads
 * precisely those.
 */
export function ensureFont(family: string, req: FontLoadRequest = {}): Promise<void> {
  if (typeof document === "undefined") return Promise.resolve();
  installFontLoadWatcher();
  if (isCustomFamily(family) || BUILTIN_SYSTEM_FAMILIES.includes(family)) return Promise.resolve();

  // The axis list comes from the catalogue: guessing it asks a single-weight
  // display font (Press Start 2P, Bangers) for weights it does not ship, and
  // Google answers that with an error, so the font never loads at all.
  if (!googleCatalogLoaded()) {
    return loadGoogleCatalog()
      .catch(() => null)
      .then(() => ensureFont(family, req));
  }
  // Not in the catalogue means Google does not have it — an OS family the
  // query has not reported yet, a family from someone else's machine. Asking
  // anyway is a guaranteed 400, once per document change.
  if (!googleMeta(family)) return Promise.resolve();

  let sheet = sheets.get(family);
  if (!sheet) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?family=${family.trim().replace(/\s+/g, "+")}:${axisSpec(family)}&display=swap`;
    // Faces can only be asked for once their @font-face rules exist. The old
    // loader asked immediately and checked afterwards, so the first request
    // for a face usually found nothing and waited for the NEXT edit to retry.
    sheet = new Promise<void>((resolve) => {
      link.onload = () => resolve();
      link.onerror = () => resolve();
    });
    sheets.set(family, sheet);
    document.head.appendChild(link);
  }

  const weight = Math.round(req.weight ?? 400);
  const italic = req.italic ?? false;
  const key = faceKey(family, weight, italic);
  const covered = coveredChars.get(key) ?? new Set<string>();
  coveredChars.set(key, covered);
  // At least the Latin basics, so a face asked for with no text yet (a hover
  // preview) still lands its primary file.
  const want = drawnChars(req.text || "Aa");
  const missing = [...want].filter((c) => !covered.has(c)).join("");
  const pending = loadingFaces.get(key);
  if (!missing) return pending ?? Promise.resolve();
  for (const c of missing) covered.add(c);
  const spec = `${italic ? "italic " : ""}${weight} 24px "${family}"`;
  const load = (pending ?? Promise.resolve())
    .then(() => sheet)
    .then(() => document.fonts.load(spec, missing))
    .then(
      () => bumpFontsVersion([family]),
      // A failed fetch un-covers what it asked for, so the next change retries.
      () => {
        for (const c of missing) covered.delete(c);
      },
    )
    .finally(() => {
      if (loadingFaces.get(key) === load) loadingFaces.delete(key);
    });
  loadingFaces.set(key, load);
  return load;
}

/**
 * Can the canvas draw `text` in this face RIGHT NOW, or would it fall back?
 *
 * A canvas never waits for a face: it draws in whatever is loaded. So a render
 * that must be true to the document — `view.render`, every export — asks this
 * after waiting (`documentFacesReady`), and reports the faces that still fail
 * instead of shipping a fallback silently. Faces this loader does not fetch
 * (uploads, the OS's own, the built-in trio) are as ready as they will get.
 */
export function faceDrawable(family: string, req: FontLoadRequest = {}): boolean {
  if (typeof document === "undefined" || !document.fonts) return true;
  if (isCustomFamily(family) || BUILTIN_SYSTEM_FAMILIES.includes(family)) return true;
  if (!googleCatalogLoaded()) return true;
  // Not a family this loader fetches: the machine has it, or nothing does.
  if (!googleMeta(family)) return familyResolves(family);
  const spec = `${req.italic ? "italic " : ""}${Math.round(req.weight ?? 400)} 24px "${family}"`;
  try {
    return document.fonts.check(spec, [...drawnChars(req.text || "Aa")].join(""));
  } catch {
    return true;
  }
}

/** CSS's own families: always something to draw with, never a name to look up. */
const GENERIC_FAMILIES = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "emoji", "math", "fangsong"]);
const PROBE_TEXT = "mmmmmmmmmmlli10WQ@ابپ";
let probeCtx: CanvasRenderingContext2D | null | undefined;

/**
 * Does ANY face answer to this family here — one the page has loaded, or one
 * installed on the machine? A canvas asked for a family that does not exist
 * draws its fallback without a word, so this asks the only way a page can
 * without the Local Font Access prompt: text set in `"family", generic` measures
 * exactly like the generic alone, against all three generics, only when the
 * family is not there. Positives are kept; a miss is asked again (a face may
 * arrive later).
 */
const resolvedFamilies = new Set<string>();
export function familyResolves(family: string): boolean {
  if (GENERIC_FAMILIES.has(family.trim().toLowerCase()) || resolvedFamilies.has(family)) return true;
  if (probeCtx === undefined) probeCtx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  const ctx = probeCtx;
  if (!ctx) return true;
  const width = (font: string) => {
    ctx.font = font;
    return ctx.measureText(PROBE_TEXT).width;
  };
  const quoted = `"${family.replace(/"/g, '\\"')}"`;
  const found = ["monospace", "serif", "sans-serif"].some((g) => width(`72px ${quoted}, ${g}`) !== width(`72px ${g}`));
  if (found) resolvedFamilies.add(family);
  return found;
}

/**
 * Is this a font the app can draw at all — the project's own, a built-in, a
 * Google family, or one the machine has? A family that is none of them never
 * loads: it is a wrong name, and a render saying "still loading" about it
 * would send an agent back to wait for nothing.
 */
export function familyKnown(family: string): boolean {
  if (!googleCatalogLoaded()) return true;
  return isCustomFamily(family) || BUILTIN_SYSTEM_FAMILIES.includes(family) || !!googleMeta(family) || familyResolves(family);
}

/**
 * Invalidate canvas layout whenever ANY font face finishes loading — a global
 * safety net for lazily-fetched `unicode-range` subsets that arrive after their
 * first paint (the "Persian looks compressed until I touch it" class of bug),
 * for every script and font, forever. Installed once, lazily.
 */
let fontLoadWatcherInstalled = false;
function installFontLoadWatcher(): void {
  if (fontLoadWatcherInstalled || typeof document === "undefined" || !document.fonts) return;
  fontLoadWatcherInstalled = true;
  document.fonts.addEventListener("loadingdone", (e) => {
    const faces = (e as FontFaceSetLoadEvent).fontfaces;
    if (faces.length) bumpFontsVersion(faces.map((f) => f.family));
  });
}

// ── Custom fonts — a family is a set of FACES, persisted in IndexedDB ────────
//
// The registry is keyed by FACE (`faceKey`), not by family, and that is the
// whole point. Registering one `FontFace("Helvetica", bytes)` with no
// descriptors claims the entire family at weight 400 upright — and a document
// face set SHADOWS the installed one, so the browser stopped matching the OS's
// real Bold and synthesised a smeared one from the regular instead. Embedding a
// font made it look worse than not embedding it. With descriptors, faces stack:
// register Regular and Bold and the browser matches each exactly, and any
// weight nobody supplied is synthesised from the nearest one we did — which is
// the same thing it would have done with the OS font.
//
// `bestFace` (core) is what turns "I need 600 italic" into "use the 700 italic
// you have", once, for the canvas, the exporter and the project bundler alike.

/**
 * WHY a family has local bytes. The one thing about a registered face that
 * cannot be derived from anything else, and the reason the font picker listed
 * half of Windows twice.
 *
 * Picking a system font EMBEDS the face it resolved to (see `system-fonts.ts`),
 * because the OS family name alone only survives on this machine. That embed
 * lands in the very same registry an upload does — so the picker, which read
 * "has local bytes" as "the user put this here", showed every system font the
 * document had ever touched a second time under YOURS, above the SYSTEM row it
 * came from. Two rows, one family, two different labels for the same face.
 *
 * `"upload"` is a file the user chose, or one that arrived inside a project
 * they opened — theirs either way. `"system"` is a face we lifted out of the OS
 * on their behalf, which is the OS's row to appear in.
 */
export type FontOrigin = "upload" | "system";

/** One registered face. `family` is the CSS family it belongs to. */
export interface CustomFont {
  family: string;
  fileName: string;
  weight: number;
  italic: boolean;
  origin: FontOrigin;
}

let customFonts: CustomFont[] = [];

/**
 * The families that have local faces, once each, sorted.
 *
 * The picker lists FAMILIES — three faces of Inter are one row, not three —
 * which is also why `getCustomFonts` stayed face-level: collapsing is the
 * caller's choice and there is exactly one way to do it.
 */
export function customFamilies(): string[] {
  return [...new Set(customFonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
}

/** The faces registered under one family, in no particular order — what the library reads a local family's weights from. */
export function customFacesOf(family: string): CustomFont[] {
  return customFonts.filter((f) => f.family === family);
}

/** True when this family is a local upload/embed rather than a web font. */
export function isCustomFamily(family: string): boolean {
  return customFonts.some((f) => f.family === family);
}

/**
 * Why this family has local bytes, or null when it has none.
 *
 * The FAMILY answers, not a face: a family with one uploaded face is the user's
 * even if the other three were lifted off the OS, because the thing they put
 * there is what they will look for. `fontSourceOf` (system-fonts) is the only
 * caller and turns this into the row a family belongs in.
 */
export function fontOriginOf(family: string): FontOrigin | null {
  let found: FontOrigin | null = null;
  for (const f of customFonts) {
    if (f.family !== family) continue;
    if (f.origin === "upload") return "upload";
    found = f.origin;
  }
  return found;
}

/** True when this exact face is already registered — the idempotence guard. */
export function hasCustomFace(family: string, weight: number, italic: boolean): boolean {
  return customFonts.some((f) => f.family === family && f.weight === weight && f.italic === italic);
}

interface StoredFace {
  /** `faceKey(family, weight, italic)` — the primary key. */
  key: string;
  family: string;
  fileName: string;
  weight: number;
  italic: boolean;
  /**
   * Absent on every record written before origins existed. Those were uploads
   * and system embeds mixed together with no way to tell them apart, and
   * "upload" is the safe reading: it puts a family in YOURS, where a stray one
   * is merely in the wrong section rather than invisible.
   */
  origin?: FontOrigin;
  data: ArrayBuffer;
}

/** A v1 record: one family, one blob, no axes. */
interface LegacyFont {
  family: string;
  fileName: string;
  data: ArrayBuffer;
}

/**
 * Register a face with the browser under REAL descriptors, so font matching —
 * and the synthesis of anything we did not supply — happens the way it does for
 * an installed font. See the note at the top of this section.
 */
const registeredFaces = new Map<string, FontFace>();

async function registerFace(family: string, data: ArrayBuffer, style: FaceStyle): Promise<void> {
  const face = new FontFace(family, data, {
    weight: String(style.weight),
    style: style.italic ? "italic" : "normal",
  });
  await face.load();
  const key = faceKey(family, style.weight, style.italic);
  // Re-registering a face (a second upload of the same file) replaces it, so
  // the document never holds two FontFaces the matcher must choose between.
  const previous = registeredFaces.get(key);
  if (previous) document.fonts.delete(previous);
  registeredFaces.set(key, face);
  document.fonts.add(face);
}

/** Take a face back out of the document — it stops rendering immediately. */
function unregisterFace(family: string, weight: number, italic: boolean): void {
  const key = faceKey(family, weight, italic);
  const face = registeredFaces.get(key);
  if (face) document.fonts.delete(face);
  registeredFaces.delete(key);
}

/** Record a face in the in-memory registry, replacing any face with the same key. */
function remember(entry: CustomFont): void {
  customFonts = [
    ...customFonts.filter(
      (f) => !(f.family === entry.family && f.weight === entry.weight && f.italic === entry.italic),
    ),
    entry,
  ];
  registryChanged();
}

/**
 * A font file's OWN idea of what it is: the family and face the foundry put in
 * its `name` and `OS/2` tables.
 *
 * The alternative was guessing from the file name, and the guess is wrong in
 * the ordinary case: `Inter-Bold.otf` became a FAMILY called "Inter Bold", a
 * sibling of "Inter Regular" that no weight dropdown could reach and no italic
 * button could pair with. Reading the file answers it exactly — one lazy import
 * of the parser the outliner already ships.
 *
 * Falls back to the file name when the bytes are a format the parser cannot
 * open (WOFF2 is brotli-compressed), which is strictly the old behaviour.
 */
async function identifyFont(file: { name: string; data: ArrayBuffer }): Promise<Omit<CustomFont, "origin">> {
  const fallback = {
    family: familyFromFileName(file.name) || "Custom Font",
    fileName: file.name,
    ...parseFaceStyle(file.name),
  };
  try {
    const opentype = await import("opentype.js");
    const font = opentype.parse(file.data);
    const name = nameReader(font.names);
    // `preferred*` (name IDs 16/17) is what a foundry uses to say "these
    // eighteen files are ONE family". The legacy pair splits anything past four
    // faces into its own family — Playfair Display's Black really does call
    // itself family "Playfair Display Black", subfamily "Regular", which is a
    // 400 of a family that does not exist. `preferredFamily`/`preferredSubfamily`
    // say "Playfair Display" / "Black", which is the truth.
    const family = name("preferredFamily") ?? name("fontFamily");
    if (!family) return fallback;
    const sub = name("preferredSubfamily") ?? name("fontSubfamily") ?? "";
    const named = parseFaceStyle(sub);
    // `usWeightClass` is the authoritative number when the table is present;
    // the subfamily string is how a face without one says the same thing.
    const os2 = (font.tables as { os2?: { usWeightClass?: number; fsSelection?: number } }).os2;
    const weight = os2?.usWeightClass ? clampWeight(os2.usWeightClass) : named.weight;
    const italic = named.italic || ((os2?.fsSelection ?? 0) & 0x01) !== 0;
    return { family, fileName: file.name, weight, italic };
  } catch {
    return fallback;
  }
}

/**
 * Read one `name` table entry, whatever shape the parser hands back.
 *
 * opentype.js v2 groups names by PLATFORM (`names.windows`, `names.macintosh`);
 * v1 returned them flat. Reading the flat shape against v2 finds nothing at
 * all — every font would have quietly fallen back to its file name, with no
 * error to notice. Try the platform tables, then the object itself, then pick
 * English out of the locale map under the key.
 */
function nameReader(names: unknown): (key: string) => string | null {
  const root = (names ?? {}) as Record<string, unknown>;
  const tables = [root["windows"], root["macintosh"], root].filter(Boolean) as Record<string, unknown>[];
  return (key) => {
    for (const table of tables) {
      const entry = table[key] as Record<string, string> | undefined;
      if (!entry || typeof entry !== "object") continue;
      const value = entry["en"] ?? Object.values(entry)[0];
      if (value?.trim()) return value.trim();
    }
    return null;
  };
}

/** Last-resort family name from a file name: "Neue-Machina_Bold.otf" → "Neue Machina Bold". */
function familyFromFileName(fileName: string): string {
  return fileName
    .replace(/\.(ttf|otf|woff2?|ttc|TTF|OTF|WOFF2?|TTC)$/, "")
    .replace(/[-_]+/g, " ")
    .trim();
}

/**
 * Load a user font file: identify the face it really is, register it for canvas
 * use now, persist it for next boot.
 *
 * Uploading Regular and then Bold of the same family now lands them as two
 * faces of ONE family, which is what makes the weight dropdown mean something.
 */
export async function addCustomFont(file: File): Promise<CustomFont> {
  const data = await file.arrayBuffer();
  const identity = await identifyFont({ name: file.name, data });
  const id: CustomFont = { ...identity, origin: "upload" };
  await registerFace(id.family, data, id);

  // Persistence is best-effort: the face works this session either way.
  await idbPut(FACE_STORE, { key: faceKey(id.family, id.weight, id.italic), ...id, data } satisfies StoredFace);

  remember(id);
  bumpFontsVersion([id.family]);
  return id;
}

/**
 * Forget a family and every face in it — from this session, from the device
 * and from the document's face set, so text using it falls back at once
 * rather than on the next reload. The browsers remove a FAMILY, because that
 * is the thing the user put there.
 */
export async function removeCustomFont(family: string): Promise<void> {
  const gone = customFacesOf(family);
  customFonts = customFonts.filter((f) => f.family !== family);
  if (typeof document !== "undefined") for (const f of gone) unregisterFace(f.family, f.weight, f.italic);
  registryChanged();
  bumpFontsVersion([family]);
  await idbDelete(FACE_STORE, gone.map((f) => faceKey(f.family, f.weight, f.italic)));
}


/**
 * Read a custom face's raw file bytes — for outlining on export, or for
 * bundling into a `.motion` project.
 *
 * `weight`/`italic` say which face; `bestFace` resolves the ask against what is
 * actually installed, so a family that ships only a Regular still answers a
 * request for Bold (with the Regular, which is what the screen is showing too)
 * instead of returning nothing and outlining a fallback font.
 */
export async function getCustomFontBlob(
  family: string,
  weight = 400,
  italic = false,
): Promise<{ fileName: string; weight: number; italic: boolean; data: ArrayBuffer } | null> {
  const face = bestFace(customFacesOf(family), { weight, italic });
  if (!face) return null;
  const record = await idbGet<StoredFace>(FACE_STORE, faceKey(face.family, face.weight, face.italic));
  if (!record) return null;
  return { fileName: record.fileName, weight: record.weight, italic: record.italic, data: record.data };
}

/**
 * Install a face from raw bytes — the counterpart of `addCustomFont` for bytes
 * that arrive already identified: a `.motion` bundle's embedded fonts, and a
 * system face lifted out of the OS by `system-fonts.ts`.
 *
 * The family is the caller's to name, because both of those callers know it
 * better than the file does (a bundle recorded what the document references; a
 * system face must land under the family the OS enumerates it as, or nothing
 * that already picked it would match).
 */
export async function installCustomFontBytes(
  family: string,
  fileName: string,
  data: ArrayBuffer,
  style: FaceStyle = { weight: 400, italic: false },
  /** Whose face this is. Defaults to the user's — only the OS lift says otherwise. */
  origin: FontOrigin = "upload",
): Promise<void> {
  try {
    await registerFace(family, data, style);
  } catch {
    return; // Bytes no longer parse — skip rather than poison the registry.
  }
  const entry: CustomFont = { family, fileName, weight: style.weight, italic: style.italic, origin };
  await idbPut(FACE_STORE, { key: faceKey(family, style.weight, style.italic), ...entry, data } satisfies StoredFace);
  remember(entry);
  bumpFontsVersion([family]);
}

let restored = false;
/**
 * Re-register every persisted face (call once on editor mount), migrating v1's
 * family-keyed uploads in on the way.
 *
 * The migration is a copy, not a move: each v1 blob becomes the family's 400
 * upright face — which is what it was already being used as — and the v1 store
 * is left exactly as it was.
 */
export async function restoreCustomFonts(): Promise<void> {
  if (restored || typeof indexedDB === "undefined") return;
  restored = true;
  try {
    const faces = await idbGetAll<StoredFace>(FACE_STORE);

    if (faces.length === 0) {
      for (const old of await idbGetAll<LegacyFont>(LEGACY_STORE)) {
        const record: StoredFace = {
          key: faceKey(old.family, 400, false),
          family: old.family,
          fileName: old.fileName,
          weight: 400,
          italic: false,
          origin: "upload",
          data: old.data,
        };
        faces.push(record);
        await idbPut(FACE_STORE, record);
      }
    }

    for (const record of faces) {
      try {
        await registerFace(record.family, record.data, record);
        remember({
          family: record.family,
          fileName: record.fileName,
          weight: record.weight,
          italic: record.italic,
          origin: record.origin ?? "upload",
        });
      } catch {
        // Skip faces that no longer parse.
      }
    }
    if (faces.length > 0) bumpFontsVersion(faces.map((f) => f.family));
  } catch {
    // No IndexedDB (private mode) — uploads still work per-session.
  }
}
