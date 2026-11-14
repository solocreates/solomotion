import type { KeyframeValue } from "../schema";
import type { Modulator } from "../schema/modulators";
import type { SurfaceColorMode, SurfaceEffect, SurfaceMaterial, SurfaceMorphStyle, SurfaceTextureTiling } from "../schema/layer-effects";
import { SURFACE_MATERIALS } from "../schema/layer-effects";
import { flowPicture, shapeStageActive, shapeSurface } from "./surface-body";
import { MATERIAL_RECIPES } from "./surface-materials";
import { ownClockSec } from "./effect-base";
import { resolveEffectValues } from "./effect-values";
import { layerEffectPath, layerEffectTypeDef } from "./layer-effects";
import { parseHexColor } from "../colors/hex";
import { fbm2, makeRng, rand01, resolveTemporalStep } from "./temporal";
import {
  clothLayers,
  empty,
  fibres,
  fingerprints,
  folds,
  fractal,
  gaussWrap,
  paperLayers,
  ruledGrid,
  scaleInto,
  smoothstep,
  specks,
  woodGrain,
  boxBlurClamp,
  coarseBlur,
  sampleCoarse,
  type SurfaceLayers,
  type SurfaceRecipe,
} from "./surface-fields";

export type { SurfaceLayers, SurfaceRecipe } from "./surface-fields";

/**
 * THE SURFACE BRAIN — what a material IS, as numbers, for the Surface card.
 *
 * A material is two fields over the sheet: a HEIGHT (fibres, tooth, threads,
 * flutes, folds) that a light rakes across, and an ALBEDO (fibres and flecks
 * darker or lighter than the sheet itself). Lighting the height from an angle
 * is what makes it read as a thing with depth rather than as a speckle laid
 * over the picture — a fibre is bright on the side facing the light and dark
 * on the other, a thread's crown catches it, a fold has a lit face and a
 * shaded one. Noise has none of that, which is the whole difference.
 *
 * Everything is generated HERE, as typed arrays, from a seed — no canvas, no
 * DOM — so the stage, the exporter and a test produce the same pixels, and the
 * renderer (`passes/surface.ts`) only uploads tiles and composites.
 *
 * THE MATERIAL RECIPES are rules, not textures. They were calibrated against
 * the one texture Shayan picked for ScientificMotion (black cardstock: a
 * near-black, slightly warm sheet; a fine positive-only tooth; mottling at two
 * large scales; short, slightly bent LIGHT fibres in every direction; nothing
 * brighter than a fifth of white) and the same family's cream paper and plain
 * weaves. A new material is a row in `SURFACE_RECIPES`.
 *
 * Two layers of cost, two caches (both in the renderer):
 *   the TILE   a seamless square of material at device resolution, a pure
 *              function of (material, unit, seed, tooth, relief, light). A
 *              stop-motion re-roll never regenerates it: each step SHIFTS the
 *              sheet under the camera by a step-seeded offset, the way a
 *              re-shot paper never sits twice in the same place.
 *   the MOTTLE a coarse, non-repeating tone field over the whole region, at a
 *              sixteenth of the resolution, re-rolled per step. It is what
 *              stops a tile from ever reading as a tile.
 */

const SHEET_RECIPES: readonly SurfaceRecipe[] = [
  {
    // Cotton drawing paper: a cream sheet, a fine tooth, darker cotton fibres
    // of every length lying in every direction.
    id: "paper",
    label: "Paper",
    tone: [242, 236, 222],
    tile: 512,
    elevation: 38,
    depth: 1.6,
    shade: 0.55,
    mottle: { amount: -0.045, size: 90 },
    edge: { reach: 5, fuzz: 0, rim: 0.55 },
    liftSoftness: 0.7,
    // A cut-out piece rounds over as far as it is thick (see `SurfaceBody.fromLift`).
    body: { profile: "bevel", width: 0.7, fromLift: true, height: 0.5, shade: 0.6 },
    build: (n, u, seed) =>
      paperLayers(n, u, seed, {
        tooth: [0.8, 1.8],
        fibres: { density: 1.3e-3, length: [8, 46], alpha: [0.1, 0.4], bend: 0.6 },
        fibreTone: -0.16,
        toothTone: -0.05,
      }),
  },
  {
    // Kraft: warm brown, LONG fibres running mostly one way (the machine
    // direction), dark flecks of unbleached pulp and a few pale fibres.
    id: "kraft",
    label: "Kraft",
    tone: [188, 146, 100],
    tile: 640,
    elevation: 36,
    depth: 1.8,
    shade: 0.6,
    mottle: { amount: -0.08, size: 110 },
    edge: { reach: 6, fuzz: 0, rim: 0.3 },
    liftSoftness: 0.7,
    // A cut-out piece rounds over as far as it is thick (see `SurfaceBody.fromLift`).
    body: { profile: "bevel", width: 0.7, fromLift: true, height: 0.5, shade: 0.6 },
    build: (n, u, seed) =>
      paperLayers(n, u, seed, {
        tooth: [0.9, 2],
        fibres: { density: 1.8e-3, length: [24, 90], alpha: [0.08, 0.3], bend: 0.5, grain: { angle: 0.12, strength: 0.55 } },
        fibreTone: -0.1,
        toothTone: -0.07,
        flecks: { density: 1.4e-4, radius: [0.6, 1.8], tone: -0.45 },
        lightFibres: { spec: { density: 2.5e-4, length: [16, 60], alpha: [0.15, 0.4], bend: 0.5, grain: { angle: 0.12, strength: 0.55 } }, tone: 0.18 },
      }),
  },
  {
    // Black cardstock — the texture Shayan loved: a near-black, slightly warm
    // sheet; a tooth that only ever LIGHTENS (16 → 32 of 255); two scales of
    // mottle (+12); short bent light fibres (+17 at most). Nothing on it is
    // brighter than a fifth of white, which is why it never reads as dust.
    id: "blackCard",
    label: "Black card",
    tone: [17, 16, 15],
    tile: 512,
    elevation: 34,
    depth: 1.4,
    shade: 0.18,
    mottle: { amount: 0.05, size: 70 },
    edge: { reach: 4, fuzz: 0, rim: 0.2 },
    liftSoftness: 0.6,
    // A cut-out piece rounds over as far as it is thick (see `SurfaceBody.fromLift`).
    body: { profile: "bevel", width: 0.6, fromLift: true, height: 0.5, shade: 0.5 },
    build: (n, u, seed) => {
      const rng = makeRng(seed);
      const tooth = fractal(n, [0.7 * u, 1.5 * u], [1, 0.6], rng);
      const fib = gaussWrap(fibres(n, { density: 7.2e-4, length: [5 * u, 22 * u], alpha: [0.1, 0.4], bend: 0.6 }, rng), n, 0.6 * u);
      const height = empty(n);
      const albedo = empty(n);
      scaleInto(height, fib, 1);
      scaleInto(albedo, fib, 0.17);
      const toothHeight = empty(n);
      const toothAlbedo = empty(n);
      for (let i = 0; i < tooth.length; i++) {
        const t = Math.max(0, tooth[i]!);
        toothHeight[i] = t * 0.6;
        toothAlbedo[i] = t * 0.067;
      }
      return { height, albedo, toothHeight, toothAlbedo };
    },
  },
  {
    // Linen: a fine plain weave (3.5 px threads), slubbed, every thread its
    // own shade — the over-under you can see.
    id: "linen",
    label: "Linen",
    tone: [222, 214, 197],
    tile: 512,
    elevation: 40,
    depth: 1.1,
    shade: 0.5,
    mottle: { amount: -0.05, size: 120 },
    edge: { reach: 4, fuzz: 0.35, rim: 0 },
    liftSoftness: 0.8,
    // A cut-out piece rounds over as far as it is thick (see `SurfaceBody.fromLift`).
    body: { profile: "pillow", width: 1, fromLift: true, height: 0.5, shade: 0.6 },
    build: (n, u, seed) => clothLayers(n, u, seed, { period: 3.6, slub: 0.25, weftTone: 0.92, toneVar: 0.05, contrast: 0.22, primer: 0 }),
  },
  {
    // Artist's canvas: a coarser cloth with irregular slubs, under a primer
    // that fills the valleys and adds a gritty tooth.
    id: "canvas",
    label: "Canvas",
    tone: [232, 225, 209],
    tile: 640,
    elevation: 38,
    depth: 1.3,
    shade: 0.55,
    mottle: { amount: -0.04, size: 140 },
    edge: { reach: 5, fuzz: 0, rim: 0 },
    liftSoftness: 0.8,
    // A cut-out piece rounds over as far as it is thick (see `SurfaceBody.fromLift`).
    body: { profile: "pillow", width: 1, fromLift: true, height: 0.5, shade: 0.6 },
    build: (n, u, seed) => clothLayers(n, u, seed, { period: 5.5, slub: 0.6, weftTone: 0.94, toneVar: 0.035, contrast: 0.14, primer: 0.25 }),
  },
  {
    // Felt: no weave, no grain — a dense mat of short fibres in every
    // direction, clumped, fuzzy. It is soft in the light and breaks every edge.
    id: "felt",
    label: "Felt",
    tone: [214, 208, 200],
    tile: 512,
    elevation: 48,
    depth: 1.5,
    shade: 0.5,
    mottle: { amount: -0.05, size: 50 },
    edge: { reach: 7, fuzz: 1, rim: 0 },
    liftSoftness: 1.4,
    // A cut-out piece rounds over as far as it is thick (see `SurfaceBody.fromLift`).
    body: { profile: "pillow", width: 1.8, fromLift: true, height: 1, shade: 0.75 },
    build: (n, u, seed) => {
      const rng = makeRng(seed);
      const mat = gaussWrap(fibres(n, { density: 0.012, length: [4 * u, 14 * u], alpha: [0.08, 0.25], bend: 1 }, rng), n, 0.8 * u);
      const clumps = fractal(n, [5 * u, 13 * u], [1, 0.7], rng);
      let mean = 0;
      for (let i = 0; i < mat.length; i++) mean += mat[i]!;
      mean /= mat.length;
      const height = empty(n);
      const albedo = empty(n);
      for (let i = 0; i < mat.length; i++) {
        height[i] = (mat[i]! - mean) * 1.4 + clumps[i]! * 0.35;
        albedo[i] = (mat[i]! - mean) * 0.55 + clumps[i]! * 0.06;
      }
      const fine = fractal(n, [0.7 * u], [1], rng);
      const toothHeight = empty(n);
      const toothAlbedo = empty(n);
      scaleInto(toothHeight, fine, 0.2);
      scaleInto(toothAlbedo, fine, 0.04);
      return { height, albedo, toothHeight, toothAlbedo };
    },
  },
  {
    // Corrugated cardboard: a kraft liner over flutes. The flutes show through
    // as soft ridges every 18 px — lit on one side, shaded on the other.
    id: "cardboard",
    label: "Cardboard",
    tone: [198, 160, 114],
    tile: 576,
    elevation: 30,
    depth: 2.2,
    shade: 0.6,
    mottle: { amount: -0.07, size: 100 },
    edge: { reach: 6, fuzz: 0, rim: 0.25 },
    liftSoftness: 0.6,
    // A cut-out piece rounds over as far as it is thick (see `SurfaceBody.fromLift`).
    body: { profile: "bevel", width: 0.5, fromLift: true, height: 0.6, shade: 0.6 },
    build: (n, u, seed) => {
      const liner = paperLayers(n, u, seed, {
        tooth: [0.9, 2],
        fibres: { density: 1e-3, length: [12, 48], alpha: [0.1, 0.35], bend: 0.5, grain: { angle: 0, strength: 0.4 } },
        fibreTone: -0.18,
        toothTone: -0.06,
        flecks: { density: 8e-5, radius: [0.6, 1.5], tone: -0.35 },
      });
      const flutes = Math.max(2, Math.round(n / (24 * u)));
      for (let y = 0; y < n; y++) {
        const ridge = 0.5 - 0.5 * Math.cos((2 * Math.PI * y * flutes) / n);
        for (let x = 0; x < n; x++) {
          const i = y * n + x;
          liner.height[i] = liner.height[i]! * 0.8 + ridge * 1.3 * u;
          liner.albedo[i] = liner.albedo[i]! + (ridge - 0.5) * 0.012;
        }
      }
      return liner;
    },
  },
  {
    // Crumpled paper: big folds and small crinkles, each a crease with a lit
    // face and a shaded one, on a white sheet with a light tooth.
    id: "crumpled",
    label: "Crumpled paper",
    tone: [240, 237, 230],
    tile: 1024,
    elevation: 42,
    depth: 1.5,
    shade: 0.5,
    mottle: { amount: -0.03, size: 160 },
    edge: { reach: 5, fuzz: 0, rim: 0.5 },
    liftSoftness: 0.7,
    // A cut-out piece rounds over as far as it is thick (see `SurfaceBody.fromLift`).
    body: { profile: "bevel", width: 0.6, fromLift: true, height: 0.5, shade: 0.6 },
    build: (n, u, seed) => {
      const base = paperLayers(n, u, seed, {
        tooth: [0.8, 1.8],
        fibres: { density: 6e-4, length: [8, 40], alpha: [0.08, 0.3], bend: 0.6 },
        fibreTone: -0.1,
        toothTone: -0.04,
      });
      // Folds are tens of px tall where a fibre is a fraction of one: the
      // fold field carries its own scale so the shared `depth` stays a
      // paper's and the tooth does not turn to stucco.
      const f = folds(n, u, makeRng(seed ^ 0x5bd1));
      for (let i = 0; i < f.length; i++) base.height[i] = base.height[i]! + f[i]! * 18 * u;
      return base;
    },
  },
  {
    // Cold-press watercolour paper: a bright sheet pitted with a coarse,
    // rounded tooth (the pits a wash settles into), few fibres, and a blotchy
    // mottle — a wash never dries even. Its edge POOLS: pigment runs to the
    // wet rim and dries darker there.
    id: "watercolor",
    label: "Watercolour paper",
    tone: [246, 242, 233],
    tile: 640,
    elevation: 40,
    depth: 1.7,
    shade: 0.5,
    mottle: { amount: -0.1, size: 55 },
    edge: { reach: 9, fuzz: 0, rim: 0, pool: 0.75 },
    liftSoftness: 0.7,
    build: (n, u, seed) => {
      const base = paperLayers(n, u, seed, {
        tooth: [1.6, 4.2],
        fibres: { density: 3e-4, length: [6, 28], alpha: [0.06, 0.2], bend: 0.7 },
        fibreTone: -0.06,
        toothTone: -0.11,
      });
      // The pits are round and deep; the tooth carries most of the relief.
      for (let i = 0; i < base.toothHeight.length; i++) base.toothHeight[i] = base.toothHeight[i]! * 2.2;
      return base;
    },
  },
  {
    // Modelling clay: no fibres, no weave — soft lumps from being pressed,
    // a few FINGERPRINTS (whorls of fine ridges) and tool drags. It is lit
    // from high and casts a pillowy shadow: the stop-motion puppet surface.
    id: "clay",
    label: "Clay",
    tone: [206, 128, 96],
    tile: 768,
    elevation: 52,
    depth: 2.4,
    shade: 0.42,
    mottle: { amount: -0.035, size: 80 },
    edge: { reach: 4, fuzz: 0, rim: 0 },
    liftSoftness: 1.8,
    // A cut-out piece rounds over as far as it is thick (see `SurfaceBody.fromLift`).
    body: { profile: "dome", width: 2.5, fromLift: true, height: 0.9, shade: 0.7 },
    // Plasticine has a waxy sheen where it was pressed smooth.
    gloss: { amount: 0.15, tightness: 12, metal: 0, iridescence: 0, mirror: 0, micro: 0.8 },
    build: (n, u, seed) => {
      const rng = makeRng(seed);
      const lumps = fractal(n, [10 * u, 28 * u], [1, 0.8], rng);
      const prints = fingerprints(n, u, rng);
      const drags = gaussWrap(fibres(n, { density: 1.6e-4 / (u * u), length: [14 * u, 40 * u], alpha: [0.25, 0.6], bend: 0.35 }, rng), n, 1.1 * u);
      const height = empty(n);
      const albedo = empty(n);
      for (let i = 0; i < height.length; i++) {
        height[i] = lumps[i]! * 1.6 + prints[i]! * 0.55 - drags[i]! * 1.4;
        albedo[i] = lumps[i]! * 0.025 - drags[i]! * 0.05;
      }
      const fine = fractal(n, [0.9 * u], [1], rng);
      const toothHeight = empty(n);
      const toothAlbedo = empty(n);
      scaleInto(toothHeight, fine, 0.12);
      scaleInto(toothAlbedo, fine, 0.015);
      return { height, albedo, toothHeight, toothAlbedo };
    },
  },
  {
    // Blueprint (cyanotype) paper: a deep Prussian-blue sheet, a fine tooth,
    // pale fibres, and the drafting GRID printed into it — light lines every
    // 24 px, a heavier one every fourth. Its grid only ever LIGHTENS, like
    // the light fibres of black card, so it reads on the sheet and fades on
    // whatever is drawn over it.
    id: "blueprint",
    label: "Blueprint",
    tone: [24, 60, 132],
    tile: 576,
    elevation: 36,
    depth: 1.1,
    shade: 0.22,
    mottle: { amount: 0.05, size: 120 },
    edge: { reach: 3, fuzz: 0, rim: 0 },
    liftSoftness: 0.6,
    build: (n, u, seed) => {
      const rng = makeRng(seed);
      const tooth = fractal(n, [0.7 * u, 1.6 * u], [1, 0.5], rng);
      const fib = gaussWrap(fibres(n, { density: 3e-4, length: [5 * u, 18 * u], alpha: [0.06, 0.2], bend: 0.6 }, rng), n, 0.6 * u);
      const lines = ruledGrid(n, u, { pitch: 24, every: 4, minor: 0.045, major: 0.07 });
      const height = empty(n);
      const albedo = empty(n);
      for (let i = 0; i < height.length; i++) {
        height[i] = fib[i]! * 0.8;
        albedo[i] = fib[i]! * 0.12 + lines[i]!;
      }
      const toothHeight = empty(n);
      const toothAlbedo = empty(n);
      for (let i = 0; i < tooth.length; i++) {
        toothHeight[i] = tooth[i]! * 0.4;
        toothAlbedo[i] = Math.max(0, tooth[i]!) * 0.05;
      }
      return { height, albedo, toothHeight, toothAlbedo };
    },
  },
  {
    // Newsprint: cheap groundwood pulp — a greyed, faintly yellow sheet
    // crowded with SHORT dark fibres and specks of bark, calendered flat (a
    // weak relief), and blotchy where the pulp ran thin. It is the sheet a
    // halftone was always printed on.
    id: "newsprint",
    label: "Newsprint",
    tone: [229, 224, 210],
    tile: 512,
    elevation: 42,
    depth: 1.2,
    shade: 0.32,
    mottle: { amount: -0.07, size: 130 },
    edge: { reach: 4, fuzz: 0, rim: 0.2 },
    liftSoftness: 0.6,
    build: (n, u, seed) =>
      paperLayers(n, u, seed, {
        tooth: [0.7, 1.6],
        fibres: { density: 2.6e-3, length: [3, 16], alpha: [0.1, 0.35], bend: 0.8 },
        fibreTone: -0.14,
        toothTone: -0.06,
        flecks: { density: 2.4e-4, radius: [0.4, 1.1], tone: -0.4 },
      }),
  },
  {
    // A planed board: rings, latewood lines, streaks and pores along x (see
    // `woodGrain`), under a fine sanded tooth. Lit, the grain shows through
    // paint; with breakup, ink skips the latewood — a woodblock print.
    id: "wood",
    label: "Wood",
    tone: [202, 160, 114],
    tile: 768,
    elevation: 34,
    depth: 1.6,
    shade: 0.5,
    mottle: { amount: -0.06, size: 160 },
    edge: { reach: 4, fuzz: 0, rim: 0 },
    liftSoftness: 0.7,
    // A cut-out piece rounds over as far as it is thick (see `SurfaceBody.fromLift`).
    body: { profile: "bevel", width: 0.4, fromLift: true, height: 0.8, shade: 0.6 },
    build: (n, u, seed) => {
      const rng = makeRng(seed);
      const { height, albedo } = woodGrain(n, u, rng);
      const fine = fractal(n, [0.7 * u], [1], rng);
      const toothHeight = empty(n);
      const toothAlbedo = empty(n);
      scaleInto(toothHeight, fine, 0.18);
      scaleInto(toothAlbedo, fine, 0.02);
      return { height, albedo, toothHeight, toothAlbedo };
    },
  },
  {
    // Graph paper: a bright smooth sheet with a printed grid — a fine line
    // every 24 px, a bolder one every fifth — that darkens whatever is drawn
    // over it, the way a marker never quite hides the grid.
    id: "graph",
    label: "Graph paper",
    tone: [248, 247, 242],
    tile: 600,
    elevation: 40,
    depth: 1.2,
    shade: 0.35,
    mottle: { amount: -0.03, size: 150 },
    edge: { reach: 4, fuzz: 0, rim: 0.3 },
    liftSoftness: 0.7,
    build: (n, u, seed) => {
      const base = paperLayers(n, u, seed, {
        tooth: [0.7, 1.5],
        fibres: { density: 5e-4, length: [6, 30], alpha: [0.06, 0.2], bend: 0.6 },
        fibreTone: -0.08,
        toothTone: -0.03,
      });
      scaleInto(base.albedo, ruledGrid(n, u, { pitch: 24, every: 5, minor: 1, major: 1 }), -0.1);
      return base;
    },
  },
];

/**
 * Every material, in the order the card offers them: the sheets first (paper
 * and its kin, cloth, card, clay, wood), then the material engine's (v112) —
 * foil, chrome, neon, glass, film, ferrofluid, kintsugi, tufting, phosphor,
 * rice paper, marbling — whose rows live in `surface-materials.ts`.
 */
export const SURFACE_RECIPES: readonly SurfaceRecipe[] = [...SHEET_RECIPES, ...MATERIAL_RECIPES];

const RECIPES = new Map<SurfaceMaterial, SurfaceRecipe>(SURFACE_RECIPES.map((r) => [r.id, r]));

export function surfaceRecipe(material: SurfaceMaterial | string): SurfaceRecipe {
  return RECIPES.get(material as SurfaceMaterial) ?? SURFACE_RECIPES[0]!;
}

// ── Params ───────────────────────────────────────────────────────────────────

export interface SurfaceParams {
  material: SurfaceMaterial;
  /** Device px per frame px, × the card's `scale` — the size of one material unit. */
  unit: number;
  relief: number;
  tooth: number;
  /** Unit vector TOWARD the light, screen space (y down). */
  lightX: number;
  lightY: number;
  /** The light angle in degrees, kept for cache keys. */
  lightAngle: number;
  mode: SurfaceColorMode;
  /** The sheet colour: the recipe's tone × the dye, 0..255. */
  tone: readonly [number, number, number];
  edge: number;
  /** Device px. */
  lift: number;
  shadow: number;
  breakup: number;
  /** 0..1 — how far light passes through untouched (`surfaceLightMask`). */
  lights: number;
  /** Which pixels are light: the light layers' matte, or a guess from colour. */
  lightsFrom: SurfaceLightsFrom;
  mix: number;
  /** The material's own seed: fixed across steps — the sheet is one sheet. */
  seed: number;
  /** Where the sheet sits under the camera at this step, 0..1 of a tile. */
  offsetX: number;
  offsetY: number;
  /** The step's seed — the mottle re-rolls with it. */
  stepSeed: number;
  /** The physics dials (× the recipe's tuned behaviour). */
  body: number;
  sheen: number;
  glow: number;
  flow: number;
  /** The dye, 0..255, kept so a morph's other material can be dyed the same. */
  dye: readonly [number, number, number];
  /**
   * A custom texture's image asset id, or null for the material's own
   * pattern. The host reads the image (core never decodes) and hands its
   * pixels to `buildSurfaceLayers`; until they arrive it draws the material.
   */
  texture: string | null;
  /** 0..1 — how much of the texture's own colour is printed. */
  textureColor: number;
  textureTiling: SurfaceTextureTiling;
  /** The material this one is becoming, and how far (0..1). */
  to: SurfaceMaterial | null;
  morph: number;
  morphStyle: SurfaceMorphStyle;
}

export function resolveSurfaceParams(
  fx: SurfaceEffect,
  sampled: Record<string, KeyframeValue>,
  scale: number,
  timeSec: number,
  resolveColor: (c: string) => string = (c) => c,
  modulators?: readonly Modulator[],
): SurfaceParams {
  const fields = layerEffectTypeDef("surface")?.fields ?? [];
  const v = resolveEffectValues(fields, fx as unknown as Record<string, unknown>, sampled, (k) => layerEffectPath(fx.id, k), {
    scale,
    resolveColor,
    modulators,
    timeSec,
  });
  const seed = Math.round(Number(v.seed) || 0);
  const step = resolveTemporalStep(
    { seed, rate: Number(v.rate) || 12, jitter: Number(v.jitter) || 0, stutter: Number(v.stutter) || 0 },
    ownClockSec(fx, timeSec),
  );
  const recipe = surfaceRecipe(String(v.material));
  const dye = parseHexColor(String(v.dye)) ?? { r: 255, g: 255, b: 255, a: 1 };
  const a = (Number(v.lightAngle) * Math.PI) / 180;
  // Step 0 is the sheet as authored; every later step shifts it. Without the
  // special case, switching Animate on would move a look you had approved.
  const shifted = step.index !== 0;
  return {
    material: recipe.id,
    unit: Math.max(0.1, Number(v.scale)),
    relief: Math.max(0, Number(v.relief)),
    tooth: Math.max(0, Number(v.tooth)),
    lightX: Math.cos(a),
    lightY: Math.sin(a),
    lightAngle: Math.round(Number(v.lightAngle)),
    mode: (["lit", "multiply", "under", "blind"].includes(String(v.colorMode)) ? v.colorMode : "lit") as SurfaceColorMode,
    tone: [(recipe.tone[0] * dye.r) / 255, (recipe.tone[1] * dye.g) / 255, (recipe.tone[2] * dye.b) / 255],
    edge: clamp01(Number(v.edge)),
    lift: Number(v.lift) || 0,
    shadow: clamp01(Number(v.shadow)),
    breakup: clamp01(Number(v.breakup)),
    lights: clamp01(Number(v.lights) || 0),
    lightsFrom: v.lightsFrom === "colour" ? "colour" : "layers",
    mix: clamp01(Number(v.mix)),
    seed,
    offsetX: shifted ? rand01(step.seed, 0x51) : 0,
    offsetY: shifted ? rand01(step.seed, 0x52) : 0,
    stepSeed: shifted ? step.seed : seed,
    body: Math.max(0, Number(v.body) || 0),
    sheen: Math.max(0, Number(v.sheen) || 0),
    glow: Math.max(0, Number(v.glow) || 0),
    flow: Math.max(0, Number(v.flow) || 0),
    dye: [dye.r, dye.g, dye.b],
    texture: String(v.texture ?? "") || null,
    textureColor: clamp01(Number(v.textureColor) || 0),
    textureTiling: v.textureTiling === "mirror" ? "mirror" : "repeat",
    to: (SURFACE_MATERIALS as readonly string[]).includes(String(v.to)) && v.to !== recipe.id ? (v.to as SurfaceMaterial) : null,
    morph: clamp01(Number(v.morph) || 0),
    morphStyle: (["spread", "sweep", "fade"].includes(String(v.morphStyle)) ? v.morphStyle : "spread") as SurfaceMorphStyle,
  };
}

// ── The morph ────────────────────────────────────────────────────────────────

/**
 * The two materials a morph is between, each a complete set of params — the
 * renderer evaluates both whole (sheet, cut, body, light) and blends them by
 * the front. Null `b` = no morph at this instant (no target, or the front has
 * not left, or has finished: then `a` is the material that is showing).
 */
export function surfaceMorphEnds(p: SurfaceParams): { a: SurfaceParams; b: SurfaceParams | null } {
  if (!p.to || p.morph < 0.002) return { a: p, b: null };
  const recipe = surfaceRecipe(p.to);
  const b: SurfaceParams = {
    ...p,
    material: recipe.id,
    tone: [(recipe.tone[0] * p.dye[0]) / 255, (recipe.tone[1] * p.dye[1]) / 255, (recipe.tone[2] * p.dye[2]) / 255],
  };
  if (p.morph > 0.998) return { a: b, b: null };
  return { a: p, b };
}

/** Width of the front's soft band, in front units (0..1 of the way across). */
const FRONT_SOFT = 0.07;

/**
 * Where the front reaches FIRST, 0..1, sampled `fw × fh` over a `w × h`
 * region — a pure function of the card's seed, style and light, NOT of
 * `morph`, so a renderer computes it once per region and only thresholds it
 * per frame. Spread is blotchy noise (stains meeting); sweep is the distance
 * from the light's side, roughened.
 */
export function surfaceFrontField(p: SurfaceParams, w: number, h: number, fw: number, fh: number): Float32Array {
  const out = new Float32Array(fw * fh);
  if (p.morphStyle === "fade") return out.fill(0.5);
  const size = Math.max(24, 140 * p.unit);
  const opts = { octaves: 3, gain: 0.5, lacunarity: 2.3, shape: "fractal" as const };
  // Projection onto the light's direction runs 0 at the lit side to 1 at the far side.
  const dx = -p.lightX;
  const dy = -p.lightY;
  const lo = Math.min(0, dx) + Math.min(0, dy);
  const hi = Math.max(0, dx) + Math.max(0, dy);
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      const X = ((x + 0.5) / fw) * w;
      const Y = ((y + 0.5) / fh) * h;
      const n = fbm2(X / size, Y / size, p.seed + 0x3f, opts);
      let v: number;
      if (p.morphStyle === "sweep") {
        const along = (((X / w) * dx + (Y / h) * dy) - lo) / Math.max(1e-6, hi - lo);
        v = along * 0.82 + 0.09 + n * 0.12;
      } else v = n * 0.85 + 0.5;
      out[y * fw + x] = clamp01(v);
    }
  }
  return out;
}

/** The front at `morph`, 0..255 per sample (255 = the new material). */
export function surfaceFrontMask(field: Float32Array, morph: number, out = new Uint8ClampedArray(field.length)): Uint8ClampedArray {
  const t = morph * (1 + 2 * FRONT_SOFT) - FRONT_SOFT;
  for (let i = 0; i < field.length; i++) out[i] = 255 * smoothstep(-FRONT_SOFT, FRONT_SOFT, t - field[i]!);
  return out;
}

export function surfaceIsNoop(p: SurfaceParams): boolean {
  return p.mix < 0.002;
}

/**
 * Does this instant need the picture's PIXELS — its shapes, not only its
 * surface? Lifting, eating the edge, breaking the ink up and laying a sheet
 * under the ground all read the picture; lighting and tinting it do not, and
 * stay on the GPU.
 */
export function surfaceReadsPicture(p: SurfaceParams): boolean {
  const r = surfaceRecipe(p.material);
  return (
    p.edge > 0.002 ||
    Math.abs(p.lift) > 0.25 ||
    p.breakup > 0.002 ||
    p.mode === "under" ||
    p.mode === "blind" ||
    (!!r.flow && p.flow > 0.002) ||
    shapeStageActive(r, p)
  );
}

/** Is the sheet's tile laid over the whole picture (the default), or does the shape stage own it? */
export function surfaceOverlaysAll(p: Pick<SurfaceParams, "material">): boolean {
  return (surfaceRecipe(p.material).overlay ?? "all") === "all";
}

// ── The tile ─────────────────────────────────────────────────────────────────

/** The longest tile side ever generated, device px. Past it the sheet repeats sooner. */
export const SURFACE_TILE_MAX = 1024;

/** What decides the sheet's raw fields: the material, its scale and seed, and a custom texture. */
type LayersInput = Pick<SurfaceParams, "material" | "unit" | "seed"> & Partial<Pick<SurfaceParams, "texture" | "textureColor" | "textureTiling">>;

/** A custom texture's tile side at scale 1, frame px — a photo's detail wants room. */
const TEXTURE_TILE = 512;

/** Tile side in device px for these params. */
export function surfaceTileSize(p: Pick<SurfaceParams, "material" | "unit"> & Partial<Pick<SurfaceParams, "texture">>): number {
  const base = p.texture ? TEXTURE_TILE : surfaceRecipe(p.material).tile;
  const n = Math.max(64, Math.min(SURFACE_TILE_MAX, Math.round(base * p.unit)));
  // Even, so a mirrored texture is exactly four quarters.
  return p.texture ? n & ~1 : n;
}

/**
 * The square, in px, a host draws a texture's image into (cover-fitted)
 * before `buildSurfaceLayers` — the whole tile, or one quarter of it when
 * the texture is mirrored.
 */
export function surfaceTextureSide(p: Pick<SurfaceParams, "material" | "unit"> & Pick<SurfaceParams, "texture" | "textureTiling">): number {
  const n = surfaceTileSize(p);
  return p.textureTiling === "mirror" ? n / 2 : n;
}

/** What the material's own generator produced — keyed WITHOUT light, relief or tooth. */
export function surfaceLayersKey(p: LayersInput): string {
  const own = `${p.material}|${surfaceTileSize(p)}|${p.unit.toFixed(3)}|${p.seed}`;
  return p.texture ? `${own}|tex:${p.texture}|${p.textureTiling ?? "repeat"}|${(p.textureColor ?? 0).toFixed(2)}` : own;
}

/** The lit tile's key: the layers plus everything the shading reads. */
export function surfaceTileKey(p: SurfaceParams): string {
  return `${surfaceLayersKey(p)}|${p.relief.toFixed(3)}|${p.tooth.toFixed(3)}|${p.lightAngle}`;
}

/**
 * The material's raw fields for these params. Expensive; cache by
 * `surfaceLayersKey`. With a custom texture, `image` is its pixels drawn
 * into a `surfaceTextureSide` square; without them (still decoding) the
 * caller must key and build the material's own sheet instead.
 */
export function buildSurfaceLayers(p: LayersInput, image?: { rgba: Uint8ClampedArray; side: number }): { size: number; layers: SurfaceLayers; scale: number } {
  const scale = surfaceTileScale(p);
  const unit = p.unit / scale;
  const n = surfaceTileSize({ ...p, unit });
  const own = surfaceRecipe(p.material).build(n, unit, hashSeed(p.seed, p.material));
  if (!p.texture || !image) return { size: n, layers: own, scale };
  // The texture is the PATTERN; everything else the recipe builds — foil's
  // grooves, glass's panes, marbling's flow — is how the material BEHAVES,
  // and stays.
  return { size: n, scale, layers: { ...own, ...textureSurfaceLayers(image.rgba, image.side, n, p.textureTiling === "mirror", p.textureColor ?? 0) } };
}

/**
 * BUFFER PX PER TEXEL — 1, unless the sheet would outgrow `SURFACE_TILE_MAX`.
 *
 * A tile is `base × unit` px, and `unit` is buffer px per frame px: a
 * material on a layer magnified ×4 (a camera group, a scaled nest) asks for
 * a tile four times the side. Clamped at the max while its features were
 * still drawn at the full unit, the sheet wrapped onto itself — a clay card
 * came out as creased paper, a seam straight across it. So past the max the
 * sheet is built at `unit ÷ scale` (the same material, the same proportions)
 * and every reader samples it `scale` buffer px per texel: the look is the
 * one authored, only its finest grain is interpolated.
 */
export function surfaceTileScale(p: Pick<SurfaceParams, "material" | "unit"> & Partial<Pick<SurfaceParams, "texture">>): number {
  const base = p.texture ? TEXTURE_TILE : surfaceRecipe(p.material).tile;
  return Math.max(1, (base * p.unit) / SURFACE_TILE_MAX);
}

/**
 * A PICTURE AS A SHEET. Its light and dark are read as height (bright stands
 * up, dark is a valley — a crack, a fibre's shadow) and as tone; the fine
 * detail goes to the tooth so the Tooth dial still means "the grain". With
 * `colour`, the picture's own colours are printed too, as the multiply map a
 * phosphor's triads use — level-matched, so a dark photo tints rather than
 * darkens.
 *
 * `rgba` is `side`×`side`; the tile is `n`×`n` — the same picture, or four
 * mirrored copies of it when `mirror` is on (`side` = n/2), which tiles any
 * picture without a seam. Transparent pixels read as the bare sheet.
 */
export function textureSurfaceLayers(
  rgba: Uint8ClampedArray,
  side: number,
  n: number,
  mirror: boolean,
  colour: number,
): Pick<SurfaceLayers, "height" | "albedo" | "toothHeight" | "toothAlbedo" | "tint"> {
  const src = (x: number, y: number) => {
    const sx = mirror && x >= side ? n - 1 - x : x % side;
    const sy = mirror && y >= side ? n - 1 - y : y % side;
    return (sy * side + sx) * 4;
  };
  const lum = new Float32Array(n * n);
  const tintOn = colour > 0.002;
  const tint = tintOn ? new Float32Array(n * n * 3) : undefined;
  let mean = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const o = src(x, y);
      const a = rgba[o + 3]! / 255;
      // Over white: a transparent pixel is the sheet, untouched.
      const r = (rgba[o]! / 255) * a + (1 - a);
      const g = (rgba[o + 1]! / 255) * a + (1 - a);
      const b = (rgba[o + 2]! / 255) * a + (1 - a);
      const i = y * n + x;
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lum[i] = l;
      mean += l;
      if (tint) {
        tint[i * 3] = (r - 1) * colour;
        tint[i * 3 + 1] = (g - 1) * colour;
        tint[i * 3 + 2] = (b - 1) * colour;
      }
    }
  }
  mean /= n * n;
  // Zero-mean, |max| = 1 — the scale every recipe's fields are tuned in, so
  // Relief means the same on a photo as on paper.
  let peak = 1e-6;
  const rel = new Float32Array(n * n);
  for (let i = 0; i < rel.length; i++) {
    rel[i] = lum[i]! - mean;
    peak = Math.max(peak, Math.abs(rel[i]!));
  }
  for (let i = 0; i < rel.length; i++) rel[i] = rel[i]! / peak;
  const coarse = gaussWrap(rel, n, 1.5);
  const height = new Float32Array(n * n);
  const albedo = new Float32Array(n * n);
  const toothHeight = new Float32Array(n * n);
  const toothAlbedo = new Float32Array(n * n);
  // Printed in colour, the picture carries its own tone; the grey tone
  // would darken it twice.
  const tone = 0.55 * (1 - colour);
  for (let i = 0; i < rel.length; i++) {
    height[i] = coarse[i]!;
    toothHeight[i] = (rel[i]! - coarse[i]!) * 0.6;
    albedo[i] = (lum[i]! - mean) * tone;
  }
  return tint ? { height, albedo, toothHeight, toothAlbedo, tint } : { height, albedo, toothHeight, toothAlbedo };
}

function hashSeed(seed: number, material: string): number {
  let h = seed | 0;
  for (let i = 0; i < material.length; i++) h = Math.imul(h ^ material.charCodeAt(i), 0x9e3779b1);
  return h >>> 0;
}

/**
 * The material, LIT. Two greyscale maps a renderer composites with two plain
 * blend modes that every engine has:
 *
 *   dark    multiply, 255 = untouched — shaded slopes, darker fibres, flecks
 *   light   screen,   0 = untouched   — lit slopes, pale fibres, a black card's tooth
 *
 * plus `bite` (0..1, the whole height normalised) — what eats an edge and
 * where dry ink catches. Splitting light from dark is what lets the same tile
 * darken a white shape and lighten a black one; an overlay map would do
 * nothing visible on either.
 */
export interface SurfaceTile {
  size: number;
  /** Buffer px per texel (≥ 1) — see `surfaceTileScale`. Every reader samples through it. */
  scale?: number;
  dark: Uint8ClampedArray;
  light: Uint8ClampedArray;
  bite: Float32Array;
  /** RGBA multiply map from the recipe's `tint` (a phosphor's triads); absent when it has none. */
  color?: Uint8ClampedArray;
  /**
   * 1 ÷ the light `color` passes on average: what the shape stage brightens
   * the face by first, so a grille darkens the picture's texture, not its
   * level. Derived from the map — a band-limited grille that has faded to
   * clear at a thumbnail needs none.
   */
  gain?: number;
  /** The skin's slope (px/px), for the shape stage's highlight; only when the recipe has a body, gloss or skin. */
  skinX?: Float32Array;
  skinY?: Float32Array;
  gloss?: Float32Array;
  film?: Float32Array;
  inlay?: Float32Array;
  cames?: Float32Array;
  pane?: Float32Array;
  flowX?: Float32Array;
  flowY?: Float32Array;
}

export function shadeSurfaceTile(p: SurfaceParams, built: { size: number; layers: SurfaceLayers; scale?: number }): SurfaceTile {
  const n = built.size;
  const { height, albedo, toothHeight, toothAlbedo } = built.layers;
  const recipe = surfaceRecipe(p.material);
  const el = (recipe.elevation * Math.PI) / 180;
  const lx = p.lightX * Math.cos(el);
  const ly = p.lightY * Math.cos(el);
  const lz = Math.sin(el);
  // Height in px per unit at this unit: features and their depth scale
  // together, so a zoomed-in sheet has the same slopes as a zoomed-out one.
  const hp = recipe.depth;
  const total = new Float32Array(n * n);
  for (let i = 0; i < total.length; i++) total[i] = height[i]! + toothHeight[i]! * p.tooth;
  const dark = new Uint8ClampedArray(n * n);
  const light = new Uint8ClampedArray(n * n);
  const bite = new Float32Array(n * n);
  const gain = recipe.shade * p.relief;
  for (let y = 0; y < n; y++) {
    const up = ((y - 1 + n) % n) * n;
    const dn = ((y + 1) % n) * n;
    const row = y * n;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const gx = (total[row + ((x + 1) % n)]! - total[row + ((x - 1 + n) % n)]!) * 0.5 * hp;
      const gy = (total[dn + x]! - total[up + x]!) * 0.5 * hp;
      const inv = 1 / Math.sqrt(gx * gx + gy * gy + 1);
      const ndl = (-gx * lx - gy * ly + lz) * inv;
      const t = (ndl - lz) * gain + albedo[i]! + toothAlbedo[i]! * p.tooth;
      dark[i] = 255 * (1 + Math.min(0, t));
      light[i] = 255 * Math.max(0, t);
    }
  }
  rankInto(bite, total);
  const out: SurfaceTile = { size: n, dark, light, bite, ...(built.scale && built.scale !== 1 ? { scale: built.scale } : {}) };
  const { skin, tint, gloss, film, inlay, cames, pane, flowX, flowY } = built.layers;
  if (recipe.body || recipe.gloss || skin) {
    // The skin's slope: its own field, or the sheet's when it has none.
    const f = skin ?? total;
    const sx = new Float32Array(n * n);
    const sy = new Float32Array(n * n);
    for (let y = 0; y < n; y++) {
      const up = ((y - 1 + n) % n) * n;
      const dn = ((y + 1) % n) * n;
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        sx[i] = (f[y * n + ((x + 1) % n)]! - f[y * n + ((x - 1 + n) % n)]!) * 0.5 * hp * p.relief;
        sy[i] = (f[dn + x]! - f[up + x]!) * 0.5 * hp * p.relief;
      }
    }
    out.skinX = sx;
    out.skinY = sy;
  }
  if (tint) {
    const color = new Uint8ClampedArray(n * n * 4);
    for (let i = 0; i < n * n; i++) {
      color[i * 4] = 255 * (1 + tint[i * 3]!);
      color[i * 4 + 1] = 255 * (1 + tint[i * 3 + 1]!);
      color[i * 4 + 2] = 255 * (1 + tint[i * 3 + 2]!);
      color[i * 4 + 3] = 255;
    }
    out.color = color;
    let mean = 0;
    for (let i = 0; i < n * n; i++) mean += 0.3 * color[i * 4]! + 0.59 * color[i * 4 + 1]! + 0.11 * color[i * 4 + 2]!;
    out.gain = (255 * n * n) / Math.max(1, mean);
  }
  if (gloss) out.gloss = gloss;
  if (film) out.film = film;
  if (inlay) out.inlay = inlay;
  if (cames) out.cames = cames;
  if (pane) out.pane = pane;
  if (flowX && flowY) {
    out.flowX = flowX;
    out.flowY = flowY;
  }
  return out;
}

/**
 * `bite` is the height's RANK — the share of the sheet lower than this pixel,
 * 0..1 — so a breakup of 0.3 loses exactly the lowest 30 % of the tooth on
 * every material. Min–max let one bright fibre squash the rest into a sliver,
 * and a mean/σ scale broke on black card, whose tooth is clipped flat over
 * half the sheet: one threshold kept everything, the next lost half. Ties
 * (that flat half) are ordered by a fixed per-pixel hash, so the floor breaks
 * up as fine grit rather than all at once.
 */
function rankInto(out: Float32Array, values: Float32Array): void {
  const n = values.length;
  const keyed = new Float64Array(n);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    if (values[i]! < lo) lo = values[i]!;
    if (values[i]! > hi) hi = values[i]!;
  }
  const tie = Math.max(1e-9, (hi - lo) * 1e-7);
  for (let i = 0; i < n; i++) keyed[i] = values[i]! + rand01(i, 0x7e1) * tie;
  const sorted = keyed.slice().sort();
  for (let i = 0; i < n; i++) {
    // Lower bound of this key in the sorted list.
    let a = 0;
    let b = n;
    const v = keyed[i]!;
    while (a < b) {
      const mid = (a + b) >> 1;
      if (sorted[mid]! < v) a = mid + 1;
      else b = mid;
    }
    out[i] = a / (n - 1 || 1);
  }
}

/**
 * The coarse tone over the whole region, `fw × fh` samples spanning `w × h`
 * device px — the mottle that keeps a repeated tile from reading as one. A
 * paper's mottle only ever darkens (a multiply map, 255 = untouched); a black
 * card's only lightens (a screen map, 0 = untouched): the recipe's sign says
 * which.
 */
export function surfaceMottle(p: SurfaceParams, w: number, h: number, fw: number, fh: number): { blend: "multiply" | "screen"; data: Uint8ClampedArray } {
  const recipe = surfaceRecipe(p.material);
  const size = Math.max(4, recipe.mottle.size * p.unit);
  const amount = Math.abs(recipe.mottle.amount);
  const screen = recipe.mottle.amount > 0;
  const out = new Uint8ClampedArray(fw * fh);
  const opts = { octaves: 2, gain: 0.55, lacunarity: 2.7, shape: "fractal" as const };
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      const v = fbm2(((x + 0.5) / fw) * (w / size), ((y + 0.5) / fh) * (h / size), p.stepSeed, opts);
      const t = Math.max(0, Math.min(1, v * 0.8 + 0.5)) * amount;
      out[y * fw + x] = screen ? 255 * t : 255 * (1 - t);
    }
  }
  return { blend: screen ? "screen" : "multiply", data: out };
}

// ── The picture's own shapes ─────────────────────────────────────────────────

/**
 * The GROUND of an opaque picture — the flat background colour of an
 * illustration — or null when the picture has transparency (a layer: its
 * alpha IS its shapes) or no dominant flat colour (a photo).
 *
 * This is what lets a whole-frame Surface treat a flat illustration as cut
 * pieces on a sheet: the frame effect sees one opaque composite, but in the
 * work a normal person makes (flat shapes on a plain background) the ground is
 * the one colour that covers the most of the frame. A quarter of the frame is
 * the bar; below it there is no ground and the shapes are the whole picture.
 */
export function detectSurfaceGround(px: Uint8ClampedArray, w: number, h: number): readonly [number, number, number] | null {
  const total = w * h;
  if (total === 0) return null;
  const stride = Math.max(1, Math.floor(Math.sqrt(total / 16384)));
  const bins = new Uint32Array(4096);
  let samples = 0;
  let opaque = 0;
  for (let y = 0; y < h; y += stride) {
    for (let x = 0; x < w; x += stride) {
      const o = (y * w + x) * 4;
      samples++;
      if (px[o + 3]! < 250) continue;
      opaque++;
      bins[((px[o]! >> 4) << 8) | ((px[o + 1]! >> 4) << 4) | (px[o + 2]! >> 4)]!++;
    }
  }
  if (opaque < samples * 0.97) return null;
  let best = 0;
  for (let i = 1; i < 4096; i++) if (bins[i]! > bins[best]!) best = i;
  // The bin is a guess at the colour; the mean of everything near its centre
  // is the colour, and the share of the frame it covers decides.
  const cr = ((best >> 8) << 4) + 8;
  const cg = (((best >> 4) & 15) << 4) + 8;
  const cb = ((best & 15) << 4) + 8;
  let n = 0;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (let y = 0; y < h; y += stride) {
    for (let x = 0; x < w; x += stride) {
      const o = (y * w + x) * 4;
      const dr = px[o]! - cr;
      const dg = px[o + 1]! - cg;
      const db = px[o + 2]! - cb;
      if (dr * dr + dg * dg + db * db > 24 * 24) continue;
      n++;
      sr += px[o]!;
      sg += px[o + 1]!;
      sb += px[o + 2]!;
    }
  }
  if (n < samples * 0.25) return null;
  return [sr / n, sg / n, sb / n];
}

/** Where Spare lights learns which pixels are light (see the schema field). */
export type SurfaceLightsFrom = "layers" | "colour";

/** Chroma (0..1 of max − min) where a pixel starts, and finishes, reading as LIGHT. */
const LIGHT_LO = 0.1;
const LIGHT_HI = 0.35;

/**
 * SPARE LIGHTS BY COLOUR (`lightsFrom: "colour"`) — which pixels of a flat
 * picture are light, 0..255 per pixel, × `amount`. A guess, for media with no
 * layers to ask (a video, a photo): keyed on CHROMA (max − min of the
 * channels), never brightness — in a chalk world white is chalk and grey is
 * the ground, and both belong to the card; what has a colour gives off light.
 * Straight alpha: a pixel counts only as much as it is there.
 *
 * It cannot see a white-hot core (no chroma) and takes any coloured shape for
 * a light, which is why the default is `layers`: the host paints the picture
 * without the layers that emit light (`emitsLight`), lays the material on that,
 * and puts the lights back on top, glow and all.
 */
export function surfaceLightMask(px: Uint8ClampedArray, w: number, h: number, amount: number, out = new Uint8ClampedArray(w * h)): Uint8ClampedArray {
  const k = clamp01(amount) * 255;
  const span = LIGHT_HI - LIGHT_LO;
  for (let i = 0, n = w * h; i < n; i++) {
    const o = i * 4;
    const a = px[o + 3]!;
    if (a === 0 || k === 0) {
      out[i] = 0;
      continue;
    }
    const r = px[o]!;
    const g = px[o + 1]!;
    const b = px[o + 2]!;
    const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    const t = Math.min(1, Math.max(0, (chroma - LIGHT_LO) / span));
    out[i] = t * t * (3 - 2 * t) * (a / 255) * k;
  }
  return out;
}

/** Colour distance at which a pixel stops being ground and starts being a shape (squared). */
const KEY_LO2 = 10 * 10;
const KEY_HI2 = 34 * 34;

/**
 * THE CUT — the part of the material that reads the picture, in place over
 * RGBA (straight alpha, device px). In order:
 *
 *   mask     the picture's shapes: its alpha, × "not the ground" when it has one
 *   edge     the material's own height bites the boundary (fibres, threads), a
 *            torn rim whitens, felt fuzzes outward in the shape's colour
 *   breakup  ink survives only on the tooth's crowns
 *   under    the ground becomes the sheet
 *   lift     the shapes stand off the sheet: their edge is lit on the side
 *            facing the light, shaded opposite, and they cast a soft shadow
 *            onto whatever is under them
 *
 * `tile` is the lit tile, sampled at the step's offset — the same sheet the
 * renderer lays over the result, so a bite follows a fibre you can see.
 *
 * COST. This runs whenever the picture under it changes, so it is built to
 * touch as little as it can: one NARROW field (a pixel or two of blur) serves
 * the edge chew, the torn rim and the lit cut; the soft cast shadow reads a
 * COARSE field blurred at a quarter or sixteenth of the pixels (a shadow that
 * soft has no detail to lose); and a pixel nothing can reach — deep inside a
 * shape, or open ground far from one — is skipped before any maths.
 */
export function cutSurface(px: Uint8ClampedArray, w: number, h: number, p: SurfaceParams, tile: SurfaceTile): void {
  const recipe = surfaceRecipe(p.material);
  // ── Flow: the picture is carried along the material first — marbling
  // swirls the shapes themselves, so everything after reads swirled shapes.
  if (recipe.flow && p.flow > 0.002 && tile.flowX && tile.flowY) {
    const T = tile.size;
    flowPicture(
      px, w, h,
      { size: T, x: tile.flowX, y: tile.flowY, ox: Math.floor(p.offsetX * T), oy: Math.floor(p.offsetY * T), scale: tile.scale },
      recipe.flow.amount * p.unit * p.flow,
      recipe.flow.steps,
    );
  }
  const found = detectSurfaceGround(px, w, h);
  const blind = p.mode === "blind";
  const n = w * h;
  const mask = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    let m = px[o + 3]! / 255;
    if (found && m > 0) {
      const dr = px[o]! - found[0];
      const dg = px[o + 1]! - found[1];
      const db = px[o + 2]! - found[2];
      const d2 = dr * dr + dg * dg + db * db;
      if (d2 <= KEY_LO2) m = 0;
      else if (d2 < KEY_HI2) m *= smoothstep(0, 1, (Math.sqrt(d2) - 10) / 24);
    }
    mask[i] = m;
  }
  // Blind: every pixel is the sheet; only the relief below says where the
  // shapes were. The ground IS the sheet, so un-mixing an edge stays exact.
  const ground = blind && found ? p.tone : found;
  if (blind) {
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      px[o] = p.tone[0];
      px[o + 1] = p.tone[1];
      px[o + 2] = p.tone[2];
    }
  }

  const T = tile.size;
  const ox = Math.floor(p.offsetX * T);
  const oy = Math.floor(p.offsetY * T);
  const bites = tile.bite;
  const inv = 1 / (tile.scale ?? 1);

  const wantsEdge = p.edge > 0.002;
  // Negative lift PRESSES the shapes into the sheet: the wall facing the
  // light is in shade, the far one lit, and the shadow falls inside.
  const press = p.lift < -0.25;
  const lift = Math.abs(p.lift);
  const wantsLift = lift > 0.25;
  // THE NARROW FIELD — a blurred copy of the mask sits near 0.5 on the
  // boundary and saturates inside: the roughen-edges idea, with the bite taken
  // from the MATERIAL instead of isotropic noise. The lit cut reads its slope.
  const reach = recipe.edge.reach * p.unit * (0.4 + p.edge);
  const rimSoft = Math.max(1, 1.2 * p.unit * Math.max(1, recipe.liftSoftness));
  const narrowR = wantsEdge ? reach * 0.5 : rimSoft * 0.5;
  const narrow = wantsEdge || wantsLift ? boxBlurClamp(mask, w, h, narrowR, 2) : null;
  // Felt fuzzes OUTWARD in the shape's own colour: the mask-weighted colour
  // nearby, blurred the same way.
  const fuzz = wantsEdge && recipe.edge.fuzz > 0 ? recipe.edge.fuzz * p.edge : 0;
  const pool = wantsEdge && recipe.edge.pool ? recipe.edge.pool * Math.min(1, p.edge * 1.6) : 0;
  let near: Float32Array[] | null = null;
  if (fuzz > 0.002) {
    near = [0, 1, 2].map((c) => {
      const f = new Float32Array(n);
      for (let i = 0; i < n; i++) f[i] = px[i * 4 + c]! * mask[i]!;
      return boxBlurClamp(f, w, h, narrowR, 2);
    });
  }
  // THE COARSE FIELD — the soft cast shadow.
  const softness = Math.max(1, lift * recipe.liftSoftness);
  const wide = wantsLift ? coarseBlur(mask, w, h, softness * 0.5) : null;
  const sheet = p.mode === "under";
  const breakup = p.breakup > 0.002;
  const toneR = p.tone[0];
  const toneG = p.tone[1];
  const toneB = p.tone[2];
  const shiftX = p.lightX * lift;
  const shiftY = p.lightY * lift;
  const cutGain = 0.9 * Math.min(2, 0.4 + p.relief * 0.6);
  // `bite` is a rank, so the threshold IS the share of ink lost: 12 % of the
  // tooth's floor at a touch of breakup, 57 % at full.
  const th = 0.12 + p.breakup * 0.45;

  for (let y = 0; y < h; y++) {
    const by = ((((y * inv) | 0) + oy) % T) * T;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const m0 = mask[i]!;
      const nf = narrow ? narrow[i]! : m0;
      // Untouched: fully inside or fully out, nothing near, no ink to break,
      // no ground to swap. Only a shadow can still reach open ground.
      // (A sliding-sum blur drifts by ulps, so "exactly 0 or 1" is a band.)
      const out = m0 < 0.002 && nf < 0.002;
      const inside = m0 > 0.998 && nf > 0.998;
      if ((out || inside) && !breakup && !(sheet && out)) {
        if (!wide || (press ? out : inside)) continue;
        // Nearest cell, no interpolation: this is only "could a shadow be here?".
        const cx = ((x + shiftX) / wide.f) | 0;
        const cy = ((y + shiftY) / wide.f) | 0;
        if (cx < 0 || cy < 0 || cx >= wide.w || cy >= wide.h) continue;
        const occ = wide.data[cy * wide.w + cx]!;
        if (press ? occ > 0.998 : occ < 0.002) continue;
      }
      const o = i * 4;
      let m = m0;
      let r = px[o]!;
      let g = px[o + 1]!;
      let b = px[o + 2]!;
      let a = px[o + 3]!;
      const bite = bites[by + ((((x * inv) | 0) + ox) % T)]!;

      // ── Edge: the material chews the boundary ────────────────────────────
      let rim = 0;
      if (wantsEdge && m0 > 0.002) {
        const chew = (bite - 0.5) * 1.6 * p.edge;
        const keep = smoothstep(0.42, 0.58, nf + chew * 0.45);
        m = m0 * keep;
        rim = recipe.edge.rim * p.edge * Math.max(0, 1 - Math.abs(nf - 0.62) / 0.14) * keep;
      }
      // ── Breakup: ink only where the tooth stands up ──────────────────────
      // Narrow on purpose: dry media is there or it is not. A soft ramp
      // turned chalk into grey felt.
      if (breakup && m > 0.002) m *= smoothstep(th - 0.025, th + 0.025, bite);

      if (ground) {
        // An opaque picture. A pixel is the shape's colour S over the ground G
        // at its mask (antialiased edges are part of both): P = m0·S + (1−m0)·G.
        // The cut leaves the shape a share m of it, and the rest shows B — the
        // sheet, or the ground it always was.
        if (sheet || m !== m0) {
          const br = sheet ? toneR : ground[0];
          const bg = sheet ? toneG : ground[1];
          const bb = sheet ? toneB : ground[2];
          if (m0 > 0.02) {
            const sr = clamp255((r - (1 - m0) * ground[0]) / m0);
            const sg = clamp255((g - (1 - m0) * ground[1]) / m0);
            const sb = clamp255((b - (1 - m0) * ground[2]) / m0);
            r = m * sr + (1 - m) * br;
            g = m * sg + (1 - m) * bg;
            b = m * sb + (1 - m) * bb;
          } else if (sheet) {
            r = br;
            g = bg;
            b = bb;
          }
        }
      } else if (a > 0) {
        // A layer: lost ink is lost alpha. Under a sheet, the paint sits on it.
        const k = m0 > 0.002 ? m / m0 : 0;
        if (sheet) {
          const ia = a / 255;
          r = r * ia + toneR * (1 - ia);
          g = g * ia + toneG * (1 - ia);
          b = b * ia + toneB * (1 - ia);
        }
        a = a * k;
      }
      if (rim > 0.002) {
        r += (250 - r) * rim;
        g += (247 - g) * rim;
        b += (240 - b) * rim;
      }
      // ── Pool: pigment dries darker inside a wet edge ─────────────────────
      // A band just inside the boundary, uneven along its length because the
      // paper's own tooth decides where the water stood. It multiplies the
      // shape's own colour, so an orange wash pools burnt orange, never grey.
      if (pool > 0 && m > 0.002 && nf < 0.995) {
        const band = smoothstep(0.42, 0.62, nf) * (1 - smoothstep(0.72, 0.99, nf));
        const k = pool * band * (0.55 + bite * 0.9) * Math.min(1, m * 1.4);
        if (k > 0.002) {
          const d = 1 - Math.min(0.6, k * 0.55);
          r *= d;
          g *= d * 0.985;
          b *= d * 0.97;
        }
      }

      // ── Fuzz: fibres reach out past the edge in the shape's colour ───────
      if (near && nf > 0.01 && m < 0.98) {
        const f = smoothstep(0.08, 0.5, nf * (0.6 + bite * 1.1)) * fuzz * (1 - m);
        if (f > 0.002) {
          const cr = near[0]![i]! / nf;
          const cg = near[1]![i]! / nf;
          const cb = near[2]![i]! / nf;
          if (ground || a >= 254) {
            r += (cr - r) * f;
            g += (cg - g) * f;
            b += (cb - b) * f;
          } else {
            const na = a + (255 - a) * f;
            const wNew = (255 * f * (1 - a / 255)) / Math.max(1, na);
            r += (cr - r) * wNew;
            g += (cg - g) * wNew;
            b += (cb - b) * wNew;
            a = na;
          }
        }
      }

      // ── Lift: a raised edge, and the shadow it casts ─────────────────────
      if (wide && narrow) {
        if (nf > 0 && nf < 1) {
          const xl = x > 0 ? x - 1 : x;
          const xr = x < w - 1 ? x + 1 : x;
          const yu = y > 0 ? y - 1 : y;
          const yd = y < h - 1 ? y + 1 : y;
          const gx = (narrow[y * w + xr]! - narrow[y * w + xl]!) * 0.5;
          const gy = (narrow[yd * w + x]! - narrow[yu * w + x]!) * 0.5;
          // The edge facing the light rises toward it: its gradient points away.
          const face = (gx * p.lightX + gy * p.lightY) * rimSoft * 2.2 * cutGain * (press ? -1 : 1);
          const shapeW = Math.min(1, m * 1.2);
          if (shapeW > 0.002) {
            const sh = -face * shapeW;
            if (sh > 0) {
              const k = Math.min(0.6, sh * 0.7);
              r += (255 - r) * k;
              g += (255 - g) * k;
              b += (255 - b) * k;
            } else {
              const k = 1 + Math.max(-0.6, sh * 0.9);
              r *= k;
              g *= k;
              b *= k;
            }
          }
        }
        // Pressed in: the occluder is the SHEET toward the light, and its
        // shadow falls across the floor of the recess.
        if (press && m > 0.002) {
          const occ = sampleCoarse(wide, x + shiftX, y + shiftY);
          const cast = p.shadow * Math.max(0, m - occ) * 0.7;
          if (cast > 0.002) {
            r *= 1 - cast;
            g *= 1 - cast * 1.02;
            b *= 1 - cast * 1.05;
          }
        }
        // The occluder is the shape TOWARD the light, one lift away.
        if (!press && m < 1) {
          const occ = sampleCoarse(wide, x + shiftX, y + shiftY);
          const cast = p.shadow * Math.max(0, occ - m) * 0.7;
          if (cast > 0.002) {
            if (ground || a >= 254) {
              r *= 1 - cast;
              g *= 1 - cast * 1.02;
              b *= 1 - cast * 1.05;
            } else {
              // Past a layer's own edge the shadow IS the pixel.
              const na = a + (255 - a) * cast;
              const keep = a / Math.max(1, na);
              r *= keep;
              g *= keep;
              b *= keep;
              a = na;
            }
          }
        }
      }

      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = b;
      px[o + 3] = a;
      mask[i] = m;
    }
  }

  // ── The shape stage: body, sheen, glow, lead, spikes (`surface-body.ts`)
  if (shapeStageActive(recipe, p)) {
    shapeSurface(px, w, h, mask, ground ? (sheet ? p.tone : ground) : null, recipe, {
      unit: p.unit,
      lightX: p.lightX,
      lightY: p.lightY,
      lightAngle: p.lightAngle,
      elevation: recipe.elevation,
      lift: p.lift,
      edge: p.edge,
      body: p.body,
      sheen: p.sheen,
      glow: p.glow,
      offsetX: p.offsetX,
      offsetY: p.offsetY,
    }, tile);
  }
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}

