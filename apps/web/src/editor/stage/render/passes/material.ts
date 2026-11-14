"use client";

import type { GlassParams } from "@solomotion/core";
import { drawRegion } from "../gl-substrate";
import { renderGlass } from "../glass";
import { nextOutput } from "./buffers";
import type { PassFn } from "./types";

/**
 * MATERIALS — liquid glass, the only card that reads the scene behind the
 * layer.
 *
 * The heaviest single chunk in the app's effect surface: `../glass` is a WebGL
 * pipeline with its own shaders and context management. It is also the one most
 * documents do not use, which is exactly the shape that made the lazy split
 * worth building.
 */

// ── Liquid glass ─────────────────────────────────────────────────────────────
// The engine renders at the card's `quality` scale; the result is blitted back
// up to the pass's device size so the rest of the chain (and `drawImage`, which
// reads the canvas's intrinsic size) never has to know the pass was cheap.
function glassPass(
  src: CanvasImageSource,
  w: number,
  h: number,
  params: GlassParams,
  backdrop: CanvasImageSource | null,
): CanvasImageSource {
  const rendered = renderGlass({ layer: src, backdrop, width: w, height: h }, params);
  const out = nextOutput(w, h);
  if (!rendered) {
    out.ctx.drawImage(src, 0, 0); // no GL, no pixels — pass the layer through
    return out.canvas;
  }
  out.ctx.imageSmoothingQuality = "high";
  drawRegion(out.ctx, rendered, 0, 0, w, h);
  return out.canvas;
}


export const glass: PassFn<"glass"> = (p, src, w, h, env) => glassPass(src, w, h, p.params, env.backdrop);
