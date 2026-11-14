import { propertyDef } from "../animation/properties";
import { channelValueAt } from "../animation/channels";
import { getClipProperty } from "../animation/paths";
import { BONE_PATH } from "../rig/fields";
import { limitChannel, type BoneChannel } from "../rig/pose";
import { poseOwnerOf } from "../rig/poses";
import { locateClip } from "../timeline/ops";
import type { MotionDocument, Clip, KeyframeValue } from "../schema";
import { cleanSamples, reduceDiscreteSamples, reduceSamplesToKeys, splitRuns, unwrapDegrees, type FrameGrid } from "./reduce";
import { punchIn } from "./punch";
import { resolveTriggers, type TriggerEvent, type TriggerMode } from "./triggers";

/**
 * A TAKE, written: the one document writer behind the Perform mode and the
 * `perform.take` verb. Samples are clip-local ms on the playback clock.
 *
 * - Runs: a take that crossed a loop wrap is several passes; each is reduced
 *   and punched in, in order, so the last pass over a range wins.
 * - Channels sampled together share key times (x and y stay motion pairs).
 * - Numbers go through `reduceSamplesToKeys`; anything else (a switch member,
 *   a pose name, a bool) keys where it changes.
 * - Values are written inside the channel's limits (a bone's limits, the
 *   property's min/max), so a key never holds what the channel cannot take.
 * - A path a pose set owns refuses its own keys (ADR-characters amendment 5):
 *   perform the set (`pose.<set>` on the group) instead.
 *
 * Mutates; call inside ONE document update — one take, one undo step.
 */

export interface TakeSample {
  t: number;
  /** One value per path, in `paths` order. */
  v: readonly KeyframeValue[];
}

export interface TakeOptions {
  /** Max error of the played-back curve, in each channel's units. Default: 0.5% of the take's range, at least 0.01. */
  tolerance?: number | readonly number[];
  /** Gaussian smoothing of the hand (σ, ms). */
  smoothMs?: number;
  /** The comp's frame step: keys land on frames, and the guard is one frame. */
  stepMs?: number;
}

export interface TakeResult {
  /** Keys written per path. */
  keys: Record<string, number>;
  /** Passes (more than one when the take crossed a loop wrap). */
  runs: number;
  /** [from, to] of the whole take, clip-local. */
  span: [number, number] | null;
}

export class TakeRefused extends Error {}

const ROTATIONS = new Set(["rotation", "rotationX", "rotationY"]);

/** The clamp a channel's writes obey. */
function clampFor(clip: Clip, path: string): (v: number) => number {
  const bone = BONE_PATH.exec(path);
  if (bone && clip.kind === "group" && clip.rig) {
    const b = clip.rig.bones.find((x) => x.id === bone[1]);
    const ch = bone[2] as BoneChannel;
    if (b) return (v) => limitChannel(b, ch, v);
  }
  const def = propertyDef(path);
  const lo = def?.min ?? -Infinity, hi = def?.max ?? Infinity;
  return (v) => (v < lo ? lo : v > hi ? hi : v);
}

function isRotation(path: string): boolean {
  const last = path.slice(path.lastIndexOf(".") + 1);
  return ROTATIONS.has(last);
}

/** Is this path's take numeric (eased) or discrete (held)? */
function numericChannel(path: string, samples: readonly TakeSample[], i: number): boolean {
  if (propertyDef(path)?.kind === "discrete") return false;
  return samples.every((s) => typeof s.v[i] === "number" && Number.isFinite(s.v[i] as number));
}

function assertOwnPath(doc: MotionDocument, clip: Clip, path: string): void {
  const owner = poseOwnerOf(doc, clip.id, path);
  if (owner) throw new TakeRefused(`"${path}" on "${clip.name}" is set by a pose set — perform pose.${owner.setId} on the character instead.`);
}

export function recordTake(
  doc: MotionDocument,
  clipId: string,
  paths: readonly string[],
  samples: readonly TakeSample[],
  opts: TakeOptions = {},
): TakeResult {
  const clip = locateClip(doc, clipId)?.clip;
  if (!clip) throw new TakeRefused(`No layer "${clipId}".`);
  for (const p of paths) assertOwnPath(doc, clip, p);
  const grid: FrameGrid | undefined = opts.stepMs ? { stepMs: opts.stepMs, originMs: -clip.startMs } : undefined;
  const out: TakeResult = { keys: Object.fromEntries(paths.map((p) => [p, 0])), runs: 0, span: null };
  const valid = samples.filter((s) => Number.isFinite(s.t) && s.v.length >= paths.length);
  if (!valid.length) return out;
  const runs = splitRuns(valid);
  out.runs = runs.length;
  const numeric = paths.map((p, i) => numericChannel(p, valid, i));
  const clamps = paths.map((p) => clampFor(clip, p));
  // What each channel showed before the take touched it — the guard's value.
  const base = paths.map((p) => getClipProperty(clip, p));
  const hadKeys = paths.map((p) => clip.keyframes.some((t) => t.property === p && !t.range && t.keys.length > 0));
  const guardMs = opts.stepMs ?? 0;

  for (const raw of runs) {
    const run = cleanSamples(raw, grid);
    if (!run.length) continue;
    const from = run[0]!.t, to = run[run.length - 1]!.t;
    out.span = out.span ? [Math.min(out.span[0], from), Math.max(out.span[1], to)] : [from, to];

    // Numbers: reduced jointly.
    const numIdx = paths.map((_, i) => i).filter((i) => numeric[i]);
    if (numIdx.length) {
      const cols = numIdx.map((i) => {
        const col = run.map((s) => s.v[i] as number);
        return (isRotation(paths[i]!) ? unwrapDegrees(col) : col).map(clamps[i]!);
      });
      const tol = opts.tolerance ?? cols.map((c) => Math.max(0.01, (Math.max(...c) - Math.min(...c)) * 0.005));
      const keys = reduceSamplesToKeys(
        run.map((s, j) => ({ t: s.t, v: cols.map((c) => c[j]!) })),
        Array.isArray(tol) ? numIdx.map((i, k) => (tol as number[])[k] ?? (tol as number[])[i] ?? 0.5) : tol,
        { smoothMs: opts.smoothMs },
      );
      numIdx.forEach((i, k) => {
        const path = paths[i]!;
        const r = punchIn(clip.keyframes, path, from, to, keys.map((key) => ({ t: key.t, v: key.v[k]!, easing: key.easing[k] })), {
          guardMs: hadKeys[i] ? 0 : guardMs,
          baseValue: base[i],
        });
        out.keys[path]! += r.added;
        hadKeys[i] = true;
      });
    }
    // Discrete: a key where it changes.
    paths.forEach((path, i) => {
      if (numeric[i]) return;
      const keys = reduceDiscreteSamples(run.map((s) => ({ t: s.t, v: s.v[i]! })));
      const r = punchIn(clip.keyframes, path, from, to, keys, { guardMs: hadKeys[i] ? 0 : guardMs, baseValue: base[i] });
      out.keys[path]! += r.added;
      hadKeys[i] = true;
    });
  }
  return out;
}

/**
 * A TRIGGER take on one discrete channel (a switch, `pose.<set>`): events from
 * keys or pad buttons, resolved by `resolveTriggers` against what the channel
 * showed before the take, then written. Latch adds keys at presses; touch
 * replaces each held span.
 */
export function recordTriggerTake(
  doc: MotionDocument,
  clipId: string,
  path: string,
  events: readonly TriggerEvent[],
  mode: TriggerMode,
  opts: { stepMs?: number; loop?: { startMs: number; endMs: number } } = {},
): TakeResult {
  const clip = locateClip(doc, clipId)?.clip;
  if (!clip) throw new TakeRefused(`No layer "${clipId}".`);
  assertOwnPath(doc, clip, path);
  const snap = (t: number) => (opts.stepMs ? Math.round((t + clip.startMs) / opts.stepMs) * opts.stepMs - clip.startMs : t);
  // Resolved in full BEFORE anything is written, so "what showed before" reads the untouched channel.
  const restAt = (t: number) => channelValueAt(clip, path, t);
  const res =resolveTriggers(events.map((e) => ({ ...e, t: snap(e.t) })), mode, restAt, opts.loop ? { loop: opts.loop } : {});
  const out: TakeResult = { keys: { [path]: 0 }, runs: 1, span: null };
  if (!res.keys.length) return out;
  const base = getClipProperty(clip, path);
  const fresh = !clip.keyframes.some((t) => t.property === path && !t.range && t.keys.length > 0);
  for (const [a, b] of res.clear) punchIn(clip.keyframes, path, a, b, [], {});
  const guard = fresh ? (opts.stepMs ?? 0) : 0;
  // Each key replaces any key at its own instant; nothing else is touched.
  const ts = res.keys.map((k) => k.t);
  out.span = [Math.min(...ts), Math.max(...ts)];
  let first = true;
  for (const k of res.keys) {
    const r = punchIn(clip.keyframes, path, k.t, k.t, [{ t: k.t, v: k.v }], first ? { guardMs: guard, baseValue: base } : {});
    first = false;
    out.keys[path]! += r.added;
  }
  return out;
}
