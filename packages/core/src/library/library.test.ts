import { describe, expect, it } from "vitest";
import { analyzeAudio, detectOnsetMs, peaksFromSamples, quantisePeaks, audibleEndMs } from "../audio/analysis";
import { LibraryClient } from "./client";
import { mergeLibrary } from "./merge";
import { packCouldMatch, parseQuery, searchLibrary, tagFacets, termsFor } from "./query";
import { compareShelfOrder, dedupeBySubject, type LibraryItem } from "./item";
import type { IndexPack, PackManifest } from "./manifest";
import { previewPathFor, publishRequestSchema, upsertPackSource } from "./publish";

/** A click 100 ms into a 1 s file at 1 kHz, with a silent tail. */
function clickAt(ms: number, sampleRate = 1000, lengthMs = 1000): Float32Array {
  const s = new Float32Array((sampleRate * lengthMs) / 1000);
  const start = (ms / 1000) * sampleRate;
  for (let i = 0; i < 20; i++) s[start + i] = 1 - i / 20;
  return s;
}

describe("audio analysis", () => {
  it("finds the transient, not the peak, and not sample zero", () => {
    expect(detectOnsetMs(clickAt(100), 1000)).toBeCloseTo(100, 0);
  });

  it("returns 0 for silence rather than guessing", () => {
    expect(detectOnsetMs(new Float32Array(500), 1000)).toBe(0);
  });

  it("ignores a soft floor below the threshold", () => {
    const s = clickAt(200);
    for (let i = 0; i < s.length; i++) s[i] = Math.max(s[i]!, 0.02);
    expect(detectOnsetMs(s, 1000)).toBeCloseTo(200, 0);
  });

  it("trims a silent tail so a padded file draws like a tight one", () => {
    // 20 samples of sound at 100 ms in a 1000 ms file → audible ends ~120 ms.
    expect(audibleEndMs(clickAt(100), 1000)).toBeCloseTo(120, 0);
  });

  it("quantises peaks normalised to the loudest bin", () => {
    expect(quantisePeaks([0.5, 0.25, 0])).toEqual([1, 0.5, 0]);
    expect(quantisePeaks([0, 0])).toEqual([0, 0]);
  });

  it("peaks take the MAX in a bin, so a transient survives binning", () => {
    const s = new Float32Array(100);
    s[50] = 1;
    const peaks = peaksFromSamples(s, 10);
    expect(Math.max(...peaks)).toBe(1);
  });

  it("analyzes to the fields a manifest carries", () => {
    const a = analyzeAudio(clickAt(100), 1000, 32);
    expect(a.durationMs).toBe(1000);
    expect(a.hitMs).toBeCloseTo(100, 0);
    expect(a.audibleMs).toBeLessThan(200);
    expect(a.peaks).toHaveLength(32);
    // Peaks cover the AUDIBLE span, so the click is not squeezed into one bin.
    expect(a.peaks.filter((p) => p > 0).length).toBeGreaterThan(1);
  });
});

const item = (patch: Partial<LibraryItem>): LibraryItem => ({
  id: "x",
  kind: "sound",
  name: "Thock",
  tags: ["keyboard", "ui"],
  blurb: null,
  source: "online",
  publisher: null,
  preview: { type: "none" },
  action: null,
  blob: null,
  packId: null,
  originId: null,
  createdAt: null,
  ...patch,
});

describe("library search", () => {
  it("lifts #hashtags out of the text and ANDs them as tags", () => {
    const parsed = parseQuery({ text: "#ui soft click" });
    expect(parsed.tags).toEqual(["ui"]);
    expect(parsed.terms).toEqual(["soft", "click"]);
  });

  it("matches tags from plain text too", () => {
    const items = [item({ id: "a", name: "Thock" }), item({ id: "b", name: "Riser", tags: ["swell"] })];
    expect(searchLibrary(items, { text: "keyboard" }).map((i) => i.id)).toEqual(["a"]);
  });

  it("ranks an exact name above a tag match", () => {
    const items = [
      item({ id: "tagged", name: "Soft Tap", tags: ["thock"] }),
      item({ id: "named", name: "Thock", tags: [] }),
    ];
    expect(searchLibrary(items, { text: "thock" }).map((i) => i.id)).toEqual(["named", "tagged"]);
  });

  it("ANDs multiple terms — every word must land", () => {
    const items = [item({ id: "a", name: "Soft Tap", tags: ["ui"] })];
    expect(searchLibrary(items, { text: "soft tap" })).toHaveLength(1);
    expect(searchLibrary(items, { text: "soft riser" })).toHaveLength(0);
  });

  it("filters by kind and source", () => {
    const items = [item({ id: "a", kind: "sound" }), item({ id: "b", kind: "text", source: "builtin" })];
    expect(searchLibrary(items, { kinds: ["text"] }).map((i) => i.id)).toEqual(["b"]);
    expect(searchLibrary(items, { sources: ["online"] }).map((i) => i.id)).toEqual(["a"]);
  });

  it("counts tag facets, commonest first", () => {
    const items = [item({ id: "a", tags: ["ui"] }), item({ id: "b", tags: ["ui", "soft"] })];
    expect(tagFacets(items)).toEqual([
      { tag: "ui", count: 2 },
      { tag: "soft", count: 1 },
    ]);
  });
});

const indexPack = (patch: Partial<IndexPack>): IndexPack => ({
  id: "ui-clicks",
  title: "UI Clicks",
  blurb: null,
  kind: "sound",
  publisher: null,
  coverPath: null,
  manifestPath: "packs/ui-clicks.json",
  itemCount: 2,
  bytes: 1000,
  tagCounts: { ui: 2 },
  terms: ["soft", "tap", "ui", "click"],
  updatedAt: 0,
  ...patch,
});

describe("pack prefilter", () => {
  it("rejects a pack whose terms cannot match, without fetching it", () => {
    expect(packCouldMatch(indexPack({}), { text: "soft" })).toBe(true);
    expect(packCouldMatch(indexPack({}), { text: "cinematic" })).toBe(false);
  });

  it("never rejects a pack the item matcher would accept", () => {
    // The generator and the prefilter must agree — that is what makes false
    // negatives impossible rather than merely unlikely.
    const terms = termsFor("Soft Tap", ["ui"], "A gentle click");
    const pack = indexPack({ terms });
    for (const q of ["soft", "tap", "ui", "gentle", "click"]) {
      expect(packCouldMatch(pack, { text: q })).toBe(true);
    }
  });

  it("rejects on kind and on a hashtag the pack does not carry", () => {
    expect(packCouldMatch(indexPack({}), { kinds: ["text"] })).toBe(false);
    expect(packCouldMatch(indexPack({}), { text: "#cinematic" })).toBe(false);
  });
});

describe("result order", () => {
  it("leads with built-ins, then yours, then the catalogue", () => {
    const items = [
      item({ id: "online", source: "online" }),
      item({ id: "builtin", source: "builtin" }),
      item({ id: "user", source: "user" }),
    ];
    // No query: every score ties, so the source rank is the whole order.
    expect(searchLibrary(items).map((i) => i.id)).toEqual(["builtin", "user", "online"]);
  });

  it("does not move an item when you acquire it", () => {
    const before = [item({ id: "a", source: "online" }), item({ id: "b", source: "online" })];
    const after = [item({ id: "a", source: "downloaded" }), item({ id: "b", source: "online" })];
    // Downloading `a` must not reshuffle the list under the cursor.
    expect(searchLibrary(after).map((i) => i.id)).toEqual(searchLibrary(before).map((i) => i.id));
  });

  it("still lets a real match outrank the source order", () => {
    const items = [
      item({ id: "builtin", source: "builtin", name: "Soft Tap" }),
      item({ id: "online", source: "online", name: "Thock" }),
    ];
    expect(searchLibrary(items, { text: "thock" }).map((i) => i.id)).toEqual(["online"]);
  });
});

describe("merge", () => {
  it("upgrades the online card IN PLACE rather than swapping it for a local one", () => {
    const action = { type: "sound", pack: null, assetId: "asset_1", hitMs: 4 } as const;
    const local = [item({ id: "device:sound:1", source: "downloaded", originId: "online:sound:p/a", action })];
    const online = [item({ id: "online:sound:p/a" }), item({ id: "online:sound:p/b" })];
    const merged = mergeLibrary(local, online);
    // Same card, same id — it just became usable.
    expect(merged.map((i) => i.id)).toEqual(["online:sound:p/a", "online:sound:p/b"]);
    expect(merged[0]).toMatchObject({ source: "downloaded", action });
  });

  it("keeps a local item whose origin is no longer in the catalogue", () => {
    const local = [item({ id: "device:sound:1", source: "downloaded", originId: "online:sound:p/gone" })];
    expect(mergeLibrary(local, []).map((i) => i.id)).toEqual(["device:sound:1"]);
  });
});

describe("LibraryClient", () => {
  const index = {
    version: 1,
    generatedAt: 0,
    packs: [indexPack({}), indexPack({ id: "risers", terms: ["riser", "swell"], manifestPath: "packs/risers.json" })],
  };
  const pack: PackManifest = {
    version: 1,
    id: "ui-clicks",
    title: "UI Clicks",
    blurb: null,
    kind: "sound",
    license: null,
    attribution: null,
    publisher: { id: "studio", name: "Studio" },
    coverPath: null,
    updatedAt: 0,
    entries: [
      {
        id: "soft-tap",
        kind: "sound",
        name: "Soft Tap",
        tags: ["ui"],
        blurb: null,
        description: null,
        blob: { path: "blobs/abc.wav", sha256: "abc", bytes: 900, mime: "audio/wav" },
        preview: { type: "peaks", peaks: [0, 1, 0.5], durationMs: 120, hitMs: 4, loudnessDb: -14 },
        payload: { kind: "sound", hitMs: 4, durationMs: 120, loudnessDb: -14 },
        createdAt: 5,
        order: null,
      },
    ],
  };

  function clientWith(seen: string[]) {
    const fetchMock = (async (url: string) => {
      seen.push(String(url));
      const body = String(url).endsWith("index.json") ? index : pack;
      return { ok: true, status: 200, json: async () => body } as Response;
    }) as unknown as typeof fetch;
    return new LibraryClient({ baseUrl: "https://library.test/v1", fetch: fetchMock });
  }

  it("fetches ONLY the packs a query could match", async () => {
    const seen: string[] = [];
    const results = await clientWith(seen).search({ text: "tap" });
    expect(seen).toEqual([
      "https://library.test/v1/index.json",
      "https://library.test/v1/packs/ui-clicks.json",
    ]);
    expect(results.map((r) => r.name)).toEqual(["Soft Tap"]);
  });

  it("fetches nothing beyond the index when no pack can match", async () => {
    const seen: string[] = [];
    expect(await clientWith(seen).search({ text: "cinematic" })).toEqual([]);
    expect(seen).toEqual(["https://library.test/v1/index.json"]);
  });

  it("caches the index across calls", async () => {
    const seen: string[] = [];
    const client = clientWith(seen);
    await client.index();
    await client.index();
    expect(seen).toHaveLength(1);
  });

  it("gives an online item no action until its bytes are local", async () => {
    const items = await clientWith([]).items("ui-clicks");
    expect(items[0]!.action).toBeNull();
    expect(items[0]!.blob?.bytes).toBe(900);
    expect(items[0]!.id).toBe("online:sound:ui-clicks/soft-tap");
    expect(items[0]!.preview).toEqual({ type: "peaks", peaks: [0, 1, 0.5], durationMs: 120, hitMs: 4, loudnessDb: -14 });
  });

  it("resolves manifest paths to absolute URLs", () => {
    const c = clientWith([]);
    expect(c.url("blobs/a.wav")).toBe("https://library.test/v1/blobs/a.wav");
    expect(c.url("https://cdn/x.wav")).toBe("https://cdn/x.wav");
  });
});

describe("subject dedupe", () => {
  const soundItem = (id: string, assetId: string): LibraryItem => ({
    id,
    kind: "sound",
    name: "Thock",
    tags: [],
    blurb: null,
    source: "user",
    publisher: null,
    preview: { type: "render" },
    action: { type: "sound", pack: null, assetId, hitMs: 12 },
    blob: null,
    packId: null,
    originId: null,
    createdAt: null,
  });

  it("folds two providers answering for one asset into one card", () => {
    const device = soundItem("device:sound:a1", "a1");
    const project = soundItem("project:sound:a1", "a1");
    const out = dedupeBySubject([device, project]);
    expect(out).toHaveLength(1);
    // First wins — the device entry is the one carrying the hit point.
    expect(out[0]!.id).toBe("device:sound:a1");
  });

  it("keeps one asset's sound card and media card apart", () => {
    const sound = soundItem("project:sound:a1", "a1");
    const media: LibraryItem = { ...sound, id: "project:media:a1", kind: "media", action: { type: "asset", assetId: "a1" } };
    expect(dedupeBySubject([sound, media])).toHaveLength(2);
  });

  it("never folds two saved snapshots that merely look alike", () => {
    const base = soundItem("user:component:x", "a1");
    const a: LibraryItem = { ...base, id: "user:component:x", kind: "component", action: { type: "snapshot", snapshot: { clips: [], groups: [] } as never } };
    const b: LibraryItem = { ...a, id: "user:component:y" };
    expect(dedupeBySubject([a, b])).toHaveLength(2);
  });
});

describe("publishing a project", () => {
  const request = (preview: { base64: string; ext: ".webp" | ".png" | ".jpg"; width: number; height: number } | null) =>
    publishRequestSchema.parse({
      publisher: { id: "studio", secret: "secret-secret" },
      pack: { id: "community", title: "Community", kind: "template" },
      entry: { fileName: "projects/black-hole.motion", name: "Black Hole" },
      fileBase64: "AAAA",
      preview,
    });

  it("files the poster beside its bundle and records its size", () => {
    const { pack } = upsertPackSource(null, request({ base64: "BBBB", ext: ".webp", width: 720, height: 1280 }), {
      id: "studio",
      name: "Studio",
    });
    expect(pack.files[0]).toMatchObject({
      file: "projects/black-hole.motion",
      preview: "projects/black-hole.poster.webp",
      width: 720,
      height: 1280,
    });
    expect(previewPathFor("projects/a.b.motion", ".png")).toBe("projects/a.b.poster.png");
  });

  it("republishing replaces the entry instead of adding a second", () => {
    const publisher = { id: "studio", name: "Studio" };
    const first = upsertPackSource(null, request(null), publisher).pack;
    const { pack, replaced } = upsertPackSource(first, request({ base64: "C", ext: ".png", width: 10, height: 10 }), publisher);
    expect(replaced).toBe(true);
    expect(pack.files).toHaveLength(1);
    expect(pack.files[0]!.preview).toBe("projects/black-hole.poster.png");
  });

  it("republishing keeps the curator's shelf order", () => {
    const publisher = { id: "studio", name: "Studio" };
    const first = upsertPackSource(null, request(null), publisher).pack;
    const placed = { ...first, files: [{ ...first.files[0]!, order: 3 }] };
    expect(upsertPackSource(placed, request(null), publisher).pack.files[0]!.order).toBe(3);
  });
});

describe("compareShelfOrder", () => {
  it("puts placed items first by order, then the rest newest first", () => {
    const items = [
      { id: "old", createdAt: 1 },
      { id: "third", createdAt: 5, order: 3 },
      { id: "new", createdAt: 9 },
      { id: "first", createdAt: 2, order: 1 },
    ];
    expect([...items].sort(compareShelfOrder).map((i) => i.id)).toEqual(["first", "third", "new", "old"]);
  });
});
