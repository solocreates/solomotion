import { sampleKeyframes } from "../animation/keyframes";
import type { MotionDocument } from "../schema/document";
import type { Clip, PathClip } from "../schema/clips";
import { clipBox } from "../timeline/ops";
import { mapLocal, unmapLocal, type LayerBasis } from "../transform-map";
import type { Contour, StrokeStyle } from "../schema/vector";

/**
 * THE mapping between frame-centre coordinates and a vector layer's OWN
 * geometry space, under its full pose at a moment in time.
 *
 * Every tool that reaches into a path's outline needs this and needs the same
 * answer: the brush appending a stroke, the eraser carrying its trail in, the
 * lasso carrying its loop in, the node editor picking a point up. It lived in
 * the drawing overlay as a closure over React refs, which meant the one piece
 * of arithmetic the whole drawing experience rests on could not be run in a
 * test, a worker or the exporter — and the bug it carried (see below) was
 * therefore only ever findable by drawing and squinting.
 *
 * ## The invariant, and the bug it exists to make impossible
 *
 * `mapLocal` and `unmapLocal` are an exact pair, and BOTH speak the layer's own
 * coordinates — the space the geometry is authored in, the space `pathBox`
 * measures. `unmapLocal` already adds the resolved pivot back on, so its result
 * IS a geometry coordinate. Re-adding the box centre to it (which the overlay
 * did) displaces every point by `(box.cx, box.cy)`.
 *
 * That offset is zero for exactly one layer: one whose outline is still centred
 * on its origin. A brush layer is centred at creation and stops being centred
 * the moment a second stroke widens its bounds — which is why the first line
 * drawn on a layer landed perfectly and each one after it drifted further, and
 * why erasing and lassoing missed on the same layers by the same amount.
 *
 * `roundTrip` below is the statement of the invariant, and the test asserts it
 * on a layer that is scaled, rotated, skewed and pivoted off-centre at once.
 */
export interface LayerSpace {
  /** The layer's pose, resolved at the requested time. */
  basis: LayerBasis;
  /** Frame-centre coordinates → this layer's geometry coordinates. */
  at(x: number, y: number): { x: number; y: number };
  /** This layer's geometry coordinates → frame-centre coordinates. */
  toFrame(x: number, y: number): { x: number; y: number };
  /**
   * A LENGTH in frame px, expressed in the layer's space (a brush radius, a
   * simplification tolerance). A scaled layer's px are not the stage's, and an
   * accuracy in px only means something once it is in the same space.
   */
  lengthScale: number;
}

/** Where the playhead sits inside a clip, clamped to its span. */
function localMs(clip: Clip, playheadMs: number): number {
  return Math.min(Math.max(0, playheadMs - clip.startMs), clip.durationMs);
}

/**
 * Resolve a path layer's space at a time. Reads the SAMPLED transform, so a
 * layer animating under the pointer is met where it is on screen rather than
 * where it rests — the difference between drawing on a moving layer and
 * drawing near one.
 */
export function layerSpace(doc: MotionDocument, clip: PathClip, playheadMs: number): LayerSpace {
  const kf = sampleKeyframes(clip.keyframes, localMs(clip, playheadMs));
  const n = (k: string, d: number): number => (typeof kf[k] === "number" ? (kf[k] as number) : d);
  const t = clip.transform;
  const scale = Math.max(0.0001, n("scale", t.scale));
  const scaleY = Math.max(0.0001, t.scaleY == null ? scale : n("scaleY", t.scaleY));
  const basis: LayerBasis = {
    scale,
    scaleY,
    rotation: n("rotation", t.rotation),
    skewX: n("skewX", t.skewX),
    skewY: n("skewY", t.skewY),
    anchor: { x: n("anchor.x", t.anchor.x), y: n("anchor.y", t.anchor.y) },
    size: clipBox(doc, clip),
  };
  const cx = n("x", t.x);
  const cy = n("y", t.y);
  return {
    basis,
    at: (x, y) => unmapLocal(x - cx, y - cy, basis),
    toFrame: (x, y) => {
      const o = mapLocal(x, y, basis);
      return { x: o.x + cx, y: o.y + cy };
    },
    lengthScale: 2 / (scale + scaleY),
  };
}

/**
 * Carry an outline drawn in frame coordinates into a layer's geometry space.
 * Handles are mapped as POINTS, not as offsets, because the map is affine with
 * a translation — mapping a handle as a vector drops the pivot and shears the
 * curve away from the line the user drew.
 */
export function contoursToLayer(
  contours: ReadonlyArray<Contour>,
  space: LayerSpace,
): Contour[] {
  const { at } = space;
  return contours.map((sub) => ({
    ...sub,
    closed: sub.closed,
    points: sub.points.map((pt) => ({
      ...pt,
      ...at(pt.x, pt.y),
      hIn: pt.hIn ? at(pt.hIn.x, pt.hIn.y) : null,
      hOut: pt.hOut ? at(pt.hOut.x, pt.hOut.y) : null,
    })),
  }));
}

/**
 * Carry INK drawn in frame coordinates into a layer's geometry space.
 *
 * The twin of `contoursToLayer`, and it exists because half a conversion is a
 * bug that only shows on a layer somebody scaled: the outline was mapped and
 * the stroke width was not, so a 50px brush stroke appended to a layer at 200%
 * came back 100px, and one at 50% came back hairline. The geometry landed
 * perfectly, which is what made it look like the width had been thrown away
 * rather than converted.
 *
 * Only `width` is scaled. `baseWidth` is the width the LOOK was authored at and
 * stays put on purpose: `strokeAtWidth` derives the dash, the wave and the
 * roughness from `width / baseWidth`, so leaving the reference alone is exactly
 * what carries the whole pipeline into the layer's space through the one rule
 * that already exists. Everything else on a stroke is either a fraction
 * (`profile`, `trim`) or a multiple of the width, and is therefore already
 * expressed in the only unit that survives a change of space.
 */
export function strokesToLayer(strokes: readonly StrokeStyle[], space: Pick<LayerSpace, "lengthScale">): StrokeStyle[] {
  const k = space.lengthScale;
  if (k === 1) return strokes.map((s) => ({ ...s }));
  return strokes.map((s) => ({ ...s, width: Math.max(0.01, s.width * k) }));
}
