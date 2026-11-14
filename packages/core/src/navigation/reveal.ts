import type { MotionDocument } from "../schema";
import { isInternalPage, pageOfFrame } from "../pages";
import { clipAncestorGroups } from "../timeline/groups";
import type { EditPath } from "./path";
import { selectionPath } from "./selection";

/**
 * WHAT HAS TO BE OPEN FOR A THING'S ROW TO EXIST.
 *
 * The layers list and the timeline are views of one tree, and a tree can hide
 * the thing you just selected: on another page, under a folded comp, inside a
 * folded group, in a nested comp nobody peeked into. Selecting it on the canvas
 * (or following a link to it, or an agent picking it) then left both lists
 * scrolled at nothing, because the row they were asked to show did not exist.
 *
 * Every surface that wants to SHOW a target needs the same answer, so it is
 * answered once, here, from the same path the inspector and the stage already
 * resolve the selection through (`selectionPath`). The caller applies it to
 * whatever "open" means in its own state; nothing here knows about collapse
 * sets or scroll positions.
 */
export interface TreeReveal {
  /** The page whose list holds the row; null on the internal shelf, which has no page to show. */
  pageId: string | null;
  /** The top-level comp the row is listed under. */
  rootFrameId: string;
  /** Nested instances to peek open on the way down — the path's hops, outermost first. */
  instances: string[];
  /** Groups to unfold, in every comp on the way, outermost first. */
  groups: string[];
  /** The comp whose audio section lists the clip, when the clip is sound. */
  audioFrameId: string | null;
}

/** Where a clip's row lives, reached from where you are standing. Null for an id that is not a clip. */
export function treeRevealForClip(doc: MotionDocument, from: EditPath, clipId: string): TreeReveal | null {
  const at = selectionPath(doc, from, clipId);
  if (!at) return null;
  const { rootFrameId, hops } = at.path;
  // Outermost first: the comp a hop lives in is opened before the hop is.
  const groups = [...hops, clipId].flatMap((id) =>
    clipAncestorGroups(doc, id)
      .map((g) => g.id)
      .reverse(),
  );
  return {
    pageId: pageOf(doc, rootFrameId),
    rootFrameId,
    instances: [...hops],
    groups,
    audioFrameId: at.clip.kind === "audio" ? at.clip.frameId : null,
  };
}

/** Where a comp's own row lives: its page, nothing to unfold. */
export function treeRevealForFrame(doc: MotionDocument, frameId: string): TreeReveal | null {
  if (!doc.frames.some((f) => f.id === frameId)) return null;
  return { pageId: pageOf(doc, frameId), rootFrameId: frameId, instances: [], groups: [], audioFrameId: null };
}

function pageOf(doc: MotionDocument, frameId: string): string | null {
  const frame = doc.frames.find((f) => f.id === frameId);
  if (!frame) return null;
  const pageId = pageOfFrame(doc, frame);
  return isInternalPage(pageId) ? null : pageId;
}
