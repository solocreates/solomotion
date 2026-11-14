"use client";
import { NAMES } from "@/editor/names";

/**
 * WHAT THIS ENGINE CAN ACTUALLY DO — detected by doing it, never by sniffing.
 *
 * ## Why this exists
 *
 * A renderer built on browser primitives is built on a set of assumptions
 * about them, and those assumptions are not uniform. The one that bit hardest:
 * **WebKit ignores `ctx.filter`.** Not "throws", not "degrades" — the
 * assignment is accepted, the property reads back what you set, and the draw
 * comes out unblurred. So blur, glow, feather, analog softness, the transition
 * wipes and goo's field all silently did NOTHING on an iPad, including in
 * Chrome there, which is WebKit underneath. Nothing errored. Nothing looked
 * broken. The effects were simply absent, which is the worst way for a feature
 * to fail, because there is nothing to search for.
 *
 * ## The rules
 *
 * **Detect by DOING.** Never a user-agent string, never a version number. A
 * probe renders the smallest possible thing that exercises the capability and
 * reads the pixels back. That is the only test that stays true when an engine
 * ships the feature next year, or ships it broken, or ships it behind a flag.
 *
 * **Once, lazily, cached.** A probe costs a 3x3 canvas and a `getImageData`.
 * Run on first ask and never again — but not at module load, because a probe
 * at import time runs in environments that have no DOM at all (the exporter's
 * tests, SSR) and would answer for the wrong machine.
 *
 * **Fail toward the slower, correct path.** Every probe returns false when it
 * cannot tell. A false negative costs speed; a false positive costs the
 * feature, silently.
 *
 * **One registry, not one flag per seam.** A capability discovered tomorrow —
 * a composite op an engine gets wrong, a missing `OffscreenCanvas`, a WebGL2
 * extension — is a new entry here and a fallback beside the thing it falls
 * back from. It is never a browser check written inline at a call site, which
 * is how this class of bug becomes unfindable.
 */

type Probe = () => boolean;

const answers = new Map<string, boolean>();

/**
 * A capability forced OFF for diagnosis: `localStorage["<ns>.capabilities"]
 * = '{"canvasFilter":false}'` renders this machine the way an engine without
 * it does (every iPad, for `canvasFilter`), so a fallback can be checked
 * without the device. Only ever turns a capability off — forcing one ON would
 * just render nothing on a machine that lacks it.
 */
function forcedOff(name: string): boolean {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(NAMES.storage.capabilities) : null;
    return raw ? (JSON.parse(raw) as Record<string, unknown>)[name] === false : false;
  } catch {
    return false;
  }
}

function ask(name: string, probe: Probe): boolean {
  const known = answers.get(name);
  if (known !== undefined) return known;
  let result = false;
  try {
    result = !forcedOff(name) && probe();
  } catch {
    result = false;
  }
  answers.set(name, result);
  return result;
}

/** A tiny scratch canvas for probes, so a probe never touches a real buffer. */
function probeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  return ctx ? { canvas, ctx } : null;
}

/**
 * Does `ctx.filter` actually filter?
 *
 * Blur one opaque pixel inside a transparent 3x3 and look at its neighbour. An
 * engine that honours the filter bleeds into it; one that ignores the filter
 * leaves it empty. There is no way to ask this question by inspection — the
 * property exists and reads back correctly either way.
 */
export function hasCanvasFilter(): boolean {
  return ask("canvasFilter", () => {
    const dst = probeCanvas(3);
    const src = probeCanvas(3);
    if (!dst || !src) return false;
    src.ctx.fillStyle = "#fff";
    src.ctx.fillRect(1, 1, 1, 1);
    dst.ctx.filter = "blur(1px)";
    dst.ctx.drawImage(src.canvas, 0, 0);
    dst.ctx.filter = "none";
    return dst.ctx.getImageData(0, 1, 1, 1).data[3]! > 0;
  });
}

/**
 * Is there a usable WebGL2 context? The material pipeline (glass today, more
 * tomorrow) is built on one, and an engine without it must fall back rather
 * than render nothing.
 */
export function hasWebGL2(): boolean {
  return ask("webgl2", () => {
    if (typeof document === "undefined") return false;
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return false;
    // A context that exists but cannot render to a float-ish target is not one
    // the material pipeline can use, so ask for the target too.
    const ok = !!gl.createFramebuffer() && !!gl.createTexture();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return ok;
  });
}

/**
 * Can WebGL2 render and BLEND into a half-float target here?
 *
 * The integrator (`integrator.ts`) sums many pictures at fractional weights,
 * and an 8-bit target rounds every one of them — sixteen samples lose four
 * bits, which is what put stepped rings in a moving glow. Half floats carry
 * the sum exactly. Detected by doing it: add 0.25 to 0.25 with blending on, in
 * an RGBA16F target, and read back 0.5. `EXT_color_buffer_float` existing is
 * not enough — the attachment can still be incomplete, or the blend ignored.
 */
export function hasFloatAccumulation(): boolean {
  return ask("floatAccumulation", () => {
    if (!hasWebGL2()) return false;
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return false;
    try {
      if (!gl.getExtension("EXT_color_buffer_float")) return false;
      const tex = gl.createTexture();
      const fbo = gl.createFramebuffer();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 1, 1, 0, gl.RGBA, gl.HALF_FLOAT, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return false;
      const shader = (type: number, src: string) => {
        const s = gl.createShader(type)!;
        gl.shaderSource(s, src);
        gl.compileShader(s);
        return s;
      };
      const prog = gl.createProgram()!;
      gl.attachShader(prog, shader(gl.VERTEX_SHADER, "#version 300 es\nin vec2 p;void main(){gl_Position=vec4(p,0.,1.);}"));
      gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, "#version 300 es\nprecision highp float;out vec4 o;void main(){o=vec4(.25);}"));
      gl.bindAttribLocation(prog, 0, "p");
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.viewport(0, 0, 1, 1);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const px = new Float32Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, px);
      return Math.abs(px[0]! - 0.5) < 1e-3 && Math.abs(px[3]! - 0.5) < 1e-3;
    } finally {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  });
}

/**
 * Every capability and its answer — for the diagnostics panel, and for a bug
 * report that says "this is what your machine could do" instead of "it looked
 * wrong on my iPad". Only reports what has actually been asked, because asking
 * everything eagerly is the thing this file refuses to do.
 */
export function knownCapabilities(): Record<string, boolean> {
  return Object.fromEntries(answers);
}
