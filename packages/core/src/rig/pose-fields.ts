import type { Clip, KeyframeValue, PoseSet } from "../schema";
import type { AnimatablePropertyDef } from "../animation/properties";

/**
 * POSE CHANNELS AS PROPERTY PATHS — `pose.<setId>`, the family the property
 * registry, `paths.ts` and the instance enumerator each delegate ONE call to
 * (the `rig/fields.ts` pattern). A DISCRETE string: the NAME of the pose the
 * set shows (a number counts poses from the first, like a switch). So keys,
 * expressions (`lipsync()`, `state()`, `blink()`), drivers, the dope sheet,
 * copy/paste properties and agents choose poses with no code of their own.
 *
 * The base slot is `PoseSet.show`. Names are stored as written; resolving
 * them (aliases, vocabulary fallbacks, the first pose) happens at evaluation
 * (`resolvePose`), so a key reads as what the animator typed.
 */

export const POSE_PATH = /^pose\.([^.]+)$/;

/** The registry row for a `pose.<setId>` path. */
export function posePropertyDef(key: string): AnimatablePropertyDef | undefined {
  if (!POSE_PATH.test(key)) return undefined;
  return { key, label: "Pose", kind: "discrete", group: "pose", identity: "", compose: "replace", appliesTo: ["group"] };
}

/** Is this a pose path on a group? */
export function isPosePath(clip: Clip, path: string): boolean {
  return clip.kind === "group" && path.startsWith("pose.") && POSE_PATH.test(path);
}

function setOf(clip: Clip, path: string): PoseSet | undefined {
  if (clip.kind !== "group") return undefined;
  const m = POSE_PATH.exec(path);
  return m ? clip.poses?.find((s) => s.id === m[1]) : undefined;
}

/** The set's resting choice; `undefined` when the set is not there. */
export function getPoseProperty(clip: Clip, path: string): KeyframeValue | undefined {
  const set = setOf(clip, path);
  if (!set) return undefined;
  return set.show || set.poses[0]?.name || "";
}

/**
 * Write the set's resting choice. A number (or a flag) counts from the first
 * pose and is stored as that pose's NAME — what reads well and survives
 * reordering. True when the path is a pose path (even if its set is gone).
 */
export function setPoseProperty(clip: Clip, path: string, value: KeyframeValue): boolean {
  if (!isPosePath(clip, path)) return false;
  const set = setOf(clip, path);
  if (!set) return true;
  if (typeof value === "string") set.show = value;
  else if (typeof value === "number" || typeof value === "boolean") {
    const n = typeof value === "boolean" ? (value ? 1 : 0) : value;
    if (Number.isFinite(n) && set.poses.length) set.show = set.poses[Math.max(0, Math.min(set.poses.length - 1, Math.round(n)))]!.name;
  }
  return true;
}

/** Every pose path this group exposes — what the node board, the curve editor and `layer_properties` list. */
export function poseClipPaths(clip: Clip): Array<{ path: string; set: PoseSet }> {
  if (clip.kind !== "group" || !clip.poses?.length) return [];
  return clip.poses.map((set) => ({ path: `pose.${set.id}`, set }));
}
