"use client";

import {
  clipContentRevision,
  clipLocalTime,
  clipVariesWithTime,
  type MotionDocument,
  type Clip,
  type Frame,
  type VisualClip,
} from "@solomotion/core";
import { faithfulSince, mediaSeeksPending, pictureFaults } from "../stage/render/media-cache";
import { paintGeneration, repaint } from "./paint-gen";
import { clipObjectBounds, drawClipPoster, flatFrame, layerBleedPad } from "../stage/render/draw-frame";

/**
 * A 2D LAYER AS A PICTURE PLANE — the picture a text, an image, a shape or a
 * whole nested comp shows when it stands in a 3D world.
 *
 * The picture is drawn by the 2D renderer itself, so everything 2D can do —
 * every script and direction of text, glyph animation, effects, strokes,
 * gradients, nested comps — is exactly what the plane shows, with no 3D
 * re-implementation of any of it. What the plane does NOT carry is the layer's
 * PLACEMENT: its transform and in/out animation are the 3D object's job
 * (`evaluateWorld`), so they are neutralised here and the layer is drawn at
 * rest, pivot at the centre.
 */

export interface PlanePicture {
  canvas: HTMLCanvasElement;
  /**
   * The picture's rectangle in layer px, relative to the pivot (y down) — the
   * layer's box plus the room its effects paint past it (a glow, a shadow, a
   * per-glyph halo: `layerBleedPad`, the pad the flat renderer reserves), so
   * nothing it draws is cut at the box.
   */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** The layer's own box inside it (no bleed) — what a slab is the size of. */
  content: { minX: number; minY: number; maxX: number; maxY: number };
  /** Changes when the pixels change — what a texture re-uploads on. */
  key: string;
  /** Do the pixels move on their own (video, a nested comp, animated text)? */
  varies: boolean;
}

// Skew stays with the picture: it is a shape the layer has, not a placement.
// Opacity goes with the placement: whoever places the picture applies it once.
const PLACEMENT_PATHS = new Set(["x", "y", "z", "scale", "scaleY", "scaleZ", "rotation", "rotationX", "rotationY", "opacity"]);

interface Rest {
  doc: MotionDocument;
  clip: VisualClip;
  /** Does the picture itself move (not just where it is)? */
  varies: boolean;
}

/** The document with ONE clip neutralised to rest (memoised per document + clip, so caches downstream hold). */
const neutral = new WeakMap<MotionDocument, Map<string, Rest | null>>();
function planeDoc(doc: MotionDocument, clipId: string): Rest | null {
  let per = neutral.get(doc);
  if (!per) neutral.set(doc, (per = new Map()));
  const hit = per.get(clipId);
  if (hit !== undefined) return hit;
  let rest = null as VisualClip | null;
  const tracks = doc.tracks.map((t) => {
    const i = t.clips.findIndex((c) => c.id === clipId);
    if (i < 0) return t;
    const c = t.clips[i] as VisualClip;
    rest = {
      ...c,
      transform: { ...c.transform, x: 0, y: 0, scale: 1, scaleY: null, rotation: 0, z: undefined, rotationX: undefined, rotationY: undefined, scaleZ: undefined },
      keyframes: c.keyframes.filter((k) => !PLACEMENT_PATHS.has(k.property)),
      modulators: c.modulators?.filter((m) => !PLACEMENT_PATHS.has(m.target)),
      animIn: null,
      animOut: null,
      constraints: undefined,
      trackBinding: null,
      opacity: 1,
    } as VisualClip;
    const clips = t.clips.slice();
    clips[i] = rest as Clip;
    return { ...t, clips };
  });
  // The picture AT REST is unbent, and nothing about it depends on bones:
  // whoever places it does the bending (the 2D warp, a world body's skin). So
  // the document it is drawn from carries NO rigs — bent here as well, it would
  // bend twice; and since a member's silhouette (what its weights read) is this
  // picture, asking any rig how to place anything while drawing it asks for
  // silhouettes while drawing one.
  //
  // Nor any BODIES, for the same two reasons: a picture at rest does not fall
  // (whoever places it moves it), and a body's collider is its silhouette —
  // this picture — so simulating while drawing it would ask for it again.
  const moves = (c: Clip) => (c.kind === "group" && !!c.rig) || (c.kind !== "audio" && (!!c.physics || !!c.forces?.length));
  for (let ti = 0; ti < tracks.length; ti++) {
    const t = tracks[ti]!;
    if (!t.clips.some(moves)) continue;
    tracks[ti] = {
      ...t,
      clips: t.clips.map((c) => (!moves(c) ? c : ({ ...c, ...(c.kind === "group" && c.rig ? { rig: null } : {}), ...(c.kind !== "audio" ? { physics: undefined, field: undefined, joints: undefined } : {}) } as Clip))),
    };
  }
  const r = rest as VisualClip | null;
  const out: Rest | null = r
    ? { doc: { ...doc, tracks }, clip: r, varies: clipVariesWithTime(r) || r.kind === "video" || r.kind === "nested" }
    : null;
  per.set(clipId, out);
  return out;
}


let serial = 0;
const ids = new WeakMap<object, number>();
const idOf = (o: object) => {
  let n = ids.get(o);
  if (n === undefined) ids.set(o, (n = ++serial));
  return n;
};

interface CacheEntry {
  picture: PlanePicture;
  lastUsed: number;
}
const cache = new Map<string, CacheEntry>();
let tick = 0;

/** Pixels of picture per layer px — 2× for crisp type, capped so a 4K plate stays one texture. */
const MAX_SIDE = 2048;

/**
 * The picture for a 2D layer in a world, at a comp instant. Cached by what it
 * depends on — the layer's content revision and, only if it moves on its own,
 * its local time — so a still title in a spinning scene draws ONCE.
 */
export function planePicture(
  doc: MotionDocument,
  frame: Frame,
  clip: VisualClip,
  timeMs: number,
  density = 2,
): PlanePicture | null {
  const local = clipLocalTime(clip, timeMs);
  if (local === null) return null;
  const neutralised = planeDoc(doc, clip.id);
  if (!neutralised) return null;
  // Time is in the key only when the PIXELS move: a layer that merely travels,
  // turns or fades on its keys keeps one picture for the whole move. (The clip
  // object is stable while playing; an edit to the layer redraws it.)
  const key = `${clip.id}|${clipContentRevision(doc, clip.id)}|${idOf(clip)}|${neutralised.varies ? Math.round(local) : "-"}|${density}|${paintGeneration(clip.id)}`;
  const hit = cache.get(clip.id);
  tick++;
  if (hit && hit.picture.key === key) {
    hit.lastUsed = tick;
    return hit.picture;
  }
  const { doc: rest, clip: restClip } = neutralised;
  const ff = flatFrame(frame);
  // Measure the silhouette at rest, then draw it 1:1 × density into a fitted canvas.
  const probe = hit?.picture.canvas ?? document.createElement("canvas");
  const pctx = probe.getContext("2d")!;
  const before = pictureFaults();
  const content = measure(pctx, rest, ff, restClip, timeMs);
  if (!content) return null;
  const pad = layerBleedPad(rest, ff, restClip, timeMs);
  const bounds = { minX: content.minX - pad, minY: content.minY - pad, maxX: content.maxX + pad, maxY: content.maxY + pad };
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  const k = Math.min(density, MAX_SIDE / Math.max(w, h));
  const cw = Math.max(1, Math.ceil(w * k));
  const ch = Math.max(1, Math.ceil(h * k));
  const canvas = probe;
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  } else {
    pctx.setTransform(1, 0, 0, 1, 0, 0);
    pctx.clearRect(0, 0, cw, ch);
  }
  const ok = drawClipPoster(pctx, rest, ff, restClip, timeMs, cw, ch, pad);
  if (!ok) return null;
  // A picture drawn while its media was still arriving (an image decoding, a
  // video seeking) is the PLACEHOLDER, and the media cache says so. It must
  // never be kept under the layer's real key — that is how an image stood in a
  // world as a grey card until something moved it. Keyed fresh instead, so the
  // next frame redraws and the texture re-uploads when the real picture lands
  // (`onMediaReady` marks the viewport dirty).
  //
  // A video's STAND-IN is a placeholder too while its seek is landing: parked,
  // the media cache serves the nearest frame already landed (a real frame, but
  // of another instant) and calls it merely inexact. Kept, it stood as the
  // picture of that instant after the right frame arrived — a world showed
  // 1.37 s at 1 s and at 1.6 s. Once no seek is pending it is the best there
  // will be, and is kept.
  const transient = !faithfulSince(before, true) || (!faithfulSince(before) && mediaSeeksPending());
  const picture: PlanePicture = { canvas, ...bounds, content, key: transient ? `${key}|placeholder${++serial}` : key, varies: neutralised.varies };
  cache.set(clip.id, { picture, lastUsed: tick });
  if (cache.size > 256) {
    let oldest: string | null = null;
    let at = Infinity;
    for (const [id, e] of cache) if (e.lastUsed < at) (at = e.lastUsed), (oldest = id);
    if (oldest) cache.delete(oldest);
  }
  return picture;
}

/** The layer's drawn extent at rest, relative to its pivot (frame centre after neutralising). */
function measure(
  ctx: CanvasRenderingContext2D,
  doc: MotionDocument,
  frame: Frame,
  clip: VisualClip,
  timeMs: number,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const b = clipObjectBounds(doc, ctx, frame, clip, clipLocalTime(clip, timeMs) ?? 0);
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return null;
  return { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY };
}

/** Forget a layer's picture (it left the world, or the world closed). */
export function dropPlanePicture(clipId: string): void {
  cache.delete(clipId);
}

/** Pixels painted in place (a brush stroke in space, before it commits): the layer's picture is redrawn and re-uploaded. */
export function repaintPlanePicture(clipId: string): void {
  repaint(clipId);
}
