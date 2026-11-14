/**
 * Web adapter — pure browser APIs. This is the only adapter today: both hosts
 * (the browser and the Electron renderer) run the app in Chromium, so standard
 * web APIs cover both. A true-native adapter (real file paths, native menus)
 * would slot in beside this behind the same ports if we ever need it.
 */

import { osKind } from "../env";
import { createHandleStore } from "./handle-store";
import { desktopBridge, type HostIdentity } from "../host";
import type {
  AppFile,
  DirectoryRef,
  FileFilter,
  FolderScanFile,
  MenuTemplateNode,
  PlatformAdapter,
  SystemFont,
  UpdateManifest,
} from "../ports";


/**
 * Optional native update bridge the Electron preload may expose. When present,
 * the host owns a real binary updater (download + install on relaunch); when
 * absent — plain browser, or the desktop shell loading the remote app — updates
 * are just a stale build healed by a reload.
 */
interface NativeUpdateBridge {
  current: string;
  check(): Promise<UpdateManifest | null>;
  install(): Promise<void>;
  onProgress(handler: (fraction: number) => void): () => void;
}
function nativeUpdate(host: HostIdentity): NativeUpdateBridge | null {
  return desktopBridge<{ update?: NativeUpdateBridge }>(host)?.update ?? null;
}

/**
 * Optional native clipboard bridge the desktop preload may expose. Browsers can
 * read image blobs off the clipboard, but only the native shell can read the
 * bytes of OS file copies (Finder / Explorer "Copy"). When absent (plain
 * browser), the image-blob path below is the only source.
 */
interface NativeClipboardFile {
  name: string;
  /** Absolute OS path the file came from — used to dedupe re-pastes. */
  path?: string;
  mime?: string;
  /** Raw bytes, structured-cloned across the IPC boundary. */
  bytes: ArrayBuffer | Uint8Array | number[];
}
interface NativeClipboardBridge {
  readFiles(): Promise<NativeClipboardFile[]>;
}
function nativeClipboard(host: HostIdentity): NativeClipboardBridge | null {
  return desktopBridge<{ clipboard?: NativeClipboardBridge }>(host)?.clipboard ?? null;
}

/**
 * Optional native application-menu bridge the desktop preload may expose. Present
 * only in the Electron shell (which owns the real OS menu bar); absent in the
 * plain browser, where there's no native menu and the port no-ops.
 */
interface NativeMenuBridge {
  set(template: MenuTemplateNode[]): void;
  onCommand(handler: (command: string) => void): () => void;
}
function nativeMenu(host: HostIdentity): NativeMenuBridge | null {
  return desktopBridge<{ menu?: NativeMenuBridge }>(host)?.menu ?? null;
}

/** The desktop preload's deep-link bridge (`<ns>://`); absent in a browser. */
interface NativeDeepLinkBridge {
  onOpen(handler: (url: string) => void): () => void;
}
function nativeDeepLink(host: HostIdentity): NativeDeepLinkBridge | null {
  return desktopBridge<{ deepLink?: NativeDeepLinkBridge }>(host)?.deepLink ?? null;
}

/** Sensible file extension for a pasted image blob, keyed off its MIME type. */
const IMAGE_MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/bmp": "bmp",
};
function extForImageMime(mime: string): string {
  return IMAGE_MIME_EXT[mime] ?? mime.split("/")[1]?.replace(/\+.*$/, "") ?? "png";
}

/** A clipboard image blob → a named AppFile the import pipeline understands. */
function imageBlobToAppFile(blob: Blob, mime: string): AppFile {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return {
    name: `pasted-image-${stamp}.${extForImageMime(mime)}`,
    mime,
    read: () => blob.arrayBuffer().then((b) => new Uint8Array(b)),
  };
}

/** A native clipboard file (bytes already read by the shell) → an AppFile. */
function nativeClipboardFileToAppFile(f: NativeClipboardFile): AppFile {
  return {
    name: f.name,
    path: f.path,
    mime: f.mime,
    read: async () => {
      const b = f.bytes;
      if (b instanceof Uint8Array) return b;
      if (b instanceof ArrayBuffer) return new Uint8Array(b);
      return new Uint8Array(b);
    },
  };
}

/** The Local Font Access API — Chromium only (Electron renderer included). */
interface LocalFontData {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
  blob(): Promise<Blob>;
}
type QueryLocalFonts = () => Promise<LocalFontData[]>;

function fileToAppFile(file: File): AppFile {
  return {
    name: file.name,
    mime: file.type || undefined,
    read: () => file.arrayBuffer().then((b) => new Uint8Array(b)),
  };
}

/** Build the `accept` attribute / picker types from our neutral filter shape. */
function acceptString(filters?: FileFilter[]): string {
  if (!filters?.length) return "";
  return filters.flatMap((f) => f.extensions.map((e) => `.${e}`)).join(",");
}

async function openViaInput(multiple: boolean, filters?: FileFilter[]): Promise<AppFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = multiple;
    const accept = acceptString(filters);
    if (accept) input.accept = accept;
    input.style.display = "none";
    // `cancel` (modern browsers) resolves []; `change` resolves the picks.
    input.addEventListener("cancel", () => resolve([]), { once: true });
    input.addEventListener(
      "change",
      () => resolve(Array.from(input.files ?? []).map(fileToAppFile)),
      { once: true },
    );
    document.body.appendChild(input);
    input.click();
    input.remove();
  });
}

/**
 * Optional native folder bridge the desktop preload may expose. The renderer
 * can pick/scan/watch a real directory here; watch fires the subscribed handler
 * (keyed by ref id) when the OS reports a change. Absent in a plain browser,
 * where the File System Access path below takes over.
 */
interface NativeFolderBridge {
  pick(): Promise<{ id: string; name: string; path: string } | null>;
  /** Metadata-only listing — bytes are pulled lazily via {@link read}. */
  scan(path: string): Promise<Array<{ relPath: string; name: string; mime?: string; mtimeMs: number; size: number }>>;
  /** Read one file's bytes on demand (so a sync only reads what it imports). */
  read(path: string, relPath: string): Promise<ArrayBuffer | Uint8Array>;
  /** Start watching `path` under `id`; returns nothing. Idempotent per id. */
  watch(id: string, path: string): void;
  /** Stop watching `id`. */
  unwatch(id: string): void;
  /** Subscribe to change events (payload = the watched ref id). Returns unsubscribe. */
  onChange(handler: (id: string) => void): () => void;
}
function nativeFolder(host: HostIdentity): NativeFolderBridge | null {
  return desktopBridge<{ folder?: NativeFolderBridge }>(host)?.folder ?? null;
}

// Coarse "worth scanning" gate, name-only, so a huge folder isn't stat-ed file
// by file for nothing. The app's assetKindForFile is the authority on what's
// truly importable — keep this superset roughly in sync with it.
const IMPORTABLE_EXTS = new Set([
  "png", "jpg", "jpeg", "webp", "gif", "svg", "avif", "bmp",
  "mp4", "webm", "mov", "m4v",
  "mp3", "wav", "ogg", "m4a", "aac", "flac",
]);
function looksImportable(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return IMPORTABLE_EXTS.has(ext);
}

// Minimal typings for the File System Access directory API (not fully in lib.dom).
type FsPermission = "granted" | "denied" | "prompt";
interface FsDirHandle {
  name: string;
  kind: "directory";
  values(): AsyncIterable<FsDirHandle | FsFileHandle>;
  queryPermission?(o: { mode: "read" | "readwrite" }): Promise<FsPermission>;
  requestPermission?(o: { mode: "read" | "readwrite" }): Promise<FsPermission>;
}
interface FsFileHandle {
  name: string;
  kind: "file";
  getFile(): Promise<File>;
}

async function handlePermission(handle: FsDirHandle, request: boolean): Promise<boolean> {
  try {
    const opts = { mode: "read" } as const;
    const q = (await handle.queryPermission?.(opts)) ?? "granted";
    if (q === "granted") return true;
    if (!request) return false;
    return ((await handle.requestPermission?.(opts)) ?? "denied") === "granted";
  } catch {
    return false;
  }
}

/** Depth-first walk of a directory handle → importable scan files (bytes lazy). */
async function scanHandle(handle: FsDirHandle, prefix: string, out: FolderScanFile[]): Promise<void> {
  for await (const child of handle.values()) {
    if (child.kind === "directory") {
      await scanHandle(child as FsDirHandle, `${prefix}${child.name}/`, out);
    } else if (looksImportable(child.name)) {
      const fileHandle = child as FsFileHandle;
      try {
        const file = await fileHandle.getFile();
        out.push({
          relPath: `${prefix}${child.name}`,
          name: child.name,
          mime: file.type || undefined,
          mtimeMs: file.lastModified,
          size: file.size,
          read: () => file.arrayBuffer().then((b) => new Uint8Array(b)),
        });
      } catch {
        /* unreadable entry — skip */
      }
    }
  }
}

function showDirectoryPicker(): (() => Promise<FsDirHandle>) | null {
  const fn = (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  return typeof fn === "function" ? (fn as () => Promise<FsDirHandle>) : null;
}

function randomRefId(): string {
  return `dir_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createWebAdapter(host: HostIdentity): PlatformAdapter {
  const handles = createHandleStore(`${host.ns}-fs-handles`);
  return {
    fs: {
      async open({ multiple = false, filters } = {}) {
        // File System Access API is nicer (real handles) but Safari/Firefox lack
        // it — fall straight through to the <input> path there.
        const picker = (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker;
        if (typeof picker !== "function") return openViaInput(multiple, filters);
        try {
          const handles = await (picker as (o: unknown) => Promise<FileSystemFileHandle[]>)({
            multiple,
            types: filters?.map((f) => ({
              description: f.name,
              accept: { "application/octet-stream": f.extensions.map((e) => `.${e}`) },
            })),
          });
          return Promise.all(
            handles.map(async (h) => fileToAppFile(await h.getFile())),
          );
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") return [];
          return openViaInput(multiple, filters);
        }
      },
      async save({ data, defaultName }) {
        // Copy into a fresh ArrayBuffer so a possibly-shared/typed view over WASM
        // memory is safe to hand to Blob.
        const blob = new Blob([new Uint8Array(data)], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = defaultName;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return defaultName;
      },
    },

    fileDrop: {
      on(handler) {
        const onDragOver = (e: DragEvent) => {
          e.preventDefault(); // suppress the browser's "open the file" navigation
        };
        const onDrop = (e: DragEvent) => {
          e.preventDefault();
          const files = Array.from(e.dataTransfer?.files ?? []);
          if (files.length) handler(files.map(fileToAppFile));
        };
        window.addEventListener("dragover", onDragOver);
        window.addEventListener("drop", onDrop);
        return () => {
          window.removeEventListener("dragover", onDragOver);
          window.removeEventListener("drop", onDrop);
        };
      },
    },

    clipboard: {
      async readFiles(): Promise<AppFile[]> {
        // 1) Native OS file copies (Finder / Explorer) — only the desktop shell
        //    can read real file bytes off the clipboard. Highest fidelity, so it
        //    wins outright when present (a Finder copy of a .mp4 beats nothing on
        //    the web, and beats a re-encoded image blob for an actual image file).
        const native = nativeClipboard(host);
        if (native) {
          try {
            const files = await native.readFiles();
            if (files.length) return files.map(nativeClipboardFileToAppFile);
          } catch {
            /* Native read failed — fall through to browser image blobs. */
          }
        }

        // 2) Browser image blobs — "copy image", screenshots, the snipping tool.
        //    The async Clipboard API needs transient activation, so callers must
        //    invoke this straight off the paste gesture. Anything that isn't an
        //    image (plain text, our JSON payloads) yields nothing here and the
        //    caller falls through to its own paste path.
        try {
          const items = await navigator.clipboard.read();
          const out: AppFile[] = [];
          for (const item of items) {
            const type = item.types.find((t) => t.startsWith("image/"));
            if (!type) continue;
            out.push(imageBlobToAppFile(await item.getType(type), type));
          }
          return out;
        } catch {
          // No Clipboard API, no read permission, or nothing on it — resolve
          // empty so paste degrades gracefully to text / no-op.
          return [];
        }
      },
    },

    folder: {
      canLink() {
        return nativeFolder(host) !== null || showDirectoryPicker() !== null;
      },

      async pick(): Promise<DirectoryRef | null> {
        const native = nativeFolder(host);
        if (native) {
          const picked = await native.pick().catch(() => null);
          return picked ? { id: picked.id, name: picked.name, path: picked.path } : null;
        }
        const picker = showDirectoryPicker();
        if (!picker) return null;
        try {
          const handle = await picker();
          const id = randomRefId();
          await handles.put(id, handle as unknown as FileSystemDirectoryHandle);
          return { id, name: handle.name, path: null };
        } catch {
          // AbortError (user cancelled) or unsupported — nothing linked.
          return null;
        }
      },

      async scan(ref: DirectoryRef): Promise<FolderScanFile[]> {
        const native = nativeFolder(host);
        if (native && ref.path) {
          const path = ref.path;
          try {
            const files = await native.scan(path);
            return files.map((f) => ({
              relPath: f.relPath,
              name: f.name,
              mime: f.mime,
              mtimeMs: f.mtimeMs,
              size: f.size,
              read: async () => {
                const b = await native.read(path, f.relPath);
                return b instanceof Uint8Array ? b : new Uint8Array(b);
              },
            }));
          } catch {
            return [];
          }
        }
        const handle = (await handles.get(ref.id)) as unknown as FsDirHandle | null;
        if (!handle || !(await handlePermission(handle, false))) return [];
        const out: FolderScanFile[] = [];
        try {
          await scanHandle(handle, "", out);
        } catch {
          /* enumeration failed mid-way — return what we gathered */
        }
        return out;
      },

      async ensureAccess(ref: DirectoryRef): Promise<boolean> {
        if (nativeFolder(host) && ref.path) return true;
        const handle = (await handles.get(ref.id)) as unknown as FsDirHandle | null;
        return handle ? handlePermission(handle, true) : false;
      },

      watch(ref: DirectoryRef, onChange: () => void): () => void {
        const native = nativeFolder(host);
        if (!native || !ref.path) return () => {}; // web has no directory watch
        native.watch(ref.id, ref.path);
        const off = native.onChange((id) => id === ref.id && onChange());
        return () => {
          off();
          native.unwatch(ref.id);
        };
      },

      async forget(ref: DirectoryRef): Promise<void> {
        nativeFolder(host)?.unwatch(ref.id);
        await handles.delete(ref.id);
      },
    },

    net: {
      async fetchFont({ family, weight = 400, italic = false }) {
        // `all`: the proxy now serves every script the family has. Its old
        // answers were Latin-only and cached as immutable, so the URL must change.
        const q = `family=${encodeURIComponent(family)}&weight=${weight}${italic ? "&italic=1" : ""}&scripts=all`;
        const res = await fetch(`/api/font?${q}`);
        if (!res.ok) return null;
        return new Uint8Array(await res.arrayBuffer());
      },
    },

    fonts: {
      supported: () => typeof (window as { queryLocalFonts?: unknown }).queryLocalFonts === "function",
      async querySystem(): Promise<SystemFont[]> {
        const query = (window as unknown as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts;
        if (typeof query !== "function") return [];
        try {
          const fonts = await query();
          return fonts.map((f) => ({
            family: f.family,
            fullName: f.fullName,
            postscriptName: f.postscriptName,
            style: f.style,
            blob: () => f.blob(),
          }));
        } catch {
          // Permission denied or unavailable — system fonts just don't appear.
          return [];
        }
      },
    },

    log: {
      write() {
        /* No native sink on the web — the real console already shows everything. */
      },
    },

    app: {
      kind: "web",
      os: osKind(),
      version: () => Promise.resolve(host.version),
    },

    update: {
      get current() {
        return nativeUpdate(host)?.current ?? host.version;
      },
      get applyKind() {
        return nativeUpdate(host) ? "install" : "reload";
      },
      async checkLatest(): Promise<UpdateManifest | null> {
        const native = nativeUpdate(host);
        if (native) return native.check();
        // Browser / remote-shell path: ask our own origin what the freshest
        // deploy is. Same-origin, no-store, cheap — no GitHub rate limits. A
        // failure (offline, 404 on an old deploy) resolves null → stay silent.
        try {
          const res = await fetch("/api/version", { cache: "no-store" });
          if (!res.ok) return null;
          const data = (await res.json()) as { version?: string; notesUrl?: string };
          return typeof data.version === "string"
            ? { version: data.version, notesUrl: data.notesUrl }
            : null;
        } catch {
          return null;
        }
      },
      async apply(): Promise<void> {
        const native = nativeUpdate(host);
        if (native) return native.install();
        // Hashed assets + a no-SW origin mean a plain reload pulls the fresh
        // index.html and its new chunks — nothing to purge.
        window.location.reload();
      },
      onProgress(handler: (fraction: number) => void): () => void {
        return nativeUpdate(host)?.onProgress(handler) ?? (() => {});
      },
    },

    menu: {
      supported() {
        return nativeMenu(host) !== null;
      },
      set(template: MenuTemplateNode[]): void {
        nativeMenu(host)?.set(template);
      },
      onCommand(handler: (command: string) => void): () => void {
        return nativeMenu(host)?.onCommand(handler) ?? (() => {});
      },
    },

    deepLink: {
      onOpen(handler: (url: string) => void): () => void {
        return nativeDeepLink(host)?.onOpen(handler) ?? (() => {});
      },
    },
  };
}
