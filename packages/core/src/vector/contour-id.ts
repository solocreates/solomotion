import { createId } from "../ids";
import type { Contour, PathClip, Subpath } from "../schema";

/**
 * CONTOUR IDENTITY — the one place that mints and repairs the ids a vector
 * layer's runs are addressed by.
 *
 * Every gesture in the node editor addresses a contour by INDEX, because that
 * is what a node key (`"<sub>:<index>"`) carries. Indices are fine while you
 * are dragging a point and wrong the moment anything structural happens: a
 * split, a join, a knife cut, a delete, a paste, a boolean. An id is what a
 * live selection, a clipboard payload, a morph correspondence and an undo step
 * can hold ACROSS those edits.
 *
 * Deliberately nothing else lives here. A piece of artwork that wants its own
 * fill, transform, effects, morph or span is a LAYER — a `path` clip — and this
 * module exists so that splitting one layer into two never loses track of which
 * geometry was which. Giving contours their own style/transform/timing fields
 * instead would be `Clip` rewritten one level down, and every feature after it
 * would have to be built twice.
 */

/** The one place a stored contour's id is minted. */
export function newContourId(): string {
  return createId("sub");
}

/** A contour that has just been computed, given a place to live. */
export function toSubpath(contour: Contour): Subpath {
  return { ...contour, id: newContourId() };
}

/**
 * Turn a computed outline INTO a layer's contours — the entry point every
 * "this geometry is now artwork" moment shares: flatten-to-path, text-to-path,
 * an SVG import, a boolean result, a brush commit.
 */
export function adoptContours(host: { subpaths: Subpath[] }, contours: ReadonlyArray<Contour>): void {
  host.subpaths = contours.map(toSubpath);
}

/**
 * Give a computed outline the identity of the outline it replaces, position by
 * position — the ONE rule for turning contours back into a layer's contours.
 *
 * A morph key, a baked geometry value and a refit all describe the SAME art at
 * a different moment, and the correspondence a morph already requires (matching
 * contour and point counts) is exactly the correspondence identity needs. Any
 * contour past the end of the declared list is genuinely new and is minted.
 */
export function lendIdentity(
  declared: ReadonlyArray<Subpath>,
  contours: ReadonlyArray<Contour>,
): Subpath[] {
  return contours.map((c, i) => ({ ...c, id: declared[i]?.id ?? newContourId() }));
}

/**
 * Make a layer's contour ids valid, whatever state they arrive in — missing,
 * or DUPLICATED, which is the state every structural op produces: a split
 * builds each half by spreading the run it came from, so both halves arrive
 * wearing one id. Repairing it at the write seam is why no op has to know ids
 * exist. Idempotent, so a healthy layer pays one walk and nothing else.
 */
export function healContourIds(host: { subpaths: Subpath[] }): void {
  const seen = new Set<string>();
  for (const sub of host.subpaths) {
    if (!sub.id || seen.has(sub.id)) sub.id = newContourId();
    seen.add(sub.id);
  }
}

/** `healContourIds` for a whole path clip (the shape callers actually hold). */
export function healPathClip(clip: PathClip): void {
  healContourIds(clip);
}

/* ------------------------------------------------------- addressing a node */

/**
 * A NODE KEY: the stable address of one anchor point, `"<contourId>:<index>"`.
 *
 * The editor used to key node selection by the contour's POSITION
 * (`"<subIndex>:<index>"`), which is a description of the array rather than of
 * the geometry. Any structural edit renumbers that array — a split, a join, a
 * knife cut, a delete, a paste, a boolean — so a selection made before one
 * silently pointed at different points afterwards, and the marquee, the drag
 * and every align verb quietly acted on the wrong nodes. Contours have carried
 * stable ids since v62 precisely so this class of bug can stop existing.
 *
 * The index INSIDE a contour stays positional on purpose: reordering points
 * within one run is what the editing ops do continuously while you drag, and
 * minting an id per anchor would be identity for something that is never stored
 * or referenced on its own.
 */
export function nodeKey(contourId: string, index: number): string {
  return `${contourId}:${index}`;
}

export interface NodeAddress {
  contourId: string;
  index: number;
}

/** Split a node key. Reads from the LAST colon, so an id may contain one. */
export function parseNodeKey(key: string): NodeAddress | null {
  const at = key.lastIndexOf(":");
  if (at <= 0) return null;
  const index = Number(key.slice(at + 1));
  if (!Number.isInteger(index) || index < 0) return null;
  return { contourId: key.slice(0, at), index };
}

/**
 * Resolve a key against a layer's CURRENT geometry — null when the contour is
 * gone or the point is past its end, which is the honest answer after an edit
 * that removed it, and the reason callers stop needing to guess.
 */
export function resolveNode(
  host: { subpaths: ReadonlyArray<Subpath> },
  key: string,
): { sub: Subpath; subIndex: number; index: number } | null {
  const addr = parseNodeKey(key);
  if (!addr) return null;
  const subIndex = host.subpaths.findIndex((s) => s.id === addr.contourId);
  if (subIndex < 0) return null;
  const sub = host.subpaths[subIndex]!;
  if (addr.index >= sub.points.length) return null;
  return { sub, subIndex, index: addr.index };
}
