import { rebaseAnchor, type LayerBox } from "./transform-map";
import { subpathBounds } from "./vector/geometry";
import { healContourIds } from "./vector/contour-id";
import { pruneContourStyles } from "./vector/contour-style";
import { copySubpaths } from "./vector/geometry";
import { followPathTopology } from "./shape-keys/topology";
import type { AnchorPoint, Contour, KeyframeTrack, PathClip, Subpath, Transform } from "./schema";

/**
 * Keeping a layer's PIVOT still while the layer's own box moves underneath it.
 *
 * `transform-map.ts` owns the arithmetic; this file owns the one rule that
 * arithmetic exists for, and the seam every content edit has to pass through to
 * obey it:
 *
 *   **A content edit edits content.** It must not move the layer, and it must
 *   not move the pivot the user placed on it.
 *
 * The pivot is stored as a fraction of the layer's box (see transform-map for
 * why), and a path's box is DERIVED from its outline — so a node drag silently
 * redefines the very box the fraction is a fraction of. Anything that writes a
 * path's geometry therefore goes through `editPathGeometry`/`setPathGeometry`
 * here instead of assigning `clip.subpaths`, and the pivot comes out where it
 * went in. Assigning `subpaths` directly is the bug; there is deliberately no
 * other supported way to write it.
 */

/** The minimum a clip has to be for its pivot to need maintaining. */
interface Pivoted {
  transform: Transform;
  keyframes: KeyframeTrack[];
}

/** The box an outline declares: its extent, and where that extent sits. */
export function pathBox(subpaths: ReadonlyArray<Contour>): LayerBox {
  const b = subpathBounds(subpaths);
  if (!b) return { width: 0, height: 0, cx: 0, cy: 0 };
  return {
    width: b.maxX - b.minX,
    height: b.maxY - b.minY,
    cx: (b.minX + b.maxX) / 2,
    cy: (b.minY + b.maxY) / 2,
  };
}

/**
 * PIVOT AT THE OUTLINE'S OWN ORIGIN — for an outline given in coordinates that
 * mean something (`layer.create {kind: "path", d}`): its 0,0 becomes the pivot,
 * so the layer's x/y is where that 0,0 lands and every point lands where `d`
 * says. The default centred pivot put the outline's BOX centre at x/y, so an
 * arc written about a circle's centre landed beside the circle.
 *
 * An outline flat on an axis has no box to be a fraction of there; the pivot
 * stays on the line and the layer moves by the line's offset instead — the
 * same place for the art either way.
 */
export function pivotAtPathOrigin(clip: PathClip): void {
  const box = pathBox(clip.subpaths);
  const axis = (size: number, centre: number): { anchor: number; shift: number } =>
    size > 1e-6 ? { anchor: 0.5 - centre / size, shift: 0 } : { anchor: 0.5, shift: centre };
  const x = axis(box.width, box.cx);
  const y = axis(box.height, box.cy);
  clip.transform.anchor = { x: x.anchor, y: y.anchor };
  clip.transform.x += x.shift;
  clip.transform.y += y.shift;
}

/**
 * Re-express a clip's pivot against a box that just changed, so the pivot —
 * and therefore the art hanging off it — stays exactly where it is.
 *
 * Rewrites the resting value AND any `anchor.x`/`anchor.y` keys: a keyframed
 * pivot is still a pivot, and rebasing only the base would leave the animated
 * frames drifting while the resting one held still (the worst of both).
 */
export function keepPivotThroughBoxChange(clip: Pivoted, before: LayerBox, after: LayerBox): void {
  if (before.width === after.width && before.height === after.height && before.cx === after.cx && before.cy === after.cy) {
    return;
  }
  const rebase = (a: AnchorPoint) => rebaseAnchor(a, before, after);
  clip.transform.anchor = rebase(clip.transform.anchor);
  const xs = clip.keyframes.find((t) => !t.range && t.property === "anchor.x");
  const ys = clip.keyframes.find((t) => !t.range && t.property === "anchor.y");
  if (!xs && !ys) return;
  // The axes are independent, so each track rebases against the resting value of
  // the other — which is what it was already rendering with when only one axis
  // is keyed, and what the paired key at the same time evaluates to when both
  // are (the rebase is affine per axis, so pairing exactly is not needed).
  for (const k of xs?.keys ?? []) {
    if (typeof k.value === "number") k.value = rebase({ x: k.value, y: clip.transform.anchor.y }).x;
  }
  for (const k of ys?.keys ?? []) {
    if (typeof k.value === "number") k.value = rebase({ x: clip.transform.anchor.x, y: k.value }).y;
  }
}

/**
 * THE way to change a path clip's outline: mutate it in place through here, and
 * the pivot is held for you.
 *
 * Pass the mutation rather than the result so the before/after boxes are read
 * around it — a caller can't forget the half that matters, and the pure ops in
 * `vector/edit-engine.ts` (which know nothing about transforms) drop straight
 * in as the callback.
 */
export function editPathGeometry(clip: PathClip, mutate: (subpaths: Subpath[]) => void): void {
  const before = pathBox(clip.subpaths);
  // Shape keys follow every point added, removed or reordered — here, so no op
  // has to know keys exist (the same reason ids and overrides heal here).
  const keyed = clip.shapeKeys?.length ? copySubpaths(clip.subpaths) : null;
  mutate(clip.subpaths);
  // The same seam now also keeps the layer's two lists agreeing. A structural op
  // splits a run by SPREADING the one it came from, so the halves arrive sharing
  // an id and a part — correct about the part, wrong about identity, and healing
  // it here is why no op has to know that parts exist. (`healContourIds` is
  // idempotent, so the ops that only move points pay a walk and nothing else.)
  healContourIds(clip);
  if (keyed) followPathTopology(clip.shapeKeys, keyed, clip.subpaths);
  // …and forgets the overrides of contours this edit removed. Same reason and
  // same seam: an op that deletes a run must not leave a style pointing at
  // nothing, and pruning HERE is why no op has to know overrides exist.
  pruneContourStyles(clip);
  keepPivotThroughBoxChange(clip, before, pathBox(clip.subpaths));
}

/** `editPathGeometry` for callers that already hold the finished outline. */
export function setPathGeometry(clip: PathClip, subpaths: Subpath[]): void {
  editPathGeometry(clip, (subs) => {
    subs.length = 0;
    subs.push(...subpaths);
  });
}
