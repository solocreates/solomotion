/**
 * PAPER — the grain field, as math.
 *
 * Every dry medium in art is a fight between pigment and a surface, and the
 * surface is what makes graphite look like graphite instead of grey. So grain
 * is not decoration here: pencil, charcoal, chalk, pastel, crayon, watercolour
 * and dry-brush oil ALL get their character from it, which is why it is
 * generated rather than shipped as a folder of seamless tiles.
 *
 * Each texture is a function of (x, y) → 0..1 coverage over a tile that repeats
 * exactly at `TILE`, so the painter can bake one tile per (texture, seed) and
 * fill with a repeating pattern. Tiles are ANCHORED to the layer by default, so
 * two strokes crossing reveal the same paper — which is the entire difference
 * between "textured brush" and "textured paper".
 */

/** Every generated tile is this many px square, and tiles seamlessly. */
export const GRAIN_TILE = 256;

export const GRAIN_TEXTURES = [
  "noise",
  "paper",
  "canvas",
  "rough",
  "concrete",
  "crosshatch",
  "speckle",
  "fibre",
  "halftone",
] as const;

export type GrainTexture = (typeof GRAIN_TEXTURES)[number];

export const GRAIN_LABEL: Record<GrainTexture, string> = {
  noise: "Noise",
  paper: "Paper",
  canvas: "Canvas",
  rough: "Rough",
  concrete: "Concrete",
  crosshatch: "Crosshatch",
  speckle: "Speckle",
  fibre: "Fibre",
  halftone: "Halftone",
};

/** Hash a lattice point to 0..1. Deterministic, seed-salted, no allocation. */
function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1274126177) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t: number) => t * t * (3 - 2 * t);

/**
 * Tiling value noise at `period` lattice cells across the tile. Wrapping the
 * lattice coordinates by `period` is what makes it seamless — the right edge
 * samples the same lattice column as the left.
 */
function valueNoise(x: number, y: number, period: number, seed: number): number {
  const fx = (x / GRAIN_TILE) * period;
  const fy = (y / GRAIN_TILE) * period;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fade(fx - x0);
  const ty = fade(fy - y0);
  const wrap = (v: number) => ((v % period) + period) % period;
  const a = hash(wrap(x0), wrap(y0), seed);
  const b = hash(wrap(x0 + 1), wrap(y0), seed);
  const c = hash(wrap(x0), wrap(y0 + 1), seed);
  const d = hash(wrap(x0 + 1), wrap(y0 + 1), seed);
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

/** Summed octaves of tiling value noise — the base of every organic texture. */
function fbm(x: number, y: number, period: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x, y, period * 2 ** o, seed + o * 101) * amp;
    norm += amp;
    amp *= 0.5;
  }
  return sum / norm;
}

const saw = (v: number) => Math.abs(((v % 1) + 1) % 1);

type Field = (x: number, y: number, seed: number) => number;

/**
 * The textures. Each returns 0..1 COVERAGE: 1 means paint lands here, 0 means
 * the paper wins. The painter maps this through the brush's grain intensity.
 */
const FIELDS: Record<GrainTexture, Field> = {
  /** Flat white-ish noise — the generic "dirty" gate. */
  noise: (x, y, seed) => hash(x, y, seed) * 0.6 + fbm(x, y, 32, 2, seed) * 0.4,

  /** Cold-press paper: soft lumps with fine tooth on top. */
  paper: (x, y, seed) => {
    const tooth = fbm(x, y, 48, 3, seed);
    const lumps = fbm(x, y, 8, 2, seed + 7);
    return Math.min(1, tooth * 0.55 + lumps * 0.35 + hash(x, y, seed) * 0.1);
  },

  /** Woven canvas: two perpendicular thread sets, softly modulated. */
  canvas: (x, y, seed) => {
    const warp = (Math.sin((x / GRAIN_TILE) * Math.PI * 2 * 32) + 1) / 2;
    const weft = (Math.sin((y / GRAIN_TILE) * Math.PI * 2 * 32) + 1) / 2;
    const weave = Math.max(warp, weft) * 0.7 + warp * weft * 0.3;
    return Math.min(1, weave * 0.75 + fbm(x, y, 12, 2, seed) * 0.35);
  },

  /** Coarse tooth — watercolour rough, heavy pastel paper. */
  rough: (x, y, seed) => {
    const v = fbm(x, y, 16, 3, seed);
    // Contrast curve: pushes the field toward "peak or valley", which is what
    // makes a rough surface skip rather than merely mottle.
    return Math.min(1, Math.max(0, (v - 0.35) * 2.4));
  },

  /** Stone/wall — broad blotches with hard pitting. */
  concrete: (x, y, seed) => {
    const base = fbm(x, y, 6, 4, seed);
    const pits = hash(x, y, seed + 3) > 0.93 ? 0 : 1;
    return Math.min(1, base * 1.15) * pits;
  },

  /** Ruled diagonal tone — engraving, comic screentone. */
  crosshatch: (x, y, seed) => {
    const a = saw((x + y) / 9);
    const b = saw((x - y) / 9);
    const line = Math.max(1 - Math.abs(a - 0.5) * 4, 1 - Math.abs(b - 0.5) * 4);
    return Math.min(1, Math.max(0, line) * 0.85 + fbm(x, y, 24, 2, seed) * 0.25);
  },

  /** Sparse hard dots — spray dust, sandpaper, stippled ink. */
  speckle: (x, y, seed) => (hash(x, y, seed) > 0.62 ? 1 : 0.08),

  /** Directional fibres — rice paper, dry brush, hair. */
  fibre: (x, y, seed) => {
    const bend = fbm(x, y, 5, 2, seed) * 26;
    return Math.min(1, fbm(x + bend, y * 7, 20, 2, seed + 11) * 1.25);
  },

  /** Regular dot lattice — printing, retro tone, dithered shading. */
  halftone: (x, y) => {
    const s = 8;
    const cx = (saw(x / s) - 0.5) * s;
    const cy = (saw(y / s) - 0.5) * s;
    const d = Math.hypot(cx, cy);
    return d < s * 0.3 ? 1 : Math.max(0, 1 - (d - s * 0.3) / (s * 0.18));
  },
};

/**
 * Bake one tile of a texture into an alpha array (`GRAIN_TILE²` bytes, 0..255).
 * Pure — the painter turns it into an ImageData, tests assert on it directly.
 */
export function grainTile(texture: GrainTexture, seed = 1): Uint8ClampedArray {
  const field = FIELDS[texture] ?? FIELDS.noise;
  const out = new Uint8ClampedArray(GRAIN_TILE * GRAIN_TILE);
  for (let y = 0; y < GRAIN_TILE; y++) {
    for (let x = 0; x < GRAIN_TILE; x++) {
      out[y * GRAIN_TILE + x] = Math.round(Math.min(1, Math.max(0, field(x, y, seed))) * 255);
    }
  }
  return out;
}
