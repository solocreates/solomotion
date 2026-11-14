import { now } from "./clock";
import { isIterator, runChunked, type ChunkStep, type TaskBody } from "./chunk";
import { DEFAULT_RUNTIME_CONFIG, resolveLimitMs, type RuntimeConfig } from "./config";
import { taskKind, UNKNOWN_KIND, type ExpiryAction } from "./kinds";
import { TaskAborted, TaskSignal, type TaskProgress } from "./signal";
import { popSubject, pushSubject, type EntityRef } from "./subject";
import { reportError } from "./report";
import { classifyFailure, currentlyOnline, type FailureKind } from "./failure";

/**
 * THE SUPERVISOR — one table of everything this app is currently doing that
 * could take a while, and the authority that decides when one of them has gone
 * wrong.
 *
 * Every long operation in the app goes through `supervise()`. What that buys,
 * in order of how much work it costs the call site:
 *
 *  - **Free, by wrapping:** the work is NAMED and TIMED. It appears in the
 *    Activity window while it runs, and if the app wedges, the crash report can
 *    say which operation was in flight instead of "something froze".
 *  - **One line (`signal.tick()`):** it becomes stoppable and gets a deadline.
 *  - **One keyword (`function*` + `yield`):** it stops blocking the thread at
 *    all — see `chunk.ts`.
 *
 * A ladder, not an all-or-nothing migration. Work that has climbed no rungs is
 * still better off in here than outside it, which is what makes adopting this
 * across a codebase this size realistic.
 *
 * This is NOT the render governor (`preview/render-budget.ts`). That one asks
 * "is this frame too expensive, should I draw it cheaper" sixty times a second.
 * This one asks "is this OPERATION still alive" about discrete jobs. They share
 * no state and answer different questions; keeping them apart is deliberate.
 */

export type TaskState = "running" | "done" | "failed" | "cancelled" | "expired";

export interface TaskRecord {
  readonly id: string;
  /** The registered kind id. */
  readonly kind: string;
  /** What the person sees: "Export ‘Title sequence’". */
  readonly label: string;
  /** Optional second line — a file name, a clip name. */
  readonly detail?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly state: TaskState;
  /** 0..1, or null when the work cannot honestly say. */
  readonly progress: number | null;
  readonly note?: string;
  /** The deadline in force, absolute ms. Null when this one may run freely. */
  readonly deadlineAt: number | null;
  /** Past its budget, but of a kind that must not be shot. See `ExpiryAction`. */
  readonly overdue: boolean;
  readonly cancellable: boolean;
  readonly onExpire: ExpiryAction;
  /** Which clip / effect / plugin this is about. What makes Activity diagnostic. */
  readonly subject?: EntityRef;
  /** Set when `state === "failed"`. */
  readonly error?: string;
  /** Why, in a word a person can act on — set when `state` is failed or expired. */
  readonly failure?: FailureKind;
  /** Done records of this task are not kept in history (a quick lazy load). */
  readonly ephemeral?: boolean;
}

export interface TaskSpec {
  kind?: string;
  label: string;
  detail?: string;
  /** Override this run's budget in ms. `null` = no limit. Omit to use settings. */
  limitMs?: number | null;
  /** Override the slice budget for a chunked body. */
  sliceMs?: number;
  /**
   * What this work is about. Re-established around every slice, so anything
   * thrown inside — at any depth — is tagged with it without being handed it.
   */
  subject?: EntityRef;
  /**
   * Routine work whose SUCCESS is not news — a chunk that arrived. It shows
   * while it runs; once done it leaves no row, so forty quick loads cannot
   * push the export that just failed out of Activity. A failure is always kept.
   */
  ephemeral?: boolean;
}

/** How many finished tasks Activity keeps. Enough to explain what just happened. */
const HISTORY = 40;
/** Progress updates are coalesced to this, so a per-pixel `report()` is free. */
const EMIT_INTERVAL_MS = 120;

let seq = 0;

class Supervisor {
  #config: RuntimeConfig = DEFAULT_RUNTIME_CONFIG;
  #live = new Map<string, { rec: TaskRecord; signal: TaskSignal }>();
  #history: TaskRecord[] = [];
  #snapshot: readonly TaskRecord[] = [];
  #listeners = new Set<() => void>();
  #dirty = false;
  #emitAt = 0;
  #sweepTimer: ReturnType<typeof setTimeout> | null = null;

  // ── settings ───────────────────────────────────────────────────────────────

  /** Push the person's Safety settings in. Affects tasks started from now on. */
  configure(config: RuntimeConfig): void {
    this.#config = config;
    this.#arm();
  }

  config(): RuntimeConfig {
    return this.#config;
  }

  // ── the store ──────────────────────────────────────────────────────────────

  /**
   * Running first (newest first), then finished. One array, because every
   * surface that reads this wants exactly that order and deriving it twice is
   * how two lists start to disagree.
   */
  tasks(): readonly TaskRecord[] {
    return this.#snapshot;
  }

  running(): readonly TaskRecord[] {
    return this.#snapshot.filter((t) => t.state === "running");
  }

  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #rebuild(): void {
    const live = [...this.#live.values()].map((e) => e.rec).sort((a, b) => b.startedAt - a.startedAt);
    this.#snapshot = [...live, ...this.#history];
  }

  /** State changes are seen at once; progress is coalesced onto a timer. */
  #emit(immediate: boolean): void {
    this.#rebuild();
    const t = now();
    if (!immediate && t - this.#emitAt < EMIT_INTERVAL_MS) {
      this.#dirty = true;
      return;
    }
    this.#dirty = false;
    this.#emitAt = t;
    for (const fn of this.#listeners) fn();
  }

  /**
   * Called by the app's heartbeat. Flushes coalesced progress and enforces
   * deadlines on bodies that never tick — an `await` on a fetch that hung
   * cannot check its own clock, so someone outside has to.
   */
  pump(at = now()): void {
    for (const { rec, signal } of [...this.#live.values()]) {
      if (rec.deadlineAt === null || at < rec.deadlineAt) continue;
      if (rec.onExpire === "warn") {
        if (!rec.overdue) this.#patch(rec.id, { overdue: true }, true);
        continue;
      }
      signal.abort("expired");
      this.#finish(rec.id, "expired");
    }
    if (this.#dirty) this.#emit(true);
    this.#arm();
  }

  /** Wake exactly once, at the next deadline that could matter. */
  #arm(): void {
    if (this.#sweepTimer !== null) {
      clearTimeout(this.#sweepTimer);
      this.#sweepTimer = null;
    }
    let next = Infinity;
    for (const { rec } of this.#live.values()) {
      if (rec.deadlineAt !== null && !rec.overdue) next = Math.min(next, rec.deadlineAt);
    }
    if (!Number.isFinite(next)) return;
    const delay = Math.max(0, next - now());
    this.#sweepTimer = setTimeout(() => {
      this.#sweepTimer = null;
      this.pump();
    }, delay);
    // Never hold a Node process open for a watchdog timer.
    (this.#sweepTimer as { unref?: () => void }).unref?.();
  }

  // ── running work ───────────────────────────────────────────────────────────

  #open(spec: TaskSpec): { rec: TaskRecord; signal: TaskSignal } {
    const def = taskKind(spec.kind ?? UNKNOWN_KIND.id) ?? UNKNOWN_KIND;
    const startedAt = now();
    const limitMs = spec.limitMs !== undefined ? spec.limitMs : resolveLimitMs(this.#config, def);
    const id = `tk_${++seq}`;
    const rec: TaskRecord = {
      id,
      kind: def.id,
      label: spec.label,
      detail: spec.detail,
      startedAt,
      state: "running",
      progress: null,
      deadlineAt: limitMs === null ? null : startedAt + limitMs,
      overdue: false,
      cancellable: def.cancellable,
      onExpire: def.onExpire,
      subject: spec.subject,
      ephemeral: spec.ephemeral,
    };
    const signal = new TaskSignal({
      taskId: id,
      kind: def.id,
      label: spec.label,
      deadlineAt: rec.deadlineAt,
      startedAt,
      subject: spec.subject ?? null,
      onReport: (p) => this.#report(id, p),
    });
    const entry = { rec, signal };
    this.#live.set(id, entry);
    this.#emit(true);
    this.#arm();
    return entry;
  }

  #patch(id: string, patch: Partial<TaskRecord>, immediate: boolean): void {
    const entry = this.#live.get(id);
    if (!entry) return;
    entry.rec = { ...entry.rec, ...patch } as TaskRecord;
    this.#emit(immediate);
  }

  #report(id: string, p: TaskProgress): void {
    const entry = this.#live.get(id);
    if (!entry) return;
    const progress = p.progress === undefined ? entry.rec.progress : clamp01(p.progress);
    const note = p.note === undefined ? entry.rec.note : p.note;
    if (progress === entry.rec.progress && note === entry.rec.note) return;
    entry.rec = { ...entry.rec, progress, note };
    this.#emit(false);
  }

  #finish(id: string, state: TaskState, error?: string, failure?: FailureKind): void {
    const entry = this.#live.get(id);
    if (!entry) return;
    this.#live.delete(id);
    const rec: TaskRecord = { ...entry.rec, state, endedAt: now(), error, failure: failure ?? (state === "expired" ? "timeout" : undefined) };
    if (!(rec.ephemeral && state === "done")) this.#history = [rec, ...this.#history].slice(0, HISTORY);
    this.#emit(true);
    this.#arm();
  }

  /**
   * Run a body under supervision. Hand it a plain function, an async function
   * or a GENERATOR — the generator is the one that keeps the app responsive,
   * and it is detected rather than declared, so one entry point covers all
   * three and no call site picks the wrong overload.
   */
  async run<T>(spec: TaskSpec, body: TaskBody<T>): Promise<T> {
    const { rec, signal } = this.#open(spec);
    try {
      const out = this.#within(rec, () => (body as (s: TaskSignal) => unknown)(signal));
      const value = isIterator(out)
        ? await runChunked(out as Iterator<ChunkStep, T, void>, {
            signal,
            sliceMs: spec.sliceMs ?? this.#config.sliceMs,
            onStep: (p) => this.#report(rec.id, p),
            // Each slice re-enters the subject: an `await` cannot carry the
            // ambient stack, but a slice boundary is a place we control.
            around: (step) => this.#within(rec, step),
          })
        : ((await out) as T);
      signal.throwIfAborted();
      this.#finish(rec.id, "done");
      return value;
    } catch (err) {
      this.#fail(rec, err);
      throw err;
    }
  }

  /**
   * Supervise work that must stay synchronous — a render pass, a document
   * migration mid-load. It cannot yield, so it cannot keep the app responsive;
   * what it gets is a name, a deadline its `tick()` calls honour, and a place
   * in the crash report. Prefer `run()` with a generator wherever the call site
   * can become async.
   */
  runSync<T>(spec: TaskSpec, body: (signal: TaskSignal) => T): T {
    const { rec, signal } = this.#open(spec);
    try {
      const value = this.#within(rec, () => body(signal));
      this.#finish(rec.id, "done");
      return value;
    } catch (err) {
      this.#fail(rec, err);
      throw err;
    }
  }

  /** Run `fn` with this task's subject in force. */
  #within<R>(rec: TaskRecord, fn: () => R): R {
    if (!rec.subject) return fn();
    pushSubject(rec.subject);
    try {
      return fn();
    } finally {
      popSubject();
    }
  }

  /**
   * The ONE failure path. Both `run` and `runSync` land here, so a task that
   * throws is recorded, classified and reported identically whichever door it
   * came through — and a cancel is never mistaken for a crash.
   */
  #fail(rec: TaskRecord, err: unknown): void {
    if (err instanceof TaskAborted) {
      this.#finish(rec.id, err.reason === "expired" ? "expired" : "cancelled");
      // A timeout is a finding; a cancel is a decision. Only one is news.
      if (err.reason === "expired") reportError(err, { taskId: rec.id, kind: rec.kind });
      return;
    }
    const error = reportError(err, {
      taskId: rec.id,
      kind: rec.kind,
      task: rec.label,
      ranMs: Math.round(now() - rec.startedAt),
    });
    this.#finish(rec.id, "failed", error.userMessage, classifyFailure(err, { online: currentlyOnline() }));
  }

  /** Stop one task by hand. Silently ignores one that already finished. */
  cancel(id: string): void {
    const entry = this.#live.get(id);
    if (!entry) return;
    entry.signal.abort("cancelled");
    // A chunked body notices at its next yield; a sync one never will, so the
    // record is left running until it returns. Marking it cancelled here would
    // claim something the app cannot deliver.
    this.#emit(true);
  }

  /** Stop everything stoppable — the Activity window's panic button. */
  cancelAll(): void {
    for (const { rec } of [...this.#live.values()]) {
      if (rec.cancellable) this.cancel(rec.id);
    }
  }

  clearHistory(): void {
    this.#history = [];
    this.#emit(true);
  }

  /** Tests only. */
  reset(): void {
    if (this.#sweepTimer !== null) clearTimeout(this.#sweepTimer);
    this.#sweepTimer = null;
    this.#live.clear();
    this.#history = [];
    this.#config = DEFAULT_RUNTIME_CONFIG;
    this.#emit(true);
  }
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** The app has exactly one. */
export const supervisor = new Supervisor();

/** The call every site uses. See `Supervisor.run`. */
export function supervise<T>(spec: TaskSpec, body: TaskBody<T>): Promise<T> {
  return supervisor.run(spec, body);
}

/** The synchronous sibling. See `Supervisor.runSync`. */
export function superviseSync<T>(spec: TaskSpec, body: (signal: TaskSignal) => T): T {
  return supervisor.runSync(spec, body);
}
