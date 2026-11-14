import { describe, expect, it } from "vitest";
import { accumulateMesh } from "../shape-keys/delta";
import { morphMesh } from "../shape-keys/mix";
import { keyPath } from "../shape-keys/fields";
import { buildTalkingHead, createTalkingHeadClip } from "./face-head";
import { recognizeFace } from "./face-presets";
import { faceCenter, faceNormal, meshBounds } from "./mesh";
import { gltfFromShapeKeys, meshMorphExport } from "./morph-targets";
import type { MeshData } from "../schema";

const head = buildTalkingHead();
const parts = (createTalkingHeadClip({ frameId: "f", startMs: 0, durationMs: 1 }).geometry as { mesh: MeshData }).mesh.faceParts!;

/** Vertices of faces wearing `part`. */
function vertsOf(mesh: MeshData, part: string): number[] {
  const s = new Set<number>();
  mesh.faces.forEach((f, i) => mesh.faceParts![i] === part && f.forEach((v) => s.add(v)));
  return [...s];
}

function posed(id: string, w = 1): MeshData {
  return morphMesh(head.mesh, head.keys, { [keyPath(id)]: w });
}

/** Height (z extent) of the dark inside: how open the mouth is. */
function opening(m: MeshData): number {
  const vs = vertsOf(m, "mouth");
  const zs = vs.map((v) => m.positions[v * 3 + 2]!);
  return Math.max(...zs) - Math.min(...zs);
}
function width(m: MeshData): number {
  const vs = vertsOf(m, "lips");
  const xs = vs.map((v) => m.positions[v * 3]!);
  return Math.max(...xs) - Math.min(...xs);
}

describe("procedural talking head", () => {
  it("is deterministic", () => {
    const again = buildTalkingHead();
    expect(again.mesh.positions).toEqual(head.mesh.positions);
    expect(again.keys).toEqual(head.keys);
  });

  it("has the keys a face preset recognises as the built-in visemes + blink", () => {
    expect(head.keys.map((k) => k.name)).toEqual(["MBP", "S", "E", "AI", "O", "U", "FV", "L", "jawOpen", "eyeBlink_L", "eyeBlink_R"]);
    const f = recognizeFace(head.keys);
    expect(f.convention).toBe("visemes");
    expect(f.missing).toEqual([]);
    expect(f.eyes.map((e) => e.name)).toEqual(["Open", "Half", "Closed"]);
  });

  it("every viseme moves the mouth measurably, and only the mouth (and jaw)", () => {
    const eyeVerts = new Set([...vertsOf(head.mesh, "eye"), ...vertsOf(head.mesh, "iris")]);
    for (const k of head.keys.filter((k) => !k.name.startsWith("eyeBlink"))) {
      const d = k.source.kind === "delta" && k.source.delta.kind === "mesh" ? k.source.delta : null;
      expect(d, k.name).not.toBeNull();
      let max = 0;
      for (let i = 0; i < d!.xyz.length; i++) max = Math.max(max, Math.abs(d!.xyz[i]!));
      expect(max, k.name).toBeGreaterThan(0.5);
      expect(d!.verts.some((v) => eyeVerts.has(v)), k.name).toBe(false);
    }
    const rest = opening(head.mesh);
    expect(opening(posed("AI"))).toBeGreaterThan(rest + 8);
    expect(opening(posed("jawOpen"))).toBeGreaterThan(opening(posed("E")));
    expect(opening(posed("MBP"))).toBeLessThan(rest + 0.1);
    expect(width(posed("U"))).toBeLessThan(width(head.mesh) - 8);
    expect(width(posed("E"))).toBeGreaterThan(width(head.mesh) + 4);
    expect(width(posed("O"))).toBeLessThan(width(head.mesh));
  });

  it("F V tucks the lower lip behind the teeth; L lifts the tongue", () => {
    const lowerLipDepth = (m: MeshData) => {
      // Mean outward reach (−y) of the lower lip's middle.
      const vs = vertsOf(m, "lips").filter((v) => m.positions[v * 3 + 2]! < -42 && Math.abs(m.positions[v * 3]!) < 4);
      return vs.reduce((s, v) => s - m.positions[v * 3 + 1]!, 0) / vs.length;
    };
    expect(lowerLipDepth(posed("FV"))).toBeLessThan(lowerLipDepth(head.mesh) - 0.5);
    const tongueTop = (m: MeshData) => Math.max(...vertsOf(m, "tongue").map((v) => m.positions[v * 3 + 2]!));
    expect(tongueTop(posed("L"))).toBeGreaterThan(tongueTop(posed("AI")) + 1);
  });

  it("a blink closes its own eye's lids over the eyeball and leaves the other open", () => {
    const covered = (m: MeshData, side: 1 | -1) => {
      // Cast rays from the front through the eye; a ray hits the lid if a lid face lies in front of the iris.
      const iris = vertsOf(m, "iris").filter((v) => Math.sign(m.positions[v * 3]!) === side);
      const irisFront = Math.min(...iris.map((v) => m.positions[v * 3 + 1]!));
      const cx = iris.reduce((s, v) => s + m.positions[v * 3]!, 0) / iris.length;
      const cz = iris.reduce((s, v) => s + m.positions[v * 3 + 2]!, 0) / iris.length;
      const lidFaces = m.faces.filter((f, i) => m.faceParts![i] === "" && f.length === 4).filter((f) => {
        const c = faceCenter(m, f);
        return Math.abs(c[0] - cx) < 4 && Math.abs(c[2] - cz) < 6 && c[1] < irisFront;
      });
      return lidFaces.length > 0;
    };
    expect(covered(head.mesh, 1)).toBe(false);
    expect(covered(head.mesh, -1)).toBe(false);
    const closedL = posed("eyeBlink_L");
    expect(covered(closedL, 1)).toBe(true);
    expect(covered(closedL, -1)).toBe(false);
    // Half a blink never lets the lid sink into the eyeball (linear keys sag on a sphere).
    const half = posed("eyeBlink_R", 0.5);
    const eye = vertsOf(half, "eye").concat(vertsOf(half, "iris")).filter((v) => half.positions[v * 3]! < 0);
    const b = meshBounds({ positions: eye.flatMap((v) => [half.positions[v * 3]!, half.positions[v * 3 + 1]!, half.positions[v * 3 + 2]!]), faces: [] });
    const c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    const re = (b.max[0] - b.min[0]) / 2;
    const d = head.keys.find((k) => k.id === "eyeBlink_R")!;
    const moved = d.source.kind === "delta" && d.source.delta.kind === "mesh" ? d.source.delta.verts : [];
    for (const v of moved) {
      const r = Math.hypot(half.positions[v * 3]! - c[0]!, half.positions[v * 3 + 1]! - c[1]!, half.positions[v * 3 + 2]! - c[2]!);
      expect(r).toBeGreaterThan(re * 1.005);
    }
  });

  it("faces point outward (skin, lids, lips, eyes)", () => {
    const m = head.mesh;
    let inward = 0;
    const centreOf = (part: string, side?: number): number[] => {
      const vs = vertsOf(m, part).filter((v) => side === undefined || Math.sign(m.positions[v * 3]!) === side);
      return [0, 1, 2].map((k) => vs.reduce((s, v) => s + m.positions[v * 3 + k]!, 0) / vs.length);
    };
    m.faces.forEach((f, i) => {
      const part = parts[i]!;
      const n = faceNormal(m, f);
      const c = faceCenter(m, f);
      let ref: number[];
      if (part === "eye" || part === "iris" || part === "shine") ref = centreOf("eye", Math.sign(c[0]));
      else if (part === "") ref = [0, 0, 0];
      else return; // mouth layers face front; checked below
      // Lid faces: measure against their eye.
      if (part === "" && Math.hypot(c[0] - 33 * Math.sign(c[0]), c[2] + 6) < 22 && c[1] < -60) ref = centreOf("eye", Math.sign(c[0]));
      if (n[0] * (c[0] - ref[0]!) + n[1] * (c[1] - ref[1]!) + n[2] * (c[2] - ref[2]!) < 0) inward++;
    });
    expect(inward).toBe(0);
    for (const part of ["mouth", "lips", "teeth", "tongue"]) {
      const front = m.faces.filter((_, i) => parts[i] === part).filter((f) => faceNormal(m, f)[1] < 0).length;
      expect(front / m.faces.filter((_, i) => parts[i] === part).length, part).toBeGreaterThan(0.9);
    }
  });

  it("exports as base corners + one relative target per key (what the glTF writer reads)", () => {
    const clip = createTalkingHeadClip({ frameId: "f", startMs: 0, durationMs: 1000 });
    clip.shapeKeys!.find((k) => k.id === "AI")!.value = 0.4;
    clip.shapeKeys!.find((k) => k.id === "L")!.mute = true;
    const mx = meshMorphExport(clip)!;
    expect(mx.names).not.toContain("L");
    expect(mx.weights[mx.ids.indexOf("AI")]).toBe(0.4);
    // Corner c of the base + its offset = the keyed shape's vertex behind that corner.
    const i = mx.ids.indexOf("AI");
    const full = posed("AI");
    for (let c = 0; c < mx.base.corners.length; c += 97) {
      const v = mx.base.corners[c]!;
      for (let k = 0; k < 3; k++) expect(mx.base.positions[c * 3 + k]! + mx.targets[i]![c * 3 + k]!).toBeCloseTo(full.positions[v * 3 + k]!, 3);
    }
    // A modifier between the keys and the picture: nothing to write as targets.
    clip.modifiers = [{ id: "m1", type: "subdivision", enabled: true }];
    expect(meshMorphExport(clip)).toBeNull();
    // And the head round-trips through glTF with every key.
    const file = gltfFromShapeKeys({ mesh: (clip.geometry as { mesh: MeshData }).mesh, keys: clip.shapeKeys! });
    expect(file.json.meshes![0]!.extras!.targetNames).toEqual(head.keys.filter((k) => k.id !== "L").map((k) => k.name));
  });

  it("the clip carries the keys, parts and a skin colour", () => {
    const clip = createTalkingHeadClip({ frameId: "f", startMs: 0, durationMs: 1000 });
    expect(clip.shapeKeys).toHaveLength(11);
    expect(clip.parts.map((p) => p.id)).toEqual(["lips", "mouth", "tongue", "teeth", "eye", "iris", "shine"]);
    const all = new Set(parts);
    for (const p of clip.parts) expect(all.has(p.id), p.id).toBe(true);
    // A key applied by hand equals the mix.
    const out = Float64Array.from(head.mesh.positions);
    const ai = head.keys.find((k) => k.id === "AI")!;
    if (ai.source.kind === "delta" && ai.source.delta.kind === "mesh") accumulateMesh(out, ai.source.delta, 1);
    expect(posed("AI").positions[100]).toBeCloseTo(out[100]!, 6);
  });
});
