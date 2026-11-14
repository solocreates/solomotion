import type { MotionDocument, Clip, GroupClip } from "../schema";
import { parseFxToken } from "../schema";
import { expressionById } from "../expressions/document";
import { VISEME_ORDER } from "@solomotion/lipsync";
import { lipSyncSource, voiceClipsIn } from "../speech/bind";
import { findInputDef, inputDefsOf } from "../components/inputs";
import { hashU32 } from "../animation/temporal";
import { detectParts, type Box, type PartMap, type PartMatch, type PartOverrides } from "./parts";

/**
 * BRING TO LIFE — "Make character" as data (ADR-characters rule 1, ux.md §1.2).
 *
 * `planBringToLife` turns a detected `PartMap` into an ordered list of plain
 * registry calls — `{verb, input}` — that `character.bringToLife` runs as ONE
 * undo step. The same list prints as a script (`printPlan`): the vibe-coding
 * face of the same thing, and what an agent reads to see what would happen.
 *
 * What it builds, from what was found — each life a BEHAVIOR in the
 * character's stack (Characters 3.0), listed, tunable and deletable; `false`
 * removes one that is on:
 *
 *  - the group becomes a RIG (no bones — the Character tab's subject);
 *  - pose sets: Mouth (visemes), Eyes (Open/Closed — a switch's drawings, a
 *    lid's opacity, or the eye squashed), Brows, Hands;
 *  - Blink: one Blink behavior on the Eyes, so both eyes shut together;
 *  - Talk: a Lip sync behavior on the Mouth — it speaks with whichever voice
 *    plays (an instance hears its `Voice` input, set in the outer comp);
 *  - Breathe: a Breathe behavior on the torso bone's stretch, else the torso
 *    layer from its bottom edge;
 *  - Nod: Nod with voice on the head;
 *  - Look (off by default): pupil pads that look at a Look control, and a
 *    Glance behavior that looks around through it.
 *
 * Idempotent by derivation, not bookkeeping: every step is planned only when
 * the document does not already show it (a set of that vocabulary, a behavior
 * of that kind, a bone of that name), so running twice plans nothing. Deterministic: ids are derived, refs are `$<n>.<path>`
 * into earlier results (the `api.batch` convention).
 */

export const LIFE_BEHAVIORS = ["blink", "breathe", "nod", "look", "talk"] as const;
export type LifeBehavior = (typeof LIFE_BEHAVIORS)[number];

export interface AliveOptions {
  /** true: make sure it is on; false: make sure it is off; absent: the default (all on but Look). */
  blink?: boolean;
  breathe?: boolean;
  nod?: boolean;
  look?: boolean;
  talk?: boolean;
  /** The voice clip (id). Absent: the one already bound, else an audio clip overlapping the character. Null: none. */
  voice?: string | null;
  /** Seconds between blinks, on average. */
  blinkEvery?: number;
  overrides?: PartOverrides;
}

export interface PlanStep {
  verb: string;
  input: Record<string, unknown>;
  /** What it is for, in a few words — the script's comment. */
  why: string;
}

export interface LifeState {
  /** On after the plan runs. */
  on: boolean;
  /** Why it cannot be on, when it cannot. */
  missing?: string;
}

export interface AlivePlan {
  targetId: string;
  parts: PartMap;
  steps: PlanStep[];
  life: Record<LifeBehavior, LifeState>;
  /** The voice the mouth follows after the plan, by name. */
  voice: string | null;
}

const DEFAULTS: Record<LifeBehavior, boolean> = { blink: true, breathe: true, nod: true, look: false, talk: true };
const BREATHE_ID = "alive-breathe";
const BREATHE_Y_ID = "alive-breathe-y";
const LOOK_BONES = ["Pupil.L", "Pupil.R", "Look", "Look.L", "Look.R"] as const;
/** Where the eyes hang, in order of preference: the head, else what carries it. */
const EYE_ANCHORS = [/^head$/i, /^neck$/i, /^(body|torso|spine|chest)$/i, /^(root|hips|pelvis)$/i];

const allClips = (doc: MotionDocument) => doc.tracks.flatMap((t) => t.clips);
const clipOf = (doc: MotionDocument, id: string) => allClips(doc).find((c) => c.id === id) ?? null;
const sourceOfDriver = (doc: MotionDocument, clip: Clip | null, path: string): string | null => {
  const id = parseFxToken(clip?.drivers?.[path]);
  return id ? (expressionById(doc, id)?.source ?? null) : clip?.drivers?.[path] ? "(driven)" : null;
};
const keyed = (clip: Clip | null, path: string) => !!clip && clip.kind !== "audio" && clip.keyframes.some((k) => k.property === path && k.keys.length > 0);
const r1 = (v: number) => Math.round(v * 10) / 10;
const cxOf = (b: Box) => (b.minX + b.maxX) / 2;
const cyOf = (b: Box) => (b.minY + b.maxY) / 2;

/** The comp-level layers of a comp that are on its root (not inside a group). */
function topLevelOf(doc: MotionDocument, frameId: string): Clip[] {
  return doc.tracks.filter((t) => !t.groupId).flatMap((t) => t.clips).filter((c) => c.frameId === frameId && c.kind !== "audio");
}

/**
 * Plan "Make character" for `targetId` (a group or a component instance).
 * Null when it is neither. `parts` may be passed (the sheet's corrected map).
 */
export function planBringToLife(doc: MotionDocument, targetId: string, options: AliveOptions = {}, given?: PartMap): AlivePlan | null {
  const parts = given ?? detectParts(doc, targetId, { overrides: options.overrides });
  if (!parts) return null;
  const P = parts.parts;
  const steps: PlanStep[] = [];
  const push = (verb: string, input: Record<string, unknown>, why: string) => steps.push({ verb, input, why }) - 1;
  const want = (b: LifeBehavior) => options[b] ?? DEFAULTS[b];
  const life = {} as Record<LifeBehavior, LifeState>;

  // ── The character group (G) ────────────────────────────────────────────────
  const instance = parts.root.kind === "instance" ? clipOf(doc, parts.root.instanceId) : null;
  let G: string;
  let group: GroupClip | null = null;
  if (parts.root.kind === "group") {
    G = parts.root.groupId;
    group = clipOf(doc, G) as GroupClip;
  } else {
    const top = topLevelOf(doc, parts.root.frameId);
    const only = top.length === 1 && top[0]!.kind === "group" ? (top[0] as GroupClip) : null;
    if (only) {
      G = only.id;
      group = only;
    } else {
      const name = doc.frames.find((f) => f.id === parts.frameId)?.name ?? "Character";
      G = `$${push("rig.create", { frameId: parts.frameId, ids: top.map((c) => c.id), name }, "one group for the character")}.rigId`;
    }
  }
  if (group && !group.rig && !group.layout) push("rig.create", { ids: [G] }, "the group is the character");
  const sets = group?.poses ?? [];
  const setPath = (vocab: string, name?: string) => {
    const s = sets.find((x) => x.vocabulary === vocab && (!name || x.name.toLowerCase() === name.toLowerCase()));
    return s ? `pose.${s.id}` : null;
  };
  /** A set's id from its path (`pose.<id>`), or the plan ref of the set a step makes. */
  const setIdOf = (path: string) => (path.startsWith("$") ? path.replace(/\.path$/, ".setId") : path.slice("pose.".length));
  const behaviors = group?.behaviors ?? [];
  const behaviorOf = (type: string) => behaviors.find((b) => b.type === type) ?? null;
  const gDriver = (path: string | null) => (path && !path.startsWith("$") ? sourceOfDriver(doc, group, path) : null);

  /** Make a part with named members a switch (in place) when it is a plain group. */
  const asSwitch = (m: PartMatch) => {
    if (!m.isSwitch) push("switch.create", { ids: [m.clipId] }, `${m.name} shows one shape at a time`);
  };
  /** A pose set from what each part's members are, canonical names in the vocabulary's order. */
  const poseSet = (name: string, vocabulary: string, order: readonly string[], from: Array<{ m: PartMatch; path: string; value: (pose: string, member: string) => unknown }>, blendMs?: number) => {
    const poses: Array<{ name: string; values: Array<{ clipId: string; path: string; value: unknown }> }> = [];
    for (const pose of order) {
      const values = from.flatMap(({ m, path, value }) => {
        const member = m.members?.find((x) => x.pose === pose);
        return member ? [{ clipId: m.clipId, path, value: value(pose, member.name) }] : [];
      });
      if (values.length) poses.push({ name: pose, values });
    }
    if (poses.length < 2) return null;
    // One part (a mouth switch): the set is about it, so its pictures frame it.
    const part = from.length === 1 ? from[0]!.m.clipId : undefined;
    return `$${push("poses.create", { groupId: G, name, vocabulary, poses, ...(blendMs !== undefined && { blend: { ms: blendMs } }), ...(part && { part }) }, `${name} poses`)}.path`;
  };

  // ── Voice ──────────────────────────────────────────────────────────────────
  const outerComp = instance ? instance.frameId : parts.frameId;
  const span = instance ?? group;
  const mouth = P.mouth?.members?.length ? P.mouth : null;
  let mouthPath = setPath("visemes");
  const bound = gDriver(mouthPath);
  const boundVoice = bound ? /lipsync\((?:"((?:[^"\\]|\\.)*)"|input)/.exec(bound) : null;
  let voice: Clip | null = null;
  if (options.voice) voice = clipOf(doc, options.voice);
  else if (options.voice === undefined && !boundVoice) {
    voice = voiceClipsIn(doc, outerComp).find((c) => !span || (c.startMs < span.startMs + span.durationMs && c.startMs + c.durationMs > span.startMs)) ?? null;
  }
  const voiceName = voice?.name ?? (boundVoice?.[1] !== undefined ? JSON.parse(`"${boundVoice[1]}"`) as string : instance && boundVoice ? "input" : null);
  const say = (fn: "lipsync" | "loudness") => {
    const src = instance ? lipSyncSource({ input: "Voice" }) : voiceName ? lipSyncSource({ layer: voiceName }) : null;
    return src && fn === "loudness" ? src.replace(/^lipsync/, "loudness") : src;
  };

  // ── Mouth + Talk ─────────────────────────────────────────────────────────
  if (!mouthPath && mouth) {
    asSwitch(mouth);
    mouthPath = poseSet("Mouth", "visemes", VISEME_ORDER, [{ m: mouth, path: "switch", value: (_, member) => member }]);
  }
  const lip = behaviorOf("lipSync");
  const talkOn = !!lip || !!boundVoice;
  if (!want("talk")) {
    if (lip) push("behaviors.remove", { groupId: G, id: lip.id }, "stop following the voice");
    if (boundVoice) push("expression.set", { id: G, property: mouthPath!, source: null }, "stop following the voice");
    life.talk = { on: false };
  } else if (talkOn && options.voice === undefined) life.talk = { on: true };
  else if (!mouthPath) life.talk = { on: false, missing: P.mouth ? "One mouth drawing — add its shapes" : "No mouth found" };
  else {
    if (instance && voice) {
      if (!findInputDef(inputDefsOf(doc, parts.frameId), "Voice")) push("component.inputs", { action: "define", frameId: parts.frameId, def: { name: "Voice", type: "layer" } }, "a Voice input on the character");
      push("layer.set", { ids: [instance.id], values: { "input.Voice": voice.name }, mode: "base" }, "this instance's voice");
    }
    // One voice named only when asked for; otherwise it speaks with whichever plays.
    const named = options.voice && voice && !instance ? voice.name : "";
    if (lip) push("behaviors.update", { groupId: G, id: lip.id, fields: { voice: named } }, "the mouth follows the voice");
    else push("behaviors.add", { groupId: G, type: "lipSync", set: setIdOf(mouthPath), fields: { voice: named } }, "the mouth follows whichever voice plays");
    life.talk = { on: true };
  }

  // ── Eyes + Blink ─────────────────────────────────────────────────────────
  let eyesPath = setPath("eyes");
  const eyes = (["L", "R"] as const).map((s) => ({ s, eye: P[`eye.${s}`], lid: P[`lid.${s}`] })).filter((e) => e.eye || e.lid);
  if (!eyesPath && eyes.length && want("blink")) {
    const from: Array<{ m: PartMatch; path: string; value: (pose: string, member: string) => unknown }> = [];
    for (const { eye, lid } of eyes) {
      // A lid alone (a flat picture's drawn lids) blinks too.
      const states = eye?.members?.map((m) => m.pose) ?? [];
      if (eye && states.includes("Open") && (states.includes("Closed") || states.includes("Half"))) {
        asSwitch(eye);
        // Open, Half and Closed when drawn: a blink passes through the lids halfway, down and back up.
        const closed = states.includes("Closed") ? "Closed" : "Half";
        const keep = (p: string) => p === "Open" || p === closed || (p === "Half" && closed === "Closed");
        from.push({ m: { ...eye, members: eye.members!.filter((x) => keep(x.pose)).map((x) => ({ ...x, pose: x.pose === closed ? "Closed" : x.pose })) }, path: "switch", value: (_, member) => member });
      } else if (lid) {
        from.push({ m: { ...lid, members: [{ clipId: lid.clipId, name: lid.name, pose: "Open" }, { clipId: lid.clipId, name: lid.name, pose: "Closed" }] }, path: "opacity", value: (pose) => (pose === "Closed" ? 1 : 0) });
      } else if (eye) {
        const c = clipOf(doc, eye.clipId);
        const base = c && c.kind !== "audio" ? (c.transform.scaleY ?? c.transform.scale) : 1;
        from.push({ m: { ...eye, members: [{ clipId: eye.clipId, name: eye.name, pose: "Open" }, { clipId: eye.clipId, name: eye.name, pose: "Closed" }] }, path: "scaleY", value: (pose) => (pose === "Closed" ? Math.round(base * 0.1 * 1000) / 1000 : base) });
      }
    }
    eyesPath = poseSet("Eyes", "eyes", ["Open", "Half", "Closed"], from, 40);
  }
  const blinkSrc = gDriver(eyesPath);
  const legacyBlink = !!blinkSrc && /\bblink\(/.test(blinkSrc);
  const blinker = behaviorOf("blink");
  const blinkOn = !!blinker || legacyBlink;
  if (!want("blink")) {
    if (blinker) push("behaviors.remove", { groupId: G, id: blinker.id }, "stop blinking");
    if (legacyBlink) push("expression.set", { id: G, property: eyesPath!, source: null }, "stop blinking");
    life.blink = { on: false };
  } else if (blinkOn) life.blink = { on: true };
  else if (!eyesPath) life.blink = { on: false, missing: "No eyes found" };
  else if (blinkSrc) life.blink = { on: false, missing: "The eyes are driven by something else" };
  else {
    // A behavior, not a lock: between blinks the eyes show whatever you pick — Angry blinks as Angry.
    push("behaviors.add", { groupId: G, type: "blink", set: setIdOf(eyesPath), fields: { every: options.blinkEvery ?? 4 } }, "blink — both eyes, one rhythm");
    life.blink = { on: true };
  }

  // ── Brows, hands: their own poses when they have them ─────────────────────
  if (!setPath("brows")) {
    const brows = (["L", "R"] as const).map((s) => P[`brow.${s}`]).filter((m): m is PartMatch => !!m?.members?.length);
    if (brows.length) {
      brows.forEach(asSwitch);
      poseSet("Brows", "brows", ["Neutral", "Raised", "Lowered", "Angry", "Sad", "Skeptical"], brows.map((m) => ({ m, path: "switch", value: (_: string, member: string) => member })));
    }
  }
  for (const s of ["L", "R"] as const) {
    const hand = P[`hand.${s}`];
    const name = s === "L" ? "Left hand" : "Right hand";
    if (!hand?.members?.length || setPath("hands", name)) continue;
    asSwitch(hand);
    poseSet(name, "hands", ["Relaxed", "Open", "Fist", "Point", "Thumb", "Peace", "Wave"], [{ m: hand, path: "switch", value: (_, member) => member }]);
  }

  // ── Breathe ──────────────────────────────────────────────────────────────
  const torso = P.torso ?? null;
  const breather = torso ? clipOf(doc, torso.clipId) : group;
  const breatherId = torso?.clipId ?? G;
  const legacyBreath = !!breather && breather.kind !== "audio" && !!breather.modulators?.some((m) => m.id === BREATHE_ID);
  const breath = behaviorOf("breathe");
  if (!want("breathe")) {
    if (breath) push("behaviors.remove", { groupId: G, id: breath.id }, "stop breathing");
    if (legacyBreath) push("layer.patch", { id: breatherId, ops: [{ op: "remove", path: `modulators[id=${BREATHE_ID}]` }, { op: "remove", path: `modulators[id=${BREATHE_Y_ID}]` }] }, "stop breathing");
    life.breathe = { on: false };
  } else if (breath || legacyBreath) life.breathe = { on: true };
  else {
    // A torso bone breathes as a stretch along it (from the hips up); without
    // one, the torso layer breathes up from its bottom edge.
    const torsoBone = (group?.rig?.bones ?? []).find((b) => /^(chest|torso|spine|body)/i.test(b.name));
    const fields: Record<string, unknown> = torsoBone ? { channel: `bone.${torsoBone.id}.scale` } : { layer: breatherId === G ? "" : breatherId, channel: "scaleY" };
    push("behaviors.add", { groupId: G, type: "breathe", fields: { ...fields, amount: 1.2, rate: 16 } }, "a slow breath");
    life.breathe = { on: true };
  }

  // ── Nod ──────────────────────────────────────────────────────────────────
  const head = P.head ? clipOf(doc, P.head.clipId) : null;
  const nodder = head?.kind === "group" ? head : parts.figure === "face" ? group : null;
  const nodderId = head?.kind === "group" ? head.id : parts.figure === "face" ? G : null;
  const nodSrc = nodder ? sourceOfDriver(doc, nodder, "rotation") : null;
  const legacyNod = !!nodSrc && /\bloudness\(/.test(nodSrc);
  const nodB = behaviorOf("nod");
  const headBone = (group?.rig?.bones ?? []).find((b) => /^(head|neck)$/i.test(b.name));
  if (!want("nod")) {
    if (nodB) push("behaviors.remove", { groupId: G, id: nodB.id }, "stop nodding");
    if (legacyNod) push("expression.set", { id: nodderId!, property: "rotation", source: null }, "stop nodding");
    life.nod = { on: false };
  } else if (nodB || legacyNod) life.nod = { on: true };
  else if (!nodderId && !headBone) life.nod = { on: false, missing: P.head ? "Group the head with its face to nod" : "No head found" };
  else if (!life.talk.on) life.nod = { on: false, missing: "Nods with a voice" };
  else if (!headBone && nodSrc) life.nod = { on: false, missing: "The head's rotation is animated" };
  else {
    // A head bone turns; else the head group does. It ADDS: keys on the head stay yours.
    const fields = headBone ? { channel: `bone.${headBone.id}.rotation` } : { layer: nodderId === G ? "" : nodderId, channel: "rotation" };
    push("behaviors.add", { groupId: G, type: "nod", fields: { ...fields, amount: 1.5 } }, "the head moves with the voice");
    life.nod = { on: true };
  }

  // ── Look ─────────────────────────────────────────────────────────────────
  const bones = group?.rig?.bones ?? [];
  const looking = bones.some((b) => b.name === "Pupil.L" || b.name === "Pupil.R");
  const pupils = (["L", "R"] as const).map((s) => ({ s, pupil: P[`pupil.${s}`], eye: P[`eye.${s}`] })).filter((p) => p.pupil?.bounds);
  if (!want("look")) {
    const gone = LOOK_BONES.filter((n) => bones.some((b) => b.name === n));
    const glance = behaviorOf("glance");
    if (glance) push("behaviors.remove", { groupId: G, id: glance.id }, "eyes stop looking");
    if (gone.length) push("rig.bone", { rigId: G, remove: gone }, "eyes stop looking");
    life.look = { on: false };
  } else if (looking) life.look = { on: true };
  else if (!pupils.length) life.look = { on: false, missing: "No pupils found" };
  else {
    const centres = pupils.map((p) => [cxOf(p.pupil!.bounds!), cyOf(p.pupil!.bounds!)] as const);
    const mid = [r1(centres.reduce((a, c) => a + c[0], 0) / centres.length), r1(centres.reduce((a, c) => a + c[1], 0) / centres.length)];
    // One skeleton: the eyes and their target hang off the character's head
    // or body root when it has one, so posing or dragging the character
    // carries its gaze (separate roots stayed behind — "the eyes don't move").
    const anchor = EYE_ANCHORS.map((re) => bones.find((b) => re.test(b.name))).find(Boolean)?.name ?? null;
    const add: Array<Record<string, unknown>> = [{ name: "Look", head: mid, tail: [mid[0]! + 12, mid[1]!], parent: anchor, deform: false, shape: "cross" }];
    pupils.forEach((p, i) => {
      const [x, y] = [r1(centres[i]![0]), r1(centres[i]![1])];
      const pb = p.pupil!.bounds!, eb = p.eye?.bounds;
      // The pad: how far the pupil can travel before it leaves its eye.
      const rx = r1(Math.max(2, eb ? ((eb.maxX - eb.minX) - (pb.maxX - pb.minX)) * 0.4 : (pb.maxX - pb.minX) * 0.6));
      const ry = r1(Math.max(2, eb ? ((eb.maxY - eb.minY) - (pb.maxY - pb.minY)) * 0.4 : (pb.maxY - pb.minY) * 0.6));
      add.push({ name: `Pupil.${p.s}`, head: [x, y], tail: [x + 8, y], parent: anchor, deform: false, shape: "square", limits: { x: [-rx, rx], y: [-ry, ry], rotation: [0, 0] } });
      add.push({ name: `Look.${p.s}`, head: [x, y], tail: [x + 6, y], parent: "Look", deform: false, shape: "circle", size: 4 });
    });
    push("rig.bone", { rigId: G, add }, "pupil pads and a Look control");
    for (const p of pupils) push("rig.bind", { ids: [p.pupil!.clipId], mode: "rigid", bone: `Pupil.${p.s}` }, `${p.pupil!.name} rides its pad`);
    push("rig.constrain", { rigId: G, add: pupils.map((p) => ({ bone: `Pupil.${p.s}`, type: "look", target: `Look.${p.s}` })) }, "pupils look where Look points");
    push("behaviors.add", { groupId: G, type: "glance", fields: { bone: "Look" } }, "the eyes look around on their own");
    life.look = { on: true };
  }

  return { targetId, parts, steps, life, voice: life.talk.on ? (voice?.name ?? voiceName) : null };
}

// ── The script face ─────────────────────────────────────────────────────────

const REF = /"\$(\d+)((?:\.[\w-]+|\[\d+\])*)"/g;

/**
 * The plan as a script of `ac.*` calls — runnable in the Scripts panel, and
 * the same calls `character.bringToLife` makes. A result a later step reads
 * is kept in a `const`.
 */
export function printPlan(plan: AlivePlan): string {
  const used = new Set<number>();
  for (const s of plan.steps) for (const m of JSON.stringify(s.input).matchAll(REF)) used.add(Number(m[1]));
  const lines = plan.steps.map((s, i) => {
    const call = `await ac.${s.verb}(${JSON.stringify(s.input).replace(REF, (_, n: string, path: string) => `s${n}${path}`)});`;
    return `// ${s.why}\n${used.has(i) ? `const s${i} = ${call}` : call}`;
  });
  return lines.join("\n");
}

/** `$<n>.<path>` → that result's value (the `api.batch` convention), deep. */
export function resolvePlanRefs(value: unknown, results: readonly unknown[]): unknown {
  if (typeof value === "string") {
    const m = /^\$(\d+)((?:\.[\w-]+|\[\d+\])*)$/.exec(value);
    if (!m) return value;
    let cur: unknown = results[Number(m[1])];
    for (const step of m[2]!.match(/[\w-]+|\d+/g) ?? []) cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[step] : undefined;
    return cur;
  }
  if (Array.isArray(value)) return value.map((v) => resolvePlanRefs(v, results));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolvePlanRefs(v, results)]));
  return value;
}

const STOP: Record<LifeBehavior, string> = { blink: "stop blinking", breathe: "stop breathing", nod: "stop nodding", look: "eyes stop looking", talk: "stop following the voice" };

/**
 * What is alive on a character now, derived from the document (the Life
 * toggles' state): on = turning it off would plan a step; `missing` = why
 * turning it on could not.
 */
export function lifeOf(doc: MotionDocument, targetId: string, parts?: PartMap): Record<LifeBehavior, LifeState> | null {
  const off = planBringToLife(doc, targetId, { blink: false, breathe: false, nod: false, look: false, talk: false }, parts);
  const on = planBringToLife(doc, targetId, { look: true }, parts);
  if (!off || !on) return null;
  return Object.fromEntries(
    LIFE_BEHAVIORS.map((b) => [b, { on: off.steps.some((s) => s.why === STOP[b]), ...(on.life[b].missing && { missing: on.life[b].missing }) }]),
  ) as Record<LifeBehavior, LifeState>;
}
