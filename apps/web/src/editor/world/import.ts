"use client";

import { toast } from "sonner";
import {
  INTERNAL_PAGE_ID,
  aimEuler,
  attachFileShapeKeys,
  createCameraClip,
  createId,
  createLightClip,
  createMeshClip,
  createNestedClip,
  createWorld,
  placeClip,
  readGltf,
  type Asset,
  type GltfFile,
  type DocumentStore,
  type PlaceClipOptions,
  type V3,
} from "@solomotion/core";
import { putAssetBlob } from "../assets/asset-store";
import { useSession } from "../state/session";
import { loadWorldEngine } from "./loader";

/**
 * 3D FILES INTO A PROJECT. Dropped into a world, a model is an object at the
 * drop point. Dropped into a 2D design, it arrives as a NESTED WORLD — a
 * private world comp holding the model, a camera framing it and a studio, on
 * a transparent backdrop — so a 3D thing sits in a flat layout like any other
 * layer, and double-clicking it opens the 3D viewport. The same move as an
 * SVG becoming editable vectors: one primitive (nesting), no special case.
 */

export const MODEL_FILE = /\.(glb|gltf|obj|stl|fbx|ply)$/i;
export const BLEND_FILE = /\.blend1?$/i;

export function isModelFile(f: File): boolean {
  return MODEL_FILE.test(f.name);
}

async function storeModel(store: DocumentStore, file: File) {
  const engine = await loadWorldEngine();
  const model = await engine.importModel(file);
  const id = createId("asset");
  await putAssetBlob(id, model.blob);
  const asset: Asset = {
    id,
    kind: "model",
    name: file.name,
    mime: model.mime,
    bytes: model.blob.size,
    width: null,
    height: null,
    durationMs: null,
    fps: null,
    folderId: null,
    origin: null,
  };
  store.update("Import model", (d) => void d.assets.push(asset));
  return { asset, model, morphs: await morphFileOf(file) };
}

/**
 * A glTF's blendshapes, read once at the drop so the new object arrives with
 * its shape keys (an avatar's 52 ARKit shapes, a VRM's A I U E O) — the
 * offsets stay in the file; the keys carry names and default weights.
 */
async function morphFileOf(file: File): Promise<GltfFile | null> {
  if (!/\.(glb|gltf)$/i.test(file.name)) return null;
  try {
    const gltf = readGltf(new Uint8Array(await file.arrayBuffer()));
    return gltf.json.meshes?.some((m) => m.primitives.some((p) => p.targets?.length)) ? gltf : null;
  } catch {
    return null;
  }
}

/** Models dropped into a WORLD: one object each, at the drop point. */
export async function importModelsIntoWorld(store: DocumentStore, frameId: string, files: File[], at: V3): Promise<string[]> {
  const ids: string[] = [];
  for (const file of files) {
    try {
      const { asset, model, morphs } = await storeModel(store, file);
      store.update("Add model", (d) => {
        const frame = d.frames.find((f) => f.id === frameId);
        const clip = createMeshClip({
          frameId,
          startMs: 0,
          durationMs: frame?.durationMs ?? d.durationMs ?? 5000,
          assetId: asset.id,
          name: model.name,
          position: at,
        });
        if (morphs) attachFileShapeKeys(clip, morphs);
        clip.fillDuration = true;
        placeClip(d, clip, { landing: "surface" });
        ids.push(clip.id);
      });
      toast.success(`Imported “${model.name}” · ${Math.round(model.triangles).toLocaleString()} triangles`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "This model could not be read.");
    }
  }
  if (ids.length) useSession.getState().select(ids);
  return ids;
}

/**
 * Models dropped into a FLAT comp: each becomes a nested world framed on the
 * model. Returns the nested clip ids.
 */
export async function importModelsAsNestedWorlds(
  store: DocumentStore,
  target: { frameId: string; startMs: number; x?: number; y?: number; placement?: PlaceClipOptions },
  files: File[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const file of files) {
    try {
      const { asset, model, morphs } = await storeModel(store, file);
      store.update("Add 3D model", (d) => {
        const parent = d.frames.find((f) => f.id === target.frameId);
        const size = { width: parent?.width ?? 1080, height: parent?.height ?? 1080 };
        const side = Math.min(size.width, size.height);
        const { frame } = createWorld(d, { starter: false, transparent: true, name: model.name, width: side, height: side, pageId: INTERNAL_PAGE_ID, fps: parent?.fps });
        const span = { frameId: frame.id, startMs: 0, durationMs: Math.max(1000, parent?.durationMs ?? d.durationMs ?? 5000) };
        const b = model.bounds;
        const centre: V3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
        const radius = Math.max(20, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2);
        // A three-quarter view that holds the whole model with a little air (50 mm).
        const dist = (radius / Math.tan(Math.atan(18 / 50))) * 1.25;
        const camPos: V3 = [centre[0] + dist * 0.6, centre[1] - dist * 0.75, centre[2] + dist * 0.35];
        const modelClip = createMeshClip({ ...span, assetId: asset.id, name: model.name });
        if (morphs) attachFileShapeKeys(modelClip, morphs);
        const objects = [
          modelClip,
          createLightClip({ ...span, type: "environment", name: "Studio", intensity: 1 }),
          createLightClip({ ...span, type: "sun", name: "Key", intensity: 2.5, rotation: [40, 0, 35] }),
          createCameraClip({ ...span, position: camPos, rotation: aimEuler(camPos, centre) }),
        ];
        for (const c of objects) {
          c.fillDuration = true;
          placeClip(d, c, { landing: "surface" });
        }
        const nested = createNestedClip({
          frameId: target.frameId,
          sourceFrameId: frame.id,
          startMs: target.startMs,
          durationMs: span.durationMs,
          x: target.x,
          y: target.y,
          name: model.name,
        });
        placeClip(d, nested, target.placement ?? { landing: "surface" });
        ids.push(nested.id);
      });
      toast.success(`“${model.name}” is a 3D world — double-click it to open`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "This model could not be read.");
    }
  }
  if (ids.length) useSession.getState().select(ids);
  return ids;
}

/** A .blend can't be read in a browser; say how to bring it in, once, plainly. */
export function explainBlendFile(): void {
  toast("Blender files open in Blender only", {
    description: "In Blender: File › Export › glTF 2.0 (.glb), then drop the .glb here — materials come with it.",
  });
}
