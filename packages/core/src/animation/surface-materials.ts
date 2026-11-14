import { makeRng } from "./temporal";
import {
  bricks,
  cracks,
  curlFlow,
  empty,
  facets,
  fibres,
  fractal,
  gaussWrap,
  hash01,
  loopPile,
  paperLayers,
  phosphorTriads,
  scaleInto,
  voronoi,
  type SurfaceLayers,
  type SurfaceRecipe,
} from "./surface-fields";

/**
 * THE MATERIAL ENGINE'S MATERIALS (v112) — rows of `SURFACE_RECIPES` whose
 * look comes mostly from the SHAPE STAGE (`surface-body.ts`): a body, a
 * gloss, a glow, a flow, lead, spikes, an inlay. Each row is data around one
 * shared pipeline; what a material needs that no other does is a generator
 * in `surface-fields.ts`, never a branch in the renderer.
 *
 * Tuned on a flat colour illustration (a sunburst on a plain ground) at
 * 1080 px, by looking. `overlay: "ground"` rows keep their sheet off the
 * shapes: neon's brick is behind the tube, not printed on it.
 */

/** A quiet ground: a fine tooth and nothing else (a backdrop, a smooth card). */
function smoothSheet(n: number, u: number, seed: number, tooth = 0.04): SurfaceLayers {
  const rng = makeRng(seed);
  const fine = fractal(n, [0.8 * u, 2 * u], [1, 0.4], rng);
  const toothHeight = empty(n);
  const toothAlbedo = empty(n);
  scaleInto(toothHeight, fine, 0.3);
  scaleInto(toothAlbedo, fine, -tooth);
  return { height: empty(n), albedo: empty(n), toothHeight, toothAlbedo };
}

export const MATERIAL_RECIPES: readonly SurfaceRecipe[] = [
  {
    // HOLOGRAPHIC FOIL, stamped on white card. The secret is that the colour
    // is not on the foil, it is in the ANGLE: tiny embossed flakes and a
    // diffraction grating each tilt the light a different way, so the
    // rainbow breaks into shards and slides when the light (or the shape)
    // moves. Key `lightAngle` and the whole stamp shimmers.
    id: "foil",
    label: "Holographic foil",
    tone: [238, 236, 230],
    tile: 512,
    elevation: 40,
    depth: 1.2,
    shade: 0.3,
    mottle: { amount: -0.03, size: 120 },
    edge: { reach: 3, fuzz: 0, rim: 0 },
    liftSoftness: 0.5,
    overlay: "ground",
    body: { profile: "bevel", width: 3, height: 0.8, shade: 0.5 },
    gloss: { amount: 0.9, tightness: 28, metal: 1, iridescence: 1, mirror: 0.4, micro: 1 },
    pigment: { color: [206, 209, 216], amount: 0.5 },
    build: (n, u, seed) => {
      const base = smoothSheet(n, u, seed);
      const rng = makeRng(seed ^ 0x51f);
      const flakes = facets(voronoi(n, 11 * u, rng), n, 0.35);
      const k = Math.max(1, Math.round(n / (5 * u)));
      const skin = empty(n);
      const film = fractal(n, [70 * u, 160 * u], [1, 0.7], rng);
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const i = y * n + x;
          skin[i] = flakes[i]! * 0.6 + Math.sin((2 * Math.PI * k * (x + y)) / n) * 0.12;
          film[i] = film[i]! * 0.9;
        }
      }
      return { ...base, skin, film };
    },
  },
  {
    // LIQUID CHROME: every shape inflated and mirror-finished, reflecting a
    // studio — bright sky, a hard horizon, a dark floor. The horizon line
    // running through every curve is the whole trick; chrome without it is
    // grey plastic. A breath of the shape's own colour survives (gold chrome
    // from an orange sun).
    id: "chrome",
    label: "Liquid chrome",
    tone: [22, 24, 30],
    tile: 512,
    elevation: 50,
    depth: 1,
    shade: 0.2,
    mottle: { amount: 0.03, size: 220 },
    edge: { reach: 3, fuzz: 0, rim: 0 },
    liftSoftness: 0.8,
    overlay: "ground",
    body: { profile: "dome", width: 22, height: 0.9, shade: 0.35 },
    gloss: { amount: 1.2, tightness: 120, metal: 0.35, iridescence: 0, mirror: 1, micro: 0.25 },
    pigment: { color: [222, 224, 230], amount: 0.5 },
    build: (n, u, seed) => {
      const base = smoothSheet(n, u, seed, 0.02);
      const skin = fractal(n, [28 * u], [1], makeRng(seed ^ 0x77));
      scaleInto(skin, skin, -0.5);
      return { ...base, skin };
    },
  },
  {
    // NEON GLASS: each shape's edge becomes a glass tube that glows in its
    // colour, the inside goes dark, and the light spills onto a brick wall
    // behind. A white-hot core down the tube's crown, a tight bloom and a
    // wide spill — one halo reads as a blur, two read as light.
    id: "neon",
    label: "Neon",
    tone: [30, 27, 31],
    tile: 768,
    elevation: 40,
    depth: 2.4,
    shade: 0.6,
    mottle: { amount: 0.04, size: 160 },
    edge: { reach: 2, fuzz: 0, rim: 0 },
    liftSoftness: 0.8,
    overlay: "ground",
    body: { profile: "tube", width: 5, height: 1, shade: 0.45 },
    gloss: { amount: 0.55, tightness: 60, metal: 0, iridescence: 0, mirror: 0, micro: 0 },
    glow: { amount: 1.1, halo: 34, core: 0.6 },
    saturate: 0.35,
    build: (n, u, seed) => {
      const rng = makeRng(seed);
      const wall = bricks(n, u, rng);
      const fine = fractal(n, [0.8 * u, 2.2 * u], [1, 0.5], rng);
      const toothHeight = empty(n);
      const toothAlbedo = empty(n);
      scaleInto(toothHeight, fine, 0.5);
      scaleInto(toothAlbedo, fine, 0.05);
      return { height: wall.height, albedo: wall.albedo, toothHeight, toothAlbedo };
    },
  },
  {
    // STAINED GLASS: a window with the light behind it. Every region of
    // colour is a pane and a wide ground is cut into more; each pane glows
    // from its middle and dims where the lead shades its edge; cathedral
    // glass is never one density, so it is streaky, its ripples bend the
    // light, and no two pieces of the ground came from the same melt. The
    // lead is a near-black silhouette with a dull shine on its crown.
    id: "stainedGlass",
    label: "Stained glass",
    // The sheet is the window's plain glass: what "under" lays as the ground.
    tone: [238, 230, 210],
    tile: 768,
    elevation: 42,
    depth: 1.6,
    shade: 0.35,
    mottle: { amount: -0.02, size: 140 },
    edge: { reach: 2, fuzz: 0, rim: 0 },
    liftSoftness: 0.6,
    whole: true,
    overlay: "none",
    lead: { width: 4.5, tone: [24, 23, 26] },
    transmit: { ripple: 0.5, edge: 0.3, falloff: 12, backlight: 0.25, vary: 0.3 },
    gloss: { amount: 0.25, tightness: 50, metal: 0, iridescence: 0, mirror: 0, micro: 1 },
    // No halo: a window's panes are luminous by their own contrast with the
    // lead, and a bloom over every pixel of a whole window doubled its cost.
    saturate: 0.3,
    build: (n, u, seed) => {
      const rng = makeRng(seed);
      // Rolled glass ripples broadly; a fine hammer read as paper tooth.
      const skin = fractal(n, [24 * u], [1], rng);
      const tone = fractal(n, [30 * u], [1], rng);
      const streak = fibres(n, { density: 3e-4 / (u * u), length: [60 * u, 180 * u], alpha: [0.3, 0.8], bend: 0.3, grain: { angle: 0.5, strength: 0.7 } }, rng);
      const albedo = empty(n);
      scaleInto(albedo, tone, 0.12);
      scaleInto(albedo, gaussWrap(streak, n, 6 * u), -0.6);
      // Cut glass is straight-edged: the ground's panes are Voronoi cells.
      const cells = voronoi(n, 170 * u, rng, 0.8);
      const cames = empty(n);
      const pane = empty(n);
      for (let i = 0; i < n * n; i++) {
        cames[i] = cells.border[i]! < 0.75 ? 1 : 0;
        pane[i] = hash01(cells.id[i]!, 7) * 2 - 1;
      }
      return { height: empty(n), albedo, toothHeight: empty(n), toothAlbedo: empty(n), skin, cames, pane };
    },
  },
  {
    // FROSTED GLASS: the whole picture seen through acid-etched glass — each
    // point scattered a few px (a jitter, not a blur: frost keeps its grit),
    // milky, with a faint sparkle on the etch.
    id: "frosted",
    label: "Frosted glass",
    tone: [236, 240, 244],
    tile: 512,
    elevation: 45,
    depth: 1.4,
    shade: 0.35,
    mottle: { amount: 0.05, size: 160 },
    edge: { reach: 3, fuzz: 0, rim: 0 },
    liftSoftness: 0.6,
    whole: true,
    flow: { amount: 16, steps: 1 },
    pigment: { color: [236, 241, 246], amount: 0.38 },
    gloss: { amount: 0.35, tightness: 30, metal: 0, iridescence: 0, mirror: 0, micro: 2.5 },
    build: (n, u, seed) => {
      const rng = makeRng(seed);
      const base = smoothSheet(n, u, seed, -0.05);
      const fx = fractal(n, [0.9 * u], [1], rng);
      const fy = fractal(n, [0.9 * u], [1], rng);
      const skin = fractal(n, [1.2 * u, 3 * u], [1, 0.5], rng);
      return { ...base, skin, flowX: fx, flowY: fy };
    },
  },
  {
    // CUT CRYSTAL: faceted — every facet a flat plane at its own tilt, so
    // the light picks them out one by one — bevelled at the edge, a little
    // clear, a little prismatic. Over a dark cloth.
    id: "crystal",
    label: "Crystal",
    tone: [20, 24, 34],
    tile: 512,
    elevation: 48,
    depth: 1,
    shade: 0.3,
    mottle: { amount: 0.03, size: 180 },
    edge: { reach: 3, fuzz: 0, rim: 0 },
    liftSoftness: 0.7,
    overlay: "ground",
    body: { profile: "bevel", width: 14, height: 0.9, shade: 0.6 },
    gloss: { amount: 1, tightness: 60, metal: 0.15, iridescence: 0.3, mirror: 0.35, micro: 1.6 },
    clear: 0.25,
    saturate: 0.3,
    build: (n, u, seed) => {
      const base = smoothSheet(n, u, seed, 0.02);
      const skin = facets(voronoi(n, 22 * u, makeRng(seed ^ 0xc5)), n, 0.9);
      return { ...base, skin };
    },
  },
  {
    // SOAP FILM: a bubble — almost clear, a dome, and over it bands of
    // thin-film colour that swirl because the film's THICKNESS swirls. The
    // highlight is a tight window; the colour lives at the rim, where you
    // look through the most film.
    id: "soapFilm",
    label: "Soap film",
    tone: [18, 20, 26],
    tile: 640,
    elevation: 52,
    depth: 1,
    shade: 0.2,
    mottle: { amount: 0.03, size: 200 },
    edge: { reach: 3, fuzz: 0, rim: 0 },
    liftSoftness: 0.8,
    overlay: "ground",
    body: { profile: "dome", width: 40, height: 0.9, shade: 0.15 },
    gloss: { amount: 1.1, tightness: 140, metal: 0, iridescence: 1, mirror: 0.25, micro: 0.3 },
    clear: 0.7,
    build: (n, u, seed) => {
      const base = smoothSheet(n, u, seed, 0.02);
      const rng = makeRng(seed ^ 0x50a9);
      const swirl = curlFlow(n, [36 * u], [1], rng);
      const film = fractal(n, [24 * u, 60 * u], [0.6, 1], rng);
      for (let i = 0; i < film.length; i++) film[i] = film[i]! * 2.2 + swirl.x[i]! * 0.6;
      const skin = fractal(n, [20 * u], [1], rng);
      scaleInto(skin, skin, -0.6);
      return { ...base, skin, film };
    },
  },
  {
    // FERROFLUID: black, wet, mirror-glossy — and with `edge` up (the field)
    // SPIKES rise out of every edge on a staggered lattice. Key `edge` and
    // the shape bristles as if a magnet came close.
    id: "ferrofluid",
    label: "Ferrofluid",
    tone: [232, 230, 226],
    tile: 512,
    elevation: 50,
    depth: 1,
    shade: 0.25,
    mottle: { amount: -0.03, size: 160 },
    edge: { reach: 3, fuzz: 0, rim: 0 },
    liftSoftness: 0.8,
    overlay: "ground",
    pigment: { color: [10, 10, 12], amount: 1 },
    body: { profile: "dome", width: 40, height: 1, shade: 0.25 },
    gloss: { amount: 1.3, tightness: 90, metal: 0, iridescence: 0, mirror: 1, micro: 0.1, fresnel: 0.1 },
    spikes: { length: 56, pitch: 28 },
    liquid: true,
    build: (n, u, seed) => smoothSheet(n, u, seed, 0.03),
  },
  {
    // KINTSUGI: glazed ceramic, broken and mended with gold. The glaze is a
    // gentle dome with a wet highlight; the cracks wander, branch rarely,
    // and are METAL — they catch the light in their own colour.
    id: "kintsugi",
    label: "Kintsugi",
    tone: [234, 226, 212],
    tile: 768,
    elevation: 44,
    depth: 1.2,
    shade: 0.35,
    mottle: { amount: -0.03, size: 140 },
    edge: { reach: 3, fuzz: 0, rim: 0 },
    liftSoftness: 0.8,
    overlay: "ground",
    body: { profile: "dome", width: 18, height: 0.7, shade: 0.45 },
    gloss: { amount: 0.8, tightness: 70, metal: 0, iridescence: 0, mirror: 0.15, micro: 0.5 },
    inlay: [214, 170, 62],
    build: (n, u, seed) => {
      const base = smoothSheet(n, u, seed);
      const rng = makeRng(seed ^ 0x6b1d);
      const inlay = cracks(n, 150 * u, 2.4 * u, 0.6, rng);
      const skin = fractal(n, [6 * u], [1], rng);
      scaleInto(skin, skin, -0.7);
      // The gold stands a hair proud of the glaze.
      scaleInto(skin, inlay, 0.6);
      return { ...base, skin, inlay };
    },
  },
  {
    // TUFTED RUG: a dense pile of yarn loops on a jute backing; every colour
    // region a soft pillow of pile with a carved channel round it, and yarn
    // fuzzing past the edge with Edge up.
    id: "tufted",
    label: "Tufted rug",
    tone: [214, 200, 176],
    tile: 512,
    elevation: 32,
    depth: 3,
    shade: 0.7,
    mottle: { amount: -0.05, size: 90 },
    edge: { reach: 5, fuzz: 0.45, rim: 0 },
    liftSoftness: 1,
    body: { profile: "pillow", width: 7, height: 0.8, shade: 0.6 },
    build: (n, u, seed) => {
      const rng = makeRng(seed);
      const pile = loopPile(n, 5.5 * u, rng);
      const fine = fractal(n, [0.7 * u], [1], rng);
      const height = empty(n);
      const albedo = empty(n);
      scaleInto(height, pile, 1);
      for (let i = 0; i < albedo.length; i++) albedo[i] = (pile[i]! - 0.5) * 0.22;
      const toothHeight = empty(n);
      const toothAlbedo = empty(n);
      scaleInto(toothHeight, fine, 0.3);
      scaleInto(toothAlbedo, fine, 0.03);
      return { height, albedo, toothHeight, toothAlbedo };
    },
  },
  {
    // CRT PHOSPHOR: the picture made of red, green and blue phosphor stripes
    // behind a dark grille, every bright part blooming into the glass. The
    // stripes are a COLOUR the sheet carries — the one material whose tile is
    // not grey.
    id: "phosphor",
    label: "CRT phosphor",
    tone: [16, 18, 16],
    tile: 384,
    elevation: 60,
    depth: 0.6,
    shade: 0.15,
    mottle: { amount: 0.02, size: 200 },
    edge: { reach: 2, fuzz: 0, rim: 0 },
    liftSoftness: 0.6,
    whole: true,
    glow: { amount: 1.4, halo: 18, core: 0 },
    saturate: 0.4,
    build: (n, u, seed) => ({ ...smoothSheet(n, u, seed, 0.01), tint: phosphorTriads(n, 9 * u) }),
  },
  {
    // RICE PAPER (xuan): thin, absorbent, long-fibred. With Edge up, ink
    // DIFFUSES — it creeps out along the fibres past every edge and dries
    // with a darker tide line where it stopped.
    id: "ricePaper",
    label: "Rice paper",
    tone: [241, 235, 221],
    tile: 640,
    elevation: 40,
    depth: 1.3,
    shade: 0.4,
    mottle: { amount: -0.04, size: 140 },
    edge: { reach: 16, fuzz: 1, rim: 0, pool: 0.7 },
    liftSoftness: 0.7,
    build: (n, u, seed) =>
      paperLayers(n, u, seed, {
        tooth: [0.7, 1.6],
        fibres: { density: 2e-3, length: [20, 120], alpha: [0.06, 0.24], bend: 0.7 },
        fibreTone: -0.08,
        toothTone: -0.03,
        lightFibres: { spec: { density: 6e-4, length: [30, 140], alpha: [0.1, 0.3], bend: 0.6 }, tone: 0.1 },
      }),
  },
  {
    // MARBLING (suminagashi): the picture floated on water and combed — every
    // point carried along a swirling, divergence-free flow in many small
    // steps, so shapes stretch into veins and curls without tearing. Key
    // `flow` from 0 and the picture marbles before your eyes.
    id: "marble",
    label: "Marbling",
    tone: [238, 232, 218],
    tile: 768,
    elevation: 40,
    depth: 1.2,
    shade: 0.35,
    mottle: { amount: -0.04, size: 120 },
    edge: { reach: 4, fuzz: 0, rim: 0 },
    liftSoftness: 0.7,
    flow: { amount: 80, steps: 16 },
    build: (n, u, seed) => {
      const base = paperLayers(n, u, seed, {
        tooth: [0.8, 1.8],
        fibres: { density: 9e-4, length: [8, 40], alpha: [0.08, 0.3], bend: 0.6 },
        fibreTone: -0.1,
        toothTone: -0.04,
      });
      const f = curlFlow(n, [30 * u, 80 * u], [1, 0.7], makeRng(seed ^ 0x3a7));
      return { ...base, flowX: f.x, flowY: f.y };
    },
  },
];
