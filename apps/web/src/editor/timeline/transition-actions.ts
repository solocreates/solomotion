"use client";

import { create } from "zustand";
import {
  MIN_TRANSITION_MS,
  applyTransition,
  applyTransitionAtTime,
  findTransition,
  getTransitionPreset,
  removeTransition,
  type MotionDocument,
  type DocumentStore,
  type Transition,
  type TransitionTarget,
} from "@solomotion/core";

/**
 * Transition COMMANDS — the shared verbs behind the timeline badge's context
 * menu, the preset browser's drop, the keyboard shortcut and the inspector.
 * Everything routes through the core ops, so a transition applied by dragging a
 * card and one applied by ⌘D are byte-identical records.
 */

const DEFAULT_KEY = "tm-default-transition";
const FALLBACK_PRESET = "cross-dissolve";

interface TransitionPrefs {
  /** The preset ⌘D applies, and the one a fresh drop starts from. */
  defaultPreset: string;
  setDefaultPreset: (id: string) => void;
}

// Copy / cut / paste of a transition is NOT here: a transition is one of the
// three clip-edge decorations, and all three share ONE clipboard and one set of
// verbs in `edge-decor.tsx` (core `clip-edges.ts` is the brain). A second,
// transition-only clipboard is exactly the kind of duplicate that made ⌘V
// ambiguous.

function loadDefaultPreset(): string {
  try {
    const saved = typeof window === "undefined" ? null : window.localStorage.getItem(DEFAULT_KEY);
    return saved && getTransitionPreset(saved) ? saved : FALLBACK_PRESET;
  } catch {
    return FALLBACK_PRESET;
  }
}

export const useTransitionPrefs = create<TransitionPrefs>((set) => ({
  defaultPreset: loadDefaultPreset(),
  setDefaultPreset: (id) => {
    try {
      window.localStorage.setItem(DEFAULT_KEY, id);
    } catch {
      // storage unavailable — the session value still applies
    }
    set({ defaultPreset: id });
  },
}));

export function dropTransition(store: DocumentStore, target: TransitionTarget, presetId: string): void {
  const def = getTransitionPreset(presetId);
  store.update(`Add ${def?.label ?? "transition"}`, (d) => {
    applyTransition(d, target, presetId);
  });
}

/** Apply the DEFAULT transition at a moment — the one-keystroke gesture. */
export function applyDefaultTransition(
  store: DocumentStore,
  frameId: string,
  timeMs: number,
  toleranceMs: number,
  trackIds?: readonly string[],
): number {
  const presetId = useTransitionPrefs.getState().defaultPreset;
  const def = getTransitionPreset(presetId);
  let applied = 0;
  store.update(`Add ${def?.label ?? "transition"}`, (d) => {
    applied = applyTransitionAtTime(d, frameId, timeMs, presetId, toleranceMs, trackIds);
  });
  return applied;
}

export function deleteTransition(store: DocumentStore, id: string): void {
  store.update("Remove transition", (d) => {
    removeTransition(d, id);
  });
}

/** Mutate one transition in place, by id. */
export function editTransition(
  store: DocumentStore,
  id: string,
  label: string,
  fn: (transition: Transition, doc: MotionDocument) => void,
  mergeKey?: string,
): void {
  store.update(
    label,
    (d) => {
      const found = findTransition(d, id);
      if (found) fn(found.transition, d);
    },
    mergeKey ? { mergeKey } : undefined,
  );
}

/**
 * Where the cut sits within the span, as the three alignments every NLE offers.
 * Expressed purely as a `splitMs`, which is why they need no extra state.
 */
export type TransitionAlignment = "center" | "start" | "end";

export function alignmentOf(transition: Transition): TransitionAlignment {
  const ratio = transition.durationMs > 0 ? transition.splitMs / transition.durationMs : 0.5;
  if (ratio <= 0.02) return "start";
  if (ratio >= 0.98) return "end";
  return "center";
}

export function splitForAlignment(durationMs: number, alignment: TransitionAlignment): number {
  if (alignment === "start") return 0;
  if (alignment === "end") return durationMs;
  return durationMs / 2;
}

export { MIN_TRANSITION_MS };
