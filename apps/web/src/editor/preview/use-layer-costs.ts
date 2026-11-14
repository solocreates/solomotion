"use client";

import * as React from "react";
import type { LayerCost } from "@solomotion/core";
import { renderProfiler } from "../stage/render/profiler-instance";

/**
 * WHAT EACH LAYER COSTS, as React state — for the timeline, which is where a
 * person already is when they wonder why the app got slow.
 *
 * The profiler is a module singleton written to dozens of times per frame and
 * read a few times a second, which is exactly why it is not in a store: putting
 * it there would re-render React on every layer of every frame to carry numbers
 * nobody is looking at yet, and a profiler that makes the thing it measures
 * slower is a profiler that lies.
 *
 * So it is POLLED, slowly, and polled ONCE. Three times a second is faster than
 * anyone can read a changing number and slow enough to be free; one shared
 * timer rather than one per clip, because a forty-layer board would otherwise
 * run forty intervals to read one object. Nothing polls at all while no clip is
 * mounted.
 *
 * The numbers are already normalised to full resolution and already exclude
 * layer-cache hits (see `core/preview/profiler.ts`), so dropping a preview tier
 * does not make the project look cheaper and a cached layer does not vanish
 * from the list at the exact moment you go looking for it.
 */

const POLL_MS = 320;

export interface LayerCostMap {
  /** Cost per FRAME at full resolution, keyed by clip id. */
  byClip: Map<string, LayerCost>;
  /** The most expensive layer — what a relative bar would be scaled against. */
  peakMs: number;
}

const EMPTY: LayerCostMap = { byClip: new Map(), peakMs: 0 };

let current: LayerCostMap = EMPTY;
let timer = 0;
const listeners = new Set<() => void>();

function sample(): void {
  const profile = renderProfiler.read();
  // Per FRAME, not per window: the window halves itself when it fills, and a
  // raw total would make every number on screen jump when it does.
  const frames = Math.max(1, profile.frames);
  const byClip = new Map<string, LayerCost>();
  let peakMs = 0;
  let changed = profile.layers.length !== current.byClip.size;
  for (const row of profile.layers) {
    const totalMs = row.totalMs / frames;
    // A number that has not visibly moved keeps its OBJECT: `useLayerCost`
    // readers compare by identity, so a clip whose cost held still does not
    // re-render — the whole timeline did, three times a second, before.
    const prev = current.byClip.get(row.clipId);
    const same = !!prev && Math.abs(prev.totalMs - totalMs) < Math.max(0.05, prev.totalMs * 0.05) && prev.name === row.name;
    const perFrame: LayerCost = same ? prev! : { ...row, totalMs };
    if (!same) changed = true;
    byClip.set(row.clipId, perFrame);
    if (perFrame.totalMs > peakMs) peakMs = perFrame.totalMs;
  }
  if (!changed) return;
  current = { byClip, peakMs };
  for (const cb of listeners) cb();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (timer === 0) {
    sample();
    timer = window.setInterval(sample, POLL_MS);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) {
      window.clearInterval(timer);
      timer = 0;
    }
  };
}

export function useLayerCosts(): LayerCostMap {
  return React.useSyncExternalStore(
    subscribe,
    () => current,
    () => EMPTY,
  );
}

/** One layer's cost, without re-rendering for every other layer's. */
export function useLayerCost(clipId: string): LayerCost | undefined {
  return React.useSyncExternalStore(
    subscribe,
    () => current.byClip.get(clipId),
    () => undefined,
  );
}
