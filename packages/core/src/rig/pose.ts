import type { Bone, BoneConstraint, BonePose, GroupClip, KeyframeValue, Rig } from "../schema";
import { sampleKeyframes } from "../animation/keyframes";
import { applyModulators } from "../animation/modulators";
import { solveIk } from "../world/ik";
import {
  cross,
  dot,
  eulerFromRotation,
  identity4,
  invert4,
  isIdentity4,
  length3,
  matPosition,
  mul4,
  normalize3,
  rotation4,
  scale3,
  scale4,
  sub,
  transformPoint,
  translate4,
  type Mat4,
  type V3,
} from "../world/math";
import { BONE_PATH, setBoneChannel } from "./fields";

/**
 * A RIG'S POSE AT AN INSTANT — `(rig, sampled channels) → every bone's frame`.
 *
 * One evaluator for a flat comp and a world. A flat comp's rig is PLANAR: its
 * bones lie in the comp's plane and turn about the line of sight, so depth and
 * the two 3D angles are not read — the same data, one dimension resting
 * (ADR-3d, "The transform").
 *
 * The order is Blender's: forward kinematics from rest + pose, then each IK
 * chain (in bone order), then every bone's SKIN matrix — `pose · rest⁻¹`, what
 * the bone does to whatever is bound to it. At rest every skin is the identity
 * exactly, so binding art never moves it.
 *
 * Pure and cheap (bones × a few matrix products, plus FABRIK for IK chains),
 * memoised on the baked rig's identity.
 */

export interface BoneState {
  id: string;
  bone: Bone;
  /** Parent bone id after validation (a dangling or cyclic parent reads as a root). */
  parent: string | null;
  /** The REST frame in rig space: origin at the head, +X toward the tail. Never scaled. */
  rest: Mat4;
  /** The POSED frame in rig space — scale included, IK applied. */
  pose: Mat4;
  /** `pose · rest⁻¹`: what this bone does to anything bound to it. */
  skin: Mat4;
  /** The rest head and tail, in rig space (what weights are measured from). */
  restHead: V3;
  restTail: V3;
  /** The posed head and tail, in rig space (what the canvas draws). */
  head: V3;
  tail: V3;
}

export interface RigPose {
  /** Bones, parents before children. */
  bones: BoneState[];
  byId: Map<string, BoneState>;
  /** Changes exactly when the rest changes — what automatic weights key on. */
  restKey: string;
  /** Changes exactly when any skin changes — what a deformed picture keys on. */
  poseKey: string;
  /** Every skin is the identity (the rig is at rest): bound art is untouched. */
  atRest: boolean;
  planar: boolean;
}

/** A bone's channels — the paths under `bone.<id>.`. */
export const BONE_CHANNELS = ["x", "y", "z", "rotation", "rotationY", "rotationX", "scale", "scaleY", "scaleZ", "ik"] as const;
export type BoneChannel = (typeof BONE_CHANNELS)[number];
/** The channels a PLANAR (flat-comp) bone reads. */
export const PLANAR_BONE_CHANNELS: ReadonlySet<BoneChannel> = new Set(["x", "y", "rotation", "scale", "scaleY", "ik"]);

// ── Order ────────────────────────────────────────────────────────────────────

/**
 * Bones parents-first, each with a validated parent: a parent that is missing,
 * is the bone itself, or closes a cycle makes the bone a ROOT (the relation
 * rule — a bad id is no relation, never a crash).
 */
export function orderBones(bones: readonly Bone[]): Array<{ bone: Bone; parent: string | null }> {
  const byId = new Map(bones.map((b) => [b.id, b]));
  // Depth-first up the parent links in list order: the link that reaches a
  // bone still being visited is the one that closes a cycle, and only it is cut.
  const parentOf = new Map<string, string | null>();
  const visiting = new Set<string>();
  const out: Array<{ bone: Bone; parent: string | null }> = [];
  const visit = (b: Bone): void => {
    if (parentOf.has(b.id)) return;
    visiting.add(b.id);
    let p = b.parent && b.parent !== b.id && byId.has(b.parent) ? b.parent : null;
    if (p && visiting.has(p)) p = null;
    else if (p) visit(byId.get(p)!);
    visiting.delete(b.id);
    parentOf.set(b.id, p);
    out.push({ bone: b, parent: p });
  };
  for (const b of bones) visit(b);
  return out;
}

// ── Frames ───────────────────────────────────────────────────────────────────

function restLocal(b: Bone, planar: boolean): Mat4 {
  const r = b.rest;
  const pos: V3 = [r.x, r.y, planar ? 0 : (r.z ?? 0)];
  return mul4(translate4(pos), planar ? rotation4(0, 0, r.rotation) : rotation4(r.rotationX ?? 0, r.rotationY ?? 0, r.rotation));
}

/**
 * A channel value held inside the bone's LIMITS — the one clamp every reader
 * goes through (the evaluator below, a drag, an agent's pose), so nothing can
 * move a bone where its limits forbid. `scaleY` absent means "follows scale".
 */
export function limitChannel(b: Bone, ch: BoneChannel, v: number): number {
  const r = ch === "ik" ? undefined : b.limits?.[ch];
  if (!r) return v;
  const lo = Math.min(r[0], r[1]), hi = Math.max(r[0], r[1]);
  return v < lo ? lo : v > hi ? hi : v;
}

/** The bone's pose with every channel held inside its limits (the same object when nothing is limited). */
function limitedPose(b: Bone): BonePose | undefined {
  const p = b.pose;
  if (!b.limits) return p;
  const base: BonePose = p ?? { x: 0, y: 0, rotation: 0, scale: 1, scaleY: null };
  const sx = limitChannel(b, "scale", base.scale);
  const out: BonePose = {
    ...base,
    x: limitChannel(b, "x", base.x),
    y: limitChannel(b, "y", base.y),
    rotation: limitChannel(b, "rotation", base.rotation),
    scale: sx,
    scaleY: base.scaleY == null && !b.limits.scaleY ? null : limitChannel(b, "scaleY", base.scaleY ?? sx),
  };
  if (base.z !== undefined || b.limits.z) out.z = limitChannel(b, "z", base.z ?? 0);
  if (base.rotationX !== undefined || b.limits.rotationX) out.rotationX = limitChannel(b, "rotationX", base.rotationX ?? 0);
  if (base.rotationY !== undefined || b.limits.rotationY) out.rotationY = limitChannel(b, "rotationY", base.rotationY ?? 0);
  if (b.limits.scaleZ) out.scaleZ = limitChannel(b, "scaleZ", base.scaleZ ?? sx);
  return out;
}

const IDENTITY_POSE: BonePose = { x: 0, y: 0, rotation: 0, scale: 1, scaleY: null };

function poseLocal(b: Bone, planar: boolean, given?: BonePose): Mat4 {
  const r = b.rest;
  const p = given ?? limitedPose(b);
  if (!p) return restLocal(b, planar);
  const pos: V3 = [r.x + p.x, r.y + p.y, planar ? 0 : (r.z ?? 0) + (p.z ?? 0)];
  const restRot = planar ? rotation4(0, 0, r.rotation) : rotation4(r.rotationX ?? 0, r.rotationY ?? 0, r.rotation);
  const poseRot = planar ? rotation4(0, 0, p.rotation) : rotation4(p.rotationX ?? 0, p.rotationY ?? 0, p.rotation);
  const sx = p.scale;
  const sy = p.scaleY ?? p.scale;
  const sz = planar ? 1 : (p.scaleZ ?? p.scale);
  let m = mul4(translate4(pos), mul4(restRot, poseRot));
  if (sx !== 1 || sy !== 1 || sz !== 1) m = mul4(m, scale4([sx, sy, sz]));
  return m;
}

const tailOf = (frame: Mat4, length: number): V3 => transformPoint(frame, [length, 0, 0]);

// ── Evaluate ─────────────────────────────────────────────────────────────────

const memo = new WeakMap<Rig, { planar: RigPose | null; spatial: RigPose | null }>();

/**
 * Every bone's rest, pose and skin, for a rig whose pose fields already hold
 * the instant's values (`bakeRig`). Memoised on the rig's identity.
 */
export function evaluateRig(rig: Rig, opts: { planar: boolean }): RigPose {
  let slot = memo.get(rig);
  if (!slot) memo.set(rig, (slot = { planar: null, spatial: null }));
  const hit = opts.planar ? slot.planar : slot.spatial;
  if (hit) return hit;
  const out = computeRig(rig, opts.planar);
  if (opts.planar) slot.planar = out;
  else slot.spatial = out;
  return out;
}

function computeRig(rig: Rig, planar: boolean): RigPose {
  const ordered = orderBones(rig.bones);
  const bones: BoneState[] = [];
  const byId = new Map<string, BoneState>();
  for (const { bone, parent } of ordered) {
    const up = parent ? byId.get(parent) : undefined;
    const rest = up ? mul4(up.rest, restLocal(bone, planar)) : restLocal(bone, planar);
    const pose = up ? mul4(up.pose, poseLocal(bone, planar)) : poseLocal(bone, planar);
    const s: BoneState = {
      id: bone.id,
      bone,
      parent,
      rest,
      pose,
      skin: identity4(),
      restHead: matPosition(rest),
      restTail: tailOf(rest, bone.rest.length),
      head: matPosition(pose),
      tail: tailOf(pose, bone.rest.length),
    };
    bones.push(s);
    byId.set(bone.id, s);
  }

  for (const s of bones) if (s.bone.ik) solveBoneIk(s, bones, byId, planar);
  if (bones.some((s) => s.bone.constraints?.length)) applyConstraints(bones, byId, planar);

  let atRest = true;
  for (const s of bones) {
    s.skin = mul4(s.pose, invert4(s.rest));
    if (!isIdentity4(s.skin)) atRest = false;
    s.head = matPosition(s.pose);
    s.tail = tailOf(s.pose, s.bone.rest.length);
  }
  const round = (m: Mat4) => m.map((v) => (Math.abs(v) < 5e-7 ? "0" : v.toFixed(4))).join(",");
  return {
    bones,
    byId,
    restKey: (planar ? "2|" : "3|") + bones.map((s) => `${s.id}:${s.bone.deform ? 1 : 0}:${round(s.rest)}:${s.bone.rest.length}`).join(";"),
    poseKey: atRest ? "rest" : bones.map((s) => round(s.skin)).join(";"),
    atRest,
    planar,
  };
}

// ── IK ───────────────────────────────────────────────────────────────────────

function isUnder(byId: Map<string, BoneState>, id: string, ancestors: ReadonlySet<string>): boolean {
  for (let at: string | null = id; at; at = byId.get(at)?.parent ?? null) if (ancestors.has(at)) return true;
  return false;
}

/**
 * Turn `tip` and up to `chain − 1` of its parents so its TAIL reaches the
 * target bone's head (FABRIK — `world/ik.ts`, the solver Child Of chains use),
 * then carry every other bone hanging off a turned one by its turn.
 *
 * The mix blends the TARGET, not the matrices: at 0.5 the tail reaches halfway
 * between where the keys put it and the target, which moves the chain the
 * short way and never through a sheared in-between.
 */
function solveBoneIk(tip: BoneState, bones: BoneState[], byId: Map<string, BoneState>, planar: boolean): void {
  const ik = tip.bone.ik!;
  const mix = Math.max(0, Math.min(1, ik.mix));
  const target = byId.get(ik.target);
  if (!target || target.id === tip.id || mix <= 0) return;
  const chain: BoneState[] = [tip];
  for (let at = tip.parent; at && chain.length < ik.chain; at = byId.get(at)?.parent ?? null) chain.unshift(byId.get(at)!);
  const inChain = new Set(chain.map((s) => s.id));
  // A target (or pole) that hangs off the chain would move as the chain moves: no answer.
  if (isUnder(byId, target.id, inChain)) return;
  const poleBone = ik.pole ? byId.get(ik.pole) : undefined;
  const pole = poleBone && !isUnder(byId, poleBone.id, inChain) ? poleBone.head : null;

  const joints = [...chain.map((s) => s.pose), mul4(tip.pose, translate4([tip.bone.rest.length, 0, 0]))];
  const tipNow = matPosition(joints[joints.length - 1]!);
  const goal: V3 = mix >= 1 ? target.head : add3(tipNow, scale3(sub(target.head, tipNow), mix));

  // The side a straight chain folds to: the side it bends at REST (flipped on
  // request) — measured in the chain root's own frame so it turns with it.
  let hint: V3 | null = null;
  const restSide = restBendSide(chain);
  if (planar) {
    const along = sub(goal, matPosition(joints[0]!));
    const side = (restSide ?? 1) * (ik.flip ? -1 : 1);
    // A chain that turns clockwise on screen (y down) has its elbow on the
    // −90° side of the root→goal line.
    hint = [along[1] * side, -along[0] * side, 0];
  } else if (!pole && chain.length >= 2) {
    hint = restBendDirection(chain);
  }

  let solved = solveIk(joints, goal, pole, 32, 0.01, hint);
  // In a plane every turn is about the line of sight — rebuilt from the solved
  // POSITIONS, so a half turn can never flip a frame over (a 180° swing has no
  // unique axis, and the wrong one mirrors the art bound to it).
  if (planar) solved = planarChain(joints, solved.map(matPosition), chain.length >= 2 ? (restSide ?? 1) * (ik.flip ? -1 : 1) : 0);
  // A chain with rotation limits: the free solve seeds a limited one (held joints, best reach).
  if (chain.some((s) => rotationLimited(s.bone, planar))) {
    const up = chain[0]!.parent ? byId.get(chain[0]!.parent)!.pose : identity4();
    solved = [...limitedChain(chain, up, solved, goal, planar), solved[solved.length - 1]!];
    // The tip joint (the chain's end) is not a bone of its own: placed from the last bone.
    solved[chain.length] = mul4(solved[chain.length - 1]!, translate4([tip.bone.rest.length, 0, 0]));
  }

  // Each chain bone's turn, nearest the root first; everything else under a
  // turned bone takes the deepest turn above it.
  const turn = new Map<string, Mat4>();
  chain.forEach((s, k) => {
    turn.set(s.id, mul4(solved[k]!, invert4(s.pose)));
    s.pose = solved[k]!;
  });
  for (const s of bones) {
    if (inChain.has(s.id)) continue;
    let t: Mat4 | undefined;
    for (let at = s.parent; at && !t; at = byId.get(at)?.parent ?? null) t = turn.get(at);
    if (t) {
      s.pose = mul4(t, s.pose);
      turn.set(s.id, t);
    }
  }
}

const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/**
 * Which way the chain bends at rest in a plane: +1 clockwise on screen (y
 * down), −1 the other way, null when it is straight. The sign of the turn
 * from the first bone to the second, summed down the chain.
 */
function restBendSide(chain: BoneState[]): number | null {
  if (chain.length < 2) return null;
  let sum = 0;
  for (let i = 0; i + 1 < chain.length; i++) {
    const a = sub(chain[i]!.restTail, chain[i]!.restHead);
    const b = sub(chain[i + 1]!.restTail, chain[i + 1]!.restHead);
    sum += a[0] * b[1] - a[1] * b[0];
  }
  if (Math.abs(sum) < 1e-6) return null;
  return sum > 0 ? 1 : -1;
}

/** A world chain's rest bend, as a direction across it (null when straight). */
function restBendDirection(chain: BoneState[]): V3 | null {
  const root = chain[0]!.restHead;
  const end = chain[chain.length - 1]!.restTail;
  const line = sub(end, root);
  const len = length3(line);
  if (len < 1e-9) return null;
  const d = scale3(line, 1 / len);
  const mid = sub(chain[1]!.restHead, root);
  const across = sub(mid, scale3(d, dot(mid, d)));
  if (length3(across) < len * 1e-4) return null;
  // Carried into where the root is now, so a turned shoulder bends its arm the same way.
  const now = mul4(chain[0]!.pose, invert4(chain[0]!.rest));
  const v = transformPoint(now, add3(root, across));
  return normalize3(sub(v, transformPoint(now, root)));
}

/**
 * A flat chain's frames from its solved joint positions: each bone turns
 * about the line of sight onto its new direction, root first, carrying the
 * rest. And it must not pop to the other side as its target crosses the line:
 * if the bend points the wrong way (`side`: +1 clockwise on screen), the
 * middle joints are mirrored across the root→tip line first — a mirror keeps
 * every length and the reach.
 */
function planarChain(joints: Mat4[], solved: V3[], side: number): Mat4[] {
  const n = joints.length;
  const pts = solved.slice();
  const root = pts[0]!, end = pts[n - 1]!;
  const line = sub(end, root);
  const len = Math.hypot(line[0], line[1]);
  if (side !== 0 && n >= 3 && len > 1e-9) {
    // The turn from the first bone to the second — the same measure as `restBendSide`.
    const a = sub(pts[1]!, root), b = sub(pts[2]!, pts[1]!);
    const now = a[0] * b[1] - a[1] * b[0];
    if (Math.abs(now) > 1e-9 && Math.sign(now) !== Math.sign(side)) {
      const ux = line[0] / len, uy = line[1] / len;
      for (let i = 1; i < n - 1; i++) {
        const d = sub(pts[i]!, root);
        const along = d[0] * ux + d[1] * uy;
        pts[i] = [root[0] + 2 * along * ux - d[0], root[1] + 2 * along * uy - d[1], pts[i]![2]];
      }
    }
  }
  const out = joints.slice();
  for (let i = 0; i < n - 1; i++) {
    const at = matPosition(out[i]!);
    const turn = planarTurn(sub(matPosition(out[i + 1]!), at), sub(pts[i + 1]!, at));
    if (!turn) continue;
    const pivot = mul4(mul4(translate4(at), turn), translate4(scale3(at, -1)));
    for (let k = i; k < n; k++) out[k] = mul4(pivot, out[k]!);
  }
  return out;
}

function planarTurn(a: V3, b: V3): Mat4 | null {
  const la = Math.hypot(a[0], a[1]), lb = Math.hypot(b[0], b[1]);
  if (la < 1e-12 || lb < 1e-12) return null;
  const ang = Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]);
  if (Math.abs(ang) < 1e-12) return null;
  return rotation4(0, 0, (ang * 180) / Math.PI);
}

// ── Channels from frames, and back ───────────────────────────────────────────

const DEG = 180 / Math.PI;
/** The same turn, the short way round: −180 … 180. */
const shortestDeg = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
/** `v` moved by whole turns to sit nearest `ref` (a channel keeps its winding). */
const unwrap = (ref: number, v: number) => ref + shortestDeg(v - ref);

/** A frame's linear part (no translation). */
const linearOf = (m: Mat4): Mat4 => [m[0]!, m[1]!, m[2]!, 0, m[4]!, m[5]!, m[6]!, 0, m[8]!, m[9]!, m[10]!, 0, 0, 0, 0, 1];
/** A direction carried by a frame's linear part. */
const dirBy = (m: Mat4, d: V3): V3 => [m[0]! * d[0] + m[4]! * d[1] + m[8]! * d[2], m[1]! * d[0] + m[5]! * d[1] + m[9]! * d[2], m[2]! * d[0] + m[6]! * d[1] + m[10]! * d[2]];

/** The rotation part of a frame — each column's scale divided out. */
function rotationPart(m: Mat4): Mat4 {
  const c = (i: number): V3 => normalize3([m[i * 4]!, m[i * 4 + 1]!, m[i * 4 + 2]!]);
  const [x, y, z] = [c(0), c(1), c(2)];
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, 0, 0, 0, 1];
}

/** The turn about unit-free `axis` by `deg` (Rodrigues). */
function turnAbout(axis: V3, deg: number): Mat4 {
  const [x, y, z] = normalize3(axis);
  const a = deg / DEG, c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  return [t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0, t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0, t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0, 0, 0, 0, 1];
}

/**
 * Turn a bone's working pose so that, under `parent` (posed, rig space), its
 * +X goes from rig direction `from` toward `to` — by `k` of the way — and
 * hold the result inside its rotation limits. Planar: one angle measured in
 * the parent's own frame (mirrors and stretch included). Spatial: the short
 * arc conjugated into the bone's rest frame, read back as its Euler channels.
 */
function turnPose(b: Bone, p: BonePose, parent: Mat4, from: V3, to: V3, k: number, planar: boolean): BonePose {
  if (planar) {
    const inv = invert4(linearOf(parent));
    const a = dirBy(inv, from), w = dirBy(inv, to);
    if (Math.hypot(a[0], a[1]) < 1e-12 || Math.hypot(w[0], w[1]) < 1e-12) return p;
    const d = shortestDeg((Math.atan2(w[1], w[0]) - Math.atan2(a[1], a[0])) * DEG);
    return { ...p, rotation: limitChannel(b, "rotation", p.rotation + d * k) };
  }
  const axis = cross(from, to);
  const sin = length3(axis), cos = dot(from, to);
  if (sin < 1e-12 * Math.max(1e-12, length3(from) * length3(to))) return p;
  const turn = turnAbout(axis, Math.atan2(sin, cos) * DEG * k);
  const r = b.rest;
  const frame = mul4(rotationPart(parent), rotation4(r.rotationX ?? 0, r.rotationY ?? 0, r.rotation));
  const now = rotation4(p.rotationX ?? 0, p.rotationY ?? 0, p.rotation);
  const [rx, ry, rz] = eulerFromRotation(mul4(mul4(invert4(frame), mul4(turn, frame)), now));
  return {
    ...p,
    rotation: limitChannel(b, "rotation", unwrap(p.rotation, rz)),
    rotationY: limitChannel(b, "rotationY", unwrap(p.rotationY ?? 0, ry)),
    rotationX: limitChannel(b, "rotationX", unwrap(p.rotationX ?? 0, rx)),
  };
}

function rotationLimited(b: Bone, planar: boolean): boolean {
  const l = b.limits;
  return !!l && (!!l.rotation || (!planar && (!!l.rotationX || !!l.rotationY)));
}

// ── IK with limits ───────────────────────────────────────────────────────────

/**
 * A chain whose joints have ROTATION LIMITS (a knee that never bends back):
 * the free FABRIK solve is read back as each bone's channels and held inside
 * its limits, then cyclic-coordinate passes (tip bone first) turn each bone,
 * still inside its limits, to bring the tip nearer the goal. Out of reach or
 * against a stop, the chain settles at its best reach. A pure function of the
 * frame's inputs — the same seed and passes every time — so a target that
 * moves smoothly moves the chain smoothly: nothing carries over between
 * frames to jitter. Returns the chain's frames.
 */
function limitedChain(chain: BoneState[], up: Mat4, solved: Mat4[], goal: V3, planar: boolean): Mat4[] {
  const n = chain.length;
  const ch: BonePose[] = chain.map((s) => ({ ...(limitedPose(s.bone) ?? IDENTITY_POSE) }));
  const fk = (): Mat4[] => {
    const out: Mat4[] = [];
    let at = up;
    for (let i = 0; i < n; i++) out.push((at = mul4(at, poseLocal(chain[i]!.bone, planar, ch[i]!))));
    return out;
  };
  // Seed: the free solve's turns, read as channels and held.
  let at = up;
  for (let i = 0; i < n; i++) {
    const b = chain[i]!.bone;
    const local = mul4(invert4(at), solved[i]!);
    const p = ch[i]!;
    if (planar) {
      const flip = p.scale < 0 ? 180 : 0;
      p.rotation = limitChannel(b, "rotation", unwrap(p.rotation, Math.atan2(local[1]!, local[0]!) * DEG - b.rest.rotation - flip));
    } else {
      const r = b.rest;
      const rot = mul4(invert4(rotation4(r.rotationX ?? 0, r.rotationY ?? 0, r.rotation)), rotationPart(local));
      const [rx, ry, rz] = eulerFromRotation(rot);
      p.rotation = limitChannel(b, "rotation", unwrap(p.rotation, rz));
      p.rotationY = limitChannel(b, "rotationY", unwrap(p.rotationY ?? 0, ry));
      p.rotationX = limitChannel(b, "rotationX", unwrap(p.rotationX ?? 0, rx));
    }
    at = mul4(at, poseLocal(b, planar, p));
  }
  const len = chain[n - 1]!.bone.rest.length;
  const tol = 1e-3;
  for (let pass = 0; pass < 24; pass++) {
    let moved = 0;
    for (let i = n - 1; i >= 0; i--) {
      const frames = fk();
      const tipAt = transformPoint(frames[n - 1]!, [len, 0, 0]);
      if (length3(sub(tipAt, goal)) < tol) return frames;
      const head = matPosition(frames[i]!);
      const was = ch[i]!;
      const next = turnPose(chain[i]!.bone, was, i ? frames[i - 1]! : up, sub(tipAt, head), sub(goal, head), 1, planar);
      moved += Math.abs(next.rotation - was.rotation) + Math.abs((next.rotationY ?? 0) - (was.rotationY ?? 0)) + Math.abs((next.rotationX ?? 0) - (was.rotationX ?? 0));
      ch[i] = next;
    }
    if (moved < 1e-6) break;
  }
  return fk();
}

// ── Constraints ──────────────────────────────────────────────────────────────

/**
 * LOOK and TRACK constraints (`schema/rig.ts`), after IK, parents first: a
 * constrained bone's new frame is rebuilt from its own channels (so its
 * limits hold), and whatever hangs off it is carried by the same change — a
 * tracked head carries its eyes, and the pupils then look from where the
 * eyes are.
 */
function applyConstraints(bones: BoneState[], byId: Map<string, BoneState>, planar: boolean): void {
  const carried = new Map<string, Mat4>();
  const done = new Set<string>();
  /** A bone's frame as it stands now — carried by a constrained ancestor even if it is not reached yet. */
  const frameNow = (s: BoneState): Mat4 => {
    if (done.has(s.id)) return s.pose;
    for (let at = s.parent; at; at = byId.get(at)?.parent ?? null) {
      const c = carried.get(at);
      if (c) return mul4(c, s.pose);
      if (done.has(at)) break;
    }
    return s.pose;
  };
  for (const s of bones) {
    const before = s.pose;
    const c = s.parent ? carried.get(s.parent) : undefined;
    if (c) s.pose = mul4(c, s.pose);
    const live = s.bone.constraints?.filter((x) => x.enabled && x.influence > 0);
    if (live?.length) constrain(s, live, byId, frameNow, planar);
    done.add(s.id);
    if (s.pose !== before) carried.set(s.id, mul4(s.pose, invert4(before)));
  }
}

function constrain(s: BoneState, list: BoneConstraint[], byId: Map<string, BoneState>, frameNow: (s: BoneState) => Mat4, planar: boolean): void {
  const b = s.bone;
  const parent = s.parent ? byId.get(s.parent)!.pose : identity4();
  let p: BonePose = { ...(limitedPose(b) ?? IDENTITY_POSE) };
  let changed = false;
  for (const c of list) {
    const target = targetPoint(c.target, s, byId, frameNow, planar);
    if (!target) continue;
    const k = Math.max(0, Math.min(1, c.influence));
    const frame = mul4(parent, poseLocal(b, planar, p));
    const head = matPosition(frame);
    if (c.type === "track") {
      const along = dirBy(frame, [1, 0, 0]);
      const want = sub(target, head);
      if (planar) want[2] = 0;
      if (length3(want) < 1e-9) continue;
      p = turnPose(b, p, parent, along, want, k, planar);
    } else {
      p = lookPose(b, p, parent, sub(target, head), c.radius, k, planar);
    }
    changed = true;
  }
  if (changed) s.pose = mul4(parent, poseLocal(b, planar, p));
}

/** Where a constraint's target is now, rig space — null for none (gone, itself, or something hanging off it). */
function targetPoint(t: BoneConstraint["target"], s: BoneState, byId: Map<string, BoneState>, frameNow: (s: BoneState) => Mat4, planar: boolean): V3 | null {
  if (t.kind === "point") return [t.x, t.y, planar ? 0 : (t.z ?? 0)];
  const o = byId.get(t.bone);
  if (!o || o.id === s.id || isUnder(byId, o.id, new Set([s.id]))) return null;
  return matPosition(frameNow(o));
}

/**
 * LOOK: the head slides toward the target — `offset` (rig space) carried into
 * the parent's frame where its x/y(/z) live, at most `radius` from where its
 * keys put it, then held inside the ELLIPSE its pad limits draw (a box's
 * corners are outside a round eye): a locked axis stays put, a free one is
 * unbounded. A target on the head is no offset.
 */
function lookPose(b: Bone, p: BonePose, parent: Mat4, offset: V3, radius: number | null, k: number, planar: boolean): BonePose {
  const o = dirBy(invert4(linearOf(parent)), offset);
  if (planar) o[2] = 0;
  const len = length3(o);
  if (radius !== null && len > radius) {
    const f = len > 1e-12 ? radius / len : 0;
    o[0] *= f, o[1] *= f, o[2] *= f;
  }
  const axes = planar ? (["x", "y"] as const) : (["x", "y", "z"] as const);
  const cur = [p.x, p.y, p.z ?? 0];
  const q = cur.map((v, i) => v + o[i]!);
  const ell: Array<{ i: number; c: number; a: number }> = [];
  axes.forEach((ax, i) => {
    const r = b.limits?.[ax];
    if (!r) return;
    const lo = Math.min(r[0], r[1]), hi = Math.max(r[0], r[1]);
    if (hi - lo < 1e-12) q[i] = lo;
    else ell.push({ i, c: (lo + hi) / 2, a: (hi - lo) / 2 });
  });
  const reach = Math.sqrt(ell.reduce((sum, e) => sum + ((q[e.i]! - e.c) / e.a) ** 2, 0));
  if (reach > 1) for (const e of ell) q[e.i] = e.c + (q[e.i]! - e.c) / reach;
  const mix = (i: number) => cur[i]! + (q[i]! - cur[i]!) * k;
  return planar ? { ...p, x: mix(0), y: mix(1) } : { ...p, x: mix(0), y: mix(1), z: mix(2) };
}

/**
 * A rig with every bone a simulation moves let go of the solvers that would
 * fight it: IK on a chain holding one, and that bone's own constraints. The
 * one rule both physics write-backs (flat and world) read.
 */
export function letGoForBodies(rig: Rig, dynamic: ReadonlySet<string>): Rig {
  const byId = new Map(rig.bones.map((b) => [b.id, b]));
  return {
    ...rig,
    bones: rig.bones.map((b) => {
      let ik = b.ik ? { ...b.ik } : null;
      if (ik) for (let at: string | null = b.id, n = 0; at && n < ik.chain; n++, at = byId.get(at)?.parent ?? null) if (dynamic.has(at)) ik = { ...ik, mix: 0 };
      const constraints = b.constraints?.map((c) => (dynamic.has(b.id) ? { ...c, enabled: false } : { ...c }));
      return { ...b, pose: b.pose ? { ...b.pose } : undefined, ik, ...(constraints && { constraints }) };
    }),
  };
}

// ── Sampling ─────────────────────────────────────────────────────────────────

/** Does this group's rig move on its own (keys or modulators on a bone channel)? */
export function rigAnimates(group: GroupClip): boolean {
  if (!group.rig) return false;
  return group.keyframes.some((t) => !t.range && t.property.startsWith("bone.")) || !!group.modulators?.some((m) => m.enabled && m.target.startsWith("bone."));
}

const baked = new WeakMap<GroupClip, Map<number, Rig>>();

/**
 * The rig with this instant's channel values written into its bones (the
 * `bakeClipAt` rule, for bones only — resolve once, then nothing downstream
 * needs to know a key exists). A still rig comes back by reference, so the
 * pose memo survives a still scene.
 */
export function bakeRig(group: GroupClip, localMs: number): Rig | null {
  const rig = group.rig;
  if (!rig) return null;
  if (!rigAnimates(group)) return rig;
  let byTime = baked.get(group);
  if (!byTime) baked.set(group, (byTime = new Map()));
  const hit = byTime.get(localMs);
  if (hit) return hit;
  const tracks = group.keyframes.filter((t) => !t.range && BONE_PATH.test(t.property));
  const sampled: Record<string, KeyframeValue> = tracks.length ? sampleKeyframes(tracks, localMs) : {};
  const out: Rig = { ...rig, bones: rig.bones.map((b) => ({ ...b, pose: b.pose ? { ...b.pose } : undefined, ik: b.ik ? { ...b.ik } : null, ...(b.constraints && { constraints: b.constraints.map((c) => ({ ...c })) }) })) };
  for (const [path, v] of Object.entries(sampled)) setBoneChannel(out, path, v);
  for (const m of group.modulators ?? []) {
    if (!m.enabled || !BONE_PATH.test(m.target)) continue;
    const base = sampled[m.target] ?? boneChannelOf(out, m.target);
    if (typeof base !== "number") continue;
    setBoneChannel(out, m.target, applyModulators(group.modulators, m.target, base, localMs / 1000, sampled));
  }
  if (byTime.size > 32) byTime.delete(byTime.keys().next().value!);
  byTime.set(localMs, out);
  return out;
}

function boneChannelOf(rig: Rig, path: string): number | undefined {
  const m = BONE_PATH.exec(path);
  if (!m) return undefined;
  const b = rig.bones.find((x) => x.id === m[1]);
  if (!b) return undefined;
  if (m[2]!.startsWith("con.")) return b.constraints?.find((c) => `con.${c.id}` === m[2])?.influence;
  return readPose(b, m[2] as BoneChannel);
}

/** A bone's channel value — its pose delta (identity when it has none), or its IK mix. */
export function readPose(b: Bone, ch: BoneChannel): number | undefined {
  if (ch === "ik") return b.ik ? b.ik.mix : undefined;
  const p: Partial<BonePose> = b.pose ?? {};
  switch (ch) {
    case "x": return p.x ?? 0;
    case "y": return p.y ?? 0;
    case "z": return p.z ?? 0;
    case "rotation": return p.rotation ?? 0;
    case "rotationX": return p.rotationX ?? 0;
    case "rotationY": return p.rotationY ?? 0;
    case "scale": return p.scale ?? 1;
    case "scaleY": return p.scaleY ?? p.scale ?? 1;
    case "scaleZ": return p.scaleZ ?? p.scale ?? 1;
  }
}

/** The group's rig pose at its own local time — what every surface draws and binds by. */
export function rigPoseAt(group: GroupClip, localMs: number, planar: boolean): RigPose | null {
  const rig = bakeRig(group, localMs);
  return rig && rig.bones.length ? evaluateRig(rig, { planar }) : null;
}

// ── Small helpers other modules share ────────────────────────────────────────

/** The axis-angle-free distance from a point to a bone's rest segment. */
export function distToSegment(p: V3, a: V3, b: V3): number {
  const ab = sub(b, a), ap = sub(p, a);
  const len = dot(ab, ab);
  const t = len > 1e-12 ? Math.max(0, Math.min(1, dot(ap, ab) / len)) : 0;
  return Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
}

