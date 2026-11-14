"use client";

import { lazyFamily, type MotionDocument, type LayerEffectType } from "@solomotion/core";
import * as BASICS from "./basics";
import type { LfxPass, LfxPassKind, PassEnv, PassModule } from "./types";

/**
 * THE LAZY PASS REGISTRY — what an effect COSTS, and when.
 *
 * Effect metadata is small and must be eager: the add palette has to list forty
 * cards you have not used yet, the property registry has to know their keyframe
 * paths, and a migration has to walk them. Effect ENGINES are the opposite —
 * the glass material carries a WebGL pipeline, the analog family carries tile
 * generators and per-pixel loops, halftone carries a rasteriser — and a
 * document that uses none of them should never download, parse or retain any
 * of it. Before this file, all of it sat in the editor's first chunk, so every
 * effect anyone ever added made the app slower to open for everybody.
 *
 * So: one family, one chunk, imported the first time a document mentions it.
 *
 * THE HARD PART IS THAT DRAWING IS SYNCHRONOUS. A frame cannot await an
 * import, so this module answers "is it here yet?" synchronously and the
 * renderer skips a pass whose chunk has not landed. Three things make that
 * honest rather than a silent hole:
 *
 *   1. EXPORT AWAITS. `prepareEffectPassesForExport` sits beside
 *      `prepareImagesForExport` and friends at every export entry point, so a
 *      render can never race a chunk. This is the one that would have been a
 *      real bug — an export quietly missing an effect is not recoverable.
 *   2. A MISS STARTS THE FETCH. `passImpl` kicks off the load the first time it
 *      is asked for a family it does not have, and `onEffectPassesReady` pokes
 *      the stage to repaint when it lands — the same contract media and raster
 *      surfaces already use, so a slow chunk looks like a slow image rather
 *      than a broken effect. Opening a document therefore needs no special
 *      case: the first frame that mentions a family asks for it.
 *   3. ADDING A CARD PREFETCHES. The inspector calls `ensureEffectPasses` the
 *      instant you pick something from the palette, so the fetch overlaps the
 *      document edit and the very first frame usually already has it.
 *   4. THE BASICS FAMILY IS STATIC. Shadow, glow, blur and stroke — the passes
 *      on screen within a second of opening almost any file — are never
 *      subject to any of the above.
 */

/**
 * Family → loader. THE table, and the only place a pass kind is mapped to the
 * chunk that draws it.
 *
 * Adding an effect is one entry in a core family file plus one case in that
 * family's module; adding a FAMILY is one line here. Nothing else in the app
 * learns a new name — which is the property that has to hold at a hundred
 * effects, and the reason this is a table rather than a switch.
 */
const FAMILY_LOADERS = {
  basics: null, // statically imported below — always present
  material: () => import("./material"),
  analog: () => import("./analog"),
  light: () => import("./light"),
  distort: () => import("./distort"),
  pattern: () => import("./pattern"),
  color: () => import("./color"),
  depth: () => import("./depth"),
  cosmos: () => import("./cosmos"),
  surface: () => import("./surface"),
} as const;

type Family = keyof typeof FAMILY_LOADERS;

/**
 * Pass kind → family. Exhaustive over `LfxPassKind`, so a new pass that nobody
 * remembers to place here fails the build rather than silently never drawing.
 */
const PASS_FAMILY: Record<LfxPassKind, Family> = {
  vignette: "basics",
  sharpen: "basics",
  directionalBlur: "basics",
  zoomBlur: "basics",
  spinBlur: "basics",
  innerShadow: "basics",
  glow: "basics",
  stroke: "basics",
  longShadow: "basics",
  rgbSplit: "basics",
  glass: "material",
  grain: "analog",
  filmDamage: "analog",
  scanlines: "analog",
  noise: "analog",
  shine: "light",
  lightRays: "light",
  lensFlare: "light",
  lightning: "light",
  bulge: "distort",
  wave: "distort",
  twirl: "distort",
  lensDistort: "distort",
  roughenEdges: "distort",
  boil: "distort",
  goo: "distort",
  glitch: "distort",
  halftone: "pattern",
  pixelate: "pattern",
  bevel: "pattern",
  gradientMap: "color",
  posterize: "color",
  overlay: "color",
  fog: "depth",
  lensBlur: "depth",
  depthMatte: "depth",
  lens: "cosmos",
  shockwave: "cosmos",
  star: "cosmos",
  starfield: "cosmos",
  nebula: "cosmos",
  surface: "surface",
};

/**
 * Effect kind → pass kind, for the kinds that compile to a pass at all.
 *
 * Deliberately NOT derived from the names being equal, even though most of them
 * are: `colorGrade` is a grade stage, `shadow`/`blur`/`adjust` are CSS filters
 * and `chromaKey` is keyed inside the media draw. Listing only the mappings
 * that exist is what lets `effectPassKind` return null honestly instead of
 * asking for a chunk that has nothing to do with the effect.
 */
const EFFECT_PASS: Partial<Record<LayerEffectType, LfxPassKind>> = {
  vignette: "vignette",
  sharpen: "sharpen",
  directionalBlur: "directionalBlur",
  zoomBlur: "zoomBlur",
  spinBlur: "spinBlur",
  innerShadow: "innerShadow",
  glow: "glow",
  stroke: "stroke",
  longShadow: "longShadow",
  rgbSplit: "rgbSplit",
  glass: "glass",
  grain: "grain",
  filmDamage: "filmDamage",
  scanlines: "scanlines",
  noise: "noise",
  shine: "shine",
  lightRays: "lightRays",
  lensFlare: "lensFlare",
  lightning: "lightning",
  bulge: "bulge",
  wave: "wave",
  twirl: "twirl",
  lensDistort: "lensDistort",
  roughenEdges: "roughenEdges",
  boil: "boil",
  goo: "goo",
  glitch: "glitch",
  halftone: "halftone",
  pixelate: "pixelate",
  bevel: "bevel",
  gradientMap: "gradientMap",
  posterize: "posterize",
  overlay: "overlay",
  fog: "fog",
  lensBlur: "lensBlur",
  depthMatte: "depthMatte",
  lens: "lens",
  shockwave: "shockwave",
  star: "star",
  starfield: "starfield",
  nebula: "nebula",
  surface: "surface",
};

// One lazy module per family (core's `lazyFamily`): fetched once, retried on
// a flaky network, never a failure remembered — a frame asks again after a
// short cooldown, and the host retries at once when the network returns.
// Offline, the files come from the offline worker's precache (ADR-offline).
//
// IN DEV, ONE VERSION PER EVALUATION. Core keeps lazy modules in one registry
// keyed by id, so a module loaded once is that module for the life of the page
// — exactly right in production, and why an edited pass never showed in dev:
// the hot update re-ran this file, asked for "effect-passes/pattern" again,
// and was handed the module it had already resolved. Stamping each evaluation
// makes a re-run registry load the new code.
const DEV_EVALUATION = process.env.NODE_ENV === "development" ? Date.now().toString(36) : undefined;
const FAMILIES = lazyFamily<Family, PassModule>("effect-passes", (family) => {
  const loader = FAMILY_LOADERS[family];
  return loader ? () => loader().then((mod) => mod as unknown as PassModule) : null;
}, { label: "effects", version: DEV_EVALUATION });

/** Repaint listeners — see `onMediaReady`, whose contract this copies. */
export function onEffectPassesReady(cb: () => void): () => void {
  return FAMILIES.onAnyReady(() => cb());
}

function loadFamily(family: Family): Promise<unknown> {
  return family === "basics" ? Promise.resolve() : FAMILIES.load(family);
}

/**
 * The implementation for this pass, IF it is already in memory. Never awaits,
 * never throws — a frame in flight cannot wait for a network round trip. A
 * `null` here means "start it and draw the layer untouched this frame".
 */
export function passImpl(kind: LfxPassKind): PassModule[LfxPassKind] | null {
  const family = PASS_FAMILY[kind];
  const mod = family === "basics" ? (BASICS as PassModule) : FAMILIES.want(family);
  return mod ? ((mod as Record<string, unknown>)[kind] as PassModule[LfxPassKind] | null) : null;
}

/** The pass an effect kind compiles to, or null when it is not a pass at all. */
export function effectPassKind(type: LayerEffectType): LfxPassKind | null {
  return EFFECT_PASS[type] ?? null;
}

/**
 * Load whatever these effect kinds need, and resolve when they can all draw —
 * or reject, so an export never quietly misses an effect (a palette's
 * prefetch ignores that; the next frame asks again).
 */
export async function ensureEffectPasses(types: Iterable<LayerEffectType>): Promise<void> {
  const families = new Set<Family>();
  for (const type of types) {
    const kind = effectPassKind(type);
    if (kind) families.add(PASS_FAMILY[kind]);
  }
  await Promise.all([...families].map(loadFamily));
}

/**
 * Every effect kind a document actually uses. Walking the document rather than
 * loading everything is the whole point: a title card with a drop shadow pays
 * for a drop shadow.
 */
export function effectKindsInDocument(doc: MotionDocument): Set<LayerEffectType> {
  const kinds = new Set<LayerEffectType>();
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind === "audio") continue;
      for (const fx of clip.effects) kinds.add(fx.type);
    }
  }
  return kinds;
}

/**
 * Warm the chunks a document needs, and resolve when an EXPORT may safely
 * begin. Named to match `prepareImagesForExport` and friends, because it is
 * the same promise: a resource the renderer needs, fetched before the first
 * frame instead of during it.
 */
export async function prepareEffectPassesForExport(doc: MotionDocument): Promise<void> {
  await ensureEffectPasses(effectKindsInDocument(doc));
}

/**
 * Dispatch one pass over a device-space image → a new device-space image.
 *
 * Returns `src` untouched when the family has not landed. That is a visible
 * one-or-two-frame delay the very first time a document uses a family, and it
 * is the correct trade: the alternative is either shipping every engine to
 * everyone, or blocking a paint on a network fetch.
 */
export function applyEffectPass(
  pass: LfxPass,
  src: CanvasImageSource,
  w: number,
  h: number,
  env: PassEnv = { backdrop: null },
): CanvasImageSource {
  const fn = passImpl(pass.kind);
  if (!fn) return src;
  return (fn as (p: LfxPass, s: CanvasImageSource, w: number, h: number, e: PassEnv) => CanvasImageSource)(pass, src, w, h, env);
}
