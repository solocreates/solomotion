import type { MotionDocument, GroupClip, Paint } from "../schema";
import { hasPoseAnimation } from "../animation/reveal";
import { clipAncestorGroups } from "./groups";

/**
 * A GROUP'S OWN LOOK — the paint it wears over what it holds, and when it has
 * to isolate to wear it.
 *
 * **The group is the surface.** Everything a group carries — its fill, its
 * stroke, its effects, its opacity, its blend — applies to the ONE picture its
 * members make, not to the members one at a time. That is the whole model, and
 * it is why a shine on a group sweeps across the group instead of N times, why
 * its stroke is one silhouette rather than an outline per member, and why its
 * fill reaches a text layer, a nested sub-group and a photo alike without any
 * of them knowing a group exists.
 *
 * The fill used to cascade by INHERITANCE: read through to children that had
 * none of their own. It was the wrong model twice over. Every clip is born with
 * a fill, so in practice the group's fill reached nothing and the control did
 * nothing — you set a colour on a group and the canvas did not move. And where
 * it did land it landed per child, so a gradient was re-evaluated inside each
 * member's own box: five copies of one ramp instead of one ramp across the
 * artwork, which is never what anyone means by "put this gradient on the logo".
 *
 * Painting it OVER the group's finished pixels answers both: it overrides every
 * descendant because it is composited after all of them; it is one gradient
 * across the group's box; and it is still a resolution rule, not a write — the
 * children's own paint is untouched in the document, so clearing the group's
 * fill (or dragging a layer out of the group) restores everything exactly.
 */

/**
 * The paint a group wears OVER its members' combined pixels, masked by their
 * alpha — so it recolours the artwork and never boxes it.
 *
 * Empty for a laid-out group: a container's fill is its own BOX
 * (`relations/layout.ts`), painted BEHIND the members as a background, which is
 * what makes it a Figma frame rather than a group with a tint. One group kind
 * cannot sensibly mean both, and "has a box" is the discriminant.
 */
export function groupTintFills(group: GroupClip): readonly Paint[] {
  return group.layout ? [] : group.fills;
}

/**
 * Does this group have to composite into a buffer of its own?
 *
 * A plain `pass` group with default everything must NOT isolate — its members
 * blend with what is beneath them in the frame, which is what a group meant
 * before it could carry a look, and what every document made before v66
 * renders as. Isolation is bought only by something that genuinely needs the
 * group's finished pixels: a composite mode, a blend or opacity applied to the
 * whole, a pixel effect, a feather, a crop, a rounded box, a tint laid over the
 * result, or a silhouette stroke drawn around it.
 *
 * Derived, never stored, so a group that has its effects removed goes straight
 * back to costing nothing.
 */
export function groupNeedsIsolation(group: GroupClip): boolean {
  return (
    group.mode !== "pass" ||
    group.blendMode !== "normal" ||
    group.opacity < 0.999 ||
    group.effects.length > 0 ||
    group.strokes.length > 0 ||
    group.feather > 0.01 ||
    // Keyed, they are a look on the frames they are keyed for: judged on the
    // resting value alone, a group fading out painted its members at full
    // strength whenever its base opacity happened to be 1.
    group.keyframes.some((t) => (t.property === "opacity" || t.property === "feather") && t.keys.length > 0) ||
    // The tint is composited ATOP the members, so it needs them as one picture.
    // A container's background fill does not — it paints behind them, in place.
    groupTintFills(group).length > 0 ||
    // A POSE animation needs the finished pixels to move; a draw-on paints
    // inside each member's own strokes and needs nothing composited.
    hasPoseAnimation(group) ||
    group.crop.top > 0 || group.crop.right > 0 || group.crop.bottom > 0 || group.crop.left > 0 ||
    group.borderRadius.tl > 0 || group.borderRadius.tr > 0 ||
    group.borderRadius.br > 0 || group.borderRadius.bl > 0
  );
}

/** Does this group move, scale, rotate or skew what it holds? */
export function groupHasTransform(group: GroupClip): boolean {
  const t = group.transform;
  return (
    t.x !== 0 || t.y !== 0 || t.rotation !== 0 || t.skewX !== 0 || t.skewY !== 0 ||
    t.scale !== 1 || (t.scaleY != null && t.scaleY !== t.scale)
  );
}

/**
 * Does this group carry anything of its OWN — a look or a placement — beyond
 * simply containing? What a serializer that cannot express containers has to
 * flatten (SVG), what an exporter that cannot express them has to warn about
 * (Lottie), and what the timeline bar shows a badge for.
 *
 * A container's background fill counts even though it never tints: it is a box
 * that has to be drawn, and drawing the members alone would lose it.
 */
export function groupCarriesLook(group: GroupClip): boolean {
  return groupNeedsIsolation(group) || groupHasTransform(group) || group.fills.length > 0;
}

/**
 * THE COMPOSITING UNIT a clip belongs to — the outermost enclosing group that
 * has to be drawn as ONE picture, or null when the clip composites for itself.
 *
 * This is the question every surface that wants to render *part* of a scene has
 * to ask, and until v79 nothing did. A group carrying a look is not a container
 * of N independently drawable layers; it is one layer whose pixels happen to be
 * made by N children. Lift a member out of it — to render it on its own, to
 * cache the rest, to hand it to a worker — and the group's glass refracts that
 * member alone, its stroke runs around whichever members were left behind, its
 * tint lands twice and its opacity multiplies where they overlap. That is one
 * bug, not four, and it is this function's absence.
 *
 * OUTERMOST, not nearest: a plain `pass` group inside a glass one is still part
 * of the glass one's picture, so the unit is the last isolating ancestor on the
 * chain rather than the first.
 *
 * `groupNeedsIsolation` is the predicate because it is already the renderer's
 * own test for "does this group composite into a buffer of its own" — one
 * answer, so a group that starts needing a buffer starts being a unit in the
 * same motion, and a new reason to isolate needs no second edit here.
 */
export function compositingUnitOf(doc: MotionDocument, clipId: string): string | null {
  let unit: string | null = null;
  // Innermost → outermost, so the LAST match wins.
  for (const group of clipAncestorGroups(doc, clipId)) {
    if (groupNeedsIsolation(group)) unit = group.id;
  }
  return unit;
}
