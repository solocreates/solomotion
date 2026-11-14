"use client";

import type { TaskSignal } from "@solomotion/core";

/**
 * THE BRIDGE between the supervisor and the web platform.
 *
 * Half of the app's long work ends in something that takes a DOM
 * `AbortSignal` — `fetch`, a decode, an engine loop that was written against
 * one. `TaskSignal` is deliberately not an `AbortSignal` (core has no DOM, and
 * a task carries a deadline and progress that `AbortSignal` has no room for),
 * so this is the one place the two meet.
 *
 * It also MERGES: pass the caller's own signal and the result fires when either
 * does. That is what lets a panel keep its Cancel button and Activity keep its
 * Stop button without either one having to know about the other, and without
 * two controllers that can disagree about whether the work is still wanted.
 */
export function abortSignalFor(
  task: TaskSignal,
  ...also: (AbortSignal | null | undefined)[]
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const disposers: (() => void)[] = [];

  if (task.aborted) abort();
  else disposers.push(task.onAbort(abort));

  for (const s of also) {
    if (!s) continue;
    if (s.aborted) abort();
    else {
      s.addEventListener("abort", abort);
      disposers.push(() => s.removeEventListener("abort", abort));
    }
  }

  return {
    signal: controller.signal,
    // Listeners on a signal that outlives the work are a leak that fires into a
    // dead closure — the caller disposes in its own `finally`.
    dispose: () => {
      for (const d of disposers) d();
    },
  };
}
