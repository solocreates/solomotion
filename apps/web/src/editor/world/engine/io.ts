import { identity } from "@/editor/identity";
import * as THREE from "three";
import { evaluateGeometry, evaluateWorld, frameDurationMs, frameFps, meshMorphExport, shapeKeyWeightsNow, type MotionDocument, type Frame, type MeshClip, type WorldObject } from "@solomotion/core";
import { makeColorResolver } from "../../stage/render/paint-style";
import { MODEL_MIME, formatOfName, parseModel, type ModelFormat } from "./models";
import { SceneSync, cameraMatrixToThree } from "./sync";

/**
 * 3D FILES IN AND OUT.
 *
 * In: a file is parsed once here, so a broken model fails at the drop with a
 * message instead of later as an empty object; the bytes are then stored like
 * any asset. Out: the world at an instant, through the same sync the renderer
 * uses, so what you export is what you see — glTF/GLB (the interchange
 * standard, materials and lights included), USDZ (AR on iPhone and iPad), OBJ,
 * STL (3D printing, millimetres) and PLY.
 */

export interface ImportedModel {
  format: ModelFormat;
  mime: string;
  name: string;
  blob: Blob;
  triangles: number;
  meshes: number;
  /** World-space bounds of the model as it will stand (cm, Z up). */
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

export async function importModelFile(file: File): Promise<ImportedModel> {
  const format = formatOfName(file.name);
  if (!format) throw new Error(`This file type is not a 3D model ${identity.name} reads.`);
  const bytes = await file.arrayBuffer();
  const obj = await parseModel(bytes, format);
  if (!obj) throw new Error("This model could not be read.");
  let triangles = 0;
  let meshes = 0;
  obj.traverse((n) => {
    const m = n as THREE.Mesh;
    if (!m.isMesh) return;
    meshes++;
    const g = m.geometry;
    triangles += (g.index ? g.index.count : g.getAttribute("position").count) / 3;
  });
  if (meshes === 0) throw new Error("This file has no meshes in it.");
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  return {
    format,
    mime: MODEL_MIME[format],
    name: file.name.replace(/\.[^.]+$/, ""),
    blob: new Blob([bytes], { type: MODEL_MIME[format] }),
    triangles,
    meshes,
    bounds: { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] },
  };
}

export type ExportFormat = "glb" | "gltf" | "usdz" | "obj" | "stl" | "ply";

export const EXPORT_FORMATS: Array<{ id: ExportFormat; label: string; ext: string; mime: string }> = [
  { id: "glb", label: "glTF Binary", ext: "glb", mime: "model/gltf-binary" },
  { id: "gltf", label: "glTF", ext: "gltf", mime: "model/gltf+json" },
  { id: "usdz", label: "USDZ (AR)", ext: "usdz", mime: "model/vnd.usdz+zip" },
  { id: "obj", label: "OBJ", ext: "obj", mime: "model/obj" },
  { id: "stl", label: "STL (print)", ext: "stl", mime: "model/stl" },
  { id: "ply", label: "PLY", ext: "ply", mime: "application/octet-stream" },
];

export interface ExportModelOptions {
  /** Only these objects (a selection); absent = the whole world. */
  only?: readonly string[];
  /**
   * Bake the comp's motion into the file (glTF / GLB): every object's and the
   * live camera's move, sampled at the comp's frame rate. Objects outside
   * their span scale to nothing, the convention every glTF viewer reads.
   */
  animate?: boolean;
}

export async function exportWorldModel(
  doc: MotionDocument,
  frame: Frame,
  timeMs: number,
  format: ExportFormat,
  opts: ExportModelOptions = {},
): Promise<Blob> {
  const ev = evaluateWorld(doc, frame, timeMs);
  const sync = new SceneSync();
  try {
    sync.sync(ev, { doc, frame, shading: "rendered", resolve: makeColorResolver(doc), density: 2 });
    // The sync's root is metres, Z-up. Interchange formats are Y-up (glTF,
    // USD, OBJ by convention); print formats stay Z-up, in millimetres.
    const out = new THREE.Group();
    out.name = frame.name || "World";
    const content = sync.root.clone(true);
    content.name = "Objects";
    out.add(content);
    const print = format === "stl" || format === "ply";
    if (print) {
      content.scale.setScalar(10); // cm → mm
    } else {
      out.rotation.x = -Math.PI / 2;
    }
    const only = opts.only ? new Set(opts.only) : null;
    const names = new Map(ev.objects.map((o) => [o.id, o.clip.name || o.clip.kind]));
    const guides = new Set(ev.objects.filter((o) => o.clip.kind === "mesh" && o.clip.lattice).map((o) => o.id));
    const holders = new Map<string, THREE.Object3D>();
    for (const h of [...content.children]) {
      const id = h.userData.clipId as string | undefined;
      if (!id) continue;
      // A lattice cage is a guide, never part of the model.
      if ((only && !only.has(id)) || guides.has(id)) {
        content.remove(h);
        continue;
      }
      // Named like the layer, so the outliner on the other side reads like ours.
      h.name = names.get(id) ?? id;
      holders.set(id, h);
    }
    const morphs = writeMorphTargets(ev.objects, holders);
    // Lines, wires and helpers are viewport furniture, never part of a model;
    // a screen-width curve has no surface to export.
    content.traverse((n) => {
      if (n.userData.overlay || n.userData.curve) n.visible = false;
    });
    // The live camera comes along for interchange (not into a print).
    let camera: THREE.Camera | null = null;
    if (!print && !only) {
      camera = new THREE.PerspectiveCamera(ev.camera.projection.type === "perspective" ? ev.camera.projection.fovY : 40, frame.width / frame.height, 0.01, 1000);
      camera.name = ev.camera.clipId ? (names.get(ev.camera.clipId) ?? "Camera") : "Camera";
      cameraMatrixToThree(ev.camera.matrix, camera);
      camera.matrixAutoUpdate = true;
      camera.matrix.decompose(camera.position, camera.quaternion, camera.scale);
      out.add(camera);
    }
    out.updateMatrixWorld(true);
    switch (format) {
      case "glb":
      case "gltf": {
        const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
        const animations = opts.animate ? [bakeMotion(doc, frame, holders, camera, morphs)] : [];
        const result = await new GLTFExporter().parseAsync(out, { binary: format === "glb", onlyVisible: true, trs: true, animations });
        return format === "glb"
          ? new Blob([result as ArrayBuffer], { type: "model/gltf-binary" })
          : new Blob([JSON.stringify(result)], { type: "model/gltf+json" });
      }
      case "usdz": {
        const { USDZExporter } = await import("three/examples/jsm/exporters/USDZExporter.js");
        const bytes = await new USDZExporter().parseAsync(out);
        return new Blob([bytes as BlobPart], { type: "model/vnd.usdz+zip" });
      }
      case "obj": {
        const { OBJExporter } = await import("three/examples/jsm/exporters/OBJExporter.js");
        return new Blob([new OBJExporter().parse(out)], { type: "model/obj" });
      }
      case "stl": {
        const { STLExporter } = await import("three/examples/jsm/exporters/STLExporter.js");
        const data = new STLExporter().parse(out, { binary: true }) as DataView;
        return new Blob([data.buffer as ArrayBuffer], { type: "model/stl" });
      }
      case "ply": {
        const { PLYExporter } = await import("three/examples/jsm/exporters/PLYExporter.js");
        const data = await new Promise<string | ArrayBuffer>((res) => new PLYExporter().parse(out, (r) => res(r as string | ArrayBuffer), { binary: true }));
        return new Blob([data], { type: "application/octet-stream" });
      }
    }
  } finally {
    sync.dispose();
  }
}

/**
 * A mesh whose shape keys travel as morph targets, and how to read its
 * weights at any instant (by target name) for the weights animation.
 */
interface MorphNode {
  clipId: string;
  mesh: THREE.Mesh;
  names: string[];
  weightsOf(o: WorldObject): Map<string, number>;
}

/**
 * SHAPE KEYS AS MORPH TARGETS. A mesh with delta keys is exported as its
 * BASE plus one relative target per key (names → `extras.targetNames`,
 * weights at the instant → the mesh's default `weights`), so another tool
 * receives blendshapes it can drive, not one frozen mouth. An imported model
 * already carries its file's targets on the clone (the sync weighted them).
 * Swaps geometry on the CLONE only — the sync's own buffers are untouched.
 */
function writeMorphTargets(objects: WorldObject[], holders: Map<string, THREE.Object3D>): MorphNode[] {
  const out: MorphNode[] = [];
  for (const o of objects) {
    const holder = holders.get(o.id);
    if (!holder || o.clip.kind !== "mesh") continue;
    const clip = o.clip as MeshClip;
    if (clip.geometry.type === "asset") {
      holder.traverse((n) => {
        const m = n as THREE.Mesh;
        if (!m.isMesh || !m.morphTargetDictionary) return;
        const names = Object.keys(m.morphTargetDictionary);
        out.push({
          clipId: o.id,
          mesh: m,
          names,
          weightsOf: (at) => {
            const w = new Map<string, number>();
            for (const { target, weight } of evaluateGeometry(at.clip as MeshClip, at.localMs).morphs ?? []) {
              const name = typeof target === "number" ? names.find((k) => m.morphTargetDictionary![k] === target) : target;
              if (name !== undefined) w.set(name, weight);
            }
            return w;
          },
        });
      });
      continue;
    }
    const mx = meshMorphExport(clip);
    if (!mx) continue;
    let mesh: THREE.Mesh | null = null;
    holder.traverse((n) => {
      if (!mesh && (n as THREE.Mesh).isMesh && !n.userData.overlay) mesh = n as THREE.Mesh;
    });
    const target = mesh as THREE.Mesh | null;
    if (!target) continue;
    const corners = mx.base.corners.length;
    if ((target.geometry.getAttribute("position")?.count ?? -1) !== corners) continue;
    const geo = target.geometry.clone();
    geo.setAttribute("position", new THREE.BufferAttribute(mx.base.positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(mx.base.normals, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(mx.base.uvs, 2));
    geo.morphAttributes.position = mx.targets.map((t) => new THREE.BufferAttribute(t, 3));
    geo.morphTargetsRelative = true;
    target.geometry = geo;
    target.morphTargetDictionary = Object.fromEntries(mx.names.map((n, i) => [n, i]));
    target.morphTargetInfluences = [...mx.weights];
    const nameOf = new Map(mx.ids.map((id, i) => [id, mx.names[i]!]));
    out.push({
      clipId: o.id,
      mesh: target,
      names: mx.names,
      weightsOf: (at) => new Map([...shapeKeyWeightsNow(at.clip as MeshClip)].flatMap(([id, w]) => (nameOf.has(id) ? [[nameOf.get(id)!, w] as [string, number]] : []))),
    });
  }
  return out;
}

/**
 * THE COMP'S MOTION as one glTF animation: each exported object's place (and
 * the live camera's) sampled every frame of the comp, as TRS tracks on the
 * nodes the file already has. Rotations are kept on one hemisphere so the
 * player's interpolation never takes the long way round.
 */
function bakeMotion(doc: MotionDocument, frame: Frame, holders: Map<string, THREE.Object3D>, camera: THREE.Camera | null, morphs: MorphNode[] = []): THREE.AnimationClip {
  const fps = frameFps(doc, frame);
  const duration = Math.max(1 / fps, frameDurationMs(doc, frame) / 1000);
  const steps = Math.min(36000, Math.max(1, Math.ceil(duration * fps)));
  const times: number[] = [];
  const pos = new Map<THREE.Object3D, number[]>();
  const rot = new Map<THREE.Object3D, number[]>();
  const scl = new Map<THREE.Object3D, number[]>();
  const nodes = [...holders.values(), ...(camera ? [camera] : [])];
  for (const n of nodes) (pos.set(n, []), rot.set(n, []), scl.set(n, []));
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  const prevQ = new Map<THREE.Object3D, THREE.Quaternion>();
  const push = (n: THREE.Object3D, visible: boolean) => {
    if (!visible) {
      // Gone: keep the last place, at no size.
      const ps = pos.get(n)!, rs = rot.get(n)!;
      pos.get(n)!.push(...(ps.length ? ps.slice(-3) : [0, 0, 0]));
      rot.get(n)!.push(...(rs.length ? rs.slice(-4) : [0, 0, 0, 1]));
      scl.get(n)!.push(0, 0, 0);
      return;
    }
    m.decompose(p, q, sc);
    const last = prevQ.get(n);
    if (last && last.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
    prevQ.set(n, q.clone());
    pos.get(n)!.push(p.x, p.y, p.z);
    rot.get(n)!.push(q.x, q.y, q.z, q.w);
    scl.get(n)!.push(sc.x, sc.y, sc.z);
  };
  const cam = new THREE.PerspectiveCamera();
  // Keyed shape-key weights, one run per (mesh, target): glTF's `weights` channel.
  const weightRuns = morphs.map((mn) => mn.names.map(() => [] as number[]));
  for (let i = 0; i <= steps; i++) {
    const t = Math.min(duration, i / fps);
    times.push(t);
    const ev = evaluateWorld(doc, frame, t * 1000);
    const at = new Map(ev.objects.map((o) => [o.id, o]));
    for (const [id, n] of holders) {
      const o = at.get(id);
      if (o) m.fromArray(o.matrix);
      push(n, !!o);
    }
    morphs.forEach((mn, mi) => {
      const o = at.get(mn.clipId);
      const w = o ? mn.weightsOf(o) : null;
      mn.names.forEach((name, ni) => weightRuns[mi]![ni]!.push(w?.get(name) ?? 0));
    });
    if (camera) {
      cameraMatrixToThree(ev.camera.matrix, cam);
      m.copy(cam.matrix);
      push(camera, true);
    }
  }
  const tracks: THREE.KeyframeTrack[] = [];
  for (const n of nodes) {
    tracks.push(
      new THREE.VectorKeyframeTrack(`${n.uuid}.position`, times, pos.get(n)!),
      new THREE.QuaternionKeyframeTrack(`${n.uuid}.quaternion`, times, rot.get(n)!),
      new THREE.VectorKeyframeTrack(`${n.uuid}.scale`, times, scl.get(n)!),
    );
  }
  morphs.forEach((mn, mi) => {
    // A target that never moves needs no track; its default weight holds.
    mn.names.forEach((name, ni) => {
      const run = weightRuns[mi]![ni]!;
      if (run.some((v) => v !== run[0])) tracks.push(new THREE.NumberKeyframeTrack(`${mn.mesh.uuid}.morphTargetInfluences[${name}]`, times, run));
    });
  });
  return new THREE.AnimationClip(frame.name || "Animation", duration, tracks);
}
