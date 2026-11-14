"use client";

import { cacheSettings, subscribeCacheStatus } from "./cache-status";

/**
 * ONE MEMORY CEILING FOR EVERY CACHE IN THE APP.
 *
 * There were three, and none of them knew about the others: the composite cache
 * had its own, the decoded-video store had 384MB hardcoded, and the video proxy
 * store had 256MB hardcoded. That is not a tuning oversight, it is the thing
 * that made caching feel arbitrary — a person watches a bar fill and then start
 * eating its own tail, and nothing anywhere on screen explains which of three
 * invisible limits they just hit, or how to raise it.
 *
 * Worse, the three competed. A project with a video background pushed the proxy
 * store past 256MB, its LRU began dropping the oldest source cells, and the
 * clip's bar developed holes at the start while the end was still filling —
 * while the composite cache, sitting on a completely separate allowance, had
 * room to spare.
 *
 * So there is one number, the person sets it, and each producer takes a
 * declared SHARE of it. Adding a fourth cache means adding a share here, which
 * is a visible decision, rather than inventing a fourth private constant.
 *
 * ## Why shares rather than one pool
 *
 * A single pool that everyone allocates from sounds better and is worse: the
 * producers have different value per byte and different refill costs. A
 * composite frame is expensive to rebuild and cheap to keep; a decoded video
 * frame is cheap to rebuild (the file is right there) and expensive to keep.
 * First-come-first-served would let whichever cache happened to be busiest
 * starve the one whose misses hurt most. Fixed shares make that trade explicit
 * and stable instead of emergent and surprising.
 */

/** The choices offered in the UI. */
export const CACHE_BUDGET_CHOICES = [256, 512, 1024, 2048, 4096, 8192] as const;

const STORAGE_KEY = "tm-cache-budget-mb";
/**
 * The ceiling nobody set. Not derived from `deviceMemory`: browsers bucket it
 * for privacy (a 32GB machine reports 8, many report 4), so a derived default
 * quietly halved the cache on capable machines — the decoded-footage share
 * fell to a couple of dozen frames and scrubbing evicted what it had just
 * decoded. A person who sets the ceiling owns it.
 */
/**
 * …but a default that ignores the machine is how an 8 GB laptop ran out of
 * memory: two gigabytes of caches beside the GPU's share of the same unified
 * memory, the browser and a dev server. `deviceMemory` is bucketed and may only
 * UNDER-report, so it is used one way — to LOWER the default, never to raise it.
 * Someone who sets the ceiling still owns it.
 */
const DEFAULT_MB = (() => {
  const gb = typeof navigator !== "undefined" ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory : undefined;
  if (gb === undefined) return 2048;
  return gb <= 4 ? 512 : gb <= 8 ? 1024 : 2048;
})();
const MIN_MB = 256;



/**
 * How the ceiling is divided — among the caches that are ON.
 *
 * Weights, not fixed fractions: a cache that is switched off holds nothing, so
 * its share goes to the others rather than sitting empty. With the layer cache
 * as the playback cache the composite store gets nothing and the layers get
 * most of the ceiling; with frames as the playback cache it is the other way
 * round, and the layer cache keeps only a sliver — the parked editing buffers
 * it always needs. Footage and posters keep theirs while they are on.
 */
export type BudgetKey = "composite" | "layers" | "mediaProxy" | "mediaDecoded" | "posters" | "effectPreview" | "board";

/** Named, so every existing `shareOfBudget(BUDGET_SHARE.x)` reads the same. */
export const BUDGET_SHARE = {
  /** Rendered composites — the Frames playback cache. */
  composite: "composite",
  /** Finished layer pixels — the Layers playback cache, and parked editing. */
  layers: "layers",
  /** Encoded source-frame proxies: cheap per frame, and what fills a clip's bar. */
  mediaProxy: "mediaProxy",
  /** Decoded source frames, ready to draw without a seek. */
  mediaDecoded: "mediaDecoded",
  /** Timeline posters and filmstrips. Capped — see `cappedShare`. */
  posters: "posters",
  /** The effect editor's preview loop. Capped — see `EFFECT_PREVIEW_MAX_BYTES`. */
  effectPreview: "effectPreview",
  /** Retained pictures of the comps on the board you are not working in. Capped — see `BOARD_MAX_BYTES`. */
  board: "board",
} as const satisfies Record<string, BudgetKey>;

const WEIGHT: Record<BudgetKey, number> = {
  composite: 0.55,
  layers: 0.55,
  mediaProxy: 0.2,
  mediaDecoded: 0.12,
  posters: 0.05,
  effectPreview: 0.05,
  board: 0.15,
};

/** Comp pictures in the Layers mode: the nested comps only. */
const NESTED_COMPS_SHARE = 0.3;

/** Parked editing buffers only, when layers are not the playback cache. */
const LAYERS_FLOOR = 0.06;

function activeWeight(key: BudgetKey): number {
  const s = cacheSettings();
  switch (key) {
    case "composite":
      // Comp pictures serve nested comps in BOTH modes; in Frames they are the
      // whole playback cache.
      if (!s.enabled) return 0;
      return s.mode === "frames" ? WEIGHT.composite : NESTED_COMPS_SHARE;
    case "layers":
      return s.enabled && s.mode === "layers" ? WEIGHT.layers : LAYERS_FLOOR;
    case "mediaProxy":
    case "mediaDecoded":
      return s.media ? WEIGHT[key] : 0; // its own switch, not the render cache's
    case "posters":
      return WEIGHT.posters;
    case "effectPreview":
      return WEIGHT.effectPreview;
    case "board":
      return WEIGHT.board;
  }
}

/**
 * A share with a ceiling of its own.
 *
 * Not every cache should grow with the budget. Timeline posters are 64px
 * thumbnails: a few hundred of them is the entire working set, and letting them
 * scale to a share of eight gigabytes would not make the timeline better, it
 * would just hide a design mistake behind memory. Their own module says as
 * much — "if this ever needs to be large, the plan is wrong, not the budget" —
 * and that judgement is worth keeping.
 *
 * So the cap stays, but it lives HERE with every other allowance rather than as
 * a private constant nobody can see next to the others. One place to read, one
 * place to argue with.
 */
export function cappedShare(share: BudgetKey, maxBytes: number): number {
  return Math.min(shareOfBudget(share), maxBytes);
}

export const POSTER_MAX_BYTES = 64 * 1024 * 1024;

/**
 * The effect preview keeps one short loop of a box a few hundred pixels wide —
 * two variants of two seconds is ~100 frames of ~1MB. Letting it scale with an
 * eight-gigabyte budget would only hide a loop that had grown by mistake.
 */
export const EFFECT_PREVIEW_MAX_BYTES = 128 * 1024 * 1024;

/**
 * The board's pictures are the comps you can SEE: a page's worth at the
 * zoom you are at, with a thumbnail for each comp elsewhere. That is the
 * whole working set, and it does not grow with a bigger ceiling — on a small
 * one (a 4 GB machine's 512 MB) it is what keeps canvas memory from crowding
 * the GPU.
 */
export const BOARD_MAX_BYTES = 256 * 1024 * 1024;

function load(): number {
  try {
    const v = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(v) && v >= MIN_MB ? v : DEFAULT_MB;
  } catch {
    return DEFAULT_MB;
  }
}

let budgetMb = load();
const listeners = new Set<() => void>();

export function cacheBudgetMb(): number {
  return budgetMb;
}

export function cacheBudgetBytes(): number {
  return budgetMb * 1024 * 1024;
}

/** This producer's allowance, in bytes — its weight over the weights that are on. */
export function shareOfBudget(share: BudgetKey): number {
  const keys: BudgetKey[] = ["composite", "layers", "mediaProxy", "mediaDecoded", "posters", "effectPreview", "board"];
  const total = keys.reduce((n, k) => n + activeWeight(k), 0);
  return total > 0 ? (cacheBudgetBytes() * activeWeight(share)) / total : 0;
}

/**
 * Change the ceiling and tell every producer, so each can evict down to its new
 * share immediately rather than at whatever moment it next happens to store
 * something.
 */
export function setCacheBudgetMb(mb: number): void {
  if (!Number.isFinite(mb) || mb < MIN_MB || mb === budgetMb) return;
  budgetMb = mb;
  try {
    localStorage.setItem(STORAGE_KEY, String(mb));
  } catch {
    // storage unavailable — the session value still applies
  }
  for (const cb of listeners) cb();
}

// A setting that turns a cache on or off moves every share: each producer
// evicts down to its new allowance at once, exactly as for a new ceiling.
let lastSettings = cacheSettings();
subscribeCacheStatus(() => {
  const next = cacheSettings();
  if (next === lastSettings) return;
  lastSettings = next;
  for (const cb of listeners) cb();
});

export function onCacheBudgetChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
