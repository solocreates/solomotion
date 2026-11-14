import { z } from "zod";
import type { MotionDocument, Bone, GroupClip, Rig, VisualClip } from "../../schema";
import { weightStrokeSchema } from "../../schema/rig";
import { ApiError, defineCommand } from "../command";
import { requireClip, resolveTargetFrame } from "../lookup";
import { clipLocalTime } from "../../animation/evaluate";
import { addBone, addConstraint, addWeightStroke, bonesInRig, clearWeightPaint, createRig, editBone, poseBones, removeBones, removeConstraints, resetPose, rigIsPlanar, setBind, setBoneProps, updateConstraint } from "../../rig/ops";
import { mirrorPose, symmetrize, type SymmetrizeResult } from "../../rig/symmetry";
import { sideOf } from "../../rig/sides";
import type { BoneTarget } from "../../schema";
import { rigPoseAt } from "../../rig/pose";
import { posedPathsAt } from "../../rig/poses";
import { beneathPoses } from "../../rig/pose-ops";
import { poseEnvAt } from "../../evaluate/resolved-doc";
import { switchOptions } from "../../timeline/switch";
import { makeSwitch, setSwitch, switchFromVariants, unmakeSwitch } from "../../timeline/switch-ops";
import { decide2d, memberOf, restToRig2d } from "../../rig/bind";
import { evaluateWorld, objectLocalMatrix } from "../../world/evaluate";
import { invert4, transformPoint, type V3 } from "../../world/math";

/**
 * RIGGING, FOR AGENTS — the same verbs a person's bone tool, pose mode and
 * weight brush have, so a rig an agent builds and one a person builds are the
 * same object (docs/adr/ADR-rigging.md).
 *
 * Space: bones are written in the RIG's space — a flat comp's px (frame
 * centre origin, y DOWN, as `transform.x/y`), a world's units (Z up). A bone
 * is named by id or by name. Posing writes the ordinary channels
 * `bone.<id>.<channel>`, so `keyframes_set`, drivers and modulators work on
 * bones too.
 */

const point = z.union([z.tuple([z.number(), z.number()]), z.tuple([z.number(), z.number(), z.number()])]);

const range = z.tuple([z.number(), z.number()]);
/** What makes a bone a CONTROL a person grabs: how it is drawn and how far it may go. */
const controlFields = {
  shape: z.enum(["bone", "circle", "square", "diamond", "cross"]).optional().describe("How it is drawn while posing — circle/square/diamond/cross for controls"),
  size: z.number().positive().nullable().optional().describe("The shape's size in rig units (null = from its length)"),
  color: z.string().nullable().optional().describe("#rrggbb on the canvas (left/right sides), null = by role"),
  limits: z
    .object({ x: range, y: range, z: range, rotation: range, rotationX: range, rotationY: range, scale: range, scaleY: range, scaleZ: range })
    .partial()
    .nullable()
    .optional()
    .describe("[min, max] per pose channel; equal ends LOCK it. A slider: { x: [0, 100], y: [0, 0] }. A pad: x and y ranges. A knee: { rotation: [0, 150] }. null frees all"),
};

const boneSpec = z.object({
  head: point.describe("Where the bone starts (its joint), rig space"),
  tail: point.describe("Where it ends (its tip)"),
  name: z.string().optional(),
  parent: z.string().nullable().optional().describe("A bone's name or id; null = a root. Absent: the previous bone in this list (a chain)"),
  deform: z.boolean().optional().describe("false = a CONTROL bone: posed and keyed, but bends no art (an IK target, a root mover)"),
  roll: z.number().optional().describe("A world bone's turn about its own length, degrees"),
  ...controlFields,
});

function requireRig(doc: MotionDocument, id: string): { group: GroupClip; rig: Rig } {
  const c = requireClip(doc, id).clip;
  if (c.kind !== "group" || !c.rig) throw new ApiError(`"${c.name}" is not a rig.`, "rig_create makes one — from layers, or from bones alone.");
  return { group: c, rig: c.rig };
}

/** A bone by id or (case-insensitive) name. */
function boneRef(rig: Rig, ref: string): Bone {
  const b = rig.bones.find((x) => x.id === ref) ?? rig.bones.find((x) => x.name.toLowerCase() === ref.toLowerCase());
  if (!b) throw new ApiError(`No bone "${ref}" in this rig.`, `Bones: ${rig.bones.map((x) => x.name).join(", ") || "none yet"}.`);
  return b;
}

/** A name not yet used in the rig (agents name by name, so names are kept unique). */
function uniqueName(rig: Rig, name: string | undefined): string | undefined {
  if (!name) return undefined;
  const used = new Set(rig.bones.map((b) => b.name.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) if (!used.has(`${name} ${i}`.toLowerCase())) return `${name} ${i}`;
}

export const rigCreate = defineCommand({
  id: "rig.create",
  summary: "Make a RIG: bones that bend art. Wrap layers in it (they bind automatically) and/or draw its first bones — a chain by default.",
  details:
    "The rig is a GROUP: the character is the group, its layers are the art, its transform moves art and bones together. Every layer in it follows the bones by default — " +
    "a piece one bone runs through RIDES that bone whole (crisp, a placement), a piece several bones run through BENDS with automatic weights (rig_bind changes it). " +
    "Bones: head → tail in the rig's space (flat comp: px from the frame centre, y down; world: units, Z up). Each bone is the child of the one before unless it names a `parent` (null = a root). " +
    "Draw bones THROUGH the art they should move: an arm's bones along the arm, joints where it bends.",
  effect: "write",
  input: z.object({
    frameId: z.string().optional(),
    ids: z.array(z.string()).optional().describe("Layers to put in the rig (one comp); a single group id makes that group a rig"),
    name: z.string().optional(),
    bones: z.array(boneSpec).optional(),
  }),
  run(input, rt) {
    const frame = resolveTargetFrame(rt, input.frameId ?? (input.ids?.[0] ? requireClip(rt.doc(), input.ids[0]).clip.frameId : undefined));
    if (!input.ids?.length && !input.bones?.length) throw new ApiError("Nothing to make a rig from.", "Pass `ids` (layers) and/or `bones`.");
    let id: string | null = null;
    rt.write("Make rig", (d) => {
      const bones = input.bones ?? [];
      // From bones alone, the first bone makes the group (a group with bones is never "empty").
      id = input.ids?.length
        ? createRig(d, frame.id, { memberIds: input.ids, name: input.name })
        : createRig(d, frame.id, { name: input.name, bones: [{ head: bones[0]!.head, tail: bones[0]!.tail, name: bones[0]!.name, roll: bones[0]!.roll, deform: bones[0]!.deform, parent: null }] });
      if (!id) throw new ApiError("Those layers cannot be made a rig.", "They must be in one comp, and a group with an auto layout cannot also be a rig.");
      const { rig } = requireRig(d, id);
      if (!input.ids?.length && rig.bones[0]) setBoneProps(d, id, rig.bones[0].id, controlProps(bones[0]!));
      addChain(d, id, rig, input.ids?.length ? bones : bones.slice(1), input.ids?.length ? null : rig.bones[0]?.id ?? null);
    });
    const { rig } = requireRig(rt.doc(), id!);
    return { rigId: id!, bones: rig.bones.map((b) => ({ id: b.id, name: b.name, parent: rig.bones.find((x) => x.id === b.parent)?.name ?? null })) };
  },
});

/** Bones added in order, each the child of the previous unless it names a parent (by name or id; null = a root). */
function addChain(d: MotionDocument, rigId: string, rig: Rig, specs: z.infer<typeof boneSpec>[], after: string | null = null): void {
  let last: string | null = after;
  for (const s of specs) {
    const parent = s.parent === undefined ? last : s.parent === null ? null : boneRef(rig, s.parent).id;
    last = addBone(d, rigId, { head: s.head, tail: s.tail, name: uniqueName(rig, s.name), roll: s.roll, deform: s.deform, parent });
    if (last) setBoneProps(d, rigId, last, controlProps(s));
  }
}

export const rigBone = defineCommand({
  id: "rig.bone",
  summary: "Add, re-aim, rename, re-parent or remove bones; give a bone IK (it reaches for a control bone).",
  details:
    "`add`: head/tail in rig space, chained to the previous added bone unless `parent` says otherwise. `edit`: move a bone's REST — the art never moves (it is bound to rest; weights re-derive). " +
    "`children: \"stay\"` (default) keeps the bones hanging off it in place, re-aiming a child JOINED at its tip (drag an elbow: both arm bones re-aim, the wrist stays); \"follow\" swings them along. " +
    "`ik`: { target: a control bone (deform: false is usual), chain: how many bones turn (2 = forearm and upper arm), pole: a bone the elbow points at, flip: bend the other way (flat comps) } — null removes. " +
    "Removing a bone keeps its children where they are and lets go of its keys, IK and bindings. " +
    "CONTROLS: a bone with deform: false, a `shape` and `limits` is a handle a person grabs — a circle root, a diamond IK target, a slider (one axis limited, the other locked) or a pad. " +
    "Wire one to anything with an expression: expression.set(prop, 'map(bone(\"Face\", \"Mouth\", \"y\"), 0, 40, 0, 1)').",
  effect: "write",
  input: z.object({
    rigId: z.string(),
    add: z.array(boneSpec).optional(),
    edit: z
      .array(
        z.object({
          bone: z.string(),
          head: point.optional(),
          tail: point.optional(),
          roll: z.number().optional(),
          name: z.string().optional(),
          parent: z.string().nullable().optional(),
          deform: z.boolean().optional(),
          ...controlFields,
          children: z.enum(["stay", "follow"]).default("stay"),
          ik: z
            .object({
              target: z.string(),
              chain: z.number().int().min(1).max(16).optional(),
              pole: z.string().nullable().optional(),
              flip: z.boolean().optional(),
              mix: z.number().min(0).max(1).optional(),
            })
            .nullable()
            .optional(),
        }),
      )
      .optional(),
    remove: z.array(z.string()).optional(),
  }),
  run(input, rt) {
    rt.write("Bones", (d) => {
      const { rig } = requireRig(d, input.rigId);
      if (input.add?.length) addChain(d, input.rigId, rig, input.add);
      for (const e of input.edit ?? []) {
        const b = boneRef(rig, e.bone);
        if (e.head || e.tail || e.roll !== undefined) editBone(d, input.rigId, b.id, { head: e.head && v3(e.head), tail: e.tail && v3(e.tail), roll: e.roll }, { children: e.children });
        setBoneProps(d, input.rigId, b.id, {
          name: e.name !== undefined ? uniqueName({ ...rig, bones: rig.bones.filter((x) => x.id !== b.id) }, e.name) : undefined,
          parent: e.parent === undefined ? undefined : e.parent === null ? null : boneRef(rig, e.parent).id,
          deform: e.deform,
          ...controlProps(e),
          ik: e.ik === undefined ? undefined : e.ik === null ? null : { ...e.ik, target: boneRef(rig, e.ik.target).id, pole: e.ik.pole === undefined ? undefined : e.ik.pole === null ? null : boneRef(rig, e.ik.pole).id },
        });
      }
      if (input.remove?.length) removeBones(d, input.rigId, input.remove.map((r) => boneRef(rig, r).id));
    });
    const { rig } = requireRig(rt.doc(), input.rigId);
    return { bones: rig.bones.map((b) => ({ id: b.id, name: b.name, parent: b.parent, ik: b.ik })) };
  },
});

const v3 = (p: readonly number[]): V3 => [p[0]!, p[1]!, p[2] ?? 0];

/** The control fields of a spec, for `setBoneProps` (absent stays absent). */
function controlProps(s: { shape?: Bone["shape"]; size?: number | null; color?: string | null; limits?: Record<string, [number, number]> | null }) {
  return { shape: s.shape, size: s.size, color: s.color, limits: s.limits };
}

const channels = {
  rotation: z.number().optional().describe("Degrees from rest (flat comps: + turns clockwise on screen)"),
  x: z.number().optional(),
  y: z.number().optional(),
  z: z.number().optional(),
  rotationX: z.number().optional().describe("A world bone's roll"),
  rotationY: z.number().optional().describe("A world bone's pitch"),
  scale: z.number().optional().describe("Stretch along the bone (1 = rest)"),
  scaleY: z.number().optional().describe("Thickness across it"),
  ik: z.number().min(0).max(1).optional().describe("How much IK wins (bones with IK)"),
};

export const rigPose = defineCommand({
  id: "rig.pose",
  summary: "Pose bones — turn, move, stretch — and key the pose at a moment. Values are a DELTA from rest (rotation 0 = as drawn), as the bone SHOWS.",
  details:
    "Writes the ordinary channels `bone.<id>.<channel>` on the rig: keyed where the channel is already keyed or `key: true`, the resting pose otherwise — exactly a person's pose-mode drag. " +
    "`atMs` is comp time (default 0). Move an IK CONTROL bone (x/y) to pose a whole arm or leg at once. `reset: true` clears every bone's resting pose first (keys stay). " +
    "Key a walk or a wave by calling this at several times with key: true, then check it with rig_inspect at those times or view_frames. " +
    "A pose set that moves the same bone keeps adding on top (poses are layers): the bone shows what you asked, and choosing another pose later keeps your adjustment.",
  effect: "write",
  input: z.object({
    rigId: z.string(),
    atMs: z.number().min(0).default(0),
    key: z.boolean().default(false),
    reset: z.boolean().default(false),
    poses: z.array(z.object({ bone: z.string(), ...channels })).default([]),
  }),
  run(input, rt) {
    rt.write("Pose", (d) => {
      const { group, rig } = requireRig(d, input.rigId);
      if (input.reset) resetPose(d, input.rigId);
      const local = clipLocalTime(group, input.atMs) ?? input.atMs - group.startMs;
      // What it SHOWS: your layer beneath whatever the rig's pose sets add.
      const posed = group.poses?.length ? posedPathsAt(d, group.startMs + local, group.frameId, poseEnvAt(d, group.startMs + local, group.frameId)) : new Map();
      const shown = input.poses.map(({ bone, ...values }) => ({ bone: boneRef(rig, bone).id, values: Object.fromEntries(Object.entries(values).filter(([, v]) => typeof v === "number")) }));
      poseBones(d, input.rigId, beneathPoses(posed, input.rigId, shown), local, { key: input.key });
    });
    return { posed: input.poses.length, atMs: input.atMs, keyed: input.key };
  },
});

export const rigBind = defineCommand({
  id: "rig.bind",
  summary: "How layers in a rig follow it: auto (default — decided by the art), smooth (bend), rigid (ride one bone), none (ignore the bones).",
  details:
    "Layers in a rig are bound with no step of their own; use this to override. `bone` (rigid) names the bone to ride. `clearPaint`: true wipes painted weights (or a bone's name: only that bone's). " +
    "A group under the rig with mode rigid/none moves as ONE piece (a head group riding the head bone).",
  effect: "write",
  input: z.object({
    ids: z.union([z.string(), z.array(z.string())]),
    mode: z.enum(["auto", "smooth", "rigid", "none"]).optional(),
    bone: z.string().nullable().optional(),
    clearPaint: z.union([z.boolean(), z.string()]).optional(),
  }),
  run(input, rt) {
    const ids = typeof input.ids === "string" ? [input.ids] : input.ids;
    rt.write("Bind", (d) => {
      for (const id of ids) {
        const m = memberOf(d, id) ?? memberOfGroup(d, id);
        if (!m) throw new ApiError(`"${requireClip(d, id).clip.name}" is not in a rig.`, "Move it into the rig's group first (layers_move into the group), or rig_create with it.");
        const bone = input.bone === undefined ? undefined : input.bone === null ? null : boneRef(m.rig.rig!, input.bone).id;
        setBind(d, id, { ...(input.mode && { mode: input.mode }), ...(bone !== undefined && { bone }) });
        if (input.clearPaint) clearWeightPaint(d, id, typeof input.clearPaint === "string" ? boneRef(m.rig.rig!, input.clearPaint).id : undefined);
      }
    });
    return { updated: ids };
  },
});

/** A group under a rig binds as a unit only when it speaks; for the bind verb, it may be told to. */
function memberOfGroup(doc: MotionDocument, id: string) {
  const c = requireClip(doc, id).clip;
  if (c.kind !== "group") return null;
  for (const t of doc.tracks) for (const x of t.clips) if (x.kind === "group" && x.rig?.bones.length && x.id !== id) {
    // Any rig above it.
    const inside = memberOfAny(doc, id, x.id);
    if (inside) return { rig: x, unit: c, inner: [] };
  }
  return null;
}
function memberOfAny(doc: MotionDocument, id: string, rigId: string): boolean {
  let at = doc.tracks.find((t) => t.clips.some((c) => c.id === id))?.groupId ?? null;
  const seen = new Set<string>();
  while (at && !seen.has(at)) {
    if (at === rigId) return true;
    seen.add(at);
    at = doc.tracks.find((t) => t.clips.some((c) => c.id === at))?.groupId ?? null;
  }
  return false;
}

export const rigPaint = defineCommand({
  id: "rig.paint",
  summary: "Paint bone weights on a bending layer — how much a bone pulls there. Strokes are kept and replayed over the automatic weights.",
  details:
    "Points are in the RIG's space (where you drew the bones), each a dab of `radius`. `mode`: add (more of this bone), subtract, replace (toward `strength`), smooth (even out a crease). " +
    "Painting makes the layer bend (mode smooth) if it was riding one bone. Fix a joint that creases or a region that follows the wrong bone; most rigs never need it.",
  effect: "write",
  input: z.object({
    id: z.string(),
    bone: z.string(),
    mode: z.enum(["add", "subtract", "replace", "smooth"]).default("add"),
    strength: z.number().min(0).max(1).default(0.5),
    radius: z.number().positive().default(30),
    points: z.array(point).min(1),
  }),
  run(input, rt) {
    rt.write("Paint weights", (d) => {
      const m = memberOf(d, input.id);
      if (!m || m.unit.id !== input.id || m.unit.kind === "group") throw new ApiError("Paint weights on a layer of a rig (not a group).");
      const bone = boneRef(m.rig.rig!, input.bone).id;
      // Rig space → the layer's own space, where strokes live.
      const frame = d.frames.find((f) => f.id === m.rig.frameId)!;
      const toRig = frame.world ? restWorld(m.unit as VisualClip, m.inner) : restToRig2d(d, m, m.unit);
      const inv = invert4(toRig);
      const pts: number[] = [];
      for (const p of input.points) {
        const l = transformPoint(inv, v3(p));
        pts.push(l[0], l[1], frame.world ? l[2] : 0, 1);
      }
      addWeightStroke(d, input.id, weightStrokeSchema.parse({ bone, mode: input.mode, strength: input.strength, radius: input.radius, points: pts }));
    });
    return { painted: input.id };
  },
});

/**
 * A world member's object space → rig space where it rests. Groups between it
 * and the rig place what they hold about their members' middle (a 3D group is
 * a delta), so a transformed one between them is refused rather than guessed.
 */
function restWorld(clip: VisualClip, inner: GroupClip[]): number[] {
  const moved = inner.find((g) => {
    const t = g.transform;
    return t.x || t.y || t.z || t.rotation || t.rotationX || t.rotationY || t.scale !== 1 || (t.scaleY ?? 1) !== 1 || (t.scaleZ ?? 1) !== 1;
  });
  if (moved) throw new ApiError(`"${moved.name}" sits between the layer and its rig and is moved itself.`, "Paint on the layer in the viewport, or reset that group's transform.");
  return objectLocalMatrix(clip);
}

export const rigInspect = defineCommand({
  id: "rig.inspect",
  summary: "A rig at a moment: every bone (rest and posed head/tail, IK) and how each of its layers follows it (rides which bone, bends, or ignores it).",
  effect: "read",
  input: z.object({ rigId: z.string(), atMs: z.number().min(0).default(0) }),
  run(input, rt) {
    const doc = rt.doc();
    const { group, rig } = requireRig(doc, input.rigId);
    const planar = rigIsPlanar(doc, group);
    const local = clipLocalTime(group, input.atMs) ?? input.atMs - group.startMs;
    const pose = rigPoseAt(group, local, planar);
    const rest = bonesInRig(rig, planar);
    const round = (p: readonly number[]) => p.slice(0, planar ? 2 : 3).map((v) => Math.round(v * 10) / 10);
    const bones = rig.bones.map((b) => {
      const s = pose?.byId.get(b.id);
      const r = rest.get(b.id)!;
      return {
        id: b.id,
        name: b.name,
        parent: b.parent ? (rig.bones.find((x) => x.id === b.parent)?.name ?? null) : null,
        deform: b.deform,
        ...(b.shape !== "bone" && { shape: b.shape }),
        ...(b.limits && { limits: b.limits }),
        rest: { head: round(r.head), tail: round(r.tail) },
        now: s ? { head: round(s.head), tail: round(s.tail) } : undefined,
        ...(b.ik && { ik: { target: rig.bones.find((x) => x.id === b.ik!.target)?.name, chain: b.ik.chain, pole: b.ik.pole ? rig.bones.find((x) => x.id === b.ik!.pole)?.name : null, flip: b.ik.flip, mix: b.ik.mix } }),
        ...(sideOf(b.name) && { side: sideOf(b.name) }),
        ...(b.constraints?.length && {
          constraints: b.constraints.map((c) => ({
            id: c.id,
            type: c.type,
            target: c.target.kind === "bone" ? (rig.bones.find((x) => x.id === (c.target as { bone: string }).bone)?.name ?? null) : [c.target.x, c.target.y, ...(c.target.z !== undefined ? [c.target.z] : [])],
            influence: c.influence,
            ...(!c.enabled && { enabled: false }),
            ...(c.type === "look" && c.radius !== null && { radius: c.radius }),
          })),
        }),
      };
    });
    const members: Array<{ id: string; name: string; follows: string }> = [];
    const frame = doc.frames.find((f) => f.id === group.frameId);
    const ev = frame?.world ? evaluateWorld(doc, frame, input.atMs) : null;
    for (const t of doc.tracks) for (const c of t.clips) {
      if (c.kind === "audio") continue;
      const m = memberOf(doc, c.id);
      if (!m || m.rig.id !== group.id || m.unit.id !== c.id) continue;
      let follows = "the group only";
      if (pose && planar) {
        const dcs = decide2d(doc, m, pose);
        follows = dcs.kind === "rigid" ? `rides ${rig.bones.find((b) => b.id === dcs.bone)?.name}` : dcs.kind === "smooth" ? "bends (weights)" : "ignores the bones";
      } else if (ev) {
        const o = ev.objects.find((x) => x.id === c.id);
        follows = o?.skin ? "bends (weights)" : c.bind?.mode === "none" ? "ignores the bones" : "rides a bone (or the rig is at rest)";
      }
      members.push({ id: c.id, name: c.name, follows });
    }
    return { rigId: group.id, space: planar ? "flat comp px, y down" : "world units, Z up", atRest: pose?.atRest ?? true, bones, members };
  },
});

// ── Symmetry and constraints (4.1) ──────────────────────────────────────────

export const rigSymmetrize = defineCommand({
  id: "rig.symmetrize",
  summary: "Build or refresh one side of a skeleton from the other: every .L bone gets its .R mirror (or the reverse) — rest, parent, limits, shape, IK and constraints. Twice is once.",
  details:
    "Sides are read from bone NAMES — Arm.L / arm_r / L_arm / LeftArm / Arm Left all work, mixed conventions pair by stem. Name the left side's bones with a side, the middle ones (Spine, Head, a Look control) without. " +
    "The mirror line is the middle of the centre bones (else midway between pairs); `axis` overrides it (rig space x). A mirror that exists is UPDATED in place (its keys and bindings kept); the rest are created. " +
    "IK targets, poles and constraint targets map to their own mirrors; a centre target stays. Pose is left alone — rig_mirror copies poses.",
  effect: "write",
  input: z.object({
    rigId: z.string(),
    from: z.enum(["L", "R"]).optional().describe("The side to copy from (default: the side with more bones)"),
    axis: z.number().optional().describe("The mirror line, rig-space x (default: the character's middle)"),
  }),
  run(input, rt) {
    let res: SymmetrizeResult | null = null;
    rt.write("Symmetrize", (d) => {
      requireRig(d, input.rigId);
      res = symmetrize(d, input.rigId, { from: input.from, axis: input.axis });
    });
    const { rig } = requireRig(rt.doc(), input.rigId);
    const r = res as SymmetrizeResult | null;
    if (!r) throw new ApiError("Nothing to symmetrize.");
    const name = (id: string) => rig.bones.find((b) => b.id === id)?.name ?? id;
    return { axis: r.axis, from: r.from, created: r.created.map(name), updated: r.updated.map(name) };
  },
});

export const rigMirror = defineCommand({
  id: "rig.mirror",
  summary: "Mirror a pose at a moment: copy one side's pose onto the other (mode copy), or flip the whole pose over (mode flip — sides swap, the middle mirrors).",
  details:
    "Turns and rolls flip sign, a move flips across the character, stretch keeps. `bones` (names or ids) limits a copy to those bones; default every bone of `from` (L). " +
    "Written like rig_pose: keyed where keyed or with key: true. A walk's second half is the first half flipped: key the contact poses, then mirror with mode flip at the half-cycle times.",
  effect: "write",
  input: z.object({
    rigId: z.string(),
    atMs: z.number().min(0).default(0),
    mode: z.enum(["copy", "flip"]).default("copy"),
    from: z.enum(["L", "R"]).default("L"),
    bones: z.array(z.string()).optional(),
    key: z.boolean().default(false),
  }),
  run(input, rt) {
    let written: string[] = [];
    rt.write(input.mode === "flip" ? "Flip pose" : "Mirror pose", (d) => {
      const { group, rig } = requireRig(d, input.rigId);
      const local = clipLocalTime(group, input.atMs) ?? input.atMs - group.startMs;
      written = mirrorPose(d, input.rigId, local, { mode: input.mode, from: input.from, key: input.key, bones: input.bones?.map((r) => boneRef(rig, r).id) });
      if (!written.length) throw new ApiError("No bone has a mirror.", "Name bones with a side (Arm.L / Arm.R), or rig_symmetrize to make the other side.");
    });
    const { rig } = requireRig(rt.doc(), input.rigId);
    return { posed: written.map((id) => rig.bones.find((b) => b.id === id)?.name ?? id), atMs: input.atMs, keyed: input.key };
  },
});

const target = z
  .union([z.string(), z.tuple([z.number(), z.number()]), z.tuple([z.number(), z.number(), z.number()])])
  .describe("A bone of this rig (name or id), or a fixed point [x, y] / [x, y, z] in rig space");

export const rigConstrain = defineCommand({
  id: "rig.constrain",
  summary: "Give bones LOOK (a pupil slides toward a target inside its pad) or TRACK (a head turns to point at a target) constraints; update or remove them.",
  details:
    "look: on a pupil CONTROL with x/y limits — it slides toward the target bone, held to the ellipse its pad limits draw (and `radius`, if set). track: on a head or an eyeball — its tail turns the short way to point at the target, held by its rotation limits. " +
    "Targets are bones of the same rig (a Look control the eyes share, a ball's control) or a point. `influence` 0..1 keys at the path bone.<id>.con.<constraintId> (keyframes_set) — fade the look in and out. " +
    "They run after IK, parents first: track the head, then the pupils look from where the head put them. To follow a LAYER outside the rig, drive the control bone's x/y with an expression.",
  effect: "write",
  input: z.object({
    rigId: z.string(),
    add: z.array(z.object({ bone: z.string(), type: z.enum(["look", "track"]), target, influence: z.number().min(0).max(1).optional(), radius: z.number().min(0).nullable().optional(), enabled: z.boolean().optional() })).optional(),
    update: z.array(z.object({ bone: z.string(), id: z.string(), target: target.optional(), influence: z.number().min(0).max(1).optional(), radius: z.number().min(0).nullable().optional(), enabled: z.boolean().optional() })).optional(),
    remove: z.array(z.object({ bone: z.string(), id: z.string() })).optional(),
  }),
  run(input, rt) {
    const added: Array<{ bone: string; id: string }> = [];
    rt.write("Constraints", (d) => {
      const { rig } = requireRig(d, input.rigId);
      const toTarget = (t: z.infer<typeof target>): BoneTarget => (typeof t === "string" ? { kind: "bone", bone: boneRef(rig, t).id } : { kind: "point", x: t[0], y: t[1], ...(t[2] !== undefined && { z: t[2] }) });
      for (const a of input.add ?? []) {
        const b = boneRef(rig, a.bone);
        const id = addConstraint(d, input.rigId, b.id, { type: a.type, target: toTarget(a.target), influence: a.influence, radius: a.radius ?? undefined, enabled: a.enabled });
        if (!id) throw new ApiError(`"${b.name}" cannot ${a.type} at that.`, "A bone cannot look at itself; name another bone of this rig, or a point.");
        added.push({ bone: b.name, id });
      }
      for (const u of input.update ?? []) {
        const b = boneRef(rig, u.bone);
        if (!updateConstraint(d, input.rigId, b.id, u.id, { target: u.target ? toTarget(u.target) : undefined, influence: u.influence, radius: u.radius, enabled: u.enabled })) {
          throw new ApiError(`No constraint "${u.id}" on "${b.name}".`, `Its constraints: ${(b.constraints ?? []).map((c) => `${c.id} (${c.type})`).join(", ") || "none"}.`);
        }
      }
      for (const r of input.remove ?? []) removeConstraints(d, input.rigId, boneRef(rig, r.bone).id, [r.id]);
    });
    return { added };
  },
});

// ── Switches ────────────────────────────────────────────────────────────────

export const switchCreate = defineCommand({
  id: "switch.create",
  summary: "Make a SWITCH — a group that shows ONE member at a time: an eye open/half/closed, a mouth's shapes, a hand's poses. From layers, or from every variant of a component.",
  details:
    "From `ids`: those layers (one comp) become the switch's members, or one group id becomes a switch. From `component` (a component frame id): one instance of every variant in its set, named for the variant, stacked at x/y in `frameId` — a mouth set becomes a mouth lip sync can key by sound. " +
    "Members are chosen by NAME (any case) or by place from the top (0); a name no member has shows the top one. Put a switch inside a rig and it rides the head bone like any piece. " +
    "Then: switch_show to choose or key; expression.set(switchId, 'switch', 'if(blink(4) > 0, \"Closed\", \"Open\")') for a living blink.",
  effect: "write",
  input: z.object({
    ids: z.array(z.string()).optional().describe("Layers to switch between, or one group to make a switch"),
    component: z.string().optional().describe("A component frame id — one instance of each of its variants"),
    frameId: z.string().optional().describe("The comp to place a component switch in (default: the active one)"),
    name: z.string().optional(),
    show: z.string().optional().describe("The member shown at rest (default: the top one)"),
    x: z.number().optional(),
    y: z.number().optional(),
  }),
  run(input, rt) {
    if (!input.ids?.length && !input.component) throw new ApiError("Nothing to switch between.", "Pass `ids` (layers) or `component` (a component frame id).");
    let id: string | null = null;
    rt.write("Make switch", (d) => {
      if (input.component) {
        const frame = resolveTargetFrame(rt, input.frameId);
        id = switchFromVariants(d, frame.id, input.component, { x: input.x, y: input.y, name: input.name, show: input.show });
        if (!id) throw new ApiError(`"${input.component}" is not a component.`, "component_list / frames_list show component frames; a component's variants are its members.");
      } else {
        id = makeSwitch(d, input.ids!, { name: input.name, show: input.show });
        if (!id) throw new ApiError("Those layers cannot be made a switch.", "They must be in one comp; a rig or an auto-layout group cannot also be a switch.");
      }
    });
    const doc = rt.doc();
    const g = requireClip(doc, id!).clip as GroupClip;
    return { switchId: id!, show: g.switch?.show ?? "", members: switchOptions(doc, id!).map((c) => ({ id: c.id, name: c.name })) };
  },
});

export const switchShow = defineCommand({
  id: "switch.show",
  summary: "Choose what a switch shows — a member's name, id or place from the top — at a moment; key: true keys it (a blink is two keys, lip sync a key per sound). off: true makes it a plain group again.",
  details: "Written as the member's NAME, keyed where the switch is already keyed or `key` is true, its resting choice otherwise. `atMs` is comp time.",
  effect: "write",
  input: z.object({
    id: z.string(),
    show: z.union([z.string(), z.number().int().min(0)]).optional(),
    atMs: z.number().min(0).default(0),
    key: z.boolean().default(false),
    off: z.boolean().default(false),
  }),
  run(input, rt) {
    rt.write(input.off ? "Remove switch" : "Show", (d) => {
      const g = requireClip(d, input.id).clip;
      if (g.kind !== "group" || !g.switch) throw new ApiError(`"${g.name}" is not a switch.`, "switch_create makes one.");
      if (input.off) {
        unmakeSwitch(d, input.id);
        return;
      }
      if (input.show === undefined) throw new ApiError("Say what to show.", "`show`: a member's name, id or place from the top.");
      const local = clipLocalTime(g, input.atMs) ?? input.atMs - g.startMs;
      if (!setSwitch(d, input.id, input.show, local, { key: input.key })) {
        throw new ApiError(`No member "${input.show}" in "${g.name}".`, `Members: ${switchOptions(d, input.id).map((c) => c.name).join(", ")}.`);
      }
    });
    return { id: input.id, show: input.off ? null : input.show, atMs: input.atMs, keyed: input.key };
  },
});

export const RIG_COMMANDS = [rigCreate, rigBone, rigPose, rigBind, rigPaint, rigInspect, rigSymmetrize, rigMirror, rigConstrain, switchCreate, switchShow];

