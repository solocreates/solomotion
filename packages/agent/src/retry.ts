/**
 * RETRY — one policy for every provider, so "the model is overloaded" reads
 * the same whether it came from Anthropic's 529, OpenAI's 429 or a local
 * server that dropped the socket.
 *
 * Retry what a second attempt can fix (rate limits, overload, 5xx, the
 * network, a stream cut mid-flight) — up to ten times, backing off
 * exponentially with jitter and honouring `retry-after` — and fail at once on
 * what it cannot (a bad key, a missing model, a malformed request). The loop
 * reports each wait, so the chat can say "Retrying in 8s (3/10)" instead of
 * looking frozen.
 */

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
    /** A short machine-readable reason for the UI: auth, rate_limit, overloaded, network… */
    readonly code: string = "error",
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export class AbortedError extends Error {
  constructor() {
    super("Stopped");
    this.name = "AbortError";
  }
}

export function isAbort(err: unknown): boolean {
  return err instanceof AbortedError || (err instanceof Error && err.name === "AbortError");
}

export interface RetryInfo {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
}

export interface RetryPolicy {
  maxAttempts: number;
  baseMs: number;
  capMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 10, baseMs: 1000, capMs: 45_000 };

/** Classify anything an SDK or `fetch` can throw into a ProviderError. */
export function classify(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const e = err as { status?: number; headers?: Headers | Record<string, string>; message?: string; name?: string; error?: { type?: string; message?: string } };
  const status = typeof e?.status === "number" ? e.status : null;
  const message = e?.error?.message ?? e?.message ?? String(err);
  const retryAfterMs = retryAfterOf(e?.headers);
  if (status === null) {
    // No status = the request never completed: network, CORS, a dropped stream.
    const cors = /failed to fetch|networkerror|load failed/i.test(message);
    return new ProviderError(
      cors ? "Could not reach the provider (network or browser access blocked)." : message,
      null,
      true,
      null,
      cors ? "network" : "stream",
    );
  }
  if (status === 401 || status === 403) return new ProviderError(message || "The key was rejected.", status, false, null, "auth");
  if (status === 404) return new ProviderError(message || "That model or endpoint does not exist.", status, false, null, "not_found");
  if (status === 400 || status === 413 || status === 422) return new ProviderError(message, status, false, null, "bad_request");
  if (status === 429) return new ProviderError(message || "Rate limited.", status, true, retryAfterMs, "rate_limit");
  if (status === 529 || /overloaded/i.test(message)) return new ProviderError(message || "The model is overloaded.", status, true, retryAfterMs, "overloaded");
  if (status === 408 || status === 409 || status >= 500) return new ProviderError(message || `Server error ${status}.`, status, true, retryAfterMs, "server");
  return new ProviderError(message, status, false, null, "error");
}

function retryAfterOf(headers: Headers | Record<string, string> | undefined): number | null {
  if (!headers) return null;
  const get = (k: string) => (headers instanceof Headers ? headers.get(k) : (headers as Record<string, string>)[k]);
  const ms = get("retry-after-ms");
  if (ms && Number.isFinite(Number(ms))) return Number(ms);
  const s = get("retry-after");
  if (!s) return null;
  const secs = Number(s);
  if (Number.isFinite(secs)) return secs * 1000;
  const date = Date.parse(s);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

export function backoffMs(attempt: number, policy: RetryPolicy, hintMs: number | null): number {
  if (hintMs !== null) return Math.min(policy.capMs * 2, Math.max(250, hintMs));
  const exp = Math.min(policy.capMs, policy.baseMs * 2 ** (attempt - 1));
  // Full jitter: many clients hitting one overloaded server spread out.
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortedError());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run `attempt` until it succeeds, fails for good, or the signal fires.
 * `attempt` receives the 1-based attempt number.
 */
export async function withRetry<T>(
  attempt: (n: number) => Promise<T>,
  opts: { policy?: RetryPolicy; signal?: AbortSignal; onRetry?: (info: RetryInfo) => void } = {},
): Promise<T> {
  const policy = opts.policy ?? DEFAULT_RETRY;
  for (let n = 1; ; n++) {
    try {
      return await attempt(n);
    } catch (err) {
      if (isAbort(err) || opts.signal?.aborted) throw new AbortedError();
      const e = classify(err);
      if (!e.retryable || n >= policy.maxAttempts) throw e;
      const delayMs = backoffMs(n, policy, e.retryAfterMs);
      opts.onRetry?.({ attempt: n + 1, maxAttempts: policy.maxAttempts, delayMs, reason: e.message });
      await sleep(delayMs, opts.signal);
    }
  }
}
