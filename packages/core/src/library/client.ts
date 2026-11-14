import {
  libraryIndexSchema,
  packManifestSchema,
  type IndexPack,
  type LibraryIndex,
  type ManifestEntry,
  type PackManifest,
} from "./manifest";
import { packCouldMatch, searchLibrary, type LibraryQuery } from "./query";
import type { LibraryItem, LibraryPreview } from "./item";
import { availableTo } from "./scope";

/**
 * The ONLINE catalogue, headless.
 *
 * Plain public GETs against static JSON — no credentials ever reach the editor,
 * because there is nothing to authenticate against. The root index is fetched
 * once and kept; pack manifests are fetched lazily and only when a query says
 * they could match, which is what keeps a catalogue of thousands cheap to
 * search from a laptop on hotel wifi.
 *
 * `fetch` is injectable so tests, the exporter and any future worker can drive
 * it without a network. It is never on a render path: every method is async and
 * the surfaces call them from effects.
 */

export interface LibraryClientOptions {
  /** Catalogue root, e.g. `https://library.example.com/v1`. No trailing slash. */
  baseUrl: string;
  /**
   * The product reading it (`identity.ns`). One catalogue serves every product
   * on the engine; packs and entries scoped to other products (scope.ts) are
   * dropped here, the one place the catalogue is read, so nothing downstream
   * ever sees them.
   */
  product: string;
  fetch?: typeof globalThis.fetch;
  /** How long a fetched index/pack stays fresh. Default 5 minutes. */
  ttlMs?: number;
}

interface Cached<T> {
  at: number;
  value: T;
}

export class LibraryClient {
  readonly baseUrl: string;
  readonly product: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly ttlMs: number;
  private indexCache: Cached<LibraryIndex> | null = null;
  private packCache = new Map<string, Cached<PackManifest>>();
  /** In-flight de-duplication: ten cards asking for one pack cause one GET. */
  private inflight = new Map<string, Promise<unknown>>();

  constructor(options: LibraryClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.product = options.product;
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
  }

  /** Absolute URL for a manifest-relative path. */
  url(path: string): string {
    return /^https?:/i.test(path) ? path : `${this.baseUrl}/${path.replace(/^\/+/, "")}`;
  }

  private fresh<T>(c: Cached<T> | null | undefined): T | null {
    return c && Date.now() - c.at < this.ttlMs ? c.value : null;
  }

  private once<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const p = run().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async json(path: string): Promise<unknown> {
    const res = await this.doFetch(this.url(path), { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`Library ${res.status} for ${path}`);
    return res.json();
  }

  async index(): Promise<LibraryIndex> {
    const hit = this.fresh(this.indexCache);
    if (hit) return hit;
    return this.once("index", async () => {
      const parsed = libraryIndexSchema.parse(await this.json("index.json"));
      const value = { ...parsed, packs: parsed.packs.filter((p) => availableTo(p.products, this.product)) };
      this.indexCache = { at: Date.now(), value };
      return value;
    });
  }

  async pack(packId: string): Promise<PackManifest> {
    const hit = this.fresh(this.packCache.get(packId));
    if (hit) return hit;
    return this.once(`pack:${packId}`, async () => {
      const index = await this.index();
      const row = index.packs.find((p) => p.id === packId);
      const parsed = packManifestSchema.parse(await this.json(row?.manifestPath ?? `packs/${packId}.json`));
      const value = { ...parsed, entries: parsed.entries.filter((e) => availableTo(e.products, this.product)) };
      this.packCache.set(packId, { at: Date.now(), value });
      return value;
    });
  }

  /** Packs the query could match, without downloading any of them. */
  async candidatePacks(query: LibraryQuery = {}): Promise<IndexPack[]> {
    const index = await this.index();
    return index.packs.filter((p) => packCouldMatch(p, query));
  }

  /**
   * Search the online catalogue. Fetches only the packs that survive the
   * index-level term filter, then ranks their entries with the SAME matcher the
   * local library uses — so one query orders local and online results together.
   */
  async search(query: LibraryQuery = {}): Promise<LibraryItem[]> {
    const packs = await this.candidatePacks(query);
    const manifests = await Promise.all(
      packs.map((p) => this.pack(p.id).catch(() => null)),
    );
    const items: LibraryItem[] = [];
    for (const m of manifests) {
      if (!m) continue;
      for (const entry of m.entries) items.push(this.toItem(entry, m));
    }
    return searchLibrary(items, query);
  }

  /** Every item in one pack, in publish order. */
  async items(packId: string): Promise<LibraryItem[]> {
    const m = await this.pack(packId);
    return m.entries.map((e) => this.toItem(e, m));
  }

  /** Fetch an item's bytes. The one place a blob is downloaded. */
  async blob(item: LibraryItem, signal?: AbortSignal): Promise<Blob> {
    if (!item.blob) throw new Error(`${item.name} has no blob to download`);
    const res = await this.doFetch(this.url(item.blob.path), { signal });
    if (!res.ok) throw new Error(`Download failed (${res.status}) for ${item.name}`);
    return res.blob();
  }

  /**
   * Manifest entry → catalogue item, with URLs made absolute.
   *
   * `action` is null by construction: an online item is not usable until its
   * bytes are local, and the surface upgrades it through `resolveLibraryItem`.
   * Preset entries are the one exception — they name something that already
   * ships in the app, so there is nothing to download.
   */
  toItem(entry: ManifestEntry, pack: PackManifest): LibraryItem {
    return {
      id: `online:${entry.kind}:${pack.id}/${entry.id}`,
      kind: entry.kind,
      name: entry.name,
      tags: entry.tags.map((t) => t.toLowerCase()),
      blurb: entry.blurb,
      source: "online",
      publisher: pack.publisher,
      preview: this.toPreview(entry.preview),
      action:
        entry.payload.kind === "preset"
          ? { type: "preset", domain: entry.payload.domain, presetId: entry.payload.presetId }
          : null,
      blob: entry.blob,
      packId: pack.id,
      originId: null,
      createdAt: entry.createdAt,
      ...(entry.order != null ? { order: entry.order } : {}),
    };
  }

  private toPreview(p: ManifestEntry["preview"]): LibraryPreview {
    switch (p.type) {
      case "peaks":
        return { type: "peaks", peaks: p.peaks, durationMs: p.durationMs, hitMs: p.hitMs, loudnessDb: p.loudnessDb };
      case "image":
        return { type: "image", url: this.url(p.path), width: p.width, height: p.height };
      case "video":
        return {
          type: "video",
          url: this.url(p.path),
          posterUrl: p.posterPath ? this.url(p.posterPath) : null,
          width: p.width,
          height: p.height,
          durationMs: p.durationMs,
        };
      default:
        return { type: "none" };
    }
  }

  /** Drop every cache — what a "Refresh" affordance calls. */
  invalidate(): void {
    this.indexCache = null;
    this.packCache.clear();
  }
}
