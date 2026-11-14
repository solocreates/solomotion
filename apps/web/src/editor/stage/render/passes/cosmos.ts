"use client";

import { blackbody } from "@solomotion/core";
import { parseColor } from "@/lib/color";
import { acquireGl, drawRegion } from "../gl-substrate";
import { nextOutput, releaseTemp } from "./buffers";
import { readPixels, remap, sampleBilinear, type WarpField } from "./resample";
import type { LfxPass, PassFn } from "./types";

/**
 * SPACE — the cosmos family's engines (core `schema/effects/cosmos.ts` has the
 * model). Every card has a fragment shader on the ONE shared WebGL2 context
 * and a CPU path for a machine without one (capabilities, never `ctx.filter`).
 *
 * Coordinates: passes work in the buffer's device px, y down, centred on the
 * layer (effect bleed pads the region symmetrically). The substrate's
 * viewport is y-up, so every shader turns `vUv` into image px first.
 */

type Pass<K extends LfxPass["kind"]> = Extract<LfxPass, { kind: K }>;

const rgb01 = (hex: string): [number, number, number] => {
  const c = parseColor(hex) ?? { r: 255, g: 255, b: 255, a: 1 };
  return [c.r / 255, c.g / 255, c.b / 255];
};

/**
 * Run one fragment shader over a `w × h` buffer and hand back a canvas from
 * the pass ring — or null when there is no GPU (the caller takes its CPU path).
 * `inputs` are uploaded PREMULTIPLIED: these shaders move and add light, and a
 * straight-alpha round trip through eight bits shifts the hue of faint texels.
 */
function shade(key: string, frag: string, w: number, h: number, inputs: CanvasImageSource[], set: (u: (name: string) => WebGLUniformLocation | null, gl: WebGL2RenderingContext) => void): HTMLCanvasElement | null {
  const g = acquireGl();
  if (!g) return null;
  const prog = g.program(key, frag);
  if (!prog) return null;
  for (let i = 0; i < inputs.length; i++) if (!g.upload(i, inputs[i]!, true)) return null;
  const region = g.output(w, h);
  const u = prog.use();
  for (let i = 0; i < inputs.length; i++) g.gl.uniform1i(u(`uIn${i}`), i);
  g.gl.uniform2f(u("uSize"), w, h);
  set(u, g.gl);
  g.drawTo(null);
  const out = nextOutput(w, h);
  drawRegion(out.ctx, region, 0, 0, w, h);
  return out.canvas;
}

// ── Gravitational lens ───────────────────────────────────────────────────────

/** A lens's numbers in buffer px: the bend's amplitude θE², its core, how far it reaches. */
function lensGeometry(p: Pass<"lens">) {
  const e2 = p.strength * p.radius * p.radius;
  // A point mass's deflection runs to infinity at the centre; a tiny core keeps
  // the innermost image finite where no shadow hides it.
  const core2 = (p.radius * 0.06) ** 2;
  const reach = p.radius * p.reach;
  // The ring sits just outside the black, centred half its width out.
  const ringAt = p.shadow + p.ringWidth * 0.5;
  return { e2, core2, reach, ringAt };
}

/**
 * Where the backdrop is seen from at distance `r`: pushed out by α(r) =
 * θE²·r/(r² + core²), eased to nothing between 0.4 and 1 reach so the edge of
 * the bend has no seam. Past the Einstein radius α > r and the sample comes
 * from the far side: the secondary, flipped image.
 */
function lensBend(e2: number, core2: number, reach: number, r: number): number {
  if (r >= reach) return 0;
  const t = Math.min(1, Math.max(0, (r - 0.4 * reach) / (0.6 * reach)));
  return ((e2 * r) / (r * r + core2)) * (1 - t * t * (3 - 2 * t));
}

const LENS_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uIn0;
uniform vec2 uSize;
uniform vec2 uC;
uniform float uE2, uCore2, uReach, uShadow, uRingAt, uRing, uRingW, uGlow;
uniform vec3 uRingColor;
void main() {
  vec2 p = vec2(vUv.x, 1.0 - vUv.y) * uSize;
  vec2 d = p - uC;
  float r = length(d);
  float halo = uShadow > 0.0 ? exp(-max(0.0, r - uShadow) / max(1.0, uShadow * 0.32)) * uGlow : 0.0;
  if (r >= uReach && halo < 0.002) { o = vec4(0.0); return; }
  vec4 col = vec4(0.0);
  if (r < uReach) {
    float t = clamp((r - 0.4 * uReach) / (0.6 * uReach), 0.0, 1.0);
    float bend = uE2 * r / (r * r + uCore2) * (1.0 - t * t * (3.0 - 2.0 * t));
    vec2 dir = r > 1e-4 ? d / r : vec2(1.0, 0.0);
    vec2 s = uC + dir * (r - bend);
    vec2 uv = vec2(s.x / uSize.x, 1.0 - s.y / uSize.y);
    float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    col = texture(uIn0, uv) * inside;
  }
  if (uShadow > 0.0) {
    // The photon ring: a thin band at the shadow's edge, and the lensed light
    // there concentrated (images near the critical curve are magnified hardest).
    float x = (r - uRingAt) / uRingW;
    float band = exp(-x * x) * uRing;
    vec3 light = uRingColor * (band + halo * 0.55);
    col.rgb = col.rgb * (1.0 + band * 1.5) + light;
    col.a = clamp(max(col.a, max(band, halo * 0.55)), 0.0, 1.0);
    col.rgb = min(col.rgb, vec3(col.a));
    float hole = 1.0 - smoothstep(uShadow - 0.75, uShadow + 0.75, r);
    col = mix(col, vec4(0.0, 0.0, 0.0, 1.0), hole);
  }
  o = col;
}`;

function lensCpu(p: Pass<"lens">, backdrop: CanvasImageSource, w: number, h: number): CanvasImageSource {
  const { e2, core2, reach, ringAt } = lensGeometry(p);
  const cx = w / 2, cy = h / 2;
  const field: WarpField = (x, y, out) => {
    const dx = x - cx, dy = y - cy;
    const r = Math.hypot(dx, dy);
    const bend = lensBend(e2, core2, reach, r);
    const k = r > 1e-4 ? (r - bend) / r : 1;
    out[0] = cx + dx * k;
    out[1] = cy + dy * k;
  };
  const warped = remap(backdrop, w, h, field, { x0: cx - reach - 2, y0: cy - reach - 2, x1: cx + reach + 2, y1: cy + reach + 2 });
  const out = nextOutput(w, h);
  const ctx = out.ctx;
  // Only the bent disc: outside it the backdrop beneath shows as it is.
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, reach, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(warped, 0, 0);
  ctx.restore();
  if (p.shadow > 0) {
    const [r, g, b] = rgb01(p.ringColor).map((v) => Math.round(v * 255));
    const rgba = (a: number) => `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
    ctx.globalCompositeOperation = "lighter";
    if (p.glow > 0) {
      const fall = Math.max(1, p.shadow * 0.32);
      const halo = ctx.createRadialGradient(cx, cy, p.shadow, cx, cy, p.shadow + fall * 4);
      for (const k of [0, 0.25, 0.5, 0.75, 1]) halo.addColorStop(k, rgba(p.glow * 0.55 * Math.exp(-k * 4)));
      ctx.fillStyle = halo;
      ctx.fillRect(cx - p.shadow - fall * 4, cy - p.shadow - fall * 4, (p.shadow + fall * 4) * 2, (p.shadow + fall * 4) * 2);
    }
    if (p.ring > 0) {
      const lo = Math.max(0, ringAt - p.ringWidth * 2.5), hi = ringAt + p.ringWidth * 2.5;
      const band = ctx.createRadialGradient(cx, cy, lo, cx, cy, hi);
      for (let k = 0; k <= 8; k++) {
        const x = (lo + ((hi - lo) * k) / 8 - ringAt) / p.ringWidth;
        band.addColorStop(k / 8, rgba(p.ring * Math.exp(-x * x)));
      }
      ctx.fillStyle = band;
      ctx.fillRect(cx - hi, cy - hi, hi * 2, hi * 2);
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.arc(cx, cy, p.shadow, 0, Math.PI * 2);
    ctx.fill();
  }
  return out.canvas;
}

/**
 * The lens REPLACES its layer's picture: the carrier is a placement, and what
 * it shows is the backdrop bent round its centre. With nothing behind it
 * (a first frame before the backdrop lands) it is still the shadow and ring.
 */
export const lens: PassFn<"lens"> = (p, _src, w, h, env) => {
  const { e2, core2, reach, ringAt } = lensGeometry(p);
  if (reach <= 0 && p.shadow <= 0) return nextOutput(w, h).canvas;
  const back = env.backdrop ?? nextOutput(w, h).canvas;
  const [r, g, b] = rgb01(p.ringColor);
  const gpu = shade("cosmos-lens", LENS_FRAG, w, h, [back], (u, gl) => {
    gl.uniform2f(u("uC"), w / 2, h / 2);
    gl.uniform1f(u("uE2"), e2);
    gl.uniform1f(u("uCore2"), core2);
    gl.uniform1f(u("uReach"), reach);
    gl.uniform1f(u("uShadow"), p.shadow);
    gl.uniform1f(u("uRingAt"), ringAt);
    gl.uniform1f(u("uRing"), p.ring);
    gl.uniform1f(u("uRingW"), p.ringWidth);
    gl.uniform1f(u("uGlow"), p.glow);
    gl.uniform3f(u("uRingColor"), r, g, b);
  });
  return gpu ?? lensCpu(p, back, w, h);
};

// ── Noise, twice: GLSL and JS, the same bits ─────────────────────────────────
// One integer hash and one Perlin-gradient noise, written as GLSL for the GPU
// and as JS for the CPU path, bit for bit (uint maths ↔ Math.imul / >>>), so a
// machine without WebGL2 draws the same nebula and the same boiling star, only
// slower — never a different picture.

const NOISE_GLSL = `
uint hash3(ivec3 c, uint seed) {
  uint h = (uint(c.x) * 0x8da6b343u) ^ (uint(c.y) * 0xd8163841u) ^ (uint(c.z) * 0xcb1ab31fu) ^ (seed * 0x165667b1u);
  h = (h ^ (h >> 15u)) * 0x2c1b3c6du;
  h = (h ^ (h >> 12u)) * 0x297a2d39u;
  return h ^ (h >> 15u);
}
float grad3(uint h, vec3 f) {
  uint k = h & 15u;
  float u = k < 8u ? f.x : f.y;
  float v = k < 4u ? f.y : ((k == 12u || k == 14u) ? f.x : f.z);
  return ((k & 1u) == 0u ? u : -u) + ((k & 2u) == 0u ? v : -v);
}
float gnoise(vec3 p, uint seed) {
  vec3 fl = floor(p);
  ivec3 i = ivec3(fl);
  vec3 f = p - fl;
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = grad3(hash3(i, seed), f);
  float b = grad3(hash3(i + ivec3(1, 0, 0), seed), f - vec3(1.0, 0.0, 0.0));
  float c = grad3(hash3(i + ivec3(0, 1, 0), seed), f - vec3(0.0, 1.0, 0.0));
  float d = grad3(hash3(i + ivec3(1, 1, 0), seed), f - vec3(1.0, 1.0, 0.0));
  float e = grad3(hash3(i + ivec3(0, 0, 1), seed), f - vec3(0.0, 0.0, 1.0));
  float g = grad3(hash3(i + ivec3(1, 0, 1), seed), f - vec3(1.0, 0.0, 1.0));
  float h = grad3(hash3(i + ivec3(0, 1, 1), seed), f - vec3(0.0, 1.0, 1.0));
  float k = grad3(hash3(i + ivec3(1, 1, 1), seed), f - vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);
}
float fbm(vec3 p, int oct, uint seed) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int o = 0; o < 8; o++) {
    if (o >= oct) break;
    s += a * gnoise(p, seed + uint(o));
    n += a;
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s / n;
}
float rnd(ivec3 c, uint seed) { return float(hash3(c, seed) >> 8u) / 16777216.0; }
`;

function hash3(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(z, 0xcb1ab31f) ^ Math.imul(seed, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

function grad3(h: number, x: number, y: number, z: number): number {
  const k = h & 15;
  const u = k < 8 ? x : y;
  const v = k < 4 ? y : k === 12 || k === 14 ? x : z;
  return (k & 1 ? -u : u) + (k & 2 ? -v : v);
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function gnoise(px: number, py: number, pz: number, seed: number): number {
  const fx = Math.floor(px), fy = Math.floor(py), fz = Math.floor(pz);
  const x = px - fx, y = py - fy, z = pz - fz;
  const u = fade(x), v = fade(y), w = fade(z);
  const g = (dx: number, dy: number, dz: number) => grad3(hash3(fx + dx, fy + dy, fz + dz, seed), x - dx, y - dy, z - dz);
  return lerp(lerp(lerp(g(0, 0, 0), g(1, 0, 0), u), lerp(g(0, 1, 0), g(1, 1, 0), u), v), lerp(lerp(g(0, 0, 1), g(1, 0, 1), u), lerp(g(0, 1, 1), g(1, 1, 1), u), v), w);
}

function fbm(x: number, y: number, z: number, oct: number, seed: number): number {
  let s = 0, a = 0.5, n = 0;
  for (let o = 0; o < oct; o++) {
    s += a * gnoise(x, y, z, (seed + o) >>> 0);
    n += a;
    x = x * 2.03 + 1.7;
    y = y * 2.03 + 9.2;
    z = z * 2.03 + 3.1;
    a *= 0.5;
  }
  return s / n;
}

const rnd = (x: number, y: number, z: number, seed: number) => (hash3(x, y, z, seed) >>> 8) / 16777216;
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Draw a small CPU picture back up to the buffer, smoothly: these looks are soft, a quarter of the pixels is invisible. */
function upscale(img: ImageData, w: number, h: number): HTMLCanvasElement {
  const tmp = document.createElement("canvas");
  tmp.width = img.width;
  tmp.height = img.height;
  tmp.getContext("2d")!.putImageData(img, 0, 0);
  const out = nextOutput(w, h);
  out.ctx.imageSmoothingEnabled = true;
  out.ctx.imageSmoothingQuality = "high";
  out.ctx.drawImage(tmp, 0, 0, w, h);
  return out.canvas;
}

/** The layer's own pixels at a CPU picture's size — what a painted sky is masked by and added to. */
function readScaled(src: CanvasImageSource, w: number, h: number): ImageData {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const x = c.getContext("2d", { willReadFrequently: true })!;
  x.drawImage(src, 0, 0, w, h);
  return x.getImageData(0, 0, w, h);
}

// ── Nebula ───────────────────────────────────────────────────────────────────

/**
 * Domain-warped fBm (Quilez): q = fbm(p), r = fbm(p + 4·warp·q), f = fbm(p +
 * 4·warp·r) — the folding is what makes filaments instead of blobs. The ramp
 * runs edge → body → core by density and by how far the warp travelled (the
 * hot cores sit where the gas folds hardest); dust is a ridged fBm riding the
 * same warp, absorbing the glow AND whatever the layer already shows behind.
 */
const NEBULA_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uIn0;
uniform vec2 uSize, uC, uDrift;
uniform float uScale, uWarp, uCoverage, uBright, uDust, uEvolve;
uniform int uOct;
uniform uint uSeed;
uniform vec3 uA, uB, uCc;
${NOISE_GLSL}
void main() {
  vec4 src = texture(uIn0, vUv);
  if (src.a <= 0.0) { o = vec4(0.0); return; }
  vec2 px = vec2(vUv.x, 1.0 - vUv.y) * uSize;
  vec3 P = vec3((px - uC - uDrift) / uScale, uEvolve);
  // Where the gas IS: big soft masses from a few octaves at half the scale.
  float m = fbm(P * 0.55 + vec3(11.0, 3.0, 0.0), 3, uSeed + 57u) * 0.5 + 0.5;
  float lo = 0.66 - 0.4 * uCoverage;
  float mass = smoothstep(lo, lo + 0.22, m);
  // What it looks like inside: warped twice, gently — wisps, not marble.
  vec2 q = vec2(fbm(P, uOct, uSeed), fbm(P + vec3(5.2, 1.3, 0.0), uOct, uSeed));
  vec2 r = vec2(fbm(P + vec3(1.6 * uWarp * q, 0.0) + vec3(1.7, 9.2, 0.0), uOct, uSeed), fbm(P + vec3(1.6 * uWarp * q, 0.0) + vec3(8.3, 2.8, 0.0), uOct, uSeed));
  float f = fbm(P + vec3(1.6 * uWarp * r, 0.0), uOct, uSeed) * 0.5 + 0.5;
  float wisps = smoothstep(0.32, 0.82, f);
  float e = mass * (0.3 + 0.95 * wisps);
  float haze = pow(smoothstep(lo - 0.25, lo + 0.45, m), 2.0) * 0.18;
  vec3 col = mix(uA, uB, smoothstep(0.05, 0.6, e));
  col = mix(col, uCc, smoothstep(0.55, 1.15, e) * clamp(0.4 + length(r) * 1.2, 0.0, 1.0));
  vec3 light = (col * pow(e, 1.5) * 1.15 + uA * haze) * uBright;
  float ridge = 1.0 - abs(fbm(P * 1.7 + vec3(3.3, 7.7, 0.0) + vec3(0.9 * r, 0.0), max(uOct - 1, 1), uSeed + 31u));
  float lanes = smoothstep(0.7, 0.96, ridge) * uDust * smoothstep(0.08, 0.6, mass);
  vec3 rgb = src.rgb * (1.0 - lanes * 0.85) + light * (1.0 - lanes * 0.9) * src.a;
  o = vec4(min(rgb, vec3(src.a)), src.a);
}`;

function nebulaCpu(p: Pass<"nebula">, src: CanvasImageSource, w: number, h: number): CanvasImageSource {
  const k = Math.min(1, 320 / Math.max(w, h));
  const W = Math.max(1, Math.round(w * k)), H = Math.max(1, Math.round(h * k));
  const img = readScaled(src, W, H);
  const d = img.data;
  const [A, B, C] = [rgb01(p.colorA), rgb01(p.colorB), rgb01(p.colorC)];
  // The CPU keeps four octaves: the finest two are below its quarter-size grid anyway.
  const oct = Math.min(4, p.detail), seed = p.seed >>> 0;
  const lo = 0.66 - 0.4 * p.coverage;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const a = d[i + 3]! / 255;
      if (a <= 0) continue;
      const Px = ((x + 0.5) / k - w / 2 - p.driftX) / p.scale, Py = ((y + 0.5) / k - h / 2 - p.driftY) / p.scale, Pz = p.evolve;
      const m = fbm(Px * 0.55 + 11, Py * 0.55 + 3, Pz * 0.55, 3, (seed + 57) >>> 0) * 0.5 + 0.5;
      const mass = smoothstep(lo, lo + 0.22, m);
      const qx = fbm(Px, Py, Pz, oct, seed), qy = fbm(Px + 5.2, Py + 1.3, Pz, oct, seed);
      const wx = 1.6 * p.warp * qx, wy = 1.6 * p.warp * qy;
      const rx = fbm(Px + wx + 1.7, Py + wy + 9.2, Pz, oct, seed), ry = fbm(Px + wx + 8.3, Py + wy + 2.8, Pz, oct, seed);
      const f = fbm(Px + 1.6 * p.warp * rx, Py + 1.6 * p.warp * ry, Pz, oct, seed) * 0.5 + 0.5;
      const e = mass * (0.3 + 0.95 * smoothstep(0.32, 0.82, f));
      const haze = Math.pow(smoothstep(lo - 0.25, lo + 0.45, m), 2) * 0.18;
      const t1 = smoothstep(0.05, 0.6, e), t2 = smoothstep(0.55, 1.15, e) * Math.min(1, 0.4 + Math.hypot(rx, ry) * 1.2);
      const ridge = 1 - Math.abs(fbm(Px * 1.7 + 3.3 + 0.9 * rx, Py * 1.7 + 7.7 + 0.9 * ry, Pz * 1.7, Math.max(oct - 1, 1), (seed + 31) >>> 0));
      const lanes = smoothstep(0.7, 0.96, ridge) * p.dust * smoothstep(0.08, 0.6, mass);
      const glow = Math.pow(e, 1.5) * 1.15 * p.brightness, hz = haze * p.brightness;
      for (let c = 0; c < 3; c++) {
        const col = lerp(lerp(A[c]!, B[c]!, t1), C[c]!, t2);
        const light = (col * glow + A[c]! * hz) * (1 - lanes * 0.9);
        const base = (d[i + c]! / 255) * a;
        d[i + c] = Math.round((Math.min(a, base * (1 - lanes * 0.85) + light * a) / a) * 255);
      }
    }
  }
  return upscale(img, w, h);
}

export const nebula: PassFn<"nebula"> = (p, src, w, h) => {
  const gpu = shade("cosmos-nebula", NEBULA_FRAG, w, h, [src], (u, gl) => {
    gl.uniform2f(u("uC"), w / 2, h / 2);
    gl.uniform2f(u("uDrift"), p.driftX, p.driftY);
    gl.uniform1f(u("uScale"), Math.max(1, p.scale));
    gl.uniform1f(u("uWarp"), p.warp);
    gl.uniform1f(u("uCoverage"), p.coverage);
    gl.uniform1f(u("uBright"), p.brightness);
    gl.uniform1f(u("uDust"), p.dust);
    gl.uniform1f(u("uEvolve"), p.evolve);
    gl.uniform1i(u("uOct"), Math.max(1, Math.min(8, Math.round(p.detail))));
    gl.uniform1ui(u("uSeed"), p.seed >>> 0);
    gl.uniform3f(u("uA"), ...rgb01(p.colorA));
    gl.uniform3f(u("uB"), ...rgb01(p.colorB));
    gl.uniform3f(u("uCc"), ...rgb01(p.colorC));
  });
  return gpu ?? nebulaCpu(p, src, w, h);
};

// ── Star ─────────────────────────────────────────────────────────────────────

/**
 * Where the layer's silhouette is, as a disc: its alpha's centroid and the
 * radius of a circle of the same area, read off a thumbnail (a 128 px read is
 * a fraction of a millisecond). So the star IS the circle it is put on — any
 * size, scaled, squashed, animated — with nothing to keep in step.
 */
function discOf(src: CanvasImageSource, w: number, h: number): { cx: number; cy: number; r: number } | null {
  const k = Math.min(1, 128 / Math.max(w, h));
  const W = Math.max(1, Math.round(w * k)), H = Math.max(1, Math.round(h * k));
  const d = readScaled(src, W, H).data;
  let sum = 0, sx = 0, sy = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const a = d[(y * W + x) * 4 + 3]! / 255;
    sum += a, sx += a * (x + 0.5), sy += a * (y + 0.5);
  }
  if (sum < 0.5) return null;
  return { cx: sx / sum / k, cy: sy / sum / k, r: Math.sqrt(sum / Math.PI) / k };
}

/**
 * How hard the camera's exposure burns the disc: a hotter surface is brighter
 * per area (σT⁴ — tamed to √T, or a red giant would be black), so heating a
 * star from 5,800 K to 30,000 K brightens it as it turns blue-white.
 */
const starExposure = (kelvin: number) => 2.6 * Math.min(1.6, Math.max(0.6, Math.sqrt(kelvin / 5800)));

/** The white the star's "camera" is balanced for, K. */
const STAR_WHITE_K = 11000;

/** The star's palette: its blackbody at the granules' heat, the lanes' and the cooler limb's — core's ONE `blackbody`. */
function starColours(p: Pass<"star">) {
  // Seen through a camera white-balanced for a HOTTER white (11,000 K), as
  // space photography is: the Sun reads golden, a red giant deep orange, a
  // blue giant pale blue — the honest chromaticity of 5,800 K is a near-white
  // cream that no film of a star has ever shown. A little saturation on top.
  const white = blackbody(STAR_WHITE_K);
  const c = (t: number): [number, number, number] => {
    const b = blackbody(t);
    const v = [b.r / white.r, b.g / white.g, b.b / white.b];
    const m = Math.max(...v);
    const n = v.map((x) => x / m);
    const l = 0.2126 * n[0]! + 0.7152 * n[1]! + 0.0722 * n[2]!;
    return n.map((x) => Math.max(0, l + (x - l) * 1.3)) as [number, number, number];
  };
  return { hot: c(p.temperature * 1.05), cool: c(p.temperature * 0.86), limb: c(p.temperature * 0.72), mid: c(p.temperature) };
}

const STAR_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform vec2 uSize, uC;
uniform float uR, uGran, uContrast, uLimb, uCorona, uCoronaSize, uBright, uTime, uExpo;
uniform uint uSeed;
uniform vec3 uHot, uCool, uLimbC, uMid;
${NOISE_GLSL}
// Convection cells: each cell's centre wanders on its own phase, so cells
// swell, split and shrink — the surface boils rather than slides.
vec2 cells(vec3 p, float t) {
  vec3 fl = floor(p);
  float f1 = 9.0, f2 = 9.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    ivec3 c = ivec3(fl) + ivec3(x, y, z);
    vec3 j = vec3(rnd(c, uSeed), rnd(c, uSeed + 7u), rnd(c, uSeed + 13u));
    vec3 pt = vec3(c) + 0.5 + 0.38 * sin(t + 6.2831 * j);
    float d = length(p - pt);
    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
  }
  return vec2(f1, f2);
}
// A star on film: the middle BURNS per channel (orange clips to yellow-white,
// as film does), the limb keeps its hue (deep orange). Limb darkening is
// applied after, or the exposure curve would flatten it away.
vec3 film(vec3 x, float mu) {
  vec3 burn = vec3(1.0) - exp(-x * 1.25);
  float L = dot(x, vec3(0.2126, 0.7152, 0.0722));
  vec3 keep = x * ((1.0 - exp(-L * 1.25)) / max(L, 1e-4));
  return clamp(mix(keep, burn, smoothstep(0.15, 0.95, mu) * smoothstep(1.0, 2.6, L) * 0.9), 0.0, 1.0);
}
// Exposure on luminance, hue kept — the corona's light.
vec3 tone(vec3 x) {
  float L = dot(x, vec3(0.2126, 0.7152, 0.0722));
  float T = 1.0 - exp(-L * 1.25);
  vec3 c = x * (T / max(L, 1e-4));
  return clamp(mix(c, vec3(T), smoothstep(1.6, 3.6, L) * 0.5), 0.0, 1.0);
}
void main() {
  vec2 px = vec2(vUv.x, 1.0 - vUv.y) * uSize;
  vec2 d = (px - uC) / uR;
  float r = length(d);
  vec4 col = vec4(0.0);
  if (r < 1.0) {
    float mu = sqrt(max(0.0, 1.0 - r * r));
    vec3 s = vec3(d, mu);
    // Cells on a lightly warped surface: granules, not tiles.
    vec3 g0 = s / uGran;
    g0 += 0.45 * vec3(gnoise(g0 * 0.5 + vec3(0.0, 0.0, uTime * 0.3), uSeed + 3u), gnoise(g0 * 0.5 + vec3(7.0, 0.0, uTime * 0.3), uSeed + 5u), 0.0);
    vec2 F = cells(g0, uTime * 2.2);
    float g = mix(1.0 - min(1.0, F.x * 0.95), smoothstep(0.0, 0.75, F.y - F.x), 0.35);
    float meso = fbm(s / (uGran * 4.0) + vec3(0.0, 0.0, uTime * 0.12), 3, uSeed + 101u) * 0.5 + 0.5;
    float sup = gnoise(s * 2.4 + vec3(0.0, 0.0, uTime * 0.05), uSeed + 151u) * 0.5 + 0.5;
    // The limb law I ∝ μ^α: the edge is seen through cooler, higher gas.
    float limbI = pow(max(mu, 1e-3), 0.15 + 0.75 * uLimb);
    float k = mix(1.0, 0.7 + 0.5 * g, uContrast) * mix(1.0, 0.8 + 0.4 * meso, uContrast) * (0.9 + 0.2 * sup);
    vec3 c = mix(uCool, uHot, 0.5 + (g - 0.5) * uContrast);
    c = mix(c, uLimbC, pow(1.0 - mu, 1.2) * uLimb);
    vec3 lit = film(c * k * uBright * uExpo * (0.35 + 0.65 * limbI), mu) * mix(1.0, limbI, 0.55);
    float edge = smoothstep(1.0, 1.0 - 1.5 / uR, r);
    col = vec4(lit * edge, edge);
  }
  if (uCorona > 0.0 && uCoronaSize > 0.0) {
    float out1 = max(0.0, r - 1.0);
    float ang = atan(d.y, d.x);
    float streak = gnoise(vec3(cos(ang) * 3.0, sin(ang) * 3.0, out1 * 1.2 - uTime * 0.05), uSeed + 211u) * 0.5 + 0.5;
    float fall = exp(-out1 / max(0.02, uCoronaSize * 0.32)) * (1.0 - smoothstep(uCoronaSize * 0.85, uCoronaSize * 1.15, out1));
    // The corona's streamers, and the optical bloom a bright disc throws just past its edge.
    float I = uCorona * (fall * (0.55 + 0.9 * streak) * 0.6 + exp(-out1 / 0.05) * 0.9);
    vec3 cc = tone(mix(uMid, vec3(1.0), 0.15) * I * 1.4);
    float a = clamp(max(cc.r, max(cc.g, cc.b)), 0.0, 1.0);
    col = vec4(col.rgb + cc * (1.0 - col.a), col.a + a * (1.0 - col.a));
  }
  o = col;
}`;

function starCpu(p: Pass<"star">, disc: { cx: number; cy: number; r: number }, w: number, h: number, pal: ReturnType<typeof starColours>): CanvasImageSource {
  const k = Math.min(1, 640 / Math.max(w, h));
  const W = Math.max(1, Math.round(w * k)), H = Math.max(1, Math.round(h * k));
  const img = new ImageData(W, H);
  const d = img.data;
  const seed = p.seed >>> 0, t = p.time * 2.2;
  const tone = (x: [number, number, number]): [number, number, number] => {
    const L = 0.2126 * x[0] + 0.7152 * x[1] + 0.0722 * x[2];
    const T = 1 - Math.exp(-L * 1.25);
    const wt = smoothstep(1.6, 3.6, L) * 0.5;
    return x.map((v) => Math.min(1, Math.max(0, lerp((v * T) / Math.max(L, 1e-4), T, wt)))) as [number, number, number];
  };
  const film = (x: [number, number, number], mu: number): [number, number, number] => {
    const L = 0.2126 * x[0] + 0.7152 * x[1] + 0.0722 * x[2];
    const kept = (1 - Math.exp(-L * 1.25)) / Math.max(L, 1e-4);
    const m = smoothstep(0.15, 0.95, mu) * smoothstep(1, 2.6, L) * 0.9;
    return x.map((v) => Math.min(1, Math.max(0, lerp(v * kept, 1 - Math.exp(-v * 1.25), m)))) as [number, number, number];
  };
  const cellsAt = (x: number, y: number, z: number): [number, number] => {
    const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
    let f1 = 9, f2 = 9;
    for (let cz = -1; cz <= 1; cz++) for (let cy = -1; cy <= 1; cy++) for (let cx = -1; cx <= 1; cx++) {
      const X = fx + cx, Y = fy + cy, Z = fz + cz;
      const jx = rnd(X, Y, Z, seed), jy = rnd(X, Y, Z, (seed + 7) >>> 0), jz = rnd(X, Y, Z, (seed + 13) >>> 0);
      const dx = x - (X + 0.5 + 0.38 * Math.sin(t + 6.2831 * jx)), dy = y - (Y + 0.5 + 0.38 * Math.sin(t + 6.2831 * jy)), dz = z - (Z + 0.5 + 0.38 * Math.sin(t + 6.2831 * jz));
      const dd = Math.hypot(dx, dy, dz);
      if (dd < f1) (f2 = f1), (f1 = dd);
      else if (dd < f2) f2 = dd;
    }
    return [f1, f2];
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = ((x + 0.5) / k - disc.cx) / disc.r, dy = ((y + 0.5) / k - disc.cy) / disc.r;
      const r = Math.hypot(dx, dy);
      let R = 0, G = 0, B = 0, A = 0;
      if (r < 1) {
        const mu = Math.sqrt(Math.max(0, 1 - r * r));
        let gx = dx / p.granulation, gy = dy / p.granulation;
        const gz = mu / p.granulation;
        const wx = 0.45 * gnoise(gx * 0.5, gy * 0.5, gz * 0.5 + p.time * 0.3, (seed + 3) >>> 0), wy = 0.45 * gnoise(gx * 0.5 + 7, gy * 0.5, gz * 0.5 + p.time * 0.3, (seed + 5) >>> 0);
        (gx += wx), (gy += wy);
        const [f1, f2] = cellsAt(gx, gy, gz);
        const g = lerp(1 - Math.min(1, f1 * 0.95), smoothstep(0, 0.75, f2 - f1), 0.35);
        const gm = p.granulation * 4;
        const meso = fbm(dx / gm, dy / gm, mu / gm + p.time * 0.12, 3, (seed + 101) >>> 0) * 0.5 + 0.5;
        const sup = gnoise(dx * 2.4, dy * 2.4, mu * 2.4 + p.time * 0.05, (seed + 151) >>> 0) * 0.5 + 0.5;
        const limbI = Math.pow(Math.max(mu, 1e-3), 0.15 + 0.75 * p.limb);
        const kk = lerp(1, 0.7 + 0.5 * g, p.contrast) * lerp(1, 0.8 + 0.4 * meso, p.contrast) * (0.9 + 0.2 * sup);
        const lm = Math.pow(1 - mu, 1.2) * p.limb;
        const gc = 0.5 + (g - 0.5) * p.contrast;
        const edge = smoothstep(1, 1 - 1.5 / (disc.r * k), r);
        const lit = film([0, 1, 2].map((c) => lerp(lerp(pal.cool[c]!, pal.hot[c]!, gc), pal.limb[c]!, lm) * kk * p.brightness * starExposure(p.temperature) * (0.35 + 0.65 * limbI)) as [number, number, number], mu);
        const dim = lerp(1, limbI, 0.55);
        (R = lit[0] * dim * edge), (G = lit[1] * dim * edge), (B = lit[2] * dim * edge), (A = edge);
      }
      if (p.corona > 0 && p.coronaSize > 0) {
        const out1 = Math.max(0, r - 1), ang = Math.atan2(dy, dx);
        const streak = gnoise(Math.cos(ang) * 3, Math.sin(ang) * 3, out1 * 1.2 - p.time * 0.05, (seed + 211) >>> 0) * 0.5 + 0.5;
        const fall = Math.exp(-out1 / Math.max(0.02, p.coronaSize * 0.32)) * (1 - smoothstep(p.coronaSize * 0.85, p.coronaSize * 1.15, out1));
        const I = p.corona * (fall * (0.55 + 0.9 * streak) * 0.6 + Math.exp(-out1 / 0.05) * 0.9);
        const cc = tone([0, 1, 2].map((c) => lerp(pal.mid[c]!, 1, 0.15) * I * 1.4) as [number, number, number]);
        const a = Math.min(1, Math.max(...cc));
        (R += cc[0]! * (1 - A)), (G += cc[1]! * (1 - A)), (B += cc[2]! * (1 - A)), (A += a * (1 - A));
      }
      const i = (y * W + x) * 4;
      // ImageData is straight alpha.
      if (A > 0) (d[i] = (R / A) * 255), (d[i + 1] = (G / A) * 255), (d[i + 2] = (B / A) * 255), (d[i + 3] = A * 255);
    }
  }
  return upscale(img, w, h);
}

/** A photosphere where the layer is, its corona past it. The layer's own paint is replaced: the circle is the star. */
export const star: PassFn<"star"> = (p, src, w, h) => {
  const disc = discOf(src, w, h);
  if (!disc) return src;
  const pal = starColours(p);
  const gpu = shade("cosmos-star", STAR_FRAG, w, h, [], (u, gl) => {
    gl.uniform2f(u("uC"), disc.cx, disc.cy);
    gl.uniform1f(u("uR"), disc.r);
    gl.uniform1f(u("uGran"), Math.max(0.005, p.granulation));
    gl.uniform1f(u("uContrast"), p.contrast);
    gl.uniform1f(u("uLimb"), p.limb);
    gl.uniform1f(u("uCorona"), p.corona);
    gl.uniform1f(u("uCoronaSize"), p.coronaSize);
    gl.uniform1f(u("uBright"), p.brightness);
    gl.uniform1f(u("uTime"), p.time);
    gl.uniform1f(u("uExpo"), starExposure(p.temperature));
    gl.uniform1ui(u("uSeed"), p.seed >>> 0);
    gl.uniform3f(u("uHot"), ...pal.hot);
    gl.uniform3f(u("uCool"), ...pal.cool);
    gl.uniform3f(u("uLimbC"), ...pal.limb);
    gl.uniform3f(u("uMid"), ...pal.mid);
  });
  return gpu ?? starCpu(p, disc, w, h, pal);
};

// ── Starfield ────────────────────────────────────────────────────────────────

/**
 * Star types as they show in a sky photo, with how common each is among the
 * stars you can see (bright giants punch above their numbers): red dwarfs and
 * giants, orange K, yellow G, white F/A, blue-white B. Their colour is the
 * blackbody's, mixed with white by the card's `color`.
 */
const SPECTRAL: Array<{ k: number; w: number }> = [
  { k: 3300, w: 0.12 },
  { k: 4200, w: 0.2 },
  { k: 5000, w: 0.18 },
  { k: 5800, w: 0.15 },
  { k: 6800, w: 0.12 },
  { k: 8500, w: 0.1 },
  { k: 12000, w: 0.08 },
  { k: 20000, w: 0.05 },
];
const SPECTRAL_CDF = SPECTRAL.reduce<number[]>((acc, s) => [...acc, (acc[acc.length - 1] ?? 0) + s.w], []);
/** Magnitudes the sky spans: the brightest at 0, the faintest at this. */
const MAG_SPAN = 7;
/** ≈2.8× as many stars each magnitude fainter. */
const MAG_SLOPE = 0.45;
const PSF = 64;

/** One star's fixed facts, read off (seed, index) alone — so changing the count adds or drops stars, never reshuffles them. */
function starAt(seed: number, i: number, band: number, bandAngle: number): { u: number; v: number; b: number; bin: number; depth: number } {
  const R = (k: number) => rnd(i, k, 0, seed);
  let u = R(1), v = R(2);
  // A share of them crowd into the galaxy's band: a line through the middle at its angle.
  if (R(3) < band * 0.55) {
    const a = (bandAngle * Math.PI) / 180;
    const along = R(4) - 0.5;
    // A Gaussian across the band (Box–Muller), narrow.
    const across = Math.sqrt(-2 * Math.log(Math.max(1e-9, R(5)))) * Math.cos(6.2831853 * R(6)) * 0.07;
    u = 0.5 + Math.cos(a) * along * 1.6 - Math.sin(a) * across;
    v = 0.5 + Math.sin(a) * along * 1.6 + Math.cos(a) * across;
    u -= Math.floor(u), v -= Math.floor(v);
  }
  const m = MAG_SPAN + Math.log10(R(7) + (1 - R(7)) * Math.pow(10, -MAG_SLOPE * MAG_SPAN)) / MAG_SLOPE;
  // Seen brightness: flux 10^(−0.4 m), compressed as film and eyes compress it.
  const b = Math.pow(Math.pow(10, -0.4 * m), 0.32);
  const s = R(8);
  const bin = Math.max(0, SPECTRAL_CDF.findIndex((c) => s <= c));
  // Brighter stars are, on the whole, nearer: they move more under a drift.
  const depth = 0.2 + 0.8 * Math.min(1, R(9) * 0.7 + b * 0.6);
  return { u, v, b, bin, depth };
}

/**
 * THE SKY'S FIXED FACTS, made once. A star is a function of (seed, index,
 * band) alone, so the table only ever grows: a denser sky reads further into
 * the same one. Re-deriving thousands of them every frame was a tenth of what
 * playing a sky cost.
 */
interface StarTable {
  n: number;
  u: Float32Array;
  v: Float32Array;
  b: Float32Array;
  depth: Float32Array;
  bin: Uint8Array;
}
const starTables = new Map<string, StarTable>();
const STAR_TABLES_KEPT = 8;

function starTable(seed: number, n: number, band: number, bandAngle: number): StarTable {
  const key = `${seed}|${band}|${bandAngle}`;
  const had = starTables.get(key);
  if (had && had.n >= n) {
    starTables.delete(key);
    starTables.set(key, had); // most recently used last
    return had;
  }
  const t: StarTable = { n, u: new Float32Array(n), v: new Float32Array(n), b: new Float32Array(n), depth: new Float32Array(n), bin: new Uint8Array(n) };
  for (let i = 0; i < n; i++) {
    const s = starAt(seed, i, band, bandAngle);
    t.u[i] = s.u, t.v[i] = s.v, t.b[i] = s.b, t.depth[i] = s.depth, t.bin[i] = s.bin;
  }
  starTables.delete(key);
  starTables.set(key, t);
  while (starTables.size > STAR_TABLES_KEPT) starTables.delete(starTables.keys().next().value!);
  return t;
}

/** The point-spread's alpha against its radius (0 centre … 1 edge) — the one profile both the sprite and the plotter use. */
const PSF_STOPS: ReadonlyArray<readonly [number, number]> = [[0, 1], [0.12, 0.9], [0.22, 0.5], [0.36, 0.15], [0.56, 0.04], [0.8, 0.01], [1, 0]];

function psfAlpha(r: number): number {
  if (r >= 1) return 0;
  for (let k = 1; k < PSF_STOPS.length; k++) {
    const [r1, a1] = PSF_STOPS[k]!;
    if (r <= r1) {
      const [r0, a0] = PSF_STOPS[k - 1]!;
      return a0 + ((a1 - a0) * (r - r0)) / (r1 - r0);
    }
  }
  return 0;
}

/** A star's colour, straight 0–1: its blackbody mixed with white by the card's `color`. */
function starRgb(bin: number, color: number): [number, number, number] {
  const bb = blackbody(SPECTRAL[bin]!.k);
  const mix = (x: number) => Math.round((1 - color + color * x) * 255) / 255;
  return [mix(bb.r), mix(bb.g), mix(bb.b)];
}

const sprites = new Map<string, HTMLCanvasElement>();

/** A star's light, tinted: a sharp core in a faint halo (a lens's point-spread, not a flat dot). */
function psf(bin: number, color: number): HTMLCanvasElement {
  const key = `${bin}|${Math.round(color * 20)}`;
  let c = sprites.get(key);
  if (c) return c;
  const [r, g, b] = starRgb(bin, Math.round(color * 20) / 20).map((x) => Math.round(x * 255));
  const rgb = `${r},${g},${b}`;
  c = document.createElement("canvas");
  c.width = c.height = PSF;
  const x = c.getContext("2d")!;
  const grad = x.createRadialGradient(PSF / 2, PSF / 2, 0, PSF / 2, PSF / 2, PSF / 2);
  for (const [at, a] of PSF_STOPS) grad.addColorStop(at, `rgba(${rgb},${a})`);
  x.fillStyle = grad;
  x.fillRect(0, 0, PSF, PSF);
  sprites.set(key, c);
  return c;
}

let spikeSprite: HTMLCanvasElement | null = null;
/** Four diffraction spikes: thin, bright at the star, fading along their length. */
function spikes(): HTMLCanvasElement {
  if (spikeSprite) return spikeSprite;
  const S = 256;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const x = c.getContext("2d")!;
  x.globalCompositeOperation = "lighter";
  for (const vertical of [false, true]) {
    const g = vertical ? x.createLinearGradient(0, 0, 0, S) : x.createLinearGradient(0, 0, S, 0);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.42, "rgba(255,255,255,0.35)");
    g.addColorStop(0.5, "rgba(255,255,255,1)");
    g.addColorStop(0.58, "rgba(255,255,255,0.35)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = g;
    if (vertical) x.fillRect(S / 2 - 1, 0, 2, S);
    else x.fillRect(0, S / 2 - 1, S, 2);
  }
  spikeSprite = c;
  return c;
}

/**
 * Stars up to this footprint (device px) are PLOTTED into a light buffer
 * rather than stamped. A canvas call costs the same for a 3 px star as for a
 * 30 px one, so a sky of thousands of faint stars cost the same at a quarter
 * resolution as at full — the preview tier could not make it faster. Plotted,
 * a star costs its pixels, and a quarter-resolution sky costs a sixteenth.
 */
const PLOT_MAX = 10;

/**
 * The plotter's light: PREMULTIPLIED 8-bit, adding and saturating per star
 * exactly as "lighter" does on a canvas, turned straight-alpha once at the end.
 * One image per sky size, the last two kept — it is the only memory the
 * plotter holds.
 */
const lightImages = new Map<string, ImageData>();

function lightImage(w: number, h: number): ImageData {
  const key = `${w}x${h}`;
  let img = lightImages.get(key);
  if (img) {
    img.data.fill(0);
    lightImages.delete(key);
  } else img = new ImageData(w, h);
  lightImages.set(key, img);
  while (lightImages.size > 2) lightImages.delete(lightImages.keys().next().value!);
  return img;
}

/** `psfAlpha` against r², tabulated: the plotter's inner loop is a lookup, no root and no stop search. */
const PSF_LUT_SIZE = 1024;
const PSF_LUT = (() => {
  const t = new Float32Array(PSF_LUT_SIZE + 1);
  for (let i = 0; i <= PSF_LUT_SIZE; i++) t[i] = psfAlpha(Math.sqrt(i / PSF_LUT_SIZE));
  return t;
})();

/**
 * Add one star's point-spread, sampled 2×2 per pixel (3×3 when it is under
 * two pixels across, so a faint star drifting by a sub-pixel never flickers).
 */
function plotStar(acc: Uint8ClampedArray, w: number, h: number, cx: number, cy: number, d: number, alpha: number, rgb: readonly [number, number, number]): void {
  const R = d / 2;
  const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(w - 1, Math.ceil(cx + R) - 1);
  const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(h - 1, Math.ceil(cy + R) - 1);
  if (x0 > x1 || y0 > y1) return;
  const ss = d < 2 ? 3 : 2;
  const step = 1 / ss;
  const inv2 = (PSF_LUT_SIZE / (R * R));
  const norm = (alpha * 255) / (ss * ss);
  const [r, g, b] = rgb;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let a = 0;
      for (let j = 0; j < ss; j++) {
        const dy = y + (j + 0.5) * step - cy;
        const dy2 = dy * dy;
        for (let i = 0; i < ss; i++) {
          const dx = x + (i + 0.5) * step - cx;
          const k = ((dx * dx + dy2) * inv2) | 0;
          if (k < PSF_LUT_SIZE) a += PSF_LUT[k]!;
        }
      }
      if (a <= 0) continue;
      a *= norm;
      const o = (y * w + x) * 4;
      acc[o] = acc[o]! + r * a;
      acc[o + 1] = acc[o + 1]! + g * a;
      acc[o + 2] = acc[o + 2]! + b * a;
      acc[o + 3] = acc[o + 3]! + a;
    }
  }
}

/**
 * The sky, drawn as light: every star a tinted point-spread added with
 * "lighter" (two stars in one pixel add), the brightest with spikes, the band
 * as a faint glow under them — then masked by the layer's own alpha and added
 * over its paint. Plain 2D canvas and plain arrays, so every engine draws the
 * same sky.
 */
export const starfield: PassFn<"starfield"> = (p, src, w, h) => {
  const out = nextOutput(w, h);
  out.ctx.drawImage(src, 0, 0);
  const sky = nextOutput(w, h);
  const x = sky.ctx;
  x.globalCompositeOperation = "lighter";
  const docArea = (w / p.scale) * (h / p.scale);
  const n = Math.min(60000, Math.round((p.density * docArea) / 1e6));
  const seed = p.seed >>> 0;
  // The galaxy's unresolved glow: a soft band across the middle.
  if (p.band > 0) {
    const a = (p.bandAngle * Math.PI) / 180;
    const span = Math.hypot(w, h);
    x.save();
    x.translate(w / 2 - p.driftX * 0.2, h / 2 - p.driftY * 0.2);
    x.rotate(a);
    const g = x.createLinearGradient(0, -span * 0.16, 0, span * 0.16);
    g.addColorStop(0, "rgba(150,140,190,0)");
    g.addColorStop(0.35, `rgba(150,140,190,${(0.07 * p.band).toFixed(3)})`);
    g.addColorStop(0.5, `rgba(215,198,220,${(0.13 * p.band).toFixed(3)})`);
    g.addColorStop(0.65, `rgba(150,140,190,${(0.07 * p.band).toFixed(3)})`);
    g.addColorStop(1, "rgba(150,140,190,0)");
    x.fillStyle = g;
    x.fillRect(-span, -span * 0.16, span * 2, span * 0.32);
    x.restore();
  }
  const wrap = (v: number, m: number) => ((v % m) + m) % m;
  const spike = p.spikes > 0 ? spikes() : null;
  const stars = starTable(seed, n, p.band, p.bandAngle);
  const colours = SPECTRAL.map((_, bin) => starRgb(bin, p.spectral));
  let light: ImageData | null = null;
  const stamp = (bin: number, cx: number, cy: number, d: number, alpha: number) => {
    if (d <= PLOT_MAX) {
      light ??= lightImage(w, h);
      plotStar(light.data, w, h, cx, cy, d, alpha, colours[bin]!);
      return;
    }
    x.globalAlpha = alpha;
    x.drawImage(psf(bin, p.spectral), cx - d / 2, cy - d / 2, d, d);
  };
  for (let i = 0; i < n; i++) {
    const sb = stars.b[i]!;
    const tw = p.twinkle > 0 ? Math.max(0, 1 + p.twinkle * (rnd(i, p.step, 11, seed) - 0.5) * 1.5) : 1;
    const b = sb * 1.5 * p.brightness * tw;
    if (b < 0.01) continue;
    const depth = stars.depth[i]!;
    const sx = wrap(stars.u[i]! * w + p.driftX * depth, w), sy = wrap(stars.v[i]! * h + p.driftY * depth, h);
    const core = p.size * (0.85 + 1.8 * Math.pow(sb, 1.6));
    const d = core * 5;
    const bin = stars.bin[i]!;
    stamp(bin, sx, sy, d, Math.min(1, b));
    // A star past "fully bright" blooms: its light keeps spreading instead of clipping.
    if (b > 1) stamp(bin, sx, sy, d * 2, Math.min(1, (b - 1) * 0.5));
    if (spike && sb > 0.55) {
      const len = core * 26 * p.spikes * (sb - 0.4) * 2;
      x.globalAlpha = Math.min(1, b * 0.7 * Math.min(1, p.spikes));
      x.save();
      x.translate(sx, sy);
      x.rotate((p.spikeAngle * Math.PI) / 180);
      x.drawImage(spike, -len, -len, len * 2, len * 2);
      x.restore();
    }
  }
  x.globalAlpha = 1;
  if (light) {
    // Premultiplied light → the straight alpha ImageData holds.
    const d8 = (light as ImageData).data;
    for (let o = 0; o < d8.length; o += 4) {
      const A = d8[o + 3]!;
      if (A === 0) continue;
      const k = 255 / A;
      d8[o] = d8[o]! * k;
      d8[o + 1] = d8[o + 1]! * k;
      d8[o + 2] = d8[o + 2]! * k;
    }
    const buf = nextOutput(w, h);
    buf.ctx.putImageData(light, 0, 0);
    x.drawImage(buf.canvas, 0, 0);
  }
  // Only where the layer is.
  x.globalCompositeOperation = "destination-in";
  x.drawImage(src, 0, 0);
  out.ctx.globalCompositeOperation = "lighter";
  out.ctx.drawImage(sky.canvas, 0, 0);
  out.ctx.globalCompositeOperation = "source-over";
  return out.canvas;
};

// ── Shockwave ────────────────────────────────────────────────────────────────

/**
 * The ring's push at distance `r`, px: the derivative of a Gaussian about the
 * front, peaking at ±strength a third of a width either side — what a pressure
 * front does to light passing through it. Zero past four widths.
 */
function shockPush(p: Pass<"shockwave">, r: number): number {
  const x = (r - p.radius) / Math.max(1, p.width);
  if (Math.abs(x) > 4) return 0;
  return p.strength * 2.33 * -x * Math.exp(-x * x);
}

const SHOCK_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uIn0;
uniform vec2 uSize, uC;
uniform float uR, uW, uS, uChroma, uLight;
uniform vec3 uColor;
vec4 at(vec2 s) {
  vec2 uv = vec2(s.x / uSize.x, 1.0 - s.y / uSize.y);
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  return texture(uIn0, uv) * inside;
}
void main() {
  vec2 p = vec2(vUv.x, 1.0 - vUv.y) * uSize;
  vec2 d = p - uC;
  float r = length(d);
  float x = (r - uR) / max(1.0, uW);
  if (abs(x) > 4.0) { o = vec4(0.0); return; }
  vec2 dir = r > 1e-4 ? d / r : vec2(1.0, 0.0);
  float push = uS * 2.33 * -x * exp(-x * x);
  vec4 g = at(p - dir * push);
  vec4 rr = at(p - dir * push * (1.0 + uChroma * 0.6));
  vec4 bb = at(p - dir * push * (1.0 - uChroma * 0.6));
  vec4 col = vec4(rr.r, g.g, bb.b, max(g.a, max(rr.a, bb.a)));
  float front = exp(-pow((x - 0.55) * 3.0, 2.0)) * uLight;
  col.rgb += uColor * front;
  col.a = clamp(max(col.a, front), 0.0, 1.0);
  o = vec4(min(col.rgb, vec3(col.a)), col.a);
}`;

function shockCpu(p: Pass<"shockwave">, backdrop: CanvasImageSource, w: number, h: number): CanvasImageSource {
  const out = nextOutput(w, h);
  const { image, buf } = readPixels(backdrop, w, h);
  const src = image.data;
  const cx = w / 2, cy = h / 2;
  const reach = p.radius + 4 * Math.max(1, p.width);
  const x0 = Math.max(0, Math.floor(cx - reach)), x1 = Math.min(w, Math.ceil(cx + reach));
  const y0 = Math.max(0, Math.floor(cy - reach)), y1 = Math.min(h, Math.ceil(cy + reach));
  const img = new ImageData(Math.max(1, x1 - x0), Math.max(1, y1 - y0));
  const o = img.data;
  const s = new Float64Array(4);
  const [lr, lg, lb] = rgb01(p.color);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const r = Math.hypot(dx, dy);
      const t = (r - p.radius) / Math.max(1, p.width);
      if (Math.abs(t) > 4) continue;
      const ux = r > 1e-4 ? dx / r : 1, uy = r > 1e-4 ? dy / r : 0;
      const push = shockPush(p, r);
      // Premultiplied channels from each of three samples: red bent further, blue less.
      const take = (k: number, ch: number) => {
        sampleBilinear(src, w, h, x - ux * push * k, y - uy * push * k, s);
        return [(s[ch]! / 255) * (s[3]! / 255), s[3]! / 255];
      };
      const [r1, ar] = take(1 + p.chroma * 0.6, 0);
      const [g1, ag] = take(1, 1);
      const [b1, ab] = take(1 - p.chroma * 0.6, 2);
      const front = Math.exp(-(((t - 0.55) * 3) ** 2)) * p.light;
      const a = Math.min(1, Math.max(ag!, ar!, ab!, front));
      const i = ((y - y0) * img.width + (x - x0)) * 4;
      if (a <= 0) continue;
      o[i] = (Math.min(a, r1! + lr * front) / a) * 255;
      o[i + 1] = (Math.min(a, g1! + lg * front) / a) * 255;
      o[i + 2] = (Math.min(a, b1! + lb * front) / a) * 255;
      o[i + 3] = a * 255;
    }
  }
  releaseTemp(buf);
  out.ctx.putImageData(img, x0, y0);
  return out.canvas;
}

/** A refracting ring. Replaces its carrier's picture; outside the ring the backdrop shows as it is. */
export const shockwave: PassFn<"shockwave"> = (p, _src, w, h, env) => {
  if (p.width <= 0 || (p.strength === 0 && p.light <= 0)) return nextOutput(w, h).canvas;
  const back = env.backdrop ?? nextOutput(w, h).canvas;
  const gpu = shade("cosmos-shock", SHOCK_FRAG, w, h, [back], (u, gl) => {
    gl.uniform2f(u("uC"), w / 2, h / 2);
    gl.uniform1f(u("uR"), p.radius);
    gl.uniform1f(u("uW"), Math.max(1, p.width));
    gl.uniform1f(u("uS"), p.strength);
    gl.uniform1f(u("uChroma"), p.chroma);
    gl.uniform1f(u("uLight"), p.light);
    gl.uniform3f(u("uColor"), ...rgb01(p.color));
  });
  return gpu ?? shockCpu(p, back, w, h);
};
