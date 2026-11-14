import type { MotionDocument, PathClip, ShapeClip, VisualClip } from "../schema";
import { isSettledDocument } from "../timeline/settled";
import { clipLocalTime } from "../animation/evaluate";
import { resolveShapeGeometry } from "../animation/paths";
import {
  hasRevealAnimation,
  layerRevealAt,
  revealFillAlpha,
  strandWindows,
  subpathLengths,
  type Reveal,
  type StrandWindow,
} from "../animation/reveal";
import { clipAncestorGroups, leafClipsUnderGroup } from "../timeline/groups";
import { locateClip } from "../timeline/ops";
import { pathCommands, shapeCommands, type PathCommand } from "./geometry";
import { inkedCommands, resolveStrokeAt, strokeIsVisible } from "./stroke";
import { sampleKeyframes } from "../animation/keyframes";
import { hostOutlineAt } from "../text/on-path";

/**
 * WHICH STRANDS a draw-on draws, and in what order.
 *
 * A strand is one subpath of one vector layer. A layer's own draw-on has one
 * strand per contour; a GROUP's draw-on has one per contour of every vector
 * leaf beneath it, so an imported icon — which arrives as a group of paths —
 * inks itself as one drawing rather than as N layers each starting at once.
 *
 * A group's reveal READS THROUGH to its children, never writes into them: a
 * child with a draw-on of its own keeps it, a child with none takes the nearest
 * enclosing group's, and clearing the group's leaves every child as it was.
 * Inheritance is right HERE and wrong for fill (`groupTintFills`) for one
 * reason: a draw-on is per-strand by nature — it inks each contour's own
 * outline, so there is nothing to composite and no meaning to "the group's
 * strands" beyond its members'. A fill has a finished picture to land on.
 *
 * Draw order is AUTHORING order — bottom of the stack first — because that is
 * how the artwork was made: SVG document order is bottom→top, and a person
 * drawing an icon draws the thing behind before the thing in front.
 */

/** A vector layer that can carry strands. */
export type OutlineClip = PathClip | ShapeClip;

export function isOutlineClip(clip: VisualClip): clip is OutlineClip {
  return clip.kind === "path" || clip.kind === "shape";
}

/**
 * The layer's outline as commands, from its DECLARED geometry — what the
 * strand lengths are measured on. Memoised on the clip object, which immer
 * keeps stable until the clip itself changes.
 */
const outlineMemo = new WeakMap<OutlineClip, PathCommand[]>();
export function outlineCommands(clip: OutlineClip): PathCommand[] {
  const hit = outlineMemo.get(clip);
  if (hit) return hit;
  const cmds = clip.kind === "path" ? pathCommands(clip.subpaths) : shapeCommands(resolveShapeGeometry(clip, {}));
  // Only a frozen clip is remembered — a mutable one may change its geometry.
  if (Object.isFrozen(clip)) outlineMemo.set(clip, cmds);
  return cmds;
}

/** Arc length of each of the layer's own strands. */
export function clipStrandLengths(clip: OutlineClip): number[] {
  return subpathLengths(outlineCommands(clip));
}

interface StrandTable {
  /** Every strand length under the group, in draw order. */
  lengths: number[];
  /** Where each leaf's strands begin in `lengths`. */
  offset: Map<string, number>;
}

const tableMemo = new WeakMap<MotionDocument, Map<string, StrandTable>>();

/** The strand table of a group — memoised per immutable document. */
function groupStrands(doc: MotionDocument, groupId: string): StrandTable {
  // Frozen = immutable = safe to remember (see `scopeIndex`).
  const cacheable = isSettledDocument(doc);
  let perDoc = cacheable ? tableMemo.get(doc) : undefined;
  const hit = perDoc?.get(groupId);
  if (hit) return hit;

  const lengths: number[] = [];
  const offset = new Map<string, number>();
  // `leafClipsUnderGroup` walks tracks top→bottom; drawing runs bottom→top.
  const leaves = leafClipsUnderGroup(doc, groupId).slice().reverse();
  for (const id of leaves) {
    const clip = locateClip(doc, id)?.clip;
    if (!clip || clip.kind === "audio" || !isOutlineClip(clip)) continue;
    offset.set(id, lengths.length);
    lengths.push(...clipStrandLengths(clip));
  }
  const table = { lengths, offset };
  if (cacheable) {
    if (!perDoc) {
      perDoc = new Map();
      tableMemo.set(doc, perDoc);
    }
    perDoc.set(groupId, table);
  }
  return table;
}

/** What a vector layer's painter needs to know about the reveal it is under. */
export interface ClipReveal {
  reveal: Reveal;
  /** Per-contour windows for this layer's outline, in its subpath order. */
  windows: StrandWindow[];
  /** Opacity multiplier for the layer's fills. */
  fillAlpha: number;
  /**
   * The outline to ink when the layer has no visible stroke of its own — a
   * filled icon still draws on, in its fill colour, at the reveal's pen width.
   */
  synthesiseOutline: boolean;
}

/**
 * The reveal in force on a vector layer at an instant, or null when its
 * outline is whole. `localMs` is the clip's own time; `compTimeMs` the comp's,
 * which is the clock an enclosing group's edge runs on (children keep
 * absolute times, so a group's local time is not a child's).
 */
export function clipRevealAt(
  doc: MotionDocument,
  clip: OutlineClip,
  localMs: number,
  compTimeMs: number,
): ClipReveal | null {
  let reveal: Reveal | null = null;
  let windows: StrandWindow[] | null = null;

  if (hasRevealAnimation(clip)) {
    reveal = layerRevealAt(clip, localMs);
    if (!reveal) return null;
    windows = strandWindows(clipStrandLengths(clip), reveal);
  } else {
    // The nearest enclosing group that HAS a draw-on decides — whether or not
    // it is drawing right now. Same precedence as the fill cascade.
    const owner = clipAncestorGroups(doc, clip.id).find(hasRevealAnimation);
    if (!owner) return null;
    const groupLocal = clipLocalTime(owner, compTimeMs);
    if (groupLocal === null) return null;
    reveal = layerRevealAt(owner, groupLocal);
    if (!reveal) return null;
    const table = groupStrands(doc, owner.id);
    const at = table.offset.get(clip.id);
    if (at === undefined) return null;
    const all = strandWindows(table.lengths, reveal);
    windows = all.slice(at, at + clipStrandLengths(clip).length);
  }

  return {
    reveal,
    windows,
    fillAlpha: revealFillAlpha(reveal),
    synthesiseOutline: !clip.strokes.some(strokeIsVisible),
  };
}

/**
 * A vector layer's outline AS DRAWN at an instant: its draw-on (own or an
 * enclosing group's) and its lead stroke's trim applied — the line the viewer
 * actually sees being inked. What anything riding the drawn line (an outline
 * lightning arc) follows, through the same `inkedCommands` the stroke plan
 * uses. The lead stroke is the first visible one: a layer's stack of strokes
 * shares one route, and the top design decides where it ends.
 */
export function inkedOutlineAt(
  doc: MotionDocument,
  clip: OutlineClip,
  localMs: number,
  compTimeMs: number,
): PathCommand[] {
  const cmds = hostOutlineAt(clip, localMs);
  if (cmds.length === 0) return cmds;
  const reveal = clipRevealAt(doc, clip, localMs, compTimeMs);
  let trim: { start: number; end: number; offset: number } | undefined;
  if (clip.strokes.length > 0) {
    const sampled = sampleKeyframes(clip.keyframes, localMs);
    for (const st of clip.strokes) {
      const s = resolveStrokeAt(st, { sampled, modulators: clip.modulators, timeSec: localMs / 1000 });
      if (strokeIsVisible(s)) {
        trim = s.trim;
        break;
      }
    }
  }
  return inkedCommands(cmds, trim, reveal?.windows);
}

/**
 * Can a draw-on do anything on this layer? A path, a shape, or a group with at
 * least one of them beneath it. What the Animate tab asks before offering it.
 */
export function clipHasOutline(doc: MotionDocument, clip: VisualClip): boolean {
  if (isOutlineClip(clip)) return true;
  if (clip.kind !== "group") return false;
  return leafClipsUnderGroup(doc, clip.id).some((id) => {
    const c = locateClip(doc, id)?.clip;
    return !!c && c.kind !== "audio" && isOutlineClip(c);
  });
}
