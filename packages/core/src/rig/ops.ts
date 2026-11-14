import type { MotionDocument, Bind, Bone, BoneConstraint, BoneIk, BoneLimits, BoneShape, BoneTarget, Clip, GroupClip, Rig, VisualClip, WeightStroke } from "../schema";
import { bindSchema, boneConstraintSchema, boneSchema, rigSchema } from "../schema/rig";
import { createId } from "../ids";
import { createGroupClip } from "../factories";
import { groupClips } from "../timeline/groups";
import { compDurationMs, locateClip } from "../timeline/ops";
import { placeClip } from "../timeline/place";
import { writeChannel } from "../animation/channels";
import { invert4, mul4, rotation4, transformPoint, translate4, type Mat4, type V3 } from "../world/math";
import { limitChannel, orderBones, type BoneChannel } from "./pose";
import { BONE_PATH } from "./fields";

/**
 * RIG EDITS — every change a person or an agent makes to a rig, written ONCE.
 *
 * People think about bones in the RIG's space: "a bone from the shoulder to
 * the elbow". The document stores each bone relative to its parent (so posing
 * a parent carries its children). These ops speak rig space and do the
 * conversion, so a canvas drag, an inspector field and `rig_bone` cannot
 * disagree about what "move the elbow" means.
 *
 * Planar or not is the comp's to say: a flat comp's bones lie in its plane
 * (x right, y down); a world's stand anywhere (Z up).
 */

export interface BoneInRig {
  head: V3;
  tail: V3;
  /** A world bone's turn about its own length, degrees (0 in a flat comp). */
  roll: number;
}

/** Is this group's rig flat (its comp is not a world)? */
export function rigIsPlanar(doc: MotionDocument, group: Pick<Clip, "frameId">): boolean {
  return !doc.frames.find((f) => f.id === group.frameId)?.world;
}

/** Every bone's REST frame in rig space (head at the origin, +X to the tail), parents first. */
export function restFrames(rig: Rig, planar: boolean): Map<string, Mat4> {
  const out = new Map<string, Mat4>();
  for (const { bone, parent } of orderBones(rig.bones)) {
    const r = bone.rest;
    const local = mul4(translate4([r.x, r.y, planar ? 0 : (r.z ?? 0)]), planar ? rotation4(0, 0, r.rotation) : rotation4(r.rotationX ?? 0, r.rotationY ?? 0, r.rotation));
    out.set(bone.id, parent ? mul4(out.get(parent)!, local) : local);
  }
  return out;
}

/** Every bone's head, tail and roll in rig space at rest. */
export function bonesInRig(rig: Rig, planar: boolean): Map<string, BoneInRig> {
  const frames = restFrames(rig, planar);
  const out = new Map<string, BoneInRig>();
  for (const b of rig.bones) {
    const f = frames.get(b.id)!;
    out.set(b.id, { head: transformPoint(f, [0, 0, 0]), tail: transformPoint(f, [b.rest.length, 0, 0]), roll: planar ? 0 : (b.rest.rotationX ?? 0) });
  }
  return out;
}

/**
 * A bone's rest in its parent's frame from a head, tail and roll in rig
 * space. The angles follow the evaluator's order (R = Rz·Ry·Rx with the bone
 * along +X): heading about Z, pitch about Y, roll about the bone itself.
 */
export function restFrom(parentFrame: Mat4 | null, at: BoneInRig, planar: boolean): Bone["rest"] {
  const inv = parentFrame ? invert4(parentFrame) : null;
  const h = inv ? transformPoint(inv, at.head) : at.head;
  const t = inv ? transformPoint(inv, at.tail) : at.tail;
  const d: V3 = [t[0] - h[0], t[1] - h[1], planar ? 0 : t[2] - h[2]];
  const length = Math.hypot(d[0], d[1], d[2]);
  // Tidy numbers in the file, fine enough that re-aiming a bone again and
  // again never walks a joint off where it was put.
  const round = (v: number) => Math.round(v * 1e6) / 1e6;
  if (planar) return { x: round(h[0]), y: round(h[1]), rotation: round(length > 1e-9 ? (Math.atan2(d[1], d[0]) * 180) / Math.PI : 0), length: round(length) };
  const flat = Math.hypot(d[0], d[1]);
  return {
    x: round(h[0]),
    y: round(h[1]),
    z: round(h[2]),
    rotation: round(flat > 1e-9 ? (Math.atan2(d[1], d[0]) * 180) / Math.PI : 0),
    rotationY: round(length > 1e-9 ? (-Math.atan2(d[2], flat) * 180) / Math.PI : 0),
    rotationX: round(at.roll),
    length: round(length),
  };
}

function rigOf(doc: MotionDocument, groupId: string): { group: GroupClip; rig: Rig } | null {
  const c = locateClip(doc, groupId)?.clip;
  if (!c || c.kind !== "group" || !c.rig) return null;
  return { group: c, rig: c.rig };
}

/** The next free "Bone N" name in a rig. */
function nextName(rig: Rig, base = "Bone"): string {
  const used = new Set(rig.bones.map((b) => b.name));
  for (let i = rig.bones.length + 1; ; i++) if (!used.has(`${base} ${i}`)) return `${base} ${i}`;
}

// ── Making a rig ─────────────────────────────────────────────────────────────

export interface BoneSpec {
  /** Rig space. A flat comp reads x and y. */
  head: V3 | [number, number];
  tail: V3 | [number, number];
  name?: string;
  parent?: string | null;
  roll?: number;
  deform?: boolean;
}

const v3 = (p: V3 | [number, number]): V3 => [p[0], p[1], p[2] ?? 0];

/**
 * A NEW RIG — the layers (one comp) wrapped in a group that carries bones,
 * or a group made a rig. With no layers and no bones there is nothing to make
 * (an empty group is pruned); bones drawn first make a rig the art moves into.
 * Returns the group's id.
 */
export function createRig(
  doc: MotionDocument,
  frameId: string,
  opts: { memberIds?: string[]; name?: string; bones?: BoneSpec[] } = {},
): string | null {
  const ids = opts.memberIds ?? [];
  let groupId: string | null = null;
  const only = ids.length === 1 ? locateClip(doc, ids[0]!)?.clip : null;
  if (only?.kind === "group" && !only.rig && !only.layout) groupId = only.id;
  else if (ids.length) groupId = groupClips(doc, ids, opts.name ?? "Rig");
  else if (opts.bones?.length) {
    const g = createGroupClip({ frameId, startMs: 0, durationMs: Math.max(500, compDurationMs(doc, frameId)), name: opts.name ?? "Rig" });
    g.rig = rigSchema.parse({});
    // Bones BEFORE placing: a group with bones is never "empty", and placing
    // ends by pruning empty groups.
    chainInto(g.rig, !doc.frames.find((f) => f.id === frameId)?.world, opts.bones);
    placeClip(doc, g, { landing: "surface" });
    return g.id;
  }
  if (!groupId) return null;
  const g = locateClip(doc, groupId)!.clip as GroupClip;
  if (g.layout) return null;
  g.rig ??= rigSchema.parse({});
  if (opts.name && ids.length === 1) g.name = opts.name;
  chainInto(g.rig, rigIsPlanar(doc, g), opts.bones ?? []);
  return groupId;
}

/** Bones added one after another, each the child of the last unless it names a parent. */
function chainInto(rig: Rig, planar: boolean, specs: readonly BoneSpec[]): void {
  let parent: string | null = null;
  for (const spec of specs) parent = boneInto(rig, planar, { ...spec, parent: spec.parent === undefined ? parent : spec.parent });
}

function boneInto(rig: Rig, planar: boolean, spec: BoneSpec): string {
  const parent = spec.parent && rig.bones.some((b) => b.id === spec.parent) ? spec.parent : null;
  const frames = restFrames(rig, planar);
  const bone = boneSchema.parse({
    id: createId("bone"),
    name: spec.name ?? nextName(rig),
    parent,
    rest: restFrom(parent ? frames.get(parent)! : null, { head: v3(spec.head), tail: v3(spec.tail), roll: spec.roll ?? 0 }, planar),
    deform: spec.deform ?? true,
  });
  rig.bones.push(bone);
  return bone.id;
}

/**
 * Add a bone from a head and tail in rig space. `parent` undefined = a root.
 * Returns its id.
 */
export function addBone(doc: MotionDocument, groupId: string, spec: BoneSpec): string | null {
  const r = rigOf(doc, groupId);
  return r ? boneInto(r.rig, rigIsPlanar(doc, r.group), spec) : null;
}

/**
 * Re-place a bone's REST in rig space. `children`:
 *  - `follow` — what hangs off it moves with it (rotate the arm, the hand comes);
 *  - `stay` — every child keeps where it is in the rig, except one JOINED at
 *    the old tail, whose head moves to the new tail (drag the elbow: the
 *    upper arm and forearm both re-aim, the wrist stays put).
 * The art never moves: it is bound to rest, and the weights re-derive.
 */
export function editBone(
  doc: MotionDocument,
  groupId: string,
  boneId: string,
  at: Partial<BoneInRig>,
  opts: { children?: "follow" | "stay" } = {},
): boolean {
  const r = rigOf(doc, groupId);
  if (!r) return false;
  const bone = r.rig.bones.find((b) => b.id === boneId);
  if (!bone) return false;
  const planar = rigIsPlanar(doc, r.group);
  const before = bonesInRig(r.rig, planar);
  const was = before.get(boneId)!;
  const next: BoneInRig = { head: at.head ? v3(at.head) : was.head, tail: at.tail ? v3(at.tail) : was.tail, roll: at.roll ?? was.roll };
  const frames = restFrames(r.rig, planar);
  const parentFrame = bone.parent ? frames.get(bone.parent) ?? null : null;
  bone.rest = restFrom(parentFrame, next, planar);
  if ((opts.children ?? "stay") === "stay") {
    const joinEps = Math.max(1e-3, bone.rest.length * 1e-3);
    // Children re-expressed against the bone's NEW frame, keeping their rig-space place.
    const kids = r.rig.bones.filter((b) => b.parent === boneId);
    const after = restFrames(r.rig, planar).get(boneId)!;
    for (const k of kids) {
      const old = before.get(k.id)!;
      const joined = Math.hypot(old.head[0] - was.tail[0], old.head[1] - was.tail[1], old.head[2] - was.tail[2]) <= joinEps;
      k.rest = restFrom(after, { head: joined ? next.tail : old.head, tail: old.tail, roll: old.roll }, planar);
    }
  }
  return true;
}

/** Rename, re-parent (keeping its place in the rig), set deform, IK. */
export function setBoneProps(
  doc: MotionDocument,
  groupId: string,
  boneId: string,
  props: {
    name?: string;
    parent?: string | null;
    deform?: boolean;
    ik?: Partial<BoneIk> | null;
    shape?: BoneShape;
    size?: number | null;
    color?: string | null;
    /** Per channel: a range, or null to free it. `null` frees every channel. */
    limits?: { [K in keyof BoneLimits]?: readonly [number, number] | null } | null;
  },
): boolean {
  const r = rigOf(doc, groupId);
  const bone = r?.rig.bones.find((b) => b.id === boneId);
  if (!r || !bone) return false;
  if (props.name !== undefined && props.name.trim()) bone.name = props.name.trim();
  if (props.deform !== undefined) bone.deform = props.deform;
  if (props.shape !== undefined) bone.shape = props.shape;
  if (props.size !== undefined) bone.size = props.size !== null && props.size > 0 ? props.size : null;
  if (props.color !== undefined) bone.color = props.color && /^#[0-9a-f]{6}$/i.test(props.color) ? props.color.toLowerCase() : null;
  if (props.limits !== undefined) {
    const next: BoneLimits = props.limits === null ? {} : { ...(bone.limits ?? {}) };
    for (const [ch, range] of Object.entries(props.limits ?? {})) {
      const k = ch as keyof BoneLimits;
      if (range === null || range === undefined) delete next[k];
      else if (Number.isFinite(range[0]) && Number.isFinite(range[1])) next[k] = [Math.min(range[0], range[1]), Math.max(range[0], range[1])];
    }
    bone.limits = Object.keys(next).length ? next : null;
  }
  if (props.parent !== undefined) {
    const planar = rigIsPlanar(doc, r.group);
    const p = props.parent && props.parent !== boneId && r.rig.bones.some((b) => b.id === props.parent) && !isDescendant(r.rig, props.parent, boneId) ? props.parent : null;
    const keep = bonesInRig(r.rig, planar).get(boneId)!;
    bone.parent = p;
    bone.rest = restFrom(p ? restFrames(r.rig, planar).get(p)! : null, keep, planar);
  }
  if (props.ik !== undefined) {
    if (props.ik === null || props.ik.target === null) bone.ik = null;
    else {
      const target = props.ik.target ?? bone.ik?.target;
      if (target && target !== boneId && r.rig.bones.some((b) => b.id === target)) {
        bone.ik = {
          target,
          chain: props.ik.chain ?? bone.ik?.chain ?? 2,
          pole: props.ik.pole !== undefined ? (props.ik.pole && r.rig.bones.some((b) => b.id === props.ik!.pole) ? props.ik.pole : null) : (bone.ik?.pole ?? null),
          flip: props.ik.flip ?? bone.ik?.flip ?? false,
          mix: props.ik.mix ?? bone.ik?.mix ?? 1,
        };
      }
    }
  }
  return true;
}

/**
 * CONNECT a bone to its parent: its head moves onto the parent's tip (the tail
 * stays where it is), so the joint is one point again — Blender's Connected.
 * The art does not move (rest is setup). False for a root.
 */
export function connectBone(doc: MotionDocument, groupId: string, boneId: string): boolean {
  const r = rigOf(doc, groupId);
  const bone = r?.rig.bones.find((b) => b.id === boneId);
  if (!r || !bone?.parent) return false;
  const at = bonesInRig(r.rig, rigIsPlanar(doc, r.group)).get(bone.parent);
  return !!at && editBone(doc, groupId, boneId, { head: at.tail }, { children: "stay" });
}

/**
 * Is a bone OFFSET from its parent — its head somewhere other than the
 * parent's tip? Drawn with a dashed line to the parent (Blender's relationship
 * line); a connected child shares the joint.
 */
export function boneIsOffset(rig: Rig, boneId: string, planar: boolean): boolean {
  const bone = rig.bones.find((b) => b.id === boneId);
  if (!bone?.parent) return false;
  const all = bonesInRig(rig, planar);
  const a = all.get(bone.parent)!.tail;
  const h = all.get(boneId)!.head;
  const parent = rig.bones.find((b) => b.id === bone.parent);
  return Math.hypot(a[0] - h[0], a[1] - h[1], a[2] - h[2]) > Math.max(1e-3, (parent?.rest.length ?? 1) * 1e-3);
}

function isDescendant(rig: Rig, id: string, of: string): boolean {
  const byId = new Map(rig.bones.map((b) => [b.id, b]));
  const seen = new Set<string>();
  for (let at = byId.get(id)?.parent ?? null; at && !seen.has(at); at = byId.get(at)?.parent ?? null) {
    if (at === of) return true;
    seen.add(at);
  }
  return false;
}

/**
 * Remove bones. Their children go to the removed bone's parent, keeping their
 * place; everything that named them lets go — their keys and modulators, IK
 * that reached for them, members riding them, paint for them.
 */
export function removeBones(doc: MotionDocument, groupId: string, boneIds: string[]): boolean {
  const r = rigOf(doc, groupId);
  if (!r) return false;
  const gone = new Set(boneIds);
  const planar = rigIsPlanar(doc, r.group);
  for (const id of boneIds) {
    const bone = r.rig.bones.find((b) => b.id === id);
    if (!bone) continue;
    let up = bone.parent;
    while (up && gone.has(up)) up = r.rig.bones.find((b) => b.id === up)?.parent ?? null;
    const place = bonesInRig(r.rig, planar);
    for (const k of r.rig.bones.filter((b) => b.parent === id)) {
      const keep = place.get(k.id)!;
      k.parent = up;
      k.rest = restFrom(up ? restFrames(r.rig, planar).get(up)! : null, keep, planar);
    }
  }
  r.rig.bones = r.rig.bones.filter((b) => !gone.has(b.id));
  for (const b of r.rig.bones) {
    if (b.ik && (gone.has(b.ik.target) || (b.ik.pole && gone.has(b.ik.pole)))) b.ik = gone.has(b.ik.target) ? null : { ...b.ik, pole: null };
    if (b.constraints?.some((c) => c.target.kind === "bone" && gone.has(c.target.bone))) {
      const left = b.constraints.filter((c) => !(c.target.kind === "bone" && gone.has(c.target.bone)));
      dropConstraintChannels(r.group, b.id, b.constraints.filter((c) => !left.includes(c)).map((c) => c.id));
      b.constraints = left.length ? left : undefined;
    }
  }
  const named = (p: string) => {
    const m = BONE_PATH.exec(p);
    return !!m && gone.has(m[1]!);
  };
  r.group.keyframes = r.group.keyframes.filter((t) => !named(t.property));
  if (r.group.modulators) r.group.modulators = r.group.modulators.filter((m) => !named(m.target));
  if (r.group.drivers) for (const p of Object.keys(r.group.drivers)) if (named(p)) delete r.group.drivers[p];
  for (const t of doc.tracks) {
    for (const c of t.clips) {
      if (c.kind === "audio" || !c.bind) continue;
      if (c.bind.bone && gone.has(c.bind.bone)) c.bind.bone = null;
      if (c.bind.paint.some((s) => gone.has(s.bone))) c.bind.paint = c.bind.paint.filter((s) => !gone.has(s.bone));
    }
  }
  return true;
}

// ── Binding ──────────────────────────────────────────────────────────────────

/** Change how a member follows its rig (absent fields keep theirs). Back to all defaults removes `bind`. */
export function setBind(doc: MotionDocument, clipId: string, patch: Partial<Bind>): boolean {
  const c = locateClip(doc, clipId)?.clip;
  if (!c || c.kind === "audio") return false;
  const next = bindSchema.parse({ ...(c.bind ?? {}), ...patch });
  (c as VisualClip).bind = next.mode === "auto" && !next.bone && next.paint.length === 0 ? undefined : next;
  return true;
}

/** One stroke of the weight brush, kept (replayed over the automatic weights). */
export function addWeightStroke(doc: MotionDocument, clipId: string, stroke: WeightStroke): boolean {
  const c = locateClip(doc, clipId)?.clip;
  if (!c || c.kind === "audio" || stroke.points.length < 4) return false;
  const bind = bindSchema.parse(c.bind ?? {});
  // Painting makes no sense on a member that rides one bone: it bends from now on.
  if (bind.mode === "auto" || bind.mode === "rigid") bind.mode = "smooth";
  bind.paint = [...bind.paint, stroke];
  (c as VisualClip).bind = bind;
  return true;
}

/** Wipe painted weights — one bone's, or all — back to automatic. */
export function clearWeightPaint(doc: MotionDocument, clipId: string, boneId?: string): boolean {
  const c = locateClip(doc, clipId)?.clip;
  if (!c || c.kind === "audio" || !c.bind) return false;
  return setBind(doc, clipId, { paint: boneId ? c.bind.paint.filter((s) => s.bone !== boneId) : [] });
}

// ── Posing ───────────────────────────────────────────────────────────────────

/**
 * Pose bones — channel values written the way every animatable write is
 * (`writeChannel`): a key where the channel is keyed (or `key`), the resting
 * value otherwise. `atMs` is the GROUP's local time.
 */
export function poseBones(
  doc: MotionDocument,
  groupId: string,
  poses: Array<{ bone: string; values: Partial<Record<BoneChannel, number>> }>,
  atMs: number,
  opts: { key?: boolean } = {},
): boolean {
  const r = rigOf(doc, groupId);
  if (!r) return false;
  for (const { bone, values } of poses) {
    const b = r.rig.bones.find((x) => x.id === bone);
    if (!b) continue;
    for (const [ch, v] of Object.entries(values)) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      // Written inside the limits, so a key never holds a value the bone cannot take.
      writeChannel(r.group, `bone.${bone}.${ch}`, atMs, limitChannel(b, ch as BoneChannel, v), { forceKey: opts.key });
    }
  }
  return true;
}

// ── Constraints ──────────────────────────────────────────────────────────────

/** A constraint as written by a person or an agent (`radius` only means something on a look). */
export interface ConstraintSpec {
  type: BoneConstraint["type"];
  target: BoneTarget;
  enabled?: boolean;
  influence?: number;
  radius?: number | null;
}

/** A target that names a bone of this rig other than `boneId` (null otherwise: a constraint on nothing is not kept). */
function validTarget(rig: Rig, boneId: string, t: BoneTarget): BoneTarget | null {
  if (t.kind === "point") return Number.isFinite(t.x) && Number.isFinite(t.y) ? t : null;
  return t.bone !== boneId && rig.bones.some((b) => b.id === t.bone) ? t : null;
}

/** Add a look / track constraint to a bone (end of its list). Returns its id. */
export function addConstraint(doc: MotionDocument, groupId: string, boneId: string, spec: ConstraintSpec): string | null {
  const r = rigOf(doc, groupId);
  const bone = r?.rig.bones.find((b) => b.id === boneId);
  if (!r || !bone) return null;
  const target = validTarget(r.rig, boneId, spec.target);
  if (!target) return null;
  const c = boneConstraintSchema.parse({ ...spec, target, id: createId("con") });
  bone.constraints = [...(bone.constraints ?? []), c];
  return c.id;
}

/** Change a constraint (absent fields keep theirs; the type is fixed — remove and add to change it). */
export function updateConstraint(doc: MotionDocument, groupId: string, boneId: string, id: string, patch: Omit<Partial<ConstraintSpec>, "type">): boolean {
  const r = rigOf(doc, groupId);
  const bone = r?.rig.bones.find((b) => b.id === boneId);
  const at = bone?.constraints?.findIndex((c) => c.id === id) ?? -1;
  if (!r || !bone || at < 0) return false;
  const was = bone.constraints![at]!;
  const target = patch.target ? validTarget(r.rig, boneId, patch.target) : was.target;
  if (!target) return false;
  const given = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  bone.constraints![at] = boneConstraintSchema.parse({ ...was, ...given, target, id: was.id, type: was.type });
  return true;
}

/** Remove constraints from a bone, and the keys, drivers and modulators on their influence. */
export function removeConstraints(doc: MotionDocument, groupId: string, boneId: string, ids: string[]): boolean {
  const r = rigOf(doc, groupId);
  const bone = r?.rig.bones.find((b) => b.id === boneId);
  if (!r || !bone?.constraints) return false;
  const left = bone.constraints.filter((c) => !ids.includes(c.id));
  bone.constraints = left.length ? left : undefined;
  dropConstraintChannels(r.group, boneId, ids);
  return true;
}

function dropConstraintChannels(group: GroupClip, boneId: string, ids: string[]): void {
  if (!ids.length) return;
  const paths = new Set(ids.map((id) => `bone.${boneId}.con.${id}`));
  group.keyframes = group.keyframes.filter((t) => !paths.has(t.property));
  if (group.modulators) group.modulators = group.modulators.filter((m) => !paths.has(m.target));
  if (group.drivers) for (const p of paths) delete group.drivers[p];
}

/** Back to rest: every pose value cleared (keys, which override, are left to the caller). */
export function resetPose(doc: MotionDocument, groupId: string, boneIds?: string[]): boolean {
  const r = rigOf(doc, groupId);
  if (!r) return false;
  for (const b of r.rig.bones) if (!boneIds || boneIds.includes(b.id)) b.pose = undefined;
  return true;
}

