"use client";

import { acquireGl, drawRegion, type GlTarget } from "../gl-substrate";

/**
 * GOO, ON THE GPU — the metaball pass as two shaders instead of a loop over
 * two million pixels.
 *
 * ## What was wrong
 *
 * Goo is blur-the-alpha, re-threshold it, keep the original colour where the
 * original was already opaque. Every one of those is a per-pixel operation with
 * no dependency on its neighbours beyond the blur, which is to say: it is a
 * fragment shader, and it was written as `drawImage` → `getImageData` → a JS
 * loop → `putImageData`. At a 1080p-ish buffer that is ~2M iterations of a
 * four-channel loop plus two full readbacks, 30–60ms a frame by construction.
 *
 * It is also why goo and glass together felt categorically worse than either:
 * glass finishes on the GPU, goo pulls the whole surface back to the CPU, and
 * the readback between them stalls the pipeline in both directions. Two passes
 * that are each fine are a hitch when they alternate.
 *
 * ## The blur is where the thought goes
 *
 * A Gaussian large enough to fuse two shapes is tens of pixels of sigma, and a
 * shader cannot afford a tap per pixel of radius. But goo's blur is pure LOW
 * FREQUENCY — it exists to be thresholded, so the only thing that survives is
 * its broad shape. So it is done at a REDUCED SIZE: downsample by roughly
 * sigma/3, run a modest separable Gaussian there, and let the bilinear
 * upsample in the composite pass do the rest of the smoothing. That is the
 * standard trick and it is genuinely free here: the field is being used as a
 * soft mask, not shown.
 *
 * Premultiplied throughout the blur, and that is not optional. Blurring
 * straight RGBA drags the colour of fully transparent pixels into the edge and
 * a goo card gains a dark rim — the same reason the CPU path blurs on a canvas
 * (which is premultiplied internally) rather than over the raw array.
 *
 * ## It reproduces the CPU formula, rather than approximating it
 *
 * The composite shader is the JS loop transcribed: the same smoothstep band,
 * the same `k = srcAlpha` weighting that keeps the original artwork sharp and
 * only melts the bridge the field invented, the same `mix` lerp on both colour
 * and alpha. A machine without WebGL2 takes the untouched CPU path and gets the
 * same picture more slowly, which is what `capabilities.ts` is for.
 */

/**
 * ONE HALVING OF THE FIELD — a 2x2 box average, not a point sample.
 *
 * This distinction is the difference between goo that sits still and goo that
 * crawls. Reducing an image by taking one texel out of every four DISCARDS the
 * other three, so as the artwork moves a fraction of a pixel the surviving
 * texels change, the field changes with them, and the threshold — which turns a
 * smooth field into a hard edge, amplifying anything the field does — makes
 * that flicker into a visibly jittering outline. Averaging instead band-limits
 * the field first, which is the whole reason a reduction chain is built out of
 * halvings rather than one big jump.
 *
 * `uTexel` is the SOURCE's texel size, so the four taps land on the centres of
 * the four source texels this destination texel covers.
 *
 * The first level also premultiplies: everything downstream is a weighted
 * average, and averaging straight colour across an alpha edge drags the colour
 * of transparent pixels into the result — the dark rim a goo card must not have.
 */
const FRAG_DOWN = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uPremultiply;
void main() {
  vec2 d = uTexel * 0.5;
  vec4 a = texture(uSrc, vUv + vec2(-d.x, -d.y));
  vec4 b = texture(uSrc, vUv + vec2( d.x, -d.y));
  vec4 c = texture(uSrc, vUv + vec2(-d.x,  d.y));
  vec4 e = texture(uSrc, vUv + vec2( d.x,  d.y));
  if (uPremultiply > 0.5) {
    a.rgb *= a.a; b.rgb *= b.a; c.rgb *= c.a; e.rgb *= e.a;
  }
  o = (a + b + c + e) * 0.25;
}`;

/**
 * ONE DOUBLING, as a 3x3 tent — and the reason the blob has a smooth outline.
 *
 * A reduced field magnified in one jump is BILINEAR, which is piecewise linear:
 * its slope changes abruptly at every source texel boundary. That is invisible
 * in a picture and glaring here, because the next thing that happens to this
 * field is a THRESHOLD, and a threshold turns a kink in the slope into a kink
 * in the outline. A field reduced sixty-four times and magnified back in one
 * step therefore produced a blob with a faceted, ragged edge — the shape was
 * right and the contour was a polygon.
 *
 * Climbing back the way we came down, filtering at each step, keeps the field
 * smooth enough that the contour is a curve. It is the same chain a bloom uses,
 * for the same reason.
 */
const FRAG_UP = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uSrc;
uniform vec2 uTexel;
void main() {
  vec2 t = uTexel;
  vec4 sum = texture(uSrc, vUv) * 4.0;
  sum += (texture(uSrc, vUv + vec2( t.x, 0.0)) + texture(uSrc, vUv + vec2(-t.x, 0.0))
        + texture(uSrc, vUv + vec2(0.0,  t.y)) + texture(uSrc, vUv + vec2(0.0, -t.y))) * 2.0;
  sum += texture(uSrc, vUv + vec2( t.x,  t.y)) + texture(uSrc, vUv + vec2(-t.x,  t.y))
       + texture(uSrc, vUv + vec2( t.x, -t.y)) + texture(uSrc, vUv + vec2(-t.x, -t.y));
  o = sum / 16.0;
}`;

/**
 * One axis of a separable Gaussian, 13 taps, weights evaluated from the sigma
 * uniform rather than baked — so one program serves every radius instead of a
 * program per radius, which on a keyframeable blur would be a shader compile
 * mid-drag.
 */
const FRAG_BLUR = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uSrc;
uniform vec2 uAxis;
uniform float uSigma;
void main() {
  float s = max(uSigma, 0.0001);
  // Taps at 0.4 sigma apart reach 2.4 sigma at the rim, which holds ~98% of the
  // kernel — past that a Gaussian has nothing left worth a texture fetch.
  float step = s * 0.4;
  vec4 sum = texture(uSrc, vUv);
  float wsum = 1.0;
  for (int i = 1; i <= 6; i++) {
    float d = float(i) * step;
    float w = exp(-0.5 * (d * d) / (s * s));
    vec2 off = uAxis * d;
    sum += (texture(uSrc, vUv + off) + texture(uSrc, vUv - off)) * w;
    wsum += 2.0 * w;
  }
  o = sum / wsum;
}`;

const FRAG_GOO = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uSrc;    // the layer, unpremultiplied
uniform sampler2D uField;  // the blurred field, premultiplied, possibly smaller
uniform float uLo;
uniform float uSpan;
uniform float uMix;
void main() {
  vec4 src = texture(uSrc, vUv);
  vec4 fp = texture(uField, vUv);
  // Back to straight colour, because the CPU formula is written in it and the
  // point of this shader is to be the same arithmetic.
  vec3 fieldRGB = fp.a > 0.0001 ? fp.rgb / fp.a : vec3(0.0);
  float fieldA = fp.a;

  float t = clamp((fieldA - uLo) / uSpan, 0.0, 1.0);
  t = t * t * (3.0 - 2.0 * t); // smoothstep — a straight ramp bands visibly
  float gooA = t;

  // How much of this pixel the ORIGINAL already covered: 1 inside the artwork
  // (keep it verbatim), 0 in the bridge the field invented (take the melt).
  float k = src.a;
  vec3 melted = mix(fieldRGB, src.rgb, k);
  vec3 outRGB = clamp(mix(src.rgb, melted, uMix), 0.0, 1.0);
  float outA = clamp(mix(src.a, gooA, uMix), 0.0, 1.0);
  o = vec4(outRGB * outA, outA);
}`;

export interface GooGpuParams {
  blur: number;
  threshold: number;
  softness: number;
  mix: number;
}

/**
 * Run goo on the GPU into `dst`, or return false if this machine cannot and the
 * CPU path must.
 *
 * Draws into a canvas the CALLER owns rather than returning the substrate's
 * shared output: the pass chain hands its result to the next pass, and the next
 * pass may itself be a GL client that would overwrite the very canvas it was
 * given. One blit to own the pixels is a rounding error next to the readback
 * this whole file exists to delete.
 */
export function gooOnGpu(
  p: GooGpuParams,
  src: CanvasImageSource,
  w: number,
  h: number,
  dst: CanvasRenderingContext2D,
): boolean {
  const sub = acquireGl();
  if (!sub) return false;
  const down = sub.program("goo.down", FRAG_DOWN);
  const up = sub.program("goo.up", FRAG_UP);
  const blur = sub.program("goo.blur", FRAG_BLUR);
  const composite = sub.program("goo.composite", FRAG_GOO);
  if (!down || !up || !blur || !composite) return false;
  const { gl } = sub;

  if (!sub.upload(0, src)) return false;

  // HOW FAR DOWN TO GO. The blur's taps sit 0.4 sigma apart, so they are always
  // well spaced relative to the kernel — but they are only well spaced relative
  // to the IMAGE once sigma is a couple of texels, and a sparse tap on a
  // full-resolution image with hard edges in it reads whatever happens to fall
  // under it. Reduce until sigma is small in texels and the two agree.
  //
  // Halvings rather than one divisor, because each halving is an exact box
  // filter and the chain composes; the floor keeps the field from collapsing
  // to a handful of texels on a very wide blur, where no amount of filtering
  // would put the shape back.
  const sizes: Array<[number, number]> = [[w, h]];
  let sigma = Math.max(0.35, p.blur);
  while (sigma > 2.5) {
    const [pw, ph] = sizes[sizes.length - 1]!;
    const nw = pw >> 1;
    const nh = ph >> 1;
    if (Math.min(nw, nh) < 24 || sizes.length > 8) break;
    sizes.push([nw, nh]);
    sigma /= 2;
  }
  const levels = sizes.length - 1;

  // Slot 0 of each size belongs to the way down, slot 1 to the way back up, so
  // a pass never reads and writes the same texture.
  const slots: Array<[GlTarget, GlTarget]> = [];
  for (const [sw, sh] of sizes) {
    const pair = sub.targets(2, sw, sh, "linear");
    if (!pair) return false;
    slots.push([pair[0]!, pair[1]!]);
  }

  // 1. Down: premultiply on the first step, box-average on every step.
  {
    const loc = down.use();
    if (levels === 0) {
      // Nothing to reduce — the pass still runs, to premultiply.
      sub.viewport(w, h);
      gl.uniform1i(loc("uSrc"), 0);
      gl.uniform2f(loc("uTexel"), 1 / w, 1 / h);
      gl.uniform1f(loc("uPremultiply"), 1);
      sub.drawTo(slots[0]![0]);
    }
    for (let i = 1; i <= levels; i++) {
      const [sw, sh] = sizes[i - 1]!;
      const [dw, dh] = sizes[i]!;
      sub.viewport(dw, dh);
      if (i === 1) {
        gl.uniform1i(loc("uSrc"), 0);
      } else {
        sub.bind(4, slots[i - 1]![0]);
        gl.uniform1i(loc("uSrc"), 4);
      }
      gl.uniform2f(loc("uTexel"), 1 / sw, 1 / sh);
      gl.uniform1f(loc("uPremultiply"), i === 1 ? 1 : 0);
      sub.drawTo(slots[i]![0]);
    }
  }

  // 2. The separable Gaussian, in the reduced buffer.
  {
    const [bw, bh] = sizes[levels]!;
    const [a, b] = slots[levels]!;
    const loc = blur.use();
    sub.viewport(bw, bh);
    gl.uniform1i(loc("uSrc"), 4);
    gl.uniform1f(loc("uSigma"), sigma);
    sub.bind(4, a);
    gl.uniform2f(loc("uAxis"), 1 / bw, 0);
    sub.drawTo(b);
    sub.bind(4, b);
    gl.uniform2f(loc("uAxis"), 0, 1 / bh);
    sub.drawTo(a);
  }

  // 3. Up: back the way we came, filtering at every step, so the contour the
  // threshold is about to cut is a curve and not a polygon.
  let field = slots[levels]![0];
  {
    const loc = up.use();
    for (let i = levels; i >= 1; i--) {
      const [sw, sh] = sizes[i]!;
      const [dw, dh] = sizes[i - 1]!;
      sub.viewport(dw, dh);
      sub.bind(4, field);
      gl.uniform1i(loc("uSrc"), 4);
      gl.uniform2f(loc("uTexel"), 1 / sw, 1 / sh);
      const target = slots[i - 1]![1];
      sub.drawTo(target);
      field = target;
    }
  }

  // 4. Composite at full size, straight onto the output canvas.
  const out = sub.output(w, h);
  {
    const loc = composite.use();
    sub.bind(5, field);
    gl.uniform1i(loc("uSrc"), 0);
    gl.uniform1i(loc("uField"), 5);
    // The threshold band, in 0..1 rather than the CPU path's 0..255. A floor of
    // one alpha step keeps `softness: 0` a clean cut instead of a divide by
    // zero and an aliased edge that crawls.
    gl.uniform1f(loc("uLo"), p.threshold - p.softness);
    gl.uniform1f(loc("uSpan"), Math.max(1 / 255, p.softness * 2));
    gl.uniform1f(loc("uMix"), p.mix);
    sub.drawTo(null);
  }

  dst.setTransform(1, 0, 0, 1, 0, 0);
  dst.clearRect(0, 0, w, h);
  drawRegion(dst, out, 0, 0);
  return true;
}
