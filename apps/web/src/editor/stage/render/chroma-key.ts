"use client";

/**
 * The headless chroma keyer — pure pixels in, keyed pixels out. One
 * ChromaKeyParams = ONE key color with its own tolerance/softness/spill/
 * feather/choke, applied in stack order (so multiple "Chroma key" cards
 * compose exactly like nodes). Runs on WebGL2 (per-key matte → feather blur →
 * apply passes, all GPU) with a full CPU fallback; "edges only" needs a
 * border flood fill, so any key using it routes the whole clip through the
 * CPU path.
 *
 * Results are cached per clip keyed by (frameKey, params hash): a paused
 * video, a still image, or an idle scrub re-uses the last keyed canvas for
 * free; only a NEW source frame or a settings change re-keys. Preview and
 * export share this module through the one draw path.
 */

export interface ChromaKeyParams {
  /** Key color, 0–255 channels (already resolved from variables). */
  r: number;
  g: number;
  b: number;
  /** 0–100 — chroma distance fully removed. */
  tolerance: number;
  /** 0–100 — fade ramp past tolerance. */
  softness: number;
  /** 0–100 — key-color spill suppression on kept pixels. */
  spill: number;
  /** Matte blur radius in source px. */
  feather: number;
  /** Matte choke after feather (negative grows keep, positive shrinks). */
  choke: number;
  /** Only remove regions connected to the image border (CPU path). */
  edgesOnly: boolean;
  /** Keep only the key color instead of removing it. */
  invert: boolean;
}

/** BT.601 RGB(0..1) → YCbCr(0..1, chroma centered on 0.5). */
function ycc(r: number, g: number, b: number): [number, number, number] {
  return [
    0.299 * r + 0.587 * g + 0.114 * b,
    0.5 - 0.168736 * r - 0.331264 * g + 0.5 * b,
    0.5 + 0.5 * r - 0.418688 * g - 0.081312 * b,
  ];
}

/** Tolerance/softness sliders (0–100) → YCbCr distance units. */
const DIST_SCALE = 0.004;

function paramsHash(keys: ChromaKeyParams[]): string {
  return keys
    .map(
      (k) =>
        `${k.r},${k.g},${k.b},${k.tolerance},${k.softness},${k.spill},` +
        `${k.feather},${k.choke},${k.edgesOnly ? 1 : 0},${k.invert ? 1 : 0}`,
    )
    .join("|");
}

// ── Frame identity ───────────────────────────────────────────────────────────

let srcSeq = 0;
const srcIds = new WeakMap<object, number>();

/**
 * A cache key naming THIS source picture: decoded frames/bitmaps/images get a
 * stable per-object id, live video elements additionally carry their current
 * time (the element object persists while its picture changes).
 */
export function sourceFrameKey(src: CanvasImageSource): string {
  const o = src as object;
  let id = srcIds.get(o);
  if (id === undefined) {
    id = ++srcSeq;
    srcIds.set(o, id);
  }
  return typeof HTMLVideoElement !== "undefined" && src instanceof HTMLVideoElement
    ? `${id}:${src.currentTime.toFixed(3)}`
    : String(id);
}

// ── Result cache (per clip, one frame each — upstream owns frame caches) ─────

interface CacheEntry {
  frameKey: string;
  hash: string;
  canvas: HTMLCanvasElement;
}

const MAX_CLIPS = 24;
const cache = new Map<string, CacheEntry>();

/**
 * Key a source frame for a clip. Returns a canvas with the keyed pixels, or
 * null when the source has no usable dimensions yet.
 */
export function chromaKeyedFrame(
  clipId: string,
  frameKey: string,
  src: CanvasImageSource,
  w: number,
  h: number,
  keys: ChromaKeyParams[],
): HTMLCanvasElement | null {
  if (w <= 0 || h <= 0 || keys.length === 0) return null;
  const hash = paramsHash(keys);
  const hit = cache.get(clipId);
  if (hit && hit.frameKey === frameKey && hit.hash === hash) {
    // LRU touch.
    cache.delete(clipId);
    cache.set(clipId, hit);
    return hit.canvas;
  }

  const out = hit?.canvas ?? document.createElement("canvas");
  if (out.width !== w || out.height !== h) {
    out.width = w;
    out.height = h;
  }
  const octx = out.getContext("2d");
  if (!octx) return null;
  octx.clearRect(0, 0, w, h);

  const needsCpu = keys.some((k) => k.edgesOnly);
  const gl = needsCpu ? null : glProcess(src, w, h, keys);
  if (gl) {
    octx.drawImage(gl, 0, 0);
  } else {
    const img = readSource(src, w, h);
    if (!img) return null;
    cpuProcess(img, keys);
    octx.putImageData(img, 0, 0);
  }

  cache.delete(clipId);
  cache.set(clipId, { frameKey, hash, canvas: out });
  if (cache.size > MAX_CLIPS) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return out;
}

// ── CPU path ─────────────────────────────────────────────────────────────────

let scratch: HTMLCanvasElement | null = null;

function readSource(src: CanvasImageSource, w: number, h: number): ImageData | null {
  scratch ??= document.createElement("canvas");
  if (scratch.width !== w || scratch.height !== h) {
    scratch.width = w;
    scratch.height = h;
  }
  const ctx = scratch.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.clearRect(0, 0, w, h);
  try {
    ctx.drawImage(src, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  } catch {
    return null; // tainted or not-ready source
  }
}

function cpuProcess(img: ImageData, keys: ChromaKeyParams[]): void {
  const { data, width: w, height: h } = img;
  const n = w * h;
  const keep = new Float32Array(n);

  for (const key of keys) {
    const [ky, kcb, kcr] = ycc(key.r / 255, key.g / 255, key.b / 255);
    const tol = key.tolerance * DIST_SCALE;
    const soft = Math.max(key.softness * DIST_SCALE, 0.001);

    for (let i = 0; i < n; i++) {
      const j = i * 4;
      const [y, cb, cr] = ycc(data[j]! / 255, data[j + 1]! / 255, data[j + 2]! / 255);
      const d = Math.hypot(cb - kcb, cr - kcr) + 0.12 * Math.abs(y - ky);
      const t = Math.min(Math.max((d - tol) / soft, 0), 1);
      const m = 1 - t * t * (3 - 2 * t); // 1 = matches key
      keep[i] = key.invert ? m : 1 - m;
    }

    if (key.edgesOnly && !key.invert) restrictToBorder(keep, w, h);
    if (key.feather > 0) blurMatte(keep, w, h, key.feather);
    applyKey(data, keep, n, key);
  }
}

/** Pixels being removed that are NOT connected to the border go back to keep=1. */
function restrictToBorder(keep: Float32Array, w: number, h: number): void {
  const n = w * h;
  const removable = new Uint8Array(n);
  for (let i = 0; i < n; i++) removable[i] = keep[i]! < 0.8 ? 1 : 0;
  const connected = new Uint8Array(n);
  const stack = new Int32Array(n);
  let top = 0;
  const push = (i: number) => {
    if (removable[i] && !connected[i]) {
      connected[i] = 1;
      stack[top++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (top > 0) {
    const i = stack[--top]!;
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < n - w) push(i + w);
  }
  for (let i = 0; i < n; i++) if (keep[i]! < 1 && !connected[i]) keep[i] = 1;
}

/** Two box passes ≈ gaussian, separable, in-place on the matte. */
function blurMatte(keep: Float32Array, w: number, h: number, radius: number): void {
  const r = Math.max(1, Math.round(radius * 0.6));
  const tmp = new Float32Array(keep.length);
  for (let pass = 0; pass < 2; pass++) {
    // Horizontal.
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let x = -r; x <= r; x++) sum += keep[row + Math.min(Math.max(x, 0), w - 1)]!;
      const win = 2 * r + 1;
      for (let x = 0; x < w; x++) {
        tmp[row + x] = sum / win;
        sum += keep[row + Math.min(x + r + 1, w - 1)]! - keep[row + Math.max(x - r, 0)]!;
      }
    }
    // Vertical.
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += tmp[Math.min(Math.max(y, 0), h - 1) * w + x]!;
      const win = 2 * r + 1;
      for (let y = 0; y < h; y++) {
        keep[y * w + x] = sum / win;
        sum += tmp[Math.min(y + r + 1, h - 1) * w + x]! - tmp[Math.max(y - r, 0) * w + x]!;
      }
    }
  }
}

/** Choke remap window for a key: keep' = clamp((keep - lo) / (hi - lo)). */
function chokeWindow(choke: number): [number, number] {
  const ck = choke / 20; // −1..1
  return [Math.max(0, ck) * 0.95, 1 + Math.min(0, ck) * 0.95];
}

function applyKey(data: Uint8ClampedArray, keep: Float32Array, n: number, key: ChromaKeyParams): void {
  const [lo, hi] = chokeWindow(key.choke);
  const range = Math.max(hi - lo, 0.001);
  // Spill suppression direction: the key's chroma vector (skip when keeping
  // the color — suppressing it would erase the very thing kept).
  const [, kcb, kcr] = ycc(key.r / 255, key.g / 255, key.b / 255);
  let dx = kcb - 0.5;
  let dy = kcr - 0.5;
  const len = Math.hypot(dx, dy);
  const spill = key.invert || len < 0.01 ? 0 : key.spill / 100;
  if (len > 0) {
    dx /= len;
    dy /= len;
  }

  for (let i = 0; i < n; i++) {
    const j = i * 4;
    const k = Math.min(Math.max((keep[i]! - lo) / range, 0), 1);
    if (spill > 0 && k > 0) {
      const [y, cb, cr] = ycc(data[j]! / 255, data[j + 1]! / 255, data[j + 2]! / 255);
      const p = Math.max(0, (cb - 0.5) * dx + (cr - 0.5) * dy);
      if (p > 0) {
        const cb2 = cb - 0.5 - dx * p * spill;
        const cr2 = cr - 0.5 - dy * p * spill;
        data[j] = Math.min(Math.max((y + 1.402 * cr2) * 255, 0), 255);
        data[j + 1] = Math.min(Math.max((y - 0.344136 * cb2 - 0.714136 * cr2) * 255, 0), 255);
        data[j + 2] = Math.min(Math.max((y + 1.772 * cb2) * 255, 0), 255);
      }
    }
    data[j + 3] = data[j + 3]! * k;
  }
}

// ── WebGL2 path ──────────────────────────────────────────────────────────────

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const YCC_GLSL = `
vec3 ycc(vec3 c) {
  return vec3(
    dot(c, vec3(0.299, 0.587, 0.114)),
    0.5 - 0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b,
    0.5 + 0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b);
}`;

const MATTE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uImage;
uniform vec3 uKey;
uniform float uTol, uSoft;
uniform bool uInvert;
${YCC_GLSL}
void main() {
  vec3 c = ycc(texture(uImage, vUv).rgb);
  float d = distance(c.yz, uKey.yz) + 0.12 * abs(c.x - uKey.x);
  float m = 1.0 - smoothstep(uTol, uTol + uSoft, d);
  o = vec4(uInvert ? m : 1.0 - m, 0.0, 0.0, 1.0);
}`;

const BLUR_FRAG = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uTex;
uniform vec2 uDir;
uniform float uRadius;
void main() {
  float sig = max(uRadius * 0.5, 0.5);
  float sum = 0.0, wsum = 0.0;
  for (int i = -40; i <= 40; i++) {
    float fi = float(i);
    if (abs(fi) > uRadius) continue;
    float w = exp(-fi * fi / (2.0 * sig * sig));
    sum += texture(uTex, vUv + uDir * fi).r * w;
    wsum += w;
  }
  o = vec4(sum / wsum, 0.0, 0.0, 1.0);
}`;

const APPLY_FRAG = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uImage, uMatte;
uniform vec2 uKeyCC;
uniform float uSpill, uChokeLo, uChokeHi;
uniform bool uPremult;
${YCC_GLSL}
void main() {
  vec4 px = texture(uImage, vUv);
  float keep = clamp((texture(uMatte, vUv).r - uChokeLo) / max(uChokeHi - uChokeLo, 0.001), 0.0, 1.0);
  vec3 c = ycc(px.rgb);
  vec2 cc = c.yz - 0.5;
  float p = max(0.0, dot(cc, uKeyCC));
  cc -= uKeyCC * p * uSpill;
  vec3 rgb = clamp(vec3(
    c.x + 1.402 * cc.y,
    c.x - 0.344136 * cc.x - 0.714136 * cc.y,
    c.x + 1.772 * cc.x), 0.0, 1.0);
  float a = px.a * keep;
  o = uPremult ? vec4(rgb * a, a) : vec4(rgb, a);
}`;

interface GlState {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  matte: WebGLProgram;
  blur: WebGLProgram;
  apply: WebGLProgram;
  srcTex: WebGLTexture;
  /** [imgPing, imgPong, mattePing, mattePong] with matching framebuffers. */
  tex: WebGLTexture[];
  fbo: WebGLFramebuffer[];
  texW: number;
  texH: number;
}

let glState: GlState | null | undefined;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) return null;
  return s;
}

function program(gl: WebGL2RenderingContext, frag: string): WebGLProgram | null {
  const v = compile(gl, gl.VERTEX_SHADER, VERT);
  const f = compile(gl, gl.FRAGMENT_SHADER, frag);
  const p = gl.createProgram();
  if (!v || !f || !p) return null;
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.bindAttribLocation(p, 0, "aPos");
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return null;
  return p;
}

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
  const matte = program(gl, MATTE_FRAG);
  const blur = program(gl, BLUR_FRAG);
  const apply = program(gl, APPLY_FRAG);
  if (!matte || !blur || !apply) return null;

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
  const tex = [mkTex(), mkTex(), mkTex(), mkTex()];
  const fbo = tex.map((t) => {
    const f = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return f;
  });
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { canvas, gl, matte, blur, apply, srcTex, tex, fbo, texW: 0, texH: 0 };
}

/** Run the full per-key pass chain on the GPU. Null on any GL trouble. */
function glProcess(
  src: CanvasImageSource,
  w: number,
  h: number,
  keys: ChromaKeyParams[],
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

  const [IMG_A, IMG_B, MAT_A, MAT_B] = [0, 1, 2, 3];
  const texel = [1 / w, 1 / h];
  let curImage: WebGLTexture = s.srcTex;
  let imgSlot = IMG_A;

  const bindSampler = (p: WebGLProgram, name: string, tex: WebGLTexture, unit: number) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(p, name), unit);
  };

  keys.forEach((key, idx) => {
    const [ky, kcb, kcr] = ycc(key.r / 255, key.g / 255, key.b / 255);

    // 1) Matte pass → MAT_A.
    gl.useProgram(s.matte);
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo[MAT_A]!);
    bindSampler(s.matte, "uImage", curImage, 0);
    gl.uniform3f(gl.getUniformLocation(s.matte, "uKey"), ky, kcb, kcr);
    gl.uniform1f(gl.getUniformLocation(s.matte, "uTol"), key.tolerance * DIST_SCALE);
    gl.uniform1f(
      gl.getUniformLocation(s.matte, "uSoft"),
      Math.max(key.softness * DIST_SCALE, 0.001),
    );
    gl.uniform1i(gl.getUniformLocation(s.matte, "uInvert"), key.invert ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 2) Feather: separable gaussian MAT_A → MAT_B → MAT_A.
    if (key.feather > 0.25) {
      gl.useProgram(s.blur);
      gl.uniform1f(gl.getUniformLocation(s.blur, "uRadius"), Math.min(key.feather, 40));
      gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo[MAT_B]!);
      bindSampler(s.blur, "uTex", s.tex[MAT_A]!, 0);
      gl.uniform2f(gl.getUniformLocation(s.blur, "uDir"), texel[0]!, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo[MAT_A]!);
      bindSampler(s.blur, "uTex", s.tex[MAT_B]!, 0);
      gl.uniform2f(gl.getUniformLocation(s.blur, "uDir"), 0, texel[1]!);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // 3) Apply (spill + choke + alpha) → next image texture, or the screen.
    const last = idx === keys.length - 1;
    gl.useProgram(s.apply);
    gl.bindFramebuffer(gl.FRAMEBUFFER, last ? null : s.fbo[imgSlot]!);
    if (last) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    bindSampler(s.apply, "uImage", curImage, 0);
    bindSampler(s.apply, "uMatte", s.tex[MAT_A]!, 1);
    let dx = kcb - 0.5;
    let dy = kcr - 0.5;
    const len = Math.hypot(dx, dy);
    const spill = key.invert || len < 0.01 ? 0 : key.spill / 100;
    if (len > 0) {
      dx /= len;
      dy /= len;
    }
    gl.uniform2f(gl.getUniformLocation(s.apply, "uKeyCC"), dx, dy);
    gl.uniform1f(gl.getUniformLocation(s.apply, "uSpill"), spill);
    const [lo, hi] = chokeWindow(key.choke);
    gl.uniform1f(gl.getUniformLocation(s.apply, "uChokeLo"), lo);
    gl.uniform1f(gl.getUniformLocation(s.apply, "uChokeHi"), hi);
    gl.uniform1i(gl.getUniformLocation(s.apply, "uPremult"), last ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (!last) {
      curImage = s.tex[imgSlot]!;
      imgSlot = imgSlot === IMG_A ? IMG_B : IMG_A;
    }
  });

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return s.canvas;
}
