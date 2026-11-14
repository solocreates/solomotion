import {
  addClipToTrack,
  stackPaintOrder,
  cloneClip,
  locateClip,
  nestNewClips,
  reconcileFillClips,
  reissueClipIds,
  replaceClipInPlace,
} from "../timeline/ops";
import { VECTOR_SOURCE_TAG } from "../navigation/scope";
import { createCarrierTrack } from "../factories";
import { editPathGeometry, pathBox } from "../pivot";
import { anchorLocal, basisOfTransform, mapLinear, mapLocal, rebaseAnchor, unmapLinear, type LayerBasis, type LayerBox } from "../transform-map";
import type { MotionDocument, PathClip, PathPoint, ScopeOverlay, Subpath, Transform } from "../schema";
import { emptyOverlay } from "../schema/scope";
import { healContourIds, newContourId } from "./contour-id";
import { bakeContourStyle, detach } from "./contour-style";
import { separateRegions } from "./regions";

/**
 * PROMOTION — the moment artwork stops being one picture and becomes pieces.
 *
 * The rule, and the whole reason this is small: a piece of a vector is a LAYER.
 * So promotion mints `path` clips, and every piece inherits fill, stroke,
 * transform, effects, morph, trim, in/out animation, motion blur, keyframes, a
 * row in the layers list, a context menu, the clipboard and property transfer —
 * not because any of that was written for pieces, but because it was written
 * for clips and a piece IS one.
 *
 * ## The bar: promotion must be INVISIBLE
 *
 * The art does not move by one pixel, the timeline does not change, and the
 * only evidence anything happened is that the layers list gained rows. Two
 * things are needed for that and nothing else is:
 *
 *  - **Geometry is copied verbatim.** Nothing is re-centred. A path clip's box
 *    is DERIVED from its outline (`pathBox`), so each piece already has a tight
 *    box of its own without any coordinates being touched — and untouched
 *    coordinates cannot drift.
 *  - **The pivot keeps its LOCAL POINT.** Each piece has a different box, so
 *    the same stored fraction would name a different point and a rotated or
 *    scaled layer would visibly jump apart. `rebaseAnchor` re-expresses the
 *    fraction against the piece's own box — the identical rule a geometry edit
 *    already uses, for the identical reason.
 *
 * Callers do not decide when this applies: `separateRegions` does. A donut and
 * its hole stay one layer because a hole cannot have its own colour.
 */

/**
 * The pieces `clip` would become, or null when it is already one piece.
 *
 * **In PAINT order** — `subpaths[0]`'s region leads, because `subpaths` order
 * IS paint order and that is the one fact a split must not lose. Every
 * placement API in the timeline takes its clips TOPMOST-first, so a caller that
 * hands this list straight to one is asking for the stack upside down; use
 * `stackPaintOrder` at that seam, which is what `mergeVectorClips` reads back.
 *
 * Pure: nothing is inserted, nothing is mutated. The caller places the result,
 * which is what lets the knife, the pen, an import and a menu command share one
 * definition of "what the pieces are" while each owns its own slot.
 */
export function pathClipRegions(clip: PathClip): PathClip[] | null {
  const regions = separateRegions(clip.subpaths, clip.fillRule);
  if (regions.length <= 1) return null;
  const from = pathBox(clip.subpaths);
  return regions.map((region, i) => {
    // BAKE BEFORE REISSUING. An overlay's paths name the SOURCE's fill and
    // stroke ids (`fill.<id>.color`), and `reissueClipIds` re-mints exactly
    // those — so baking after it would write to entries that no longer exist
    // and the override would silently vanish at the moment it mattered most.
    const draft = cloneClip(clip) as PathClip;
    const solo = region.contours.length === 1 ? clip.contourStyles[region.contours[0]!.id] : undefined;
    if (solo) bakeContourStyle(draft, solo);
    const piece = reissueClipIds(draft) as PathClip;
    piece.subpaths = region.contours.map((c) => ({ ...c }));
    healContourIds(piece);
    piece.transform = {
      ...piece.transform,
      anchor: rebaseAnchor(clip.transform.anchor, from, pathBox(piece.subpaths)),
    };
    piece.name = `${clip.name} ${i + 1}`;
    // An override made BEFORE the split is an override you still have after it.
    // A single-contour piece baked its overlay into its own real fields above,
    // so it carries none. A compound piece (a shape and its holes) keeps the
    // overlays it had: a hole has no colour of its own to bake, and the outline
    // it belongs to still owns the look.
    piece.contourStyles = {};
    if (!solo) {
      for (const c of region.contours) {
        const ov = clip.contourStyles[c.id];
        if (ov) piece.contourStyles[c.id] = detach(ov);
      }
    }
    return piece;
  });
}

/** What promotion produced. */
export interface Promotion {
  /** The vector GROUP the pieces went into, or null when they joined an
   *  existing one (see `promotePathClip`). */
  nestedId: string | null;
  /** The pieces, in region order. */
  pieceIds: string[];
}

/**
 * Split a path clip into its pieces — as a VECTOR GROUP.
 *
 * The pieces do not land on the timeline you were looking at. A logo is one
 * thing with twelve parts, and separating it into twelve root lanes is not
 * "more control", it is a comp you can no longer read: the parent stack grows
 * by eleven, every layer below shifts, and the twelve pieces have nothing
 * holding them together as the artwork they are. So one layer goes in and ONE
 * layer comes out, in the same lane, at the same z, and the pieces live inside
 * it — visible under its disclosure triangle in the Layers panel, selectable in
 * place, each with its own fill, transform, effects, morph and keyframes,
 * because each is an ordinary `path` clip.
 *
 * A vector group is not a new concept and this mints nothing new: it is a
 * nested clip, built by `nestNewClips`, which already guarantees the pixels do
 * not move (the comp is content-sized and the offset moves into the group).
 *
 * The ONE exception, and it is the obvious one: artwork already living inside a
 * vector group. Cutting a piece in two there makes two siblings in that group,
 * not a group inside a group — you asked for another piece, not another level.
 *
 * Returns null when the artwork was already a single piece.
 */
export function promotePathClip(doc: MotionDocument, clipId: string): Promotion | null {
  const loc = locateClip(doc, clipId);
  if (loc?.clip.kind !== "path") return null;
  const source = loc.clip;
  const pieces = pathClipRegions(source);
  if (!pieces) return null;

  const name = source.name;
  const home = doc.frames.find((f) => f.id === source.frameId);
  // Already inside a vector group: the pieces are siblings there.
  const insideGroup = home?.sourceTag === VECTOR_SOURCE_TAG;

  const pieceIds = pieces.map((p) => p.id);

  // Already inside a vector group: the pieces are siblings there, in this comp.
  if (insideGroup) {
    if (!replaceClipInPlace(doc, clipId, stackPaintOrder(pieces))) return null;
    return { nestedId: null, pieceIds };
  }

  // Wrap. The pieces are BORN inside the group and the group takes the source's
  // own slot, so the parent never grows a lane per piece only to have it
  // emptied and pruned a moment later. One layer in, one layer out, and no
  // intermediate state to leave wreckage behind when the prune misses one.
  const nestedId = nestNewClips(doc, source.frameId, stackPaintOrder(pieces), { name, slotClipId: clipId });
  if (!nestedId) return { nestedId: null, pieceIds };

  const nested = locateClip(doc, nestedId)?.clip;
  if (nested?.kind === "nested") {
    nested.name = name;
    for (const id of pieceIds) {
      const piece = locateClip(doc, id)?.clip;
      // The pieces span their group, and follow when it is trimmed.
      if (piece) piece.fillDuration = true;
    }
    reconcileFillClips(doc, nested.sourceFrameId);
    const frame = doc.frames.find((f) => f.id === nested.sourceFrameId);
    if (frame) {
      // Stamp it as vector artwork so the breadcrumb, the badge and the
      // "already inside a group" test above all read it the same way — and so
      // cutting a piece in here adds a sibling instead of another level.
      frame.sourceTag = VECTOR_SOURCE_TAG;
      frame.name = name || "Vectors";
    }
  }
  return { nestedId, pieceIds };
}


/* ------------------------------------------------- inherit, until you don't */

/**
 * Give ONE piece of a vector its own everything — the "override" half of
 * inherit-by-default.
 *
 * The default is already right and costs nothing: contours in a layer share
 * that layer's fill, stroke, effects, morph and timing, because they are one
 * layer. The question is what happens the moment you want one of them to differ
 * — a single petal in another colour, one letter that trims on its own.
 *
 * The tempting answer is a per-contour style block that inherits from the
 * layer. It is the wrong one, and specifically: `fill` is the first field, then
 * `stroke`, then `opacity`, then `blendMode`, then transform (a petal has to
 * rotate), then effects, then keyframes for all of it, then a `part.<id>.…`
 * keyframe path family, then a resolver at every read site — and at the end you
 * have rebuilt `Clip` one level down, and every feature the app grows after
 * that has to be implemented twice. That is the model this file's header exists
 * to refuse.
 *
 * So the override IS a layer. `extractContours` lifts the named contours into
 * their own `path` clip, sitting directly above the remainder inside the same
 * vector group — where it inherits nothing at render time because it was given
 * a COPY of everything the source had. The visual result is identical the
 * instant it happens (same style, same transform, same pixels); it just has
 * somewhere of its own to put the change you are about to make. From that
 * moment it has fill, stroke, opacity, blend, transform, effects, morph, trim,
 * in/out, motion blur and keyframes — not because they were written for pieces,
 * but because they were written for clips.
 *
 * And the parent timeline never learns about it: inside a vector group, all of
 * this happens one level down.
 *
 * Returns the new clip's id, or null when the request is meaningless (an
 * unknown clip, no contours named, or ALL of them — extracting everything
 * leaves nothing to differ FROM, so it is a rename, not an override).
 */
export function extractContours(
  doc: MotionDocument,
  clipId: string,
  contourIds: ReadonlyArray<string>,
): string | null {
  const loc = locateClip(doc, clipId);
  if (loc?.clip.kind !== "path") return null;
  const source = loc.clip;
  const wanted = new Set(contourIds);
  const taken = source.subpaths.filter((c) => wanted.has(c.id));
  if (taken.length === 0 || taken.length === source.subpaths.length) return null;

  const from = pathBox(source.subpaths);
  // Bake before reissuing, for the reason in `pathClipRegions`.
  const draft = cloneClip(source) as PathClip;
  const solo = taken.length === 1 ? source.contourStyles[taken[0]!.id] : undefined;
  if (solo) bakeContourStyle(draft, solo);
  const piece = reissueClipIds(draft) as PathClip;
  piece.subpaths = taken.map((c) => ({ ...c }));
  healContourIds(piece);
  piece.transform = {
    ...piece.transform,
    anchor: rebaseAnchor(source.transform.anchor, from, pathBox(piece.subpaths)),
  };
  piece.name = `${source.name} piece`;
  // Whatever it was overriding becomes what it IS. One contour baked above;
  // several carry their overlays across, still overriding the same look.
  piece.contourStyles = {};
  if (!solo) {
    for (const c of taken) {
      const ov = source.contourStyles[c.id];
      if (ov) piece.contourStyles[c.id] = detach(ov);
    }
  }

  // The remainder loses those contours through the ONE geometry write seam, so
  // its pivot is held across the box change exactly as any other edit's is.
  editPathGeometry(source, (subs) => {
    const kept = subs.filter((c) => !wanted.has(c.id));
    subs.length = 0;
    subs.push(...kept);
  });

  // Directly above the remainder: the piece was painted last within its layer,
  // so it stays painted last, and the pixels do not move.
  const carrier = createCarrierTrack(piece.name);
  carrier.color = loc.track.color;
  carrier.heightPx = loc.track.heightPx;
  carrier.homeCompId = loc.track.homeCompId;
  doc.tracks.splice(loc.trackIndex, 0, carrier);
  addClipToTrack(carrier, piece);
  return piece.id;
}

/** Is this clip a VECTOR GROUP — a nested clip whose inside is artwork? */
export function isVectorGroup(doc: MotionDocument, clip: { kind: string; sourceFrameId?: string }): boolean {
  if (clip.kind !== "nested" || !clip.sourceFrameId) return false;
  return doc.frames.find((f) => f.id === clip.sourceFrameId)?.sourceTag === VECTOR_SOURCE_TAG;
}

/* ------------------------------------------------------------- the inverse */

/**
 * MERGE — put the pieces back into one layer.
 *
 * Split and merge are one gesture and its undo, so this is the exact inverse of
 * `promotePathClip`: a vector group collapses back to a single `path` clip, in
 * the group's own lane and slot, with every piece's contours in paint order and
 * the pixels unmoved.
 *
 * Nothing is lost, which is the part that has to be right. A piece that carried
 * its own fill is not silently repainted in the survivor's colour — its style
 * becomes a per-contour OVERRIDE (`contourStyles`), the same overlay it would
 * have had if you had never split. So split → merge → split is a round trip,
 * and "treat this as one layer" stops being a lie about what is underneath.
 *
 * Geometry is re-expressed in the survivor's space (each piece's own transform
 * is baked into its points through the one local→world map), so pieces that
 * were moved, scaled or rotated apart still land exactly where they were.
 *
 * Accepts either the GROUP (a nested clip over vector art) or a set of sibling
 * path clips. Returns the surviving clip's id, or null when there is nothing to
 * merge.
 */
export function mergeVectorClips(doc: MotionDocument, clipIds: ReadonlyArray<string>): string | null {
  const first = clipIds.length === 1 ? locateClip(doc, clipIds[0]!) : null;
  // A group: merge what is INSIDE it, then put the result where the group was.
  if (first && first.clip.kind === "nested") {
    const source = first.clip.sourceFrameId;
    const inside = doc.tracks
      .flatMap((t) => t.clips)
      .filter((c) => c.frameId === source && c.kind === "path")
      .map((c) => c.id);
    if (inside.length === 0) return null;
    const mergedId = mergeVectorClips(doc, inside);
    const merged = mergedId ? locateClip(doc, mergedId) : null;
    if (!merged || merged.clip.kind !== "path") return null;
    // Lift it into the parent, carrying the group's own pose so the artwork
    // stays exactly where the group put it.
    // The survivor STANDS IN FOR THE GROUP, so it inherits the group's whole
    // container: its span, its keyframes and drivers, its effects, its in/out
    // animation, its opacity and blending. Merging collapses what is INSIDE the
    // group — it is not a reason to throw away the animation you put ON it.
    // Taking only the geometry was the bug: you staggered a logo, merged it,
    // and the stagger's carrier vanished with the group.
    const group = cloneClip(first.clip) as typeof first.clip;
    const lifted = cloneClip(merged.clip) as PathClip;
    lifted.frameId = group.frameId;
    lifted.startMs = group.startMs;
    lifted.durationMs = group.durationMs;
    lifted.fillDuration = false;
    lifted.name = group.name;
    lifted.keyframes = group.keyframes;
    lifted.drivers = group.drivers;
    lifted.modulators = group.modulators;
    lifted.linkGroupId = group.linkGroupId;
    lifted.effects = group.effects;
    lifted.animIn = group.animIn;
    lifted.animOut = group.animOut;
    lifted.opacity = group.opacity;
    lifted.blendMode = group.blendMode;
    lifted.motionBlur = group.motionBlur;
    lifted.hidden = group.hidden;
    lifted.locked = group.locked;
    composeInto(lifted, first.clip.transform, merged.clip.transform, pathBox(merged.clip.subpaths));
    merged.track.clips.splice(merged.track.clips.indexOf(merged.clip), 1);
    replaceClipInPlace(doc, first.clip.id, [lifted]);
    return lifted.id;
  }

  const pieces = clipIds
    .map((id) => locateClip(doc, id))
    .filter((l): l is NonNullable<typeof l> => l?.clip.kind === "path");
  if (pieces.length === 0) return null;
  if (pieces.length === 1) return pieces[0]!.clip.id;

  // Paint order is z-order: the BOTTOM lane paints first, so it leads the list
  // and the survivor keeps the stack you were looking at.
  const ordered = [...pieces].sort((a, b) => b.trackIndex - a.trackIndex);
  const host = ordered[ordered.length - 1]!; // topmost — its lane survives
  // Read PLAIN SNAPSHOTS, never the immer drafts. Everything below is assembled
  // into a clip that gets stored, and a draft proxy smuggled into stored data
  // (through a spread, or through `detach` on an overlay) throws DataCloneError
  // in the next `structuredClone` — far from here and unreadable when it does.
  // `cloneClip` is the one unwrap, so take it once and build from the result.
  const snap = new Map(ordered.map((p) => [p.clip.id, cloneClip(p.clip) as PathClip]));
  const survivor = cloneClip(host.clip) as PathClip;
  survivor.subpaths = [];
  survivor.contourStyles = {};

  const hostClip = snap.get(host.clip.id)!;
  const hostBasis = basisOfTransform(hostClip.transform, pathBox(hostClip.subpaths));
  for (const p of ordered) {
    const piece = snap.get(p.clip.id)!;
    const same = p.clip.id === host.clip.id;
    const basis = basisOfTransform(piece.transform, pathBox(piece.subpaths));
    for (const contour of piece.subpaths) {
      const moved: Subpath = same
        ? { ...contour, points: contour.points.map((pt) => ({ ...pt })) }
        : { ...contour, points: contour.points.map((pt) => rebasePoint(pt, piece.transform, basis, hostClip.transform, hostBasis)) };
      moved.id = newContourId();
      survivor.subpaths.push(moved);
      // A piece that differed keeps differing — as an override rather than by
      // being repainted in the survivor's colour.
      const ov = piece.contourStyles[contour.id];
      if (ov) survivor.contourStyles[moved.id] = detach(ov);
      else if (!same) {
        const diff = styleDiff(hostClip, piece);
        if (diff) survivor.contourStyles[moved.id] = diff;
      }
    }
  }
  healContourIds(survivor);

  for (const p of ordered) {
    if (p.clip.id === host.clip.id) continue;
    p.track.clips.splice(p.track.clips.indexOf(p.clip), 1);
  }
  replaceClipInPlace(doc, host.clip.id, [survivor]);
  return survivor.id;
}

/** A point of one layer, re-expressed in another layer's local space. */
function rebasePoint(
  pt: PathPoint,
  from: Transform,
  fromBasis: LayerBasis,
  to: Transform,
  toBasis: LayerBasis,
): PathPoint {
  const at = anchorLocal(toBasis.anchor, toBasis.size);
  const move = (p: { x: number; y: number }) => {
    const w = mapLocal(p.x, p.y, fromBasis);
    const rel = unmapLinear(from.x + w.x - to.x, from.y + w.y - to.y, toBasis);
    return { x: at.x + rel.x, y: at.y + rel.y };
  };
  const a = move(pt);
  return {
    ...pt,
    x: a.x,
    y: a.y,
    hIn: pt.hIn ? move(pt.hIn) : null,
    hOut: pt.hOut ? move(pt.hOut) : null,
  };
}

/** Bake a parent pose onto a child's, so the child alone lands where both did. */
function composeInto(clip: PathClip, parent: Transform, child: Transform, box: LayerBox): void {
  const pb = basisOfTransform(parent, box);
  const w = mapLinear(child.x, child.y, pb);
  clip.transform = {
    ...child,
    x: Math.round(parent.x + w.x),
    y: Math.round(parent.y + w.y),
    scale: parent.scale * child.scale,
    scaleY: (parent.scaleY ?? parent.scale) * (child.scaleY ?? child.scale),
    rotation: parent.rotation + child.rotation,
  };
}

/** What a piece's style says that the survivor's does not — as an overlay. */
function styleDiff(host: PathClip, piece: PathClip): ScopeOverlay | null {
  const ov = emptyOverlay();
  let any = false;
  if (JSON.stringify(detach(piece.fills)) !== JSON.stringify(detach(host.fills))) {
    ov.added.fills = detach(piece.fills);
    for (const f of host.fills) ov.removed.push(f.id);
    any = true;
  }
  if (JSON.stringify(detach(piece.strokes)) !== JSON.stringify(detach(host.strokes))) {
    ov.added.strokes = detach(piece.strokes);
    for (const s of host.strokes) ov.removed.push(s.id);
    any = true;
  }
  if (piece.opacity !== host.opacity) {
    ov.props["opacity"] = piece.opacity;
    any = true;
  }
  return any ? ov : null;
}

/**
 * What merging this vector group would DISCARD — empty when the merge is a
 * clean inverse of separating.
 *
 * Merge collapses the pieces into one layer, and the survivor inherits the
 * GROUP's container (span, keyframes, effects, in/out), so the animation you
 * put on the group survives. What cannot survive is animation you put on a
 * PIECE: once two layers become one, there is no longer a thing for a per-piece
 * keyframe to belong to. That is inherent, not a gap in the implementation.
 *
 * So we do not guess and we do not silently destroy: the caller asks first, and
 * says what it costs. Right after a separate — the overwhelmingly common case,
 * "undo my split" — this returns nothing and merge is exactly lossless.
 */
export function vectorMergeLoss(doc: MotionDocument, clip: { kind: string; sourceFrameId?: string }): string[] {
  if (!isVectorGroup(doc, clip)) return [];
  const pieces = doc.tracks
    .flatMap((t) => t.clips)
    .filter((c): c is PathClip => c.frameId === clip.sourceFrameId && c.kind === "path");
  const lost: string[] = [];
  const count = (pred: (c: (typeof pieces)[number]) => boolean) => pieces.filter(pred).length;

  const animated = count((c) => c.keyframes.length > 0 || !!c.modulators?.length || !!c.drivers);
  if (animated) lost.push(`${animated === 1 ? "1 piece has" : `${animated} pieces have`} their own keyframes`);

  const effected = count((c) => c.effects.length > 0);
  if (effected) lost.push(`${effected === 1 ? "1 piece has" : `${effected} pieces have`} their own effects`);

  const inOut = count((c) => !!c.animIn || !!c.animOut);
  if (inOut) lost.push(`${inOut === 1 ? "1 piece has" : `${inOut} pieces have`} in/out animation`);

  // Pieces that were retimed off the group's own span — the payoff of "Own
  // timeline", so losing it silently would be the worst of the four.
  const retimed = count((c) => !c.fillDuration);
  if (retimed) lost.push(`${retimed === 1 ? "1 piece has" : `${retimed} pieces have`} their own timing`);

  return lost;
}
