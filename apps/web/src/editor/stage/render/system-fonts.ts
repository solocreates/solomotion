"use client";

import {
  bestFace,
  documentFontUsage,
  faceKey,
  fontUsageOf,
  parseFaceStyle,
  setTextFaceLoader,
  type MotionDocument,
  type FaceId,
  type FontSourceId,
} from "@solomotion/core";
import { type SystemFont } from "@solomotion/platform";
import { platform } from "@/editor/platform";
import { BUILTIN_SYSTEM_FAMILIES, ensureFont, faceDrawable, familyKnown, fontOriginOf, hasCustomFace, installCustomFontBytes } from "./fonts";

/**
 * System fonts — the third leg of the Figma-style font menu (Google · System ·
 * Upload), built headlessly on the platform bridge's `fonts` port (Local Font
 * Access API; Chromium and the Electron desktop shell, every OS).
 *
 * ON PICK we embed the bytes through the custom-font registry, because the OS
 * family name alone only survives on this machine: outlining for export needs
 * real bytes, and so does opening the project anywhere else. But we embed ONE
 * FACE AT A TIME, the face that is actually asked for, and that is the whole
 * design:
 *
 *   eagerly embedding a family means eighteen files and several megabytes for a
 *   layer that uses one of them
 *
 *   embedding only the REGULAR — which is what this did — is worse than that:
 *   a registered face set shadows the installed family, so the browser stopped
 *   matching the OS's real Bold and synthesised one from the Regular instead.
 *   Picking a system font made its bold look WORSE than leaving it alone
 *
 * So discovery is family-level (that is what a menu shows) and embedding is
 * face-level, driven by what the document renders. `documentFontUsage` says
 * which faces those are; `bestFace` decides which installed face answers each.
 *
 * The query is lazy (fired when the picker first opens, or when a document
 * turns out to reference a family we don't otherwise have) so there is no
 * startup cost and the one-time permission prompt only appears when it can be
 * explained by something the user just did.
 */

let faces: SystemFont[] = [];
let families: string[] = [];
let loaded = false;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());

export function subscribeSystemFonts(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Stable snapshot of discovered family names (for useSyncExternalStore). */
export function systemFontFamilies(): string[] {
  return families;
}

export function systemFontsSupported(): boolean {
  return platform.fonts.supported();
}

/** Query installed system fonts once. Idempotent; safe to call on every picker open. */
export function loadSystemFonts(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (inFlight) return inFlight;
  inFlight = platform.fonts
    .querySystem()
    .then((list) => {
      faces = list;
      // Local Font Access returns one entry per FACE; the menu shows families.
      families = [...new Set(list.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
      loaded = true;
      emit();
    })
    .catch(() => {
      loaded = true; // unsupported or denied — leave the list empty, don't retry-storm
    });
  return inFlight;
}

/** True once the OS has been asked (whether or not it answered with anything). */
export function systemFontsQueried(): boolean {
  return loaded;
}

/** Is this family one the OS installed? Only meaningful after `loadSystemFonts`. */
export function isSystemFamily(family: string): boolean {
  return families.includes(family);
}

/**
 * The faces the OS ships for a family, with their axes resolved — the shape
 * `bestFace` matches against. `SystemFont.style` is a `name`-table subfamily
 * string ("Bold Italic", "SemiBold", "W6"), which is exactly what
 * `parseFaceStyle` exists to read.
 */
export function installedFaces(family: string): (SystemFont & { weight: number; italic: boolean })[] {
  return faces
    .filter((f) => f.family === family)
    .map((f) => ({ ...f, ...parseFaceStyle(f.style) }));
}

/** Faces embedded (or attempted) this session — the guard against re-reading bytes. */
const attempted = new Set<string>();

/**
 * Embed the installed face that best answers `want`, under the OS family name.
 *
 * Non-destructive in both directions: it never replaces a face already
 * registered (an upload of the same family wins, because the user put it
 * there), and a failure to read the bytes leaves the family perfectly usable on
 * screen — the OS still renders it, we just cannot outline or bundle it.
 */
export async function ensureSystemFace(want: FaceId): Promise<void> {
  if (!systemFontsSupported()) return;
  if (!loaded) await loadSystemFonts();
  if (!isSystemFamily(want.family)) return;

  const pick = bestFace(installedFaces(want.family), want);
  if (!pick) return;
  // Keyed by the face we RESOLVED to, not the one asked for: a family with only
  // a Regular must not re-read those same bytes once per weight on the page.
  const key = faceKey(pick.family, pick.weight, pick.italic);
  if (attempted.has(key) || hasCustomFace(pick.family, pick.weight, pick.italic)) return;
  attempted.add(key);

  try {
    const bytes = await (await pick.blob()).arrayBuffer();
    await installCustomFontBytes(
      pick.family,
      `${pick.postscriptName}.font`,
      bytes,
      { weight: pick.weight, italic: pick.italic },
      // The OS's face, not the user's file — which is the whole reason origins
      // exist. Without it this embed made the family look uploaded, and the
      // picker listed it under YOURS as well as under SYSTEM.
      "system",
    );
  } catch {
    /* keep the family selectable; the OS still renders it on screen */
  }
}

/**
 * EVERY FACE A DOCUMENT RENDERS, loaded from whichever source owns it.
 *
 * The one entry point for "make this document paint correctly" — called on
 * open, on import, and whenever the document changes. It lives here rather than
 * beside the registry because it is the only place that spans all three
 * sources, and because reaching the OS is the half that has to be asked for.
 *
 * `documentFontUsage` (core) is the walk. It replaced two walks that disagreed:
 * the stage loaded base styles only, and the project bundler a different
 * family-only set, so a caption whose focus word used a second font shipped a
 * project that opened without it.
 */
export function ensureDocumentFaces(doc: MotionDocument): void {
  for (const use of documentFontUsage(doc)) {
    ensureFont(use.family, { text: use.text, weight: use.weight, italic: use.italic });
    void ensureSystemFace(use);
  }
}

/** How long a measuring command waits for a face before it measures what it has. */
const FACE_WAIT_MS = 4000;

// THE FACES A MEASURED BOX NEEDS (core `textFacesReady`): the same walk, over
// the layers being measured, each face loaded exactly — so `layer.get` returns
// the width of the real face, never its fallback's. Bounded: a face that never
// arrives measures as it would render, in its fallback.
setTextFaceLoader(async (doc, clips) => {
  const loads = fontUsageOf(doc, clips).map((use) =>
    Promise.all([ensureFont(use.family, { text: use.text, weight: use.weight, italic: use.italic }), ensureSystemFace(use)]),
  );
  await Promise.race([Promise.all(loads), new Promise((resolve) => setTimeout(resolve, FACE_WAIT_MS))]);
});

/** How long a render waits for the faces it draws before it draws what it has. */
const RENDER_FACE_WAIT_MS = 12_000;

/**
 * EVERY FACE THE DOCUMENT DRAWS, LOADED — the render's half of the contract
 * the measuring commands already keep (`textFacesReady` above).
 *
 * A render never awaited a font: images, surfaces, effect passes, worlds and
 * sound were all prepared before the first frame, and type was not. A Google
 * family used for the first time in a project drew in a fallback face until
 * its files arrived, in `view.render` (so an agent judged the wrong type) and
 * in the first frames of an export (so it shipped), with nothing said.
 *
 * Bounded: a face that never arrives does not hold a render forever. Returns
 * the families that still cannot draw, so the caller can say so.
 */
export async function documentFacesReady(doc: MotionDocument, frameId?: string): Promise<string[]> {
  const uses = documentFontUsage(doc, frameId);
  if (!uses.length) return [];
  const loads = uses.map((use) =>
    Promise.all([ensureFont(use.family, { text: use.text, weight: use.weight, italic: use.italic }), ensureSystemFace(use)]).catch(() => undefined),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.all(loads), new Promise((resolve) => (timer = setTimeout(resolve, RENDER_FACE_WAIT_MS)))]);
  clearTimeout(timer);
  const pending = uses.filter((use) => !faceDrawable(use.family, { text: use.text, weight: use.weight, italic: use.italic }));
  return [...new Set(pending.map((use) => use.family))];
}

/**
 * What a render or an export must say about the families `documentFacesReady`
 * left drawing in a fallback — the one wording for `view.render`,
 * `view.frames` and `export.render`. A family still LOADING is worth a second
 * look; a family that is no font at all (a typo, a face never installed)
 * never loads, and saying "render again" about it sends an agent to wait for
 * nothing.
 */
export function fontReadinessNote(
  pending: readonly string[],
  what: "picture" | "file",
): { fontsPending?: string[]; fontsUnknown?: string[]; note?: string } {
  if (!pending.length) return {};
  const unknown = pending.filter((f) => !familyKnown(f));
  const loading = pending.filter((f) => familyKnown(f));
  const notes: string[] = [];
  if (unknown.length) {
    notes.push(
      `${unknown.join(", ")} is not a font here (not installed, not a Google Fonts family, not in this project), so this ${what} draws it in a fallback face. Check the spelling, or install the file with font.install.`,
    );
  }
  if (loading.length) {
    notes.push(
      what === "picture"
        ? `${loading.join(", ")} had not loaded, so this picture draws it in a fallback face. Render again in a moment.`
        : `${loading.join(", ")} did not load in time, so this file draws it in a fallback face. Export again once the font is in (view_render shows it).`,
    );
  }
  return { ...(loading.length ? { fontsPending: loading } : {}), ...(unknown.length ? { fontsUnknown: unknown } : {}), note: notes.join(" ") };
}

// ── Which list a family belongs in ──────────────────────────────────────────


/** The curated built-ins the app ships as "system" regardless of what the OS says. */
const BUILTIN_SYSTEM = new Set(BUILTIN_SYSTEM_FAMILIES);

/**
 * WHICH SOURCE OWNS THIS FAMILY — one answer, so no family can be listed twice.
 *
 * The picker used to build three lists side by side and render all of them: the
 * local registry, the Google catalog, and the OS query. Nothing reconciled them,
 * and on Windows they overlap heavily — every system font the document had ever
 * touched was embedded into the local registry by `ensureSystemFace`, so it
 * appeared under YOURS above the SYSTEM row it came from, and a Google family
 * that also happens to be installed (Roboto, Open Sans, Inter — the common case
 * on a designer's machine) appeared in both of those as well. Three lists, one
 * family, three labels, and a menu that reads as broken because it is.
 *
 * Precedence, and each clause is a claim about what the person is looking for:
 *
 *   the user's own FILE wins over everything — they put it there, and it is
 *   what actually renders, since a registered face shadows the installed family
 *
 *   then the OS, for anything it reports or the app ships as a built-in — that
 *   is where a person looks for Arial, whether or not we have lifted its bytes
 *
 *   then local bytes with no OS behind them — a face embedded from SOMEONE
 *   ELSE'S machine, arriving inside a project. Theirs now, so: yours
 *
 *   otherwise the catalog.
 */
export function fontSourceOf(family: string): FontSourceId {
  const origin = fontOriginOf(family);
  if (origin === "upload") return "yours";
  if (isSystemFamily(family) || BUILTIN_SYSTEM.has(family)) return "system";
  return origin ? "yours" : "google";
}
