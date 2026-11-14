"use client";

import {
  maskCoverage,
  locateClip,
  referenceKey,
  resolveReference,
  resolveRegion,
  type MotionDocument,
  type Frame,
  type PaintScope,
  type RegionMask,
  type ResolvedReference,
} from "@solomotion/core";
import { drawFrameContent } from "../stage/render/draw-frame";

/**
 * THE REGION PIPELINE — one place turns a paint scope into a stencil, and
 * everything that needs one asks here.
 *
 *   reference ──► referenceRaster()  cached pixels of the artwork you draw against
 *                        │
 *   seed point ──────────┴──► resolveRegion()  core's flood (gap closing, expand, invert)
 *                                    │
 *                                    ├──► stencilCanvas()   an alpha mask a stroke composites through
 *                                    └──► traceRegion()     a real outline (vector fill, preview)
 *
 * The bucket, "paint inside", "paint outside" and the fill PREVIEW all enter
 * here, which is the only way the outline a person sees under the cursor can be
 * trusted to be the shape that lands when they press.
 *
 * ── Why the cache is the interesting part ───────────────────────────────────
 *
 * The expensive step is rasterizing the reference: a full comp draw at frame
 * resolution, which is milliseconds, not microseconds. It happens on every
 * stroke start under a confine, and on every pointer MOVE while the bucket
 * hovers. Recomputing it each time would make the preview the slowest thing on
 * the canvas.
 *
 * So the raster is memoised on the facts that can change it, and the document
 * store is immer — structurally shared — which means a referenced clip's object
 * IDENTITY is an exact, free content stamp. If nothing in the reference
 * changed, the same objects come back and the cached bitmap is still true. No
 * revision counters to bump, nothing to remember to invalidate, and a stroke on
 * an unrelated layer costs nothing.
 *
 * One entry, deliberately: the reference is a single thing you are working
 * against, and a map keyed by scope would keep whole frame-sized bitmaps alive
 * for references nobody is using any more.
 */

/** The rasterized reference, and the facts that produced it. */
interface RasterEntry {
  frameId: string;
  key: string;
  timeMs: number;
  width: number;
  height: number;
  /** Identity of every clip that went in — the content stamp (see above). */
  stamp: readonly unknown[];
  pixels: ImageData;
}

let cached: RasterEntry | null = null;

/**
 * The comp's own frame grid quantises time before anything is drawn
 * (`drawFrameContent`), so two playhead positions inside one frame are the same
 * picture. Rounding here is what stops a 2px pointer wobble from re-rendering
 * the reference sixty times a second while nothing on screen has changed.
 */
const TIME_BUCKET_MS = 8;

function sameStamp(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Drop the cached bitmap — for a surface whose pixels changed under us. */
export function invalidateReferenceRaster(): void {
  cached = null;
  stencilCache = null;
}

/**
 * The reference's pixels at this instant, drawn once and reused.
 *
 * `transparent` is not optional: the artboard background is not paint, and
 * sampling it makes every fill "succeed" by flooding the whole canvas rectangle.
 */
export function referenceRaster(
  doc: MotionDocument,
  frame: Frame,
  timeMs: number,
  scope: PaintScope,
  /**
   * Clips to leave OUT of the picture — in practice, the layer this gesture is
   * about to paint into.
   *
   * Your own marks must never become the boundary that confines you. Without
   * this, the second stroke into a shape is bounded by the first: the region
   * shrinks with every stroke and the tool appears to change its mind about
   * where you are allowed to paint. It is the "it keeps switching its
   * playground" complaint, and it is why a hover — taken before the stroke —
   * could look right while the stroke that followed behaved differently.
   */
  exclude: readonly string[] = [],
): { pixels: ImageData; reference: ResolvedReference; drawn: readonly string[] } {
  const reference = resolveReference(doc, frame.id, scope.refs);
  const skip = exclude.length > 0 ? new Set(exclude) : null;
  const visible = skip ? reference.clipIds.filter((id) => !skip.has(id)) : reference.clipIds;
  const key = `${referenceKey(scope.refs)}#${exclude.join(",")}`;
  const bucket = Math.round(timeMs / TIME_BUCKET_MS) * TIME_BUCKET_MS;
  const stamp = reference.clips;

  if (
    cached &&
    cached.frameId === frame.id &&
    cached.key === key &&
    cached.timeMs === bucket &&
    cached.width === frame.width &&
    cached.height === frame.height &&
    sameStamp(cached.stamp, stamp)
  ) {
    return { pixels: cached.pixels, reference, drawn: visible };
  }

  const canvas = document.createElement("canvas");
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  drawFrameContent(ctx, doc, frame, timeMs, {
    transparent: true,
    // An explicit reference draws EXACTLY those layers; an empty one is the
    // whole picture, which is what `only: null` already means to the renderer.
    // An exclusion forces the explicit form either way — "everything except
    // this" is only expressible as a list.
    only: scope.refs.length > 0 || skip ? new Set(visible) : null,
  });
  const pixels = ctx.getImageData(0, 0, frame.width, frame.height);
  cached = {
    frameId: frame.id,
    key,
    timeMs: bucket,
    width: frame.width,
    height: frame.height,
    stamp,
    pixels,
  };
  return { pixels, reference, drawn: visible };
}

/**
 * Does a mask group's stencil actually cover this point?
 *
 * The question behind "can this confined stroke join the layer that is already
 * selected". Being inside SOME mask group is not enough — paint inside one
 * shape, then start a stroke inside a different one while that first layer is
 * still selected, and the new mark lands in the first container where its own
 * stencil clips it away entirely. It vanishes, and nothing on screen says why.
 *
 * Answered by rendering the stencils and reading one pixel, which is the only
 * test that is uniform across every kind of clip a stencil can be: a traced
 * path from `contain`, or a copy of text, media or a nested comp from `track`.
 * A geometric hit test would work for the first and quietly guess at the rest.
 *
 * Its own cache slot, deliberately separate from the reference raster's — they
 * are different pictures asked for in the same breath, and one entry shared
 * between them would thrash on every stroke.
 */
let stencilCache: RasterEntry | null = null;

export function stencilCoversPoint(
  doc: MotionDocument,
  frame: Frame,
  timeMs: number,
  stencilIds: readonly string[],
  /** Frame-centre coordinates. */
  point: { x: number; y: number },
): boolean {
  if (stencilIds.length === 0) return false;
  const key = [...stencilIds].sort().join("|");
  const bucket = Math.round(timeMs / TIME_BUCKET_MS) * TIME_BUCKET_MS;
  const stamp = stencilIds.map((id) => locateClip(doc, id)?.clip);
  if (stamp.some((c) => !c)) return false;

  let entry = stencilCache;
  if (
    !entry ||
    entry.frameId !== frame.id ||
    entry.key !== key ||
    entry.timeMs !== bucket ||
    entry.width !== frame.width ||
    entry.height !== frame.height ||
    !sameStamp(entry.stamp, stamp)
  ) {
    const canvas = document.createElement("canvas");
    canvas.width = frame.width;
    canvas.height = frame.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    // `includeHidden` because a stencil is CONSUMED by its group — it is not
    // painted, so the ordinary draw would skip it and every test would say
    // "not covered".
    drawFrameContent(ctx, doc, frame, timeMs, {
      transparent: true,
      only: new Set(stencilIds),
      includeHidden: true,
    });
    entry = {
      frameId: frame.id,
      key,
      timeMs: bucket,
      width: frame.width,
      height: frame.height,
      stamp,
      pixels: ctx.getImageData(0, 0, frame.width, frame.height),
    };
    stencilCache = entry;
  }

  const x = Math.round(point.x + frame.width / 2);
  const y = Math.round(point.y + frame.height / 2);
  if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) return false;
  // Any real alpha counts: a feathered stencil's edge is still inside it.
  return entry.pixels.data[(y * frame.width + x) * 4 + 3]! > 8;
}

/** Frame-centre coordinates → the reference raster's pixel grid. */
export function seedInRaster(p: { x: number; y: number }, frame: Frame): { x: number; y: number } {
  return { x: p.x + frame.width / 2, y: p.y + frame.height / 2 };
}

/**
 * The region a scope resolves to from one seed point, in frame pixels.
 *
 * `confine: "outside"` inverts it; `"off"` is not this function's business —
 * a caller with no confinement should not be computing a stencil at all, which
 * is what `scopeNeedsRegion` is for.
 *
 * Comes back with TWO layer lists, and they answer different questions:
 *
 *  - `reference.clipIds` — what the scope NAMES. With no explicit reference
 *    that is every visible layer in the comp, exclusions and all.
 *  - `drawn` — what actually went into the picture this region was flooded on.
 *    The exclusion is already taken out, so this is the honest answer to "what
 *    gave this region its edges", and it is what a caller must consult before
 *    WRITING into a layer. The bucket does: a pour may not be appended to
 *    artwork that bounded it, or filling one face of a drawing rewrites the
 *    drawing. Asking `clipIds` instead would have refused every layer in the
 *    comp, including the fill layer pours are supposed to accumulate in.
 */
export function regionAt(
  doc: MotionDocument,
  frame: Frame,
  timeMs: number,
  scope: PaintScope,
  seed: { x: number; y: number },
  opts: { invert?: boolean; global?: boolean; exclude?: readonly string[] } = {},
): { mask: RegionMask | null; reference: ResolvedReference; drawn: readonly string[] } {
  const { pixels, reference, drawn } = referenceRaster(doc, frame, timeMs, scope, opts.exclude);
  const s = seedInRaster(seed, frame);
  const mask = resolveRegion(pixels.data, frame.width, frame.height, s.x, s.y, {
    tolerance: scope.tolerance,
    closeGapPx: scope.closeGapPx,
    expandPx: scope.expandPx,
    global: opts.global,
    invert: opts.invert,
  });
  return { mask, reference, drawn };
}

/**
 * A region as a WHITE alpha stencil on a frame-sized canvas.
 *
 * White, and composited with `destination-in`, because that is the one
 * operation that works identically for a brush stroke buffer, a bucket's flood
 * and a live preview: whatever is in the buffer keeps the stencil's alpha and
 * loses the rest. Feather rides along as coverage, so a soft-edged confine and
 * a hard one differ by a number rather than by a code path.
 */
export function stencilCanvas(mask: RegionMask, featherPx = 0): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = mask.width;
  canvas.height = mask.height;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(mask.width, mask.height);
  const cov = maskCoverage(mask, featherPx);
  for (let i = 0; i < cov.length; i++) {
    const a = cov[i]!;
    if (a === 0) continue;
    const o = i * 4;
    img.data[o] = 255;
    img.data[o + 1] = 255;
    img.data[o + 2] = 255;
    img.data[o + 3] = a;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** A region as a solid colour on a frame-sized canvas — the bucket's paint. */
export function fillCanvas(mask: RegionMask, color: string, featherPx = 0): HTMLCanvasElement {
  const canvas = stencilCanvas(mask, featherPx);
  const ctx = canvas.getContext("2d")!;
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}
