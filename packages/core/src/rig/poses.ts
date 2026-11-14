import type { MotionDocument, Clip, GroupClip, KeyframeValue, Pose, PoseBlend, PoseSet } from "../schema";
import type { ExprContext } from "../expressions/globals";
import { applyBehaviorWrite, behaviorChannelWrites, behaviorsChoiceAt, type BehaviorWrite } from "../behaviors/evaluate";
import { isGeometryValue } from "../schema";
import { evaluateEasing } from "../easing";
import { lerpKeyframeValue, sampleKeyframeTrack } from "../animation/keyframes";
import { parseHexColor, propertyDef } from "../animation/properties";
import { channelValueAt } from "../animation/channels";
import { setClipProperty } from "../animation/paths";
import { compFps, frameStepMs } from "../timeline/fps";
import { isSettledDocument } from "../timeline/settled";
import { resolvePoseName } from "./vocabulary";
import { BONE_PATH } from "./fields";
import { KEY_PATH } from "../shape-keys/fields";

/**
 * POSEMIX — what a pose set looks like at an instant (ADR-characters,
 * "PoseSet"; amendments 3–6).
 *
 * DERIVED, NEVER STORED. The set's channel `pose.<setId>` says which pose is
 * wanted; this module looks back over the blend window, at the comp's frame
 * resolution, for the latest changes of that wanted pose — keys, an expression,
 * a machine, lip sync all look alike, because each is just "the name at t'" —
 * and eases from what was showing toward the new pose:
 *
 *   value(t) = lerp(…lerp(lerp(P₀, P₁, e₁), P₂, e₂)…, Pₙ, eₙ)
 *
 * where Pᵢ is the pose wanted after the i-th change in the window and
 * eᵢ = ease((t − cᵢ) / blend). P₀ is whatever was wanted at the window's start
 * (or the group's start): held, fully weighted. A pure function of t, so a
 * scrub backward equals a scrub forward and an export equals the preview.
 *
 *  - Floats, colours and outlines blend by that chain (`lerpKeyframeValue`, the
 *    one blend rule keys use).
 *  - DISCRETE values (a switch, text, a flag) take the NEWEST pose at the START
 *    of its blend: a mouth's drawings swap on the sound, never 120 ms late.
 *  - A pose that does not name a path the set owns leaves it at its UNDERLYING
 *    value (its own keys/base), so a "Squint" that only moves the lids blends
 *    the lids alone.
 *  - Bone channels and shape-key weights are LAYERS (`poseComposeOf`): the
 *    pose adds to what you posed by hand instead of replacing it.
 *
 * APPLYING is part of the bake (`resolvedDocAt`, drivers → PoseMix → shape
 * keys → relations → physics): every value is written with `setClipProperty`
 * and the member's key track for that path is DROPPED — the driver rule
 * (`resolve-clip.ts`), and the reason a 3D `bakeClipAt` cannot re-sample a key
 * over the pose. On a layered path that track is read FIRST: it is your layer.
 */

// ── Resolving a wanted name to a pose ────────────────────────────────────────

/**
 * The pose a channel value shows. A string is a pose id or NAME (case- and
 * punctuation-insensitive, aliases, then the vocabulary's fallbacks); a number
 * or flag counts from the first pose; anything unmatched shows the FIRST pose.
 * Null only for an empty set.
 */
export function resolvePose(set: PoseSet, wanted: KeyframeValue | null | undefined): Pose | null {
  const poses = set.poses;
  if (!poses.length) return null;
  const at = (n: number) => poses[Math.max(0, Math.min(poses.length - 1, Math.round(n)))]!;
  if (typeof wanted === "number") return Number.isFinite(wanted) ? at(wanted) : poses[0]!;
  if (typeof wanted === "boolean") return at(wanted ? 1 : 0);
  if (typeof wanted === "string" && wanted !== "") {
    const byId = poses.find((p) => p.id === wanted);
    if (byId) return byId;
    const name = resolvePoseName(set.vocabulary, wanted, poses.map((p) => p.name));
    if (name !== null) return poses.find((p) => p.name === name)!;
    if (/^-?\d+(\.\d+)?$/.test(wanted.trim())) return at(Number(wanted));
  }
  return poses[0]!;
}

// ── The mix ──────────────────────────────────────────────────────────────────

export interface PoseMixStep {
  /** The pose id wanted from `atMs` on. */
  pose: string;
  /** When it became wanted (the first sample that saw it); the oldest step's is the window start. */
  atMs: number;
  /** Its eased progress toward full weight (the oldest step is 1). May overshoot with a back ease. */
  t: number;
}

export interface PoseMix {
  /** The newest wanted pose — what a discrete value shows. */
  target: string;
  /** Oldest first; folded by `lerp(acc, step, step.t)`. One step = settled. */
  chain: PoseMixStep[];
  /** Each pose's share of the look (summing to 1; overshoot not clamped). */
  weights: Map<string, number>;
}

/**
 * The mix at `t`. `nameAt(t')` answers the wanted pose ID at any instant (the
 * caller resolves names, so an alias is not a change). Samples `t`, then the
 * frame grid below it (multiples of `stepMs`) back to one step at or before
 * `t − blend.ms`, never before `floorMs` (the group's start) — so at the very
 * first frame there is nothing to blend from.
 */
export function poseMixAt(
  nameAt: (t: number) => string,
  t: number,
  blend: PoseBlend,
  stepMs: number,
  floorMs = 0,
  /** The blend for one change, `from` → `to` (pose ids); absent = `blend` for all. */
  pairBlend?: (from: string, to: string) => PoseBlend,
  /** The longest blend `pairBlend` can answer — how far back to look. */
  windowMs = blend.ms,
): PoseMix {
  const now = nameAt(t);
  if (blend.mode === "swap" && !pairBlend) return settled(now, t);
  if (!(windowMs > 0) || !(stepMs > 0) || t <= floorMs) return settled(now, t);
  const times = [t];
  // Grid instants by FRAME INDEX (k·step, a whole ms when it is one within
  // 1e-6) — never by repeated subtraction, which drifted 600 − 3·(1000/30) to
  // 499.99999… and read a pose key at 500 ms, on frame 15, one frame late
  // (the blend started a frame behind).
  const at = (k: number) => {
    const g = k * stepMs;
    const whole = Math.round(g);
    return Math.abs(g - whole) < 1e-6 ? whole : g;
  };
  let k = Math.floor(t / stepMs + 1e-6);
  if (at(k) > t - 1e-6) k--;
  for (;;) {
    const g = at(k);
    if (g <= floorMs) {
      if (times[times.length - 1]! > floorMs) times.push(floorMs);
      break;
    }
    times.push(g);
    if (g <= t - windowMs) break;
    k--;
  }
  // Oldest → newest; a change is the first sample that sees a new pose.
  const names = times.map((s, i) => (i === 0 ? now : nameAt(s)));
  const chain: PoseMixStep[] = [{ pose: names[names.length - 1]!, atMs: times[times.length - 1]!, t: 1 }];
  for (let i = names.length - 2; i >= 0; i--) {
    if (names[i] === names[i + 1]) continue;
    const b = pairBlend ? pairBlend(names[i + 1]!, names[i]!) : blend;
    const p = b.mode === "swap" || !(b.ms > 0) ? 1 : Math.max(0, Math.min(1, (t - times[i]!) / b.ms));
    const e = evaluateEasing(b.ease, p);
    // A change a whole blend ago has fully landed: it restarts the chain.
    if (p >= 1) chain.splice(0, chain.length, { pose: names[i]!, atMs: times[i]!, t: 1 });
    else chain.push({ pose: names[i]!, atMs: times[i]!, t: e });
  }
  return { target: now, chain, weights: weightsOf(chain) };
}

function settled(pose: string, t: number): PoseMix {
  return { target: pose, chain: [{ pose, atMs: t, t: 1 }], weights: new Map([[pose, 1]]) };
}

function weightsOf(chain: PoseMixStep[]): Map<string, number> {
  const w = new Map<string, number>();
  for (let i = 0; i < chain.length; i++) {
    let share = chain[i]!.t;
    for (let j = i + 1; j < chain.length; j++) share *= 1 - chain[j]!.t;
    w.set(chain[i]!.pose, (w.get(chain[i]!.pose) ?? 0) + share);
  }
  return w;
}

// ── How a pose meets what you posed by hand ──────────────────────────────────

/**
 * POSES ARE LAYERS ON TOP OF YOUR OWN VALUES — never a lock on them.
 *
 * A bone channel is a DELTA from where the bone was drawn and a shape key is a
 * WEIGHT over the base shape: both have an identity, so a pose can be measured
 * from it and ADDED to whatever the part already holds (a stretch multiplies).
 * Moho's smart bones and Spine's additive tracks are the same rule. Choosing a
 * pose then changes only that pose's contribution, and a bone you dragged —
 * keyed or not — keeps its own turn on top. Nothing a click does can erase a
 * customisation, which is how new poses get invented.
 *
 * A path with no identity to measure from — a switch's drawing, a colour, a
 * member's own placement — is the pose's outright (`own`), as before.
 */
export type PoseCompose = "add" | "scale" | "own";

const ADDITIVE_BONE = new Set(["x", "y", "z", "rotation", "rotationX", "rotationY"]);
const SCALING_BONE = new Set(["scale", "scaleY", "scaleZ"]);

export function poseComposeOf(path: string): PoseCompose {
  const bone = BONE_PATH.exec(path);
  if (bone) return ADDITIVE_BONE.has(bone[2]!) ? "add" : SCALING_BONE.has(bone[2]!) ? "scale" : "own";
  return KEY_PATH.test(path) ? "add" : "own";
}

/** The value a layered path holds when nothing poses it. */
function identityOf(compose: Exclude<PoseCompose, "own">): number {
  return compose === "add" ? 0 : 1;
}

// ── What a set owns, and the blended values ──────────────────────────────────

/** Every (clip, path) any pose of the set names, once each, in first-seen order. */
export function posePathsOf(set: PoseSet): Array<{ clipId: string; path: string }> {
  const seen = new Set<string>();
  const out: Array<{ clipId: string; path: string }> = [];
  for (const p of set.poses)
    for (const v of p.values) {
      const k = `${v.clipId}\u0000${v.path}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ clipId: v.clipId, path: v.path });
    }
  return out;
}

function blendable(path: string, a: KeyframeValue, b: KeyframeValue): boolean {
  if (propertyDef(path)?.kind === "discrete") return false;
  if (typeof a === "number" && typeof b === "number") return true;
  if (typeof a === "string" && typeof b === "string") return !!parseHexColor(a) && !!parseHexColor(b);
  return isGeometryValue(a) && isGeometryValue(b);
}

/**
 * The values a set writes under `mix`: one per path that some pose in the
 * chain names. On a LAYERED path (`poseComposeOf`) a value is the set's
 * contribution, and a pose that leaves the path alone contributes nothing (the
 * identity). On an owned path `underlying(clipId, path)` — the path's own keys
 * or base — is what a pose that leaves it alone shows.
 */
export function blendPoseValues(
  set: PoseSet,
  mix: PoseMix,
  underlying: (clipId: string, path: string) => KeyframeValue | undefined,
): Array<{ clipId: string; path: string; value: KeyframeValue; compose: PoseCompose }> {
  const byId = new Map(set.poses.map((p) => [p.id, p]));
  const valueIn = (poseId: string, clipId: string, path: string) =>
    byId.get(poseId)?.values.find((v) => v.clipId === clipId && v.path === path)?.value;
  const out: Array<{ clipId: string; path: string; value: KeyframeValue; compose: PoseCompose }> = [];
  for (const { clipId, path } of posePathsOf(set)) {
    if (!mix.chain.some((s) => valueIn(s.pose, clipId, path) !== undefined)) continue;
    const compose = poseComposeOf(path);
    let base: KeyframeValue | undefined;
    let baseRead = false;
    const at = (poseId: string): KeyframeValue | undefined => {
      const own = valueIn(poseId, clipId, path);
      if (own !== undefined) return own;
      if (compose !== "own") return identityOf(compose);
      if (!baseRead) {
        base = underlying(clipId, path);
        baseRead = true;
      }
      return base;
    };
    const target = at(mix.target);
    let acc = at(mix.chain[0]!.pose);
    let discrete = false;
    for (let i = 1; i < mix.chain.length && acc !== undefined; i++) {
      const next = at(mix.chain[i]!.pose);
      if (next === undefined) continue;
      if (!blendable(path, acc, next)) {
        discrete = true;
        break;
      }
      acc = lerpKeyframeValue(path, acc, next, mix.chain[i]!.t);
    }
    const value = discrete || propertyDef(path)?.kind === "discrete" ? target : acc;
    if (value !== undefined) out.push({ clipId, path, value, compose });
  }
  return out;
}

// ── Reading the wanted pose at any instant (RAW, never the bake) ─────────────

export interface PoseEnv {
  /**
   * Re-run the ONE driver on a `pose.<set>` channel at comp time `compMs`
   * (amendment 6: under `withExpressionContext(makeExprContext(raw, t', …))`,
   * never `resolvedDocAt(t')`). Hosts pass core `poseDriverAt`; absent = keys
   * and base only (`keysOnlyPoseDriver`).
   */
  driverAt?: (group: GroupClip, path: string, token: string, compMs: number) => KeyframeValue | undefined;
  /** A pose id shown outright, no blend (the Face pad's hover preview); undefined = the set's own choice. */
  force?: (groupId: string, setId: string) => string | undefined;
  /**
   * The expression context at comp time — what behaviors read through an
   * instance (its Voice input, its seed, its machines). Hosts pass the bake's
   * (core `poseEnvAt`); absent = headless (`behaviors/evaluate.ts`).
   */
  contextAt?: (compMs: number) => ExprContext | null;
}

/** The CHARACTER a clip belongs to: itself or its nearest enclosing group that has a rig or pose sets. */
export function characterOf(doc: MotionDocument, clipId: string): GroupClip | null {
  let clip: Clip | undefined;
  let groupId: string | null = null;
  for (const t of doc.tracks) {
    const c = t.clips.find((x) => x.id === clipId);
    if (c) {
      clip = c;
      groupId = t.groupId ?? null;
      break;
    }
  }
  if (!clip) return null;
  if (clip.kind === "group" && (clip.rig || clip.poses?.length || clip.behaviors?.length)) return clip;
  const seen = new Set<string>();
  while (groupId && !seen.has(groupId)) {
    seen.add(groupId);
    let next: string | null = null;
    for (const t of doc.tracks) {
      const g = t.clips.find((x) => x.id === groupId);
      if (!g) continue;
      if (g.kind === "group" && (g.rig || g.poses?.length || g.behaviors?.length)) return g;
      next = t.groupId ?? null;
      break;
    }
    groupId = next;
  }
  return null;
}

/** Where a set's wanted pose came from at an instant. */
export type PoseChoiceSource = "keys" | "base" | "driver" | "behavior";

export interface PoseWant {
  /** The wanted value — a pose name or id (an alias, a viseme), resolved by `resolvePose`. */
  value: KeyframeValue;
  source: PoseChoiceSource;
  /** The behavior that decided it (source `behavior`). */
  behaviorId?: string;
  /** A person's override on that behavior decided it. */
  overridden?: boolean;
  /** Which override (`BehaviorOverride.id`). */
  overrideId?: string;
}

/**
 * THE ONE READER of which pose a set wants at comp time (ADR-characters-3,
 * "Evaluation"): your keys on `pose.<set>`, else its base; a legacy driver
 * over that (it can read them as `#value`); then every enabled behavior on the
 * set, in stack order, wherever it is active — overrides applied. RAW: the
 * keys and driver token on the group as stored, never a bake, so the PoseMix
 * look-back can ask it at any earlier instant.
 */
export function poseChoiceAt(doc: MotionDocument, group: GroupClip, set: PoseSet, compMs: number, env: PoseEnv = {}): PoseWant {
  const path = `pose.${set.id}`;
  let out: PoseWant = { value: set.show, source: "base" };
  const track = group.keyframes.find((k) => k.property === path && !k.range && k.keys.length > 0);
  if (track) {
    const v = sampleKeyframeTrack(track, compMs - group.startMs);
    if (v !== undefined) out = { value: v, source: "keys" };
  }
  const token = group.drivers?.[path];
  if (token) {
    const v = (env.driverAt ?? keysOnlyPoseDriver)(group, path, token, compMs);
    if (v !== undefined && typeof v !== "object") out = { value: v, source: "driver" };
  }
  if (group.behaviors?.length) {
    const b = behaviorsChoiceAt(doc, group, set, compMs, env);
    if (b) out = { value: b.value, source: "behavior", behaviorId: b.behavior.id, overridden: b.overridden, ...(b.overrideId ? { overrideId: b.overrideId } : {}) };
  }
  return out;
}

/** The raw wanted value of a set's channel at comp time (`poseChoiceAt`'s value). */
export function poseChannelAt(doc: MotionDocument, group: GroupClip, set: PoseSet, compMs: number, env: PoseEnv = {}): KeyframeValue {
  return poseChoiceAt(doc, group, set, compMs, env).value;
}

/**
 * No driver evaluation: the channel's keys, else its base. Only for callers
 * that hold no bake (pure unit maths) — every real host passes the bake's own
 * reader, `poseDriverAt` (core `evaluate/`), so a set driven by lip sync, a
 * machine, an input or a node graph answers as it does on the canvas.
 */
export const keysOnlyPoseDriver: NonNullable<PoseEnv["driverAt"]> = () => undefined;

/** `nameAt` for `poseMixAt`: the wanted pose's ID at comp time (resolved, so aliases are not changes). */
export function poseNameReader(doc: MotionDocument, group: GroupClip, set: PoseSet, env: PoseEnv = {}): (compMs: number) => string {
  return (t) => resolvePose(set, poseChannelAt(doc, group, set, t, env))?.id ?? "";
}

/** The pose a name or id in a transition means ("*" = any). */
function transitionMatches(set: PoseSet, ref: string, poseId: string): boolean {
  if (ref === "*" || ref === "") return true;
  const pose = set.poses.find((p) => p.id === poseId);
  return !!pose && (pose.id === ref || pose.name.toLowerCase() === ref.toLowerCase());
}

/** The blend for one change of a set, `from` → `to` (pose ids): its most specific transition, else the set's own. */
export function poseBlendFor(set: PoseSet, from: string, to: string): PoseBlend {
  let best: PoseBlend = set.blend;
  let score = -1;
  for (const tr of set.transitions ?? []) {
    if (!transitionMatches(set, tr.from, from) || !transitionMatches(set, tr.to, to)) continue;
    const s = (tr.from !== "*" && tr.from !== "" ? 1 : 0) + (tr.to !== "*" && tr.to !== "" ? 1 : 0);
    if (s <= score) continue;
    score = s;
    best = { ms: tr.ms, ease: tr.ease ?? set.blend.ease, mode: tr.mode ?? set.blend.mode };
  }
  return best;
}

/** The mix of one set at comp time — what the bake applies and the Face pad rings. */
export function poseSetMixAt(doc: MotionDocument, group: GroupClip, set: PoseSet, compMs: number, env: PoseEnv = {}): PoseMix | null {
  if (!set.poses.length) return null;
  const stepMs = frameStepMs(compFps(doc, group.frameId));
  const nameAt = poseNameReader(doc, group, set, env);
  if (!set.transitions?.length) return poseMixAt(nameAt, compMs, set.blend, stepMs, group.startMs);
  const windowMs = Math.max(set.blend.mode === "swap" ? 0 : set.blend.ms, ...set.transitions.map((t) => (t.mode === "swap" ? 0 : t.ms)));
  return poseMixAt(nameAt, compMs, set.blend, stepMs, group.startMs, (a, b) => poseBlendFor(set, a, b), windowMs);
}

// ── Indexes (memoised on settled documents only) ─────────────────────────────

interface PoseIndex {
  groups: GroupClip[];
  /** `clipId \0 path` → the set that OWNS it outright (the last set to name it wins, as in the bake). Layered paths are nobody's. */
  owners: Map<string, { groupId: string; setId: string }>;
  /** `clipId \0 path` → every set that layers onto it, in bake order. */
  layers: Map<string, Array<{ groupId: string; setId: string }>>;
}

const indexMemo = new WeakMap<MotionDocument, PoseIndex | null>();

function poseIndex(doc: MotionDocument): PoseIndex | null {
  const settledDoc = isSettledDocument(doc);
  if (settledDoc && indexMemo.has(doc)) return indexMemo.get(doc)!;
  let out: PoseIndex | null = null;
  for (const track of doc.tracks)
    for (const clip of track.clips) {
      if (clip.kind !== "group" || (!clip.poses?.length && !clip.behaviors?.length)) continue;
      out ??= { groups: [], owners: new Map(), layers: new Map() };
      out.groups.push(clip);
      for (const set of clip.poses ?? [])
        for (const { clipId, path } of posePathsOf(set)) {
          const key = `${clipId}\u0000${path}`;
          const who = { groupId: clip.id, setId: set.id };
          if (poseComposeOf(path) === "own") out.owners.set(key, who);
          else {
            const list = out.layers.get(key);
            if (list) list.push(who);
            else out.layers.set(key, [who]);
          }
        }
    }
  if (settledDoc) indexMemo.set(doc, out);
  return out;
}

/** Does any group in this document carry a pose set or a behavior? The common project asks once and pays nothing more. */
export function documentHasPoses(doc: MotionDocument): boolean {
  return poseIndex(doc) !== null;
}

/**
 * The pose set that OWNS a clip's path outright — the field's "Pose" source —
 * or null. A layered path (a bone channel, a shape-key weight) is never owned:
 * it stays yours to key, drag and perform, and the poses add on top.
 */
export function poseOwnerOf(doc: MotionDocument, clipId: string, path: string): { groupId: string; setId: string } | null {
  return poseIndex(doc)?.owners.get(`${clipId}\u0000${path}`) ?? null;
}

/** The sets that layer onto a clip's path (empty when none). */
export function poseLayersOn(doc: MotionDocument, clipId: string, path: string): ReadonlyArray<{ groupId: string; setId: string }> {
  return poseIndex(doc)?.layers.get(`${clipId}\u0000${path}`) ?? [];
}

// ── The bake ─────────────────────────────────────────────────────────────────

/** One posed path at an instant: how it composes, and what each set brings. */
export interface PosedPath {
  clipId: string;
  path: string;
  compose: PoseCompose;
  /** Each set's blended value on the path, in bake order. Layered: its contribution. Owned: the value it shows. */
  sets: Array<{ groupId: string; setId: string; value: KeyframeValue }>;
}

/**
 * Every posed path in comp `compId` at comp time `compMs`, keyed
 * `clipId \0 path` — the one walk the bake, a drag over a posed bone and
 * "capture what it looks like" all read, so the three cannot disagree about
 * what a pose contributed.
 */
export function posedPathsAt(doc: MotionDocument, compMs: number, compId: string | null, env: PoseEnv = {}): Map<string, PosedPath> {
  const out = new Map<string, PosedPath>();
  const index = poseIndex(doc);
  if (!index) return out;
  let clipById: Map<string, Clip> | null = null;
  const find = (id: string): Clip | undefined => {
    if (!clipById) {
      clipById = new Map();
      for (const t of doc.tracks) for (const c of t.clips) clipById.set(c.id, c);
    }
    return clipById.get(id);
  };
  for (const group of index.groups) {
    if (compId && group.frameId !== compId) continue;
    if (compMs < group.startMs || compMs >= group.startMs + group.durationMs) continue;
    for (const set of group.poses ?? []) {
      const forced = env.force?.(group.id, set.id);
      const mix = forced && set.poses.some((p) => p.id === forced) ? settled(forced, compMs) : poseSetMixAt(doc, group, set, compMs, env);
      if (!mix) continue;
      const underlying = (clipId: string, path: string) => {
        const c = find(clipId);
        return c ? channelValueAt(c, path, compMs - c.startMs) : undefined;
      };
      for (const w of blendPoseValues(set, mix, underlying)) {
        if (!find(w.clipId)) continue;
        const key = `${w.clipId}\u0000${w.path}`;
        let p = out.get(key);
        if (!p) out.set(key, (p = { clipId: w.clipId, path: w.path, compose: w.compose, sets: [] }));
        p.sets.push({ groupId: group.id, setId: set.id, value: w.value });
      }
    }
  }
  return out;
}

/**
 * What a posed path SHOWS over your own value `own` (its keys or base): your
 * value plus every set's contribution (a stretch multiplies), or — owned — the
 * last set's value. `except` leaves one set out (what the others bring).
 */
export function composePosed(p: PosedPath, own: KeyframeValue | undefined, except?: string): KeyframeValue | undefined {
  const sets = except ? p.sets.filter((s) => s.setId !== except) : p.sets;
  if (p.compose === "own") return sets.length ? sets[sets.length - 1]!.value : own;
  let acc = typeof own === "number" ? own : identityOf(p.compose);
  for (const s of sets) {
    if (typeof s.value !== "number") continue;
    acc = p.compose === "add" ? acc + s.value : acc * s.value;
  }
  return acc;
}

/**
 * The value YOUR layer needs for a layered path to SHOW `shown` — the inverse
 * of `composePosed`, so dragging a posed bone puts it under your hand and the
 * pose stays underneath. Null for an owned path (the pose decides it) or a
 * stretch a pose has squashed to nothing.
 */
export function ownValueShowing(p: PosedPath, shown: number, except?: string): number | null {
  if (p.compose === "own") return null;
  let layer = identityOf(p.compose);
  for (const s of p.sets) {
    if (s.setId === except || typeof s.value !== "number") continue;
    layer = p.compose === "add" ? layer + s.value : layer * s.value;
  }
  if (p.compose === "add") return shown - layer;
  return Math.abs(layer) < 1e-9 ? null : shown / layer;
}

/**
 * Write every pose set's mix in comp `compId` at comp time `compMs` onto its
 * members: your own value with the poses layered on, or the pose's outright on
 * a path it owns. Untouched clips keep their identity; a document with no sets
 * is returned as is. `doc` is the bake so far (drivers applied); the look-back
 * reads each group's own keys and driver token, which the driver pass leaves
 * on the clip — pass `env.driverAt` built over the RAW document.
 */
export function applyPoseMixes(doc: MotionDocument, compMs: number, compId: string | null, env: PoseEnv = {}): MotionDocument {
  const index = poseIndex(doc);
  if (!index) return doc;
  const posed = posedPathsAt(doc, compMs, compId, env);
  const added = behaviorWritesAt(doc, index.groups, compMs, compId, env);
  if (posed.size === 0 && added.length === 0) return doc;
  const writes = new Map<string, Map<string, (c: Clip) => KeyframeValue | undefined>>();
  const slot = (clipId: string) => {
    let m = writes.get(clipId);
    if (!m) writes.set(clipId, (m = new Map()));
    return m;
  };
  for (const p of posed.values()) slot(p.clipId).set(p.path, (c) => composePosed(p, channelValueAt(c, p.path, compMs - c.startMs)));
  // Channel behaviors ADD onto whatever the path shows by now — your keys,
  // the poses on top — so breathing never fights a pose or a hand move.
  for (const w of added) {
    const m = slot(w.clipId);
    const under = m.get(w.path);
    m.set(w.path, (c) => applyBehaviorWrite(under ? under(c) : channelValueAt(c, w.path, compMs - c.startMs), w));
  }
  let changedAny = false;
  const tracks = doc.tracks.map((track) => {
    if (!track.clips.some((c) => writes.has(c.id))) return track;
    changedAny = true;
    return {
      ...track,
      clips: track.clips.map((c) => {
        const w = writes.get(c.id);
        if (!w) return c;
        // Every value is read off the clip as it CAME (your keys, your base)
        // before any is written, then written once: one writer per path.
        const values = [...w].map(([path, read]) => [path, read(c)] as const);
        const next = structuredClone(c);
        for (const [path, value] of values) if (value !== undefined) setClipProperty(next, path, value);
        // A surviving track would re-sample over the result (3D `bakeClipAt`).
        next.keyframes = next.keyframes.filter((k) => k.range || !w.has(k.property));
        return next;
      }),
    };
  });
  return changedAny ? { ...doc, tracks } : doc;
}

/** Every channel write the behaviors of the comp's characters make at comp time. */
function behaviorWritesAt(doc: MotionDocument, groups: readonly GroupClip[], compMs: number, compId: string | null, env: PoseEnv): BehaviorWrite[] {
  const out: BehaviorWrite[] = [];
  for (const g of groups) {
    if (!g.behaviors?.length) continue;
    if (compId && g.frameId !== compId) continue;
    if (compMs < g.startMs || compMs >= g.startMs + g.durationMs) continue;
    for (const w of behaviorChannelWrites(doc, g, compMs, env)) out.push(w);
  }
  return out;
}
