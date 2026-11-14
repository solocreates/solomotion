"use client";

import * as React from "react";
import { drawableWeight, localFamilyMeta, type FontFamilyMeta } from "@solomotion/core";
import {
  BUILTIN_SYSTEM_FAMILIES,
  customFacesOf,
  customFamilies,
  fontRegistrySnapshot,
  subscribeFontRegistry,
} from "../stage/render/fonts";
import {
  fontSourceOf,
  installedFaces,
  loadSystemFonts,
  subscribeSystemFonts,
  systemFontFamilies,
} from "../stage/render/system-fonts";
import { googleCatalog, googleMeta, loadGoogleCatalog, subscribeGoogleCatalog } from "./google-catalog";

/**
 * THE FONT LIBRARY — every family the app can set, once each, from wherever it
 * lives. The quick picker, the Fonts window and the Weight menu all read this
 * one list, so none of them can disagree about what exists or what it weighs.
 *
 * Three sources are gathered and reconciled here and nowhere else:
 *
 *   your uploads     local faces the user put there (kept on the device)
 *   this device      what the OS reports, plus the web-safe built-ins
 *   Google Fonts     the catalogue, minus anything the first two already own
 *
 * `fontSourceOf` decides which one owns a family, so a family is never listed
 * twice. And a family the OS owns but Google also knows (Inter installed on a
 * designer's machine) keeps Google's DESCRIPTION — category, feelings, scripts
 * — so it still answers a "Geometric" filter, with the weights the machine
 * really has.
 */

function describe(family: string, source: FontFamilyMeta["source"], faces: ReadonlyArray<{ weight: number; italic: boolean }>): FontFamilyMeta {
  const local = localFamilyMeta(family, source, faces);
  const known = googleMeta(family);
  if (!known) return local;
  return {
    ...known,
    source,
    weights: faces.length > 0 ? local.weights : known.weights,
    italics: faces.length > 0 ? local.italics : known.italics,
    variable: faces.length > 0 ? null : known.variable,
    // An installed Google family keeps its real rank — Inter on this machine is
    // still Inter — and only your own uploads jump the queue.
    popularity: source === "yours" ? -1 : known.popularity,
  };
}

let cache: {
  registry: unknown;
  system: unknown;
  google: unknown;
  list: FontFamilyMeta[];
  byFamily: Map<string, FontFamilyMeta>;
} | null = null;

function build(): NonNullable<typeof cache> {
  const registry = fontRegistrySnapshot();
  const system = systemFontFamilies();
  const google = googleCatalog();
  if (cache && cache.registry === registry && cache.system === system && cache.google === google) return cache;

  const list: FontFamilyMeta[] = [];
  const seen = new Set<string>();
  const push = (meta: FontFamilyMeta) => {
    if (seen.has(meta.family)) return;
    seen.add(meta.family);
    list.push(meta);
  };
  for (const family of customFamilies()) {
    if (fontSourceOf(family) === "yours") push(describe(family, "yours", customFacesOf(family)));
  }
  for (const family of [...BUILTIN_SYSTEM_FAMILIES, ...system]) {
    if (fontSourceOf(family) === "system") push(describe(family, "system", installedFaces(family)));
  }
  for (const meta of google ?? []) {
    if (fontSourceOf(meta.family) === "google") push(meta);
  }
  cache = { registry, system, google, list, byFamily: new Map(list.map((m) => [m.family, m])) };
  return cache;
}

function subscribe(cb: () => void): () => void {
  const a = subscribeFontRegistry(cb);
  const b = subscribeSystemFonts(cb);
  const c = subscribeGoogleCatalog(cb);
  return () => {
    a();
    b();
    c();
  };
}

const snapshot = () => build().list;

/**
 * Ask every source for its families. The Google catalogue is one lazy chunk;
 * the OS query may show a one-time permission prompt, so this is called when a
 * person opens a font browser — the moment the prompt can be explained.
 */
export function openFontLibrary(): void {
  void loadGoogleCatalog();
  void loadSystemFonts();
}

/** Every family, in source order (yours · device · Google by popularity). */
export function useFontLibrary(): FontFamilyMeta[] {
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * One family's description, whatever its source — or a plain Regular/Bold pair
 * for a family nobody knows yet (a font from someone else's machine).
 */
export function familyMeta(family: string): FontFamilyMeta {
  return (
    knownFamilyMeta(family) ??
    localFamilyMeta(family, "system", [
      { weight: 400, italic: false },
      { weight: 700, italic: false },
    ])
  );
}

/** A family's description only when some source actually knows it. */
export function knownFamilyMeta(family: string): FontFamilyMeta | null {
  return build().byFamily.get(family) ?? googleMeta(family) ?? null;
}

/** `familyMeta`, live: re-renders when the family's faces or the catalogue arrive. */
export function useFamilyMeta(family: string | undefined): FontFamilyMeta | null {
  React.useEffect(() => {
    if (family) void loadGoogleCatalog();
  }, [family]);
  const read = React.useCallback(() => (family ? familyMeta(family) : null), [family]);
  const list = React.useSyncExternalStore(subscribe, snapshot, snapshot);
  // `familyMeta` is recomputed from the same cache `list` came from.
  return React.useMemo(() => read(), [read, list]);
}

/**
 * The style patch a font PICK writes. Changing family keeps the weight you had
 * whenever the new family can draw it, and otherwise lands on the nearest one
 * it ships — Lobster has one weight, and "Change font" that left a layer at an
 * ExtraBold Lobster cannot exist would show a Weight menu lying about the
 * text. An explicit face (a weight step clicked on a card, an uploaded file)
 * is taken as given.
 */
export function fontPickPatch(
  family: string,
  current: { weight?: number; italic?: boolean },
  face?: { weight: number; italic?: boolean },
): { fontFamily: string; fontWeight: number; italic?: boolean } {
  if (face) return { fontFamily: family, fontWeight: face.weight, ...(face.italic !== undefined ? { italic: face.italic } : {}) };
  const meta = knownFamilyMeta(family);
  const weight = current.weight ?? 400;
  // A family nobody can describe yet keeps the weight: snapping it to a
  // guessed ladder would change the text for no reason anyone could see.
  return { fontFamily: family, fontWeight: meta ? drawableWeight(meta, weight, current.italic ?? false) : weight };
}
