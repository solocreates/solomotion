import type { Bone, Clip, GroupClip, KeyframeValue, Rig } from "../schema";
import type { AnimatablePropertyDef } from "../animation/properties";
import type { BoneChannel } from "./pose";

/**
 * BONE CHANNELS AS PROPERTY PATHS — `bone.<id>.<channel>`, the family the
 * property registry, `paths.ts` and the instance enumerator each delegate ONE
 * call to (the `mdf.<id>.<field>` pattern). So a bone's rotation keys, drives,
 * modulates, wires into the node board and answers `layer_set` with no code of
 * its own anywhere else.
 *
 * Channels are the POSE (a delta from rest — `schema/rig.ts`): `x y z`
 * move the head in the parent's frame, `rotation rotationY rotationX` turn
 * it, `scale scaleY scaleZ` stretch it, `ik` is how much its IK wins.
 */

export const BONE_PATH = /^bone\.([^.]+)\.(x|y|z|rotation|rotationX|rotationY|scale|scaleY|scaleZ|ik|con\.[^.]+)$/;

/** `con.<constraintId>` — one of the bone's constraints' influence (4.1). */
const CON = /^con\.(.+)$/;
/** The constraint a channel names: undefined when it is not a `con.` channel, null when that constraint is gone. */
function constraintOf(b: Bone, ch: string) {
  const m = CON.exec(ch);
  return m ? (b.constraints?.find((c) => c.id === m[1]) ?? null) : undefined;
}

interface ChannelSpec {
  label: string;
  identity: number;
  min?: number;
  max?: number;
  step?: number;
  /** Only a world bone (one with depth) has it. */
  spatial?: boolean;
}

const CHANNELS: Record<BoneChannel, ChannelSpec> = {
  x: { label: "Move X", identity: 0, step: 1 },
  y: { label: "Move Y", identity: 0, step: 1 },
  z: { label: "Move Z", identity: 0, step: 1, spatial: true },
  rotation: { label: "Rotation", identity: 0, step: 0.1 },
  rotationY: { label: "Pitch", identity: 0, step: 0.1, spatial: true },
  rotationX: { label: "Roll", identity: 0, step: 0.1, spatial: true },
  scale: { label: "Stretch", identity: 1, step: 0.01 },
  scaleY: { label: "Thickness", identity: 1, step: 0.01 },
  scaleZ: { label: "Depth", identity: 1, step: 0.01, spatial: true },
  ik: { label: "IK", identity: 1, min: 0, max: 1, step: 0.01 },
};

/** The registry row for a `bone.<id>.<channel>` path (labels are the channel's; the bone's name is the group). */
export function bonePropertyDef(key: string): AnimatablePropertyDef | undefined {
  const m = BONE_PATH.exec(key);
  if (!m) return undefined;
  if (CON.test(m[2]!)) return { key, label: "Influence", kind: "number", group: "rig", identity: 1, compose: "replace", appliesTo: ["group"], min: 0, max: 1, step: 0.01 };
  const c = CHANNELS[m[2] as BoneChannel];
  return { key, label: c.label, kind: "number", group: "rig", identity: c.identity, compose: "replace", appliesTo: ["group"], min: c.min, max: c.max, step: c.step };
}

/** Is this a bone path on a group with a rig? */
export function isBonePath(clip: Clip, path: string): boolean {
  return clip.kind === "group" && path.startsWith("bone.") && BONE_PATH.test(path);
}

function boneOf(rig: Rig | null | undefined, id: string): Bone | undefined {
  return rig?.bones.find((b) => b.id === id);
}

/** Read a bone channel off a group; `undefined` when the bone (or its IK) is not there. */
export function getBoneProperty(clip: Clip, path: string): KeyframeValue | undefined {
  if (clip.kind !== "group") return undefined;
  const m = BONE_PATH.exec(path);
  if (!m) return undefined;
  const b = boneOf(clip.rig, m[1]!);
  if (!b) return undefined;
  const con = constraintOf(b, m[2]!);
  if (con !== undefined) return con ? con.influence : undefined;
  const ch = m[2] as BoneChannel;
  if (ch === "ik") return b.ik ? b.ik.mix : undefined;
  const p = b.pose;
  switch (ch) {
    case "x": return p?.x ?? 0;
    case "y": return p?.y ?? 0;
    case "z": return p?.z ?? 0;
    case "rotation": return p?.rotation ?? 0;
    case "rotationX": return p?.rotationX ?? 0;
    case "rotationY": return p?.rotationY ?? 0;
    case "scale": return p?.scale ?? 1;
    case "scaleY": return p?.scaleY ?? p?.scale ?? 1;
    case "scaleZ": return p?.scaleZ ?? p?.scale ?? 1;
  }
}

/** Write a bone channel's base value on a group. Returns false when the path is not a bone's. */
export function setBoneProperty(clip: Clip, path: string, value: KeyframeValue): boolean {
  if (clip.kind !== "group" || !BONE_PATH.test(path)) return false;
  if ((clip as GroupClip).rig) setBoneChannel((clip as GroupClip).rig!, path, value);
  return true;
}

/** Write a channel into a rig (a draft, or a baked copy). Unknown bones and non-numbers are ignored. */
export function setBoneChannel(rig: Rig, path: string, value: KeyframeValue): void {
  const m = BONE_PATH.exec(path);
  if (!m || typeof value !== "number" || !Number.isFinite(value)) return;
  const b = boneOf(rig, m[1]!);
  if (!b) return;
  const con = constraintOf(b, m[2]!);
  if (con !== undefined) {
    if (con) con.influence = Math.max(0, Math.min(1, value));
    return;
  }
  const ch = m[2] as BoneChannel;
  if (ch === "ik") {
    if (b.ik) b.ik.mix = Math.max(0, Math.min(1, value));
    return;
  }
  const p = (b.pose ??= { x: 0, y: 0, rotation: 0, scale: 1, scaleY: null });
  switch (ch) {
    case "x": p.x = value; break;
    case "y": p.y = value; break;
    case "z": p.z = value; break;
    case "rotation": p.rotation = value; break;
    case "rotationX": p.rotationX = value; break;
    case "rotationY": p.rotationY = value; break;
    case "scale": p.scale = value; break;
    case "scaleY": p.scaleY = value; break;
    case "scaleZ": p.scaleZ = value; break;
  }
}

/** Is this bone a WORLD bone — one with depth, whose 3D channels mean something? */
export function boneIsSpatial(b: Bone): boolean {
  return b.rest.z !== undefined || b.rest.rotationX !== undefined || b.rest.rotationY !== undefined;
}

/**
 * Every bone path this group exposes, bone by bone (the 3D channels only on a
 * world bone; `ik` only where the bone has IK) — what the node board, the
 * curve editor and `layer_properties` list.
 */
export function boneClipPaths(clip: Clip): Array<{ path: string; bone: Bone }> {
  if (clip.kind !== "group" || !clip.rig) return [];
  const out: Array<{ path: string; bone: Bone }> = [];
  for (const b of clip.rig.bones) {
    const spatial = boneIsSpatial(b);
    for (const [ch, spec] of Object.entries(CHANNELS) as Array<[BoneChannel, ChannelSpec]>) {
      if (spec.spatial && !spatial) continue;
      if (ch === "ik" && !b.ik) continue;
      out.push({ path: `bone.${b.id}.${ch}`, bone: b });
    }
    for (const c of b.constraints ?? []) out.push({ path: `bone.${b.id}.con.${c.id}`, bone: b });
  }
  return out;
}
