import type { Behavior, Clip, KeyframeValue } from "../schema";
import { BEHAVIOR, behaviorDef } from "./registry";

/**
 * A behavior's fields as PROPERTY PATHS — `bhv.<id>.<field>` on the character
 * group — so keys, drivers, modulators, the node board, the curve editor and
 * agents reach them with no code of their own. `enabled` is the card's switch
 * (a discrete key: "it stops blinking at 0:04").
 */

const PATH = /^bhv\.([^.]+)\.([^.]+)$/;

export const behaviorsOf = (clip: Clip): readonly Behavior[] => (clip.kind === "group" ? (clip.behaviors ?? []) : []);

export function isBehaviorPath(path: string): boolean {
  return path.startsWith("bhv.") && PATH.test(path);
}

export function getBehaviorProperty(clip: Clip, path: string): KeyframeValue | undefined {
  const m = PATH.exec(path);
  const b = m ? behaviorsOf(clip).find((x) => x.id === m[1]) : undefined;
  if (!b) return undefined;
  const k = m![2]!;
  if (k === "enabled") return b.enabled;
  const v = (b as Record<string, unknown>)[k];
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  const d = BEHAVIOR.defaults(b.type)[k];
  return typeof d === "number" || typeof d === "string" || typeof d === "boolean" ? d : undefined;
}

/** Write one behavior field on a clip (a draft or a baked copy). False when the path is not a behavior's. */
export function setBehaviorProperty(clip: Clip, path: string, value: KeyframeValue): boolean {
  const m = PATH.exec(path);
  if (!m || clip.kind !== "group") return false;
  const list = clip.behaviors;
  const i = list?.findIndex((b) => b.id === m[1]) ?? -1;
  if (!list || i < 0) return true;
  const k = m[2]!;
  if (k === "id" || k === "type" || k === "overrides" || k === "steps") return true;
  if (k === "enabled") {
    if (typeof value === "boolean") clip.behaviors = list.map((b, j) => (j === i ? { ...b, enabled: value } : b));
    return true;
  }
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    if (typeof value === "number" && !Number.isFinite(value)) return true;
    clip.behaviors = list.map((b, j) => (j === i ? ({ ...b, [k]: value } as Behavior) : b));
  }
  return true;
}

/** Every keyable behavior number on a clip, card by card. */
export function behaviorClipPaths(clip: Clip): Array<{ path: string; behavior: Behavior; label: string }> {
  const out: Array<{ path: string; behavior: Behavior; label: string }> = [];
  for (const b of behaviorsOf(clip)) {
    const def = behaviorDef(b.type);
    for (const field of def?.fields ?? []) if (field.kind === "number") out.push({ path: BEHAVIOR.path(b.id, field.key), behavior: b, label: def!.label });
  }
  return out;
}
