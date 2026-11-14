/**
 * AUDITIONING A LIBRARY OF SOUNDS — the headless half.
 *
 * Browsing sound is not browsing pictures. A grid of thumbnails is read in
 * parallel; a shelf of sounds is read in SERIES, one at a time, and the person
 * doing it is holding a queue in their head: this one, the next one, back to
 * the one before. That queue is a real piece of state with real rules, and it
 * had no home — every surface that ever played a preview kept its own `playing`
 * boolean and re-derived "what's next" from whatever array it happened to have.
 *
 * So the queue lives here, pure: which sound is armed, what `next` and `prev`
 * mean at the ends, what happens when one finishes, and — the part that is
 * genuinely interesting — WHAT TO WARM AHEAD.
 *
 * Nothing in this file knows about React, `AudioContext`, `fetch` or the
 * library client. It takes ids and numbers and returns ids and numbers, so the
 * browser binding, a test, and any future surface (a node, a plugin, the
 * desktop shell) all reason about a queue the same way.
 */

import { dbToGain } from "./envelope";

/* -------------------------------------------------------------------------- */
/* The queue                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What happens when a sound ends.
 *
 * `one` is the audition loop — the thing you hold on while deciding. `all`
 * walks the shelf hands-free, which is how you find a sound you cannot name.
 * `off` stops, because most of the time you are comparing two, not touring.
 */
export type AuditionLoop = "off" | "one" | "all";

export const AUDITION_LOOPS: readonly AuditionLoop[] = ["off", "one", "all"];

/**
 * The queue's whole state. `ids` is the list AS DISPLAYED — the same order the
 * rows are in, after search and sort — so "next" always means the row below,
 * whatever the filters currently say. Re-filtering while something plays
 * therefore changes what next means, which is the honest behaviour: the list
 * you can see is the list you are walking.
 */
export interface AuditionQueue {
  ids: readonly string[];
  /** The armed sound's index, or -1 when nothing is. */
  at: number;
  loop: AuditionLoop;
  /**
   * Consecutive auditions reached by ADVANCING (ended, next, prev) rather than
   * by clicking a row out of the blue. It is the only evidence available that
   * someone is working down a shelf instead of spot-checking one sound, and it
   * is what makes the preloader lean forward exactly as far as the listener is.
   */
  streak: number;
}

export function emptyQueue(loop: AuditionLoop = "off"): AuditionQueue {
  return { ids: [], at: -1, loop, streak: 0 };
}

/** The armed id, or null. */
export function auditionCurrent(q: AuditionQueue): string | null {
  return q.at >= 0 && q.at < q.ids.length ? q.ids[q.at]! : null;
}

/**
 * Point the queue at a list. The armed SOUND survives a re-sort or a re-filter
 * if it is still in the list — an index would not, and a list that keeps
 * playing sound A while highlighting row B is the bug this prevents.
 */
export function retarget(q: AuditionQueue, ids: readonly string[]): AuditionQueue {
  const id = auditionCurrent(q);
  const at = id ? ids.indexOf(id) : -1;
  // Dropping out of the list breaks the run: there is no row below a row that
  // is not there, so the next thing played is a fresh start, not step N+1.
  return { ...q, ids, at, streak: at === -1 ? 0 : q.streak };
}

/** Arm one sound by id — a deliberate click, so the run starts over at 1. */
export function playAt(q: AuditionQueue, id: string): AuditionQueue {
  const at = q.ids.indexOf(id);
  return at === -1 ? { ...q, at: -1, streak: 0 } : { ...q, at, streak: 1 };
}

/** Nothing armed. Stops the run. */
export function stopped(q: AuditionQueue): AuditionQueue {
  return { ...q, at: -1, streak: 0 };
}

/**
 * Step by ±1, wrapping. Wrapping rather than stopping at the ends because a
 * shelf is a ring you are scanning, not a document you are reading: hitting
 * next on the last row and getting silence reads as broken, and there is
 * nowhere else for the gesture to go.
 */
export function step(q: AuditionQueue, delta: number): AuditionQueue {
  if (!q.ids.length) return { ...q, at: -1, streak: 0 };
  const from = q.at >= 0 ? q.at : delta > 0 ? -1 : 0;
  const n = q.ids.length;
  const at = ((from + delta) % n + n) % n;
  return { ...q, at, streak: q.streak + 1 };
}

/**
 * What to do when the armed sound finishes playing.
 *
 * Returns the queue AND whether anything should now be playing — those are two
 * different facts and collapsing them is how "loop: off" ends up silently
 * replaying the last sound. `at` is deliberately KEPT when playback stops, so
 * the row stays selected and pressing space plays it again rather than
 * starting the shelf from the top.
 */
export function ended(q: AuditionQueue): { queue: AuditionQueue; play: boolean } {
  switch (q.loop) {
    case "one":
      return { queue: { ...q, streak: q.streak + 1 }, play: true };
    case "all":
      return { queue: step(q, 1), play: true };
    default:
      return { queue: { ...q, streak: 0 }, play: false };
  }
}

/* -------------------------------------------------------------------------- */
/* Preload                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How far ahead to warm, and what is too expensive to warm at all.
 *
 * The whole point is that it is CONSERVATIVE by construction. A library
 * browser that speculatively fetches is a library browser that can quietly
 * download a gigabyte while someone reads the names, so every dimension is
 * capped: how many, how long each may be, and how many bytes may be held at
 * once. Preloading is a convenience that must never become the reason the tab
 * is using 800 MB.
 */
export interface PreloadPolicy {
  /** Off = fetch only what is actually played. */
  enabled: boolean;
  /** Hard cap on lookahead, whatever the streak says. */
  maxAhead: number;
  /**
   * Skip anything longer than this. A 3-minute ambience is not the next thing
   * in a run of one-shots, and warming it costs more than every click in the
   * pack put together.
   */
  maxDurationMs: number;
  /** Ceiling on the decoded set held in memory. Eviction enforces it. */
  budgetBytes: number;
}

export const DEFAULT_PRELOAD: PreloadPolicy = {
  enabled: true,
  maxAhead: 4,
  maxDurationMs: 15_000,
  budgetBytes: 32 * 1024 * 1024,
};

/**
 * How many rows ahead to warm, given how long the current run is.
 *
 * ONE after the first sound — the single most likely next fetch, and the
 * cheapest possible bet. Then it grows with the run, because someone who has
 * played four in a row is walking the shelf and the fifth is nearly certain.
 * It never runs ahead of the evidence, and it never exceeds `maxAhead`.
 *
 * A fixed lookahead was the alternative and it is wrong in both directions:
 * 1 is useless to someone touring a pack, 4 is a speculative download of three
 * files nobody asked for when someone clicks a single sound and leaves.
 */
export function preloadAhead(streak: number, policy: PreloadPolicy): number {
  if (!policy.enabled || streak <= 0) return 0;
  return Math.max(1, Math.min(policy.maxAhead, streak));
}

/** What the preloader needs to know about one candidate. */
export interface PreloadCandidate {
  durationMs: number | null;
  bytes: number;
}

export interface PreloadInput {
  queue: AuditionQueue;
  /** Facts per id. An id with no entry is skipped — unknown is not free. */
  facts: ReadonlyMap<string, PreloadCandidate>;
  /** Ids already decoded and held. */
  warm: ReadonlySet<string>;
  /** Bytes those warm entries occupy. */
  warmBytes: number;
}

/**
 * The ids to warm, NEAREST FIRST, already filtered by every cap.
 *
 * It returns an ordered WANT LIST, not a command to fetch them all: the binding
 * takes the head, fetches exactly one, and asks again. That is what makes the
 * behaviour "slowly, one at a time" rather than a burst — and it means a
 * listener who moves on mid-warm simply gets a different answer next tick
 * instead of a queue of stale downloads to cancel.
 */
export function preloadTargets(input: PreloadInput, policy: PreloadPolicy): string[] {
  const { queue, facts, warm } = input;
  const ahead = preloadAhead(queue.streak, policy);
  if (ahead <= 0 || queue.at < 0 || !queue.ids.length) return [];

  const out: string[] = [];
  let budget = policy.budgetBytes - input.warmBytes;
  const n = queue.ids.length;
  for (let i = 1; i <= ahead; i++) {
    // Wrapping matches `step`: at the end of a shelf the next row is the first.
    const id = queue.ids[(queue.at + i) % n]!;
    if (warm.has(id) || out.includes(id)) continue;
    const fact = facts.get(id);
    if (!fact) continue;
    if (fact.durationMs !== null && fact.durationMs > policy.maxDurationMs) continue;
    if (fact.bytes > budget) continue;
    budget -= fact.bytes;
    out.push(id);
  }
  return out;
}

/**
 * What to DROP so the warm set fits its budget — least recently heard first.
 *
 * Preloading without eviction is a memory leak with a nice name. `heardAt` is
 * the clock: whatever was played or warmed longest ago goes first, except
 * anything in `keep` (what is playing, and what the preloader just asked for),
 * which is never evicted because evicting it would only cause it to be fetched
 * again on the next tick.
 */
export function evictTargets(
  entries: ReadonlyMap<string, { bytes: number; heardAt: number }>,
  keep: ReadonlySet<string>,
  budgetBytes: number,
): string[] {
  let total = 0;
  for (const e of entries.values()) total += e.bytes;
  if (total <= budgetBytes) return [];

  const order = [...entries.entries()]
    .filter(([id]) => !keep.has(id))
    .sort((a, b) => a[1].heardAt - b[1].heardAt);

  const drop: string[] = [];
  for (const [id, e] of order) {
    if (total <= budgetBytes) break;
    drop.push(id);
    total -= e.bytes;
  }
  return drop;
}

/* -------------------------------------------------------------------------- */
/* Ear guard                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A CEILING on how loud an audition can get — not a normaliser.
 *
 * Auditioning a sound library means clicking through hundreds of files
 * mastered by hundreds of people, on headphones, at whatever level the last
 * quiet one needed. One brickwalled impact in that context genuinely hurts,
 * and "turn it down first" is advice nobody can follow, because you cannot
 * know which file it was until you have already heard it.
 *
 * Two decisions make this the useful version rather than the cosmetic one:
 *
 * **It measures LOUDNESS, not peak.** A peak ceiling barely helps: a
 * brickwalled impact and a 3 ms tick both peak at 1.0 and are fifteen decibels
 * apart to a human. What hurts is sustained energy, so that is what is
 * measured (`measureLoudnessDb`) and what the ceiling is set against.
 *
 * **It is a ceiling, not a target.** Only sounds ABOVE the ceiling move, and
 * only down to it. A normaliser would make everything equally loud and destroy
 * the exact thing you are auditioning for — whether this impact hits harder
 * than that one. Relative dynamics between two reasonable sounds survive
 * untouched; only the ambush is removed.
 */
export interface EarGuard {
  enabled: boolean;
  /**
   * Perceived loudness ceiling in dB. Anything measuring above this is brought
   * down to it. −18 dB is roughly a well-mastered one-shot at a comfortable
   * monitoring level; the sounds that hurt measure −6 and above.
   */
  ceilingDb: number;
}

export const DEFAULT_EAR_GUARD: EarGuard = { enabled: true, ceilingDb: -18 };

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * The correction one sound needs, as a linear gain in (0, 1].
 *
 * `loudnessDb` is what `measureLoudnessDb` published. Never above 1: the guard
 * only ever takes away, so switching it on can never make anything louder than
 * it already was — which is the property that makes it safe to leave on.
 */
export function ceilingGain(loudnessDb: number | null, ceilingDb: number): number {
  // Unmeasured is a real state — a pack published before loudness was derived,
  // or a sound whose bytes never decoded. No correction beats a guessed one:
  // guessing high clips, guessing low mutes something for no reason.
  if (loudnessDb === null || !Number.isFinite(loudnessDb)) return 1;
  const over = loudnessDb - ceilingDb;
  return over > 0 ? dbToGain(-over) : 1;
}

/**
 * How much quieter the guard is making this sound, in dB. 0 = untouched.
 * The player shows it, because a control that is silently changing what you
 * hear while you judge a sound has to say so.
 */
export function guardTrimDb(loudnessDb: number | null, guard: EarGuard): number {
  if (!guard.enabled || loudnessDb === null || !Number.isFinite(loudnessDb)) return 0;
  return Math.min(0, guard.ceilingDb - loudnessDb);
}

/**
 * The gain an audition actually plays at: the listener's own volume, with the
 * guard's correction multiplied in.
 *
 * MULTIPLY, not `min`. The correction and the volume answer different
 * questions — "how much is this sound over the line" and "how loud do I want
 * to monitor" — and taking the smaller of the two would make the volume slider
 * do nothing at all between 50 % and 100 % on every loud file.
 */
export function auditionGain(volume: number, loudnessDb: number | null, guard: EarGuard): number {
  const v = clamp01(volume);
  return guard.enabled ? v * ceilingGain(loudnessDb, guard.ceilingDb) : v;
}
