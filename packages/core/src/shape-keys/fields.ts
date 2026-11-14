import type { MotionDocument, Clip, KeyframeValue, ShapeKey } from "../schema";
import type { AnimatablePropertyDef } from "../animation/properties";

/**
 * SHAPE-KEY WEIGHTS AS PROPERTY PATHS — `key.<id>`, the family the property
 * registry, `paths.ts` and the instance enumerator each delegate ONE call to
 * (the `bone.<id>.<channel>` pattern, `rig/fields.ts`). So a weight keys,
 * drives, modulates, takes a PoseSet value, wires into the node board, shows
 * in the dope sheet and answers `layer_set` with no code of its own anywhere.
 *
 * The base slot is `ShapeKey.value`. A weight is a factor, not a clamp: the
 * def carries no min/max, so 1.3 (overshoot) and −0.5 are honest values; the
 * inspector's meter shows 0..1.
 */

export const KEY_PATH = /^key\.([^.]+)$/;

export function keyPath(id: string): string {
  return `key.${id}`;
}

/** The clip's keys, for the two kinds that carry them. */
export function shapeKeysOf(clip: Clip): ShapeKey[] | undefined {
  return clip.kind === "path" || clip.kind === "mesh" ? clip.shapeKeys : undefined;
}

/** The registry row for a `key.<id>` path (the key's name is the group label). */
export function shapeKeyPropertyDef(key: string): AnimatablePropertyDef | undefined {
  if (!KEY_PATH.test(key)) return undefined;
  return { key, label: "Weight", kind: "number", group: "geometry", identity: 0, compose: "replace", appliesTo: ["path", "mesh"], step: 0.01 };
}

/** Is this a weight path on a clip that can carry keys? */
export function isShapeKeyPath(clip: Clip, path: string): boolean {
  return (clip.kind === "path" || clip.kind === "mesh") && path.startsWith("key.") && KEY_PATH.test(path);
}

/** A weight's base value; `undefined` when the key is not there. */
export function getShapeKeyProperty(clip: Clip, path: string): KeyframeValue | undefined {
  const m = KEY_PATH.exec(path);
  if (!m) return undefined;
  const k = shapeKeysOf(clip)?.find((x) => x.id === m[1]);
  return k ? (k.value ?? 0) : undefined;
}

/** Write a weight's base value. False when the path is not a weight path on this clip. */
export function setShapeKeyProperty(clip: Clip, path: string, value: KeyframeValue): boolean {
  const m = KEY_PATH.exec(path);
  if (!m || (clip.kind !== "path" && clip.kind !== "mesh")) return false;
  // A flag from an expression counts too (`speaking()` on a key).
  const v = typeof value === "boolean" ? (value ? 1 : 0) : value;
  const k = shapeKeysOf(clip)?.find((x) => x.id === m[1]);
  if (k && typeof v === "number" && Number.isFinite(v)) k.value = v;
  return true;
}

/** Every weight path this clip exposes, key by key — what the board, the curve editor and `layer_properties` list. */
export function shapeKeyClipPaths(clip: Clip): Array<{ path: string; key: ShapeKey }> {
  return (shapeKeysOf(clip) ?? []).map((key) => ({ path: keyPath(key.id), key }));
}

const hasKeysMemo = new WeakMap<MotionDocument, boolean>();

/**
 * Does any clip carry shape keys? (The bake-gate question, amendment 3.)
 *
 * Note it is NOT on the gate today: weights need no bake of their own — keys
 * are sampled where geometry is read, and drivers / PoseMix already open the
 * gate and write the base slot. Gating on this would bake (clone) every
 * document with a key on every frame for nothing.
 */
export function documentHasShapeKeys(doc: MotionDocument): boolean {
  const hit = hasKeysMemo.get(doc);
  if (hit !== undefined) return hit;
  let any = false;
  outer: for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if ((shapeKeysOf(clip)?.length ?? 0) > 0) {
        any = true;
        break outer;
      }
    }
  }
  hasKeysMemo.set(doc, any);
  return any;
}
