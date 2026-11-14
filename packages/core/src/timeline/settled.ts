import type { MotionDocument } from "../schema";

/**
 * IS THIS DOCUMENT SETTLED — will it never change again?
 *
 * Every per-document memo in core (the comp index, the layer tree, the scope
 * index, the sound inventory, the draw-on strands) may cache only a document
 * that cannot change underneath it. The store's snapshots prove it by being
 * frozen. A RESOLVED document — the per-(comp, instant) bake of drivers and
 * relations the renderer draws from — is just as immutable but is built by
 * mapping, not by immer, so it is not frozen; and since a heavy film draws a
 * fresh one per nested comp per frame, every memo missed on every call, and
 * each draw re-indexed the whole project from inside its own loops.
 *
 * The producer of such a document says so with `settleDocument`. A draft
 * mid-mutation is neither, and is simply recomputed.
 */
const settled = new WeakSet<MotionDocument>();

export function settleDocument(doc: MotionDocument): MotionDocument {
  settled.add(doc);
  return doc;
}

export function isSettledDocument(doc: MotionDocument): boolean {
  return Object.isFrozen(doc) || settled.has(doc);
}

/**
 * THE STORED DOCUMENT A BAKE CAME FROM — a raw document is its own.
 *
 * A bake (drivers, poses, followers, relations, physics) writes its values into
 * the clips' own slots, so a baked `transform.x` is indistinguishable from a
 * typed one. Most readers want exactly that. The few that must NOT follow the
 * animation — a group's pivot, which is a fraction of its members' REST box —
 * ask here for the document the values were written over. Without it, a pan
 * keyed on a member left the parent's zoom centre still while the same pan
 * driven by an expression dragged it along.
 *
 * Lives beside `settleDocument` because both are facts about a document's
 * identity, and the geometry in `ops.ts` that reads it is upstream of the bake.
 */
const storedOf = new WeakMap<MotionDocument, MotionDocument>();

/** Record that `derived` is a bake of `source` (or of what `source` was baked from). */
export function noteBakedFrom(derived: MotionDocument, source: MotionDocument): MotionDocument {
  if (derived !== source) storedOf.set(derived, storedOf.get(source) ?? source);
  return derived;
}

export function storedDocumentOf(doc: MotionDocument): MotionDocument {
  return storedOf.get(doc) ?? doc;
}
