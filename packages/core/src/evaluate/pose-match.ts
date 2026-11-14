import type { MotionDocument, GroupClip, KeyframeValue, PoseSet } from "../schema";
import { getClipProperty } from "../animation/paths";
import { channelValueAt, writeChannel } from "../animation/channels";
import { parseHexColor } from "../animation/properties";
import { clipLookup } from "../timeline/frame-index";
import { composePosed, poseComposeOf, posedPathsAt, posePathsOf, poseSetMixAt, type PoseEnv } from "../rig/poses";
import { resolvedDocAt } from "./resolved-doc";

/**
 * WHICH POSE IS SHOWING — computed, never stored (ADR-characters-3, "Parts").
 *
 * The set's channel says which pose is CHOSEN; what a person sees can differ
 * — they dragged the lid a little after picking Squint. A pose is SHOWING
 * when every value it would put on the part equals what the part shows now
 * (its own values on a path it owns; on a layered path — a bone, a shape key —
 * the other sets plus its share, with nothing of yours on top). So:
 *
 *  - picking a pose and touching nothing: chosen, showing;
 *  - a hand tweak on top: chosen, MODIFIED (Update from current / Reset);
 *  - a new pose captured from now: showing at once, with no bookkeeping.
 */

export interface PoseMatch {
  /** The pose the set's channel chooses at this instant (null for an empty set). */
  chosen: string | null;
  /** Every pose that matches what the part shows now. */
  showing: string[];
  /** The chosen pose is not what shows — a hand change on top (false mid-blend). */
  modified: boolean;
  /** Mid-blend: no pose is settled. */
  blending: boolean;
}

function same(path: string, a: KeyframeValue | undefined, b: KeyframeValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (typeof a === "number" && typeof b === "number") {
    const scale = Math.max(1, Math.abs(a), Math.abs(b));
    // Degrees and px to a hundredth; ratios (scale, weights) to a thousandth.
    return Math.abs(a - b) <= (/scale|key\.|opacity|ik$/.test(path) ? 1e-3 : 1e-2) * scale;
  }
  if (typeof a === "string" && typeof b === "string") {
    const ca = parseHexColor(a);
    const cb = parseHexColor(b);
    if (ca && cb) return Math.abs(ca.r - cb.r) + Math.abs(ca.g - cb.g) + Math.abs(ca.b - cb.b) < 3 && Math.abs(ca.a - cb.a) < 0.01;
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/** What showing `poseId` would put on `path` now: a layered path keeps your layer and the other sets. */
function wouldShow(doc: MotionDocument, group: GroupClip, set: PoseSet, poseId: string, clipId: string, path: string, compMs: number, posed: ReturnType<typeof posedPathsAt>): KeyframeValue | undefined {
  const pose = set.poses.find((p) => p.id === poseId);
  const own = pose?.values.find((v) => v.clipId === clipId && v.path === path)?.value;
  const clip = clipLookup(doc)(clipId);
  if (!clip) return undefined;
  const compose = poseComposeOf(path);
  const p = posed.get(`${clipId}\u0000${path}`);
  if (compose === "own") {
    const mine = channelValueAt(clip, path, compMs - clip.startMs);
    return own ?? (p ? composePosed(p, mine, set.id) : mine);
  }
  // The pose's own picture: the OTHER sets on top of no hand change at all —
  // a turn of yours over it is exactly the modification this is asked to see.
  const identity = compose === "add" ? 0 : 1;
  const others = p ? composePosed(p, identity, set.id) : identity;
  const base = typeof others === "number" ? others : identity;
  const share = typeof own === "number" ? own : compose === "add" ? 0 : 1;
  return compose === "add" ? base + share : base * share;
}

/** Which of a set's poses show at comp time `compMs` — see the file's note. */
export function poseMatchAt(doc: MotionDocument, group: GroupClip, set: PoseSet, compMs: number, env: PoseEnv = {}): PoseMatch {
  const mix = poseSetMixAt(doc, group, set, compMs, env);
  if (!mix) return { chosen: null, showing: [], modified: false, blending: false };
  const blending = mix.chain.length > 1;
  const shownDoc = resolvedDocAt(doc, compMs, group.frameId);
  const shown = clipLookup(shownDoc);
  const posed = posedPathsAt(doc, compMs, group.frameId, env);
  const paths = posePathsOf(set);
  const showing = set.poses
    .filter((pose) =>
      paths.every(({ clipId, path }) => {
        const c = shown(clipId);
        return !c || same(path, getClipProperty(c, path), wouldShow(doc, group, set, pose.id, clipId, path, compMs, posed));
      }),
    )
    .map((p) => p.id);
  return { chosen: mix.target, showing, modified: !blending && !showing.includes(mix.target), blending };
}

/**
 * RESET TO POSE — take the hand changes off a set's part at group-local
 * `localMs`: every layered path the set names goes back to your identity
 * there (no turn, no stretch, no weight of your own), so what shows is the
 * pose and the other sets. Owned paths are the pose's already. Keys where the
 * path is keyed. Returns how many paths changed.
 */
export function resetToPose(doc: MotionDocument, group: GroupClip, set: PoseSet, localMs: number): number {
  let n = 0;
  for (const { clipId, path } of posePathsOf(set)) {
    const compose = poseComposeOf(path);
    if (compose === "own") continue;
    const clip = clipLookup(doc)(clipId);
    if (!clip) continue;
    const identity = compose === "add" ? 0 : 1;
    const local = localMs + group.startMs - clip.startMs;
    if (same(path, channelValueAt(clip, path, local), identity)) continue;
    writeChannel(clip, path, local, identity);
    n++;
  }
  return n;
}
