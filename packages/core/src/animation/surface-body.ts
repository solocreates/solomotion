import { boxBlurClamp, coarseBlur, hash01, sampleCoarse, smoothstep, type SurfaceRecipePhysics } from "./surface-fields";

/**
 * THE SHAPE STAGE — how a piece of material responds to the SHAPE it is cut
 * into, and to the light. The sheet (`surface.ts`) knows fibres and tooth;
 * this knows that a felt piece is a pillow, a clay one a dome, a chrome one a
 * mirror bulging toward you, a neon one a glowing tube along its edge, that
 * stained glass is held in lead, that ferrofluid spikes when pulled.
 *
 * One pipeline for every material, each step a block of recipe DATA
 * (`SurfaceRecipePhysics`) scaled by a card dial:
 *
 *   flow      the picture is carried along the material's flow field (marbling,
 *             frost) — before anything reads its shapes
 *   distance  how far each pixel is inside its shape (an exact Euclidean
 *             distance transform, O(n)), and outside it for spikes
 *   height    the body's profile over that distance (dome, pillow, bevel,
 *             tube), lead cames, spikes — one height field, in px
 *   normal    its slope, plus the skin's (foil grooves, crystal facets)
 *   colour    pigment and inlay, lit by the body; iridescence; a studio
 *             reflection; a highlight; what shows through a clear face; a hot
 *             core
 *   halo      light thrown past the shape
 *
 * Pure typed arrays, no DOM: the stage, the exporter and a test produce the
 * same pixels. Called by `cutSurface` after the cut has decided coverage.
 */

/** The tile reads the stage needs, sampled at the step's offset. */
export interface ShapeTile {
  size: number;
  /** Buffer px per tile texel (≥ 1): >1 when the sheet was built coarser than it is seen (`surfaceTileScale`). */
  scale?: number;
  /** The sheet's lit maps — laid on the GROUND here when the recipe's overlay is "ground". */
  dark: Uint8ClampedArray;
  light: Uint8ClampedArray;
  /** The skin's slope, px per px (absent: a flat face). */
  skinX?: Float32Array;
  skinY?: Float32Array;
  gloss?: Float32Array;
  film?: Float32Array;
  inlay?: Float32Array;
  /** 0..1: lead the glazier adds to cut the GROUND into panes (stained glass). */
  cames?: Float32Array;
  /** −1..1 per piece of glass: its melt — a little warmer or cooler, denser or clearer. */
  pane?: Float32Array;
  /** × the face's brightness, making up what the sheet's colour map will hold back (a phosphor grille). */
  gain?: number;
}

export interface ShapeParams {
  /** Device px per frame px × the card's scale. */
  unit: number;
  lightX: number;
  lightY: number;
  lightAngle: number;
  /** Elevation of the light, degrees. */
  elevation: number;
  /** Device px; negative = pressed in. */
  lift: number;
  edge: number;
  body: number;
  sheen: number;
  glow: number;
  offsetX: number;
  offsetY: number;
}

/** Will the shape stage touch any pixel for these dials? */
export function shapeStageActive(r: SurfaceRecipePhysics, p: Pick<ShapeParams, "body" | "sheen" | "glow" | "edge" | "lift">): boolean {
  const bodyOn = !!r.body && p.body > 0.002 && (!r.body.fromLift || Math.abs(p.lift) > 0.25);
  return (
    bodyOn ||
    (!!r.gloss && p.sheen > 0.002) ||
    (!!r.glow && p.glow > 0.002) ||
    (!!r.spikes && p.edge > 0.002) ||
    !!r.lead ||
    !!r.pigment ||
    !!r.inlay ||
    r.overlay === "ground"
  );
}

// ── Distance ─────────────────────────────────────────────────────────────────

const INF = 1e20;

/** Felzenszwalb–Huttenlocher 1D squared distance transform of `f` (length n) into `d`. */
function dt1(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    const fq = f[q]! + q * q;
    let vk = v[k]!;
    let s = (fq - (f[vk]! + vk * vk)) / (2 * q - 2 * vk);
    while (s <= z[k]!) {
      k--;
      vk = v[k]!;
      s = (fq - (f[vk]! + vk * vk)) / (2 * q - 2 * vk);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const vk = v[k]!;
    d[q] = (q - vk) * (q - vk) + f[vk]!;
  }
}

/**
 * Exact Euclidean distance, px, from every pixel to the nearest SEED pixel —
 * two separable passes, linear in the pixel count. 0 on a seed; a large
 * number when there is no seed at all.
 */
export function distanceToSeeds(seed: Uint8Array, w: number, h: number): Float32Array {
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const grid = new Float64Array(w * h);
  for (let i = 0; i < grid.length; i++) grid[i] = seed[i] ? 0 : INF;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x]!;
    dt1(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y]!;
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = grid[row + x]!;
    dt1(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[row + x] = Math.sqrt(Math.min(d[x]!, 1e12));
  }
  return out;
}

// ── Light ────────────────────────────────────────────────────────────────────

/** Thin-film colour at a phase (cycles): the rainbow foil and soap film share. 0..1 per channel. */
export function filmColor(phase: number): [number, number, number] {
  const t = 2 * Math.PI * phase;
  return [
    0.18 + 0.82 * (0.5 + 0.5 * Math.cos(t)),
    0.18 + 0.82 * (0.5 + 0.5 * Math.cos(t - 2.094)),
    0.18 + 0.82 * (0.5 + 0.5 * Math.cos(t - 4.189)),
  ];
}

/**
 * The studio a mirror sees, 0..~1.5 by reflected direction (screen space, y
 * down): a bright sky above with a softbox in it, a crisp horizon, a dark
 * floor. The horizon is what makes chrome read as chrome — a hard light/dark
 * line running through every curve.
 */
export function studio(rx: number, ry: number): number {
  const hz = ry * 0.9 + rx * 0.22;
  const sky = 0.55 + 0.45 * smoothstep(0, -0.9, hz);
  const floor = 0.04 + 0.2 * smoothstep(0.15, 1, hz);
  let e = sky + (floor - sky) * smoothstep(-0.025, 0.025, hz);
  e += 0.7 * Math.exp(-(((rx + 0.5) / 0.2) ** 2) - ((ry + 0.48) / 0.16) ** 2);
  e += 0.25 * Math.exp(-(((rx - 0.62) / 0.12) ** 2) - ((ry + 0.1) / 0.35) ** 2);
  return e;
}

// ── The flow ─────────────────────────────────────────────────────────────────

/**
 * Carry the picture along the material's flow field: each pixel looks back
 * along the field `steps` times (`amount` device px in all) and takes the
 * colour it finds there. One step is a scatter (frost); many trace the
 * field's curls (marbling). The field is the tile's, at the step's offset, so
 * the swirl belongs to the sheet and stays put while the picture moves.
 */
export function flowPicture(
  px: Uint8ClampedArray,
  w: number,
  h: number,
  field: { size: number; x: Float32Array; y: Float32Array; ox: number; oy: number; scale?: number },
  amount: number,
  steps: number,
): void {
  if (amount < 0.25) return;
  const src = px.slice();
  const map = flowMap(w, h, field, amount, steps);
  const gw = Math.ceil(w / FLOW_GRID) + 1;
  for (let y = 0; y < h; y++) {
    const gy = y / FLOW_GRID;
    const r0 = gy | 0;
    const vy = gy - r0;
    for (let x = 0; x < w; x++) {
      // Where this pixel came from: the grid's answer, bilinear between its
      // four nearest points (the flow is smooth at that scale; see `flowMap`).
      const gx = x / FLOW_GRID;
      const c0 = gx | 0;
      const vx = gx - c0;
      const g00 = (r0 * gw + c0) * 2;
      const g10 = g00 + 2;
      const g01 = g00 + gw * 2;
      const g11 = g01 + 2;
      const dx = (map[g00]! * (1 - vx) + map[g10]! * vx) * (1 - vy) + (map[g01]! * (1 - vx) + map[g11]! * vx) * vy;
      const dy = (map[g00 + 1]! * (1 - vx) + map[g10 + 1]! * vx) * (1 - vy) + (map[g01 + 1]! * (1 - vx) + map[g11 + 1]! * vx) * vy;
      // Bilinear, clamped: a frame has no colour past its edge.
      const fx = Math.min(w - 1, Math.max(0, x + dx));
      const fy = Math.min(h - 1, Math.max(0, y + dy));
      const x0 = fx | 0;
      const y0 = fy | 0;
      const x1 = x0 + 1 < w ? x0 + 1 : x0;
      const y1 = y0 + 1 < h ? y0 + 1 : y0;
      const ax = fx - x0;
      const ay = fy - y0;
      const o = (y * w + x) * 4;
      const o00 = (y0 * w + x0) * 4;
      const o10 = (y0 * w + x1) * 4;
      const o01 = (y1 * w + x0) * 4;
      const o11 = (y1 * w + x1) * 4;
      for (let c = 0; c < 4; c++) {
        const top = src[o00 + c]! + (src[o10 + c]! - src[o00 + c]!) * ax;
        const bot = src[o01 + c]! + (src[o11 + c]! - src[o01 + c]!) * ax;
        px[o + c] = top + (bot - top) * ay;
      }
    }
  }
}

/** Pixels between the points `flowMap` traces. The flow's curls span 30–80 units, so 4 px loses nothing. */
const FLOW_GRID = 4;

/** The last map traced per field — a playing comp asks for the same one every frame. */
const flowMaps = new WeakMap<Float32Array, { key: string; map: Float32Array }>();

/**
 * Where each point of a `FLOW_GRID` lattice over the frame came from, as
 * (dx, dy) pairs: the point carried back along the field in `steps` small
 * steps. It depends on the field, its offset, the frame size and the amount —
 * never the picture or the time — so it is traced once and kept, and every
 * frame after is one resample. Tracing every pixel every frame was ~0.5 s a
 * frame at 1080², the slowest look in the library.
 */
function flowMap(w: number, h: number, field: { size: number; x: Float32Array; y: Float32Array; ox: number; oy: number; scale?: number }, amount: number, steps: number): Float32Array {
  const ks = field.scale ?? 1;
  const key = `${w}x${h}:${field.ox},${field.oy}:${amount}:${steps}:${ks}`;
  const hit = flowMaps.get(field.x);
  if (hit?.key === key) return hit.map;
  const T = field.size;
  const k = amount / Math.max(1, steps);
  const gw = Math.ceil(w / FLOW_GRID) + 1;
  const gh = Math.ceil(h / FLOW_GRID) + 1;
  const map = new Float32Array(gw * gh * 2);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const x = gx * FLOW_GRID;
      const y = gy * FLOW_GRID;
      let sx = x;
      let sy = y;
      for (let s = 0; s < steps; s++) {
        const tx = ((Math.round(sx / ks) + field.ox) % T + T) % T;
        const ty = ((Math.round(sy / ks) + field.oy) % T + T) % T;
        const j = ty * T + tx;
        sx -= field.x[j]! * k;
        sy -= field.y[j]! * k;
      }
      const g = (gy * gw + gx) * 2;
      map[g] = sx - x;
      map[g + 1] = sy - y;
    }
  }
  flowMaps.set(field.x, { key, map });
  return map;
}

// ── The stage ────────────────────────────────────────────────────────────────

/**
 * Runs the shape stage over RGBA (straight alpha, device px) in place.
 *
 * `mask` is the shapes' coverage AFTER the cut; `back` is what shows where a
 * shape's coverage drops (a tube's empty middle, a clear face): the sheet's
 * tone or the picture's ground for an opaque picture, null for a layer, whose
 * dropped coverage is alpha.
 */
export function shapeSurface(
  px: Uint8ClampedArray,
  w: number,
  h: number,
  mask: Float32Array,
  back: readonly [number, number, number] | null,
  r: SurfaceRecipePhysics,
  p: ShapeParams,
  tile: ShapeTile,
): void {
  const n = w * h;
  const u = p.unit;
  const T = tile.size;
  const ox = Math.floor(p.offsetX * T);
  const oy = Math.floor(p.offsetY * T);
  // Buffer px → tile texel (identity unless the sheet was built coarser than seen).
  const inv = 1 / (tile.scale ?? 1);
  const tex = (v: number) => (v * inv) | 0;
  const whole = !!r.whole;

  const body = r.body && p.body > 0.002 && (!r.body.fromLift || Math.abs(p.lift) > 0.25) ? r.body : null;
  const bodyW = body ? Math.max(1, (body.fromLift ? Math.abs(p.lift) * body.width : body.width * u)) : 0;
  // A piece PRESSED into the sheet (negative lift) is the same profile
  // upside down: its walls fall away from the sheet instead of rising.
  const bodyH = body ? body.height * bodyW * p.body * (body.fromLift && p.lift < 0 ? -1 : 1) : 0;
  const spikes = r.spikes && p.edge > 0.002 ? r.spikes : null;

  // ── Distance ───────────────────────────────────────────────────────────
  const inside = new Uint8Array(n);
  const outside = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const m = whole ? 1 : mask[i]!;
    inside[i] = m >= 0.5 ? 1 : 0;
    outside[i] = 1 - inside[i]!;
  }
  // PIECES: every region of one colour is its own piece. A sun on a star is
  // two pieces of felt, two neon tubes, two panes of glass — not one shape
  // with a hole in its relief. So bodies and lead measure to the nearest
  // boundary of COLOUR as well as to the ground. A gradient never crosses
  // the threshold between neighbours, so a shaded fill stays one piece.
  // A liquid is the exception: one blob flows over every colour under it.
  let edges: Uint8Array | null = null;
  const cames = r.lead ? tile.cames : undefined;
  if ((body && !r.liquid) || r.lead) {
    const seed = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const o = i * 4;
        const right = x + 1 < w ? o + 4 : o;
        const down = y + 1 < h ? o + w * 4 : o;
        let d = 0;
        for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(px[o + c]! - px[right + c]!), Math.abs(px[o + c]! - px[down + c]!));
        if (d > 36 || (!whole && Math.abs(mask[i]! - (x + 1 < w ? mask[i + 1]! : mask[i]!)) > 0.35)) seed[i] = 1;
        // A glazier cuts a wide ground into panes; the subject's pieces stay whole.
        else if (cames && mask[i]! < 0.5 && cames[((tex(y) + oy) % T) * T + ((tex(x) + ox) % T)]! > 0.5) seed[i] = 1;
      }
    }
    edges = seed;
  }
  // The distance INTO a piece, offset by the coverage so an antialiased edge
  // stays antialiased in the profile.
  let dIn: Float32Array | null = null;
  if (body) {
    const seed = new Uint8Array(n);
    for (let i = 0; i < n; i++) seed[i] = outside[i]! | (inside[i]! & (edges && !r.liquid ? edges[i]! : 0));
    dIn = distanceToSeeds(seed, w, h);
    for (let i = 0; i < n; i++) if (inside[i]) dIn[i] = Math.max(0, dIn[i]! - 1 + mask[i]!);
  }
  const dOut = spikes ? distanceToSeeds(inside, w, h) : null;

  // Lead follows every boundary of colour: two panes meet in a came as
  // surely as glass meets the frame.
  const leadW = r.lead ? Math.max(1, r.lead.width * u) : 0;
  const dLead = r.lead && edges ? distanceToSeeds(edges, w, h) : null;

  // ── Height ─────────────────────────────────────────────────────────────
  const H = new Float32Array(n);
  const cover = new Float32Array(n);
  const spike = spikes ? new Float32Array(n) : null;
  const spikeLen = spikes ? spikes.length * u * Math.min(1.5, p.edge) : 0;
  const pitch = spikes ? Math.max(4, spikes.pitch * u) : 1;
  let hMax = 1e-6;
  let hAbs = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let c = whole ? 1 : mask[i]!;
      let hh = 0;
      if (body && dIn && inside[i]) {
        const d = dIn[i]!;
        switch (body.profile) {
          case "dome": {
            const t = Math.min(1, d / bodyW);
            hh = Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t))) * bodyH;
            break;
          }
          case "pillow": {
            const t = Math.min(1, d / bodyW);
            hh = (1 - (1 - t) ** 3) * bodyH;
            break;
          }
          case "bevel":
            hh = Math.min(1, d / bodyW) * bodyH;
            break;
          case "tube": {
            // A tube of radius bodyW whose outer wall is the shape's edge;
            // past it, the shape is empty.
            const t = (d - bodyW) / bodyW;
            if (t >= 1) c = 0;
            else hh = Math.sqrt(Math.max(0, 1 - t * t)) * bodyH;
            break;
          }
        }
      }
      if (dLead) {
        const d = dLead[i]!;
        if (d < leadW) hh += Math.sqrt(1 - (d / leadW) ** 2) * leadW * 0.9;
      }
      H[i] = hh;
      cover[i] = c;
      if (hh > hMax) hMax = hh;
      if (-hh > hAbs) hAbs = -hh;
    }
  }

  // ── Spikes: a field pulls the fluid into cones on a staggered lattice,
  // and the cones rooted ON the edge stand out of it along its normal —
  // each a round cone tapering to a point, so the light runs down its side
  // as a streak. Only the silhouette bristles: cones seen from straight
  // above are dots, and a carpet of them read as an embossed halftone.
  if (spike && dOut) {
    const sd = (j: number) => (inside[j] ? -(dIn ? dIn[j]! : 0) : dOut[j]!);
    const base = pitch * 0.36;
    const rowH = pitch * 0.866;
    for (let row = 0; row * rowH < h + pitch; row++) {
      const cy = row * rowH;
      for (let k = -1; k * pitch < w + pitch; k++) {
        const cx = (k + (row & 1) * 0.5) * pitch;
        const xi = Math.round(cx);
        const yi = Math.round(cy);
        if (xi < 2 || yi < 2 || xi >= w - 2 || yi >= h - 2) continue;
        const j = yi * w + xi;
        const s0 = sd(j);
        if (Math.abs(s0) > pitch * 0.4) continue;
        let gx = sd(j + 2) - sd(j - 2);
        let gy = sd(j + 2 * w) - sd(j - 2 * w);
        const gl = Math.hypot(gx, gy);
        if (gl < 1e-3) continue;
        gx /= gl;
        gy /= gl;
        // A liquid's cones are never quite one height.
        const len = spikeLen * (0.8 + 0.4 * hash01(row, k));
        const bx = cx - gx * s0;
        const by = cy - gy * s0;
        const x0 = Math.max(0, Math.floor(Math.min(bx - gx * base, bx + gx * len) - base - 1));
        const x1 = Math.min(w - 1, Math.ceil(Math.max(bx - gx * base, bx + gx * len) + base + 1));
        const y0 = Math.max(0, Math.floor(Math.min(by - gy * base, by + gy * len) - base - 1));
        const y1 = Math.min(h - 1, Math.ceil(Math.max(by - gy * base, by + gy * len) + base + 1));
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const dx = x - bx;
            const dy = y - by;
            const along = dx * gx + dy * gy;
            if (along < -base || along > len) continue;
            const half = base * Math.min(1, 1 - along / len);
            const across = Math.abs(dx * gy - dy * gx);
            if (across >= half + 0.5) continue;
            const i = y * w + x;
            const cov = Math.min(1, half - across + 0.5);
            const hh = Math.sqrt(Math.max(0, 1 - (across / Math.max(0.5, half)) ** 2)) * half * 1.4 * cov;
            if (hh > H[i]!) H[i] = hh;
            if (hh > hMax) hMax = hh;
            if (!inside[i] && cov > cover[i]!) {
              cover[i] = cov;
              spike[i] = 1;
            }
          }
        }
      }
    }
  }

  // The distance field is exact but its INSIDE test is per pixel, so a thin
  // diagonal shape's profile steps row by row and a mirror shows every step.
  // A pixel of smoothing is below what the eye calls soft and removes them.
  const Hs = hMax > 1e-3 || hAbs > 1e-3 ? boxBlurClamp(H, w, h, 1, 2) : H;

  // ── Colour ─────────────────────────────────────────────────────────────
  const el = (p.elevation * Math.PI) / 180;
  const lx = p.lightX * Math.cos(el);
  const ly = p.lightY * Math.cos(el);
  const lz = Math.sin(el);
  // The half vector to a viewer straight above.
  let hx = lx;
  let hy = ly;
  let hz = lz + 1;
  const hl = Math.hypot(hx, hy, hz);
  hx /= hl;
  hy /= hl;
  hz /= hl;
  const g = r.gloss && p.sheen > 0.002 ? r.gloss : null;
  const tr = r.transmit;
  const gl = r.glow && p.glow > 0.002 ? r.glow : null;
  const shade = (body?.shade ?? 0.6) * Math.min(2, p.body || 1);
  const pig = r.pigment;
  const inlayC = r.inlay;
  const clear = r.clear ?? 0;
  const lead = r.lead;
  const groundSkin = r.overlay === "ground";
  // The skin's slopes in the face: the gloss block says how much; a matte
  // body (felt, tufting) shows its fibres on its shoulders at half.
  const micro = g ? g.micro : 0.5;
  const sat = r.saturate ?? 0;
  const exposure = tile.gain ?? 1;
  const phase0 = p.lightAngle / 180;
  // The light the shapes throw, gathered as they are lit (premultiplied).
  const haloSrc = gl && gl.halo > 0 ? [new Float32Array(n), new Float32Array(n), new Float32Array(n)] : null;

  for (let y = 0; y < h; y++) {
    const ty = ((tex(y) + oy) % T) * T;
    const yl = y > 0 ? y - 1 : y;
    const yr = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const o = i * 4;
      const m0 = whole ? 1 : mask[i]!;
      const c = cover[i]!;
      const a0 = px[o + 3]!;
      if (m0 < 0.002 && c < 0.002 && !groundSkin) continue;
      const ti = ty + ((tex(x) + ox) % T);

      // What is here: the shape's own colour S, and what is behind it B.
      let sr = px[o]!;
      let sg = px[o + 1]!;
      let sb = px[o + 2]!;
      const br = back ? back[0] : sr;
      const bg = back ? back[1] : sg;
      const bb = back ? back[2] : sb;
      if (back && m0 > 0.02 && m0 < 0.98 && !whole) {
        sr = clamp255((sr - (1 - m0) * br) / m0);
        sg = clamp255((sg - (1 - m0) * bg) / m0);
        sb = clamp255((sb - (1 - m0) * bb) / m0);
      }
      // Ground between the shapes takes the sheet's skin (a wall, a card).
      let gr = back ? br : sr;
      let gg = back ? bg : sg;
      let gb = back ? bb : sb;
      if (groundSkin && c < 0.998) {
        const dk = tile.dark[ti]! / 255;
        const lt = tile.light[ti]! / 255;
        gr = 255 - (255 - gr * dk) * (1 - lt);
        gg = 255 - (255 - gg * dk) * (1 - lt);
        gb = 255 - (255 - gb * dk) * (1 - lt);
      }
      if (c < 0.002) {
        if (back) {
          px[o] = gr;
          px[o + 1] = gg;
          px[o + 2] = gb;
        } else if (groundSkin && a0 > 0) {
          px[o] = gr;
          px[o + 1] = gg;
          px[o + 2] = gb;
        }
        if (!back && m0 > 0.002) px[o + 3] = 0;
        continue;
      }

      // Spikes are the shape's own stuff, grown out of it.
      if (spike && spike[i] && pig) {
        sr = pig.color[0];
        sg = pig.color[1];
        sb = pig.color[2];
      }

      // ── Normal: the body's slope and the skin's ──────────────────────────
      const xl = x > 0 ? x - 1 : x;
      const xr = x < w - 1 ? x + 1 : x;
      let nx = -(Hs[y * w + xr]! - Hs[y * w + xl]!) * 0.5;
      let ny = -(Hs[yr * w + x]! - Hs[yl * w + x]!) * 0.5;
      // The BODY's normal alone sets the colour by angle: a foil's rainbow
      // runs in broad bands over the shape; its flakes only make it sparkle.
      const bl = Math.hypot(nx, ny, 1);
      const bnx = nx / bl;
      const bny = ny / bl;
      if (tile.skinX && tile.skinY) {
        nx -= tile.skinX[ti]! * micro;
        ny -= tile.skinY[ti]! * micro;
      }
      const nl = Math.hypot(nx, ny, 1);
      nx /= nl;
      ny /= nl;
      const nz = 1 / nl;
      const hn = H[i]! / hMax;

      let inLead = false;
      if (lead && dLead && dLead[i]! < leadW) {
        inLead = true;
        sr = lead.tone[0];
        sg = lead.tone[1];
        sb = lead.tone[2];
      } else {
        if (pig) {
          sr += (pig.color[0] - sr) * pig.amount;
          sg += (pig.color[1] - sg) * pig.amount;
          sb += (pig.color[2] - sb) * pig.amount;
        }
      }
      if (exposure !== 1 && !inLead) {
        sr *= exposure;
        sg *= exposure;
        sb *= exposure;
        // Past white the HUE holds and the excess burns toward white, as an
        // overdriven phosphor does — clipping each channel turned orange olive.
        const top = Math.max(sr, sg, sb);
        if (top > 255) {
          const k = 255 / top;
          const burn = (1 - k) * 0.5;
          sr = sr * k + (255 - sr * k) * burn;
          sg = sg * k + (255 - sg * k) * burn;
          sb = sb * k + (255 - sb * k) * burn;
        }
      }
      if (sat > 0 && !inLead) {
        const l = 0.3 * sr + 0.59 * sg + 0.11 * sb;
        sr = l + (sr - l) * (1 + sat);
        sg = l + (sg - l) * (1 + sat);
        sb = l + (sb - l) * (1 + sat);
      }
      const inl = !inLead && inlayC && tile.inlay ? tile.inlay[ti]! : 0;
      if (inl > 0.002 && inlayC) {
        sr += (inlayC[0] - sr) * inl;
        sg += (inlayC[1] - sg) * inl;
        sb += (inlayC[2] - sb) * inl;
      }

      // ── Diffuse: the body lit from the light's side ──────────────────────
      const ndl = nx * lx + ny * ly + nz * lz;
      const t = (ndl - lz) * shade;
      if (tr && !inLead) {
        // ── Transmitted: lit from BEHIND. A face's slopes do not shade it;
        // they bend the light through it into brighter and darker ripples.
        // The came shades the glass along its edge, so each pane glows from
        // its middle; the window is brighter toward the light; every piece
        // of the ground is its own melt; the glass is denser along its
        // streaks (the sheet's albedo).
        let k = 1 + (ndl - lz) * tr.ripple;
        if (dLead) k *= 1 - tr.edge * (1 - smoothstep(leadW, leadW + tr.falloff * u, dLead[i]!));
        k *= 1 + tr.backlight * (((x / w) - 0.5) * p.lightX + ((y / h) - 0.5) * p.lightY) * 2;
        k *= tile.dark[ti]! / 255;
        let pr = 1;
        let pg = 1;
        let pb = 1;
        if (tile.pane && mask[i]! < 0.5) {
          // A melt: denser or clearer, and a filter from amber through
          // clear to a pale green — cathedral glass. Glass only ever holds
          // light back, so a pale pane keeps its headroom and its tint.
          const v = tile.pane[ti]!;
          const amber = Math.max(0, -v);
          const green = Math.max(0, v);
          k *= 1 - tr.vary * 0.35 * Math.abs(v);
          pr = 1 - tr.vary * 0.4 * green;
          pg = 1 - tr.vary * (0.3 * amber + 0.1 * green);
          pb = 1 - tr.vary * (0.9 * amber + 0.6 * green);
        }
        sr *= k * pr;
        sg *= k * pg;
        sb *= k * pb;
      } else if (t < 0) {
        // Lead against the light is a silhouette: its round crown only just shows.
        const k = 1 + Math.max(-0.85, tr ? t * 0.3 : t);
        sr *= k;
        sg *= k;
        sb *= k;
      } else {
        const k = Math.min(0.7, t * (tr ? 0.2 : 0.8));
        sr += (255 - sr) * k;
        sg += (255 - sg) * k;
        sb += (255 - sb) * k;
      }

      if (g && !inLead) {
        const sheen = p.sheen;
        const metal = Math.min(1, g.metal + inl);
        // ── Iridescence: colour by angle, and by the film's thickness ──────
        let fr = 1;
        let fg = 1;
        let fb = 1;
        if (g.iridescence > 0) {
          const ph = (tile.film ? tile.film[ti]! : 0) + bnx * 1.6 + bny * 1.1 + (nx - bnx) * 0.35 + phase0;
          const fc = filmColor(ph);
          const k = Math.min(1, g.iridescence * sheen);
          fr = 1 + (fc[0] * 1.35 - 1) * k;
          fg = 1 + (fc[1] * 1.35 - 1) * k;
          fb = 1 + (fc[2] * 1.35 - 1) * k;
          const lum = (0.3 * sr + 0.59 * sg + 0.11 * sb) / 255;
          const base = 0.55 + 0.45 * lum;
          sr += (255 * base * fr * 0.85 - sr) * k * 0.6;
          sg += (255 * base * fg * 0.85 - sg) * k * 0.6;
          sb += (255 * base * fb * 0.85 - sb) * k * 0.6;
        }
        // ── Mirror: the studio, seen in the face from a viewer above ───────
        if (g.mirror > 0) {
          let vx = -(x / w - 0.5) * 0.7;
          let vy = -(y / h - 0.5) * 0.7;
          let vz = 1;
          const vl = Math.hypot(vx, vy, vz);
          vx /= vl;
          vy /= vl;
          vz /= vl;
          const nv = nx * vx + ny * vy + nz * vz;
          const rx = 2 * nv * nx - vx;
          const ry = 2 * nv * ny - vy;
          const e = studio(rx, ry) * 255;
          // Chrome takes a breath of the shape's colour; ferrofluid none.
          const tr = 1 + ((sr / 255) * 1.6 - 1) * metal * 0.5;
          const tg = 1 + ((sg / 255) * 1.6 - 1) * metal * 0.5;
          const tb = 1 + ((sb / 255) * 1.6 - 1) * metal * 0.5;
          const f0 = g.fresnel;
          const k = Math.min(1, g.mirror * sheen * (f0 === undefined ? 1 : f0 + (1 - f0) * (1 - Math.max(0, nv)) ** 5));
          sr += (e * tr * fr - sr) * k;
          sg += (e * tg * fg - sg) * k;
          sb += (e * tb * fb - sb) * k;
        }
        // ── Highlight ──────────────────────────────────────────────────────
        const ndh = Math.max(0, nx * hx + ny * hy + nz * hz);
        const s = Math.min(2, g.amount * sheen * Math.pow(ndh, g.tightness) * (tile.gloss ? tile.gloss[ti]! : 1) * (1 + inl));
        if (s > 0.002) {
          const cr = (255 + (sr * 1.3 - 255) * metal) * fr;
          const cg = (255 + (sg * 1.3 - 255) * metal) * fg;
          const cb = (255 + (sb * 1.3 - 255) * metal) * fb;
          sr += cr * s;
          sg += cg * s;
          sb += cb * s;
        }
      } else if (inLead && g) {
        const ndh = Math.max(0, nx * hx + ny * hy + nz * hz);
        const s = 0.35 * Math.pow(ndh, 24);
        sr += 255 * s;
        sg += 255 * s;
        sb += 255 * s;
      }

      // ── Clear: what is behind shows through the flat of the face ─────────
      let cov = c;
      if (clear > 0 && !inLead) {
        const k = clear * Math.min(1, nz ** 6);
        if (back) {
          sr += (gr - sr) * k;
          sg += (gg - sg) * k;
          sb += (gb - sb) * k;
        } else cov *= 1 - k * 0.85;
      }

      // ── Glow: a hot core along the crown ─────────────────────────────────
      if (gl && !inLead) {
        const k = Math.min(1, gl.core * p.glow * (body ? hn * hn : 0.5));
        if (k > 0.002) {
          sr += (255 - sr) * k * 0.85;
          sg += (255 - sg) * k * 0.85;
          sb += (255 - sb) * k * 0.85;
        }
      }
      sr = clamp255(sr);
      sg = clamp255(sg);
      sb = clamp255(sb);
      if (haloSrc && !inLead) {
        // The light a pane throws is its own colour, brightest where it is
        // brightest: a phosphor's dark field throws nothing.
        const k = cov * (whole ? ((sr + sg + sb) / 765) ** 2 : 1);
        haloSrc[0]![i] = sr * k;
        haloSrc[1]![i] = sg * k;
        haloSrc[2]![i] = sb * k;
      }

      if (back) {
        px[o] = cov * sr + (1 - cov) * gr;
        px[o + 1] = cov * sg + (1 - cov) * gg;
        px[o + 2] = cov * sb + (1 - cov) * gb;
      } else {
        const a = Math.max(a0 * (m0 > 0.002 ? Math.min(1, cov / m0) : 0), 255 * cov);
        px[o] = sr;
        px[o + 1] = sg;
        px[o + 2] = sb;
        px[o + 3] = Math.min(255, a);
      }
    }
  }

  // ── Halo: the light thrown past the shape, two reaches (a tight bloom and
  // a wide spill), screened over everything ───────────────────────────────
  if (haloSrc && gl) {
    const reach = gl.halo * u;
    const tight = haloSrc.map((f) => coarseBlur(f, w, h, Math.max(1, reach * 0.22)));
    const wide = haloSrc.map((f) => coarseBlur(f, w, h, Math.max(2, reach)));
    const k = gl.amount * p.glow;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const o = i * 4;
        let peak = 0;
        const add: number[] = [0, 0, 0];
        for (let ch = 0; ch < 3; ch++) {
          const v = (sampleCoarse(tight[ch]!, x, y) * 0.9 + sampleCoarse(wide[ch]!, x, y) * 1.1) * k;
          add[ch] = v;
          if (v > peak) peak = v;
        }
        if (peak < 0.5) continue;
        if (back || px[o + 3]! >= 254) {
          for (let ch = 0; ch < 3; ch++) px[o + ch] = 255 - (255 - px[o + ch]!) * (1 - Math.min(1, add[ch]! / 255));
        } else {
          // Past a layer's edge the halo IS the pixel: light with its own alpha.
          const a = px[o + 3]! / 255;
          const ga = Math.min(1, peak / 255);
          const na = a + ga * (1 - a);
          for (let ch = 0; ch < 3; ch++) {
            const lit = Math.min(255, (add[ch]! / Math.max(1e-3, ga)));
            px[o + ch] = (px[o + ch]! * a + lit * ga * (1 - a)) / Math.max(1e-3, na);
          }
          px[o + 3] = na * 255;
        }
      }
    }
  }
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
