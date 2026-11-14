import type { Track } from "../schema/document";
import type { MotionDocument } from "../schema/document";
import { getPreset } from "../animation/presets";
import { layerSpecFromPreset, retargetLayerSpec } from "../animation/layer-animation";
import { getTransitionPreset } from "../animation/transitions";
import { clipEnd, locateClip } from "./ops";
import {
  buildTransition,
  clampTransition,
  resolveTransitionDrop,
  transitionSpan,
  transitionTargets,
  type TransitionTarget,
} from "./transitions";

/**
 * Where a dragged PRESET would land on a lane — ONE resolver for both preset
 * families.
 *
 * A layer animation and a cut transition are different things, but the gesture
 * is identical: point at a lane and the app must say, honestly and before you
 * let go, exactly what it is about to do and over what span. Sharing the
 * resolver is what makes the two feel like one feature instead of two that
 * happen to sit in the same panel — and it means the drag ghost is drawn from
 * the same maths that commits, so it can never promise something different.
 *
 * ONE AIMING RULE, both families: the half of the clip you pointed at decides.
 * Point at the front half and an animation claims that clip's in-edge and a
 * transition claims the cut at its start; point at the back half and you get
 * the out-edge / the cut at its end. A cut is a shared seam when two clips
 * abut and a lone clip edge when they do not — the same record either way.
 *
 * Transitions used to answer a DIFFERENT question here — "is there a cut
 * within N px?" — so the identical gesture went dead over the middle of a
 * clip for one family and not the other, and a drop there was a toast instead
 * of an edit. The tolerance is still consulted FIRST, because aiming straight
 * at a seam must beat the midpoint of whichever clip owns that pixel, but it
 * is no longer the only way to hit anything.
 */
export interface AnimationDropTarget {
  kind: "animation";
  trackId: string;
  frameId: string;
  clipId: string;
  edge: "in" | "out";
  /** Wall-clock span the preview should cover. */
  startMs: number;
  endMs: number;
  /** An animation already on that edge — the drop REPLACES it. */
  replaces: boolean;
}

export interface TransitionDropTarget {
  kind: "transition";
  trackId: string;
  frameId: string;
  target: TransitionTarget;
  startMs: number;
  endMs: number;
  replaces: boolean;
}

export type PresetDropTarget = AnimationDropTarget | TransitionDropTarget;

/** The clip under a wall-clock time on a lane, if any. */
function clipAt(track: Track, frameId: string, timeMs: number) {
  return (
    track.clips.find(
      (c) => c.frameId === frameId && timeMs >= c.startMs && timeMs <= clipEnd(c),
    ) ?? null
  );
}

/**
 * Which edge of which clip an animation drop would claim. The midpoint decides:
 * aim at the front half and you get the in-animation, the back half the out —
 * the same "which end did you point at" rule the transition resolver uses, so
 * one mental model covers both.
 */
export function resolveAnimationDrop(
  track: Track,
  frameId: string,
  timeMs: number,
  presetId: string,
): AnimationDropTarget | null {
  const clip = clipAt(track, frameId, timeMs);
  // An ADJUSTMENT takes one like any other layer: `layerPoseAt` drives its
  // sizing and its wet/dry mix, so "fade in" ramps the grade on and "slide"
  // pushes the graded region across — see `renderAdjustment`. Audio is the one
  // real exclusion: it has no pose to animate.
  if (!clip || clip.kind === "audio") return null;
  const edge = timeMs < clip.startMs + clip.durationMs / 2 ? "in" : "out";
  const existing = edge === "in" ? clip.animIn : clip.animOut;
  // Preview the span the animation will actually occupy: its own duration when
  // it is replacing one, otherwise the incoming preset's default.
  const durationMs = Math.min(
    clip.durationMs,
    existing?.durationMs ?? getPreset(presetId)?.defaultDurationMs ?? 450,
  );
  return {
    kind: "animation",
    trackId: track.id,
    frameId,
    clipId: clip.id,
    edge,
    startMs: edge === "in" ? clip.startMs : clipEnd(clip) - durationMs,
    endMs: edge === "in" ? clip.startMs + durationMs : clipEnd(clip),
    replaces: existing !== null,
  };
}

/**
 * The cut belonging to the clip under the pointer, chosen by the SAME midpoint
 * rule `resolveAnimationDrop` uses. A clip's start cut is whichever target
 * ends at it (a lone head, or the seam with the clip before); its end cut is
 * whichever target starts from it (the seam with the next clip, or a tail).
 */
function cutOfClipAt(track: Track, frameId: string, timeMs: number): TransitionTarget | null {
  const clip = clipAt(track, frameId, timeMs);
  if (!clip) return null;
  const atStart = timeMs < clip.startMs + clip.durationMs / 2;
  return (
    transitionTargets(track, frameId).find((t) =>
      atStart ? t.bClipId === clip.id : t.aClipId === clip.id,
    ) ?? null
  );
}

/** The transition cut a drop would claim, with the span it would occupy. */
export function resolveTransitionDropTarget(
  track: Track,
  frameId: string,
  timeMs: number,
  presetId: string,
  toleranceMs: number,
): TransitionDropTarget | null {
  // Aiming AT a cut wins; anywhere else on a clip falls back to that clip's
  // own nearer cut, so the drag stays live across the whole clip.
  const target =
    resolveTransitionDrop(track, frameId, timeMs, toleranceMs) ??
    cutOfClipAt(track, frameId, timeMs);
  if (!target) return null;
  const draft = clampTransition(track, buildTransition(track, target, presetId));
  const span = transitionSpan(track, draft);
  if (!span || draft.durationMs <= 0) return null;
  return {
    kind: "transition",
    trackId: track.id,
    frameId,
    target,
    startMs: span.startMs,
    endMs: span.endMs,
    replaces: target.existingId !== null,
  };
}

/**
 * The one entry point a drag calls per lane, whichever preset family is in
 * flight. Returns null when the pointer is over nothing droppable, so the ghost
 * can say "not here" rather than guessing.
 */
export function resolvePresetDrop(
  track: Track,
  frameId: string,
  timeMs: number,
  preset: { kind: "animation" | "transition"; id: string },
  toleranceMs: number,
): PresetDropTarget | null {
  if (track.locked) return null;
  return preset.kind === "transition"
    ? resolveTransitionDropTarget(track, frameId, timeMs, preset.id, toleranceMs)
    : resolveAnimationDrop(track, frameId, timeMs, preset.id);
}

/**
 * Commit an animation drop. Retargets rather than overwrites when that edge
 * already carries one, so dropping a different preset onto an animation you
 * have already tuned keeps its duration and easing — the same promise the
 * inspector's preset picker makes.
 */
export function applyAnimationDrop(
  doc: MotionDocument,
  target: AnimationDropTarget,
  presetId: string,
): boolean {
  const located = locateClip(doc, target.clipId);
  if (!located || located.clip.kind === "audio") return false;
  const field = target.edge === "in" ? "animIn" : "animOut";
  const existing = located.clip[field];
  located.clip[field] = existing ? retargetLayerSpec(existing, presetId) : layerSpecFromPreset(presetId);
  return true;
}

/** Human-readable summary of what a drop will do — shown on the drag ghost. */
export function describePresetDrop(target: PresetDropTarget, label: string): string {
  if (target.kind === "animation") {
    return `${label} · ${target.edge === "in" ? "in" : "out"}${target.replaces ? " (replace)" : ""}`;
  }
  if (target.target.kind === "seam") return `${label} · cut`;
  return `${label} · clip ${target.target.kind === "head" ? "start" : "end"}`;
}

/** Does this preset id belong to the transition registry rather than the animation one? */
export function isTransitionPreset(id: string): boolean {
  return getTransitionPreset(id) !== undefined;
}
