"use client";

import { create } from "zustand";

/**
 * PERFORM — the mode's UI state. Tiny on purpose: the chip, the shortcut and
 * the rig overlay import it; the recorder and the pad load lazily on entry.
 *
 * Recording is NOT here: `session.recording` (R) is the one record switch in
 * the app. In Perform it means "this pass is a take"; off, a pass rehearses.
 */
export interface PerformState {
  active: boolean;
  /** Touch: records only while held. Latch: holds the last value until playback stops. */
  latch: boolean;
  /** Which armed set the pad (and 1–9) drives. */
  setIndex: number;
  /** Takes written this session (the pad's count). */
  takes: number;
  /** The count-in on the chip (2, 1), null when not counting. */
  countIn: number | null;
  enter(): void;
  exit(): void;
  toggle(): void;
  setLatch(v: boolean): void;
  setSetIndex(i: number): void;
}

export const usePerform = create<PerformState>((set, get) => ({
  active: false,
  latch: false,
  setIndex: 0,
  takes: 0,
  countIn: null,
  enter: () => set({ active: true }),
  exit: () => set({ active: false, countIn: null }),
  toggle: () => (get().active ? get().exit() : get().enter()),
  setLatch: (latch) => set({ latch }),
  setSetIndex: (setIndex) => set({ setIndex }),
}));

/**
 * The gesture tap. Canvas gestures that already compute channel values (the
 * rig overlay's turn / reach / move) hand them here first; while Perform is on,
 * the recorder takes them instead of the document. The recorder installs the
 * sink when it loads, so a gesture never imports it.
 */
export interface PerformSink {
  feed(clipId: string, values: Record<string, number>): boolean;
  release(): boolean;
}

let sink: PerformSink | null = null;

export function setPerformSink(s: PerformSink | null): void {
  sink = s;
}

/** Offer a gesture's values to Perform. True = taken (do not preview or commit them yourself). */
export function performFeed(clipId: string, values: Record<string, number>): boolean {
  return usePerform.getState().active && !!sink && sink.feed(clipId, values);
}

/** The gesture's pointer let go. True = Perform owned the gesture. */
export function performRelease(): boolean {
  return usePerform.getState().active && !!sink && sink.release();
}
