"use client";

import { identity } from "@/editor/identity";
import { z } from "zod";
import { ApiError, applyFacePoses, defineCommand, locateClip, recognizeFace, resolveTargetFrame, type V3 } from "@solomotion/core";
import { attachmentFile, getAttachment } from "../agent/attachments";
import { importModelsAsNestedWorlds, importModelsIntoWorld, isModelFile } from "./import";

/**
 * 3D MODELS, FOR AGENTS — the drop a person makes, as a verb: a .glb/.gltf
 * (or OBJ, FBX, STL, PLY) becomes an object in a world, or a nested world in
 * a flat comp. A glTF's blendshapes arrive as shape keys; with `faces` (the
 * default) a recognisable face also gets its Mouth + Eyes pose sets, so an
 * avatar can talk in the next call.
 */
export const worldImportModel = defineCommand({
  id: "world.import_model",
  summary: "Import a 3D model (an attached or linked .glb/.gltf/obj/fbx/stl/ply): into a world as an object, or into a flat comp as a nested 3D world. Blendshapes become shape keys; a face gets talking pose sets.",
  details:
    "Into a WORLD: an object at `position` ([x,y,z], Z up). Into a flat comp: a nested world framed on the model (double-click opens it). `faces: false` skips the pose sets. Returns the layer ids, the mesh with the keys, the keys' names and the face convention found (arkit, oculus, vrm, visemes).",
  effect: "write",
  input: z.object({
    attachmentId: z.string().optional(),
    url: z.string().url().optional(),
    name: z.string().optional(),
    frameId: z.string().optional(),
    position: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
    startMs: z.number().min(0).optional(),
    faces: z.boolean().default(true),
  }),
  async run(input, rt) {
    let file: File;
    if (input.attachmentId) {
      const a = await getAttachment(input.attachmentId);
      if (!a) throw new ApiError(`No attachment "${input.attachmentId}".`);
      file = attachmentFile(a);
    } else if (input.url) {
      const res = await fetch(input.url).catch(() => null);
      if (!res?.ok) throw new ApiError("Could not download that URL from the browser.", "Ask the user to attach the file instead.");
      const blob = await res.blob();
      file = new File([blob], input.name ?? decodeURIComponent(new URL(input.url).pathname.split("/").pop() || "model.glb"), { type: blob.type });
    } else throw new ApiError("Give an attachmentId or a url.");
    if (!isModelFile(file)) throw new ApiError(`"${file.name}" is not a 3D model ${identity.name} reads.`, ".glb, .gltf, .obj, .fbx, .stl or .ply — a .blend exports to .glb from Blender.");
    const frame = resolveTargetFrame(rt, input.frameId ?? null);
    const ids = frame.world
      ? await importModelsIntoWorld(rt.store, frame.id, [file], input.position as V3)
      : await importModelsAsNestedWorlds(rt.store, { frameId: frame.id, startMs: input.startMs ?? rt.session.playheadMs() }, [file]);
    if (!ids.length) throw new ApiError(`"${file.name}" could not be read.`);
    // The mesh carrying the keys: the object itself, or the model inside the nested world.
    const doc = rt.doc();
    const placed = locateClip(doc, ids[0]!)?.clip;
    const meshId =
      placed?.kind === "mesh" ? placed.id
      : placed?.kind === "nested" ? doc.tracks.flatMap((t) => t.clips).find((c) => c.frameId === placed.sourceFrameId && c.kind === "mesh")?.id
      : undefined;
    const mesh = meshId ? locateClip(doc, meshId)?.clip : undefined;
    const keys = mesh?.kind === "mesh" ? (mesh.shapeKeys ?? []) : [];
    const face = keys.length ? recognizeFace(keys) : null;
    let poses: ReturnType<typeof applyFacePoses> = null;
    if (input.faces && meshId && face && (face.convention || face.eyes.length)) {
      rt.write("Make face talk", (d) => {
        poses = applyFacePoses(d, meshId);
      });
    }
    const p = poses as ReturnType<typeof applyFacePoses>;
    return {
      ids,
      ...(meshId ? { meshId } : {}),
      keys: keys.map((k) => k.name),
      ...(face ? { convention: face.convention, missing: face.missing } : {}),
      ...(p ? { groupId: p.groupId, mouthSetId: p.mouthSetId, eyesSetId: p.eyesSetId } : {}),
    };
  },
});
