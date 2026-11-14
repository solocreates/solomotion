import type { MotionDocument, Behavior, Clip, GroupClip, PoseSet } from "../schema";
import { parseFxToken } from "../schema";
import { expressionById } from "../expressions/document";
import { writeChannel } from "../animation/channels";
import { clipLocalTime } from "../animation/evaluate";
import { locateClip } from "../timeline/ops";
import { compFps, frameStepMs } from "../timeline/fps";
import { switchOptions } from "../timeline/switch";
import { characterOf } from "../rig/poses";
import { guessVocabulary, poseSetFromSwitch } from "../rig/pose-ops";
import { behaviorValue } from "../behaviors/registry";
import { addBehavior, updateBehavior } from "../behaviors/ops";
import { lipSyncPoseFor, lipSyncVisemeAt } from "../behaviors/evaluate";
import { mouthKindOfPath, slowestKind, type MouthKind } from "./feel";
import { mediaAssetOf } from "./source";
import { REST_VISEME } from "./types";

/**
 * WIRING A MOUTH TO A VOICE — one driver: the Lip sync BEHAVIOR on the
 * mouth's pose set. Its `voice` field says what it hears ("" = whichever
 * voice plays, in the comp or through an instance's Voice input), and its
 * map, rest and lead are the Mouth map the Character tab draws. 2D (a switch
 * of drawings), morphs and bones all talk the same way, because each is a
 * viseme pose set.
 *
 * The `lipsync("Voice")` expression stays a VALUE SOURCE for hand-written
 * expressions, but nothing in the app binds a mouth with it any more. Older
 * documents that did are read (`lipSyncBindingOf`) and upgraded the first
 * time their mouth is given a voice (`setMouthVoice` drops the driver).
 */

/** A mouth in a comp: a viseme pose set, or a mouth switch no set covers yet. */
export interface Mouth {
  /** Stable picker key: `<groupId>|<setId>`, or `switch|<switchId>`. */
  key: string;
  /** The group whose set it is — the character. For a bare switch, where its set will go. */
  groupId: string;
  /** Null for a bare switch: giving it a voice makes the set. */
  setId: string | null;
  switchId: string | null;
  /** "Pip · Mouth", or a bare switch's own name. */
  label: string;
  kind: MouthKind;
  /** What it hears: null = silent, "" = every voice (whichever plays), else that layer's name. */
  voice: string | null;
  behaviorId: string | null;
}

const isLipSync = (b: Behavior, setId: string) => b.type === "lipSync" && String(b.set ?? "") === setId;

function kindOfSet(set: PoseSet): MouthKind {
  return slowestKind(set.poses.flatMap((p) => p.values.map((v) => mouthKindOfPath(v.path))));
}

/** The Lip sync behavior that moves `setId`, enabled or not. */
export function lipSyncBehaviorOf(group: GroupClip, setId: string): Behavior | null {
  return group.behaviors?.find((b) => isLipSync(b, setId)) ?? null;
}

/** What a set hears: its enabled behavior's voice, else an older `lipsync()` driver's. */
function heardBy(doc: MotionDocument, group: GroupClip, set: PoseSet): { voice: string | null; behaviorId: string | null } {
  const b = lipSyncBehaviorOf(group, set.id);
  if (b?.enabled) return { voice: String(behaviorValue(b, "voice") ?? ""), behaviorId: b.id };
  const legacy = lipSyncBindingOf(doc, group, `pose.${set.id}`);
  return { voice: legacy ? (legacy.voice ?? "") : null, behaviorId: b?.id ?? null };
}

/** Does this switch already belong to a pose set (any set reaching it through `switch`)? */
function coveredSwitches(doc: MotionDocument, compId: string): Set<string> {
  const out = new Set<string>();
  for (const t of doc.tracks)
    for (const c of t.clips) {
      if (c.frameId !== compId || c.kind !== "group") continue;
      for (const s of c.poses ?? []) {
        if (s.part) out.add(s.part);
        for (const p of s.poses) for (const v of p.values) if (v.path === "switch") out.add(v.clipId);
      }
    }
  return out;
}

/** A switch that reads as a mouth: named like one, or its drawings named like visemes. */
function looksLikeMouth(doc: MotionDocument, sw: GroupClip): boolean {
  return /mouth|lips?/i.test(sw.name) || guessVocabulary(switchOptions(doc, sw.id).map((m) => m.name)) === "visemes";
}

/**
 * Every mouth in a comp: viseme pose sets (and any set a Lip sync behavior
 * drives) first, then mouth switches no set covers. One list, so the voice
 * clip's picker, the Character tab and `speech.bind` agree on what a mouth is.
 */
export function mouthsIn(doc: MotionDocument, compId: string): Mouth[] {
  const sets: Mouth[] = [];
  const bare: Mouth[] = [];
  const covered = coveredSwitches(doc, compId);
  for (const t of doc.tracks)
    for (const c of t.clips) {
      if (c.frameId !== compId || c.kind !== "group") continue;
      for (const set of c.poses ?? []) {
        if (set.vocabulary !== "visemes" && !lipSyncBehaviorOf(c, set.id)) continue;
        sets.push({ key: `${c.id}|${set.id}`, groupId: c.id, setId: set.id, switchId: set.part ?? null, label: `${c.name} · ${set.name}`, kind: kindOfSet(set), ...heardBy(doc, c, set) });
      }
      if (c.switch && !covered.has(c.id) && looksLikeMouth(doc, c)) {
        const legacy = lipSyncBindingOf(doc, c, "switch");
        bare.push({ key: `switch|${c.id}`, groupId: characterOf(doc, c.id)?.id ?? c.id, setId: null, switchId: c.id, label: c.name, kind: "drawings", voice: legacy ? (legacy.voice ?? "") : null, behaviorId: null });
      }
    }
  return [...sets, ...bare];
}

/** The mouth a picked layer means: its own viseme set, a mouth inside it, or the switch itself. */
export function mouthOf(doc: MotionDocument, picked: Clip): Mouth | null {
  const all = mouthsIn(doc, picked.frameId);
  const own = all.find((m) => m.groupId === picked.id && m.setId) ?? all.find((m) => m.switchId === picked.id);
  if (own) return own;
  const inside = all.filter((m) => m.groupId === picked.id || (m.switchId && characterOf(doc, m.switchId)?.id === picked.id));
  return inside.find((m) => /mouth|lips?/i.test(m.label)) ?? inside[0] ?? null;
}

/** Does `mouth` move with this voice clip? Named, or listening to whichever plays. */
export function mouthHears(mouth: Mouth, voice: Clip): boolean {
  if (mouth.voice === null) return false;
  if (mouth.voice === "") return true;
  const want = mouth.voice.trim().toLowerCase();
  return voice.id === mouth.voice || voice.name.trim().toLowerCase() === want;
}

/**
 * Give a mouth a voice — or take it away (`null`). `""` = whichever voice
 * plays. A bare switch becomes a viseme set on its character (or on itself);
 * the set gets a Lip sync behavior, or its existing one is re-enabled and
 * re-pointed, so a person's Mouth map survives. Silencing DISABLES the
 * behavior for the same reason. An older `lipsync()` driver on the channel
 * is dropped: one driver. Mutates — call inside a write. Returns where the
 * mouth now lives, or null when the target is gone.
 */
export function setMouthVoice(doc: MotionDocument, mouth: Pick<Mouth, "groupId" | "setId" | "switchId">, voice: string | null): { groupId: string; setId: string; behaviorId: string | null } | null {
  let setId = mouth.setId;
  if (!setId) {
    if (!mouth.switchId) return null;
    unbindLipSync(doc, mouth.switchId, "switch");
    if (voice === null) return null;
    setId = poseSetFromSwitch(doc, mouth.groupId, mouth.switchId, { name: "Mouth", vocabulary: "visemes" });
    if (!setId) return null;
  }
  const group = locateClip(doc, mouth.groupId)?.clip;
  if (group?.kind !== "group") return null;
  unbindLipSync(doc, group.id, `pose.${setId}`);
  const b = lipSyncBehaviorOf(group, setId);
  if (voice === null) {
    if (b) updateBehavior(doc, group.id, b.id, { enabled: false });
    return { groupId: group.id, setId, behaviorId: b?.id ?? null };
  }
  if (b) {
    updateBehavior(doc, group.id, b.id, { enabled: true, voice });
    return { groupId: group.id, setId, behaviorId: b.id };
  }
  const added = addBehavior(doc, group.id, "lipSync", { set: setId, voice });
  return { groupId: group.id, setId, behaviorId: added?.id ?? null };
}

// ── Bake ────────────────────────────────────────────────────────────────────

export interface BakeResult {
  keys: number;
  fromMs: number;
  toMs: number;
}

/**
 * BAKE TO KEYS — a talking mouth becomes ordinary hold keys on its pose
 * channel (`pose.<set>`), one per change on the comp's frame grid over the
 * voice's span, and its Lip sync behavior is switched OFF (kept, with its
 * map, for "talk again"). Keys already on the channel inside the span are
 * replaced; keys outside stay. The track must already be heard (the host
 * awaits it). Mutates — call inside a write.
 */
export function bakeMouth(doc: MotionDocument, groupId: string, setId: string, voiceId: string): BakeResult | null {
  const group = locateClip(doc, groupId)?.clip;
  const voice = locateClip(doc, voiceId)?.clip;
  if (group?.kind !== "group" || !voice || !mediaAssetOf(voice)) return null;
  const set = group.poses?.find((s) => s.id === setId);
  const b = lipSyncBehaviorOf(group, setId);
  if (!set || !b) return null;
  // Bake what THIS voice says, whatever the behavior listens to.
  const heard: Behavior = { ...b, voice: voice.id };
  const path = `pose.${setId}`;
  const step = frameStepMs(compFps(doc, group.frameId));
  const fromMs = Math.max(group.startMs, voice.startMs);
  const toMs = Math.min(group.startMs + group.durationMs, voice.startMs + voice.durationMs);
  if (!(toMs > fromMs)) return { keys: 0, fromMs, toMs };

  const poseAt = (t: number) => lipSyncPoseFor(heard, lipSyncVisemeAt(doc, group, set, heard, t) ?? REST_VISEME);
  const samples: Array<{ local: number; value: string }> = [];
  let last: string | null = null;
  for (let t = fromMs; t < toMs; t += step) {
    const value = poseAt(t);
    if (value === last) continue;
    const local = clipLocalTime(group, t);
    if (local === null) continue;
    samples.push({ local, value });
    last = value;
  }
  const rest = lipSyncPoseFor(heard, REST_VISEME);
  const endLocal = clipLocalTime(group, toMs);
  if (endLocal !== null && last !== rest) samples.push({ local: endLocal, value: rest });

  updateBehavior(doc, group.id, b.id, { enabled: false });
  unbindLipSync(doc, group.id, path);
  const lo = fromMs - group.startMs;
  const hi = toMs - group.startMs;
  for (const k of group.keyframes) {
    if (k.property !== path || k.range) continue;
    k.keys = k.keys.filter((key) => key.timeMs < lo - 0.5 || key.timeMs > hi + 0.5);
  }
  for (const s of samples) writeChannel(group, path, s.local, s.value, { forceKey: true });
  return { keys: samples.length, fromMs, toMs };
}

// ── The expression form (a value source, and older documents) ───────────────

/** The expression source for a voice — a layer name, or an input of the comp (`input("Voice")`). */
export function lipSyncSource(voice: { layer: string } | { input: string }): string {
  return "layer" in voice ? `lipsync(${JSON.stringify(voice.layer)})` : `lipsync(input(${JSON.stringify(voice.input)}))`;
}

const LIPSYNC_CALL = /\blipsync\(\s*(?:"((?:[^"\\]|\\.)*)"|input\(\s*"((?:[^"\\]|\\.)*)"\s*\))/;

export interface LipSyncBinding {
  expressionId: string;
  source: string;
  /** The voice layer the source names literally, or null when it reads an input. */
  voice: string | null;
  /** The input it reads the voice from, when it does. */
  input: string | null;
}

/** A `lipsync(...)` driver on a channel — how documents before the one driver bound a mouth. */
export function lipSyncBindingOf(doc: MotionDocument, clip: Clip, path: string): LipSyncBinding | null {
  const id = parseFxToken(clip.drivers?.[path]);
  const expr = id ? expressionById(doc, id) : undefined;
  if (!expr) return null;
  const m = LIPSYNC_CALL.exec(expr.source);
  if (!m) return null;
  const unquote = (s: string | undefined) => (s === undefined ? null : (JSON.parse(`"${s}"`) as string));
  return { expressionId: expr.id, source: expr.source, voice: unquote(m[1]), input: unquote(m[2]) };
}

/** Drop a `lipsync(...)` driver from a channel (only that kind). */
export function unbindLipSync(doc: MotionDocument, targetId: string, path: string): boolean {
  const clip = locateClip(doc, targetId)?.clip;
  if (!clip || !lipSyncBindingOf(doc, clip, path)) return false;
  const drivers = { ...clip.drivers };
  delete drivers[path];
  clip.drivers = Object.keys(drivers).length ? drivers : undefined;
  return true;
}

// ── Voices ──────────────────────────────────────────────────────────────────

/** A clip in `compId` named `name` (any case) that plays a recording. */
export function voiceClipNamed(doc: MotionDocument, compId: string, name: string): Clip | null {
  const want = name.trim().toLowerCase();
  for (const t of doc.tracks) for (const c of t.clips) if (c.frameId === compId && mediaAssetOf(c) && (c.id === name || c.name.trim().toLowerCase() === want)) return c;
  return null;
}

/** Every clip in a comp that can be a voice (imported audio, video with sound). */
export function voiceClipsIn(doc: MotionDocument, compId: string): Clip[] {
  const out: Clip[] = [];
  for (const t of doc.tracks) for (const c of t.clips) if (c.frameId === compId && mediaAssetOf(c)) out.push(c);
  return out;
}
