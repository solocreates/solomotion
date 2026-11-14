import { now } from "./clock";
import type { TaskProgress, TaskSignal } from "./signal";

/**
 * THE CHUNKED RUNNER — the piece that actually stops the tab from dying.
 *
 * A deadline tells you a job ran too long. It does not stop the browser from
 * painting the "Page unresponsive" sheet over the top of it, because that sheet
 * is about ONE thing: how long the main thread went without returning to the
 * event loop. Supervision without chunking gets you a well-documented freeze.
 *
 * So: hand `supervise()` a GENERATOR instead of a function, and the same loop
 * you already wrote runs in slices. Between slices the thread goes back to the
 * host — React paints, the progress bar moves, the Stop button works, and the
 * browser never sees an unresponsive frame. A thirty-second grind stops being a
 * crash and becomes thirty seconds of visible, cancellable progress.
 *
 * Generators are the seam because the conversion is nearly free: `function` →
 * `function*`, one `yield` in the loop body, and the body keeps its locals, its
 * closures and its `try/finally`. That last one is why abort calls `iter.return()`
 * — a generator stopped mid-flight must still run its cleanup, or a cancelled
 * export leaves its encoder open.
 */

/** What a chunked body yields: nothing, or where it has got to. */
export type ChunkStep = void | TaskProgress;

/** A supervised body: sync, async, or chunked. `supervise()` takes all three. */
export type TaskBody<T> =
  | ((signal: TaskSignal) => T)
  | ((signal: TaskSignal) => Promise<T>)
  | ((signal: TaskSignal) => Generator<ChunkStep, T, void>);

export function isIterator(x: unknown): x is Iterator<ChunkStep, unknown> {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as Iterator<unknown>).next === "function" &&
    Symbol.iterator in x
  );
}

// ── yielding to the host ─────────────────────────────────────────────────────

/**
 * How a slice hands the thread back. A port, because the right answer differs
 * per host and none of them belong in core: the web app upgrades this to
 * `scheduler.yield()` where the browser has it.
 *
 * The default is a `MessageChannel` round-trip rather than `setTimeout(0)`,
 * which browsers clamp to 4ms once timeouts nest — a 4ms tax on a 12ms slice
 * is a third of the work thrown away. A message task still lets the browser
 * paint between slices, which is the whole point.
 */
/** The slice of `MessageChannel` this needs, so core can stay off the DOM lib. */
interface YieldChannel {
  port1: { close(): void; onmessage: ((ev: unknown) => void) | null };
  port2: { postMessage(v: unknown): void };
}

function defaultYield(): Promise<void> {
  const Channel = (globalThis as unknown as { MessageChannel?: new () => YieldChannel })
    .MessageChannel;
  if (Channel) {
    return new Promise<void>((resolve) => {
      const ch = new Channel();
      ch.port1.onmessage = () => {
        ch.port1.close();
        resolve();
      };
      ch.port2.postMessage(null);
    });
  }
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

let yieldToHost: () => Promise<void> = defaultYield;

/**
 * Hand the thread back once, the host's way — for an async loop that is not a
 * chunked body (a tracking run) but must not monopolise the thread either.
 */
export function yieldNow(): Promise<void> {
  return yieldToHost();
}

/** Replace the yield strategy. `null` restores the default. */
export function setYieldStrategy(fn: (() => Promise<void>) | null): void {
  yieldToHost = fn ?? defaultYield;
}

// ── the runner ───────────────────────────────────────────────────────────────

export interface ChunkOptions {
  signal: TaskSignal;
  /** Milliseconds of work between yields. */
  sliceMs: number;
  /** Where a yielded `{progress, note}` goes. */
  onStep?: (p: TaskProgress) => void;
  /**
   * Wraps each slice. The supervisor uses it to re-establish the task's subject,
   * which an `await` cannot carry across — see `subject.ts`.
   */
  around?: <R>(fn: () => R) => R;
}

/**
 * Drive an iterator to completion in time-boxed slices. Throws whatever the
 * body throws, plus `TaskAborted` when it is stopped — and in both cases the
 * iterator is closed so its `finally` runs.
 */
export async function runChunked<T>(
  iter: Iterator<ChunkStep, T, void>,
  { signal, sliceMs, onStep, around }: ChunkOptions,
): Promise<T> {
  const slice = Math.max(1, sliceMs);
  let sliceEnd = now() + slice;
  try {
    for (;;) {
      signal.throwIfAborted();
      const step = around ? around(() => iter.next()) : iter.next();
      if (step.done) return step.value;
      if (step.value && onStep) onStep(step.value);
      if (now() >= sliceEnd) {
        await yieldToHost();
        // Both questions, in order: was it stopped while we were away, and has
        // it now outstayed its budget? `check()` answers the second and throws.
        signal.check();
        sliceEnd = now() + slice;
      }
    }
  } catch (err) {
    // A generator abandoned mid-body keeps its frame alive until it is closed.
    // Closing it here is what runs the `finally` that releases the encoder, the
    // decoder, the canvas — whatever this body was holding.
    iter.return?.(undefined as never);
    throw err;
  }
}
