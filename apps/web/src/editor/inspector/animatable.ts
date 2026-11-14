"use client";

import * as React from "react";
import {
  propertyHasKeys,
  channelPartners,
  frameEvalTimeMs,
  sampleKeyframes,
  setClipProperty,
  writeChannel,
  type Clip,
  type KeyframeValue,
  type MotionDocument,
} from "@solomotion/core";
import { useSession } from "../state/session";
import { peekDoc } from "../state/document-context";
import type { Field } from "./merge";

/**
 * The app-wide animatable-value rule (After Effects semantics):
 *  - a property WITHOUT keyframes reads/writes its base value;
 *  - a property WITH keyframes is owned by them — the UI shows the sampled
 *    value at the playhead, and edits write a keyframe right there;
 *  - in RECORD mode, every animatable edit writes a keyframe at the playhead
 *    (planting the first key if needed) — this is the Figma-Motion behavior.
 * Every surface (inspector, canvas drags, nudges) goes through `animWriteMode`
 * (via `writeAnimatable`/`commitProperty`), so this policy lives in ONE place.
 */

export type AnimWriteMode = "base" | "keyframe";

/**
 * The clip-local instant an edit at the playhead lands on — THE time every
 * keyframe write and keyed read goes through: the instant the comp is SHOWING
 * (`frameEvalTimeMs`, the render clock), never the playhead's raw millisecond.
 *
 * The picture is the frame the playhead is INSIDE, drawn at that frame's start.
 * A key written at the raw playhead — 1010ms, inside the frame that starts at
 * 1000 — sat after the instant on screen, so a held value (a text's words, a
 * drawing, a switch) changed one frame LATE and a tweened one was a sliver off
 * where you set it. On the grid, the key is the frame you are looking at.
 *
 * In a STATIC frame that instant is the still, whatever the playhead says: a
 * still is edited at the moment it shows.
 */
export function clipLocalClamped(clip: Clip, playheadMs: number, doc: MotionDocument | null = peekDoc()): number {
  const home = doc?.frames.find((f) => f.id === clip.frameId);
  const at = doc && home ? frameEvalTimeMs(doc, home, playheadMs) : playheadMs;
  return Math.min(Math.max(at - clip.startMs, 0), clip.durationMs);
}

/** The single decision point every animatable write (and pre-write check) goes through. */
export function animWriteMode(clip: Clip, property: string): AnimWriteMode {
  const recording = useSession.getState().recording;
  return recording || propertyHasKeys(clip.keyframes, property) ? "keyframe" : "base";
}

/**
 * Write a value: a keyframe at the playhead when the property is keyed OR
 * record mode is armed; otherwise the base slot.
 */
export function writeAnimatable(
  clip: Clip,
  property: string,
  value: KeyframeValue,
  playheadMs: number,
  writeBase: (clip: Clip) => void,
): void {
  // A linked pair (x/y, scale X/Y…) is keyed as one — see core `writeChannel`.
  const partnerKeyed = channelPartners(property).some((p) => propertyHasKeys(clip.keyframes, p));
  if (animWriteMode(clip, property) === "keyframe" || partnerKeyed) {
    writeChannel(clip, property, clipLocalClamped(clip, playheadMs), value, { forceKey: true });
  } else {
    writeBase(clip);
  }
}

/**
 * The fully path-driven write — the one every field should call. The base
 * setter is derived from the path (core's `setClipProperty`), so no call site
 * hand-writes a closure per property. Record mode and keyframing wrap this
 * uniformly, so ANY value (transform, typography, an effect-stack field,
 * highlight) keyframes the same way with zero extra plumbing. Mutates — call
 * inside a document update.
 */
export function commitProperty(
  clip: Clip,
  path: string,
  value: KeyframeValue,
  playheadMs: number,
): void {
  writeAnimatable(clip, path, value, playheadMs, (c) => setClipProperty(c, path, value));
}

/** Read the effective value at a time: sampled when keyed, else base. */
export function effectiveValue<T extends KeyframeValue>(
  clip: Clip,
  property: string,
  base: T,
  playheadMs: number,
  doc: MotionDocument | null = peekDoc(),
): T {
  if (!propertyHasKeys(clip.keyframes, property)) return base;
  const local = clipLocalClamped(clip, playheadMs, doc);
  const sampled = sampleKeyframes(clip.keyframes, local)[property];
  return (sampled === undefined ? base : sampled) as T;
}

/**
 * Reactive effective value. Subscribes to the playhead but snapshots through
 * the displayed value, so it only re-renders when that value actually changes
 * (and never for un-keyed properties).
 */
export function useEffectiveValue<T extends KeyframeValue>(
  clip: Clip | undefined,
  property: string,
  base: T,
): T {
  const subscribe = React.useCallback((cb: () => void) => useSession.subscribe(cb), []);
  const clipRef = React.useRef(clip);
  clipRef.current = clip;
  const baseRef = React.useRef(base);
  baseRef.current = base;

  const get = React.useCallback((): T => {
    const c = clipRef.current;
    if (!c) return baseRef.current;
    const v = effectiveValue(c, property, baseRef.current, useSession.getState().playheadMs);
    // Quantize floats so playback re-renders only on visible changes.
    return (typeof v === "number" ? Math.round(v * 1000) / 1000 : v) as T;
  }, [property]);

  return React.useSyncExternalStore(
    subscribe,
    get,
    () => baseRef.current,
  );
}

/** Quantise a displayed float so playback re-renders only on visible changes. */
function shown(v: KeyframeValue): KeyframeValue {
  return typeof v === "number" ? Math.round(v * 1000) / 1000 : v;
}

/**
 * THE READ SEAM for an animatable field, across the selection.
 *
 * `peers` comes from `usePeers` — the primary first — and `base` reads each
 * peer's own un-keyed value, so a layer that is keyed and a layer that is not
 * are each read the way the renderer reads them. The value shown is the
 * primary's at the playhead; `mixed` is whether any peer shows something else
 * right now. A selection of one is simply never mixed.
 */
export function useField<C extends Clip, T extends KeyframeValue>(
  peers: readonly C[],
  property: string,
  base: (c: C) => T,
): Field<T> {
  const subscribe = React.useCallback((cb: () => void) => useSession.subscribe(cb), []);
  const live = React.useRef({ peers, base });
  live.current = { peers, base };
  const last = React.useRef<Field<T> | null>(null);

  const get = React.useCallback((): Field<T> => {
    const { peers: list, base: read } = live.current;
    const ph = useSession.getState().playheadMs;
    const at = (c: C) => shown(effectiveValue(c, property, read(c), ph)) as T;
    const value = at(list[0]!);
    let mixed = false;
    for (let i = 1; i < list.length && !mixed; i++) mixed = !Object.is(value, at(list[i]!));
    const prev = last.current;
    if (prev && Object.is(prev.value, value) && prev.mixed === mixed) return prev;
    return (last.current = { value, mixed });
  }, [property]);

  // `get` reads the peers through a ref updated every render, so an edit or a
  // new selection is picked up by the render itself; the subscription covers
  // the playhead moving under a keyed value.
  return React.useSyncExternalStore(subscribe, get, get);
}
