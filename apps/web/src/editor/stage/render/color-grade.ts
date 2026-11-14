"use client";

/**
 * The headless color-grade engine — pure pixels in, graded pixels out. One
 * ColorGradeParams = ONE grading node (lift/gamma/gain trims, white balance,
 * exposure, contrast, hue, saturation, vibrance, intensity mix); a call takes
 * the stack's nodes IN ORDER and runs them as sequential passes, exactly like
 * a node graph. Runs on WebGL2 (params are uniforms — no LUT bake, no result
 * cache: values keyframe per frame for free) with a full CPU fallback sharing
 * the same math. Preview and export share this module through the one draw
 * path. The returned canvas is the engine's scratch — draw it immediately.
 */

export interface ColorGradeParams {
  /** −100..100 warm↔cool, luma-preserving. */
  temperature: number;
  /** −100..100 green↔magenta, luma-preserving. */
  tint: number;
  /** Stops (×2^v). */
  exposure: number;
  /** 1 = neutral, around mid-grey pivot. */
  contrast: number;
  /** 1 = neutral. */
  saturation: number;
  /** −1..1 — boosts muted colors more than saturated ones. */
  vibrance: number;
  hueDeg: number;
  /** 0..1 mix of graded over original. */
  intensity: number;
  /** [r, g, b, master] trims, each −1..1. */
  lift: [number, number, number, number];
  gamma: [number, number, number, number];
  gain: [number, number, number, number];
}

// Rec.601 luma — matches the chroma keyer's color space.
const LUMA = [0.299, 0.587, 0.114] as const;
/** ~18% grey in sRGB — the contrast pivot. */
const PIVOT = 0.4353;
// Wheel-unit → engine-unit scales (full deflection stays cinematic, not nuked).
const LIFT_SCALE = 0.35;
const GAMMA_SCALE = 0.9;
const GAIN_SCALE = 0.75;

/** Per-pass constants both paths consume — ONE place owns the grade math. */
interface GradeUniforms {
  /** White-balance gains with exposure folded in. */
  wb: [number, number, number];
  contrast: number;
  lift: [number, number, number];
  gain: [number, number, number];
  /** Per-channel power exponents. */
  gamma: [number, number, number];
  /** Combined hue-rotate × saturation 3×3 (column-major for GL). */
  mat: Float32Array;
  vibrance: number;
  intensity: number;
}

function computeUniforms(p: ColorGradeParams): GradeUniforms {
  // White balance: warm pushes R over B, tint trades G against magenta; the
  // gains are then normalized to constant luma so balance never re-exposes.
  const t = p.temperature / 100;
  const ti = p.tint / 100;
  let r = 1 + 0.3 * t + 0.06 * ti;
  let g = 1 - 0.2 * ti;
  let b = 1 - 0.3 * t + 0.06 * ti;
  const luma = r * LUMA[0] + g * LUMA[1] + b * LUMA[2];
  const exp = Math.pow(2, p.exposure) / Math.max(luma, 1e-4);
  r *= exp;
  g *= exp;
  b *= exp;

  const trim = (v: [number, number, number, number], scale: number, base: number) =>
    [base + scale * (v[0] + v[3]), base + scale * (v[1] + v[3]), base + scale * (v[2] + v[3])] as [
      number,
      number,
      number,
    ];
  const gammaExp = trim(p.gamma, GAMMA_SCALE, 1).map(
    (d) => 1 / Math.min(Math.max(d, 0.2), 5),
  ) as [number, number, number];

  return {
    wb: [r, g, b],
    contrast: p.contrast,
    lift: trim(p.lift, LIFT_SCALE, 0),
    gain: trim(p.gain, GAIN_SCALE, 1),
    gamma: gammaExp,
    mat: hueSatMatrix(p.hueDeg, p.saturation),
    vibrance: p.vibrance,
    intensity: p.intensity,
  };
}

/** Hue rotation about the grey axis composed with a saturation matrix. */
function hueSatMatrix(hueDeg: number, sat: number): Float32Array {
  const a = (hueDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  // Rodrigues rotation about normalized (1,1,1).
  const k = 1 / 3;
  const rt = Math.sqrt(1 / 3);
  const hue: number[] = [
    c + (1 - c) * k, k * (1 - c) - rt * s, k * (1 - c) + rt * s,
    k * (1 - c) + rt * s, c + (1 - c) * k, k * (1 - c) - rt * s,
    k * (1 - c) - rt * s, k * (1 - c) + rt * s, c + (1 - c) * k,
  ];
  // sat matrix: out = s·c + (1−s)·luma(c)
  const st: number[] = [
    sat + (1 - sat) * LUMA[0], (1 - sat) * LUMA[1], (1 - sat) * LUMA[2],
    (1 - sat) * LUMA[0], sat + (1 - sat) * LUMA[1], (1 - sat) * LUMA[2],
    (1 - sat) * LUMA[0], (1 - sat) * LUMA[1], sat + (1 - sat) * LUMA[2],
  ];
  // m = st × hue (row-major multiply), emitted column-major for uniformMatrix3fv.
  const out = new Float32Array(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      let sum = 0;
      for (let x = 0; x < 3; x++) sum += st[i * 3 + x]! * hue[x * 3 + j]!;
      out[j * 3 + i] = sum;
    }
  return out;
}

/**
 * Grade a source picture through the given nodes in order. Returns the
 * engine's output canvas (valid until the next call), or null when the source
 * isn't usable yet.
 */
export function colorGradedFrame(
  src: CanvasImageSource,
  w: number,
  h: number,
  grades: ColorGradeParams[],
): HTMLCanvasElement | null {
  if (w <= 0 || h <= 0 || grades.length === 0) return null;
  const uniforms = grades.map(computeUniforms);
  const gl = glProcess(src, w, h, uniforms);
  if (gl) return gl;
  return cpuFrame(src, w, h, uniforms);
}

// ── CPU path ─────────────────────────────────────────────────────────────────

let cpuCanvas: HTMLCanvasElement | null = null;

function cpuFrame(
  src: CanvasImageSource,
  w: number,
  h: number,
  uniforms: GradeUniforms[],
): HTMLCanvasElement | null {
  cpuCanvas ??= document.createElement("canvas");
  if (cpuCanvas.width !== w || cpuCanvas.height !== h) {
    cpuCanvas.width = w;
    cpuCanvas.height = h;
  }
  const ctx = cpuCanvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.clearRect(0, 0, w, h);
  try {
    ctx.drawImage(src, 0, 0, w, h);
  } catch {
    return null;
  }
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (const u of uniforms) {
    const m = u.mat;
    for (let i = 0; i < d.length; i += 4) {
      const or = d[i]! / 255;
      const og = d[i + 1]! / 255;
      const ob = d[i + 2]! / 255;
      let r = (or * u.wb[0] - PIVOT) * u.contrast + PIVOT;
      let g = (og * u.wb[1] - PIVOT) * u.contrast + PIVOT;
      let b = (ob * u.wb[2] - PIVOT) * u.contrast + PIVOT;
      r = Math.pow(Math.max(r * u.gain[0] + u.lift[0], 0), u.gamma[0]);
      g = Math.pow(Math.max(g * u.gain[1] + u.lift[1], 0), u.gamma[1]);
      b = Math.pow(Math.max(b * u.gain[2] + u.lift[2], 0), u.gamma[2]);
      // Column-major mat: out = M·c.
      const r2 = m[0]! * r + m[3]! * g + m[6]! * b;
      const g2 = m[1]! * r + m[4]! * g + m[7]! * b;
      const b2 = m[2]! * r + m[5]! * g + m[8]! * b;
      const mx = Math.max(r2, g2, b2);
      const mn = Math.min(r2, g2, b2);
      const vb = 1 + u.vibrance * (1 - (mx - mn) / Math.max(mx, 1e-3));
      const l = r2 * LUMA[0] + g2 * LUMA[1] + b2 * LUMA[2];
      r = l + (r2 - l) * vb;
      g = l + (g2 - l) * vb;
      b = l + (b2 - l) * vb;
      d[i] = clamp255((or + (r - or) * u.intensity) * 255);
      d[i + 1] = clamp255((og + (g - og) * u.intensity) * 255);
      d[i + 2] = clamp255((ob + (b - ob) * u.intensity) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return cpuCanvas;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

// ── WebGL2 path ──────────────────────────────────────────────────────────────

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uImage;
uniform vec3 uWb, uLift, uGain, uGamma;
uniform mat3 uMat;
uniform float uContrast, uVibrance, uIntensity;
uniform bool uPremult;
const vec3 LUMA = vec3(0.299, 0.587, 0.114);
const float PIVOT = ${PIVOT};
void main() {
  vec4 px = texture(uImage, vUv);
  vec3 c0 = px.rgb;
  vec3 c = (c0 * uWb - PIVOT) * uContrast + PIVOT;
  c = pow(max(c * uGain + uLift, 0.0), uGamma);
  c = uMat * c;
  float sat = (max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)))
    / max(max(c.r, max(c.g, c.b)), 1e-3);
  float l = dot(c, LUMA);
  c = l + (c - l) * (1.0 + uVibrance * (1.0 - sat));
  c = clamp(mix(c0, c, uIntensity), 0.0, 1.0);
  o = uPremult ? vec4(c * px.a, px.a) : vec4(c, px.a);
}`;

interface GlState {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  prog: WebGLProgram;
  srcTex: WebGLTexture;
  /** Ping-pong textures with matching framebuffers for multi-node chains. */
  tex: WebGLTexture[];
  fbo: WebGLFramebuffer[];
  texW: number;
  texH: number;
}

let glState: GlState | null | undefined;

function initGl(): GlState | null {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", {
    premultipliedAlpha: true,
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
  });
  if (!gl) return null;
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  };
  const v = compile(gl.VERTEX_SHADER, VERT);
  const f = compile(gl.FRAGMENT_SHADER, FRAG);
  const prog = gl.createProgram();
  if (!v || !f || !prog) return null;
  gl.attachShader(prog, v);
  gl.attachShader(prog, f);
  gl.bindAttribLocation(prog, 0, "aPos");
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const mkTex = () => {
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  const srcTex = mkTex();
  const tex = [mkTex(), mkTex()];
  const fbo = tex.map((t) => {
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return fb;
  });
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { canvas, gl, prog, srcTex, tex, fbo, texW: 0, texH: 0 };
}

function glProcess(
  src: CanvasImageSource,
  w: number,
  h: number,
  uniforms: GradeUniforms[],
): HTMLCanvasElement | null {
  if (glState === undefined) glState = initGl();
  const s = glState;
  if (!s || s.gl.isContextLost()) return null;
  const { gl } = s;

  if (s.canvas.width !== w || s.canvas.height !== h) {
    s.canvas.width = w;
    s.canvas.height = h;
  }
  if (s.texW !== w || s.texH !== h) {
    for (const t of s.tex) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    s.texW = w;
    s.texH = h;
  }
  gl.viewport(0, 0, w, h);
  gl.disable(gl.BLEND);

  gl.bindTexture(gl.TEXTURE_2D, s.srcTex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
  } catch {
    return null;
  } finally {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  gl.useProgram(s.prog);
  const loc = (name: string) => gl.getUniformLocation(s.prog, name);
  let cur: WebGLTexture = s.srcTex;
  uniforms.forEach((u, idx) => {
    const last = idx === uniforms.length - 1;
    const slot = idx % 2;
    gl.bindFramebuffer(gl.FRAMEBUFFER, last ? null : s.fbo[slot]!);
    if (last) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, cur);
    gl.uniform1i(loc("uImage"), 0);
    gl.uniform3fv(loc("uWb"), u.wb);
    gl.uniform3fv(loc("uLift"), u.lift);
    gl.uniform3fv(loc("uGain"), u.gain);
    gl.uniform3fv(loc("uGamma"), u.gamma);
    gl.uniformMatrix3fv(loc("uMat"), false, u.mat);
    gl.uniform1f(loc("uContrast"), u.contrast);
    gl.uniform1f(loc("uVibrance"), u.vibrance);
    gl.uniform1f(loc("uIntensity"), u.intensity);
    gl.uniform1i(loc("uPremult"), last ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!last) cur = s.tex[slot]!;
  });

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return s.canvas;
}
