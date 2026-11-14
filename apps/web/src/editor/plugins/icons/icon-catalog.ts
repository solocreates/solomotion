"use client";

import { identity } from "@/editor/identity";
import { IconCatalogClient, ICONIFY_PUBLIC_API, type IconStore } from "@solomotion/core";
import { NAMES } from "@/editor/names";

/**
 * The editor's ONE icon catalogue client — core's headless client bound to
 * the browser: our proxy first, the public API behind it, and the Cache API
 * as the persistent store.
 *
 * Why the Cache API and not IndexedDB: what is being kept is HTTP responses
 * — JSON by URL-shaped key — and the Cache API is the browser's own store for
 * exactly that, with no schema, no versioning and eviction the platform
 * manages. A set browsed once is there offline next session. Where it does
 * not exist (a non-secure context), the client simply keeps a session memory.
 */

const CACHE_NAME = NAMES.caches.icons;
/** Keys are not URLs; they are wrapped in a synthetic origin the cache accepts. */
const KEY_ORIGIN = NAMES.caches.iconsKeyOrigin;

function cacheApiStore(): IconStore | undefined {
  if (typeof caches === "undefined") return undefined;
  const open = () => caches.open(CACHE_NAME);
  const req = (key: string) => new Request(KEY_ORIGIN + encodeURIComponent(key));
  return {
    async get(key) {
      const hit = await (await open()).match(req(key));
      return hit ? hit.text() : null;
    },
    async put(key, value) {
      await (await open()).put(req(key), new Response(value, { headers: { "content-type": "application/json" } }));
    },
  };
}

/** Our origin, when configured; the public API is always the fallback. */
const OUR_API = process.env.NEXT_PUBLIC_ICONS_API ?? identity.hosts.icons;

let client: IconCatalogClient | null = null;

export function iconCatalog(): IconCatalogClient {
  if (!client) {
    client = new IconCatalogClient({
      baseUrls: [...new Set([OUR_API, ICONIFY_PUBLIC_API].filter((u): u is string => !!u))],
      store: cacheApiStore(),
    });
  }
  return client;
}
