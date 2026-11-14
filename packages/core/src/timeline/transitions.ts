import type { MotionDocument, Track } from "../schema/document";
import type { Clip } from "../schema/clips";
import type { Transition } from "../schema/transitions";
import {
  crossfadeGains,
  getTransitionPreset,
  transitionParamsFor,
  type AudioCrossfadeCurve,
} from "../animation/transitions";
import { clipEnd, clipSourceCapacityMs, locateClip } from "./ops";
import { clipPlaybackOf } from "../clip-registry";
import { createId } from "../ids";

/**
 * Transition GEOMETRY and LIFECYCLE — the one headless brain every surface
 * reads: the renderer asks what is mixing right now, the timeline asks where
 * to draw the badge and how far a handle may drag, the audio conductor asks
 * for crossfade gains, and the edit ops ask what to re-anchor after a trim.
 *
 * Nothing here knows about pixels, React or the DOM.
 */

/** Two cuts closer than this are the same cut (mirrors the timeline's own attachment test). */
export const ABUT_EPSILON_MS = 1;

/** A transition shorter than this is not draggable or visible — treat as removal. */
export const MIN_TRANSITION_MS = 40;

// ── Lookup ───────────────────────────────────────────────────────────────────

/** Every transition on a track belonging to one comp. */
export function trackTransitions(track: Track, frameId: string): Transition[] {
  return track.transitions.filter((t) => t.frameId === frameId);
}

export function findTransition(doc: MotionDocument, id: string): { track: Track; transition: Transition } | null {
  for (const track of doc.tracks) {
    const transition = track.transitions.find((t) => t.id === id);
    if (transition) return { track, transition };
  }
  return null;
}

/** The transition owning a clip's head (it is the INCOMING side), if any. */
export function transitionAtHead(track: Track, clipId: string): Transition | null {
  return track.transitions.find((t) => t.bClipId === clipId) ?? null;
}

/** The transition owning a clip's tail (it is the OUTGOING side), if any. */
export function transitionAtTail(track: Track, clipId: string): Transition | null {
  return track.transitions.find((t) => t.aClipId === clipId) ?? null;
}

/** Everything attached to a clip — what a delete or copy of that clip carries. */
export function transitionsOfClip(track: Track, clipId: string): Transition[] {
  return track.transitions.filter((t) => t.aClipId === clipId || t.bClipId === clipId);
}

// ── Geometry ─────────────────────────────────────────────────────────────────

export interface TransitionSpan {
  /** Wall-clock ms of the cut itself. */
  cutMs: number;
  /** Wall-clock ms the mix starts (cut − splitMs). */
  startMs: number;
  /** Wall-clock ms the mix ends. */
  endMs: number;
}

/**
 * Where a transition sits on the timeline. Null when it is orphaned (a
 * participant was deleted) — callers treat that as "reconcile me away" rather
 * than crashing, so a stale record can never take the renderer down.
 */
export function transitionSpan(track: Track, tr: Transition): TransitionSpan | null {
  const a = tr.aClipId ? track.clips.find((c) => c.id === tr.aClipId) : null;
  const b = tr.bClipId ? track.clips.find((c) => c.id === tr.bClipId) : null;
  if (!a && !b) return null;
  const cutMs = a ? clipEnd(a) : b!.startMs;
  const split = Math.min(tr.splitMs, tr.durationMs);
  return { cutMs, startMs: cutMs - split, endMs: cutMs + (tr.durationMs - split) };
}

/** Normalized progress 0→1 through a transition at a wall-clock time, or null when outside it. */
export function transitionProgressAt(track: Track, tr: Transition, timeMs: number): number | null {
  const span = transitionSpan(track, tr);
  if (!span || tr.durationMs <= 0) return null;
  if (timeMs < span.startMs || timeMs > span.endMs) return null;
  return (timeMs - span.startMs) / tr.durationMs;
}

/** The single transition active at a moment on a track (spans never overlap by construction). */
export function activeTransitionAt(
  track: Track,
  frameId: string,
  timeMs: number,
): { transition: Transition; progress: number } | null {
  for (const transition of track.transitions) {
    if (transition.frameId !== frameId) continue;
    const progress = transitionProgressAt(track, transition, timeMs);
    if (progress !== null) return { transition, progress };
  }
  return null;
}

/** Every clip a transition needs painted at this moment — including one that is outside its own span. */
export function transitionParticipants(track: Track, tr: Transition): { a: Clip | null; b: Clip | null } {
  return {
    a: (tr.aClipId ? track.clips.find((c) => c.id === tr.aClipId) : null) ?? null,
    b: (tr.bClipId ? track.clips.find((c) => c.id === tr.bClipId) : null) ?? null,
  };
}

// ── Limits ───────────────────────────────────────────────────────────────────

/** ms at the head of a clip already reserved by a DIFFERENT transition. */
function headReservedMs(track: Track, clipId: string, exceptId: string): number {
  const t = track.transitions.find((x) => x.bClipId === clipId && x.id !== exceptId);
  return t ? Math.max(0, t.durationMs - Math.min(t.splitMs, t.durationMs)) : 0;
}

/** ms at the tail of a clip already reserved by a DIFFERENT transition. */
function tailReservedMs(track: Track, clipId: string, exceptId: string): number {
  const t = track.transitions.find((x) => x.aClipId === clipId && x.id !== exceptId);
  return t ? Math.min(t.splitMs, t.durationMs) : 0;
}

export interface TransitionLimits {
  /** Largest legal A-side (ms before the cut). */
  maxSplitMs: number;
  /** Largest legal B-side (ms after the cut). */
  maxTailMs: number;
  /** Largest legal total span. */
  maxDurationMs: number;
}

/**
 * How far a transition may grow before it would eat past a clip's own start /
 * end or collide with the neighbouring transition on the same clip. Drives BOTH
 * the drag clamp and the disabled state of the duration field, so the handle
 * can never be dragged somewhere the model would reject.
 */
export function transitionLimits(track: Track, tr: Transition): TransitionLimits {
  const { a, b } = transitionParticipants(track, tr);
  // A single-sided transition lives entirely inside its one clip.
  const aRoom = a ? Math.max(0, a.durationMs - headReservedMs(track, a.id, tr.id)) : 0;
  const bRoom = b ? Math.max(0, b.durationMs - tailReservedMs(track, b.id, tr.id)) : 0;
  const maxSplitMs = a ? aRoom : 0;
  const maxTailMs = b ? bRoom : 0;
  return { maxSplitMs, maxTailMs, maxDurationMs: Math.max(0, maxSplitMs + maxTailMs) };
}

/**
 * Fit a transition inside its legal limits, preserving INTENT: the requested
 * split ratio survives clamping whenever it can, so dragging a symmetric
 * transition against a short clip shrinks it evenly instead of lurching to one
 * side. Returns a new record; never mutates.
 */
export function clampTransition(track: Track, tr: Transition): Transition {
  const { a, b } = transitionParticipants(track, tr);
  const limits = transitionLimits(track, tr);
  // Single-sided: the split is not a free variable — the span hangs off the one
  // clip it has, so it is pinned to whichever end that is.
  if (!a || !b) {
    const duration = Math.max(0, Math.min(tr.durationMs, limits.maxDurationMs));
    return { ...tr, durationMs: duration, splitMs: a ? duration : 0 };
  }
  const ratio = tr.durationMs > 0 ? Math.min(tr.splitMs, tr.durationMs) / tr.durationMs : 0.5;
  // The SPLIT RATIO is the user's deliberate choice, so the DURATION yields to
  // it, not the other way round: an asymmetric transition dragged against a
  // short clip stops growing rather than silently re-centring itself. Each side
  // caps the total it can belong to; the tighter cap wins.
  const capBySplit = ratio > 0.001 ? limits.maxSplitMs / ratio : Infinity;
  const capByTail = ratio < 0.999 ? limits.maxTailMs / (1 - ratio) : Infinity;
  const duration = Math.max(0, Math.min(tr.durationMs, capBySplit, capByTail));
  return { ...tr, durationMs: duration, splitMs: Math.max(0, Math.min(duration * ratio, duration)) };
}

// ── Media handles ────────────────────────────────────────────────────────────

export interface TransitionMediaShortfall {
  /** ms of A's tail that has no real source behind it (freeze-framed). */
  aFreezeMs: number;
  /** ms of B's head that has no real source behind it (freeze-framed). */
  bFreezeMs: number;
}

const NO_SHORTFALL: TransitionMediaShortfall = { aFreezeMs: 0, bFreezeMs: 0 };

/**
 * A two-sided transition has to paint A PAST its out point and B BEFORE its in
 * point. Synthetic clips (text, shapes, vectors, drawings) extrapolate for
 * free, and a looping source wraps — but a trimmed video with nothing left in
 * the can cannot, and the honest answer is to hold the edge frame and SAY so
 * rather than flash black. This reports exactly how much of each side is held,
 * which the renderer clamps by and the timeline badge warns about.
 */
export function transitionMediaShortfall(
  doc: MotionDocument,
  track: Track,
  tr: Transition,
): TransitionMediaShortfall {
  const { a, b } = transitionParticipants(track, tr);
  if (!a || !b) return NO_SHORTFALL;
  const split = Math.min(tr.splitMs, tr.durationMs);
  const tail = tr.durationMs - split;

  // A is asked for `tail` ms beyond its out point.
  let aFreezeMs = 0;
  const aCapacity = clipSourceCapacityMs(doc, a);
  if (aCapacity !== null) aFreezeMs = Math.max(0, tail - Math.max(0, aCapacity - a.durationMs));

  // B is asked for `split` ms before its in point — that is its trimmed head.
  let bFreezeMs = 0;
  const bCapacity = clipSourceCapacityMs(doc, b);
  if (bCapacity !== null) {
    const playback = clipPlaybackOf(b);
    const speed = playback && playback.speed > 0 ? playback.speed : 1;
    const trimIn = "trimInMs" in b ? (b.trimInMs as number) : 0;
    bFreezeMs = Math.max(0, split - trimIn / speed);
  }
  return { aFreezeMs, bFreezeMs };
}

// ── Drop targeting ───────────────────────────────────────────────────────────

export type TransitionTargetKind = "seam" | "head" | "tail";

export interface TransitionTarget {
  kind: TransitionTargetKind;
  trackId: string;
  frameId: string;
  aClipId: string | null;
  bClipId: string | null;
  /** Wall-clock ms of the cut this target represents. */
  cutMs: number;
  /** An existing transition already occupying it — a drop REPLACES rather than stacks. */
  existingId: string | null;
}

/** Every place on a track a transition could legally land, in time order. */
export function transitionTargets(track: Track, frameId: string): TransitionTarget[] {
  const clips = track.clips
    .filter((c) => c.frameId === frameId)
    .slice()
    .sort((x, y) => x.startMs - y.startMs);
  const targets: TransitionTarget[] = [];
  const push = (t: Omit<TransitionTarget, "existingId" | "trackId" | "frameId">) => {
    const existing =
      track.transitions.find(
        (x) => x.frameId === frameId && x.aClipId === t.aClipId && x.bClipId === t.bClipId,
      ) ?? null;
    targets.push({ ...t, trackId: track.id, frameId, existingId: existing?.id ?? null });
  };

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]!;
    const next = clips[i + 1];
    const abutsNext = next != null && Math.abs(next.startMs - clipEnd(clip)) <= ABUT_EPSILON_MS;
    const prev = clips[i - 1];
    const abutsPrev = prev != null && Math.abs(clip.startMs - clipEnd(prev)) <= ABUT_EPSILON_MS;

    // A lone head: nothing attached on the left.
    if (!abutsPrev) push({ kind: "head", aClipId: null, bClipId: clip.id, cutMs: clip.startMs });
    if (abutsNext) {
      // The shared cut — one target owned by BOTH clips, which is what makes a
      // single drop land "on both, just like editing apps".
      push({ kind: "seam", aClipId: clip.id, bClipId: next!.id, cutMs: clipEnd(clip) });
    } else {
      push({ kind: "tail", aClipId: clip.id, bClipId: null, cutMs: clipEnd(clip) });
    }
  }
  return targets;
}

/**
 * The target a pointer at `timeMs` is offering to drop onto — the nearest cut
 * within `toleranceMs`, seams winning ties because a shared cut is almost
 * always what the user means when two clips touch. Returns null outside the
 * tolerance so the drag ghost can honestly show "no target here".
 */
export function resolveTransitionDrop(
  track: Track,
  frameId: string,
  timeMs: number,
  toleranceMs: number,
): TransitionTarget | null {
  let best: TransitionTarget | null = null;
  let bestDistance = Infinity;
  for (const target of transitionTargets(track, frameId)) {
    const distance = Math.abs(target.cutMs - timeMs);
    if (distance > toleranceMs) continue;
    const better =
      distance < bestDistance - ABUT_EPSILON_MS ||
      (Math.abs(distance - bestDistance) <= ABUT_EPSILON_MS && target.kind === "seam");
    if (better) {
      best = target;
      bestDistance = distance;
    }
  }
  return best;
}

// ── Mutation ─────────────────────────────────────────────────────────────────

/** A fresh transition for a target, already clamped to fit. Does not attach it. */
export function buildTransition(
  track: Track,
  target: TransitionTarget,
  presetId: string,
  overrides?: Partial<Pick<Transition, "durationMs" | "splitMs" | "params" | "easing" | "color">>,
): Transition {
  const def = getTransitionPreset(presetId);
  const durationMs = overrides?.durationMs ?? def?.defaultDurationMs ?? 500;
  const draft: Transition = {
    id: createId("tr"),
    preset: presetId,
    frameId: target.frameId,
    aClipId: target.aClipId,
    bClipId: target.bClipId,
    durationMs,
    splitMs: overrides?.splitMs ?? (target.kind === "seam" ? durationMs / 2 : target.kind === "tail" ? durationMs : 0),
    easing: overrides?.easing ?? def?.defaultEasing ?? { kind: "preset", name: "ease-in-out" },
    params: overrides?.params ?? transitionParamsFor(presetId),
    color: overrides?.color ?? null,
  };
  return clampTransition(track, draft);
}

/**
 * Put a transition on a target, REPLACING whatever was there. The one mutation
 * the browser drop, the ⌘D default, the paste command and the plugin API all
 * call — so "apply a transition" can only ever mean one thing. Returns the new
 * transition, or null when the target has no room for a usable one.
 */
export function applyTransition(
  doc: MotionDocument,
  target: TransitionTarget,
  presetId: string,
  overrides?: Parameters<typeof buildTransition>[3],
): Transition | null {
  const track = doc.tracks.find((t) => t.id === target.trackId);
  if (!track || track.locked) return null;
  const built = buildTransition(track, target, presetId, overrides);
  if (built.durationMs < MIN_TRANSITION_MS) return null;
  // Clear EVERY transition that claims either edge this one needs — not just an
  // exact a/b match. A drop can legitimately resolve to a different shape than
  // what is already there (a lone tail where a seam now sits, or the reverse),
  // and pushing alongside it would leave two records fighting over one edge,
  // with the re-anchor pass arbitrarily keeping whichever came first in the
  // array — which reads to the user as "my new transition did nothing".
  // Applying is a REPLACE by definition, so it is enforced here rather than
  // left to a later pass to adjudicate.
  track.transitions = track.transitions.filter((t) => {
    if (t.id === target.existingId) return false;
    if (target.aClipId != null && t.aClipId === target.aClipId) return false;
    if (target.bClipId != null && t.bClipId === target.bClipId) return false;
    return true;
  });
  track.transitions.push(built);
  return built;
}

/**
 * Apply a transition to EVERY cut the given clips touch — the brain behind
 * "paste onto the selection" and "add transitions to all these clips". Each
 * selected clip contributes both of its edges, and a cut shared by two selected
 * clips is one target, not two, so pasting onto an abutted pair yields three
 * transitions (outer head, shared seam, outer tail) rather than four overlapping
 * ones. Returns how many landed.
 */
export function applyTransitionToClips(
  doc: MotionDocument,
  clipIds: readonly string[],
  presetId: string,
  overrides?: Parameters<typeof buildTransition>[3],
  edge: "in" | "out" | "any" = "any",
): number {
  const wanted = new Set(clipIds);
  const seen = new Set<string>();
  let applied = 0;
  for (const track of doc.tracks) {
    if (track.locked) continue;
    const frames = new Set(track.clips.filter((c) => wanted.has(c.id)).map((c) => c.frameId));
    for (const frameId of frames) {
      for (const target of transitionTargets(track, frameId)) {
        // `edge` narrows which of a clip's two edges may take it. "any" is the
        // browse-and-apply gesture (both edges of everything selected); "in" and
        // "out" are what a PASTE uses, so a transition copied from one end of a
        // clip lands on the matching end of the next one instead of blanketing
        // both. A seam counts as the incoming edge of its B and the outgoing
        // edge of its A, which is exactly what those words mean at a cut.
        const touches =
          edge === "in"
            ? target.bClipId != null && wanted.has(target.bClipId)
            : edge === "out"
              ? target.aClipId != null && wanted.has(target.aClipId)
              : (target.aClipId != null && wanted.has(target.aClipId)) ||
                (target.bClipId != null && wanted.has(target.bClipId));
        if (!touches) continue;
        const key = `${track.id}:${target.aClipId ?? ""}:${target.bClipId ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (applyTransition(doc, target, presetId, overrides)) applied++;
      }
    }
  }
  return applied;
}

/**
 * Apply a transition at the cut nearest a moment — the "default transition"
 * gesture every NLE binds to a key. Restricted to `trackIds` when given (the
 * selection's lanes), otherwise every unlocked lane in the comp gets one, which
 * is what makes a single keystroke transition a whole multi-lane edit at once.
 */
export function applyTransitionAtTime(
  doc: MotionDocument,
  frameId: string,
  timeMs: number,
  presetId: string,
  toleranceMs: number,
  trackIds?: readonly string[],
): number {
  const only = trackIds ? new Set(trackIds) : null;
  let applied = 0;
  for (const track of doc.tracks) {
    if (track.locked || (only && !only.has(track.id))) continue;
    const target = resolveTransitionDrop(track, frameId, timeMs, toleranceMs);
    if (target && applyTransition(doc, target, presetId)) applied++;
  }
  return applied;
}

export function removeTransition(doc: MotionDocument, id: string): boolean {
  for (const track of doc.tracks) {
    const index = track.transitions.findIndex((t) => t.id === id);
    if (index >= 0) {
      track.transitions.splice(index, 1);
      return true;
    }
  }
  return false;
}

/**
 * Resize a transition by dragging one of its two outer handles.
 *
 * `symmetric` (the default, matching every NLE) keeps the cut centred in the
 * user's intent: dragging either edge grows or shrinks BOTH sides together.
 * Holding alt sets `symmetric: false`, which moves only the dragged side and
 * so writes an asymmetric `splitMs`. Both are the same edit on the same single
 * record, which is why the two sides can never drift out of sync.
 */
export function resizeTransition(
  doc: MotionDocument,
  id: string,
  edge: "start" | "end",
  timeMs: number,
  symmetric: boolean,
): boolean {
  const found = findTransition(doc, id);
  if (!found || found.track.locked) return false;
  const { track, transition } = found;
  const span = transitionSpan(track, transition);
  if (!span) return false;

  const side = edge === "start" ? span.cutMs - timeMs : timeMs - span.cutMs;
  const requested = Math.max(0, side);
  let next: Transition;
  if (symmetric) {
    // Both sides take the dragged half — a centred transition stays centred and
    // an asymmetric one keeps its ratio.
    const split = Math.min(transition.splitMs, transition.durationMs);
    const ratio = transition.durationMs > 0 ? split / transition.durationMs : 0.5;
    const share = edge === "start" ? ratio : 1 - ratio;
    const duration = share > 0.001 ? requested / share : requested * 2;
    next = { ...transition, durationMs: duration, splitMs: duration * ratio };
  } else {
    const split = Math.min(transition.splitMs, transition.durationMs);
    const tail = transition.durationMs - split;
    const nextSplit = edge === "start" ? requested : split;
    const nextTail = edge === "end" ? requested : tail;
    next = { ...transition, durationMs: nextSplit + nextTail, splitMs: nextSplit };
  }

  const clamped = clampTransition(track, next);
  const index = track.transitions.findIndex((t) => t.id === id);
  if (clamped.durationMs < MIN_TRANSITION_MS) {
    track.transitions.splice(index, 1);
    return true;
  }
  track.transitions[index] = clamped;
  return true;
}

/**
 * Re-anchor every transition after ANY structural edit — trim, move, split,
 * delete, ripple. Orphans (a participant is gone) either degrade to the
 * single-sided form or are dropped; a pair that no longer abuts stops being a
 * seam and becomes two edges; everything left is re-clamped to its new room.
 *
 * This is the guard that keeps the feature honest: no edit path has to know
 * about transitions, it just calls this afterwards, so no future op can leave a
 * dangling record behind.
 */
export function reconcileTransitions(doc: MotionDocument): void {
  for (const track of doc.tracks) {
    if (!track.transitions.length) continue;
    const byId = new Map(track.clips.map((c) => [c.id, c]));
    const kept: Transition[] = [];
    const claimedHead = new Set<string>();
    const claimedTail = new Set<string>();

    for (const tr of track.transitions) {
      let a = tr.aClipId ? byId.get(tr.aClipId) ?? null : null;
      let b = tr.bClipId ? byId.get(tr.bClipId) ?? null : null;
      // A deleted participant degrades the transition to its surviving side
      // rather than deleting it — the user's cut effect survives a ripple.
      if (tr.aClipId && !a) a = null;
      if (tr.bClipId && !b) b = null;
      if (!a && !b) continue;
      // The pair drifted apart (one was moved or trimmed) — it is no longer one
      // cut. Keep it on the outgoing side, which is where it reads as an out.
      if (a && b && Math.abs(b.startMs - clipEnd(a)) > ABUT_EPSILON_MS) b = null;
      // A clip may own each of its two edges exactly once.
      if (a && claimedTail.has(a.id)) a = null;
      if (b && claimedHead.has(b.id)) b = null;
      if (!a && !b) continue;

      const clamped = clampTransition(track, {
        ...tr,
        aClipId: a?.id ?? null,
        bClipId: b?.id ?? null,
      });
      if (clamped.durationMs < MIN_TRANSITION_MS) continue;
      if (a) claimedTail.add(a.id);
      if (b) claimedHead.add(b.id);
      kept.push(clamped);
    }
    track.transitions = kept;
  }
}

/**
 * Carry transitions across a CLONE — duplicating a frame, pasting a set of
 * clips, precomposing. `idMap` is old clip id → new clip id; a transition
 * survives only when every side it names came along, so a partial copy yields
 * the single-sided form instead of a dangling reference. The one place clone
 * paths reuse, so none of them has to understand the geometry.
 */
export function remapTransitions(
  source: readonly Transition[],
  idMap: ReadonlyMap<string, string>,
  frameId: string,
  nextFrameId: string,
): Transition[] {
  const out: Transition[] = [];
  for (const tr of source) {
    if (tr.frameId !== frameId) continue;
    const a = tr.aClipId ? idMap.get(tr.aClipId) ?? null : null;
    const b = tr.bClipId ? idMap.get(tr.bClipId) ?? null : null;
    if (!a && !b) continue;
    out.push({ ...tr, id: createId("tr"), frameId: nextFrameId, aClipId: a, bClipId: b });
  }
  return out;
}

/**
 * Hand a clip's TAIL transition to another clip. A split is the case that needs
 * it: the cut the transition was authored on now belongs to the right-hand
 * piece, and only the op performing the split knows that. Without this the
 * generic re-anchor pass would see a transition whose A no longer abuts B and
 * demote a perfectly good seam to a lone edge halfway up the clip.
 */
export function reassignTransitionTail(track: Track, fromClipId: string, toClipId: string): void {
  for (const tr of track.transitions) {
    if (tr.aClipId === fromClipId) tr.aClipId = toClipId;
  }
}

/** Drop everything attached to a clip — used by delete paths that do not re-anchor. */
export function dropTransitionsOfClip(track: Track, clipId: string): void {
  track.transitions = track.transitions.filter((t) => t.aClipId !== clipId && t.bClipId !== clipId);
}

// ── Audio ────────────────────────────────────────────────────────────────────

/**
 * The crossfade factor a clip's gain is MULTIPLIED by at a wall-clock time —
 * 1 when no transition touches it. Mirrors `fadeFactorAt`'s contract exactly
 * (multiply, never write keys), so a crossfade composes with the clip's own
 * fades and gain automation instead of fighting them.
 */
export function crossfadeFactorAt(track: Track, clip: Clip, timeMs: number): number {
  let factor = 1;
  for (const tr of track.transitions) {
    if (tr.aClipId !== clip.id && tr.bClipId !== clip.id) continue;
    const def = getTransitionPreset(tr.preset);
    const curve: AudioCrossfadeCurve | null = def?.audio ?? null;
    if (!curve) continue;
    const progress = transitionProgressAt(track, tr, timeMs);
    if (progress === null) continue;
    const gains = crossfadeGains(curve, progress);
    factor *= tr.aClipId === clip.id ? gains.a : gains.b;
  }
  return Math.max(0, Math.min(1, factor));
}

/** Convenience for callers holding only a clip id (live conductor, waveform). */
export function crossfadeFactorForClip(doc: MotionDocument, clipId: string, timeMs: number): number {
  const located = locateClip(doc, clipId);
  return located ? crossfadeFactorAt(located.track, located.clip, timeMs) : 1;
}
