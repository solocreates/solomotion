/**
 * JOBS — asked-for work that outlives the call that asked for it, run one at
 * a time, each with an id anyone can wait on.
 *
 * An export used to BE its call: the agent's tool call stayed open for the
 * whole render. Six sent together rendered at once on one thread, none made
 * progress fast enough, and every one of them timed out in the agent app while
 * the page rendered on. A job answers at once with its id and its place in
 * line; the work runs in order behind it; `wait` blocks for a bounded time
 * and says where each job is. A caller that drops — an agent app's timeout, a
 * bridge handing over — loses nothing: the job runs on and its result is kept.
 *
 * Not the supervisor (`supervisor.ts`), which watches work already running and
 * decides when it has gone wrong; a job's body runs under it like anything
 * else. Not the background lane, which hands out permits to work nobody asked
 * for. This is the line people stand in.
 *
 * Headless: no timers beyond `wait`'s own, no DOM.
 */

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface JobView<R = unknown> {
  id: string;
  label: string;
  /** Who asked — an agent session's id — so a caller can list only its own. */
  owner?: string;
  state: JobState;
  /** Jobs before this one: 0 while it runs, 1 when it is next. Null once finished. */
  ahead: number | null;
  /** The body's last word on how it is doing ("Exporting · 40%"). */
  progress: string | null;
  result?: R;
  error?: string;
  /** A failure's own advice (an `ApiError`'s `hint`). */
  hint?: string;
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
}

export interface JobSpec {
  label: string;
  owner?: string;
}

export type JobBody<R> = (signal: AbortSignal, progress: (text: string) => void) => Promise<R>;

export interface JobWaitOptions {
  signal?: AbortSignal;
  /** Any listed job said something new: "#2 · Exporting · 40%". Keeps a waiting caller audibly alive. */
  onProgress?: (text: string) => void;
}

export interface JobQueue<R> {
  /** Put work in line. Returns at once; the work starts when everything before it is done. */
  enqueue(spec: JobSpec, body: JobBody<R>): JobView<R>;
  /** Put work in line and await it — for a caller that has nothing better to do (the Export panel). */
  run(spec: JobSpec, body: JobBody<R>): Promise<R>;
  get(id: string): JobView<R> | undefined;
  /** Every job kept, oldest first; only `owner`'s when given. */
  list(owner?: string): JobView<R>[];
  /** Resolves when every listed job has finished, or after `ms`, or when `signal` aborts — with where each one is. Unknown ids are left out. */
  wait(ids: readonly string[], ms: number, options?: JobWaitOptions): Promise<JobView<R>[]>;
  /** Stop a job: one in line leaves it, a running one is aborted. False when it had already finished. */
  cancel(id: string): boolean;
  /** Something changed — a job queued, started, reported or finished. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

interface Entry<R> {
  view: JobView<R>;
  body: JobBody<R>;
  abort: AbortController;
}

const FINISHED: ReadonlySet<JobState> = new Set(["done", "failed", "cancelled"]);
export const isJobFinished = (j: Pick<JobView, "state">): boolean => FINISHED.has(j.state);

export function createJobQueue<R>(options: { prefix?: string; keep?: number; now?: () => number } = {}): JobQueue<R> {
  const prefix = options.prefix ?? "job";
  const keep = options.keep ?? 50;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry<R>>();
  /** Waiting to run, in order. */
  const line: string[] = [];
  let running: string | null = null;
  let seq = 0;
  const listeners = new Set<() => void>();

  const changed = () => {
    for (const l of listeners) l();
  };

  const snapshot = (e: Entry<R>): JobView<R> => {
    const id = e.view.id;
    const ahead = isJobFinished(e.view) ? null : id === running ? 0 : line.indexOf(id) + (running ? 1 : 0);
    return { ...e.view, ahead };
  };

  const finish = (e: Entry<R>, patch: Partial<JobView<R>>) => {
    e.view = { ...e.view, ...patch, endedAt: now() };
    // Keep the newest finished ones; a long session must not grow without bound.
    const done = [...entries.values()].filter((x) => isJobFinished(x.view));
    for (const old of done.slice(0, Math.max(0, done.length - keep))) entries.delete(old.view.id);
  };

  const pump = () => {
    if (running) return;
    const id = line.shift();
    if (!id) return changed();
    const e = entries.get(id)!;
    running = id;
    e.view = { ...e.view, state: "running", startedAt: now() };
    changed();
    const progress = (text: string) => {
      if (running !== id) return;
      e.view = { ...e.view, progress: text };
      changed();
    };
    let settled: Promise<unknown>;
    try {
      settled = Promise.resolve(e.body(e.abort.signal, progress));
    } catch (err) {
      settled = Promise.reject(err);
    }
    void settled.then(
      (result) => finish(e, e.abort.signal.aborted ? { state: "cancelled" } : { state: "done", result: result as R }),
      (err: unknown) =>
        finish(
          e,
          e.abort.signal.aborted
            ? { state: "cancelled" }
            : {
                state: "failed",
                error: err instanceof Error ? err.message : String(err),
                hint: typeof (err as { hint?: unknown })?.hint === "string" ? (err as { hint: string }).hint : undefined,
              },
        ),
    ).finally(() => {
      running = null;
      pump();
    });
  };

  const queue: JobQueue<R> = {
    enqueue(spec, body) {
      const id = `${prefix}-${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const e: Entry<R> = {
        view: { id, label: spec.label, owner: spec.owner, state: "queued", ahead: null, progress: null, queuedAt: now() },
        body,
        abort: new AbortController(),
      };
      entries.set(id, e);
      line.push(id);
      changed();
      pump();
      return snapshot(e);
    },

    async run(spec, body) {
      const { id } = queue.enqueue(spec, body);
      for (;;) {
        const [j] = await queue.wait([id], 60_000);
        if (!j || !isJobFinished(j)) continue;
        if (j.state === "done") return j.result as R;
        throw Object.assign(new Error(j.error ?? "Cancelled."), j.hint ? { hint: j.hint } : {});
      }
    },

    get(id) {
      const e = entries.get(id);
      return e && snapshot(e);
    },

    list(owner) {
      return [...entries.values()].filter((e) => owner === undefined || e.view.owner === owner).map(snapshot);
    },

    wait(ids, ms, { signal, onProgress } = {}) {
      const views = () => ids.map((id) => queue.get(id)).filter((j): j is JobView<R> => !!j);
      return new Promise((resolve) => {
        const said = new Map<string, string>();
        const check = () => {
          const jobs = views();
          if (onProgress) {
            for (const j of jobs) {
              const line = j.state === "queued" ? `Queued (${j.ahead} ahead)` : j.state === "running" ? (j.progress ?? "Working") : j.state;
              if (said.get(j.id) === line) continue;
              said.set(j.id, line);
              onProgress(jobs.length > 1 ? `${j.label} · ${line}` : line);
            }
          }
          if (jobs.every(isJobFinished)) end();
        };
        const end = () => {
          clearTimeout(timer);
          off();
          signal?.removeEventListener("abort", end);
          resolve(views());
        };
        const timer = setTimeout(end, Math.max(0, ms));
        const off = queue.subscribe(check);
        signal?.addEventListener("abort", end);
        if (signal?.aborted) return end();
        check();
      });
    },

    cancel(id) {
      const e = entries.get(id);
      if (!e || isJobFinished(e.view)) return false;
      const at = line.indexOf(id);
      if (at >= 0) {
        line.splice(at, 1);
        finish(e, { state: "cancelled" });
        changed();
      } else {
        e.abort.abort();
      }
      return true;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return queue;
}
