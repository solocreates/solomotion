/**
 * The build's OFFLINE MANIFEST — every file the editor can ever ask its own
 * origin for, written after `next build` (the package's `build` script, which
 * OpenNext runs before it copies `.next/static` and `public/` into the
 * Worker's assets).
 *
 * The offline worker (public/sw.js, ADR-offline) precaches exactly this list,
 * so a session keeps every lazy chunk — an effect family, a panel, the 3D
 * engine — when the network drops, without ever having loaded it:
 *
 *   immutable  /_next/static/**: content-hashed, so cache-first can never be
 *              stale. Lives at `/_next/static/<build>/offline-manifest.json`,
 *              beside Next's own per-build manifests.
 *   shell      public/** files (icons, manifest, template sounds): same URL
 *              across builds, so the worker refreshes them per build.
 *
 * Reading the disk rather than hooking the bundler is deliberate: it sees
 * exactly what ships, whichever bundler wrote it.
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextDir = path.join(webRoot, ".next");
const staticDir = path.join(nextDir, "static");
const publicDir = path.join(webRoot, "public");
const NAME = "offline-manifest.json";
const PRODUCT_ROUTES = ["/favicon.svg", "/icon-maskable.svg", "/apple-touch-icon.svg", "/manifest.webmanifest"];

/** Files the worker must never precache: itself, host config, source maps, a dev's local ML weights. */
const SKIP = (rel) => rel === "sw.js" || rel.startsWith("_") || rel.startsWith("models/") || rel.endsWith(".map") || rel.split("/").some((s) => s.startsWith("."));

async function walk(root, rel = "", out = []) {
  for (const ent of await readdir(path.join(root, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) await walk(root, child, out);
    else if (ent.isFile() && !SKIP(child) && ent.name !== NAME) out.push(child);
  }
  return out;
}

async function bytesOf(root, files) {
  let n = 0;
  for (const f of files) n += (await stat(path.join(root, f))).size;
  return n;
}

const build = (await readFile(path.join(nextDir, "BUILD_ID"), "utf8")).trim();
const statics = (await walk(staticDir)).sort();
const publics = (await walk(publicDir)).sort();
const bytes = (await bytesOf(staticDir, statics)) + (await bytesOf(publicDir, publics));

const manifest = {
  build,
  bytes,
  immutable: statics.map((f) => `/_next/static/${f}`),
  // The product's icons and install manifest are routes, not public files
  // (src/app/favicon.svg/route.ts…); they belong to the shell all the same.
  shell: [...publics.map((f) => `/${f}`), ...PRODUCT_ROUTES],
};
await mkdir(path.join(staticDir, build), { recursive: true });
await writeFile(path.join(staticDir, build, NAME), JSON.stringify(manifest));
console.log(`offline manifest: ${manifest.immutable.length + manifest.shell.length} files, ${(bytes / 1048576).toFixed(1)} MB (build ${build})`);
