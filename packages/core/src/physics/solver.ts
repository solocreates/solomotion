import * as CANNON from "cannon-es";
import { eulerFromRotation, rotation4, type Mat4, type V3 } from "../world/math";
import { circularSpeed, fieldAcceleration, fieldHorizon, wellGM, type FieldAt } from "./fields";
import type { EmitterSpec } from "../schema";
import { ParticleSpace, type SpaceHit } from "./particle-space";

/**
 * THE SOLVER — one for a flat comp and a world. A scene builder (`flat.ts`,
 * `world.ts`) describes bodies, colliders, joints, fields and the floor in
 * the comp's own units; this runs them in cannon-es (metres, a fixed 120 Hz)
 * and keeps every step. A flat comp's bodies are PLANAR: they move in its
 * plane and turn about the line of sight (cannon's linear and angular
 * factors), so 2D is a world with a dimension resting — the same contacts,
 * joints, fields and cache.
 *
 * Exact per frame: a scene is keyed by what it STARTS from (`SimScene.key`),
 * every step is stored, and any instant reads its step — scrubbed, played
 * backward or exported out of order. It re-simulates only when the start
 * changes. Deterministic for the same inputs.
 */

export const HZ = 120;
const M = 0.01; // comp units (px, cm) → metres
const MAX_STEPS = HZ * 120;

export type Quat = [number, number, number, number];

export type SimCollider =
  | { kind: "box"; half: V3; offset: V3 }
  | { kind: "sphere"; radius: number; offset: V3 }
  /** A convex polygon (counter-clockwise, body-local units) extruded ±`depth` along `normal`, in the plane of `u`, `v`. */
  | { kind: "prism"; points: Array<readonly [number, number]>; u: V3; v: V3; normal: V3; depth: number; offset?: V3 };

export interface SimBody {
  id: string;
  type: "active" | "passive" | "animated";
  mass: number;
  bounce: number;
  friction: number;
  damping: number;
  colliders: SimCollider[];
  /** At the start, comp units. */
  position: V3;
  quaternion: Quat;
  velocity: V3;
  /** Degrees per second about each axis. */
  spin: V3;
  planar: boolean;
  /** An animated body's pose at `t` seconds into the simulation. */
  animate?: (t: number) => { position: V3; quaternion: Quat };
  /**
   * When it is in the world, simulation seconds `[from, to)` — its layer's
   * span on the timeline. Absent = throughout. A body that arrives later starts
   * at `position` then (its pose at its own start); one that leaves lets go of
   * whatever rested on it.
   */
  life?: { from: number; to: number };
  /**
   * An active body pulled toward where its animation puts it (`physics.follow`,
   * 0..1): a damped spring on its pose — jiggle at a little, stiff at 1.
   */
  follow?: { strength: number; target: (t: number) => { position: V3; quaternion: Quat } };
}

export interface SimJoint {
  id: string;
  type: "pin" | "weld" | "rope" | "spring";
  a: string;
  /** Null = the comp itself. */
  b: string | null;
  /** In A's own space, comp units. */
  anchorA: V3;
  /** In B's own space — or, when B is the comp, in the comp. */
  anchorB: V3;
  stiffness: number;
  damping: number;
  length: number | null;
  /**
   * A PLANAR pin as a hinge (a bone's joint): how far A may turn relative to B
   * (degrees, `[min, max]` about the line of sight), and a drive pulling A's
   * relative angle toward `target(t)` with `strength` 0..1 — the bone's
   * animated angle, so a dynamic bone follows its keys and swings behind them.
   */
  hinge?: { limit: [number, number] | null; drive: { strength: number; target: (t: number) => number } | null };
  /**
   * A SPATIAL pin as a bone's joint (a world): A's turn relative to B, less
   * `zero` (their relation with the bone's channels at 0), read as the bone's
   * own Euler channels and held inside their limits — the same ranges a keyed
   * bone is clamped to.
   */
  ball?: { zero: Quat; limits: { rotation?: [number, number]; rotationY?: [number, number]; rotationX?: [number, number] } };
}

/**
 * A PARTICLE EMITTER in the scene (v102): the layer it belongs to, when it is
 * on (simulation seconds), and what it is at an instant — its numbers then,
 * its origin and aim in the comp, and where in it a particle is born for two
 * random numbers (its origin, its box or its outline).
 */
export interface SimEmitter {
  /** The carrier layer — whose hits and whose picture the particles are. */
  layer: string;
  /** Its place in the carrier's stack. */
  index: number;
  life?: { from: number; to: number };
  /** A sub-emitter's parent: its index in `SimScene.emitters` — whose particles' deaths or hits throw these. */
  parent?: number;
  at: (t: number) => { spec: EmitterSpec; origin: [number, number]; angle: number; place: (u: number, v: number) => [number, number] } | null;
}

export interface SimScene {
  /** Everything the simulation starts from, as one string — the cache key. */
  key: string;
  /** Units/s². */
  gravity: V3;
  planes: Array<{ point: V3; normal: V3 }>;
  bodies: SimBody[];
  joints: SimJoint[];
  /** Each field's placement at `t` seconds, or null when it does not act then. */
  fields: Array<(t: number) => FieldAt | null>;
  /** Simulation seconds per comp second. */
  timeScale: number;
  /** Particle emitters (v102). */
  emitters?: SimEmitter[];
  /** Split a step that would carry a body past ¾ of its radius (v106); absent = one step. */
  guard?: boolean;
}

export interface SimPose {
  position: V3;
  quaternion: Quat;
  /** A planar body's turn since the start about the line of sight, degrees, UNWOUND (three rolls read 1080). */
  turn: number;
  /** Swallowed by a gravity well's horizon by now (v107): out of the simulation, where it crossed. */
  gone?: boolean;
}

interface Run {
  world: CANNON.World;
  /** Substep fast steps (v106 `guard`). */
  guard: boolean;
  /** Active bodies, in recording order. */
  active: Array<{ id: string; body: CANNON.Body; mass: number; planar: boolean; life: Life }>;
  animated: Array<{ body: CANNON.Body; animate: NonNullable<SimBody["animate"]> }>;
  springs: Array<() => void>;
  /** Per-step torques and forces: hinge drives and limits, follow springs (`t` = seconds into the run). */
  drives: Array<(t: number) => void>;
  /** Bodies that arrive or leave during the run, and the constraints that hold only while both ends are in. */
  comings: Array<{ body: CANNON.Body; life: Life }>;
  constraints: Array<{ c: CANNON.Constraint; a: CANNON.Body; b: CANNON.Body }>;
  fields: SimScene["fields"];
  /** Per step: x, y, z, qx, qy, qz, qw per active body. */
  steps: Float32Array[];
  /** Per step: each planar body's unwound turn since the start (degrees). */
  turns: Float32Array[];
  /** Every new contact, in step order — what a collision sound rides. */
  hits: SimHit[];
  /** Which scene body each cannon body is (walls and the floor are none). */
  ids: Map<CANNON.Body, string>;
  /** One per emitter: its live particles and every step of them. */
  particles: ParticleRun[];
  /** The same runs in stepping order: every parent before its sub-emitters, so a burst is born the step its shell dies. */
  particleOrder: ParticleRun[];
  gravity: V3;
  /** Where particles meet the bodies, rebuilt each step that has any. */
  space: ParticleSpace | null;
  /**
   * Bodies a horizon has swallowed (v107), and per active body the step it
   * happened (Infinity = never): from then on it is out of the world for good —
   * its layer's span no longer brings it back — and every read says `gone`.
   */
  swallowed: Set<CANNON.Body>;
  gone: number[];
}

/** A live particle: its index (birth order), where it is and how it moves, units. */
interface Particle {
  i: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

interface ParticleRun {
  em: SimEmitter;
  /** A sub-emitter's parent run. */
  parent: ParticleRun | null;
  /**
   * This step's deaths and hits, for sub-emitters to throw from — kept only
   * when a child listens. 7 numbers each: index, x, y, vx, vy, nx, ny (the
   * surface's normal on a hit).
   */
  died: number[] | null;
  struck: number[] | null;
  /** The next particle's index, and births owed but not yet whole (a stream at 40/s owes 1/3 a step). */
  next: number;
  owed: number;
  /** A burst has thrown; a stream has started. */
  burst: boolean;
  /** A `hit` emitter: how far down `run.hits` it has read, and whose hits it answers (null = every body's). */
  seen: number;
  of: string | null;
  /**
   * The falling body that carries it, when its layer is one: the emitter
   * rides where the simulation puts it, not where its keys stand — sparks
   * trail a thrown ball. `from` is the emitter's placement and the body's
   * pose when it first emits, mapped rigidly by the body's motion since.
   */
  rides: { body: CANNON.Body; from: { origin: [number, number]; angle: number; place: (u: number, v: number) => [number, number]; x: number; y: number; turn: number } | null } | null;
  live: Particle[];
  /** Per index: when it was born (simulation seconds) and how long it lives. */
  born: number[];
  lives: number[];
  /** Per index: the parent particle a sub-emitter's particle came from — one colour per firework shell. */
  family: number[] | null;
  /** Per step: index, x, y per live particle, in index order. */
  steps: Float32Array[];
}

/** At most this many alive per emitter: past it, births wait for deaths. */
export const MAX_PARTICLES = 4000;
/** Slower than this along the surface's normal, a hit is resting contact: no sound, no bounce. */
const REST_SPEED = 30;

/**
 * A HIT: two bodies starting to touch, `t` simulation seconds in, closing at
 * `speed` units/s along the contact's normal. Resting contact never re-fires
 * (a pair counts once until it parts); `b` null is a wall or the floor.
 */
export interface SimHit {
  t: number;
  a: string;
  b: string | null;
  speed: number;
  /** A particle's hit: `a` is the layer that emitted it, this its index (v102). */
  particle?: number;
  /**
   * A body hit's contact, comp units: where, and the way something thrown off
   * it goes — out of the surface toward the side that moves (up off a floor,
   * in off a ring). `glance` when both sides move: then it is the contact's
   * normal, and spray goes along the tangent, both ways.
   */
  x?: number;
  y?: number;
  nx?: number;
  ny?: number;
  glance?: boolean;
}

type Life = { from: number; to: number };
const ALWAYS: Life = { from: 0, to: Infinity };
const alive = (life: Life, t: number) => t >= life.from - 1e-9 && t < life.to - 1e-9;
/** In the world now (cannon sets `world` on add and clears it on remove). */
const inWorld = (b: CANNON.Body) => !!b.world;

const runs = new Map<string, Run>();

/** The active bodies' poses `seconds` of comp time after the start (`timeScale` applied), comp units. */
export function simulate(scene: SimScene, seconds: number): Map<string, SimPose> {
  let run = runs.get(scene.key);
  if (run) {
    runs.delete(scene.key);
    runs.set(scene.key, run);
  } else {
    run = build(scene);
    record(run);
    runs.set(scene.key, run);
    // A few scenes stay warm (A/B-ing a setting); the rest go.
    if (runs.size > 4) runs.delete(runs.keys().next().value!);
  }
  // Between two stored steps the pose is interpolated, never snapped: a
  // shutter's sub-samples sit a few ms apart (inside one 120 Hz step), and a
  // snapped read put every one on the same step — no smear — while a 25 fps
  // export stepped 5, 5, 5, 5, 4 and juddered. On a step it is the step.
  const f = Math.max(0, Math.min(MAX_STEPS, seconds * scene.timeScale * HZ));
  const n = Math.min(MAX_STEPS, Math.floor(f + 1e-9));
  const a = f - n > 1e-6 && n < MAX_STEPS ? f - n : 0;
  const last = a > 0 ? n + 1 : n;
  while (run.steps.length <= last) {
    step(run, (run.steps.length - 1) / HZ);
    record(run);
  }
  const row = run.steps[n]!, turn = run.turns[n]!;
  const row1 = run.steps[last]!, turn1 = run.turns[last]!;
  const out = new Map<string, SimPose>();
  const t = n / HZ;
  run.active.forEach(({ id, life }, i) => {
    // Only what is in the world then: before its layer starts and after it ends, nothing to place.
    if (!alive(life, t)) return;
    const o = i * 7;
    // A body that leaves before the next step is read on this one.
    const b = a > 0 && alive(life, last / HZ) ? a : 0;
    const at = (k: number) => row[o + k]! + (row1[o + k]! - row[o + k]!) * b;
    // nlerp along the short arc — at a 120 Hz step the turn between rows is small.
    const dot = row[o + 3]! * row1[o + 3]! + row[o + 4]! * row1[o + 4]! + row[o + 5]! * row1[o + 5]! + row[o + 6]! * row1[o + 6]!;
    const s1 = dot < 0 ? -1 : 1;
    const q = [3, 4, 5, 6].map((k) => row[o + k]! * (1 - b) + s1 * row1[o + k]! * b);
    const len = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!) || 1;
    out.set(id, {
      position: [at(0) / M, at(1) / M, at(2) / M],
      quaternion: [q[0]! / len, q[1]! / len, q[2]! / len, q[3]! / len],
      turn: turn[i]! + (turn1[i]! - turn[i]!) * b,
      ...(run.gone[i]! <= n && { gone: true }),
    });
  });
  return out;
}

/** Every hit in the first `seconds` of comp time after the start (`timeScale` applied), in order. */
export function simulateHits(scene: SimScene, seconds: number): SimHit[] {
  simulate(scene, seconds);
  const run = runs.get(scene.key)!;
  const until = Math.min(MAX_STEPS, Math.round(seconds * scene.timeScale * HZ)) / HZ;
  return run.hits.filter((h) => h.t <= until + 1e-9);
}

/** Drop every stored simulation (tests, memory pressure). */
export function clearSimulations(): void {
  runs.clear();
  particleReads.clear();
}

function vec(v: V3, k = 1): CANNON.Vec3 {
  return new CANNON.Vec3(v[0] * k, v[1] * k, v[2] * k);
}

/** The turn taking +Z onto `n` (a plane's normal). */
function quatTo(n: V3): CANNON.Quaternion {
  const q = new CANNON.Quaternion();
  q.setFromVectors(new CANNON.Vec3(0, 0, 1), vec(n).unit());
  return q;
}

function shapeOf(c: SimCollider): { shape: CANNON.Shape; offset: CANNON.Vec3 } {
  if (c.kind === "box") return { shape: new CANNON.Box(vec(c.half, M)), offset: vec(c.offset, M) };
  if (c.kind === "sphere") return { shape: new CANNON.Sphere(Math.max(1e-3, c.radius * M)), offset: vec(c.offset, M) };
  // A prism: the polygon at ±depth along its normal; faces wound outward.
  const n = c.points.length;
  const at = (p: readonly [number, number], s: number) =>
    new CANNON.Vec3(
      (p[0] * c.u[0] + p[1] * c.v[0] + s * c.normal[0]) * M,
      (p[0] * c.u[1] + p[1] * c.v[1] + s * c.normal[1]) * M,
      (p[0] * c.u[2] + p[1] * c.v[2] + s * c.normal[2]) * M,
    );
  // Around the piece's own centre: cannon wants each convex shape to hold its origin.
  const mid = c.points.reduce((m, p) => [m[0] + p[0] / n, m[1] + p[1] / n] as [number, number], [0, 0] as [number, number]);
  const centre = at(mid, 0);
  const vertices = [...c.points.map((p) => at(p, -c.depth).vsub(centre)), ...c.points.map((p) => at(p, c.depth).vsub(centre))];
  // u × v = normal for a right-handed plane: the polygon's own winding faces +normal.
  const handed = Math.sign(
    (c.u[1] * c.v[2] - c.u[2] * c.v[1]) * c.normal[0] + (c.u[2] * c.v[0] - c.u[0] * c.v[2]) * c.normal[1] + (c.u[0] * c.v[1] - c.u[1] * c.v[0]) * c.normal[2],
  ) || 1;
  const top = Array.from({ length: n }, (_, i) => n + i);
  const bottom = Array.from({ length: n }, (_, i) => n - 1 - i);
  const faces: number[][] = handed > 0 ? [top, bottom] : [top.slice().reverse(), bottom.slice().reverse()];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    faces.push(handed > 0 ? [i, j, n + j, n + i] : [n + i, n + j, j, i]);
  }
  return { shape: new CANNON.ConvexPolyhedron({ vertices, faces }), offset: (c.offset ? vec(c.offset, M) : new CANNON.Vec3()).vadd(centre) };
}

/**
 * A body that STARTS through the ground stands on it. A cube made at a world's
 * origin sits half under the floor; the solver resolved that overlap in one
 * step and fired it upward at thousands of units a second. Lifting it clear
 * before the first step is what anyone meant by "make it fall". A body wholly
 * below the plane is left where it is — that is not a resting mistake.
 */
function restOn(body: CANNON.Body, point: CANNON.Vec3, normal: CANNON.Vec3): void {
  let lo = Infinity, hi = -Infinity;
  const reach = (v: CANNON.Vec3) => {
    const d = v.vsub(point).dot(normal);
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  };
  body.shapes.forEach((shape, i) => {
    const at = body.position.vadd(body.quaternion.vmult(body.shapeOffsets[i]!));
    const turn = body.quaternion.mult(body.shapeOrientations[i]!);
    if (shape instanceof CANNON.Sphere) {
      const d = at.vsub(point).dot(normal);
      lo = Math.min(lo, d - shape.radius);
      hi = Math.max(hi, d + shape.radius);
      return;
    }
    const hull = shape instanceof CANNON.Box ? shape.convexPolyhedronRepresentation : shape instanceof CANNON.ConvexPolyhedron ? shape : null;
    for (const v of hull?.vertices ?? []) reach(at.vadd(turn.vmult(v)));
  });
  if (lo < 0 && hi > 0) body.position.vadd(normal.scale(-lo), body.position);
}

function build(scene: SimScene): Run {
  const world = new CANNON.World({ gravity: vec(scene.gravity, M) });
  world.allowSleep = false;
  (world.solver as CANNON.GSSolver).iterations = 12;
  if (scene.bodies.length > 12) world.broadphase = new CANNON.SAPBroadphase(world);
  for (const p of scene.planes) {
    const ground = new CANNON.Body({ mass: 0, material: new CANNON.Material({ friction: 1, restitution: 1 }) });
    ground.addShape(new CANNON.Plane());
    ground.position.copy(vec(p.point, M));
    ground.quaternion.copy(quatTo(p.normal));
    world.addBody(ground);
  }
  const bodies = new Map<string, CANNON.Body>();
  const run: Run = {
    world, active: [], animated: [], springs: [], drives: [], comings: [], constraints: [], fields: scene.fields, steps: [], turns: [], hits: [], ids: new Map(),
    particles: (scene.emitters ?? []).map((em) => ({ em, parent: null, died: null, struck: null, next: 0, owed: 0, burst: false, seen: 0, of: scene.bodies.some((b) => b.id === em.layer) ? em.layer : null, rides: null, live: [], born: [], lives: [], family: null, steps: [] })),
    particleOrder: [],
    gravity: scene.gravity,
    space: scene.emitters?.length ? new ParticleSpace() : null,
    guard: scene.guard === true,
    swallowed: new Set(),
    gone: [],
  };
  // Cannon fires `collide` once per pair as it starts touching, BEFORE the
  // solve — the velocities are still the approach, so the speed is the impact.
  const onCollide = (e: { body: CANNON.Body; target: CANNON.Body; contact: CANNON.ContactEquation }) => {
    const { bi, bj, ni, ri, rj } = e.contact;
    const speed = Math.abs(bj.velocity.vsub(bi.velocity).dot(ni)) / M;
    const a = run.ids.get(e.target), b = run.ids.get(e.body) ?? null;
    // Each pair dispatches on both bodies: keep the one from the lower id's side.
    if (a === undefined || (b !== null && b < a)) return;
    const t = run.steps.length / HZ;
    // A pair touching at several points this step is one hit, as hard as its hardest.
    for (let i = run.hits.length - 1; i >= 0 && run.hits[i]!.t === t; i--) {
      const h = run.hits[i]!;
      if (h.a === a && h.b === b) return void (h.speed = Math.max(h.speed, speed));
    }
    // `ni` leaves bi toward bj; spray leaves the still side toward the moving one.
    const moves = (x: CANNON.Body) => x.type === CANNON.Body.DYNAMIC;
    const glance = moves(bi) === moves(bj);
    const k = glance || moves(bj) ? 1 : -1;
    const l = Math.hypot(ni.x, ni.y) || 1;
    // Halfway between the two surfaces' points: a fast body has sunk in a step's worth.
    const x = (bi.position.x + ri.x + bj.position.x + rj.x) / (2 * M), y = (bi.position.y + ri.y + bj.position.y + rj.y) / (2 * M);
    run.hits.push({ t, a, b, speed, x, y, nx: (k * ni.x) / l, ny: (k * ni.y) / l, ...(glance && { glance: true }) });
  };
  for (const b of scene.bodies) {
    const body = new CANNON.Body({
      mass: b.type === "active" ? b.mass : 0,
      type: b.type === "animated" ? CANNON.Body.KINEMATIC : b.type === "passive" ? CANNON.Body.STATIC : CANNON.Body.DYNAMIC,
      material: new CANNON.Material({ friction: b.friction, restitution: b.bounce }),
      linearDamping: b.damping,
      angularDamping: b.damping,
    });
    for (const c of b.colliders) {
      const { shape, offset } = shapeOf(c);
      body.addShape(shape, offset);
    }
    run.ids.set(body, b.id);
    body.addEventListener("collide", onCollide);
    body.position.copy(vec(b.position, M));
    body.quaternion.set(...b.quaternion);
    if (b.type === "active") for (const p of scene.planes) restOn(body, vec(p.point, M), vec(p.normal).unit());
    if (b.planar) {
      body.linearFactor.set(1, 1, 0);
      body.angularFactor.set(0, 0, 1);
    }
    const life = b.life ?? ALWAYS;
    if (b.type === "active") {
      body.velocity.copy(vec(b.velocity, M));
      body.angularVelocity.set(...(b.spin.map((d) => (d * Math.PI) / 180) as V3));
      run.active.push({ id: b.id, body, mass: b.mass, planar: b.planar, life });
      run.gone.push(Infinity);
    }
    if (b.type === "animated" && b.animate) run.animated.push({ body, animate: b.animate });
    if (b.type === "active" && b.follow && b.follow.strength > 0) run.drives.push(followSpring(body, b.follow, b.planar));
    if (life !== ALWAYS) run.comings.push({ body, life });
    if (alive(life, 0)) world.addBody(body);
    bodies.set(b.id, body);
  }
  for (const pr of run.particles) {
    const body = bodies.get(pr.em.layer);
    if (body?.type === CANNON.Body.DYNAMIC) pr.rides = { body, from: null };
    const up = pr.em.parent !== undefined ? run.particles[pr.em.parent] : undefined;
    if (up && up !== pr) {
      pr.parent = up;
      pr.family = [];
      up.died ??= [];
      up.struck ??= [];
    }
  }
  // Parents first. The scene's builder refuses loops; a depth past the list is one anyway, and steps last.
  const depth = (pr: ParticleRun) => {
    let d = 0;
    for (let p = pr.parent; p && d <= run.particles.length; p = p.parent) d++;
    return d;
  };
  run.particleOrder = run.particles.map((pr, i) => ({ pr, d: depth(pr), i })).sort((a, b) => a.d - b.d || a.i - b.i).map((x) => x.pr);
  // The comp as a body, for joints that hold something in the air.
  const anchorOf = (id: string | null): CANNON.Body => {
    if (id && bodies.has(id)) return bodies.get(id)!;
    const fixed = new CANNON.Body({ mass: 0, type: CANNON.Body.STATIC });
    world.addBody(fixed);
    return fixed;
  };
  for (const j of scene.joints) {
    const a = bodies.get(j.a);
    if (!a) continue;
    const b = anchorOf(j.b);
    const pa = vec(j.anchorA, M), pb = vec(j.anchorB, M);
    if (j.type === "pin" || j.type === "weld") {
      const c = j.type === "pin" ? new CANNON.PointToPointConstraint(a, pa, b, pb) : new CANNON.LockConstraint(a, b);
      run.constraints.push({ c, a, b });
      if (inWorld(a) && inWorld(b)) world.addConstraint(c);
      if (j.type === "pin" && j.hinge) run.drives.push(hinge(a, b, j.hinge, pa.length()));
      if (j.type === "pin" && j.ball) run.drives.push(ball(a, b, j.ball, pa.length()));
    } else {
      const wa = a.pointToWorldFrame(pa), wb = b.pointToWorldFrame(pb);
      const rest = j.length !== null ? j.length * M : wa.distanceTo(wb);
      const m = (a.mass + (b.mass || a.mass)) / 2 || 1;
      if (j.type === "spring") {
        const spring = new CANNON.Spring(a, b, { localAnchorA: pa, localAnchorB: pb, restLength: rest, stiffness: j.stiffness * m, damping: j.damping * m });
        run.springs.push(() => inWorld(a) && inWorld(b) && spring.applyForce());
      } else {
        // A rope pulls only when taut: a very stiff spring that lets go when slack.
        const spring = new CANNON.Spring(a, b, { localAnchorA: pa, localAnchorB: pb, restLength: rest, stiffness: 4000 * m, damping: 40 * m });
        run.springs.push(() => {
          if (inWorld(a) && inWorld(b) && a.pointToWorldFrame(pa).distanceTo(b.pointToWorldFrame(pb)) > rest) spring.applyForce();
        });
      }
    }
  }
  return run;
}

/** Bodies arriving at `t` enter where they start; bodies whose layer has ended leave; joints follow their ends. */
function arrive(run: Run, t: number): void {
  let changed = false;
  for (const { body, life } of run.comings) {
    const want = alive(life, t) && !run.swallowed.has(body);
    if (want === inWorld(body)) continue;
    if (want) run.world.addBody(body);
    else run.world.removeBody(body);
    changed = true;
  }
  if (!changed) return;
  holdConstraints(run);
}

/** Constraints hold only while both ends are in the world. */
function holdConstraints(run: Run): void {
  for (const { c, a, b } of run.constraints) {
    const want = inWorld(a) && inWorld(b);
    const has = run.world.constraints.includes(c);
    if (want && !has) run.world.addConstraint(c);
    else if (!want && has) run.world.removeConstraint(c);
  }
}

type Hole = NonNullable<ReturnType<typeof fieldHorizon>>;

/**
 * Did the step from A to B pass within a horizon? SWEPT, never sampled at the
 * step's end: near a heavy well a particle falls at √(2GM/r) — thousands of
 * units/s, more than a small horizon's diameter per 120 Hz step — and an
 * end-point test let it jump clean across the hole and slingshot out. The
 * segment's closest approach to the centre is what counts (the idea
 * particle-space uses for surfaces).
 */
function crossesHorizon(h: Hole, ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len2 = dx * dx + dy * dy + dz * dz;
  const u = len2 > 1e-12 ? Math.max(0, Math.min(1, ((h.x - ax) * dx + (h.y - ay) * dy + (h.z - az) * dz) / len2)) : 0;
  const cx = ax + dx * u - h.x, cy = ay + dy * u - h.y, cz = az + dz * u - h.z;
  return cx * cx + cy * cy + cz * cz < h.r2;
}

/**
 * Every active body whose centre passed within a horizon this step (swept from
 * where it was, `from`, to where it is) leaves for good — the cleanest model
 * of "swallowed": no contact, no joint, no field reads it again, and the layer
 * is hidden from this step on (`SimPose.gone`). The crossing is its CENTRE's:
 * a lens's shadow (2.6× the horizon) hides the moment anyway.
 */
function swallow(run: Run, holes: Hole[], from: Float64Array): void {
  let changed = false;
  run.active.forEach(({ body }, i) => {
    if (!inWorld(body)) return;
    const x = body.position.x / M, y = body.position.y / M, z = body.position.z / M;
    const o = i * 3;
    if (!holes.some((h) => crossesHorizon(h, from[o]!, from[o + 1]!, from[o + 2]!, x, y, z))) return;
    run.world.removeBody(body);
    run.swallowed.add(body);
    run.gone[i] = run.steps.length;
    changed = true;
  });
  if (changed) holdConstraints(run);
}

/** The most a body may travel in one solver step, as a share of its radius: past it, a thin wall can be skipped. */
const TRAVEL_PER_STEP = 0.75;
/** Substeps a step may split into — a ball at 8× the safe speed still cannot tunnel. */
const MAX_SUBSTEPS = 8;

/**
 * How many solver steps this step needs so no active body moves more than
 * {@link TRAVEL_PER_STEP} of its radius in one — the guard against tunnelling
 * (a 16 px ball falling at 1400 px/s covers 12 px a step at 120 Hz and passes a
 * 12 px edge collider). 1 for every calm step, so it costs only when it saves.
 */
function substeps(run: Run, dt: number): number {
  let need = 1;
  for (const { body } of run.active) {
    if (!inWorld(body) || body.boundingRadius <= 0) continue;
    const travel = body.velocity.length() * dt;
    need = Math.max(need, Math.ceil(travel / (TRAVEL_PER_STEP * body.boundingRadius)));
  }
  return Math.min(MAX_SUBSTEPS, need);
}

function step(run: Run, t: number): void {
  const dt = 1 / HZ;
  if (run.comings.length) arrive(run, t);
  for (const { body, animate } of run.animated) {
    if (!inWorld(body)) continue;
    // Where its keys put it next step, with the velocity that gets it there (so contacts push).
    const now = animate(t), next = animate(t + dt);
    body.position.set(now.position[0] * M, now.position[1] * M, now.position[2] * M);
    body.quaternion.set(...now.quaternion);
    body.velocity.set(((next.position[0] - now.position[0]) * M) / dt, ((next.position[1] - now.position[1]) * M) / dt, ((next.position[2] - now.position[2]) * M) / dt);
  }
  const placed = run.fields.length ? run.fields.map((f) => f(t)).filter((f): f is FieldAt => !!f) : [];
  if (placed.length) {
    for (const { body, mass } of run.active) {
      if (!inWorld(body)) continue;
      const p: V3 = [body.position.x / M, body.position.y / M, body.position.z / M];
      const v: V3 = [body.velocity.x / M, body.velocity.y / M, body.velocity.z / M];
      let ax = 0, ay = 0, az = 0;
      for (const f of placed) {
        const a = fieldAcceleration(f, p, v, t);
        ax += a[0], ay += a[1], az += a[2];
      }
      if (ax || ay || az) body.applyForce(new CANNON.Vec3(ax * mass * M, ay * mass * M, az * mass * M));
    }
  }
  for (const s of run.springs) s();
  for (const d of run.drives) d(t);
  const holes = placed.length ? placed.map(fieldHorizon).filter((h): h is Hole => !!h) : NO_HOLES;
  // Where each body starts the step, so a horizon is swept, not sampled.
  const from = holes.length ? new Float64Array(run.active.length * 3) : null;
  if (from) run.active.forEach(({ body }, i) => from.set([body.position.x / M, body.position.y / M, body.position.z / M], i * 3));
  const n = run.guard ? substeps(run, dt) : 1;
  for (let k = 0; k < n; k++) run.world.step(dt / n);
  if (from) swallow(run, holes, from);
  // Particles after the bodies: they meet them where this step left them.
  if (run.space) {
    let built = false;
    const space = () => {
      if (!built) run.space!.rebuild(run.world), (built = true);
      return run.space!;
    };
    for (const pr of run.particleOrder) stepParticles(run, pr, t, placed, holes, space);
  }
}

const NO_HOLES: Hole[] = [];

// ── Particles ───────────────────────────────────────────────────────────────

/** A seeded 0..1 per (seed, particle, channel) — the same particle is the same every run. */
function rand(seed: number, i: number, k: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(i + 1, 0xc2b2ae35) ^ Math.imul(k + 7, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** The per-particle randoms, by channel — one table, so a reader drawing a particle asks the same numbers the run used. */
export const PARTICLE_RAND = { u: 0, v: 1, aim: 2, speed: 3, life: 4, size: 5, hue: 6, spin: 7, sub: 8, depth: 9 } as const;
/** Numbers per particle in `SimParticles.data`. */
export const PARTICLE_STRIDE = 8;
export function particleRand(seed: number, i: number, k: number): number {
  return rand(seed, i, k);
}

/** A particle's speed seen flat when it was thrown in 3D (`sphere`): the sine of a uniform elevation — a sphere's shell, projected. */
function flat3d(s: EmitterSpec, seed: number, i: number): number {
  if (!s.sphere) return 1;
  const c = rand(seed, i, PARTICLE_RAND.depth) * 2 - 1;
  return Math.sqrt(1 - c * c);
}

/**
 * One step of one emitter's particles: births, then every live one pushed by
 * gravity × weight, the fields and its air, swept from where it is to where
 * it is going (a ray, so a fast spark cannot pass a hairline wall), bounced
 * off whatever it meets. One way: a particle never pushes a body.
 */
function stepParticles(run: Run, pr: ParticleRun, t: number, fields: FieldAt[], holes: Hole[], space: () => ParticleSpace): void {
  const dt = 1 / HZ;
  // Last step's deaths and hits have been thrown from (children step after their parent).
  if (pr.died) pr.died.length = 0;
  if (pr.struck) pr.struck.length = 0;
  // A carrier a horizon swallowed gives off nothing more.
  const on = (!pr.em.life || alive(pr.em.life, t)) && !(pr.rides && run.swallowed.has(pr.rides.body));
  const here = on ? ridden(pr, pr.em.at(t)) : null;
  if (here && here.spec.enabled) {
    const s = here.spec;
    let n = 0;
    if (s.type === "hit") hitBursts(run, pr, s, t);
    else if (s.type === "sub") subBursts(pr, s, t);
    else if (s.type === "burst") {
      if (!pr.burst) (n = s.count), (pr.burst = true);
    } else {
      // The first one leaves as the stream starts — a slow stream (a shell a second) never opens on a wait.
      if (!pr.burst && s.rate > 0) (pr.owed += 1), (pr.burst = true);
      pr.owed += Math.max(0, s.rate) * dt;
      n = Math.floor(pr.owed);
      pr.owed -= n;
    }
    n = Math.min(n, MAX_PARTICLES - pr.live.length);
    for (let j = 0; j < n; j++) {
      const i = pr.next++;
      const R = (k: number) => rand(s.seed, i, k);
      const wander = (k: number) => 1 + (R(k) * 2 - 1) * s.variance;
      const [x, y] = s.source === "point" ? here.origin : here.place(R(PARTICLE_RAND.u), R(PARTICLE_RAND.v));
      const { aim: way, speed: launched } = launchOf(s, here, x, y, fields);
      const aim = way + (R(PARTICLE_RAND.aim) - 0.5) * ((s.spread * Math.PI) / 180);
      const speed = launched * wander(PARTICLE_RAND.speed) * (s.launch === "orbit" ? 1 : flat3d(s, s.seed, i));
      // Born spread through the step, not stacked at its start: a fast stream is a line, not beads.
      const ahead = s.type === "stream" ? R(PARTICLE_RAND.sub) * dt : 0;
      const vx = Math.cos(aim) * speed, vy = Math.sin(aim) * speed;
      pr.live.push({ i, x: x + vx * ahead, y: y + vy * ahead, vx, vy, r: (s.size * Math.max(0.2, 1 + (R(PARTICLE_RAND.size) * 2 - 1) * s.variance * 0.5)) / 2 });
      pr.born[i] = t - ahead;
      pr.lives[i] = s.life * Math.max(0.1, 1 + (R(PARTICLE_RAND.life) * 2 - 1) * s.variance * 0.5);
    }
  }
  if (!pr.live.length) return;
  const spec = here?.spec ?? pr.em.at(Math.min(t, pr.em.life?.to ?? t))?.spec ?? null;
  if (!spec) return void (pr.live = []);
  const g = run.gravity, w = spec.weight;
  const air = spec.drag > 0 ? Math.pow(1 - Math.min(0.999, spec.drag), dt) : 1;
  const died = pr.died;
  // Compacted in place: the survivors keep their order (index order — what a read merges on).
  let kept = 0;
  const live = pr.live;
  for (let q = 0; q < live.length; q++) {
    const p = live[q]!;
    if (Math.abs(p.x) > 1e5 || Math.abs(p.y) > 1e5) continue;
    if (t + dt - pr.born[p.i]! >= pr.lives[p.i]!) {
      died?.push(p.i, p.x, p.y, p.vx, p.vy, 0, 0);
      continue;
    }
    live[kept++] = p;
    let ax = g[0] * w, ay = g[1] * w;
    for (const f of fields) {
      const a = fieldAcceleration(f, [p.x, p.y, 0], [p.vx, p.vy, 0], t);
      ax += a[0], ay += a[1];
    }
    p.vx = (p.vx + ax * dt) * air;
    p.vy = (p.vy + ay * dt) * air;
    const mx = p.vx * dt, my = p.vy * dt;
    const len = Math.hypot(mx, my);
    if (spec.collide && len > 1e-6) {
      // Swept from its centre to its leading edge's next place.
      const reach = (len + p.r) / len;
      const h = space().sweep(p.x, p.y, mx * reach, my * reach);
      if (h) {
        bounceOff(run, pr, p, spec, h);
        continue;
      }
    }
    // Across a horizon it is gone — swept over the whole step, and silently:
    // nothing it would throw on dying gets out.
    if (holes.length && holes.some((h) => crossesHorizon(h, p.x, p.y, h.z, p.x + mx, p.y + my, h.z))) {
      kept--;
      continue;
    }
    p.x += mx;
    p.y += my;
  }
  live.length = kept;
}

/**
 * The way a particle born at (x, y) leaves, before its spread, and how fast
 * (before its variance): along the layer's aim; sideways at the circular speed
 * of the strongest well there (× `orbit`, its sign the way round — the well
 * that pulls hardest is the nearest heavy one); or straight toward or away
 * from the layer's origin. Born on the origin, inward and outward fall back to
 * the aim; with no well, an orbit circles the origin at `speed`.
 */
function launchOf(s: EmitterSpec, here: { origin: [number, number]; angle: number }, x: number, y: number, fields: FieldAt[]): { aim: number; speed: number } {
  if (s.launch === "inward" || s.launch === "outward") {
    const dx = x - here.origin[0], dy = y - here.origin[1];
    if (Math.hypot(dx, dy) < 1e-6) return { aim: here.angle, speed: s.speed };
    return { aim: Math.atan2(dy, dx) + (s.launch === "inward" ? Math.PI : 0), speed: s.speed };
  }
  if (s.launch !== "orbit") return { aim: here.angle, speed: s.speed };
  let best: FieldAt | null = null, pull = 0;
  for (const f of fields) {
    if (f.spec.type !== "gravity" || !f.spec.enabled || f.spec.mass <= 0) continue;
    const d2 = (x - f.origin[0]) ** 2 + (y - f.origin[1]) ** 2;
    const g = wellGM(f.spec) / (d2 + f.spec.core * f.spec.core);
    if (g > pull) (pull = g), (best = f);
  }
  const cx = best ? best.origin[0] : here.origin[0], cy = best ? best.origin[1] : here.origin[1];
  const r = Math.hypot(x - cx, y - cy);
  const turn = s.orbit < 0 ? -1 : 1;
  // Clockwise on screen (y down) is the radius turned +90°.
  const aim = r < 1e-6 ? here.angle : Math.atan2(y - cy, x - cx) + (turn * Math.PI) / 2;
  return { aim, speed: Math.abs(s.orbit) * (best ? circularSpeed(best.spec, r) : s.speed) };
}

/** An emitter's placement where its carrying body is now (its keys' placement when it rides none). */
function ridden(pr: ParticleRun, here: ReturnType<SimEmitter["at"]>): ReturnType<SimEmitter["at"]> {
  const r = pr.rides;
  if (!here || !r || !inWorld(r.body)) return here;
  const b = r.body;
  const x = b.position.x / M, y = b.position.y / M, turn = 2 * Math.atan2(b.quaternion.z, b.quaternion.w);
  if (!r.from) r.from = { origin: here.origin, angle: here.angle, place: here.place, x, y, turn };
  const f = r.from;
  const d = turn - f.turn, c = Math.cos(d), s = Math.sin(d);
  const map = ([px, py]: [number, number]): [number, number] => [x + (px - f.x) * c - (py - f.y) * s, y + (px - f.x) * s + (py - f.y) * c];
  return { spec: here.spec, origin: map(f.origin), angle: f.angle + d, place: (u, v) => map(f.place(u, v)) };
}

/** A closing speed this hard throws a `hit` emitter's whole `count` at its full `speed`. */
const HARD_HIT = 1200;

/**
 * A `hit` emitter's births this step: a burst at each new contact it answers,
 * from the contact, fanned about the way off the surface (or along it both
 * ways, for two moving bodies) — `count` and `speed` at a hard hit, fewer and
 * slower for a soft one, nothing under `threshold`. Particle hits never count:
 * sparks do not throw sparks.
 */
function hitBursts(run: Run, pr: ParticleRun, s: EmitterSpec, t: number): void {
  // This step's hits only: an emitter switched on later does not answer old ones.
  const now = run.steps.length / HZ;
  for (; pr.seen < run.hits.length; pr.seen++) {
    const h = run.hits[pr.seen]!;
    if (h.particle !== undefined || h.x === undefined || Math.abs(h.t - now) > 1e-9) continue;
    if (h.speed < Math.max(REST_SPEED, s.threshold)) continue;
    if (pr.of !== null && h.a !== pr.of && h.b !== pr.of) continue;
    const hard = Math.min(1, h.speed / HARD_HIT);
    const n = Math.min(MAX_PARTICLES - pr.live.length, Math.max(1, Math.round(s.count * hard)));
    const out = Math.atan2(h.ny!, h.nx!);
    for (let j = 0; j < n; j++) {
      const i = pr.next++;
      const R = (k: number) => rand(s.seed, i, k);
      // Two moving bodies glance: along the contact, half each way.
      const base = h.glance ? out + (i % 2 ? 0.5 : -0.5) * Math.PI : out;
      const aim = base + (R(PARTICLE_RAND.aim) - 0.5) * ((s.spread * Math.PI) / 180);
      const speed = s.speed * (0.35 + 0.65 * hard) * (1 + (R(PARTICLE_RAND.speed) * 2 - 1) * s.variance) * flat3d(s, s.seed, i);
      const r = (s.size * Math.max(0.2, 1 + (R(PARTICLE_RAND.size) * 2 - 1) * s.variance * 0.5)) / 2;
      // Born just off the surface, so the first sweep does not meet it.
      pr.live.push({ i, x: h.x! + h.nx! * (h.glance ? 0 : r + 0.5), y: h.y! + h.ny! * (h.glance ? 0 : r + 0.5), vx: Math.cos(aim) * speed, vy: Math.sin(aim) * speed, r });
      pr.born[i] = t;
      pr.lives[i] = s.life * Math.max(0.1, 1 + (R(PARTICLE_RAND.life) * 2 - 1) * s.variance * 0.5);
    }
  }
}

/**
 * A sub-emitter's births this step: `count` from each of its parent's
 * particles that died (fanned about the way it was going — 360 is a sphere)
 * or hit something (fanned off the surface), carrying `inherit` of its motion.
 * Each remembers which parent particle it came from (`family`): one colour per
 * shell. A sub never answers its own particles — its parent chain has no loop.
 */
function subBursts(pr: ParticleRun, s: EmitterSpec, t: number): void {
  const from = s.on === "hit" ? pr.parent?.struck : pr.parent?.died;
  if (!from?.length) return;
  for (let e = 0; e < from.length; e += 7) {
    const [pi, x, y, pvx, pvy, nx, ny] = [from[e]!, from[e + 1]!, from[e + 2]!, from[e + 3]!, from[e + 4]!, from[e + 5]!, from[e + 6]!];
    const hit = s.on === "hit";
    const out = hit ? Math.atan2(ny, nx) : Math.hypot(pvx, pvy) > 1e-6 ? Math.atan2(pvy, pvx) : -Math.PI / 2;
    const n = Math.min(s.count, MAX_PARTICLES - pr.live.length);
    for (let j = 0; j < n; j++) {
      const i = pr.next++;
      const R = (k: number) => rand(s.seed, i, k);
      const aim = out + (R(PARTICLE_RAND.aim) - 0.5) * ((s.spread * Math.PI) / 180);
      const speed = s.speed * (1 + (R(PARTICLE_RAND.speed) * 2 - 1) * s.variance) * flat3d(s, s.seed, i);
      const r = (s.size * Math.max(0.2, 1 + (R(PARTICLE_RAND.size) * 2 - 1) * s.variance * 0.5)) / 2;
      // Off a surface: born just clear of it, so the first sweep does not meet it.
      const off = hit ? r + 0.5 : 0;
      pr.live.push({ i, x: x + nx * off, y: y + ny * off, vx: Math.cos(aim) * speed + pvx * s.inherit, vy: Math.sin(aim) * speed + pvy * s.inherit, r });
      pr.born[i] = t;
      pr.lives[i] = s.life * Math.max(0.1, 1 + (R(PARTICLE_RAND.life) * 2 - 1) * s.variance * 0.5);
      pr.family![i] = pi;
    }
  }
}

/** A particle meeting a surface: placed against it, its motion relative to it reflected and rubbed, the hit logged. */
function bounceOff(run: Run, pr: ParticleRun, p: Particle, spec: EmitterSpec, hit: SpaceHit): void {
  const b = hit.body;
  const { nx, ny } = hit;
  const hx = hit.x, hy = hit.y;
  // The surface's own motion there (a kicked paddle bats a particle).
  const rx = b ? hx - b.position.x / M : 0, ry = b ? hy - b.position.y / M : 0;
  const sx = b ? b.velocity.x / M - b.angularVelocity.z * ry : 0, sy = b ? b.velocity.y / M + b.angularVelocity.z * rx : 0;
  let ux = p.vx - sx, uy = p.vy - sy;
  const vn = ux * nx + uy * ny;
  if (vn < 0) {
    const tx = ux - vn * nx, ty = uy - vn * ny;
    const out = -vn * spec.bounce;
    const n = out < REST_SPEED ? 0 : out;
    const keepT = 1 - spec.friction * (n === 0 ? 1 : 0.5);
    ux = tx * keepT + nx * n;
    uy = ty * keepT + ny * n;
    p.vx = ux + sx;
    p.vy = uy + sy;
    // A hit emitter's particles are quiet: the hit that threw them already rang.
    if (-vn >= REST_SPEED && spec.type !== "hit") run.hits.push({ t: run.steps.length / HZ, a: pr.em.layer, b: (b && run.ids.get(b)) ?? null, speed: -vn, particle: p.i });
  }
  p.x = hx + nx * p.r;
  p.y = hy + ny * p.r;
  // A sub-emitter on hit throws from here: any real hit, a quiet one too (a hit emitter's spark can pop).
  if (vn < 0 && -vn >= REST_SPEED) pr.struck?.push(p.i, p.x, p.y, p.vx, p.vy, nx, ny);
}

/** One emitter's particles at an instant, for drawing: per particle its index, place, velocity, age and life. */
export interface SimParticles {
  layer: string;
  index: number;
  /** Per particle, `PARTICLE_STRIDE` (8) numbers: index, x, y, vx, vy, age (s), life (s), family (the parent particle a sub-emitter's particle came from; its own index otherwise). */
  data: Float32Array;
  count: number;
}

/**
 * Every emitter's particles `seconds` of comp time after the start
 * (`timeScale` applied) — between two stored steps, matched by index and
 * interpolated, so a shutter or a 25 fps export reads them smooth.
 */
export function simulateParticles(scene: SimScene, seconds: number): SimParticles[] {
  if (!scene.emitters?.length) return [];
  // Every carrier in a frame asks for the same instant: read it once.
  const memoKey = `${seconds}|${scene.key}`;
  const memo = particleReads.get(memoKey);
  if (memo) return memo;
  const out = readParticles(scene, seconds);
  if (particleReads.size >= 8) particleReads.delete(particleReads.keys().next().value!);
  particleReads.set(memoKey, out);
  return out;
}

const particleReads = new Map<string, SimParticles[]>();

function readParticles(scene: SimScene, seconds: number): SimParticles[] {
  // One step past the instant too: a particle born on it takes its velocity from where it goes next.
  simulate(scene, seconds + 1 / (HZ * scene.timeScale));
  const run = runs.get(scene.key)!;
  const f = Math.max(0, Math.min(MAX_STEPS, seconds * scene.timeScale * HZ));
  const n = Math.min(run.particles[0]!.steps.length - 1, Math.floor(f + 1e-9));
  const a = f - n > 1e-6 ? f - n : 0;
  const t = (n + a) / HZ;
  const S = PARTICLE_STRIDE;
  return run.particles.map((pr) => {
    const r0 = pr.steps[n] ?? EMPTY_ROW;
    const r1 = pr.steps[a > 0 ? n + 1 : n] ?? r0;
    const prev = n > 0 ? pr.steps[n - 1]! : EMPTY_ROW;
    const ahead = pr.steps[n + 1] ?? EMPTY_ROW;
    const out = new Float32Array((r0.length / 3) * S);
    const fam = pr.family;
    // Every row is in index order: one merge walk over the neighbours, never a search per particle.
    let k = 0, j = 0, q = 0, z = 0;
    for (let o = 0; o < r0.length; o += 3) {
      const i = r0[o]!;
      while (j < r1.length && r1[j]! < i) j += 3;
      while (q < prev.length && prev[q]! < i) q += 3;
      while (z < ahead.length && ahead[z]! < i) z += 3;
      const there = j < r1.length && r1[j] === i;
      const x0 = r0[o + 1]!, y0 = r0[o + 2]!;
      // Its velocity from the step it moves across (or the one it came from, at its death; or the next, just born).
      let vx = 0, vy = 0;
      if (there) (vx = (r1[j + 1]! - x0) * HZ), (vy = (r1[j + 2]! - y0) * HZ);
      if (!there || a === 0) {
        if (q < prev.length && prev[q] === i) (vx = (x0 - prev[q + 1]!) * HZ), (vy = (y0 - prev[q + 2]!) * HZ);
        else if (z < ahead.length && ahead[z] === i) (vx = (ahead[z + 1]! - x0) * HZ), (vy = (ahead[z + 2]! - y0) * HZ);
      }
      const b = there ? a : 0;
      out[k] = i;
      out[k + 1] = x0 + (there ? (r1[j + 1]! - x0) * b : 0);
      out[k + 2] = y0 + (there ? (r1[j + 2]! - y0) * b : 0);
      out[k + 3] = vx;
      out[k + 4] = vy;
      out[k + 5] = Math.max(0, t - pr.born[i]!);
      out[k + 6] = pr.lives[i]!;
      out[k + 7] = fam ? (fam[i] ?? i) : i;
      k += S;
    }
    return { layer: pr.em.layer, index: pr.em.index, data: out, count: k / S };
  });
}

const EMPTY_ROW = new Float32Array(0);

// ── Springs on angles and poses ─────────────────────────────────────────────

/** A spring's natural frequency (rad/s) and damping ratio for a 0..1 strength: loose and bouncy low, stiff and settled high. */
function springOf(strength: number): { w: number; zeta: number } {
  const s = Math.max(0, Math.min(1, strength));
  return { w: 2 * Math.PI * (0.6 + 6 * s * s), zeta: 0.3 + 0.5 * s };
}

const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/** A planar hinge: limits that stop A turning past them relative to B, and a drive toward a target relative angle. */
function hinge(a: CANNON.Body, b: CANNON.Body, h: NonNullable<SimJoint["hinge"]>, arm: number): (t: number) => void {
  const drive = h.drive ? springOf(h.drive.strength) : null;
  return (t) => {
    if (!inWorld(a) || !inWorld(b) || a.type !== CANNON.Body.DYNAMIC) return;
    const rel = wrap(zAngle(a.quaternion) - zAngle(b.quaternion));
    const relW = a.angularVelocity.z - b.angularVelocity.z;
    // It turns about the pin, not its mass centre: the inertia it has there.
    const I = (a.inertia.z || 0) + a.mass * arm * arm || 1e-6;
    let torque = 0;
    if (drive && h.drive) {
      const err = (wrap(h.drive.target(t) - rel) * Math.PI) / 180;
      torque += I * (drive.w * drive.w * err - 2 * drive.zeta * drive.w * relW);
    }
    if (h.limit) {
      const [lo, hi] = h.limit[0] <= h.limit[1] ? h.limit : [h.limit[1], h.limit[0]];
      // Past a stop: no further that way, and pushed back inside.
      const over = rel > hi ? rel - hi : rel < lo ? rel - lo : 0;
      if (over !== 0) {
        // A stop is a wall, not a spring: no further that way, and eased back inside, critically damped.
        const out = Math.sign(relW) === Math.sign(over) ? relW : 0;
        a.angularVelocity.z -= out;
        const w = 2 * Math.PI * 8;
        torque -= I * (w * w * ((over * Math.PI) / 180) + 2 * w * (relW - out));
      }
    }
    if (torque) {
      a.torque.z += torque;
      if (b.type === CANNON.Body.DYNAMIC) b.torque.z -= torque;
    }
  };
}

/** A unit quaternion's inverse. */
export const conj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
const qOf = (q: CANNON.Quaternion): Quat => [q.x, q.y, q.z, q.w];

/** A unit quaternion as a rotation matrix (column-major 4×4). */
function quatMatrix([x, y, z, w]: Quat): Mat4 {
  return [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y), 0, 2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x), 0, 2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y), 0, 0, 0, 0, 1];
}

/** A rotation matrix as a unit quaternion. */
export function matrixQuat(m: Mat4): Quat {
  const m00 = m[0]!, m10 = m[1]!, m20 = m[2]!, m01 = m[4]!, m11 = m[5]!, m21 = m[6]!, m02 = m[8]!, m12 = m[9]!, m22 = m[10]!;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    return [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
}

/**
 * A spatial joint's stops: A's turn relative to B, as the bone's own channels,
 * clamped to their limits; past a stop, a critically damped torque (about the
 * pin) turns it back to the nearest allowed pose.
 */
function ball(a: CANNON.Body, b: CANNON.Body, j: NonNullable<SimJoint["ball"]>, arm: number): (t: number) => void {
  const w = 2 * Math.PI * 8;
  const ranges: Array<[0 | 1 | 2, [number, number] | undefined]> = [[0, j.limits.rotationX], [1, j.limits.rotationY], [2, j.limits.rotation]];
  return () => {
    if (!inWorld(a) || !inWorld(b) || a.type !== CANNON.Body.DYNAMIC) return;
    const qa = qOf(a.quaternion), qb = qOf(b.quaternion);
    const pose = qmul(conj(j.zero), qmul(conj(qb), qa));
    const e = eulerFromRotation(quatMatrix(pose));
    let clamped = false;
    for (const [i, r] of ranges) {
      if (!r) continue;
      const lo = Math.min(r[0], r[1]), hi = Math.max(r[0], r[1]);
      const v = e[i]!;
      if (v < lo || v > hi) (e[i] = v < lo ? lo : hi), (clamped = true);
    }
    if (!clamped) return;
    const want = qmul(qb, qmul(j.zero, matrixQuat(rotation4(e[0]!, e[1]!, e[2]!))));
    let [ex, ey, ez, ew] = qmul(want, conj(qa));
    if (ew < 0) (ex = -ex), (ey = -ey), (ez = -ez), (ew = -ew);
    const sn = Math.hypot(ex, ey, ez);
    if (sn < 1e-9) return;
    const ang = 2 * Math.atan2(sn, ew);
    const ax = [ex / sn, ey / sn, ez / sn];
    const rw = [a.angularVelocity.x - b.angularVelocity.x, a.angularVelocity.y - b.angularVelocity.y, a.angularVelocity.z - b.angularVelocity.z];
    const I = [a.inertia.x, a.inertia.y, a.inertia.z].map((v) => v + a.mass * arm * arm);
    const tq = new CANNON.Vec3(...([0, 1, 2].map((i) => I[i]! * (w * w * ang * ax[i]! - 2 * w * rw[i]!)) as [number, number, number]));
    a.torque.vadd(tq, a.torque);
    if (b.type === CANNON.Body.DYNAMIC) b.torque.vsub(tq, b.torque);
  };
}

/** Hamilton product a · b of [x, y, z, w] quaternions. */
export function qmul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** A body pulled toward its animated pose: a damped spring on where it is and how it is turned. */
function followSpring(body: CANNON.Body, f: NonNullable<SimBody["follow"]>, planar: boolean): (t: number) => void {
  const { w, zeta } = springOf(f.strength);
  const dt = 1 / HZ;
  return (t) => {
    if (!inWorld(body)) return;
    const now = f.target(t), next = f.target(t + dt);
    const m = body.mass;
    for (let i = 0; i < 3; i++) {
      if (planar && i === 2) continue;
      const k = (["x", "y", "z"] as const)[i]!;
      const err = now.position[i]! * M - body.position[k];
      const vT = ((next.position[i]! - now.position[i]!) * M) / dt;
      body.force[k] += m * (w * w * err + 2 * zeta * w * (vT - body.velocity[k]));
    }
    // The turn that takes the body to its target (target · current⁻¹), as an axis × angle.
    const q = body.quaternion;
    let [ex, ey, ez, ew] = qmul(now.quaternion, [-q.x, -q.y, -q.z, q.w]);
    if (ew < 0) (ex = -ex), (ey = -ey), (ez = -ez), (ew = -ew);
    const s = Math.hypot(ex, ey, ez);
    const ang = 2 * Math.atan2(s, ew);
    const ax = s > 1e-9 ? [ex / s, ey / s, ez / s] : [0, 0, 0];
    const I = body.inertia;
    const tq = [I.x * (w * w * ang * ax[0]! - 2 * zeta * w * body.angularVelocity.x), I.y * (w * w * ang * ax[1]! - 2 * zeta * w * body.angularVelocity.y), I.z * (w * w * ang * ax[2]! - 2 * zeta * w * body.angularVelocity.z)];
    if (planar) body.torque.z += tq[2]!;
    else body.torque.vadd(new CANNON.Vec3(tq[0], tq[1], tq[2]), body.torque);
  };
}

const zAngle = (q: CANNON.Quaternion) => (Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z)) * 180) / Math.PI;

function record(run: Run): void {
  for (const pr of run.particles) {
    const live = pr.live;
    const row = live.length ? new Float32Array(live.length * 3) : EMPTY_ROW;
    for (let k = 0, o = 0; k < live.length; k++, o += 3) {
      const p = live[k]!;
      row[o] = p.i;
      row[o + 1] = p.x;
      row[o + 2] = p.y;
    }
    pr.steps.push(row);
  }
  const row = new Float32Array(run.active.length * 7);
  const turn = new Float32Array(run.active.length);
  const prev = run.steps[run.steps.length - 1], prevTurn = run.turns[run.turns.length - 1];
  run.active.forEach(({ body, planar }, i) => {
    row.set([body.position.x, body.position.y, body.position.z, body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w], i * 7);
    if (!planar || !prev || !prevTurn) return;
    // The step's turn, the short way round, added to the running total.
    const was = zAngle(new CANNON.Quaternion(prev[i * 7 + 3], prev[i * 7 + 4], prev[i * 7 + 5], prev[i * 7 + 6]));
    let d = zAngle(body.quaternion) - was;
    d = d > 180 ? d - 360 : d < -180 ? d + 360 : d;
    turn[i] = prevTurn[i]! + d;
  });
  run.steps.push(row);
  run.turns.push(turn);
}

/**
 * Where a body's mass sits — the centroid of its colliders (area × depth for a
 * prism, volume for a box or a sphere) — and its colliders moved to centre on
 * it. cannon puts a body's centre of mass at its origin; ours is the layer's
 * pivot, which can sit anywhere (a corner, off the art), and a box would then
 * tumble about its corner. Builders simulate about this point and carry the
 * offset back.
 */
export function centreColliders(colliders: SimCollider[]): { centre: V3; colliders: SimCollider[] } {
  let w = 0;
  const c: V3 = [0, 0, 0];
  const add = (p: V3, m: number) => {
    c[0] += p[0] * m, c[1] += p[1] * m, c[2] += p[2] * m;
    w += m;
  };
  for (const k of colliders) {
    if (k.kind === "box") add(k.offset, 8 * k.half[0] * k.half[1] * k.half[2]);
    else if (k.kind === "sphere") add(k.offset, (4 / 3) * Math.PI * k.radius ** 3);
    else {
      // The polygon's area centroid, carried into the body by its plane.
      let a = 0, cx = 0, cy = 0;
      for (let i = 0, j = k.points.length - 1; i < k.points.length; j = i++) {
        const [x0, y0] = k.points[j]!, [x1, y1] = k.points[i]!;
        const cr = x0 * y1 - x1 * y0;
        a += cr, cx += (x0 + x1) * cr, cy += (y0 + y1) * cr;
      }
      if (Math.abs(a) < 1e-9) continue;
      cx /= 3 * a, cy /= 3 * a;
      const o = k.offset ?? [0, 0, 0];
      const scaleUV = Math.hypot(k.u[1] * k.v[2] - k.u[2] * k.v[1], k.u[2] * k.v[0] - k.u[0] * k.v[2], k.u[0] * k.v[1] - k.u[1] * k.v[0]);
      add([cx * k.u[0] + cy * k.v[0] + o[0], cx * k.u[1] + cy * k.v[1] + o[1], cx * k.u[2] + cy * k.v[2] + o[2]], Math.abs(a / 2) * scaleUV * k.depth * 2);
    }
  }
  if (w <= 0) return { centre: [0, 0, 0], colliders };
  const centre: V3 = [c[0] / w, c[1] / w, c[2] / w];
  const shift = (o: V3 | undefined): V3 => { const p = o ?? [0, 0, 0]; return [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]]; };
  return {
    centre,
    colliders: colliders.map((k) => (k.kind === "prism" ? { ...k, offset: shift(k.offset) } : { ...k, offset: shift(k.offset) })),
  };
}
