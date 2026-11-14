"use client";

import { acquireGl, type CanvasRegion, type GlProgram, type GlSubstrate, type GlTarget, wholeCanvas } from "./gl-substrate";

import { MAX_SLOPE, glassBezel, glassRefract, signedDistanceField, type GlassParams } from "@solomotion/core";
import { parseColor } from "@/lib/color";
import { blurTo } from "./gaussian";

/**
 * The liquid-glass pixel engine — two images in (the layer, and the backdrop
 * behind it), one image out. All of the material's MATH already happened in
 * `resolveGlassParams` (core); this file only moves pixels, on WebGL2 with a
 * CPU fallback that shares the same model so a machine without GL still
 * exports the same frame (slower, and without the directional smear).
 *
 * Pipeline, per frame, at the card's `quality` scale:
 *
 *   1. FIELD — a signed distance field of the layer's silhouette, by jump
 *      flooding: seed the edge pixels, then log₂(reach) passes that each let a
 *      pixel adopt its neighbours' nearest seed at halving strides. Every
 *      pixel within `reach` of the edge ends up knowing its distance to the
 *      edge AND the direction to it; everything further is flat glass and is
 *      never resolved, which is what keeps a 4000px pane as cheap as a 40px one.
 *   2. SOFTEN — a small blur of the field's DIRECTION only. At a sharp corner
 *      the nearest-edge direction flips 90° across the diagonal; smoothing it
 *      over a fraction of the bezel turns that crease into the rounded corner a
 *      real bezel would have, while the distance (the bezel's extent) stays
 *      exact. This is the difference between a square that looks like glass
 *      and a square with a mitre scratched into each corner.
 *   3. FROST — blur the backdrop once, if the card asks for it.
 *   4. SHADE — one fragment pass: bezel slope from the distance, Snell through
 *      it, sample the backdrop from where the refracted ray lands (smeared a
 *      little along that direction — the stretch), tint, then light the slope.
 *
 * Nothing is cached INSIDE this file, and that is still right — but not for the
 * reason it once said. The old claim was that a cache keyed on the params would
 * miss every frame of an animation; the answer turned out to be that the params
 * are the wrong subject, and the layer cache one level up (`layer-cache.ts`)
 * keys on the INSTANT and reuses a whole glass card's finished pixels for as
 * long as the playhead has not moved. The work here is O(pixels) with a
 * `quality` dial that divides it, and it now runs once per changed frame rather
 * than once per render.
 */

export interface GlassInputs {
  /** The layer's own pixels, device space. */
  layer: CanvasImageSource;
  /** Everything painted BEHIND the layer, same space and size. */
  backdrop: CanvasImageSource | null;
  width: number;
  height: number;
}

/** Render one glass card. Returns a region of `quality`-scaled size, or null. */
export function renderGlass(inputs: GlassInputs, p: GlassParams): CanvasRegion | null {
  const { width: w, height: h } = inputs;
  if (w < 1 || h < 1) return null;
  const gl = glRender(inputs, p);
  if (gl) return gl;
  const cpu = cpuRender(inputs, p);
  return cpu ? wholeCanvas(cpu) : null;
}

// ── Shared scratch canvases ──────────────────────────────────────────────────

interface Scratch {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}
const scratches = new Map<string, Scratch>();
function scratch(key: string, w: number, h: number): Scratch {
  let s = scratches.get(key);
  if (!s) {
    const canvas = document.createElement("canvas");
    s = { canvas, ctx: canvas.getContext("2d")! };
    scratches.set(key, s);
  }
  if (s.canvas.width !== w || s.canvas.height !== h) {
    s.canvas.width = w;
    s.canvas.height = h;
  }
  s.ctx.setTransform(1, 0, 0, 1, 0, 0);
  s.ctx.filter = "none";
  s.ctx.globalAlpha = 1;
  s.ctx.globalCompositeOperation = "source-over";
  s.ctx.clearRect(0, 0, w, h);
  return s;
}

/** The backdrop, frosted. */
function blurred(key: string, src: CanvasImageSource, w: number, h: number, blur: number): HTMLCanvasElement {
  const s = scratch(key, w, h);
  // Through `blurTo`, not `ctx.filter` directly: the browser clamp at ~100px
  // would cap a heavy frost the moment the stage zoomed in.
  blurTo(s.ctx, src, w, h, blur);
  return s.canvas;
}

/** #rrggbb[aa] → [r, g, b] 0..1 plus the alpha, which scales the term. */
function rgb01(color: string): { rgb: [number, number, number]; a: number } {
  const c = parseColor(color) ?? { r: 255, g: 255, b: 255, a: 1 };
  return { rgb: [c.r / 255, c.g / 255, c.b / 255], a: c.a };
}

const PROFILE_INDEX: Record<GlassParams["profile"], number> = { squircle: 0, circle: 1, lip: 2, concave: 3 };

// ── WebGL2 ───────────────────────────────────────────────────────────────────

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

/**
 * Seed coordinates ride an RGBA8 target as two 16-bit fixed numbers with two
 * fractional bits (¼ px, up to 16k px) — seeds sit on the SUB-PIXEL edge, not
 * on pixel centres, see the seed pass.
 */
const CODEC = `
vec4 encodeSeed(vec2 p) {
  vec2 q = clamp(floor(p * 4.0 + 0.5), 0.0, 65000.0);
  vec2 hi = floor(q / 256.0);
  vec2 lo = q - hi * 256.0;
  return vec4(hi.x, lo.x, hi.y, lo.y) / 255.0;
}
vec2 decodeSeed(vec4 c) {
  vec4 b = floor(c * 255.0 + 0.5);
  return vec2(b.x * 256.0 + b.y, b.z * 256.0 + b.w) * 0.25;
}
bool noSeed(vec2 s) { return s.x > 16000.0; }
const vec4 NONE = vec4(1.0);
`;

/** The layer's alpha as a pane: which pixels are inside, and where the edge is. */
const FRAG_SEED = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uLayer;
uniform vec2 uFieldTexel;
uniform float uCoverage;
${CODEC}
float aAt(vec2 uv) { return texture(uLayer, uv).a; }
bool inside(vec2 uv) { return aAt(uv) / uCoverage > 0.5; }
void main() {
  if (!inside(vUv)) { o = NONE; return; }
  bool edge = !inside(vUv + vec2(uFieldTexel.x, 0.0)) || !inside(vUv - vec2(uFieldTexel.x, 0.0))
           || !inside(vUv + vec2(0.0, uFieldTexel.y)) || !inside(vUv - vec2(0.0, uFieldTexel.y));
  if (!edge) { o = NONE; return; }
  // The seed is placed on the TRUE edge, not on this pixel's centre: the
  // anti-aliased alpha says how far through the pixel the edge runs, and the
  // alpha gradient says which way. A field seeded on pixel centres is seeded
  // on a staircase, and every pixel nearby picks one stair — the direction
  // fans out in bundles that the stretch turns into spokes at every curve.
  float a = aAt(vUv);
  float full = a;
  vec2 g = vec2(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 d = vec2(float(i), float(j));
    float n = aAt(vUv + d * uFieldTexel);
    full = max(full, n);
    g += d * n;
  }
  float frac = full > 1e-4 ? clamp(a / full, 0.0, 1.0) : 1.0;
  float glen = length(g);
  vec2 outward = glen > 1e-5 ? -g / glen : vec2(0.0);
  o = encodeSeed(floor(gl_FragCoord.xy) + 0.5 + outward * (frac - 0.5));
}`;

/** One jump-flood step: adopt the nearest seed among the 3×3 at `uStep`. */
const FRAG_JFA = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uSeeds;
uniform vec2 uFieldTexel;
uniform float uStep;
${CODEC}
void main() {
  vec2 p = floor(gl_FragCoord.xy) + 0.5;
  vec2 best = vec2(70000.0);
  float bestD = 1e12;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 uv = vUv + vec2(float(i), float(j)) * uStep * uFieldTexel;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) continue;
    vec2 s = decodeSeed(texture(uSeeds, uv));
    if (noSeed(s)) continue;
    vec2 d = s - p;
    float dd = dot(d, d);
    if (dd < bestD) { bestD = dd; best = s; }
  }
  o = noSeed(best) ? NONE : encodeSeed(best);
}`;

/** Seeds → the field: rg = outward direction, b = distance / reach, a = inside. */
const FRAG_RESOLVE = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uSeeds, uLayer;
uniform vec2 uFieldTexel;
uniform float uReach, uCoverage;
${CODEC}
float aAt(vec2 uv) { return texture(uLayer, uv).a; }
void main() {
  vec2 p = floor(gl_FragCoord.xy) + 0.5;
  bool inside = aAt(vUv) / uCoverage > 0.5;
  vec2 s = decodeSeed(texture(uSeeds, vUv));
  if (noSeed(s)) { o = vec4(0.5, 0.5, 1.0, inside ? 1.0 : 0.0); return; }
  vec2 d = s - p;
  float len = length(d);
  vec2 dir;
  if (len > 0.2) {
    // Outward for both sides: toward the edge from inside, away from it outside.
    dir = inside ? d / len : -d / len;
  } else {
    // The edge ring is its own seed and has no direction of its own: take it
    // from the alpha gradient (alpha falls outward), like the CPU path does.
    vec2 g = vec2(aAt(vUv + vec2(uFieldTexel.x, 0.0)) - aAt(vUv - vec2(uFieldTexel.x, 0.0)),
                  aAt(vUv + vec2(0.0, uFieldTexel.y)) - aAt(vUv - vec2(0.0, uFieldTexel.y)));
    float glen = length(g);
    dir = glen > 1e-5 ? -g / glen : vec2(0.0);
  }
  o = vec4(dir * 0.5 + 0.5, clamp(len / uReach, 0.0, 1.0), inside ? 1.0 : 0.0);
}`;

/** Separable blur of the DIRECTION channels only; distance and side pass through. */
const FRAG_SOFTEN = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uField;
uniform vec2 uAxis;
void main() {
  vec4 c = texture(uField, vUv);
  vec2 acc = vec2(0.0);
  float wsum = 0.0;
  const float W[5] = float[5](0.204, 0.180, 0.124, 0.066, 0.028);
  for (int k = -4; k <= 4; k++) {
    vec2 uv = clamp(vUv + uAxis * float(k), 0.0, 1.0);
    vec4 s = texture(uField, uv);
    // Only pixels near an edge carry a direction worth averaging in.
    float w = W[abs(k)] * (s.b < 0.999 ? 1.0 : 0.0);
    acc += (s.rg * 2.0 - 1.0) * w;
    wsum += w;
  }
  vec2 dir = wsum > 1e-5 ? acc / wsum : c.rg * 2.0 - 1.0;
  float l = length(dir);
  if (l > 1e-4) dir /= l;
  o = vec4(dir * 0.5 + 0.5, c.b, c.a);
}`;

const FRAG_SHADE = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;

uniform sampler2D uLayer, uBack, uFrost, uField;
uniform vec2 uFieldSize;
uniform float uReach, uDepth, uRefraction, uIor, uDispersion, uFrostMix, uMix, uCoverage, uInset, uPaint;
uniform int uProfile;
uniform vec3 uTint; uniform float uTintAmt, uSaturation, uBrightness;
uniform vec2 uLight; uniform float uLightI, uSplay; uniform vec3 uLightColor;
uniform float uNoise, uNoiseScale, uRipple, uRippleScale, uPhase, uEdgeOnly;

const vec3 LUMA = vec3(0.299, 0.587, 0.114);
const float MAX_SLOPE = ${MAX_SLOPE.toFixed(1)};

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

// The bezel — see core \`glassBezel\`. Returns the surface slope at t (0 = edge).
float convexSlope(float t, bool circle) {
  float x = 1.0 - clamp(t, 0.0, 1.0);
  if (circle) {
    float h = sqrt(max(0.0, 1.0 - x * x));
    return h > 1e-4 ? min(MAX_SLOPE, x / h) : MAX_SLOPE;
  }
  float x4 = x * x * x * x;
  float h = pow(max(0.0, 1.0 - x4), 0.25);
  float h3 = h * h * h;
  return h3 > 1e-5 ? min(MAX_SLOPE, (x * x * x) / h3) : MAX_SLOPE;
}
float bezelSlope(float t) {
  if (uProfile == 1) return convexSlope(t, true);
  if (uProfile == 3) return -convexSlope(t, false);
  float s = convexSlope(t, false);
  if (uProfile == 2) {
    float u = clamp(t, 0.0, 1.0);
    float w = u * u * u * (u * (u * 6.0 - 15.0) + 10.0);
    return mix(s, -0.15 * s, w);
  }
  return s;
}
// Snell for a ray arriving straight down onto a surface tilted by tan θ₁.
float refractTan(float slope, float ior) {
  float th1 = atan(abs(slope));
  float s = sin(th1) / max(1.0, ior);
  return sign(slope) * tan(asin(min(1.0, s)));
}

vec4 backAt(vec2 uv) {
  uv = clamp(uv, 0.0, 1.0);
  return mix(texture(uBack, uv), texture(uFrost, uv), uFrostMix);
}
// The stretch: three taps along the refraction direction, so a pixel on the
// bezel shows the backdrop pulled along the normal rather than merely shifted.
vec4 smear(vec2 uv, vec2 offUv) {
  return (backAt(uv + offUv * 0.8) + backAt(uv + offUv) + backAt(uv + offUv * 1.2)) / 3.0;
}

void main() {
  vec4 lay = texture(uLayer, vUv);
  vec4 f = texture(uField, vUv);
  vec2 dir = f.rg * 2.0 - 1.0;
  float dist = f.b * uReach;
  bool inside = f.a > 0.5;
  float sd = (inside ? dist : -dist) - uInset;

  // ── The pane ──────────────────────────────────────────────────────────────
  float m = abs(uInset) > 0.01 ? smoothstep(-0.7, 0.7, sd) : clamp(lay.a / uCoverage, 0.0, 1.0);
  m *= uMix;
  if (m <= 0.001) { o = vec4(lay.rgb * lay.a, lay.a); return; }

  // ── The bezel ─────────────────────────────────────────────────────────────
  float t = uDepth > 0.5 ? clamp(sd / uDepth, 0.0, 1.0) : 1.0;
  float slope = bezelSlope(t);
  vec2 tilt = dir * slope;
  if (uRipple > 0.001) {
    // A travelling cross-wave folded into the surface, fading toward the
    // middle so the pane stays readable.
    vec2 q = vUv * uFieldSize * (uRippleScale / 60.0);
    float w1 = sin(q.x * 6.2831 + uPhase) + sin(q.y * 4.1 - uPhase * 0.7);
    float w2 = cos(q.y * 6.2831 - uPhase * 1.17) + cos(q.x * 3.7 + uPhase * 0.9);
    tilt += vec2(w1, w2) * uRipple * 0.5 * mix(1.0, 0.35, t);
  }
  float tiltLen = length(tilt);
  vec2 tiltDir = tiltLen > 1e-5 ? tilt / tiltLen : vec2(0.0);

  // ── Refraction ────────────────────────────────────────────────────────────
  vec4 back = vec4(0.0);
  if (uEdgeOnly < 0.5) {
    float disp = refractTan(tiltLen, uIor) * uRefraction * uDepth; // field px
    // Grain: scatter each sample a little.
    vec2 scatter = vec2(0.0);
    if (uNoise > 0.001) {
      vec2 cell = floor(gl_FragCoord.xy / max(uNoiseScale, 0.1));
      scatter = (vec2(hash(cell), hash(cell + 17.3)) - 0.5) * uNoise * 8.0;
    }
    // A convex bezel bends the ray INWARD (toward the centre): the rim shows
    // the backdrop pulled from further in — the magnifying edge of a lens.
    vec2 offPx = -tiltDir * disp + scatter;
    vec2 offUv = offPx / uFieldSize;
    bool stretch = abs(disp) > 1.5;
    if (uDispersion > 0.001 && abs(disp) > 0.5) {
      // Red bends least, blue most — three taps, one colour. Alpha takes the
      // widest coverage of the three so a fringe never punches a hole.
      vec2 dR = offUv * (1.0 - uDispersion * 0.35);
      vec2 dB = offUv * (1.0 + uDispersion * 0.35);
      vec4 sR = stretch ? smear(vUv, dR) : backAt(vUv + dR);
      vec4 sG = stretch ? smear(vUv, offUv) : backAt(vUv + offUv);
      vec4 sB = stretch ? smear(vUv, dB) : backAt(vUv + dB);
      back = vec4(sR.r, sG.g, sB.b, max(sG.a, max(sR.a, sB.a)));
    } else {
      back = stretch ? smear(vUv, offUv) : backAt(vUv + offUv);
    }
    float l = dot(back.rgb, LUMA);
    back.rgb = mix(vec3(l), back.rgb, uSaturation) * uBrightness;
    back.rgb = mix(back.rgb, uTint, uTintAmt);
  }

  // ── Light ─────────────────────────────────────────────────────────────────
  // How tilted the surface is (0 flat, → 1 vertical), lit from uLight on both
  // sides of the pane — the far side dimmer — and spread by splay.
  float cosT = 1.0 / sqrt(1.0 + tiltLen * tiltLen);
  float steep = 1.0 - cosT;
  // Uploads are flipped, so the field's y runs up the screen; the light is y-down.
  float facing = dot(vec2(dir.x, -dir.y), uLight);
  float e = mix(4.0, 0.6, uSplay);
  float ang = pow(max(facing, 0.0), e) + 0.55 * pow(max(-facing, 0.0), e);
  float spread = pow(steep, mix(1.3, 0.35, uSplay));
  float hl = uLightI * spread * ang * (inside || abs(uInset) > 0.01 ? 1.0 : 0.0);
  hl = min(hl, 1.6);

  // ── Composite ─────────────────────────────────────────────────────────────
  // The layer's own paint sits OVER the glass at paint × its alpha — a 20%
  // fill is a 20% tint — and you can only see through to something that is
  // actually there, so a pane over empty space keeps its own fill.
  float backA = back.a;
  float paintA = lay.a * uPaint;
  float gA = paintA + backA * (1.0 - paintA);
  vec3 gRGB = gA > 0.0001 ? (lay.rgb * paintA + back.rgb * backA * (1.0 - paintA)) / gA : back.rgb;
  gRGB += uLightColor * hl;
  gA = clamp(max(gA, min(hl, 1.0)), 0.0, 1.0);

  float outA = mix(lay.a, gA, m);
  vec3 outRGB = clamp(mix(lay.rgb, gRGB, m), 0.0, 1.0);
  o = vec4(outRGB * outA, outA);
}`;

/**
 * The glass pipeline's five programs, on the renderer's ONE WebGL2 context.
 *
 * Everything that used to live here — the context, the shader compiler, the
 * fullscreen triangle, the upload textures, the ping-pong targets — is
 * `gl-substrate.ts` now, because goo needs the identical four things and a
 * page may only hold so many contexts before the browser starts killing the
 * oldest without telling anyone. What is left is the part that is actually
 * about glass: which shaders, in which order, with which uniforms.
 */
const FRAGS: Record<"seed" | "jfa" | "resolve" | "soften" | "shade", string> = {
  seed: FRAG_SEED,
  jfa: FRAG_JFA,
  resolve: FRAG_RESOLVE,
  soften: FRAG_SOFTEN,
  shade: FRAG_SHADE,
};

function glassPrograms(gl: GlSubstrate): Record<keyof typeof FRAGS, GlProgram> | null {
  const out: Partial<Record<keyof typeof FRAGS, GlProgram>> = {};
  for (const key of Object.keys(FRAGS) as Array<keyof typeof FRAGS>) {
    const prog = gl.program(`glass.${key}`, FRAGS[key]);
    if (!prog) return null;
    out[key] = prog;
  }
  return out as Record<keyof typeof FRAGS, GlProgram>;
}

function glRender(inputs: GlassInputs, p: GlassParams): CanvasRegion | null {
  const sub = acquireGl();
  if (!sub) return null;
  const { gl } = sub;
  const programs = glassPrograms(sub);
  if (!programs) return null;

  const { width: w, height: h } = inputs;
  const q = p.quality;
  const qw = Math.max(1, Math.round(w * q));
  const qh = Math.max(1, Math.round(h * q));
  const out = sub.output(qw, qh);
  const targets = sub.targets(3, qw, qh);
  if (!targets) return null;

  const edgeOnly = p.edgeOnly || !inputs.backdrop;
  const back = edgeOnly ? inputs.layer : inputs.backdrop!;
  const wantFrost = !edgeOnly && p.frost > 0.4;
  const frost = wantFrost ? blurred("frost", back, w, h, p.frost) : back;

  if (!sub.upload(0, inputs.layer) || !sub.upload(1, back) || !sub.upload(2, frost)) return null;

  const bind = (prog: GlProgram) => prog.use();
  const bindTarget = (unit: number, t: GlTarget) => sub.bind(unit, t);
  const drawTo = (t: GlTarget | null) => sub.drawTo(t);

  // Everything below is in FIELD px (the quality-scaled buffer).
  const reach = Math.max(2, p.reach * q);
  const fieldTexel: [number, number] = [1 / qw, 1 / qh];

  // 1. Seeds.
  let src = targets[0]!;
  let dst = targets[1]!;
  {
    const loc = bind(programs.seed);
    gl.uniform1i(loc("uLayer"), 0);
    gl.uniform2f(loc("uFieldTexel"), fieldTexel[0], fieldTexel[1]);
    gl.uniform1f(loc("uCoverage"), p.coverage);
    drawTo(src);
  }
  // 2. Jump flood, strides halving from the reach down to 1 (+1 to tidy).
  {
    const loc = bind(programs.jfa);
    gl.uniform1i(loc("uSeeds"), 4);
    gl.uniform2f(loc("uFieldTexel"), fieldTexel[0], fieldTexel[1]);
    const steps: number[] = [];
    for (let st = Math.pow(2, Math.floor(Math.log2(reach))); st >= 1; st /= 2) steps.push(st);
    steps.push(1);
    for (const st of steps) {
      bindTarget(4, src);
      gl.uniform1f(loc("uStep"), st);
      drawTo(dst);
      [src, dst] = [dst, src];
    }
  }
  // 3. Resolve to direction + distance.
  {
    const loc = bind(programs.resolve);
    bindTarget(4, src);
    gl.uniform1i(loc("uSeeds"), 4);
    gl.uniform1i(loc("uLayer"), 0);
    gl.uniform2f(loc("uFieldTexel"), fieldTexel[0], fieldTexel[1]);
    gl.uniform1f(loc("uReach"), reach);
    gl.uniform1f(loc("uCoverage"), p.coverage);
    drawTo(dst);
    [src, dst] = [dst, src];
  }
  // 4. Soften the direction across corners.
  const softenPx = p.soften * q;
  if (softenPx >= 0.75) {
    const loc = bind(programs.soften);
    gl.uniform1i(loc("uField"), 4);
    // Two rounds of a 9-tap separable Gaussian — a wider, smoother kernel than
    // one round at twice the stride, for the same four cheap passes.
    const stride = softenPx / 5;
    const spare = targets[2]!;
    for (let round = 0; round < 2; round++) {
      bindTarget(4, src);
      gl.uniform2f(loc("uAxis"), stride / qw, 0);
      drawTo(spare);
      bindTarget(4, spare);
      gl.uniform2f(loc("uAxis"), 0, stride / qh);
      drawTo(dst);
      [src, dst] = [dst, src];
    }
  }

  // 5. Shade.
  {
    const loc = bind(programs.shade);
    bindTarget(3, src);
    gl.uniform1i(loc("uLayer"), 0);
    gl.uniform1i(loc("uBack"), 1);
    gl.uniform1i(loc("uFrost"), 2);
    gl.uniform1i(loc("uField"), 3);
    gl.uniform2f(loc("uFieldSize"), qw, qh);
    gl.uniform1f(loc("uReach"), reach);
    gl.uniform1f(loc("uDepth"), p.depth * q);
    gl.uniform1f(loc("uRefraction"), p.refraction);
    gl.uniform1f(loc("uIor"), p.ior);
    gl.uniform1f(loc("uDispersion"), p.dispersion);
    gl.uniform1f(loc("uFrostMix"), wantFrost ? 1 : 0);
    gl.uniform1f(loc("uMix"), p.mix);
    gl.uniform1f(loc("uCoverage"), p.coverage);
    gl.uniform1f(loc("uInset"), p.insetPx * q);
    gl.uniform1f(loc("uPaint"), p.paint);
    gl.uniform1i(loc("uProfile"), PROFILE_INDEX[p.profile]);
    const tint = rgb01(p.tintColor);
    gl.uniform3fv(loc("uTint"), tint.rgb);
    gl.uniform1f(loc("uTintAmt"), p.tint * tint.a);
    gl.uniform1f(loc("uSaturation"), p.saturation);
    gl.uniform1f(loc("uBrightness"), p.brightness);
    gl.uniform2f(loc("uLight"), p.light[0], p.light[1]);
    const lc = rgb01(p.lightColor);
    gl.uniform1f(loc("uLightI"), p.lightIntensity * lc.a);
    gl.uniform1f(loc("uSplay"), p.splay);
    gl.uniform3fv(loc("uLightColor"), lc.rgb);
    gl.uniform1f(loc("uNoise"), p.noise);
    gl.uniform1f(loc("uNoiseScale"), p.noiseScale);
    gl.uniform1f(loc("uRipple"), p.ripple);
    gl.uniform1f(loc("uRippleScale"), p.rippleScale);
    gl.uniform1f(loc("uPhase"), p.phase);
    gl.uniform1f(loc("uEdgeOnly"), edgeOnly ? 1 : 0);
    // Null target: the substrate clears the shared output canvas before the
    // final pass, so whatever the previous client left in it can never show
    // through a glass card's transparent regions.
    drawTo(null);
  }
  return out;
}

// ── CPU fallback ─────────────────────────────────────────────────────────────
// The same model in straight JS, for machines without WebGL2 (or after a lost
// context): core's exact distance transform stands in for the jump flood, the
// direction is the field's gradient. Materially slower — `quality` matters
// more here — but a frame that renders slowly still beats one that renders
// wrong. No directional smear and no corner soften; the shape is the same.

function cpuRender(inputs: GlassInputs, p: GlassParams): HTMLCanvasElement | null {
  const { width: w, height: h } = inputs;
  const q = p.quality;
  const qw = Math.max(1, Math.round(w * q));
  const qh = Math.max(1, Math.round(h * q));

  const layer = scratch("cpu-layer", qw, qh);
  layer.ctx.drawImage(inputs.layer, 0, 0, qw, qh);
  const edgeOnly = p.edgeOnly || !inputs.backdrop;
  const backSrc = edgeOnly ? inputs.layer : inputs.backdrop!;
  const back = blurred("cpu-back", backSrc, qw, qh, edgeOnly ? 0 : p.frost * q);

  let L: ImageData;
  let B: ImageData;
  try {
    L = layer.ctx.getImageData(0, 0, qw, qh);
    B = back.getContext("2d")!.getImageData(0, 0, qw, qh);
  } catch {
    return null; // tainted canvas — nothing sensible to draw
  }
  const ld = L.data;
  const bd = B.data;
  const inside = new Uint8Array(qw * qh);
  for (let i = 0; i < qw * qh; i++) inside[i] = ld[i * 4 + 3]! / 255 / p.coverage > 0.5 ? 1 : 0;
  const reach = Math.max(2, p.reach * q);
  const field = signedDistanceField(inside, qw, qh, reach);

  const out = scratch("cpu-out", qw, qh);
  const O = out.ctx.createImageData(qw, qh);
  const od = O.data;
  const depth = p.depth * q;
  const insetPx = p.insetPx * q;
  const tint = rgb01(p.tintColor);
  const lc = rgb01(p.lightColor);
  const [lx, ly] = p.light;
  const e = 4 + (0.6 - 4) * p.splay;
  const spreadExp = 1.3 + (0.35 - 1.3) * p.splay;

  const sdAt = (x: number, y: number) => field[clampi(y, 0, qh - 1) * qw + clampi(x, 0, qw - 1)]!;

  for (let y = 0; y < qh; y++) {
    for (let x = 0; x < qw; x++) {
      const i = (y * qw + x) * 4;
      const la0 = ld[i + 3]! / 255;
      const sd = sdAt(x, y) - insetPx;
      let m = Math.abs(insetPx) > 0.01 ? smoothstep(-0.7, 0.7, sd) : Math.min(1, la0 / p.coverage);
      m *= p.mix;
      if (m <= 0.001) {
        od[i] = ld[i]!;
        od[i + 1] = ld[i + 1]!;
        od[i + 2] = ld[i + 2]!;
        od[i + 3] = ld[i + 3]!;
        continue;
      }
      // Outward direction = the field's gradient (distance grows inward, so
      // the gradient points in; flip it).
      let dx = -(sdAt(x + 1, y) - sdAt(x - 1, y)) * 0.5;
      let dy = -(sdAt(x, y + 1) - sdAt(x, y - 1)) * 0.5;
      const dl = Math.hypot(dx, dy) || 1;
      dx /= dl;
      dy /= dl;
      const t = depth > 0.5 ? clamp01(sd / depth) : 1;
      const slope = glassBezel(t, p.profile).slope;
      const tiltLen = Math.abs(slope);

      let br = 0;
      let bg = 0;
      let bb = 0;
      let ba = 0;
      if (!edgeOnly) {
        const disp = glassRefract(slope, p.ior) * p.refraction * depth;
        const sx = clampi(Math.round(x - dx * disp), 0, qw - 1);
        const sy = clampi(Math.round(y - dy * disp), 0, qh - 1);
        const j = (sy * qw + sx) * 4;
        br = bd[j]! / 255;
        bg = bd[j + 1]! / 255;
        bb = bd[j + 2]! / 255;
        ba = bd[j + 3]! / 255;
        const lum = br * 0.299 + bg * 0.587 + bb * 0.114;
        br = (lum + (br - lum) * p.saturation) * p.brightness;
        bg = (lum + (bg - lum) * p.saturation) * p.brightness;
        bb = (lum + (bb - lum) * p.saturation) * p.brightness;
        const ta = p.tint * tint.a;
        br += (tint.rgb[0] - br) * ta;
        bg += (tint.rgb[1] - bg) * ta;
        bb += (tint.rgb[2] - bb) * ta;
      }

      const steep = 1 - 1 / Math.sqrt(1 + tiltLen * tiltLen);
      const facing = dx * lx + dy * ly;
      const ang = Math.pow(Math.max(facing, 0), e) + 0.55 * Math.pow(Math.max(-facing, 0), e);
      const hl = Math.min(1.6, p.lightIntensity * lc.a * Math.pow(steep, spreadExp) * ang * (sd > 0 ? 1 : 0));

      const paintA = la0 * p.paint;
      const gA0 = paintA + ba * (1 - paintA);
      const inv = gA0 > 0.0001 ? 1 / gA0 : 0;
      const lr0 = ld[i]! / 255;
      const lg0 = ld[i + 1]! / 255;
      const lb0 = ld[i + 2]! / 255;
      const gr = (gA0 > 0.0001 ? (lr0 * paintA + br * ba * (1 - paintA)) * inv : br) + lc.rgb[0] * hl;
      const gg = (gA0 > 0.0001 ? (lg0 * paintA + bg * ba * (1 - paintA)) * inv : bg) + lc.rgb[1] * hl;
      const gb = (gA0 > 0.0001 ? (lb0 * paintA + bb * ba * (1 - paintA)) * inv : bb) + lc.rgb[2] * hl;
      const gA = clamp01(Math.max(gA0, Math.min(1, hl)));

      od[i] = clamp8((lr0 + (gr - lr0) * m) * 255);
      od[i + 1] = clamp8((lg0 + (gg - lg0) * m) * 255);
      od[i + 2] = clamp8((lb0 + (gb - lb0) * m) * 255);
      od[i + 3] = clamp8((la0 + (gA - la0) * m) * 255);
    }
  }
  out.ctx.putImageData(O, 0, 0);
  return out.canvas;
}

function clampi(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a || 1e-6));
  return t * t * (3 - 2 * t);
}
