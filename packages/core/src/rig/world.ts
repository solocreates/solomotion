import type { MotionDocument, MeshData, VisualClip } from "../schema";
import { mapLocal } from "../transform-map";
import { planeBasis } from "../world/plane";
import { isBodyKind } from "../world/body";
import { meshBounds, refineMesh } from "../world/mesh";
import { invert4, mul4, transformPoint, type Mat4 } from "../world/math";
import type { RigPose } from "./pose";
import { artShape2d, decideUnit, field2d, localSkins, meshField, skinGraph, skinPoint, type ArtShape, type Decision, type MemberOf } from "./bind";
import { sampleGrid, type Influence } from "./support";

/**
 * RIGS IN A WORLD — the same binding, placed in 3D.
 *
 * A unit that RIDES a bone gains the bone in its parent chain (the world
 * evaluator places it). A unit that BENDS keeps its placement and is skinned
 * as the first step of its geometry stack (`StackEnv.skin`), so every
 * modifier after it works on the bent shape.
 *
 * A 2D layer in a world reads the very weights it has in a flat comp — its
 * silhouette grid in its own px, sampled at each body vertex — so a character
 * made 3D bends exactly as it did flat. A mesh is weighted over its own
 * vertices.
 */

/** A 2D layer's own coordinates (x, y, depth) → its object's local 3D space (`planeToLocal`, as a matrix). */
export function planeMatrix(doc: MotionDocument, clip: VisualClip): Mat4 {
  const b = planeBasis(doc, clip);
  const o = mapLocal(0, 0, b), ux = mapLocal(1, 0, b), uy = mapLocal(0, 1, b);
  return [ux.x - o.x, 0, -(ux.y - o.y), 0, uy.x - o.x, 0, -(uy.y - o.y), 0, 0, 1, 0, 0, o.x, 0, -o.y, 1];
}

/**
 * What a bending object's stack runs first: its skin, keyed by everything it
 * read. `apply` refines the surface first (`refineForSkin`) — the result has
 * more points than it was given, never fewer.
 */
export interface WorldSkin {
  key: string;
  apply(mesh: MeshData, meshKey: string): MeshData;
}

export type WorldBinding = { kind: "none" } | { kind: "rigid"; skin: Mat4 } | { kind: "smooth"; skin: WorldSkin };

/**
 * How one unit in a world follows its rig. `rest` and `now` place the unit's
 * object space in the rig's — where it rests (stored transforms) and where it
 * is at this instant. `restMesh` (a mesh's own geometry at rest) gives a mesh
 * its extent.
 */
/** A world unit as art the decision reads: a picture plane's silhouette through its plane, a mesh's box. */
function worldArt(doc: MotionDocument, m: MemberOf, rest: Mat4, restMesh?: MeshData | null): { art: ArtShape | null; plane: Mat4 | null } {
  const unit = m.unit;
  if (isBodyKind(unit.kind)) {
    const plane = planeMatrix(doc, unit as VisualClip);
    return { art: artShape2d(doc, m, unit, mul4(rest, plane)), plane };
  }
  if (unit.kind === "mesh" && restMesh?.positions.length) {
    const b = meshBounds(restMesh);
    return { art: { key: `${unit.id}|${b.min.join(",")}|${b.max.join(",")}`, toRig: rest, min: b.min, max: b.max, flat: false, coverage: null }, plane: null };
  }
  return { art: null, plane: null };
}

/** How a world unit follows its rig — what `worldBinding` acts on, and what physics reads (which bone a piece hangs on). */
export function worldDecision(doc: MotionDocument, m: MemberOf, pose: RigPose, rest: Mat4, restMesh?: MeshData | null): Decision {
  if (m.unit.kind === "audio") return { kind: "none" };
  return decideUnit(m, pose, worldArt(doc, m, rest, restMesh).art, transformPoint(rest, [0, 0, 0]));
}

export function worldBinding(doc: MotionDocument, m: MemberOf, pose: RigPose, rest: Mat4, now: Mat4, restMesh?: MeshData | null): WorldBinding {
  const unit = m.unit;
  if (unit.kind === "audio") return { kind: "none" };
  const { art, plane } = worldArt(doc, m, rest, restMesh);
  const d = decideUnit(m, pose, art, transformPoint(rest, [0, 0, 0]));
  if (d.kind === "none") return { kind: "none" };
  if (d.kind === "rigid") {
    const s = pose.byId.get(d.bone!);
    return s ? { kind: "rigid", skin: s.skin } : { kind: "none" };
  }
  const bind = (unit as VisualClip).bind;
  const blend = m.rig.rig?.blend ?? 0.35;
  const round = (x: Mat4) => x.map((v) => v.toFixed(3)).join(",");
  const key = `${pose.restKey}|${pose.poseKey}|${round(rest)}|${round(now)}|${bind ? JSON.stringify([bind.mode, bind.bone, bind.paint.length]) : "auto"}|${blend}`;
  if (plane) {
    const field = field2d(doc, m, unit, pose, mul4(rest, plane));
    const toOwn = invert4(plane);
    // The bone skins in the object's own space at this instant.
    const skins = localSkins(field.weights, pose, now);
    return {
      kind: "smooth",
      skin: {
        key: `${key}|${field.grid.key}`,
        apply(base, baseKey) {
          const mesh = refineForSkin(base, baseKey).mesh;
          const out = mesh.positions.slice();
          const inf: Influence = { bone: new Int16Array(4), w: new Float32Array(4) };
          for (let i = 0; i + 2 < out.length; i += 3) {
            const own = transformPoint(toOwn, [out[i]!, out[i + 1]!, out[i + 2]!]);
            sampleGrid(field.grid, field.weights, own[0], own[1], inf);
            const p = skinPoint(skins, inf, out[i]!, out[i + 1]!, out[i + 2]!);
            out[i] = p[0], out[i + 1] = p[1], out[i + 2] = p[2];
          }
          return { ...mesh, positions: out };
        },
      },
    };
  }
  return {
    kind: "smooth",
    skin: {
      key,
      apply(base, baseKey) {
        const { mesh, key: meshKey } = refineForSkin(base, baseKey);
        const { graph, weights } = meshField(mesh, meshKey, rest, pose, bind, blend);
        const pos = skinGraph(graph, weights, localSkins(weights, pose, now));
        return { ...mesh, positions: Array.from(pos) };
      },
    },
  };
}

const dense = new Map<string, MeshData>();

/**
 * A surface fine enough to bend: conforming midpoint splits to ~32 across the
 * longest side (the deform cards' rule), so a cube or a picture card bends
 * smoothly without anyone adding a Subdivision first. The shape is unchanged
 * — every split lies on a face it splits.
 */
export function refineForSkin(mesh: MeshData, key: string): { mesh: MeshData; key: string } {
  const k = `${key}|skin32`;
  let out = dense.get(k);
  if (!out) {
    const b = meshBounds(mesh);
    const span = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    out = refineMesh(mesh, Math.max(1e-3, span / 32), 20000);
    if (dense.size > 48) dense.delete(dense.keys().next().value!);
    dense.set(k, out);
  }
  return { mesh: out, key: k };
}

