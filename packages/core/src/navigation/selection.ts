import type { MotionDocument, Clip } from "../schema";
import { locateClip } from "../timeline/ops";
import { childTimeOf, resolveEditContext, timeAtDepth, type EditContext } from "./context";
import { editPath, pathFrameIds, pathToFrame, walkPath, type EditPath } from "./path";
import { editScopes } from "./scope";

/**
 * SELECTION vs NAVIGATION — two questions this editor used to weld into one.
 *
 * "Which timeline am I editing" and "what am I inspecting" are different facts.
 * Welding them is why opening a piece of an SVG costs you your place: to look
 * at a layer inside a nested comp you had to NAVIGATE into it, which re-scoped
 * the timeline, moved the playhead, dropped your breadcrumb and generally made
 * inspecting a thing feel like emigrating to it.
 *
 * `EditPath` already models root + hops, so the fix is not new machinery — it
 * is letting a SELECTION carry its own path. `selectionPath` answers "where
 * does this clip live, expressed from where I am standing", and every surface
 * that needs a clip's frame, matrix or local time resolves it from the CLIP
 * rather than from `nav`. The open timeline then never has to move for a
 * selection to be understood.
 *
 * Figma, Cavalry and Rive all work this way; After Effects does not, which is
 * exactly why nesting feels heavy there. This generalises to every nested comp
 * — components, precomps, flipbook cells, drawings — not just vector groups.
 */

/** How a clip's own path relates to the path you are standing on. */
export type SelectionReach =
  /** The clip lives in the open timeline. The ordinary case. */
  | "target"
  /** Inside a nested comp reachable from the open timeline (extra hops). */
  | "inside"
  /** In a comp you have drilled through — the path truncates. */
  | "ancestor"
  /** Not reachable from here at all; the path is the document's own ancestry. */
  | "elsewhere";

export interface SelectionPath {
  path: EditPath;
  reach: SelectionReach;
  /** Hops beyond the current path (0 unless `reach` is `"inside"`). */
  descent: number;
  clip: Clip;
}

/** How deep `selectionPath` will look for a clip inside nested comps. */
const MAX_DESCENT = 16;

/**
 * The path a clip lives at, expressed from where you are standing.
 *
 * The result is always a prefix or an extension of `from` when the clip is
 * reachable, which is what lets the playhead be mapped between the two without
 * ambiguity. When it is not reachable (a clip in another tab, a stale id) the
 * document's own ancestry answers instead and `reach` says `"elsewhere"`, so a
 * caller can choose to refuse rather than silently teleport the user.
 */
export function selectionPath(
  doc: MotionDocument,
  from: EditPath,
  clipId: string,
  maxDescent = MAX_DESCENT,
): SelectionPath | null {
  const found = locateClip(doc, clipId);
  if (!found) return null;
  const at = framePath(doc, from, found.clip.frameId, maxDescent);
  return { ...at, clip: found.clip };
}

/**
 * The path a FRAME is reached at, expressed from where you are standing — the
 * brain behind `selectionPath`, and the answer any surface needs when it has a
 * frame and wants to know WHERE ON THE CANVAS that frame currently lives.
 *
 * That second use is not academic. A frame's own `x`/`y` is page-board layout;
 * a frame reached by drilling is painted through the hop chain instead, often
 * nowhere near its stored coordinates. Anything that maps a point in or out of
 * a frame has to resolve the frame first.
 */
export function framePath(
  doc: MotionDocument,
  from: EditPath,
  frameId: string,
  maxDescent = MAX_DESCENT,
): Omit<SelectionPath, "clip"> {
  // 1. The ordinary case: it IS the timeline you are looking at.
  const onPath = pathFrameIds(doc, from);
  const targetIdx = onPath.length - 1;
  if (onPath[targetIdx] === frameId) return { path: from, reach: "target", descent: 0 };

  // 2. Down: breadth-first through the nested comps under the open timeline, so
  //    the SHALLOWEST route wins and the answer is deterministic.
  const descent = descendTo(doc, onPath[targetIdx]!, frameId, maxDescent);
  if (descent) {
    return {
      path: editPath(from.rootFrameId, [...from.hops, ...descent]),
      reach: "inside",
      descent: descent.length,
    };
  }

  // 3. Up: a comp we drilled THROUGH still shows its layers on the stage, so
  //    clicking one of them is an ordinary selection — not a navigation out.
  const up = onPath.indexOf(frameId);
  if (up >= 0) {
    return { path: editPath(from.rootFrameId, from.hops.slice(0, up)), reach: "ancestor", descent: 0 };
  }

  // 4. Nowhere near here. Answer honestly with where it actually lives.
  return { path: pathToFrame(doc, frameId), reach: "elsewhere", descent: 0 };
}

/**
 * The live context OF A FRAME — its world matrix and its own local time — with
 * the open timeline left exactly where it was. The frame half of
 * `resolveClipContext`, and the one thing a surface may use to turn a frame's
 * coordinates into world coordinates.
 */
export function resolveFrameContext(
  doc: MotionDocument,
  from: EditPath,
  playheadMs: number,
  frameId: string,
): EditContext | null {
  const at = framePath(doc, from, frameId);
  return resolveEditContext(doc, at.path, playheadBetweenPaths(doc, from, at.path, playheadMs));
}

/**
 * The clip ids the hops of `path` step THROUGH to reach `to` from `fromFrameId`,
 * or null. Breadth-first so the shallowest nesting wins; frames already visited
 * are never re-entered, so a component instanced inside itself cannot loop.
 */
function descendTo(
  doc: MotionDocument,
  fromFrameId: string,
  toFrameId: string,
  maxDescent: number,
): string[] | null {
  if (fromFrameId === toFrameId) return [];
  const seen = new Set<string>([fromFrameId]);
  let level: Array<{ frameId: string; hops: string[] }> = [{ frameId: fromFrameId, hops: [] }];
  for (let depth = 0; depth < maxDescent && level.length > 0; depth++) {
    const next: Array<{ frameId: string; hops: string[] }> = [];
    for (const node of level) {
      for (const track of doc.tracks) {
        for (const c of track.clips) {
          if (c.frameId !== node.frameId) continue;
          const match = editScopes.resolve(doc, c);
          if (!match || seen.has(match.sourceFrameId)) continue;
          const hops = [...node.hops, c.id];
          if (match.sourceFrameId === toFrameId) return hops;
          seen.add(match.sourceFrameId);
          next.push({ frameId: match.sourceFrameId, hops });
        }
      }
    }
    level = next;
  }
  return null;
}

/**
 * Move an instant between two paths where one is a prefix of the other:
 * descending maps DOWN through each new hop's trim + speed, ascending maps back
 * UP. The single implementation behind both "entering must not jump the
 * picture" and "a selection two levels down is evaluated at ITS own local
 * time" — two surfaces that would otherwise each grow their own copy.
 *
 * Paths under a different root share no instant at all — there is no mapping
 * between two unrelated timelines, so the destination answers with ITS OWN
 * remembered time. Carrying the number across was the bug where scrubbing one
 * scene moved every sibling scene on the board.
 */
export function playheadBetweenPaths(
  doc: MotionDocument,
  from: EditPath,
  to: EditPath,
  playheadMs: number,
): number {
  if (from.rootFrameId !== to.rootFrameId) {
    const own = rememberedPlayheadMs(doc, to.rootFrameId);
    return to.hops.length > 0 ? playheadBetweenPaths(doc, editPath(to.rootFrameId), to, own) : own;
  }
  const fromDepth = from.hops.length;
  const toDepth = to.hops.length;
  if (toDepth === fromDepth) return playheadMs;
  if (toDepth > fromDepth) {
    let t = playheadMs;
    for (let i = fromDepth; i < toDepth; i++) {
      const clip = locateClip(doc, to.hops[i]!)?.clip;
      if (!clip) break;
      t = childTimeOf(doc, clip, t);
    }
    return Math.max(0, t);
  }
  const ctx = resolveEditContext(doc, from, playheadMs);
  return ctx ? Math.max(0, timeAtDepth(ctx, toDepth)) : playheadMs;
}

/**
 * THE resolver every surface calls: the full edit context OF A SELECTED CLIP —
 * its frame, its world matrix, its own local time — with the open timeline left
 * exactly where it was.
 *
 * The inspector, the stage gizmo, snapping, align and the layers panel all ask
 * this instead of reading `nav`, which is the whole of "selection without
 * navigation": there is no longer any code path where inspecting a nested layer
 * requires being inside its comp.
 */
export function resolveClipContext(
  doc: MotionDocument,
  from: EditPath,
  playheadMs: number,
  clipId: string,
): { ctx: EditContext; clip: Clip; reach: SelectionReach } | null {
  const found = selectionPath(doc, from, clipId);
  if (!found) return null;
  const localMs = playheadBetweenPaths(doc, from, found.path, playheadMs);
  const ctx = resolveEditContext(doc, found.path, localMs);
  return ctx ? { ctx, clip: found.clip, reach: found.reach } : null;
}

/**
 * Is this clip visible from where we stand — either in the open timeline or in
 * a comp nested under it? The rule selection VALIDATION uses: a selection is
 * legal exactly when the user can see the thing they have selected.
 *
 * Deliberately NOT "is it in the target frame". That older rule is why clicking
 * a layer inside a nested comp used to throw your selection away, and it is the
 * one line that has to change for everything else in this feature to work.
 */
export function isClipInScope(doc: MotionDocument, from: EditPath, clipId: string): boolean {
  const found = selectionPath(doc, from, clipId);
  return found != null && found.reach !== "elsewhere";
}

/**
 * The frames whose layers are legally selectable from here: the open timeline,
 * every comp drilled through to reach it, and everything nested underneath.
 * Precomputed once per interaction when many ids must be checked — the same
 * answer as `isClipInScope` per clip, without re-walking the tree each time.
 */
export function selectableFrameIds(doc: MotionDocument, from: EditPath, maxDescent = MAX_DESCENT): Set<string> {
  const ids = new Set<string>(pathFrameIds(doc, from));
  const target = walkPath(doc, from);
  const start = target.length > 0 ? target[target.length - 1]!.childFrameId : from.rootFrameId;
  let level = [start];
  for (let depth = 0; depth < maxDescent && level.length > 0; depth++) {
    const next: string[] = [];
    for (const frameId of level) {
      for (const track of doc.tracks) {
        for (const c of track.clips) {
          if (c.frameId !== frameId) continue;
          const match = editScopes.resolve(doc, c);
          if (!match || ids.has(match.sourceFrameId)) continue;
          ids.add(match.sourceFrameId);
          next.push(match.sourceFrameId);
        }
      }
    }
    level = next;
  }
  return ids;
}

/**
 * HOW FAR OUT AND IN A GESTURE MAY REACH, in comps.
 *
 * A second axis beside "this layer / all layers", and a genuinely different
 * question: that one asks WHICH LAYERS of a comp, this one asks WHICH COMPS.
 * Standing inside a character's head, "all layers" is the head's layers — which
 * is right, and is also why the eraser could never take a line that had ended
 * up on the body, and why a bucket could not fill against the scene the head
 * sits in.
 *
 * Both directions, because they are wanted separately. `up` walks toward the
 * root (the scene around you); `down` descends into nested comps (the pieces
 * inside what you are pointing at). Zero and zero is the default and means
 * exactly what it says: this comp, nothing else — the behaviour every tool had
 * before there was a way to ask for more.
 */
export interface DepthReach {
  /** Comps toward the ROOT, nearest first. 0 = none. */
  up: number;
  /** Comps DOWN through nested clips. 0 = none. */
  down: number;
}

/** This comp and nothing else — what every tool does unless told otherwise. */
export const HERE: DepthReach = { up: 0, down: 0 };

/**
 * The frames a gesture may act in, from where you are standing — target first,
 * then outward, then inward, so a caller that wants "the nearest one that can
 * take this" simply takes the first.
 *
 * Deliberately ordered rather than a Set: reach is a RANGE, and the whole point
 * of a range is that the near end matters more than the far one.
 */
export function reachableFrameIds(
  doc: MotionDocument,
  from: EditPath,
  reach: DepthReach = HERE,
): string[] {
  const chain = pathFrameIds(doc, from);
  const target = chain[chain.length - 1]!;
  const out: string[] = [target];
  const seen = new Set(out);

  // Outward: ancestors, nearest first.
  for (let i = chain.length - 2; i >= 0 && out.length <= reach.up; i--) {
    const id = chain[i]!;
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }

  // Inward: one whole level at a time, so `down: 1` means every comp directly
  // inside this one rather than the first branch of a depth-first walk.
  let level = [target];
  for (let d = 0; d < reach.down && level.length > 0; d++) {
    const next: string[] = [];
    for (const frameId of level) {
      for (const track of doc.tracks) {
        for (const c of track.clips) {
          if (c.frameId !== frameId) continue;
          const match = editScopes.resolve(doc, c);
          if (!match || seen.has(match.sourceFrameId)) continue;
          seen.add(match.sourceFrameId);
          out.push(match.sourceFrameId);
          next.push(match.sourceFrameId);
        }
      }
    }
    level = next;
  }
  return out;
}

/**
 * Where a frame's own playhead was left — its root time, the instant the board
 * paints it at while you stand somewhere else. See `Frame.playheadMs`.
 */
export function rememberedPlayheadMs(doc: MotionDocument, frameId: string): number {
  return Math.max(0, doc.frames.find((f) => f.id === frameId)?.playheadMs ?? 0);
}
