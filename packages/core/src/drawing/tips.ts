/**
 * THE TIP STENCIL — what one dab of a brush looks like, as MATH.
 *
 * A brush pack needs fifty tips with fifty characters, and there are only two
 * ways to get them: ship fifty PNGs, or describe them. This file describes
 * them. A stencil is a resolution-independent, deterministic, pure-data answer
 * to "what shape is this stamp" — polygons plus soft dots in a unit box — which
 * the painter rasterizes ONCE into a sprite and then blits per dab.
 *
 * Why that matters beyond file size:
 *  - A math tip is crisp at any size and any DPR; a 128px PNG is not.
 *  - It tints to any colour for free, because the stencil is alpha only.
 *  - It costs nothing at stroke time. Sprite generation happens once per
 *    (brush, colour); the stroke itself stays pure `drawImage` blits, so a
 *    bristle brush with 40 hairs is exactly as fast as a hard round.
 *  - It is TESTABLE. A stencil is numbers, so "does the bristle tip actually
 *    have bristles" is an assertion rather than an eyeball.
 *
 * Everything is in a unit box: x,y ∈ [-1, 1], radius in the same units, where
 * 1 = half the dab's diameter. The painter scales that to the sprite.
 *
 * Randomness is SEEDED and part of the tip's identity: `seed` lives on the
 * brush, so "Spatter" always spatters the same way, and nudging the seed in the
 * studio deals a new tip rather than a new brush.
 */

/** A soft circular blob — the primitive behind bristles, spray and grit. */
export interface TipDot {
  x: number;
  y: number;
  /** Radius in unit space (1 = the dab's own radius). */
  r: number;
  /** 0..1 alpha of this blob. */
  alpha: number;
  /** 0 = fully feathered, 1 = hard edge. */
  hardness: number;
}

export interface TipPoint {
  x: number;
  y: number;
}

/**
 * One stamp, fully described. A painter fills `polys` flat, then `dots` with a
 * radial falloff, then multiplies the whole thing by `mask` if present.
 */
export interface TipStencil {
  /** Filled outlines (closed), in draw order. */
  polys: TipPoint[][];
  /** Soft blobs, in draw order. */
  dots: TipDot[];
  /**
   * A radial mask applied to the assembled stamp: `inner` is the fraction of
   * the radius that stays opaque, past which alpha eases to 0 at the edge.
   * `null` leaves the stamp unmasked (hard-edged shapes, scattered grit).
   */
  mask: { inner: number } | null;
}

/** Deterministic rng (mulberry32) — the same one the stroke engine uses. */
function rng(seed: number): () => number {
  let a = (seed | 0) >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A regular n-gon, optionally star-pointed, rotated by `rot` radians. */
function polygon(sides: number, radius: number, rot = 0, innerRatio = 1): TipPoint[] {
  const pts: TipPoint[] = [];
  const steps = innerRatio < 1 ? sides * 2 : sides;
  for (let i = 0; i < steps; i++) {
    const a = rot + (i / steps) * Math.PI * 2;
    const r = innerRatio < 1 && i % 2 === 1 ? radius * innerRatio : radius;
    pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return pts;
}

/** A rounded rectangle as a polygon — the chisel/flat family's body. */
function bar(halfW: number, halfH: number, rot = 0, corner = 0): TipPoint[] {
  const pts: TipPoint[] = [];
  const c = Math.min(corner, halfW, halfH);
  const corners: Array<[number, number, number]> = [
    [halfW - c, halfH - c, 0],
    [-(halfW - c), halfH - c, Math.PI / 2],
    [-(halfW - c), -(halfH - c), Math.PI],
    [halfW - c, -(halfH - c), -Math.PI / 2],
  ];
  for (const [cx, cy, base] of corners) {
    if (c <= 0) {
      pts.push({ x: cx, y: cy });
      continue;
    }
    for (let i = 0; i <= 4; i++) {
      const a = base + (i / 4) * (Math.PI / 2);
      pts.push({ x: cx + Math.cos(a) * c, y: cy + Math.sin(a) * c });
    }
  }
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  return pts.map((p) => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos }));
}

/**
 * THE TIP FAMILIES.
 *
 * Each is a generator, not a case in a switch: adding "Sponge" is one entry
 * here and one string in the schema's enum, and every surface that stamps,
 * previews or thumbnails a brush picks it up with no further code. The `params`
 * are the same three numbers for all of them — density, spread, irregularity —
 * deliberately, so the studio can offer ONE set of tip controls that means
 * something for every family instead of a different panel per shape.
 */
export interface TipParams {
  /** How MANY marks the tip is made of (bristles, spray dots, flakes). 0..1. */
  density: number;
  /** How far they spread from the centre. 0..1. */
  spread: number;
  /** How irregular / broken the mark is. 0..1. */
  irregular: number;
  /** 0 = fully feathered, 1 = hard edge (round/geometric families). */
  hardness: number;
  /** Corner/point count for the geometric families. */
  sides: number;
}

export const DEFAULT_TIP_PARAMS: TipParams = {
  density: 0.5,
  spread: 0.5,
  irregular: 0.4,
  hardness: 0.9,
  sides: 5,
};

type TipGenerator = (p: TipParams, seed: number) => TipStencil;

const empty = (): TipStencil => ({ polys: [], dots: [], mask: null });

/**
 * Scatter `n` blobs inside a disc of `spread`, with radii and alphas shaped by
 * `irregular`. The one primitive behind bristle, spray, grit and sponge — the
 * families differ in their NUMBERS, not their code, which is why they feel like
 * one instrument family rather than four unrelated hacks.
 */
function scatter(
  count: number,
  spread: number,
  baseR: number,
  irregular: number,
  hardness: number,
  next: () => number,
  falloff = 1,
): TipDot[] {
  const dots: TipDot[] = [];
  for (let i = 0; i < count; i++) {
    // sqrt keeps the disc evenly covered instead of clumping at the centre.
    const rad = Math.sqrt(next()) * spread;
    const ang = next() * Math.PI * 2;
    const wobble = 1 - irregular * next();
    dots.push({
      x: Math.cos(ang) * rad,
      y: Math.sin(ang) * rad,
      r: Math.max(0.01, baseR * wobble),
      alpha: Math.max(0.05, (1 - falloff * (rad / Math.max(0.01, spread))) * (1 - irregular * 0.6 * next()) + 0.15),
      hardness,
    });
  }
  return dots;
}

const GENERATORS: Record<string, TipGenerator> = {
  /** The plain disc. Hardness is the whole tip. */
  round: (p) => ({ polys: [], dots: [], mask: { inner: p.hardness } }),

  /** A flat, angled nib — calligraphy, markers, flat painting brushes. */
  chisel: (p) => ({
    polys: [bar(1, Math.max(0.06, 0.5 - p.spread * 0.44), 0, 0.06)],
    dots: [],
    mask: p.hardness >= 0.99 ? null : { inner: p.hardness },
  }),

  /** A hard rectangle — pixel pens, blocky markers, halftone stamps. */
  square: (p) => ({
    polys: [bar(1, 1, 0, (1 - p.hardness) * 0.9)],
    dots: [],
    mask: null,
  }),

  /** An n-gon or star. `sides` picks it; `irregular` pulls the points in. */
  polygon: (p) => ({
    polys: [polygon(Math.max(3, Math.round(p.sides)), 1, -Math.PI / 2, 1 - p.irregular * 0.75)],
    dots: [],
    mask: p.hardness >= 0.99 ? null : { inner: p.hardness },
  }),

  /**
   * A rake of hairs across the tip — the dry-brush / bristle family. Hairs run
   * along one axis so `followStroke` drags them into real bristle streaks
   * rather than a smear.
   */
  bristle: (p, seed) => {
    const next = rng(seed);
    const hairs = Math.max(3, Math.round(4 + p.density * 26));
    const dots: TipDot[] = [];
    for (let i = 0; i < hairs; i++) {
      const t = hairs === 1 ? 0.5 : i / (hairs - 1);
      const y = (t * 2 - 1) * (0.35 + p.spread * 0.6);
      const jitterY = (next() * 2 - 1) * p.irregular * 0.18;
      // Each hair is a short run of blobs, so it survives being stretched.
      const len = 0.55 + next() * 0.45;
      const steps = 3;
      for (let s = 0; s < steps; s++) {
        const x = ((s / (steps - 1)) * 2 - 1) * len;
        dots.push({
          x,
          y: y + jitterY,
          r: (0.06 + next() * 0.09) * (1 + p.spread * 0.5),
          alpha: Math.max(0.08, 1 - p.irregular * next()),
          hardness: p.hardness,
        });
      }
    }
    return { polys: [], dots, mask: { inner: 0.65 } };
  },

  /** Airbrush spray — many tiny dots, denser at the middle. */
  spray: (p, seed) => {
    const next = rng(seed);
    const n = Math.round(30 + p.density * 260);
    return {
      polys: [],
      dots: scatter(n, 0.98, 0.028 + p.spread * 0.05, p.irregular, 1, next, 0.85),
      mask: null,
    };
  },

  /** Big irregular droplets — splatter, ink spray, paint fling. */
  spatter: (p, seed) => {
    const next = rng(seed);
    const n = Math.round(4 + p.density * 26);
    const dots = scatter(n, 0.95, 0.08 + p.spread * 0.22, p.irregular, p.hardness, next, 0.25);
    // A couple of satellites well outside the disc — that's what reads as ink.
    for (let i = 0; i < 3; i++) {
      const ang = next() * Math.PI * 2;
      const rad = 0.7 + next() * 0.3;
      dots.push({ x: Math.cos(ang) * rad, y: Math.sin(ang) * rad, r: 0.025 + next() * 0.05, alpha: 0.9, hardness: 1 });
    }
    return { polys: [], dots, mask: null };
  },

  /** Torn, chalky edge — charcoal, conte, pastel, crayon. */
  grit: (p, seed) => {
    const next = rng(seed);
    const n = Math.round(14 + p.density * 70);
    const dots = scatter(n, 0.9, 0.1 + p.spread * 0.2, p.irregular, 0.55, next, 0.35);
    return { polys: [], dots, mask: { inner: Math.min(0.9, p.hardness) } };
  },

  /** Open cellular holes — sponge, foam, stone texture. */
  sponge: (p, seed) => {
    const next = rng(seed);
    const n = Math.round(6 + p.density * 22);
    const dots: TipDot[] = [];
    for (let i = 0; i < n; i++) {
      const rad = Math.sqrt(next()) * 0.85;
      const ang = next() * Math.PI * 2;
      dots.push({
        x: Math.cos(ang) * rad,
        y: Math.sin(ang) * rad,
        r: 0.12 + next() * (0.16 + p.spread * 0.2),
        alpha: 0.55 + next() * 0.45,
        hardness: 0.35 + p.hardness * 0.4,
      });
    }
    return { polys: [], dots, mask: { inner: 0.5 } };
  },

  /** Parallel ruled lines — hatching, screentone, engraving. */
  hatch: (p, seed) => {
    const next = rng(seed);
    const lines = Math.max(2, Math.round(2 + p.density * 10));
    const thick = 0.05 + (1 - p.density) * 0.12;
    const polys: TipPoint[][] = [];
    for (let i = 0; i < lines; i++) {
      const t = lines === 1 ? 0.5 : i / (lines - 1);
      const y = (t * 2 - 1) * 0.85;
      const wobble = (next() * 2 - 1) * p.irregular * 0.15;
      polys.push(bar(1, thick, 0).map((pt) => ({ x: pt.x, y: pt.y + y + wobble })));
    }
    return { polys, dots: [], mask: p.hardness >= 0.99 ? null : { inner: p.hardness } };
  },

  /** A ring — bokeh, bubbles, smoke rings, halo stamps. */
  ring: (p) => {
    const inner = 0.35 + (1 - p.spread) * 0.5;
    const dots: TipDot[] = [];
    const steps = 48;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const rad = (1 + inner) / 2;
      dots.push({
        x: Math.cos(a) * rad,
        y: Math.sin(a) * rad,
        r: Math.max(0.03, (1 - inner) / 2),
        alpha: 1,
        hardness: p.hardness,
      });
    }
    return { polys: [], dots, mask: null };
  },

  /**
   * A pointed leaf / petal — the organic stamp family (foliage, feathers,
   * flames). Built from a symmetric quadratic hull so it stays smooth at size.
   */
  leaf: (p) => {
    const width = 0.25 + p.spread * 0.6;
    const pts: TipPoint[] = [];
    const steps = 26;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = t * 2 - 1;
      pts.push({ x, y: Math.sin(t * Math.PI) ** (0.6 + p.irregular) * width });
    }
    for (let i = steps; i >= 0; i--) {
      const t = i / steps;
      const x = t * 2 - 1;
      pts.push({ x, y: -(Math.sin(t * Math.PI) ** (0.6 + p.irregular)) * width });
    }
    return { polys: [pts], dots: [], mask: p.hardness >= 0.99 ? null : { inner: p.hardness } };
  },

  /** A four-point sparkle — stars, glints, glitter. */
  sparkle: (p) => {
    const points = Math.max(3, Math.round(p.sides));
    const thin = 0.06 + (1 - p.spread) * 0.22;
    return {
      polys: [polygon(points, 1, -Math.PI / 2, thin)],
      dots: [{ x: 0, y: 0, r: 0.16 + p.density * 0.2, alpha: 1, hardness: 0.2 }],
      mask: null,
    };
  },
};

/** Every tip family, in the order the studio offers them. */
export const TIP_KINDS = [
  "round",
  "chisel",
  "square",
  "polygon",
  "bristle",
  "spray",
  "spatter",
  "grit",
  "sponge",
  "hatch",
  "ring",
  "leaf",
  "sparkle",
] as const;

export type TipKind = (typeof TIP_KINDS)[number];

/** Human labels for the studio's tip picker. */
export const TIP_LABEL: Record<TipKind, string> = {
  round: "Round",
  chisel: "Chisel",
  square: "Square",
  polygon: "Polygon",
  bristle: "Bristle",
  spray: "Spray",
  spatter: "Spatter",
  grit: "Grit",
  sponge: "Sponge",
  hatch: "Hatch",
  ring: "Ring",
  leaf: "Leaf",
  sparkle: "Sparkle",
};

/**
 * THE tip resolver: (kind, params, seed) → stencil. Pure and deterministic —
 * the same three arguments always give the same stamp, in a test, in the
 * painter and in a preview card.
 */
export function tipStencil(kind: TipKind, params: TipParams, seed: number): TipStencil {
  const gen = GENERATORS[kind];
  return gen ? gen(params, seed) : empty();
}
