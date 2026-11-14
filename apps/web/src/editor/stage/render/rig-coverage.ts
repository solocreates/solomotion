"use client";

import { anchorLocal, clipBox, setRigCoverageProvider, shearPoint, type VisualClip } from "@solomotion/core";
import { planePicture } from "../../world/plane-picture";

/**
 * THE SILHOUETTE A RIG WEIGHTS BY — the opacity of a layer's own picture at a
 * point of its own space, which core cannot see (`setRigCoverageProvider`).
 * Read from the picture the layer shows at its FIRST frame (its rest look, so
 * a playing video or a typing text does not re-weight every frame), at no
 * more than 128 cells a side, once per picture.
 *
 * Installed on import: anything that draws a rig imports the renderer, so the
 * silhouette is there before the first weight is taken.
 */

const ALPHA = new Map<string, { w: number; h: number; a: Uint8ClampedArray }>();
let probe: HTMLCanvasElement | null = null;

function alphaOf(key: string, canvas: HTMLCanvasElement): { w: number; h: number; a: Uint8ClampedArray } {
  const hit = ALPHA.get(key);
  if (hit) return hit;
  const k = Math.min(1, 128 / Math.max(canvas.width, canvas.height, 1));
  const w = Math.max(1, Math.round(canvas.width * k)), h = Math.max(1, Math.round(canvas.height * k));
  probe ??= document.createElement("canvas");
  probe.width = w;
  probe.height = h;
  const ctx = probe.getContext("2d", { willReadFrequently: true })!;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(canvas, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const a = new Uint8ClampedArray(w * h);
  for (let i = 0; i < a.length; i++) a[i] = data[i * 4 + 3]!;
  const out = { w, h, a };
  if (ALPHA.size > 96) ALPHA.delete(ALPHA.keys().next().value!);
  ALPHA.set(key, out);
  return out;
}

setRigCoverageProvider((doc, clip) => {
  if (typeof document === "undefined" || clip.kind === "audio" || clip.kind === "group") return null;
  const frame = doc.frames.find((f) => f.id === clip.frameId);
  if (!frame) return null;
  const pic = planePicture(doc, frame, clip as VisualClip, clip.startMs, 1);
  if (!pic) return null;
  const t = clip.transform;
  const pivot = anchorLocal(t.anchor, clipBox(doc, clip));
  const spanX = Math.max(1e-6, pic.maxX - pic.minX), spanY = Math.max(1e-6, pic.maxY - pic.minY);
  const key = pic.key;
  return {
    key: `${key}|${pivot.x.toFixed(2)},${pivot.y.toFixed(2)}`,
    at(x, y) {
      const q = shearPoint(x - pivot.x, y - pivot.y, t.skewX, t.skewY);
      const g = alphaOf(key, pic.canvas);
      const u = Math.floor(((q.x - pic.minX) / spanX) * g.w), v = Math.floor(((q.y - pic.minY) / spanY) * g.h);
      if (u < 0 || v < 0 || u >= g.w || v >= g.h) return 0;
      return g.a[v * g.w + u]! / 255;
    },
  };
});
