import type { Rig } from "../schema";
import { solveIk } from "../world/ik";
import { cross, dot, eulerFromRotation, invert4, length3, matPosition, mul4, normalize3, rotation4, translate4, type Mat4, type V3 } from "../world/math";
import { evaluateRig, readPose, type BoneState, type RigPose } from "./pose";

/**
 * POSE GESTURES → CHANNEL VALUES, for a flat comp's rig.
 *
 * A gesture happens in the RIG's space (where the pointer is: "turn this bone
 * by 30°", "move it by (10, −4)", "put its tip here"). Channels are written in
 * each bone's own frame, as a delta from rest. These turn the one into the
 * other, once, for the canvas, the keyboard (G/R/S) and agents alike — and
 * get mirrors right: under a mirrored parent, a turn on screen is the other
 * way round in the bone's frame.
 *
 * Every function takes the rig as it is NOW (baked at the instant) and returns
 * absolute channel values to write.
 */

const deg = (r: number) => (r * 180) / Math.PI;

/** Is this frame mirrored (its linear part flips orientation)? */
function mirrored(m: Mat4): boolean {
  return m[0]! * m[5]! - m[1]! * m[4]! < 0;
}

/** The frame a bone's channels are written in: its parent's posed frame (or the rig's). */
function parentFrame(pose: RigPose, s: BoneState): Mat4 | null {
  return s.parent ? pose.byId.get(s.parent)!.pose : null;
}

/** The bone's angle on screen (rig space), degrees. */
export function worldAngle(s: BoneState): number {
  return deg(Math.atan2(s.tail[1] - s.head[1], s.tail[0] - s.head[0]));
}

/** TURN a bone about its head by `delta` degrees as seen in rig space. */
export function turnChannel(pose: RigPose, boneId: string, delta: number): number {
  const s = pose.byId.get(boneId)!;
  const p = parentFrame(pose, s);
  const sign = (p && mirrored(p) ? -1 : 1) * (mirroredOwn(s) ? -1 : 1);
  return (readPose(s.bone, "rotation") ?? 0) + delta * sign;
}

/** A bone whose own pose scale is negative turns the other way in its frame. */
function mirroredOwn(s: BoneState): boolean {
  const p = s.bone.pose;
  return !!p && p.scale * (p.scaleY ?? p.scale) < 0;
}

/** MOVE a bone's head by `delta` in rig space → its x/y (in its parent's frame). */
export function moveChannels(pose: RigPose, boneId: string, delta: V3): { x: number; y: number } {
  const s = pose.byId.get(boneId)!;
  const p = parentFrame(pose, s);
  let d: V3 = delta;
  if (p) {
    // A direction (not a point) into the parent's frame: its linear part only.
    const inv = invert4([p[0]!, p[1]!, p[2]!, 0, p[4]!, p[5]!, p[6]!, 0, p[8]!, p[9]!, p[10]!, 0, 0, 0, 0, 1]);
    d = [inv[0]! * delta[0] + inv[4]! * delta[1], inv[1]! * delta[0] + inv[5]! * delta[1], 0];
  }
  return { x: (readPose(s.bone, "x") ?? 0) + d[0], y: (readPose(s.bone, "y") ?? 0) + d[1] };
}

/** STRETCH a bone by `factor` along it (`axis: "x"`), across it (`"y"`), or both. */
export function stretchChannels(pose: RigPose, boneId: string, factor: number, axis: "x" | "y" | "both" = "x"): { scale?: number; scaleY?: number } {
  const b = pose.byId.get(boneId)!.bone;
  const sx = readPose(b, "scale") ?? 1;
  const sy = readPose(b, "scaleY") ?? sx;
  if (axis === "x") return { scale: sx * factor, scaleY: sy };
  if (axis === "y") return { scaleY: sy * factor };
  return { scale: sx * factor, scaleY: sy * factor };
}

/**
 * REACH — put a bone's TIP at `target` (rig space) by turning it and up to
 * `chain − 1` bones above it, keeping the side the chain bends to (dragging a
 * hand never flips the elbow). The rotations to write, root of the chain first.
 */
export function reachChannels(rig: Rig, boneId: string, target: V3, chain = 2): Array<{ bone: string; rotation: number }> {
  const pose = evaluateRig(rig, { planar: true });
  const tip = pose.byId.get(boneId);
  if (!tip) return [];
  const bones: BoneState[] = [tip];
  for (let at = tip.parent; at && bones.length < chain; at = pose.byId.get(at)?.parent ?? null) bones.unshift(pose.byId.get(at)!);
  if (bones.length === 1) {
    // One bone: turn it toward the target.
    const want = deg(Math.atan2(target[1] - tip.head[1], target[0] - tip.head[0]));
    return [{ bone: tip.id, rotation: turnChannel(pose, tip.id, shortest(want - worldAngle(tip))) }];
  }
  const joints = [...bones.map((b) => b.pose), mul4(tip.pose, translate4([tip.bone.rest.length, 0, 0]))];
  // The side it bends to now: the turn from the first bone to the second.
  const a = sub2(bones[1]!.head, bones[0]!.head), b = sub2(tip.tail, bones[1]!.head);
  const turn = a[0] * b[1] - a[1] * b[0];
  const along = sub2(target, bones[0]!.head);
  const side = turn === 0 ? 1 : Math.sign(turn);
  const hint: V3 = [along[1] * side, -along[0] * side, 0];
  const solved = solveIk(joints, [target[0], target[1], 0], null, 48, 0.01, hint).map(matPosition);
  // Keep the side: mirror the middle joints across root→end if the solve flipped it.
  const root = solved[0]!, end = solved[solved.length - 1]!;
  const s2 = sub2(solved[1]!, root), e2 = sub2(solved[2]!, solved[1]!);
  if (Math.sign(s2[0] * e2[1] - s2[1] * e2[0]) !== side && solved.length >= 3) {
    const l = sub2(end, root), len = Math.hypot(l[0], l[1]) || 1, ux = l[0] / len, uy = l[1] / len;
    for (let i = 1; i < solved.length - 1; i++) {
      const d = sub2(solved[i]!, root), k = d[0] * ux + d[1] * uy;
      solved[i] = [root[0] + 2 * k * ux - d[0], root[1] + 2 * k * uy - d[1], 0];
    }
  }
  const out: Array<{ bone: string; rotation: number }> = [];
  let carried = 0;
  bones.forEach((s, i) => {
    const want = deg(Math.atan2(solved[i + 1]![1] - solved[i]![1], solved[i + 1]![0] - solved[i]![0]));
    const now = worldAngle(s) + carried;
    const delta = shortest(want - now);
    carried += delta;
    out.push({ bone: s.id, rotation: turnChannel(pose, s.id, delta) });
  });
  return out;
}

/**
 * How many bones a reach from `boneId` may bend: up to `chain`, the grabbed
 * bone included, stopping BELOW a pinned bone (a pinned shoulder holds while
 * the hand pulls the forearm and upper arm) and below a BRANCH — a bone two
 * limbs hang from (hips, chest) is where a limb ends, so pulling a hand never
 * bends the spine. 0 when the grabbed bone is pinned.
 */
export function reachChainLength(rig: Rig, boneId: string, chain: number, pinned: ReadonlySet<string> = new Set()): number {
  if (pinned.has(boneId)) return 0;
  const byId = new Map(rig.bones.map((b) => [b.id, b]));
  const kids = new Map<string, number>();
  for (const b of rig.bones) if (b.parent && b.deform !== false) kids.set(b.parent, (kids.get(b.parent) ?? 0) + 1);
  let n = 1;
  for (let at = byId.get(boneId)?.parent ?? null; at && n < chain; at = byId.get(at)?.parent ?? null) {
    if (pinned.has(at) || (kids.get(at) ?? 0) > 1) break;
    n++;
  }
  return n;
}

const sub2 = (a: readonly number[], b: readonly number[]): [number, number] => [a[0]! - b[0]!, a[1]! - b[1]!];
/** The same turn, the short way round: −180 … 180. */
const shortest = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

// ── In a world: three angles, three axes ────────────────────────────────────

/** The rotation part of a frame's linear map — scale divided out of each column. */
function rotationOf(m: Mat4): Mat4 {
  const col = (i: number): V3 => normalize3([m[i * 4]!, m[i * 4 + 1]!, m[i * 4 + 2]!]);
  const [x, y, z] = [col(0), col(1), col(2)];
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, 0, 0, 0, 1];
}

/** The rotation about `axis` (any length) by `deg`, as a 4×4 (Rodrigues). */
export function axisRotation(axis: V3, deg: number): Mat4 {
  const [x, y, z] = normalize3(axis);
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  return [t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0, t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0, t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0, 0, 0, 0, 1];
}

/** The turn carrying direction `a` onto direction `b` (both rig space), or null when they already agree. */
export function turnBetween(a: V3, b: V3): Mat4 | null {
  const la = length3(a), lb = length3(b);
  if (la < 1e-9 || lb < 1e-9) return null;
  const axis = cross(a, b);
  const sin = length3(axis) / (la * lb), cos = dot(a, b) / (la * lb);
  if (sin < 1e-9) return null;
  return axisRotation(axis, (Math.atan2(sin, cos) * 180) / Math.PI);
}

/**
 * TURN a world bone about its head by `turn` (a rotation in RIG space — "about
 * the line of sight", "about Z") → its three angle channels. The turn is
 * carried into the frame the channels are written in (parent's posed frame,
 * then the bone's rest), so the bone ends up exactly turned on screen, with
 * the result read back as the evaluator's own Euler order.
 */
export function rotateChannels3d(pose: RigPose, boneId: string, turn: Mat4): { rotation: number; rotationY: number; rotationX: number } {
  const s = pose.byId.get(boneId)!;
  const p = parentFrame(pose, s);
  const r = s.bone.rest;
  const frame = mul4(p ? rotationOf(p) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], rotation4(r.rotationX ?? 0, r.rotationY ?? 0, r.rotation));
  const now = rotation4(readPose(s.bone, "rotationX") ?? 0, readPose(s.bone, "rotationY") ?? 0, readPose(s.bone, "rotation") ?? 0);
  const next = mul4(mul4(invert4(frame), mul4(turn, frame)), now);
  const [rx, ry, rz] = eulerFromRotation(next);
  return { rotation: rz, rotationY: ry, rotationX: rx };
}

/** MOVE a world bone's head by `delta` (rig space) → its x/y/z, in its parent's frame. */
export function moveChannels3d(pose: RigPose, boneId: string, delta: V3): { x: number; y: number; z: number } {
  const s = pose.byId.get(boneId)!;
  const p = parentFrame(pose, s);
  let d = delta;
  if (p) {
    const inv = invert4([p[0]!, p[1]!, p[2]!, 0, p[4]!, p[5]!, p[6]!, 0, p[8]!, p[9]!, p[10]!, 0, 0, 0, 0, 1]);
    d = [inv[0]! * delta[0] + inv[4]! * delta[1] + inv[8]! * delta[2], inv[1]! * delta[0] + inv[5]! * delta[1] + inv[9]! * delta[2], inv[2]! * delta[0] + inv[6]! * delta[1] + inv[10]! * delta[2]];
  }
  return { x: (readPose(s.bone, "x") ?? 0) + d[0], y: (readPose(s.bone, "y") ?? 0) + d[1], z: (readPose(s.bone, "z") ?? 0) + d[2] };
}

/**
 * REACH IN A WORLD — put a bone's TIP at `target` (rig space, 3D) by turning
 * it and up to `chain − 1` bones above it: the 3D solver (FABRIK, the one bone
 * IK uses) finds where each joint goes, then each bone, root of the chain
 * first, turns the short way onto its segment — re-reading the chain after
 * each turn, so a parent's turn carries its children before they aim. Keeps
 * the plane the limb bends in (the current knee is the solver's hint).
 * Rotations to write: `{bone, values: {rotation, rotationY, rotationX}}`.
 */
export function reachChannels3d(rig: Rig, boneId: string, target: V3, chain = 2): Array<{ bone: string; values: { rotation: number; rotationY: number; rotationX: number } }> {
  let pose = evaluateRig(rig, { planar: false });
  const tip = pose.byId.get(boneId);
  if (!tip) return [];
  const ids: string[] = [tip.id];
  for (let at = tip.parent; at && ids.length < chain; at = pose.byId.get(at)?.parent ?? null) ids.unshift(at);
  const states = ids.map((id) => pose.byId.get(id)!);
  const joints = [...states.map((b) => b.pose), mul4(tip.pose, translate4([tip.bone.rest.length, 0, 0]))];
  // The bend's side: the middle joint's offset from the root→tip line.
  const root = matPosition(joints[0]!);
  const end = matPosition(joints[joints.length - 1]!);
  const mid = joints.length > 2 ? matPosition(joints[1]!) : null;
  let hint: V3 | null = null;
  if (mid) {
    const axis = normalize3([end[0] - root[0], end[1] - root[1], end[2] - root[2]]);
    const m: V3 = [mid[0] - root[0], mid[1] - root[1], mid[2] - root[2]];
    const k = dot(m, axis);
    const off: V3 = [m[0] - axis[0] * k, m[1] - axis[1] * k, m[2] - axis[2] * k];
    if (length3(off) > 1e-6) hint = normalize3(off);
  }
  const solved = solveIk(joints, target, null, 48, 0.01, hint ?? undefined).map(matPosition);
  const work: Rig = { ...rig, bones: rig.bones.map((b) => ({ ...b })) };
  const out: Array<{ bone: string; values: { rotation: number; rotationY: number; rotationX: number } }> = [];
  for (let i = 0; i < ids.length; i++) {
    const s = pose.byId.get(ids[i]!)!;
    const want: V3 = [solved[i + 1]![0] - solved[i]![0], solved[i + 1]![1] - solved[i]![1], solved[i + 1]![2] - solved[i]![2]];
    const now: V3 = [s.tail[0] - s.head[0], s.tail[1] - s.head[1], s.tail[2] - s.head[2]];
    const turn = turnBetween(now, want);
    if (!turn) continue;
    const values = rotateChannels3d(pose, s.id, turn);
    out.push({ bone: s.id, values });
    const b = work.bones.find((x) => x.id === s.id)!;
    b.pose = { ...(b.pose ?? { x: 0, y: 0, rotation: 0, scale: 1, scaleY: null }), ...values };
    pose = evaluateRig(work, { planar: false });
  }
  return out;
}
