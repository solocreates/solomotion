import type { AdjustmentClip, MotionDocument } from "../schema";
import { isAdjustmentClip } from "../clip-registry";
import { propertyHasKeys } from "../animation/keyframes";
import { layerEffectCarves } from "../animation/layer-effects";
import { groupAncestry } from "./groups";
import { frameEffectClip } from "./frame-effects";
export { frameEffectClip, isFrameEffectClip } from "./frame-effects";

/**
 * THE adjustment-layer brain (v39) — resolves an adjustment's `scope` into the
 * concrete instruction the renderer follows, with zero renderer-side knowledge
 * of groups or filter modes. One pure function so preview and export are
 * identical by construction, and any future surface (a node graph, a scope
 * badge) reads the same truth.
 *
 * The renderer treats an adjustment as "grade the reachable composite, then keep
 * the graded pixels only inside `matteIds`' silhouette (whole composite when
 * `wholeReach`), and consume that region from the plate when `replaces`".
 * `reach` tells it WHEN to run: "below" inline at the layer's z-position, "all"
 * as a final full-frame pass.
 */
export interface AdjustmentTargets {
  /** "below" grades what's beneath it in z; "all" grades the whole frame last. */
  reach: "below" | "all";
  /** The grade covers the ENTIRE reachable composite — no matte, fast path. */
  wholeReach: boolean;
  /**
   * When not `wholeReach`: the clip ids whose union silhouette the grade is
   * masked to. Empty + not whole = the grade affects nothing (a valid no-op).
   */
  matteIds: Set<string>;
  /**
   * Erase the graded region from the plate before the result lands on it, so a
   * grade that MOVES its pixels (a sizing pose, a displacement) relocates them
   * instead of leaving an un-graded twin behind. It is the user's `scope.source`
   * and nothing else — the renderer used to infer it from `wholeReach`, which
   * made ticking a layer in the scope picker quietly change two things.
   */
  replaces: boolean;
}

/**
 * Expand `scope.filter` (which addresses clips OR groups) into a flat matte set,
 * intersected with the frame's real drawable clips. Group ids fold in every
 * descendant clip through the same ancestry the layer tree uses, so "only this
 * group" tracks membership as clips move in and out of it.
 */
export function resolveAdjustmentTargets(
  doc: MotionDocument,
  frameId: string,
  clip: AdjustmentClip,
): AdjustmentTargets {
  const { reach, filter } = clip.scope;
  const replaces = clip.scope.source !== "over";
  if (filter.mode === "all") return { reach, wholeReach: true, matteIds: new Set(), replaces };

  const targets = new Set(filter.targetIds);
  // A clip is targeted if it's listed directly, or any ancestor group is listed.
  const frameClipIds: string[] = [];
  const listed = new Set<string>();
  for (const track of doc.tracks) {
    const inTargetGroup = track.groupId != null && groupAncestry(doc, track.groupId).some((g) => targets.has(g));
    for (const c of track.clips) {
      if (c.frameId !== frameId || c.kind === "audio") continue;
      // Never matte against another processor — it has no silhouette of its own.
      if (isAdjustmentClip(c)) continue;
      frameClipIds.push(c.id);
      if (targets.has(c.id) || inTargetGroup) listed.add(c.id);
    }
  }

  if (filter.mode === "only") return { reach, wholeReach: false, matteIds: listed, replaces };
  // "except": everything drawable in the frame minus the listed set.
  return {
    reach,
    wholeReach: false,
    matteIds: new Set(frameClipIds.filter((id) => !listed.has(id))),
    replaces,
  };
}

/**
 * Does this processor's result land somewhere it would NOT cover what it read
 * — so that `scope.source` (consume it, or lay over it) changes the picture?
 *
 * Two ways. Its pose puts the graded result somewhere OTHER than where it read
 * it (a DaVinci sizing node rather than a grade in place), and only a grade
 * that relocates can leave an un-graded original behind. Or a card CARVES
 * (`carves`: a screen's gaps, a matte), and over the original every hole it
 * cuts shows the picture it was meant to replace. A grade that lands back on
 * its own pixels, whole, covers them either way.
 *
 * `renderAdjustment` gates the same way, one instant at a time (a null pose
 * matrix, the active carving cards); this is the "ever, at any time" form the
 * inspector needs to decide whether to offer the switch.
 */
export function adjustmentSourceMatters(clip: AdjustmentClip): boolean {
  if (clip.effects.some((fx) => layerEffectCarves(fx.type))) return true;
  const t = clip.transform;
  if (t.x !== 0 || t.y !== 0 || t.rotation !== 0 || t.skewX !== 0 || t.skewY !== 0) return true;
  if (t.scale !== 1 || (t.scaleY !== null && t.scaleY !== 1)) return true;
  if (t.anchor.x !== 0.5 || t.anchor.y !== 0.5) return true;
  return SIZING_PATHS.some((path) => propertyHasKeys(clip.keyframes, path));
}

const SIZING_PATHS = ["x", "y", "scale", "scaleY", "rotation", "skewX", "skewY", "anchor.x", "anchor.y"];

// `isFrameEffectClip` and `frameEffectClip` live in the leaf `./frame-effects`
// (the render clock reads them, and it must not import this module's graph).
