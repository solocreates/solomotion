/**
 * THE LOOP GUARD — a named cap for a loop that cannot prove it terminates.
 *
 * Most of this app's `while` loops advance by a COMPUTED step: a time cursor
 * moved by a frame interval, a path walked by an arc length, a scanline
 * advanced by a stride. Every one of them is correct until the day its step
 * arrives as `0` or `NaN`, and then the loop is not slow — it is eternal, and
 * the tab is gone with no stack, no message and no clue which of the eighty-odd
 * loops in core it was.
 *
 * This turns that into a thrown, named, reportable error in about the time it
 * takes to increment an integer. It is not a substitute for fixing the step;
 * it is what tells you the step is broken, in a bug report, from a person who
 * would otherwise only have been able to say "it froze".
 *
 *   const guard = loopGuard("clipSourcePhaseAt");
 *   while (t < end) { guard(); t += step; }
 */

import { EngineError } from "./errors";

export class RuntimeLoopError extends EngineError {
  readonly loop: string;
  readonly limit: number;
  constructor(loop: string, limit: number) {
    super({
      code: "runtime/runaway-loop",
      message:
        `“${loop}” ran ${limit.toLocaleString()} iterations without finishing — ` +
        `its step is probably zero or NaN. Stopped it instead of hanging.`,
      userMessage: "Something got stuck and was stopped before it could freeze the app.",
      severity: "error",
      recoverable: true,
      context: { loop, limit },
    });
    this.loop = loop;
    this.limit = limit;
  }
}

/**
 * A ceiling no legitimate loop in this app reaches: a 4K frame is 8.3M pixels,
 * and anything counting individual pixels in a `while` has a different problem.
 * Pass an explicit limit where the real bound is known — a tighter cap catches
 * the bug sooner and reads as documentation of what the loop expects.
 */
export const DEFAULT_LOOP_LIMIT = 10_000_000;

export function loopGuard(loop: string, limit = DEFAULT_LOOP_LIMIT): () => void {
  let n = 0;
  return () => {
    if (++n > limit) throw new RuntimeLoopError(loop, limit);
  };
}

export function isRuntimeLoopError(e: unknown): e is RuntimeLoopError {
  return e instanceof RuntimeLoopError;
}
