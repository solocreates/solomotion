import { PARTICLE_RAND, PARTICLE_STRIDE, TRAIL_STEPS, blackbody, parseHexColor, particleRand, type EmitterSpec, type Frame, type SimParticles, type ViewedParticles } from "@solomotion/core";
import type { ColorResolver } from "./paint-style";

/**
 * PARTICLES ON THE CANVAS — one emitter's particles at an instant, drawn at
 * their layer's place in the stack, in comp space. The simulation (core
 * `flatParticles`) says where each one is; this says what it looks like then:
 * its size, colour and fade along its life, its tumble, a spark's streak.
 *
 * Every per-particle choice reads the SAME seeded randoms the run used
 * (`particleRand`), so a particle keeps its hue and its spin direction from
 * frame to frame, in preview and export alike.
 */

/** How much of its motion a spark streaks behind it, seconds. */
const STREAK_S = 0.035;
const MAX_STREAK = 160;

export interface ParticleLook {
  /** Baked at the instant: a keyed `opacity` is the card's fade (its layer's never reaches it). */
  spec: EmitterSpec;
  /** A layer's picture for `shape: "layer"`, its longest side `size` units; null = draw a dot. */
  sprite: CanvasImageSource | null;
  spriteAspect: number;
}

/** Steps of a colour ramp, hue buckets and alpha levels a particle is drawn at — fine enough to read as smooth, coarse enough to batch. */
const RAMP = 24;
const HUES = 24;
const ALPHA = 32;
/** A spark's width in half units — strokes of one width share a path. */
const WIDTHS = 64;
/** The pass that draws the particles themselves. */
const NO_HALO = { halo: false, w: 1, a: 1 };

/**
 * One emitter's particles, BATCHED: each particle's colour (a step of its
 * ramp, a bucket of its hue), alpha and width are quantised, the particles
 * sorted by that key, and every run of one key drawn as ONE path — one fill
 * for a thousand dots, one stroke for a thousand sparks — with its style
 * string pre-built. Per-particle state changes and string colours were what a
 * frame of particles spent its time on. Shapes that turn on their own
 * (confetti, a layer's picture) and feathered dots stay one draw each.
 */
export function paintParticles(ctx: CanvasRenderingContext2D, frame: Frame, set: SimParticles | ViewedParticles, look: ParticleLook, resolve: ColorResolver): void {
  const { spec } = look;
  if (!set.count || spec.opacity <= 0) return;
  const a = parseHexColor(resolve(spec.color)) ?? { r: 255, g: 255, b: 255, a: 1 };
  const b = parseHexColor(resolve(spec.colorEnd)) ?? a;
  // A blackbody is light: no paint alpha of its own.
  const thermal = spec.colorBy === "temperature";
  const pal = thermal ? thermalPalette(spec.kelvin, spec.hue) : palette(a, b, spec.hue);
  const baseAlpha = thermal ? 1 : a.a;
  // Where along its ramp a particle is: its age, or its speed against `hot`.
  const bySpeed = spec.colorBy !== "life", hot = Math.max(1, spec.hot);
  const d = set.data;
  // Seen through a lens or beamed (core `viewParticles`): per row, × alpha and × heat.
  const seen = "gain" in set ? set : null;
  const soft = spec.shape === "dot" ? spec.soft : 0, glow = spec.glow;
  const batched = spec.shape === "spark" || (spec.shape === "dot" && soft <= 0.01) || (spec.shape === "layer" && !look.sprite);
  const n = set.count;
  // Per particle: its sort key (style, alpha, width) × 2¹⁶ + its slot, and its size now.
  const keys = new Float64Array(n);
  const sizes = new Float32Array(n);
  let m = 0;
  for (let k = 0; k < n; k++) {
    const o = k * PARTICLE_STRIDE;
    const i = d[o]!, age = d[o + 5]!, life = d[o + 6]!, family = d[o + 7]!;
    const u = Math.min(1, age / Math.max(1e-6, life));
    // Fades late, the way an ember does: bright most of its life.
    const alpha = spec.opacity * Math.max(0, 1 - spec.fade * u * u) * baseAlpha * (seen ? seen.gain[k]! : 1);
    const al = Math.min(ALPHA - 1, Math.round(alpha * (ALPHA - 1)));
    if (al <= 0) continue;
    const vary = Math.max(0.2, 1 + (particleRand(spec.seed, i, PARTICLE_RAND.size) * 2 - 1) * spec.variance * 0.5);
    const size = spec.size * vary * (1 + (spec.grow - 1) * u);
    if (size <= 0.05) continue;
    // A sub-emitter's hue wanders per parent: a firework shell bursts in one colour.
    const hb = pal.hued ? Math.min(HUES - 1, Math.floor(particleRand(spec.seed, family, PARTICLE_RAND.hue) * HUES)) : 0;
    const along = Math.min(1, (bySpeed ? (seen ? seen.speed[k]! : Math.hypot(d[o + 3]!, d[o + 4]!)) / hot : u) * (seen ? seen.heat[k]! : 1));
    const ci = (pal.ramped ? Math.min(RAMP - 1, Math.round(along * (RAMP - 1))) : 0) + hb * RAMP;
    const wl = spec.shape === "spark" ? Math.min(WIDTHS - 1, Math.max(1, Math.round(size * 2))) : 0;
    keys[m] = ((ci * ALPHA + al) * WIDTHS + wl) * 65536 + k;
    sizes[k] = size;
    m++;
  }
  if (!m) return;
  const order = keys.subarray(0, m);
  if (batched) order.sort();
  const cx = frame.width / 2, cy = frame.height / 2;
  ctx.save();
  ctx.translate(cx, cy);
  // Glow adds light: where sparks cross they burn toward white.
  if (glow > 0) ctx.globalCompositeOperation = "lighter";
  if (spec.shape === "spark") ctx.lineCap = "round";
  const keyOf = (q: number) => Math.floor(order[q]! / 65536);
  const slotOf = (q: number) => order[q]! % 65536;
  if (batched) {
    // The halo first, then the particles themselves. A spark's halo is two
    // strokes — wide and faint under narrower and brighter — so its light
    // falls off instead of ending in an outline.
    const passes = glow <= 0 ? [NO_HALO] : spec.shape === "spark" ? [{ halo: true, w: 1 + 6 * glow, a: 0.12 * glow }, { halo: true, w: 1 + 2.5 * glow, a: 0.3 * glow }, NO_HALO] : [{ halo: true, w: 1, a: 0.45 * glow }, NO_HALO];
    for (const { halo: pass, w: wide, a: faint } of passes) {
      for (let q = 0; q < m; ) {
        const key = keyOf(q);
        const wl = key % WIDTHS, al = Math.floor(key / WIDTHS) % ALPHA, ci = Math.floor(key / (WIDTHS * ALPHA));
        const alpha = al / (ALPHA - 1);
        ctx.globalAlpha = Math.min(1, alpha * faint);
        ctx.fillStyle = ctx.strokeStyle = pal.styles[ci]!;
        ctx.beginPath();
        if (spec.shape === "spark") {
          ctx.lineWidth = (wl / 2) * wide;
          for (; q < m && keyOf(q) === key; q++) {
            const o = slotOf(q) * PARTICLE_STRIDE;
            const x = d[o + 1]!, y = d[o + 2]!, vx = d[o + 3]!, vy = d[o + 4]!;
            if (seen) {
              // Seen through a tilt and a lens: the streak is the curve its light drew (middle as the control point).
              const t = slotOf(q) * TRAIL_STEPS * 2, tr = seen.trail;
              const tx = tr[t + (TRAIL_STEPS - 1) * 2]!, ty = tr[t + (TRAIL_STEPS - 1) * 2 + 1]!;
              ctx.moveTo(tx === x && ty === y ? x - 0.01 : tx, ty);
              for (let j = TRAIL_STEPS - 2; j >= 0; j--) ctx.lineTo(tr[t + j * 2]!, tr[t + j * 2 + 1]!);
              ctx.lineTo(x, y);
              continue;
            }
            // The streak IS its motion blur; a slow one is a round dot (a round cap on a point).
            const sp = Math.hypot(vx, vy);
            const len = Math.min(MAX_STREAK, sp * STREAK_S);
            ctx.moveTo(len > 0.01 ? x - (vx / sp) * len : x - 0.01, y - (len > 0.01 ? (vy / sp) * len : 0));
            ctx.lineTo(x, y);
          }
          ctx.stroke();
        } else if (pass) {
          // A dot's halo is a feathered light around it, stamped.
          const at = puffs(pal, 1);
          const [sx, sy] = at.cell(ci);
          for (; q < m && keyOf(q) === key; q++) {
            const k = slotOf(q), o = k * PARTICLE_STRIDE;
            const h = sizes[k]! * (1.5 + 3 * glow);
            ctx.drawImage(at.canvas, sx, sy, PUFF, PUFF, d[o + 1]! - h / 2, d[o + 2]! - h / 2, h, h);
          }
        } else {
          for (; q < m && keyOf(q) === key; q++) {
            const k = slotOf(q), o = k * PARTICLE_STRIDE;
            const x = d[o + 1]!, y = d[o + 2]!, r = sizes[k]! / 2;
            ctx.moveTo(x + r, y);
            ctx.arc(x, y, r, 0, Math.PI * 2);
          }
          ctx.fill();
        }
      }
    }
    ctx.restore();
    return;
  }
  // One draw each: feathered dots, tumbling confetti, a layer's picture.
  const halo = glow > 0 ? puffs(pal, 1) : null, feather = spec.shape === "dot" ? puffs(pal, soft) : null;
  for (let q = 0; q < m; q++) {
    const k = slotOf(q), key = keyOf(q);
    const al = Math.floor(key / WIDTHS) % ALPHA, ci = Math.floor(key / (WIDTHS * ALPHA));
    const o = k * PARTICLE_STRIDE;
    const i = d[o]!, x = d[o + 1]!, y = d[o + 2]!, age = d[o + 5]!;
    const size = sizes[k]!, alpha = al / (ALPHA - 1);
    if (halo) {
      ctx.globalAlpha = Math.min(1, alpha * glow * 0.45);
      const h = size * (1.5 + 3 * glow);
      const [sx, sy] = halo.cell(ci);
      ctx.drawImage(halo.canvas, sx, sy, PUFF, PUFF, x - h / 2, y - h / 2, h, h);
    }
    ctx.globalAlpha = alpha;
    const turn = spec.spin > 0 ? (((particleRand(spec.seed, i, PARTICLE_RAND.spin) < 0.5 ? -1 : 1) * spec.spin * age + particleRand(spec.seed, i, PARTICLE_RAND.aim) * 360) * Math.PI) / 180 : 0;
    if (feather) {
      // A feathered dot is drawn a little wider, so softening never shrinks it.
      const w = size * (1 + soft * 0.6);
      const [sx, sy] = feather.cell(ci);
      ctx.drawImage(feather.canvas, sx, sy, PUFF, PUFF, x - w / 2, y - w / 2, w, w);
      continue;
    }
    ctx.save();
    ctx.translate(x, y);
    if (turn) ctx.rotate(turn);
    if (spec.shape === "square") {
      // Confetti: a card tumbling in 3D reads as one that narrows and widens.
      const flip = spec.spin > 0 ? Math.abs(Math.cos(turn * 0.7)) * 0.8 + 0.2 : 1;
      ctx.fillStyle = pal.styles[ci]!;
      ctx.fillRect(-size / 2, (-size / 2) * flip, size, size * flip);
    } else if (look.sprite) {
      const w = look.spriteAspect >= 1 ? size : size * look.spriteAspect;
      const h = look.spriteAspect >= 1 ? size / look.spriteAspect : size;
      ctx.drawImage(look.sprite, -w / 2, -h / 2, w, h);
    }
    ctx.restore();
  }
  ctx.restore();
}

interface Palette {
  /** `rgb()` per colour index: ramp step + RAMP × hue bucket. */
  styles: string[];
  rgb: Float32Array;
  ramped: boolean;
  hued: boolean;
}

const palettes = new Map<string, Palette>();

/** An emitter's colours, built once: its ramp from start to end colour, turned through its hue range — strings ready to assign. */
function palette(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }, hue: number): Palette {
  const ramped = a.r !== b.r || a.g !== b.g || a.b !== b.b;
  return rampPalette(`${a.r},${a.g},${a.b}|${b.r},${b.g},${b.b}|${hue}`, ramped, hue, (u) => [a.r + (b.r - a.r) * u, a.g + (b.g - a.g) * u, a.b + (b.b - a.b) * u]);
}

/**
 * A blackbody ramp: step u of the ramp is a particle at u × `hot`, glowing at
 * `kelvin` × u^1.5 (a disk's temperature runs as r^−¾ and its speed as r^−½)
 * through core's ONE `blackbody`. Brightness rises with it — far gentler than
 * T⁴, which would leave every ember black — so the slow rim is a dim red and
 * the fast inner edge burns white.
 */
function thermalPalette(kelvin: number, hue: number): Palette {
  const k = Math.round(kelvin / 50) * 50;
  return rampPalette(`bb|${k}|${hue}`, true, hue, (u) => {
    const c = blackbody(Math.max(800, k * Math.pow(u, 1.5)));
    const lum = 255 * (0.28 + 0.72 * u);
    return [c.r * lum, c.g * lum, c.b * lum];
  });
}

function rampPalette(key: string, ramped: boolean, hue: number, at: (u: number) => [number, number, number]): Palette {
  const hit = palettes.get(key);
  if (hit) return hit;
  const hued = hue > 0;
  const steps = ramped ? RAMP : 1, buckets = hued ? HUES : 1;
  const styles: string[] = new Array(RAMP * buckets);
  const rgb = new Float32Array(RAMP * buckets * 3);
  for (let h = 0; h < buckets; h++) {
    for (let s = 0; s < steps; s++) {
      const u = steps > 1 ? s / (steps - 1) : 0;
      let [r, g, bl] = at(u);
      if (hued) [r, g, bl] = turnHue(r, g, bl, (((h + 0.5) / HUES) * 2 - 1) * hue);
      const ci = s + h * RAMP;
      styles[ci] = `rgb(${r | 0},${g | 0},${bl | 0})`;
      rgb.set([r, g, bl], ci * 3);
    }
  }
  const out = { styles, rgb, ramped, hued };
  if (palettes.size > 64) palettes.clear();
  palettes.set(key, out);
  return out;
}

/** A puff's cell in its atlas, px. */
const PUFF = 48;

interface PuffAtlas {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /** Where colour index `ci`'s puff sits — drawn on first ask. */
  cell: (ci: number) => [number, number];
}

const atlases = new WeakMap<Palette, Map<number, PuffAtlas>>();

/**
 * Round dots in every colour of a palette whose edge feathers by `soft`
 * (1 = no edge at all), on ONE canvas: a row per hue bucket, a cell per ramp
 * step, each drawn the first time it is asked for. Stamped per particle from
 * the same picture, so the GPU draws a cloud as one batch — a gradient per
 * particle, or a canvas per colour, is what made soft particles slow.
 */
function puffs(pal: Palette, soft: number): PuffAtlas {
  const S = Math.round(soft * 10) / 10;
  let bySoft = atlases.get(pal);
  if (!bySoft) atlases.set(pal, (bySoft = new Map()));
  const hit = bySoft.get(S);
  if (hit) return hit;
  const cols = RAMP, rows = pal.hued ? HUES : 1;
  const w = cols * PUFF, h = rows * PUFF;
  const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const x = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  const drawn = new Uint8Array(cols * rows);
  const core = Math.max(0, 1 - S) * 0.98;
  const atlas: PuffAtlas = {
    canvas,
    cell: (ci) => {
      const cx = (ci % RAMP) * PUFF, cy = Math.floor(ci / RAMP) * PUFF;
      if (!drawn[ci]) {
        drawn[ci] = 1;
        const rgb = `${pal.rgb[ci * 3]! | 0},${pal.rgb[ci * 3 + 1]! | 0},${pal.rgb[ci * 3 + 2]! | 0}`;
        const grad = x.createRadialGradient(cx + PUFF / 2, cy + PUFF / 2, 0, cx + PUFF / 2, cy + PUFF / 2, PUFF / 2);
        grad.addColorStop(0, `rgba(${rgb},1)`);
        grad.addColorStop(core, `rgba(${rgb},1)`);
        // An eased fall-off reads as a puff; a linear one reads as a cone.
        for (const k of [0.25, 0.5, 0.75]) grad.addColorStop(core + (1 - core) * k, `rgba(${rgb},${((1 - k) * (1 - k)).toFixed(3)})`);
        grad.addColorStop(1, `rgba(${rgb},0)`);
        x.fillStyle = grad;
        x.fillRect(cx, cy, PUFF, PUFF);
      }
      return [cx, cy];
    },
  };
  bySoft.set(S, atlas);
  return atlas;
}

/** An RGB turned `deg` round the colour wheel (YIQ rotation: no HSL round trip per particle). */
function turnHue(r: number, g: number, b: number, deg: number): [number, number, number] {
  const rad = (deg * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad);
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const i = 0.596 * r - 0.274 * g - 0.322 * b;
  const q = 0.211 * r - 0.523 * g + 0.312 * b;
  const i2 = i * c - q * s, q2 = i * s + q * c;
  const clamp = (v: number) => Math.max(0, Math.min(255, v));
  return [clamp(y + 0.956 * i2 + 0.621 * q2), clamp(y - 0.272 * i2 - 0.647 * q2), clamp(y - 1.106 * i2 + 1.703 * q2)];
}
