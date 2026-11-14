import type { MotionDocument, Clip, VisualClip } from "../schema";
import type { Tracker, TrackSource } from "../schema/tracking";
import type { Vec2 } from "../schema/common";
import { clipLocalTime } from "../animation/evaluate";
import { channelValueAt } from "../animation/channels";
import { clipBox, clipSourcePhaseAt } from "../timeline/ops";
import { groupChainMatrix } from "../timeline/group-space";
import { layerMatrix, type LayerBasis } from "../transform-map";
import { apply, applyInverse, IDENTITY, multiply, rotation, scaling, translation, type Mat2D } from "../navigation/matrix";

/**
 * WHERE THE FOOTAGE IS — the join between a tracker (source time, source
 * pixels) and a comp (comp time, frame-centre-local pixels).
 *
 * A tracker belongs to its media, not to a clip, so "where is the face in this
 * comp right now" is two questions: WHICH clip is showing that media now, and
 * how does that clip place its pixels. Both are answered here, once, for every
 * reader — the follow bake, `track()`, the Track node, grade windows, the stage
 * overlay, the API.
 *
 * The placement is read from the document it is given. Called with a RESOLVED
 * document (`resolvedDocAt`), an animated or driven footage layer is followed
 * where it actually is — a sticker on a face in a plate that is itself being
 * pushed in stays on the face.
 */

export interface FootageView {
  /** The clip showing the source at this instant. */
  clip: VisualClip;
  /** Source time (ms into the media) the clip shows. */
  sourceMs: number;
  /** Source px → comp (frame-centre-local), group chain included. */
  toComp: Mat2D;
}

/** The asset a clip shows as pixels, if any. */
export function pictureAssetOf(clip: Clip): string | null {
  return clip.kind === "video" || clip.kind === "image" ? clip.assetId : null;
}

/** Does this clip show this source's pixels? */
export function clipShowsSource(clip: Clip, source: TrackSource): clip is VisualClip {
  return pictureAssetOf(clip) === source.assetId;
}

/** Every clip in a comp (or the document) showing a tracker's source, bottom to top. */
export function footageClips(doc: MotionDocument, tracker: Tracker, compId?: string | null): VisualClip[] {
  const out: VisualClip[] = [];
  for (const track of doc.tracks)
    for (const clip of track.clips)
      if ((!compId || clip.frameId === compId) && clipShowsSource(clip, tracker.source)) out.push(clip);
  return out;
}

/**
 * The clip a tracker is seen through in `compId` at `compMs`: `via` if it is
 * showing the source then, else the TOPMOST clip that is, else null — a
 * consumer then keeps its own pose rather than being snapped to a guess.
 */
export function footageClipAt(doc: MotionDocument, tracker: Tracker, compId: string, compMs: number): VisualClip | null {
  let top: VisualClip | null = null;
  for (const clip of footageClips(doc, tracker, compId)) {
    if (clipLocalTime(clip, compMs) === null) continue;
    if (clip.id === tracker.via) return clip;
    top = clip; // ascending track order: the last match is the topmost
  }
  return top;
}

/** Source time a clip shows at comp time — through trim, speed, ramps, loop and reverse. Null outside it. */
export function footageTimeAt(doc: MotionDocument, clip: Clip, compMs: number): number | null {
  const local = clipLocalTime(clip, compMs);
  if (local === null) return null;
  if (clip.kind === "image") return 0;
  return clipSourcePhaseAt(doc, clip, local).sourceMs;
}

/**
 * Source px → the clip's OWN local space at a clip-local time: centre the media
 * in its box, then the content transform (pan/zoom inside the window,
 * transform-map's `mapContent`). What a per-layer pass (a grade window drawn
 * inside the layer's buffer) needs.
 */
export function sourceToLocalMatrix(doc: MotionDocument, clip: VisualClip, localMs: number): Mat2D {
  const box = clipBox(doc, clip);
  const n = sampler(clip, localMs);
  const cs = n("content.scale", clip.content.scale);
  const csy = clip.content.scaleY == null ? cs : n("content.scaleY", clip.content.scaleY);
  const content = multiply(
    translation(box.cx + n("content.x", clip.content.x), box.cy + n("content.y", clip.content.y)),
    multiply(rotation(n("content.rotation", clip.content.rotation)), multiply(scaling(cs, csy), translation(-box.cx, -box.cy))),
  );
  // Source pixel (0,0) is the box's top-left.
  return multiply(content, translation(box.cx - box.width / 2, box.cy - box.height / 2));
}

/**
 * Source px → comp (frame-centre-local) at a comp instant. The renderer's own
 * composition: `sourceToLocalMatrix`, the layer's T·R·K·S about its pivot, then
 * every enclosing group.
 */
export function footageMatrix(doc: MotionDocument, clip: VisualClip, compMs: number): Mat2D {
  const local = clipLocalTime(clip, compMs) ?? 0;
  const n = sampler(clip, local);
  const t = clip.transform;
  const scale = n("scale", t.scale);
  const basis: LayerBasis = {
    scale,
    scaleY: n("scaleY", t.scaleY ?? scale),
    rotation: n("rotation", t.rotation),
    skewX: n("skewX", t.skewX),
    skewY: n("skewY", t.skewY),
    anchor: { x: n("anchor.x", t.anchor.x), y: n("anchor.y", t.anchor.y) },
    size: clipBox(doc, clip),
  };
  const [a, b, c, d, e, f] = layerMatrix(basis);
  const layer = multiply(translation(n("x", t.x), n("y", t.y)), { a, b, c, d, e, f });
  const own = multiply(layer, sourceToLocalMatrix(doc, clip, local));
  const chain = groupChainMatrix(doc, clip.id, (g) => clipLocalTime(g, compMs) ?? 0);
  return chain === IDENTITY ? own : multiply(chain, own);
}

/** A clip's numeric channel at a local time — keys, drivers already baked, else the stored value. */
function sampler(clip: Clip, localMs: number): (path: string, fallback: number) => number {
  return (path, fallback) => {
    const v = channelValueAt(clip, path, localMs);
    return typeof v === "number" ? v : fallback;
  };
}

/** Everything a reader needs to turn a sample into comp space, or null when nothing shows the source. */
export function footageAt(doc: MotionDocument, tracker: Tracker, compId: string, compMs: number): FootageView | null {
  const clip = footageClipAt(doc, tracker, compId, compMs);
  if (!clip) return null;
  const sourceMs = footageTimeAt(doc, clip, compMs);
  if (sourceMs === null) return null;
  return { clip, sourceMs, toComp: footageMatrix(doc, clip, compMs) };
}

/** A source-px point into comp space. */
export function sourceToComp(view: FootageView, p: Vec2): Vec2 {
  return apply(view.toComp, p);
}

/** The inverse map, for gestures that drag a tracked point on the stage. */
export function compToSource(view: FootageView, p: Vec2): Vec2 {
  return applyInverse(view.toComp, p);
}
