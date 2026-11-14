import type { MeshData } from "../schema/world";
import { edgeKey, faceNormal, hasUv, vertexAt, vertexCount } from "./mesh";
import { add, cross, dot, normalize3, scale3, sub, type V3 } from "./math";

/**
 * BEVEL — Blender's Bevel modifier: every edge sharper than `angle` is cut
 * back by `width` on both faces and bridged by `segments` strips that arc
 * through the old edge (one segment = a chamfer, more = a round), with a
 * patch at each corner where the strips meet. Faces stay where they were,
 * only smaller, so parts and normals keep their meaning.
 */
export function bevelMesh(mesh: MeshData, width: number, segments: number, angleDeg: number): MeshData {
  const nFaces = mesh.faces.length;
  if (!(width > 0) || nFaces === 0) return mesh;
  const k = Math.max(1, Math.min(8, Math.round(segments)));
  const cosLimit = Math.cos((angleDeg * Math.PI) / 180);
  const normals = mesh.faces.map((f) => faceNormal(mesh, f));
  // Directed edge "a>b" → the face that owns it.
  const owner = new Map<string, number>();
  mesh.faces.forEach((f, fi) => f.forEach((a, i) => owner.set(`${a}>${f[(i + 1) % f.length]}`, fi)));
  const twin = (a: number, b: number) => owner.get(`${b}>${a}`);
  // Is the edge a→b of face fi bevelled? (shared, and sharp enough)
  const bevelled = (fi: number, a: number, b: number) => {
    const g = twin(a, b);
    return g !== undefined && dot(normals[fi]!, normals[g]!) < cosLimit;
  };

  const positions: number[] = [];
  // Every new point is cut from one original vertex; it takes that vertex's
  // unwrap (a bevel is a few units wide — the picture does not notice).
  const own = hasUv(mesh) ? mesh.uv : null;
  const uv: number[] = [];
  let from = -1;
  const push = (p: V3) => {
    if (own) uv.push(own[from * 2]!, own[from * 2 + 1]!);
    return positions.push(p[0], p[1], p[2]), positions.length / 3 - 1;
  };
  // The inset corner of face fi at its i-th vertex.
  const corner: number[][] = mesh.faces.map((f, fi) => {
    const n = normals[fi]!;
    return f.map((v, i) => {
      const p = vertexAt(mesh, v);
      const next = f[(i + 1) % f.length]!, prev = f[(i - 1 + f.length) % f.length]!;
      const pn = vertexAt(mesh, next), pp = vertexAt(mesh, prev);
      const lim = 0.45 * Math.min(Math.hypot(...sub(pn, p)), Math.hypot(...sub(pp, p)));
      const w = Math.min(width, lim);
      const in1 = bevelled(fi, v, next) ? normalize3(cross(n, sub(pn, p))) : ([0, 0, 0] as V3);
      const in2 = bevelled(fi, prev, v) ? normalize3(cross(n, sub(p, pp))) : ([0, 0, 0] as V3);
      const denom = Math.max(0.15, 1 + dot(in1, in2));
      from = v;
      return push(add(p, scale3(add(in1, in2), w / denom)));
    });
  });
  const faces: number[][] = [];
  const parts: string[] | undefined = mesh.faceParts ? [] : undefined;
  const part = (fi: number) => mesh.faceParts?.[fi] ?? "";
  const emit = (loop: number[], fi: number) => {
    if (new Set(loop).size < 3) return;
    faces.push(loop);
    parts?.push(part(fi));
  };
  mesh.faces.forEach((_, fi) => emit(corner[fi]!.slice(), fi));

  // The arc from face f's corner to face g's corner at original vertex v.
  const arcCache = new Map<string, number[]>();
  const arc = (fi: number, gi: number, v: number): number[] => {
    const key = `${fi}|${gi}|${v}`;
    const hit = arcCache.get(key);
    if (hit) return hit;
    const a = corner[fi]![mesh.faces[fi]!.indexOf(v)]!;
    const b = corner[gi]![mesh.faces[gi]!.indexOf(v)]!;
    const pa: V3 = [positions[a * 3]!, positions[a * 3 + 1]!, positions[a * 3 + 2]!];
    const pb: V3 = [positions[b * 3]!, positions[b * 3 + 1]!, positions[b * 3 + 2]!];
    const c = vertexAt(mesh, v);
    const out = [a];
    from = v;
    for (let j = 1; j < k; j++) {
      const t = j / k;
      out.push(push(add(add(scale3(pa, (1 - t) * (1 - t)), scale3(c, 2 * (1 - t) * t)), scale3(pb, t * t))));
    }
    out.push(b);
    arcCache.set(key, out);
    arcCache.set(`${gi}|${fi}|${v}`, out.slice().reverse());
    return out;
  };

  // Strips along each bevelled edge, once per edge.
  const done = new Set<string>();
  mesh.faces.forEach((f, fi) => {
    f.forEach((a, i) => {
      const b = f[(i + 1) % f.length]!;
      const ek = edgeKey(a, b);
      if (done.has(ek) || !bevelled(fi, a, b)) return;
      done.add(ek);
      const gi = twin(a, b)!;
      const A = arc(fi, gi, a), B = arc(fi, gi, b);
      for (let j = 0; j < k; j++) emit([B[j]!, A[j]!, A[j + 1]!, B[j + 1]!], fi);
    });
  });

  // Corner patches: walk the faces round each original vertex.
  const facesAt = new Map<number, number[]>();
  mesh.faces.forEach((f, fi) => f.forEach((v) => (facesAt.get(v) ?? facesAt.set(v, []).get(v)!).push(fi)));
  const vertexNormal = (v: number) => normalize3((facesAt.get(v) ?? []).reduce((acc, fi) => add(acc, normals[fi]!), [0, 0, 0] as V3));
  for (let v = 0; v < vertexCount(mesh); v++) {
    const around = facesAt.get(v);
    if (!around || around.length < 2) continue;
    // Order the faces round v: from f, cross its edge v→next to the twin.
    const order: number[] = [around[0]!];
    let closed = false;
    for (let guard = 0; guard < around.length + 1; guard++) {
      const fi = order[order.length - 1]!;
      const f = mesh.faces[fi]!;
      const next = f[(f.indexOf(v) + 1) % f.length]!;
      const g = twin(v, next);
      if (g === undefined) break;
      if (g === order[0]) {
        closed = true;
        break;
      }
      if (order.includes(g)) break;
      order.push(g);
    }
    if (order.length < 2) continue;
    const ring: number[] = [];
    const pairs = closed ? order.length : order.length - 1;
    let anyBevel = false;
    for (let i = 0; i < pairs; i++) {
      const fi = order[i]!, gi = order[(i + 1) % order.length]!;
      const f = mesh.faces[fi]!;
      const next = f[(f.indexOf(v) + 1) % f.length]!;
      if (bevelled(fi, v, next)) {
        anyBevel = true;
        const pts = arc(fi, gi, v);
        for (const p of pts) if (ring[ring.length - 1] !== p) ring.push(p);
      } else {
        const a = corner[fi]![f.indexOf(v)]!;
        const b = corner[gi]![mesh.faces[gi]!.indexOf(v)]!;
        if (ring[ring.length - 1] !== a) ring.push(a);
        if (ring[ring.length - 1] !== b) ring.push(b);
      }
    }
    if (!anyBevel) continue;
    from = v;
    if (!closed) ring.push(push(vertexAt(mesh, v)));
    if (ring[0] === ring[ring.length - 1]) ring.pop();
    if (ring.length < 3) continue;
    // Face it outward, whichever way the walk went.
    const probe: MeshData = { positions, faces: [ring] };
    if (dot(faceNormal(probe, ring), vertexNormal(v)) < 0) ring.reverse();
    emit(ring, order[0]!);
  }
  return { positions, faces, ...(parts && { faceParts: parts }), ...(own && { uv }) };
}
