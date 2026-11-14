import * as THREE from "three";
import { getAssetBlob } from "../../assets/asset-store";

/**
 * IMPORTED MODELS — a file's scene as a reusable template, converted ONCE at
 * the boundary into the world's convention (Z up, 1 unit = 1 cm) so nothing
 * else ever knows which tool a model came from.
 *
 *   glTF / GLB  Y-up metres (the standard)   → turn +90° about X, ×100
 *   FBX / OBJ   Y-up, units vary             → turn, then fit to ~2 m
 *   STL / PLY   usually Z-up, units vary     → fit to ~2 m
 *
 * Fitting is only for formats that carry no reliable unit: a scanned STL in
 * millimetres would otherwise arrive a hundred times too big or too small. A
 * glTF's metres are honoured exactly.
 */

export type ModelFormat = "glb" | "gltf" | "obj" | "stl" | "fbx" | "ply";

export const MODEL_EXTENSIONS: Record<string, ModelFormat> = {
  glb: "glb", gltf: "gltf", obj: "obj", stl: "stl", fbx: "fbx", ply: "ply",
};

export const MODEL_MIME: Record<ModelFormat, string> = {
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  obj: "model/obj",
  stl: "model/stl",
  fbx: "model/vnd.fbx",
  ply: "model/ply",
};

export function formatOfName(name: string): ModelFormat | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return MODEL_EXTENSIONS[ext] ?? null;
}

const templates = new Map<string, THREE.Object3D>();
const pending = new Map<string, Promise<THREE.Object3D | null>>();
/** The format each asset was imported as (asset id → format), registered by the importer. */
const formats = new Map<string, ModelFormat>();

export function registerModelFormat(assetId: string, format: ModelFormat): void {
  formats.set(assetId, format);
}

export function peekModelTemplate(assetId: string): THREE.Object3D | null {
  return templates.get(assetId) ?? null;
}

export function loadModelTemplate(assetId: string, formatHint?: ModelFormat): Promise<THREE.Object3D | null> {
  const hit = templates.get(assetId);
  if (hit) return Promise.resolve(hit);
  let p = pending.get(assetId);
  if (!p) {
    p = (async () => {
      const blob = await getAssetBlob(assetId);
      if (!blob) return null;
      const bytes = await blob.arrayBuffer();
      const format = formatHint ?? formats.get(assetId) ?? sniff(blob, bytes);
      const obj = await parseModel(bytes, format);
      if (!obj) return null;
      templates.set(assetId, obj);
      return obj;
    })().catch(() => null);
    pending.set(assetId, p);
  }
  return p;
}

/**
 * Which format a stored model is. The MIME first — but the asset store keeps
 * bytes in OPFS, which does not keep a type, so a reloaded model arrives as
 * "" and is recognised by its CONTENT: every format here has a signature.
 */
function sniff(blob: Blob, bytes: ArrayBuffer): ModelFormat {
  for (const [f, mime] of Object.entries(MODEL_MIME) as Array<[ModelFormat, string]>) if (blob.type === mime) return f;
  const head = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 512));
  const text = String.fromCharCode(...head);
  if (text.startsWith("glTF")) return "glb";
  if (text.startsWith("ply")) return "ply";
  if (text.startsWith("Kaydara FBX Binary") || /^\s*;\s*FBX/.test(text)) return "fbx";
  if (/^\s*\{/.test(text)) return "gltf";
  // Binary STL: an 80-byte header, a triangle count, 50 bytes per triangle.
  if (bytes.byteLength >= 84 && 84 + new DataView(bytes).getUint32(80, true) * 50 === bytes.byteLength) return "stl";
  if (/^\s*solid\b/.test(text) && /facet\s+normal/.test(text)) return "stl";
  if (/^(\s*(#.*|[ovfgsu]\b.*|vn .*|vt .*|mtllib .*|usemtl .*)?\r?\n)*/.test(text) && /(^|\n)\s*v\s+-?[\d.]/.test(text)) return "obj";
  return "glb";
}

/** Parse bytes into a Z-up, centimetre template. */
export async function parseModel(bytes: ArrayBuffer, format: ModelFormat): Promise<THREE.Object3D | null> {
  let obj: THREE.Object3D | null = null;
  let yUp = true;
  let fit = false;
  if (format === "glb" || format === "gltf") {
    const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
    const gltf = await new GLTFLoader().parseAsync(bytes, "");
    obj = gltf.scene;
    obj.scale.setScalar(100);
  } else if (format === "obj") {
    const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
    obj = new OBJLoader().parse(new TextDecoder().decode(bytes));
    fit = true;
  } else if (format === "fbx") {
    const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
    obj = new FBXLoader().parse(bytes, "");
    fit = true;
  } else if (format === "stl") {
    const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
    const geo = new STLLoader().parse(bytes);
    geo.computeVertexNormals();
    obj = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xc9cbd1, roughness: 0.5 }));
    yUp = false;
    fit = true;
  } else if (format === "ply") {
    const { PLYLoader } = await import("three/examples/jsm/loaders/PLYLoader.js");
    const geo = new PLYLoader().parse(bytes);
    geo.computeVertexNormals();
    const hasColor = !!geo.getAttribute("color");
    obj = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: hasColor ? 0xffffff : 0xc9cbd1, vertexColors: hasColor, roughness: 0.6 }));
    yUp = false;
    fit = true;
  }
  if (!obj) return null;
  const wrap = new THREE.Group();
  if (yUp) wrap.rotation.x = Math.PI / 2;
  wrap.add(obj);
  if (fit) {
    wrap.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(wrap);
    const size = box.getSize(new THREE.Vector3());
    const big = Math.max(size.x, size.y, size.z);
    if (big > 0) {
      const k = 200 / big;
      wrap.scale.multiplyScalar(k);
      // Stand it on the floor, centred on its origin.
      const c = box.getCenter(new THREE.Vector3()).multiplyScalar(k);
      wrap.position.set(-c.x, -c.y, -box.min.z * k);
    }
  }
  wrap.updateMatrixWorld(true);
  return wrap;
}

export function dropModelTemplate(assetId: string): void {
  templates.delete(assetId);
  pending.delete(assetId);
}
