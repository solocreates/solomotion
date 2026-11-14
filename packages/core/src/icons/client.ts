import { z } from "zod";
import { iconSetAllowed, iconSetStyle, parseIconId, type IconData, type IconRef, type IconSet } from "./catalog";

/**
 * The icon catalogue, ONLINE — a headless client for the Iconify API.
 *
 * Why an API and not a bundle: the world's open icon sets are 370,000 icons and
 * change weekly. Shipping them would cost 300 MB and be stale on day one;
 * indexing them ourselves would be a build pipeline whose only job is to
 * re-derive what `api.iconify.design` already answers — a searchable list, a
 * set's categories, an icon's body — from static, CDN-cached JSON. So the
 * editor asks that API, through a base URL we own (a Cloudflare Worker that
 * caches in front of it — `apps/icons`), with the public API as the fallback
 * so nothing here depends on our proxy being up. Swapping the source later —
 * a self-hosted `@iconify/api`, our own R2 tier with richer tags — is a base
 * URL, not a rewrite.
 *
 * Everything the client fetches is laid down twice: in memory for this
 * session, and in an injectable `IconStore` (the web binds the Cache API) so
 * a set browsed once is there offline next time. Requests de-duplicate in
 * flight: forty visible tiles asking for one set's bodies cause one GET.
 *
 * `fetch` is injectable, so tests drive it without a network.
 */

export interface IconStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface IconCatalogOptions {
  /** API roots, tried in order. Default: the public Iconify API. */
  baseUrls?: readonly string[];
  fetch?: typeof globalThis.fetch;
  store?: IconStore;
}

export const ICONIFY_PUBLIC_API = "https://api.iconify.design";

/* ----------------------------------------------------------------- schemas */

const infoSchema = z.object({
  name: z.string(),
  total: z.number().int().min(0),
  author: z.object({ name: z.string(), url: z.string().optional() }).optional(),
  license: z.object({ title: z.string(), spdx: z.string().optional(), url: z.string().optional() }).optional(),
  samples: z.array(z.string()).default([]),
  height: z.union([z.number(), z.array(z.number())]).optional(),
  palette: z.boolean().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  hidden: z.boolean().optional(),
});
const collectionsSchema = z.record(z.string(), infoSchema);

const collectionSchema = z.object({
  prefix: z.string(),
  total: z.number().int(),
  title: z.string().optional(),
  categories: z.record(z.string(), z.array(z.string())).optional(),
  uncategorized: z.array(z.string()).optional(),
  hidden: z.array(z.string()).optional(),
  aliases: z.record(z.string(), z.string()).optional(),
});

const searchSchema = z.object({
  icons: z.array(z.string()),
  total: z.number().int(),
  limit: z.number().int(),
  start: z.number().int(),
});

const iconRecordSchema = z.object({
  body: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  left: z.number().optional(),
  top: z.number().optional(),
});
const iconsJsonSchema = z.object({
  prefix: z.string(),
  icons: z.record(z.string(), iconRecordSchema),
  aliases: z.record(z.string(), z.object({ parent: z.string() }).passthrough()).optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  not_found: z.array(z.string()).optional(),
});

/* ------------------------------------------------------------------ model */

/** A set's browse structure: its categories (name → icons) and the rest. */
export interface IconSetIndex {
  prefix: string;
  categories: Array<{ name: string; icons: string[] }>;
  uncategorized: string[];
  /** Every visible icon name, in upstream order. */
  all: string[];
}

export interface IconSearch {
  query: string;
  /** Restrict to these sets. Omit for every allowed set. */
  prefixes?: readonly string[];
  /** Only line icons, or only filled ones. */
  style?: "stroke" | "fill";
  /** Only multicolour artwork, or only single-ink glyphs. */
  palette?: boolean;
  limit?: number;
  start?: number;
}

export interface IconSearchResult {
  icons: IconRef[];
  total: number;
}

/** Search asks for at most this many rows; the API caps at 999. */
export const ICON_SEARCH_MAX = 999;

/** Names per bodies request — keeps the URL well under every proxy's limit. */
const ICONS_PER_REQUEST = 80;

const storedIconSchema = z.object({
  body: z.string(),
  width: z.number(),
  height: z.number(),
  left: z.number(),
  top: z.number(),
});

function parseStored(text: string): IconData | null {
  try {
    const res = storedIconSchema.safeParse(JSON.parse(text));
    return res.success ? res.data : null;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- client */

export class IconCatalogClient {
  private readonly bases: readonly string[];
  private readonly doFetch: typeof globalThis.fetch;
  private readonly store: IconStore | null;
  /** The base that last answered — tried first from then on. */
  private live = 0;

  private setsCache: IconSet[] | null = null;
  private readonly indexCache = new Map<string, IconSetIndex>();
  private readonly iconCache = new Map<string, IconData | null>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(options: IconCatalogOptions = {}) {
    this.bases = (options.baseUrls?.length ? options.baseUrls : [ICONIFY_PUBLIC_API]).map((b) => b.replace(/\/+$/, ""));
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.store = options.store ?? null;
  }

  private once<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const p = run().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /**
   * GET a path as JSON — persisted copy first, then each base in turn. A base
   * that fails is not abandoned for good: the next call tries the live one
   * first and falls back again, so a proxy outage costs one failed request,
   * not a session.
   */
  private async json(path: string, opts: { persist: boolean }): Promise<unknown> {
    if (opts.persist && this.store) {
      const hit = await this.store.get(path).catch(() => null);
      if (hit) {
        try {
          return JSON.parse(hit) as unknown;
        } catch {
          /* a corrupt entry is simply refetched */
        }
      }
    }
    let lastError: unknown = null;
    for (let i = 0; i < this.bases.length; i++) {
      const at = (this.live + i) % this.bases.length;
      try {
        const res = await this.doFetch(`${this.bases[at]}${path}`, { headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(`Icons ${res.status} for ${path}`);
        const text = await res.text();
        this.live = at;
        if (opts.persist && this.store) void this.store.put(path, text).catch(() => undefined);
        return JSON.parse(text) as unknown;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`Icons unavailable for ${path}`);
  }

  /** Every set the panel may offer — licence-gated, hidden sets dropped. */
  async sets(): Promise<IconSet[]> {
    if (this.setsCache) return this.setsCache;
    return this.once("sets", async () => {
      const raw = collectionsSchema.parse(await this.json("/collections", { persist: true }));
      const out: IconSet[] = [];
      for (const [prefix, info] of Object.entries(raw)) {
        if (info.hidden) continue;
        const license = {
          title: info.license?.title ?? "Unknown",
          spdx: info.license?.spdx ?? null,
          url: info.license?.url ?? null,
        };
        if (!iconSetAllowed(license)) continue;
        const tags = info.tags ?? [];
        const palette = info.palette ?? false;
        out.push({
          prefix,
          name: info.name,
          total: info.total,
          author: { name: info.author?.name ?? "Unknown", url: info.author?.url ?? null },
          license,
          samples: info.samples,
          height: Array.isArray(info.height) ? (info.height[0] ?? null) : (info.height ?? null),
          palette,
          category: info.category ?? null,
          tags,
          style: iconSetStyle({ palette, tags }),
        });
      }
      this.setsCache = out;
      return out;
    });
  }

  async set(prefix: string): Promise<IconSet | null> {
    return (await this.sets()).find((s) => s.prefix === prefix) ?? null;
  }

  /** A set's browse structure. Fetched once per set, kept. */
  async index(prefix: string): Promise<IconSetIndex> {
    const hit = this.indexCache.get(prefix);
    if (hit) return hit;
    return this.once(`index:${prefix}`, async () => {
      const raw = collectionSchema.parse(await this.json(`/collection?prefix=${encodeURIComponent(prefix)}`, { persist: true }));
      const hidden = new Set(raw.hidden ?? []);
      const categories = Object.entries(raw.categories ?? {}).map(([name, icons]) => ({
        name,
        icons: icons.filter((n) => !hidden.has(n)),
      }));
      const uncategorized = (raw.uncategorized ?? []).filter((n) => !hidden.has(n));
      const seen = new Set<string>();
      const all: string[] = [];
      for (const list of [...categories.map((c) => c.icons), uncategorized]) {
        for (const n of list) {
          if (!seen.has(n)) {
            seen.add(n);
            all.push(n);
          }
        }
      }
      const index = { prefix, categories, uncategorized, all };
      this.indexCache.set(prefix, index);
      return index;
    });
  }

  /**
   * Search by name across sets. Style and palette ride along as the API's own
   * query keywords, so the filter runs server-side and a "stroke arrows"
   * search downloads only stroke arrows. Not persisted: results are cheap and
   * the index behind them moves.
   */
  async search(input: IconSearch): Promise<IconSearchResult> {
    const words = [input.query.trim()];
    if (input.style) words.push(`style:${input.style}`);
    if (input.palette !== undefined) words.push(`palette:${input.palette}`);
    const q = words.filter(Boolean).join(" ");
    if (!q) return { icons: [], total: 0 };
    const params = new URLSearchParams({
      query: q,
      limit: String(Math.min(ICON_SEARCH_MAX, Math.max(1, input.limit ?? 120))),
    });
    if (input.start) params.set("start", String(input.start));
    if (input.prefixes?.length) params.set("prefixes", input.prefixes.join(","));
    const raw = searchSchema.parse(await this.json(`/search?${params.toString()}`, { persist: false }));
    const allowed = new Set((await this.sets()).map((s) => s.prefix));
    const icons: IconRef[] = [];
    for (const id of raw.icons) {
      const ref = parseIconId(id);
      if (ref && allowed.has(ref.prefix)) icons.push(ref);
    }
    return { icons, total: raw.total };
  }

  /** One icon's data, or null when the set has no such icon. */
  async icon(ref: IconRef): Promise<IconData | null> {
    const got = await this.icons(ref.prefix, [ref.name]);
    return got.get(ref.name) ?? null;
  }

  /**
   * Bodies for many icons of one set, batched. Every name comes back in the
   * map — `null` for one the set does not have — so a caller can render a page
   * of tiles from one await.
   */
  async icons(prefix: string, names: readonly string[]): Promise<Map<string, IconData | null>> {
    const out = new Map<string, IconData | null>();
    let missing: string[] = [];
    for (const name of names) {
      const key = `${prefix}:${name}`;
      if (this.iconCache.has(key)) out.set(name, this.iconCache.get(key) ?? null);
      else missing.push(name);
    }
    // Persisted PER ICON, not per request: a page's batch and a later single
    // ask must hit the same copy, whatever grouping fetched it.
    if (this.store && missing.length) {
      const still: string[] = [];
      for (const name of missing) {
        const kept = await this.store.get(`icon:${prefix}:${name}`).catch(() => null);
        const data = kept ? parseStored(kept) : null;
        if (data) {
          this.iconCache.set(`${prefix}:${name}`, data);
          out.set(name, data);
        } else still.push(name);
      }
      missing = still;
    }
    for (let i = 0; i < missing.length; i += ICONS_PER_REQUEST) {
      const chunk = missing.slice(i, i + ICONS_PER_REQUEST);
      const sorted = [...chunk].sort();
      const path = `/${encodeURIComponent(prefix)}.json?icons=${sorted.map(encodeURIComponent).join(",")}`;
      const fetched = await this.once(path, async () => {
        const raw = iconsJsonSchema.parse(await this.json(path, { persist: false }));
        const setW = raw.width ?? 16;
        const setH = raw.height ?? 16;
        const map = new Map<string, IconData>();
        const toData = (r: z.infer<typeof iconRecordSchema>): IconData => ({
          body: r.body,
          width: r.width ?? setW,
          height: r.height ?? setH,
          left: r.left ?? 0,
          top: r.top ?? 0,
        });
        for (const [name, r] of Object.entries(raw.icons)) map.set(name, toData(r));
        // An alias is its parent's body under another name.
        for (const [name, a] of Object.entries(raw.aliases ?? {})) {
          const parent = raw.icons[a.parent];
          if (parent && !map.has(name)) map.set(name, toData(parent));
        }
        return map;
      });
      for (const name of chunk) {
        const data = fetched.get(name) ?? null;
        this.iconCache.set(`${prefix}:${name}`, data);
        out.set(name, data);
        if (data && this.store) void this.store.put(`icon:${prefix}:${name}`, JSON.stringify(data)).catch(() => undefined);
      }
    }
    return out;
  }

  /** Drop everything remembered in memory (the store keeps its copies). */
  invalidate(): void {
    this.setsCache = null;
    this.indexCache.clear();
    this.iconCache.clear();
  }
}
