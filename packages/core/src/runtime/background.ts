import { now as runtimeNow } from "./clock";

/**
 * THE BACKGROUND LANE — the one rule every piece of optional work obeys on the
 * main thread: thumbnails, filmstrips, cell pictures, peaks, warmers, whatever
 * comes next.
 *
 * Background work is anything the person did not just ask for. It may be
 * expensive (a filmstrip tile of a heavy comp is a whole render), and the
 * browser offers no way to pre-empt a synchronous draw once it starts. So the
 * contract is about WHEN work may start, never how fast it runs:
 *
 *  1. **One at a time, app-wide.** Concurrency on one thread is not throughput;
 *     three "in flight" synchronous renders are one long task three times as
 *     long.
 *  2. **A duty cycle measured from cost.** After a job that took C ms, the lane
 *     stays out of the way for C·(1/duty − 1) ms. A 2 ms job costs nothing; a
 *     1 s job buys the UI ~2 s back before the next. This is what turns "a
 *     queue of 700 heavy renders" from a hang into a slow fill.
 *  3. **Foreground first.** While the person is interacting (a press, a key, a
 *     wheel — within `quietMs`) or the foreground says it is busy (playback),
 *     nothing starts.
 *
 * Callers own their queues (priority, dedupe, cancellation); the lane only
 * hands out PERMITS. Headless and timer-injected, so the rule is tested here
 * rather than asserted in comments.
 */

export interface BackgroundGate {
  /** Share of wall time background work may occupy, (0, 1]. */
  duty: number;
  /** Nothing starts within this long of the last user input. */
  quietMs: number;
}

export const DEFAULT_BACKGROUND_GATE: BackgroundGate = { duty: 0.35, quietMs: 150 };

export interface BackgroundClock {
  nowMs: number;
  /** When the previous job's synchronous part ended (−∞ if none yet). */
  lastEndMs: number;
  /** How long that synchronous part took. */
  lastCostMs: number;
  /** The last user input (−∞ if none). */
  lastInputMs: number;
}

/** How long until the next job may start — 0 means now. Pure. */
export function backgroundWaitMs(clock: BackgroundClock, gate: BackgroundGate = DEFAULT_BACKGROUND_GATE): number {
  const duty = Math.min(1, Math.max(0.01, gate.duty));
  const dutyGap = clock.lastCostMs * (1 / duty - 1);
  const afterJob = clock.lastEndMs + dutyGap - clock.nowMs;
  const afterInput = clock.lastInputMs + gate.quietMs - clock.nowMs;
  return Math.max(0, afterJob, afterInput);
}

export interface BackgroundLaneOptions {
  gate?: BackgroundGate;
  /** The foreground owns the thread right now (playback, a running export). */
  isBusy?: () => boolean;
  /** How often to look again while the foreground is busy. */
  busyRetryMs?: number;
  /** Injected for tests; defaults to `setTimeout`. */
  setTimer?: (fn: () => void, ms: number) => void;
  now?: () => number;
}

export interface BackgroundLane {
  /**
   * Ask for one permit. `job` runs when the lane allows; its SYNCHRONOUS part
   * (up to its first `await`) is what is measured and charged, because that is
   * the part that blocks input. Jobs are served FIFO by the lane; a caller that
   * wants a different order keeps its own queue and asks for one permit per
   * job it is ready to run.
   */
  request(job: () => unknown): void;
  /** A user input happened — hold background work for the quiet window. */
  noteInput(): void;
  /** Exponentially-smoothed sync cost of recent jobs, for diagnostics. */
  meanCostMs(): number;
  /** Permits waiting. */
  pending(): number;
}

export function createBackgroundLane(options: BackgroundLaneOptions = {}): BackgroundLane {
  const gate = options.gate ?? DEFAULT_BACKGROUND_GATE;
  const now = options.now ?? runtimeNow;
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms));
  const busyRetryMs = options.busyRetryMs ?? 250;
  const waiting: Array<() => unknown> = [];
  let lastEndMs = -Infinity;
  let lastCostMs = 0;
  let lastInputMs = -Infinity;
  let mean = 0;
  let armed = false;

  const arm = (ms: number) => {
    if (armed) return;
    armed = true;
    setTimer(tick, ms);
  };

  function tick(): void {
    armed = false;
    if (waiting.length === 0) return;
    if (options.isBusy?.()) {
      arm(busyRetryMs);
      return;
    }
    const wait = backgroundWaitMs({ nowMs: now(), lastEndMs, lastCostMs, lastInputMs }, gate);
    if (wait > 0) {
      arm(wait);
      return;
    }
    const job = waiting.shift()!;
    const start = now();
    try {
      // Fire and forget: the async tail (an `await createImageBitmap`) is off the
      // thread and is the caller's business. A throw is the caller's too — the
      // lane must survive it, or one bad job would stop every thumbnail forever.
      const out = job();
      if (out && typeof (out as Promise<unknown>).catch === "function") (out as Promise<unknown>).catch(() => {});
    } catch {
      /* the lane outlives any one job */
    }
    lastEndMs = now();
    lastCostMs = Math.max(0, lastEndMs - start);
    mean = mean === 0 ? lastCostMs : mean * 0.75 + lastCostMs * 0.25;
    if (waiting.length > 0) arm(backgroundWaitMs({ nowMs: lastEndMs, lastEndMs, lastCostMs, lastInputMs }, gate));
  }

  return {
    request(job) {
      waiting.push(job);
      arm(0);
    },
    noteInput() {
      lastInputMs = now();
    },
    meanCostMs: () => mean,
    pending: () => waiting.length,
  };
}
