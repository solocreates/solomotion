const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, protocol, net, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL, fileURLToPath } = require("node:url");

// Who this shell is (products/<id>/desktop/product.json, stamped at build).
const { product } = require("./product");

// Public repo that hosts the installers + electron-updater manifests
// (latest-*.yml). The same repo electron-builder.cjs publishes to.
const RELEASES_REPO = product.releasesRepo;

// Dev: the orchestrator sets this to the Next dev server. Prod: unset, and we
// resolve a start URL (remote-first, see below) at launch.
const DEV_URL = process.env.ELECTRON_START_URL;

// Remote-first core delivery: the shell is a thin native wrapper; the product IS
// the web app, which already ships to Cloudflare on every release. So we load
// the LIVE deploy — core updates land instantly, no reinstall. Its offline
// worker (ADR-offline) keeps every file of the last build it saw, so the remote
// origin keeps working when the network drops mid-session AND opens offline —
// on the same origin, so the same projects. The bundled snapshot is only for a
// machine that has never reached the deploy. A new binary is then only needed
// for native-shell changes or to refresh that snapshot.
const REMOTE_URL = process.env.DESKTOP_REMOTE_URL || product.remoteUrl;
const LOCAL_URL = "app://local/";
// Milliseconds to wait for the remote to answer before falling back offline.
const REMOTE_PROBE_MS = 2500;

// The exported web bundle: bundled as a resource when packaged, read from the
// web workspace when running unpackaged.
const OUT_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "web-out")
  : path.join(__dirname, "..", "..", "web", "out");

// A standard, secure custom scheme gives the static export a real origin —
// file:// would break Next's absolute /_next/* asset paths.
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// ── <scheme>:// deep links (ADR-links) ────────────────────────────────────────
// `<scheme>://project/<id>/<page-slug>?at=…` is the web app's address with the
// scheme swapped, so the renderer reads it with the same grammar. The OS hands
// it to us three ways: `open-url` (macOS), a second launch's argv (Windows,
// Linux) and the first launch's own argv. One window, one instance: a second
// launch forwards its link here and quits.
const SCHEME = product.scheme;
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient(SCHEME, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(SCHEME);
}
if (!app.requestSingleInstanceLock()) app.quit();

/** A link that arrived before the renderer listened (the one that launched us). */
let pendingDeepLink = null;
/** The renderer has subscribed since its last (re)load. */
let deepLinkReady = false;

function deepLinkIn(argv) {
  return argv.find((a) => typeof a === "string" && a.startsWith(`${SCHEME}://`)) ?? null;
}

function deliverDeepLink(url) {
  if (!url) return;
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
  if (win && deepLinkReady) win.webContents.send("deeplink:open", url);
  else pendingDeepLink = url;
}

pendingDeepLink = deepLinkIn(process.argv);
app.on("open-url", (event, url) => {
  event.preventDefault();
  deliverDeepLink(url);
});
app.on("second-instance", (_event, argv) => deliverDeepLink(deepLinkIn(argv)));
ipcMain.handle("deeplink:take", () => {
  deepLinkReady = true;
  const url = pendingDeepLink;
  pendingDeepLink = null;
  return url;
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#131316",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      // The sandboxed preload cannot require product.js; it names its global from this.
      additionalArguments: [`--studio-ns=${product.scheme}`],
    },
  });

  // External links open in the OS (browser, mail, phone), never inside the
  // app window — a `mailto:` allowed through would open a blank window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto|tel):/i.test(url)) {
      void shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
  // A reload drops the renderer's subscription; links wait until it is back.
  win.webContents.on("did-start-loading", () => {
    deepLinkReady = false;
  });

  // If a remote load fails mid-flight (server down, connection dropped after the
  // probe passed), heal to the bundled snapshot so the app always opens.
  win.webContents.on("did-fail-load", (_e, errorCode, _desc, validatedURL, isMainFrame) => {
    // -3 is ERR_ABORTED (navigation superseded) — not a real failure.
    if (!isMainFrame || errorCode === -3) return;
    if (!DEV_URL && validatedURL !== LOCAL_URL) void win.loadURL(LOCAL_URL);
  });

  void resolveStartUrl().then((url) => win.loadURL(url));
}

/**
 * Probe the live deploy quickly; return true if it answers. Uses the app's own
 * `/api/version` beacon so we only commit to remote when the real app is up.
 */
function remoteReachable() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), REMOTE_PROBE_MS);
    try {
      const req = net.request(new URL("api/version", REMOTE_URL).toString());
      req.on("response", (res) => {
        clearTimeout(timer);
        done(res.statusCode >= 200 && res.statusCode < 400);
      });
      req.on("error", () => {
        clearTimeout(timer);
        done(false);
      });
      req.end();
    } catch {
      clearTimeout(timer);
      done(false);
    }
  });
}

/**
 * Has the deploy's offline worker been installed in this session? Then the
 * remote origin opens with or without a network: the worker answers the page
 * network-first and falls back to its own copy. Rejects when nothing is
 * registered for the scope; bounded so a wedged worker cannot stall launch.
 */
function remoteWorksOffline() {
  return Promise.race([
    session.defaultSession.serviceWorkers.startWorkerForScope(REMOTE_URL).then(
      () => true,
      () => false,
    ),
    new Promise((resolve) => setTimeout(() => resolve(false), REMOTE_PROBE_MS)),
  ]);
}

/** Decide where to boot: dev server → live remote (online, or kept by its worker) → bundled snapshot. */
async function resolveStartUrl() {
  if (DEV_URL) return DEV_URL;
  if (await remoteWorksOffline()) return REMOTE_URL;
  if (!net.isOnline()) return LOCAL_URL;
  return (await remoteReachable()) ? REMOTE_URL : LOCAL_URL;
}

/**
 * Native binary updates (the "whole app" update), surfaced to the renderer
 * through the SAME UpdatePort as web updates. electron-updater reads the
 * latest-*.yml manifests published beside the installers in RELEASES_REPO.
 *
 * We drive it manually (autoDownload off): check on demand, download only when
 * the user accepts, relaunch when it lands. Core/web updates never come through
 * here — the shell already loads those remote-first.
 */
function setupAutoUpdater() {
  // Synchronous: the preload bridge reads this at exposure time so the web
  // adapter's `current` getter resolves eagerly. MUST be registered before any
  // window's preload evaluates (we call setup before createWindow).
  ipcMain.on("update:current", (event) => {
    event.returnValue = app.getVersion();
  });

  // Only packaged builds carry a real update feed (app-update.yml); dev/unpacked
  // runs report "no update" rather than crashing electron-updater.
  const canUpdate = () => app.isPackaged && !DEV_URL;

  let autoUpdater = null;
  function updater() {
    if (autoUpdater) return autoUpdater;
    ({ autoUpdater } = require("electron-updater"));
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("download-progress", (p) => {
      const fraction = (p.percent ?? 0) / 100;
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send("update:progress", fraction);
      }
    });
    // Relaunch into the freshly downloaded installer once it's staged.
    autoUpdater.on("update-downloaded", () => autoUpdater.quitAndInstall());
    return autoUpdater;
  }

  ipcMain.handle("update:check", async () => {
    if (!canUpdate()) return null;
    try {
      const result = await updater().checkForUpdates();
      const info = result?.updateInfo;
      if (!info?.version) return null;
      // Return the latest known release; the renderer decides if it's newer.
      return {
        version: info.version,
        notes: typeof info.releaseNotes === "string" ? info.releaseNotes : undefined,
        notesUrl: `https://github.com/${RELEASES_REPO}/releases/tag/v${info.version}`,
        publishedAt: info.releaseDate,
      };
    } catch {
      return null; // offline / rate-limited / no feed → stay silent
    }
  });

  ipcMain.handle("update:install", async () => {
    if (!canUpdate()) return;
    try {
      // Kicks off the download; 'update-downloaded' then relaunches the app.
      await updater().downloadUpdate();
    } catch {
      /* renderer falls back to the "available" state; user can retry */
    }
  });
}

/**
 * The native application menu, built from the renderer's headless menu spec.
 * The renderer owns the whole tree (labels, order, checkbox state) and pushes it
 * over `menu:set`; here we only translate that serializable template into a real
 * Electron menu and route item clicks back as command ids. So the in-window menu
 * and the OS menu are literally the same source — change one, both change.
 *
 * Accelerators are deliberately NOT registered here: the web app owns a
 * focus-aware shortcut registry (a copy in the timeline differs from one on the
 * canvas), and a native menu accelerator would swallow the key before the
 * renderer's context-aware handler could run. The in-window menu shows the
 * shortcut hints; the native menu is click-to-run.
 */
function buildMenuNodes(nodes) {
  return nodes.map((n) => {
    if (n.type === "separator") return { type: "separator" };
    const item = {};
    if (n.label) item.label = n.label;
    if (n.role) item.role = n.role;
    if (n.type) item.type = n.type;
    if (typeof n.checked === "boolean") item.checked = n.checked;
    if (typeof n.enabled === "boolean") item.enabled = n.enabled;
    if (n.command) {
      const command = n.command;
      item.click = (_menuItem, win) => {
        const target = win || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
        target?.webContents.send("menu:command", command);
      };
    }
    if (Array.isArray(n.submenu)) item.submenu = buildMenuNodes(n.submenu);
    return item;
  });
}

function setupAppMenu() {
  // A minimal branded bootstrap so the very first paint never shows Electron's
  // stock "Electron"/devtools menu; the renderer replaces it with the full spec
  // the instant the editor mounts.
  const bootstrap = [{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }];
  Menu.setApplicationMenu(Menu.buildFromTemplate(bootstrap));

  ipcMain.on("menu:set", (_e, template) => {
    if (!Array.isArray(template) || template.length === 0) return;
    try {
      Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuNodes(template)));
    } catch {
      /* a malformed template should never crash the shell — keep the last menu */
    }
  });
}

// Largest OS-file we'll pull off the clipboard in one paste — a guard so a
// stray copy of a giant file can't stall the main process reading it.
const MAX_CLIPBOARD_FILE_BYTES = 1024 * 1024 * 1024; // 1 GB

const EXT_MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  gif: "image/gif", svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/x-m4v",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
  aac: "audio/aac", flac: "audio/flac",
};
function mimeForPath(p) {
  return EXT_MIME[path.extname(p).slice(1).toLowerCase()] || undefined;
}
function looksImportable(name) {
  return EXT_MIME[path.extname(name).slice(1).toLowerCase()] !== undefined;
}

/**
 * The absolute paths of files sitting on the OS clipboard after a Finder /
 * Explorer / file-manager "Copy". Every platform advertises these differently,
 * so we probe each known format and dedupe. Best-effort: any format that isn't
 * present is simply skipped.
 */
function clipboardFilePaths() {
  const paths = [];
  const seen = new Set();
  const add = (p) => {
    const clean = (p || "").trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      paths.push(clean);
    }
  };
  const fromFileUrl = (u) => {
    try {
      return u.startsWith("file:") ? fileURLToPath(u.trim()) : u.trim();
    } catch {
      return null;
    }
  };
  try {
    if (process.platform === "darwin") {
      // A Finder copy exposes a single file URL, and (for multi-select) an
      // NSFilenamesPboardType XML plist listing every path.
      add(fromFileUrl(clipboard.read("public.file-url")));
      const buf = clipboard.readBuffer("NSFilenamesPboardType");
      if (buf && buf.length) {
        const xml = buf.toString("utf8");
        for (const m of xml.matchAll(/<string>([^<]*)<\/string>/g)) add(m[1]);
      }
    } else if (process.platform === "win32") {
      // CF_HDROP, surfaced as UTF-16LE, NUL-separated, double-NUL terminated.
      const buf = clipboard.readBuffer("FileNameW");
      if (buf && buf.length) buf.toString("ucs2").split("\0").forEach(add);
    }
    // Linux (and a cross-platform fallback): a uri-list of file:// entries.
    const uriList = clipboard.read("text/uri-list");
    if (uriList) {
      uriList
        .split(/\r?\n/)
        .filter((l) => l && !l.startsWith("#"))
        .forEach((u) => add(fromFileUrl(u)));
    }
  } catch {
    /* best-effort — return whatever we managed to gather */
  }
  return paths;
}

/**
 * Read the bytes of every file copied to the OS clipboard, so the renderer's
 * ClipboardPort can hand them to the same import pipeline a drop uses. Images
 * copied as raw bitmaps (screenshots) are NOT handled here — the renderer's
 * Clipboard API reads those uniformly across hosts; this is only for real files.
 */
function setupClipboardBridge() {
  ipcMain.handle("clipboard:read-files", async () => {
    const out = [];
    for (const p of clipboardFilePaths()) {
      try {
        const stat = await fs.promises.stat(p);
        if (!stat.isFile() || stat.size > MAX_CLIPBOARD_FILE_BYTES) continue;
        const buf = await fs.promises.readFile(p);
        // Slice out an exact ArrayBuffer view so the structured clone across IPC
        // carries only this file's bytes, not the whole pool buffer.
        out.push({
          name: path.basename(p),
          path: p,
          mime: mimeForPath(p),
          bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        });
      } catch {
        /* unreadable / vanished — skip it */
      }
    }
    return out;
  });
}

/**
 * Native linked-folder bridge: pick a real directory, scan it (metadata only —
 * bytes are pulled lazily so a sync reads only what it imports), and watch it
 * for changes. Change events are debounced and broadcast to every window; the
 * renderer's FolderPort filters by the watched ref id.
 */
function setupFolderBridge() {
  const watchers = new Map(); // id → { watcher, timer }

  const walk = async (root, rel, out) => {
    let entries;
    try {
      entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith(".")) continue; // skip dotfiles / .DS_Store
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        await walk(root, childRel, out);
      } else if (ent.isFile() && looksImportable(ent.name)) {
        try {
          const st = await fs.promises.stat(path.join(root, childRel));
          out.push({
            relPath: childRel,
            name: ent.name,
            mime: mimeForPath(ent.name),
            mtimeMs: st.mtimeMs,
            size: st.size,
          });
        } catch {
          /* vanished mid-scan — skip */
        }
      }
    }
  };

  ipcMain.handle("folder:pick", async () => {
    const res = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    const dir = res.canceled ? null : res.filePaths[0];
    return dir ? { id: dir, name: path.basename(dir), path: dir } : null;
  });

  ipcMain.handle("folder:scan", async (_e, dir) => {
    const out = [];
    await walk(dir, "", out);
    return out;
  });

  ipcMain.handle("folder:read", async (_e, dir, relPath) => {
    // Contain reads to inside the linked root (defence against a crafted relPath).
    const abs = path.resolve(dir, relPath);
    if (abs !== dir && !abs.startsWith(dir + path.sep)) throw new Error("out of bounds");
    const buf = await fs.promises.readFile(abs);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });

  ipcMain.on("folder:watch", (_e, id, dir) => {
    if (watchers.has(id)) return;
    let timer = null;
    try {
      const watcher = fs.watch(dir, { recursive: true }, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          for (const w of BrowserWindow.getAllWindows()) w.webContents.send("folder:changed", id);
        }, 300);
      });
      watchers.set(id, { watcher, timer: () => timer });
    } catch {
      /* platform without recursive watch — sync stays manual/on-focus */
    }
  });

  ipcMain.on("folder:unwatch", (_e, id) => {
    const w = watchers.get(id);
    if (w) {
      try {
        w.watcher.close();
      } catch {
        /* already closed */
      }
      watchers.delete(id);
    }
  });
}

app.whenReady().then(() => {
  // Trusted first-party content: grant permission requests (notably `local-fonts`,
  // which powers system-font enumeration) instead of silently denying them.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(true));
  session.defaultSession.setPermissionCheckHandler(() => true);

  // Register update IPC before the first window so the preload's synchronous
  // `update:current` read resolves.
  setupAutoUpdater();
  setupAppMenu();
  setupClipboardBridge();
  setupFolderBridge();

  if (!DEV_URL) {
    protocol.handle("app", (request) => {
      const { pathname } = new URL(request.url);
      const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
      return net.fetch(pathToFileURL(path.join(OUT_DIR, rel)).toString());
    });
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
