import type { MotionDocument, Track } from "../schema/document";
import type { Clip, VisualClip } from "../schema/clips";
import type { AnimationSpec, LayerAnimationSpec } from "../schema/animation";
import type { Transition } from "../schema/transitions";
import { getPreset } from "../animation/presets";
import { retargetAnimSpec } from "../animation/presets";
import { layerSpecFromPreset, retargetLayerSpec } from "../animation/layer-animation";
import { getTransitionPreset } from "../animation/transitions";
import { animationSpanMs } from "../text/schedule";
import { segmentText } from "../text/segment";
import { unitCountOf } from "../text/segment";
import { clipEnd, locateClip } from "./ops";
import {
  applyTransitionToClips,
  findTransition,
  removeTransition,
  transitionLimits,
  transitionMediaShortfall,
  transitionSpan,
  trackTransitions,
  clampTransition,
} from "./transitions";
import { retargetTransition } from "../animation/transitions";

/**
 * CLIP EDGE DECORATIONS — the ONE model behind every "this clip plays in/out
 * like THIS" marker on the timeline.
 *
 * Three things had grown their own selection slot, their own delete branch,
 * their own context menu and their own bit of chrome:
 *   • `clip.animIn` / `animOut` — the whole-LAYER pose (any visual clip);
 *   • `clip.animations.in` / `.out` — the per-GLYPH pose (text);
 *   • a `Transition` record on the track — the cut effect, which may straddle
 *     two clips or hang off a lone edge.
 * They are three DATA shapes for good reasons (see each schema), but to the
 * user they are one idea: a labelled span at the end of a clip that can be
 * clicked, renamed in the eye, resized, copied, pasted and deleted. Modelling
 * that idea ONCE is what lets the timeline draw one chip, the session hold one
 * selection, and ⌘C/⌘X/⌘V/⌫ have one branch each instead of three.
 *
 * This module is the brain: address (`EdgeRef`), read (`EdgeDecor`), and the
 * four verbs. It is pure data — no React, no DOM, no pixels.
 */

export type ClipEdgeSide = "in" | "out";
export type EdgeDecorKind = "layer" | "text" | "transition";

/**
 * A stable ADDRESS for one decoration. Layer and glyph animations are properties
 * of a clip edge and so are addressed by (clip, side); a transition owns its own
 * identity because it can belong to two clips at once.
 */
export type EdgeRef =
  | { kind: "layer"; clipId: string; side: ClipEdgeSide }
  | { kind: "text"; clipId: string; side: ClipEdgeSide }
  | { kind: "transition"; id: string };

/** Comparable key — selection state stores refs, and React needs a key. */
export function edgeRefKey(ref: EdgeRef): string {
  return ref.kind === "transition" ? `transition:${ref.id}` : `${ref.kind}:${ref.clipId}:${ref.side}`;
}

export function sameEdgeRef(a: EdgeRef | null, b: EdgeRef | null): boolean {
  if (!a || !b) return a === b;
  return edgeRefKey(a) === edgeRefKey(b);
}

/** Everything a chip needs to draw itself and everything a tooltip needs to say. */
export interface EdgeDecor {
  ref: EdgeRef;
  kind: EdgeDecorKind;
  /** Which end of the clip it hangs off. "cut" = a transition with both sides. */
  side: ClipEdgeSide | "cut";
  /** The preset's display name — what the chip prints, so nothing is mystery chrome. */
  label: string;
  presetId: string;
  /** One line of prose for the tooltip: what this thing IS. */
  tagline: string;
  /** Total visible span in ms (a glyph animation's span includes its stagger). */
  durationMs: number;
  /** Longest span the clip / cut has room for — the drag clamp and the menus share it. */
  maxDurationMs: number;
  /** Lane-absolute ms, so a lane-level layer and a clip-level one agree. */
  startMs: number;
  endMs: number;
  /** Where the cut falls inside the span, 0..1. Only meaningful for transitions. */
  cutFraction: number;
  /**
   * The clips this decoration belongs to — one for an animation, one or two for
   * a transition. Selecting a decoration selects its owners, which is what makes
   * a paste land on the layers the user is looking at.
   */
  clipIds: string[];
  /** A problem worth surfacing on hover (never as a permanent alarm icon). */
  warning: string | null;
}

// ── Read ─────────────────────────────────────────────────────────────────────

function glyphUnitCount(clip: Clip, spec: AnimationSpec): number {
  const text =
    clip.kind === "text" ? clip.text : "";
  if (!text) return 0;
  return unitCountOf(segmentText(text), spec.unit);
}

/** The span a glyph animation occupies on the clip, clamped to the clip itself. */
export function glyphAnimSpanMs(clip: Clip, spec: AnimationSpec): number {
  return Math.min(clip.durationMs, animationSpanMs(spec, glyphUnitCount(clip, spec)));
}

function labelOf(presetId: string): { label: string; tagline: string } {
  const def = getPreset(presetId);
  return { label: def?.label ?? presetId, tagline: def?.tagline ?? "" };
}

/**
 * Every decoration living ON a clip (both animation grains, both sides), in
 * draw order. Transitions are NOT here: they can straddle two clips, so they
 * belong to the lane — see `trackEdgeDecors`.
 */
export function clipEdgeDecors(clip: Clip): EdgeDecor[] {
  if (clip.kind === "audio") return [];
  const out: EdgeDecor[] = [];
  const push = (kind: "layer" | "text", side: ClipEdgeSide, presetId: string, durationMs: number) => {
    const span = Math.min(durationMs, clip.durationMs);
    if (span <= 0) return;
    const { label, tagline } = labelOf(presetId);
    out.push({
      ref: { kind, clipId: clip.id, side },
      kind,
      side,
      label,
      presetId,
      tagline,
      durationMs: span,
      maxDurationMs: clip.durationMs,
      startMs: side === "in" ? clip.startMs : clipEnd(clip) - span,
      endMs: side === "in" ? clip.startMs + span : clipEnd(clip),
      cutFraction: side === "in" ? 0 : 1,
      clipIds: [clip.id],
      warning: null,
    });
  };

  if (clip.kind === "text") {
    const { in: aIn, out: aOut } = clip.animations;
    if (aIn) push("text", "in", aIn.preset, glyphAnimSpanMs(clip, aIn));
    if (aOut) push("text", "out", aOut.preset, glyphAnimSpanMs(clip, aOut));
  }
  const visual = clip as VisualClip;
  if (visual.animIn) push("layer", "in", visual.animIn.preset, visual.animIn.durationMs);
  if (visual.animOut) push("layer", "out", visual.animOut.preset, visual.animOut.durationMs);
  return out;
}

/** The transition decorations on one lane of one comp. */
export function trackEdgeDecors(doc: MotionDocument, track: Track, frameId: string): EdgeDecor[] {
  const out: EdgeDecor[] = [];
  for (const tr of trackTransitions(track, frameId)) {
    const decor = transitionDecor(doc, track, tr);
    if (decor) out.push(decor);
  }
  return out;
}

function transitionDecor(doc: MotionDocument, track: Track, tr: Transition): EdgeDecor | null {
  const span = transitionSpan(track, tr);
  if (!span) return null;
  const def = getTransitionPreset(tr.preset);
  const shortfall = transitionMediaShortfall(doc, track, tr);
  const held = Math.round(Math.max(shortfall.aFreezeMs, shortfall.bFreezeMs));
  const side: ClipEdgeSide | "cut" = tr.aClipId && tr.bClipId ? "cut" : tr.aClipId ? "out" : "in";
  return {
    ref: { kind: "transition", id: tr.id },
    kind: "transition",
    side,
    label: def?.label ?? tr.preset,
    presetId: tr.preset,
    tagline: def?.tagline ?? "",
    durationMs: tr.durationMs,
    maxDurationMs: transitionLimits(track, tr).maxDurationMs,
    startMs: span.startMs,
    endMs: span.endMs,
    cutFraction: tr.durationMs > 0 ? Math.min(1, tr.splitMs / tr.durationMs) : 0.5,
    clipIds: [tr.aClipId, tr.bClipId].filter((id): id is string => id !== null),
    warning: held > 1 ? `Holding ${held} ms — no source media left` : null,
  };
}

/** Resolve one address to its live decoration, or null when it is gone. */
export function findEdgeDecor(doc: MotionDocument, ref: EdgeRef): EdgeDecor | null {
  if (ref.kind === "transition") {
    const found = findTransition(doc, ref.id);
    return found ? transitionDecor(doc, found.track, found.transition) : null;
  }
  const loc = locateClip(doc, ref.clipId);
  if (!loc) return null;
  return clipEdgeDecors(loc.clip).find((d) => sameEdgeRef(d.ref, ref)) ?? null;
}

// ── Verbs (mutate a draft document) ──────────────────────────────────────────

/** Delete one decoration — never the clip it decorates. */
export function removeEdgeDecor(doc: MotionDocument, ref: EdgeRef): boolean {
  if (ref.kind === "transition") return removeTransition(doc, ref.id);
  const loc = locateClip(doc, ref.clipId);
  if (!loc || loc.clip.kind === "audio") return false;
  if (ref.kind === "layer") {
    const field = ref.side === "in" ? "animIn" : "animOut";
    if (!loc.clip[field]) return false;
    loc.clip[field] = null;
    return true;
  }
  if (loc.clip.kind !== "text") return false;
  const field = ref.side === "in" ? "in" : "out";
  if (!loc.clip.animations[field]) return false;
  loc.clip.animations[field] = null;
  return true;
}

/**
 * Resize a decoration to a target SPAN.
 *
 * A glyph animation's visible span is `duration + stagger·(n−1)`, so dragging
 * its handle scales both terms by the same factor — the user is stretching the
 * whole entrance, not just one glyph, and the rhythm they tuned survives.
 */
export function setEdgeDecorDuration(doc: MotionDocument, ref: EdgeRef, targetMs: number): boolean {
  if (ref.kind === "transition") {
    const found = findTransition(doc, ref.id);
    if (!found || found.track.locked) return false;
    const { track, transition } = found;
    const ratio = transition.durationMs > 0 ? transition.splitMs / transition.durationMs : 0.5;
    const next = clampTransition(track, {
      ...transition,
      durationMs: Math.max(0, targetMs),
      splitMs: Math.max(0, targetMs) * ratio,
    });
    track.transitions[track.transitions.findIndex((t) => t.id === ref.id)] = next;
    return true;
  }
  const loc = locateClip(doc, ref.clipId);
  if (!loc || loc.clip.kind === "audio") return false;
  const want = Math.max(0, Math.min(loc.clip.durationMs, targetMs));
  if (ref.kind === "layer") {
    const spec = loc.clip[ref.side === "in" ? "animIn" : "animOut"];
    if (!spec) return false;
    spec.durationMs = Math.round(want);
    return true;
  }
  if (loc.clip.kind !== "text") return false;
  const spec = loc.clip.animations[ref.side === "in" ? "in" : "out"];
  if (!spec) return false;
  const current = glyphAnimSpanMs(loc.clip, spec);
  if (current <= 0) return false;
  const factor = Math.max(0.02, want / current);
  spec.durationMs = Math.max(1, Math.round(spec.durationMs * factor));
  spec.staggerMs = Math.max(0, Math.round(spec.staggerMs * factor));
  spec.delayMs = Math.max(0, Math.round(spec.delayMs * factor));
  return true;
}

/** Swap the preset while keeping the timing the user tuned. */
export function retargetEdgeDecor(doc: MotionDocument, ref: EdgeRef, presetId: string): boolean {
  if (ref.kind === "transition") {
    const found = findTransition(doc, ref.id);
    if (!found || found.track.locked) return false;
    const { track, transition } = found;
    track.transitions[track.transitions.findIndex((t) => t.id === ref.id)] = retargetTransition(
      transition,
      presetId,
    );
    return true;
  }
  const loc = locateClip(doc, ref.clipId);
  if (!loc || loc.clip.kind === "audio") return false;
  if (ref.kind === "layer") {
    const field = ref.side === "in" ? "animIn" : "animOut";
    loc.clip[field] = retargetLayerSpec(loc.clip[field], presetId);
    return true;
  }
  if (loc.clip.kind !== "text") return false;
  const field = ref.side === "in" ? "in" : "out";
  loc.clip.animations[field] = retargetAnimSpec(loc.clip.animations[field], presetId);
  return true;
}

// ── Clipboard ────────────────────────────────────────────────────────────────

/**
 * A decoration lifted off its clip: the SPEC without the identity.
 *
 * A transition carries its split as a RATIO rather than ms so pasting a centred
 * cut onto a short one lands centred instead of lopsided (the same reasoning
 * `pasteOverrides` already used, now stated once).
 */
export type EdgeClipboard =
  | { kind: "layer"; side: ClipEdgeSide; spec: LayerAnimationSpec }
  | { kind: "text"; side: ClipEdgeSide; spec: AnimationSpec }
  | {
      kind: "transition";
      /**
       * Which edge it was lifted from — "in" a lone head, "out" a lone tail,
       * "cut" a seam between two clips. A paste reproduces the SHAPE it was
       * copied from: copying one end of a clip and pasting it elsewhere used to
       * blanket both ends of the target, which is never what was asked for.
       */
      side: ClipEdgeSide | "cut";
      preset: string;
      durationMs: number;
      splitRatio: number;
      easing: Transition["easing"];
      params: Record<string, number>;
      color: string | null;
    };

/** Lift a decoration into a clipboard payload. */
export function readEdgeDecor(doc: MotionDocument, ref: EdgeRef): EdgeClipboard | null {
  if (ref.kind === "transition") {
    const found = findTransition(doc, ref.id);
    if (!found) return null;
    const t = found.transition;
    return {
      kind: "transition",
      side: t.aClipId && t.bClipId ? "cut" : t.aClipId ? "out" : "in",
      preset: t.preset,
      durationMs: t.durationMs,
      splitRatio: t.durationMs > 0 ? t.splitMs / t.durationMs : 0.5,
      easing: t.easing,
      params: { ...t.params },
      color: t.color,
    };
  }
  const loc = locateClip(doc, ref.clipId);
  if (!loc || loc.clip.kind === "audio") return null;
  if (ref.kind === "layer") {
    const spec = loc.clip[ref.side === "in" ? "animIn" : "animOut"];
    return spec ? { kind: "layer", side: ref.side, spec: structuredClone(spec) } : null;
  }
  if (loc.clip.kind !== "text") return null;
  const spec = loc.clip.animations[ref.side === "in" ? "in" : "out"];
  return spec ? { kind: "text", side: ref.side, spec: structuredClone(spec) } : null;
}

/** Human name for a payload — what the toast and the paste menu item say. */
export function edgeClipboardLabel(entry: EdgeClipboard): string {
  if (entry.kind === "transition") return getTransitionPreset(entry.preset)?.label ?? entry.preset;
  return getPreset(entry.spec.preset)?.label ?? entry.spec.preset;
}

/**
 * Paste a payload onto clips.
 *
 * The GRAIN adapts to the target rather than refusing: a glyph animation
 * dropped on a rectangle becomes the same preset at LAYER grain (the two
 * grains share one preset registry, so this is a translation, not a guess),
 * and a layer animation dropped on text stays a layer animation — which is
 * exactly what the user asked for by dropping it there. Returns how many
 * clips took it.
 */
export function applyEdgeClipboard(
  doc: MotionDocument,
  entry: EdgeClipboard,
  clipIds: readonly string[],
): number {
  if (entry.kind === "transition") {
    return applyTransitionToClips(
      doc,
      clipIds,
      entry.preset,
      {
        durationMs: entry.durationMs,
        splitMs: entry.durationMs * entry.splitRatio,
        easing: entry.easing,
        params: { ...entry.params },
        color: entry.color,
      },
      // A seam belongs to both of its clips, so it spreads across every cut the
      // selection touches; a lone edge only ever reproduces its own end.
      entry.side === "cut" ? "any" : entry.side,
    );
  }
  let applied = 0;
  for (const clipId of clipIds) {
    const loc = locateClip(doc, clipId);
    if (!loc || loc.track.locked || loc.clip.kind === "audio") continue;
    const clip = loc.clip;
    if (entry.kind === "text" && clip.kind === "text") {
      clip.animations[entry.side === "in" ? "in" : "out"] = structuredClone(entry.spec);
    } else if (entry.kind === "text") {
      // Same preset, coarser grain — a rectangle has no glyphs to stagger.
      clip[entry.side === "in" ? "animIn" : "animOut"] = {
        ...layerSpecFromPreset(entry.spec.preset),
        durationMs: Math.max(1, entry.spec.durationMs),
        easing: entry.spec.easing,
        params: { ...entry.spec.params },
      };
    } else {
      clip[entry.side === "in" ? "animIn" : "animOut"] = structuredClone(entry.spec);
    }
    applied++;
  }
  return applied;
}

/**
 * Put a LAYER animation on every given clip — the one seam behind clicking an
 * animation preset in the library, dropping one on a clip, and the inspector's
 * preset picker. Deliberately layer-grained for every clip kind INCLUDING text:
 * "animate this layer" is what the gesture promises, and a text clip's glyph
 * animation is a separate, explicitly text-scoped control.
 */
export function applyLayerAnimToClips(
  doc: MotionDocument,
  clipIds: readonly string[],
  presetId: string,
  side: ClipEdgeSide,
): number {
  const field = side === "in" ? "animIn" : "animOut";
  let applied = 0;
  for (const clipId of clipIds) {
    const loc = locateClip(doc, clipId);
    if (!loc || loc.track.locked || loc.clip.kind === "audio") continue;
    loc.clip[field] = retargetLayerSpec(loc.clip[field], presetId);
    applied++;
  }
  return applied;
}
