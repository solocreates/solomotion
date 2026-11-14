"use client";

import { decodeFontCatalog, type FontFamilyMeta } from "@solomotion/core";

/**
 * The Google Fonts catalogue, loaded once, on demand.
 *
 * ~1,950 families with weights, variable axes, scripts, feelings and styles —
 * a 44KB (gzipped) chunk that only loads when something asks about a Google
 * family: a picker opening, or a document that uses one (the loader needs the
 * family's real axes to request it — see `ensureFont`). Regenerate it with
 * `node scripts/fonts/build-google-catalog.mjs`.
 */

let catalog: FontFamilyMeta[] | null = null;
let index: Map<string, FontFamilyMeta> | null = null;
let loading: Promise<FontFamilyMeta[]> | null = null;
const listeners = new Set<() => void>();

export function googleCatalog(): FontFamilyMeta[] | null {
  return catalog;
}

export function googleMeta(family: string): FontFamilyMeta | undefined {
  return index?.get(family);
}

export function googleCatalogLoaded(): boolean {
  return catalog !== null;
}

export function subscribeGoogleCatalog(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

export function loadGoogleCatalog(): Promise<FontFamilyMeta[]> {
  if (catalog) return Promise.resolve(catalog);
  loading ??= import("./google-catalog.data").then(({ GOOGLE_CATALOG_JSON }) => {
    const list = decodeFontCatalog(GOOGLE_CATALOG_JSON, "google");
    catalog = list;
    index = new Map(list.map((f) => [f.family, f]));
    for (const l of [...listeners]) l();
    return list;
  });
  return loading;
}
