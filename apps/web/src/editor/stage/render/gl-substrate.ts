"use client";

import { hasWebGL2 } from "./capabilities";

/**
 * ONE WebGL2 CONTEXT FOR THE WHOLE RENDERER — and the plumbing every pass on
 * it would otherwise write again.
 *
 * ## Why this is a module and not a second context
 *
 * The liquid-glass engine opened a WebGL2 context, compiled programs into it,
 * uploaded a fullscreen triangle and ping-ponged a pair of render targets. The
 * next pass that wants the GPU — goo today, and every per-pixel kernel in
 * `render/passes/` after it — needs exactly those four things and nothing
 * else. Giving each of them its own context does not scale and is not a matter
 * of taste: browsers cap how many WebGL contexts a page may hold (Chrome is
 * around sixteen), and the cap is enforced by SILENTLY KILLING THE OLDEST. So
 * "one context per effect family" does not fail when you add the seventeenth
 * effect; it makes the first one you wrote go black on a board that uses
 * enough of them, which is the least debuggable failure this renderer could
 * have.
 *
 * One context, keyed programs, a shared target pool. A new pass is a fragment
 * shader and a call site.
 *
 * ## What is deliberately NOT here
 *
 * No scheduling, no caching, no notion of what a pass means. This is plumbing
 * — context, compile, quad, textures, targets, draw. Everything above it is
 * the pass's own business, which is what keeps the substrate from growing into
 * a framework that each pass has to be written around.
 *
 * ## Context loss is normal, not exceptional
 *
 * A GPU reset, a laptop switching graphics, a background tab reclaimed: the
 * context goes away and every object in it with it. `acquire()` checks on
 * every call and rebuilds from nothing, and every client is written to fall
 * back to its CPU path when it gets null — which is what `capabilities.ts`
 * exists for and why a pass without a CPU path has no business being here.
 */

export interface GlProgram {
  /**
   * Make this the current program and hand back a uniform lookup.
   *
   * Locations are memoised per program: `getUniformLocation` is a string
   * lookup into the driver, and a shade pass with thirty uniforms called sixty
   * times a second is thirty string lookups per frame for values that cannot
   * move for the life of the program.
   */
  use(): (name: string) => WebGLUniformLocation | null;
}

/**
 * A RECTANGLE OF A CANVAS — what a pass that renders into the shared output
 * hands back. The output only ever grows (see `output`), so a pass's pixels are
 * the corner it was drawn into, not the whole canvas.
 */
export interface CanvasRegion {
  canvas: HTMLCanvasElement;
  sx: number;
  sy: number;
  w: number;
  h: number;
}

/** A whole canvas as a region. */
export const wholeCanvas = (canvas: HTMLCanvasElement): CanvasRegion => ({ canvas, sx: 0, sy: 0, w: canvas.width, h: canvas.height });

/** Draw a region into `dx, dy, dw, dh` (its own size when omitted). */
export function drawRegion(ctx: CanvasRenderingContext2D, r: CanvasRegion, dx: number, dy: number, dw = r.w, dh = r.h): void {
  ctx.drawImage(r.canvas, r.sx, r.sy, r.w, r.h, dx, dy, dw, dh);
}

export interface GlTarget {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
}

/**
 * NEAREST when the texels are DATA (encoded coordinates, indices, anything a
 * blend between two neighbours would corrupt); LINEAR when they are a picture
 * and an interpolated sample is a better answer than the nearest one.
 */
export type GlFilter = "nearest" | "linear";

/**
 * What a target's texels hold. `rgba8` is a picture; `rgba16f` is a SUM —
 * many pictures added at fractional weights, which eight bits would round on
 * every add (see `integrator.ts`). Half floats need `hasFloatAccumulation`.
 */
export type GlFormat = "rgba8" | "rgba16f";

export interface GlSubstrate {
  gl: WebGL2RenderingContext;
  /**
   * Where the final pass renders: a `w x h` corner of the shared output canvas.
   * Shared: a client draws into it and copies out synchronously before
   * returning, so there is never a second reader.
   *
   * The canvas ONLY GROWS. Resizing a WebGL canvas reallocates its drawing
   * buffer and stalls on the GPU, and every glass card or goo layer is its own
   * size — a scene of four glass cards resized it four times a frame, which was
   * the single largest cost of drawing one (measured: 40% of a glass scene).
   */
  output(w: number, h: number): CanvasRegion;
  /** Compile once, keyed. The key is the cache — pass a stable string. */
  program(key: string, frag: string): GlProgram | null;
  /**
   * `count` render targets at `w x h`, ping-pongable.
   *
   * Pooled BY SIZE AND FILTER, not reallocated on every change of either. One
   * pool that resizes itself is right for a single client and wrong the moment
   * there are two: glass wants full-size NEAREST targets (its jump flood rides
   * encoded seed coordinates on RGBA8, and linear interpolation between two
   * encoded seeds is not a seed), while a blur wants a small LINEAR one so the
   * upsample IS the smoothing. Alternating those through one resizing pool
   * would reallocate several megabytes twice per layer per frame.
   *
   * Pools are held for a handful of sizes and the least recently asked-for is
   * dropped, so a stage that zooms through a hundred sizes does not accumulate
   * a hundred pools.
   */
  targets(count: number, w: number, h: number, filter?: GlFilter, format?: GlFormat): GlTarget[] | null;
  /**
   * Point the rasteriser at a buffer of this size.
   *
   * Explicit rather than implied by `drawTo`, because a chain that blurs into a
   * small target and composites into a large one changes viewport mid-pass, and
   * a viewport left at the previous pass's size is the classic "the effect only
   * covers a corner" bug. `output()` sets it for you; every other switch is the
   * caller's to make, which is at least visible in the call order.
   */
  viewport(w: number, h: number): void;
  /**
   * Put an image on a texture unit. False when the source could not be read.
   *
   * `premultiplied` keeps a canvas's own premultiplied texels as they are. The
   * default un-premultiplies on the way in, which is right for a pass that
   * shades straight colour and LOSSY for one that sums light: a 4%-alpha glow
   * texel divided by its alpha in eight bits comes back a different hue.
   */
  upload(unit: number, src: CanvasImageSource, premultiplied?: boolean): boolean;
  /** Put a target's texture on a unit, to read what a previous pass wrote. */
  bind(unit: number, t: GlTarget): void;
  /** Draw the fullscreen triangle into `t`, or into the output canvas for null. */
  drawTo(t: GlTarget | null): void;
}

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

interface TargetPool {
  targets: GlTarget[];
  w: number;
  h: number;
  filter: GlFilter;
  used: number;
}

interface State {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  vert: WebGLShader;
  programs: Map<string, GlProgram>;
  uploads: WebGLTexture[];
  pools: Map<string, TargetPool>;
  useClock: number;
}

/**
 * How many (size, filter) pools may be held before the least recently asked-for
 * goes.
 *
 * It has to comfortably exceed what ONE FRAME asks for, and that is the whole
 * sizing rule. A reduction chain walks a new size per level — eight of them for
 * a wide blur — and glass wants its own on top. With a cap below that total,
 * every pool a frame creates evicts one the SAME frame is about to use again,
 * so each level re-allocates its texture and framebuffer on every single frame:
 * megabytes of `texImage2D` per layer, which shows up as the app stalling for
 * seconds rather than as anything anyone would recognise as a cache being too
 * small.
 */
const MAX_POOLS = 24;

/** `undefined` = never tried; `null` = tried and this machine cannot. */
let state: State | null | undefined;

function build(): State | null {
  // Asked of the ONE capability registry rather than by trying and catching: an
  // engine without WebGL2 must reach its fallback deliberately, not by way of
  // an exception nobody sees. See `capabilities.ts`.
  if (!hasWebGL2()) return null;
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", {
    premultipliedAlpha: true,
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
  });
  if (!gl) return null;

  const vert = gl.createShader(gl.VERTEX_SHADER);
  if (!vert) return null;
  gl.shaderSource(vert, VERT);
  gl.compileShader(vert);
  if (!gl.getShaderParameter(vert, gl.COMPILE_STATUS)) {
    console.error("[gl] vertex", gl.getShaderInfoLog(vert));
    return null;
  }

  // ONE FULLSCREEN TRIANGLE, not a quad. It covers the viewport with three
  // vertices instead of six and has no diagonal seam for the rasteriser to
  // shade twice — the standard trick, and the reason `aPos` runs to 3.
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  return { canvas, gl, vert, programs: new Map(), uploads: [], pools: new Map(), useClock: 0 };
}

function makeTexture(gl: WebGL2RenderingContext, filter: number): WebGLTexture | null {
  const t = gl.createTexture();
  if (!t) return null;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  // Clamped, so a sample taken past the edge repeats the border pixel instead
  // of wrapping the opposite side of the frame into the result — which is what
  // a refracted ray or a blur tap at the rim would otherwise do.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

/**
 * The shared context, or null when this machine (or this moment) has none.
 *
 * Call it at the top of every GPU path and branch on null. It is cheap: the
 * steady state is one `isContextLost()` check.
 */
export function acquireGl(): GlSubstrate | null {
  if (state === undefined) state = build();
  const s = state;
  if (!s) return null;
  if (s.gl.isContextLost()) {
    // Everything in the old context is gone, programs included. Rebuild from
    // scratch on the next call rather than trying to revive handles that are
    // no longer valid — and return null now, so this frame takes the CPU path
    // instead of drawing nothing.
    state = undefined;
    return null;
  }
  const { gl } = s;

  return {
    gl,
    output(w, h) {
      // Grown in 256 px steps, so a card that animates its size does not
      // reallocate on every frame of the animation either.
      if (s.canvas.width < w || s.canvas.height < h) {
        s.canvas.width = Math.max(s.canvas.width, Math.ceil(w / 256) * 256);
        s.canvas.height = Math.max(s.canvas.height, Math.ceil(h / 256) * 256);
      }
      gl.viewport(0, 0, w, h);
      // The viewport's origin is the canvas's BOTTOM-left; in image rows the
      // region is the bottom `h` of the canvas.
      return { canvas: s.canvas, sx: 0, sy: s.canvas.height - h, w, h };
    },
    program(key, frag) {
      const known = s.programs.get(key);
      if (known) return known;
      const f = gl.createShader(gl.FRAGMENT_SHADER);
      const prog = gl.createProgram();
      if (!f || !prog) return null;
      gl.shaderSource(f, frag);
      gl.compileShader(f);
      if (!gl.getShaderParameter(f, gl.COMPILE_STATUS)) {
        console.error(`[gl] ${key}`, gl.getShaderInfoLog(f));
        return null;
      }
      gl.attachShader(prog, s.vert);
      gl.attachShader(prog, f);
      gl.bindAttribLocation(prog, 0, "aPos");
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error(`[gl] ${key}`, gl.getProgramInfoLog(prog));
        return null;
      }
      const loc = new Map<string, WebGLUniformLocation | null>();
      const handle: GlProgram = {
        use() {
          gl.useProgram(prog);
          return (name) => {
            if (!loc.has(name)) loc.set(name, gl.getUniformLocation(prog, name));
            return loc.get(name) ?? null;
          };
        },
      };
      s.programs.set(key, handle);
      return handle;
    },
    targets(count, w, h, filter = "nearest", format = "rgba8") {
      if (w < 1 || h < 1 || count < 1) return null;
      if (format === "rgba16f" && !gl.getExtension("EXT_color_buffer_float")) return null;
      const key = `${w}x${h}:${filter}:${format}`;
      let pool = s.pools.get(key);
      if (!pool) {
        pool = { targets: [], w, h, filter, used: 0 };
        s.pools.set(key, pool);
        // Oldest pool out, and its GPU memory with it — a stage being zoomed
        // asks for a new size every frame, and a pool per size is a leak.
        if (s.pools.size > MAX_POOLS) {
          let oldestKey: string | null = null;
          let oldest = Infinity;
          for (const [k, p] of s.pools) {
            if (k === key || p.used >= oldest) continue;
            oldest = p.used;
            oldestKey = k;
          }
          const victim = oldestKey ? s.pools.get(oldestKey) : null;
          if (oldestKey && victim) {
            for (const t of victim.targets) {
              gl.deleteFramebuffer(t.fbo);
              gl.deleteTexture(t.tex);
            }
            s.pools.delete(oldestKey);
          }
        }
      }
      pool.used = ++s.useClock;
      while (pool.targets.length < count) {
        const tex = makeTexture(gl, filter === "linear" ? gl.LINEAR : gl.NEAREST);
        const fbo = gl.createFramebuffer();
        if (!tex || !fbo) return null;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        if (format === "rgba16f") gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
        else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        pool.targets.push({ tex, fbo });
      }
      return pool.targets.slice(0, count);
    },
    viewport(w, h) {
      gl.viewport(0, 0, w, h);
    },
    upload(unit, src, premultiplied = false) {
      let tex = s.uploads[unit];
      if (!tex) {
        const made = makeTexture(gl, gl.LINEAR);
        if (!made) return false;
        s.uploads[unit] = tex = made;
      }
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiplied);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
      } catch {
        // A tainted or zero-sized source. The caller falls back; it must not
        // throw out of a render.
        return false;
      } finally {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      }
      return true;
    },
    bind(unit, t) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
    },
    drawTo(t) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
      if (!t) {
        // The output canvas keeps whatever the last client left in it, so the
        // final pass of a new one starts from a known-empty frame.
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
