/**
 * Capability PORTS — the headless contract every host must satisfy.
 *
 * This file is pure types: no browser API, no host SDK, no React. App code
 * depends only on these shapes; `adapters/web.ts` implements them (and a future
 * native adapter would too). Add a capability here first, then teach each
 * adapter — the compiler then forces every host to keep up.
 */

/** A file handed to the app — from an OS drop, an open dialog, or a browser <input>. */
export interface AppFile {
  name: string;
  /** Absolute OS path when the host knows one (Tauri drops/dialogs); undefined on the web. */
  path?: string;
  /** MIME type when known. */
  mime?: string;
  /** Read the bytes. Lazy so large media isn't slurped into memory until used. */
  read(): Promise<Uint8Array>;
}

/** One entry in an open/save dialog's type filter. */
export interface FileFilter {
  name: string;
  /** Extensions WITHOUT the dot, e.g. ["png", "jpg"]. */
  extensions: string[];
}

export interface FsPort {
  /**
   * Open one or more real files. Returns [] if the user cancels.
   * Web: File System Access API, falling back to a hidden <input>.
   * Tauri: native open dialog + fs read (yields real paths).
   */
  open(opts?: { multiple?: boolean; filters?: FileFilter[] }): Promise<AppFile[]>;
  /**
   * Save bytes to a real file the user picks. Returns the path (Tauri) or the
   * chosen name (web download), or null if cancelled.
   */
  save(opts: { data: Uint8Array; defaultName: string; filters?: FileFilter[] }): Promise<string | null>;
}

export interface FileDropPort {
  /**
   * Subscribe to OS files dropped onto the app window. Returns an unsubscribe fn.
   * This is for files coming FROM the OS only — in-app dnd-kit reordering is
   * unrelated and untouched. Tauri gives real paths here; the web reads the
   * HTML5 DataTransfer. Wiring a handler auto-suppresses the browser's default
   * "navigate to the dropped file" behaviour on the web.
   */
  on(handler: (files: AppFile[]) => void): () => void;
}

/**
 * A host-agnostic handle to a real directory the user linked. `id` is the key
 * the host persists the live handle under (a stored File System Access handle on
 * the web; on native the `path` suffices). Serializable, so it can travel in the
 * project — on a machine where neither resolves, scanning just yields nothing.
 */
export interface DirectoryRef {
  id: string;
  name: string;
  path?: string | null;
}

/** One importable file found while scanning a linked directory. */
export interface FolderScanFile extends AppFile {
  /** Path relative to the linked root, POSIX-separated — the stable dedup key. */
  relPath: string;
  mtimeMs: number;
  size: number;
}

export interface FolderPort {
  /** Whether this host can LINK a folder for repeated re-scan (persisted handle / native path). One-shot folder import doesn't need this. */
  canLink(): boolean;
  /**
   * Prompt for a directory and persist whatever's needed to re-scan it later.
   * Returns a serializable ref, or null if cancelled / unsupported.
   */
  pick(): Promise<DirectoryRef | null>;
  /**
   * Enumerate importable files under a previously-picked ref (recursive).
   * Resolves [] when the ref can't be resolved on this host — a missing handle,
   * a stale path, or lapsed permission — so the caller degrades gracefully.
   */
  scan(ref: DirectoryRef): Promise<FolderScanFile[]>;
  /**
   * Re-establish access to a ref (re-request a lapsed web handle permission,
   * on a user gesture). Native hosts are always granted. False = no access.
   */
  ensureAccess(ref: DirectoryRef): Promise<boolean>;
  /**
   * Watch a ref for on-disk changes; the handler fires (debounced) on any add /
   * change / remove. Native only — the web has no directory watch, so it returns
   * a bare unsubscribe and callers re-scan on window focus instead.
   */
  watch(ref: DirectoryRef, onChange: () => void): () => void;
  /** Drop any persisted state for a ref (web handle, native watcher) on unlink. */
  forget(ref: DirectoryRef): Promise<void>;
}

export interface ClipboardPort {
  /**
   * Read importable files sitting on the system clipboard, so ⌘V can behave
   * exactly like a drop. Covers two sources:
   *  • Browser image blobs — "copy image", screenshots, snipping tool — read via
   *    the async Clipboard API (works in every Chromium/Safari host, desktop shell
   *    included). Requires transient activation, so call it from the paste gesture.
   *  • OS file copies (Finder / Explorer "Copy") — only the native shell can read
   *    real file bytes off the clipboard; the web returns none for those.
   * Never throws: resolves `[]` when the clipboard holds no importable media or
   * access is blocked, so callers can fall through to their own paste logic.
   */
  readFiles(): Promise<AppFile[]>;
}

export interface NetPort {
  /**
   * Fetch a Google-Fonts TTF binary for text→path outlining. Browsers can only
   * pull UA-negotiated woff2 (which opentype.js can't parse without brotli), so
   * this does the legacy-UA CSS dance. Web routes through the Next `/api/font`
   * proxy; Tauri does it in-process via the HTTP plugin (no CORS). Null if the
   * variant can't be resolved (e.g. offline).
   */
  fetchFont(spec: { family: string; weight?: number; italic?: boolean }): Promise<Uint8Array | null>;
}

/** One installed system-font face, as surfaced by the Local Font Access API. */
export interface SystemFont {
  /** Family name, e.g. "Helvetica Neue". */
  family: string;
  /** Full face name, e.g. "Helvetica Neue Bold". */
  fullName: string;
  /** PostScript name — unique per face. */
  postscriptName: string;
  /** Style / subfamily, e.g. "Bold Italic". */
  style: string;
  /** The font file bytes, loaded on demand. */
  blob(): Promise<Blob>;
}

export interface FontsPort {
  /** True when this host can enumerate installed system fonts (Local Font Access API). */
  supported(): boolean;
  /**
   * Enumerate installed system fonts. Prompts for permission on first use;
   * resolves [] if the host can't do it (non-Chromium) or the user declines.
   */
  querySystem(): Promise<SystemFont[]>;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogPort {
  /**
   * Forward a captured log line to the host's native sink (Tauri → stdout + a
   * rotating file for offline crash triage). No-op on the web, where the real
   * browser console already shows everything.
   */
  write(level: LogLevel, message: string): void;
}

export interface AppInfoPort {
  readonly kind: import("./env").PlatformKind;
  readonly os: import("./env").OsKind;
  /** App version, resolved async on Tauri; "dev" on the web. */
  version(): Promise<string>;
}

/** The newest build a host discovered, in a source-agnostic shape. */
export interface UpdateManifest {
  /** Semver of the latest available build, e.g. "0.6.0". */
  version: string;
  /** Human release title, if any. */
  name?: string;
  /** Raw markdown release notes, if any. */
  notes?: string;
  /** Web page for the full notes / all assets. */
  notesUrl?: string;
  /** ISO publish timestamp, if known. */
  publishedAt?: string;
}

/**
 * How a host applies an update once the user accepts:
 *  • "reload"  — the running build is stale; a reload pulls the fresh one
 *                (browser tab, or the Electron shell loading the remote app).
 *  • "install" — a native binary was downloaded and installs on relaunch.
 */
export type UpdateApplyKind = "reload" | "install";

export interface UpdatePort {
  /** The version this client is currently running. */
  readonly current: string;
  /** How {@link apply} behaves on this host. */
  readonly applyKind: UpdateApplyKind;
  /**
   * Discover the newest available build. Returns `null` when the check itself
   * fails (offline, rate-limited) so callers stay silent rather than error —
   * comparison against {@link current} is the caller's job (see a product's releases reader).
   */
  checkLatest(): Promise<UpdateManifest | null>;
  /** Apply the update: reload to the fresh build, or install the staged binary. */
  apply(): Promise<void>;
  /**
   * Subscribe to native download progress (0‥1) for "install" hosts; the handler
   * fires as a binary downloads. No-op (returns a bare unsubscribe) on "reload"
   * hosts, which have nothing to download.
   */
  onProgress(handler: (fraction: number) => void): () => void;
}

/**
 * One node in a native application-menu template — a serializable subset of
 * Electron's MenuItemConstructorOptions (no `click` function crosses the IPC
 * boundary). Leaves that drive the app carry a `command` id the host routes back
 * to the renderer; `role` items are handled natively by the OS. The renderer
 * owns the whole tree (see the editor's menu-spec), so the in-window menu and
 * the native menu can never drift.
 */
export interface MenuTemplateNode {
  /** Visible label. Omitted for separators and pure-role items. */
  label?: string;
  /** A native Electron role (e.g. "quit", "hide", "minimize", "appMenu"). */
  role?: string;
  /** "separator" | "checkbox" | "normal" | "submenu" — inferred when omitted. */
  type?: "normal" | "separator" | "checkbox" | "submenu";
  /** App command id routed back through {@link MenuPort.onCommand} on click. */
  command?: string;
  /** Checkbox state for `type: "checkbox"` items. */
  checked?: boolean;
  /** Disable the item when false. */
  enabled?: boolean;
  /** Nested items for a submenu. */
  submenu?: MenuTemplateNode[];
}

export interface MenuPort {
  /** True when the host owns a native application menu to drive (desktop shell). */
  supported(): boolean;
  /** Replace the native application menu with this template. No-op on the web. */
  set(template: MenuTemplateNode[]): void;
  /**
   * Subscribe to native menu-item clicks (the `command` id of the chosen item).
   * Returns an unsubscribe fn. No-op (bare unsubscribe) on the web.
   */
  onCommand(handler: (command: string) => void): () => void;
}

/**
 * Addresses handed to the app from OUTSIDE it — an `<ns>://…` link clicked
 * in another app, which the OS gives the desktop shell. The web has no such
 * channel (its address bar is the deep link), so there it never fires.
 */
export interface DeepLinkPort {
  /**
   * Subscribe to incoming links. A link that arrived before anyone listened
   * (the one that launched the app) is delivered on subscribe. Returns an
   * unsubscribe fn.
   */
  onOpen(handler: (url: string) => void): () => void;
}

/** The full facade every host provides. */
export interface PlatformAdapter {
  fs: FsPort;
  fileDrop: FileDropPort;
  clipboard: ClipboardPort;
  folder: FolderPort;
  net: NetPort;
  fonts: FontsPort;
  log: LogPort;
  app: AppInfoPort;
  update: UpdatePort;
  menu: MenuPort;
  deepLink: DeepLinkPort;
}
