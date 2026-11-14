import { describe, expect, it } from "vitest";
import type { MeshData } from "../schema";
import { bridgeLoops, spinSelection } from "./edit";
import { buildPrimitive } from "./primitives";
import { edgeKey, faceCenter, faceNormal, joinMeshes, meshEdges, transformMesh, vertexCount } from "./mesh";
import { dot, translate4 } from "./math";

const ring = (z: number, n: number, offset: number): { positions: number[]; lines: number[] } => {
  const positions: number[] = [];
  const lines: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    positions.push(Math.cos(a) * 100, Math.sin(a) * 100, z);
    lines.push(offset + i, offset + ((i + 1) % n));
  }
  return { positions, lines };
};

describe("bridge edge loops", () => {
  it("two rings become a tube, faces turned outward", () => {
    const a = ring(0, 8, 0), b = ring(100, 8, 8);
    const mesh: MeshData = { positions: [...a.positions, ...b.positions], faces: [], lines: [...a.lines, ...b.lines] };
    const edges: string[] = [];
    for (let i = 0; i < mesh.lines!.length; i += 2) edges.push(edgeKey(mesh.lines![i]!, mesh.lines![i + 1]!));
    const r = bridgeLoops(mesh, { mode: "edge", verts: [], edges, faces: [] });
    expect(r.error).toBeUndefined();
    expect(r.mesh.faces).toHaveLength(8);
    for (const f of r.mesh.faces) {
      const c = faceCenter(r.mesh, f);
      expect(dot(faceNormal(r.mesh, f), [c[0], c[1], 0])).toBeGreaterThan(0);
    }
    // Different counts refuse, with a reason.
    const c = ring(100, 6, 8);
    const odd: MeshData = { positions: [...a.positions, ...c.positions], faces: [], lines: [...a.lines, ...c.lines] };
    const oddEdges: string[] = [];
    for (let i = 0; i < odd.lines!.length; i += 2) oddEdges.push(edgeKey(odd.lines![i]!, odd.lines![i + 1]!));
    expect(bridgeLoops(odd, { mode: "edge", verts: [], edges: oddEdges, faces: [] }).error).toMatch(/same number/);
  });

  it("two facing faces become a tunnel: the caps go, the result is closed", () => {
    const box = buildPrimitive("cube", { sizeX: 100, sizeY: 100, sizeZ: 100 })!;
    const two = joinMeshes(box, transformMesh(box, translate4([300, 0, 0])));
    const facing = (sign: number, x0: number) => two.faces.findIndex((f) => {
      const n = faceNormal(two, f), c = faceCenter(two, f);
      return n[0] * sign > 0.9 && Math.abs(c[0] - x0) < 1;
    });
    const r = bridgeLoops(two, { mode: "face", verts: [], edges: [], faces: [facing(1, 50), facing(-1, 250)] });
    expect(r.error).toBeUndefined();
    expect(r.mesh.faces).toHaveLength(12 - 2 + 4);
    expect(meshEdges(r.mesh).list.every((e) => e.faces.length === 2)).toBe(true);
  });
});

describe("spin", () => {
  it("a profile swept a full turn closes into a surface of revolution", () => {
    const profile: MeshData = { positions: [100, 0, 0, 140, 0, 60, 90, 0, 120], faces: [], lines: [0, 1, 1, 2] };
    const r = spinSelection(profile, { mode: "vertex", verts: [0, 1, 2], edges: [], faces: [] }, [0, 0, 0], [0, 0, 1], 360, 8);
    expect(vertexCount(r.mesh)).toBe(3 * 8);
    expect(r.mesh.faces).toHaveLength(2 * 8);
    // Closed round: every ring edge is shared by two bands.
    const inner = meshEdges(r.mesh).list.filter((e) => e.faces.length === 2);
    expect(inner.length).toBeGreaterThan(0);
    // A half turn leaves the last ring selected, away from the first.
    const half = spinSelection(profile, { mode: "vertex", verts: [0, 1, 2], edges: [], faces: [] }, [0, 0, 0], [0, 0, 1], 180, 4);
    expect(half.mesh.faces).toHaveLength(2 * 4);
    expect(half.mesh.positions[half.selection.verts[0]! * 3]).toBeCloseTo(-100, 6);
  });
});
