const { contextBridge, ipcRenderer } = require("electron");

// Flag the host so @solomotion/platform's isDesktop() lights up (and so
// use-url-sync skips address-bar reflection). Kept intentionally tiny — the app
// runs on standard web APIs in the Chromium renderer; richer native power (real
// file paths, native menus, main-process font fetch) is added here behind the
// platform bridge, not sprinkled through the app.
//
// `update` is the native binary-updater bridge the web adapter's UpdatePort
// looks for (packages/platform/src/adapters/web.ts → nativeUpdate). When
// present it flips the app's "update" semantics from "reload" to "install":
// main-process electron-updater checks GitHub releases, downloads, and
// relaunches into the new binary. Core (web) updates are separate — the shell
// loads them remote-first, so they never route through here.
// The global is `__<NS>_DESKTOP__` (apps/web/src/editor/names.ts), from the
// product's namespace that main.js passes in.
const ns = process.argv.find((a) => a.startsWith("--studio-ns="))?.slice("--studio-ns=".length);
if (!ns) throw new Error("preload: --studio-ns is missing");
contextBridge.exposeInMainWorld(`__${ns.toUpperCase()}_DESKTOP__`, {
  platform: process.platform,
  // Native clipboard reach the browser can't have: the bytes of OS file copies
  // (Finder / Explorer "Copy"). The renderer's ClipboardPort merges this with its
  // own image-blob reads so ⌘V imports anything the OS put on the clipboard.
  clipboard: {
    /** Read files copied from the OS file manager. Resolves [] when there are none. */
    readFiles: () => ipcRenderer.invoke("clipboard:read-files"),
  },
  // Linked-folder bridge: pick / scan (metadata) / lazily read / watch a real
  // directory, so the media library can mirror an on-disk folder and live-sync.
  folder: {
    pick: () => ipcRenderer.invoke("folder:pick"),
    scan: (dir) => ipcRenderer.invoke("folder:scan", dir),
    read: (dir, relPath) => ipcRenderer.invoke("folder:read", dir, relPath),
    watch: (id, dir) => ipcRenderer.send("folder:watch", id, dir),
    unwatch: (id) => ipcRenderer.send("folder:unwatch", id),
    onChange: (handler) => {
      const listener = (_e, id) => handler(id);
      ipcRenderer.on("folder:changed", listener);
      return () => ipcRenderer.removeListener("folder:changed", listener);
    },
  },
  // Native application menu, driven entirely by the renderer's headless menu
  // spec: the app pushes a serializable template and the main process builds the
  // real OS menu from it, routing item clicks back as command ids. This is how
  // the in-window menu and the native macOS menu stay one and the same.
  menu: {
    set: (template) => ipcRenderer.send("menu:set", template),
    onCommand: (handler) => {
      const listener = (_e, command) => handler(command);
      ipcRenderer.on("menu:command", listener);
      return () => ipcRenderer.removeListener("menu:command", listener);
    },
  },
  // <scheme>:// links handed in by the OS. The link that launched the app (or
  // arrived during a reload) is held by the main process and delivered on
  // subscribe; later ones arrive as they come.
  deepLink: {
    onOpen: (handler) => {
      const listener = (_e, url) => handler(url);
      ipcRenderer.on("deeplink:open", listener);
      void ipcRenderer.invoke("deeplink:take").then((url) => url && handler(url));
      return () => ipcRenderer.removeListener("deeplink:open", listener);
    },
  },
  update: {
    // Synchronous so the web adapter's `current` getter can read it eagerly.
    current: ipcRenderer.sendSync("update:current"),
    /** Ask the main process to check GitHub for a newer installer. */
    check: () => ipcRenderer.invoke("update:check"),
    /** Download the pending update; the app relaunches into it when ready. */
    install: () => ipcRenderer.invoke("update:install"),
    /** Subscribe to download progress (0‥1). Returns an unsubscribe fn. */
    onProgress: (handler) => {
      const listener = (_event, fraction) => handler(fraction);
      ipcRenderer.on("update:progress", listener);
      return () => ipcRenderer.removeListener("update:progress", listener);
    },
  },
});
