import {
  characterOf,
  MIXED,
  clipHasSound,
  isCaptionClip,
  isVisualClip,
  nestedIsAudioOnly,
  type MotionDocument,
  type Clip,
  type KeyframeValue,
} from "@solomotion/core";
import type { InspectorTabId } from "../state/session";

/**
 * The headless selection brain: which tabs a selection offers and what the
 * panel is about. The fields themselves are the sections' own — merged across
 * the selection by the scope (`selection-scope.tsx`) rather than re-listed
 * here from the registry, which is how multi-select used to become a flat
 * list of numbers instead of the panel you know.
 */

/** A field whose selected clips disagree on the value (Figma's "Mixed") —
 *  core's own sentinel, so a list's `sharedList` and a scalar's merge cannot
 *  disagree about what "mixed" is. */
export { MIXED };
export type FieldValue = KeyframeValue | typeof MIXED;

/**
 * The inspector's tab spine — ONE definition, used by the single-clip panel, the
 * multi-select panel and the shared-property brain alike. It used to be three
 * hand-written arrays in Inspector.tsx plus this type, which is why a text layer
 * and a shape layer disagreed about what a tab even was.
 *
 * `effects` is a first-class tab as of the v49 sidebar: the effect stack is what
 * people come to this app for, and it was living collapsed at the bottom of a
 * 900px scroll.
 */
// One name for the tab id: the session stores it, this file decides it. Two
// hand-kept unions of the same seven words were waiting to disagree.
export type InspectorTab = InspectorTabId;

const TAB_ORDER: InspectorTab[] = ["design", "character", "effects", "animate", "track", "physics", "sound", "cues"];

/**
 * A PROCESSOR leads with Effects, because an adjustment layer IS its effect
 * stack — landing it on Design puts a scope picker where the reason you clicked
 * the layer should be. The order is per-selection rather than a second constant
 * so "the first tab" stays one idea: `sectionsFor`'s `home` slot (Timing,
 * Export) follows it automatically, which is the whole point of deriving it.
 */
function tabOrderFor(clips: Clip[]): InspectorTab[] {
  return clips.length > 0 && clips.every((c) => c.kind === "adjustment")
    ? ["effects", "design", "character", "animate", "track", "physics", "sound", "cues"]
    : TAB_ORDER;
}

/** The tabs a single clip exposes — mirrors the single-clip inspector, headless. */
export function clipTabs(clip: Clip, doc: MotionDocument): Set<InspectorTab> {
  const tabs = new Set<InspectorTab>();
  if (isVisualClip(clip)) {
    tabs.add("design");
    tabs.add("animate");
    // EVERY visual layer, processors emphatically included. An adjustment layer
    // IS its effect stack, and it used to be the one kind whose stack you could
    // not reach by selecting it: the tab was withheld on the theory that its
    // own inspector edited the grade, which it never did — it edits scope. The
    // stack was reachable only through the frame panel, so a second adjustment
    // in the same comp had no editor at all.
    tabs.add("effects");
    // PHYSICS (v92): anything with a body to give — a layer, a mesh, a null
    // that carries a field. A processor, a camera and a light have none.
    if (clip.kind !== "adjustment" && clip.kind !== "camera" && clip.kind !== "light") tabs.add("physics");
    // CHARACTER (Characters 2.0, ux.md §2.1): a group with a rig or pose sets,
    // or any part of one — a part opens its character's Face pad.
    if (characterOf(doc, clip.id)) tabs.add("character");
    // TRACK (v101): footage is where trackers are drawn; any other layer can
    // FOLLOW one once the project has any. A processor has no pose to give.
    if (clip.kind !== "adjustment" && (clip.kind === "video" || clip.kind === "image" || !!clip.trackBinding || doc.trackers.length > 0)) tabs.add("track");
  }
  // A caption's cue list — the only tab a caption adds over a text layer.
  if (isCaptionClip(clip)) tabs.add("cues");
  // CAPABILITY, not current state. Gating on `clipHasSound` was a chicken-and-egg
  // bug the moment sound stopped being text-only: a shape with no sound yet got
  // no Sound tab, and the tab was the only place to add one. Any clip that can
  // carry a stack entry gets the tab; the panel's own empty state does the rest.
  if (clip.kind === "audio" || isVisualClip(clip) || clipHasSound(doc, clip)) tabs.add("sound");
  return tabs;
}

/** Tabs common to EVERY selected clip, in canonical order — EXCEPT Sound, which
 * is UNION (shown if ANY selected clip carries sound), so a mixed selection can
 * still control the sounds it contains. */
export function sharedTabs(clips: Clip[], doc: MotionDocument): InspectorTab[] {
  if (clips.length === 0) return [];
  const sets = clips.map((c) => clipTabs(c, doc));
  return tabOrderFor(clips).filter((t) =>
    t === "sound" ? sets.some((s) => s.has(t)) : sets.every((s) => s.has(t)),
  );
}

/**
 * The tabs the panel offers for a selection — the ONE answer, for one layer or
 * fifty. The two kind rules that used to live in the single-layer component:
 *
 *  - an AUDIO-ONLY nested comp reads as audio, so Sound is the whole panel;
 *  - a VIDEO keeps its sound under Design, beside its picture, so a selection
 *    of videos has no Sound tab of its own.
 */
export function inspectorTabs(clips: Clip[], doc: MotionDocument): InspectorTab[] {
  if (clips.length > 0 && clips.every((c) => c.kind === "nested" && nestedIsAudioOnly(doc, c))) return ["sound"];
  const soundElsewhere = clips.length > 0 && clips.every((c) => c.kind === "video");
  // A layer in a still has one instant: nothing to animate, nothing to hear.
  const still = clips.length > 0 && clips.every((c) => inStill(doc, c));
  return sharedTabs(clips, doc).filter(
    (t) => (t !== "sound" || !soundElsewhere) && !(still && (t === "animate" || t === "sound" || t === "physics")),
  );
}

/** Is this layer in a STATIC frame — one instant, no clock? */
export function inStill(doc: MotionDocument, clip: Clip): boolean {
  return doc.frames.find((f) => f.id === clip.frameId)?.mode === "static";
}

/* ─────────────────────────────────────────── what the panel is looking at ── */

/**
 * WHAT THE RIGHT PANEL IS ABOUT — one resolved subject, decided once.
 *
 * ## The rule
 *
 * **The panel is the SUBJECT's. The stage's top bar is the TOOL's.**
 *
 * Layers first, then the artboard, then the project. A tool never becomes a
 * subject, because a tool is not a thing you are looking at — it is a thing you
 * are holding, and its settings now sit under the hand holding it (see
 * `stage/tool-bar-kit.tsx`).
 *
 * There used to be a fourth rung: with nothing selected, a creating tool put
 * its DEFAULTS here. Two things were wrong with it and the second is the one
 * that mattered. It read as an override of your layer (arming the text tool
 * replaced a selected layer's whole property stack, so the way to see your
 * layer again was to put the tool down) — that was fixed by demoting it to a
 * fallback. But the fallback is not much better: settings you can only reach by
 * deselecting, that disappear the moment you click your own artwork, live on
 * the far side of the screen from the tool, and duplicate a bar the pen and
 * brush already had. `hasToolDefaults` is gone with the panel it selected.
 *
 * `frameTool` is the one tool that stays a subject, and it earns the exception
 * by not being a style at all: it is a placement tool with a searchable
 * CATALOGUE of artboard sizes, which is panel-shaped in a way no strip across
 * the top of the canvas can be. Selected layers still outrank it.
 *
 * Pure and total, so the precedence is one testable fact rather than a ladder
 * of `? :` in a component.
 */
export type InspectorSubject =
  | { kind: "soundBus"; busId: string }
  | { kind: "clips"; clips: Clip[] }
  | { kind: "frame"; frameId: string }
  | { kind: "framePresets" }
  | { kind: "project" };

export function inspectorSubject(input: {
  /** Layers selected in the timeline / layers list / canvas, in pick order. */
  clips: Clip[];
  /** The artboard the frame panel would edit (the primary of a frame selection). */
  frameId: string | null;
  /** The armed tool is the frame tool. */
  frameTool: boolean;
  /** A sound category opened from the current selection (already checked against it). */
  soundBusId?: string | null;
}): InspectorSubject {
  // Opened on purpose FROM the selection, so it outranks it — and falls away
  // the moment the selection changes (see `inspectedSoundBus`).
  if (input.soundBusId) return { kind: "soundBus", busId: input.soundBusId };
  if (input.clips.length > 0) return { kind: "clips", clips: input.clips };
  if (input.frameId) return { kind: "frame", frameId: input.frameId };
  if (input.frameTool) return { kind: "framePresets" };
  return { kind: "project" };
}
