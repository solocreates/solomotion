import type { Vec2 } from "./schema";
import { constrainDragToAngle } from "./gesture";

/**
 * Dragging one tangent arm of a node — the ONE definition, for every surface
 * that draws nodes on a canvas.
 *
 * A vector path and a motion path are the same gesture wearing different
 * storage: a path point keeps its arms as ABSOLUTE coordinates either side of
 * the anchor, a motion key keeps them as vectors RELATIVE to it. That is the
 * only real difference, and it is a mapping, not a behaviour. Everything that
 * makes the drag feel like something — whether the partner follows, what ⌥
 * means, what ⇧ locks, when a handle dissolves back into a corner — lives here
 * so the two surfaces cannot drift apart again.
 */

const EPS = 1e-6;

/**
 * Is this pair of tangent arms balanced — equal length, pointing exactly
 * opposite ways?
 *
 * The tolerances are deliberately loose (1% of length, ~0.8°) because this
 * answers a question about INTENT, not about floats: a pair the user made
 * smooth should still read as smooth after a drag has rounded its coordinates.
 */
export function isMirroredPair(a: Arm | null, b: Arm | null): boolean {
  if (!a || !b) return false;
  const aLen = len3(a);
  const bLen = len3(b);
  if (aLen < EPS || bLen < EPS) return false;
  if (Math.abs(aLen - bLen) > 0.01 * Math.max(aLen, bLen)) return false;
  // Opposite directions ⇒ the normalized dot product sits at −1.
  return isAlignedPair(a, b);
}

/**
 * Should a handle drag carry its partner along, balanced?
 *
 * A node behaves the way it already looks. Drag one arm of a balanced node and
 * the pair moves together, staying balanced. Drag one arm of a node you
 * deliberately broke and only that arm moves, leaving it broken. ⌥ TOGGLES
 * whichever of those the node implies — so on a balanced node it breaks the pair
 * for this drag, and on a broken node it moves both and balances them again.
 *
 * That is the whole rule: ⌥ always means "do the other one". It never means
 * something different depending on which node you happened to grab.
 */
export function shouldPairTangents(symmetric: boolean, alt: boolean): boolean {
  return alt ? !symmetric : symmetric;
}

/**
 * An arm, in any of the spaces a node lives in: a flat canvas's (x, y) or a
 * world's, where a path handle may also carry depth (`z`). The rules below
 * are the same rules either way; depth simply joins the arithmetic when an
 * arm has it.
 */
export type Arm = Vec2 & { z?: number };

const len3 = (v: Arm) => Math.hypot(v.x, v.y, v.z ?? 0);

/** The balanced partner of an arm: same length, opposite direction. */
export function mirrorTangent<T extends Arm>(v: T): T {
  return (v.z === undefined ? { x: -v.x, y: -v.y } : { x: -v.x, y: -v.y, z: -v.z }) as T;
}

/**
 * Do two arms make ONE tangent through their anchor (opposite directions,
 * any lengths)? Loose like `isMirroredPair` (~0.8°), for the same reason.
 */
export function isAlignedPair(a: Arm | null, b: Arm | null): boolean {
  if (!a || !b) return false;
  const la = len3(a), lb = len3(b);
  if (la < EPS || lb < EPS) return false;
  return (a.x * b.x + a.y * b.y + (a.z ?? 0) * (b.z ?? 0)) / (la * lb) <= -0.9999;
}

/**
 * What a surface freezes when a tangent drag begins.
 *
 * `symmetric` MUST be sampled at press and then left alone. Re-reading it on
 * every move would feed the gesture its own output: ⌥-balancing a broken node
 * would make it symmetric, which flips the answer on the very next move, and the
 * pair would fight the pointer.
 */
export interface TangentDragStart {
  symmetric: boolean;
  /**
   * The partner's length when the two arms are ALIGNED but not balanced — a
   * smooth node with a long side and a short one, which is what every fitted
   * brush stroke is made of. A drag keeps such a node smooth: the partner
   * turns to stay opposite and keeps its own length. Absent for a balanced
   * pair (that one mirrors) and a broken one (that one stays put).
   */
  alignedLength?: number;
}

export interface TangentDragInput {
  /** Where the grabbed arm now points, as a vector from its anchor. */
  vector: Arm;
  alt: boolean;
  shift: boolean;
  /**
   * Drop the arm within this of the anchor and the handle dissolves — the node
   * becomes a corner. Same units as `vector`, so a caller working in world
   * space converts its screen-px radius first.
   */
  dissolveWithin: number;
}

export interface TangentDragResult {
  /** The grabbed arm's new vector; null means it dissolved into a corner. */
  dragged: Arm | null;
  /** The partner's new vector; null means leave it exactly as it is. */
  partner: Arm | null;
}

/** Freeze what the gesture needs to know about the node it grabbed. */
export function beginTangentDrag(grabbed: Arm | null, partner: Arm | null): TangentDragStart {
  const symmetric = isMirroredPair(grabbed, partner);
  return !symmetric && isAlignedPair(grabbed, partner) ? { symmetric, alignedLength: len3(partner!) } : { symmetric };
}

/**
 * Resolve one move of a tangent drag: ⇧ locks the arm to a 15° ray, a drop back
 * onto the anchor dissolves the handle, and the partner follows or not per the
 * node's own state toggled by ⌥.
 */
export function resolveTangentDrag(
  start: TangentDragStart,
  input: TangentDragInput,
): TangentDragResult {
  let v = input.vector;
  if (input.shift) {
    const c = constrainDragToAngle(v.x, v.y);
    v = v.z === undefined ? { x: c.dx, y: c.dy } : { x: c.dx, y: c.dy, z: v.z };
  }
  // Dissolving is about the ANCHOR, so it outranks the pairing question: a node
  // collapsing to a corner has no arms left to balance.
  const l = len3(v);
  if (l <= input.dissolveWithin) return { dragged: null, partner: null };
  // A smooth node with uneven arms stays smooth and keeps its unevenness;
  // ⌥ breaks it, exactly as it breaks a balanced pair.
  if (start.alignedLength !== undefined && !input.alt) {
    const k = -start.alignedLength / Math.max(EPS, l);
    return { dragged: v, partner: v.z === undefined ? { x: v.x * k, y: v.y * k } : { x: v.x * k, y: v.y * k, z: v.z * k } };
  }
  const pair = shouldPairTangents(start.symmetric || start.alignedLength !== undefined, input.alt);
  return { dragged: v, partner: pair ? mirrorTangent(v) : null };
}
