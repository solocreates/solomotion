// The offline worker (docs/adr/ADR-offline.md).
//
// A session that has loaded once keeps EVERY feature when the network drops:
// the build's whole offline manifest (scripts/offline-manifest.mjs) is
// precached at install, so an effect family, a panel or an engine nobody has
// opened yet still arrives from disk.
//
// WHY THIS CANNOT BE THE STALE WORKER OF OLD. The bug this file used to exist
// for was a worker serving chunks that did not belong to the page. Here the
// cache is CONTENT-ADDRESSED: /_next/static URLs carry their content hash, so
// a hit is byte-for-byte the file that URL names, whichever build asks. The
// only non-hashed answer is the page itself, and that is network-first — a
// copy answers only when the network cannot, and the copy is the shell of a
// build whose every chunk is already here (it is stored last, after them).
//
// TWO MODES, ONE URL.
//   /sw.js?build=<id>  registered by the editor (editor/runtime/offline.ts).
//   /sw.js             any other registration at this URL — a ghost from some
//                      other project once served on this origin. It wipes
//                      its caches, unregisters and reloads its tabs, exactly
//                      what the kill-switch always did.

const PARAMS = new URL(self.location.href).searchParams;
const BUILD = PARAMS.get("build");
// The app's data namespace (editor/names.ts): every cache this worker owns is
// named from it, so each product's caches are its own and never renamed.
const NS = PARAMS.get("ns");
// A registration from before the worker was told its namespace (an older
// build's `/sw.js?build=…`, re-checked by the browser) cannot tell which caches
// are its own, so it touches none: it installs, serves nothing, and waits for
// the page to register its successor. Never a self-destruct — that would sweep
// the kept engines.
const INERT = !NS;

const STATIC = `${NS}-static-v1`; // /_next/static/**, keyed by URL (= by content)
const SHELL = `${NS}-shell-v1`; // the page shell "/" + public files
const META = `${NS}-meta-v1`; // the manifests of the builds kept
const OURS = [STATIC, SHELL, META];
/**
 * Caches that belong to a FEATURE, versioned by their own content, never by a
 * build: the lazy engines' downloads (`editor/engines/files.ts`). Pruning
 * them per build re-downloaded ~130 MB of depth model on every app update.
 */
const KEEP_PREFIX = `${NS}-keep:`;
const BUILDS_KEY = `/__${NS}/builds`;
/** A tab of the previous build may still be open: its chunks stay one more build. */
const KEEP_BUILDS = 2;
/** A page the network has not answered by then is served from the copy (if any). */
const PAGE_TIMEOUT_MS = 4000;
/** Precache fetches in flight at once. */
const PARALLEL = 6;
/**
 * A /_next/static file worth keeping when it arrives outside a precache: it
 * carries a content hash (16 hex) or this build's id. Dev-server files carry
 * neither, so a production worker left on localhost never pins a dev chunk.
 */
const HASHED = /[/.-][0-9a-f]{16}[.-]/;

// ── kill-switch mode ─────────────────────────────────────────────────────────
async function selfDestruct() {
  try {
    for (const k of await caches.keys()) if (!k.startsWith(KEEP_PREFIX)) await caches.delete(k);
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: "window" })) client.navigate(client.url);
  } catch {
    // Best-effort cleanup; ignore failures.
  }
}

// ── builds we keep ──────────────────────────────────────────────────────────
/** @returns {Promise<{ build: string, immutable: string[], shell: string[] }[]>} oldest → newest */
async function readBuilds() {
  const res = await (await caches.open(META)).match(BUILDS_KEY);
  return res ? res.json() : [];
}

async function writeBuilds(builds) {
  await (await caches.open(META)).put(BUILDS_KEY, new Response(JSON.stringify(builds), { headers: { "content-type": "application/json" } }));
}

async function pool(items, n, fn) {
  let i = 0;
  const lane = async () => {
    while (i < items.length) await fn(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, lane));
}

async function fetchOk(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res;
}

/**
 * Bring this build's files in. Incremental — a file already held under its
 * hash is not fetched again, so an update costs only what changed — and
 * atomic where it matters: any failure fails the install (the previous worker
 * keeps serving), and the shell is written last.
 */
async function precache() {
  const manifest = await (await fetchOk(`/_next/static/${BUILD}/offline-manifest.json`, { cache: "no-cache" })).json();
  const stat = await caches.open(STATIC);
  const held = new Set((await stat.keys()).map((r) => new URL(r.url).pathname));
  await pool(
    manifest.immutable.filter((p) => !held.has(p)),
    PARALLEL,
    async (p) => stat.put(p, await fetchOk(p)),
  );
  const shell = await caches.open(SHELL);
  await pool(manifest.shell, PARALLEL, async (p) => shell.put(p, await fetchOk(p, { cache: "no-cache" })));
  await shell.put("/", await fetchOk("/", { cache: "no-cache" }));
  const builds = (await readBuilds()).filter((b) => b.build !== BUILD);
  builds.push({ build: BUILD, immutable: manifest.immutable, shell: manifest.shell });
  await writeBuilds(builds);
}

/** Drop what no kept build names, and any cache of ours from an older layout. */
async function prune() {
  const builds = (await readBuilds()).slice(-KEEP_BUILDS);
  await writeBuilds(builds);
  const keep = new Set(builds.flatMap((b) => b.immutable));
  const stat = await caches.open(STATIC);
  for (const req of await stat.keys()) if (!keep.has(new URL(req.url).pathname)) await stat.delete(req);
  const current = builds[builds.length - 1];
  const shellKeep = new Set(["/", ...(current ? current.shell : [])]);
  const shell = await caches.open(SHELL);
  for (const req of await shell.keys()) if (!shellKeep.has(new URL(req.url).pathname)) await shell.delete(req);
  for (const k of await caches.keys()) if (k.startsWith(`${NS}-`) && !k.startsWith(KEEP_PREFIX) && !OURS.includes(k)) await caches.delete(k);
}

async function announce(target) {
  const msg = { type: `${NS}:offline`, builds: (await readBuilds()).map((b) => b.build) };
  const clients = target ? [target] : await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const c of clients) c.postMessage(msg);
}

// ── lifecycle ────────────────────────────────────────────────────────────────
self.addEventListener("install", (event) => {
  // The fetch handler is build-agnostic (content-addressed), so a new worker
  // can take over open tabs at once: it serves an older tab correctly too.
  event.waitUntil(BUILD && !INERT ? precache().then(() => self.skipWaiting()) : self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  if (INERT) return;
  event.waitUntil(BUILD ? prune().then(() => self.clients.claim()).then(() => announce()) : selfDestruct());
});

self.addEventListener("message", (event) => {
  if (BUILD && !INERT && event.data && event.data.type === `${NS}:offline?`) event.waitUntil(announce(event.source));
});

// ── serving ──────────────────────────────────────────────────────────────────
/**
 * A worker's own URL is the URL of the response that started it. Turbopack
 * hands a worker its chunk list in that URL's fragment (`#params=`), which a
 * fetch event never sees: a cached or re-fetched response carries the URL
 * without it, and the worker starts with nothing to load ("Missing worker
 * bootstrap config"). A constructed Response has no URL, so the browser keeps
 * the one the page asked for — fragment and all.
 */
const asRequested = (event, res) => (event.request.destination.endsWith("worker") ? new Response(res.body, res) : res);

/** Content-addressed: the copy IS the file. Arrivals outside a precache are kept too. */
async function staticFile(event, url) {
  const hit = await caches.match(event.request, { cacheName: STATIC });
  if (hit) return asRequested(event, hit);
  const res = await fetch(event.request);
  if (res.ok && (HASHED.test(url.pathname) || url.pathname.startsWith(`/_next/static/${BUILD}/`)) && !url.pathname.includes("hot-update")) {
    const copy = res.clone();
    event.waitUntil(caches.open(STATIC).then((c) => c.put(event.request, copy)));
  }
  return asRequested(event, res);
}

/**
 * Network first. The copy — the shell of the newest fully-precached build —
 * answers when the network fails, or is slower than PAGE_TIMEOUT_MS. Every
 * route renders the same shell (the editor lives in the root layout and reads
 * its place from the address), so one copy serves `/` and every project URL.
 */
function page(event) {
  const network = fetch(event.request);
  const copy = () => caches.match("/", { cacheName: SHELL });
  return new Promise((resolve) => {
    let done = false;
    const settle = (res) => {
      if (done || !res) return;
      done = true;
      resolve(res);
    };
    const timer = setTimeout(() => void copy().then(settle), PAGE_TIMEOUT_MS);
    network.then(
      (res) => {
        clearTimeout(timer);
        settle(res);
      },
      () => {
        clearTimeout(timer);
        void copy().then((res) => settle(res || Response.error()));
      },
    );
  });
}

/** Public files: fresh when online, the build's copy when not. */
async function shellFile(event) {
  try {
    return await fetch(event.request);
  } catch (e) {
    const hit = await caches.match(event.request, { cacheName: SHELL });
    if (hit) return hit;
    throw e;
  }
}

self.addEventListener("fetch", (event) => {
  if (!BUILD || INERT) return;
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (req.mode === "navigate") event.respondWith(page(event));
  else if (url.pathname.startsWith("/_next/static/")) event.respondWith(staticFile(event, url));
  else if (!url.search) event.respondWith(shellFile(event));
});
