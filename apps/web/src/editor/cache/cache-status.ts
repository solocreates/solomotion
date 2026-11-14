"use client";

/**
 * THE CACHE ORCHESTRA — one headless registry for every cache in the app.
 *
 * The render is a stack, and so is what it keeps. Three producers, each
 * answering exactly one question, each strictly UNDER the next:
 *
 *   MEDIA      "is this source frame decoded?"        clip × SOURCE time
 *              (`stage/render/media-cache.ts`)
 *   LAYER      "are this layer's finished pixels kept?" clip × clip-local time
 *              (`stage/render/layer-cache.ts`)
 *   COMPOSITE  "is the whole frame already pixels?"   comp × comp time
 *              (`stage/render/frame-store.ts`)
 *
 * A change at one level never reaches DOWN. Editing the top layer drops the
 * composites it painted into and its own layer entries — the layers beneath
 * keep their pixels, so rebuilding the composite is a blit per untouched layer
 * and one render of the layer you changed. Decoded footage is never touched by
 * an edit at all; only a new SOURCE (a relinked file) drops it.
 *
 * ## What this module is, and is not
 *
 * It holds STATUS, never bytes. Producers own their storage and report cells
 * in and out; consumers (timeline bars, the range build, the settings panel)
 * only query. Zero React, zero DOM.
 *
 * It also owns the two things that must be ONE thing across all producers:
 *
 *  - THE SWITCH. It was stored twice — in the session (what the timeline icon
 *    showed) and here (what the caches obeyed) — and the stage's "cache work
 *    range" flipped only this one, so the icon said off while the app cached.
 *    It is stored here, persisted here, and read everywhere through
 *    `useCachingEnabled`.
 *  - THE PRODUCER LIST. Each producer registers its stats and its purge, so the
 *    settings panel, "purge everything" and any future readout enumerate them
 *    instead of importing each one by name. A fourth producer is one
 *    `registerCacheProducer` call.
 *
 * ## Subjects
 *
 * Coverage is keyed by a typed SUBJECT (`media:clip`, `layer:clip`,
 * `comp:frame`), because the same clip id legitimately has two independent
 * facts — its footage can be decoded while its graded layer is not — and one
 * untyped id space let those two overwrite each other's cells.
 *
 * Each subject's time axis is quantized onto a floor grid it declares, so every
 * producer and consumer lands on identical cells whatever instants they sample.
 */

export type ClipCachePolicy = "always" | "never" | undefined; // undefined = auto

export type CacheSubjectKind = "media" | "layer" | "comp";

/** Decoded source footage of one clip, over SOURCE time. */
export const mediaSubject = (clipId: string): string => `media:${clipId}`;
/** One layer's finished pixels, over the clip's LOCAL time. */
export const layerSubject = (clipId: string): string => `layer:${clipId}`;
/** A whole finished composite, over the comp's own time. */
export const compSubject = (frameId: string): string => `comp:${frameId}`;

const DEFAULT_BUCKET_MS = 1000 / 30;

/**
 * Per-subject cell size. A comp at 60fps that reported onto a 30fps grid would
 * paint a cell green with only half of it cached — a bar that promises pixels
 * it does not have is worse than no bar.
 */
const grids = new Map<string, number>();

/** A producer declares the grid its frames land on. Idempotent. */
export function setSubjectGrid(subject: string, cellMs: number): void {
  if (!Number.isFinite(cellMs) || cellMs <= 0) return;
  if (grids.get(subject) === cellMs) return;
  // A REGRID INVALIDATES THE CELLS. Old cells were counted against the old
  // divisor, so keeping them would leave refcounts that can never be paid back
  // and a bar that is green forever. The producer re-reports what it still has.
  grids.set(subject, cellMs);
  if (coverage.delete(subject)) bump();
}

// cell → refcount: one cell can be held several times (two tiers, two variants
// of one layer); it stays green until the LAST holder lets go.
const coverage = new Map<string, Map<number, number>>();
const policies = new Map<string, ClipCachePolicy>();
let version = 0;

const listeners = new Set<() => void>();

function bump(): void {
  version++;
  for (const cb of listeners) cb();
}

/** Notified whenever coverage, a policy, a producer or the switch changes. */
export function subscribeCacheStatus(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Monotonic change counter — cheap dirty check for canvas painters. */
export function cacheStatusVersion(): number {
  return version;
}

// ── The settings ────────────────────────────────────────────────────────────

/**
 * HOW PLAYBACK IS KEPT — one choice, never two copies of the same pixels.
 *
 *   LAYERS (default) — each top-level unit of the comp keeps its own finished
 *   pixels per instant: a group as one unit, a nested comp as one unit, never
 *   its children as well. Editing one unit rebuilds that unit; the rest are
 *   blits. The stacked cache.
 *   FRAMES — whole finished frames, the classic RAM preview. Fastest replay of
 *   a range that will not be edited; any edit drops the frames it touches.
 *
 * Both at once was the design this replaced, and it kept every pixel twice.
 */
export type PlaybackCacheMode = "layers" | "frames";

export interface CacheSettings {
  /** The master switch: may the app keep rendered work at all. */
  enabled: boolean;
  mode: PlaybackCacheMode;
  /** Decoded footage (scrub, reverse, filmstrips). */
  media: boolean;
  /** Play at speed and keep what it can (on), or make every frame first (off). */
  realtime: boolean;
  /** At the ceiling: travel with the playhead (on), or hold what is kept (off). */
  rolling: boolean;
  /**
   * Layers mode: keep a layer per instant only when it costs at least this
   * much to render (ms). Cheaper layers draw faster than a buffer pays back.
   * A steady stretch (one buffer for all of it) is always kept.
   */
  layerMinMs: number;
}

export const DEFAULT_CACHE_SETTINGS: CacheSettings = {
  // OFF until asked for. Kept frames are memory — a full-HD second is a
  // quarter of a gigabyte — and a cache nobody asked for was filling it on
  // every play of every comp. Building a work range turns it on.
  enabled: false,
  // FRAMES by default: one finished picture per instant is the simplest thing
  // that can be true, and the cheapest to hold. Layers is for editing one layer
  // of a heavy comp while the rest stays kept.
  mode: "frames",
  media: true,
  realtime: true,
  rolling: true,
  layerMinMs: 2,
};

const SETTINGS_KEY = "tm-cache-settings";
/**
 * Stored settings carry this. Before it, every write stored the whole object,
 * so an `enabled: true` saved then was the old default riding along with some
 * other change, not a choice — those load with the default instead.
 */
const SETTINGS_VERSION = 2;

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function loadSettings(): CacheSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as Partial<CacheSettings> | null;
    // The switch predates the rest; an old "off" is honoured.
    const legacyOff = localStorage.getItem("tm-timeline-caching") === "0";
    const chosen = raw && (raw as { v?: number }).v === SETTINGS_VERSION ? raw : raw ? { ...raw, enabled: undefined } : null;
    const merged = { ...DEFAULT_CACHE_SETTINGS, ...(legacyOff ? { enabled: false } : {}), ...stripUndefined(chosen ?? {}) };
    // Known fields only: a retired setting left in storage must not ride along.
    return {
      enabled: merged.enabled,
      mode: merged.mode,
      media: merged.media,
      realtime: merged.realtime,
      rolling: merged.rolling,
      layerMinMs: typeof merged.layerMinMs === "number" && merged.layerMinMs > 0 ? merged.layerMinMs : DEFAULT_CACHE_SETTINGS.layerMinMs,
    };
  } catch {
    return { ...DEFAULT_CACHE_SETTINGS };
  }
}

let settings: CacheSettings = loadSettings();

/** Notified when the master switch flips — producers purge their storage. */
const switchListeners = new Set<(on: boolean) => void>();

export function onCachingEnabledChange(cb: (on: boolean) => void): () => void {
  switchListeners.add(cb);
  return () => switchListeners.delete(cb);
}

/** The settings, as one immutable snapshot (a new object on every change). */
export function cacheSettings(): CacheSettings {
  return settings;
}

/**
 * Change any of the settings. OFF MEANS OFF: producers listening here let go
 * of what they hold when their switch or mode goes — a bar that stays green
 * after it was switched off is a lie.
 */
export function setCacheSettings(patch: Partial<CacheSettings>): void {
  const next = { ...settings, ...patch };
  if (JSON.stringify(next) === JSON.stringify(settings)) return;
  const wasOn = settings.enabled;
  settings = next;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...next, v: SETTINGS_VERSION }));
  } catch {
    // storage unavailable — the session value still applies
  }
  if (wasOn !== next.enabled) for (const cb of switchListeners) cb(next.enabled);
  bump();
}

export function resetCacheSettings(): void {
  setCacheSettings(DEFAULT_CACHE_SETTINGS);
}

export const isCachingEnabled = (): boolean => settings.enabled;
export const setCachingEnabled = (on: boolean): void => setCacheSettings({ enabled: on });
export const isRealtimePlayback = (): boolean => settings.realtime;
export const setRealtimePlayback = (on: boolean): void => setCacheSettings({ realtime: on });
export const isRollingCache = (): boolean => settings.rolling;

// ── The playback regime ─────────────────────────────────────────────────────

/**
 * LIVE or EXACT — how a running transport treats time, derived, never stored.
 *
 *   LIVE   real-time playback: the clock is the wall clock and footage plays
 *          on its own element clock. A picture made from footage is only ever
 *          as exact as that element happens to be, so nothing made from footage
 *          is kept per instant or read back beside it.
 *   EXACT  real-time playback off, or a range build: every comp frame is shown
 *          as the exact picture of its instant (see core's `exact-clock.ts`),
 *          footage included — so EVERYTHING it draws may be kept, from the
 *          bottom of the stack up.
 *
 * This used to be a separate setting ("footage in layers") that could say yes
 * while playback was live — keeping pictures that disagreed with the footage
 * beside them — and no while playback was exact, which left the bottom layer
 * uncached on every pass. Both halves were the regime, asked twice.
 */
export type PlaybackRegime = "live" | "exact";

let rangeBuild = false;

/** A range build is sweeping the transport — exact whatever the setting says. */
export function setRangeBuildActive(on: boolean): void {
  if (rangeBuild === on) return;
  rangeBuild = on;
  bump();
}

export function isRangeBuildActive(): boolean {
  return rangeBuild;
}

export function playbackRegime(): PlaybackRegime {
  return rangeBuild || (settings.enabled && !settings.realtime) ? "exact" : "live";
}
export const setRollingCache = (on: boolean): void => setCacheSettings({ rolling: on });

/** Is the whole-frame cache the playback cache right now? */
export const framesCacheOn = (): boolean => settings.enabled && settings.mode === "frames";
/** Is the per-unit layer cache the playback cache right now? */
export const layersCacheOn = (): boolean => settings.enabled && settings.mode === "layers";

/** A producer's contents changed in a way coverage cells do not describe. */
export function touchCacheStatus(): void {
  bump();
}

// ── Per-clip policy (media) ─────────────────────────────────────────────────

/** Producers push the clip's saved policy as they touch it (doc-driven). */
export function setClipCachePolicy(clipId: string, policy: ClipCachePolicy): void {
  if (policies.get(clipId) === policy) return;
  if (policy === undefined) policies.delete(clipId);
  else policies.set(clipId, policy);
  bump();
}

export function clipCachePolicy(clipId: string): ClipCachePolicy {
  return policies.get(clipId);
}

/**
 * May this clip's media be cached — written, read and shown — right now?
 *
 * ONE predicate. It used to be three (`captureAllowed`, `readsAllowed`,
 * `statusVisible`) that were word-for-word the same function under three names,
 * which is three places a future change has to remember to keep equal.
 * Per-clip overrides beat the global switch in BOTH directions.
 */
export function mediaCachingAllowed(clipId: string): boolean {
  const policy = policies.get(clipId);
  if (policy === "never") return false;
  if (policy === "always") return true;
  // Decoded footage is its OWN switch, not part of the render cache: a video
  // decoded once is worth keeping whether or not rendered pictures are.
  return settings.media;
}

// ── Coverage reports (producers) ─────────────────────────────────────────────

/**
 * The cell an instant falls in. Instants arrive rounded to the microsecond
 * (`quantizeMsToFrame` keeps three decimals), so frame 1 at 30fps is 33.333ms —
 * a hair BELOW its cell's edge at 33.333…; the old 1e-6 slack filed it under
 * cell 0 and left every third frame off the ruler bar. The slack is a
 * hundredth of a millisecond: above any rounding, far below any frame.
 */
function bucketOf(subject: string, ms: number): number {
  return Math.floor((ms + 0.01) / (grids.get(subject) ?? DEFAULT_BUCKET_MS));
}

export function reportFrameCached(subject: string, ms: number): void {
  let cells = coverage.get(subject);
  if (!cells) {
    cells = new Map();
    coverage.set(subject, cells);
  }
  const b = bucketOf(subject, ms);
  const count = cells.get(b) ?? 0;
  cells.set(b, count + 1);
  if (count === 0) bump();
}

export function reportFrameDropped(subject: string, ms: number): void {
  const cells = coverage.get(subject);
  if (!cells) return;
  const b = bucketOf(subject, ms);
  const count = cells.get(b) ?? 0;
  if (count <= 1) {
    cells.delete(b);
    if (cells.size === 0) coverage.delete(subject);
    if (count === 1) bump();
  } else {
    cells.set(b, count - 1);
  }
}

/** Everything a subject had is gone (source changed, clip deleted, producer reset). */
export function dropSubjectCoverage(subject: string): void {
  if (coverage.delete(subject)) bump();
  grids.delete(subject);
}

/** A clip left the document: its media policy goes with its coverage. */
export function forgetClip(clipId: string): void {
  dropSubjectCoverage(mediaSubject(clipId));
  dropSubjectCoverage(layerSubject(clipId));
  if (policies.delete(clipId)) bump();
}

// ── Queries (consumers) ──────────────────────────────────────────────────────

export function hasFrame(subject: string, ms: number): boolean {
  return (coverage.get(subject)?.get(bucketOf(subject, ms)) ?? 0) > 0;
}

/** Does this subject hold ANY cell? Lets a bar skip a per-pixel walk. */
export function hasAnyCoverage(subject: string): boolean {
  return (coverage.get(subject)?.size ?? 0) > 0;
}

// ── Producers ───────────────────────────────────────────────────────────────

export interface CacheProducerStats {
  bytes: number;
  /** This producer's share of the one ceiling, in bytes. */
  budget: number;
}

export interface CacheProducer {
  id: CacheSubjectKind | "posters";
  /** Short, human — the row label in the settings panel. */
  label: string;
  /** Rank in the stack, bottom first: what a panel lists and in what order. */
  order: number;
  stats(): CacheProducerStats;
  purge(): void;
  /**
   * Not part of the render cache — decoded footage. Its own switch governs it,
   * and "purge everything" (which means rendered work) leaves it alone.
   */
  independent?: boolean;
  /**
   * Made at its OWN size, not the preview resolution (timeline thumbnails) —
   * choosing a resolution leaves it alone, because nothing it holds was made
   * at the old one.
   */
  resolutionFree?: boolean;
}

const producers = new Map<string, CacheProducer>();

/** A producer joins the orchestra. Re-registering replaces (HMR-safe). */
export function registerCacheProducer(p: CacheProducer): void {
  producers.set(p.id, p);
  bump();
}

export function cacheProducers(): CacheProducer[] {
  return [...producers.values()].sort((a, b) => a.order - b.order);
}

/** Producers within this share of their allowance count as full. */
const CEILING_SHARE = 0.97;

/**
 * WHICH CACHES ARE AT THEIR CEILING — asked, never guessed. The settings panel
 * marks them; the stage says so once, with what to do about it.
 */
export function cachesAtCeiling(): CacheProducer[] {
  return cacheProducers().filter((p) => {
    const s = p.stats();
    return s.budget > 0 && s.bytes >= s.budget * CEILING_SHARE;
  });
}

/** Everything goes — every producer, one gesture. */
export function purgeAllCaches(): void {
  for (const p of producers.values()) if (!p.independent) p.purge();
  bump();
}

/** The preview resolution changed: drop only what was made at the old one. */
export function purgeResolutionBound(): void {
  for (const p of producers.values()) if (!p.independent && !p.resolutionFree) p.purge();
  bump();
}
