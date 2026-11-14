import type { MotionDocument, GroupClip, KeyframeTrack, PoseSet } from "../schema";
import { locateClip } from "../timeline/ops";
import { compFps, frameStepMs } from "../timeline/fps";
import { poseChoiceAt, resolvePose, type PoseEnv } from "./poses";
import { poseSetLiveSource } from "./pose-choice";
import { drivesSet } from "../behaviors/evaluate";
import { behaviorLabel } from "../behaviors/registry";

/**
 * A CHARACTER ON THE TIMELINE, AS ITS PERFORMANCE — one lane per pose set, a
 * block per stretch of one pose (docs/adr/characters/timeline-and-sidebar.md
 * §1, ADR-characters-3 "Blocks"). A PROJECTION, never stored: derived by the
 * one reader the bake uses (`poseChoiceAt`), so a block says exactly what the
 * canvas shows, and WHO decided it — your keys, the resting pose, a driver, or
 * a behavior (and whether a person overrode that behavior there).
 *
 * Keys and the base are read as KEYS — segments cost nothing however long the
 * film. Anything live (a behavior, a driver) is sampled on the comp's frame
 * grid, inside the range asked for (what is on screen).
 */

export type PoseBlockSource = "keyed" | "base" | "live";

export interface PoseBlock {
  /** Comp ms. `toMs` is exclusive. */
  fromMs: number;
  toMs: number;
  poseId: string;
  name: string;
  source: PoseBlockSource;
  /** Keyed: the GROUP-LOCAL time of the key that starts this block (the handle a drag moves). */
  keyMs?: number;
  /** Live from a behavior: its id. Absent on a live block = a driver (an expression, the node board). */
  behaviorId?: string;
  /** A person's override on that behavior decided this block. */
  overridden?: boolean;
  /** Which override — the block's identity through regeneration (a split makes two). */
  overrideId?: string;
}

export interface PoseLaneBehavior {
  id: string;
  type: string;
  label: string;
  enabled: boolean;
}

export interface PoseLane {
  setId: string;
  name: string;
  /** How the set is chosen: by keys you own, by its resting pose, or by something live. */
  mode: PoseBlockSource;
  /** The live driver's source (what to say on a hatched block), when a driver chooses it. */
  driver?: string;
  /** The behaviors that drive this set, in stack order. */
  behaviors: PoseLaneBehavior[];
  /** What SHOWS: your keys where nothing live speaks, a behavior's or a driver's blocks where it does. */
  blocks: PoseBlock[];
  /** Your keys (or the base) underneath, whatever is live on top — the handles a drag moves. */
  keys: PoseBlock[];
  /**
   * Where something live shows another pose than your keys (a blink over the
   * keyed eyes, a syllable over a held smile) — `blocks` minus `keys`.
   */
  overlays: PoseBlock[];
}

/** The keys that choose a set (its `pose.<set>` track), or null. */
export function poseKeyTrack(group: GroupClip, set: PoseSet): KeyframeTrack | null {
  return group.keyframes.find((k) => k.property === `pose.${set.id}` && !k.range && k.keys.length > 0) ?? null;
}

/** Comp-ms range intersected with the group's span. */
function spanOf(group: GroupClip, range?: { fromMs: number; toMs: number }): { from: number; to: number } {
  const from = Math.max(group.startMs, range?.fromMs ?? -Infinity);
  const to = Math.min(group.startMs + group.durationMs, range?.toMs ?? Infinity);
  return { from, to };
}

interface Sample {
  poseId: string;
  source: PoseBlockSource;
  behaviorId?: string;
  overridden?: boolean;
  overrideId?: string;
  /** Keyed: the key whose stretch this is — two keys of one pose stay two blocks. */
  keyMs?: number;
}

/** Runs of one sample over comp time, on the frame grid. */
function sampledBlocks(set: PoseSet, from: number, to: number, stepMs: number, read: (t: number) => Sample): PoseBlock[] {
  const out: PoseBlock[] = [];
  // Grid instants by FRAME INDEX, snapped to a whole ms within 1e-6 — the
  // `poseMixAt` rule: 78 × (1000 / 30) is 2599.99999…, a hair before a cue
  // boundary at 2600, and would read the syllable before it.
  const grid = (k: number) => {
    const g = k * stepMs;
    return Math.abs(g - Math.round(g)) < 1e-6 ? Math.round(g) : g;
  };
  for (let k = Math.floor(from / stepMs + 1e-6); ; k++) {
    const t = grid(k);
    if (t >= to) break;
    const at = Math.max(from, t);
    const end = Math.min(to, grid(k + 1));
    const s = read(at);
    const last = out[out.length - 1];
    if (last && last.poseId === s.poseId && last.source === s.source && last.behaviorId === s.behaviorId && !!last.overridden === !!s.overridden && last.overrideId === s.overrideId && last.keyMs === s.keyMs) last.toMs = end;
    else
      out.push({
        fromMs: at,
        toMs: end,
        poseId: s.poseId,
        name: set.poses.find((p) => p.id === s.poseId)?.name ?? s.poseId,
        source: s.source,
        ...(s.behaviorId ? { behaviorId: s.behaviorId } : {}),
        ...(s.overridden ? { overridden: true } : {}),
        ...(s.overrideId ? { overrideId: s.overrideId } : {}),
        ...(s.keyMs !== undefined ? { keyMs: s.keyMs } : {}),
      });
  }
  return out;
}

/**
 * The lanes of a character over comp `range` (default: its whole span).
 * `envAt(t)` is the bake's pose env AT that instant (core `poseEnvAt(doc, t,
 * comp)`, which reads drivers, variables, voices and instance inputs there, as
 * the canvas does) — without it a live set reads headless (no drivers).
 * `only`: just that set's lane (a timeline row asks for its own).
 */
export function characterLanes(
  doc: MotionDocument,
  groupId: string,
  range?: { fromMs: number; toMs: number },
  envAt?: (compMs: number) => PoseEnv,
  only?: string,
): PoseLane[] {
  const group = locateClip(doc, groupId)?.clip;
  if (group?.kind !== "group" || !group.poses?.length) return [];
  const { from, to } = spanOf(group, range);
  const stepMs = frameStepMs(compFps(doc, group.frameId));
  const lanes: PoseLane[] = [];
  for (const set of group.poses) {
    if (!set.poses.length || (only && set.id !== only)) continue;
    const driver = poseSetLiveSource(doc, group, set);
    const token = group.drivers?.[`pose.${set.id}`];
    const behaviors = (group.behaviors ?? []).filter((b) => drivesSet(b, set, doc)).map((b) => ({ id: b.id, type: b.type, label: behaviorLabel(b), enabled: b.enabled !== false }));
    const track = poseKeyTrack(group, set);
    const live = !!driver || behaviors.some((b) => b.enabled);
    const lane: PoseLane = { setId: set.id, name: set.name, mode: live ? "live" : track ? "keyed" : "base", behaviors, blocks: [], keys: [], overlays: [] };
    if (driver) lane.driver = driver;
    const named = (id: string) => set.poses.find((p) => p.id === id)?.name ?? id;
    if (to > from) {
      // Your keys (or the base), read as keys: no driver, no behaviors.
      const bare = { ...group, drivers: undefined, behaviors: undefined } as GroupClip;
      const own = (t: number) => resolvePose(set, poseChoiceAt(doc, bare, set, t).value)?.id ?? "";
      if (!track) {
        const id = own(from);
        lane.keys = [{ fromMs: from, toMs: to, poseId: id, name: named(id), source: "base" }];
      } else {
        const keys = [...track.keys].sort((a, b) => a.timeMs - b.timeMs);
        for (let i = 0; i < keys.length; i++) {
          const start = i === 0 ? group.startMs : group.startMs + keys[i]!.timeMs;
          const end = i + 1 < keys.length ? group.startMs + keys[i + 1]!.timeMs : group.startMs + group.durationMs;
          const a = Math.max(from, start), b = Math.min(to, end);
          if (b <= a) continue;
          // The span before the first key holds it: the first block starts with the character.
          const id = own(Math.max(group.startMs + keys[i]!.timeMs, a));
          lane.keys.push({ fromMs: a, toMs: b, poseId: id, name: named(id), source: "keyed", keyMs: keys[i]!.timeMs });
        }
      }
      if (!token && !behaviors.length) lane.blocks = lane.keys;
      else {
        lane.blocks = sampledBlocks(set, from, to, stepMs, (t) => {
          const want = poseChoiceAt(doc, group, set, t, envAt?.(t) ?? {});
          const poseId = resolvePose(set, want.value)?.id ?? "";
          if (want.source === "keys") {
            const k = lane.keys.find((x) => x.fromMs <= t && t < x.toMs);
            return { poseId, source: "keyed", ...(k?.keyMs !== undefined ? { keyMs: k.keyMs } : {}) };
          }
          if (want.source === "base") return { poseId, source: "base" };
          return {
            poseId,
            source: "live",
            ...(want.behaviorId ? { behaviorId: want.behaviorId } : {}),
            ...(want.overridden ? { overridden: true } : {}),
            ...(want.overrideId ? { overrideId: want.overrideId } : {}),
          };
        });
        // Keyed stretches of the composite keep their key handle.
        for (const b of lane.blocks) {
          if (b.source !== "keyed") continue;
          const k = lane.keys.find((x) => x.fromMs <= b.fromMs && b.fromMs < x.toMs);
          if (k?.keyMs !== undefined) b.keyMs = k.keyMs;
        }
        lane.overlays = lane.blocks.filter((s) => s.source === "live" && s.poseId !== own(s.fromMs));
      }
    }
    lanes.push(lane);
  }
  return lanes;
}
