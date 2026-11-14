import { TaskAborted } from "./signal";

/**
 * WHY SOMETHING FAILED, in the words a person can act on.
 *
 * A failed load or job used to surface as its raw message ("TypeError: Failed
 * to fetch", "ChunkLoadError: Loading chunk 812 failed"), which is the same
 * sentence for "you are offline", "our server had a bad minute" and "a new
 * version shipped under this tab" — three problems with three different fixes.
 * One classifier, read by the activity ring, the Activity window and the
 * console report, so the three cannot disagree about what happened.
 *
 *   offline      the device has no network — wait, it retries when it's back
 *   network      the request didn't complete (DNS, reset, CORS, a blocked host)
 *   server       the server answered with an error (5xx, 429)
 *   missing      the file is gone — usually a newer version shipped; reload
 *   unsupported  this browser can't do it (no WebGPU, no codec)
 *   timeout      it ran out of its time budget
 *   bug          the code threw — reported, not something the person caused
 */
export type FailureKind = "offline" | "network" | "server" | "missing" | "unsupported" | "timeout" | "bug";

export const FAILURE_META: Record<FailureKind, { label: string; retry: boolean }> = {
  offline: { label: "You're offline", retry: true },
  network: { label: "Network error", retry: true },
  server: { label: "Server error", retry: true },
  missing: { label: "A newer version is out — reload", retry: false },
  unsupported: { label: "Not supported in this browser", retry: false },
  timeout: { label: "Took too long", retry: true },
  bug: { label: "Something broke", retry: true },
};

const MISSING = /ChunkLoadError|Loading (CSS )?chunk|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|\b404\b|not found/i;
const SERVER = /\b(5\d\d|429)\b|server error|service unavailable|bad gateway|too many requests/i;
const NETWORK = /failed to fetch|networkerror|network error|load failed|network request failed|err_(network|internet|connection|name)|timed? ?out|aborted by the network/i;
const UNSUPPORTED = /not supported|unsupported|no webgpu|webgpu|webcodecs|notsupportederror/i;

/**
 * Classify an error. `online` is the host's network flag (`navigator.onLine`);
 * omitted, offline is never claimed — core cannot see the network.
 */
export function classifyFailure(error: unknown, opts: { online?: boolean } = {}): FailureKind {
  if (error instanceof TaskAborted && error.reason === "expired") return "timeout";
  const e = error as { name?: string; message?: string; status?: number } | null;
  const text = `${e?.name ?? ""} ${e?.message ?? String(error)}`;
  if (typeof e?.status === "number") {
    if (e.status === 404 || e.status === 410) return "missing";
    if (e.status >= 500 || e.status === 429) return "server";
  }
  if (MISSING.test(text)) return opts.online === false ? "offline" : "missing";
  if (SERVER.test(text)) return "server";
  if (NETWORK.test(text)) return opts.online === false ? "offline" : "network";
  if (e?.name === "NotSupportedError" || UNSUPPORTED.test(text)) return "unsupported";
  return opts.online === false ? "offline" : "bug";
}

let onlineProbe: () => boolean | undefined = () => {
  const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
  return typeof nav?.onLine === "boolean" ? nav.onLine : undefined;
};

/** Tests (and hosts without `navigator`) say how to read the network flag. */
export function setOnlineProbe(probe: () => boolean | undefined): void {
  onlineProbe = probe;
}

export function currentlyOnline(): boolean | undefined {
  return onlineProbe();
}
