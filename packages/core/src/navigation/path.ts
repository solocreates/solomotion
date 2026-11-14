/**
 * THE navigation state: an `EditPath`.
 *
 * ONE canonical shape replaces the old pair of independent fields
 * (`activeFrameId` + `timelinePath`, which could and did disagree — that's the
 * "Frame 1 ▸ Frame 1" breadcrumb, the lost drill on tab switch, and the
 * click-jumps-you-out bug, all from the same root cause).
 *
 *   root  = the comp the TAB is on: a real frame anchoring the stage.
 *   hops  = the nested clips you stepped through, outermost first.
 *
 * Everything else is DERIVED and therefore cannot drift:
 *   target frame   = source of the last hop (or the root when hops = []).
 *   breadcrumb     = root + one chip per hop, never duplicated.
 *   depth          = hops.length.
 *
 * A path is always normalised before it is stored: broken links, deleted clips,
 * cycles and no-op hops are pruned to the longest valid prefix. So an invalid
 * navigation state is unrepresentable rather than merely "unlikely".
 */

import type { MotionDocument, Clip, Frame } from "../schema";
import { isInternalPage } from "../pages";
import { locateClip } from "../timeline/ops";
import { editScopes, type EditScopeKind } from "./scope";

export interface EditPath {
  /** The tab's root comp. */
  readonly rootFrameId: string;
  /** Nested clip ids stepped through, outermost first. */
  readonly hops: readonly string[];
}

export function editPath(rootFrameId: string, hops: readonly string[] = []): EditPath {
  return { rootFrameId, hops: [...hops] };
}

export function pathsEqual(a: EditPath | null, b: EditPath | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.rootFrameId === b.rootFrameId &&
    a.hops.length === b.hops.length &&
    a.hops.every((h, i) => h === b.hops[i])
  );
}

/** One resolved link in the chain: the clip stepped through and both its ends. */
export interface PathLink {
  clipId: string;
  clip: Clip;
  parentFrameId: string;
  childFrameId: string;
  kind: EditScopeKind;
}

/**
 * Walk a path against the document, stopping at the first broken link. Returns
 * the links that ARE valid — the basis of both normalisation and resolution.
 */
export function walkPath(doc: MotionDocument, path: EditPath): PathLink[] {
  const links: PathLink[] = [];
  let parentFrameId = path.rootFrameId;
  const seen = new Set<string>([parentFrameId]);
  for (const clipId of path.hops) {
    const loc = locateClip(doc, clipId);
    if (!loc) break;
    // The clip must actually live in the frame we're standing in, or the path
    // is describing a nesting that no longer exists (clip moved comps).
    if (loc.clip.frameId !== parentFrameId) break;
    const match = editScopes.resolve(doc, loc.clip);
    if (!match) break;
    if (seen.has(match.sourceFrameId)) break; // a cycle — refuse to enter
    links.push({
      clipId,
      clip: loc.clip,
      parentFrameId,
      childFrameId: match.sourceFrameId,
      kind: match.kind,
    });
    seen.add(match.sourceFrameId);
    parentFrameId = match.sourceFrameId;
  }
  return links;
}

/**
 * Prune a path to its longest valid prefix. If the root frame itself is gone,
 * returns null — the caller picks a new root (that's a policy decision, not a
 * geometry one).
 */
export function normalizePath(doc: MotionDocument, path: EditPath | null): EditPath | null {
  if (!path) return null;
  if (!doc.frames.some((f) => f.id === path.rootFrameId)) return null;
  const links = walkPath(doc, path);
  return links.length === path.hops.length ? path : editPath(path.rootFrameId, links.map((l) => l.clipId));
}

/** The frame whose timeline is open — the thing you are editing. */
export function targetFrameId(doc: MotionDocument, path: EditPath): string {
  const links = walkPath(doc, path);
  return links.length > 0 ? links[links.length - 1]!.childFrameId : path.rootFrameId;
}

export function targetFrame(doc: MotionDocument, path: EditPath): Frame | null {
  const id = targetFrameId(doc, path);
  return doc.frames.find((f) => f.id === id) ?? null;
}

/** Every frame on the path, root-first, target last. */
export function pathFrameIds(doc: MotionDocument, path: EditPath): string[] {
  return [path.rootFrameId, ...walkPath(doc, path).map((l) => l.childFrameId)];
}

/** Step one level out (drop the last hop). Root paths are returned unchanged. */
export function parentPath(path: EditPath): EditPath {
  return path.hops.length === 0 ? path : editPath(path.rootFrameId, path.hops.slice(0, -1));
}

/** Truncate to `depth` hops — the breadcrumb's "jump to this crumb". */
export function pathAtDepth(path: EditPath, depth: number): EditPath {
  return editPath(path.rootFrameId, path.hops.slice(0, Math.max(0, depth)));
}

/**
 * Step INTO a clip from the current path. Returns null when the clip has no
 * inside, or when entering it would revisit a frame already on the path.
 *
 * Re-entering the SAME clip you are already inside is idempotent (returns the
 * current path) — the old runaway `Frame 1 ▸ Frame 1 ▸ Frame 1` breadcrumb was
 * exactly this case appending forever.
 */
export function enterPath(doc: MotionDocument, path: EditPath, clipId: string): EditPath | null {
  if (path.hops[path.hops.length - 1] === clipId) return path;
  const candidate = editPath(path.rootFrameId, [...path.hops, clipId]);
  const links = walkPath(doc, candidate);
  return links.length === candidate.hops.length ? candidate : null;
}

/**
 * Build a path from the document's own ancestry when all we know is "open this
 * frame": walk up from an INTERNAL comp through its owner until we reach a
 * frame that has a home of its own (a page). This is how the Layers panel /
 * library / search reveal a nested comp without the user having drilled — the
 * path is a fact about the document, not about the click history.
 *
 * A frame that lives on a page is always its own root, even if something
 * happens to instance it. Otherwise clicking a component master sitting on your
 * page would teleport you into whichever clip uses it, which is the opposite of
 * what "open this frame" means.
 */
export function pathToFrame(doc: MotionDocument, frameId: string, maxDepth = 32): EditPath {
  const hops: string[] = [];
  let current = frameId;
  const seen = new Set<string>([current]);
  for (let i = 0; i < maxDepth; i++) {
    const frame = doc.frames.find((f) => f.id === current);
    // A comp on a page is an artboard: it is its own root however many clips
    // link to it (a cover's live wall showing a scene once must not turn the
    // scene into Cover ▸ Scene). Only a comp on the internal shelf — embedded,
    // never painted as an artboard — is entered through its owner, in place.
    if (!frame || !isInternalPage(frame.pageId)) break;
    const owner = soleOwnerClip(doc, current);
    if (!owner || seen.has(owner.frameId)) break;
    hops.unshift(owner.id);
    current = owner.frameId;
    seen.add(current);
  }
  return editPath(current, hops);
}

/**
 * The single nested clip that references a frame, when there is exactly one.
 * Ambiguous (0 or 2+ references) means the frame has no unique home, so it is
 * its own root.
 */
function soleOwnerClip(doc: MotionDocument, frameId: string): Clip | null {
  let owner: Clip | null = null;
  let count = 0;
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind === "nested" && clip.sourceFrameId === frameId) {
        owner = clip;
        count++;
        if (count > 1) return null;
      }
    }
  }
  return count === 1 ? owner : null;
}

/** One breadcrumb chip. `depth` is what `pathAtDepth` needs to jump here. */
export interface TrailCrumb {
  depth: number;
  frameId: string;
  name: string;
  /** The clip stepped through to REACH this crumb (null for the root). */
  clipId: string | null;
  badge: EditScopeKind["badge"] | "root";
  isTarget: boolean;
}

/**
 * The breadcrumb: root first, target last, EXACTLY one chip per frame. Because
 * the target is derived from the path rather than stored beside it, a duplicate
 * final chip ("Frame 1 ▸ Frame 1") is now impossible by construction.
 */
export function pathTrail(doc: MotionDocument, path: EditPath): TrailCrumb[] {
  const name = (id: string) => doc.frames.find((f) => f.id === id)?.name ?? "—";
  const links = walkPath(doc, path);
  const crumbs: TrailCrumb[] = [
    {
      depth: 0,
      frameId: path.rootFrameId,
      name: name(path.rootFrameId),
      clipId: null,
      badge: "root",
      isTarget: links.length === 0,
    },
  ];
  links.forEach((link, i) => {
    crumbs.push({
      depth: i + 1,
      frameId: link.childFrameId,
      name: name(link.childFrameId),
      clipId: link.clipId,
      badge: link.kind.badge,
      isTarget: i === links.length - 1,
    });
  });
  return crumbs;
}
