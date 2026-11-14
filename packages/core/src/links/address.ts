import type { EngineIdentity } from "../identity";
import type { NodeKey } from "../schema";

/**
 * THE ADDRESS GRAMMAR — every place in the app as a path, one parser and one
 * formatter. The URL bar, a link's `route` target, "Copy link", the PDF
 * exporter's web fallback and the agent API all speak it, so a URL pasted
 * anywhere means the same thing everywhere. See ADR-links for why ids are the
 * authority and slugs are cosmetic; this grammar is the irreversible part of
 * the design, so it only ever grows.
 *
 *   /                                      home
 *   /project/<id>[/<page-slug>]            a project (on a page)
 *        ?at=<key>[,<key>…]&t=<time>       … at a node / a selection, at a time
 *   /plugin/<id>[?<params>]                a plugin, opened with its intent
 *
 * Pure strings in, data out — no DOM, no `URL` (a path is not a URL).
 */

/**
 * Where THIS app lives, from the product (identity.ts): its web origin, and its
 * desktop scheme — `<ns>://<the same path, minus its leading slash>`.
 */
export type AppAddress = Pick<EngineIdentity, "name" | "webOrigin" | "scheme">;

export type Route =
  | { to: "home" }
  | {
      to: "project";
      projectId: string;
      /** The cosmetic page slug, as written. Resolves only when no `at` names a node. */
      slug: string | null;
      /** Doc-index keys, first one is where you stand; more = a selection. */
      at: NodeKey[];
      /** Seconds-precise time on the target comp's clock, ms. */
      t: number | null;
      /** Every other query param, kept so a newer build's URL survives this one. */
      params: Record<string, string>;
    }
  | { to: "plugin"; pluginId: string; params: Record<string, string> }
  /** A path this build does not know — kept and shown, never dropped. */
  | { to: "unknown"; path: string };

const NODE_KEY = /^(page|frame|clip):[^\s,]+$/;

export function isDocKey(s: string): s is NodeKey {
  return NODE_KEY.test(s);
}

export function docKey(kind: "page" | "frame" | "clip", id: string): NodeKey {
  return `${kind}:${id}`;
}

export function parseDocKey(key: string): { kind: "page" | "frame" | "clip"; id: string } | null {
  if (!isDocKey(key)) return null;
  const at = key.indexOf(":");
  return { kind: key.slice(0, at) as "page" | "frame" | "clip", id: key.slice(at + 1) };
}

/**
 * A name as a path segment. Letters of EVERY script survive (a Persian page
 * gets a Persian slug, percent-encoded on the wire); everything else becomes a
 * single hyphen. Empty for a name with no letters at all.
 */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
}

/**
 * A time as people write it: `12`, `12.5`, `1:30`, `1:02:03`, `1m30s`, `90s`,
 * `750ms`, `1h2m`. Ms, or null when it is not a time.
 */
export function parseTimeParam(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * 1000);
  if (/^\d+(\.\d+)?ms$/.test(s)) return Math.round(parseFloat(s));
  if (/^\d+(:\d{1,2}){1,2}(\.\d+)?$/.test(s)) {
    const parts = s.split(":").map(Number);
    let sec = 0;
    for (const p of parts) sec = sec * 60 + p;
    return Math.round(sec * 1000);
  }
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(s);
  if (m && (m[1] || m[2] || m[3])) {
    return Math.round(((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000);
  }
  return null;
}

/** Ms as the shortest exact seconds string (`1500` → `1.5`). */
export function formatTimeParam(ms: number): string {
  return String(Math.round(ms) / 1000);
}

/** `encodeURIComponent`, but leaving the characters our keys use readable. */
function encodeParam(v: string): string {
  return encodeURIComponent(v).replace(/%3A/gi, ":").replace(/%2C/gi, ",");
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

function parseQuery(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of query.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = decode(eq < 0 ? part : part.slice(0, eq));
    if (k) out[k] = eq < 0 ? "" : decode(part.slice(eq + 1));
  }
  return out;
}

function formatQuery(entries: Array<[string, string]>): string {
  const q = entries.map(([k, v]) => (v === "" ? encodeParam(k) : `${encodeParam(k)}=${encodeParam(v)}`)).join("&");
  return q ? `?${q}` : "";
}

/**
 * The PATH of an address, whatever it was written as: a bare path, a web-app
 * URL (the app's web origin, or another of its origins), or `<scheme>//…`.
 * Null when it is somewhere else entirely — a URL on another site. Without
 * an `app`, only a bare path is this app's.
 */
export function appPathOf(input: string, app?: AppAddress | null, extraOrigins: readonly string[] = []): string | null {
  const s = input.trim();
  if (s.startsWith("/") && !s.startsWith("//")) return s;
  if (app && s.toLowerCase().startsWith(`${app.scheme}//`)) return `/${s.slice(app.scheme.length + 2).replace(/^\/+/, "")}`;
  for (const origin of [app?.webOrigin, ...extraOrigins]) {
    if (!origin) continue;
    if (s === origin) return "/";
    if (s.startsWith(`${origin}/`) || s.startsWith(`${origin}?`)) return s.slice(origin.length).replace(/^(?=\?)/, "/");
  }
  return null;
}

/** Parse an app path (`/project/x/intro?at=frame:y&t=2`). Never throws. */
export function parseRoute(path: string): Route {
  const hashAt = path.indexOf("#");
  const clean = hashAt >= 0 ? path.slice(0, hashAt) : path;
  const qAt = clean.indexOf("?");
  const pathname = qAt >= 0 ? clean.slice(0, qAt) : clean;
  const params = parseQuery(qAt >= 0 ? clean.slice(qAt + 1) : "");
  const segs = pathname.split("/").filter(Boolean).map(decode);

  if (segs.length === 0) return { to: "home" };
  if (segs[0] === "project" && segs[1]) {
    const { at: atRaw, t: tRaw, ...rest } = params;
    const at = (atRaw ?? "").split(",").map((k) => k.trim()).filter(isDocKey);
    return {
      to: "project",
      projectId: segs[1],
      slug: segs[2] ?? null,
      at,
      t: tRaw !== undefined ? parseTimeParam(tRaw) : null,
      params: rest,
    };
  }
  if (segs[0] === "plugin" && segs[1]) return { to: "plugin", pluginId: segs[1], params };
  return { to: "unknown", path: clean || "/" };
}

/** The canonical path for a route — the inverse of `parseRoute`. */
export function formatRoute(route: Route): string {
  switch (route.to) {
    case "home":
      return "/";
    case "project": {
      const slug = route.slug ? `/${encodeURIComponent(route.slug)}` : "";
      const q: Array<[string, string]> = [];
      if (route.at.length) q.push(["at", route.at.join(",")]);
      if (route.t !== null) q.push(["t", formatTimeParam(route.t)]);
      for (const [k, v] of Object.entries(route.params)) q.push([k, v]);
      return `/project/${encodeURIComponent(route.projectId)}${slug}${formatQuery(q)}`;
    }
    case "plugin":
      return `/plugin/${encodeURIComponent(route.pluginId)}${formatQuery(Object.entries(route.params))}`;
    case "unknown":
      return route.path;
  }
}

/** The shareable web URL for a route, on the app's web origin. */
export function webUrlOf(route: Route, webOrigin: string): string {
  return `${webOrigin}${formatRoute(route)}`;
}
