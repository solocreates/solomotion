import type { Capability } from "./capabilities";

/**
 * `window.<ns>` (the host's namespace) — the ONLY surface a sandboxed plugin can touch. Every method
 * is async (a `postMessage` round-trip to the host), except reads of static
 * boot context. This interface is the public contract plugin authors code
 * against; the host implements the other side in `sandbox/bridge`.
 *
 * Keep this list intentional and narrow: each method maps to a capability in
 * `METHOD_CAPABILITY` and is only reachable if the plugin declared it. Growing
 * the API is additive — new methods + new capabilities, never a breaking rename.
 */

export interface HostContext {
  /** The editor build the plugin is running inside (NEXT_PUBLIC_APP_VERSION). */
  appVersion: string;
  /** Protocol major the host speaks (PLUGIN_PROTOCOL_VERSION). */
  apiVersion: number;
  plugin: { id: string; name: string; version: string };
  /** Capabilities the host granted this instance (⊆ what the manifest asked). */
  capabilities: Capability[];
}

export interface DocInfo {
  id: string;
  name: string;
  /**
   * Frame rate of the comp the editor is currently focused on.
   *
   * A project has no single rate — every comp carries its own, so a plugin that
   * needs the rate of a PARTICULAR comp should read that comp rather than this
   * field. This stays on the contract (and stays a number) because plugins ask
   * "what rate am I authoring against right now", and the focused comp is the
   * honest answer to that.
   */
  fps: number;
  durationMs: number;
  frameCount: number;
}

export interface SelectionInfo {
  /** The comp/frame the editor is focused on (drives where inserts land). */
  activeFrameId: string | null;
  frameIds: string[];
  clipIds: string[];
}

export interface InsertTextParams {
  text: string;
  /** Offset from the frame centre, in px. Defaults to the centre. */
  x?: number;
  y?: number;
  fontSize?: number;
  /** Any CSS color; defaults to the document's text color. */
  color?: string;
}

export interface InsertTextResult {
  clipId: string;
}

export type NotifyLevel = "info" | "success" | "warning" | "error";

export interface PluginApi {
  /** Host + plugin identity and the capabilities you were granted. */
  getContext(): Promise<HostContext>;

  document: {
    getInfo(): Promise<DocInfo>;
    /** Insert a text layer into the active frame. Requires `document:write`. */
    insertText(params: InsertTextParams): Promise<InsertTextResult>;
  };

  selection: {
    /** Current selection. Requires `selection:read`. */
    get(): Promise<SelectionInfo>;
  };

  ui: {
    /** Toast a message in the editor. Requires `ui:notify`. */
    notify(message: string, level?: NotifyLevel): Promise<void>;
    /** Resize this plugin's window. */
    resize(size: { width: number; height: number }): Promise<void>;
    /** Close this plugin's window. */
    close(): Promise<void>;
  };

  /** Subscribe to an editor event; returns an unsubscribe function. */
  on(event: "selectionchange", handler: (info: SelectionInfo) => void): () => void;
}

/** Editor events the host pushes to plugins that subscribe. */
export type PluginEventName = "selectionchange";

/**
 * The ONE authorization table: wire method → capability it requires (`null` =
 * always allowed). The host bridge consults this before dispatching, so adding a
 * method without an entry here fails closed (unknown method → rejected).
 */
export const METHOD_CAPABILITY: Record<string, Capability | null> = {
  "document.getInfo": "document:read",
  "document.insertText": "document:write",
  "selection.get": "selection:read",
  "ui.notify": "ui:notify",
  "ui.resize": null,
  "ui.close": null,
};
