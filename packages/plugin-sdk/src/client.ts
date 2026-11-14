import type { PluginApi, HostContext } from "./api";

export interface PluginBootstrapConfig {
  /** Per-instance secret the host injects; echoed on every request. */
  nonce: string;
  /** Static boot context, so `getContext()` needs no round-trip. */
  context: HostContext;
  /** The host's data namespace: the wire tags (`<ns>:req`…) and the global (`window.<ns>`). */
  ns: string;
}

/**
 * The client half of the bridge. It is SELF-CONTAINED on purpose: the host
 * stringifies this function with `.toString()` and injects it into the sandboxed
 * iframe before the plugin's own code runs. That means the runtime body must not
 * reference imports or module-scope values (type-only references are erased and
 * therefore safe). It installs `window.<ns>` and announces `ready`.
 *
 * Plugin authors never call this — they just use the `window.<ns>` it
 * installs (typed via {@link PluginApi}). It lives in the SDK so the client and
 * the host protocol are edited together and can never drift.
 */
export function pluginClientBootstrap(config: PluginBootstrapConfig): void {
  const nonce = config.nonce;
  const ns = config.ns;
  let seq = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();

  function call(method: string, params?: unknown): Promise<unknown> {
    const id = ++seq;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      window.parent.postMessage({ kind: `${ns}:req`, nonce, id, method, params: params ?? null }, "*");
    });
  }

  window.addEventListener("message", (event: MessageEvent) => {
    const msg = event.data as {
      kind?: string;
      id?: number;
      ok?: boolean;
      result?: unknown;
      error?: { message?: string };
      event?: string;
      payload?: unknown;
    };
    if (!msg || typeof msg !== "object") return;
    if (msg.kind === `${ns}:res` && typeof msg.id === "number") {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error?.message ?? "Plugin call failed"));
    } else if (msg.kind === `${ns}:evt` && typeof msg.event === "string") {
      const set = listeners.get(msg.event);
      if (set) for (const handler of set) handler(msg.payload);
    }
  });

  function on(event: string, handler: (payload: unknown) => void): () => void {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    const bucket = set;
    bucket.add(handler);
    return () => {
      bucket.delete(handler);
    };
  }

  const api = {
    getContext: () => Promise.resolve(config.context),
    document: {
      getInfo: () => call("document.getInfo"),
      insertText: (params: unknown) => call("document.insertText", params),
    },
    selection: {
      get: () => call("selection.get"),
    },
    ui: {
      notify: (message: string, level?: string) => call("ui.notify", { message, level }).then(() => undefined),
      resize: (size: unknown) => call("ui.resize", size).then(() => undefined),
      close: () => call("ui.close").then(() => undefined),
    },
    on,
  };

  (window as unknown as Record<string, PluginApi>)[ns] = api as unknown as PluginApi;
  window.parent.postMessage({ kind: `${ns}:ready`, nonce }, "*");
}
