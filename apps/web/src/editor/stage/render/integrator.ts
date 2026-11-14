"use client";

import type { ShutterExposure } from "@solomotion/core";
import { hasFloatAccumulation } from "./capabilities";
import { acquireGl, drawRegion, type GlProgram, type GlSubstrate, type GlTarget } from "./gl-substrate";
import { acquireTemp, releaseTemp } from "./passes/buffers";

/**
 * THE ONE WAY TO SUM PICTURES — many images at fractional weights, rounded to
 * eight bits exactly once.
 *
 * Motion blur is an integral: N pictures of a layer across the shutter, each
 * weighted, summed. The obvious canvas implementation draws each one into an
 * RGBA8 buffer at `globalAlpha = weight` with `lighter`, and that rounds EVERY
 * sample to a whole level before it is added. Sixteen samples at 1/16 each lose
 * four bits: a soft glow's falloff, which spends a level every few pixels,
 * comes back as stepped rings, and because R, G, B and A round independently
 * the rings change hue. That was the "you can see the edges of the glow" in
 * every moving glow, blurred shape and low-opacity layer an export had.
 *
 * So the sum is never held in eight bits. On the GPU it accumulates in a
 * half-float target (exact for any weight a shutter uses); without one it
 * accumulates in a Float32Array on the CPU. Either way the finished frame —
 * crisp and smear mixed by the shares core's `shutterExposure` hands over — is
 * quantised once, on the way out, which is the only rounding a picture should
 * ever have.
 *
 * Everything is premultiplied end to end: textures are uploaded without the
 * un-premultiply WebGL defaults to (dividing a 4%-alpha texel by its alpha in
 * eight bits is its own hue shift), and the sum of premultiplied pixels is the
 * physical one — colour and coverage mix together.
 */

export interface Placement {
  weight: number;
  /** Source image px → integration px. */
  place: DOMMatrix;
}

export interface Integrator {
  /**
   * ONE picture at many placements — the pose tiers bank a single render and
   * re-place it per sample. Uploaded once, drawn per placement.
   */
  addPlacements(src: HTMLCanvasElement, placements: readonly Placement[]): void;
  /** One picture in place — the content tier's per-sample render. */
  addPicture(src: HTMLCanvasElement, weight: number): void;
  /**
   * `crisp · C + smear · Σ`, rounded once, drawn into `dst` at (0, 0, w, h) in
   * its CURRENT transform. Ends the integration and frees what it held.
   */
  resolveInto(dst: CanvasRenderingContext2D, crisp: HTMLCanvasElement | null, exposure: Pick<ShutterExposure, "crisp" | "smear">): void;
}

type Combine = ShutterExposure["combine"];

/** Start summing `w x h` pictures. GPU half floats where the probe says they work, CPU floats otherwise. */
export function beginIntegration(w: number, h: number, combine: Combine): Integrator {
  return gpuIntegrator(w, h, combine) ?? cpuIntegrator(w, h, combine);
}

// ── GPU: half-float accumulation on the shared substrate ─────────────────────

const PLACE_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform mat3 uInv;
uniform vec2 uSrcSize;
uniform float uDstH;
uniform float uWeight;
out vec4 o;
void main() {
  // Fragment → integration image px (top-left origin) → source image px.
  vec2 p = vec2(gl_FragCoord.x, uDstH - gl_FragCoord.y);
  vec2 q = (uInv * vec3(p, 1.0)).xy;
  if (q.x < 0.0 || q.y < 0.0 || q.x > uSrcSize.x || q.y > uSrcSize.y) { o = vec4(0.0); return; }
  o = texture(uSrc, vec2(q.x / uSrcSize.x, 1.0 - q.y / uSrcSize.y)) * uWeight;
}`;

const RESOLVE_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uSum;
uniform sampler2D uCrisp;
uniform vec2 uSize;
uniform float uSmear;
uniform float uCrispShare;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec4 c = texture(uSum, uv) * uSmear;
  if (uCrispShare > 0.0) c += texture(uCrisp, uv) * uCrispShare;
  c = clamp(c, 0.0, 1.0);
  // Still a premultiplied colour, whatever a look's pile-up did to it.
  o = vec4(min(c.rgb, vec3(c.a)), c.a);
}`;

/** GPU texture units: the picture being added, and the sum being read back. */
const SRC_UNIT = 0;
const SUM_UNIT = 1;

interface GpuKit {
  g: GlSubstrate;
  place: GlProgram;
  resolve: GlProgram;
}

function gpuKit(): GpuKit | null {
  const g = hasFloatAccumulation() ? acquireGl() : null;
  if (!g) return null;
  const place = g.program("integrator.place", PLACE_FRAG);
  const resolve = g.program("integrator.resolve", RESOLVE_FRAG);
  return place && resolve ? { g, place, resolve } : null;
}

function clearTarget(k: GpuKit, t: GlTarget, w: number, h: number): void {
  const { gl } = k.g;
  gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
  k.g.viewport(w, h);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
}

/**
 * Add whatever picture sits on `SRC_UNIT` (`srcW x srcH`) into `target`, once
 * per placement, at its weight, combined by `combine`. Leaves blending off.
 */
function drawPlacements(
  k: GpuKit,
  target: GlTarget,
  w: number,
  h: number,
  srcW: number,
  srcH: number,
  placements: readonly Placement[],
  combine: Combine,
): void {
  const { g } = k;
  const { gl } = g;
  const u = k.place.use();
  gl.uniform1i(u("uSrc"), SRC_UNIT);
  gl.uniform2f(u("uSrcSize"), srcW, srcH);
  gl.uniform1f(u("uDstH"), h);
  g.viewport(w, h);
  gl.enable(gl.BLEND);
  if (combine === "max") {
    gl.blendEquation(gl.MAX);
  } else {
    gl.blendEquation(gl.FUNC_ADD);
    if (combine === "screen") gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    else gl.blendFunc(gl.ONE, gl.ONE);
  }
  for (const p of placements) {
    if (p.weight <= 0) continue;
    const inv = p.place.inverse();
    if (!Number.isFinite(inv.a) || !Number.isFinite(inv.e)) continue;
    // Column-major: x' = a·x + c·y + e, y' = b·x + d·y + f.
    gl.uniformMatrix3fv(u("uInv"), false, [inv.a, inv.b, 0, inv.c, inv.d, 0, inv.e, inv.f, 1]);
    gl.uniform1f(u("uWeight"), p.weight);
    g.drawTo(target);
  }
  // Every other client of the substrate assumes the default blend state.
  gl.disable(gl.BLEND);
  gl.blendEquation(gl.FUNC_ADD);
  gl.blendFunc(gl.ONE, gl.ZERO);
}

/** `crisp · (SRC_UNIT) + smear · sum`, rounded once, drawn into `dst` at (0, 0, w, h). */
function resolveTarget(k: GpuKit, sum: GlTarget, w: number, h: number, crispShare: number, smearShare: number, dst: CanvasRenderingContext2D): void {
  const { g } = k;
  const { gl } = g;
  const u = k.resolve.use();
  g.bind(SUM_UNIT, sum);
  gl.uniform1i(u("uSum"), SUM_UNIT);
  gl.uniform1i(u("uCrisp"), SRC_UNIT);
  gl.uniform2f(u("uSize"), w, h);
  gl.uniform1f(u("uSmear"), smearShare);
  gl.uniform1f(u("uCrispShare"), crispShare);
  const out = g.output(w, h);
  g.drawTo(null);
  // The output canvas is shared: copied out now, before any other pass runs.
  drawRegion(dst, out, 0, 0, w, h);
}

function gpuIntegrator(w: number, h: number, combine: Combine): Integrator | null {
  const k = gpuKit();
  if (!k) return null;
  // Re-asked on every add: another GPU pass may run between two adds (the
  // content tier renders the layer there), and asking marks the pool used.
  const sum = () => k.g.targets(1, w, h, "nearest", "rgba16f")?.[0] ?? null;
  const first = sum();
  if (!first) return null;
  clearTarget(k, first, w, h);

  const add = (src: HTMLCanvasElement, placements: readonly Placement[]) => {
    const target = sum();
    if (!target || !k.g.upload(SRC_UNIT, src, true)) return;
    drawPlacements(k, target, w, h, src.width, src.height, placements, combine);
  };

  return {
    addPlacements: add,
    addPicture: (src, weight) => add(src, [{ weight, place: new DOMMatrix() }]),
    resolveInto(dst, crisp, exposure) {
      const target = sum();
      if (!target) return;
      const crispShare = crisp && exposure.crisp > 0 ? exposure.crisp : 0;
      if (crispShare > 0 && !k.g.upload(SRC_UNIT, crisp!, true)) return;
      resolveTarget(k, target, w, h, crispShare, exposure.smear, dst);
    },
  };
}

/**
 * THE SMEAR'S DOUBLING, IN FLOAT. `src` placed at `first`, then averaged with
 * itself moved by each of `steps` in turn — 2^K samples in K passes (see
 * `passes/smear.ts`) — and drawn into `dst` at (0, 0, w, h).
 *
 * Each 8-bit pass rounds twice, so a nine-pass light ray or zoom blur carried
 * a few levels of error through every soft falloff: banding in exactly the
 * effects that exist to be soft. Ping-ponged through two half-float targets,
 * the whole chain is rounded once. False when this machine has no float path;
 * the caller keeps its 8-bit chain for that.
 */
export function smearInFloat(
  src: CanvasImageSource,
  w: number,
  h: number,
  first: DOMMatrix,
  steps: readonly DOMMatrix[],
  dst: CanvasRenderingContext2D,
): boolean {
  const k = gpuKit();
  // LINEAR: each pass samples the previous one at a sub-pixel transform.
  const pair = k?.g.targets(2, w, h, "linear", "rgba16f");
  if (!k || !pair || !k.g.upload(SRC_UNIT, src, true)) return false;
  let [cur, next] = pair as [GlTarget, GlTarget];
  clearTarget(k, cur, w, h);
  drawPlacements(k, cur, w, h, w, h, [{ weight: 1, place: first }], "sum");
  const still = new DOMMatrix();
  for (const step of steps) {
    clearTarget(k, next, w, h);
    k.g.bind(SRC_UNIT, cur);
    drawPlacements(k, next, w, h, w, h, [{ weight: 0.5, place: still }, { weight: 0.5, place: step }], "sum");
    [cur, next] = [next, cur];
  }
  resolveTarget(k, cur, w, h, 0, 1, dst);
  return true;
}

// ── CPU: Float32 accumulation ────────────────────────────────────────────────

function cpuIntegrator(w: number, h: number, combine: Combine): Integrator {
  const acc = new Float32Array(w * h * 4);

  const accumulate = (data: Uint8ClampedArray, weight: number) => {
    for (let i = 0; i < acc.length; i += 4) {
      const a = data[i + 3]!;
      if (a === 0 && combine !== "max") continue;
      // ImageData is straight alpha; the sum is premultiplied.
      const k = (weight * a) / (255 * 255);
      const x0 = data[i]! * k;
      const x1 = data[i + 1]! * k;
      const x2 = data[i + 2]! * k;
      const x3 = (weight * a) / 255;
      if (combine === "sum") {
        acc[i] = acc[i]! + x0;
        acc[i + 1] = acc[i + 1]! + x1;
        acc[i + 2] = acc[i + 2]! + x2;
        acc[i + 3] = acc[i + 3]! + x3;
      } else if (combine === "screen") {
        acc[i] = acc[i]! + x0 - acc[i]! * x0;
        acc[i + 1] = acc[i + 1]! + x1 - acc[i + 1]! * x1;
        acc[i + 2] = acc[i + 2]! + x2 - acc[i + 2]! * x2;
        acc[i + 3] = acc[i + 3]! + x3 - acc[i + 3]! * x3;
      } else {
        acc[i] = Math.max(acc[i]!, x0);
        acc[i + 1] = Math.max(acc[i + 1]!, x1);
        acc[i + 2] = Math.max(acc[i + 2]!, x2);
        acc[i + 3] = Math.max(acc[i + 3]!, x3);
      }
    }
  };

  const add = (src: HTMLCanvasElement, placements: readonly Placement[]) => {
    const tmp = acquireTemp(w, h);
    for (const p of placements) {
      if (p.weight <= 0) continue;
      tmp.ctx.setTransform(1, 0, 0, 1, 0, 0);
      tmp.ctx.clearRect(0, 0, w, h);
      tmp.ctx.setTransform(p.place);
      tmp.ctx.drawImage(src, 0, 0);
      accumulate(tmp.ctx.getImageData(0, 0, w, h).data, p.weight);
    }
    releaseTemp(tmp);
  };

  return {
    addPlacements: add,
    addPicture: (src, weight) => add(src, [{ weight, place: new DOMMatrix() }]),
    resolveInto(dst, crisp, exposure) {
      const out = acquireTemp(w, h);
      const crispShare = crisp && exposure.crisp > 0 ? exposure.crisp : 0;
      let c: Uint8ClampedArray | null = null;
      if (crispShare > 0) {
        out.ctx.drawImage(crisp!, 0, 0);
        c = out.ctx.getImageData(0, 0, w, h).data;
      }
      const img = out.ctx.createImageData(w, h);
      const d = img.data;
      for (let i = 0; i < acc.length; i += 4) {
        let a = acc[i + 3]! * exposure.smear;
        let r = acc[i]! * exposure.smear;
        let gg = acc[i + 1]! * exposure.smear;
        let b = acc[i + 2]! * exposure.smear;
        if (c) {
          const ca = c[i + 3]! / 255;
          const k = (crispShare * ca) / 255;
          r += c[i]! * k;
          gg += c[i + 1]! * k;
          b += c[i + 2]! * k;
          a += crispShare * ca;
        }
        a = Math.min(1, a);
        if (a <= 0) continue;
        // Back to straight alpha for ImageData — the one rounding.
        d[i] = Math.round((Math.min(r, a) / a) * 255);
        d[i + 1] = Math.round((Math.min(gg, a) / a) * 255);
        d[i + 2] = Math.round((Math.min(b, a) / a) * 255);
        d[i + 3] = Math.round(a * 255);
      }
      out.ctx.putImageData(img, 0, 0);
      dst.drawImage(out.canvas, 0, 0);
      releaseTemp(out);
    },
  };
}
