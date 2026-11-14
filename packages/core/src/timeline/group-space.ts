import type { AnchorPoint, MotionDocument, Clip, GroupClip, KeyframeValue, Vec2 } from "../schema";
import { sampledScaleY } from "../animation/uniform-scale";
import { sampleKeyframes } from "../animation/keyframes";
import { anchorLocal, layerMatrix, unmapLocal, type Affine, type LayerBox } from "../transform-map";
import { apply, IDENTITY, multiply, rotation, scaling, shear, translation, type Mat2D } from "../navigation/matrix";
import { clipAncestorGroups } from "./groups";
import { clipBox } from "./ops";
import { rigidSkins2d } from "../rig/bind";

/**
 * WHERE A GROUP PUTS WHAT IT HOLDS — the one answer, for everyone.
 *
 * ## Why this file exists
 *
 * A group's transform is a DELTA applied about a pivot: its members keep their
 * own `x/y` in the comp, and the group moves, turns and scales the lot on top.
 * That is the right model for a container whose box is derived from what is
 * inside it — the alternative (the group owns a coordinate space, members are
 * re-authored into it) makes every member's stored position a lie the moment
 * you drag the group.
 *
 * The model was fine. Where it lived was not: the matrix was a private function
 * inside the renderer, so the renderer was the only thing in the app that knew
 * where a grouped layer actually IS. Everything else — the pivot crosshair, the
 * corner-radius dots, the shape handles, the pen nodes, the gradient knobs —
 * asked the comp chain (`frameSpace`) and got the layer's position as if no
 * group were there. The selection box was right because it comes from the
 * renderer's own hit rects; every control drawn beside it was wrong, by exactly
 * the group's delta. That is why they "always fight" and why the box looks
 * correct while the roundness handles sit somewhere else.
 *
 * One authority now. The renderer composites through it, the stage maps through
 * it, and a control added tomorrow is right without knowing groups exist.
 *
 * ## The space
 *
 * FRAME-CENTRE LOCAL, origin at the middle of the comp — the space
 * `transform.x/y` is written in, the space `EditSpace` calls LOCAL, and the
 * space the schema and the inspector already agree on. The renderer paints in
 * frame TOP-LEFT coordinates and conjugates by half the frame; that is one
 * translate at one call site, not a second convention.
 */

/** The transform values a group is placed by at one instant. */
export interface GroupPose {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  skewX: number;
  skewY: number;
  /**
   * SAMPLED, like every other channel. The pivot is animatable — dragging the
   * crosshair with the group keyed writes `anchor.x/y` keys — so reading the
   * static value here put the crosshair and the pixels on two different pivots
   * the instant one was recorded, which is a drift that grows with the curve.
   */
  anchor: AnchorPoint;
}

function num(kf: Record<string, KeyframeValue>, key: string, fallback: number): number {
  const v = kf[key];
  return typeof v === "number" ? v : fallback;
}

/**
 * A group's sampled pose at its OWN local time.
 *
 * `scaleY: null` mirrors `scale`, exactly as it does for every other layer, and
 * a keyed `scaleY` breaks the link — one rule, resolved here so no caller has
 * to remember it.
 */
export function groupPoseAt(group: GroupClip, localMs: number): GroupPose {
  const kf = sampleKeyframes(group.keyframes, localMs);
  const t = group.transform;
  const scaleX = num(kf, "scale", t.scale);
  return {
    x: num(kf, "x", t.x),
    y: num(kf, "y", t.y),
    rotation: num(kf, "rotation", t.rotation),
    scaleX,
    scaleY: sampledScaleY(kf, t.scaleY) ?? scaleX,
    skewX: num(kf, "skewX", t.skewX),
    skewY: num(kf, "skewY", t.skewY),
    anchor: { x: num(kf, "anchor.x", t.anchor.x), y: num(kf, "anchor.y", t.anchor.y) },
  };
}

/** Does this group move, scale, rotate or shear what it holds? */
export function groupPoseIsIdentity(p: GroupPose): boolean {
  return (
    p.x === 0 && p.y === 0 && p.rotation === 0 && p.skewX === 0 && p.skewY === 0 &&
    p.scaleX === 1 && p.scaleY === 1
  );
}

/**
 * THE GROUP'S PIVOT, at rest — the point its rotation and scale happen about,
 * in frame-centre-local coordinates, BEFORE its own translation.
 *
 * It is the group's box centre offset by the normalized anchor, exactly as a
 * leaf layer's pivot is — `anchorLocal` is the same function, fed the same kind
 * of box. The difference is only that a group's box is DERIVED from what it
 * holds, so this point follows the artwork rather than a declared width.
 *
 * Deliberately not stored. A stored pivot would be a second fact about a box
 * that is itself a derivation, and the two would disagree the first time a
 * member moved — which is the defect class this codebase has the most of.
 */
export function groupPivotLocal(
  doc: MotionDocument,
  group: GroupClip,
  localMs: number,
  box?: LayerBox,
): Vec2 {
  return anchorLocal(groupPoseAt(group, localMs).anchor, box ?? clipBox(doc, group));
}

/**
 * THE group's matrix, from a pose and the pivot it turns about — the one
 * builder every other answer in this file is composed from.
 *
 * Exported because the gestures need it with a value SUBSTITUTED: what would
 * this group's placement be with that pivot, or with that scale? Answering
 * those by re-deriving the formula at the call site is how a resize ends up
 * applying a correction with the sign inverted.
 */
export function groupMatrixOf(pose: GroupPose, pivot: Vec2): Mat2D {
  let m = translation(pivot.x + pose.x, pivot.y + pose.y);
  m = multiply(m, rotation(pose.rotation));
  m = multiply(m, shear(pose.skewX, pose.skewY));
  m = multiply(m, scaling(pose.scaleX, pose.scaleY));
  return multiply(m, translation(-pivot.x, -pivot.y));
}

/**
 * The group's placement matrix in frame-centre-local space: T·R·K·S about the
 * pivot, then back off it.
 *
 * Same shape as `hopMatrix` and `layerMatrix` — a pivot, the T·R·K·S order the
 * renderer applies, and a step back to the origin — because it is the same
 * operation. A group whose pose is identity returns `null` rather than an
 * identity matrix, so the common case costs a comparison and no multiply.
 */
export function groupDeltaMatrix(
  doc: MotionDocument,
  group: GroupClip,
  localMs: number,
  box?: LayerBox,
): Mat2D | null {
  const pose = groupPoseAt(group, localMs);
  if (groupPoseIsIdentity(pose)) return null;
  return groupMatrixOf(pose, anchorLocal(pose.anchor, box ?? clipBox(doc, group)));
}

/**
 * THE GAP BETWEEN A LAYER'S STORED POSITION AND WHERE IT ACTUALLY SITS — zero
 * for a leaf, the pivot for a group, and THE reason so many surfaces have drawn
 * a group's chrome a whole pivot away from its artwork.
 *
 * `transform.x/y` does not mean the same thing under the document's two
 * placement models:
 *
 *   LEAF    `x/y` IS the pivot's place in the comp.        origin = x/y
 *   GROUP   `x/y` is a DELTA about a pivot derived from
 *           the box of what it holds.                     origin = pivot + x/y
 *
 * So anything that reads a position channel as a POINT — a crosshair, a motion
 * path, a snap candidate, a nudge readout, an alignment — is right for a leaf
 * and off by this for a group. Each surface that noticed wrote its own branch
 * (`clip.kind === "group" ? … : …`), each one had to remember, and the ones that
 * did not remember drew the right shape in the wrong place: the pivot crosshair
 * did this, and then the motion path did it again with a curve that floated off
 * beside the group it belonged to.
 *
 * One term, one place, no branch at the call site:
 *
 *     placed  = transform.x/y + positionOrigin(...)
 *     stored  = placed        − positionOrigin(...)
 *
 * SAMPLED, like everything else here: a keyed pivot makes this offset travel,
 * and a surface reading the resting value would drift away from the picture as
 * the curve moved.
 */
export function positionOrigin(
  doc: MotionDocument,
  clip: Clip,
  localMs: number,
  box?: LayerBox,
): Vec2 {
  if (clip.kind !== "group") return { x: 0, y: 0 };
  return anchorLocal(groupPoseAt(clip, localMs).anchor, box ?? clipBox(doc, clip));
}

/**
 * The pivot as it ends up ON SCREEN — the crosshair's point, after the group's
 * own translation.
 *
 * A pivot is a fixed point of its own transform, so this is simply
 * `pivot + (x, y)`; deriving it that way rather than by mapping the box centre
 * is what keeps the crosshair on the real centre of rotation when the group is
 * scaled or turned.
 */
export function groupPivotPlaced(
  doc: MotionDocument,
  group: GroupClip,
  localMs: number,
  box?: LayerBox,
): Vec2 {
  const pose = groupPoseAt(group, localMs);
  const p = anchorLocal(pose.anchor, box ?? clipBox(doc, group));
  return { x: p.x + pose.x, y: p.y + pose.y };
}

/**
 * How a layer's own local time is found. Time authority lives outside core's
 * geometry (tracks retime, loop and reverse), so the chain asks rather than
 * re-deriving it — which is what keeps a group's silhouette, its pixels and its
 * handles all sampled at the same instant.
 */
export type LocalTimeOf = (clip: Clip) => number;

/**
 * THE GROUP CHAIN for a clip: every enclosing group's delta, composed
 * outermost-first, in frame-centre-local coordinates.
 *
 * Post-multiply a layer's own placement by this and you have where it really
 * sits in its comp. `IDENTITY` for an ungrouped layer, so a caller never
 * branches on whether groups are involved.
 */
export function groupChainMatrix(
  doc: MotionDocument,
  clipId: string,
  localTimeOf: LocalTimeOf,
): Mat2D {
  // `clipAncestorGroups` walks innermost → outermost; composing has to go the
  // other way, because the outer group places the inner one.
  const groups = clipAncestorGroups(doc, clipId);
  // A RIG's bone is one more delta on the way down: after the rig's own, before
  // what is inside it — so a layer riding a bone has its handles, its pivot and
  // its selection box on the bone, by the same matrix that places its pixels.
  const bones = groups.some((g) => g.rig?.bones.length) ? rigidSkins2d(doc, clipId, localTimeOf) : null;
  let m = IDENTITY;
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]!;
    const d = groupDeltaMatrix(doc, g, localTimeOf(g));
    if (d) m = multiply(m, d);
    const s = bones?.get(g.id);
    if (s) m = multiply(m, { a: s[0]!, b: s[1]!, c: s[4]!, d: s[5]!, e: s[12]!, f: s[13]! });
  }
  return m;
}

/** The scale and rotation the group chain adds, for sizing handles and cursors. */
export interface GroupChainPlacement {
  scaleX: number;
  scaleY: number;
  rotation: number;
}

export function groupChainPlacement(
  doc: MotionDocument,
  clipId: string,
  localTimeOf: LocalTimeOf,
): GroupChainPlacement {
  let scaleX = 1;
  let scaleY = 1;
  let rot = 0;
  for (const g of clipAncestorGroups(doc, clipId)) {
    const pose = groupPoseAt(g, localTimeOf(g));
    scaleX *= pose.scaleX;
    scaleY *= pose.scaleY;
    rot += pose.rotation;
  }
  return { scaleX, scaleY, rotation: rot };
}

/**
 * THE COUNTER-MOVE THAT HOLDS THE ART STILL WHEN A PIVOT MOVES — for any layer,
 * derived rather than cased.
 *
 * Moving a pivot must never move the picture. What has to change to keep that
 * promise depends on what the layer's transform MEANS: a leaf layer's `x/y`
 * positions its pivot, so the position travels with it; a group's `x/y` is a
 * delta about its pivot, so the position only has to move by the part of the
 * pivot change the linear map does not already absorb — and when the group is
 * unrotated and unscaled, by nothing at all.
 *
 * Those are two formulas, and writing them as two formulas is how a pivot drag
 * ends up correct for one kind and a teleport for the other. They are not
 * really two facts: both say "the translation column must not change". So this
 * reads the answer straight off the matrices — the difference of their
 * translations — and is exact for both, and for whatever placement model gets
 * added next.
 *
 * Pass the layer's placement matrix with the OLD pivot and with the NEW one,
 * both built with the same translation. The result is what to add to `x/y`.
 */
export function holdStillShift(before: Mat2D, after: Mat2D): Vec2 {
  return shiftToPin(before, after, { x: 0, y: 0 });
}

/**
 * THE TRANSLATION THAT PINS ONE POINT — what to add to a layer's `x/y` so that
 * `q` lands where it landed before, after any change to its placement.
 *
 * `before(q) - after(q)`, and there is nothing else to it. Every "hold the art
 * still" correction in the app is this with a different `q`: the origin when a
 * PIVOT moves (the linear parts match, so every point gives the same answer),
 * the opposite corner when a RESIZE runs, the pivot itself under ⌥.
 *
 * Writing those as separate formulas is how the group resize ended up applying
 * its correction with the sign INVERTED — it moved the box centre by the
 * scale's own effect and then added that again as a position, so a group crept
 * by twice the error every time you pulled a handle.
 */
export function shiftToPin(before: Mat2D, after: Mat2D, q: Vec2): Vec2 {
  const b = apply(before, q);
  const a = apply(after, q);
  return { x: b.x - a.x, y: b.y - a.y };
}

/* ────────────────────────────────────────────── the pivot, for any layer ── */

/**
 * EVERYTHING THE PIVOT GESTURE NEEDS, for whatever it is pointed at.
 *
 * There are two placement models in this document and a pivot behaves
 * differently under each:
 *
 *   A LEAF layer's `x/y` IS its pivot. The pivot is written in the layer's own
 *   local space, so a pointer delta has to be un-rotated and un-scaled into
 *   that space, and moving the pivot drags the position with it.
 *
 *   A GROUP's `x/y` is a DELTA about its pivot, and the pivot is a point in the
 *   comp. A pointer delta is already in that space, and moving the pivot leaves
 *   an unrotated, unscaled group exactly where it was.
 *
 * The on-canvas crosshair used to run the leaf formulas against both. On a
 * group that reads as: the crosshair sits nowhere near the artwork, grabbing it
 * teleports the group by the distance between the frame centre and the real
 * pivot, and the members shoot off screen. Which is exactly what it does.
 *
 * Rather than branch at the gesture — where the branch would have to be
 * repeated by the inspector, the nine-point picker and anything else that moves
 * a pivot — the difference is resolved once, here, into three answers the
 * caller consumes without knowing which model it got. `holdStill` in particular
 * is derived from the two placement matrices rather than written per model, so
 * it stays exact for a placement kind nobody has invented yet.
 */
export interface PivotModel {
  /** The box the normalized anchor is a fraction of. */
  box: LayerBox;
  /** Where the pivot sits now, in the space the anchor resolves into. */
  local: Vec2;
  /** A frame-local pointer delta, in the space the pivot is written in. */
  toPivotSpace: (d: Vec2) => Vec2;
  /** What to ADD to `transform.x/y` so the art holds still at the new anchor. */
  holdStill: (next: AnchorPoint) => Vec2;
}

/** A group's placement matrix with an anchor substituted in — the `holdStill` input. */
function groupMatrixWithAnchor(pose: GroupPose, box: LayerBox, anchor: AnchorPoint): Mat2D {
  return groupMatrixOf(pose, anchorLocal(anchor, box));
}

function affineToMat(a: Affine): Mat2D {
  return { a: a[0], b: a[1], c: a[2], d: a[3], e: a[4], f: a[5] };
}

export function pivotModel(
  doc: MotionDocument,
  clip: Clip,
  pose: {
    x: number;
    y: number;
    scale: number;
    scaleY: number;
    rotation: number;
    skewX: number;
    skewY: number;
    anchor: AnchorPoint;
  },
  /**
   * The layer's box, when the caller already holds it. Moving a pivot never
   * changes the box, so a gesture measures it ONCE and hands it back on every
   * move — which matters most for the kind whose box is most expensive: a
   * group's is a walk of every member it holds, at every depth.
   */
  box0?: LayerBox,
): PivotModel | null {
  if (clip.kind === "audio") return null;
  const box = box0 ?? clipBox(doc, clip);

  if (clip.kind === "group") {
    const gp: GroupPose = {
      x: pose.x,
      y: pose.y,
      rotation: pose.rotation,
      scaleX: pose.scale,
      scaleY: pose.scaleY,
      skewX: pose.skewX,
      skewY: pose.skewY,
      anchor: pose.anchor,
    };
    const before = groupMatrixWithAnchor(gp, box, pose.anchor);
    return {
      box,
      local: anchorLocal(pose.anchor, box),
      // A group's pivot lives in the COMP, alongside the members it turns — so
      // the pointer is already speaking its language.
      toPivotSpace: (d) => d,
      holdStill: (next) => holdStillShift(before, groupMatrixWithAnchor(gp, box, next)),
    };
  }

  const basis = {
    scale: pose.scale,
    scaleY: pose.scaleY,
    rotation: pose.rotation,
    skewX: pose.skewX,
    skewY: pose.skewY,
    anchor: pose.anchor,
    size: box,
  };
  const before = affineToMat(layerMatrix(basis));
  return {
    box,
    local: anchorLocal(pose.anchor, box),
    // A leaf's pivot is written in its OWN local space, so the pointer has to
    // come back through rotate → shear → scale to be measured against it.
    toPivotSpace: (d) => unmapLocal(d.x, d.y, basis),
    holdStill: (next) =>
      holdStillShift(before, affineToMat(layerMatrix({ ...basis, anchor: next }))),
  };
}

/**
 * The channels the layer's LINEAR map reads. Keyed, and a pivot move corrects
 * every position key by its own amount; un-keyed, one vector serves them all.
 */
const SHAPES_THE_MAP = new Set([
  "rotation",
  "scale",
  "scaleY",
  "skewX",
  "skewY",
  "anchor.x",
  "anchor.y",
]);

/** A layer's placement channels at one instant — what a pivot move holds still. */
export interface PivotPose {
  x: number;
  y: number;
  scale: number;
  scaleY: number;
  rotation: number;
  skewX: number;
  skewY: number;
  anchor: AnchorPoint;
}

/**
 * The placement channels a layer renders with at `localMs`: each keyed channel
 * sampled, the rest from the stored transform, `scaleY` following `scale`
 * when it has no value of its own. ONE sampler for every pivot move — the
 * stage's crosshair drag and `layer.pivot` hold the art still against the same
 * numbers.
 */
export function pivotPoseAt(clip: Clip, localMs: number): PivotPose {
  if (clip.kind === "audio") return { x: 0, y: 0, scale: 1, scaleY: 1, rotation: 0, skewX: 0, skewY: 0, anchor: { x: 0.5, y: 0.5 } };
  const kf = sampleKeyframes(clip.keyframes, localMs);
  const t = clip.transform;
  const n = (k: string, d: number) => (typeof kf[k] === "number" ? (kf[k] as number) : d);
  const scale = n("scale", t.scale);
  return {
    x: n("x", t.x),
    y: n("y", t.y),
    scale,
    scaleY: sampledScaleY(kf, t.scaleY) ?? scale,
    rotation: n("rotation", t.rotation),
    skewX: n("skewX", t.skewX),
    skewY: n("skewY", t.skewY),
    anchor: { x: n("anchor.x", t.anchor.x), y: n("anchor.y", t.anchor.y) },
  };
}

/**
 * RE-PIVOT A LAYER WITHOUT MOVING IT — the whole operation, headless.
 *
 * The crosshair gesture computes a new anchor; everything after that is
 * document surgery, and it is more than one write. Doing it at the call site
 * got two things wrong:
 *
 * IT ONLY FIXED THIS FRAME. `x`/`y` are animatable, so a layer with position
 * keys carries the correction in its BASE value while every key keeps the old
 * one. The art held still at the playhead and slid everywhere else — the motion
 * path visibly changed shape, which is "moving the pivot changes its position".
 * Every key has to move, and by its OWN correction: the shift depends on the
 * pose at that instant, and rotation and scale are animatable too.
 *
 * IT ASSUMED ONE PLACEMENT MODEL. See `pivotModel` — a group's `x/y` is a delta
 * about its pivot, not the pivot itself, so the correction is a different
 * formula and on an unrotated group it is zero.
 *
 * Both are handled by asking, at each instant, what the layer's placement WAS
 * and what it WOULD BE, and pinning the difference (`shiftToPin`). Returns
 * false when there is nothing to re-pivot.
 */
export function repivotClip(
  doc: MotionDocument,
  clip: Clip,
  nextAnchor: AnchorPoint,
  poseAt: (localMs: number) => {
    x: number;
    y: number;
    scale: number;
    scaleY: number;
    rotation: number;
    skewX: number;
    skewY: number;
    anchor: AnchorPoint;
  },
  playheadLocalMs: number,
  /** The layer's box — measured once by the gesture; see `pivotModel`. */
  box?: LayerBox,
): boolean {
  if (clip.kind === "audio") return false;

  /** The hold-still correction at one instant. */
  const shiftAt = (localMs: number): Vec2 => {
    const model = pivotModel(doc, clip, poseAt(localMs), box);
    return model ? model.holdStill(nextAnchor) : { x: 0, y: 0 };
  };

  // The base values always move: they are what an un-keyed channel renders, and
  // what a key added later starts from.
  const base = shiftAt(playheadLocalMs);
  clip.transform.x += base.x;
  clip.transform.y += base.y;

  /*
   * THE MOTION PATH TRAVELS WITH THE PIVOT, AS ONE PIECE — and almost always
   * for free.
   *
   * The correction at a key is `L(pivot₁ − pivot₀)`, with `L` the layer's own
   * linear map (rotate ∘ shear ∘ scale) at that instant. Those channels are
   * animatable, so in general each key moves by its own amount and the path
   * genuinely changes shape — that is not a bug, it is what holding the art
   * still at every frame requires, and After Effects does the same.
   *
   * But when nothing in `L` is keyed — which is the overwhelming majority of
   * animated layers — `L` is identical at every instant, so every key moves by
   * the SAME vector and the whole path simply TRANSLATES. Recognising that is
   * worth a great deal more than the arithmetic it saves: this runs on every
   * pointer move of a pivot drag, and the general path builds two matrices per
   * key and, for a group, re-measures a box that is a walk of every member at
   * every depth. A long path on a group turned a 1-frame drag into a stutter.
   * One vector, reused, and the drag tracks the pointer again.
   */
  const shaped = clip.keyframes.some(
    (t) => !t.range && SHAPES_THE_MAP.has(t.property),
  );
  for (const track of clip.keyframes) {
    if (track.property !== "x" && track.property !== "y") continue;
    for (const key of track.keys) {
      if (typeof key.value !== "number") continue;
      const s = shaped ? shiftAt(key.timeMs) : base;
      key.value += track.property === "x" ? s.x : s.y;
    }
  }

  clip.transform.anchor = { x: nextAnchor.x, y: nextAnchor.y };
  // A KEYED pivot is a real thing (an orbit centre that travels), so an existing
  // anchor track is rebased rather than ignored — the drag sets where the pivot
  // is NOW, and the curve keeps its shape around it.
  for (const track of clip.keyframes) {
    if (track.property !== "anchor.x" && track.property !== "anchor.y") continue;
    const from = poseAt(playheadLocalMs).anchor;
    const d = track.property === "anchor.x" ? nextAnchor.x - from.x : nextAnchor.y - from.y;
    for (const key of track.keys) {
      if (typeof key.value === "number") key.value += d;
    }
  }
  return true;
}
