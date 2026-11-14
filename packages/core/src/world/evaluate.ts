import type {
  MotionDocument,
  CameraClip,
  CameraSpec,
  Clip,
  Frame,
  GroupClip,
  KeyframeValue,
  LightClip,
  LightSpec,
  Material,
  MeshClip,
  MeshData,
  NestedClip,
  VisualClip,
  WorldSpec,
} from "../schema";
import { worldSpecSchema } from "../schema/world";
import { clipLocalTime } from "../animation/evaluate";
import { hiddenBySwitch } from "../timeline/switch";
import { sampleKeyframes } from "../animation/keyframes";
import { applyModulators } from "../animation/modulators";
import { layerPoseAt } from "../animation/layer-animation";
import { getClipProperty, setClipProperty } from "../animation/paths";
import { frameLayerTree, type LayerTreeNode } from "../timeline/layer-tree";
import { clipBox, clipSourceTimeAt, isClipHidden, locateClip } from "../timeline/ops";
import { isSpatialClip } from "../clip-registry";
import {
  add,
  aimRotation,
  composeTrs,
  decomposeTrs,
  dist3,
  identity4,
  invert4,
  matAxis,
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
} from "./math";
import { defaultCameraMatrix, DEFAULT_CAMERA_SPEC, projectionOf, unitsPerPixel, type Projection } from "./camera";
import { buildPrimitive, primitiveDef, primitiveParams } from "./primitives";
import { stackOnto, type ModifierScene, type SceneObject, type StackEnv } from "./modifiers";
import { pathPolyline, planeBasis, planeToLocal } from "./plane";
import { solveIk } from "./ik";
import { meshBounds } from "./mesh";
import { mixSignature, mixTerms, morphMesh } from "../shape-keys/mix";
import { bodyThickness, isBodyKind } from "./body";
import { worldPhysics, worldPosesAt, type WorldBodyStart, type WorldPhysics, type WorldRigStart } from "../physics/world";
import { rigPlans } from "../physics/rig-plan";
import { rotateChannels3d } from "../rig/pose-edit";
import { bodyLife } from "../physics/life";
import { outlineGeneration, readPhysicsOutline } from "../physics/outline";
import { simulationSchema } from "../schema/physics";
import { isSettledDocument, storedDocumentOf } from "../timeline/settled";
import { bakeRig, evaluateRig, letGoForBodies, rigPoseAt, type RigPose } from "../rig/pose";
import { worldBinding, worldDecision, type WorldSkin } from "../rig/world";
import { speaksForMembers } from "../rig/bind";

/**
 * THE WORLD RENDER CONTRACT — `(document, world comp, time) → scene`.
 *
 * Everything a renderer needs to draw a world at one instant, resolved: each
 * object's world matrix (groups, constraints and in/out animations applied),
 * its sampled fields, its geometry, the live camera and environment. The
 * three.js engine draws exactly this; the viewport, the exporter and an agent
 * inspecting a scene all read the same answer, so they cannot disagree about
 * where anything is. Pure — it runs in tests.
 */

export type WorldObjectKind = "mesh" | "camera" | "light" | "empty" | "plane";

export interface WorldObject {
  id: string;
  kind: WorldObjectKind;
  /** The clip with every keyed / modulated value BAKED into its own slots. */
  clip: VisualClip;
  /** The stored clip (identity-stable — what caches key on). */
  source: VisualClip;
  /** Object → world. For a plane, its picture lies on the local XZ plane facing −Y. */
  matrix: Mat4;
  /** The clip's local time. */
  localMs: number;
  /** Multiplied down the tree and through the in/out animation. */
  opacity: number;
  /** Ids of the groups this object sits in, outermost first. */
  groups: string[];
  /**
   * Inside an instance of a world component: the id of the object it repeats
   * in the component's own comp (its `id` is then `<instance>/<that id>`).
   */
  instanceOf?: string;
  /** It bends with a rig: what its geometry stack runs first (`StackEnv.skin`). */
  skin?: WorldSkin;
  /**
   * The rig it is in and the bone its unit hangs on (null: the rig itself, or
   * it bends) — recorded when asked (`evaluateWorld(…, { bindings: true })`),
   * which is how physics knows which bone a piece swings.
   */
  rides?: { rig: string; unit: string; bone: string | null; bends?: string[] };
}

export interface CameraEval {
  /** The live camera clip, or null when the default camera is showing. */
  clipId: string | null;
  matrix: Mat4;
  spec: CameraSpec;
  projection: Projection;
}

export interface WorldEval {
  frameId: string;
  timeMs: number;
  width: number;
  height: number;
  spec: WorldSpec;
  objects: WorldObject[];
  /** Every rig on screen: its pose and where its space stands in the world (bones are drawn and picked by it). */
  rigs: WorldRig[];
  camera: CameraEval;
  /** The live environment light, if any. */
  environment: WorldObject | null;
}

export const DEFAULT_WORLD_SPEC: WorldSpec = worldSpecSchema.parse({});

/** Is this comp a 3D world? THE check. */
export function isWorldFrame(frame: Pick<Frame, "world"> | null | undefined): boolean {
  return !!frame && frame.world != null;
}

// ── Sampling ─────────────────────────────────────────────────────────────────

/**
 * The clip at an instant, with keyed and modulated values written into its own
 * slots (the `resolveClipDrivers` rule: resolve ONCE, then nothing downstream
 * needs to know a key exists). Unanimated clips come back by reference, so
 * memoisation on identity survives a still scene.
 */
/**
 * A deep copy for the bake that SHARES the heavy payloads no channel writes
 * into: an editable mesh's polygons and the shape keys' deltas (a weight
 * writes `value` only). Copying them every frame gave a keyed mesh a new
 * geometry identity per frame — a buffer rebuild per frame — and copied every
 * blendshape with it.
 */
function cloneForBake<C extends Clip>(clip: C): C {
  const mesh = clip.kind === "mesh" && clip.geometry.type === "mesh" ? clip.geometry : null;
  const keys = clip.kind === "path" || clip.kind === "mesh" ? clip.shapeKeys : undefined;
  if (!mesh && !keys) return structuredClone(clip);
  const out = structuredClone({ ...clip, ...(mesh && { geometry: null }), ...(keys && { shapeKeys: undefined }) }) as C;
  const o = out as Clip & { geometry?: unknown; shapeKeys?: unknown };
  if (mesh) o.geometry = mesh;
  if (keys) o.shapeKeys = keys.map((k) => ({ ...k }));
  return out;
}

export function bakeClipAt<C extends Clip>(clip: C, localMs: number): C {
  const tracks = clip.keyframes.filter((t) => !t.range);
  const mods = clip.modulators?.filter((m) => m.enabled) ?? [];
  if (tracks.length === 0 && mods.length === 0) return clip;
  const sampled = sampleKeyframes(tracks, localMs);
  const out = cloneForBake(clip);
  for (const t of tracks) {
    const v = sampled[t.property];
    if (v !== undefined) setClipProperty(out, t.property, v);
  }
  const timeSec = localMs / 1000;
  for (const m of mods) {
    const base = sampled[m.target] ?? getClipProperty(out, m.target);
    if (typeof base !== "number") continue;
    setClipProperty(out, m.target, applyModulators(clip.modulators, m.target, base, timeSec, sampled));
  }
  return out;
}

/** An object's own matrix (no parents): T · R · S with the 3D fields resolved. */
export function objectLocalMatrix(clip: VisualClip): Mat4 {
  const t = clip.transform;
  const sx = t.scale;
  const sy = t.scaleY ?? t.scale;
  const sz = t.scaleZ ?? t.scale;
  // A picture plane's 2D scale acts on its picture: content v lies along local Z.
  const scale: V3 = isSpatialClip(clip) ? [sx, sy, sz] : [sx, sz, sy];
  return composeTrs({ position: [t.x, t.y, t.z ?? 0], rotation: [t.rotationX ?? 0, t.rotationY ?? 0, t.rotation], scale });
}

// ── The walk ─────────────────────────────────────────────────────────────────

interface Pending {
  node: LayerTreeNode;
  parent: Mat4;
  opacity: number;
  groups: string[];
  rig?: RigWalk;
}

/**
 * The nearest rig above a node during the walk. Rig space is where the rig's
 * members are written (its parent's space); `base` places it in the world
 * (everything above, the rig's own delta included). `now`/`rest` are the
 * groups between the rig and here — at this instant and at their stored
 * transforms. `bound`: a group above already bound everything below as one.
 */
/** A rig in a world at an instant: bones posed in its space, and that space's place in the world. */
export interface WorldRig {
  id: string;
  pose: RigPose;
  matrix: Mat4;
}

interface RigWalk {
  group: GroupClip;
  pose: RigPose;
  base: Mat4;
  now: Mat4;
  rest: Mat4;
  inner: GroupClip[];
  bound: boolean;
  /** The group unit that bound everything below as one, and the bone it hangs on (recorded with `bindings`). */
  unit?: { id: string; bone: string | null };
}

/**
 * A comp as it is at an instant — its keys, poses, behaviors and drivers baked
 * there (`bakeOfCompAt`): what a nested world component is resolved through at
 * its own time. Installed by `evaluate/resolved-doc`
 * (which reaches this module through physics, so it cannot be imported back);
 * until it is, a world reads the document as handed.
 */
type Baker = (doc: MotionDocument, frameId: string, timeMs: number) => MotionDocument;
let resolveNested: Baker | null = null;
/** A bake of another instant, asked again at this one (`rebakeAt`); anything else as handed. */
let rebakeAt: Baker | null = null;
export function installWorldNestedResolver(bakers: { nested: Baker; at: Baker }): void {
  resolveNested = bakers.nested;
  rebakeAt = bakers.at;
}

/**
 * The stored layer an evaluated id stands for: itself, or — inside an
 * instance of a world component (`<instance>/<id>`, nested any depth) — the
 * component's own layer it repeats.
 */
export function worldSourceId(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1);
}

/** How deep worlds may nest in worlds (a component of components of …). */
const MAX_WORLD_DEPTH = 4;

/**
 * Evaluate a world comp at comp time `timeMs`. Hidden, out-of-span and
 * non-visual layers are skipped; a group is a DELTA about the median of its
 * members' origins (the 2D group model with one more axis).
 *
 * `aliveAt` is for one instant of a SHUTTER: who is in the shot (and which
 * camera is live) is decided at the frame's own instant, and each of those is
 * posed at `timeMs` held inside its own span. Without it, a layer's first and
 * last frames were averaged with instants it does not exist at — every world
 * scene opened on a half-transparent frame, and a camera cut blurred across.
 */
export function evaluateWorld(
  doc: MotionDocument,
  frame: Frame,
  timeMs: number,
  opts: { physics?: boolean; bindings?: boolean; aliveAt?: number; depth?: number } = {},
): WorldEval {
  // THE WORLD AT THIS INSTANT. The document handed in may be a bake of another
  // instant — a shutter poses each of its instants from the frame's bake — and
  // a bake has its driven fields frozen there (their keys dropped), so an
  // expression-driven carousel stood still across the shutter and never blurred.
  // Such a bake is asked again at this instant; any other document is read as
  // handed. The simulation is built once per edit, from the raw document.
  const raw = storedDocumentOf(doc);
  if (rebakeAt) doc = rebakeAt(doc, frame.id, timeMs);
  const localOf = (c: Clip): number | null => heldLocalTime(c, timeMs, opts.aliveAt);
  const spec = frame.world ?? DEFAULT_WORLD_SPEC;
  const objects: WorldObject[] = [];
  const rigs: WorldRig[] = [];
  const tree = frameLayerTree(doc, frame.id);
  // The simulation, read BEFORE the walk: a rig that simulates through its bones
  // is posed by it on the way down (its bones swing, its root falls), so what
  // rides those bones is placed from the start.
  const wp = opts.physics !== false && frameSimulates(raw, frame.id) ? worldPhysicsOf(raw, frame) : null;
  const poses = wp ? worldPosesAt(wp, timeMs) : null;

  const stack: Pending[] = tree.map((node) => ({ node, parent: identity4(), opacity: 1, groups: [] }));
  // Depth-first, preserving top→bottom z order.
  const visit = (p: Pending): void => {
    const { node } = p;
    const track = doc.tracks[node.trackIndex];
    if (!track) return;
    const raw = node.clip;
    // An adjustment grades what the camera sees (the frame's post-pass) — a
    // camera filter, not an object. (The layer tree never holds sound.)
    if (raw.kind === "adjustment") return;
    // A backplate is the picture behind the scene, painted flat by the 2D renderer — not an object.
    if ("backplate" in raw && raw.backplate) return;
    if (isClipHidden(track, raw)) return;
    // A member its switch does not show is not in the world now.
    if (hiddenBySwitch(doc, track, raw, opts.aliveAt ?? timeMs)) return;
    const local = localOf(raw);
    if (local === null) return;
    const clip = bakeClipAt(raw, local);
    if (node.type === "group") {
      const delta = groupDelta(doc, clip as VisualClip, node, localOf);
      let parent = delta ? mul4(p.parent, delta) : p.parent;
      let rig = p.rig;
      // A group under a rig: a unit of its own (it rides a bone whole) or
      // organisation (its leaves bind one by one; it only carries them).
      if (rig && !rig.bound) {
        const restDelta = groupDelta(doc, raw as VisualClip, node, (c) => clipLocalTime(c, 0)) ?? identity4();
        if (speaksForMembers(raw)) {
          const m = { rig: rig.group, unit: raw, inner: rig.inner };
          const b = worldBinding(doc, m, rig.pose, mul4(rig.rest, restDelta), mul4(rig.now, delta ?? identity4()));
          if (b.kind === "rigid") parent = mul4(rig.base, mul4(b.skin, mul4(rig.now, delta ?? identity4())));
          let unit: RigWalk["unit"];
          if (opts.bindings) {
            const d = worldDecision(doc, m, rig.pose, mul4(rig.rest, restDelta));
            unit = { id: raw.id, bone: d.kind === "rigid" ? (d.bone ?? null) : null };
          }
          rig = { ...rig, bound: true, unit };
        } else {
          rig = { ...rig, now: mul4(rig.now, delta ?? identity4()), rest: mul4(rig.rest, restDelta), inner: [...rig.inner, raw as GroupClip] };
        }
      }
      // A rig of its own: the walk below binds to it (a rig in a rig rides the outer one whole, above).
      const keyed = raw.kind === "group" && raw.rig?.bones.length ? rigPoseAt(raw, local, false) : null;
      if (keyed) {
        let own = keyed;
        // Simulating through its bones: the root where it fell, the dynamic bones where they swung.
        const run = wp?.rigs.get(raw.id);
        if (run && poses) {
          const root = run.rootFalls ? poses.get(raw.id) : undefined;
          if (root) parent = root;
          if (run.dynamic.length) own = posedByBodies(raw as GroupClip, local, parent, run.dynamic, poses) ?? own;
        }
        rig = { group: raw as GroupClip, pose: own, base: parent, now: identity4(), rest: identity4(), inner: [], bound: false };
        rigs.push({ id: raw.id, pose: own, matrix: parent });
      }
      for (const child of node.children) {
        visit({ node: child, parent, opacity: p.opacity * clip.opacity, groups: [...p.groups, raw.id], rig });
      }
      return;
    }
    // AN INSTANCE OF A WORLD — a 3D component placed in this one: its objects,
    // in 3D, under the instance's transform, at the instance's own time —
    // never a flat picture of it. Ids are the instance's (`<instance>/<id>`),
    // so two instances are two sets of objects; its own cameras and lights
    // stay home (this world's camera looks, this world's lights light).
    if (raw.kind === "nested") {
      const src = doc.frames.find((f) => f.id === (raw as NestedClip).sourceFrameId);
      if (src?.world && (opts.depth ?? 0) < MAX_WORLD_DEPTH) {
        const at = clipSourceTimeAt(doc, raw, local);
        const inner = resolveNested ? resolveNested(doc, src.id, at) : doc;
        const sub = evaluateWorld(inner, src, at, { physics: false, bindings: opts.bindings, depth: (opts.depth ?? 0) + 1 });
        const base = mul4(p.parent, objectLocalMatrix(clip as VisualClip));
        const own = (id: string) => `${raw.id}/${id}`;
        for (const o of sub.objects) {
          if (o.kind === "camera" || o.kind === "light") continue;
          objects.push({
            ...o,
            id: own(o.id),
            matrix: mul4(base, o.matrix),
            opacity: p.opacity * clip.opacity * o.opacity,
            groups: [...p.groups, raw.id, ...o.groups.map(own)],
            instanceOf: o.instanceOf ?? o.id,
            ...(o.rides && { rides: { ...o.rides, rig: own(o.rides.rig), unit: own(o.rides.unit) } }),
          });
        }
        for (const r of sub.rigs) rigs.push({ ...r, id: own(r.id), matrix: mul4(base, r.matrix) });
        return;
      }
    }
    const kind: WorldObjectKind = raw.kind === "mesh" || raw.kind === "camera" || raw.kind === "light" || raw.kind === "empty" ? raw.kind : "plane";
    let matrix = mul4(p.parent, objectLocalMatrix(clip as VisualClip));
    let skin: WorldSkin | undefined;
    let rides: WorldObject["rides"];
    if (opts.bindings && p.rig) {
      if (p.rig.bound) rides = p.rig.unit ? { rig: p.rig.group.id, unit: p.rig.unit.id, bone: p.rig.unit.bone } : undefined;
      else {
        const restMesh = raw.kind === "mesh" ? evaluateGeometry(raw as MeshClip, local).mesh : null;
        const d = worldDecision(doc, { rig: p.rig.group, unit: raw, inner: p.rig.inner }, p.rig.pose, mul4(p.rig.rest, objectLocalMatrix(raw as VisualClip)), restMesh);
        rides = { rig: p.rig.group.id, unit: raw.id, bone: d.kind === "rigid" ? (d.bone ?? null) : null, ...(d.kind === "smooth" && d.made?.length && { bends: d.made }) };
      }
    }
    if (p.rig && !p.rig.bound && !p.rig.pose.atRest) {
      const r = p.rig;
      const now = mul4(r.now, objectLocalMatrix(clip as VisualClip));
      const rest = mul4(r.rest, objectLocalMatrix(raw as VisualClip));
      const restMesh = raw.kind === "mesh" ? evaluateGeometry(raw as MeshClip, local).mesh : null;
      const b = worldBinding(doc, { rig: r.group, unit: raw, inner: r.inner }, r.pose, rest, now, restMesh);
      if (b.kind === "rigid") matrix = mul4(r.base, mul4(b.skin, now));
      else if (b.kind === "smooth") skin = b.skin;
    }
    objects.push({
      id: raw.id,
      kind,
      clip: clip as VisualClip,
      source: raw as VisualClip,
      matrix,
      localMs: local,
      opacity: p.opacity * (clip as VisualClip).opacity,
      groups: p.groups,
      ...(skin && { skin }),
      ...(rides && { rides }),
    });
  };
  for (const p of stack) visit(p);

  // Rigid bodies take over from where they stood at the physics start — before
  // constraints, so a camera can look at (or a layer be parented to) a body.
  if (poses) for (const o of objects) {
    const m = poses.get(o.id);
    if (m) o.matrix = withLiveScale(m, o.matrix, wp!.scales.get(o.id));
  }
  applyConstraints(objects);

  const camera = activeCamera(objects, frame);
  applyLayerAnimations(objects, camera, frame.width);

  const environment = objects.find((o) => o.kind === "light" && (o.clip as LightClip).light.type === "environment") ?? null;
  return { frameId: frame.id, timeMs, width: frame.width, height: frame.height, spec, objects, rigs, camera, environment };
}

/**
 * The simulation owns where a body is and how it is turned — not its size. A
 * body's pose carries the scale it had at the physics start, so a planet keyed
 * to pop in from 0.01 stayed a speck forever. Its scale NOW rides on the pose
 * (the collider stays the start shape).
 */
function withLiveScale(pose: Mat4, keyed: Mat4, atStart: V3 | undefined): Mat4 {
  if (!atStart) return pose;
  const now = decomposeTrs(keyed).scale;
  const r = [0, 1, 2].map((i) => (Math.abs(atStart[i]!) > 1e-6 ? now[i]! / atStart[i]! : 1)) as V3;
  return r.every((x) => Math.abs(x - 1) < 1e-6) ? pose : mul4(pose, scale4(r));
}

/** A clip's local time at `timeMs` — or, for a shutter instant, at `timeMs` held inside its span when it is live at `aliveAt`. */
function heldLocalTime(clip: Clip, timeMs: number, aliveAt: number | undefined): number | null {
  if (aliveAt === undefined) return clipLocalTime(clip, timeMs);
  const live = clipLocalTime(clip, aliveAt);
  if (live === null) return null;
  const held = Math.min(Math.max(timeMs, clip.startMs), clip.startMs + clip.durationMs - 0.01);
  return clipLocalTime(clip, held) ?? live;
}

/** Does a group under a rig bind as ONE unit (a rig of its own, or an explicit rigid/none)? */

/** A group's delta about the median of its members' base origins; null when identity. */
function groupDelta(doc: MotionDocument, group: VisualClip, node: Extract<LayerTreeNode, { type: "group" }>, localOf: (c: Clip) => number | null): Mat4 | null {
  const t = group.transform;
  const identity =
    t.x === 0 && t.y === 0 && (t.z ?? 0) === 0 && t.rotation === 0 && (t.rotationX ?? 0) === 0 && (t.rotationY ?? 0) === 0 &&
    t.scale === 1 && (t.scaleY ?? 1) === 1 && (t.scaleZ ?? 1) === 1;
  if (identity) return null;
  const pts: V3[] = [];
  const collect = (n: LayerTreeNode) => {
    if (n.type === "group") n.children.forEach(collect);
    else {
      const local = localOf(n.clip);
      if (local === null) return;
      const c = bakeClipAt(n.clip, local);
      pts.push([c.transform.x, c.transform.y, c.transform.z ?? 0]);
    }
  };
  node.children.forEach(collect);
  void doc;
  const pivot: V3 = pts.length ? scale3(pts.reduce((a, b) => add(a, b), [0, 0, 0] as V3), 1 / pts.length) : [0, 0, 0];
  const sx = t.scale, sy = t.scaleY ?? t.scale, sz = t.scaleZ ?? t.scale;
  let m = translate4(add(pivot, [t.x, t.y, t.z ?? 0]));
  m = mul4(m, rotation4(t.rotationX ?? 0, t.rotationY ?? 0, t.rotation));
  m = mul4(m, scale4([sx, sy, sz]));
  return mul4(m, translate4(scale3(pivot, -1)));
}

// ── Constraints ──────────────────────────────────────────────────────────────

/** Follow first (positions), then look-at (rotations), so a camera that follows AND looks sees its target. */
function applyConstraints(objects: WorldObject[]): void {
  const byId = new Map(objects.map((o) => [o.id, o]));
  // A layer that now lives inside an instance of a world component is still
  // what a camera here looks at (or a layer follows): its first instance answers.
  for (const o of objects) if (o.instanceOf && !byId.has(o.instanceOf)) byId.set(o.instanceOf, o);
  // CHILD OF first, parents before children (a hand on a forearm on an arm),
  // so every later constraint sees the rig already posed. A cycle stops at the
  // layer that closes it.
  const done = new Set<string>();
  const visiting = new Set<string>();
  const parent = (o: WorldObject): void => {
    if (done.has(o.id) || visiting.has(o.id)) return;
    visiting.add(o.id);
    for (const c of o.clip.constraints ?? []) {
      if (!c.enabled || c.type !== "childOf" || !c.targetId || c.targetId === o.id) continue;
      const target = byId.get(c.targetId);
      if (!target) continue;
      parent(target);
      const rel = c.inverse ? mul4(c.inverse, o.matrix) : o.matrix;
      o.matrix = blendMatrix(o.matrix, mul4(target.matrix, rel), c.influence);
    }
    visiting.delete(o.id);
    done.add(o.id);
  };
  for (const o of objects) parent(o);
  applyIk(objects, byId);
  const base = new Map(objects.map((o) => [o.id, o.matrix]));
  for (const o of objects) {
    for (const c of o.clip.constraints ?? []) {
      if (!c.enabled || c.type !== "follow" || !c.targetId || c.targetId === o.id) continue;
      const target = base.get(c.targetId);
      if (!target) continue;
      // Own position is the OFFSET from the target; optionally ride its rotation too.
      const follow = c.rotation ? mul4(target, o.matrix) : mul4(translate4(matPosition(target)), o.matrix);
      o.matrix = blendMatrix(o.matrix, follow, c.influence);
    }
  }
  for (const o of objects) {
    for (const c of o.clip.constraints ?? []) {
      if (!c.enabled || c.type !== "lookAt" || !c.targetId || c.targetId === o.id) continue;
      const target = byId.get(c.targetId);
      if (!target) continue;
      const from = matPosition(o.matrix);
      const to = matPosition(target.matrix);
      if (dist3(from, to) < 1e-6) continue;
      const forward = o.kind === "camera" || o.kind === "light" ? "-z" : "-y";
      const s: V3 = [length(matAxis(o.matrix, 0)), length(matAxis(o.matrix, 1)), length(matAxis(o.matrix, 2))];
      const aimed = mul4(mul4(translate4(from), aimRotation(sub(to, from), forward)), scale4(s));
      o.matrix = blendMatrix(o.matrix, aimed, c.influence);
    }
  }
}

/**
 * IK, after the rig is posed by Child Of: each chain turns toward its target
 * (`solveIk`), then whatever else hangs off a turned joint — a mesh on the
 * forearm, a prop in the hand — is carried by that joint's turn, parents
 * before children.
 */
function applyIk(objects: WorldObject[], byId: Map<string, WorldObject>): void {
  const parentOf = (o: WorldObject): string | null => {
    const c = (o.clip.constraints ?? []).find((x) => x.enabled && x.type === "childOf" && x.targetId && x.targetId !== o.id);
    return c?.targetId ?? null;
  };
  for (const tip of objects) {
    for (const c of tip.clip.constraints ?? []) {
      if (!c.enabled || c.type !== "ik" || !c.targetId || c.targetId === tip.id) continue;
      const target = byId.get(c.targetId);
      if (!target) continue;
      // The chain: the tip and up to `chainLength` parents above it, root first.
      const chain: WorldObject[] = [tip];
      const seen = new Set([tip.id]);
      let at: WorldObject | undefined = tip;
      while (chain.length <= c.chainLength && at) {
        const pid = parentOf(at);
        const up = pid ? byId.get(pid) : undefined;
        if (!up || seen.has(up.id)) break;
        seen.add(up.id);
        chain.unshift(up);
        at = up;
      }
      if (chain.length < 2 || seen.has(target.id)) continue;
      const pole = c.poleId ? byId.get(c.poleId) : undefined;
      const solved = solveIk(chain.map((o) => o.matrix), matPosition(target.matrix), pole ? matPosition(pole.matrix) : null);
      const turn = new Map<string, Mat4>();
      chain.forEach((o, k) => {
        const next = blendMatrix(o.matrix, solved[k]!, c.influence);
        turn.set(o.id, mul4(next, invert4(o.matrix)));
        o.matrix = next;
      });
      // Carry the rest of each turned joint's family, nearest the root first.
      const depth = (o: WorldObject): number => {
        let d = 0;
        let pid = parentOf(o);
        const guard = new Set<string>();
        while (pid && !guard.has(pid) && d < 64) {
          guard.add(pid);
          d++;
          const p = byId.get(pid);
          pid = p ? parentOf(p) : null;
        }
        return d;
      };
      for (const o of [...objects].sort((a, b) => depth(a) - depth(b))) {
        if (turn.has(o.id)) continue;
        const pid = parentOf(o);
        const t = pid ? turn.get(pid) : undefined;
        if (!t) continue;
        o.matrix = mul4(t, o.matrix);
        turn.set(o.id, t);
      }
    }
  }
}

const length = (v: V3) => Math.hypot(v[0], v[1], v[2]);

function blendMatrix(a: Mat4, b: Mat4, t: number): Mat4 {
  if (t >= 1) return b;
  if (t <= 0) return a;
  return a.map((v, i) => v + (b[i]! - v) * t);
}

// ── Camera ───────────────────────────────────────────────────────────────────

/**
 * THE ACTIVE CAMERA — the topmost visible camera clip live at this instant
 * (After Effects' rule); the default camera otherwise. Objects are in z order,
 * topmost first, so the first camera found wins.
 */
function activeCamera(objects: WorldObject[], frame: Frame): CameraEval {
  return cameraEvalOf(objects.find((o) => o.kind === "camera"), frame.width, frame.height);
}

/**
 * ONE camera object as the lens it is (the default camera for none) — the
 * active camera's reading, and the viewport's when it looks through a camera
 * that is not the one rendering (several cameras, one picked).
 */
export function cameraEvalOf(cam: WorldObject | undefined, width: number, height: number): CameraEval {
  if (!cam || cam.kind !== "camera") {
    return {
      clipId: null,
      matrix: defaultCameraMatrix(width, height),
      spec: DEFAULT_CAMERA_SPEC,
      projection: projectionOf(DEFAULT_CAMERA_SPEC, width, height),
    };
  }
  const spec = (cam.clip as CameraClip).camera;
  // Cameras never scale what they see: strip any scale from the matrix.
  const m = cam.matrix;
  const x = normalize3(matAxis(m, 0)), y = normalize3(matAxis(m, 1)), z = normalize3(matAxis(m, 2));
  const pure = [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, m[12]!, m[13]!, m[14]!, 1];
  return { clipId: cam.id, matrix: pure, spec, projection: projectionOf(spec, width, height) };
}

/** Every camera clip of a world, topmost first, with whether it is live at `timeMs`. */
export function worldCameras(doc: MotionDocument, frame: Frame, timeMs: number): Array<{ clip: CameraClip; live: boolean }> {
  const out: Array<{ clip: CameraClip; live: boolean }> = [];
  const walk = (nodes: LayerTreeNode[]) => {
    for (const n of nodes) {
      if (n.type === "group") walk(n.children);
      else if (n.clip.kind === "camera") {
        const track = doc.tracks[n.trackIndex];
        const live = !!track && !isClipHidden(track, n.clip) && clipLocalTime(n.clip, timeMs) !== null;
        out.push({ clip: n.clip, live });
      }
    }
  };
  walk(frameLayerTree(doc, frame.id));
  return out;
}

/** The id of the camera that is showing at `timeMs` — null for the default camera. */
export function activeCameraAt(doc: MotionDocument, frame: Frame, timeMs: number): string | null {
  return worldCameras(doc, frame, timeMs).find((c) => c.live)?.clip.id ?? null;
}

// ── In / out animations in 3D ────────────────────────────────────────────────

/**
 * A layer's in/out animation, played in 3D THROUGH THE CAMERA: a slide moves
 * along the camera's right/down axes by the pixels the preset says (scaled by
 * depth, so 100 px reads as 100 px on screen), a spin turns about the line of
 * sight, a pop scales all three axes about the object's origin — so a preset
 * written for 2D looks right from any angle instead of sliding along world X.
 */
function applyLayerAnimations(objects: WorldObject[], cam: CameraEval, frameWidth: number): void {
  const right = normalize3(matAxis(cam.matrix, 0));
  const up = normalize3(matAxis(cam.matrix, 1));
  const back = normalize3(matAxis(cam.matrix, 2));
  const camPos = matPosition(cam.matrix);
  for (const o of objects) {
    if (o.kind === "camera" || o.kind === "light") continue;
    const pose = layerPoseAt(o.clip, o.localMs);
    if (pose.opacity === 1 && pose.dx === 0 && pose.dy === 0 && pose.scale === 1 && pose.rotation === 0) continue;
    o.opacity *= pose.opacity;
    const origin = matPosition(o.matrix);
    const depth = Math.max(1, -(sub(origin, camPos)[0] * back[0] + sub(origin, camPos)[1] * back[1] + sub(origin, camPos)[2] * back[2]));
    const k = unitsPerPixel(cam.projection, depth, frameWidth);
    const offset = add(scale3(right, pose.dx * k), scale3(up, -pose.dy * k));
    // Spin about the line of sight through the origin; scale about the origin.
    const spin = pose.rotation ? axisAngle(back, -pose.rotation) : identity4();
    const about = mul4(mul4(translate4(add(origin, offset)), mul4(spin, scale4([pose.scale, pose.scale, pose.scale]))), translate4(scale3(origin, -1)));
    o.matrix = mul4(about, o.matrix);
  }
}

function axisAngle(axis: V3, deg: number): Mat4 {
  const a = (deg * Math.PI) / 180;
  const [x, y, z] = normalize3(axis);
  const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  return [
    t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
    0, 0, 0, 1,
  ];
}

// ── Geometry ─────────────────────────────────────────────────────────────────

export interface EvaluatedGeometry {
  /** Stable while the geometry is unchanged — what renderers rebuild buffers on. */
  key: string;
  mesh: MeshData | null;
  /** For an imported model: the asset to load (modifiers do not apply to file meshes). */
  assetId: string | null;
  /**
   * An imported model's own morph targets at their weights now (shape keys
   * with `source.kind === "asset"`) — the renderer sets `morphTargetInfluences`
   * by them and the exporter writes `weights`. Absent when none weigh in.
   */
  morphs?: Array<{ target: number | string; weight: number }>;
}

let meshSerial = 0;
const meshIds = new WeakMap<MeshData, number>();
function meshId(m: MeshData): number {
  let id = meshIds.get(m);
  if (id === undefined) meshIds.set(m, (id = ++meshSerial));
  return id;
}

/**
 * A mesh clip's geometry at an instant: the primitive built from its sampled
 * params (or the stored polygons), then the modifier stack with its sampled
 * fields. `baked` must be the clip from `bakeClipAt` (params already keyed).
 */
export function evaluateGeometry(baked: MeshClip, localMs: number, env: StackEnv = {}): EvaluatedGeometry {
  const g = baked.geometry;
  let base: MeshData | null = null;
  let key: string;
  if (g.type === "primitive") {
    const def = primitiveDef(g.primitive);
    const p = def ? primitiveParams(def, g.params) : {};
    base = buildPrimitive(g.primitive, g.params);
    key = `p:${g.primitive}:${Object.values(p).join(",")}`;
  } else if (g.type === "mesh") {
    // Shape keys mix into the BASE (weights already baked into `value`), so the
    // rig and every modifier act on the morphed shape — and the weights join
    // the key, or the cached stack would stay unmorphed.
    const terms = mixTerms(baked.shapeKeys, undefined);
    base = terms.length ? morphMesh(g.mesh, baked.shapeKeys, undefined) : g.mesh;
    key = `m:${meshId(g.mesh)}${terms.length ? `|k:${mixSignature(terms)}` : ""}`;
  } else {
    const terms = mixTerms(baked.shapeKeys, undefined, "asset");
    const morphs = terms.map((t) => ({ target: (t.key.source as { target: number | string }).target, weight: t.weight }));
    return { key: `a:${g.assetId}`, mesh: null, assetId: g.assetId, ...(morphs.length && { morphs }) };
  }
  if (!base) return { key, mesh: null, assetId: null };
  return { ...stackOnto(base, key, baked.modifiers, localMs, env), assetId: null };
}

/**
 * An object's extent in its OWN space — a mesh's evaluated geometry; a 2D
 * layer's box on its plane, back through its thickness (`clipBox`, the app's
 * one size answer, with text measured in its real font where the app has
 * installed the measurer). Null for what has no extent (a light, a camera).
 */
export function objectLocalBounds(o: WorldObject, doc?: MotionDocument): { min: V3; max: V3 } | null {
  if (o.kind === "mesh") {
    const g = evaluateGeometry(o.clip as MeshClip, o.localMs);
    if (g.mesh && g.mesh.positions.length) return meshBounds(g.mesh);
    return null;
  }
  if (doc && isBodyKind(o.source.kind)) {
    const box = clipBox(doc, o.source);
    const basis = planeBasis(doc, o.source);
    const depth = bodyThickness(o.clip)?.depth ?? 0;
    const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
    for (const x of [box.cx - box.width / 2, box.cx + box.width / 2]) {
      for (const y of [box.cy - box.height / 2, box.cy + box.height / 2]) {
        for (const z of [0, depth]) {
          const p = planeToLocal(basis, { x, y, z });
          for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k]!, p[k]!);
            max[k] = Math.max(max[k]!, p[k]!);
          }
        }
      }
    }
    return { min, max };
  }
  return null;
}

/** World-space bounds of an evaluated object: its own extent (`objectLocalBounds`) placed; a point for what has none. */
export function objectWorldBounds(o: WorldObject, doc?: MotionDocument): { min: V3; max: V3 } {
  const b = objectLocalBounds(o, doc);
  if (b) {
    const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
    for (const cx of [b.min[0], b.max[0]]) for (const cy of [b.min[1], b.max[1]]) for (const cz of [b.min[2], b.max[2]]) {
      const p = transformPoint(o.matrix, [cx, cy, cz]);
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k]!, p[k]!);
        max[k] = Math.max(max[k]!, p[k]!);
      }
    }
    return { min, max };
  }
  const p = matPosition(o.matrix);
  return { min: [p[0] - 50, p[1] - 50, p[2] - 50], max: [p[0] + 50, p[1] + 50, p[2] + 50] };
}

/** The resolved material of a mesh (fields already baked by `bakeClipAt`). */
export function meshMaterial(clip: MeshClip): Material {
  return clip.material;
}

/** The resolved light (fields already baked). */
export function lightSpec(clip: LightClip): LightSpec {
  return clip.light;
}

/** World → camera-view matrix for a camera eval. */
export function viewMatrix(cam: CameraEval): Mat4 {
  return invert4(cam.matrix);
}

// ── Motion paths ─────────────────────────────────────────────────────────────

const POSITION_CHANNELS = new Set(["x", "y", "z"]);

/** Does this layer's position move on its own — keys, modulators, a follow? */
export function clipTravels(clip: Clip): boolean {
  if (clip.kind === "audio") return false;
  if (clip.keyframes.some((t) => POSITION_CHANNELS.has(t.property) && t.keys.length > 1)) return true;
  if (clip.modulators?.some((m) => m.enabled && POSITION_CHANNELS.has(m.target))) return true;
  return !!clip.constraints?.some((c) => c.enabled && c.type === "follow");
}

export interface MotionPath {
  /** The object's world origin, sampled across its span. */
  points: V3[];
  /** Where its position keys put it, in key order. */
  keys: V3[];
}

/**
 * An object's MOTION PATH in the world — Blender's path display, derived:
 * the origin sampled at frame steps across the layer's span, through
 * everything that moves it (keys, easing, modulators, a group, a follow).
 * Null when it does not travel. Cost is one world evaluation per sample, so
 * callers cache it on the document.
 */
export function objectMotionPath(doc: MotionDocument, frame: Frame, clipId: string, opts: { stepMs?: number; maxSamples?: number } = {}): MotionPath | null {
  const loc = locateClip(doc, clipId);
  if (!loc || loc.clip.frameId !== frame.id) return null;
  const clip = loc.clip;
  const start = clip.startMs;
  const end = clip.startMs + clip.durationMs;
  const first = evaluateWorld(doc, frame, start).objects.find((o) => o.id === clipId);
  const groups = first?.groups ?? [];
  const travels = clipTravels(clip) || groups.some((g) => {
    const gc = locateClip(doc, g)?.clip;
    return !!gc && clipTravels(gc);
  });
  if (!travels) return null;
  const n = Math.max(2, Math.min(opts.maxSamples ?? 240, Math.ceil((end - start) / (opts.stepMs ?? 1000 / 30)) + 1));
  const at = (t: number): V3 | null => {
    const o = evaluateWorld(doc, frame, Math.min(end - 0.5, t)).objects.find((x) => x.id === clipId);
    return o ? matPosition(o.matrix) : null;
  };
  const points: V3[] = [];
  for (let i = 0; i < n; i++) {
    const p = at(start + ((end - start) * i) / (n - 1));
    if (p) points.push(p);
  }
  const times = new Set<number>();
  for (const t of clip.keyframes) if (POSITION_CHANNELS.has(t.property)) for (const k of t.keys) times.add(k.timeMs);
  const keys: V3[] = [];
  for (const t of [...times].sort((a, b) => a - b)) {
    if (t < 0 || t > clip.durationMs) continue;
    const p = at(start + t);
    if (p) keys.push(p);
  }
  return { points, keys };
}

// ── The scene a modifier can reach ───────────────────────────────────────────

/**
 * The rest of the world as ONE object's modifiers see it (core `ModifierScene`):
 * every other object's matrix into this object's space, its surface (a mesh)
 * or its outline (a path), and — only when a card asks (Hook) — the same at
 * rest, the start of the comp. Lazy and memoised per sync; a reached mesh is
 * evaluated WITHOUT a scene of its own, so two objects that reach for each
 * other can never recurse.
 */
export function modifierScene(doc: MotionDocument, frame: Frame, ev: WorldEval, self: WorldObject): ModifierScene {
  const inv = invert4(self.matrix);
  const memo = new Map<string, SceneObject | null>();
  let rest: WorldEval | null = null;
  const restOf = () => (rest ??= evaluateWorld(doc, frame, 0, { physics: false }));
  return {
    object(id, opts) {
      const mk = `${id}|${opts?.rest ? 1 : 0}`;
      const hit = memo.get(mk);
      if (hit !== undefined) return hit;
      const o = ev.objects.find((x) => x.id === id);
      if (!o || o.id === self.id) {
        memo.set(mk, null);
        return null;
      }
      const matrix = mul4(inv, o.matrix);
      let mesh: MeshData | null = null;
      let meshKey = "";
      if (o.kind === "mesh") {
        const g = evaluateGeometry(o.clip as MeshClip, o.localMs);
        mesh = g.mesh;
        meshKey = g.key;
      }
      let path: V3[] | null = null;
      let pathKey = "";
      if (o.clip.kind === "path") {
        path = pathPolyline(doc, o.clip);
        pathKey = String(path.length) + path.slice(0, 4).flat().map((v) => v.toFixed(1)).join(",");
      }
      // The face of a picture looks down its local −Y.
      const f = transformDirection(matrix, [0, -1, 0]);
      let restM: Mat4 | undefined;
      if (opts?.rest) {
        const r = restOf();
        const ro = r.objects.find((x) => x.id === id), rs = r.objects.find((x) => x.id === self.id);
        restM = ro && rs ? mul4(invert4(rs.matrix), ro.matrix) : matrix;
      }
      const round = (m: Mat4) => m.map((v) => v.toFixed(3)).join(",");
      const lattice = o.clip.kind === "mesh" ? ((o.clip as MeshClip).lattice ?? null) : null;
      const so: SceneObject = {
        matrix,
        rest: restM,
        mesh,
        path,
        facing: normalize3(f),
        lattice,
        key: `${round(matrix)}|${restM ? round(restM) : ""}|${meshKey}|${pathKey}|${lattice ? `${lattice.u}${lattice.v}${lattice.w}:${lattice.size.join(",")}` : ""}`,
      };
      memo.set(mk, so);
      return so;
    },
  };
}

function transformDirection(m: Mat4, d: V3): V3 {
  return [m[0]! * d[0] + m[4]! * d[1] + m[8]! * d[2], m[1]! * d[0] + m[5]! * d[1] + m[9]! * d[2], m[2]! * d[0] + m[6]! * d[1] + m[10]! * d[2]];
}

// ── Physics ──────────────────────────────────────────────────────────────────

const physicsMemo = new WeakMap<MotionDocument, Map<string, WorldPhysics | null>>();
const simulating = new WeakMap<MotionDocument, Set<string>>();

/** Does anything in this world have a body? Memoised per settled document. */
function frameSimulates(doc: MotionDocument, frameId: string): boolean {
  let set = simulating.get(doc);
  if (!set) {
    set = new Set();
    for (const t of doc.tracks) for (const c of t.clips) if (c.kind !== "audio" && (c as VisualClip).physics) set.add(c.frameId);
    if (isSettledDocument(doc)) simulating.set(doc, set);
  }
  return set.has(frameId);
}

/** The rotation part of a matrix, columns normalised (no translation). */
function rotationOnly(m: Mat4): Mat4 {
  const c = (i: number): V3 => normalize3([m[i]!, m[i + 1]!, m[i + 2]!]);
  const [x, y, z] = [c(0), c(4), c(8)];
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, 0, 0, 0, 1];
}

const transpose3 = (m: Mat4): Mat4 => [m[0]!, m[4]!, m[8]!, 0, m[1]!, m[5]!, m[9]!, 0, m[2]!, m[6]!, m[10]!, 0, 0, 0, 0, 1];

/**
 * A rig's pose with its dynamic bones turned to where the simulation has them
 * (parents first): each bone's simulated frame, carried into the rig's space,
 * becomes its three angle channels (`rotateChannels3d`). IK on a chain holding
 * one lets go — the body moves it now.
 */
function posedByBodies(group: GroupClip, local: number, base: Mat4, dynamic: string[], poses: Map<string, Mat4>): RigPose | null {
  const baked = bakeRig(group, local);
  if (!baked) return null;
  let rig = letGoForBodies(baked, new Set(dynamic));
  const toRig = transpose3(rotationOnly(base));
  for (const id of dynamic) {
    const W = poses.get(id);
    if (!W) continue;
    const pose = evaluateRig(rig, { planar: false });
    const s = pose.byId.get(id);
    if (!s) continue;
    const turn = mul4(mul4(toRig, rotationOnly(W)), transpose3(rotationOnly(s.pose)));
    const ch = rotateChannels3d(pose, id, turn);
    rig = { ...rig, bones: rig.bones.map((b) => (b.id === id ? { ...b, pose: { ...(b.pose ?? { x: 0, y: 0, rotation: 0, scale: 1, scaleY: null }), rotation: ch.rotation, rotationY: ch.rotationY, rotationX: ch.rotationX } } : b)) };
  }
  return evaluateRig(rig, { planar: false });
}

/**
 * The world's simulation, from the world as it stands at the physics start
 * (memoised per settled document — the start is read once, the steps are
 * cached by what they start from in the solver).
 */
function worldPhysicsOf(doc: MotionDocument, frame: Frame): WorldPhysics | null {
  const settled = isSettledDocument(doc);
  const memo = settled ? physicsMemo.get(doc) : undefined;
  const slot = `${frame.id}#${outlineGeneration()}`;
  if (memo?.has(slot)) return memo.get(slot)!;
  const sim = simulationSchema.parse(frame.physics ?? {});
  const start = sim.startMs;
  // Each body enters at its own layer's start (or the simulation's, if later)
  // and leaves at its end: the world is read once per distinct entrance.
  const lives = new Map<string, { from: number; to: number }>();
  for (const t of doc.tracks) {
    for (const c of t.clips) {
      if (c.frameId !== frame.id || c.kind === "audio" || !(c as VisualClip).physics) continue;
      const life = bodyLife(doc, c.id);
      if (life && life.to > start) lives.set(c.id, life);
    }
  }
  const evals = new Map<number, WorldEval>();
  const worldAt = (ms: number) => {
    let e = evals.get(ms);
    if (!e) evals.set(ms, (e = evaluateWorld(doc, frame, ms, { physics: false, bindings: true })));
    return e;
  };
  const at = worldAt(start);
  const parentOf = (o: WorldObject) => mul4(o.matrix, invert4(objectLocalMatrix(o.clip)));
  // Rigs with physics in them simulate through their bones (`rig-plan.ts`): their
  // members are the plan's, never bodies of their own.
  const plans = rigPlans(
    doc,
    frame.id,
    (rig) => at.rigs.find((r) => r.id === rig.id)?.pose ?? null,
    (m) => {
      const o = at.objects.find((x) => x.rides?.unit === m.unit.id);
      return o?.rides?.bone ? { kind: "rigid", bone: o.rides.bone } : o?.rides?.bends ? { kind: "smooth", made: o.rides.bends } : { kind: "none" };
    },
  );
  const owned = new Set(plans.flatMap((p) => [...p.owned]));
  const starts: WorldBodyStart[] = [];
  for (const [id, life] of lives) {
    if (owned.has(id)) continue;
    const born = Math.max(start, life.from);
    const o = worldAt(born).objects.find((x) => x.id === id);
    if (!o) continue;
    const parent = parentOf(o);
    starts.push({
      id,
      clip: o.source,
      kind: o.kind,
      matrix: o.matrix,
      mesh: o.kind === "mesh" ? evaluateGeometry(o.clip as MeshClip, o.localMs).mesh : null,
      matrixAt: (ms: number) => mul4(parent, objectLocalMatrix(bakeClipAt(o.source, Math.max(0, ms - o.source.startMs)))),
      life: { from: born, to: life.to },
    });
  }
  const rigStarts: WorldRigStart[] = [];
  for (const plan of plans) {
    const life = bodyLife(doc, plan.rig.id);
    if (!life || life.to <= start) continue;
    const born = Math.max(start, life.from);
    const e = worldAt(born);
    const pieces: WorldRigStart["pieces"] = new Map();
    for (const b of plan.bodies) {
      for (const p of b.pieces) {
        const o = e.objects.find((x) => x.id === p.clip.id);
        if (o) pieces.set(o.id, { clip: o.source, kind: o.kind, matrix: o.matrix, mesh: o.kind === "mesh" ? evaluateGeometry(o.clip as MeshClip, o.localMs).mesh : null });
      }
    }
    rigStarts.push({
      plan,
      life,
      pieces,
      // The rig by its keys at any instant (the evaluator itself, physics off) — what keyed bones and `follow` read.
      at: (ms) => {
        const r = evaluateWorld(doc, frame, ms, { physics: false }).rigs.find((x) => x.id === plan.rig.id);
        return r ? { base: r.matrix, pose: r.pose } : null;
      },
    });
  }
  const fields = at.objects
    .filter((o) => o.source.forces?.length)
    .map((o) => {
      const parent = parentOf(o);
      const src = o.source;
      const life = bodyLife(doc, o.id) ?? { from: 0, to: 0 };
      return {
        id: o.id,
        count: src.forces!.length,
        key: [src.forces, src.transform, src.keyframes, life, parent],
        at: (ms: number) => {
          if (ms < life.from || ms >= life.to) return null;
          const baked = bakeClipAt(src, ms - src.startMs);
          return { clip: baked, matrix: mul4(parent, objectLocalMatrix(baked)) };
        },
      };
    });
  const out = worldPhysics(doc, frame, starts, fields, (clip, ms) => readPhysicsOutline(doc, clip, ms), rigStarts);
  if (settled) {
    let m = physicsMemo.get(doc);
    if (!m) physicsMemo.set(doc, (m = new Map()));
    m.set(slot, out);
  }
  return out;
}
