import type { MotionDocument, Bone, GroupClip, KeyframeValue, Pose, PoseBlend, PoseSet, PoseValue } from "../schema";
import { poseBlendSchema, poseTransitionSchema, type PoseTransition } from "../schema/poses";
import { createId } from "../ids";
import { channelValueAt, writeChannel } from "../animation/channels";
import { getClipProperty } from "../animation/paths";
import { duplicateClips, locateClip } from "../timeline/ops";
import { clipsUnderGroup } from "../timeline/groups";
import { switchOptions } from "../timeline/switch";
import { compFps, frameStepMs } from "../timeline/fps";
import { BONE_PATH } from "./fields";
import type { BoneChannel } from "./pose";
import { restFrames, rigIsPlanar } from "./ops";
import { decide2d, memberOf } from "./bind";
import { evaluateRig } from "./pose";
import { mirroredValues } from "./symmetry";
import { mirrorName, pairOf } from "./sides";
import { canonicalPoseName, listVocabularies, mirrorPoseName } from "./vocabulary";
import { drivesSet } from "../behaviors/evaluate";
import { composePosed, ownValueShowing, poseChannelAt, poseComposeOf, posedPathsAt, resolvePose, type PosedPath, type PoseEnv } from "./poses";

/**
 * POSE SET EDITS — the verbs the Face pad, the agent API and scripts share.
 * Every op mutates a draft (call inside one store update) and returns what it
 * made, or null when the group / set / pose is not there.
 */

function groupOf(doc: MotionDocument, groupId: string): GroupClip | null {
  const c = locateClip(doc, groupId)?.clip;
  return c?.kind === "group" ? c : null;
}

export function poseSetOf(doc: MotionDocument, groupId: string, setId: string): { group: GroupClip; set: PoseSet } | null {
  const group = groupOf(doc, groupId);
  const set = group?.poses?.find((s) => s.id === setId || s.name.toLowerCase() === setId.toLowerCase());
  return group && set ? { group, set } : null;
}

/** A pose by id or name (any case). */
export function poseIn(set: PoseSet, ref: string): Pose | undefined {
  return set.poses.find((p) => p.id === ref) ?? set.poses.find((p) => p.name.toLowerCase() === ref.toLowerCase());
}

function unique(taken: readonly string[], name: string): string {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) if (!used.has(`${name} ${i}`.toLowerCase())) return `${name} ${i}`;
}

/** Can a pose value address this clip — the group itself or anything under it? */
export function poseCanReach(doc: MotionDocument, groupId: string, clipId: string): boolean {
  return clipId === groupId || clipsUnderGroup(doc, groupId).includes(clipId);
}

/** The vocabulary most of these names speak (half or more resolve), or null. */
export function guessVocabulary(names: readonly string[]): string | null {
  if (!names.length) return null;
  let best: { id: string; hits: number } | null = null;
  for (const v of listVocabularies()) {
    const hits = names.filter((n) => canonicalPoseName(v, n) !== null).length;
    if (hits * 2 >= names.length && (!best || hits > best.hits)) best = { id: v.id, hits };
  }
  return best?.id ?? null;
}

export function createPoseSet(
  doc: MotionDocument,
  groupId: string,
  opts: { name?: string; vocabulary?: string | null; blend?: Partial<PoseBlend>; poses?: Array<{ name: string; values?: PoseValue[] }> } = {},
): string | null {
  const g = groupOf(doc, groupId);
  if (!g) return null;
  const sets = (g.poses ??= []);
  const id = createId("poses");
  const poses = (opts.poses ?? []).map((p) => ({ id: createId("pose"), name: p.name, values: (p.values ?? []).filter((v) => poseCanReach(doc, groupId, v.clipId)) }));
  sets.push({
    id,
    name: unique(sets.map((s) => s.name), opts.name?.trim() || "Poses"),
    vocabulary: opts.vocabulary === undefined ? guessVocabulary(poses.map((p) => p.name)) : opts.vocabulary,
    blend: poseBlendSchema.parse(opts.blend ?? {}),
    poses,
    show: "",
  });
  return id;
}

/** A set from a SWITCH: one pose per member, each showing that member (`switch` = its name). */
export function poseSetFromSwitch(doc: MotionDocument, groupId: string, switchId: string, opts: { name?: string; vocabulary?: string | null } = {}): string | null {
  const sw = groupOf(doc, switchId);
  if (!sw?.switch || !poseCanReach(doc, groupId, switchId)) return null;
  const members = switchOptions(doc, switchId);
  const id = createPoseSet(doc, groupId, {
    name: opts.name ?? sw.name,
    vocabulary: opts.vocabulary,
    poses: members.map((m) => ({ name: m.name, values: [{ clipId: switchId, path: "switch", value: m.name }] })),
  });
  // The set is ABOUT this switch: its pictures frame it, new drawings go in it.
  const at = id ? poseSetOf(doc, groupId, id) : null;
  if (at) at.set.part = switchId;
  return id;
}

export function updatePoseSet(
  doc: MotionDocument,
  groupId: string,
  setId: string,
  patch: { name?: string; vocabulary?: string | null; blend?: Partial<PoseBlend>; part?: string | null; transitions?: PoseTransition[] | null },
): boolean {
  const at = poseSetOf(doc, groupId, setId);
  if (!at) return false;
  if (patch.name?.trim()) at.set.name = unique(at.group.poses!.filter((s) => s !== at.set).map((s) => s.name), patch.name.trim());
  if (patch.vocabulary !== undefined) at.set.vocabulary = patch.vocabulary;
  if (patch.blend) at.set.blend = poseBlendSchema.parse({ ...at.set.blend, ...patch.blend });
  if (patch.part !== undefined) {
    if (patch.part === null) delete at.set.part;
    else if (poseCanReach(doc, groupId, patch.part)) at.set.part = patch.part;
  }
  if (patch.transitions !== undefined) {
    if (!patch.transitions?.length) delete at.set.transitions;
    else at.set.transitions = patch.transitions.map((t) => poseTransitionSchema.parse(t));
  }
  return true;
}

/**
 * A POSE FROM ANY LAYER — a drawing, a group, a nested comp, a flipbook, a
 * video: "this is how the part looks in this pose". A layer that is already a
 * drawing of a switch the set chooses becomes that switch's choice; any other
 * layer under the character shows in the new pose ONLY, in place of the
 * part's other looks (the set's subjects are hidden in it and shown again in
 * every other pose). Returns the pose id, or null when the layer is not inside
 * the character (move it in first).
 */
export function addPoseFromLayer(doc: MotionDocument, groupId: string, setId: string, layerId: string, opts: { name?: string } = {}): string | null {
  const at = poseSetOf(doc, groupId, setId);
  const layer = locateClip(doc, layerId);
  if (!at || !layer || !poseCanReach(doc, groupId, layerId)) return null;
  const name = opts.name?.trim() || layer.clip.name || "Pose";
  // 1. A drawing of a switch this set already chooses.
  const switches = new Set(at.set.poses.flatMap((p) => p.values.filter((v) => v.path === "switch").map((v) => v.clipId)));
  if (layer.track.groupId && switches.has(layer.track.groupId)) {
    return addPose(doc, groupId, setId, { name, values: [{ clipId: layer.track.groupId, path: "switch", value: layer.clip.name }] });
  }
  // 2. Any layer: shown in this pose, instead of what the others show.
  const under = (a: string, b: string) => clipsUnderGroup(doc, a).includes(b);
  const looks = poseSetSubjects(doc, groupId, setId).filter((id) => id !== layerId && !under(id, layerId) && !under(layerId, id));
  const opacityOf = (id: string) => {
    const c = locateClip(doc, id)?.clip;
    return c && c.kind !== "audio" ? c.opacity : 1;
  };
  for (const p of at.set.poses) {
    const named = new Set(p.values.filter((v) => v.path === "opacity").map((v) => v.clipId));
    if (!named.has(layerId)) p.values.push({ clipId: layerId, path: "opacity", value: 0 });
    for (const id of looks) if (!named.has(id)) p.values.push({ clipId: id, path: "opacity", value: opacityOf(id) });
  }
  const pose = addPose(doc, groupId, setId, { name, values: [{ clipId: layerId, path: "opacity", value: opacityOf(layerId) || 1 }, ...looks.map((id) => ({ clipId: id, path: "opacity", value: 0 }))] });
  return pose;
}

/** Drop a set, its channel's keys and its driver — nothing is left choosing a pose that is gone. */
export function removePoseSet(doc: MotionDocument, groupId: string, setId: string): boolean {
  const at = poseSetOf(doc, groupId, setId);
  if (!at) return false;
  const path = `pose.${at.set.id}`;
  at.group.poses = at.group.poses!.filter((s) => s !== at.set);
  if (!at.group.poses.length) delete at.group.poses;
  at.group.keyframes = at.group.keyframes.filter((k) => k.property !== path);
  if (at.group.drivers?.[path]) {
    const { [path]: _gone, ...rest } = at.group.drivers;
    at.group.drivers = Object.keys(rest).length ? rest : undefined;
  }
  return true;
}

/**
 * CAPTURE WHAT IT LOOKS LIKE — the values of `targets` (default: every path
 * the set names) as they SHOW at group-local `localMs`, for this set to hold:
 * your own value with every pose on it, less what OTHER sets bring.
 *
 * On a layered path (a bone channel, a shape-key weight) your still tweak
 * moves INTO the pose — `absorb` lists those, for `takeCapture` to reset — so
 * once the captured pose shows, the picture is exactly what you captured, not
 * your tweak twice. A keyed tweak stays yours (you animated it on purpose):
 * the pose takes what is left. `env` is the bake's pose reader (core
 * `poseDriverAt`), so a live set's contribution is counted as it is on screen.
 */
export function captureValues(
  doc: MotionDocument,
  groupId: string,
  set: PoseSet,
  localMs: number,
  targets?: ReadonlyArray<{ clipId: string; path: string }>,
  env: PoseEnv = {},
): PoseValue[] {
  return captureShown(doc, groupId, set, localMs, targets, env).values;
}

interface Capture {
  values: PoseValue[];
  /** Layered paths whose still value moved into the pose (reset to identity when it shows). */
  absorb: Array<{ clipId: string; path: string; identity: number }>;
}

function captureShown(
  doc: MotionDocument,
  groupId: string,
  set: PoseSet,
  localMs: number,
  targets: ReadonlyArray<{ clipId: string; path: string }> | undefined,
  env: PoseEnv,
): Capture {
  const g = groupOf(doc, groupId);
  if (!g) return { values: [], absorb: [] };
  const compMs = g.startMs + localMs;
  const posed = posedPathsAt(doc, compMs, g.frameId, env);
  const list = targets ?? set.poses.flatMap((p) => p.values.map((v) => ({ clipId: v.clipId, path: v.path })));
  const seen = new Set<string>();
  const out: Capture = { values: [], absorb: [] };
  for (const { clipId, path } of list) {
    const k = `${clipId}\u0000${path}`;
    if (seen.has(k) || !poseCanReach(doc, groupId, clipId)) continue;
    seen.add(k);
    const c = locateClip(doc, clipId)?.clip;
    if (!c) continue;
    const own = channelValueAt(c, path, compMs - c.startMs);
    const p = posed.get(k);
    const shown = p ? composePosed(p, own) : own;
    if (shown === undefined) continue;
    const compose = poseComposeOf(path);
    if (compose === "own" || typeof shown !== "number") {
      out.values.push({ clipId, path, value: structuredClone(shown) });
      continue;
    }
    const identity = compose === "add" ? 0 : 1;
    const keyed = c.keyframes.some((t) => t.property === path && !t.range && t.keys.length > 0);
    // The pose holds what shows, less the other sets — and less your layer when it is animated.
    const others = p ? (ownValueShowing({ ...p, sets: p.sets.filter((s) => s.setId !== set.id) }, shown) ?? identity) : shown;
    const mine = keyed && typeof own === "number" ? (compose === "add" ? others - own : own === 0 ? identity : others / own) : others;
    out.values.push({ clipId, path, value: mine });
    if (!keyed && typeof own === "number" && own !== identity) out.absorb.push({ clipId, path, identity });
  }
  return out;
}

/**
 * The captured pose SHOWS from now (the choice the Face pad's click makes),
 * and the still tweaks it absorbed return to rest — together, so the picture
 * does not move. A set something else drives keeps its driver; then nothing is
 * absorbed (the pose may not be what shows).
 */
function takeCapture(doc: MotionDocument, group: GroupClip, set: PoseSet, poseId: string, localMs: number, cap: Capture): void {
  if (group.drivers?.[`pose.${set.id}`]) return;
  keyPose(doc, group.id, set.id, poseId, localMs);
  for (const a of cap.absorb) {
    const c = locateClip(doc, a.clipId)?.clip;
    if (c) writeChannel(c, a.path, group.startMs + localMs - c.startMs, a.identity);
  }
}

/**
 * THE PARTS A SET CHANGES — what to look at to tell its poses apart: every
 * layer a pose writes (a switch, a lid, a shape-keyed mouth) and every piece
 * that moves with a bone a pose turns, the bones below it included (a wave
 * turns the upper arm; the forearm and the hand go with it). What a pose
 * tile frames, so Open and Closed eyes are eyes, not a character two pixels
 * tall. Ids are binding units (a switch, not its drawings).
 */
export function poseSetSubjects(doc: MotionDocument, groupId: string, setId: string): string[] {
  const at = poseSetOf(doc, groupId, setId);
  if (!at) return [];
  // The set says what it is about: that part, framed alone.
  if (at.set.part && locateClip(doc, at.set.part)) return [at.set.part];
  const out = new Set<string>();
  const turned = new Map<string, Set<string>>(); // rig id → bones a pose moves
  for (const p of at.set.poses)
    for (const v of p.values) {
      const bone = BONE_PATH.exec(v.path);
      const c = locateClip(doc, v.clipId)?.clip;
      if (bone && c?.kind === "group" && c.rig) {
        let s = turned.get(c.id);
        if (!s) turned.set(c.id, (s = new Set()));
        s.add(bone[1]!);
      } else if (v.clipId !== groupId) out.add(v.clipId);
    }
  for (const [rigId, bones] of turned) {
    const rig = locateClip(doc, rigId)?.clip;
    if (rig?.kind !== "group" || !rig.rig) continue;
    // Everything hanging below a moved bone moves too.
    for (let grew = true; grew; ) {
      grew = false;
      for (const b of rig.rig.bones) if (b.parent && bones.has(b.parent) && !bones.has(b.id)) (bones.add(b.id), (grew = true));
    }
    const pose = evaluateRig(rig.rig, { planar: rigIsPlanar(doc, rig) });
    for (const id of clipsUnderGroup(doc, rigId)) {
      const m = memberOf(doc, id);
      if (!m || m.rig.id !== rigId || m.unit.id !== id) continue;
      const d = decide2d(doc, m, pose);
      if ((d.kind === "rigid" && d.bone && bones.has(d.bone)) || (d.kind === "smooth" && d.made?.some((b) => bones.has(b)))) out.add(id);
    }
  }
  return [...out];
}

/**
 * POSE A BONE AS YOU SEE IT. `items` are values the channels should SHOW —
 * what a drag measures from the bones on screen, or what an agent asks for —
 * and this returns what YOUR layer needs once the poses on top are counted, for
 * `poseBones` or a take. Without that, a drag over a waving arm wrote the wave
 * into your layer and the pose added it again. `posed` is `posedPathsAt` for
 * the instant: walk it once per gesture — what the poses bring cannot change
 * while time stands still.
 */
export function beneathPoses<T extends { bone: string; values: Partial<Record<BoneChannel, number>> }>(
  posed: ReadonlyMap<string, PosedPath>,
  groupId: string,
  items: readonly T[],
): T[] {
  if (!posed.size) return items.slice();
  return items.map((it) => {
    const values: Partial<Record<BoneChannel, number>> = {};
    for (const [ch, v] of Object.entries(it.values) as Array<[BoneChannel, number | undefined]>) {
      if (typeof v !== "number") continue;
      const p = posed.get(`${groupId}\u0000bone.${it.bone}.${ch}`);
      values[ch] = p ? (ownValueShowing(p, v) ?? v) : v;
    }
    return { ...it, values };
  });
}

/** Add a pose — given values, or captured (`capture`, group-local ms) from what the set's parts show, which it then shows. */
export function addPose(
  doc: MotionDocument,
  groupId: string,
  setId: string,
  opts: { name?: string; values?: PoseValue[]; capture?: { atMs: number; targets?: Array<{ clipId: string; path: string }> }; env?: PoseEnv } = {},
): string | null {
  const at = poseSetOf(doc, groupId, setId);
  if (!at) return null;
  const cap = opts.capture ? captureShown(doc, groupId, at.set, opts.capture.atMs, opts.capture.targets, opts.env ?? {}) : null;
  const values = cap ? cap.values : (opts.values ?? []).filter((v) => poseCanReach(doc, groupId, v.clipId));
  const id = createId("pose");
  at.set.poses.push({ id, name: unique(at.set.poses.map((p) => p.name), opts.name?.trim() || "Pose"), values });
  if (cap && opts.capture) takeCapture(doc, at.group, at.set, id, opts.capture.atMs, cap);
  return id;
}

/**
 * Change a pose: rename, replace its values, upsert some (`set`), drop some
 * (`unset`), or re-capture every value it holds (`capture`, group-local ms —
 * the Face pad's "Update from current").
 */
export function updatePose(
  doc: MotionDocument,
  groupId: string,
  setId: string,
  poseRef: string,
  patch: { name?: string; values?: PoseValue[]; set?: PoseValue[]; unset?: Array<{ clipId: string; path: string }>; capture?: { atMs: number }; env?: PoseEnv },
): boolean {
  const at = poseSetOf(doc, groupId, setId);
  const pose = at && poseIn(at.set, poseRef);
  if (!at || !pose) return false;
  if (patch.name?.trim()) pose.name = unique(at.set.poses.filter((p) => p !== pose).map((p) => p.name), patch.name.trim());
  if (patch.values) pose.values = patch.values.filter((v) => poseCanReach(doc, groupId, v.clipId));
  for (const v of patch.set ?? []) {
    if (!poseCanReach(doc, groupId, v.clipId)) continue;
    const i = pose.values.findIndex((x) => x.clipId === v.clipId && x.path === v.path);
    if (i >= 0) pose.values[i] = v;
    else pose.values.push(v);
  }
  if (patch.unset?.length) pose.values = pose.values.filter((v) => !patch.unset!.some((u) => u.clipId === v.clipId && u.path === v.path));
  if (patch.capture) {
    const cap = captureShown(doc, groupId, at.set, patch.capture.atMs, pose.values.length ? pose.values : undefined, patch.env ?? {});
    pose.values = cap.values;
    takeCapture(doc, at.group, at.set, pose.id, patch.capture.atMs, cap);
  }
  return true;
}

export function duplicatePose(doc: MotionDocument, groupId: string, setId: string, poseRef: string): string | null {
  const at = poseSetOf(doc, groupId, setId);
  const pose = at && poseIn(at.set, poseRef);
  if (!at || !pose) return null;
  const id = createId("pose");
  at.set.poses.splice(at.set.poses.indexOf(pose) + 1, 0, { id, name: unique(at.set.poses.map((p) => p.name), pose.name), values: JSON.parse(JSON.stringify(pose.values)) as PoseValue[] });
  return id;
}

/**
 * THE DRAWING A POSE SHOWS — the layer you edit to change how that pose
 * LOOKS (not where the part stands): a swap pose's member (`switch` on its
 * switch group). Null for a pose that only moves bones or morphs keys — those
 * are edited by posing and Update from current.
 */
export function poseDrawingOf(doc: MotionDocument, groupId: string, setId: string, poseRef: string): { switchId: string; memberId: string } | null {
  const at = poseSetOf(doc, groupId, setId);
  const pose = at && poseIn(at.set, poseRef);
  const v = pose?.values.find((x) => x.path === "switch" && typeof x.value === "string");
  if (!v) return null;
  // A switch names its member by id or by name — the switch's own rule.
  const member = switchOptions(doc, v.clipId).find((c) => c.id === v.value || c.name === v.value);
  return member ? { switchId: v.clipId, memberId: member.id } : null;
}

/**
 * A NEW DRAWING FROM A POSE — its member copied into the same switch (beside
 * it, ids fresh) and a new pose that shows the copy, everything else the
 * same. What you do before redrawing a pose you want to keep: the original
 * stays what it was, everywhere it is used. Returns the new pose and layer.
 */
export function duplicatePoseDrawing(doc: MotionDocument, groupId: string, setId: string, poseRef: string): { poseId: string; memberId: string } | null {
  const drawing = poseDrawingOf(doc, groupId, setId, poseRef);
  const at = poseSetOf(doc, groupId, setId);
  const pose = at && poseIn(at.set, poseRef);
  const src = drawing && locateClip(doc, drawing.memberId);
  if (!at || !pose || !drawing || !src) return null;
  // ⌘D's own op: a fresh lane beside it, in the same switch, its insides with it.
  const memberId = duplicateClips(doc, [drawing.memberId]).tops[0];
  if (!memberId) return null;
  const poseId = duplicatePose(doc, groupId, setId, pose.id);
  const copy = poseId ? at.set.poses.find((p) => p.id === poseId) : undefined;
  if (!poseId || !copy) return null;
  for (const v of copy.values) if (v.path === "switch" && v.clipId === drawing.switchId) v.value = memberId;
  const clip = locateClip(doc, memberId)?.clip;
  if (clip) clip.name = `${src.clip.name} ${copy.name.replace(pose.name, "").trim() || "copy"}`.trim();
  return { poseId, memberId };
}

/**
 * ANY LAYER BECOMES A PART — a tail, ears, a cape: a pose set named for the
 * layer, framed on it (`part`), with one pose, Rest, holding nothing (the
 * layer as it is). Pose it (bones, keys, values) and Add pose → From now.
 */
export function poseSetFromLayer(doc: MotionDocument, groupId: string, layerId: string): string | null {
  const layer = locateClip(doc, layerId)?.clip;
  if (!layer || !poseCanReach(doc, groupId, layerId)) return null;
  const id = createPoseSet(doc, groupId, { name: layer.name || "Part", vocabulary: null, poses: [{ name: "Rest", values: [] }] });
  const at = id ? poseSetOf(doc, groupId, id) : null;
  if (at) at.set.part = layerId;
  return id;
}

export function removePose(doc: MotionDocument, groupId: string, setId: string, poseRef: string): boolean {
  const at = poseSetOf(doc, groupId, setId);
  const pose = at && poseIn(at.set, poseRef);
  if (!at || !pose) return false;
  at.set.poses = at.set.poses.filter((p) => p !== pose);
  return true;
}

/** Order the poses by these ids (unnamed ones keep their order, after). */
export function reorderPoses(doc: MotionDocument, groupId: string, setId: string, ids: readonly string[]): boolean {
  const at = poseSetOf(doc, groupId, setId);
  if (!at) return false;
  const rank = (p: Pose) => {
    const i = ids.indexOf(p.id);
    return i < 0 ? ids.length + at.set.poses.indexOf(p) : i;
  };
  at.set.poses = [...at.set.poses].sort((a, b) => rank(a) - rank(b));
  return true;
}

/**
 * Show a pose from group-local `localMs`: a key on `pose.<set>` where the
 * channel is keyed or `key` (record mode), its resting choice otherwise —
 * the switch rule. Written as the pose's NAME.
 */
export function keyPose(doc: MotionDocument, groupId: string, setId: string, poseRef: string, localMs: number, opts: { key?: boolean } = {}): boolean {
  const at = poseSetOf(doc, groupId, setId);
  const pose = at && poseIn(at.set, poseRef);
  if (!at || !pose) return false;
  writeChannel(at.group, `pose.${at.set.id}`, localMs, pose.name, { forceKey: opts.key });
  return true;
}

/**
 * RETIME A POSE BLOCK — move the key at group-local `fromMs` to `toMs`,
 * between its neighbours (a frame clear of each, so a drag can never stack
 * two keys or swap their order). Returns where it landed, or null when there
 * is no key there. The timeline's block drag and the agent verb share it.
 */
export function movePoseKey(doc: MotionDocument, groupId: string, setId: string, fromMs: number, toMs: number): number | null {
  const at = poseSetOf(doc, groupId, setId);
  const track = at?.group.keyframes.find((k) => k.property === `pose.${at.set.id}` && !k.range);
  const key = track?.keys.find((k) => Math.abs(k.timeMs - fromMs) < 0.5);
  if (!at || !track || !key) return null;
  const step = frameStepMs(compFps(doc, at.group.frameId));
  const sorted = [...track.keys].sort((a, b) => a.timeMs - b.timeMs);
  const i = sorted.indexOf(key);
  const lo = i > 0 ? sorted[i - 1]!.timeMs + step : -Infinity;
  const hi = i + 1 < sorted.length ? sorted[i + 1]!.timeMs - step : Infinity;
  key.timeMs = Math.round(Math.min(hi, Math.max(lo, toMs)) * 1000) / 1000;
  return key.timeMs;
}

/**
 * Remove the pose key at group-local `atMs`: the block before it runs on (the
 * timeline's Delete). The last key leaves the set at that key's pose, as its
 * resting choice — removing a block never makes the part jump to the top pose.
 */
export function removePoseKey(doc: MotionDocument, groupId: string, setId: string, atMs: number): boolean {
  const at = poseSetOf(doc, groupId, setId);
  const path = at ? `pose.${at.set.id}` : "";
  const track = at?.group.keyframes.find((k) => k.property === path && !k.range);
  const key = track?.keys.find((k) => Math.abs(k.timeMs - atMs) < 0.5);
  if (!at || !track || !key) return false;
  track.keys = track.keys.filter((k) => k !== key);
  if (!track.keys.length) {
    at.group.keyframes = at.group.keyframes.filter((k) => k !== track);
    if (typeof key.value === "string") at.set.show = key.value;
  }
  return true;
}

/**
 * BAKE TO KEYS — the set's channel as it is chosen now (an expression, lip
 * sync, a machine) becomes `pose.<set>` keys over comp `[fromMs, toMs]`, one
 * per change on the comp's frame grid, and the driver is dropped: hand edits
 * happen on keys, in the dope sheet (Moho's bake). Keys already in the range
 * are replaced. Returns the number of keys written.
 */
export function bakePoseSet(doc: MotionDocument, groupId: string, setId: string, range: { fromMs: number; toMs: number }, env: PoseEnv = {}): number {
  const at = poseSetOf(doc, groupId, setId);
  if (!at || !at.set.poses.length) return 0;
  const { group, set } = at;
  const path = `pose.${set.id}`;
  const step = frameStepMs(compFps(doc, group.frameId));
  const from = Math.max(group.startMs, range.fromMs);
  const to = Math.min(group.startMs + group.durationMs, range.toMs);
  const changes: Array<{ localMs: number; name: string }> = [];
  for (let i = 0; ; i++) {
    const t = from + i * step;
    if (t > to + 1e-6) break;
    const name = resolvePose(set, poseChannelAt(doc, group, set, t, env))?.name ?? "";
    if (!changes.length || changes[changes.length - 1]!.name !== name) changes.push({ localMs: Math.round((t - group.startMs) * 1000) / 1000, name });
  }
  if (group.drivers?.[path]) {
    const { [path]: _gone, ...rest } = group.drivers;
    group.drivers = Object.keys(rest).length ? rest : undefined;
  }
  // The behaviors on the set stand down (kept in the stack, switched off), so
  // the keys you now own are what shows — switch one back on to go live again.
  if (group.behaviors?.length) group.behaviors = group.behaviors.map((b) => (drivesSet(b, set, doc) ? { ...b, enabled: false } : b));
  const lo = from - group.startMs - 0.5;
  const hi = to - group.startMs + 0.5;
  for (const track of group.keyframes) if (track.property === path && !track.range) track.keys = track.keys.filter((k) => k.timeMs < lo || k.timeMs > hi);
  for (const c of changes) writeChannel(group, path, c.localMs, c.name, { forceKey: true });
  return changes.length;
}

// ── Mirror ───────────────────────────────────────────────────────────────────

/** Clip channels whose sign is a side: a change of these is reflected, not copied. */
const REFLECTED = new Set(["x", "rotation", "skewX"]);

/**
 * MIRROR A POSE (Blender's paste flipped): every value lands on the other
 * side's part — a clip by `mirrorName`, a bone by its pair — reflected where a
 * side has a sign (a bone through `mirroredValues`, the rig's own rule; a
 * clip's x / rotation as the opposite change from its own rest), copied
 * otherwise. A centre part mirrors onto itself. The result is the pose named
 * as the mirror (vocabulary, then sides), replaced if it exists.
 */
export function mirrorPoseInSet(doc: MotionDocument, groupId: string, setId: string, poseRef: string): string | null {
  const at = poseSetOf(doc, groupId, setId);
  const pose = at && poseIn(at.set, poseRef);
  if (!at || !pose) return null;
  const under = [at.group.id, ...clipsUnderGroup(doc, groupId)];
  const clips = under.map((id) => locateClip(doc, id)?.clip).filter((c): c is NonNullable<typeof c> => !!c);
  const byName = new Map(clips.map((c) => [c.name, c]));
  const otherClip = (id: string) => {
    const c = clips.find((x) => x.id === id);
    if (!c) return null;
    const m = mirrorName(c.name);
    return m !== c.name ? (byName.get(m) ?? c) : c;
  };
  const out: PoseValue[] = [];
  // Bones: grouped per bone, mirrored through the rig's own rule.
  const rig = at.group.rig;
  const planar = rig ? rigIsPlanar(doc, at.group) : true;
  const frames = rig ? restFrames(rig, planar) : new Map();
  const boneVals = new Map<string, Map<BoneChannel, number>>();
  for (const v of pose.values) {
    const m = v.clipId === at.group.id ? BONE_PATH.exec(v.path) : null;
    if (m && rig && typeof v.value === "number") {
      let map = boneVals.get(m[1]!);
      if (!map) boneVals.set(m[1]!, (map = new Map()));
      map.set(m[2] as BoneChannel, v.value);
      continue;
    }
    const dst = otherClip(v.clipId);
    if (!dst) continue;
    const src = clips.find((c) => c.id === v.clipId)!;
    let value: KeyframeValue = structuredClone(v.value);
    if (REFLECTED.has(v.path) && typeof v.value === "number") {
      const baseSrc = getClipProperty(src, v.path);
      const baseDst = getClipProperty(dst, v.path);
      if (typeof baseSrc === "number" && typeof baseDst === "number") value = baseDst - (v.value - baseSrc);
    } else if (v.path === "switch" && typeof v.value === "string" && dst.kind === "group") {
      const m = mirrorName(v.value);
      if (m !== v.value && switchOptions(doc, dst.id).some((o) => o.name === m)) value = m;
    }
    out.push({ clipId: dst.id, path: v.path, value });
  }
  if (rig) {
    for (const [boneId, chans] of boneVals) {
      const srcBone = rig.bones.find((b) => b.id === boneId);
      if (!srcBone) continue;
      const dstBone = pairOf(rig, boneId) ?? srcBone;
      const probe: Bone = { ...srcBone, pose: { x: chans.get("x") ?? 0, y: chans.get("y") ?? 0, z: chans.get("z"), rotation: chans.get("rotation") ?? 0, rotationX: chans.get("rotationX"), rotationY: chans.get("rotationY"), scale: chans.get("scale") ?? 1, scaleY: chans.get("scaleY") ?? null, scaleZ: chans.get("scaleZ") ?? null } };
      const mirrored = mirroredValues(probe, dstBone, frames, planar);
      for (const ch of chans.keys()) {
        const value = ch === "ik" ? chans.get("ik")! : mirrored[ch];
        if (typeof value === "number") out.push({ clipId: at.group.id, path: `bone.${dstBone.id}.${ch}`, value });
      }
    }
  }
  const name = mirrorPoseName(at.set.vocabulary, pose.name) ?? (mirrorName(pose.name) !== pose.name ? mirrorName(pose.name) : `${pose.name} mirrored`);
  const existing = poseIn(at.set, name);
  if (existing && existing !== pose) {
    existing.values = out;
    return existing.id;
  }
  const id = createId("pose");
  at.set.poses.splice(at.set.poses.indexOf(pose) + 1, 0, { id, name: unique(at.set.poses.map((p) => p.name), name), values: out });
  return id;
}
