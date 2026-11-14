"use client";

import { anchorLocal, clipBox, noteOutlinesChanged, setPhysicsOutlineProvider, type PathCommand, type VisualClip } from "@solomotion/core";
import { extrudeSource, onOutlineReady } from "../world/engine/extrude";
import { traceSilhouette } from "../world/engine/body";
import { planePicture } from "../world/plane-picture";
import { markStageDirty } from "../stage/render/stage-dirty";
import { onMediaReady } from "../stage/render/media-cache";

/**
 * WHAT A BODY COLLIDES AS, where core cannot see it: a text's glyphs (its
 * font) and a picture's silhouette (its pixels) — so a word lands on its
 * letters and a cut-out sticker on its edge, not on their boxes. The same
 * readers the 3D solids extrude from, so a layer is one shape everywhere.
 *
 * Outlines are the layer's OWN space (box-centred); the solid readers hand
 * them back relative to the pivot, so they are moved back by it. A text
 * outline arrives once its font has: until then it collides as its box, and
 * when it lands every simulation built without it is built again.
 *
 * Installed on import (the renderer imports it).
 */

const PICTURES = new Set(["image", "video", "nested", "raster"]);
/** Bodies whose picture was not decoded yet when asked: their silhouette re-shapes them once it is. */
const waiting = new Set<string>();

function shift(cmds: PathCommand[], dx: number, dy: number): PathCommand[] {
  return cmds.map((c) =>
    c.type === "Z" ? c : c.type === "C" ? { ...c, x1: c.x1 + dx, y1: c.y1 + dy, x2: c.x2 + dx, y2: c.y2 + dy, x: c.x + dx, y: c.y + dy } : { ...c, x: c.x + dx, y: c.y + dy },
  );
}

if (typeof window !== "undefined") {
  setPhysicsOutlineProvider((doc, clip, localMs) => {
    if (clip.kind === "audio") return null;
    const frame = doc.frames.find((f) => f.id === clip.frameId);
    if (!frame) return null;
    const v = clip as VisualClip;
    const pivot = anchorLocal(v.transform.anchor, clipBox(doc, v));
    if (clip.kind === "text") {
      const src = extrudeSource(doc, frame, v, localMs);
      return src ? shift(src.cmds, pivot.x, pivot.y) : null;
    }
    if (PICTURES.has(clip.kind)) {
      const pic = planePicture(doc, frame, v, clip.startMs + localMs, 1);
      if (!pic) waiting.add(clip.id);
      const sil = pic ? traceSilhouette(clip.id, pic) : null;
      return sil ? shift(sil.cmds, pivot.x, pivot.y) : null;
    }
    return null;
  });
  onOutlineReady(() => {
    noteOutlinesChanged();
    markStageDirty();
  });
  onMediaReady((clipId) => {
    if (!waiting.size || (clipId && !waiting.has(clipId))) return;
    if (clipId) waiting.delete(clipId);
    else waiting.clear();
    noteOutlinesChanged();
    markStageDirty();
  });
}
