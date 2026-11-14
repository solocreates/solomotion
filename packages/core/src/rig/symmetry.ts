import type { MotionDocument, Bone, BoneConstraint, BoneLimits, GroupClip, Rig } from "../schema";
import { createId } from "../ids";
import { locateClip } from "../timeline/ops";
import { invert4, mul4, type Mat4, type V3 } from "../world/math";
import { bakeRig, orderBones, readPose, type BoneChannel } from "./pose";
import { bonesInRig, poseBones, restFrames, restFrom, rigIsPlanar } from "./ops";
import { mirrorName, pairOf, SIDE_COLORS, sideOf, type Side } from "./sides";

/**
 * SYMMETRY — one side of a character made from the other, and a pose copied
 * or flipped across it. The mirror is the plane x = axis in the RIG's space
 * (a flat comp's vertical line through the character; a world's YZ plane —
 * a flat rig made 3D keeps its x, so one rule serves both).
 *
 * The math, once (F a bone's rest frame in rig space, R the reflection, D =
 * diag(1, −1, 1) — the flip that keeps a mirrored frame right-handed with
 * its +X along the mirrored bone): the mirror bone's frame is R·F·D. So
 *  - a ROTATION delta (written in the bone's own rest frame) is always
 *    D-conjugated: rotation and roll negate, pitch keeps, scale keeps;
 *  - a POSITION delta (written in the PARENT's frame) maps through
 *    A = P′⁻¹·R·P, P and P′ the two parents' rest frames — (x, −y) under
 *    mirrored parents, (−x, y) for a root, whatever a centre parent says.
 * Sides come from names (`sides.ts`); nothing about symmetry is stored.
 */

const REFLECT: Mat4 = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const linearOf = (m: Mat4): Mat4 => [m[0]!, m[1]!, m[2]!, 0, m[4]!, m[5]!, m[6]!, 0, m[8]!, m[9]!, m[10]!, 0, 0, 0, 0, 1];
const apply3 = (m: Mat4, v: V3): V3 => [m[0]! * v[0] + m[4]! * v[1] + m[8]! * v[2], m[1]! * v[0] + m[5]! * v[1] + m[9]! * v[2], m[2]! * v[0] + m[6]! * v[1] + m[10]! * v[2]];

/** A = P′⁻¹·R·P (linear): a position delta in P's frame → the mirror's, in P′'s. */
function reflectionBetween(from: Mat4 | null | undefined, to: Mat4 | null | undefined): Mat4 {
  const P = from ? linearOf(from) : null;
  const Q = to ? linearOf(to) : null;
  const RP = P ? mul4(REFLECT, P) : REFLECT;
  return Q ? mul4(invert4(Q), RP) : RP;
}

/**
 * The rig's mirror line: the middle of its centre bones (deforming ones
 * first — a spine, a neck), else midway between its paired bones, else the
 * rig's origin.
 */
export function rigAxis(rig: Rig, planar: boolean): number {
  const at = bonesInRig(rig, planar);
  const centre = rig.bones.filter((b) => !sideOf(b.name));
  const deforming = centre.filter((b) => b.deform);
  const pick = deforming.length ? deforming : centre;
  if (pick.length) {
    const xs = pick.flatMap((b) => [at.get(b.id)!.head[0], at.get(b.id)!.tail[0]]).sort((a, b) => a - b);
    const m = xs.length >> 1;
    return xs.length % 2 ? xs[m]! : (xs[m - 1]! + xs[m]!) / 2;
  }
  const mids: number[] = [];
  for (const b of rig.bones) {
    const p = sideOf(b.name) === "L" ? pairOf(rig, b.id) : null;
    if (p) mids.push((at.get(b.id)!.head[0] + at.get(p.id)!.head[0]) / 2);
  }
  return mids.length ? mids.reduce((a, b) => a + b, 0) / mids.length : 0;
}

/** Limits carried to the mirror bone: turns and rolls flip, pitch and scale keep, moves map through A. */
function mirrorLimits(l: BoneLimits | null, A: Mat4): BoneLimits | null {
  if (!l) return null;
  const flip = (r: [number, number]): [number, number] => [-r[1] || 0, -r[0] || 0];
  const out: BoneLimits = {};
  if (l.rotation) out.rotation = flip(l.rotation);
  if (l.rotationX) out.rotationX = flip(l.rotationX);
  if (l.rotationY) out.rotationY = [...l.rotationY];
  for (const k of ["scale", "scaleY", "scaleZ"] as const) if (l[k]) out[k] = [...l[k]!];
  const axes = ["x", "y", "z"] as const;
  axes.forEach((src, j) => {
    const r = l[src];
    if (!r) return;
    const col = [A[j * 4]!, A[j * 4 + 1]!, A[j * 4 + 2]!];
    const k = col.reduce((best, v, i) => (Math.abs(v) > Math.abs(col[best]!) ? i : best), 0);
    // A move that lands on one axis maps exactly; a parent at a slant (not mirrored) keeps the range where it was.
    if (Math.abs(col[k]!) > 0.999) out[axes[k]!] = col[k]! > 0 ? [...r] : flip(r);
    else out[src] = [...r];
  });
  return Object.keys(out).length ? out : null;
}

export interface SymmetrizeResult {
  axis: number;
  from: Side;
  created: string[];
  updated: string[];
}

/**
 * SYMMETRIZE — build or refresh the other side of a skeleton from `from`
 * (default: the side with more bones, L on a tie): every bone of that side
 * gets its mirror — rest, parent, limits, shape, size, deform, colour, IK
 * (target and pole mapped to their own mirrors; a centre bone stays itself)
 * and constraints. A mirror that exists (by name, any convention:
 * `pairOf`) is UPDATED in place — its id, keys and art bindings kept — and
 * one that does not is created. Running it twice is running it once.
 * The other side's own pose is left alone: this is setup.
 */
export function symmetrize(doc: MotionDocument, groupId: string, opts: { from?: Side; axis?: number } = {}): SymmetrizeResult | null {
  const g = locateClip(doc, groupId)?.clip;
  if (!g || g.kind !== "group" || !g.rig) return null;
  const rig = g.rig;
  const planar = rigIsPlanar(doc, g);
  const count = (s: Side) => rig.bones.filter((b) => sideOf(b.name) === s).length;
  const from = opts.from ?? (count("R") > count("L") ? "R" : "L");
  const axis = opts.axis ?? rigAxis(rig, planar);
  const sources = orderBones(rig.bones).filter((o) => sideOf(o.bone.name) === from);
  const mapId = new Map<string, string>();
  const created: string[] = [];
  const updated: string[] = [];

  // Pass 1 — the bones themselves, parents first, so a mirror's parent is already in place.
  for (const { bone: src, parent } of sources) {
    const existing = pairOf(rig, src.id);
    const mp = parent ? (mapId.get(parent) ?? parent) : null;
    const at = bonesInRig(rig, planar).get(src.id)!;
    const m = (p: V3): V3 => [2 * axis - p[0], p[1], p[2]];
    const rest = restFrom(mp ? restFrames(rig, planar).get(mp)! : null, { head: m(at.head), tail: m(at.tail), roll: -at.roll }, planar);
    const color = src.color && src.color !== SIDE_COLORS[from] ? src.color : null;
    const props = { parent: mp, rest, deform: src.deform, shape: src.shape, size: src.size, color };
    if (existing && existing.id !== src.id) {
      Object.assign(existing, props);
      mapId.set(src.id, existing.id);
      updated.push(existing.id);
    } else {
      const bone: Bone = { ...props, id: createId("bone"), name: mirrorName(src.name), ik: null, limits: null };
      rig.bones.push(bone);
      mapId.set(src.id, bone.id);
      created.push(bone.id);
    }
  }

  // Pass 2 — what names other bones (IK, constraints) and what depends on both parents (limits).
  const frames = restFrames(rig, planar);
  const mapped = (id: string) => mapId.get(id) ?? id;
  for (const { bone: src } of sources) {
    const dst = rig.bones.find((b) => b.id === mapId.get(src.id))!;
    dst.limits = mirrorLimits(src.limits, reflectionBetween(src.parent ? frames.get(src.parent) : null, dst.parent ? frames.get(dst.parent) : null));
    dst.ik = src.ik ? { ...src.ik, target: mapped(src.ik.target), pole: src.ik.pole ? mapped(src.ik.pole) : null } : null;
    const kept = dst.constraints ?? [];
    const constraints = (src.constraints ?? []).map((c, i): BoneConstraint => {
      const target: BoneConstraint["target"] = c.target.kind === "bone" ? { kind: "bone", bone: mapped(c.target.bone) } : { ...c.target, x: 2 * axis - c.target.x };
      // The same slot keeps its id, so keys on its influence survive a refresh.
      const id = kept[i]?.type === c.type ? kept[i]!.id : createId("con");
      return { ...c, id, target };
    });
    if (constraints.length) dst.constraints = constraints;
    else delete dst.constraints;
  }
  return { axis, from, created, updated };
}

const PLANAR_CHANNELS: BoneChannel[] = ["x", "y", "rotation", "scale", "scaleY", "ik"];
const SPATIAL_CHANNELS: BoneChannel[] = ["x", "y", "z", "rotation", "rotationY", "rotationX", "scale", "scaleY", "scaleZ", "ik"];

/** One bone's channel values carried onto its mirror (`dst` may be itself — a centre bone flips in place). */
export function mirroredValues(src: Bone, dst: Bone, frames: Map<string, Mat4>, planar: boolean): Partial<Record<BoneChannel, number>> {
  const A = reflectionBetween(src.parent ? frames.get(src.parent) : null, dst.parent ? frames.get(dst.parent) : null);
  const v = (ch: BoneChannel) => readPose(src, ch) ?? (ch.startsWith("scale") ? 1 : 0);
  const pos = apply3(A, [v("x"), v("y"), planar ? 0 : v("z")]);
  const out: Partial<Record<BoneChannel, number>> = {};
  for (const ch of planar ? PLANAR_CHANNELS : SPATIAL_CHANNELS) {
    if (ch === "ik") {
      if (src.ik && dst.ik) out.ik = src.ik.mix;
      continue;
    }
    out[ch] = ch === "x" ? pos[0] : ch === "y" ? pos[1] : ch === "z" ? pos[2] : ch === "rotation" || ch === "rotationX" ? -v(ch) || 0 : v(ch);
  }
  return out;
}

/**
 * MIRROR A POSE at the group's local time `atMs`, written the way every pose
 * write is (keyed where keyed, or with `key`):
 *  - `copy`: each source bone's pose onto its mirror — `bones` (ids), or by
 *    default every bone of side `from` (L) — Blender's paste flipped;
 *  - `flip`: the whole pose turned over — each pair swaps (mirrored), each
 *    centre bone mirrors onto itself.
 * Values are read at the instant (keys, modulators) before anything is
 * written, so a swap never reads its own half-written result.
 */
export function mirrorPose(
  doc: MotionDocument,
  groupId: string,
  atMs: number,
  opts: { mode?: "copy" | "flip"; bones?: string[]; from?: Side; key?: boolean } = {},
): string[] {
  const g = locateClip(doc, groupId)?.clip;
  if (!g || g.kind !== "group" || !g.rig) return [];
  const planar = rigIsPlanar(doc, g);
  const now = bakeRig(g as GroupClip, atMs) ?? g.rig;
  const frames = restFrames(g.rig, planar);
  const from = opts.from ?? "L";
  const writes: Array<{ bone: string; values: Partial<Record<BoneChannel, number>> }> = [];
  const byId = new Map(now.bones.map((b) => [b.id, b]));
  for (const src of now.bones) {
    const side = sideOf(src.name);
    let dst: Bone | null;
    if ((opts.mode ?? "copy") === "flip") dst = side ? pairOf(now, src.id) : src;
    else {
      const chosen = opts.bones ? opts.bones.includes(src.id) : side === from;
      dst = chosen && side ? pairOf(now, src.id) : null;
    }
    if (!dst) continue;
    writes.push({ bone: dst.id, values: mirroredValues(src, byId.get(dst.id)!, frames, planar) });
  }
  poseBones(doc, groupId, writes, atMs, { key: opts.key });
  return writes.map((w) => w.bone);
}

