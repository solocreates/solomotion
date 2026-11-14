"use client";

import { frameStepMs, quantizeMsToFrame } from "@solomotion/core";
import { frameCacheStats } from "../stage/render/frame-store";
import {
  framesCacheOn,
  isCachingEnabled,
  isRollingCache,
  setRangeBuildActive,
  subscribeCacheStatus,
} from "../cache/cache-status";
import { useSession } from "../state/session";
import { useStatusBar } from "../state/status-bar";

/**
 * RENDER, THEN PLAY — the RAM preview build.
 *
 * A build is EXACT PLAYBACK, UNPACED: the same transport, the same clock (see
 * core's `exact-clock.ts`), the same stage render and the same caches — it just
 * advances the moment each instant has been shown exactly, instead of waiting
 * for that instant's turn on the wall clock. When the range is swept, playback
 * carries on from the top, paced, out of what was just kept. After Effects'
 * RAM preview, with the sweep visible on the timeline.
 *
 * It used to be a loop of its own beside the transport: set the playhead, poll
 * for a presentation, give up after a timeout, retry — with footage parked on
 * an exact SEEK per instant, which re-decodes from the keyframe every frame.
 * Two sweeps that had to agree about what "shown" means, and the slower of
 * them was the one the build button used. Now there is one, and footage is
 * stepped forward frame by frame (`conductStep` in media-cache).
 *
 * Interruptible at every instant: stopping playback cancels the build.
 */

export interface PrerenderRange {
  compId: string;
  fromMs: number;
  toMs: number;
  fps: number;
}

/**
 * How a build ended. Only CANCELLED means the person wanted playback to stop;
 * a range that would not fit still hands over to playback — refusing to play
 * at all is the one outcome worse than playing live.
 */
export type PrerenderResult = "done" | "cancelled" | "full";

interface ActiveBuild {
  range: PrerenderRange;
  from: number;
  to: number;
  resolve: (r: PrerenderResult) => void;
}

let build: ActiveBuild | null = null;

export function isPrerendering(): boolean {
  return build !== null;
}

/** The build the transport is sweeping, if any. */
export function activeBuild(): Readonly<{ compId: string; from: number; to: number }> | null {
  return build ? { compId: build.range.compId, from: build.from, to: build.to } : null;
}

/**
 * The transport's report: it moved to `instantMs` (or wrapped to the top). Ends
 * the build past the range's end — handing over to paced playback from the top
 * — or when a held cache is full.
 */
export function buildAdvanced(instantMs: number, wrapped: boolean): "continue" | "done" {
  if (!build) return "done";
  const span = Math.max(1, build.to - build.from);
  if (wrapped || instantMs > build.to + 0.5 || instantMs < build.from - 0.5) {
    const top = build.from;
    finish("done");
    useSession.getState().setPlayhead(top);
    return "done";
  }
  useSession.getState().setPrerenderProgress(Math.min(1, (instantMs - build.from) / span));
  if (framesCacheOn() && fullNow()) {
    const b = build;
    notifyFull(b.to - b.from, frameStepMs(b.range.fps));
    finish("full");
    return "done";
  }
  return "continue";
}

function finish(result: PrerenderResult): void {
  const b = build;
  if (!b) return;
  build = null;
  setRangeBuildActive(false);
  useSession.getState().setPrerenderProgress(null);
  b.resolve(result);
}

/** Stop the build (and the sweep). Safe to call when nothing is running. */
export function cancelPrerender(): void {
  if (!build) return;
  finish("cancelled");
  useSession.getState().setPlaying(false);
}

// A build exists only while it is what the person asked for: caching off, or
// the transport stopped, ends one under way.
subscribeCacheStatus(() => {
  if (build && !isCachingEnabled()) cancelPrerender();
});
useSession.subscribe((s, prev) => {
  if (build && prev.playing && !s.playing) finish("cancelled");
});

/**
 * Sweep `range` into the cache, then play it. Resolves when the sweep ends.
 */
export function prerenderRange(range: PrerenderRange): Promise<PrerenderResult> {
  // Caching off means nothing may be kept — a build would render every
  // instant for nothing. The control that starts one is disabled too.
  if (build || !isCachingEnabled()) return Promise.resolve("cancelled");
  const from = quantizeMsToFrame(Math.max(0, range.fromMs), range.fps);
  const to = Math.max(from, quantizeMsToFrame(range.toMs, range.fps));
  const session = useSession.getState();
  if (session.playing) session.setPlaying(false);
  return new Promise<PrerenderResult>((resolve) => {
    build = { range, from, to, resolve };
    setRangeBuildActive(true);
    session.setPlayhead(from);
    session.setPrerenderProgress(0);
    session.setPlaying(true);
  });
}

function fullNow(): boolean {
  const stats = frameCacheStats();
  return stats.bytes >= stats.budget * 0.98 && !isRollingCache();
}

/** HOLD at the ceiling: say so, and hand over to playback. */
function notifyFull(spanMs: number, step: number): void {
  const heldMs = Math.round(frameCacheStats().entries * step);
  useStatusBar.getState().notify({
    kind: "warning",
    id: "prerender-budget",
    text: `Cached ${(heldMs / 1000).toFixed(1)}s of ${(spanMs / 1000).toFixed(1)}s — memory is full`,
    description: "Raise the cache memory, shorten the work range, or use a lower resolution.",
  });
}
