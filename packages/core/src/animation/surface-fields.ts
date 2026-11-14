import type { SurfaceMaterial } from "../schema/layer-effects";
import { makeRng } from "./temporal";

/**
 * THE SURFACE FIELDS — the generators every material recipe is built from:
 * periodic noise, fibres, specks, weaves, folds, grids, grain. A LEAF: it
 * imports only the RNG, so the recipe files (`surface.ts`,
 * `surface-materials.ts`) and the shape stage can all share it without an
 * import cycle. Every field is periodic, so every tile is seamless.
 */

// ── Field helpers (periodic, so every tile is seamless) ──────────────────────

/** A periodic N×N field of floats. */
export type Field = Float32Array;

export function whiteNoise(n: number, rng: () => number): Field {
  const f = new Float32Array(n * n);
  for (let i = 0; i < f.length; i++) f[i] = rng() * 2 - 1;
  return f;
}

/** Separable box blur, `passes` times, wrapping at the edges (periodic). */
export function boxBlurWrap(src: Field, n: number, radius: number, passes = 3): Field {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return src;
  let a = src;
  let b = new Float32Array(n * n);
  const span = 2 * r + 1;
  for (let p = 0; p < passes; p++) {
    // Horizontal.
    for (let y = 0; y < n; y++) {
      const row = y * n;
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += a[row + ((k % n) + n) % n]!;
      for (let x = 0; x < n; x++) {
        b[row + x] = acc / span;
        acc += a[row + ((x + r + 1) % n)]! - a[row + ((x - r) % n + n) % n]!;
      }
    }
    // Vertical.
    const c = new Float32Array(n * n);
    for (let x = 0; x < n; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += b[(((k % n) + n) % n) * n + x]!;
      for (let y = 0; y < n; y++) {
        c[y * n + x] = acc / span;
        acc += b[((y + r + 1) % n) * n + x]! - b[(((y - r) % n + n) % n) * n + x]!;
      }
    }
    a = c;
    b = new Float32Array(n * n);
  }
  return a;
}

/** Gaussian of σ px, as three box passes (σ² = passes·(w²−1)/12). */
export function gaussWrap(src: Field, n: number, sigma: number): Field {
  if (sigma < 0.35) return src;
  if (sigma < 1.2) {
    // Small σ: an exact 1D kernel reads better than a one-pixel box.
    const rad = Math.ceil(sigma * 3);
    const k: number[] = [];
    let sum = 0;
    for (let i = -rad; i <= rad; i++) {
      const v = Math.exp(-(i * i) / (2 * sigma * sigma));
      k.push(v);
      sum += v;
    }
    for (let i = 0; i < k.length; i++) k[i] = k[i]! / sum;
    const tmp = new Float32Array(n * n);
    const out = new Float32Array(n * n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        let acc = 0;
        for (let i = -rad; i <= rad; i++) acc += src[y * n + (((x + i) % n) + n) % n]! * k[i + rad]!;
        tmp[y * n + x] = acc;
      }
    }
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        let acc = 0;
        for (let i = -rad; i <= rad; i++) acc += tmp[((((y + i) % n) + n) % n) * n + x]! * k[i + rad]!;
        out[y * n + x] = acc;
      }
    }
    return out;
  }
  const w = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  return boxBlurWrap(src, n, (w - 1) / 2, 3);
}

/** Zero-mean, |max| = 1 — `fractal()` in the ScientificMotion texture rules. */
export function normalise(f: Field): Field {
  let mean = 0;
  for (let i = 0; i < f.length; i++) mean += f[i]!;
  mean /= f.length;
  let peak = 1e-9;
  for (let i = 0; i < f.length; i++) {
    f[i] = f[i]! - mean;
    peak = Math.max(peak, Math.abs(f[i]!));
  }
  for (let i = 0; i < f.length; i++) f[i] = f[i]! / peak;
  return f;
}

/** Summed blurred white noise at several σ (px), weighted, normalised. */
export function fractal(n: number, sigmas: readonly number[], weights: readonly number[], rng: () => number): Field {
  const out = new Float32Array(n * n);
  sigmas.forEach((s, i) => {
    const f = gaussWrap(whiteNoise(n, rng), n, s);
    // Blurring white noise shrinks it by ~1/(2σ√π); undo that so a weight
    // means the same thing at any σ.
    const gain = (weights[i] ?? 1) * Math.max(1, 2 * s * Math.sqrt(Math.PI));
    for (let j = 0; j < out.length; j++) out[j] = out[j]! + f[j]! * gain;
  });
  return normalise(out);
}

/** Deposit `v` at (x, y) with bilinear weights, wrapping. */
export function splat(f: Field, n: number, x: number, y: number, v: number): void {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const x0 = ((xi % n) + n) % n;
  const y0 = ((yi % n) + n) % n;
  const x1 = (x0 + 1) % n;
  const y1 = (y0 + 1) % n;
  f[y0 * n + x0] = f[y0 * n + x0]! + v * (1 - fx) * (1 - fy);
  f[y0 * n + x1] = f[y0 * n + x1]! + v * fx * (1 - fy);
  f[y1 * n + x0] = f[y1 * n + x0]! + v * (1 - fx) * fy;
  f[y1 * n + x1] = f[y1 * n + x1]! + v * fx * fy;
}

export interface FibreSpec {
  /** Fibres per px² of tile. */
  density: number;
  /** Length range, px. */
  length: readonly [number, number];
  /** Per-fibre strength range, 0..1. */
  alpha: readonly [number, number];
  /** σ of the bend along a fibre, radians (0.6 in the rules: slightly curved). */
  bend: number;
  /** Dominant direction (radians) and how strongly fibres follow it, 0..1. */
  grain?: { angle: number; strength: number };
}

/**
 * Paper fibres: short, slightly curved strokes in random directions — the
 * rule from the ScientificMotion paper. Rasterised as bilinear splats every
 * half pixel, so a fibre is an anti-aliased 1px line at any angle.
 */
export function fibres(n: number, spec: FibreSpec, rng: () => number): Field {
  const f = new Float32Array(n * n);
  const count = Math.round(spec.density * n * n);
  for (let i = 0; i < count; i++) {
    const x = rng() * n;
    const y = rng() * n;
    let a = rng() * Math.PI;
    if (spec.grain && rng() < spec.grain.strength) a = spec.grain.angle + (rng() - 0.5) * 0.5;
    const len = spec.length[0] + rng() * (spec.length[1] - spec.length[0]);
    // A normal deviate for the bend (Box–Muller), as the rules' `normal(0, .6)`.
    const bend = Math.sqrt(-2 * Math.log(Math.max(1e-9, rng()))) * Math.cos(2 * Math.PI * rng()) * spec.bend;
    const v = spec.alpha[0] + rng() * (spec.alpha[1] - spec.alpha[0]);
    const steps = Math.max(2, Math.ceil(len * 2));
    for (let s = 0; s <= steps; s++) {
      const u = s / steps;
      const ang = a + bend * (u - 0.5);
      // Integrate along the curve so the bend really bends the stroke.
      const t = (u - 0.5) * len;
      splat(f, n, x + Math.cos(ang) * t, y + Math.sin(ang) * t, v * 0.5);
    }
  }
  return f;
}

/** Specks: tiny round dots (kraft flecks, felt pills). */
export function specks(n: number, density: number, radius: readonly [number, number], rng: () => number): Field {
  const f = new Float32Array(n * n);
  const count = Math.round(density * n * n);
  for (let i = 0; i < count; i++) {
    const cx = rng() * n;
    const cy = rng() * n;
    const r = radius[0] + rng() * (radius[1] - radius[0]);
    const v = 0.5 + rng() * 0.5;
    const R = Math.ceil(r + 1);
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const d = Math.hypot(dx, dy);
        const cover = Math.max(0, Math.min(1, r + 0.5 - d));
        if (cover <= 0) continue;
        const px = (((Math.floor(cx) + dx) % n) + n) % n;
        const py = (((Math.floor(cy) + dy) % n) + n) % n;
        f[py * n + px] = Math.max(f[py * n + px]!, cover * v);
      }
    }
  }
  return f;
}

/**
 * A plain weave: warp (vertical) and weft (horizontal) threads, over one and
 * under one, each thread a little uneven (`slub`) — the ScientificMotion weave
 * rule. The thread COUNT is whole so the tile repeats seamlessly.
 */
export function weave(n: number, period: number, slub: number, weftTone: number, rng: () => number): { height: Field; tone: Field } {
  const threads = Math.max(2, Math.round(n / period));
  // Even, so the over/under checker also repeats.
  const count = threads % 2 === 0 ? threads : threads + 1;
  const p = n / count;
  const jx = periodic1D(n, 3, rng);
  const jy = periodic1D(n, 3, rng);
  const tx = periodic1D(n, 1.5, rng);
  const ty = periodic1D(n, 1.5, rng);
  const height = new Float32Array(n * n);
  const tone = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const px = (x + jx[x]! * slub * p) / p;
      const py = (y + jy[y]! * slub * p) / p;
      const threadX = 0.5 - 0.5 * Math.cos(2 * Math.PI * px);
      const threadY = 0.5 - 0.5 * Math.cos(2 * Math.PI * py);
      const over = ((Math.floor(px) + Math.floor(py)) & 1) === 0;
      // The thread on top shows its round crown; the one under it is hidden
      // except where it rises between its neighbours.
      const h = over ? threadX * (0.75 + 0.25 * threadY) : weftTone * threadY * (0.75 + 0.25 * threadX);
      const i = y * n + x;
      height[i] = h;
      tone[i] = over ? tx[x]! : ty[y]!;
    }
  }
  return { height, tone };
}

/** A periodic 1D noise of length n, blurred by σ, in roughly [-1, 1]. */
export function periodic1D(n: number, sigma: number, rng: () => number): Float32Array {
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) raw[i] = rng() * 2 - 1;
  const r = Math.ceil(sigma * 3);
  const out = new Float32Array(n);
  let peak = 1e-9;
  for (let i = 0; i < n; i++) {
    let acc = 0;
    let wsum = 0;
    for (let k = -r; k <= r; k++) {
      const wgt = Math.exp(-(k * k) / (2 * sigma * sigma));
      acc += raw[(((i + k) % n) + n) % n]! * wgt;
      wsum += wgt;
    }
    out[i] = acc / wsum;
    peak = Math.max(peak, Math.abs(out[i]!));
  }
  for (let i = 0; i < n; i++) out[i] = out[i]! / peak;
  return out;
}

/**
 * Crumpled paper: FOLDS, each a crease line with a lit face and a shaded one
 * either side (|distance to the line| is a V), fading along its length — big
 * folds and the small crinkles between them. Generated at half resolution and
 * upsampled: a fold is large, and the crease line stays sharp enough at 2px.
 */
export function folds(n: number, unit: number, rng: () => number): Field {
  const m = Math.max(16, Math.round(n / 2));
  const half = new Float32Array(m * m);
  const s = m / n; // half-res px per tile px
  const sets = [
    { count: Math.round(20 * (m * m) / (512 * 512) / (unit * unit)) + 6, len: 240 * unit * s, width: 150 * unit * s, depth: 1 },
    { count: Math.round(70 * (m * m) / (512 * 512) / (unit * unit)) + 10, len: 70 * unit * s, width: 40 * unit * s, depth: 0.45 },
  ];
  for (const set of sets) {
    for (let c = 0; c < set.count; c++) {
      const cx = rng() * m;
      const cy = rng() * m;
      const th = rng() * Math.PI;
      const co = Math.cos(th);
      const si = Math.sin(th);
      const depth = (rng() < 0.5 ? -1 : 1) * set.depth * (0.4 + rng() * 0.6);
      const L = set.len * (0.5 + rng());
      const W = set.width * (0.6 + rng() * 0.8);
      const R = Math.min(m / 2, Math.ceil(Math.max(L, W) * 2));
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const along = dx * co + dy * si;
          const across = -dx * si + dy * co;
          const fall = Math.exp(-(along * along) / (L * L) - (across * across) / (W * W));
          if (fall < 0.01) continue;
          const px = (((Math.floor(cx) + dx) % m) + m) % m;
          const py = (((Math.floor(cy) + dy) % m) + m) % m;
          // A fold: the sheet either side tilts away from (or toward) the crease.
          half[py * m + px] = half[py * m + px]! + depth * (W - Math.abs(across)) * fall / Math.max(1, W);
        }
      }
    }
  }
  // Bilinear upsample back to the tile, wrapping.
  const out = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    const fy = y * s;
    const y0 = Math.floor(fy) % m;
    const y1 = (y0 + 1) % m;
    const ty = fy - Math.floor(fy);
    for (let x = 0; x < n; x++) {
      const fx = x * s;
      const x0 = Math.floor(fx) % m;
      const x1 = (x0 + 1) % m;
      const tx = fx - Math.floor(fx);
      const a = half[y0 * m + x0]! + (half[y0 * m + x1]! - half[y0 * m + x0]!) * tx;
      const b = half[y1 * m + x0]! + (half[y1 * m + x1]! - half[y1 * m + x0]!) * tx;
      out[y * n + x] = a + (b - a) * ty;
    }
  }
  return normalise(out);
}

// ── The recipes ──────────────────────────────────────────────────────────────

/**
 * What one material is made of, in TILE pixels at `unit` device px per frame
 * px. Four fields: a coarse height and albedo the material owns, and a fine
 * TOOTH height and albedo the card's `tooth` dial scales — kept apart because
 * "less tooth" must not mean "fewer fibres".
 */
export interface SurfaceLayers {
  height: Field;
  albedo: Field;
  toothHeight: Field;
  toothAlbedo: Field;
  /**
   * THE SKIN — the height of a PIECE of the material's face, when it is not
   * the sheet's: foil's diffraction grooves, crystal's facets, glass's
   * hammering. Lit per pixel on the picture's shapes by the shape stage; the
   * sheet (`height`) stays the ground. Absent = the sheet's own height.
   */
  skin?: Field;
  /** Per-channel albedo, 3·n², interleaved RGB: a colour the sheet carries (a phosphor's triads). Multiplied over the picture. */
  tint?: Float32Array;
  /** 0..1 per pixel: how glossy the face is here (kintsugi: the gold lines shine, the glaze less). Absent = 1. */
  gloss?: Field;
  /** Thin-film phase, in cycles: soap film's swirling bands of colour. */
  film?: Field;
  /** 0..1 per pixel: where the recipe's `inlay` colour fills the face (kintsugi's gold). */
  inlay?: Field;
  /** 0..1: lead lines the glazier adds to cut a wide ground into panes (stained glass). */
  cames?: Field;
  /** −1..1, one value per piece of glass: that piece's melt. */
  pane?: Field;
  /** −1..1 per pixel: a displacement field the picture is carried along (`flow`). */
  flowX?: Field;
  flowY?: Field;
}

/**
 * THE SHAPE STAGE — how a piece of the material responds to the SHAPE it is
 * cut into and to the light, beyond the sheet's own relief. Every block is
 * optional and data; `animation/surface-body.ts` is the one implementation.
 * The card's `body`, `sheen`, `glow` and `flow` dials scale them (1 = tuned).
 */
export type SurfaceBodyProfile = "dome" | "pillow" | "bevel" | "tube";

export interface SurfaceBody {
  /**
   * dome    a quarter-round shoulder, then flat: clay, chrome, glaze
   * pillow  a soft rise that never quite stands up: felt, tufted pile
   * bevel   a straight chamfer: stamped foil, embossing, cut crystal
   * tube    a round tube along the edge, the inside dropped: neon
   */
  profile: SurfaceBodyProfile;
  /** How far in from the edge the rise runs, frame px (the tube's radius). */
  width: number;
  /** `width` is × |lift| instead: a cut-out's rounding is its thickness. */
  fromLift?: boolean;
  /** Rise per unit of width: 1 ≈ as tall as it is wide. */
  height: number;
  /** How hard the body's slopes are lit (as `shade` is for the sheet). */
  shade: number;
}

export interface SurfaceGloss {
  /** Strength of the highlight. */
  amount: number;
  /** Blinn exponent: 8 is satin, 80 is a wet glaze, 200 a mirror's pin. */
  tightness: number;
  /** 0 = white highlights (plastic, glaze), 1 = highlights in the face's own colour (metal). */
  metal: number;
  /** 0..1 — colour by angle: foil's rainbow, a soap film's bands. */
  iridescence: number;
  /** 0..1 — the face reflects a studio (sky, horizon, floor): chrome. */
  mirror: number;
  /** × the skin's slopes in the highlight: foil's sparkle, glass's ripple. */
  micro: number;
  /**
   * A dielectric's mirror: the share reflected face-on (Schlick's F0), rising
   * to all of it at a grazing slope. Black glass, lacquer, ferrofluid — dark
   * where you look straight in, the studio blazing round every curve. Absent:
   * a metal's mirror, the same at every angle.
   */
  fresnel?: number;
}

export interface SurfaceGlow {
  /** How much light the material gives off. */
  amount: number;
  /** The halo's reach outside the shape, frame px. */
  halo: number;
  /** 0..1 — the hot white core along the body's crown (a neon tube's centre). */
  core: number;
}

export interface SurfaceRecipePhysics {
  body?: SurfaceBody;
  gloss?: SurfaceGloss;
  glow?: SurfaceGlow;
  /** The picture is carried `amount` frame px along the flow field, in `steps` (1 = a jitter, many = swirls). */
  flow?: { amount: number; steps: number };
  /** The material's own colour pulls the picture's toward it: chrome's silver, ferrofluid's black. */
  pigment?: { color: readonly [number, number, number]; amount: number };
  /** 0..1 — what is behind shows through the face, most where it is flattest: a bubble, a glass. */
  clear?: number;
  /** Extra saturation of the face's colour: light through glass, a lit phosphor. */
  saturate?: number;
  /** The colour `inlay` fills with (and it shines as metal). */
  inlay?: readonly [number, number, number];
  /**
   * Light comes THROUGH the material from behind (stained glass): the face's
   * slopes bend it into `ripple`, the came shades the glass `edge` deep for
   * `falloff` frame px in from the lead, the window is brighter toward the
   * light by `backlight`, and each piece of the sheet's `pane` varies by
   * `vary`. Replaces lighting the face from the front.
   */
  transmit?: { ripple: number; edge: number; falloff: number; backlight: number; vary: number };
  /** A came along every boundary of colour: stained glass's lead. Width in frame px. */
  lead?: { width: number; tone: readonly [number, number, number] };
  /** One body over every colour under it — a liquid flows together; solid materials are cut into a piece per colour. */
  liquid?: boolean;
  /** Spikes rising out of the edge with the `edge` dial — a field pulling at ferrofluid. Frame px. */
  spikes?: { length: number; pitch: number };
  /**
   * Every region of the picture is the material — its ground too — not only
   * its shapes: a stained-glass window, a phosphor screen, frosted glass.
   */
  whole?: boolean;
  /**
   * Where the sheet's tile is laid: over everything (paper — the default),
   * only the GROUND between the shapes (a brick wall behind neon, the card
   * under foil), or nowhere (the shape stage owns every pixel).
   */
  overlay?: "all" | "ground" | "none";
}

export interface SurfaceRecipe extends SurfaceRecipePhysics {
  id: SurfaceMaterial;
  label: string;
  /** The sheet's own colour, 0..255 — what `multiply` and `under` lay down. */
  tone: readonly [number, number, number];
  /** Tile side in frame px at scale 1. Larger for materials with large features. */
  tile: number;
  /** Light elevation, degrees: low rakes across fibres, high only shows folds. */
  elevation: number;
  /** Height of the field in px per unit of `height` at scale 1 — sets the slopes. */
  depth: number;
  /** How hard the lit slopes brighten or darken, at relief 1. */
  shade: number;
  /** Coarse tone variation (mottling) across the sheet: amount, feature size in frame px. */
  mottle: { amount: number; size: number };
  /**
   * How the picture's edge breaks: reach in frame px, outward fuzz 0..1 (only
   * materials made of loose fibres — felt, linen — reach past the cut; it costs
   * three colour blurs, so paper does not pay for it), torn-rim whitening 0..1,
   * and `pool` 0..1: pigment that gathers inside a WET edge and dries darker
   * there (watercolour) — the one tell a wash has that a flat fill never does.
   */
  edge: { reach: number; fuzz: number; rim: number; pool?: number };
  /** Lift-shadow softness, × the lift. Paper is crisp, felt is a pillow. */
  liftSoftness: number;
  build: (n: number, unit: number, seed: number) => SurfaceLayers;
}

export const empty = (n: number) => new Float32Array(n * n);

export function scaleInto(dst: Field, src: Field, k: number): void {
  for (let i = 0; i < dst.length; i++) dst[i] = dst[i]! + src[i]! * k;
}

/** Cotton paper and its relatives: tooth + fibres, the ScientificMotion cream rule. */
export function paperLayers(n: number, unit: number, seed: number, o: {
  tooth: readonly [number, number];
  fibres: FibreSpec;
  /** Albedo per unit fibre (negative = darker than the sheet). */
  fibreTone: number;
  toothTone: number;
  flecks?: { density: number; radius: readonly [number, number]; tone: number };
  lightFibres?: { spec: FibreSpec; tone: number };
}): SurfaceLayers {
  const rng = makeRng(seed);
  const tooth = fractal(n, [o.tooth[0] * unit, o.tooth[1] * unit], [1, 0.5], rng);
  const fib = gaussWrap(fibres(n, { ...o.fibres, length: [o.fibres.length[0] * unit, o.fibres.length[1] * unit] }, rng), n, 0.6 * unit);
  const height = empty(n);
  const albedo = empty(n);
  scaleInto(height, fib, 1.2);
  scaleInto(albedo, fib, o.fibreTone);
  if (o.lightFibres) {
    const lf = gaussWrap(fibres(n, { ...o.lightFibres.spec, length: [o.lightFibres.spec.length[0] * unit, o.lightFibres.spec.length[1] * unit] }, rng), n, 0.6 * unit);
    scaleInto(height, lf, 1);
    scaleInto(albedo, lf, o.lightFibres.tone);
  }
  if (o.flecks) {
    const fl = specks(n, o.flecks.density / (unit * unit), [o.flecks.radius[0] * unit, o.flecks.radius[1] * unit], rng);
    scaleInto(albedo, fl, o.flecks.tone);
    scaleInto(height, fl, 0.4);
  }
  const toothHeight = empty(n);
  const toothAlbedo = empty(n);
  scaleInto(toothHeight, tooth, 0.5);
  scaleInto(toothAlbedo, tooth, o.toothTone);
  return { height, albedo, toothHeight, toothAlbedo };
}

/** Plain weaves: linen and canvas. */
export function clothLayers(n: number, unit: number, seed: number, o: { period: number; slub: number; weftTone: number; toneVar: number; contrast: number; primer: number }): SurfaceLayers {
  const rng = makeRng(seed);
  const { height: w, tone } = weave(n, o.period * unit, o.slub, o.weftTone, rng);
  const height = empty(n);
  const albedo = empty(n);
  let mean = 0;
  for (let i = 0; i < w.length; i++) mean += w[i]!;
  mean /= w.length;
  for (let i = 0; i < w.length; i++) {
    height[i] = w[i]!;
    // The valleys between threads are darker (shadowed fibre); each thread
    // carries its own slightly different dye lot.
    albedo[i] = (w[i]! - mean) * o.contrast + tone[i]! * o.toneVar;
  }
  const fine = fractal(n, [0.8 * unit], [1], rng);
  const toothHeight = empty(n);
  const toothAlbedo = empty(n);
  scaleInto(toothHeight, fine, 0.25 + o.primer);
  scaleInto(toothAlbedo, fine, 0.03 + o.primer * 0.04);
  return { height, albedo, toothHeight, toothAlbedo };
}


/**
 * Fingerprints pressed into clay: a few whorls, each an ellipse of fine
 * concentric ridges (period ~2.6 px) that fades out from its centre and is
 * squashed and turned at random — the trace of a thumb, not a pattern.
 */
export function fingerprints(n: number, unit: number, rng: () => number): Field {
  const f = new Float32Array(n * n);
  const count = Math.max(2, Math.round(((n * n) / (768 * 768)) * 5 / (unit * unit)));
  const period = 2.6 * unit;
  for (let c = 0; c < count; c++) {
    const cx = rng() * n;
    const cy = rng() * n;
    const r = (22 + rng() * 18) * unit;
    const th = rng() * Math.PI;
    const squash = 0.55 + rng() * 0.3;
    const co = Math.cos(th);
    const si = Math.sin(th);
    const R = Math.min(Math.floor(n / 2), Math.ceil(r * 1.6));
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const a = dx * co + dy * si;
        const b = (-dx * si + dy * co) / squash;
        const d = Math.hypot(a, b);
        const fall = Math.exp(-(d * d) / (r * r));
        if (fall < 0.02) continue;
        const px = (((Math.floor(cx) + dx) % n) + n) % n;
        const py = (((Math.floor(cy) + dy) % n) + n) % n;
        f[py * n + px] = f[py * n + px]! + Math.sin((2 * Math.PI * d) / period) * fall;
      }
    }
  }
  return f;
}

/**
 * A ruled grid as albedo: thin lines every `pitch` px and a heavier one every
 * `every`-th, whole counts so the tile repeats. Lines are ~1.2 px with a soft
 * shoulder so they anti-alias at any scale. Positive tones lighten (a
 * blueprint's pale grid), negative ones darken (graph paper's printed one).
 */
export function ruledGrid(n: number, unit: number, o: { pitch: number; every: number; minor: number; major: number }): Field {
  const f = new Float32Array(n * n);
  const cells = Math.max(o.every, Math.round(n / (o.pitch * unit) / o.every) * o.every);
  const p = n / cells;
  const line = (v: number): { minor: number; major: number } => {
    const k = v / p;
    const d = Math.abs(k - Math.round(k)) * p;
    const minor = Math.max(0, 1 - Math.max(0, d - 0.35) / 0.9);
    const major = Math.round(k) % o.every === 0 ? Math.max(0, 1 - Math.max(0, d - 0.8) / 1) : 0;
    return { minor, major };
  };
  const at = Array.from({ length: n }, (_, i) => line(i));
  for (let y = 0; y < n; y++) {
    const ly = at[y]!;
    for (let x = 0; x < n; x++) {
      const lx = at[x]!;
      f[y * n + x] = Math.max(lx.minor, ly.minor) * o.minor + Math.max(lx.major, ly.major) * o.major;
    }
  }
  return f;
}

/**
 * Planed wood: GROWTH RINGS running along the board (x), each a soft
 * earlywood band that ends in a dark, hard latewood line, wandering as the
 * tree did (a large warp), unevenly spaced; fine streaks that follow the same
 * lines; and open PORES — short dark dashes along the grain. The latewood is
 * both darker and lower (it is what a wire brush or a print roller finds), so
 * a light raking across it and ink skipping it read the same grain.
 */
export function woodGrain(n: number, unit: number, rng: () => number): { height: Field; albedo: Field } {
  const rings = Math.max(3, Math.round(n / (18 * unit)));
  const warp = fractal(n, [70 * unit, 150 * unit], [1, 0.6], rng);
  const wobble = fractal(n, [5 * unit], [1], rng);
  const spacing = periodic1D(n, 14 * unit, rng);
  const fine = periodic1D(n, 0.8 * unit, rng);
  const coarse = periodic1D(n, 2.6 * unit, rng);
  const pores = gaussWrap(fibres(n, { density: 2.2e-3 / (unit * unit), length: [3 * unit, 10 * unit], alpha: [0.2, 0.6], bend: 0.08, grain: { angle: 0, strength: 1 } }, rng), n, 0.45 * unit);
  const height = empty(n);
  const albedo = empty(n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      // Along-the-grain coordinate: rows bent by the warp. Whole rings per
      // tile and index-periodic noise keep it seamless.
      const t = y + warp[i]! * 26 * unit + wobble[i]! * 1.4 * unit;
      const idx = ((Math.round(t) % n) + n) % n;
      const ph = ((t + spacing[idx]! * 5 * unit) / n) * rings;
      const fr = ph - Math.floor(ph);
      const late = smoothstep(0.6, 0.84, fr) * (1 - smoothstep(0.9, 1, fr));
      const streak = fine[idx]! * 0.6 + coarse[idx]! * 0.4;
      height[i] = -late * 0.7 + streak * 0.3 - pores[i]! * 1.1;
      albedo[i] = -late * 0.17 + streak * 0.05 - pores[i]! * 0.2;
    }
  }
  return { height, albedo };
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// ── Blurs over a picture (clamped, not periodic) ────────────────────────────

/** A blurred field held at a fraction of the resolution: `f` px per sample. */
export interface CoarseField {
  f: number;
  w: number;
  h: number;
  data: Float32Array;
}

/**
 * A wide blur at reduced resolution — a box-average downsample, then the box
 * blur at radius / f. A blur wide enough to want this has no detail the
 * downsample could lose, and it costs f² less.
 */
export function coarseBlur(src: Float32Array, w: number, h: number, radius: number): CoarseField {
  const f = radius >= 6 ? 4 : radius >= 1.5 ? 2 : 1;
  if (f === 1) return { f, w, h, data: boxBlurClamp(src, w, h, radius) };
  const cw = Math.ceil(w / f);
  const chh = Math.ceil(h / f);
  const small = new Float32Array(cw * chh);
  for (let y = 0; y < h; y++) {
    const row = ((y / f) | 0) * cw;
    const srow = y * w;
    for (let cx = 0, x = 0; cx < cw; cx++) {
      let sum = 0;
      const end = Math.min(w, x + f);
      for (; x < end; x++) sum += src[srow + x]!;
      small[row + cx] = small[row + cx]! + sum;
    }
  }
  const inv = 1 / (f * f);
  for (let i = 0; i < small.length; i++) small[i] = small[i]! * inv;
  return { f, w: cw, h: chh, data: boxBlurClamp(small, cw, chh, radius / f) };
}

/** Bilinear read of a coarse field at full-resolution coordinates, clamped. */
export function sampleCoarse(c: CoarseField, x: number, y: number): number {
  const fx = Math.min(c.w - 1, Math.max(0, (x + 0.5) / c.f - 0.5));
  const fy = Math.min(c.h - 1, Math.max(0, (y + 0.5) / c.f - 0.5));
  const x0 = fx | 0;
  const y0 = fy | 0;
  const x1 = x0 + 1 < c.w ? x0 + 1 : x0;
  const y1 = y0 + 1 < c.h ? y0 + 1 : y0;
  const tx = fx - x0;
  const ty = fy - y0;
  const d = c.data;
  const a = d[y0 * c.w + x0]! + (d[y0 * c.w + x1]! - d[y0 * c.w + x0]!) * tx;
  const b = d[y1 * c.w + x0]! + (d[y1 * c.w + x1]! - d[y1 * c.w + x0]!) * tx;
  return a + (b - a) * ty;
}

/**
 * Box blur (×3 by default) with clamped edges, over a w×h float field. Radius
 * px. Written for the cache: the horizontal pass slides along a row, and the
 * vertical one slides a whole ROW of running sums down the image instead of
 * walking each column with a stride of w.
 */
export function boxBlurClamp(src: Float32Array, w: number, h: number, radius: number, passes = 3): Float32Array {
  const r = Math.max(1, Math.round(radius));
  const inv = 1 / (2 * r + 1);
  const tmp = new Float32Array(w * h);
  const acc = new Float32Array(w);
  let a: Float32Array = src;
  let out: Float32Array = new Float32Array(w * h);
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += a[row + (k < 0 ? 0 : k >= w ? w - 1 : k)]!;
      for (let x = 0; x < w; x++) {
        tmp[row + x] = sum * inv;
        const add = x + r + 1;
        const sub = x - r;
        sum += a[row + (add < w ? add : w - 1)]! - a[row + (sub > 0 ? sub : 0)]!;
      }
    }
    acc.fill(0);
    for (let k = -r; k <= r; k++) {
      const rk = (k < 0 ? 0 : k >= h ? h - 1 : k) * w;
      for (let x = 0; x < w; x++) acc[x] = acc[x]! + tmp[rk + x]!;
    }
    for (let y = 0; y < h; y++) {
      const row = y * w;
      const addRow = (y + r + 1 < h ? y + r + 1 : h - 1) * w;
      const subRow = (y - r > 0 ? y - r : 0) * w;
      for (let x = 0; x < w; x++) {
        out[row + x] = acc[x]! * inv;
        acc[x] = acc[x]! + tmp[addRow + x]! - tmp[subRow + x]!;
      }
    }
    if (pass < passes - 1) {
      // Ping-pong: the next pass reads what this one wrote.
      const next = a === src ? new Float32Array(w * h) : a;
      a = out;
      out = next;
    } else a = out;
  }
  return a;
}

// ── Generators for the shape stage's materials ───────────────────────────────

/** A cell field: per pixel the nearest seed's index, its distance, and the distance to the next cell's border. */
export interface Cells {
  /** Index of the nearest seed. */
  id: Int32Array;
  /** Index of the second nearest — which border this pixel is near. */
  id2: Int32Array;
  /** Distance to the nearest seed, px. */
  f1: Field;
  /** ≈ distance to the nearest cell border, px ((f2 − f1) / 2). */
  border: Field;
  /** Each seed's offset from this pixel, so a cell can carry a plane: dx, dy per pixel. */
  dx: Field;
  dy: Field;
}

/**
 * Periodic Voronoi cells: `g × g` jittered seeds over the tile, each pixel
 * finding its nearest two among the 3×3 neighbouring grid cells (wrapping).
 * Facets, flakes, cracks and leading all start here.
 */
export function voronoi(n: number, cellPx: number, rng: () => number, jitter = 0.9): Cells {
  const g = Math.max(2, Math.round(n / cellPx));
  const c = n / g;
  const sx = new Float32Array(g * g);
  const sy = new Float32Array(g * g);
  for (let j = 0; j < g; j++) {
    for (let i = 0; i < g; i++) {
      sx[j * g + i] = (i + 0.5 + (rng() - 0.5) * jitter) * c;
      sy[j * g + i] = (j + 0.5 + (rng() - 0.5) * jitter) * c;
    }
  }
  const id = new Int32Array(n * n);
  const id2 = new Int32Array(n * n);
  const f1 = new Float32Array(n * n);
  const border = new Float32Array(n * n);
  const dxs = new Float32Array(n * n);
  const dys = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    const gy = Math.floor(y / c);
    for (let x = 0; x < n; x++) {
      const gx = Math.floor(x / c);
      let b1 = Infinity;
      let b2 = Infinity;
      let i1 = 0;
      let i2 = 0;
      let bdx = 0;
      let bdy = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const cx = gx + ox;
          const cy = gy + oy;
          const wx = ((cx % g) + g) % g;
          const wy = ((cy % g) + g) % g;
          const k = wy * g + wx;
          // The seed's position in THIS copy of the tile.
          const px = sx[k]! + (cx - wx) * c;
          const py = sy[k]! + (cy - wy) * c;
          const ddx = px - x;
          const ddy = py - y;
          const d = ddx * ddx + ddy * ddy;
          if (d < b1) {
            b2 = b1;
            i2 = i1;
            b1 = d;
            i1 = k;
            bdx = ddx;
            bdy = ddy;
          } else if (d < b2) {
            b2 = d;
            i2 = k;
          }
        }
      }
      const i = y * n + x;
      id[i] = i1;
      id2[i] = i2;
      const r1 = Math.sqrt(b1);
      f1[i] = r1;
      border[i] = (Math.sqrt(b2) - r1) / 2;
      dxs[i] = bdx;
      dys[i] = bdy;
    }
  }
  return { id, id2, f1, border, dx: dxs, dy: dys };
}

/** A deterministic 0..1 per integer — per-cell randoms that need no table. */
export function hash01(a: number, b = 0): number {
  let h = Math.imul(a ^ 0x27d4eb2d, 0x165667b1) ^ Math.imul(b + 0x3c6ef372, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/**
 * FACETS: every cell a flat plane tilted its own way (± `tilt` per px), so a
 * light picks out each face on its own — cut crystal, a glitter flake, ice.
 */
export function facets(cells: Cells, n: number, tilt: number): Field {
  const f = new Float32Array(n * n);
  for (let i = 0; i < f.length; i++) {
    const k = cells.id[i]!;
    const ax = (hash01(k, 1) - 0.5) * 2 * tilt;
    const ay = (hash01(k, 2) - 0.5) * 2 * tilt;
    f[i] = -cells.dx[i]! * ax - cells.dy[i]! * ay + hash01(k, 3) * tilt * 4;
  }
  return f;
}

/**
 * A divergence-free FLOW (the curl of a smooth periodic potential): it swirls
 * and never piles the picture up or tears it open — ink on water, marbling.
 * Returned as unit-peak (x, y).
 */
export function curlFlow(n: number, sigmas: readonly number[], weights: readonly number[], rng: () => number): { x: Field; y: Field } {
  const psi = fractal(n, sigmas, weights, rng);
  const x = new Float32Array(n * n);
  const y = new Float32Array(n * n);
  let peak = 1e-9;
  for (let j = 0; j < n; j++) {
    const up = ((j - 1 + n) % n) * n;
    const dn = ((j + 1) % n) * n;
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const vx = (psi[dn + i]! - psi[up + i]!) * 0.5;
      const vy = -(psi[j * n + ((i + 1) % n)]! - psi[j * n + ((i - 1 + n) % n)]!) * 0.5;
      x[k] = vx;
      y[k] = vy;
      peak = Math.max(peak, Math.hypot(vx, vy));
    }
  }
  for (let k = 0; k < x.length; k++) {
    x[k] = x[k]! / peak;
    y[k] = y[k]! / peak;
  }
  return { x, y };
}

/**
 * Bricks in a running bond: whole bricks per tile, every other course offset
 * by half, each brick its own slight height and tone, sunk mortar between.
 */
export function bricks(n: number, unit: number, rng: () => number): { height: Field; albedo: Field } {
  const rows = Math.max(2, Math.round(n / (26 * unit)));
  const courses = rows % 2 === 0 ? rows : rows + 1;
  const bh = n / courses;
  const cols = Math.max(1, Math.round(n / (78 * unit)));
  const bw = n / cols;
  const mortar = 2.4 * unit;
  const seed = Math.floor(rng() * 1e6);
  const height = new Float32Array(n * n);
  const albedo = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    const row = Math.floor(y / bh);
    const vy = y - row * bh;
    for (let x = 0; x < n; x++) {
      const xs = (x + (row % 2) * bw * 0.5) % n;
      const col = Math.floor(xs / bw);
      const vx = xs - col * bw;
      const d = Math.min(vx, bw - vx, vy, bh - vy);
      const inBrick = smoothstep(mortar * 0.5, mortar * 1.4, d);
      const k = (row % courses) * 1000 + (col % cols);
      const i = y * n + x;
      height[i] = inBrick * (0.8 + hash01(k, seed) * 0.4);
      albedo[i] = inBrick * (hash01(k, seed + 1) - 0.5) * 0.18 - (1 - inBrick) * 0.12;
    }
  }
  return { height, albedo };
}

/**
 * A pile of yarn loops, as a tufting gun leaves them: a jittered grid of
 * small rings (the loop's arc seen from above) packed so they touch, each a
 * little taller or shorter than its neighbour.
 */
export function loopPile(n: number, pitch: number, rng: () => number): Field {
  const g = Math.max(2, Math.round(n / pitch));
  const c = n / g;
  const f = new Float32Array(n * n);
  const r = c * 0.62;
  for (let j = 0; j < g; j++) {
    for (let i = 0; i < g; i++) {
      const cx = (i + 0.5 + (rng() - 0.5) * 0.5) * c;
      const cy = (j + 0.5 + (rng() - 0.5) * 0.5) * c;
      const tall = 0.75 + rng() * 0.5;
      const R = Math.ceil(r + 2);
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const d = Math.hypot(dx + (cx % 1), dy + (cy % 1));
          if (d > r + 1) continue;
          // A loop: a torus of yarn — high on its ring, dipping at its eye.
          const ring = Math.exp(-(((d - r * 0.5) / (r * 0.32)) ** 2));
          const v = ring * tall;
          const px = (((Math.floor(cx) + dx) % n) + n) % n;
          const py = (((Math.floor(cy) + dy) % n) + n) % n;
          f[py * n + px] = Math.max(f[py * n + px]!, v);
        }
      }
    }
  }
  return f;
}

/**
 * An aperture grille: vertical red, green and blue phosphor stripes (whole
 * triads per tile) with a dark gap between them and a darker line every few
 * px down the screen — the tint a CRT's face lays over everything it shows.
 *
 * BAND-LIMITED. Each pixel is the grille AVERAGED over its footprint, and
 * below ~4 px a triad fades to its mean: at a thumbnail the device pixel is
 * wider than a stripe, and point-sampling a pattern finer than the pixels
 * beats into moiré that swallows the picture. A tube seen from across the
 * room is a smooth picture; the grille is what you see up close. (Fading to
 * clear, not to the grille's mean, is what keeps the thumbnail bright: the
 * tile's `gain` makes up whatever the grille holds back.)
 */
export function phosphorTriads(n: number, pitch: number): Float32Array {
  const triads = Math.max(2, Math.round(n / pitch));
  const p = n / triads;
  const rows = Math.max(2, Math.round(n / (p * 1.05)));
  const rp = n / rows;
  const contrast = smoothstep(2.2, 4.2, p);
  const SS = 8;
  // The grille is separable — stripes across, scanlines down — so each axis
  // is averaged once: per column a colour, per row a darkening.
  const col = new Float32Array(n * 3);
  for (let x = 0; x < n; x++) {
    for (let s = 0; s < SS; s++) {
      const u = ((((x + (s + 0.5) / SS) % p) + p) % p / p) * 3;
      const which = Math.min(2, Math.floor(u));
      const inStripe = 0.72 + 0.28 * Math.sin(Math.PI * (u - which));
      // Each stripe passes its own primary and holds back the other two.
      for (let ch = 0; ch < 3; ch++) col[x * 3 + ch] = col[x * 3 + ch]! + ((ch === which ? 1 : 0.55) * inStripe) / SS;
    }
  }
  const row = new Float32Array(n);
  for (let y = 0; y < n; y++) {
    for (let s = 0; s < SS; s++) {
      const vy = (((y + (s + 0.5) / SS) % rp) / rp);
      row[y] = row[y]! + (vy > 0.85 ? 0.7 : 1) / SS;
    }
  }
  const tint = new Float32Array(n * n * 3);
  for (let y = 0; y < n; y++) {
    const scan = 1 + (row[y]! - 1) * contrast;
    for (let x = 0; x < n; x++) {
      const o = (y * n + x) * 3;
      for (let ch = 0; ch < 3; ch++) tint[o + ch] = (1 + (col[x * 3 + ch]! - 1) * contrast) * scan - 1;
    }
  }
  return tint;
}

/**
 * Cracks: the borders of a few large cells, wandering (the coordinates are
 * warped first), and only some of them — a pot breaks along a handful of
 * lines, not a net. 0..1 coverage of a line `width` px wide.
 */
export function cracks(n: number, cellPx: number, width: number, keep: number, rng: () => number): Field {
  const cells = voronoi(n, cellPx, rng, 0.95);
  const warp = curlFlow(n, [cellPx * 0.18], [1], rng);
  const f = new Float32Array(n * n);
  const amp = cellPx * 0.08;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      // Read the cell field a little off this pixel: the line wanders.
      const sx = (((Math.round(x + warp.x[i]! * amp)) % n) + n) % n;
      const sy = (((Math.round(y + warp.y[i]! * amp)) % n) + n) % n;
      const j = sy * n + sx;
      const a = Math.min(cells.id[j]!, cells.id2[j]!);
      const b = Math.max(cells.id[j]!, cells.id2[j]!);
      if (hash01(a, b) > keep) continue;
      f[i] = 1 - smoothstep(width * 0.35, width, cells.border[j]!);
    }
  }
  return f;
}
