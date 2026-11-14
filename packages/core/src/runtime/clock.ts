/**
 * THE RUNTIME CLOCK — one function, injectable.
 *
 * Everything in `runtime/` reads time through here so the supervisor, the
 * deadlines and the watchdog can be driven by a fake clock in a test without a
 * single `await sleep()`. A test that waits for real time is a test that is
 * slow AND flaky, and this is exactly the kind of code where "it expired a
 * millisecond late" must be provable rather than plausible.
 *
 * `performance.now()` where it exists — it is monotonic, so a system clock
 * change mid-export cannot make a task look like it started in the future.
 */

const real: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();

let clock = real;

/** Milliseconds on the runtime's own monotonic timeline. */
export function now(): number {
  return clock();
}

/** Tests only. `null` restores the real clock. */
export function setRuntimeClock(fn: (() => number) | null): void {
  clock = fn ?? real;
}
