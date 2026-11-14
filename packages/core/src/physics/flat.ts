import type { MotionDocument, Clip, Frame, GroupClip, PhysicsSpec, VisualClip } from "../schema";
import { physicsSchema, simulationSchema } from "../schema/physics";
import { clipRenderLocalTime } from "../animation/evaluate";
import { trackLocalTime } from "../drawing/flipbook";
import { anchorLocal, basisOfTransform, layerMatrix } from "../transform-map";
import { clipBox, locateClip } from "../timeline/ops";
import { groupChainMatrix, groupDeltaMatrix } from "../timeline/group-space";
import { clipAncestorGroups } from "../timeline/groups";
import { isSettledDocument, settleDocument } from "../timeline/settled";
import { apply, invert, multiply, type Mat2D } from "../navigation/matrix";
import { bakeClipAt } from "../world/evaluate";
import { extrudeOutline, lineOutline } from "../world/extrude";
import { isSpatialClip } from "../clip-registry";
import type { PathCommand } from "../vector/geometry";
import type { V3 } from "../world/math";
import { convexHull, convexPieces, edgeQuads, outlinePolygons, type P2 } from "./geometry";
import { flattenCommands } from "../vector/polyline";
import { centreColliders, simulate, simulateHits, simulateParticles, type Quat, type SimBody, type SimPose, type SimCollider, type SimEmitter, type SimJoint, type SimParticles, type SimScene } from "./solver";
import type { FieldAt } from "./fields";
import { outlineGeneration, readPhysicsOutline } from "./outline";
import { bodyLife } from "./life";
import { subParentIndex } from "./emitters";
import { rigPlans, type RigPiece, type RigPlan } from "./rig-plan";
import { decide2d, memberOf } from "../rig/bind";
import { bakeRig, evaluateRig, letGoForBodies, rigPoseAt, type RigPose } from "../rig/pose";
import { setBoneChannel } from "../rig/fields";
import { turnChannel, worldAngle } from "../rig/pose-edit";

/**
 * PHYSICS IN A FLAT COMP — the 2D face of the one solver.
 *
 * A body is any layer with `physics` (a group is one body of everything in
 * it). It starts where its keys and its groups put it at the comp's physics
 * start, moving the way its keys were moving then (a thrown thing keeps
 * flying), plus its own start velocity and spin. Its collider is cut from
 * what it is: a rectangle's corners, a circle, a star's or a word's real
 * outline in convex pieces, a picture's box (or silhouette, when the app can
 * read one).
 *
 * The result is WRITTEN BACK as the layer's own placement at the instant
 * (`resolveFlatPhysics`), the way drivers are baked: the renderer, the
 * selection chrome, hit testing and the inspector all read a body where the
 * simulation put it, with no seam of their own.
 */


/** How deep a flat body's collider is: deep enough that every body in the plane overlaps every other in depth. */
const DEPTH = 500;

interface Placement {
  clip: VisualClip;
  /** Its parent space → the comp, at the start (groups and bones around it). */
  chain: Mat2D;
  /** The pivot's offset from `transform.x/y` in its parent space (a group's pivot; 0 for a leaf). */
  pivot: { x: number; y: number };
  /** Its rotation at the start, and the body's (theirs plus the chain's). */
  rotation0: number;
  angle0: number;
  /** Its mass centre in its body frame (pivot origin, unrotated): what the solver moves. */
  centre: V3;
  /** Each layer's local time at the instant this body enters (the start, or its own clip's start). */
  at: (c: Clip) => number;
  /** Its pivot in the comp as it enters. */
  origin: { x: number; y: number };
}

export interface FlatPhysics {
  scene: SimScene;
  startMs: number;
  placements: Map<string, Placement>;
  /** Rigs that simulate through their bones, and how to write their bones back. */
  rigs: RigRun[];
}

const built = new WeakMap<MotionDocument, Map<string, FlatPhysics | null>>();
const anyBodies = new WeakMap<MotionDocument, boolean>();

/** Does any layer in a FLAT comp of this document have a body? Memoised per settled document — the common project asks once. */
export function documentHasFlatPhysics(doc: MotionDocument): boolean {
  const hit = anyBodies.get(doc);
  if (hit !== undefined) return hit;
  const worlds = new Set(doc.frames.filter((f) => f.world).map((f) => f.id));
  const out = doc.tracks.some((t) => t.clips.some((c) => c.kind !== "audio" && (!!(c as VisualClip).physics || !!c.emitters?.length) && !worlds.has(c.frameId)));
  if (isSettledDocument(doc)) anyBodies.set(doc, out);
  return out;
}

/** Does any layer in this comp have a body? */
function bodiesIn(doc: MotionDocument, frameId: string): VisualClip[] {
  const out: VisualClip[] = [];
  for (const t of doc.tracks) for (const c of t.clips) if (c.frameId === frameId && c.kind !== "audio" && (c as VisualClip).physics && !isSpatialClip(c)) out.push(c as VisualClip);
  // A layer inside a group that is a body is part of that body.
  return out.filter((c) => !clipAncestorGroups(doc, c.id).some((g) => g.physics));
}

/** The comp's simulation, built from its start (memoised per settled document). Null when nothing in it has a body. */
export function flatPhysics(doc: MotionDocument, frameId: string): FlatPhysics | null {
  const settled = isSettledDocument(doc);
  let byFrame = settled ? built.get(doc) : undefined;
  const slot = `${frameId}#${outlineGeneration()}`;
  if (byFrame?.has(slot)) return byFrame.get(slot)!;
  const frame = doc.frames.find((f) => f.id === frameId);
  const out = frame && !frame.world ? buildFlat(doc, frame) : null;
  if (settled) {
    if (!byFrame) built.set(doc, (byFrame = new Map()));
    byFrame.set(slot, out);
  }
  return out;
}

function localTimeOf(doc: MotionDocument, frameId: string, compMs: number): (c: Clip) => number {
  return (c) => {
    const track = locateClip(doc, c.id)?.track;
    if (!track) return Math.max(0, compMs - c.startMs);
    return clipRenderLocalTime(track, c, trackLocalTime(track, frameId, compMs))?.local ?? Math.max(0, Math.min(c.durationMs, compMs - c.startMs));
  };
}

const toAffine = (m: Mat2D) => m;
const affine = (L: ReturnType<typeof layerMatrix>, x: number, y: number): Mat2D => ({ a: L[0], b: L[1], c: L[2], d: L[3], e: L[4] + x, f: L[5] + y });
const angleOf = (m: Mat2D) => (Math.atan2(m.b, m.a) * 180) / Math.PI;

/** A layer's own space → its parent's, at a local instant (its sampled transform). */
function ownToParent(doc: MotionDocument, clip: VisualClip): Mat2D {
  const t = clip.transform;
  return affine(layerMatrix(basisOfTransform(t, clipBox(doc, clip))), t.x, t.y);
}

function buildFlat(doc: MotionDocument, frame: Frame): FlatPhysics | null {
  const sim = simulationSchema.parse(frame.physics ?? {});
  const start = sim.startMs;
  // Rigs with physics in them simulate through their bones (`rig-plan.ts`): their
  // members and the rig group are the plan's, never bodies of their own.
  const startAt = localTimeOf(doc, frame.id, start);
  const plans = rigPlans(doc, frame.id, (rig) => rigPoseAt(rig, startAt(rig), true), (m, pose) => decide2d(doc, m, pose));
  const owned = new Set(plans.flatMap((p) => [...p.owned]));
  const clips = bodiesIn(doc, frame.id).filter((c) => !owned.has(c.id));
  const carriers = emittingIn(doc, frame.id);
  if (!clips.length && !plans.length && !carriers.length) return null;
  const placements = new Map<string, Placement>();
  const bodies: SimBody[] = [];
  const keyParts: unknown[] = [frame.width, frame.height, sim];
  const toSim = (ms: number) => ((ms - start) / 1000) * sim.timeScale;
  // Every body's frame as it enters, and which body each layer is part of (itself,
  // or the rig body its piece belongs to) with its own space → the comp then:
  // what a joint needs to pin anything to anything.
  const bodyAt: BodyRegistry = { frames: new Map(), ofClip: new Map() };

  /** One layer as a body — its own collider, or (a rig's root) the pieces it carries. */
  const addBody = (raw: VisualClip, spec: PhysicsSpec, pieces?: RigPiece[]): Placement | null => {
    // A body is in the simulation while its layer is on the timeline: it enters
    // where its keys put it at its own start, and leaves at its end.
    const life = bodyLife(doc, raw.id);
    if (!life || life.to <= start) return null;
    const born = Math.max(start, life.from);
    const at = localTimeOf(doc, frame.id, born);
    const clip = bakeClipAt(raw, at(raw)) as VisualClip;
    const chain = toAffine(groupChainMatrix(doc, raw.id, at));
    const pivot = raw.kind === "group" ? anchorLocal(clip.transform.anchor, clipBox(doc, raw)) : { x: 0, y: 0 };
    const pos = apply(chain, { x: clip.transform.x + pivot.x, y: clip.transform.y + pivot.y });
    const angle0 = clip.transform.rotation + angleOf(chain);
    const toBody = bodyFrame(pos, angle0);
    // Simulated about its mass centre; the pivot rides along at its offset.
    const shapes = pieces ? pieces.flatMap((p) => pieceColliders(doc, frame.id, p, p.spec ?? spec, at, toBody)) : collidersOf(doc, raw, spec, at, toBody);
    const { centre, colliders } = centreColliders(shapes.length || spec.type !== "active" ? shapes : [{ kind: "sphere", radius: 10, offset: [0, 0, 0] }]);
    const placement: Placement = { clip: raw, chain, pivot, rotation0: clip.transform.rotation, angle0, centre, at, origin: pos };
    placements.set(raw.id, placement);
    bodyAt.frames.set(raw.id, { pos, angle0, centre });
    bodyAt.ofClip.set(raw.id, { body: raw.id, toComp: multiply(chain, ownToParent(doc, clip)) });
    const com = rotateAdd(pos, angle0, centre);
    // Moving the way its keys were moving at the start, plus its own push.
    const kick = keyedMotion(doc, frame.id, raw, born);
    bodies.push({
      id: raw.id,
      type: spec.type,
      mass: spec.mass,
      bounce: spec.bounce,
      friction: spec.friction,
      damping: spec.damping,
      colliders,
      position: [com.x, com.y, 0],
      quaternion: zQuat(angle0),
      velocity: [spec.velocity[0] + kick.vx, spec.velocity[1] + kick.vy, 0],
      spin: [0, 0, spec.spin[2] + kick.spin],
      planar: true,
      ...(spec.type === "animated" && { animate: animatedPose(doc, frame.id, raw, start, sim.timeScale, centre) }),
      ...(spec.type === "active" && spec.follow > 0 && { follow: { strength: spec.follow, target: animatedPose(doc, frame.id, raw, start, sim.timeScale, centre) } }),
      ...((life.from > start || Number.isFinite(life.to)) && { life: { from: toSim(born), to: toSim(life.to) } }),
    });
    keyParts.push([raw.id, spec, com.x, com.y, angle0, colliders, kick, life, spec.type === "animated" || spec.follow > 0 ? raw.keyframes : null]);
    return placement;
  };

  for (const raw of clips) addBody(raw, raw.physics!);
  const rigJoints: SimJoint[] = [];
  const rigs: RigRun[] = [];
  for (const plan of plans) {
    // The root: the rig group, carrying the pieces no simulating bone does — falling
    // when the rig itself falls, otherwise going where the group's keys put it.
    const anchor = plan.byId.get(plan.rig.id)!;
    const rootSpec = plan.root ?? physicsSchema.parse({ type: "animated" });
    const root = addBody(plan.rig, rootSpec, anchor.pieces);
    if (!root) continue;
    const run = rigBodies(doc, frame, plan, root, start, sim.timeScale, toSim, bodies, rigJoints, keyParts, bodyAt);
    if (run) rigs.push(run);
  }
  const emitters = emittersOf(doc, frame, carriers, start, sim.timeScale, toSim, keyParts);
  if (!bodies.length && !emitters.length) return null;

  const joints = [...jointsOf(doc, frame.id, bodyAt), ...rigJoints];
  const fields = fieldsOf(doc, frame, start, sim.timeScale, keyParts);
  keyParts.push(joints);
  const planes: SimScene["planes"] = [];
  const W = frame.width / 2, H = frame.height / 2;
  if (sim.floor) planes.push({ point: [0, sim.floorAt ?? H, 0], normal: [0, -1, 0] });
  if (sim.walls) planes.push({ point: [-W, 0, 0], normal: [1, 0, 0] }, { point: [W, 0, 0], normal: [-1, 0, 0] }, { point: [0, -H, 0], normal: [0, 1, 0] });
  const scene: SimScene = {
    key: JSON.stringify(keyParts, (_k, v) => (typeof v === "number" ? Math.round(v * 1e4) / 1e4 : v)),
    gravity: [0, sim.gravity, 0],
    planes,
    bodies,
    joints,
    fields,
    timeScale: sim.timeScale,
    guard: sim.guard,
    ...(emitters.length && { emitters }),
  };
  return { scene, startMs: start, placements, rigs };
}

/** Comp space → a body frame at `pos`, turned `angle` degrees (unrotated, origin at `pos`). */
function bodyFrame(pos: { x: number; y: number }, angle: number): (p: { x: number; y: number }) => P2 {
  const rad = (-angle * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  return (p) => {
    const dx = p.x - pos.x, dy = p.y - pos.y;
    return [dx * cos - dy * sin, dx * sin + dy * cos];
  };
}

/** `pos` plus `v` turned by `angle` degrees. */
function rotateAdd(pos: { x: number; y: number }, angle: number, v: V3 | readonly [number, number]): { x: number; y: number } {
  const a = (angle * Math.PI) / 180;
  return { x: pos.x + v[0] * Math.cos(a) - v[1] * Math.sin(a), y: pos.y + v[0] * Math.sin(a) + v[1] * Math.cos(a) };
}

const zQuat = (deg: number): Quat => {
  const h = (deg * Math.PI) / 360;
  return [0, 0, Math.sin(h), Math.cos(h)];
};

// ── Colliders ────────────────────────────────────────────────────────────────

/** The leaves a body is made of, each with its own space → the comp. */
function leavesOf(doc: MotionDocument, clip: VisualClip, at: (c: Clip) => number): Array<{ leaf: VisualClip; toComp: Mat2D }> {
  if (clip.kind !== "group") {
    const baked = bakeClipAt(clip, at(clip)) as VisualClip;
    return [{ leaf: clip, toComp: multiply(groupChainMatrix(doc, clip.id, at), ownToParent(doc, baked)) }];
  }
  const out: Array<{ leaf: VisualClip; toComp: Mat2D }> = [];
  for (const t of doc.tracks) {
    if (t.groupId !== clip.id) continue;
    for (const c of t.clips) if (c.kind !== "audio" && c.kind !== "adjustment" && !isSpatialClip(c)) out.push(...leavesOf(doc, c as VisualClip, at));
  }
  return out;
}

/** A leaf's outline in its own space: core's for a shape or a path, the app's for text and pictures. */
function outlineOf(doc: MotionDocument, leaf: VisualClip, localMs: number): PathCommand[] | null {
  return extrudeOutline(leaf, localMs) ?? readPhysicsOutline(doc, leaf, localMs);
}

function collidersOf(doc: MotionDocument, clip: VisualClip, spec: PhysicsSpec, at: (c: Clip) => number, toBody: (p: { x: number; y: number }) => P2): SimCollider[] {
  const prism = (points: P2[]): SimCollider => ({ kind: "prism", points: points.map((p) => [p[0], p[1]] as const), u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1], depth: DEPTH });
  const out: SimCollider[] = [];
  const all: P2[] = [];
  for (const { leaf, toComp } of leavesOf(doc, clip, at)) {
    const box = clipBox(doc, leaf);
    const corners = [
      [box.cx - box.width / 2, box.cy - box.height / 2],
      [box.cx + box.width / 2, box.cy - box.height / 2],
      [box.cx + box.width / 2, box.cy + box.height / 2],
      [box.cx - box.width / 2, box.cy + box.height / 2],
    ].map(([x, y]) => toBody(apply(toComp, { x: x!, y: y! })));
    const local = at(leaf);
    const shape = spec.shape === "auto" ? autoShape(leaf, toComp) : spec.shape;
    if (shape === "sphere") {
      const centre = toBody(apply(toComp, { x: box.cx, y: box.cy }));
      const s = Math.sqrt(Math.abs(toComp.a * toComp.d - toComp.b * toComp.c));
      out.push({ kind: "sphere", radius: (Math.max(box.width, box.height) / 2) * s, offset: [centre[0], centre[1], 0] });
      all.push(...corners);
      continue;
    }
    const cmds = shape === "box" ? null : outlineOf(doc, leaf, local);
    const size = Math.max(box.width, box.height);
    const polys = cmds ? outlinePolygons(cmds, size).map((p) => p.map(([x, y]) => toBody(apply(toComp, { x, y })))) : [];
    // A mirrored layer flips its outline's winding: the pieces want it counter-clockwise.
    const ccw = polys.map((p) => (area2(p) < 0 ? p.slice().reverse() : p));
    // The line itself: asked for, or what an outline with nothing closed (a drawn line) can only mean.
    const wantsLine = shape === "edge" || (shape === "outline" && spec.shape === "auto" && !ccw.length);
    const line = wantsLine ? (lineOutline(leaf, local) ?? cmds) : null;
    const edges = line ? edgeQuads(line, size, strokeWidth(leaf)) : [];
    if (edges.length) {
      for (const q of edges) {
        const pts = q.map(([x, y]) => toBody(apply(toComp, { x, y })));
        out.push(prism(area2(pts) < 0 ? pts.slice().reverse() : pts));
        all.push(...pts);
      }
      continue;
    }
    if (!ccw.length || shape === "box") out.push(prism(area2(corners) < 0 ? corners.slice().reverse() : corners));
    // A picture's silhouette as its hull: a sticker lands on its edge, fast.
    else if (shape === "hull" || shape === "picture") out.push(prism(convexHull(ccw.flat())));
    else for (const p of ccw) for (const piece of convexPieces(p)) out.push(prism(piece));
    all.push(...(ccw.length ? ccw.flat() : corners));
  }
  // A group's pieces, or a hull asked of a group, come from all of it.
  if (clip.kind === "group" && spec.shape === "hull" && all.length >= 3) return [prism(convexHull(all))];
  return out;
}

/**
 * What `auto` means for a layer: a rectangle is a box, a round thing a circle,
 * an outline its pieces, a picture its silhouette's hull (its box when the
 * app cannot read one).
 */
function autoShape(leaf: VisualClip, toComp: Mat2D): PhysicsSpec["shape"] | "picture" {
  if (leaf.kind === "shape") {
    if (leaf.shape === "rect") return "box";
    const uniform = Math.abs(Math.hypot(toComp.a, toComp.b) - Math.hypot(toComp.c, toComp.d)) < 1e-6 && Math.abs(toComp.a * toComp.c + toComp.b * toComp.d) < 1e-6;
    if (leaf.shape === "ellipse" && Math.abs(leaf.width - leaf.height) < 1e-6 && uniform) return "sphere";
    return "outline";
  }
  if (leaf.kind === "path" || leaf.kind === "text") return "outline";
  return "picture";
}

/** How thick a layer's line is: its widest enabled stroke, or a hairline's 2 units. */
function strokeWidth(leaf: VisualClip): number {
  return leaf.strokes.reduce((w, s) => (s.enabled === false ? w : Math.max(w, s.width)), 2);
}

const area2 = (p: readonly P2[]) => {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j]![0] - p[i]![0]) * (p[j]![1] + p[i]![1]);
  return a;
};

// ── Motion at the start ─────────────────────────────────────────────────────

/** The pivot's velocity (units/s) and spin (deg/s) its own keys give it at the start. */
function keyedMotion(doc: MotionDocument, frameId: string, clip: VisualClip, start: number): { vx: number; vy: number; spin: number } {
  if (!clip.keyframes.some((k) => k.property === "x" || k.property === "y" || k.property === "rotation")) return { vx: 0, vy: 0, spin: 0 };
  const h = 1000 / 120;
  const a = poseAt(doc, frameId, clip, start - h), b = poseAt(doc, frameId, clip, start);
  return { vx: ((b.x - a.x) * 1000) / h, vy: ((b.y - a.y) * 1000) / h, spin: ((b.angle - a.angle) * 1000) / h };
}

/** Where a layer's pivot is in the comp, and its angle, at comp time `ms` by its own keys (the groups around it as at that time). */
function poseAt(doc: MotionDocument, frameId: string, clip: VisualClip, ms: number): { x: number; y: number; angle: number } {
  const at = localTimeOf(doc, frameId, ms);
  const baked = bakeClipAt(clip, at(clip)) as VisualClip;
  const chain = groupChainMatrix(doc, clip.id, at);
  const pivot = clip.kind === "group" ? anchorLocal(baked.transform.anchor, clipBox(doc, clip)) : { x: 0, y: 0 };
  const p = apply(chain, { x: baked.transform.x + pivot.x, y: baked.transform.y + pivot.y });
  return { x: p.x, y: p.y, angle: baked.transform.rotation + angleOf(chain) };
}

/** An animated body's pose `t` simulation-seconds after the start. */
function animatedPose(doc: MotionDocument, frameId: string, clip: VisualClip, start: number, timeScale: number, centre: V3): (t: number) => { position: V3; quaternion: Quat } {
  return (t) => {
    const p = poseAt(doc, frameId, clip, start + (t / timeScale) * 1000);
    const a = (p.angle * Math.PI) / 180;
    return { position: [p.x + centre[0] * Math.cos(a) - centre[1] * Math.sin(a), p.y + centre[0] * Math.sin(a) + centre[1] * Math.cos(a), 0], quaternion: zQuat(p.angle) };
  };
}

// ── Joints and fields ───────────────────────────────────────────────────────

/** Every body's frame as it enters, and which body each layer belongs to. */
interface BodyRegistry {
  frames: Map<string, { pos: { x: number; y: number }; angle0: number; centre: V3 }>;
  /** A layer → its body, and its own space → the comp as that body enters. */
  ofClip: Map<string, { body: string; toComp: Mat2D }>;
}

/**
 * Joints on any layer that is part of a body — a plain one, or a rigged piece
 * (which pins its bone's body: a rope from a hand to a balloon). Anchors are
 * in each layer's own space, carried to its body's frame as the body enters;
 * a null target anchor means "where this anchor is then".
 */
function jointsOf(doc: MotionDocument, frameId: string, reg: BodyRegistry): SimJoint[] {
  const out: SimJoint[] = [];
  const toBody = (body: string, c: { x: number; y: number }): V3 => {
    const f = reg.frames.get(body)!;
    const q = bodyFrame(f.pos, f.angle0)(c);
    return [q[0] - f.centre[0], q[1] - f.centre[1], 0];
  };
  for (const t of doc.tracks) {
    for (const clip of t.clips) {
      if (clip.frameId !== frameId || clip.kind === "audio" || !clip.joints?.length) continue;
      const a = reg.ofClip.get(clip.id);
      if (!a || !reg.frames.has(a.body)) continue;
      for (const j of clip.joints) {
        if (!j.enabled) continue;
        const here = apply(a.toComp, { x: j.anchor[0], y: j.anchor[1] });
        const b = j.target ? reg.ofClip.get(j.target) : undefined;
        // Two pieces of one body are already one.
        if (b && b.body === a.body) continue;
        const anchorB: V3 = b ? toBody(b.body, j.targetAnchor ? apply(b.toComp, { x: j.targetAnchor[0], y: j.targetAnchor[1] }) : here) : (j.targetAnchor ?? [here.x, here.y, 0]);
        out.push({ id: j.id, type: j.type, a: a.body, b: b ? b.body : null, anchorA: toBody(a.body, here), anchorB, stiffness: j.stiffness, damping: j.damping, length: j.length });
      }
    }
  }
  return out;
}

/** Every force in the comp — each card of each carrier's stack — placed by its carrier's keys over time (the groups around it as at the start). */
function fieldsOf(doc: MotionDocument, frame: Frame, start: number, timeScale: number, keyParts: unknown[]): SimScene["fields"] {
  const out: SimScene["fields"] = [];
  const at = localTimeOf(doc, frame.id, start);
  for (const t of doc.tracks) {
    for (const raw of t.clips) {
      if (raw.frameId !== frame.id || raw.kind === "audio" || !raw.forces?.length) continue;
      const clip = raw as VisualClip;
      const life = bodyLife(doc, clip.id);
      if (!life) continue;
      const chain = groupChainMatrix(doc, clip.id, at);
      keyParts.push(["forces", clip.id, clip.forces, clip.transform, clip.keyframes, life]);
      // One carrier placed once per instant, read by every card in its stack.
      let memo: { ms: number; baked: VisualClip; o: { x: number; y: number }; ang: number } | null = null;
      const placed = (ms: number) => {
        if (memo?.ms !== ms) {
          const baked = bakeClipAt(clip, ms - clip.startMs) as VisualClip;
          memo = { ms, baked, o: apply(chain, { x: baked.transform.x, y: baked.transform.y }), ang: ((baked.transform.rotation + angleOf(chain)) * Math.PI) / 180 };
        }
        return memo;
      };
      clip.forces!.forEach((_f, i) => {
        out.push((s) => {
          const ms = start + (s / timeScale) * 1000;
          if (ms < life.from || ms >= life.to) return null;
          const { baked, o, ang } = placed(ms);
          const spec = baked.forces?.[i];
          if (!spec) return null;
          const f: FieldAt = { spec, origin: [o.x, o.y, 0], axisX: [Math.cos(ang), Math.sin(ang), 0], axisZ: [0, 0, 1] };
          return f;
        });
      });
    }
  }
  return out;
}

// ── Particles ───────────────────────────────────────────────────────────────

/** Layers in this comp that carry an emitter. */
function emittingIn(doc: MotionDocument, frameId: string): VisualClip[] {
  const out: VisualClip[] = [];
  for (const t of doc.tracks) for (const c of t.clips) if (c.frameId === frameId && c.kind !== "audio" && c.emitters?.length) out.push(c as VisualClip);
  return out;
}

/** What only DRAWS a particle — left out of the simulation's key, so recolouring sparks never re-runs them. */
const LOOK_ONLY = new Set(["shape", "instance", "color", "colorEnd", "hue", "fade", "grow", "soft", "glow", "behind", "colorBy", "hot", "kelvin", "tilt", "lensing", "beaming"]);

/**
 * Every emitter in the comp, placed by its carrier's keys over time (the
 * groups around it as at the start, like a force): its numbers at an instant,
 * its origin and aim, and where in it a particle is born — its origin, its box,
 * or along its outline (a word that sheds sparks along its letters).
 */
function emittersOf(doc: MotionDocument, frame: Frame, carriers: VisualClip[], start: number, timeScale: number, toSim: (ms: number) => number, keyParts: unknown[]): SimEmitter[] {
  const out: SimEmitter[] = [];
  const at = localTimeOf(doc, frame.id, start);
  for (const clip of carriers) {
    const life = bodyLife(doc, clip.id);
    if (!life || life.to <= start) continue;
    const chain = groupChainMatrix(doc, clip.id, at);
    const box = clipBox(doc, clip);
    const born = Math.max(start, life.from);
    const outline = clip.emitters!.some((e) => e.source === "outline") ? perimeterOf(doc, clip, born - clip.startMs, box) : null;
    keyParts.push([
      "emitters",
      clip.id,
      clip.emitters!.map((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !LOOK_ONLY.has(k)))),
      clip.transform,
      clip.keyframes.filter((k) => !(k.property.startsWith("emit.") && LOOK_ONLY.has(k.property.split(".")[2]!))),
      box,
      life,
    ]);
    let memo: { ms: number; baked: VisualClip; toComp: Mat2D; o: { x: number; y: number }; ang: number } | null = null;
    const placed = (ms: number) => {
      if (memo?.ms !== ms) {
        const baked = bakeClipAt(clip, ms - clip.startMs) as VisualClip;
        memo = { ms, baked, toComp: multiply(chain, ownToParent(doc, baked)), o: apply(chain, { x: baked.transform.x, y: baked.transform.y }), ang: ((baked.transform.rotation + angleOf(chain)) * Math.PI) / 180 };
      }
      return memo;
    };
    const base = out.length;
    clip.emitters!.forEach((e, i) => {
      // A sub-emitter's parent: the card it names, else the card above — never a loop.
      const parent = e.type === "sub" ? subParentIndex(clip.emitters!, i) : null;
      out.push({
        layer: clip.id,
        index: i,
        life: { from: toSim(born), to: toSim(life.to) },
        ...(parent !== null && { parent: base + parent }),
        at: (t) => {
          const { baked, toComp, o, ang } = placed(start + (t / timeScale) * 1000);
          const spec = baked.emitters?.[i];
          if (!spec) return null;
          const place = (u: number, v: number): [number, number] => {
            // A ring is about the origin, in comp units like a force's reach: uniform over its area.
            if (spec.source === "ring") {
              const lo = Math.min(spec.inner, spec.outer), hi = Math.max(spec.inner, spec.outer);
              const r = Math.sqrt(lo * lo + u * (hi * hi - lo * lo)), a = v * Math.PI * 2;
              return [o.x + Math.cos(a) * r, o.y + Math.sin(a) * r];
            }
            const local = spec.source === "outline" && outline ? outline(u) : { x: box.cx + (u - 0.5) * box.width, y: box.cy + (v - 0.5) * box.height };
            const p = apply(toComp, local);
            return [p.x, p.y];
          };
          return { spec, origin: [o.x, o.y], angle: ang, place };
        },
      });
    });
  }
  return out;
}

/** A point `u` (0..1) of the way round a layer's outline, in its own space — its line, its filled outline, or its box's edge. */
function perimeterOf(doc: MotionDocument, clip: VisualClip, local: number, box: ReturnType<typeof clipBox>): (u: number) => { x: number; y: number } {
  const cmds = lineOutline(clip, local) ?? outlineOf(doc, clip, local);
  // Every contour, open ones too (a pen line sheds along its stroke).
  const lines = cmds ? flattenCommands(cmds, Math.max(0.25, Math.max(box.width, box.height) * 0.004)).filter((pl) => pl.pts.length >= 2) : [];
  const corners = [{ x: box.cx - box.width / 2, y: box.cy - box.height / 2 }, { x: box.cx + box.width / 2, y: box.cy - box.height / 2 }, { x: box.cx + box.width / 2, y: box.cy + box.height / 2 }, { x: box.cx - box.width / 2, y: box.cy + box.height / 2 }];
  const rings = (lines.length ? lines : [{ pts: corners, closed: true }]).map((pl) => ({ pts: pl.pts.map((p) => [p.x, p.y] as P2), closed: pl.closed }));
  const segs: Array<{ a: P2; b: P2; at: number; len: number }> = [];
  let total = 0;
  for (const { pts: ring, closed } of rings) {
    for (let i = 0; i < (closed ? ring.length : ring.length - 1); i++) {
      const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len > 1e-9) segs.push({ a, b, at: total, len }), (total += len);
    }
  }
  return (u) => {
    const d = Math.max(0, Math.min(total, u * total));
    let lo = 0, hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segs[mid]!.at <= d) lo = mid;
      else hi = mid - 1;
    }
    const s = segs[lo];
    if (!s) return { x: box.cx, y: box.cy };
    const k = (d - s.at) / s.len;
    return { x: s.a[0] + (s.b[0] - s.a[0]) * k, y: s.a[1] + (s.b[1] - s.a[1]) * k };
  };
}

/**
 * Every emitter's particles in a flat comp at comp time `compMs` — what the
 * renderer draws, from the same stored run the bodies and the hit sounds read.
 * Ask it of the RAW document (the build is memoised per settled document).
 */
export function flatParticles(doc: MotionDocument, frameId: string, compMs: number): SimParticles[] {
  const fp = flatPhysics(doc, frameId);
  if (!fp?.scene.emitters?.length || compMs < fp.startMs) return [];
  return simulateParticles(fp.scene, (compMs - fp.startMs) / 1000);
}

/**
 * What a seen emitter (`particle-view.ts`) needs at comp time `compMs`: the
 * origin its plane tilts about and the comp's fields then — the same
 * placements the run used, so the lens sits exactly on the well the gas orbits.
 */
export function flatParticleView(doc: MotionDocument, frameId: string, compMs: number, layer: string, index: number): { origin: [number, number]; fields: FieldAt[] } | null {
  const fp = flatPhysics(doc, frameId);
  const em = fp?.scene.emitters?.find((e) => e.layer === layer && e.index === index);
  if (!fp || !em) return null;
  const t = Math.max(0, (compMs - fp.startMs) / 1000) * fp.scene.timeScale;
  const here = em.at(t);
  if (!here) return null;
  return { origin: here.origin, fields: fp.scene.fields.map((f) => f(t)).filter((f): f is FieldAt => !!f) };
}

// ── Rigs: physics through the bones ─────────────────────────────────────────

/** A bone's frame in the comp: its head, and the way it points (degrees). */
interface BoneFrame {
  x: number;
  y: number;
  angle: number;
}

/** A rig that simulates, kept for writing its dynamic bones back at an instant. */
export interface RigRun {
  rig: GroupClip;
  /** Dynamic bones, parents first, with the angle each body started at (its frame's). */
  dynamic: Array<{ bone: string; angle0: number }>;
}

const IDENTITY: Mat2D = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** The rig's space → the comp at comp time `ms` (its groups, then its own delta), and its pose then. */
function rigAt(doc: MotionDocument, frameId: string, rig: GroupClip, ms: number): { pre: Mat2D; pose: RigPose | null } {
  const at = localTimeOf(doc, frameId, ms);
  const local = at(rig);
  const delta = groupDeltaMatrix(doc, rig, local);
  const chain = groupChainMatrix(doc, rig.id, at);
  return { pre: delta ? multiply(chain, delta) : chain, pose: rigPoseAt(rig, local, true) };
}

function boneFrameOf(pre: Mat2D, pose: RigPose, boneId: string): BoneFrame | null {
  const s = pose.byId.get(boneId);
  if (!s) return null;
  const h = apply(pre, { x: s.head[0], y: s.head[1] });
  // The bone's +X through the rig's placement (its length may be 0: read the frame).
  const dx = s.pose[0]!, dy = s.pose[1]!;
  const d = { x: pre.a * dx + pre.c * dy, y: pre.b * dx + pre.d * dy };
  return { x: h.x, y: h.y, angle: (Math.atan2(d.y, d.x) * 180) / Math.PI };
}

/**
 * A rig's bone bodies (`rig-plan.ts`): each dynamic bone a body pinned at its
 * head to what it hangs from — a hinge held inside the bone's rotation limits
 * and, when its pieces `follow`, driven toward its animated angle — and each
 * keyed bone a collider moving with its keys. The root is the rig group's own
 * body (`root`, built like any layer's).
 */
function rigBodies(
  doc: MotionDocument,
  frame: Frame,
  plan: RigPlan,
  root: Placement,
  start: number,
  timeScale: number,
  toSim: (ms: number) => number,
  bodies: SimBody[],
  joints: SimJoint[],
  keyParts: unknown[],
  bodyAt: BodyRegistry,
): RigRun | null {
  const rig = plan.rig;
  const life = bodyLife(doc, rig.id);
  if (!life || life.to <= start) return null;
  const born = Math.max(start, life.from);
  const at = localTimeOf(doc, frame.id, born);
  const memo = new Map<number, ReturnType<typeof rigAt>>();
  const rigAtMs = (ms: number) => {
    const k = Math.round(ms * 8) / 8;
    let r = memo.get(k);
    if (!r) {
      if (memo.size > 256) memo.clear();
      memo.set(k, (r = rigAt(doc, frame.id, rig, k)));
    }
    return r;
  };
  const frameAt = (ms: number, bone: string): BoneFrame | null => {
    const r = rigAtMs(ms);
    return r.pose ? boneFrameOf(r.pre, r.pose, bone) : null;
  };
  /** A body's frame angle at comp time `ms` by its keys: a bone's, or the root's pivot. */
  const keyedAngle = (ms: number, body: string): number => (body === rig.id ? poseAt(doc, frame.id, rig, ms).angle : (frameAt(ms, body)?.angle ?? 0));
  // Each body as it enters: where its frame is, and its mass centre in that frame.
  const frames = bodyAt.frames;
  // Every piece is part of its body: a joint on it pins that body.
  const piecesOf = (id: string, pieces: RigPiece[]) => {
    for (const p of pieces) {
      const baked = bakeClipAt(p.clip, at(p.clip)) as VisualClip;
      bodyAt.ofClip.set(p.clip.id, { body: id, toComp: multiply(groupChainMatrix(doc, p.clip.id, at), ownToParent(doc, baked)) });
    }
  };
  piecesOf(rig.id, plan.byId.get(rig.id)!.pieces);
  const toBodyOf = (id: string, p: { x: number; y: number }): V3 => {
    const f = frames.get(id)!;
    const q = bodyFrame(f.pos, f.angle0)(p);
    return [q[0] - f.centre[0], q[1] - f.centre[1], 0];
  };
  const pose0 = rigAtMs(born).pose;
  if (!pose0) return null;
  const h = 1000 / 120;
  const timed = life.from > start || Number.isFinite(life.to) ? { life: { from: toSim(born), to: toSim(life.to) } } : {};
  const dynamic: RigRun["dynamic"] = [];
  keyParts.push(["rig", rig.id, rig.rig, rig.keyframes.filter((k) => k.property.startsWith("bone.")), life]);

  for (const b of plan.bodies) {
    if (b.kind === "anchor" || !b.bone) continue;
    const f0 = frameAt(born, b.bone);
    if (!f0) continue;
    const toBody = bodyFrame(f0, f0.angle);
    const actives = b.pieces.filter((p) => p.spec?.type === "active");
    const lead = actives[0]?.spec ?? b.pieces[0]?.spec ?? physicsSchema.parse({});
    const shapes = b.pieces.flatMap((p) => pieceColliders(doc, frame.id, p, p.spec ?? lead, at, toBody));
    const { centre, colliders } = centreColliders(shapes.length ? shapes : [{ kind: "sphere", radius: 4, offset: [0, 0, 0] }]);
    frames.set(b.id, { pos: { x: f0.x, y: f0.y }, angle0: f0.angle, centre });
    piecesOf(b.id, b.pieces);
    const com = rotateAdd(f0, f0.angle, centre);
    const comAt = (ms: number) => {
      const f = frameAt(ms, b.bone!) ?? f0;
      return { f, c: rotateAdd(f, f.angle, centre) };
    };
    if (b.kind === "dynamic") {
      // Moving the way its keys moved it as it enters (a swung arm keeps swinging).
      const was = comAt(born - h);
      const mass = actives.reduce((m, p) => m + p.spec!.mass, 0) || lead.mass;
      bodies.push({
        id: b.id,
        type: "active",
        mass,
        bounce: lead.bounce,
        friction: lead.friction,
        damping: lead.damping,
        colliders,
        position: [com.x, com.y, 0],
        quaternion: zQuat(f0.angle),
        velocity: [((com.x - was.c.x) * 1000) / h, ((com.y - was.c.y) * 1000) / h, 0],
        spin: [0, 0, (wrapDeg(f0.angle - was.f.angle) * 1000) / h],
        planar: true,
        ...timed,
      });
      dynamic.push({ bone: b.bone, angle0: f0.angle });
      // Pinned at its head to what it hangs from: a hinge.
      const link = b.link ?? rig.id;
      const linkAngle0 = frames.get(link)?.angle0 ?? root.angle0;
      const rel0 = wrapDeg(f0.angle - linkAngle0);
      const state = pose0.byId.get(b.bone)!;
      const own0 = state.bone.rest.rotation + (state.bone.pose?.rotation ?? 0);
      const lim = state.bone.limits?.rotation;
      const follow = Math.max(0, ...actives.map((p) => p.spec!.follow));
      joints.push({
        id: `bone:${b.id}`,
        type: "pin",
        a: b.id,
        b: link,
        anchorA: [-centre[0], -centre[1], 0],
        anchorB: toBodyOf(link, f0),
        stiffness: 0,
        damping: 0,
        length: null,
        hinge: {
          // The bone's own limits, measured the way the hinge measures (what lies between it and its body is carried).
          limit: lim ? [rel0 - own0 + state.bone.rest.rotation + lim[0], rel0 - own0 + state.bone.rest.rotation + lim[1]] : null,
          drive: follow > 0 ? { strength: follow, target: (t) => wrapDeg(keyedAngle(start + (t / timeScale) * 1000, b.bone!) - keyedAngle(start + (t / timeScale) * 1000, link)) } : null,
        },
      });
      keyParts.push([b.id, "dynamic", link, mass, lead, follow, lim ?? null, com.x, com.y, f0.angle, colliders]);
    } else {
      bodies.push({
        id: b.id,
        type: "animated",
        mass: 0,
        bounce: lead.bounce,
        friction: lead.friction,
        damping: lead.damping,
        colliders,
        position: [com.x, com.y, 0],
        quaternion: zQuat(f0.angle),
        velocity: [0, 0, 0],
        spin: [0, 0, 0],
        planar: true,
        animate: (t) => {
          const { f, c } = comAt(start + (t / timeScale) * 1000);
          return { position: [c.x, c.y, 0], quaternion: zQuat(f.angle) };
        },
        ...timed,
      });
      keyParts.push([b.id, "keyed", com.x, com.y, f0.angle, colliders]);
    }
  }
  return dynamic.length ? { rig, dynamic } : { rig, dynamic: [] };
}

/**
 * A rig piece's colliders in a body's frame: its own outline, or — art that
 * bends — a slim box along the bone it stands for (as wide as the art is thin,
 * never wider than a third of the bone), placed from the bone where the rig
 * stood as the body entered.
 */
function pieceColliders(doc: MotionDocument, frameId: string, p: RigPiece, spec: PhysicsSpec, at: (c: Clip) => number, toBody: (q: { x: number; y: number }) => P2): SimCollider[] {
  if (!p.segment) return collidersOf(doc, p.clip, spec, at, toBody);
  const rig = memberOf(doc, p.clip.id)?.rig;
  if (!rig) return [];
  const local = at(rig);
  const delta = groupDeltaMatrix(doc, rig, local);
  const chain = groupChainMatrix(doc, rig.id, at);
  const pre = delta ? multiply(chain, delta) : chain;
  const s = rigPoseAt(rig, local, true)?.byId.get(p.segment.bone);
  if (!s) return [];
  const h = apply(pre, { x: s.head[0], y: s.head[1] }), t = apply(pre, { x: s.tail[0], y: s.tail[1] });
  const L = Math.hypot(t.x - h.x, t.y - h.y);
  if (L < 1e-3) return [];
  const box = clipBox(doc, p.clip);
  const toComp = multiply(groupChainMatrix(doc, p.clip.id, at), ownToParent(doc, bakeClipAt(p.clip, at(p.clip)) as VisualClip));
  const r = Math.max(2, Math.min(L * 0.35, (Math.min(box.width, box.height) / 2) * Math.sqrt(Math.abs(toComp.a * toComp.d - toComp.b * toComp.c))));
  const nx = (-(t.y - h.y) / L) * r, ny = ((t.x - h.x) / L) * r;
  const quad = [{ x: h.x - nx, y: h.y - ny }, { x: t.x - nx, y: t.y - ny }, { x: t.x + nx, y: t.y + ny }, { x: h.x + nx, y: h.y + ny }].map(toBody);
  const ccw = area2(quad) < 0 ? quad.slice().reverse() : quad;
  return [{ kind: "prism", points: ccw.map((q) => [q[0], q[1]] as const), u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1], depth: DEPTH }];
}

const wrapDeg = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/**
 * Each simulating rig's dynamic bones written back as ordinary rotation
 * channels, parents first, into the instant's document — the way a driven
 * channel is baked: the renderer, the bones overlay, bending and every child
 * read the swung bone where the simulation has it. IK on a chain that holds a
 * dynamic bone lets go (the body is what moves it now).
 */
function writeRigs(fp: FlatPhysics, doc: MotionDocument, frameId: string, compMs: number, poses: Map<string, { turn: number }>): MotionDocument {
  const groups = new Map<string, GroupClip>();
  for (const run of fp.rigs) {
    const live = run.dynamic.filter((d) => poses.has(d.bone));
    if (!live.length) continue;
    const g = locateClip(doc, run.rig.id)?.clip;
    if (g?.kind !== "group" || !g.rig) continue;
    const at = localTimeOf(doc, frameId, compMs);
    const local = at(g);
    const baked = bakeRig(g, local) ?? g.rig;
    let rig = letGoForBodies(baked, new Set(live.map((d) => d.bone)));
    const delta = groupDeltaMatrix(doc, g, local);
    const chain = groupChainMatrix(doc, g.id, at);
    const pre = delta ? multiply(chain, delta) : chain;
    const inv = invert({ ...pre, e: 0, f: 0 }) ?? IDENTITY;
    for (const d of live) {
      const pose = evaluateRig(rig, { planar: true });
      const s = pose.byId.get(d.bone);
      if (!s) continue;
      // The simulated direction, from the comp into the rig's space.
      const a = ((d.angle0 + poses.get(d.bone)!.turn) * Math.PI) / 180;
      const v = apply(inv, { x: Math.cos(a), y: Math.sin(a) });
      const want = (Math.atan2(v.y, v.x) * 180) / Math.PI;
      const rotation = turnChannel(pose, d.bone, wrapDeg(want - worldAngle(s)));
      rig = { ...rig, bones: rig.bones.map((b) => (b.id === d.bone ? { ...b, pose: { ...(b.pose ?? { x: 0, y: 0, rotation: 0, scale: 1, scaleY: null }) } } : b)) };
      setBoneChannel(rig, `bone.${d.bone}.rotation`, rotation);
    }
    // Every channel is baked into the bones now: their keys and modulators have said their piece.
    groups.set(g.id, {
      ...g,
      rig,
      keyframes: g.keyframes.filter((k) => !k.property.startsWith("bone.")),
      ...(g.modulators && { modulators: g.modulators.filter((m) => !m.target.startsWith("bone.")) }),
    });
  }
  if (!groups.size) return doc;
  return settleDocument({ ...doc, tracks: doc.tracks.map((t) => (t.clips.some((c) => groups.has(c.id)) ? { ...t, clips: t.clips.map((c) => groups.get(c.id) ?? c) } : t)) });
}

// ── Writing it back ─────────────────────────────────────────────────────────

const PLACEMENT_PATHS = new Set(["x", "y", "rotation"]);

/**
 * The comp at comp time `compMs` with every active body placed where the
 * simulation has it — its own `x`, `y` and `rotation`, its keys on those
 * dropped (the simulation owns them now). The document itself when nothing
 * simulates there or then. Settled, like every resolved document.
 */
/**
 * Every hit in a flat comp from its start to comp time `untilMs`, at comp ms:
 * what a collision sound rides. Reads the same stored run playback reads, so a
 * sound lands on the frame the bodies touch.
 */
export function flatHits(doc: MotionDocument, frameId: string, untilMs: number): Array<{ ms: number; a: string; b: string | null; speed: number; particle?: number; x?: number }> {
  const fp = flatPhysics(doc, frameId);
  if (!fp || untilMs < fp.startMs) return [];
  const scale = fp.scene.timeScale;
  return simulateHits(fp.scene, (untilMs - fp.startMs) / 1000).map((h) => ({ ms: fp.startMs + (h.t / scale) * 1000, a: h.a, b: h.b, speed: h.speed, ...(h.particle !== undefined && { particle: h.particle }), ...(h.x !== undefined && { x: h.x }) }));
}

export function resolveFlatPhysics(doc: MotionDocument, frameId: string, compMs: number, into: MotionDocument = doc): MotionDocument {
  // The simulation is built from `doc` (the raw document — its memo survives a
  // frame); the poses are written into `into` (the instant's resolved one).
  const fp = flatPhysics(doc, frameId);
  if (!fp || compMs < fp.startMs) return into;
  const poses = posesAt(fp, compMs);
  if (!poses.size) return into;
  doc = into;
  const next = new Map<string, Clip>();
  // The groups around each body as they are NOW: the simulation owns where it is in the comp.
  const now = localTimeOf(doc, frameId, compMs);
  for (const [id, pose] of poses) {
    const pl = fp.placements.get(id);
    if (!pl) continue;
    const placed = placeBody(doc, pl, pose, (locateClip(doc, id)?.clip as VisualClip | undefined) ?? pl.clip, now);
    if (placed) next.set(id, placed);
  }
  const placed = next.size ? settleDocument({ ...doc, tracks: doc.tracks.map((t) => (t.clips.some((c) => next.has(c.id)) ? { ...t, clips: t.clips.map((c) => next.get(c.id) ?? c) } : t)) }) : doc;
  // Bones after placements: a falling rig's root is placed first, its limbs swing from it.
  return fp.rigs.length ? writeRigs(fp, placed, frameId, compMs, poses) : placed;
}

/**
 * ONE BODY AT AN INSTANT, without placing the rest — what a shutter sub-sample
 * of a body asks (core `clipAtInstant`). `base` is the layer as everything
 * before the simulation left it then; it comes back placed where the solver
 * has the body, or as is while the body is not in the world. The groups around
 * it are read in `into` (the frame's bake). A layer that is not a body is
 * `base`. Null when the simulation does not place this layer on its own (a
 * rig, whose bones are written together) — ask for the whole instant then.
 */
export function flatBodyAt(doc: MotionDocument, frameId: string, compMs: number, into: MotionDocument, base: VisualClip): VisualClip | null {
  const fp = flatPhysics(doc, frameId);
  if (!fp) return base;
  if (fp.rigs.some((r) => r.rig.id === base.id)) return null;
  const pl = fp.placements.get(base.id);
  if (!pl || compMs < fp.startMs) return base;
  const pose = posesAt(fp, compMs).get(base.id);
  return pose ? (placeBody(into, pl, pose, base, localTimeOf(into, frameId, compMs)) ?? base) : base;
}

/** The body's clip with its placement written where `pose` puts it; null when its groups cannot be undone. */
function placeBody(doc: MotionDocument, pl: Placement, pose: SimPose, clip: VisualClip, now: (c: Clip) => number): VisualClip | null {
  const chain = groupChainMatrix(doc, clip.id, now);
  const inv = invert(chain);
  if (!inv) return null;
  // The pivot rides at its offset from the mass centre, turned with the body.
  const total = ((pl.angle0 + pose.turn) * Math.PI) / 180;
  const pivotAt = { x: pose.position[0] - (pl.centre[0] * Math.cos(total) - pl.centre[1] * Math.sin(total)), y: pose.position[1] - (pl.centre[0] * Math.sin(total) + pl.centre[1] * Math.cos(total)) };
  const p = apply(inv, pivotAt);
  // The body's angle in the comp, unwound, less what the groups around it turn by now.
  const angle = pl.angle0 + pose.turn - angleOf(chain);
  return {
    ...clip,
    transform: { ...clip.transform, x: p.x - pl.pivot.x, y: p.y - pl.pivot.y, rotation: angle },
    keyframes: clip.keyframes.filter((k) => !PLACEMENT_PATHS.has(k.property)),
    // Swallowed by a horizon: hidden from then on, in the bake only — the layer itself is untouched.
    ...(pose.gone && { hidden: true }),
  } as VisualClip;
}

/**
 * Every body's pose at a comp instant, remembered per simulation: one frame's
 * shutters ask each sub-sample instant once per BODY, and reading the run
 * builds every body's pose at once. The instants of a frame or two stay warm.
 */
const posesMemo = new WeakMap<FlatPhysics, Map<number, Map<string, SimPose>>>();
function posesAt(fp: FlatPhysics, compMs: number): Map<string, SimPose> {
  let memo = posesMemo.get(fp);
  if (!memo) posesMemo.set(fp, (memo = new Map()));
  const hit = memo.get(compMs);
  if (hit) return hit;
  const poses = simulate(fp.scene, (compMs - fp.startMs) / 1000);
  if (memo.size >= 256) memo.delete(memo.keys().next().value!);
  memo.set(compMs, poses);
  return poses;
}

export type { GroupClip };
