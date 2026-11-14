/**
 * The `platform` facade — the ONE object app code touches for host capabilities.
 *
 * Both hosts today (browser and the Electron desktop shell) run the app in a
 * Chromium renderer, so the web adapter's standard web APIs cover everything and
 * there's no separate desktop adapter to resolve — the facade is a thin, sync
 * pass-through. If we later want true native power (real file paths, native
 * menus, a main-process font fetch), it slots in behind this same surface as an
 * Electron adapter, chosen by `isDesktop()` — nothing downstream changes.
 */

import { isDesktop, osKind, platformKind } from "./env";
import { createWebAdapter } from "./adapters/web";
import type { HostIdentity } from "./host";
import { installConsoleCapture } from "./log/bus";
import type {
  AppFile,
  DirectoryRef,
  FileFilter,
  FolderScanFile,
  MenuTemplateNode,
  PlatformAdapter,
  SystemFont,
  UpdateApplyKind,
  UpdateManifest,
} from "./ports";

export interface Platform {
  fs: {
    open(opts?: { multiple?: boolean; filters?: FileFilter[] }): Promise<AppFile[]>;
    save(opts: { data: Uint8Array; defaultName: string; filters?: FileFilter[] }): Promise<string | null>;
  };
  fileDrop: {
    on(handler: (files: AppFile[]) => void): () => void;
  };
  clipboard: {
    /** Importable files on the clipboard (image blobs everywhere; OS file copies on native). Never throws — resolves [] when there's nothing to paste. */
    readFiles(): Promise<AppFile[]>;
  };
  folder: {
    /** Whether a folder can be LINKED for repeated re-scan on this host. */
    canLink(): boolean;
    /** Prompt for a directory to link; null if cancelled/unsupported. */
    pick(): Promise<DirectoryRef | null>;
    /** Recursively enumerate importable files under a linked ref ([] if unresolvable). */
    scan(ref: DirectoryRef): Promise<FolderScanFile[]>;
    /** Re-establish access to a linked ref (web permission re-request). */
    ensureAccess(ref: DirectoryRef): Promise<boolean>;
    /** Watch a linked ref for changes (native only; web returns a no-op). */
    watch(ref: DirectoryRef, onChange: () => void): () => void;
    /** Drop persisted state for a ref on unlink. */
    forget(ref: DirectoryRef): Promise<void>;
  };
  net: {
    fetchFont(spec: { family: string; weight?: number; italic?: boolean }): Promise<Uint8Array | null>;
  };
  fonts: {
    /** Whether installed system fonts can be enumerated in this host. */
    supported(): boolean;
    /** Installed system fonts (prompts once for permission; [] if unavailable/denied). */
    querySystem(): Promise<SystemFont[]>;
  };
  app: {
    readonly kind: ReturnType<typeof platformKind>;
    readonly os: ReturnType<typeof osKind>;
    readonly isDesktop: boolean;
    version(): Promise<string>;
  };
  update: {
    readonly current: string;
    readonly applyKind: UpdateApplyKind;
    checkLatest(): Promise<UpdateManifest | null>;
    apply(): Promise<void>;
    onProgress(handler: (fraction: number) => void): () => void;
  };
  menu: {
    /** True when the host owns a native application menu (desktop shell). */
    supported(): boolean;
    /** Replace the native menu with this template (no-op on the web). */
    set(template: MenuTemplateNode[]): void;
    /** Subscribe to native menu-item command clicks (no-op on the web). */
    onCommand(handler: (command: string) => void): () => void;
  };
  deepLink: {
    /** Links handed in by the OS (`<ns>://…`, desktop); never fires on the web. */
    onOpen(handler: (url: string) => void): () => void;
  };
}

/**
 * The platform for one host. The app makes it ONCE (`editor/platform.ts`) from
 * who it is — its store namespace, its desktop global, its version — and every
 * caller uses that one instance.
 */
export function createPlatform(host: HostIdentity): Platform {
  const adapter: PlatformAdapter = createWebAdapter(host);
  return {
    fs: {
      open: (opts) => adapter.fs.open(opts),
      save: (opts) => adapter.fs.save(opts),
    },
    fileDrop: {
      on: (handler) => adapter.fileDrop.on(handler),
    },
    clipboard: {
      readFiles: () => adapter.clipboard.readFiles(),
    },
    folder: {
      canLink: () => adapter.folder.canLink(),
      pick: () => adapter.folder.pick(),
      scan: (ref) => adapter.folder.scan(ref),
      ensureAccess: (ref) => adapter.folder.ensureAccess(ref),
      watch: (ref, onChange) => adapter.folder.watch(ref, onChange),
      forget: (ref) => adapter.folder.forget(ref),
    },
    net: {
      fetchFont: (spec) => adapter.net.fetchFont(spec),
    },
    fonts: {
      supported: () => adapter.fonts.supported(),
      querySystem: () => adapter.fonts.querySystem(),
    },
    app: {
      kind: platformKind(host),
      os: osKind(),
      isDesktop: isDesktop(host),
      version: () => adapter.app.version(),
    },
    update: {
      get current() {
        return adapter.update.current;
      },
      get applyKind() {
        return adapter.update.applyKind;
      },
      checkLatest: () => adapter.update.checkLatest(),
      apply: () => adapter.update.apply(),
      onProgress: (handler) => adapter.update.onProgress(handler),
    },
    menu: {
      supported: () => adapter.menu.supported(),
      set: (template) => adapter.menu.set(template),
      onCommand: (handler) => adapter.menu.onCommand(handler),
    },
    deepLink: {
      onOpen: (handler) => adapter.deepLink.onOpen(handler),
    },
  };
}

/** Boot the platform layer: install console capture (feeds the in-app Console). */
export function initPlatform(): void {
  installConsoleCapture();
}
