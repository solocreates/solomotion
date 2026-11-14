import { shearPoint, unshearPoint, type AnchorPoint, type Transform } from "./schema/common";
import type { ContentTransform, CropInsets, Vec2 } from "./schema";

/**
 * THE local → world map for a layer. Every surface that needs to know where a
 * layer's own coordinates land — the renderer, hit-testing, on-canvas handles,
 * vector node editing, snapping, bounds, SVG/Lottie export — goes through this
 * one function. Before it existed, six files hand-rolled the same
 * `T·R·K·S` arithmetic; they agreed only by luck, and adding the PIVOT below
 * would have needed six identical edits to stay in sync.
 *
 * ## The pivot (anchor point)
 *
 * A layer's `transform.x/y` positions its PIVOT, and rotation, scale and shear
 * all happen about that pivot. The default pivot is the box center, which is
 * exactly what every document did before pivots existed — so `{x: 0.5, y: 0.5}`
 * is the identity and no document needed migrating.
 *
 * The pivot is stored NORMALIZED (a fraction of the layer's own box: 0 = left/
 * top edge, 0.5 = center, 1 = right/bottom edge, and values outside 0..1 are
 * legal and put the pivot outside the layer). Normalized, not pixels, because
 * the pivot is a statement about the SHAPE ("spin about my bottom-right
 * corner"), and a pixel offset would quietly stop meaning that the moment the
 * layer is resized, rescaled, re-wrapped or its media swapped. This is the same
 * reason CSS `transform-origin` takes percentages.
 *
 * The one cost of normalizing is that resolving a pivot needs the layer's box,
 * which is per-kind and — for text — only known after layout. So the box is an
 * explicit input here: callers pass the best one they hold (the renderer its
 * measured layout, everyone else `clipBox`), and there is still only one
 * formula.
 *
 * ## The pivot vs. the geometry underneath it
 *
 * A normalized pivot is a statement about a box, so it only stays put while the
 * box does. That is true of a shape (`width`/`height` are declared) but NOT of a
 * path, whose box is DERIVED from its outline — so dragging one node resizes the
 * box, and a fraction of a different box is a different point. Left alone, the
 * whole layer slides sideways every time you morph it, by an amount that grows
 * with how far the pivot sits from the centre. That was the bug.
 *
 * The rule, which matches After Effects and Blender: **editing geometry edits
 * geometry only.** A morph never moves the layer and never moves the pivot — the
 * pivot is part of the layer's frame, not of its content. `rebaseAnchor` below
 * is how that is enforced: when a content edit changes the box, the stored
 * fraction is re-expressed against the new box so the pivot's LOCAL POINT — and
 * therefore every unedited point of the art — comes out exactly where it was.
 * (Deliberately not the other reading, "the pivot keeps riding the corner it was
 * pinned to": a node you dragged on one side of the shape would then relocate a
 * pivot you placed on the other, which is nobody's idea of morphing.)
 */

/**
 * A layer's own box, in LOCAL (pre-transform) units: how big it is, and where
 * that box sits relative to the layer's ORIGIN.
 *
 * `cx/cy` is zero for every kind whose geometry is authored about its origin —
 * a shape, an image, a nested comp, a text box — which is why it was possible
 * to ignore it for so long. A PATH is the exception: its outline is a free
 * cloud of points that starts centred (the pen normalises it on commit) and
 * then wanders the moment a node is dragged. Dropping `cx/cy` made the pivot
 * resolve against a box the user cannot see, so the nine-point picker's
 * "top-left" landed somewhere in the middle of edited art.
 */
export interface LayerBox {
  width: number;
  height: number;
  /** The box centre, in the layer's own (origin-relative) coordinates. */
  cx: number;
  cy: number;
}

/**
 * Everything needed to map a layer's local coordinates to world offsets: the
 * linear part of T·R·K·S plus the resolved pivot. Sampled poses and raw
 * transforms both reduce to this.
 */
export interface LayerBasis {
  scale: number;
  scaleY: number;
  rotation: number;
  skewX: number;
  skewY: number;
  /** Normalized pivot (0..1 across the box; 0.5,0.5 = center). */
  anchor: AnchorPoint;
  /** The box the normalized pivot is a fraction of. */
  size: LayerBox;
}

/** The identity pivot: the box center — what every layer had before pivots. */
export const CENTER_ANCHOR: AnchorPoint = { x: 0.5, y: 0.5 };

/**
 * The pivot in the layer's own coordinates (the space geometry is authored in):
 * the box centre for a centered pivot, `centre - (w/2, h/2)` for the top-left.
 */
export function anchorLocal(anchor: AnchorPoint, box: LayerBox): Vec2 {
  return { x: box.cx + (anchor.x - 0.5) * box.width, y: box.cy + (anchor.y - 0.5) * box.height };
}

/**
 * THE PAINTED EXTENT of a cropped layer — the visible window, as a box in the
 * layer's own coordinates.
 *
 * ## Two boxes, not one
 *
 * A layer has TWO rectangles, and collapsing them is a defect this codebase has
 * now paid for twice:
 *
 *   the PIVOT BOX      what a normalized anchor is a fraction of. The layer's
 *                      natural box — `clipBox` — and nothing else. It does not
 *                      shrink when you crop, because a crop is not a resize:
 *                      the picture must not swing to a new centre the instant
 *                      you pull an edge in.
 *   the PAINTED EXTENT what the layer actually inks. THIS. Smaller than the
 *                      pivot box under a crop, off-centre under an asymmetric
 *                      one, and — for a shape with a dragged-out corner or a
 *                      path animated off its declared box — sometimes bigger.
 *
 * The pose places the extent, but pivots about the box. Feed the extent in as
 * the pivot box and every off-centre crop resolves its anchor against a
 * rectangle the painter never used: the layer's computed position drifts by the
 * crop's own offset, multiplied by scale. Nothing looks wrong while that answer
 * is only used to draw the picture (the painter has the right box); it goes
 * wrong where the answer is used to SIZE A BUFFER — the isolation buffer and
 * the motion-blur region — because the buffer is then measured around a
 * rectangle the layer is not in, and everything past its wall is cut off with a
 * hard, straight edge. That is the "half my cropped image disappears while it
 * plays" bug: the region moved, the picture did not.
 *
 * So the extent is derived HERE, once, headless, and every surface that needs
 * "what does this layer cover" reads it — the painter's clip rect, the fills
 * that hug the cropped box, the isolation buffer, the shutter region and the
 * exporters alike. Insets are clamped (over-crop collapses to an empty window
 * rather than inverting) and the result carries its own `cx/cy`, so an
 * asymmetric crop travels as a box offset instead of as a second convention
 * each caller has to remember to apply.
 */
export function cropWindow(crop: CropInsets, box: LayerBox): LayerBox {
  const w = box.width;
  const h = box.height;
  const x0 = Math.min(w, Math.max(0, crop.left));
  const y0 = Math.min(h, Math.max(0, crop.top));
  const x1 = Math.max(x0, w - Math.max(0, crop.right));
  const y1 = Math.max(y0, h - Math.max(0, crop.bottom));
  return {
    width: x1 - x0,
    height: y1 - y0,
    cx: box.cx + (x0 + x1) / 2 - w / 2,
    cy: box.cy + (y0 + y1) / 2 - h / 2,
  };
}

/**
 * ── THE PICTURE INSIDE THE WINDOW ────────────────────────────────────────────
 *
 * `cropWindow` above answers "where is the visible rectangle". These answer
 * "where is the art inside it", which is the other half of the same fact and
 * used to be expressed only as two other properties cancelling each other out
 * (see `contentTransformSchema`).
 *
 * The map is an ordinary affine about the layer's OWN BOX CENTRE:
 *
 *     p' = boxC + R(rot)·S·(p − boxC) + (x, y)
 *
 * ## The pivot is the box, and that is the load-bearing part
 *
 * The obvious choice is the WINDOW'S centre — zoom about what you can see — and
 * it is wrong, for a reason worth stating so nobody re-derives it: the window's
 * centre is a FUNCTION OF THE INSETS. Put it in this map and the two facts are
 * coupled through the pivot, so dragging a crop edge moves the pivot, and every
 * non-identity picture shifts by `(1 − scale)` times however far the window
 * travelled. Reframing the crop dragged the footage along with it — the exact
 * coupling this whole field exists to remove.
 *
 * So the pivot is the box centre: a property of the layer's own geometry, which
 * a crop never touches. **Nothing in this map reads the crop.** Editing the
 * window changes what you SEE and never what the picture is doing, at any zoom,
 * at any pan, and under animation as well as under the pointer — which is the
 * only version of "independent" that survives a keyframe.
 *
 * It is also what every finishing tool does: Resolve's input Zoom grows the
 * source about its own centre while Pan/Tilt move it, and the power window in
 * front of it is a separate node that cannot disturb either.
 *
 * The pan is applied OUTSIDE the zoom (the CSS/After Effects order), so `x`/`y`
 * are in the layer's final px: a drag moves the picture 1:1 with the pointer
 * however far in you are, and a gesture that wants to hold some other point
 * still writes the pan that does it rather than bending the model.
 */

/** `scaleY: null` mirrors `scale` — uniform, the same rule the layer transform uses. */
export function contentScaleY(c: ContentTransform): number {
  return c.scaleY == null ? c.scale : c.scaleY;
}

/**
 * Is the picture sitting square in its window? The zero-cost check every render
 * seam makes before doing any of this — an identity content transform must
 * render byte for byte as it did before v68.
 */
export function contentIsIdentity(c: ContentTransform): boolean {
  return (
    c.x === 0 &&
    c.y === 0 &&
    c.rotation === 0 &&
    c.scale === 1 &&
    (c.scaleY == null || c.scaleY === 1)
  );
}

/** One point of the layer's own space through the content transform. */
export function mapContent(lx: number, ly: number, c: ContentTransform, box: LayerBox): Vec2 {
  const sy = contentScaleY(c);
  const dx = (lx - box.cx) * c.scale;
  const dy = (ly - box.cy) * sy;
  const rad = (c.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: box.cx + dx * cos - dy * sin + c.x,
    y: box.cy + dx * sin + dy * cos + c.y,
  };
}

/**
 * The media box after the content transform, as an axis-aligned box in the
 * layer's own coordinates.
 *
 * What the CROP-MODE preview covers (it paints the whole picture, dimmed,
 * outside the window) and therefore what a buffer sized for that preview has to
 * hold — the same discipline `cropWindow` states: the extent follows the paint,
 * always, or the artwork is cut off at a buffer wall nobody can see.
 */
export function contentExtent(c: ContentTransform, box: LayerBox): LayerBox {
  if (contentIsIdentity(c)) return box;
  const hw = box.width / 2;
  const hh = box.height / 2;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    const p = mapContent(box.cx + sx * hw, box.cy + sy * hh, c, box);
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return {
    width: maxX - minX,
    height: maxY - minY,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
  };
}

/**
 * The content transform that seats the picture in its window — `fill` covers it
 * (the shortest side just reaches, the long one overhangs), `fit` puts the
 * whole picture inside it.
 *
 * This is the ONE place the window legitimately enters: it is a command, not
 * the model. You asked for the picture to be centred on the window as it is
 * NOW, so the window is read once, a pan is written, and the result is an
 * ordinary content transform that a later crop edit will leave alone like any
 * other.
 *
 * Headless because three surfaces want it and none should own the arithmetic:
 * the inspector's button, the gesture that re-seats a reframed layer, and any
 * future auto-fit on media swap.
 */
export function fitContent(box: LayerBox, win: LayerBox, mode: "fit" | "fill"): ContentTransform {
  const w = Math.max(1e-6, box.width);
  const h = Math.max(1e-6, box.height);
  const sx = win.width / w;
  const sy = win.height / h;
  const scale = mode === "fill" ? Math.max(sx, sy) : Math.min(sx, sy);
  // The zoom is about the box centre, so centring the picture on the window is
  // just the offset between the two centres — the same at every scale.
  return { x: win.cx - box.cx, y: win.cy - box.cy, scale, scaleY: null, rotation: 0 };
}

/** The linear part of the layer map — scale, then shear, then rotate (S→K→R). */
export function mapLinear(
  lx: number,
  ly: number,
  b: Pick<LayerBasis, "scale" | "scaleY" | "rotation" | "skewX" | "skewY">,
): Vec2 {
  const s = shearPoint(lx * b.scale, ly * b.scaleY, b.skewX, b.skewY);
  const rad = (b.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { x: s.x * cos - s.y * sin, y: s.x * sin + s.y * cos };
}

/**
 * A local (center-origin) point as a WORLD OFFSET from the layer's position.
 * Add the layer's position to land in comp space.
 */
export function mapLocal(lx: number, ly: number, b: LayerBasis): Vec2 {
  const a = anchorLocal(b.anchor, b.size);
  return mapLinear(lx - a.x, ly - a.y, b);
}

/** Exact inverse of `mapLinear` — undo rotate, then shear, then scale (R->K->S). */
export function unmapLinear(
  dx: number,
  dy: number,
  b: Pick<LayerBasis, "scale" | "scaleY" | "rotation" | "skewX" | "skewY">,
): Vec2 {
  const rad = (-b.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const u = unshearPoint(dx * cos - dy * sin, dx * sin + dy * cos, b.skewX, b.skewY);
  return { x: u.x / (b.scale || 1e-6), y: u.y / (b.scaleY || 1e-6) };
}

/**
 * Exact inverse of `mapLocal`: a WORLD OFFSET from the layer's position back to
 * the layer's own (center-origin) coordinates.
 *
 * This is the half every interactive surface needs — "the pointer is here, which
 * of my own coordinates is that?" — and it is the half that kept getting
 * hand-rolled as `rotate(-theta) / scale`, which silently drops both the shear
 * and the pivot. A vector node picked up with that inverse and put back down
 * with the real forward map lands somewhere else: that is the pen tool drifting
 * the moment a pivot moves off center.
 */
export function unmapLocal(dx: number, dy: number, b: LayerBasis): Vec2 {
  const a = anchorLocal(b.anchor, b.size);
  const u = unmapLinear(dx, dy, b);
  return { x: u.x + a.x, y: u.y + a.y };
}

/**
 * A 2-D affine as the six numbers every canvas, DOMMatrix and SVG `matrix()`
 * already speaks: `(x, y) → (a·x + c·y + e, b·x + d·y + f)`.
 */
export type Affine = readonly [a: number, b: number, c: number, d: number, e: number, f: number];

/**
 * `mapLocal` AS A MATRIX — the same S→K→R composition and the same pivot step,
 * handed to a renderer in one piece instead of a point at a time.
 *
 * The two are the same map and this file is why: a painter needs the transform
 * (it draws a whole image, not points), while hit-testing and snapping need the
 * point map, and having them derived separately is how a preview ends up in a
 * different place from the thing it is previewing. That is not hypothetical —
 * the drawing overlay hand-rolled `translate(x,y) rotate scale translate(-w/2,
 * -h/2)`, which is `mapLocal` with the shear dropped and the pivot assumed
 * central. It agreed with the renderer for as long as no pivot ever moved, and
 * the day a pixel layer started GROWING (`grownRaster` re-normalises the anchor
 * so the pixels stay put) every live brush stroke drew itself half a growth
 * block away from where it would land on release.
 *
 * `mapLocal(x, y, b)` and applying this matrix to `(x, y)` are equal to within
 * floating point, and `transform-map.test.ts` asserts it under rotation, shear,
 * non-uniform scale and an off-centre pivot together.
 */
export function layerMatrix(b: LayerBasis): Affine {
  const rad = (b.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const tx = Math.tan((b.skewX * Math.PI) / 180);
  const ty = Math.tan((b.skewY * Math.PI) / 180);
  // Columns are where the local basis vectors land: e1 through scale, shear,
  // then rotation — `mapLinear(1, 0)` and `mapLinear(0, 1)` written out.
  const a = b.scale * (cos - ty * sin);
  const bb = b.scale * (sin + ty * cos);
  const c = b.scaleY * (tx * cos - sin);
  const d = b.scaleY * (tx * sin + cos);
  // …and the translation is that linear part applied to the pivot, so the pivot
  // is the point the whole map holds still.
  const p = anchorLocal(b.anchor, b.size);
  return [a, bb, c, d, -(a * p.x + c * p.y), -(bb * p.x + d * p.y)];
}

/**
 * `unmapLocal` AS A MATRIX — the exact inverse of {@link layerMatrix}, for the
 * other direction every raster op needs: taking something drawn in FRAME space
 * and writing it into a layer's own pixels (merging layers down, dropping a
 * floating selection back onto its source).
 *
 * Derived rather than re-composed, and that is the point. `M = L·T(−p)`, so
 * `M⁻¹ = T(p)·L⁻¹` — the inverse translation is just the pivot. Written by hand
 * as `rotate(−θ)` then `scale(1/s)` it inverts the factors in the WRONG ORDER,
 * which is exact only while the scale is uniform and the shear is zero; both
 * hand-rolled copies in the editor had that bug and neither could be seen until
 * someone squashed a layer on one axis.
 */
export function inverseLayerMatrix(b: LayerBasis): Affine {
  const [a, bb, c, d] = layerMatrix(b);
  const det = a * d - bb * c;
  // A degenerate pose (zero scale) has no inverse; the identity keeps callers
  // drawing something rather than filling a surface with NaN.
  if (!det || !Number.isFinite(det)) return [1, 0, 0, 1, 0, 0];
  const p = anchorLocal(b.anchor, b.size);
  return [d / det, -bb / det, -c / det, a / det, p.x, p.y];
}

/**
 * World offset from the layer's POSITION (where its pivot sits) to its box
 * CENTER. Zero for the default center pivot — which is why every selection box,
 * hit rect and gizmo that assumed "position === center" kept working until a
 * pivot was actually moved.
 */
export function centerOffset(b: LayerBasis): Vec2 {
  return mapLocal(0, 0, b);
}

/**
 * Inverse of `centerOffset`: where the layer's position must be for its box
 * center to land on `center`. This is what a resize writes — a resize is
 * specified by where the BOX goes, but stores where the PIVOT is, and the offset
 * between them changes with both the scale and the box size.
 */
export function positionForCenter(center: Vec2, b: LayerBasis): Vec2 {
  const o = centerOffset(b);
  return { x: center.x - o.x, y: center.y - o.y };
}

/**
 * Re-express a normalized pivot against a NEW box so that it resolves to the
 * same local point it did against the old one.
 *
 * This is the correction a content edit owes the transform. A path's box is its
 * outline's extent, so every node drag, knife cut, node delete and geometry bake
 * changes it; without this the layer would jump by the difference (see the note
 * at the top of this file). With it, `anchorLocal(rebaseAnchor(a, from, to), to)`
 * equals `anchorLocal(a, from)` by construction, which is exactly the statement
 * "nothing moved".
 *
 * Note what does NOT call this: a resize. A resize changes the box on purpose
 * and WANTS the fraction to hold — that is how a pivot stays welded to the
 * corner it was placed on while the box grows. Content edits keep the point;
 * box edits keep the fraction. Two different intents, and conflating them is
 * how a pivot ends up drifting in one gesture and jumping in the other.
 */
export function rebaseAnchor(anchor: AnchorPoint, from: LayerBox, to: LayerBox): AnchorPoint {
  const a = anchorLocal(anchor, from);
  // A collapsed axis (every node on one line) can't express a pivot offset as a
  // fraction of nothing — hold the stored value rather than dividing into
  // infinity, and let the next non-degenerate edit re-base it.
  const axis = (local: number, centre: number, extent: number, keep: number) =>
    Math.abs(extent) < 1e-6 ? keep : 0.5 + (local - centre) / extent;
  return {
    x: axis(a.x, to.cx, to.width, anchor.x),
    y: axis(a.y, to.cy, to.height, anchor.y),
  };
}

/** Build a basis from a raw transform (uniform `scaleY: null` resolved). */
export function basisOfTransform(t: Transform, size: LayerBox): LayerBasis {
  return {
    scale: t.scale,
    scaleY: t.scaleY ?? t.scale,
    rotation: t.rotation,
    skewX: t.skewX,
    skewY: t.skewY,
    anchor: t.anchor,
    size,
  };
}

/**
 * The world shift a layer's POSITION needs so that moving its pivot from `from`
 * to `to` doesn't move the ART.
 *
 * Because position means "where the pivot is", changing the pivot alone would
 * slide the layer by exactly the pivot's own displacement — which is never what
 * anyone means by "move the pivot". Every surface that edits a pivot (the
 * on-canvas crosshair, the inspector fields, the nine-point picker) applies this
 * same correction, so none of them can drift the layer.
 */
export function anchorMoveShift(from: AnchorPoint, to: AnchorPoint, b: LayerBasis): Vec2 {
  const a0 = anchorLocal(from, b.size);
  const a1 = anchorLocal(to, b.size);
  return mapLinear(a1.x - a0.x, a1.y - a0.y, b);
}
