import type { MotionDocument, Clip, KeyframeValue } from "../schema";
import { switchOptions } from "../timeline/switch";
import { posePathsOf } from "../rig/poses";

/**
 * TRIGGERS — keys (or on-screen buttons) that set a discrete channel live.
 *
 * Two modes, named as the person sees them:
 *
 *   LATCH  press = key that value at the press. Release does nothing; the
 *          value stays until the next press. (Character Animator's latch.)
 *   TOUCH  "records only while held": press = key the value; release = key
 *          back what showed BEFORE the press. Holds stack — press 2 while
 *          holding 1, let go of 2 and 1 shows again; let go of both and the
 *          rest value returns. A held span replaces any keys under it (your
 *          hand covered it); a latch only adds keys at its presses.
 *
 * The transport may WRAP while a key is held (a loop). The span is cut at the
 * loop's end and resumed at its start, so a hold never becomes a key that runs
 * backwards in time.
 *
 * Pure: the caller says what showed before (`restAt`, read from the channel as
 * it was), and applies `{ keys, clear }` with `punchIn`.
 */

export type TriggerMode = "latch" | "touch";

export interface TriggerEvent {
  /** Clip-local ms on the playback clock, in the order they happened. */
  t: number;
  kind: "down" | "up";
  /** The value this trigger keys — a switch member's name, a pose name. */
  value: KeyframeValue;
}

export interface TriggerResult {
  keys: Array<{ t: number; v: KeyframeValue }>;
  /** Spans a TOUCH hold covered — their old keys are replaced. */
  clear: Array<[number, number]>;
}

export interface TriggerOptions {
  /** The loop the transport wraps in (clip-local), when it loops. */
  loop?: { startMs: number; endMs: number };
}

export function resolveTriggers(
  events: readonly TriggerEvent[],
  mode: TriggerMode,
  restAt: (t: number) => KeyframeValue | undefined,
  opts: TriggerOptions = {},
): TriggerResult {
  const keys: TriggerResult["keys"] = [];
  const clear: TriggerResult["clear"] = [];
  const put = (t: number, v: KeyframeValue) => {
    const same = keys.findIndex((k) => Math.abs(k.t - t) < 0.5);
    if (same >= 0) keys.splice(same, 1);
    keys.push({ t, v });
  };
  if (mode === "latch") {
    for (const e of events) if (e.kind === "down") put(e.t, e.value);
    keys.sort((a, b) => a.t - b.t);
    return { keys, clear };
  }

  // TOUCH: a stack of held values over a rest value.
  const held: KeyframeValue[] = [];
  let rest: KeyframeValue | undefined;
  let spanStart = 0;
  let last = -Infinity;
  const showing = () => (held.length ? held[held.length - 1] : rest);
  for (const raw of events) {
    const t = raw.t;
    if (t < last - 1e-6 && held.length && opts.loop) {
      // Wrapped while held: close the span at the loop's end, reopen at its start.
      clear.push([spanStart, opts.loop.endMs]);
      const r = rest;
      if (r !== undefined) put(opts.loop.endMs, r);
      spanStart = opts.loop.startMs;
      const v = showing();
      if (v !== undefined) put(opts.loop.startMs, v);
    }
    last = t;
    if (raw.kind === "down") {
      if (!held.length) {
        rest = restAt(t);
        spanStart = t;
      }
      held.push(raw.value);
      put(t, raw.value);
    } else {
      const i = held.lastIndexOf(raw.value);
      if (i < 0) continue;
      const wasTop = i === held.length - 1;
      held.splice(i, 1);
      if (!held.length) {
        clear.push([spanStart, t]);
        if (rest !== undefined) put(t, rest);
      } else if (wasTop) {
        put(t, held[held.length - 1]!);
      }
    }
  }
  // Still held when the take ended: the span runs to the last event.
  if (held.length && Number.isFinite(last)) clear.push([spanStart, last]);
  keys.sort((a, b) => a.t - b.t);
  return { keys, clear };
}

// ── What can be armed ───────────────────────────────────────────────────────

/**
 * An ARMABLE SET: one discrete channel and the named values it can take. A
 * switch group's members today; a pose set's poses (`pose.<setId>`) when that
 * lands — each family registers a provider, so the perform pad and the agent
 * verb never learn which one they are driving.
 */
export interface TriggerSet {
  /** The clip that owns the channel (the group). */
  clipId: string;
  path: string;
  label: string;
  /** The values, in pad order. */
  values: string[];
  /**
   * Channels this set OWNS (ADR-characters amendment 5: a path owned by a pose
   * set refuses its own keys). A set listed here hides any other set on that
   * channel — a switch run by a Mouth set is armed through the set.
   */
  supersedes?: Array<{ clipId: string; path: string }>;
}

export type TriggerSetProvider = (doc: MotionDocument, clip: Clip) => TriggerSet[];

const providers: TriggerSetProvider[] = [];

/** Register a family of armable sets. Returns an unregister. */
export function registerTriggerSets(provider: TriggerSetProvider): () => void {
  providers.push(provider);
  return () => {
    const i = providers.indexOf(provider);
    if (i >= 0) providers.splice(i, 1);
  };
}

/** A switch group's members, by name, top first. */
const switchSets: TriggerSetProvider = (doc, clip) => {
  if (clip.kind !== "group" || !clip.switch) return [];
  return [{ clipId: clip.id, path: "switch", label: clip.name, values: switchOptions(doc, clip.id).map((c) => c.name) }];
};

/**
 * A character's pose sets: `pose.<setId>` on the GROUP. A set owns the paths
 * its poses write (amendment 5), so a switch it drives is armed through it.
 */
const poseSets: TriggerSetProvider = (_doc, clip) => {
  if (clip.kind !== "group" || !clip.poses?.length) return [];
  return clip.poses.map((set) => ({
    clipId: clip.id,
    path: `pose.${set.id}`,
    label: set.name,
    values: set.poses.map((p) => p.name),
    supersedes: posePathsOf(set),
  }));
};

registerTriggerSets(poseSets);
registerTriggerSets(switchSets);

/**
 * Every set armable on these clips (a character group and its descendants),
 * with owned channels resolved: a set superseded by another is left out.
 */
export function triggerSetsOf(doc: MotionDocument, clips: readonly Clip[]): TriggerSet[] {
  const all: TriggerSet[] = [];
  for (const c of clips) for (const p of providers) all.push(...p(doc, c));
  const owned = new Set(all.flatMap((s) => (s.supersedes ?? []).map((o) => `${o.clipId}\u0000${o.path}`)));
  const seen = new Set<string>();
  return all.filter((s) => {
    const k = `${s.clipId}\u0000${s.path}`;
    if (owned.has(k) || seen.has(k)) return false;
    seen.add(k);
    return s.values.length > 0;
  });
}

/**
 * The perform keys, per set in order (UX spec §2.4): set 1 → 1…9 0, set 2 →
 * Q W E T Y U, set 3 → A S D F G, set 4 → Z X C V B. R, Space, Esc, comma,
 * period, Backspace and the arrows are never assigned.
 */
export const PERFORM_KEY_ROWS: readonly (readonly string[])[] = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["q", "w", "e", "t", "y", "u"],
  ["a", "s", "d", "f", "g"],
  ["z", "x", "c", "v", "b"],
];

/** The key for value `i` of set `setIndex`, or null when the row is full. */
export function performKeyFor(setIndex: number, i: number): string | null {
  return PERFORM_KEY_ROWS[setIndex]?.[i] ?? null;
}
