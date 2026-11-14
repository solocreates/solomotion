import { toSubpath } from "./contour-id";
import type { Contour, PathPoint, Subpath } from "../schema/vector";
import { insertPointOnSegment } from "./geometry";
import { joinEndpoints, openEndpoints, weldNodes, type NodeRef } from "./edit-engine";

/**
 * The pen tool's headless brain: where a click LANDS on existing geometry, what
 * that landing MEANS, and how two runs fuse when it means "connect".
 *
 * The overlay owns screen space — only it can say which anchor is within grab
 * range of the cursor. Everything after that is here, because the preview and
 * the press must never be able to disagree: the chrome under the cursor, the
 * cursor hint, the toolbar copy and the mutation all read ONE `PenIntent`
 * derived by `penIntent()` from the same landing. When "what would happen" and
 * "what happened" live in two files they drift, and that drift is the whole
 * class of bug this module exists to make unrepresentable.
 */

// ── Where a click lands ──────────────────────────────────────────────────────

/**
 * A spot on committed geometry, addressed the way the mutation needs it. An
 * `anchor` is a node that already exists; a `segment` is a point ON a curve
 * that becomes an anchor the moment anything needs it to (see `anchorAtSite`) —
 * which is why "add a point here" and "connect here" are the same primitive
 * with different stopping points, not two features.
 */
export type PenSite =
  | { kind: "anchor"; sub: number; index: number }
  | { kind: "segment"; sub: number; index: number; t: number };

/** A landing: a site on a specific clip, plus what the site can structurally do. */
export interface PenLanding {
  clipId: string;
  site: PenSite;
  /**
   * Set when the site is an OPEN END of an open run — the only kind of node
   * where two runs can fuse into ONE continuous path. Anywhere else a junction
   * is a coincident anchor (a T), because a path point has two neighbours and
   * a third branch is not expressible in one run. Derived, never stored twice.
   */
  end: "head" | "tail" | null;
}

/** A landing ranked by how far the cursor is from it, in screen px. */
export interface PenCandidate {
  landing: PenLanding;
  dist: number;
}

/**
 * Pick the landing a click resolves to. Anchors beat segments outright — the
 * node you can see is always the thing you meant, even when the curve passes
 * closer to the pixel — and within a class the nearest wins.
 */
export function pickPenLanding(candidates: ReadonlyArray<PenCandidate>): PenLanding | null {
  let best: PenCandidate | null = null;
  for (const c of candidates) {
    if (!best) {
      best = c;
      continue;
    }
    const bAnchor = best.landing.site.kind === "anchor";
    const cAnchor = c.landing.site.kind === "anchor";
    if (cAnchor !== bAnchor) {
      if (cAnchor) best = c;
      continue;
    }
    if (c.dist < best.dist) best = c;
  }
  return best?.landing ?? null;
}

// ── What the click means ─────────────────────────────────────────────────────

/**
 * Every outcome a pen click can have. The kinds split on ONE question — is a
 * run in flight? — because that is what changes the verb: with no run a landing
 * is somewhere to start FROM, with a run in flight it is somewhere to end ON.
 */
export type PenIntent =
  /** Nothing in flight, nothing under the cursor — begin a new path. */
  | { kind: "start" }
  /** A run is in flight over empty space — place the next node. */
  | { kind: "add" }
  /** A run is in flight over its own first node — close it into a loop. */
  | { kind: "close" }
  /** Nothing in flight, over a node (or a curve, which becomes one) — draw FROM it. */
  | { kind: "resume"; landing: PenLanding }
  /** A run is in flight over another OPEN END — the two runs can become one. */
  | { kind: "fuse"; landing: PenLanding }
  /** A run is in flight over an interior node or a curve — a coincident junction. */
  | { kind: "attach"; landing: PenLanding };

/**
 * The one derivation. `drawing` is "a run is in flight" (draft, extension or a
 * seeded branch — the pen does not care which); `closing` is the overlay's
 * answer to "is the cursor on this run's own start", which only it can know.
 */
export function penIntent(opts: {
  drawing: boolean;
  closing: boolean;
  landing: PenLanding | null;
}): PenIntent {
  if (opts.closing) return { kind: "close" };
  if (opts.landing) {
    if (!opts.drawing) return { kind: "resume", landing: opts.landing };
    return opts.landing.end ? { kind: "fuse", landing: opts.landing } : { kind: "attach", landing: opts.landing };
  }
  return opts.drawing ? { kind: "add" } : { kind: "start" };
}

/** Does this intent land on existing geometry (i.e. carry a landing)? */
export function penIntentLanding(intent: PenIntent): PenLanding | null {
  return "landing" in intent ? intent.landing : null;
}

/**
 * The phrase shown beside the cursor. Deliberately empty for `start` and `add`:
 * the pen's ordinary job needs no narration, and a hint that is always on stops
 * being a hint. It speaks only when the click is about to do something to
 * geometry that already exists.
 */
export function penIntentHint(intent: PenIntent): string {
  switch (intent.kind) {
    case "close":
      return "Close path";
    case "resume":
      if (intent.landing.site.kind === "segment") return "Add point";
      return intent.landing.end ? "Continue path" : "Branch from point";
    case "fuse":
      return "Connect ends";
    case "attach":
      return intent.landing.site.kind === "segment" ? "Join path here" : "Join at point";
    default:
      return "";
  }
}

/** The mark a pen cursor carries beside its nib, so it can say what a click does. */
export type PenMark = "none" | "add" | "join" | "close" | "continue";

/**
 * Which mark an intent wears. The cursor art is the surface's; this says only
 * what the click would do, in the one place the eye is already looking, before
 * the hint has been read.
 */
export function penMark(intent: PenIntent): PenMark {
  switch (intent.kind) {
    case "close":
      return "close";
    case "resume":
      // An open END continues the run (Figma's "/" pen); an interior node branches.
      if (intent.landing.site.kind === "segment") return "add";
      return intent.landing.end ? "continue" : "join";
    case "fuse":
    case "attach":
      return "join";
    default:
      return "none";
  }
}

// ── How geometry fuses ───────────────────────────────────────────────────────

const clone = (p: { x: number; y: number } | null | undefined) => (p ? { x: p.x, y: p.y } : null);
// Identity and per-vertex radius travel WITH the point. A copy that drops
// them is a point that quietly stops being the node it was.
const copyPoint = (p: PathPoint): PathPoint => ({
  x: p.x,
  y: p.y,
  hIn: clone(p.hIn),
  hOut: clone(p.hOut),
  ...(p.cornerRadius == null ? {} : { cornerRadius: p.cornerRadius }),
  ...(p.weldId == null ? {} : { weldId: p.weldId }),
});

/**
 * Resolve a site to a real anchor, splitting the curve when the site is a
 * segment. The de Casteljau split leaves the outline byte-identical, so the
 * path does not move under the click — the node simply starts existing.
 *
 * This is the primitive behind BOTH "add a point on this line" and "connect
 * here": the first stops at the returned ref, the second keeps going. That is
 * why inserting mid-line and then drawing on is not a special case with its own
 * rules — it is the ordinary flow with the ordinary anchor.
 */
export function anchorAtSite(subs: Contour[], site: PenSite): NodeRef | null {
  const sub = subs[site.sub];
  if (!sub) return null;
  if (site.kind === "anchor") return sub.points[site.index] ? { sub: site.sub, index: site.index } : null;
  const segments = sub.closed ? sub.points.length : sub.points.length - 1;
  if (site.index < 0 || site.index >= segments) return null;
  const index = insertPointOnSegment(sub, site.index, Math.max(0, Math.min(1, site.t)));
  return { sub: site.sub, index };
}

/** Is this ref a grabbable END of an open run (the only fusable kind of node)? */
export function isOpenEnd(subs: ReadonlyArray<Contour>, ref: NodeRef): "head" | "tail" | null {
  const found = openEndpoints(subs).find((ep) => ep.sub === ref.sub && ep.index === ref.index);
  return found?.end ?? null;
}

/**
 * Weld an open `run` into `subs` at `site`. `run` is expressed in the target's
 * OWN local space and its LAST point is the end that landed.
 *
 * Two outcomes, and the difference is structural rather than a preference:
 *  · the site is an open END → the two runs concatenate into one continuous
 *    path, the shared anchor fusing (this is `joinEndpoints`, reused whole);
 *  · anywhere else → the run is added alongside and its landing point is WELDED
 *    to the anchor. A node with three neighbours cannot live in one run, so the
 *    junction is two points that share an identity — which is the difference
 *    between a junction and two anchors that merely sit on the same pixel.
 *    Leaving them merely coincident (what this did before) renders identically
 *    and comes apart the first time you drag it.
 *
 * Returns false only when the site does not resolve (stale geometry).
 */
export function weldRun(subs: Subpath[], run: Contour, site: PenSite): boolean {
  const anchor = anchorAtSite(subs, site);
  if (!anchor) return false;
  const target = subs[anchor.sub]!.points[anchor.index]!;
  const landing = run.points[run.points.length - 1];
  if (!landing) return false;
  // Snap the landing exactly onto the anchor, carrying its handle with it, so
  // "connected" is true of the coordinates and not merely of the rendering.
  const dx = target.x - landing.x;
  const dy = target.y - landing.y;
  if (dx !== 0 || dy !== 0) {
    landing.x = target.x;
    landing.y = target.y;
    if (landing.hIn) {
      landing.hIn.x += dx;
      landing.hIn.y += dy;
    }
    if (landing.hOut) {
      landing.hOut.x += dx;
      landing.hOut.y += dy;
    }
  }
  const end = isOpenEnd(subs, anchor);
  subs.push(toSubpath({ closed: false, points: run.points.map(copyPoint) }));
  const added: NodeRef = { sub: subs.length - 1, index: run.points.length - 1 };
  // Two open ends CAN become one continuous run, and that is strictly better
  // than a weld: one run needs no identity to stay together. Single-point runs
  // have no second end to orient, so joinEndpoints rightly refuses them.
  if (end && run.points.length >= 2) {
    joinEndpoints(subs, anchor, added);
    return true;
  }
  // Everything else is a real junction: three or more lines meeting at one node.
  weldNodes(subs, [anchor, added]);
  return true;
}
