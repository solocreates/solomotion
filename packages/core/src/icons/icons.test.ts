import { describe, expect, it } from "vitest";
import {
  iconBodyStyle,
  iconSetAllowed,
  iconSetStyle,
  iconSvg,
  iconTags,
  parseIconId,
} from "./catalog";
import { IconCatalogClient, type IconStore } from "./client";

const STROKE_BODY =
  '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2"><path d="M3 10h18"/></g>';
const FILL_BODY = '<path fill="currentColor" d="M2 2h20v20H2z"/>';
const COLOR_BODY = '<path fill="#f00" d="M2 2h20v20H2z"/>';

describe("icon model", () => {
  it("parses ids and refuses malformed ones", () => {
    expect(parseIconId("lucide:house")).toEqual({ prefix: "lucide", name: "house" });
    expect(parseIconId("lucide:")).toBeNull();
    expect(parseIconId("house")).toBeNull();
  });

  it("gates sets by licence", () => {
    expect(iconSetAllowed({ spdx: "MIT" })).toBe(true);
    expect(iconSetAllowed({ spdx: "CC-BY-4.0" })).toBe(true);
    expect(iconSetAllowed({ spdx: "CC-BY-NC-4.0" })).toBe(false);
    expect(iconSetAllowed({ spdx: "GPL-3.0" })).toBe(false);
    expect(iconSetAllowed({ spdx: null })).toBe(false);
  });

  it("reads style off the set and off the body", () => {
    expect(iconSetStyle({ palette: false, tags: ["Uses Stroke"] })).toBe("stroke");
    expect(iconSetStyle({ palette: false, tags: [] })).toBe("fill");
    expect(iconSetStyle({ palette: true, tags: ["Uses Stroke"] })).toBe("color");
    expect(iconBodyStyle(STROKE_BODY)).toBe("stroke");
    expect(iconBodyStyle(FILL_BODY)).toBe("fill");
    expect(iconBodyStyle(COLOR_BODY)).toBe("color");
  });

  it("builds an svg at a size, in a colour, with an optional pen", () => {
    const svg = iconSvg({ body: STROKE_BODY, width: 24, height: 24, left: 0, top: 0 }, { size: 96, color: "#123456", strokeWidth: 1.5 });
    expect(svg).toContain('width="96" height="96"');
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain('color="#123456"');
    expect(svg).toContain('stroke-width="1.5"');
    // A filled body has no pen to change.
    expect(iconSvg({ body: FILL_BODY, width: 24, height: 24, left: 0, top: 0 }, { strokeWidth: 1 })).not.toContain("stroke-width");
  });

  it("derives tags — words, set, style, categories — with no duplicates", () => {
    expect(iconTags({ prefix: "lucide", name: "arrow-up-right" }, { style: "stroke" }, ["Arrows"])).toEqual([
      "arrow",
      "up",
      "right",
      "lucide",
      "stroke",
      "arrows",
    ]);
  });
});

/** A fake API: two sets, one of them unlicensed for us, a handful of icons. */
function fakeFetch(log: string[]): typeof globalThis.fetch {
  const routes: Record<string, unknown> = {
    "/collections": {
      lucide: {
        name: "Lucide",
        total: 2,
        author: { name: "Lucide" },
        license: { title: "ISC", spdx: "ISC" },
        samples: ["house"],
        height: 24,
        tags: ["Uses Stroke"],
        category: "UI 24px",
      },
      nc: { name: "Not Ours", total: 1, license: { title: "NC", spdx: "CC-BY-NC-4.0" }, samples: [] },
      hidden: { name: "Hidden", total: 1, license: { title: "MIT", spdx: "MIT" }, samples: [], hidden: true },
    },
    "/collection?prefix=lucide": {
      prefix: "lucide",
      total: 2,
      categories: { Arrows: ["arrow-up"] },
      uncategorized: ["house", "old"],
      hidden: ["old"],
    },
    "/search?query=arrow+style%3Astroke&limit=10&prefixes=lucide": {
      icons: ["lucide:arrow-up", "nc:arrow"],
      total: 2,
      limit: 10,
      start: 0,
    },
    "/lucide.json?icons=arrow-up,house": {
      prefix: "lucide",
      width: 24,
      height: 24,
      icons: { house: { body: STROKE_BODY }, "arrow-up": { body: STROKE_BODY, width: 20 } },
      aliases: { home: { parent: "house" } },
    },
    "/lucide.json?icons=home": {
      prefix: "lucide",
      width: 24,
      height: 24,
      icons: { house: { body: STROKE_BODY } },
      aliases: { home: { parent: "house" } },
    },
    "/lucide.json?icons=nope": { prefix: "lucide", icons: {}, not_found: ["nope"] },
  };
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const key = url.pathname + url.search;
    log.push(url.origin + key);
    const body = routes[key];
    if (!body) return new Response("nope", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof globalThis.fetch;
}

function memoryStore(): IconStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (k) => map.get(k) ?? null,
    put: async (k, v) => void map.set(k, v),
  };
}

describe("icon catalogue client", () => {
  it("lists only sets we may use, with style derived", async () => {
    const client = new IconCatalogClient({ fetch: fakeFetch([]) });
    const sets = await client.sets();
    expect(sets.map((s) => s.prefix)).toEqual(["lucide"]);
    expect(sets[0]!.style).toBe("stroke");
    expect(sets[0]!.height).toBe(24);
  });

  it("indexes a set, dropping hidden icons", async () => {
    const client = new IconCatalogClient({ fetch: fakeFetch([]) });
    const index = await client.index("lucide");
    expect(index.categories).toEqual([{ name: "Arrows", icons: ["arrow-up"] }]);
    expect(index.uncategorized).toEqual(["house"]);
    expect(index.all).toEqual(["arrow-up", "house"]);
  });

  it("searches with style as an API keyword and filters to allowed sets", async () => {
    const log: string[] = [];
    const client = new IconCatalogClient({ fetch: fakeFetch(log) });
    const res = await client.search({ query: "arrow", style: "stroke", prefixes: ["lucide"], limit: 10 });
    expect(res.icons).toEqual([{ prefix: "lucide", name: "arrow-up" }]);
    expect(log.some((u) => u.includes("style%3Astroke"))).toBe(true);
  });

  it("batches bodies, resolves aliases and remembers misses", async () => {
    const log: string[] = [];
    const client = new IconCatalogClient({ fetch: fakeFetch(log) });
    const got = await client.icons("lucide", ["house", "arrow-up"]);
    expect(got.get("house")?.width).toBe(24);
    expect(got.get("arrow-up")?.width).toBe(20);
    // Second ask: nothing fetched.
    const before = log.length;
    await client.icons("lucide", ["house"]);
    expect(log.length).toBe(before);
    expect(await client.icon({ prefix: "lucide", name: "home" })).not.toBeNull();
    expect(await client.icon({ prefix: "lucide", name: "nope" })).toBeNull();
  });

  it("persists what it fetched and reads it back without the network", async () => {
    const store = memoryStore();
    const log: string[] = [];
    const a = new IconCatalogClient({ fetch: fakeFetch(log), store });
    await a.sets();
    await a.icons("lucide", ["house", "arrow-up"]);
    expect(store.map.size).toBe(3);
    const offline = new IconCatalogClient({ fetch: (async () => new Response("", { status: 503 })) as typeof fetch, store });
    expect((await offline.sets()).length).toBe(1);
    expect((await offline.icon({ prefix: "lucide", name: "house" }))?.body).toBe(STROKE_BODY);
  });

  it("falls back to the next base when the first is down, and sticks to the live one", async () => {
    const log: string[] = [];
    const inner = fakeFetch(log);
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith("https://down.example")) throw new Error("offline");
      return inner(input, init);
    }) as typeof fetch;
    const client = new IconCatalogClient({ fetch: flaky, baseUrls: ["https://down.example", "https://up.example"] });
    expect((await client.sets()).length).toBe(1);
    await client.index("lucide");
    // The second request went straight to the base that answered.
    expect(log.filter((u) => u.startsWith("https://up.example")).length).toBe(2);
  });
});
