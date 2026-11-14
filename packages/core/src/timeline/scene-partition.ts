import { clipsUnderGroup } from "./groups";
import { compositingUnitOf } from "./group-paint";
import { frameLayerTree } from "./layer-tree";
import { layerEffectReadsBackdrop } from "../animation/layer-effects";
import type { MotionDocument, Clip, Frame } from "../schema";
import type { EditPath } from "../navigation/path";
import type { LayerTreeNode } from "./layer-tree";

/**
 * THE SCENE, CUT AROUND WHAT IS ABOUT TO CHANGE.
 *
 * Most of what a person does to a document changes ONE layer. Typing changes a
 * text layer. Dragging a pen node changes a path. Nudging a slider changes the
 * card it belongs to. Working inside a nested comp changes that comp's instance
 * and nothing else in the scene around it.
 *
 * The renderer had no way to say that. Every edit meant "re-render everything",
 * so a change to the top layer of a forty-layer board re-walked all forty —
 * measuring each one, keying it, compositing it — to arrive at the identical
 * pixels it had a millisecond ago. The layer cache made each of those layers
 * cheap to REUSE; it could not make the walk itself go away.
 *
 * So the scene is cut into three: everything painted BELOW what is changing,
 * the changing run itself, and everything painted ABOVE it. The outer two are
 * constants for as long as the hypothesis holds, and a constant is one blit.
 *
 * ## It is a hypothesis, and it is verified
 *
 * The caller says what it believes may change. It does not have to be right,
 * and being generous is safe: the raster carries the identity of every clip it
 * baked, and an untouched clip keeps its object identity under immer. Anything
 * outside the changing run that moves at all is caught on the next tick and the
 * cut is thrown away. The cost of a wrong guess is a re-bake, never a wrong
 * picture.
 *
 * ## Why it refuses more often than it accepts
 *
 * A cut is only honest when the outer two thirds do not depend on the middle.
 * Each way that can fail is a hard refusal rather than a special case — and the
 * material check asks the effect registry (`layerEffectReadsBackdrop`) rather
 * than naming effects, so a new one that reads pixels refuses this cut without
 * anyone having to remember this file exists:
 *
 *  · An ADJUSTMENT LAYER grades the composite beneath it, so its output depends
 *    on the layers that are changing.
 *  · A layer above with a NON-NORMAL BLEND composites against what is below it.
 *  · A MATERIAL above reads the pixels behind it (`readsBackdrop`), which are
 *    the changing ones as much as anything else.
 *  · A TRANSITION mixes two clips, so neither half can be cut away from it.
 *  · A SCATTERED set has unchanging layers interleaved with changing ones;
 *    there is no single "above" and "below" to cut.
 *  · A DRIVEN DOCUMENT is re-baked into fresh objects at every instant, so the
 *    identity check could never pass.
 *
 * ## Promotion, not refusal
 *
 * A member of a group that composites as a whole cannot be lifted out of it —
 * the group's glass, its stroke and its opacity apply to the finished picture
 * its members make. Rather than refuse, the changing set is PROMOTED to that
 * whole group (`compositingUnitOf`), so the middle is a run of layers that
 * genuinely renders on its own. Correct and still cheap: the cost is the
 * group's subtree, not the board.
 */
export interface ScenePartition {
  /** What the caller said may change, before promotion. */
  requested: ReadonlySet<string>;
  /** The changing run — rendered for real, every tick. */
  changing: ReadonlySet<string>;
  /** Painted before the changing run. Constant. */
  below: ReadonlySet<string>;
  /** Painted after it. Constant. */
  above: ReadonlySet<string>;
}

/** Paint order across the page: the tree walked in reverse, frame by frame. */
function paintOrder(doc: MotionDocument, frames: readonly Frame[]): string[] {
  const order: string[] = [];
  const walk = (ns: LayerTreeNode[]): void => {
    for (let i = ns.length - 1; i >= 0; i--) {
      const n = ns[i]!;
      if (n.type === "clip") order.push(n.clip.id);
      else walk(n.children);
    }
  };
  for (const f of frames) walk(frameLayerTree(doc, f.id));
  return order;
}

/**
 * Cut the scene around `requested`, or null when the cut would lie. Every
 * refusal below is one in this file's header.
 */
export function partitionScene(
  doc: MotionDocument,
  frames: readonly Frame[],
  requested: ReadonlySet<string>,
): ScenePartition | null {
  if (requested.size === 0) return null;
  if (doc.graphs.length > 0 || doc.expressions.length > 0 || doc.variables.length > 0) return null;

  // Promotion, before anything is measured.
  const changing = new Set<string>();
  for (const id of requested) {
    const unit = compositingUnitOf(doc, id);
    if (!unit) {
      changing.add(id);
      continue;
    }
    changing.add(unit);
    for (const member of clipsUnderGroup(doc, unit)) changing.add(member);
  }

  const order = paintOrder(doc, frames);
  const first = order.findIndex((id) => changing.has(id));
  if (first < 0) return null;
  let last = first;
  for (let i = order.length - 1; i >= first; i--) {
    if (changing.has(order[i]!)) {
      last = i;
      break;
    }
  }
  // Scattered: something unchanging sits between two changing layers.
  for (let i = first; i <= last; i++) if (!changing.has(order[i]!)) return null;

  const byId = new Map<string, Clip>();
  for (const t of doc.tracks) for (const c of t.clips) byId.set(c.id, c);
  for (const id of changing) if (!byId.has(id)) return null;

  const below = new Set(order.slice(0, first));
  const above = new Set(order.slice(last + 1));

  for (const id of above) {
    const clip = byId.get(id);
    if (!clip || clip.kind === "audio") continue;
    if (clip.kind === "adjustment") return null;
    if ("blendMode" in clip && clip.blendMode !== "normal") return null;
    if (clip.effects.some((fx) => fx.enabled && layerEffectReadsBackdrop(fx))) return null;
  }
  for (const t of doc.tracks) {
    if (t.transitions.length > 0 && t.clips.some((c) => changing.has(c.id))) return null;
  }
  // An adjustment ANYWHERE can still reach upward (`reach: "all"` runs as a
  // full-frame post-pass), so the cheap, honest answer is to refuse whenever
  // the page carries one.
  for (const t of doc.tracks) {
    for (const c of t.clips) if (c.kind === "adjustment") return null;
  }

  return { requested, changing, below, above };
}

/**
 * THE CLIPS THE CURRENT EDIT CAN CHANGE — read off the navigation, which is
 * already the one canonical answer to "what am I working on".
 *
 * Text editing, pen-node editing, shape corners, crop: all of them are the
 * navigation's LEAF, and the session fields that name them
 * (`editingClipId`, `vectorEditClipId`, …) are documented projections of it.
 * There is no second list of modes to keep in step here, and a mode added
 * tomorrow is covered the day it becomes a leaf.
 *
 * Drilled into a nested comp or a component, the answer is the OUTERMOST hop:
 * whatever you do in there, the only thing the scene around it sees change is
 * that one instance. `hops` is outermost-first, so it is `hops[0]` — and using
 * the outermost rather than the innermost is the whole point, because the
 * scene being cut is the root one.
 *
 * A gesture (dragging layers) is NOT here: that is the pointer's business, not
 * the navigation's, and the caller unions the two.
 */
export function editScopeClipIds(path: EditPath | null, leafClipId: string | null): Set<string> {
  const out = new Set<string>();
  if (path && path.hops.length > 0) {
    out.add(path.hops[0]!);
    return out;
  }
  if (leafClipId) out.add(leafClipId);
  return out;
}
