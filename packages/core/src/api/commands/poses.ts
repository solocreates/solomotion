import { z } from "zod";
import type { MotionDocument, GroupClip, PoseSet } from "../../schema";
import { keyframeValueSchema } from "../../schema/animation";
import { ApiError, defineCommand } from "../command";
import { requireClip } from "../lookup";
import { easingInputSchema, parseEasing } from "../values";
import { listVocabularies } from "../../rig/vocabulary";
import { poseSetMixAt } from "../../rig/poses";
import { characterLanes, type PoseBlock } from "../../rig/character-lanes";
import { lipSyncVoiceOf, poseSetLiveSource } from "../../rig/pose-choice";
import { poseEnvAt } from "../../evaluate/resolved-doc";
import { changeBlockPose, deleteBlock, slideBlock, splitBlock, trimBlock } from "../../rig/block-edit";
import {
  addPose,
  bakePoseSet,
  createPoseSet,
  duplicatePose,
  keyPose,
  mirrorPoseInSet,
  movePoseKey,
  removePoseKey,
  poseIn,
  poseSetFromSwitch,
  poseSetFromLayer,
  poseDrawingOf,
  duplicatePoseDrawing,
  poseSetOf,
  removePose,
  removePoseSet,
  reorderPoses,
  updatePose,
  updatePoseSet,
} from "../../rig/pose-ops";

/**
 * POSES, FOR AGENTS — a part with named states (a mouth's visemes, eyes,
 * hands) and the verbs the Face pad has. A pose is a list of `{clipId, path,
 * value}` on any layer under the group (`switch`, `key.<id>`, `bone.<id>.<ch>`,
 * `y`, a fill…); the set's channel `pose.<setId>` picks one by NAME and the
 * app eases between them. See references/poses.md.
 */

const valueSpec = z.object({ clipId: z.string(), path: z.string(), value: keyframeValueSchema });
const targetSpec = z.object({ clipId: z.string(), path: z.string() });
const blendSpec = z.object({ ms: z.number().min(0).max(2000).optional(), ease: easingInputSchema.optional() });

function requireGroup(doc: MotionDocument, id: string): GroupClip {
  const c = requireClip(doc, id).clip;
  if (c.kind !== "group") throw new ApiError(`"${c.name}" is not a group.`, "Pose sets live on a group — the character, or a part of it.");
  return c;
}

function requireSet(doc: MotionDocument, groupId: string, set: string): { group: GroupClip; set: PoseSet } {
  requireGroup(doc, groupId);
  const at = poseSetOf(doc, groupId, set);
  if (!at) {
    const g = requireGroup(doc, groupId);
    throw new ApiError(`No pose set "${set}" on "${g.name}".`, `Sets: ${(g.poses ?? []).map((s) => s.name).join(", ") || "none — poses_create makes one"}.`);
  }
  return at;
}

function requirePose(set: PoseSet, ref: string) {
  const p = poseIn(set, ref);
  if (!p) throw new ApiError(`No pose "${ref}" in "${set.name}".`, `Poses: ${set.poses.map((x) => x.name).join(", ") || "none yet"}.`);
  return p;
}

const blendOf = (b: z.infer<typeof blendSpec> | undefined) => (b ? { ...(b.ms !== undefined && { ms: b.ms }), ...(b.ease !== undefined && { ease: parseEasing(b.ease) }) } : undefined);

export const posesCreate = defineCommand({
  id: "poses.create",
  summary: "Make a POSE SET on a group — a part with named states (mouth visemes, eyes, brows, hands). From a switch (one pose per member) or from pose lists.",
  details:
    "`fromSwitch`: a switch group under (or equal to) `groupId` — each member becomes a pose showing it. `poses`: [{name, values:[{clipId, path, value}]}], any animatable path on any layer under the group. " +
    `Vocabularies: ${listVocabularies().map((v) => `${v.id} (${v.names.join(" ")})`).join("; ")}. Omitted = guessed from the names. Blend default 120 ms ease-in-out.`,
  effect: "write",
  input: z.object({
    groupId: z.string(),
    name: z.string().optional(),
    vocabulary: z.string().nullable().optional(),
    fromSwitch: z.string().optional(),
    fromLayer: z.string().optional().describe("Any layer under the group becomes a part of its own (a tail, ears, a cape): a set named for it, framed on it, with one pose, Rest. Pose it and poses.add capture."),
    poses: z.array(z.object({ name: z.string(), values: z.array(valueSpec).default([]) })).optional(),
    blend: blendSpec.optional(),
    part: z.string().optional().describe("The layer the set is about (the Mouth group, Eye.L) — its pictures frame it. From a switch: the switch."),
  }),
  run(input, rt) {
    let id: string | null = null;
    rt.write("New pose set", (d) => {
      requireGroup(d, input.groupId);
      id = input.fromSwitch
        ? poseSetFromSwitch(d, input.groupId, input.fromSwitch, { name: input.name, vocabulary: input.vocabulary })
        : input.fromLayer
          ? poseSetFromLayer(d, input.groupId, requireClip(d, input.fromLayer).clip.id)
          : createPoseSet(d, input.groupId, { name: input.name, vocabulary: input.vocabulary, poses: input.poses, blend: blendOf(input.blend) });
      if (!id && input.fromLayer) throw new ApiError("That layer is not under the group.", "`fromLayer` must be a layer inside the character.");
      if (id && input.fromLayer && input.name) updatePoseSet(d, input.groupId, id, { name: input.name });
      if (!id) throw new ApiError("That switch cannot make a pose set here.", "`fromSwitch` must be a switch group inside the group (or the group itself).");
      if (input.fromSwitch && input.blend) updatePoseSet(d, input.groupId, id, { blend: blendOf(input.blend) });
      if (input.part) updatePoseSet(d, input.groupId, id, { part: requireClip(d, input.part).clip.id });
    });
    const { set } = requireSet(rt.doc(), input.groupId, id!);
    return { setId: set.id, path: `pose.${set.id}`, name: set.name, vocabulary: set.vocabulary, poses: set.poses.map((p) => ({ id: p.id, name: p.name })) };
  },
});

export const posesInspect = defineCommand({
  id: "poses.inspect",
  summary: "A group's pose sets: each pose and what it sets, at `atMs` which pose shows and the blend weights, and with `blocks` its performance — the timeline's pose lanes.",
  details:
    "`blocks: true` returns each set's blocks over `fromMs`–`toMs` (comp time; default the whole group): {fromMs, toMs, pose, source: keyed | base | live, keyMs?} — what the canvas shows, block by block — and `overlays` where a driver riding on the keys (a blink over `#value`) shows something else. `keyMs` is the group-local key a block starts at: move it with poses.key `move`, remove it with `remove`.",
  effect: "read",
  input: z.object({
    groupId: z.string(),
    atMs: z.number().min(0).optional(),
    blocks: z.boolean().default(false),
    fromMs: z.number().min(0).optional(),
    toMs: z.number().min(0).optional(),
  }),
  run(input, rt) {
    const doc = rt.doc();
    const g = requireGroup(doc, input.groupId);
    const lanes = input.blocks
      ? characterLanes(doc, g.id, input.fromMs !== undefined || input.toMs !== undefined ? { fromMs: input.fromMs ?? 0, toMs: input.toMs ?? Infinity } : undefined, (t) => poseEnvAt(doc, t, g.frameId))
      : [];
    const block = (b: PoseBlock) => ({ fromMs: Math.round(b.fromMs), toMs: Math.round(b.toMs), pose: b.name, source: b.source, ...(b.keyMs !== undefined && { keyMs: b.keyMs }), ...(b.behaviorId && { behavior: b.behaviorId }), ...(b.overridden && { overridden: true }) });
    return {
      groupId: g.id,
      sets: (g.poses ?? []).map((set) => {
        const lane = lanes.find((l) => l.setId === set.id);
        const mix = input.atMs !== undefined ? poseSetMixAt(doc, g, set, input.atMs, poseEnvAt(doc, input.atMs, g.frameId)) : null;
        const nameOf = (id: string) => set.poses.find((p) => p.id === id)?.name ?? id;
        return {
          id: set.id,
          path: `pose.${set.id}`,
          name: set.name,
          vocabulary: set.vocabulary,
          blendMs: set.blend.ms,
          keyed: g.keyframes.some((k) => k.property === `pose.${set.id}` && k.keys.length > 0),
          driven: !!g.drivers?.[`pose.${set.id}`],
          poses: set.poses.map((p) => ({ id: p.id, name: p.name, values: p.values })),
          ...(mix && { now: nameOf(mix.target), weights: Object.fromEntries([...mix.weights].map(([k, w]) => [nameOf(k), Math.round(w * 1000) / 1000])) }),
          ...(lane && { mode: lane.mode, blocks: lane.blocks.map(block), ...(lane.overlays.length && { overlays: lane.overlays.map(block) }) }),
        };
      }),
    };
  },
});

export const posesAdd = defineCommand({
  id: "poses.add",
  summary: "Add a pose to a set — from `values`, or `capture` what the set's parts (or `targets`) show at `atMs`.",
  details:
    "Capture takes what the parts SHOW at `atMs` (comp time) — pose them first, then capture — and the new pose shows from there: still adjustments on bones and shape keys move into it, keyed ones stay yours, so nothing on screen moves.",
  effect: "write",
  input: z.object({
    groupId: z.string(),
    set: z.string().describe("Set id or name"),
    name: z.string(),
    values: z.array(valueSpec).optional(),
    capture: z.boolean().default(false),
    targets: z.array(targetSpec).optional(),
    atMs: z.number().min(0).default(0),
  }),
  run(input, rt) {
    let id: string | null = null;
    rt.write("Add pose", (d) => {
      const { group, set } = requireSet(d, input.groupId, input.set);
      id = addPose(d, group.id, set.id, {
        name: input.name,
        values: input.values,
        capture: input.capture || (!input.values && input.targets) ? { atMs: input.atMs - group.startMs, targets: input.targets } : undefined,
        env: poseEnvAt(d, input.atMs, group.frameId),
      });
    });
    const { set } = requireSet(rt.doc(), input.groupId, input.set);
    const pose = set.poses.find((p) => p.id === id)!;
    return { poseId: pose.id, name: pose.name, values: pose.values };
  },
});

export const posesUpdate = defineCommand({
  id: "poses.update",
  summary: "Change a pose set (rename, vocabulary, blend, order) or one pose (rename, values, upsert/unset values, re-capture, duplicate, mirror L↔R).",
  effect: "write",
  input: z.object({
    groupId: z.string(),
    set: z.string(),
    name: z.string().optional().describe("New SET name (without `pose`)"),
    vocabulary: z.string().nullable().optional(),
    blend: blendSpec.extend({ mode: z.enum(["morph", "swap"]).optional() }).optional(),
    part: z.string().nullable().optional().describe("The layer the set is about; null = automatic"),
    transitions: z
      .array(z.object({ from: z.string().default("*"), to: z.string().default("*"), ms: z.number().min(0).max(2000), mode: z.enum(["morph", "swap"]).optional() }))
      .nullable()
      .optional()
      .describe("Per-pair blends over the set's own: [{from, to, ms}] (names, `*` any). null clears."),
    order: z.array(z.string()).optional().describe("Pose ids or names, first to last"),
    pose: z.string().optional().describe("The pose to change (id or name)"),
    rename: z.string().optional(),
    values: z.array(valueSpec).optional().describe("Replace all its values"),
    setValues: z.array(valueSpec).optional().describe("Upsert these values"),
    unset: z.array(targetSpec).optional(),
    capture: z.boolean().default(false).describe("Re-capture its values at atMs"),
    atMs: z.number().min(0).default(0),
    duplicate: z.boolean().default(false),
    mirror: z.boolean().default(false).describe("Write the pose's mirror (Wink.L → Wink.R), made or replaced"),
  }),
  run(input, rt) {
    let made = null as string | null;
    rt.write("Edit pose", (d) => {
      const { group, set } = requireSet(d, input.groupId, input.set);
      updatePoseSet(d, group.id, set.id, {
        name: input.name,
        vocabulary: input.vocabulary,
        blend: input.blend ? { ...blendOf(input.blend), ...(input.blend.mode && { mode: input.blend.mode }) } : undefined,
        ...(input.part !== undefined && { part: input.part === null ? null : requireClip(d, input.part).clip.id }),
        ...(input.transitions !== undefined && { transitions: input.transitions }),
      });
      if (input.order) reorderPoses(d, group.id, set.id, input.order.map((r) => requirePose(set, r).id));
      if (!input.pose) return;
      const pose = requirePose(set, input.pose);
      updatePose(d, group.id, set.id, pose.id, {
        name: input.rename,
        values: input.values,
        set: input.setValues,
        unset: input.unset,
        capture: input.capture ? { atMs: input.atMs - group.startMs } : undefined,
        env: poseEnvAt(d, input.atMs, group.frameId),
      });
      if (input.duplicate) made = duplicatePose(d, group.id, set.id, pose.id);
      if (input.mirror) made = mirrorPoseInSet(d, group.id, set.id, pose.id);
    });
    const { set } = requireSet(rt.doc(), input.groupId, input.set);
    return { setId: set.id, name: set.name, poses: set.poses.map((p) => ({ id: p.id, name: p.name })), ...(made && { made }) };
  },
});

export const posesRemove = defineCommand({
  id: "poses.remove",
  summary: "Delete one pose, or (no `pose`) the whole set with its keys and driver.",
  effect: "write",
  input: z.object({ groupId: z.string(), set: z.string(), pose: z.string().optional() }),
  run(input, rt) {
    rt.write(input.pose ? "Delete pose" : "Delete pose set", (d) => {
      const { group, set } = requireSet(d, input.groupId, input.set);
      if (input.pose) removePose(d, group.id, set.id, requirePose(set, input.pose).id);
      else removePoseSet(d, group.id, set.id);
    });
    return { removed: input.pose ?? input.set };
  },
});

export const posesKey = defineCommand({
  id: "poses.key",
  summary: "Show a pose from a moment — key it (key: true, or where the set is already keyed) or set its resting pose. Many at once: `keys`.",
  details:
    "Lip sync by hand is one key per sound: keys: [{atMs, pose:'MBP'}, …]. Names go through the vocabulary (aliases, fallbacks). `atMs` is comp time. " +
    "Edit blocks like the timeline does: `move: {fromMs, toMs}` retimes the key a block starts at (group-local `keyMs` from poses.inspect blocks), `remove: keyMs` deletes it — the block before runs on.",
  effect: "write",
  input: z.object({
    groupId: z.string(),
    set: z.string(),
    pose: z.string().optional(),
    atMs: z.number().min(0).default(0),
    key: z.boolean().default(true),
    keys: z.array(z.object({ atMs: z.number().min(0), pose: z.string() })).optional(),
    move: z.object({ fromMs: z.number(), toMs: z.number() }).optional().describe("Retime a block: its key, group-local"),
    remove: z.number().optional().describe("Delete the block whose key is at this group-local ms"),
  }),
  run(input, rt) {
    if (input.move || input.remove !== undefined) {
      let moved: number | null = null;
      let removed = false;
      rt.write(input.move ? "Move pose block" : "Delete pose block", (d) => {
        const { group, set } = requireSet(d, input.groupId, input.set);
        if (input.move) moved = movePoseKey(d, group.id, set.id, input.move.fromMs, input.move.toMs);
        if (input.remove !== undefined) removed = removePoseKey(d, group.id, set.id, input.remove);
      });
      if (input.move && moved === null) throw new ApiError(`No pose key at  ms.`, "poses.inspect {blocks: true} lists each block's keyMs.");
      if (input.remove !== undefined && !removed) throw new ApiError(`No pose key at  ms.`, "poses.inspect {blocks: true} lists each block's keyMs.");
      return { ...(input.move && { movedTo: moved }), ...(input.remove !== undefined && { removed }) };
    }
    const list = input.keys ?? (input.pose ? [{ atMs: input.atMs, pose: input.pose }] : []);
    if (!list.length) throw new ApiError("Say which pose.", "`pose` (+ `atMs`), `keys: [{atMs, pose}]`, `move` or `remove`.");
    {
      // A set something else drives would ignore the keys — say so instead of writing them.
      const { group, set } = requireSet(rt.doc(), input.groupId, input.set);
      const live = poseSetLiveSource(rt.doc(), group, set);
      if (live)
        throw new ApiError(
          `${set.name} is live (${live}) — keys under it would change nothing.`,
          lipSyncVoiceOf(live) !== null ? "speech.fix corrects one syllable; poses.bake turns the live choice into keys you own." : "poses.bake turns the live choice into keys you own, then key it.",
        );
    }
    rt.write("Key pose", (d) => {
      const { group, set } = requireSet(d, input.groupId, input.set);
      for (const k of list) keyPose(d, group.id, set.id, requirePose(set, k.pose).id, k.atMs - group.startMs, { key: input.key || list.length > 1 });
    });
    return { keyed: list.length };
  },
});

export const posesBake = defineCommand({
  id: "poses.bake",
  summary: "Bake a set's live choice (an expression, lip sync, a machine) into pose.<set> keys over a range — one key per change — and drop the driver.",
  effect: "write",
  input: z.object({ groupId: z.string(), set: z.string(), fromMs: z.number().min(0).optional(), toMs: z.number().min(0).optional() }),
  run(input, rt) {
    let n = 0;
    rt.write("Bake to keys", (d) => {
      const { group, set } = requireSet(d, input.groupId, input.set);
      // The driver is read on the document as it was (the draft is about to drop it).
      n = bakePoseSet(d, group.id, set.id, { fromMs: input.fromMs ?? group.startMs, toMs: input.toMs ?? group.startMs + group.durationMs }, poseEnvAt(rt.doc(), group.startMs, group.frameId));
    });
    return { keys: n };
  },
});

export const posesBlock = defineCommand({
  id: "poses.block",
  summary: "Edit ONE block of a set's lane like a clip — the block under `atMs` (comp time): change its pose, split it, delete it, trim or roll an edge, or slide it. Works on any block: your keys, a behavior's (a syllable, a blink — it becomes an override the behavior keeps), or the resting pose.",
  details:
    "`change` + `pose`: that block alone shows another pose. `split` + `splitMs`: two blocks of its pose (then change either). `delete`: a key goes (the block before runs on) / a behavior stands aside there. `trim` + `edge` (start | end) + `toMs`: the edge moves — the edge it shares with its neighbour ROLLS (one grows as the other shrinks) unless `roll: false`. `slide` + `deltaMs`: the whole block moves (a keyed block slides between its neighbours; a behavior's lands over what is there). Every time lands on the frame grid. poses.inspect `blocks: true` lists the blocks.",
  effect: "write",
  input: z.object({
    groupId: z.string(),
    set: z.string().describe("Set id or name."),
    atMs: z.number().min(0).describe("A comp instant inside the block."),
    action: z.enum(["change", "split", "delete", "trim", "slide"]),
    pose: z.string().optional().describe("`change`: the pose (name or id)."),
    splitMs: z.number().min(0).optional().describe("`split`: where (comp ms); default `atMs`."),
    edge: z.enum(["start", "end"]).optional(),
    toMs: z.number().min(0).optional().describe("`trim`: where the edge goes (comp ms)."),
    roll: z.boolean().default(true),
    deltaMs: z.number().optional().describe("`slide`: how far (ms, + later)."),
  }),
  run(input, rt) {
    const doc = rt.doc();
    const { group, set } = requireSet(doc, input.groupId, input.set);
    const lane = characterLanes(doc, group.id, undefined, (t) => poseEnvAt(doc, t, group.frameId), set.id)[0];
    const index = lane?.blocks.findIndex((b) => b.fromMs <= input.atMs && input.atMs < b.toMs) ?? -1;
    if (!lane || index < 0) throw new ApiError(`No block of "${set.name}" at ${input.atMs} ms.`, `The character spans ${group.startMs}–${group.startMs + group.durationMs} ms (comp time).`);
    const block = lane.blocks[index]!;
    if (input.action === "change" && !input.pose) throw new ApiError("`change` needs `pose`.");
    if (input.action === "trim" && (!input.edge || input.toMs === undefined)) throw new ApiError("`trim` needs `edge` and `toMs`.");
    if (input.action === "slide" && input.deltaMs === undefined) throw new ApiError("`slide` needs `deltaMs`.");
    const poseId = input.pose ? requirePose(set, input.pose).id : "";
    let ok = false;
    rt.write(`${input.action[0]!.toUpperCase()}${input.action.slice(1)} block`, (d) => {
      if (input.action === "change") ok = changeBlockPose(d, group.id, set.id, block, poseId);
      else if (input.action === "split") ok = splitBlock(d, group.id, set.id, block, input.splitMs ?? input.atMs);
      else if (input.action === "delete") ok = deleteBlock(d, group.id, set.id, block);
      else if (input.action === "trim") ok = !!trimBlock(d, group.id, set.id, lane.blocks, index, input.edge!, input.toMs!, { roll: input.roll });
      else ok = !!slideBlock(d, group.id, set.id, lane.blocks, index, input.deltaMs!);
    });
    if (!ok) throw new ApiError(`Could not ${input.action} that ${block.source} block.`, block.source === "live" && !block.behaviorId ? "A driver chooses it: poses.bake first." : "A split needs a frame either side; a trim leaves a frame of each block.");
    const after = rt.doc();
    const now = characterLanes(after, group.id, undefined, (t) => poseEnvAt(after, t, group.frameId), set.id)[0];
    return { blocks: (now?.blocks ?? []).map((b) => ({ fromMs: Math.round(b.fromMs), toMs: Math.round(b.toMs), pose: b.name, source: b.source, ...(b.behaviorId && { behavior: b.behaviorId }), ...(b.overridden && { overridden: true }) })) };
  },
});

export const posesDrawing = defineCommand({
  id: "poses.drawing",
  summary: "A swap pose's DRAWING — the layer that pose shows (a hand drawn as a fist). `inspect` names it (edit that layer to change the pose everywhere it is used, like a component's master); `duplicate` copies it into the same switch as a NEW pose to redraw, the original untouched.",
  details: "Bones and shape-key poses have no drawing of their own: pose the parts and poses.update capture. After `duplicate`, edit the returned `layerId` (its shapes are layers under it) and rename the pose with poses.update.",
  effect: "write",
  input: z.object({ groupId: z.string(), set: z.string(), pose: z.string(), action: z.enum(["inspect", "duplicate"]).default("inspect") }),
  run(input, rt) {
    const { set } = requireSet(rt.doc(), input.groupId, input.set);
    const pose = requirePose(set, input.pose);
    const drawing = poseDrawingOf(rt.doc(), input.groupId, set.id, pose.id);
    if (!drawing) throw new ApiError(`"${pose.name}" shows no drawing of its own.`, "Only a swap pose (a switch member) has one — move bones or keys and poses.update capture instead.");
    if (input.action === "inspect") return { pose: pose.name, switchId: drawing.switchId, layerId: drawing.memberId, layers: clipsUnderGroupOf(rt.doc(), drawing.memberId) };
    let made: ReturnType<typeof duplicatePoseDrawing> = null;
    rt.write("New drawing from pose", (d) => void (made = duplicatePoseDrawing(d, input.groupId, set.id, pose.id)));
    const m = made as ReturnType<typeof duplicatePoseDrawing>;
    if (!m) throw new ApiError("Could not copy that drawing.");
    const after = requireSet(rt.doc(), input.groupId, set.id).set;
    return { poseId: m.poseId, pose: after.poses.find((p) => p.id === m.poseId)?.name, layerId: m.memberId, layers: clipsUnderGroupOf(rt.doc(), m.memberId) };
  },
});

/** The layers under a drawing (itself when it is one layer), by id and name. */
function clipsUnderGroupOf(doc: MotionDocument, id: string): Array<{ id: string; name: string; kind: string }> {
  const c = requireClip(doc, id).clip;
  if (c.kind !== "group") return [{ id: c.id, name: c.name, kind: c.kind }];
  return doc.tracks.filter((t) => t.groupId === id).flatMap((t) => t.clips.map((x) => ({ id: x.id, name: x.name, kind: x.kind })));
}

export const POSE_COMMANDS = [posesDrawing, posesCreate, posesInspect, posesAdd, posesUpdate, posesRemove, posesKey, posesBake, posesBlock];
