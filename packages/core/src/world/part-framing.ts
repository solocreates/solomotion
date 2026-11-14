import type { MotionDocument, Clip, MeshClip } from "../schema";
import { locateClip } from "../timeline/ops";
import { KEY_PATH } from "../shape-keys/fields";
import { poseSetSubjects } from "../rig/pose-ops";
import { evaluateWorld } from "./evaluate";
import { buildPrimitive } from "./primitives";
import { basis4, eulerFromRotation, transformDir, transformPoint, type V3 } from "./math";

/**
 * FRAMING A PART IN A WORLD — what a 3D pose picture is OF (ADR-characters-3,
 * "Parts"). A mouth set on a head morphs only the lips' vertices; its pictures
 * should be the lips, not the head two hundred pixels away. So the focus is
 * the WORLD box of what the set's poses actually move:
 *
 *  - a shape-key weight (`key.<id>`): the vertices that key displaces, at rest
 *    and displaced, through the object's matrix;
 *  - anything else (a switch's drawing, a bone, a colour): the subjects'
 *    whole bounds (`poseSetSubjects`).
 *
 * and the tile camera is the world's own camera, kept looking the same way,
 * pulled in to fit that box. Pure, headless: the app renders the result.
 */

export interface WorldFocus {
  center: V3;
  /** The radius of a sphere around everything the set moves, world units. */
  radius: number;
  /**
   * Which way the part FACES, world space (a face's front, Blender's −Y of the
   * object its keys morph). A picture looks at it head-on: lips read as lips,
   * not as a sliver at the edge of a three-quarter head. Absent = the scene
   * camera's own direction.
   */
  facing?: V3;
}

function basePositions(c: MeshClip): number[] | null {
  const g = c.geometry;
  if (g.type === "mesh") return g.mesh.positions;
  if (g.type === "primitive") return buildPrimitive(g.primitive, g.params)?.positions ?? null;
  return null;
}

/** The world box of everything a set's poses move, at comp time `timeMs`. Null outside a world. */
export function poseSetWorldFocus(doc: MotionDocument, groupId: string, setId: string, timeMs: number): WorldFocus | null {
  const group = locateClip(doc, groupId)?.clip;
  const frame = group && doc.frames.find((f) => f.id === group.frameId);
  const set = group?.kind === "group" ? group.poses?.find((s) => s.id === setId) : undefined;
  if (!group || !frame?.world || !set) return null;
  const ev = evaluateWorld(doc, frame, timeMs, { physics: false });
  const byId = new Map(ev.objects.map((o) => [o.id, o]));
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  const add = (p: V3) => {
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i]!, p[i]!);
      hi[i] = Math.max(hi[i]!, p[i]!);
    }
  };
  // 1. What the shape keys move.
  const keyed = new Map<string, Set<string>>();
  for (const p of set.poses)
    for (const v of p.values) {
      const m = KEY_PATH.exec(v.path);
      if (!m) continue;
      let ids = keyed.get(v.clipId);
      if (!ids) keyed.set(v.clipId, (ids = new Set()));
      ids.add(m[1]!);
    }
  let facing: V3 | undefined;
  for (const [clipId, keys] of keyed) {
    const obj = byId.get(clipId);
    const clip = obj?.source as Clip | undefined;
    if (!obj || clip?.kind !== "mesh") continue;
    const pos = basePositions(clip as MeshClip);
    if (!pos) continue;
    facing ??= normalize(transformDir(obj.matrix, [0, -1, 0]));
    for (const k of (clip as MeshClip).shapeKeys ?? []) {
      if (!keys.has(k.id) || k.source.kind !== "delta" || k.source.delta.kind !== "mesh") continue;
      const d = k.source.delta;
      // What visibly MOVES: a viseme nudges the chin by a hair and the lips by
      // a lot — the hair would frame the whole face.
      let most = 0;
      for (let i = 0; i < d.verts.length; i++) most = Math.max(most, Math.hypot(d.xyz[i * 3] ?? 0, d.xyz[i * 3 + 1] ?? 0, d.xyz[i * 3 + 2] ?? 0));
      for (let i = 0; i < d.verts.length; i++) {
        if (Math.hypot(d.xyz[i * 3] ?? 0, d.xyz[i * 3 + 1] ?? 0, d.xyz[i * 3 + 2] ?? 0) < most * 0.3) continue;
        const vi = d.verts[i]!;
        const at: V3 = [pos[vi * 3] ?? 0, pos[vi * 3 + 1] ?? 0, pos[vi * 3 + 2] ?? 0];
        add(transformPoint(obj.matrix, at));
        add(transformPoint(obj.matrix, [at[0] + (d.xyz[i * 3] ?? 0), at[1] + (d.xyz[i * 3 + 1] ?? 0), at[2] + (d.xyz[i * 3 + 2] ?? 0)]));
      }
    }
  }
  // 2. Otherwise the subjects, whole.
  if (!Number.isFinite(lo[0])) {
    for (const id of poseSetSubjects(doc, groupId, setId)) {
      const obj = byId.get(id);
      const clip = obj?.source as Clip | undefined;
      if (!obj) continue;
      const pos = clip?.kind === "mesh" ? basePositions(clip as MeshClip) : null;
      if (pos) for (let i = 0; i + 2 < pos.length; i += 3) add(transformPoint(obj.matrix, [pos[i]!, pos[i + 1]!, pos[i + 2]!]));
      else add([obj.matrix[12]!, obj.matrix[13]!, obj.matrix[14]!]);
    }
  }
  if (!Number.isFinite(lo[0])) return null;
  const center: V3 = [(lo[0] + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2];
  const radius = Math.max(1, Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) / 2);
  return { center, radius, ...(facing && { facing }) };
}

function normalize(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * The document with the world's live camera pulled in on `focus`: the same
 * direction it looks, at the distance that fits the sphere with a margin
 * (`fill` of the frame). Its constraints go (a Track To would turn it back to
 * the whole head). Null when the world shows its default camera.
 */
export function framedOnFocus(doc: MotionDocument, frameId: string, timeMs: number, focus: WorldFocus, fill = 0.7): MotionDocument | null {
  const frame = doc.frames.find((f) => f.id === frameId);
  if (!frame?.world) return null;
  const ev = evaluateWorld(doc, frame, timeMs, { physics: false });
  const camId = ev.camera.clipId;
  const cam = camId ? locateClip(doc, camId) : null;
  if (!cam || cam.track.groupId) return null;
  let m = ev.camera.matrix;
  // Head-on when the part says which way it faces: the camera's +Z (it looks
  // down −Z) is the part's front, its up the world's up (Z).
  if (focus.facing) {
    const z = normalize(focus.facing);
    const up: V3 = Math.abs(z[2]) > 0.95 ? [0, 1, 0] : [0, 0, 1];
    const x = normalize(cross(up, z));
    const y = cross(z, x);
    m = basis4(x, y, z);
  }
  // A camera looks down its own −Z.
  const fwd: V3 = [-m[8]!, -m[9]!, -m[10]!];
  const spec = ev.camera.spec;
  const aspect = frame.height > 0 ? frame.width / frame.height : 16 / 9;
  let dist: number;
  if (spec.projection === "orthographic") dist = Math.max(focus.radius * 4, Math.hypot(ev.camera.matrix[12]! - focus.center[0], ev.camera.matrix[13]! - focus.center[1], ev.camera.matrix[14]! - focus.center[2]));
  else {
    const fovX = 2 * Math.atan(spec.sensorWidth / (2 * spec.focalLength));
    const fovY = 2 * Math.atan(Math.tan(fovX / 2) / aspect);
    dist = focus.radius / Math.max(0.05, fill) / Math.tan(Math.min(fovX, fovY) / 2);
  }
  const pos: V3 = [focus.center[0] - fwd[0] * dist, focus.center[1] - fwd[1] * dist, focus.center[2] - fwd[2] * dist];
  const [rx, ry, rz] = eulerFromRotation(m);
  const tracks = doc.tracks.map((t) =>
    t !== cam.track
      ? t
      : {
          ...t,
          clips: t.clips.map((c): Clip => {
            if (c.id !== camId || c.kind === "audio") return c;
            const next = { ...c, transform: { ...c.transform, x: pos[0], y: pos[1], z: pos[2], rotationX: rx, rotationY: ry, rotation: rz }, keyframes: c.keyframes.filter((k) => !/^(x|y|z|rotation|rotationX|rotationY)$/.test(k.property)) } as Clip;
            if ("constraints" in next) delete (next as { constraints?: unknown }).constraints;
            if (spec.projection === "orthographic" && next.kind === "camera") return { ...next, camera: { ...next.camera, orthoScale: (focus.radius * 2) / fill } } as Clip;
            return next;
          }),
        },
  );
  return { ...doc, tracks };
}
