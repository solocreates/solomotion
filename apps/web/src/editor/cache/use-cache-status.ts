"use client";

import * as React from "react";
import { DEFAULT_CACHE_SETTINGS, cacheSettings, cacheStatusVersion, subscribeCacheStatus, type CacheSettings } from "./cache-status";

/** How often cache readouts may redraw — a bar nobody reads at 60fps. */
const READOUT_MS = 250;

/**
 * The registry's change counter as React state — at most four updates a
 * second, trailing.
 *
 * It was one update per animation frame, and during playback coverage moves
 * EVERY frame (a built instant, a kept layer), so every clip's bar re-rendered
 * every frame — a nested clip's footage strip walking the whole media tree per
 * pixel — on the thread playback needs. Progress readouts update at human
 * speed; the last change always lands.
 */
export function useCacheStatusVersion(): number {
  const [v, setV] = React.useState(cacheStatusVersion);
  React.useEffect(() => {
    let timer = 0;
    const unsub = subscribeCacheStatus(() => {
      if (timer) return;
      timer = window.setTimeout(() => {
        timer = 0;
        setV(cacheStatusVersion());
      }, READOUT_MS);
    });
    return () => {
      unsub();
      if (timer) window.clearTimeout(timer);
    };
  }, []);
  return v;
}

/** The cache settings, as React state — one snapshot object, replaced on change. */
export function useCacheSettings(): CacheSettings {
  return React.useSyncExternalStore((cb) => subscribeCacheStatus(cb), cacheSettings, () => DEFAULT_CACHE_SETTINGS);
}

/** THE caching switch, as React state — the one every surface reads. */
export function useCachingEnabled(): boolean {
  return useCacheSettings().enabled;
}

