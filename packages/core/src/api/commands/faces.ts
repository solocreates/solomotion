import { z } from "zod";
import { ApiError, defineCommand } from "../command";
import { requireClip } from "../lookup";
import { applyFacePoses, recognizeFace } from "../../world/face-presets";

/**
 * FACES, FOR AGENTS — "make this face talk" as one verb. Reads a mesh's shape
 * keys (an imported avatar's blendshapes, the procedural head's visemes),
 * names the convention, and builds the Mouth (visemes) and Eyes pose sets on
 * its character group. Lip sync and blinks then drive those sets. See
 * references/3d-faces.md.
 */
export const worldFace = defineCommand({
  id: "world.face",
  summary: "Make a 3D face talk: recognise its blendshapes (ARKit-52, Oculus/RPM visemes, VRM vowels, the built-in head's nine visemes) and build its Mouth + Eyes pose sets.",
  details:
    "`id` is the mesh (an imported .glb avatar, or world_add kind \"head\"). It is wrapped in a group if it has none; the sets go on that group (re-running rebuilds them in place). `dryRun` only reports what it recognised. Returns the group, the set ids (drive `pose.<setId>`: poses_key, or lipsync() on the Mouth set) and the visemes the face has nothing for.",
  effect: "write",
  input: z.object({
    id: z.string(),
    blendMs: z.number().min(0).max(2000).optional().describe("The ease between mouth shapes (default 120)."),
    dryRun: z.boolean().default(false),
  }),
  run(input, rt) {
    const doc = rt.doc();
    const clip = requireClip(doc, input.id).clip;
    if (clip.kind !== "mesh") throw new ApiError(`"${clip.name}" is not a 3D mesh.`, "Pass the avatar's mesh layer (world_inspect lists them).");
    const keys = clip.shapeKeys ?? [];
    if (!keys.length) throw new ApiError(`"${clip.name}" has no shape keys.`, "Import a .glb with blendshapes (morph targets), add world_add kind \"head\", or make keys with shapekey_create.");
    const face = recognizeFace(keys);
    const summary = {
      convention: face.convention,
      keys: keys.length,
      missing: face.missing,
      eyes: face.eyes.map((e) => e.name),
    };
    if (!face.convention && !face.eyes.length) {
      throw new ApiError(
        `No face convention in "${clip.name}"'s keys.`,
        `Keys: ${keys.slice(0, 12).map((k) => k.name).join(", ")}${keys.length > 12 ? "…" : ""}. Build the sets yourself with poses_create (values on key.<id>).`,
      );
    }
    if (input.dryRun) return summary;
    let result: ReturnType<typeof applyFacePoses> = null;
    rt.write("Make face talk", (d) => {
      result = applyFacePoses(d, input.id, { blendMs: input.blendMs });
    });
    const r = result as ReturnType<typeof applyFacePoses>;
    if (!r) throw new ApiError("Could not place pose sets for this face.", "The mesh must be in a comp where it can be grouped.");
    return { ...summary, groupId: r.groupId, mouthSetId: r.mouthSetId, eyesSetId: r.eyesSetId };
  },
});

export const FACE_COMMANDS = [worldFace];
