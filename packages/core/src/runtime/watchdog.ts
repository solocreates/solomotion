import { now } from "./clock";
import { supervisor, type TaskRecord } from "./supervisor";
import { errorPayloads, errors } from "./report";
import type { ErrorPayload } from "./errors";

/**
 * THE WATCHDOG — noticing that the app stopped responding, and being able to
 * say what it was doing at the time.
 *
 * Deliberately NOT a Worker. A worker can watch the main thread go quiet, but
 * it cannot interrupt it, cannot read what it was doing, and cannot do anything
 * at all with the finding until the main thread comes back — at which point the
 * main thread could have measured the same gap itself, and knows the task table
 * that explains it. A worker here would be a second source of truth that adds
 * latency and a message protocol in exchange for nothing. If we ever move real
 * work into workers, the ability to TERMINATE those workers is the thing that
 * would justify one, and that is a different feature.
 *
 * So the mechanism is the oldest one there is: a timer that measures its own
 * lateness. A 250ms heartbeat that fires 9 seconds late means the thread was
 * blocked for 8.75 seconds, and the tasks that were open across that gap are
 * the suspects.
 *
 * …PROVIDED the page was in a position to run. A late timer has three causes
 * and only one of them is a freeze: the thread was busy, OR the host throttled
 * its timers (a hidden tab, a minimised window, App Nap), OR the machine
 * slept. Lateness alone cannot tell them apart, which is how "the app froze
 * for 41s" appeared while nobody was even looking at the app. So there are two
 * kinds of evidence, best first:
 *
 *  • `block()` — the engine WITNESSED a task run that long (the Long Tasks
 *    API). Exact, and immune to throttling and sleep, because a throttled
 *    page runs nothing at all. Where it exists, it is the only evidence.
 *  • `beat()` — timer lateness, for engines without it. Any gap the page spent
 *    hidden or frozen by its host is `suspend()`ed and thrown away, and a gap
 *    too long to be anything but a suspension is never called a freeze.
 */

/** One episode of the app being blocked. */
export interface FreezeRecord {
  /** When the thread came back. */
  readonly at: number;
  /** How long it was gone. */
  readonly durationMs: number;
  /** What was open across the gap — the suspects, most recent first. */
  readonly tasks: readonly { kind: string; label: string }[];
}

const HISTORY = 20;

/**
 * Past this, a heartbeat gap is a suspension (sleep, a discarded or deeply
 * throttled tab), not a freeze: a page that is genuinely blocked this long has
 * long since been offered the browser's own "Page unresponsive" sheet, and
 * the black box — not the watchdog — is what explains that.
 */
const SUSPENSION_MS = 60_000;

export class Watchdog {
  #lastBeat = now();
  #suspended = false;
  #freezes: FreezeRecord[] = [];
  #listeners = new Set<() => void>();

  /**
   * Call on a regular timer. Returns a record when the gap since the last beat
   * crossed `freezeMs` — i.e. the thread was blocked — and null otherwise.
   *
   * `expectedMs` is the timer's own interval; it is subtracted so a 250ms
   * heartbeat does not report a permanent 250ms freeze. A gap that spans a
   * `suspend()` is not evidence and only re-arms the clock.
   */
  beat(opts: { freezeMs: number; expectedMs: number; at?: number }): FreezeRecord | null {
    const at = opts.at ?? now();
    const blocked = at - this.#lastBeat - opts.expectedMs;
    this.#lastBeat = at;
    if (this.#suspended) {
      this.#suspended = false;
      return null;
    }
    if (blocked < opts.freezeMs || blocked > SUSPENSION_MS) return null;
    return this.#record(at - blocked, blocked, at);
  }

  /**
   * The engine saw the thread held for `durationMs` from `startedAt` (both on
   * the runtime clock). Direct evidence, so no suspension rules apply.
   */
  block(span: { startedAt: number; durationMs: number; freezeMs: number }): FreezeRecord | null {
    if (span.durationMs < span.freezeMs) return null;
    return this.#record(span.startedAt, span.durationMs, span.startedAt + span.durationMs);
  }

  /**
   * The page could not run for a while for reasons that are not ours — it was
   * hidden, frozen by the browser, or the machine slept. The gap the next beat
   * measures is thrown away instead of being reported as a freeze.
   */
  suspend(): void {
    this.#suspended = true;
  }

  #record(startedAt: number, blocked: number, at: number): FreezeRecord {
    const rec: FreezeRecord = {
      at,
      durationMs: Math.round(blocked),
      tasks: supervisor
        .tasks()
        .filter((t) => spanned(t, startedAt))
        .map((t) => ({ kind: t.kind, label: t.label })),
    };
    this.#freezes = [rec, ...this.#freezes].slice(0, HISTORY);
    for (const fn of this.#listeners) fn();
    return rec;
  }

  /** Newest first. */
  freezes(): readonly FreezeRecord[] {
    return this.#freezes;
  }

  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  clear(): void {
    this.#freezes = [];
    for (const fn of this.#listeners) fn();
  }

  /** Tests only. */
  reset(at = now()): void {
    this.#lastBeat = at;
    this.#suspended = false;
    this.#freezes = [];
  }
}

/** Was this task open at the instant the thread went quiet? */
function spanned(t: TaskRecord, startedAt: number): boolean {
  return t.startedAt <= startedAt && (t.endedAt === undefined || t.endedAt >= startedAt);
}

export const watchdog = new Watchdog();

// ── the black box ────────────────────────────────────────────────────────────

/**
 * What the app writes down so the NEXT session can explain this one.
 *
 * A tab killed by the browser's "Page unresponsive" sheet leaves nothing
 * behind — no error, no unload, no chance to report. So the state that would
 * explain it is persisted while things are still fine, and read back on the
 * next boot. Kept tiny and flat: it is written on a timer, and a black box that
 * is expensive to write is a black box that gets turned off.
 */
export interface BlackBox {
  /** When this snapshot was taken. Epoch ms — it is compared across sessions. */
  at: number;
  /** The app's build, so a stale box from an old version is recognisable. */
  version: string;
  /** What was running. */
  tasks: { kind: string; label: string; startedMs: number }[];
  /** The freezes seen in this session. */
  freezes: { durationMs: number; label: string | null }[];
  /** The last few failures, in full. What makes the next session's report useful. */
  errors: ErrorPayload[];
}

export function snapshotBlackBox(version: string): BlackBox {
  const t = now();
  return {
    at: Date.now(),
    version,
    tasks: supervisor.running().map((r) => ({
      kind: r.kind,
      label: r.label,
      startedMs: Math.round(t - r.startedAt),
    })),
    freezes: watchdog.freezes().map((f) => ({
      durationMs: f.durationMs,
      label: f.tasks[0]?.label ?? null,
    })),
    // Capped hard: this is written on a timer to synchronous storage, and a
    // black box that costs milliseconds to save is one that gets switched off.
    errors: errorPayloads(errors.reports(), 5),
  };
}

/**
 * Read a black box back and decide whether the LAST session ended badly.
 * "Badly" is: it was still doing something, or it had frozen, and it never got
 * to clear the box. A clean exit clears it, so its mere presence is the signal.
 */
export function diagnoseBlackBox(box: BlackBox | null): {
  crashed: boolean;
  culprit: string | null;
  freezeMs: number;
  errors: ErrorPayload[];
} {
  if (!box) return { crashed: false, culprit: null, freezeMs: 0, errors: [] };
  const worst = box.freezes.reduce<{ durationMs: number; label: string | null } | null>(
    (a, b) => (a === null || b.durationMs > a.durationMs ? b : a),
    null,
  );
  const errs = box.errors ?? [];
  const culprit = box.tasks[0]?.label ?? worst?.label ?? errs[0]?.userMessage ?? null;
  return {
    crashed: box.tasks.length > 0 || box.freezes.length > 0 || errs.length > 0,
    culprit,
    freezeMs: worst?.durationMs ?? 0,
    errors: errs,
  };
}
