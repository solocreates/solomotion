"use client";

import {
  compFps,
  frameStepMs,
  locateClip,
  recordTake,
  recordTriggerTake,
  setClipProperty,
  TakeRefused,
  type DocumentStore,
  type KeyframeValue,
  type TakeSample,
  type TriggerEvent,
} from "@solomotion/core";
import { useSession } from "../state/session";
import { clipLocalClamped } from "../inspector/animatable";
import { effectiveWorkRange } from "../timeline/work-range";
import { timelineEndMs } from "../timeline/timeline-utils";
import { toast } from "@/lib/toast";
import { setPerformSink, usePerform } from "./state";

/**
 * THE TAKE RECORDER — the one place Perform's time lives.
 *
 * Gestures say WHAT a channel should be (`feed`); the recorder says WHEN. It
 * samples on the playback clock — every time the transport moves the playhead
 * it records the live values at that instant, clip-local and frame-quantised
 * through the same `clipLocalClamped` every keyed write uses — so a take is
 * exact against what was on screen, never wall-clock time.
 *
 * While a take runs, the performed channels show the hand, not their old keys:
 * a store OVERLAY holds each one at its live value (its track hidden), so the
 * picture follows the pointer and history is untouched. On release (touch) or
 * when playback stops (latch), the overlay clears and the whole take is written
 * by core's `recordTake` in ONE `store.update` — one undo step per take.
 *
 * R (session.recording) decides whether a pass is a take. Off, the same
 * gestures rehearse: the overlay previews and nothing is written. On and
 * paused, the first gesture counts in (2, 1) and starts the transport.
 */

interface Capture {
  clipId: string;
  paths: string[];
  values: Record<string, KeyframeValue>;
  samples: TakeSample[];
  /** The pointer let go; a latch keeps sampling the last values until playback stops. */
  released: boolean;
  /** This pass writes (Rec was on when it began sampling). */
  takes: boolean;
}

interface TriggerTake {
  clipId: string;
  path: string;
  events: TriggerEvent[];
  held: KeyframeValue[];
  rest: boolean;
}

const COUNT_MS = 500;

let store: DocumentStore | null = null;
let capture: Capture | null = null;
let triggers: TriggerTake | null = null;
let unsub: (() => void) | null = null;
let countTimer: ReturnType<typeof setTimeout> | null = null;
let lastPlayhead = NaN;

const recording = () => useSession.getState().recording;
const playing = () => useSession.getState().playing;

function localNow(clipId: string): number | null {
  const doc = store?.getState();
  const clip = doc && locateClip(doc, clipId)?.clip;
  return clip ? clipLocalClamped(clip, useSession.getState().playheadMs) : null;
}

/** The overlay: every live channel held at its performed value. */
function showLive(): void {
  if (!store) return;
  const live: Array<{ clipId: string; path: string; value: KeyframeValue }> = [];
  if (capture) for (const p of capture.paths) live.push({ clipId: capture.clipId, path: p, value: capture.values[p]! });
  if (triggers && triggers.held.length) live.push({ clipId: triggers.clipId, path: triggers.path, value: triggers.held[triggers.held.length - 1]! });
  if (!live.length) return store.setOverlay(null);
  store.setOverlay((d) => {
    for (const w of live) {
      const c = locateClip(d, w.clipId)?.clip;
      if (!c) continue;
      c.keyframes = c.keyframes.filter((t) => t.property !== w.path || !!t.range);
      setClipProperty(c, w.path, w.value);
    }
  });
}

function sample(): void {
  if (capture?.takes) {
    const t = localNow(capture.clipId);
    if (t !== null) capture.samples.push({ t, v: capture.paths.map((p) => capture!.values[p]!) });
  }
}

function stepMsOf(clipId: string): number | undefined {
  const doc = store?.getState();
  const clip = doc && locateClip(doc, clipId)?.clip;
  return doc && clip ? frameStepMs(compFps(doc, clip.frameId)) : undefined;
}

function report(keys: number): void {
  const s = usePerform.getState();
  usePerform.setState({ takes: s.takes + 1 });
  toast(`Take recorded — ${keys} keys`, {
    action: { label: "Undo", onClick: () => store?.undo() },
  });
}

/** Write the open capture as one take (or drop it, when it rehearsed). */
function commitCapture(): void {
  const c = capture;
  capture = null;
  if (!store || !c) return showLive();
  store.setOverlay(null);
  showLive();
  if (!c.takes || !c.samples.length) return;
  let written = 0;
  try {
    store.update("Perform take", (d) => {
      const r = recordTake(d, c.clipId, c.paths, c.samples, { stepMs: stepMsOf(c.clipId), smoothMs: 12 });
      written = Object.values(r.keys).reduce((a, b) => a + b, 0);
    });
  } catch (err) {
    if (err instanceof TakeRefused) return void toast.error(err.message);
    throw err;
  }
  if (written) report(written);
}

function commitTriggers(): void {
  const t = triggers;
  triggers = null;
  showLive();
  if (!store || !t || !t.events.length) return;
  const doc = store.getState();
  const clip = locateClip(doc, t.clipId)?.clip;
  if (!clip) return;
  const range = effectiveWorkRange(clip.frameId);
  const loop = range
    ? { startMs: range.startMs - clip.startMs, endMs: range.endMs - clip.startMs }
    : { startMs: -clip.startMs, endMs: timelineEndMs(doc, clip.frameId) - clip.startMs };
  // Anything still held lets go where the take ended.
  const end = localNow(t.clipId);
  const events = [...t.events];
  if (end !== null) for (const v of t.held) events.push({ t: end, kind: "up", value: v });
  let written = 0;
  try {
    store.update("Perform take", (d) => {
      const r = recordTriggerTake(d, t.clipId, t.path, events, usePerform.getState().latch ? "latch" : "touch", { stepMs: stepMsOf(t.clipId), loop });
      written = r.keys[t.path] ?? 0;
    });
  } catch (err) {
    if (err instanceof TakeRefused) return void toast.error(err.message);
    throw err;
  }
  if (written) report(written);
}

/** Paused with Rec on: count in, then roll. */
function countIn(then: () => void): void {
  if (countTimer) return;
  usePerform.setState({ countIn: 2 });
  countTimer = setTimeout(() => {
    usePerform.setState({ countIn: 1 });
    countTimer = setTimeout(() => {
      countTimer = null;
      usePerform.setState({ countIn: null });
      if (!usePerform.getState().active) return;
      useSession.getState().setPlaying(true);
      then();
    }, COUNT_MS);
  }, COUNT_MS);
}

function beginCapture(clipId: string, values: Record<string, KeyframeValue>): void {
  if (capture && capture.clipId === clipId && !capture.released) return;
  if (capture) commitCapture();
  const rolling = playing();
  capture = { clipId, paths: Object.keys(values), values: { ...values }, samples: [], released: false, takes: rolling && recording() };
  if (capture.takes) sample();
  else if (recording() && !rolling) {
    const c = capture;
    countIn(() => {
      if (capture !== c) return;
      c.takes = true;
      sample();
    });
  }
}

// ── The public face ─────────────────────────────────────────────────────────

export const recorder = {
  /** A gesture's live values (pointer drags; the rig overlay through the tap). */
  feed(clipId: string, values: Record<string, KeyframeValue>): boolean {
    if (!capture || capture.clipId !== clipId || capture.released) beginCapture(clipId, values);
    const c = capture!;
    for (const [p, v] of Object.entries(values)) {
      if (!c.paths.includes(p)) c.paths.push(p);
      c.values[p] = v;
    }
    // Paused: a press-and-release with Rec on and no roll is still a key.
    showLive();
    return true;
  },
  /** The gesture's pointer let go. */
  release(): boolean {
    if (!capture) return false;
    capture.released = true;
    if (!usePerform.getState().latch || !playing()) {
      if (countTimer && !capture.takes) {
        clearTimeout(countTimer);
        countTimer = null;
        usePerform.setState({ countIn: null });
      }
      commitCapture();
    }
    return true;
  },
  /** A lost pointer: the held take is dropped, never written (a latched one already let go). */
  abortHeld(): void {
    if (!capture || capture.released) return;
    capture = null;
    if (countTimer) clearTimeout(countTimer);
    countTimer = null;
    usePerform.setState({ countIn: null });
    showLive();
  },
  /** A trigger pressed (a 1–9 key, a pad button). */
  press(clipId: string, path: string, value: KeyframeValue): void {
    if (triggers && (triggers.clipId !== clipId || triggers.path !== path)) commitTriggers();
    if (!triggers) triggers = { clipId, path, events: [], held: [], rest: true };
    const tk = triggers;
    const latch = usePerform.getState().latch;
    tk.held = latch ? [value] : [...tk.held.filter((v) => v !== value), value];
    showLive();
    const at = () => {
      const t = localNow(clipId);
      if (t !== null && triggers === tk) tk.events.push({ t, kind: "down", value });
    };
    if (playing() && recording()) at();
    else if (recording()) countIn(at);
  },
  release_trigger(clipId: string, path: string, value: KeyframeValue): void {
    const tk = triggers;
    if (!tk || tk.clipId !== clipId || tk.path !== path) return;
    if (usePerform.getState().latch) return;
    tk.held = tk.held.filter((v) => v !== value);
    if (playing() && recording()) {
      const t = localNow(clipId);
      if (t !== null && tk.events.length) tk.events.push({ t, kind: "up", value });
    }
    showLive();
    if (!playing() && !tk.held.length) commitTriggers();
  },
  /** Leaving Perform (or the transport stopping): everything open is written. */
  flush(): void {
    if (capture) commitCapture();
    if (triggers) commitTriggers();
  },
};

/** Start listening to the playback clock; returns the stop. */
export function attachRecorder(s: DocumentStore): () => void {
  store = s;
  setPerformSink({ feed: recorder.feed, release: recorder.release });
  lastPlayhead = useSession.getState().playheadMs;
  let wasPlaying = playing();
  unsub = useSession.subscribe((st) => {
    if (st.playheadMs !== lastPlayhead) {
      lastPlayhead = st.playheadMs;
      if (st.playing) sample();
    }
    if (wasPlaying && !st.playing) recorder.flush();
    wasPlaying = st.playing;
  });
  return () => {
    recorder.flush();
    unsub?.();
    unsub = null;
    setPerformSink(null);
    store?.setOverlay(null);
    store = null;
  };
}
