import { cueIndexAt, energyAt } from "@solomotion/lipsync";
import type { MotionDocument, Behavior, BehaviorOverride, Clip, GroupClip, KeyframeValue, PoseSet } from "../schema";
import type { ExprContext } from "../expressions/globals";
import { scopedSeedFor } from "../expressions/bind";
import { resolveScopedLayer } from "../components/inputs";
import { channelValueAt } from "../animation/channels";
import { compFps } from "../timeline/fps";
import { clipBox, locateClip } from "../timeline/ops";
import { actedCues, energyGain, mouthKindOfPath, slowestKind } from "../speech/feel";
import { mediaAssetOf, mediaSourceAt } from "../speech/source";
import { readSpeechTrack } from "../speech/reader";
import { REST_VISEME, type MediaPosition } from "../speech/types";
import { BEHAVIOR, behaviorDef, behaviorValue } from "./registry";

/**
 * WHAT A BEHAVIOR DOES AT AN INSTANT — pure functions of (behavior, time, the
 * document, the speech reader). The registry (`registry.ts`) says what a kind
 * IS; this says what it does. Every reader of a pose channel (the bake's
 * PoseMix look-back, the timeline's lanes, the Face pad, agents) goes through
 * `behaviorsChoiceAt`, every channel write through `behaviorChannelWrites`, so
 * the canvas, the timeline and an export cannot disagree about a blink.
 *
 * Times: a behavior lives on the character's own clock (GROUP-LOCAL ms) —
 * move the character and its performance moves with it. A voice is read on
 * the comp's clock through its clip (`mediaSourceAt`), so moving the audio
 * re-syncs the mouth with nothing regenerated.
 */

export interface BehaviorEnv {
  /**
   * The expression context at comp time `compMs` — the instance scope (a
   * character's Voice input, seeds that differ per instance), machines,
   * layers through the instance chain. Hosts pass the bake's (core
   * `poseEnvAt`); absent = headless: voices in the character's own comp, the
   * character's own seed, no machines.
   */
  contextAt?: (compMs: number) => ExprContext | null;
}

/** A field at group-local time: its keys, else its stored value, else the kind's default. */
export function behaviorFieldAt(group: GroupClip, b: Behavior, key: string, localMs: number): KeyframeValue | undefined {
  const path = BEHAVIOR.path(b.id, key);
  if (group.keyframes.some((k) => k.property === path && k.keys.length > 0)) {
    const v = channelValueAt(group, path, localMs);
    if (v !== undefined) return v;
  }
  return behaviorValue(b, key);
}

const num = (v: KeyframeValue | undefined, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const str = (v: KeyframeValue | undefined): string => (typeof v === "string" ? v : "");

/** Is this behavior ON at group-local time (its switch may be keyed)? */
export function behaviorEnabledAt(group: GroupClip, b: Behavior, localMs: number): boolean {
  const path = BEHAVIOR.path(b.id, "enabled");
  if (group.keyframes.some((k) => k.property === path && k.keys.length > 0)) return channelValueAt(group, path, localMs) !== false;
  return b.enabled !== false;
}

// ── Randomness (seeded, replayable) ─────────────────────────────────────────

function hash(n: number): number {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function noise1(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i + seed * 101.3) * (1 - u) + hash(i + 1 + seed * 101.3) * u;
}

/** Smooth 0..1 noise with three octaves — wanders rather than jumps. */
function fbm(x: number, seed: number): number {
  return (noise1(x, seed) * 0.57 + noise1(x * 2.03 + 17.1, seed) * 0.29 + noise1(x * 4.01 + 31.7, seed) * 0.14) / 1;
}

/** The seed of one behavior on one character in one instance. */
function seedOf(group: GroupClip, b: Behavior, ctx: ExprContext | null, extra: number): number {
  return scopedSeedFor(`${group.id}/${b.id}/${extra}`, ctx?.scope) * 9973;
}

// ── Overrides ───────────────────────────────────────────────────────────────

/** The override covering group-local `localMs`, if any (spans never overlap; the last wins if they do). */
export function overrideAt(b: Behavior, localMs: number): BehaviorOverride | undefined {
  const list = b.overrides;
  if (!list?.length) return undefined;
  for (let i = list.length - 1; i >= 0; i--) {
    const o = list[i]!;
    if (localMs >= o.fromMs && localMs < o.toMs) return o;
  }
  return undefined;
}

/**
 * The override list with `[fromMs, toMs)` set to `pose` (null = stand aside):
 * what it covers is cut out of the spans already there, so spans never
 * overlap and an override of an override replaces it.
 */
export function withOverride(list: readonly BehaviorOverride[] | undefined, span: BehaviorOverride): BehaviorOverride[] {
  const out: BehaviorOverride[] = [];
  for (const o of list ?? []) {
    if (o.toMs <= span.fromMs || o.fromMs >= span.toMs) {
      out.push(o);
      continue;
    }
    if (o.fromMs < span.fromMs) out.push({ ...o, id: `${o.id}a`, toMs: span.fromMs });
    if (o.toMs > span.toMs) out.push({ ...o, id: `${o.id}b`, fromMs: span.toMs });
  }
  if (span.toMs > span.fromMs) out.push(span);
  return out.sort((a, b) => a.fromMs - b.fromMs);
}

/** The override list with `[fromMs, toMs)` cleared back to automatic. */
export function withoutOverride(list: readonly BehaviorOverride[] | undefined, fromMs: number, toMs: number): BehaviorOverride[] {
  return withOverride(list, { id: "_", fromMs, toMs, pose: null }).filter((o) => o.id !== "_");
}

// ── Blink ───────────────────────────────────────────────────────────────────

export interface BlinkEvent {
  /** Group-local ms the lids start to close. */
  atMs: number;
  /** How long the eye is shut. */
  shutMs: number;
}

interface BlinkRun {
  events: BlinkEvent[];
  /** When the next first-blink of the rhythm starts. */
  next: number;
  k: number;
}
const blinkMemo = new Map<string, BlinkRun>();

/**
 * The blinks of one rhythm from 0 past `untilMs`, in order: the first after
 * 30–100 % of a gap, then gaps of (1 ± unevenness) × `every`, and now and then
 * a second blink right after one (the `blink()` expression's rhythm, with its
 * two constants made fields). Deterministic per seed, grown and kept.
 */
export function blinkEvents(everyS: number, shutMs: number, variance: number, doubles: number, seed: number, untilMs: number): BlinkEvent[] {
  const gap = Math.max(200, everyS * 1000);
  const shut = Math.max(10, Math.min(shutMs, gap / 2));
  const v = Math.max(0, Math.min(1, variance / 100));
  const p2 = Math.max(0, Math.min(1, doubles / 100));
  const key = `${gap}|${shut}|${v}|${p2}|${seed}`;
  let run = blinkMemo.get(key);
  if (!run) {
    if (blinkMemo.size > 256) blinkMemo.clear();
    run = { events: [], next: gap * (0.3 + 0.7 * hash(seed * 3.17 + 0.5)), k: 1 };
    blinkMemo.set(key, run);
  }
  while (run.next <= untilMs + gap) {
    const at = run.next;
    run.events.push({ atMs: at, shutMs: shut });
    if (hash(seed * 5.03 + run.k * 1.91) < p2) run.events.push({ atMs: at + shut * 2.2, shutMs: shut });
    run.next = Math.max(at + shut * 3.5, at + gap * (1 - v + 2 * v * hash(seed * 7.31 + run.k * 2.71)));
    run.k++;
  }
  return run.events;
}

function blinkAt(group: GroupClip, b: Behavior, local: number, ctx: ExprContext | null): string | undefined {
  if (local < 0) return undefined;
  const events = blinkEvents(
    num(behaviorFieldAt(group, b, "every", local), 4),
    num(behaviorFieldAt(group, b, "length", local), 120),
    num(behaviorFieldAt(group, b, "variance", local), 40),
    num(behaviorFieldAt(group, b, "doubles", local), 17),
    seedOf(group, b, ctx, num(behaviorValue(b, "seed"), 0)),
    local,
  );
  // Binary search for the last blink starting at or before `local`.
  let lo = 0;
  let hi = events.length - 1;
  let hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid]!.atMs <= local) {
      hit = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  for (let i = hit; i >= 0 && i >= hit - 1; i--) {
    const e = events[i]!;
    if (local < e.atMs || local >= e.atMs + e.shutMs) continue;
    const half = str(behaviorValue(b, "half"));
    const closed = str(behaviorValue(b, "closed")) || "Closed";
    if (!half) return closed;
    // Top and bottom lids pass through halfway on the way down and back up.
    const p = (local - e.atMs) / e.shutMs;
    return p < 0.25 || p >= 0.8 ? half : closed;
  }
  return undefined;
}

// ── Voices ──────────────────────────────────────────────────────────────────

interface Heard {
  src: MediaPosition;
  clipId: string;
}

/**
 * The voice a character hears at comp time `compMs`: the named one, or —
 * every voice in reach — the topmost clip playing then, in the character's
 * own comp, else through its instance's layer inputs (a component's Voice).
 * So a character speaks with whichever line is on the timeline there.
 */
function voiceAt(doc: MotionDocument, group: GroupClip, name: string, compMs: number, ctx: ExprContext | null): Heard | null {
  if (name) {
    if (ctx) {
      const at = resolveScopedLayer(ctx, name);
      const src = at?.layers.sourceOf?.(at.clipId);
      if (at && src) return { src, clipId: at.clipId };
    }
    const want = name.trim().toLowerCase();
    for (const t of doc.tracks)
      for (const c of t.clips) {
        if (c.frameId !== group.frameId || (c.id !== name && c.name.trim().toLowerCase() !== want) || !mediaAssetOf(c)) continue;
        const src = mediaSourceAt(doc, c, compMs);
        if (src) return { src, clipId: c.id };
      }
    return null;
  }
  for (const t of doc.tracks)
    for (const c of t.clips) {
      if (c.frameId !== group.frameId || !mediaAssetOf(c) || compMs < c.startMs || compMs >= c.startMs + c.durationMs) continue;
      if (isMuted(c)) continue;
      const src = mediaSourceAt(doc, c, compMs);
      if (src) return { src, clipId: c.id };
    }
  // Inside a component: a layer input (its Voice) names a clip beside the instance.
  if (ctx?.scope && ctx.readInput) {
    for (const inputName of ["Voice", "voice"]) {
      const ref = ctx.readInput(inputName);
      if (typeof ref !== "string" || !ref) continue;
      const at = resolveScopedLayer(ctx, ref);
      const src = at?.layers.sourceOf?.(at.clipId);
      if (at && src) return { src, clipId: at.clipId };
    }
  }
  return null;
}

const isMuted = (c: Clip): boolean => ("muted" in c && (c as { muted?: boolean }).muted === true) || ("volume" in c && (c as { volume?: number }).volume === 0);

/** The mouth kind a set acts as: drawings swap, morphs ease, bones move. */
function mouthKindOfSet(set: PoseSet) {
  return slowestKind(set.poses.flatMap((p) => p.values.map((v) => mouthKindOfPath(v.path))));
}

/**
 * The VISEME a Lip sync behavior hears at comp time — before any mapping — or
 * null where no voice plays. Exported for the editor's mouth map, which lights
 * the shape sounding at the playhead.
 */
export function lipSyncVisemeAt(doc: MotionDocument, group: GroupClip, set: PoseSet, b: Behavior, compMs: number, ctx: ExprContext | null = null): string | null {
  const local = compMs - group.startMs;
  const lead = num(behaviorFieldAt(group, b, "lead", local), 0);
  const heard = voiceAt(doc, group, str(behaviorValue(b, "voice")), compMs + lead, ctx);
  if (!heard) return null;
  const track = readSpeechTrack(heard.src.assetId);
  if (!track) return REST_VISEME;
  const cues = actedCues(track, { kind: mouthKindOfSet(set), fps: compFps(doc, group.frameId), speech: heard.src.asset?.speech });
  const i = cueIndexAt(cues, heard.src.sourceMs);
  return i >= 0 ? cues[i]!.viseme : REST_VISEME;
}

/**
 * THE MOUTH MAP — which pose a viseme shows. A person's choice for that viseme
 * (`as.<VISEME>`, flat on the behavior like every field) wins; rest is the
 * "In pauses" field; anything unmapped is the viseme itself, which the set's
 * vocabulary resolves by name, alias and fallback. One function, so the
 * evaluator and the map the editor draws can never disagree.
 */
export const VISEME_MAP_PREFIX = "as.";
export function visemeMapped(b: Behavior, viseme: string): string {
  const v = b[`${VISEME_MAP_PREFIX}${viseme}`];
  return typeof v === "string" ? v : "";
}
export function lipSyncPoseFor(b: Behavior, viseme: string): string {
  if (viseme === REST_VISEME) return str(behaviorValue(b, "rest")) || visemeMapped(b, viseme) || REST_VISEME;
  return visemeMapped(b, viseme) || viseme;
}

function lipSyncAt(doc: MotionDocument, group: GroupClip, set: PoseSet, b: Behavior, compMs: number, ctx: ExprContext | null): string | undefined {
  const viseme = lipSyncVisemeAt(doc, group, set, b, compMs, ctx);
  if (viseme === null) return undefined;
  if (viseme === REST_VISEME && behaviorValue(b, "pausesShowKeys") === true) return undefined;
  return lipSyncPoseFor(b, viseme);
}

/** The voice's loudness 0..1 at comp time (0 where none plays). */
function loudnessAt(doc: MotionDocument, group: GroupClip, name: string, compMs: number, ctx: ExprContext | null): number {
  const heard = voiceAt(doc, group, name, compMs, ctx);
  if (!heard) return 0;
  const track = readSpeechTrack(heard.src.assetId);
  if (!track) return 0;
  const v = energyAt(track.energy, heard.src.sourceMs) * energyGain(heard.src.asset?.speech);
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ── Cycle ───────────────────────────────────────────────────────────────────

function cycleAt(group: GroupClip, b: Behavior, local: number): string | undefined {
  const steps = (b.steps ?? []).filter((s) => s.ms > 0 && s.pose);
  if (!steps.length) return undefined;
  const total = steps.reduce((n, s) => n + s.ms, 0);
  const speed = num(behaviorFieldAt(group, b, "speed", local), 100) / 100;
  const offset = num(behaviorFieldAt(group, b, "offset", local), 0);
  let t = local * speed + offset;
  const mode = str(behaviorValue(b, "mode")) || "loop";
  if (mode === "once") {
    if (t < 0 || t >= total) return undefined;
  } else if (mode === "pingpong") {
    const p = ((t % (total * 2)) + total * 2) % (total * 2);
    t = p < total ? p : total * 2 - p - 1e-6;
  } else t = ((t % total) + total) % total;
  for (const s of steps) {
    if (t < s.ms) return s.pose;
    t -= s.ms;
  }
  return steps[steps.length - 1]!.pose;
}

// ── Machine ─────────────────────────────────────────────────────────────────

function machineAt(doc: MotionDocument, group: GroupClip, set: PoseSet, b: Behavior, ctx: ExprContext | null): string | undefined {
  if (!ctx?.readMachine) return undefined;
  const frame = doc.frames.find((f) => f.id === group.frameId);
  const id = str(behaviorValue(b, "machine"));
  const machine = frame?.machines?.find((m) => m.id === id || m.name === id);
  if (!machine) return undefined;
  let out: string | undefined;
  for (const layer of machine.layers) {
    const r = ctx.readMachine(machine.name, layer.name);
    const o = r?.output;
    if (o?.kind === "pose" && (o.set === set.id || o.set === set.name)) out = o.pose;
  }
  return out;
}

// ── Set behaviors: which pose ───────────────────────────────────────────────

/**
 * Does this behavior drive this set? A machine drives the sets its states
 * name — known only with the document in hand (without it: every set).
 */
export function drivesSet(b: Behavior, set: PoseSet, doc?: MotionDocument): boolean {
  const def = behaviorDef(b.type);
  if (def?.drives !== "set") return false;
  if (b.type === "machine") {
    if (!doc) return true;
    const id = str(behaviorValue(b, "machine"));
    for (const f of doc.frames)
      for (const m of f.machines ?? []) {
        if (m.id !== id && m.name !== id) continue;
        return m.layers.some((l) => l.states.some((s) => s.output.kind === "pose" && (s.output.set === set.id || s.output.set === set.name)));
      }
    return false;
  }
  const s = str(behaviorValue(b, "set"));
  return s === set.id || (s !== "" && s === set.name);
}

/**
 * What ONE behavior asks of a set at comp time, BEFORE overrides — undefined
 * where it is not active (no blink now, no voice playing, a machine whose
 * states say nothing of this set).
 */
export function behaviorGeneratedAt(doc: MotionDocument, group: GroupClip, set: PoseSet, b: Behavior, compMs: number, env: BehaviorEnv = {}): string | undefined {
  const local = compMs - group.startMs;
  const ctx = b.type === "lipSync" || b.type === "machine" || b.type === "blink" ? (env.contextAt?.(compMs) ?? null) : null;
  switch (b.type) {
    case "blink":
      return blinkAt(group, b, local, ctx);
    case "lipSync":
      return lipSyncAt(doc, group, set, b, compMs, ctx);
    case "cycle":
      return cycleAt(group, b, local);
    case "machine":
      return machineAt(doc, group, set, b, ctx);
    default:
      return undefined;
  }
}

export interface BehaviorChoice {
  /** The pose name (or id, or viseme) asked for. */
  value: string;
  behavior: Behavior;
  /** True when a person's override decided it, not the behavior. */
  overridden: boolean;
  /** Which override — two you split apart stay two blocks, even showing one pose. */
  overrideId?: string;
}

/**
 * Which pose the behaviors on `group` ask of `set` at comp time — the topmost
 * active one, overrides applied — or null where none is active (your keys
 * show). An override with a pose wins even where the behavior was quiet (a
 * blink you added); an override of `null` makes the behavior stand aside.
 */
export function behaviorsChoiceAt(doc: MotionDocument, group: GroupClip, set: PoseSet, compMs: number, env: BehaviorEnv = {}): BehaviorChoice | null {
  const list = group.behaviors;
  if (!list?.length) return null;
  const local = compMs - group.startMs;
  let out: BehaviorChoice | null = null;
  for (const b of list) {
    if (!drivesSet(b, set, doc) || !behaviorEnabledAt(group, b, local)) continue;
    const o = overrideAt(b, local);
    if (o) {
      if (o.pose !== null) out = { value: o.pose, behavior: b, overridden: true, overrideId: o.id };
      continue;
    }
    const v = behaviorGeneratedAt(doc, group, set, b, compMs, env);
    if (v !== undefined) out = { value: v, behavior: b, overridden: false };
  }
  return out;
}

/** Does any enabled behavior drive this set? (Cheap: no evaluation.) */
export function setHasBehaviors(group: GroupClip, set: PoseSet): boolean {
  return !!group.behaviors?.some((b) => b.enabled !== false && drivesSet(b, set));
}

// ── Channel behaviors: what they add ────────────────────────────────────────

export interface BehaviorWrite {
  clipId: string;
  path: string;
  /** `add`: onto the value; `multiply`: a factor (scales and stretches). */
  mode: "add" | "multiply";
  value: number;
  behaviorId: string;
}

const SCALING = /(^|\.)(scale|scaleX|scaleY|scaleZ)$/;

/**
 * Where a channel behavior acts: its `layer` (empty = the character) and
 * `channel` (empty = the kind's default — a torso bone's stretch for Breathe,
 * a head bone's turn for Sway). A bone channel is `bone.<id>.<channel>` on the
 * character group.
 */
export function behaviorTarget(group: GroupClip, b: Behavior): { clipId: string; path: string } | null {
  const def = behaviorDef(b.type);
  if (def?.drives !== "channel") return null;
  if (b.type === "glance") {
    const layer = str(behaviorValue(b, "layer"));
    if (layer && !str(behaviorValue(b, "bone"))) return { clipId: layer, path: "rotation" };
    const bone = resolveBone(group, str(behaviorValue(b, "bone")), def.defaultChannel);
    return bone ? { clipId: group.id, path: `bone.${bone}.x` } : null;
  }
  const layer = str(behaviorValue(b, "layer")) || group.id;
  const channel = str(behaviorValue(b, "channel"));
  if (channel) return { clipId: layer, path: channel };
  if (layer !== group.id) return { clipId: layer, path: b.type === "breathe" ? "scaleY" : "rotation" };
  const bone = resolveBone(group, "", def.defaultChannel);
  if (bone) return { clipId: group.id, path: `bone.${bone}.${b.type === "breathe" ? "scale" : "rotation"}` };
  return { clipId: group.id, path: b.type === "breathe" ? "scaleY" : "rotation" };
}

function resolveBone(group: GroupClip, idOrName: string, fallback: string | undefined): string | null {
  const bones = group.rig?.bones ?? [];
  if (idOrName) return bones.find((x) => x.id === idOrName || x.name === idOrName)?.id ?? null;
  const m = fallback && /^bone:(.+)$/.exec(fallback);
  if (!m) return null;
  const re = new RegExp(m[1]!, "i");
  return bones.find((x) => re.test(x.name))?.id ?? null;
}

interface GlanceStep {
  atMs: number;
  x: number;
  y: number;
}
const glanceMemo = new Map<string, GlanceStep[]>();

/** Looks, in order: hold, jump, hold — seeded, grown and kept. */
function glanceSteps(holdS: number, rx: number, ry: number, centre: number, seed: number, untilMs: number): GlanceStep[] {
  const key = `${holdS}|${rx}|${ry}|${centre}|${seed}`;
  let list = glanceMemo.get(key);
  if (!list) {
    if (glanceMemo.size > 256) glanceMemo.clear();
    list = [{ atMs: 0, x: 0, y: 0 }];
    glanceMemo.set(key, list);
  }
  const hold = Math.max(200, holdS * 1000);
  while (list[list.length - 1]!.atMs <= untilMs) {
    const k = list.length;
    const at = list[k - 1]!.atMs + hold * (0.5 + hash(seed * 1.3 + k * 3.7));
    const home = hash(seed * 2.9 + k * 5.1) < centre / 100;
    const x = home ? 0 : (hash(seed * 4.7 + k * 1.7) * 2 - 1) * rx;
    const y = home ? 0 : (hash(seed * 6.1 + k * 2.3) * 2 - 1) * ry;
    list.push({ atMs: at, x, y });
  }
  return list;
}

/** Every channel write the behaviors on `group` make at comp time. */
export function behaviorChannelWrites(doc: MotionDocument, group: GroupClip, compMs: number, env: BehaviorEnv = {}): BehaviorWrite[] {
  const list = group.behaviors;
  if (!list?.length) return [];
  const local = compMs - group.startMs;
  const out: BehaviorWrite[] = [];
  for (const b of list) {
    const def = behaviorDef(b.type);
    if (def?.drives !== "channel" || !behaviorEnabledAt(group, b, local)) continue;
    const target = behaviorTarget(group, b);
    if (!target) continue;
    const scaling = SCALING.test(target.path);
    const s = local / 1000;
    const f = (key: string, fallback: number) => num(behaviorFieldAt(group, b, key, local), fallback);
    if (b.type === "breathe") {
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * ((f("rate", 16) / 60) * s + f("phase", 0) / 100));
      const amount = f("amount", 1.4);
      out.push(scaling ? { ...target, mode: "multiply", value: 1 + (amount / 100) * w, behaviorId: b.id } : { ...target, mode: "add", value: amount * w, behaviorId: b.id });
      // A LAYER breathing up from its bottom edge: lift it by what the stretch adds below its pivot.
      if (scaling && !target.path.startsWith("bone.") && /scale(Y)?$/.test(target.path) && behaviorValue(b, "keepBottom") !== false) {
        const lift = bottomLift(doc, target.clipId, (amount / 100) * w);
        if (lift) out.push({ clipId: target.clipId, path: "y", mode: "add", value: lift, behaviorId: b.id });
      }
    } else if (b.type === "sway") {
      const ctx = env.contextAt?.(compMs) ?? null;
      const v = (fbm(s * f("speed", 0.25), seedOf(group, b, ctx, f("seed", 0)) % 997) * 2 - 1) * f("amount", 2);
      out.push(scaling ? { ...target, mode: "multiply", value: 1 + v / 100, behaviorId: b.id } : { ...target, mode: "add", value: v, behaviorId: b.id });
    } else if (b.type === "nod") {
      const ctx = env.contextAt?.(compMs) ?? null;
      const v = loudnessAt(doc, group, str(behaviorValue(b, "voice")), compMs, ctx) * f("amount", 1.5);
      out.push(scaling ? { ...target, mode: "multiply", value: 1 + v / 100, behaviorId: b.id } : { ...target, mode: "add", value: v, behaviorId: b.id });
    } else if (b.type === "glance") {
      const ctx = env.contextAt?.(compMs) ?? null;
      // One rhythm per character and seed — not per card — so a Glance on each eye looks together.
      const seed = scopedSeedFor(`${group.id}/glance/${f("seed", 0)}`, ctx?.scope) * 9973;
      const steps = glanceSteps(f("hold", 1.6), f("rangeX", 24), f("rangeY", 10), f("centre", 40), seed, Math.max(0, local));
      let i = 0;
      while (i + 1 < steps.length && steps[i + 1]!.atMs <= local) i++;
      const cur = steps[i]!;
      const prev = steps[Math.max(0, i - 1)]!;
      const p = Math.min(1, Math.max(0, (local - cur.atMs) / Math.max(1, f("move", 90))));
      const e = 1 - (1 - p) * (1 - p) * (1 - p);
      const x = prev.x + (cur.x - prev.x) * e;
      const y = prev.y + (cur.y - prev.y) * e;
      if (!target.path.startsWith("bone.")) {
        // A layer turns: heading left–right, pitch up–down (a world eye looks down −Y, Z up).
        out.push({ clipId: target.clipId, path: "rotation", mode: "add", value: -x, behaviorId: b.id });
        out.push({ clipId: target.clipId, path: "rotationX", mode: "add", value: y, behaviorId: b.id });
        continue;
      }
      const bone = target.path.replace(/\.x$/, "");
      // Up and down: y on a flat rig, z in a world (Z up).
      const world = !!doc.frames.find((fr) => fr.id === group.frameId)?.world;
      out.push({ clipId: group.id, path: `${bone}.x`, mode: "add", value: x, behaviorId: b.id });
      out.push({ clipId: group.id, path: `${bone}.${world ? "z" : "y"}`, mode: "add", value: world ? -y : y, behaviorId: b.id });
    }
  }
  return out;
}

const boxMemo = new WeakMap<object, { height: number }>();

/** How far a layer must rise for its bottom edge to hold while it stretches by (1 + `grow`) about its pivot. */
function bottomLift(doc: MotionDocument, clipId: string, grow: number): number {
  const clip = locateClip(doc, clipId)?.clip;
  if (!clip || clip.kind === "audio" || !grow) return 0;
  let box = boxMemo.get(clip);
  if (!box) boxMemo.set(clip, (box = { height: clipBox(doc, clip).height }));
  const t = clip.transform;
  const sy = Math.abs(t.scaleY ?? t.scale);
  return -box.height * (1 - (t.anchor?.y ?? 0.5)) * grow * sy;
}

/** Fold a write onto a value. */
export function applyBehaviorWrite(own: KeyframeValue | undefined, w: BehaviorWrite): number {
  const v = typeof own === "number" ? own : w.mode === "multiply" ? 1 : 0;
  return w.mode === "multiply" ? v * w.value : v + w.value;
}
