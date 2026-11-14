import { z } from "zod";
import type { MeshClip, MeshData, VisualClip } from "../../schema";
import { extrudeSchema, lightTypeSchema, lineArtSchema, worldSpecSchema } from "../../schema/world";
import { createId } from "../../ids";
import { placeClip } from "../../timeline/place";
import { createTextClip } from "../../factories";
import { ApiError, defineCommand } from "../command";
import { requireClip, requirePage, resolveTargetFrame } from "../lookup";
import {
  createCameraClip,
  createEmptyClip,
  createLightClip,
  setChildOf,
  createMeshClip,
  createWorld,
  makeMeshEditable,
  aimEuler,
  setMeshData,
  applyModifier,
  addLattice,
  makeCameraActive,
  materializeDefaultCamera,
} from "../../world/ops";
import { activeCameraAt, evaluateWorld, objectWorldBounds } from "../../world/evaluate";
import { frameIntoWorld, moveIntoWorld } from "../../world/flat3d";
import { isBodyClip } from "../../world/body";
import { buildPrimitive, primitiveDef } from "../../world/primitives";
import { createTalkingHeadClip } from "../../world/face-head";
import { slotBesidePage } from "../../pages";
import { applyMaterialPreset, materialPreset, MATERIAL_PRESETS } from "../../world/material-presets";
import { decomposeTrs, matPosition, type V3 } from "../../world/math";
import { faceNormal, meshStats, recalcNormalsOutside, flipFaces } from "../../world/mesh";
import {
  deleteElements,
  extrude,
  fillFace,
  bridgeLoops,
  spinSelection,
  insetFaces,
  loopCut,
  mergeVerts,
  selectedFaces,
  selectedVerts,
  selectionNormal,
  subdivideFaces,
  transformVerts,
  transformVertsWeighted,
  proportionalWeights,
  mirrorSelection,
  selectionMedian,
  FALLOFFS,
  type MeshSelection,
} from "../../world/edit";
import { rotation4, translate4, scale4, mul4 } from "../../world/math";
import { edgeKey } from "../../world/mesh";
import { catmullClark } from "../../world/modifiers";
import { SCULPT_BRUSHES, SCULPT_SPACING, SculptSession, type SculptBrush } from "../../world/sculpt";

/**
 * THE 3D WORLD, FOR AGENTS — every verb a person's viewport gesture has, so a
 * scene an agent builds and one a person builds are the same objects (ADR-3d).
 * Axes: Z up, 1 unit = 1 px = 1 cm. Values that animate are ordinary property
 * paths for `layer_set` / `keyframes_set` (`z`, `rotationX`, `camera.focalLength`,
 * `light.intensity`, `material.roughness`, `geometry.<param>`, `mdf.<id>.<field>`).
 */

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

function requireWorld(rt: Parameters<typeof resolveTargetFrame>[0], frameId?: string) {
  const frame = resolveTargetFrame(rt, frameId);
  if (!frame.world) throw new ApiError(`"${frame.name}" is a flat comp, not a 3D world.`, "world.create makes one; layers_nest a world into a flat comp to use it there.");
  return frame;
}

export const worldCreate = defineCommand({
  id: "world.create",
  summary: "Make a 3D WORLD comp — Z up, 1 unit = 1 px. Starts with a camera, a key light, a studio and a cube unless `starter: false`.",
  details:
    "A world is a comp: nest it into a flat comp (layers_nest / layer_create kind comp) to place it in a design — it renders through its live camera. `transparent` gives it no backdrop (for compositing over 2D). Size is the camera's output.",
  effect: "write",
  input: z.object({
    name: z.string().optional(),
    width: z.number().int().positive().default(1920),
    height: z.number().int().positive().default(1080),
    starter: z.boolean().default(true),
    transparent: z.boolean().default(false),
    pageId: z.string().optional().describe("Page to put it on (id or name); omitted = the focused comp's page."),
  }),
  run(input, rt) {
    let frameId = "";
    let objects: string[] = [];
    rt.write("Create 3D world", (d) => {
      // A page by id OR name, like frame.create — a name stored raw as the
      // pageId filed the world on a page that does not exist.
      const asked = input.pageId ? requirePage(d, input.pageId).id : null;
      // Beside the page's comps, as frame.create places one — at x 0 a world
      // landed ON TOP of the first comp (found building the Talking Characters template).
      const page = asked ?? d.frames.find((f) => f.id === rt.session.focusFrameId())?.pageId ?? d.pages[0]?.id ?? null;
      const x = page ? slotBesidePage(d, page) : null;
      const r = createWorld(d, { name: input.name ?? "World", width: input.width, height: input.height, starter: input.starter, transparent: input.transparent, pageId: asked });
      if (x !== null) r.frame.x = x;
      frameId = r.frame.id;
      objects = r.clipIds;
    });
    return { frameId, objects };
  },
});

export const worldAdd = defineCommand({
  id: "world.add",
  summary: "Add a 3D object to a world: a mesh primitive, a camera, a light, a text standing in space, or a talking head.",
  details:
    "`position` is [x, y, z] (Z up). Cameras and lights look down their −Z: give `lookAt` (a point or a layer id) to aim them. Mesh `primitive` ids: catalog_list primitives; `params` override its defaults (keyed later at `geometry.<param>`). `material` is a preset id (catalog_list materials).",
  effect: "write",
  input: z.object({
    frameId: z.string().optional(),
    kind: z.enum(["mesh", "camera", "light", "text", "controller", "head"]).describe("`head`: a stylised 3D head with viseme + blink shape keys — world_face makes it talk."),
    primitive: z.string().default("cube"),
    params: z.record(z.string(), z.number()).optional(),
    light: lightTypeSchema.default("point"),
    position: vec3.default([0, 0, 0]),
    rotation: vec3.optional().describe("Degrees, XYZ (Blender)."),
    scale: z.union([vec3, z.number()]).optional().describe("Size multiplier: one number, or [x, y, z]."),
    eyes: z.boolean().default(true).describe("`head`: false builds it without eyes — put eyeballs and lids of their own in the sockets (`talkingHeadEyes`)."),
    lookAt: z.union([vec3, z.string()]).optional(),
    color: z.string().optional(),
    material: z.string().optional(),
    intensity: z.number().optional(),
    focalLength: z.number().optional(),
    text: z.string().optional(),
    name: z.string().optional(),
    startMs: z.number().min(0).optional(),
    durationMs: z.number().positive().optional(),
  }),
  run(input, rt) {
    const frame = requireWorld(rt, input.frameId);
    if (input.kind === "mesh" && !primitiveDef(input.primitive)) throw new ApiError(`No primitive "${input.primitive}".`, "catalog_list primitives");
    // A param name the primitive does not have was silently dropped: `torus {radius, tube}` built the
    // default 25-unit tube, which scaled ×11 swallowed the whole frame. Refuse it and name the real ones.
    const def = input.kind === "mesh" ? primitiveDef(input.primitive) : undefined;
    const wrong = def ? Object.keys(input.params ?? {}).filter((k) => !def.params.some((p) => p.key === k)) : [];
    if (def && wrong.length)
      throw new ApiError(`A ${def.id} has no ${wrong.map((w) => `"${w}"`).join(", ")}.`, `Its params: ${def.params.map((p) => p.key).join(", ")}.`);
    const preset = input.material ? materialPreset(input.material) : undefined;
    if (input.material && !preset) throw new ApiError(`No material preset "${input.material}".`, "catalog_list materials");
    let id = "";
    rt.write(`Add ${input.kind}`, (d) => {
      const span = {
        frameId: frame.id,
        startMs: input.startMs ?? 0,
        durationMs: input.durationMs ?? (frame.durationMs ?? d.durationMs ?? 5000),
      };
      let target: V3 | null = null;
      if (Array.isArray(input.lookAt)) target = input.lookAt as V3;
      else if (typeof input.lookAt === "string") {
        const t = requireClip(d, input.lookAt).clip;
        if (t.kind !== "audio") target = [t.transform.x, t.transform.y, t.transform.z ?? 0];
      }
      const pos = input.position as V3;
      const rot = (input.rotation as V3 | undefined) ?? (target ? aimEuler(pos, target) : undefined);
      let clip;
      if (input.kind === "mesh") {
        clip = createMeshClip({ ...span, primitive: input.primitive, params: input.params, position: pos, rotation: rot, color: input.color ?? preset?.color ?? undefined, name: input.name });
        if (preset) Object.assign(clip.material, preset.material, { preset: preset.id });
      } else if (input.kind === "camera") {
        clip = createCameraClip({ ...span, position: pos, rotation: rot ?? [90, 0, 0], name: input.name, focalLength: input.focalLength });
      } else if (input.kind === "head") {
        clip = createTalkingHeadClip({ ...span, position: pos, rotation: rot, name: input.name, eyes: input.eyes });
      } else if (input.kind === "controller") {
        clip = createEmptyClip({ ...span, position: pos, rotation: rot, name: input.name });
      } else if (input.kind === "light") {
        clip = createLightClip({ ...span, type: input.light, position: pos, rotation: rot, name: input.name, intensity: input.intensity });
        if (input.color) clip.light.color = input.color;
      } else {
        clip = createTextClip({ ...span, text: input.text ?? "Text", presetId: null, x: pos[0], y: pos[1] });
        clip.transform.z = pos[2];
        if (rot) [clip.transform.rotationX, clip.transform.rotationY, clip.transform.rotation] = rot;
        if (input.color) clip.style.color = input.color;
        if (input.name) clip.name = input.name;
      }
      if (input.scale !== undefined) {
        const sc: V3 = typeof input.scale === "number" ? [input.scale, input.scale, input.scale] : (input.scale as V3);
        clip.transform.scale = sc[0];
        clip.transform.scaleY = sc[1] === sc[0] ? null : sc[1];
        if (sc[2] !== sc[0]) clip.transform.scaleZ = sc[2];
      }
      // A 3D object lives for the whole shot unless told otherwise.
      if (input.startMs === undefined && input.durationMs === undefined) clip.fillDuration = true;
      placeClip(d, clip, { landing: "settle" });
      id = clip.id;
    });
    return { id };
  },
});

export const worldInspect = defineCommand({
  id: "world.inspect",
  summary: "Read a world at an instant: every object's world position, rotation and size, the live camera, and how the scene is lit.",
  details: "Numbers to check your work cheaply before (or instead of) a render — is the object in front of the camera, did the move land, which camera is live.",
  effect: "read",
  input: z.object({ frameId: z.string().optional(), atMs: z.number().min(0).optional() }),
  run(input, rt) {
    const frame = requireWorld(rt, input.frameId);
    const doc = rt.doc();
    const t = input.atMs ?? rt.session.playheadMs();
    const ev = evaluateWorld(doc, frame, t);
    const round = (v: number) => Math.round(v * 10) / 10;
    return {
      frameId: frame.id,
      atMs: t,
      output: [frame.width, frame.height],
      camera: {
        id: ev.camera.clipId ?? "default",
        position: matPosition(ev.camera.matrix).map(round),
        rotation: decomposeTrs(ev.camera.matrix).rotation.map(round),
        fovY: round(ev.camera.projection.fovY),
      },
      environment: ev.environment ? { id: ev.environment.id } : null,
      objects: ev.objects.map((o) => {
        const b = objectWorldBounds(o, doc);
        const trs = decomposeTrs(o.matrix);
        return {
          id: o.id,
          name: o.clip.name,
          kind: o.kind === "plane" ? `plane (${o.clip.kind})` : o.kind,
          position: trs.position.map(round),
          rotation: trs.rotation.map(round),
          ...(o.kind === "mesh" || o.kind === "plane" ? { size: [0, 1, 2].map((k) => round(b.max[k]! - b.min[k]!)) } : {}),
          ...(o.opacity !== 1 ? { opacity: Math.round(o.opacity * 100) / 100 } : {}),
        };
      }),
      liveCameraAtMs: activeCameraAt(doc, frame, t),
    };
  },
});

const selectionInput = z
  .object({
    mode: z.enum(["vertex", "edge", "face"]).default("face"),
    faces: z.array(z.number().int().min(0)).optional(),
    verts: z.array(z.number().int().min(0)).optional(),
    /** Faces whose normal points this way (object space), e.g. "+z" = the top. */
    facing: z.enum(["+x", "-x", "+y", "-y", "+z", "-z"]).optional(),
    /** The POINTS at that end of the shape (object space), e.g. "+z" = the topmost layer — a cylinder's top rim, a lattice cage's top row. */
    side: z.enum(["+x", "-x", "+y", "-y", "+z", "-z"]).optional(),
    all: z.boolean().optional(),
  })
  .default({ mode: "face", all: true });

function resolveSelection(mesh: MeshData, s: z.infer<typeof selectionInput>): MeshSelection {
  if (s.all) {
    return { mode: s.mode, verts: s.mode === "vertex" ? mesh.positions.map((_, i) => i).filter((i) => i < mesh.positions.length / 3) : [], edges: [], faces: s.mode === "face" ? mesh.faces.map((_, i) => i) : [] };
  }
  if (s.side) {
    const axis = "xyz".indexOf(s.side[1]!);
    const vals = Array.from({ length: mesh.positions.length / 3 }, (_, i) => mesh.positions[i * 3 + axis]!);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const end = s.side[0] === "+" ? hi : lo;
    const tol = Math.max(1e-4, (hi - lo) * 1e-3);
    return { mode: "vertex", verts: vals.map((v, i) => (Math.abs(v - end) <= tol ? i : -1)).filter((i) => i >= 0), edges: [], faces: [] };
  }
  if (s.facing) {
    const axis = "xyz".indexOf(s.facing[1]!);
    const sign = s.facing[0] === "+" ? 1 : -1;
    const faces = mesh.faces.map((f, i) => (faceNormal(mesh, f)[axis]! * sign > 0.9 ? i : -1)).filter((i) => i >= 0);
    return { mode: "face", verts: [], edges: [], faces };
  }
  return { mode: s.mode, verts: s.verts ?? [], edges: [], faces: s.faces ?? [] };
}

export const meshEdit = defineCommand({
  id: "mesh.edit",
  summary: "Edit a mesh's polygons — extrude, inset, subdivide, loop cut, merge, delete, fill, flip, move/rotate/scale the selected part.",
  details:
    "A primitive is made editable first (its size params stop being animatable). `bridge` joins two selected edge loops (or two face groups) with a band of faces; `spin` sweeps the selected points and edges around `axis` through `by` by `deg` (default 360) in `steps`. Select faces by index, by `facing` (\"+z\" = the top faces) or `all`; points by index (`mode: \"vertex\", verts`) or by `side` (\"+z\" = the topmost points — a lattice cage's top row). `extrude` moves the new faces `amount` along their normal; `inset` takes `amount` (and an optional `depth`). Returns the new counts and the faces left selected, to chain the next step.",
  effect: "write",
  input: z.object({
    id: z.string(),
    op: z.enum(["extrude", "inset", "subdivide", "loopCut", "merge", "delete", "fill", "flip", "recalc", "move", "rotate", "scale", "mirror", "bridge", "spin", "makeEditable"]),
    steps: z.number().int().min(1).max(256).optional().describe("spin: how many steps the sweep takes (default 12)"),
    select: selectionInput,
    amount: z.number().optional(),
    depth: z.number().optional(),
    by: vec3.optional().describe("move: the offset, object space. mirror: the point the mirror plane passes through (default: the selection's centre)."),
    axis: z.enum(["x", "y", "z"]).optional(),
    deg: z.number().optional(),
    factor: z.number().optional(),
    deleteKind: z.enum(["vertices", "edges", "faces", "onlyFaces"]).default("faces"),
    proportional: z
      .object({ radius: z.number().positive(), falloff: z.enum(FALLOFFS).default("smooth") })
      .optional()
      .describe("move/rotate/scale: neighbours within `radius` follow by the falloff (Blender's O) — a hill from one vertex, a soft bulge from a face."),
  }),
  run(input, rt) {
    let result: { vertices: number; faces: number; selected: number[] } = { vertices: 0, faces: 0, selected: [] };
    rt.write("Edit mesh", (d) => {
      const loc = requireClip(d, input.id);
      const clip = loc.clip;
      if (clip.kind !== "mesh") throw new ApiError(`"${clip.name}" is not a mesh.`);
      if (clip.geometry.type === "asset") throw new ApiError("An imported model edits as polygons once made editable; it is kept as its file until then.");
      makeMeshEditable(clip);
      const mesh = (clip as MeshClip).geometry.type === "mesh" ? (clip.geometry as { mesh: MeshData }).mesh : buildPrimitive("cube", {})!;
      const shape = (m: MeshData, vs: Set<number>, mat: ReturnType<typeof translate4>) =>
        input.proportional
          ? transformVertsWeighted(m, proportionalWeights(m, vs, input.proportional.radius, { falloff: input.proportional.falloff }), mat)
          : transformVerts(m, vs, mat);
      const sel = resolveSelection(mesh, input.select);
      let out: { mesh: MeshData; selection: MeshSelection } = { mesh, selection: sel };
      switch (input.op) {
        case "makeEditable":
          break;
        case "extrude": {
          const n = selectionNormal(mesh, sel);
          const ex = extrude(mesh, sel);
          const moved = transformVerts(ex.mesh, selectedVerts(ex.mesh, ex.selection), translate4([n[0] * (input.amount ?? 50), n[1] * (input.amount ?? 50), n[2] * (input.amount ?? 50)]));
          out = { mesh: moved, selection: ex.selection };
          break;
        }
        case "inset":
          out = insetFaces(mesh, sel, input.amount ?? 20, input.depth ?? 0);
          break;
        case "subdivide":
          out = subdivideFaces(mesh, sel);
          break;
        case "loopCut": {
          const f = selectedFaces(mesh, sel).values().next().value;
          const face = f !== undefined ? mesh.faces[f] : mesh.faces[0];
          if (!face) throw new ApiError("The mesh has no faces to cut through.");
          out = loopCut(mesh, edgeKey(face[0]!, face[1]!), input.factor ?? 0.5);
          break;
        }
        case "merge":
          out = mergeVerts(mesh, sel, "center");
          break;
        case "delete":
          out = deleteElements(mesh, sel, input.deleteKind);
          break;
        case "fill":
          out = fillFace(mesh, sel);
          break;
        case "bridge": {
          const r = bridgeLoops(mesh, sel);
          if (r.error) throw new ApiError(r.error, "Select two loops with the same number of points (edge mode), or two groups of faces facing each other.");
          out = r;
          break;
        }
        case "spin": {
          // Around `axis` (default z) through `by` (default the object's origin), `deg` degrees (default 360).
          const ax = input.axis ?? "z";
          out = spinSelection(mesh, sel, (input.by as V3 | undefined) ?? [0, 0, 0], ax === "x" ? [1, 0, 0] : ax === "y" ? [0, 1, 0] : [0, 0, 1], input.deg ?? 360, input.steps ?? 12);
          break;
        }
        case "flip":
          out = { mesh: flipFaces(mesh, selectedFaces(mesh, sel)), selection: sel };
          break;
        case "recalc":
          out = { mesh: recalcNormalsOutside(mesh), selection: sel };
          break;
        case "move": {
          const by = (input.by ?? [0, 0, 0]) as V3;
          out = { mesh: shape(mesh, selectedVerts(mesh, sel), translate4(by)), selection: sel };
          break;
        }
        case "mirror": {
          // Across the selection's own centre (or `by`, object space) on `axis`.
          const ax = ({ x: 0, y: 1, z: 2 } as const)[input.axis ?? "x"];
          const pivot = (input.by as V3 | undefined) ?? selectionMedian(mesh, sel) ?? [0, 0, 0];
          out = mirrorSelection(mesh, sel, ax, pivot);
          break;
        }
        case "rotate":
        case "scale": {
          const vs = selectedVerts(mesh, sel);
          let c: V3 = [0, 0, 0];
          for (const v of vs) c = [c[0] + mesh.positions[v * 3]!, c[1] + mesh.positions[v * 3 + 1]!, c[2] + mesh.positions[v * 3 + 2]!];
          c = [c[0] / Math.max(1, vs.size), c[1] / Math.max(1, vs.size), c[2] / Math.max(1, vs.size)];
          const ax = input.axis ?? "z";
          const r: V3 = [ax === "x" ? input.deg ?? 0 : 0, ax === "y" ? input.deg ?? 0 : 0, ax === "z" ? input.deg ?? 0 : 0];
          const f = input.factor ?? 1;
          const core = input.op === "rotate" ? rotation4(...r) : scale4([f, f, f]);
          out = { mesh: shape(mesh, vs, mul4(mul4(translate4(c), core), translate4([-c[0], -c[1], -c[2]]))), selection: sel };
          break;
        }
      }
      setMeshData(d, clip.id, out.mesh);
      const stats = meshStats(out.mesh);
      result = { vertices: stats.vertices, faces: stats.faces, selected: [...selectedFaces(out.mesh, out.selection)] };
    });
    return result;
  },
});

export const worldMaterial = defineCommand({
  id: "world.material",
  summary: "Give anything in a world a material preset (gold, glass, chrome, clay, neon, toon…) — meshes, and texts, logos, photos and video standing there. One step, every field still editable.",
  effect: "write",
  input: z.object({ ids: z.union([z.string(), z.array(z.string()).min(1)]), preset: z.string() }),
  run(input, rt) {
    const preset = materialPreset(input.preset);
    if (!preset) throw new ApiError(`No material preset "${input.preset}".`, `One of: ${MATERIAL_PRESETS.map((p) => p.id).join(", ")}`);
    const ids = typeof input.ids === "string" ? [input.ids] : input.ids;
    rt.write("Material", (d) => {
      for (const id of ids) {
        const c = requireClip(d, id).clip;
        if (c.kind !== "mesh" && !isBodyClip(c)) throw new ApiError(`"${c.name}" is a ${c.kind}; materials are for meshes and 2D layers in a world.`);
        applyMaterialPreset(c, preset);
      }
    });
    return { updated: ids.length };
  },
});

export const worldTrack = defineCommand({
  id: "world.track",
  summary: "Make a layer LOOK AT and/or FOLLOW another (a camera tracking a hero, a light riding a car), parent it (Child Of — a rig), or make a chain REACH a target (IK). null clears.",
  details: "Following keeps the layer's own position as its OFFSET from the target, so its stored position is the distance it keeps.",
  effect: "write",
  input: z.object({
    id: z.string(),
    lookAt: z.string().nullable().optional(),
    follow: z.string().nullable().optional(),
    followRotation: z.boolean().default(false),
    childOf: z.string().nullable().optional().describe("Parent to this layer (a rig: hand → forearm → arm → controller). It stays where it is and follows from now on; null unparents."),
    ik: z
      .object({
        target: z.string().describe("What the tip reaches for — usually a controller you animate"),
        chainLength: z.number().int().min(1).max(16).default(2).describe("How many parents above the tip turn (2 = forearm and upper arm)"),
        pole: z.string().nullable().default(null).describe("Which way the first bend points (an elbow at a controller behind the arm)"),
      })
      .nullable()
      .optional()
      .describe("INVERSE KINEMATICS on the tip of a Child Of chain: its parents turn so it reaches the target. null removes."),
  }),
  run(input, rt) {
    rt.write("Track", (d) => {
      const c = requireClip(d, input.id).clip;
      if (c.kind === "audio") throw new ApiError("Audio has no place to track from.");
      if (input.childOf !== undefined) {
        const frame = d.frames.find((f) => f.id === c.frameId);
        if (!frame?.world) throw new ApiError("Child Of works inside a 3D world.");
        if (input.childOf) requireClip(d, input.childOf);
        setChildOf(d, frame, c.id, input.childOf);
      }
      let list = c.constraints ?? [];
      if (input.lookAt !== undefined) {
        list = list.filter((x) => x.type !== "lookAt");
        if (input.lookAt) list.push({ id: createId("cns"), type: "lookAt", targetId: requireClip(d, input.lookAt).clip.id, enabled: true, influence: 1 });
      }
      if (input.ik !== undefined) {
        list = list.filter((x) => x.type !== "ik");
        if (input.ik) {
          list.push({
            id: createId("cns"),
            type: "ik",
            targetId: requireClip(d, input.ik.target).clip.id,
            enabled: true,
            influence: 1,
            chainLength: input.ik.chainLength,
            poleId: input.ik.pole ? requireClip(d, input.ik.pole).clip.id : null,
          });
        }
      }
      if (input.follow !== undefined) {
        list = list.filter((x) => x.type !== "follow");
        if (input.follow) list.push({ id: createId("cns"), type: "follow", targetId: requireClip(d, input.follow).clip.id, enabled: true, influence: 1, rotation: input.followRotation });
      }
      c.constraints = list.length ? list : undefined;
    });
    return { updated: input.id };
  },
});

export const worldMoveInto = defineCommand({
  id: "world.move_into",
  summary: "Move 2D layers (one flat comp) — or a whole frame — into a NEW 3D world nested where they were: same picture, now real depth and cameras.",
  details:
    "The world is transparent, the comp's size, with no camera: its default camera sees the layers exactly as the flat comp drew them. " +
    "Positions convert (2D y → world −z; z → depth y) and so do their keys. Add a camera there (world_add) to start moving through it. " +
    "For a layer that only needs to tilt or sit back in a flat comp, set `z`, `rotationX`, `rotationY` on it instead — no world needed.",
  effect: "write",
  input: z
    .object({
      ids: z.array(z.string()).min(1).optional(),
      /** A whole flat frame: its content into a world nested in it, the frame kept as the wrapper (an empty frame gets a starter world). */
      frameId: z.string().optional(),
      name: z.string().optional(),
    })
    .refine((v) => !!v.ids || !!v.frameId, { message: "Pass ids (layers) or frameId (a whole frame)." }),
  run(input, rt) {
    let out: ReturnType<typeof moveIntoWorld> = null;
    rt.write("Move into 3D world", (d) => {
      if (input.frameId) {
        out = frameIntoWorld(d, input.frameId, input.name);
        if (!out) throw new ApiError(`"${input.frameId}" is not a flat frame.`);
        return;
      }
      for (const id of input.ids!) requireClip(d, id);
      out = moveIntoWorld(d, input.ids!, input.name ?? "3D world");
      if (!out) throw new ApiError("Nothing to move: pick 2D layers in a flat comp (audio, adjustments and 3D objects stay).");
    });
    const r = out as unknown as { nestedId: string; frameId: string };
    return { nestedId: r.nestedId, frameId: r.frameId };
  },
});

export const worldExtrude = defineCommand({
  id: "world.extrude",
  summary: "Give layers in a world THICKNESS — extruded 3D letters, logos, badges, photo blocks, video slabs. depth 0 makes them flat pictures again.",
  details:
    "Any 2D layer in a world takes it: text (any script — Farsi and Arabic join as they do flat), shapes, paths, images, video, nested comps. " +
    "`fit`: `outline` follows the real shape (glyphs, contour, an image's transparency — exact), `box` is a slab the size of the picture (fast — the default for video and nested comps). " +
    "The face wears the layer's own picture; the sides take `sideColor`, else a shade of the face (vectors) or the picture's edge pixels (pictures). " +
    "`bevel` rounds the edges (a few units reads as polished). Depth extrudes AWAY from the front, so the face stays where the picture was. " +
    "Keys at `extrude.depth` and `extrude.bevel` — key depth from 0 for letters that grow out of the wall. How light treats it is the layer's material: `material.roughness`, `material.metalness`, `material.emission`… (layer.set), the same fields a mesh has.",
  effect: "write",
  input: z.object({
    ids: z.union([z.string(), z.array(z.string()).min(1)]),
    depth: z.number().min(0),
    bevel: z.number().min(0).optional(),
    bevelSegments: z.number().int().min(1).max(8).optional(),
    sideColor: z.string().nullable().optional(),
    fit: z.enum(["outline", "box"]).optional(),
  }),
  run(input, rt) {
    const ids = typeof input.ids === "string" ? [input.ids] : input.ids;
    rt.write("Thickness", (d) => {
      for (const id of ids) {
        const c = requireClip(d, id).clip;
        if (!isBodyClip(c)) throw new ApiError(`"${c.name}" is a ${c.kind}; thickness is for 2D layers in a world (meshes have geometry of their own).`);
        if (input.depth === 0) {
          c.extrude = undefined;
          continue;
        }
        const prev = c.extrude ?? extrudeSchema.parse({});
        c.extrude = {
          ...prev,
          depth: input.depth,
          ...(input.bevel !== undefined && { bevel: input.bevel }),
          ...(input.bevelSegments !== undefined && { bevelSegments: input.bevelSegments }),
          ...(input.sideColor !== undefined && { sideColor: input.sideColor }),
          ...(input.fit !== undefined && { fit: input.fit }),
        };
      }
    });
    return { updated: ids };
  },
});

export const worldLook = defineCommand({
  id: "world.look",
  summary: "The LOOK of a world's shot: tone, exposure, shadows, mist, BLOOM, AMBIENT OCCLUSION, a FLOOR (shadow catcher, solid, mirror) and a camera's DEPTH OF FIELD. The premium-render switches in one call.",
  details:
    "All optional — only what you pass changes. `bloom` glows what is brighter than `threshold` (emission strength > 1 makes neon read as light). " +
    "`dof` needs `cameraId`: `focusOn` a layer id keeps that layer sharp wherever it moves (null = use `focusDistance` in units), `fStop` 1.4 is dreamy, 16 nearly all sharp. " +
    "Keyable later at `camera.dof.focusDistance` / `camera.dof.fStop`. Both show in Rendered view, on the board and in every export.",
  effect: "write",
  input: z.object({
    frameId: z.string(),
    toneMapping: z.enum(["agx", "aces", "neutral", "none"]).optional(),
    exposure: z.number().min(-10).max(10).optional().describe("In STOPS: 0 is normal, +1 is twice as bright, −1 half."),
    shadows: z.boolean().optional(),
    mist: z.object({ enabled: z.boolean().optional(), color: z.string().optional(), start: z.number().min(0).optional(), end: z.number().min(0).optional() }).optional(),
    bloom: z
      .object({
        enabled: z.boolean().optional(),
        strength: z.number().min(0).max(3).optional(),
        radius: z.number().min(0).max(1).optional(),
        threshold: z.number().min(0).max(1).optional(),
        source: z.enum(["bright", "emission"]).optional().describe("bright: whatever is bright in the picture glows; emission: only emissive materials glow (neon, screens) — a white wall never does"),
      })
      .optional(),
    ao: z.object({ enabled: z.boolean().optional(), radius: z.number().min(1).max(5000).optional(), strength: z.number().min(0).max(2).optional() }).optional(),

    floor: z.object({ mode: z.enum(["none", "shadow", "solid", "mirror"]).optional(), color: z.string().optional(), opacity: z.number().min(0).max(1).optional(), z: z.number().optional() }).optional(),
    cameraId: z.string().optional(),
    dof: z
      .object({ enabled: z.boolean().optional(), focusOn: z.string().nullable().optional(), focusDistance: z.number().positive().optional(), fStop: z.number().min(0.1).max(128).optional() })
      .optional(),
  }),
  run(input, rt) {
    rt.write("World look", (d) => {
      const frame = d.frames.find((f) => f.id === input.frameId);
      if (!frame?.world) throw new ApiError(`"${input.frameId}" is not a 3D world.`, "world.create makes one.");
      const r = frame.world.render;
      if (input.toneMapping) r.toneMapping = input.toneMapping;
      if (input.exposure !== undefined) r.exposure = input.exposure;
      if (input.shadows !== undefined) r.shadows = input.shadows;
      if (input.mist) Object.assign(frame.world.fog, Object.fromEntries(Object.entries(input.mist).filter(([, v]) => v !== undefined)));
      const set = <T extends object>(target: T, patch: object | undefined) => patch && Object.assign(target, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
      if (input.bloom) set((r.bloom ??= worldSpecSchema.parse({}).render.bloom), input.bloom);
      if (input.ao) set((r.ao ??= worldSpecSchema.parse({}).render.ao), input.ao);
      if (input.floor) set((r.floor ??= worldSpecSchema.parse({}).render.floor), input.floor);
      if (input.dof) {
        if (!input.cameraId) throw new ApiError("Depth of field belongs to a camera: pass cameraId.", "world.inspect lists the cameras.");
        const cam = requireClip(d, input.cameraId).clip;
        if (cam.kind !== "camera") throw new ApiError(`"${cam.name}" is a ${cam.kind}, not a camera.`);
        const dof = cam.camera.dof;
        if (input.dof.enabled !== undefined) dof.enabled = input.dof.enabled;
        if (input.dof.focusOn !== undefined) {
          if (input.dof.focusOn) requireClip(d, input.dof.focusOn);
          dof.focusObjectId = input.dof.focusOn;
        }
        if (input.dof.focusDistance !== undefined) dof.focusDistance = input.dof.focusDistance;
        if (input.dof.fStop !== undefined) dof.fStop = input.dof.fStop;
        if (input.dof.enabled === undefined) dof.enabled = true;
      }
    });
    return { updated: input.frameId };
  },
});

export const worldApplyModifier = defineCommand({
  id: "world.apply_modifier",
  summary: "Apply a mesh's modifier (Blender's Ctrl+A): bake the stack up to and including it into the mesh's own polygons, at a time. The look does not change; those cards go.",
  details:
    "Everything below the card keeps running on the result. A primitive becomes editable polygons (its size params and their keys go). " +
    "`atMs` is comp time (default 0) — what the stack looked like then is what is kept. Imported models cannot be applied to.",
  effect: "write",
  input: z.object({ id: z.string(), modifierId: z.string(), atMs: z.number().min(0).optional() }),
  run(input, rt) {
    rt.write("Apply modifier", (d) => {
      const c = requireClip(d, input.id).clip;
      if (c.kind !== "mesh") throw new ApiError(`"${c.name}" is a ${c.kind}; only a mesh's modifiers apply (a layer's body is rebuilt from the layer).`);
      const local = Math.max(0, (input.atMs ?? 0) - c.startMs);
      if (!applyModifier(c, input.modifierId, local)) throw new ApiError(`Could not apply "${input.modifierId}" on "${c.name}".`, "layer.get lists its modifiers; imported models cannot be applied to.");
    });
    return { applied: input.modifierId };
  },
});

export const worldLattice = defineCommand({
  id: "world.lattice",
  summary: "Give an object a Lattice (Blender's soft cage deform) in one step: a cage of points fitted round it, riding it, and a Lattice modifier reading it.",
  details:
    "Returns the cage's id and the modifier's. The cage is a mesh whose points are a grid (`resolution` u×v×w, default 3×3×3): " +
    "move its points (mesh.edit on the cage's vertices, or Tab in the app) and the object squashes, bulges and leans with them; moving the whole cage changes nothing. " +
    "Works on meshes and on any 2D layer in a world. The modifier's `interpolation` is smooth (B-spline, soft) or linear; key its `strength` to press the deform in.",
  effect: "write",
  input: z.object({
    id: z.string(),
    resolution: z.tuple([z.number().int().min(2).max(12), z.number().int().min(2).max(12), z.number().int().min(2).max(12)]).optional(),
  }),
  run(input, rt) {
    let made: { cageId: string; modifierId: string } | null = null;
    rt.write("Add lattice", (d) => {
      const c = requireClip(d, input.id).clip;
      made = addLattice(d, input.id, { resolution: input.resolution });
      if (!made) throw new ApiError(`"${c.name}" can't take a lattice.`, "A mesh, or a 2D layer standing in a world (world.move_into puts one there).");
    });
    return made!;
  },
});

export const worldLineArt = defineCommand({
  id: "world.line_art",
  summary: "Line art on 2D layers standing in a world: their silhouette, creases and borders drawn as lines — the outlined, illustrated look.",
  details:
    "For a layer's body (text, shape, path, picture…). A mesh draws its lines with its own strokes instead (style.set on the mesh's strokes; its `lines` flags pick which edges). " +
    "`enabled: false` removes it. `width` is in screen px; `color` a hex or a colour token. The silhouette follows the camera; creases are edges sharper than `creaseAngle`.",
  effect: "write",
  input: z.object({
    ids: z.union([z.string(), z.array(z.string())]),
    enabled: z.boolean().optional(),
    color: z.string().optional(),
    width: z.number().min(0).max(64).optional(),
    opacity: z.number().min(0).max(1).optional(),
    silhouette: z.boolean().optional(),
    creases: z.boolean().optional(),
    creaseAngle: z.number().min(0).max(180).optional(),
    boundaries: z.boolean().optional(),
  }),
  run(input, rt) {
    const ids = Array.isArray(input.ids) ? input.ids : [input.ids];
    rt.write(input.enabled === false ? "Remove line art" : "Line art", (d) => {
      for (const id of ids) {
        const c = requireClip(d, id).clip;
        if (c.kind === "mesh") throw new ApiError(`"${c.name}" is a mesh; it draws line art with its own strokes.`, "style.set its strokes; its `lines` flags pick the edges.");
        if (!isBodyClip(c)) throw new ApiError(`"${c.name}" is not a layer that stands in a world.`);
        if (input.enabled === false) {
          delete (c as VisualClip).lineArt;
          continue;
        }
        const { ids: _ids, enabled: _on, ...patch } = input;
        (c as VisualClip).lineArt = lineArtSchema.parse({ ...((c as VisualClip).lineArt ?? {}), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) });
      }
    });
    return { updated: ids };
  },
});

export const worldCamera = defineCommand({
  id: "world.camera",
  summary: "Choose the camera a world is seen through, or turn its DEFAULT camera into a camera layer you can edit and key.",
  details:
    "The live camera at a moment is the topmost visible camera whose bar covers it, so `activate` restacks that camera above the live one (and shows it if hidden) — " +
    "at `atMs` (comp time; default: the camera's own start). For a cut between angles, lay camera bars end to end on one lane instead. " +
    "`fromDefault` adds a camera exactly where the default one stands (it frames the comp as the flat comp did), under every other camera, so nothing on screen changes; returns its id.",
  effect: "write",
  input: z.object({
    frameId: z.string().optional(),
    activate: z.string().optional().describe("A camera's id: make it the one the world is seen through"),
    atMs: z.number().min(0).optional(),
    fromDefault: z.boolean().optional(),
  }),
  run(input, rt) {
    const frame = requireWorld(rt, input.frameId ?? (input.activate ? requireClip(rt.doc(), input.activate).clip.frameId : undefined));
    let made: string | null = null;
    const at = input.atMs ?? (input.activate ? requireClip(rt.doc(), input.activate).clip.startMs : 0);
    rt.write("Camera", (d) => {
      if (input.fromDefault) made = materializeDefaultCamera(d, frame.id);
      if (input.activate) {
        const why = makeCameraActive(d, frame.id, requireClip(d, input.activate).clip.id, at);
        if (why) throw new ApiError(why);
      }
    });
    return { frameId: frame.id, ...(made ? { cameraId: made } : {}), activeAt: at, active: activeCameraAt(rt.doc(), frame, at) ?? "default" };
  },
});

export const worldSculpt = defineCommand({
  id: "world.sculpt",
  summary: "Sculpt a mesh with brush strokes (Blender's sculpt mode): raise, carve, smooth, flatten, pinch, inflate, clay up or grab its surface. One undo step.",
  details:
    "Points are OBJECT space, as mesh.edit (read the shape's extent from world.inspect): a stroke is a polyline the brush is dragged along, dabbing every ~12% of `radius`. " +
    "`draw` raises along the surface (`direction: -1` carves), `clay` builds flat layers, `inflate` swells along normals, `crease` cuts a sharp fold, `smooth` relaxes, `flatten` presses to the area's plane, `pinch` gathers, " +
    "`grab` drags what is under the stroke's FIRST point by (last − first). A low-poly shape has nothing to sculpt — `detail` subdivides it smoothly first (each level ×4 faces; a cube wants 3–4, a sphere 1–2). " +
    "`symmetry` mirrors every dab across the object's own X/Y/Z planes. Check with view_render at detail \"standard\".",
  effect: "write",
  input: z.object({
    id: z.string(),
    brush: z.enum(SCULPT_BRUSHES.map((b) => b.id) as [SculptBrush, ...SculptBrush[]]),
    strokes: z
      .array(
        z.object({
          points: z.array(vec3).min(1),
          radius: z.number().positive().optional(),
          strength: z.number().min(0).max(1).optional(),
        }),
      )
      .min(1),
    radius: z.number().positive().default(40).describe("Brush radius, object units — per stroke `radius` wins"),
    strength: z.number().min(0).max(1).default(0.5),
    direction: z.union([z.literal(1), z.literal(-1)]).default(1),
    falloff: z.enum(FALLOFFS).default("smooth"),
    symmetry: z.array(z.enum(["x", "y", "z"])).optional(),
    detail: z.number().int().min(0).max(4).default(0),
  }),
  run(input, rt) {
    let stats = { vertices: 0, moved: 0 };
    rt.write("Sculpt", (d) => {
      const clip = requireClip(d, input.id).clip;
      if (clip.kind !== "mesh") throw new ApiError(`"${clip.name}" is a ${clip.kind}; only a mesh can be sculpted.`, "world.add a primitive, or Convert to mesh (world.convertMesh in the app) first.");
      if (clip.geometry.type === "asset") throw new ApiError("An imported model sculpts once made editable.", "mesh.edit op makeEditable.");
      makeMeshEditable(clip);
      let mesh = (clip.geometry as { mesh: MeshData }).mesh;
      for (let i = 0; i < input.detail && mesh.faces.length < 200000; i++) mesh = catmullClark(mesh);
      const session = new SculptSession(mesh);
      const symmetry: [boolean, boolean, boolean] = [!!input.symmetry?.includes("x"), !!input.symmetry?.includes("y"), !!input.symmetry?.includes("z")];
      let moved = 0;
      for (const s of input.strokes) {
        const brush = { brush: input.brush, radius: s.radius ?? input.radius, strength: s.strength ?? input.strength, direction: input.direction, falloff: input.falloff, symmetry };
        const pts = s.points as V3[];
        if (input.brush === "grab") {
          moved += session.beginGrab(pts[0]!, brush);
          const last = pts[pts.length - 1]!;
          session.moveGrab([last[0] - pts[0]![0], last[1] - pts[0]![1], last[2] - pts[0]![2]]);
          session.endGrab();
          continue;
        }
        const step = brush.radius * SCULPT_SPACING;
        moved += session.dab(pts[0]!, brush);
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1]!, b = pts[i]!;
          const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
          for (let t = step; t <= len; t += step) {
            const f = t / len;
            moved += session.dab([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f], brush);
          }
        }
      }
      setMeshData(d, clip.id, session.mesh());
      stats = { vertices: session.vertexCount, moved };
    });
    if (stats.moved === 0) throw new ApiError("The brush touched nothing.", "Points are object space and must lie within `radius` of the surface — world.inspect gives the mesh's bounds.");
    return { id: input.id, vertices: stats.vertices, dabsMovedVertices: stats.moved };
  },
});

export const WORLD_COMMANDS = [worldCreate, worldAdd, worldInspect, meshEdit, worldMaterial, worldTrack, worldMoveInto, worldExtrude, worldApplyModifier, worldLattice, worldLineArt, worldLook, worldCamera, worldSculpt];
