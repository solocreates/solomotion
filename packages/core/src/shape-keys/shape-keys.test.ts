import { describe, expect, it } from "vitest";
import type { GroupClip, MeshClip, MeshData, PathClip, ShapeKey, Subpath } from "../schema";
import { createEmptyDocument, createPathClip, createTrack } from "../factories";
import { locateClip } from "../timeline/ops";
import { editPathGeometry } from "../pivot";
import { pathGeometryAt, insertPointOnSegment, copySubpaths } from "../vector/geometry";
import { breakAtNode, deleteNodes, reverseSubpaths, joinEndpoints } from "../vector/edit-engine";
import { getClipProperty, setClipProperty } from "../animation/paths";
import { clipAnimatableProperties } from "../animation/clip-properties";
import { propertyDef } from "../animation/properties";
import { createMeshClip, setMeshData } from "../world/ops";
import { bakeClipAt, evaluateGeometry } from "../world/evaluate";
import { extrude, loopCut, deleteElements, selectAll, meshEdges } from "../world";
import { createRig } from "../rig/ops";
import { evaluateRig } from "../rig/pose";
import { field2d, localSkins, memberOf, restToRig2d } from "../rig/bind";
import { warpedVectorClip } from "../rig/vector";
import {
  addAssetShapeKey,
  beginKeyEdit,
  endKeyEdit,
  addShapeKey,
  duplicateShapeKey,
  keyChain,
  mirrorShapeKey,
  morphMesh,
  morphSubpaths,
  removeShapeKey,
  setKeyShape,
  setShapeKeyMute,
  setShapeKeyRelativeTo,
  shapeOfKey,
} from ".";

const P = (x: number, y: number, hIn: [number, number] | null = null, hOut: [number, number] | null = null) => ({
  x,
  y,
  hIn: hIn ? { x: hIn[0], y: hIn[1] } : null,
  hOut: hOut ? { x: hOut[0], y: hOut[1] } : null,
});

/** A mouth: an open line of four anchors, middle two curved. */
function mouth(closed = false): { doc: ReturnType<typeof createEmptyDocument>; clip: () => PathClip } {
  const doc = createEmptyDocument();
  const frameId = doc.frames[0]!.id;
  const c = createPathClip({
    frameId,
    startMs: 0,
    durationMs: 1000,
    subpaths: [{ closed, points: [P(-30, 0, null, [-20, 0]), P(-10, 0, [-15, 0], [-5, 0]), P(10, 0, [5, 0], [15, 0]), P(30, 0, [20, 0], null)] }],
  });
  const t = createTrack("m");
  t.clips.push(c);
  doc.tracks.push(t);
  return { doc, clip: () => locateClip(doc, c.id)!.clip as PathClip };
}

/** A smile: ends up 10, middle down 4 (the curve's handles ride along). */
function smile(subs: Subpath[]): Subpath[] {
  const out = copySubpaths(subs);
  const dy = [-10, 4, 4, -10];
  out[0]!.points.forEach((p, i) => {
    p.y += dy[i]!;
    if (p.hIn) p.hIn.y += dy[i]!;
    if (p.hOut) p.hOut.y += dy[i]!;
  });
  return out;
}

const ys = (subs: Subpath[]) => subs[0]!.points.map((p) => p.y);

describe("shape keys — the mix", () => {
  it("weights 0 / 1 / overshoot / negative scale the delta; 0 hands back the base itself", () => {
    const { clip } = mouth();
    const c = clip();
    const k = addShapeKey(c, { name: "Smile", shape: smile(c.subpaths) })!;
    expect(pathGeometryAt(c, {})).toBe(c.subpaths);
    expect(ys(pathGeometryAt(c, { [`key.${k.id}`]: 1 }))).toEqual([-10, 4, 4, -10]);
    expect(ys(pathGeometryAt(c, { [`key.${k.id}`]: 0.5 }))).toEqual([-5, 2, 2, -5]);
    expect(ys(pathGeometryAt(c, { [`key.${k.id}`]: 1.5 }))).toEqual([-15, 6, 6, -15]);
    expect(ys(pathGeometryAt(c, { [`key.${k.id}`]: -1 }))).toEqual([10, -4, -4, 10]);
    // Handles ride their anchor: the second point's in-arm is still 5 to its left.
    const p1 = pathGeometryAt(c, { [`key.${k.id}`]: 1 })[0]!.points[1]!;
    expect(p1.hIn).toEqual({ x: -15, y: 4 });
    // The resting value is the base slot of the channel.
    setClipProperty(c, `key.${k.id}`, 1);
    expect(getClipProperty(c, `key.${k.id}`)).toBe(1);
    expect(ys(pathGeometryAt(c, {}))).toEqual([-10, 4, 4, -10]);
  });

  it("muted keys sit out and keep their weight; a corner stays a corner", () => {
    const { clip } = mouth();
    const c = clip();
    const k = addShapeKey(c, { shape: smile(c.subpaths), value: 1 })!;
    setShapeKeyMute(c, k.id, true);
    expect(pathGeometryAt(c, {})).toBe(c.subpaths);
    expect(c.shapeKeys![0]!.value).toBe(1);
    setShapeKeyMute(c, k.id, false);
    expect(pathGeometryAt(c, {})[0]!.points[0]!.hIn).toBeNull();
  });

  it("same weights → same array (pictures key on identity); new weights → new array", () => {
    const { clip } = mouth();
    const c = clip();
    const k = addShapeKey(c, { shape: smile(c.subpaths) })!;
    const a = pathGeometryAt(c, { [`key.${k.id}`]: 0.3 });
    expect(pathGeometryAt(c, { [`key.${k.id}`]: 0.3 })).toBe(a);
    expect(pathGeometryAt(c, { [`key.${k.id}`]: 0.4 })).not.toBe(a);
  });

  it("is an ordinary channel: registry, enumerator, keyed via sampled", () => {
    const { clip } = mouth();
    const c = clip();
    const k = addShapeKey(c, { name: "Open" })!;
    expect(propertyDef(`key.${k.id}`)?.kind).toBe("number");
    const row = clipAnimatableProperties(c).find((p) => p.path === `key.${k.id}`);
    expect(row?.def.label).toBe("Open");
    expect(row?.group).toBe("Shape keys");
  });
});

describe("shape keys — relativeTo", () => {
  it("a key drawn on another moves with it; the mix stays a plain sum", () => {
    const { clip } = mouth();
    const c = clip();
    const open = addShapeKey(c, { name: "Open", shape: smile(c.subpaths) })!;
    // "Wide" is drawn on top of Open: its shape = Open's + 2 down at every anchor.
    const target = copySubpaths(shapeOfKey(c, open.id) as Subpath[]);
    target[0]!.points.forEach((p) => {
      p.y += 2;
      if (p.hIn) p.hIn.y += 2;
      if (p.hOut) p.hOut.y += 2;
    });
    const wide = addShapeKey(c, { name: "Wide", relativeTo: open.id, shape: target })!;
    expect(ys(shapeOfKey(c, wide.id) as Subpath[])).toEqual([-8, 6, 6, -8]);
    // Its own delta is just the +2 — the mix with Wide alone at 1 is base + 2.
    expect(ys(pathGeometryAt(c, { [`key.${wide.id}`]: 1 }))).toEqual([2, 2, 2, 2]);
    // Re-pointing keeps its absolute shape.
    expect(setShapeKeyRelativeTo(c, wide.id, undefined)).toBe(true);
    expect(ys(shapeOfKey(c, wide.id) as Subpath[])).toEqual([-8, 6, 6, -8]);
    // Removing a reference folds it into its dependents.
    setShapeKeyRelativeTo(c, wide.id, open.id);
    removeShapeKey(c, open.id);
    expect(c.shapeKeys!.find((k) => k.id === wide.id)!.relativeTo).toBeUndefined();
    expect(ys(shapeOfKey(c, wide.id) as Subpath[])).toEqual([-8, 6, 6, -8]);
  });

  it("refuses a cycle, and a cycle written by hand never hangs", () => {
    const { clip } = mouth();
    const c = clip();
    const a = addShapeKey(c, { name: "A", shape: smile(c.subpaths) })!;
    const b = addShapeKey(c, { name: "B", relativeTo: a.id })!;
    expect(setShapeKeyRelativeTo(c, a.id, b.id)).toBe(false);
    expect(setShapeKeyRelativeTo(c, a.id, a.id)).toBe(false);
    // Forge one: A → B → A.
    (c.shapeKeys![0] as ShapeKey).relativeTo = b.id;
    expect(keyChain(c.shapeKeys!, a.id).length).toBe(2);
    expect(() => shapeOfKey(c, a.id)).not.toThrow();
    expect(ys(pathGeometryAt(c, { [`key.${a.id}`]: 1 }))).toEqual([-10, 4, 4, -10]);
  });

  it("remove drops the channel's keys, drivers and modulators", () => {
    const { clip } = mouth();
    const c = clip();
    const k = addShapeKey(c, {})!;
    c.keyframes.push({ id: "t", property: `key.${k.id}`, keys: [] } as unknown as PathClip["keyframes"][number]);
    removeShapeKey(c, k.id);
    expect(c.keyframes.some((t) => t.property === `key.${k.id}`)).toBe(false);
    expect(c.shapeKeys).toBeUndefined();
  });
});

describe("shape keys follow topology (editPathGeometry)", () => {
  it("inserting a point keeps every key's shape exactly (split in key space)", () => {
    const { clip } = mouth();
    const c = clip();
    const k = addShapeKey(c, { shape: smile(c.subpaths) })!;
    const before = pathGeometryAt(c, { [`key.${k.id}`]: 1 });
    const sample = (subs: Subpath[], i: number, t: number) => {
      const a = subs[0]!.points[i]!, b = subs[0]!.points[i + 1]!;
      const c1 = a.hOut ?? a, c2 = b.hIn ?? b, u = 1 - t;
      return u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y;
    };
    const want = sample(before, 1, 0.3);
    editPathGeometry(c, (subs) => void insertPointOnSegment(subs[0]!, 1, 0.3));
    expect(c.subpaths[0]!.points.length).toBe(5);
    const after = pathGeometryAt(c, { [`key.${k.id}`]: 1 });
    expect(after[0]!.points[2]!.y).toBeCloseTo(want, 9);
    // The neighbours' arms were shortened in key space too: the halves trace the old curve.
    expect(sample(after, 1, 0.5)).toBeCloseTo(sample(before, 1, 0.15), 6);
    expect(sample(after, 2, 0.5)).toBeCloseTo(sample(before, 1, 0.65), 6);
    // Untouched anchors keep their deltas.
    expect(after[0]!.points[0]!.y).toBe(-10);
    expect(after[0]!.points[4]!.y).toBe(-10);
  });

  it("deleting a point drops its delta; the rest stay aligned", () => {
    const { clip } = mouth();
    const c = clip();
    const k = addShapeKey(c, { shape: smile(c.subpaths) })!;
    editPathGeometry(c, (subs) => void deleteNodes(subs, [{ sub: 0, index: 1 }]));
    expect(ys(pathGeometryAt(c, { [`key.${k.id}`]: 1 }))).toEqual([-10, 4, -10]);
    const run = (c.shapeKeys![0]!.source as { delta: { contours: Record<string, number[]> } }).delta.contours[c.subpaths[0]!.id]!;
    expect(run.length).toBe(18);
  });

  it("reverse swaps the arm terms; break on a closed path duplicates the delta", () => {
    const { clip } = mouth(true);
    const c = clip();
    const k = addShapeKey(c, { shape: smile(c.subpaths) })!;
    const before = pathGeometryAt(c, { [`key.${k.id}`]: 1 });
    editPathGeometry(c, (subs) => reverseSubpaths(subs));
    const rev = pathGeometryAt(c, { [`key.${k.id}`]: 1 });
    expect(rev[0]!.points.map((p) => [p.x, p.y, p.hIn, p.hOut])).toEqual(
      [...before[0]!.points].reverse().map((p) => [p.x, p.y, p.hOut, p.hIn]),
    );
    editPathGeometry(c, (subs) => breakAtNode(subs, { sub: 0, index: 0 }));
    const broken = pathGeometryAt(c, { [`key.${k.id}`]: 1 })[0]!.points;
    expect(broken.length).toBe(5);
    expect(broken[0]!.y).toBe(broken[4]!.y);
  });

  it("joining two runs carries both runs' deltas (one reversed to meet)", () => {
    const doc = createEmptyDocument();
    const c = createPathClip({
      frameId: doc.frames[0]!.id,
      startMs: 0,
      subpaths: [
        { closed: false, points: [P(0, 0, null, [5, 0]), P(10, 0, [5, 0], null)] },
        { closed: false, points: [P(30, 0), P(20, 0)] },
      ],
    });
    const target = copySubpaths(c.subpaths);
    target[0]!.points[0]!.y = 1;
    target[0]!.points[0]!.hOut!.y = 1;
    target[1]!.points[0]!.y = 3;
    target[1]!.points[1]!.y = 2;
    const k = addShapeKey(c, { shape: target })!;
    editPathGeometry(c, (subs) => void joinEndpoints(subs, { sub: 0, index: 1 }, { sub: 1, index: 1 }));
    expect(c.subpaths.length).toBe(1);
    const pts = pathGeometryAt(c, { [`key.${k.id}`]: 1 })[0]!.points;
    expect(pts.map((p) => [p.x, p.y])).toEqual([[0, 1], [10, 0], [20, 2], [30, 3]]);
  });

  it("a moved base carries every key with it (deltas, not absolutes)", () => {
    const { clip } = mouth();
    const c = clip();
    const k = addShapeKey(c, { shape: smile(c.subpaths) })!;
    editPathGeometry(c, (subs) => subs[0]!.points.forEach((p) => (p.y += 100)));
    expect(ys(pathGeometryAt(c, { [`key.${k.id}`]: 1 }))).toEqual([90, 104, 104, 90]);
  });
});

describe("edit key mode", () => {
  it("writes the key, not the base; refuses another topology", () => {
    const { clip } = mouth();
    const c = clip();
    const k = addShapeKey(c, { name: "Smile" })!;
    const base = copySubpaths(c.subpaths);
    expect(setKeyShape(c, k.id, smile(c.subpaths))).toBe(true);
    expect(c.subpaths).toEqual(base);
    expect(ys(shapeOfKey(c, k.id) as Subpath[])).toEqual([-10, 4, 4, -10]);
    expect(setKeyShape(c, k.id, [{ id: "x", closed: false, points: [P(0, 0)] }])).toBe(false);
  });

  it("duplicate copies the delta (not shared); mirror reflects across x = 0 and names the side", () => {
    const { clip } = mouth();
    const c = clip();
    const target = copySubpaths(c.subpaths);
    target[0]!.points[0]!.y = -10; // only the LEFT corner lifts
    const k = addShapeKey(c, { name: "Smile.L", shape: target })!;
    const d = duplicateShapeKey(c, k.id)!;
    expect(d.source).not.toBe(k.source);
    const m = mirrorShapeKey(c, k.id)!;
    expect(m.name).toBe("Smile.R");
    expect(ys(shapeOfKey(c, m.id) as Subpath[])).toEqual([0, 0, 0, -10]);
  });
});

describe("edit key session", () => {
  it("shows the key as the base, saves the edit into the key, restores base and mutes", () => {
    const { doc, clip } = mouth();
    const c = clip();
    const k = addShapeKey(c, { name: "Smile", shape: smile(c.subpaths), value: 0.5 })!;
    const base = copySubpaths(c.subpaths);
    const s = beginKeyEdit(doc, c.id, k.id)!;
    expect(ys(clip().subpaths)).toEqual([-10, 4, 4, -10]);
    expect(pathGeometryAt(clip(), {})).toBe(clip().subpaths); // every key muted: WYSIWYG
    editPathGeometry(clip(), (subs) => void (subs[0]!.points[0]!.y = -20));
    expect(endKeyEdit(doc, s)).toBe("saved");
    expect(clip().subpaths[0]!.points.map((p) => p.y)).toEqual(base[0]!.points.map((p) => p.y));
    expect(clip().shapeKeys![0]!.mute).toBeUndefined();
    expect(ys(shapeOfKey(clip(), k.id) as Subpath[])).toEqual([-20, 4, 4, -10]);
  });

  it("a point added mid-edit is refused, the key keeps its shape", () => {
    const { doc, clip } = mouth();
    const c = clip();
    const k = addShapeKey(c, { shape: smile(c.subpaths) })!;
    const s = beginKeyEdit(doc, c.id, k.id)!;
    editPathGeometry(clip(), (subs) => void insertPointOnSegment(subs[0]!, 0, 0.5));
    expect(endKeyEdit(doc, s)).toBe("topology");
    expect(clip().subpaths[0]!.points.length).toBe(4);
    expect(ys(shapeOfKey(clip(), k.id) as Subpath[])).toEqual([-10, 4, 4, -10]);
  });
});

describe("keys before bones", () => {
  it("a bending path bends its MORPHED outline, and the bent clip carries no keys", () => {
    const doc = createEmptyDocument();
    const frameId = doc.frames[0]!.id;
    const c = createPathClip({ frameId, startMs: 0, durationMs: 1000, subpaths: [{ closed: false, points: [P(-100, 0), P(100, 0)] }] });
    const lane = createTrack("s");
    lane.clips.push(c);
    doc.tracks.push(lane);
    const target = copySubpaths(c.subpaths);
    target[0]!.points[1]!.y = 40;
    const k = addShapeKey(c, { shape: target, value: 1 })!;
    const rig = createRig(doc, frameId, { memberIds: [c.id], bones: [{ head: [-100, 0], tail: [0, 0] }, { head: [0, 0], tail: [100, 0] }] })!;
    const g = locateClip(doc, rig)!.clip as GroupClip;
    const path = locateClip(doc, c.id)!.clip as PathClip;
    const pose = evaluateRig(g.rig!, { planar: true });
    const m = memberOf(doc, c.id)!;
    const field = field2d(doc, m, path, pose);
    const skins = localSkins(field.weights, pose, restToRig2d(doc, m, path));
    const out = warpedVectorClip(path, {}, field, skins, 0.3);
    expect(out.shapeKeys).toBeUndefined();
    const last = out.subpaths[0]!.points.at(-1)!;
    expect(last.y).toBeCloseTo(40, 4);
    expect(k.id).toBeTruthy();
  });
});

// ── Meshes ───────────────────────────────────────────────────────────────────

function quad(): MeshData {
  return { positions: [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0], faces: [[0, 1, 2, 3]] };
}

function meshDoc(mesh = quad()) {
  const doc = createEmptyDocument();
  const frameId = doc.frames[0]!.id;
  const m = createMeshClip({ frameId, startMs: 0, durationMs: 1000, mesh });
  const t = createTrack("w");
  t.clips.push(m);
  doc.tracks.push(t);
  return { doc, clip: () => locateClip(doc, m.id)!.clip as MeshClip };
}

describe("shape keys on meshes", () => {
  it("sparse delta, morphs in evaluateGeometry, weights in the key", () => {
    const { clip } = meshDoc();
    const c = clip();
    const up = { ...quad(), positions: quad().positions.map((v, i) => (i === 8 ? 5 : v)) }; // vertex 2 z = 5
    const k = addShapeKey(c, { name: "Lift", shape: up })!;
    const d = k.source.kind === "delta" && k.source.delta.kind === "mesh" ? k.source.delta : null;
    expect(d?.verts).toEqual([2]);
    expect(d?.xyz).toEqual([0, 0, 5]);
    const g0 = evaluateGeometry(c, 0);
    expect(g0.mesh!.positions[8]).toBe(0);
    setClipProperty(c, `key.${k.id}`, 0.5);
    const g1 = evaluateGeometry(c, 0);
    expect(g1.mesh!.positions[8]).toBe(2.5);
    expect(g1.key).not.toBe(g0.key);
    // Still weights → same key and same mesh object.
    expect(evaluateGeometry(c, 0).key).toBe(g1.key);
    expect(evaluateGeometry(c, 0).mesh).toBe(g1.mesh);
  });

  it("keyed weights through bakeClipAt; the polygons are shared, not cloned per frame", () => {
    const { clip } = meshDoc();
    const c = clip();
    const k = addShapeKey(c, { shape: { ...quad(), positions: quad().positions.map((v, i) => (i === 8 ? 4 : v)) } })!;
    c.keyframes.push({ id: "t", property: `key.${k.id}`, keys: [
      { id: "a", timeMs: 0, value: 0, easing: { kind: "linear" } },
      { id: "b", timeMs: 1000, value: 1, easing: { kind: "linear" } },
    ] } as unknown as MeshClip["keyframes"][number]);
    const before = structuredClone(c);
    const baked = bakeClipAt(c, 500);
    expect(baked.geometry).toBe(c.geometry);
    expect(evaluateGeometry(baked, 500).mesh!.positions[8]).toBeCloseTo(2, 6);
    // The bake never wrote into the source.
    expect(c.shapeKeys).toEqual(before.shapeKeys);
  });

  it("modifiers run on the morphed shape (keys first in the stack)", () => {
    const { clip } = meshDoc();
    const c = clip();
    const k = addShapeKey(c, { shape: { ...quad(), positions: quad().positions.map((v, i) => (i === 8 ? 6 : v)) }, value: 1 })!;
    c.modifiers = [{ id: "s", type: "subdivision", enabled: true, levels: 1 } as unknown as MeshClip["modifiers"][number]];
    const g = evaluateGeometry(c, 0).mesh!;
    expect(g.positions.length / 3).toBeGreaterThan(4);
    let maxZ = 0;
    for (let v = 2; v < g.positions.length; v += 3) maxZ = Math.max(maxZ, g.positions[v]!);
    expect(maxZ).toBeGreaterThan(0);
    expect(k.id).toBeTruthy();
  });

  it("follows mesh edits: extrude copies the source vertex, loop cut lerps, delete drops", () => {
    const { doc, clip } = meshDoc();
    const c = clip();
    const k = addShapeKey(c, { shape: { ...quad(), positions: quad().positions.map((v, i) => (i % 3 === 2 && i >= 6 ? 4 : v)) } })!;
    // Extrude the face: four new vertices at the old ones' places.
    const ex = extrude(c.geometry.type === "mesh" ? c.geometry.mesh : quad(), selectAll(quad(), "face"));
    setMeshData(doc, c.id, ex.mesh);
    const after = clip();
    const n = after.geometry.type === "mesh" ? after.geometry.mesh.positions.length / 3 : 0;
    expect(n).toBe(8);
    const morphed = morphMesh((after.geometry as { mesh: MeshData }).mesh, after.shapeKeys, { [`key.${k.id}`]: 1 });
    const base = (after.geometry as { mesh: MeshData }).mesh;
    for (let v = 0; v < n; v++) {
      const dz = morphed.positions[v * 3 + 2]! - base.positions[v * 3 + 2]!;
      const y = base.positions[v * 3 + 1]!;
      expect(dz).toBeCloseTo(y === 10 ? 4 : 0, 6);
    }
    // Loop cut across the original quad: the new vertices sit halfway → half the lift where an end was lifted.
    const { clip: clip2, doc: doc2 } = meshDoc();
    const c2 = clip2();
    const k2 = addShapeKey(c2, { shape: { ...quad(), positions: quad().positions.map((v, i) => (i === 8 || i === 11 ? 4 : v)) } })!;
    const m2 = (c2.geometry as { mesh: MeshData }).mesh;
    const edge = meshEdges(m2).list.find((e) => e.a === 1 && e.b === 2)!;
    const cut = loopCut(m2, `${edge.a}_${edge.b}`, 0.5);
    setMeshData(doc2, c2.id, cut.mesh);
    const c2b = clip2();
    const b2 = (c2b.geometry as { mesh: MeshData }).mesh;
    const mm = morphMesh(b2, c2b.shapeKeys, { [`key.${k2.id}`]: 1 });
    for (let v = 4; v < b2.positions.length / 3; v++) expect(mm.positions[v * 3 + 2]! - b2.positions[v * 3 + 2]!).toBeCloseTo(2, 6);
    // Delete a vertex: the others keep theirs.
    const del = deleteElements(b2, { mode: "vertex", verts: [0], edges: [], faces: [] }, "vertices");
    setMeshData(doc2, c2.id, del.mesh);
    const c2c = clip2();
    const sk = c2c.shapeKeys![0]!;
    expect(sk.source.kind === "delta" && sk.source.delta.kind === "mesh" && sk.source.delta.verts.every((v) => v < del.mesh.positions.length / 3)).toBe(true);
  });

  it("an imported model's key passes its weight to the renderer", () => {
    const doc = createEmptyDocument();
    const m = createMeshClip({ frameId: doc.frames[0]!.id, startMs: 0, durationMs: 1000, assetId: "a1" });
    const k = addAssetShapeKey(m, "jawOpen")!;
    expect(evaluateGeometry(m, 0).morphs).toBeUndefined();
    setClipProperty(m, `key.${k.id}`, 0.7);
    expect(evaluateGeometry(m, 0).morphs).toEqual([{ target: "jawOpen", weight: 0.7 }]);
    expect(addShapeKey(m, {})).toBeNull();
  });
});

describe("morph identity", () => {
  it("no keys / all zero → the base object itself", () => {
    const base = quad();
    expect(morphMesh(base, undefined, {})).toBe(base);
    const subs: Subpath[] = [{ id: "s", closed: false, points: [P(0, 0), P(1, 1)] }];
    expect(morphSubpaths(subs, [], {})).toBe(subs);
  });
});
