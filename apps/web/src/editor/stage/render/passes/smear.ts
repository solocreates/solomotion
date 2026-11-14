"use client";

import { smearInFloat } from "../integrator";
import { acquireTemp, releaseTemp, type Buf } from "./buffers";

/**
 * THE SMEAR — an image averaged over a continuous family of transforms, with
 * no visible copies at any size.
 *
 * Every effect that smears a picture along a path — zoom blur (scale about a
 * point), spin blur (rotation), directional blur and long shadow
 * (translation), light rays (scale, under a decay) — used to do it the naive
 * way: draw the image N times, a fixed N. N copies spread over a fixed FRACTION
 * of the layer are spaced by `travel / N` PIXELS, and travel grows with the
 * buffer — a bigger layer, a higher zoom, a denser display, a source parked
 * far off the layer all made it larger. Past a pixel or two the copies stop
 * blending and read as separate ghosts: light rays came out as distinct waves
 * instead of a falloff, worst exactly where the shaft was longest. A hard edge
 * (a shape cut by a frame or comp edge) shows it hardest, because each copy
 * repeats that edge.
 *
 * The fix is not a bigger N. It is spacing samples by PIXELS, and getting
 * there in log time: average the image with itself moved half the extent,
 * then that result with itself moved a quarter, and so on. After K passes it
 * holds 2^K evenly spaced samples. K is chosen from the pixel travel, so the
 * gap between neighbours never exceeds a pixel, whatever the resolution,
 * zoom, layer size or machine. A 450px zoom blur is 9 draws instead of 32
 * ghosted ones.
 *
 * It works because every family here COMPOSES BY ADDING ITS PARAMETER: scaling
 * by Mᵃ then Mᵇ about one point is Mᵃ⁺ᵇ, and turns and shifts add the same way.
 * A family is "apply the transform at parameter u to this context", with u in
 * units of the whole extent.
 */
export type SmearFamily = (ctx: CanvasRenderingContext2D, u: number) => void;

/** Past this the samples are a quarter-pixel apart on a 16k buffer. */
const MAX_PASSES = 12;

/** Doubling passes that keep neighbouring samples within `gapPx` over `travelPx`. */
export function smearPasses(travelPx: number, gapPx = 1): number {
  if (!(travelPx > gapPx)) return 0;
  return Math.min(MAX_PASSES, Math.ceil(Math.log2(travelPx / gapPx)));
}

/**
 * `src` averaged over the family across u ∈ [u0, u0 + 1). `travelPx` is how
 * far the farthest pixel moves across that whole range. Each sample sits at
 * the centre of its share of the range, so u0 = −0.5 gives a smear centred on
 * the image and a travel under a pixel gives back `src` itself, unmoved.
 *
 * Returns a scratch buffer the caller releases.
 */
export function smear(src: CanvasImageSource, w: number, h: number, family: SmearFamily, travelPx: number, u0 = 0): Buf {
  const passes = smearPasses(travelPx);
  if (passes > 0) {
    // The same doubling, summed in float where the GPU can — one rounding for
    // the whole chain instead of two per pass (see `smearInFloat`).
    const out = acquireTemp(w, h);
    const steps = Array.from({ length: passes }, (_, i) => familyMatrix(family, 2 ** -(i + 1)));
    if (smearInFloat(src, w, h, familyMatrix(family, u0 + 2 ** -(passes + 1)), steps, out.ctx)) return out;
    releaseTemp(out);
  }
  let cur = acquireTemp(w, h);
  family(cur.ctx, u0 + 2 ** -(passes + 1));
  cur.ctx.drawImage(src, 0, 0);
  cur.ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (let k = 1; k <= passes; k++) {
    // An AVERAGE of premultiplied pixels is half of each, added — `lighter`
    // at alpha ½. Source-over would weight the copy by its own alpha and dim
    // every soft edge on each pass.
    const next = acquireTemp(w, h);
    next.ctx.globalCompositeOperation = "lighter";
    next.ctx.globalAlpha = 0.5;
    next.ctx.drawImage(cur.canvas, 0, 0);
    family(next.ctx, 2 ** -k);
    next.ctx.drawImage(cur.canvas, 0, 0);
    next.ctx.setTransform(1, 0, 0, 1, 0, 0);
    next.ctx.globalAlpha = 1;
    next.ctx.globalCompositeOperation = "source-over";
    releaseTemp(cur);
    cur = next;
  }
  return cur;
}

/** A family's transform at `u`, as a matrix — what a GPU pass places by. */
let probe: CanvasRenderingContext2D | null = null;
function familyMatrix(family: SmearFamily, u: number): DOMMatrix {
  probe ??= document.createElement("canvas").getContext("2d")!;
  probe.setTransform(1, 0, 0, 1, 0, 0);
  family(probe, u);
  return probe.getTransform();
}

/** Scale about (cx, cy) by `factor`ᵘ. */
export function scaleFamily(cx: number, cy: number, factor: number): SmearFamily {
  const ln = Math.log(Math.max(1e-6, factor));
  return (ctx, u) => {
    const s = Math.exp(ln * u);
    ctx.translate(cx, cy);
    ctx.scale(s, s);
    ctx.translate(-cx, -cy);
  };
}

/** Turn about (cx, cy) by `angle`·u radians. */
export function rotateFamily(cx: number, cy: number, angle: number): SmearFamily {
  return (ctx, u) => {
    ctx.translate(cx, cy);
    ctx.rotate(angle * u);
    ctx.translate(-cx, -cy);
  };
}

/** Shift by (dx, dy)·u. */
export function shiftFamily(dx: number, dy: number): SmearFamily {
  return (ctx, u) => ctx.translate(dx * u, dy * u);
}

/** The farthest any buffer pixel sits from (cx, cy) — the radius a scale or turn moves most. */
export function farthestCorner(cx: number, cy: number, w: number, h: number): number {
  return Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
}
