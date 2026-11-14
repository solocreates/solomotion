import { NAMES } from "@/editor/names";
import { unzip, strFromU8, type Unzipped } from "fflate";
import {
  isManifestFileName,
  parseManifest,
  pluginClientBootstrap,
  type ManifestParseResult,
  type PluginBootstrapConfig,
  type PluginManifest,
} from "@solomotion/plugin-sdk";
import type { PluginBundleFiles } from "./plugin-model";

/**
 * The bundle engine — the ONE place that turns a plugin's files (from a zip, a
 * dev folder, or a seeded sample) into something runnable. It:
 *   • normalizes the file map (strip a wrapping folder, drop OS junk),
 *   • reads + validates the manifest,
 *   • extracts the icon as a data URL,
 *   • assembles the sandbox HTML document (inline the bundle's own assets, inject
 *     the SDK client) served to the iframe via `srcdoc`.
 *
 * Everything is self-contained: the assembled document references no external
 * origin, so the iframe can run fully sandboxed (null origin, `allow-scripts`).
 */

// ── mime + data URLs ─────────────────────────────────────────────────────────

const MIME_BY_EXT: Record<string, string> = {
  html: "text/html",
  js: "text/javascript",
  mjs: "text/javascript",
  css: "text/css",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  woff: "font/woff",
  woff2: "font/woff2",
};

function extOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i < 0 ? "" : path.slice(i + 1).toLowerCase();
}

function mimeForPath(path: string): string {
  return MIME_BY_EXT[extOf(path)] ?? "application/octet-stream";
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function dataUrlFor(path: string, bytes: Uint8Array): string {
  const mime = mimeForPath(path);
  if (mime === "image/svg+xml") return `data:${mime};utf8,${encodeURIComponent(strFromU8(bytes))}`;
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

// ── reading bundles ──────────────────────────────────────────────────────────

function unzipAsync(buf: Uint8Array): Promise<Unzipped> {
  return new Promise((resolve, reject) => unzip(buf, (err, data) => (err ? reject(err) : resolve(data))));
}

/** Read a `.zip`/`.atomplugin` into a normalized file map. */
export async function bundleFromZip(file: File): Promise<PluginBundleFiles> {
  const entries = await unzipAsync(new Uint8Array(await file.arrayBuffer()));
  const files: PluginBundleFiles = {};
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith("/")) continue; // directory entry
    files[name] = bytes;
  }
  return normalizeBundle(files);
}

/** Minimal FS Access directory shape — the DOM lib omits the async iterators. */
interface DirEntryHandle {
  kind: "file" | "directory";
  name: string;
  getFile?: () => Promise<File>;
  entries?: () => AsyncIterableIterator<[string, DirEntryHandle]>;
}

/** Read a picked directory (Chromium FS Access API) recursively into a map. */
export async function bundleFromDirectory(dir: FileSystemDirectoryHandle): Promise<PluginBundleFiles> {
  const files: PluginBundleFiles = {};
  async function walk(handle: DirEntryHandle, prefix: string): Promise<void> {
    if (!handle.entries) return;
    for await (const [name, child] of handle.entries()) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const path = prefix ? `${prefix}/${name}` : name;
      if (child.kind === "file" && child.getFile) {
        files[path] = new Uint8Array(await (await child.getFile()).arrayBuffer());
      } else if (child.kind === "directory") {
        await walk(child, path);
      }
    }
  }
  await walk(dir as unknown as DirEntryHandle, "");
  return normalizeBundle(files);
}

/** Strip a single wrapping folder (zip of `my-plugin/…`) and drop OS junk. */
function normalizeBundle(files: PluginBundleFiles): PluginBundleFiles {
  const paths = Object.keys(files).filter(
    (p) => !p.includes("__MACOSX") && !p.endsWith(".DS_Store") && !p.startsWith("."),
  );
  const tops = new Set(paths.map((p) => p.split("/")[0]));
  let strip = "";
  if (tops.size === 1 && !paths.some(isManifestFileName)) {
    const only = [...tops][0]!;
    if (paths.some((p) => p.startsWith(`${only}/`) && isManifestFileName(p.slice(only.length + 1)))) strip = `${only}/`;
  }
  const out: PluginBundleFiles = {};
  for (const p of paths) out[strip && p.startsWith(strip) ? p.slice(strip.length) : p] = files[p]!;
  return out;
}

// ── manifest + icon ──────────────────────────────────────────────────────────

export function readManifest(files: PluginBundleFiles): ManifestParseResult {
  // The host's own name first; a plugin made for another product on this engine reads too.
  const name = files[NAMES.files.pluginManifest] ? NAMES.files.pluginManifest : Object.keys(files).find(isManifestFileName);
  const raw = name ? files[name] : undefined;
  if (!name || !raw) return { ok: false, errors: [`Missing ${NAMES.files.pluginManifest} at the bundle root.`] };
  let json: unknown;
  try {
    json = JSON.parse(strFromU8(raw));
  } catch {
    return { ok: false, errors: [`${name} is not valid JSON.`] };
  }
  return parseManifest(json);
}

export function iconDataUrl(manifest: PluginManifest, files: PluginBundleFiles): string | null {
  if (!manifest.icon) return null;
  const bytes = files[manifest.icon];
  return bytes ? dataUrlFor(manifest.icon, bytes) : null;
}

// ── sandbox document assembly ────────────────────────────────────────────────

export function buildSandboxHtml(
  manifest: PluginManifest,
  files: PluginBundleFiles,
  config: PluginBootstrapConfig,
  /** Extra head markup that must precede the plugin's own (the host theme). */
  headPrefix = "",
): string {
  const entry = files[manifest.main];
  if (!entry) throw new Error(`Entry "${manifest.main}" not found in the plugin bundle.`);
  const html = inlineLocalRefs(strFromU8(entry), manifest.main, files);
  const bootstrap = `<script>(${pluginClientBootstrap.toString()})(${JSON.stringify(config)});</script>`;
  return injectHead(html, headPrefix + bootstrap);
}

function baseDirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** Resolve a bundle-relative href against the entry's directory. */
function resolvePath(entryPath: string, ref: string): string {
  if (ref.startsWith("/")) return ref.replace(/^\/+/, "");
  const parts = baseDirOf(entryPath) ? baseDirOf(entryPath).split("/") : [];
  for (const seg of ref.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

const isLocalRef = (ref: string): boolean => !/^(?:https?:|data:|blob:|#|mailto:|\/\/)/i.test(ref);

/**
 * Inline the bundle's own `<script src>`, stylesheet `<link>` and media `src`
 * so the sandbox document is fully self-contained (v1 loader — plenty for the
 * single-file and small multi-file plugins this ships with; blob-URL
 * sub-resource loading can come later for heavier bundles).
 */
function inlineLocalRefs(html: string, entryPath: string, files: PluginBundleFiles): string {
  const textOf = (ref: string): string | null => {
    const bytes = files[resolvePath(entryPath, ref)];
    return bytes ? strFromU8(bytes) : null;
  };
  // <script src="local.js"></script>  →  inline
  html = html.replace(
    /<script\b([^>]*?)\ssrc=(["'])(.*?)\2([^>]*)>\s*<\/script>/gi,
    (m, pre: string, _q: string, src: string, post: string) => {
      if (!isLocalRef(src)) return m;
      const code = textOf(src);
      return code == null ? m : `<script${pre}${post}>\n${code}\n</script>`;
    },
  );
  // <link rel="stylesheet" href="local.css">  →  inline <style>
  html = html.replace(/<link\b([^>]*?)>/gi, (m, attrs: string) => {
    if (!/stylesheet/i.test(attrs)) return m;
    const href = /\shref=(["'])(.*?)\1/i.exec(attrs)?.[2];
    if (!href || !isLocalRef(href)) return m;
    const css = textOf(href);
    return css == null ? m : `<style>\n${css}\n</style>`;
  });
  // media src → data URL
  html = html.replace(
    /<(img|source|audio|video)\b([^>]*?)\ssrc=(["'])(.*?)\3([^>]*)>/gi,
    (m, tag: string, pre: string, _q: string, src: string, post: string) => {
      if (!isLocalRef(src)) return m;
      const path = resolvePath(entryPath, src);
      const bytes = files[path];
      return bytes ? `<${tag}${pre} src="${dataUrlFor(path, bytes)}"${post}>` : m;
    },
  );
  return html;
}

/** Ensure the bootstrap runs before any of the plugin's own scripts. */
function injectHead(html: string, tag: string): string {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}\n${tag}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}\n<head>${tag}</head>`);
  return `${tag}\n${html}`;
}
