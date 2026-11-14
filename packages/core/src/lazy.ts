import { supervisor } from "./runtime/supervisor";

/**
 * LAZY MODULES — the one way a heavy part of the app arrives later.
 *
 * The 3D engine, effect families, plugin bodies, inspector sections, the
 * agent: each is a chunk a session that never touches it never downloads.
 * They all need the same five things, and before this file each loader got a
 * different subset of them right:
 *
 *   1. ONE FETCH. Every caller shares one promise; `load()` twice is one import.
 *   2. A SYNCHRONOUS ANSWER. A frame cannot await — `peek()` says "here, or
 *      null", and a miss starts the fetch (`want()`), so drawing code paints a
 *      placeholder and is re-asked when `onReady` fires.
 *   3. A FAILURE NEVER POISONS. A flaky network retries with backoff inside
 *      one load; if it still fails, the next `load()` tries afresh — never a
 *      rejected promise remembered for the rest of the session.
 *   4. A STALE DEPLOY IS NAMED. A chunk that is gone after every retry usually
 *      means a newer version shipped under this tab: the host's failure hook
 *      (`onLazyFailure`) asks for the update check, and the reload it offers
 *      brings matching chunks.
 *   5. IDLE PREFETCH. `prefetch()` fetches when the main thread is idle — for
 *      what the user is about to need (the 3D engine while a world is on the
 *      page, a plugin on hover), without blocking what they are doing.
 *
 * CACHING IS PER VERSION BY CONSTRUCTION. Chunks are content-hashed and
 * served immutable: the browser keeps each one under its hash until a new
 * version changes it, and this layer keeps the evaluated module in memory for
 * the session. A module that carries its own version (`version`) is known by
 * `id@version`, so re-registering a newer one loads the newer one.
 *
 * Headless and DOM-free: it runs in the editor, a worker, a test or Node.
 */

export type LazyState = "idle" | "loading" | "ready" | "failed";

export interface Lazy<T> {
  readonly id: string;
  readonly version: string | null;
  readonly state: LazyState;
  /** The module if it is in memory — never awaits, never throws. */
  peek(): T | null;
  /**
   * `peek()`, and on a miss start fetching (drawing code's question). After a
   * failure it waits `wantCooldownMs` before asking again — a frame repaints
   * far faster than a dead network comes back; `load()` and
   * `retryFailedLazyModules()` (the host's "we're back online") never wait.
   */
  want(): T | null;
  /** The module, fetched once and shared; a failure is retried, never remembered. */
  load(): Promise<T>;
  /** Fetch when the main thread is idle; errors are swallowed (a later `load` retries). */
  prefetch(): void;
  /** Called once it is ready — at once if it already is. Returns an unsubscribe. */
  onReady(cb: (value: T) => void): () => void;
}

export interface LazyOptions {
  /** A module's own version: it is known as `id@version`. */
  version?: string;
  /**
   * What a person would call it — "3D engine", "Depth model". Named modules
   * show in the activity ring while they load; unnamed ones (UI chunks) run
   * quietly unless they are slow, and are always reported when they fail.
   */
  label?: string;
  /** Extra attempts inside one load before it counts as failed (default 2). */
  retries?: number;
  /** First backoff in ms, doubling (default 400). */
  backoffMs?: number;
  /** How long `want()` leaves a failed module alone, ms (default 10 000). */
  wantCooldownMs?: number;
}

export interface LazyFailure {
  id: string;
  version: string | null;
  error: unknown;
  /** The error reads like a missing chunk (a deploy replaced it), not a bug in the module. */
  missingChunk: boolean;
}

export interface LazyEntry {
  id: string;
  version: string | null;
  state: LazyState;
  /** How long the last successful load took, ms. */
  loadMs: number | null;
}

const registry = new Map<string, Lazy<unknown> & { loadMs: number | null }>();
const failureHandlers = new Set<(f: LazyFailure) => void>();

/** The host hears about a load that failed after every retry (once per failure). */
export function onLazyFailure(handler: (f: LazyFailure) => void): () => void {
  failureHandlers.add(handler);
  return () => failureHandlers.delete(handler);
}

/** Every lazy module made so far, and how it stands — for diagnostics and tests. */
export function lazyModules(): LazyEntry[] {
  return [...registry.values()].map((l) => ({ id: l.id, version: l.version, state: l.state, loadMs: l.loadMs }));
}

/**
 * Load again every module whose last load failed — what a host calls when the
 * network comes back, so a family a frame gave up on lands (and repaints, via
 * `onReady`) without waiting for something to ask for it.
 */
export function retryFailedLazyModules(): number {
  let n = 0;
  for (const l of registry.values()) {
    if (l.state !== "failed") continue;
    n++;
    void l.load().catch(() => {});
  }
  return n;
}

const MISSING_CHUNK = /ChunkLoadError|Loading (CSS )?chunk|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i;

/** Did this error come from a chunk that could not be fetched (vs. one that threw)? */
export function isMissingChunk(error: unknown): boolean {
  const e = error as { name?: string; message?: string } | null;
  return !!e && (e.name === "ChunkLoadError" || MISSING_CHUNK.test(String(e.message ?? e)));
}

/** "effect-passes/glow" → "glow" — a name for a module nobody labelled. */
const humanId = (id: string) => (id.split("/").pop() ?? id).replace(/[-_]+/g, " ");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run on an idle main thread when the host has one; soon otherwise. */
export function whenIdle(fn: () => void): void {
  const g = globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (g.requestIdleCallback) g.requestIdleCallback(fn, { timeout: 4000 });
  else setTimeout(fn, 200);
}

/** A module that arrives later — see the file header for the contract. */
export function lazyModule<T>(id: string, loader: () => Promise<T>, opts: LazyOptions = {}): Lazy<T> {
  const version = opts.version ?? null;
  const key = version ? `${id}@${version}` : id;
  const existing = registry.get(key);
  if (existing) return existing as unknown as Lazy<T>;
  const retries = Math.max(0, opts.retries ?? 2);
  const backoff = Math.max(0, opts.backoffMs ?? 400);
  const cooldown = Math.max(0, opts.wantCooldownMs ?? 10_000);
  let failedAt = 0;
  let value: T | null = null;
  let has = false;
  let pending: Promise<T> | null = null;
  let state: LazyState = "idle";
  let prefetching = false;
  const listeners = new Set<(v: T) => void>();

  const attempt = async (): Promise<T> => {
    let lastError: unknown;
    for (let i = 0; i <= retries; i++) {
      try {
        return await loader();
      } catch (e) {
        lastError = e;
        // A module that THREW is a bug, not a network: retrying runs it again for nothing.
        if (!isMissingChunk(e) && !/network|fetch|timeout/i.test(String((e as Error)?.message ?? e))) break;
        if (i < retries) await sleep(backoff * 2 ** i);
      }
    }
    throw lastError;
  };

  const self: Lazy<T> & { loadMs: number | null } = {
    id,
    version,
    loadMs: null,
    get state() {
      return state;
    },
    peek: () => (has ? value : null),
    want() {
      if (!has && (state !== "failed" || Date.now() - failedAt >= cooldown)) void self.load().catch(() => {});
      return has ? value : null;
    },
    load() {
      if (has) return Promise.resolve(value as T);
      if (pending) return pending;
      state = "loading";
      const started = Date.now();
      // Supervised, so the activity ring can say what is arriving and a
      // failure is classified (offline, server, a stale deploy) in one place.
      pending = supervisor.run<T>({ kind: "load", label: `Loading ${opts.label ?? humanId(id)}`, ephemeral: true }, () => attempt()).then(
        (v) => {
          value = v;
          has = true;
          state = "ready";
          pending = null;
          self.loadMs = Date.now() - started;
          for (const cb of [...listeners]) cb(v);
          listeners.clear();
          return v;
        },
        (error) => {
          state = "failed";
          failedAt = Date.now();
          pending = null;
          const failure: LazyFailure = { id, version, error, missingChunk: isMissingChunk(error) };
          for (const h of failureHandlers) h(failure);
          throw error;
        },
      );
      return pending;
    },
    prefetch() {
      if (has || pending || prefetching) return;
      prefetching = true;
      whenIdle(() => {
        prefetching = false;
        void self.load().catch(() => {});
      });
    },
    onReady(cb) {
      if (has) {
        cb(value as T);
        return () => {};
      }
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  registry.set(key, self as unknown as Lazy<unknown> & { loadMs: number | null });
  return self;
}

/**
 * A FAMILY of lazy modules under one key space — effect families, engines,
 * languages: `get(key)` makes (once) the member a loader table names, and
 * `onAnyReady` hears every member land (what repaints a stage).
 */
export interface LazyFamily<K extends string, T> {
  get(key: K): Lazy<T> | null;
  peek(key: K): T | null;
  want(key: K): T | null;
  load(key: K): Promise<T | null>;
  onAnyReady(cb: (key: K) => void): () => void;
}

export function lazyFamily<K extends string, T>(id: string, loaderFor: (key: K) => (() => Promise<T>) | null | undefined, opts: LazyOptions = {}): LazyFamily<K, T> {
  const members = new Map<K, Lazy<T> | null>();
  const listeners = new Set<(key: K) => void>();
  const get = (key: K): Lazy<T> | null => {
    if (members.has(key)) return members.get(key)!;
    const loader = loaderFor(key);
    const m = loader ? lazyModule(`${id}/${key}`, loader, { ...opts, label: opts.label ? `${key} ${opts.label}` : undefined }) : null;
    m?.onReady(() => {
      for (const cb of [...listeners]) cb(key);
    });
    members.set(key, m);
    return m;
  };
  return {
    get,
    peek: (key) => get(key)?.peek() ?? null,
    want: (key) => get(key)?.want() ?? null,
    load: async (key) => {
      const m = get(key);
      return m ? m.load() : null;
    },
    onAnyReady(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
