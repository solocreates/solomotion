import type { MotionDocument, Bone, GroupClip, PhysicsSpec, VisualClip } from "../schema";
import { decide2d, memberOf, type Decision, type MemberOf } from "../rig/bind";
import { rigPoseAt, type RigPose } from "../rig/pose";

/**
 * A RIG IN THE SIMULATION — which bones simulate and what each body is made
 * of. Pure rig data, the same for a flat comp and a world; the builders turn
 * it into bodies, pins and write-backs (docs/adr/ADR-physics.md, "Rigs").
 *
 * In a rig, physics acts THROUGH THE BONES. A piece's body says what its bone
 * does:
 *
 *  - a piece that FALLS (`active`) makes the bone it rides DYNAMIC: a body
 *    pinned at the bone's head to whatever the bone hangs from. It falls and
 *    swings about its joint (a pendulum, a clock hand let go), and everything
 *    hanging off it rides along. Chains of them are ropes, tails, ragdoll limbs.
 *  - a FIXED or KEYED piece rides its bone as a collider that moves with it.
 *  - the RIG ITSELF (the group's own body, or a piece it carries that falls —
 *    the clock's face) is the character's root: falls, and the whole character
 *    falls, its dynamic limbs flopping (a ragdoll); keyed or none, the root
 *    goes where the group's animation puts it.
 *
 * Bodies are the rig's ANCHOR (the group — its root), each DYNAMIC bone, and
 * each animated bone a dynamic one hangs from or a collider rides (so a hand
 * swinging from a keyed arm follows the arm). A bone below a dynamic one that
 * is not dynamic itself is carried by it — part of its body.
 */

export type RigBodyKind = "anchor" | "dynamic" | "keyed";

export interface RigPiece {
  clip: VisualClip;
  /** Its own body spec, or null when it collides only because the rig as a whole is a body. */
  spec: PhysicsSpec | null;
  /**
   * Art that BENDS is one piece per bone it is made of, each colliding as a
   * slim box along its bone (the art changes shape as it bends; its bones do
   * not) — a drawn tail falls as a chain.
   */
  segment?: { bone: string };
}

export interface RigBody {
  /** The rig group's id for the anchor; a bone's id otherwise. */
  id: string;
  kind: RigBodyKind;
  /** The bone it stands for (null: the anchor). */
  bone: string | null;
  /** For a dynamic or keyed bone: the body it is pinned to at its head (another bone's, or the anchor's). */
  link: string | null;
  pieces: RigPiece[];
}

export interface RigPlan {
  rig: GroupClip;
  /** Parents before children. */
  bodies: RigBody[];
  byId: Map<string, RigBody>;
  /** Every layer the plan speaks for — none of them is a body of its own. */
  owned: Set<string>;
  /** The dynamic bones. */
  dynamic: Set<string>;
  /**
   * The root's body: the rig group's own, or — when a piece the rig itself
   * carries falls — that piece's (the face of the clock falls: the clock
   * falls). Null: it goes where the group's keys put it.
   */
  root: PhysicsSpec | null;
}

/**
 * The plan of every rig in a comp that has physics in it — a member with a
 * body, or the rig group with one AND a member with one (a rig that alone has
 * a body stays one rigid body, as any group does).
 */
export function rigPlans(doc: MotionDocument, frameId: string, poseOf: (rig: GroupClip) => RigPose | null, decide: (m: MemberOf, pose: RigPose) => Decision): RigPlan[] {
  const byRig = new Map<string, { rig: GroupClip; members: Array<{ clip: VisualClip; m: MemberOf }> }>();
  for (const t of doc.tracks) {
    for (const c of t.clips) {
      if (c.frameId !== frameId || c.kind === "audio") continue;
      const m = memberOf(doc, c.id);
      if (!m) continue;
      let entry = byRig.get(m.rig.id);
      if (!entry) byRig.set(m.rig.id, (entry = { rig: m.rig, members: [] }));
      entry.members.push({ clip: c as VisualClip, m });
    }
  }
  const out: RigPlan[] = [];
  for (const { rig, members } of byRig.values()) {
    if (!members.some(({ clip }) => clip.physics)) continue;
    const pose = poseOf(rig);
    if (!pose) continue;
    out.push(plan(rig, pose, members, decide));
  }
  return out;
}

function plan(rig: GroupClip, pose: RigPose, members: Array<{ clip: VisualClip; m: MemberOf }>, decide: (m: MemberOf, pose: RigPose) => Decision): RigPlan {
  const whole = !!rig.physics;
  // How each unit follows the rig: the bone it rides, or the bones it bends with.
  const rides = new Map<string, Decision>();
  const pieces: Array<{ piece: RigPiece; bone: string | null }> = [];
  const owned = new Set<string>([rig.id]);
  for (const { clip, m } of members) {
    owned.add(clip.id);
    // A layer inside a unit (a group that rides whole) is that unit's; the unit is the piece.
    if (m.unit.id !== clip.id && !clip.physics) continue;
    let d = rides.get(m.unit.id);
    if (!d) rides.set(m.unit.id, (d = decide(m, pose)));
    if (!clip.physics && !(whole && m.unit.id === clip.id)) continue;
    const spec = clip.physics ?? null;
    const bends = d.kind === "smooth" ? (d.made ?? []).filter((b) => pose.byId.has(b)) : [];
    // Bending art: a piece on each bone it is made of (a chain). Riding art: its bone. Neither: the rig.
    if (bends.length) for (const b of bends) pieces.push({ piece: { clip, spec, segment: { bone: b } }, bone: b });
    else pieces.push({ piece: { clip, spec }, bone: d.kind === "rigid" && d.bone && pose.byId.has(d.bone) ? d.bone : null });
  }
  const dynamic = new Set(pieces.filter((p) => p.bone && p.piece.spec?.type === "active").map((p) => p.bone!));
  const parentOf = (id: string) => pose.byId.get(id)?.parent ?? null;
  const dynamicAbove = (id: string): string | null => {
    for (let at: string | null = id; at; at = parentOf(at)) if (dynamic.has(at)) return at;
    return null;
  };
  // A bone needs a body of its own when it is dynamic, or — with nothing dynamic
  // above it — something rides it or a dynamic bone hangs below it.
  const ridden = new Set(pieces.map((p) => p.bone).filter((b): b is string => !!b));
  const below = new Set<string>();
  for (const d of dynamic) for (let at = parentOf(d); at; at = parentOf(at)) below.add(at);
  // The root falls when the rig does, or when a piece it carries does; a falling
  // root carries every bone that does not simulate itself.
  const root = rig.physics ?? pieces.find((p) => !p.bone && p.piece.spec?.type === "active")?.piece.spec ?? null;
  const rootFalls = root?.type === "active";
  const bodyOf = (bone: string | null): string => {
    if (!bone) return rig.id;
    const dyn = dynamicAbove(bone);
    if (dyn) return dyn;
    if (rootFalls) return rig.id;
    if (ridden.has(bone) || below.has(bone)) return bone;
    return bodyOf(parentOf(bone));
  };
  const bodies: RigBody[] = [{ id: rig.id, kind: "anchor", bone: null, link: null, pieces: [] }];
  const byId = new Map(bodies.map((b) => [b.id, b]));
  for (const s of pose.bones) {
    if (bodyOf(s.id) !== s.id) continue;
    const b: RigBody = { id: s.id, kind: dynamic.has(s.id) ? "dynamic" : "keyed", bone: s.id, link: bodyOf(s.parent), pieces: [] };
    bodies.push(b);
    byId.set(b.id, b);
  }
  for (const { piece, bone } of pieces) byId.get(bodyOf(bone))!.pieces.push(piece);
  return { rig, bodies, byId, owned, dynamic, root };
}

/**
 * What a flat comp's rigged layer hangs on: the bone it rides (its body makes
 * that bone swing), or the rig itself (its body is the rig's root). Null when
 * it is not in a rig — or the rig is in a world, which binds in 3D.
 */
export function rigPieceOf(doc: MotionDocument, clipId: string): { rig: GroupClip; bone: Bone | null } | null {
  const m = memberOf(doc, clipId);
  if (!m || doc.frames.find((f) => f.id === m.rig.frameId)?.world) return null;
  const pose = rigPoseAt(m.rig, 0, true);
  if (!pose) return null;
  const d = decide2d(doc, m, pose);
  const bone = d.kind === "rigid" && d.bone ? (pose.byId.get(d.bone)?.bone ?? null) : null;
  return { rig: m.rig, bone };
}
