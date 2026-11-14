import { identity } from "@/editor/identity";
import ENGINES from "./engines.json";
import { NAMES } from "@/editor/names";

/**
 * LAZY ENGINES — the heavy parts the app downloads the first time a feature
 * needs them and never bundles: the depth networks today, any model after.
 *
 * WHERE. `engines.json` is the one list; this file turns it into URLs. In
 * production they are on our models origin (the product's models host,
 * uploaded by `pnpm models:publish`); in dev, `/models` (apps/web/public,
 * git-ignored, the same layout). NEXT_PUBLIC_MODELS_BASE overrides both.
 *
 * KEPT. Every file goes through ONE cache that belongs to the ENGINES, not to
 * the app: `<ns>-keep:engines`. The offline worker and the dev cleanup
 * leave the `<ns>-keep:` namespace alone (they used to wipe any
 * `<ns>-*` cache they did not own on every new build — 130 MB re-downloaded
 * per app update). An app update never touches it; a new ENGINE does, because
 * its URL is new (a version prefix, the runtime's version), and the entries no
 * current URL names are pruned. So: downloaded once per engine version, then
 * offline for good — on the web and in the desktop app alike.
 */

export const ENGINE_BASE = (process.env.NEXT_PUBLIC_MODELS_BASE ?? (process.env.NODE_ENV === "development" ? "/models" : identity.hosts.models)).replace(/\/$/, "");

/** The runtime's files, pinned to the installed onnxruntime-web (next.config derives the version). */
export const RUNTIME_FILES = ENGINES.runtime.files.map((f) => `${ENGINE_BASE}/ort/${process.env.NEXT_PUBLIC_ORT_VERSION}/${f}`) as [string, string, string];

const at = (p: string) => `${ENGINE_BASE}/${p}`;

/** The depth networks — see `tracking/depth-models.ts` for which runs where. */
export const DEPTH_FILES = {
  video: ENGINES.depth.video.map(at) as [string, string],
  stillGpu: { graph: at(ENGINES.depth.stillGpu.graph), data: at(ENGINES.depth.stillGpu.data), dataPath: ENGINES.depth.stillGpu.dataPath },
  stillCpu: at(ENGINES.depth.stillCpu),
};

/** Every URL a current engine may ask for — what the cache keeps. */
const CURRENT = [...RUNTIME_FILES, ...DEPTH_FILES.video, DEPTH_FILES.stillGpu.graph, DEPTH_FILES.stillGpu.data, DEPTH_FILES.stillCpu];

/** The engines' own cache. `<ns>-keep:` is the namespace the offline worker never prunes. */
export const ENGINE_CACHE = NAMES.caches.engines;

const absolute = (u: string) => new URL(u, self.location.href).href;

async function openCache(): Promise<Cache | null> {
  return typeof caches !== "undefined" ? caches.open(ENGINE_CACHE).catch(() => null) : null;
}

let pruned = false;
/** Drop what no current engine names (an old runtime, an old export) — once per thread. */
async function prune(cache: Cache): Promise<void> {
  if (pruned) return;
  pruned = true;
  const keep = new Set(CURRENT.map(absolute));
  for (const req of await cache.keys()) if (!keep.has(req.url)) await cache.delete(req);
  // The cache before it had a namespace of its own: the offline worker pruned it anyway.
  if (typeof caches !== "undefined") await caches.delete(NAMES.caches.legacyModels).catch(() => false);
}

/** Which of these files this device already has — what a first run will download. */
export async function enginesCached(urls: readonly string[]): Promise<boolean> {
  const cache = await openCache();
  if (!cache) return false;
  for (const u of urls) if (!(await cache.match(u))) return false;
  return true;
}

/** Whether this device can run depth without a download (the runtime and one of the depth paths are cached). */
export async function depthEngineCached(): Promise<boolean> {
  if (!(await enginesCached(RUNTIME_FILES))) return false;
  const d = DEPTH_FILES;
  return (await enginesCached(d.video)) || (await enginesCached([d.stillGpu.graph, d.stillGpu.data])) || enginesCached([d.stillCpu]);
}

/**
 * An engine file's bytes: the cache, else the network with progress (then
 * cached under its own URL). A file too big for one upload to the models
 * origin is hosted as parts beside a `<file>.parts` count
 * (`scripts/models/publish.mjs`); its whole URL answers 404 and the parts are
 * fetched in order instead — nothing here declares which files are split.
 */
export async function engineBytes(url: string, onProgress: (fraction: number) => void): Promise<ArrayBuffer> {
  const cache = await openCache();
  if (cache) await prune(cache).catch(() => {});
  const hit = cache ? await cache.match(url) : undefined;
  if (hit) return hit.arrayBuffer();
  const failed = (status: number) => Object.assign(new Error(`An engine file could not be downloaded (${status}).`), { name: status === 404 ? "MissingError" : "NetworkError" });
  const res = await fetch(url);
  let chunks: Uint8Array[];
  if (res.ok) chunks = await readAll(res, onProgress);
  else if (res.status === 404) {
    const count = await fetch(`${url}.parts`);
    const n = count.ok ? Number((await count.text()).trim()) : 0;
    if (!(n > 0)) throw failed(404);
    chunks = [];
    for (let i = 0; i < n; i++) {
      const part = await fetch(`${url}.part${i}`);
      if (!part.ok) throw failed(part.status);
      chunks.push(...(await readAll(part, (f) => onProgress((i + f) / n))));
    }
  } else throw failed(res.status);
  const bytes = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let o = 0;
  for (const c of chunks) bytes.set(c, (o += c.length) - c.length);
  if (cache) await cache.put(url, new Response(bytes, { headers: { "content-type": "application/octet-stream" } })).catch(() => {});
  return bytes.buffer;
}

/** A response's body as chunks, reporting how much has arrived. */
async function readAll(res: Response, onProgress: (fraction: number) => void): Promise<Uint8Array[]> {
  if (!res.body) return [new Uint8Array(await res.arrayBuffer())];
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const out: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
    got += value.length;
    if (total) onProgress(got / total);
  }
  return out;
}
