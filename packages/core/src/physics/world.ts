import type { MotionDocument, Frame, MeshClip, MeshData, VisualClip } from "../schema";
import { simulationSchema, type SimulationSpec } from "../schema/physics";
import { decomposeTrs, invert4, mul4, normalize3, rotation4, transformDir, transformPoint, type Mat4, type V3 } from "../world/math";
import { meshBounds } from "../world/mesh";
import { planeMatrix } from "../rig/world";
import { bodyThickness } from "../world/body";
import { extrudeOutline, lineOutline } from "../world/extrude";
import type { PathCommand } from "../vector/geometry";
import { clipBox } from "../timeline/ops";
import { convexHull, convexPieces, edgeQuads, outlinePolygons, type P2 } from "./geometry";
import { centreColliders, conj, matrixQuat, qmul, simulate, type Quat, type SimBody, type SimCollider, type SimJoint, type SimScene } from "./solver";
import type { FieldAt } from "./fields";
import type { RigPlan } from "./rig-plan";
import type { RigPose } from "../rig/pose";
import { physicsSchema } from "../schema/physics";

/**
 * PHYSICS IN A WORLD — the 3D face of the one solver. Meshes and 2D layers
 * standing in the world are bodies alike: a mesh collides as its box (or a
 * sphere when round), a picture plane as its own 2D outline extruded through
 * its thickness. Fields are any objects that carry one. The evaluator hands
 * over the world as it stood at the physics start; this hands back where the
 * active bodies are now.
 */

/** A body as the world stood at the physics start. */
export interface WorldBodyStart {
  id: string;
  /** The clip as it was (its spec, its keys). */
  clip: VisualClip;
  kind: string;
  /** Object → world at the start, scale included. */
  matrix: Mat4;
  /** A mesh's evaluated geometry at the start (its bounds size the collider). */
  mesh: MeshData | null;
  /** An animated body's object → world at `ms` (its keys over the start's parents). */
  matrixAt?: (ms: number) => Mat4;
  /** Comp ms it is in the world, `[from, to)` — `matrix` is its pose at `from` (`bodyLife`). */
  life?: { from: number; to: number };
}

/** A force carrier as the world places it at comp time `ms`, or null when it is not on then. */
export interface WorldFieldSource {
  id: string;
  /** How many forces its stack holds. */
  count: number;
  at: (ms: number) => { clip: VisualClip; matrix: Mat4 } | null;
  /** What it starts from, for the cache key. */
  key: unknown;
}

export interface WorldPhysics {
  scene: SimScene;
  sim: SimulationSpec;
  scales: Map<string, V3>;
  /** Each body's mass centre in its object frame (scale applied): the solver moves it; the origin rides at its offset. */
  centres: Map<string, V3>;
  /** Rigs that simulate through their bones: the dynamic bones to write back (parents first), and whether the root falls. */
  rigs: Map<string, { dynamic: string[]; rootFalls: boolean }>;
}

/**
 * A rig in a world as the simulation reads it (`rig-plan.ts`): its plan, its
 * space and pose at an instant (the evaluator's, keys only), and each piece
 * that collides as the world placed it when the rig entered.
 */
export interface WorldRigStart {
  plan: RigPlan;
  /** Rig space → world, and the pose, at comp time `ms` by keys alone. */
  at: (ms: number) => { base: Mat4; pose: RigPose } | null;
  /** Comp ms the rig is in the world, `[from, to)`. */
  life: { from: number; to: number };
  pieces: Map<string, { clip: VisualClip; kind: string; matrix: Mat4; mesh: MeshData | null }>;
}

/** A text's glyphs, a picture's silhouette — the app's reader (`setPhysicsOutlineProvider`, shared with flat comps). */
type OutlineReader = (clip: VisualClip, localMs: number) => PathCommand[] | null;

export function worldPhysics(doc: MotionDocument, frame: Frame, starts: WorldBodyStart[], fields: WorldFieldSource[], readOutline: OutlineReader, rigStarts: WorldRigStart[] = []): WorldPhysics | null {
  if (!starts.length && !rigStarts.length) return null;
  const sim = simulationSchema.parse(frame.physics ?? {});
  const bodies: SimBody[] = [];
  const scales = new Map<string, V3>();
  const centres = new Map<string, V3>();
  const keyParts: unknown[] = [sim];
  const toSim = (ms: number) => ((ms - sim.startMs) / 1000) * sim.timeScale;
  for (const s of starts) {
    const spec = s.clip.physics!;
    const trs = decomposeTrs(s.matrix);
    const scale = trs.scale;
    scales.set(s.id, scale);
    const { centre, colliders } = centreColliders(s.kind === "mesh" ? meshColliders(s.clip as MeshClip, s.mesh, scale) : planeColliders(doc, s.clip, scale, readOutline));
    centres.set(s.id, centre);
    const rotOnly = mul4(s.matrix, [1 / (scale[0] || 1), 0, 0, 0, 0, 1 / (scale[1] || 1), 0, 0, 0, 0, 1 / (scale[2] || 1), 0, 0, 0, 0, 1]);
    const com = transformPoint(rotOnly, centre);
    bodies.push({
      id: s.id,
      type: spec.type,
      mass: spec.mass,
      bounce: spec.bounce,
      friction: spec.friction,
      damping: spec.damping,
      colliders,
      position: com,
      quaternion: matrixQuat(rotOnly),
      velocity: spec.velocity,
      spin: spec.spin,
      planar: false,
      ...(s.life && { life: { from: toSim(s.life.from), to: toSim(s.life.to) } }),
      ...(spec.type === "animated" &&
        s.matrixAt && {
          animate: (t: number) => {
            const m = s.matrixAt!(sim.startMs + (t / sim.timeScale) * 1000);
            const sc = decomposeTrs(m).scale;
            const r = mul4(m, [1 / (sc[0] || 1), 0, 0, 0, 0, 1 / (sc[1] || 1), 0, 0, 0, 0, 1 / (sc[2] || 1), 0, 0, 0, 0, 1]);
            return { position: transformPoint(r, centre), quaternion: matrixQuat(r) };
          },
        }),
    });
    keyParts.push([s.id, spec, s.matrix.map((v) => +v.toFixed(4)), colliders, s.life ?? null, spec.type === "animated" ? s.clip.keyframes : null]);
  }
  for (const f of fields) keyParts.push(["field", f.id, f.key]);
  // Every body's rigid frame as it enters, and which body each layer is part of:
  // what a joint needs to pin anything to anything (a rope from a rigged hand).
  const reg: WorldBodyRegistry = { frames: new Map(), ofClip: new Map() };
  for (const st of starts) {
    reg.frames.set(st.id, { F: rigidOf(st.matrix), centre: centres.get(st.id) ?? [0, 0, 0] });
    reg.ofClip.set(st.id, { body: st.id, ownToWorld: st.kind === "mesh" ? st.matrix : mul4(st.matrix, planeMatrix(doc, st.clip)) });
  }
  const joints: SimJoint[] = [];
  const rigs = new Map<string, { dynamic: string[]; rootFalls: boolean }>();
  for (const r of rigStarts) {
    const out = worldRigBodies(doc, r, sim, toSim, readOutline, bodies, joints, scales, centres, keyParts, reg);
    if (out) rigs.set(r.plan.rig.id, out);
  }
  joints.push(...worldJoints(doc, frame.id, reg));
  if (!bodies.length) return null;
  keyParts.push(joints);
  const scene: SimScene = {
    key: JSON.stringify(keyParts, (_k, v) => (typeof v === "number" ? Math.round(v * 1e4) / 1e4 : v)),
    gravity: [0, 0, -sim.gravity],
    planes: sim.floor ? [{ point: [0, 0, sim.floorAt ?? 0], normal: [0, 0, 1] }] : [],
    bodies,
    joints,
    // Every card of every carrier's stack is a force of its own.
    fields: fields.flatMap((f) =>
      (f.count ? Array.from({ length: f.count }, (_, i) => i) : []).map((i) => (t: number) => {
        const at = f.at(sim.startMs + (t / sim.timeScale) * 1000);
        const spec = at?.clip.forces?.[i];
        if (!at || !spec) return null;
        const m = at.matrix;
        const out: FieldAt = { spec, origin: [m[12]!, m[13]!, m[14]!], axisX: normalize3(transformDir(m, [1, 0, 0])), axisZ: normalize3(transformDir(m, [0, 0, 1])) };
        return out;
      }),
    ),
    timeScale: sim.timeScale,
    guard: sim.guard,
  };
  return { scene, sim, scales, centres, rigs };
}

/** The active bodies' world matrices at comp time `timeMs` (their scale kept), or null before the start. */
export function worldPosesAt(wp: WorldPhysics, timeMs: number): Map<string, Mat4> | null {
  if (timeMs < wp.sim.startMs) return null;
  const poses = simulate(wp.scene, (timeMs - wp.sim.startMs) / 1000);
  const out = new Map<string, Mat4>();
  for (const [id, p] of poses) {
    // The origin rides at its offset from the mass centre, turned with the body.
    const m = composeFromQuat(p.position, p.quaternion, [1, 1, 1]);
    const c = wp.centres.get(id) ?? [0, 0, 0];
    const off = transformDir(m, c);
    // Swallowed by a horizon: shrunk to a point where it crossed (a degenerate matrix would break the normals).
    const scale = p.gone ? ([1e-6, 1e-6, 1e-6] as V3) : (wp.scales.get(id) ?? [1, 1, 1]);
    out.set(id, composeFromQuat([p.position[0] - off[0], p.position[1] - off[1], p.position[2] - off[2]], p.quaternion, scale));
  }
  return out;
}

/** Every body's rigid frame as it enters (and its mass centre there), and which body each layer is part of. */
interface WorldBodyRegistry {
  frames: Map<string, { F: Mat4; centre: V3 }>;
  /** A layer → its body, and its own space → the world as that body enters (a picture plane through its plane). */
  ofClip: Map<string, { body: string; ownToWorld: Mat4 }>;
}

/**
 * Joints in a world, on any layer that is part of a body — a plain one or a
 * rigged piece (which pins its bone's body). Anchors are in each layer's own
 * space (a mesh's object units, a picture plane's own 2D px through its plane);
 * a joint to the comp holds a world point.
 */
function worldJoints(doc: MotionDocument, frameId: string, reg: WorldBodyRegistry): SimJoint[] {
  const toBody = (body: string, w: V3): V3 => {
    const f = reg.frames.get(body)!;
    const l = transformPoint(invert4(f.F), w);
    return [l[0] - f.centre[0], l[1] - f.centre[1], l[2] - f.centre[2]];
  };
  const out: SimJoint[] = [];
  for (const t of doc.tracks) {
    for (const clip of t.clips) {
      if (clip.frameId !== frameId || clip.kind === "audio" || !clip.joints?.length) continue;
      const a = reg.ofClip.get(clip.id);
      if (!a || !reg.frames.has(a.body)) continue;
      for (const j of clip.joints) {
        if (!j.enabled) continue;
        const here = transformPoint(a.ownToWorld, j.anchor);
        const b = j.target ? reg.ofClip.get(j.target) : undefined;
        if (b && b.body === a.body) continue;
        const anchorB: V3 = b ? toBody(b.body, j.targetAnchor ? transformPoint(b.ownToWorld, j.targetAnchor) : here) : (j.targetAnchor ?? here);
        out.push({ id: j.id, type: j.type, a: a.body, b: b ? b.body : null, anchorA: toBody(a.body, here), anchorB, stiffness: j.stiffness, damping: j.damping, length: j.length });
      }
    }
  }
  return out;
}

// ── Rigs: physics through the bones ─────────────────────────────────────────

/** The spin (degrees/s about each world axis) that turns `from` into `to` in `ms`. */
function spinBetween(from: Quat, to: Quat, ms: number): V3 {
  let [x, y, z, w] = qmul(to, conj(from));
  if (w < 0) (x = -x), (y = -y), (z = -z), (w = -w);
  const s = Math.hypot(x, y, z);
  if (s < 1e-9) return [0, 0, 0];
  const deg = ((2 * Math.atan2(s, w) * 180) / Math.PI) * (1000 / ms);
  return [(x / s) * deg, (y / s) * deg, (z / s) * deg];
}

/** A matrix's rotation alone, columns normalised, its translation kept. */
function rigidOf(m: Mat4): Mat4 {
  const c = (i: number): V3 => normalize3([m[i]!, m[i + 1]!, m[i + 2]!]);
  const [x, y, z] = [c(0), c(4), c(8)];
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, m[12]!, m[13]!, m[14]!, 1];
}

/** A collider carried by a rigid transform into another frame (a box becomes the prism it is). */
function moveCollider(c: SimCollider, R: Mat4): SimCollider {
  const dir = (v: V3) => transformDir(R, v);
  if (c.kind === "sphere") return { kind: "sphere", radius: c.radius, offset: transformPoint(R, c.offset) };
  if (c.kind === "box") {
    const [hx, hy, hz] = c.half;
    return { kind: "prism", points: [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]], u: dir([1, 0, 0]), v: dir([0, 1, 0]), normal: dir([0, 0, 1]), depth: hz, offset: transformPoint(R, c.offset) };
  }
  return { ...c, u: dir(c.u), v: dir(c.v), normal: dir(c.normal), offset: transformPoint(R, c.offset ?? [0, 0, 0]) };
}

/**
 * A rig's bodies in a world: its root (falling when the plan says, else keyed),
 * each dynamic bone pinned at its head to what it hangs from — a ball joint,
 * pulled toward its keyed pose when its pieces `follow` — and each keyed bone a
 * collider moving with its keys. Frames are the bones' own (head, unit axes);
 * a piece's collider is carried from its object frame into its bone's.
 */
function worldRigBodies(
  doc: MotionDocument,
  r: WorldRigStart,
  sim: SimulationSpec,
  toSim: (ms: number) => number,
  readOutline: OutlineReader,
  bodies: SimBody[],
  joints: SimJoint[],
  scales: Map<string, V3>,
  centres: Map<string, V3>,
  keyParts: unknown[],
  reg: WorldBodyRegistry,
): { dynamic: string[]; rootFalls: boolean } | null {
  const { plan } = r;
  const start = sim.startMs;
  if (r.life.to <= start) return null;
  const born = Math.max(start, r.life.from);
  const memo = new Map<number, ReturnType<WorldRigStart["at"]>>();
  const at = (ms: number) => {
    const k = Math.round(ms * 8) / 8;
    if (!memo.has(k)) {
      if (memo.size > 256) memo.clear();
      memo.set(k, r.at(k));
    }
    return memo.get(k)!;
  };
  /** A body's frame in the world at `ms` by keys: the rig's space (the root), or a bone's head and axes. */
  const frameAt = (ms: number, bone: string | null): Mat4 | null => {
    const a = at(ms);
    if (!a) return null;
    if (!bone) return rigidOf(a.base);
    const s = a.pose.byId.get(bone);
    return s ? rigidOf(mul4(a.base, s.pose)) : null;
  };
  const first = at(born);
  if (!first) return null;
  const timed = r.life.from > start || Number.isFinite(r.life.to) ? { life: { from: toSim(born), to: toSim(r.life.to) } } : {};
  const frames = reg.frames;
  const dynamic: string[] = [];
  const h = 1000 / 120;
  keyParts.push(["rig", plan.rig.id, plan.rig.rig, plan.rig.keyframes.filter((k) => k.property.startsWith("bone.")), r.life]);
  const rootFalls = plan.root?.type === "active";

  for (const b of plan.bodies) {
    const F = frameAt(born, b.bone);
    if (!F) continue;
    const toF = invert4(F);
    const actives = b.pieces.filter((p) => p.spec?.type === "active");
    const lead = (b.kind === "anchor" ? plan.root : null) ?? actives[0]?.spec ?? b.pieces[0]?.spec ?? physicsSchema.parse({});
    const shapes: SimCollider[] = [];
    for (const p of b.pieces) {
      const o = r.pieces.get(p.clip.id);
      if (!o) continue;
      const sc = decomposeTrs(o.matrix).scale;
      if (p.segment) {
        // Art that bends: a slim box along the bone it stands for, as thick as the art is thin.
        const s = first.pose.byId.get(p.segment.bone);
        const Fs = frameAt(born, p.segment.bone);
        if (!s || !Fs) continue;
        const hd = transformPoint(first.base, s.head), tl = transformPoint(first.base, s.tail);
        const L = Math.hypot(tl[0] - hd[0], tl[1] - hd[1], tl[2] - hd[2]);
        if (L < 1e-3) continue;
        const thin = o.kind === "mesh" && o.mesh?.positions.length ? (() => { const bb = meshBounds(o.mesh!); return Math.min(...[0, 1, 2].map((i) => (bb.max[i]! - bb.min[i]!) * Math.abs(sc[i]!))); })() : (() => { const bx = clipBox(doc, o.clip); return Math.min(bx.width * Math.abs(sc[0]), bx.height * Math.abs(sc[2])); })();
        const rad = Math.max(2, Math.min(L * 0.35, thin / 2));
        shapes.push(moveCollider({ kind: "box", half: [L / 2, rad, rad], offset: [L / 2, 0, 0] }, mul4(toF, Fs)));
        continue;
      }
      const own = o.kind === "mesh" ? meshColliders(o.clip as MeshClip, o.mesh, sc) : planeColliders(doc, o.clip, sc, readOutline);
      const rel = mul4(toF, rigidOf(o.matrix));
      for (const c of own) shapes.push(moveCollider(c, rel));
    }
    const falls = b.kind === "dynamic" || (b.kind === "anchor" && rootFalls);
    const { centre, colliders } = centreColliders(shapes.length || !falls ? shapes : [{ kind: "sphere", radius: 4, offset: [0, 0, 0] }]);
    frames.set(b.id, { F, centre });
    for (const p of b.pieces) {
      const o = r.pieces.get(p.clip.id);
      if (o && !reg.ofClip.has(o.clip.id)) reg.ofClip.set(o.clip.id, { body: b.id, ownToWorld: o.kind === "mesh" ? o.matrix : mul4(o.matrix, planeMatrix(doc, o.clip)) });
    }
    centres.set(b.id, centre);
    scales.set(b.id, b.kind === "anchor" ? decomposeTrs(first.base).scale : [1, 1, 1]);
    const comOf = (m: Mat4) => transformPoint(m, centre);
    const com = comOf(F);
    const keyed = (t: number) => {
      const m = frameAt(start + (t / sim.timeScale) * 1000, b.bone) ?? F;
      return { position: comOf(m), quaternion: matrixQuat(m) };
    };
    if (falls) {
      const was = frameAt(born - h, b.bone) ?? F;
      const p0 = comOf(was);
      const follow = Math.max(0, ...actives.map((p) => p.spec!.follow));
      bodies.push({
        id: b.id,
        type: "active",
        mass: actives.reduce((m, p) => m + p.spec!.mass, 0) || lead.mass,
        bounce: lead.bounce,
        friction: lead.friction,
        damping: lead.damping,
        colliders,
        position: com,
        quaternion: matrixQuat(F),
        velocity: [((com[0] - p0[0]) * 1000) / h, ((com[1] - p0[1]) * 1000) / h, ((com[2] - p0[2]) * 1000) / h],
        // Turning the way its keys turned it as it enters (a swung arm keeps swinging).
        spin: spinBetween(matrixQuat(was), matrixQuat(F), h),
        planar: false,
        ...(follow > 0 && b.kind === "dynamic" && { follow: { strength: follow, target: keyed } }),
        ...timed,
      });
      if (b.kind === "dynamic") dynamic.push(b.bone!);
    } else {
      bodies.push({ id: b.id, type: "animated", mass: 0, bounce: lead.bounce, friction: lead.friction, damping: lead.damping, colliders, position: com, quaternion: matrixQuat(F), velocity: [0, 0, 0], spin: [0, 0, 0], planar: false, animate: keyed, ...timed });
    }
    keyParts.push([b.id, b.kind, falls, lead, F.map((v) => +v.toFixed(3)), colliders]);
    // A dynamic bone hangs at its head from what it hangs on: a ball joint.
    if (b.kind === "dynamic") {
      const link = b.link ?? plan.rig.id;
      const L = frames.get(link);
      if (!L) continue;
      const head: V3 = [F[12]!, F[13]!, F[14]!];
      const inL = transformPoint(invert4(L.F), head);
      // Its stops: the bone's own limits, measured from where its channels read 0.
      const lim = first.pose.byId.get(b.bone!)?.bone.limits;
      const bp = first.pose.byId.get(b.bone!)?.bone.pose;
      const zero = qmul(qmul(conj(matrixQuat(L.F)), matrixQuat(F)), conj(matrixQuat(rotation4(bp?.rotationX ?? 0, bp?.rotationY ?? 0, bp?.rotation ?? 0))));
      const limits = lim && (lim.rotation || lim.rotationX || lim.rotationY) ? { ...(lim.rotation && { rotation: lim.rotation }), ...(lim.rotationY && { rotationY: lim.rotationY }), ...(lim.rotationX && { rotationX: lim.rotationX }) } : null;
      joints.push({
        id: `bone:${b.id}`,
        type: "pin",
        a: b.id,
        b: link,
        anchorA: [-centre[0], -centre[1], -centre[2]],
        anchorB: [inL[0] - L.centre[0], inL[1] - L.centre[1], inL[2] - L.centre[2]],
        stiffness: 0,
        damping: 0,
        length: null,
        ...(limits && { ball: { zero, limits } }),
      });
    }
  }
  return { dynamic, rootFalls };
}

function meshColliders(clip: MeshClip, mesh: MeshData | null, scale: V3): SimCollider[] {
  const b = mesh && mesh.positions.length >= 3 ? meshBounds(mesh) : { min: [-50, -50, -50] as V3, max: [50, 50, 50] as V3 };
  const half: V3 = [0, 1, 2].map((i) => Math.max(0.5, ((b.max[i]! - b.min[i]!) / 2) * Math.abs(scale[i]!))) as V3;
  const centre: V3 = [0, 1, 2].map((i) => ((b.max[i]! + b.min[i]!) / 2) * scale[i]!) as V3;
  const p = clip.physics ?? physicsSchema.parse({});
  const round = clip.geometry.type === "primitive" && /sphere/i.test(clip.geometry.primitive);
  if (p.shape === "sphere" || (p.shape === "auto" && round)) return [{ kind: "sphere", radius: Math.max(...half), offset: centre }];
  return [{ kind: "box", half, offset: centre }];
}

/** A picture plane: its own outline, extruded through its thickness, in the plane's basis. */
function planeColliders(doc: MotionDocument, clip: VisualClip, scale: V3, readOutline: OutlineReader): SimCollider[] {
  const P = planeMatrix(doc, clip);
  const S = (v: V3): V3 => [v[0] * scale[0], v[1] * scale[1], v[2] * scale[2]];
  const u = S([P[0]!, P[1]!, P[2]!]), v = S([P[4]!, P[5]!, P[6]!]);
  const normal = normalize3(S([P[8]!, P[9]!, P[10]!]));
  const offset = S([P[12]!, P[13]!, P[14]!]);
  const depth = Math.max(1, (bodyThickness(clip)?.depth ?? 2) / 2);
  const box = clipBox(doc, clip);
  const prism = (pts: P2[]): SimCollider => ({ kind: "prism", points: pts.map((p) => [p[0], p[1]] as const), u, v, normal, depth, offset });
  const corners: P2[] = [
    [box.cx - box.width / 2, box.cy - box.height / 2],
    [box.cx + box.width / 2, box.cy - box.height / 2],
    [box.cx + box.width / 2, box.cy + box.height / 2],
    [box.cx - box.width / 2, box.cy + box.height / 2],
  ];
  const spec = clip.physics ?? physicsSchema.parse({});
  if (spec.shape === "box" || spec.shape === "sphere") return [prism(corners)];
  const cmds = extrudeOutline(clip, 0) ?? readOutline(clip, 0);
  const size = Math.max(box.width, box.height);
  const polys = cmds ? outlinePolygons(cmds, size) : [];
  // The line as a wall (asked for, or an outline that closes nothing): a ring a ball rolls inside.
  const line = spec.shape === "edge" || (spec.shape === "auto" && !polys.length) ? (lineOutline(clip, 0) ?? cmds) : null;
  if (line) {
    const width = clip.strokes.reduce((w, s) => (s.enabled === false ? w : Math.max(w, s.width)), 2);
    const quads = edgeQuads(line, size, width);
    if (quads.length) return quads.map(prism);
  }
  if (!polys.length) return [prism(corners)];
  if (spec.shape === "hull" || (spec.shape === "auto" && clip.kind === "shape" && clip.shape === "rect")) return [prism(convexHull(polys.flat()))];
  return polys.flatMap((p) => convexPieces(p).map(prism));
}


function composeFromQuat(p: V3, q: Quat, s: V3): Mat4 {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * s[0], 2 * (xy + wz) * s[0], 2 * (xz - wy) * s[0], 0,
    2 * (xy - wz) * s[1], (1 - 2 * (xx + zz)) * s[1], 2 * (yz + wx) * s[1], 0,
    2 * (xz + wy) * s[2], 2 * (yz - wx) * s[2], (1 - 2 * (xx + yy)) * s[2], 0,
    p[0], p[1], p[2], 1,
  ];
}

export { transformPoint };
