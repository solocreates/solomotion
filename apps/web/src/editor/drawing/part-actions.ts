"use client";

import {
  basisOfTransform,
  canMergeParts,
  clipsInGroup,
  groupOfClip,
  ungroupClips,
  createRasterClip,
  isPartGroup,
  locateClip,
  mapLocal,
  nestClips,
  nestNewClips,
  partsOf,
  reconcileFillClips,
  replaceClipInPlace,
  separateInkRegions,
  type MotionDocument,
  type DocumentStore,
  type RasterClip,
  type RasterRegion,
} from "@solomotion/core";
import { COMPOSITE } from "../stage/render/draw-frame";
import { placeClip } from "@solomotion/core";
import {
  deleteSurfaces,
  surfaceCanvas,
  surfaceInk,
  surfacePixels,
  writeSurface,
} from "./raster-store";
import { toast } from "@/lib/toast";

/**
 * PARTS — the document half of "a pixel layer made of pieces".
 *
 * The routing rule and every query live in core (`drawing/pieces.ts`); this
 * file is the small set of things that need the app: a surface id, a canvas to
 * composite pixels on, the store to write through.
 *
 * Nothing here invents structure. A separated drawing is a NESTED CLIP whose
 * source comp holds one raster clip per piece — the same one-container shape
 * `promotePathClip` produces for vectors, built with the same primitive
 * (`nestNewClips`). There is deliberately no group in it: a group inside a
 * nested clip is two containers describing one thing, and it is why stepping
 * into a split drawing used to show a group that would not open.
 *
 * The only genuinely new arithmetic is in `mergeParts`, which has to put
 * several surfaces onto one.
 */

/* ------------------------------------------------------------------ separate */

/**
 * SEPARATE A PAINT LAYER — split its ink into a part per piece, then give the
 * parts their own timeline.
 *
 * This is the pixel twin of `promotePathClip`, and deliberately the same word,
 * icon and place: artwork that is several things wearing one layer becomes a
 * nested comp with one row each. What differs is only how the pieces are found
 * — a path lists its subpaths, a bitmap has its ink read (`separateInkRegions`).
 *
 * Each part is cropped to its OWN region, so a Separate makes a drawing
 * smaller: five marks on a full canvas stop being five full canvases. The
 * pixels are copied through a mask rather than re-rendered, so what you drew is
 * exactly what lands — no resampling, no softening, at any zoom.
 *
 * Precomposing afterwards is `nestClips`, the same call precomposing anything
 * else makes. A bespoke "explode a paint layer" verb would be a second thing to
 * keep working the next time nesting changes.
 */
export const PARTS_TAG = "paint-parts";

/**
 * HOW MANY PIECES THIS LAYER WOULD SPLIT INTO — the honest answer to "should
 * the Separate button be here", cached on the one fact that can change it.
 *
 * Counting means scanning the layer's alpha, which is a real cost to pay on
 * every selection change. It is paid ONCE per layer per paint revision:
 * `surfaceId + rev` is an exact content stamp (the revision is bumped inside
 * the same document update as every committed stroke), so a cached count is
 * either still true or not found.
 *
 * Offering the command and then refusing it was the alternative, and it is
 * worse than either: a button that appears on everything and answers "nothing
 * to separate" half the time teaches people not to trust the toolbar.
 */
const partCountCache = new Map<string, number>();

export function separablePartCount(doc: MotionDocument, clipId: string): number {
  const clip = locateClip(doc, clipId)?.clip;
  if (isPartGroup(doc, clip)) return clipsInGroup(doc, clip.id).length;
  if (clip?.kind !== "raster") return 0;
  const key = `${clip.surfaceId}@${clip.rev}`;
  const had = partCountCache.get(key);
  if (had !== undefined) return had;
  const pixels = surfacePixels(clip);
  // Still streaming in: unknown, and not cached — ask again once it lands.
  if (!pixels) return 0;
  const n = separateInkRegions(pixels, clip.width, clip.height).length;
  // One entry per layer, not per revision: the old counts are dead the moment a
  // stroke lands, and a map that only grows is a leak with a nice name.
  for (const k of partCountCache.keys()) {
    if (k.startsWith(`${clip.surfaceId}@`)) partCountCache.delete(k);
  }
  partCountCache.set(key, n);
  return n;
}

export function separateParts(store: DocumentStore, clipId: string): void {
  const doc = store.getState();
  const clip = locateClip(doc, clipId)?.clip;

  // A legacy GROUP of parts (the old shape): give it the one container it
  // should have had. Precomposing a group moves the group; the parts are what
  // belong inside, so they are what gets nested.
  if (isPartGroup(doc, clip)) {
    const ids = clipsInGroup(doc, clip.id);
    if (ids.length < 2) {
      toast("Nothing to separate — this layer is one part");
      return;
    }
    store.update("Separate parts", (d: MotionDocument) => {
      nestClips(d, [...ids], clip.name || "Parts");
    });
    return;
  }

  if (clip?.kind !== "raster") {
    toast("Separate needs a pixel layer");
    return;
  }
  const pixels = surfacePixels(clip);
  if (!pixels) {
    toast("This layer is still loading");
    return;
  }
  const regions = separateInkRegions(pixels, clip.width, clip.height);
  partCountCache.set(`${clip.surfaceId}@${clip.rev}`, regions.length);
  if (regions.length < 2) {
    toast(regions.length === 0 ? "Nothing painted to separate" : "This drawing is one piece");
    return;
  }

  // Cut every piece FIRST, outside the document update: writing surfaces is a
  // side effect, and a half-written split behind a failed update would leave
  // pixels nothing points at.
  const cut = regions.map((region, i) => {
    const w = region.bounds.x1 - region.bounds.x0;
    const h = region.bounds.y1 - region.bounds.y0;
    const part = createRasterClip({
      frameId: clip.frameId,
      width: w,
      height: h,
      startMs: clip.startMs,
      durationMs: clip.durationMs,
      fillDuration: clip.fillDuration,
      name: `${clip.name || "Pixel layer"} ${i + 1}`,
    });
    // WHERE THE PIECE SITS. Its surface is a window onto the original's, so its
    // centre is the window's centre in the original's own coordinates, carried
    // through the layer's pose — which is what keeps a separated drawing
    // exactly where it was, on a rotated or scaled layer too.
    const basis = basisOfTransform(clip.transform, {
      width: clip.width,
      height: clip.height,
      cx: 0,
      cy: 0,
    });
    const o = mapLocal(
      region.bounds.x0 + w / 2 - clip.width / 2,
      region.bounds.y0 + h / 2 - clip.height / 2,
      basis,
    );
    part.transform = {
      ...clip.transform,
      x: clip.transform.x + o.x,
      y: clip.transform.y + o.y,
      anchor: { x: 0.5, y: 0.5 },
    };
    part.opacity = clip.opacity;
    part.blendMode = clip.blendMode;
    writeSurface(part.surfaceId, w, h, (ctx) => {
      ctx.putImageData(maskedCrop(pixels, clip.width, region, w, h), 0, 0);
    });
    return part;
  });

  const name = clip.name || "Paint";
  store.update("Separate parts", (d: MotionDocument) => {
    // ALREADY INSIDE a separated drawing: the pieces are siblings here. No
    // second container — one level per split, exactly as the vector side does
    // it. (A group INSIDE a nested clip was the old shape, and it is why
    // stepping in showed a group that would not open: two containers describing
    // one thing, neither of them the one the UI expected.)
    const home = d.frames.find((f) => f.id === clip.frameId);
    if (home?.sourceTag === PARTS_TAG) {
      replaceClipInPlace(d, clipId, cut);
      return;
    }
    // The parts are BORN inside the new comp and it takes the layer's own slot,
    // so the parent never grows a lane per part only to have it emptied. This
    // is the same primitive `promotePathClip` uses — one layer in, one out.
    const nestedId = nestNewClips(d, clip.frameId, cut, { name, slotClipId: clipId });
    const nested = nestedId ? locateClip(d, nestedId)?.clip : null;
    if (nested?.kind !== "nested") return;
    nested.name = name;
    for (const part of cut) {
      const live = locateClip(d, part.id)?.clip;
      // The parts span their comp and follow when it is trimmed.
      if (live) live.fillDuration = true;
    }
    reconcileFillClips(d, nested.sourceFrameId);
    const frame = d.frames.find((f) => f.id === nested.sourceFrameId);
    if (frame) {
      // Stamped, so "am I already inside a separated drawing" above, the
      // breadcrumb and a later split all read it the same way.
      frame.sourceTag = PARTS_TAG;
      frame.name = name;
    }
  });
  deleteSurfaces([clip.surfaceId]);
}

/** One region's pixels, cropped to its box and cut to its own mask. */
function maskedCrop(
  pixels: Uint8ClampedArray,
  srcWidth: number,
  region: RasterRegion,
  w: number,
  h: number,
): ImageData {
  const out = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    const sy = region.bounds.y0 + y;
    for (let x = 0; x < w; x++) {
      const si = sy * srcWidth + region.bounds.x0 + x;
      if (!region.mask[si]) continue;
      const s = si * 4;
      const d = (y * w + x) * 4;
      out.data[d] = pixels[s]!;
      out.data[d + 1] = pixels[s + 1]!;
      out.data[d + 2] = pixels[s + 2]!;
      out.data[d + 3] = pixels[s + 3]!;
    }
  }
  return out;
}

/* --------------------------------------------------------------------- merge */

/**
 * MERGE — many parts become one surface.
 *
 * Every part is composited into a new buffer sized to the union of what the
 * parts actually have INK in, not to the union of their boxes: a part is
 * allowed slack (it grows in blocks), and merging is the moment to give that
 * slack back rather than to add it all up.
 *
 * Opacity and blend mode are BAKED, because after the merge there is no second
 * layer left to apply them to. That is the honest cost of flattening and it is
 * why merge is a deliberate command rather than something the brush does on
 * your behalf.
 *
 * Rotated and sheared parts are refused (`canMergeParts`): getting their pixels
 * onto a shared grid means resampling them, and a drawing that comes back
 * softer every time you tidy the layer list is a bad trade. Rotate the group.
 */
export function mergeParts(store: DocumentStore, clipIds: readonly string[]): void {
  const doc = store.getState();
  if (!canMergeParts(doc, clipIds)) {
    toast("Merge needs two or more upright pixel layers");
    return;
  }
  const parts = clipIds
    .map((id) => locateClip(doc, id)?.clip)
    .filter((c): c is RasterClip => c?.kind === "raster");

  // Z-ORDER IS THE STACK, and it has to be read from the document rather than
  // from the selection: parts are composited bottom-up, and a selection made by
  // shift-clicking is in click order. Merging in the wrong order silently
  // reorders artwork that was already stacked the way somebody wanted it.
  const lane = new Map<string, number>(doc.tracks.map((t, i) => [t.id, i] as const));
  const ordered = [...parts].sort((a, b) => {
    const la = lane.get(locateClip(doc, a.id)!.track.id) ?? 0;
    const lb = lane.get(locateClip(doc, b.id)!.track.id) ?? 0;
    return lb - la; // tracks[0] is the TOP of the stack, so bottom-first is descending
  });

  // Each part's ink, in frame-centre coordinates.
  const placed = ordered.map((clip) => {
    const ink = surfaceInk(clip);
    const basis = basisOfTransform(clip.transform, {
      width: clip.width,
      height: clip.height,
      cx: 0,
      cy: 0,
    });
    const at = (sx: number, sy: number) => {
      const o = mapLocal(sx - clip.width / 2, sy - clip.height / 2, basis);
      return { x: clip.transform.x + o.x, y: clip.transform.y + o.y };
    };
    const box = ink ? { a: at(ink.x0, ink.y0), b: at(ink.x1 + 1, ink.y1 + 1) } : null;
    return { clip, basis, at, box };
  });

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of placed) {
    if (!p.box) continue;
    minX = Math.min(minX, p.box.a.x, p.box.b.x);
    minY = Math.min(minY, p.box.a.y, p.box.b.y);
    maxX = Math.max(maxX, p.box.a.x, p.box.b.x);
    maxY = Math.max(maxY, p.box.a.y, p.box.b.y);
  }
  if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) {
    toast("Nothing painted to merge");
    return;
  }

  const width = Math.max(1, Math.ceil(maxX - minX));
  const height = Math.max(1, Math.ceil(maxY - minY));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const first = ordered[0]!;
  const merged = createRasterClip({
    frameId: first.frameId,
    width,
    height,
    startMs: Math.min(...ordered.map((c) => c.startMs)),
    durationMs: Math.max(...ordered.map((c) => c.startMs + c.durationMs)) - Math.min(...ordered.map((c) => c.startMs)),
    fillDuration: first.fillDuration,
    name: first.name || "Pixel layer",
  });
  merged.transform = { ...merged.transform, x: cx, y: cy };

  // The merged surface's pixel (0,0) is the union box's top-left, and the
  // merged clip is unrotated at scale 1 with a centred pivot — so frame → merged
  // pixel is a plain translation, and each part only needs its own scale.
  writeSurface(merged.surfaceId, width, height, (ctx) => {
    for (const p of placed) {
      const origin = p.at(0, 0);
      ctx.save();
      ctx.globalAlpha = p.clip.opacity;
      ctx.globalCompositeOperation = COMPOSITE[p.clip.blendMode];
      ctx.translate(origin.x - minX, origin.y - minY);
      ctx.scale(p.basis.scale, p.basis.scaleY);
      ctx.drawImage(surfaceCanvas(p.clip), 0, 0);
      ctx.restore();
    }
  });

  const gone = ordered.map((c) => c.surfaceId);
  store.update("Merge parts", (d: MotionDocument) => {
    // Above the first part — and in its group, since that is where the row
    // `placeClip` seats it lives.
    placeClip(d, merged, { aboveClipId: first.id });
    for (const c of ordered) {
      const loc = locateClip(d, c.id);
      if (loc) loc.track.clips.splice(loc.clipIndex, 1);
    }
    // A group that merged down to one member is no longer a group — it is a
    // layer. Dissolve it rather than leaving a container around a single child,
    // which is the state that makes a layer list feel like it is hiding things.
    const groupId = groupOfClip(d, merged.id);
    if (groupId && clipsInGroup(d, groupId).length <= 1) {
      merged.name = locateClip(d, groupId)?.clip.name || merged.name;
      ungroupClips(d, [groupId]);
    }
  });
  deleteSurfaces(gone);
}

/**
 * The clips a Merge command should act on, given a selection.
 *
 * Selecting the GROUP means "merge this whole paint layer" — the thing a person
 * points at is the layer, not its insides — so a group resolves to its parts.
 * Selecting parts means those parts. Both readings arrive here so the menu item,
 * the shortcut and the stage button can never disagree about scope.
 */
export function partsToMerge(doc: MotionDocument, selectedIds: readonly string[]): string[] {
  if (selectedIds.length === 1) {
    const only = locateClip(doc, selectedIds[0]!)?.clip;
    if (isPartGroup(doc, only)) return partsOf(doc, only.id).map((c) => c.id);
  }
  return selectedIds.filter((id) => locateClip(doc, id)?.clip.kind === "raster");
}
