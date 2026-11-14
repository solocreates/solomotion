import type { MeshData } from "../schema/world";
import { hasUv, meshEdges, vertexCount } from "./mesh";

/**
 * SCREW — revolve a PROFILE round an axis through the object's origin
 * (Blender's Screw, a lathe): a drawn half-silhouette becomes a vase, a glass,
 * a bottle; with `height` it climbs as it turns — a spring, a spiral ramp, a
 * helix of type.
 *
 * The profile is the mesh's loose edges (`lines` — what a stroke drawn for
 * revolving is), else its open borders (a card revolves its outline), else
 * every edge. Each profile edge sweeps a strip of quads; a closed 360° turn
 * welds its last step onto its first.
 */
export function screwMesh(mesh: MeshData, angleDeg: number, steps: number, height: number, axis: 0 | 1 | 2): MeshData {
  const n = vertexCount(mesh);
  if (n === 0) return mesh;
  let profile: Array<[number, number]> = [];
  if (mesh.lines && mesh.lines.length >= 2) {
    for (let i = 0; i + 1 < mesh.lines.length; i += 2) profile.push([mesh.lines[i]!, mesh.lines[i + 1]!]);
  } else if (mesh.faces.length) {
    const { list } = meshEdges(mesh);
    const open = list.filter((e) => e.faces.length === 1);
    profile = (open.length ? open : list).map((e) => [e.a, e.b]);
  }
  if (!profile.length) return mesh;
  const k = Math.max(1, Math.min(512, Math.round(steps)));
  const full = Math.abs(Math.abs(angleDeg) - 360) < 1e-6 && Math.abs(height) < 1e-9;
  const rings = full ? k : k + 1;
  const P = mesh.positions;
  const [u, v] = axis === 0 ? [1, 2] : axis === 1 ? [2, 0] : [0, 1];
  const positions: number[] = [];
  const own = hasUv(mesh) ? mesh.uv : null;
  const uv: number[] = [];
  for (let r = 0; r < rings; r++) {
    const t = r / k;
    const th = (angleDeg * Math.PI * t) / 180;
    const c = Math.cos(th), s = Math.sin(th);
    for (let i = 0; i < n; i++) {
      const p = [P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!];
      const q = p.slice();
      q[u] = p[u]! * c - p[v]! * s;
      q[v] = p[u]! * s + p[v]! * c;
      q[axis] = p[axis]! + height * t;
      positions.push(q[0]!, q[1]!, q[2]!);
      // The unwrap: the profile's own along one direction, the turn along the other.
      if (own) uv.push(own[i * 2]!, own[i * 2 + 1]! + t);
    }
  }
  const faces: number[][] = [];
  for (let r = 0; r < k; r++) {
    const r0 = r * n, r1 = ((r + 1) % rings) * n;
    for (const [a, b] of profile) faces.push([r0 + a, r0 + b, r1 + b, r1 + a]);
  }
  const out: MeshData = { positions, faces };
  if (own) out.uv = uv;
  return out;
}
