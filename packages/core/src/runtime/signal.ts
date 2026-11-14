import { now } from "./clock";
import { EngineError } from "./errors";
import type { EntityRef } from "./subject";

/**
 * THE TASK SIGNAL — a running operation's handle on its own mortality.
 *
 * One object carries the three things long work needs and nothing else:
 * *am I still wanted* (someone pressed Stop), *have I run too long* (the
 * deadline), and *how do I say where I am* (progress). A body never reads a
 * store, a setting or a clock; it reads this.
 *
 * The contract is COOPERATIVE, and that is not a compromise — it is the only
 * thing that is true. A browser cannot interrupt synchronous JavaScript from
 * the outside, so a loop that never looks up cannot be stopped by anyone, and
 * an engine that pretends otherwise is lying to the person watching the tab
 * die. What we CAN do is make looking up cost nothing: `tick()` is a counter
 * increment in the common case, and the clock is sampled on a stride that
 * tunes itself to the body's own weight.
 *
 * That last part matters more than it looks. A fixed stride is wrong at both
 * ends: 256 iterations of a nanosecond body is a pointless clock read, and 256
 * iterations of a 100ms body overshoots a 2-second deadline by four minutes.
 * So the stride HALVES when a sample lands late and DOUBLES when it lands
 * early, and settles within a few samples on "about one clock read per
 * `SAMPLE_TARGET_MS` of work" whatever the body happens to be.
 */

export type AbortReason = "cancelled" | "expired";

/**
 * What a supervised body throws when it is stopped. Distinct from every other
 * error in the app on purpose: a cancelled export is not a failed export, and
 * the difference decides whether the person sees a red message or nothing at
 * all.
 */
export class TaskAborted extends EngineError {
  readonly reason: AbortReason;
  readonly taskId: string;
  readonly kind: string;
  readonly label: string;

  constructor(
    taskId: string,
    kind: string,
    label: string,
    reason: AbortReason,
    subject?: EntityRef,
  ) {
    super({
      code: reason === "cancelled" ? "runtime/cancelled" : "runtime/timed-out",
      message:
        reason === "cancelled"
          ? `${label} was stopped`
          : `${label} ran past its time limit and was stopped`,
      // A cancel is a thing the person DID. Showing it back to them as an error
      // is the app calling them wrong, so it is info and it is recoverable.
      severity: reason === "cancelled" ? "info" : "warning",
      recoverable: true,
      context: { taskId, kind, reason },
      subject,
    });
    this.reason = reason;
    this.taskId = taskId;
    this.kind = kind;
    this.label = label;
  }
}

export function isTaskAborted(e: unknown): e is TaskAborted {
  return e instanceof TaskAborted;
}

/** A body's report on where it has got to. Both fields optional, both sticky. */
export interface TaskProgress {
  /** 0..1. Omit when the work genuinely cannot say — a spinner is honest. */
  progress?: number;
  /** One short line: "frame 412 of 900". Not a sentence, not an explanation. */
  note?: string;
}

/** How much work we want between two clock reads. */
const SAMPLE_TARGET_MS = 4;
const MIN_STRIDE = 1;
const MAX_STRIDE = 1 << 16;

export class TaskSignal {
  readonly taskId: string;
  readonly kind: string;
  readonly label: string;
  /** Absolute time this task must be done by, or null for "as long as it likes". */
  readonly deadlineAt: number | null;
  /** What this task is about — carried onto anything it throws. */
  readonly subject: EntityRef | null;

  #reason: AbortReason | null = null;
  #counter = 0;
  // Starts at 1, and doubles once per sample until the body earns a longer
  // leash. Deliberately the pessimistic end: ramping up costs a fast loop
  // ~17 clock reads in total, while starting high costs a SLOW loop its entire
  // deadline — the first sample of a 100ms body would land 100 seconds in.
  #stride = 1;
  #lastSampleAt: number;
  #listeners = new Set<() => void>();
  #report: (p: TaskProgress) => void;

  constructor(init: {
    taskId: string;
    kind: string;
    label: string;
    deadlineAt: number | null;
    onReport: (p: TaskProgress) => void;
    startedAt: number;
    subject?: EntityRef | null;
  }) {
    this.taskId = init.taskId;
    this.kind = init.kind;
    this.label = init.label;
    this.deadlineAt = init.deadlineAt;
    this.subject = init.subject ?? null;
    this.#report = init.onReport;
    this.#lastSampleAt = init.startedAt;
  }

  get aborted(): boolean {
    return this.#reason !== null;
  }

  get reason(): AbortReason | null {
    return this.#reason;
  }

  /**
   * The one call a loop body makes. Throws `TaskAborted` the moment this task
   * is unwanted or out of time.
   *
   * `cost` says how heavy this iteration was relative to the others — pass the
   * pixel count, the sample count, whatever the loop is actually counting — and
   * the stride adapts against that instead of against raw iterations. Leave it
   * at 1 for an even loop.
   */
  tick(cost = 1): void {
    // Cancellation is checked EVERY tick and costs one compare: it is the path
    // that makes a chunked task stop the instant Stop is pressed, and the
    // person pressing it is watching.
    if (this.#reason !== null) throw this.error();
    if (this.deadlineAt === null) return;
    this.#counter += cost;
    if (this.#counter < this.#stride) return;
    this.#counter = 0;
    this.#sample();
  }

  /** Sample the clock unconditionally. For a loop whose body is already heavy. */
  check(): void {
    if (this.#reason !== null) throw this.error();
    if (this.deadlineAt === null) return;
    this.#counter = 0;
    this.#sample();
  }

  #sample(): void {
    const t = now();
    const since = t - this.#lastSampleAt;
    this.#lastSampleAt = t;
    // Re-tune: land roughly one sample per SAMPLE_TARGET_MS of work.
    if (since > SAMPLE_TARGET_MS * 2) {
      this.#stride = Math.max(MIN_STRIDE, this.#stride >>> 1);
    } else if (since < SAMPLE_TARGET_MS / 2) {
      this.#stride = Math.min(MAX_STRIDE, this.#stride << 1);
    }
    if (this.deadlineAt !== null && t >= this.deadlineAt) {
      this.abort("expired");
      throw this.error();
    }
  }

  /** Throw if this task has already been stopped, without touching the clock. */
  throwIfAborted(): void {
    if (this.#reason !== null) throw this.error();
  }

  /** Say where the work has got to. Cheap, coalesced by the supervisor. */
  report(p: TaskProgress): void {
    this.#report(p);
  }

  /**
   * For work that cannot be interrupted from the inside — a fetch, a decode, a
   * worker round-trip. Returns its own disposer, because a listener that
   * outlives its await is a leak that fires into a dead closure.
   */
  onAbort(fn: () => void): () => void {
    if (this.#reason !== null) {
      fn();
      return () => {};
    }
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** Supervisor-facing. Idempotent: the FIRST reason is the true one. */
  abort(reason: AbortReason): void {
    if (this.#reason !== null) return;
    this.#reason = reason;
    for (const fn of this.#listeners) fn();
    this.#listeners.clear();
  }

  error(): TaskAborted {
    return new TaskAborted(
      this.taskId,
      this.kind,
      this.label,
      this.#reason ?? "cancelled",
      this.subject ?? undefined,
    );
  }
}
