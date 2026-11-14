import { z } from "zod";
import type { MotionDocument, Clip, MeshData, ShapeKey, Subpath } from "../../schema";
import { ApiError, defineCommand } from "../command";
import { requireClip } from "../lookup";
import { setClipProperty } from "../../animation/paths";
import { copySubpaths } from "../../vector/geometry";
import {
  addAssetShapeKey,
  addShapeKey,
  canHoldShapeKeys,
  currentMix,
  duplicateShapeKey,
  keyPath,
  mirrorShapeKey,
  removeShapeKey,
  renameShapeKey,
  setKeyShape,
  setShapeKeyMute,
  setShapeKeyRelativeTo,
  shapeOfKey,
  type KeyedClip,
} from "../../shape-keys";
import { makeMeshEditable } from "../../world/ops";

/**
 * SHAPE KEYS, FOR AGENTS — the same writes the inspector's Shape keys section
 * and the stage's "Edit key" mode make (core `shape-keys/ops.ts`). A key is
 * named by id or name; its weight is the ordinary channel `key.<id>`, so
 * `keyframes_set`, `expression_set`, modulators and pose sets drive it.
 */

function keyedClip(doc: MotionDocument, id: string): KeyedClip {
  const c = requireClip(doc, id).clip;
  if (canHoldShapeKeys(c)) return c;
  if (c.kind === "mesh" && c.geometry.type === "primitive") {
    throw new ApiError(`"${c.name}" is a primitive.`, "Pass `editable: true` to shapekey_create to make it polygons first.");
  }
  throw new ApiError(`"${c.name}" cannot hold shape keys.`, "Shape keys live on a vector PATH or an editable MESH (convert a shape or text to a path first).");
}

function keyRef(clip: Clip, ref: string): ShapeKey {
  const keys = (clip.kind === "path" || clip.kind === "mesh" ? clip.shapeKeys : undefined) ?? [];
  const k = keys.find((x) => x.id === ref) ?? keys.find((x) => x.name.toLowerCase() === ref.toLowerCase());
  if (!k) throw new ApiError(`No shape key "${ref}" on "${clip.name}".`, `Keys: ${keys.map((x) => x.name).join(", ") || "none yet"}.`);
  return k;
}

const pointEdit = z.object({
  contour: z.number().int().min(0).default(0).describe("Contour index (paint order)"),
  index: z.number().int().min(0).describe("Anchor index in that contour"),
  x: z.number().optional(),
  y: z.number().optional(),
  dx: z.number().optional().describe("Move by, instead of an absolute x"),
  dy: z.number().optional(),
  hIn: z.tuple([z.number(), z.number()]).nullable().optional().describe("Absolute in-handle; null = a corner on that side"),
  hOut: z.tuple([z.number(), z.number()]).nullable().optional(),
});

const vertexEdit = z.object({
  index: z.number().int().min(0),
  x: z.number().optional(),
  y: z.number().optional(),
  z: z.number().optional(),
  dx: z.number().optional(),
  dy: z.number().optional(),
  dz: z.number().optional(),
});

/** A key's absolute shape with these edits applied (layer's own space). */
function editedShape(clip: KeyedClip, keyId: string, points?: z.infer<typeof pointEdit>[], verts?: z.infer<typeof vertexEdit>[]): Subpath[] | MeshData {
  const shape = shapeOfKey(clip, keyId);
  if (clip.kind === "path") {
    const subs = copySubpaths(shape as Subpath[]);
    for (const e of points ?? []) {
      const p = subs[e.contour]?.points[e.index];
      if (!p) throw new ApiError(`No anchor ${e.contour}:${e.index}.`, "shapekey_inspect lists each contour's anchors.");
      const nx = e.x ?? p.x + (e.dx ?? 0), ny = e.y ?? p.y + (e.dy ?? 0);
      const mx = nx - p.x, my = ny - p.y;
      p.x = nx;
      p.y = ny;
      // Arms travel with their anchor unless given.
      p.hIn = e.hIn === undefined ? (p.hIn ? { x: p.hIn.x + mx, y: p.hIn.y + my } : null) : e.hIn && { x: e.hIn[0], y: e.hIn[1] };
      p.hOut = e.hOut === undefined ? (p.hOut ? { x: p.hOut.x + mx, y: p.hOut.y + my } : null) : e.hOut && { x: e.hOut[0], y: e.hOut[1] };
    }
    return subs;
  }
  const mesh = shape as MeshData;
  const positions = mesh.positions.slice();
  for (const e of verts ?? []) {
    if (e.index * 3 + 2 >= positions.length) throw new ApiError(`No vertex ${e.index}.`, `The mesh has ${positions.length / 3} vertices.`);
    const o = e.index * 3;
    positions[o] = e.x ?? positions[o]! + (e.dx ?? 0);
    positions[o + 1] = e.y ?? positions[o + 1]! + (e.dy ?? 0);
    positions[o + 2] = e.z ?? positions[o + 2]! + (e.dz ?? 0);
  }
  return { ...mesh, positions };
}

function describeKey(clip: Clip, k: ShapeKey) {
  const keys = (clip.kind === "path" || clip.kind === "mesh" ? clip.shapeKeys : undefined) ?? [];
  const src = k.source;
  const moved =
    src.kind === "asset"
      ? undefined
      : src.delta.kind === "mesh"
        ? src.delta.verts.length
        : Object.values(src.delta.contours).reduce((n, run) => {
            for (let i = 0; i < run.length; i += 6) if (run.slice(i, i + 6).some((v) => v !== 0)) n++;
            return n;
          }, 0);
  return {
    id: k.id,
    name: k.name,
    path: keyPath(k.id),
    weight: k.value ?? 0,
    ...(k.mute && { mute: true }),
    relativeTo: k.relativeTo ? (keys.find((x) => x.id === k.relativeTo)?.name ?? k.relativeTo) : null,
    ...(src.kind === "asset" ? { assetTarget: src.target } : { moved }),
  };
}

export const shapekeyCreate = defineCommand({
  id: "shapekey.create",
  summary: "Add a SHAPE KEY to a vector path or mesh: a drawn shape it morphs to by a weight (a viseme, a blink, jawOpen).",
  details:
    "from: `zero` (default — the reference shape, then shapekey_edit moves points), `mix` (what the current weights make: Blender's 'new shape from mix'). " +
    "`points` / `verts` set the new key's shape in one call (same as shapekey_edit). `relativeTo` draws it on top of another key (a corrective). " +
    "On an imported model, `assetTarget` (a glTF morph target name or index) adds a weight-only key for the model's own blendshape. " +
    "The weight is `key.<id>` (0..1, may overshoot): key it with keyframes_set, drive it with expression_set (loudness(\"Voice\") on jawOpen), or put it in a pose set.",
  effect: "write",
  input: z.object({
    id: z.string().describe("The path or mesh layer"),
    name: z.string().optional(),
    relativeTo: z.string().optional().describe("Another key's name or id"),
    from: z.enum(["zero", "mix"]).default("zero"),
    points: z.array(pointEdit).optional(),
    verts: z.array(vertexEdit).optional(),
    assetTarget: z.union([z.number().int().min(0), z.string()]).optional(),
    editable: z.boolean().optional().describe("A primitive mesh becomes polygons first"),
    weight: z.number().optional(),
  }),
  run(input, rt) {
    let made: ShapeKey | null = null;
    rt.write("Add shape key", (d) => {
      const raw = requireClip(d, input.id).clip;
      if (raw.kind === "mesh" && input.assetTarget !== undefined) {
        made = addAssetShapeKey(raw, input.assetTarget, input.name);
        if (!made) throw new ApiError("`assetTarget` is for an imported model.", "Polygons take `verts` instead.");
        return;
      }
      if (raw.kind === "mesh" && raw.geometry.type === "primitive" && input.editable) makeMeshEditable(raw);
      const clip = keyedClip(d, input.id);
      const rel = input.relativeTo ? keyRef(clip, input.relativeTo).id : undefined;
      made = addShapeKey(clip, { name: input.name, relativeTo: rel, value: input.weight, ...(input.from === "mix" && { shape: currentMix(clip) }) });
      if (!made) throw new ApiError("Could not add the key.", "The shape must have the layer's own points.");
      if (input.points?.length || input.verts?.length) setKeyShape(clip, made.id, editedShape(clip, made.id, input.points, input.verts));
    });
    const clip = requireClip(rt.doc(), input.id).clip;
    return describeKey(clip, keyRef(clip, made!.id));
  },
});

export const shapekeyEdit = defineCommand({
  id: "shapekey.edit",
  summary: "Reshape, rename, mute, re-reference, duplicate or mirror a shape key. The base and every other key stay put.",
  details:
    "`points` (path: contour + anchor index, absolute x/y or dx/dy; handles follow their anchor unless given) and `verts` (mesh: index, absolute or delta) write the KEY's shape. " +
    "`relativeTo: null` puts it back on the base; its shape is kept. `duplicate` / `mirror` (L↔R across the layer's own x = 0, named Smile.L → Smile.R) add a new key and return it.",
  effect: "write",
  input: z.object({
    id: z.string(),
    key: z.string(),
    points: z.array(pointEdit).optional(),
    verts: z.array(vertexEdit).optional(),
    name: z.string().optional(),
    mute: z.boolean().optional(),
    relativeTo: z.string().nullable().optional(),
    duplicate: z.boolean().optional(),
    mirror: z.boolean().optional(),
  }),
  run(input, rt) {
    let out: string | null = null;
    rt.write("Edit shape key", (d) => {
      const clip = keyedClip(d, input.id);
      const k = keyRef(clip, input.key);
      if (input.points?.length || input.verts?.length) {
        if (!setKeyShape(clip, k.id, editedShape(clip, k.id, input.points, input.verts))) throw new ApiError("That key's shape lives in the imported model.", "Only its weight can change.");
      }
      if (input.name) renameShapeKey(clip, k.id, input.name);
      if (input.mute !== undefined) setShapeKeyMute(clip, k.id, input.mute);
      if (input.relativeTo !== undefined) {
        const ref = input.relativeTo === null ? undefined : keyRef(clip, input.relativeTo).id;
        if (!setShapeKeyRelativeTo(clip, k.id, ref)) throw new ApiError("That reference would make a loop.", "A key cannot be drawn on a key drawn on it.");
      }
      out = k.id;
      if (input.duplicate) out = duplicateShapeKey(clip, k.id)?.id ?? out;
      if (input.mirror) {
        const m = mirrorShapeKey(clip, k.id);
        if (!m) throw new ApiError("Nothing to mirror.", "Mirror pairs points across the layer's own x = 0; this outline has no partners there.");
        out = m.id;
      }
    });
    const clip = requireClip(rt.doc(), input.id).clip;
    return describeKey(clip, keyRef(clip, out!));
  },
});

export const shapekeySet = defineCommand({
  id: "shapekey.set",
  summary: "Set shape-key weights (the resting value of each `key.<id>`). Keys and drivers on a weight win over this.",
  effect: "write",
  input: z.object({ id: z.string(), weights: z.record(z.string(), z.number()).describe("{ keyNameOrId: weight }") }),
  run(input, rt) {
    rt.write("Set shape keys", (d) => {
      const clip = keyedClip(d, input.id);
      for (const [ref, w] of Object.entries(input.weights)) setClipProperty(clip, keyPath(keyRef(clip, ref).id), w);
    });
    const clip = requireClip(rt.doc(), input.id).clip;
    return { keys: ((clip.kind === "path" || clip.kind === "mesh" ? clip.shapeKeys : []) ?? []).map((k) => describeKey(clip, k)) };
  },
});

export const shapekeyRemove = defineCommand({
  id: "shapekey.remove",
  summary: "Remove shape keys (their keys, drivers and modulators go too; keys drawn on them keep their shapes).",
  effect: "write",
  input: z.object({ id: z.string(), keys: z.array(z.string()).min(1) }),
  run(input, rt) {
    rt.write("Remove shape keys", (d) => {
      const clip = keyedClip(d, input.id);
      for (const ref of input.keys) removeShapeKey(clip, keyRef(clip, ref).id);
    });
    return { removed: input.keys.length };
  },
});

export const shapekeyInspect = defineCommand({
  id: "shapekey.inspect",
  summary: "List a layer's shape keys (name, weight path, reference, how many points each moves) and, with `key`, that key's own shape.",
  effect: "read",
  input: z.object({ id: z.string(), key: z.string().optional() }),
  run(input, rt) {
    const c = requireClip(rt.doc(), input.id).clip;
    const keys = (c.kind === "path" || c.kind === "mesh" ? c.shapeKeys : undefined) ?? [];
    const out: Record<string, unknown> = { keys: keys.map((k) => describeKey(c, k)) };
    if (input.key && canHoldShapeKeys(c)) {
      const k = keyRef(c, input.key);
      const shape = shapeOfKey(c, k.id);
      out.shape = Array.isArray(shape)
        ? shape.map((s) => ({ closed: s.closed, points: s.points.map((p) => [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100]) }))
        : { vertices: shape.positions.length / 3 };
    }
    return out;
  },
});

export const SHAPE_KEY_COMMANDS = [shapekeyCreate, shapekeyEdit, shapekeySet, shapekeyRemove, shapekeyInspect];
