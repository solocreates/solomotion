import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { edgeKey, faceCenter, faceNormal, meshEdges, type MeshClip, type MeshData, type StrokeStyle } from "@solomotion/core";
import type { ColorResolver } from "../../stage/render/paint-style";

/**
 * STROKES ON A 3D OBJECT — Blender's Line Art, the way a motion designer
 * expects a stroke to behave: on by default around the shape you SEE (the
 * silhouette, recomputed from wherever the camera is) plus its hard edges,
 * and on exactly the edges you marked when you want control. The line's look
 * is the layer's own stroke list (colour, width, opacity), so it is styled,
 * keyed and varied exactly like a 2D stroke; width is in screen pixels, which
 * is what an outline is.
 */

interface EdgeCache {
  mesh: MeshData;
  /** Static edges (creases, borders, marks) as flat xyz pairs. */
  fixed: Float32Array;
  /** Manifold edges with their two faces, for the silhouette test. */
  pairs: Array<{ a: number; b: number; f0: number; f1: number }>;
  centers: Array<[number, number, number]>;
  normals: Array<[number, number, number]>;
}

const caches = new WeakMap<MeshData, Map<string, EdgeCache>>();

function edgeCache(mesh: MeshData, lines: MeshClip["lines"]): EdgeCache {
  const key = `${lines.creases}|${lines.creaseAngle}|${lines.boundaries}|${lines.marked}`;
  let per = caches.get(mesh);
  if (!per) caches.set(mesh, (per = new Map()));
  let c = per.get(key);
  if (c) return c;
  const { list } = meshEdges(mesh);
  const normals = mesh.faces.map((f) => faceNormal(mesh, f));
  const centers = mesh.faces.map((f) => faceCenter(mesh, f));
  const marks = new Set<string>();
  if (lines.marked && mesh.marks) for (let i = 0; i + 1 < mesh.marks.length; i += 2) marks.add(edgeKey(mesh.marks[i]!, mesh.marks[i + 1]!));
  const cosCrease = Math.cos((lines.creaseAngle * Math.PI) / 180);
  const fixed: number[] = [];
  const pairs: EdgeCache["pairs"] = [];
  const P = mesh.positions;
  for (const e of list) {
    let keep = marks.has(edgeKey(e.a, e.b));
    if (!keep && lines.boundaries && e.faces.length === 1) keep = true;
    if (!keep && lines.creases && e.faces.length === 2) {
      const n0 = normals[e.faces[0]!]!, n1 = normals[e.faces[1]!]!;
      if (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2] < cosCrease) keep = true;
    }
    if (keep) fixed.push(P[e.a * 3]!, P[e.a * 3 + 1]!, P[e.a * 3 + 2]!, P[e.b * 3]!, P[e.b * 3 + 1]!, P[e.b * 3 + 2]!);
    else if (e.faces.length === 2) pairs.push({ a: e.a, b: e.b, f0: e.faces[0]!, f1: e.faces[1]! });
  }
  c = { mesh, fixed: new Float32Array(fixed), pairs, centers, normals };
  per.set(key, c);
  return c;
}

/** Edges where one face turns toward the eye and the other away — what you SEE as the outline. */
function silhouette(c: EdgeCache, eye: THREE.Vector3): Float32Array {
  const out: number[] = [];
  const P = c.mesh.positions;
  const facing = (f: number) => {
    const n = c.normals[f]!, p = c.centers[f]!;
    return n[0] * (eye.x - p[0]) + n[1] * (eye.y - p[1]) + n[2] * (eye.z - p[2]) > 0;
  };
  for (const e of c.pairs) {
    if (facing(e.f0) !== facing(e.f1)) out.push(P[e.a * 3]!, P[e.a * 3 + 1]!, P[e.a * 3 + 2]!, P[e.b * 3]!, P[e.b * 3 + 1]!, P[e.b * 3 + 2]!);
  }
  return new Float32Array(out);
}

export class MeshLines {
  readonly group = new THREE.Group();
  private items: Array<{ line: LineSegments2; mat: LineMaterial }> = [];

  constructor() {
    this.group.userData.overlay = true;
  }

  /**
   * Rebuild for this frame. `eyeLocal` is the camera position in the mesh's own
   * space (cm); `pxScale` multiplies widths for renders larger than the comp.
   */
  update(
    mesh: MeshData,
    lines: MeshClip["lines"],
    strokes: StrokeStyle[],
    resolve: ColorResolver,
    eyeLocal: THREE.Vector3,
    resolution: THREE.Vector2,
    pxScale: number,
    opacity: number,
  ): void {
    const live = strokes.filter((s) => s.enabled !== false && s.width > 0);
    while (this.items.length > live.length) {
      const it = this.items.pop()!;
      this.group.remove(it.line);
      it.line.geometry.dispose();
      it.mat.dispose();
    }
    if (!live.length) return;
    const c = edgeCache(mesh, lines);
    const sil = lines.silhouette ? silhouette(c, eyeLocal) : new Float32Array(0);
    const all = new Float32Array(c.fixed.length + sil.length);
    all.set(c.fixed, 0);
    all.set(sil, c.fixed.length);
    live.forEach((s, i) => {
      let it = this.items[i];
      if (!it) {
        const mat = new LineMaterial({ worldUnits: false, transparent: true, depthTest: true });
        const line = new LineSegments2(new LineSegmentsGeometry(), mat);
        line.frustumCulled = false;
        line.renderOrder = 2;
        this.group.add(line);
        it = { line, mat };
        this.items[i] = it;
      }
      const geo = new LineSegmentsGeometry();
      geo.setPositions(all.length ? all : new Float32Array(6));
      it.line.geometry.dispose();
      it.line.geometry = geo;
      const paint = resolve.paint(s.paint);
      const color = paint.type === "solid" ? resolve(paint.color) : "#000000";
      it.mat.color.set(color);
      it.mat.linewidth = s.width * pxScale;
      it.mat.opacity = (paint.opacity ?? 1) * opacity;
      it.mat.resolution.copy(resolution);
      it.line.visible = all.length > 0;
    });
  }

  dispose(): void {
    for (const it of this.items) {
      it.line.geometry.dispose();
      it.mat.dispose();
    }
    this.items = [];
  }
}
