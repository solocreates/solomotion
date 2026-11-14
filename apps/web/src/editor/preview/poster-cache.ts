"use client";

import { BUDGET_SHARE, POSTER_MAX_BYTES, cappedShare, onCacheBudgetChange } from "../cache/memory-budget";
import {
  clipPictureRevision,
  compContentRevision,
  compFps,
  compRenderTimeMs,
  frameStepMs,
  posterHeightTier,
  quantizeMsToFrame,
  type MotionDocument,
  type Clip,
  type PosterSource,
  type VisualClip,
} from "@solomotion/core";
import {
  animatedImageFrameAtRaw,
  cachedAssetPicture,
  getImageForAsset,
  onMediaBanked,
} from "../stage/render/media-cache";
import { registerCacheProducer } from "../cache/cache-status";
import { drawClipPoster, drawFrameContent } from "../stage/render/draw-frame";
import { onSurfaceReady } from "../drawing/raster-store";
import { backgroundLane } from "../runtime/background-lane";
import { videoThumbAt } from "./video-thumbs";

/**
 * THE poster store — one place that turns core's poster PLAN into pictures and
 * keeps them, for every surface that wants to show what a clip looks like:
 * timeline clip strips, flipbook cells and their ghost repeats, drawing
 * previews, and whatever comes next.
 *
 * Three rules hold the whole thing up.
 *
 * **A picture is identified by its SOURCE, not by the clip showing it.** The
 * key is `(source, revision, height tier, source frame)`. None of those four
 * mentions zoom, scroll, the clip's position, its length, its trim or its
 * speed — so panning, zooming, trimming, sliding and duplicating re-plan and
 * hit every entry they already had, ten instances of a component share one set
 * of bitmaps, and a ⌥-drag duplicate costs nothing. Keying by clip and by
 * requested millisecond (the obvious shape) would mint a fresh key on every
 * pixel of every gesture: a cache with a hit rate of zero that only grows.
 *
 * **Revalidation is by revision, never by timer.** Comps and layers carry a
 * content hash from core (`compContentRevision` / `clipPictureRevision`)
 * memoized per immutable document, so "did this change" is a string compare
 * during render. Edit a drawing and exactly its cells re-render; edit nothing
 * and nothing does. No debounce, no dirty flags, no staleness windows, and no
 * race — the hash is pure and the documents are frozen.
 *
 * **Off frees, it does not merely hide.** `setPostersEnabled(false)` closes
 * every bitmap and empties the queue, and the TIMELINE — the consumer that
 * asks for hundreds of pictures — stops asking (`postersVisibleAt`). That is
 * what makes it honest to leave on by default: the switch gives the memory
 * back rather than parking it for a switch-on that may never come.
 *
 * The store itself never refuses a read, and that is deliberate. A flipbook
 * sheet's cells ARE its content, not a decoration on top of it; a preference
 * about the timeline must not blank the workspace that replaced the timeline.
 * The two are never on screen at once, and a sheet's few dozen visible cells
 * are bounded by the LRU like anything else.
 *
 * Production is asynchronous, deduplicated per key, served NEWEST-FIRST, and
 * owned by DEMAND: a job exists only while a surface on screen still wants it,
 * and starts only when the app's background lane grants a permit (one
 * synchronous render at a time, paced by its measured cost, never during
 * playback or a gesture). The plan it serves is windowed to the screen and
 * thinned by each source's measured cost, so the work a page costs to open is
 * the work you can see — however much the comps behind it contain.
 */

// ── Budget ───────────────────────────────────────────────────────────────────

/**
 * Posters are thumbnails, so this is small on purpose — a few hundred 64px
 * pictures, not the hundreds of megabytes the video frame cache runs at. If it
 * ever needs to be large, the plan is wrong, not the budget.
 *
 * That judgement is unchanged; where it is WRITTEN has changed. It is a CAPPED
 * SHARE of the app's one memory ceiling now (`cache/memory-budget.ts`) rather
 * than a private constant, so every allowance in the app can be read in one
 * place and none of them can quietly compete with the others.
 */
const MAX_BYTES = () => cappedShare(BUDGET_SHARE.posters, POSTER_MAX_BYTES);
/**
 * How many pictures may be FINISHING at once. Only the asynchronous tail
 * overlaps (`createImageBitmap`, a footage seek); the synchronous part — a
 * comp render — is serialised app-wide by the background lane, because three
 * concurrent synchronous renders on one thread are one long task three times
 * as long.
 */
const MAX_IN_FLIGHT = 3;
/** Requests nobody re-asks for are trimmed past this; they come back if seen. */
const MAX_QUEUED = 256;

interface Entry {
  bitmap: ImageBitmap;
  bytes: number;
  lastUse: number;
  /** Cache namespace, so a revision change can drop a whole source at once. */
  sourceKey: string;
  rev: string;
  family: string;
  sourceMs: number;
}

const entries = new Map<string, Entry>();
/**
 * Entries grouped by FAMILY — one source, revision and height tier — keyed by
 * source ms. What lets a tile still being made show its nearest neighbour
 * (`posterNearest`) instead of a hole while you zoom.
 */
const families = new Map<string, Map<number, string>>();
const familyOf = (sourceKey: string, rev: string, tier: number) => `${sourceKey}|${rev}|${tier}`;

function forget(entry: Entry): void {
  const fam = families.get(entry.family);
  if (fam) {
    fam.delete(entry.sourceMs);
    if (fam.size === 0) families.delete(entry.family);
  }
}
let bytes = 0;
let tick = 0;
let version = 0;
let enabled = true;

const inFlight = new Set<string>();
/**
 * WANTED pictures, oldest first; served newest-first. A job lives only while
 * someone on screen wants it: a surface that repaints re-declares exactly the
 * pictures it is still missing, and one that unmounts (a page switch, a clip
 * scrolled away, a sheet closed) withdraws its demand — so navigating away
 * CANCELS work instead of leaving hundreds of renders queued behind you.
 */
const queue = new Map<string, PosterJob>();
/** A lane permit has been asked for and not yet used. */
let permitPending = false;
const listeners = new Set<() => void>();

interface PosterJob {
  key: string;
  request: ResolvedRequest;
  /** Who still wants it. `null` = an anonymous ask, wanted until served. */
  owners: Set<object> | null;
}

function bump(): void {
  version++;
  for (const cb of listeners) cb();
}

/** Notified whenever a picture lands, or the switch flips. */
export function subscribePosters(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Monotonic change counter — the cheap dirty check for canvas painters. */
export function postersVersion(): number {
  return version;
}

// ── The switch ───────────────────────────────────────────────────────────────

export function postersEnabled(): boolean {
  return enabled;
}

/**
 * Turn posters on or off. Off frees everything immediately — this is the whole
 * point of the setting, so it must not leave the bitmaps parked "just in case".
 */
export function setPostersEnabled(on: boolean): void {
  if (enabled === on) return;
  enabled = on;
  if (!on) clearPosters();
  else bump();
}

/** Drop and free every cached picture and every queued job. */
export function clearPosters(): void {
  for (const entry of entries.values()) entry.bitmap.close();
  entries.clear();
  families.clear();
  queue.clear();
  bytes = 0;
  bump();
}

/** Free one source's pictures — an asset relink, a deleted comp. */
export function dropPosterSource(sourceKey: string): void {
  let changed = false;
  for (const [key, entry] of entries) {
    if (entry.sourceKey !== sourceKey) continue;
    entries.delete(key);
    forget(entry);
    bytes -= entry.bytes;
    entry.bitmap.close();
    changed = true;
  }
  if (changed) bump();
}

// ── Requests ─────────────────────────────────────────────────────────────────

export interface PosterQuery {
  doc: MotionDocument;
  /**
   * The clip asking. Only the producers that need it read it: an `asset`
   * poster branches on its kind, a `layer` poster IS it. A `comp` poster has
   * no clip — a flipbook cell's picture is a picture of a comp, and asking a
   * caller to invent a clip to get one would be a lie in the type.
   */
  clip?: Clip;
  source: PosterSource;
  /** Source time of the picture — a tile's `sourceMs`, already frame-snapped. */
  sourceMs: number;
  /** Lane height in px; snapped to a tier so a zoom gesture cannot thrash. */
  heightPx: number;
  /**
   * A `layer` picture framed on THIS box (comp px about the frame's centre)
   * instead of its own silhouette — a pose tile showing the eyes, not the whole
   * character. Name it in `source.key` too: the key is what the store caches by.
   */
  focus?: { minX: number; minY: number; maxX: number; maxY: number };
}

interface ResolvedRequest extends PosterQuery {
  tier: number;
  rev: string;
}

/**
 * What invalidates this source's pictures.
 *
 * An asset's bytes are immutable — a relink mints a NEW asset id, and an
 * in-place re-import calls `dropPosterSource` — so its revision is empty and
 * its pictures are cached until evicted. Comps and layers are edited in place,
 * so they carry a content hash.
 */
function revisionOf(req: PosterQuery): string {
  if (req.source.kind === "comp") return compContentRevision(req.doc, req.source.id);
  if (req.source.kind === "layer") return clipPictureRevision(req.doc, req.source.id);
  return "";
}

function keyOf(req: ResolvedRequest): string {
  return `${req.source.key}|${req.rev}|${req.tier}|${Math.round(req.sourceMs)}`;
}

/**
 * The picture for one request, or null when it is not ready.
 *
 * Never throws, never blocks, never decodes on the calling thread: a miss
 * schedules the work and returns null, and the caller repaints when
 * `subscribePosters` fires. Callers should draw nothing for a null rather than
 * a placeholder — a clip that fills in as its pictures arrive reads as
 * progress, and a grid of grey rectangles reads as breakage.
 */
export function posterAt(req: PosterQuery, owner?: object): ImageBitmap | null {
  const resolved: ResolvedRequest = {
    ...req,
    tier: posterHeightTier(req.heightPx),
    rev: revisionOf(req),
  };
  const key = keyOf(resolved);
  const hit = entries.get(key);
  if (hit) {
    hit.lastUse = ++tick;
    return hit.bitmap;
  }
  // A source whose revision moved on: its old pictures can never be asked for
  // again, so free them now rather than waiting for the LRU to notice.
  if (resolved.rev) evictStaleRevisions(resolved.source.key, resolved.rev);
  schedule(key, resolved, owner);
  return null;
}

/**
 * The closest picture ALREADY MADE of the same source, revision and size —
 * never schedules anything. A strip draws it under a tile whose own picture is
 * still coming, so a zoom shows the nearest frame for a beat instead of a
 * hole: what every NLE does while its filmstrip refines.
 */
export function posterNearest(req: PosterQuery): ImageBitmap | null {
  const fam = families.get(familyOf(req.source.key, revisionOf(req), posterHeightTier(req.heightPx)));
  if (!fam) return null;
  const want = Math.round(req.sourceMs);
  let best: string | null = null;
  let bestD = Infinity;
  for (const [ms, key] of fam) {
    const d = Math.abs(ms - want);
    if (d < bestD) (bestD = d), (best = key);
  }
  return best ? (entries.get(best)?.bitmap ?? null) : null;
}

/**
 * Withdraw everything `owner` asked for. A surface calls this at the start of
 * each paint (it is about to re-declare what it still needs) and on unmount;
 * a job nobody wants any more is dropped before it costs a render.
 */
export function releasePosterDemand(owner: object): void {
  for (const [key, job] of queue) {
    if (!job.owners?.delete(owner)) continue;
    if (job.owners.size === 0) queue.delete(key);
  }
}

/**
 * A picture of a COMP at a comp time — the door for surfaces that think in
 * comps rather than clips: flipbook cells and their ghost repeats, drawing
 * previews, component cards.
 *
 * The same store, the same revision key and the same producer as a nested
 * clip's filmstrip tile, which is the point: paint a stroke and the cell in
 * the sheet, the ghost repeat beside it and the nested clip's tile on the
 * parent timeline all re-render together, because they were never three
 * caches to begin with.
 */
export function compPosterAt(
  doc: MotionDocument,
  frameId: string,
  timeMs: number,
  heightPx: number,
  owner?: object,
): ImageBitmap | null {
  const frame = doc.frames.find((f) => f.id === frameId);
  if (!frame) return null;
  return posterAt({
    doc,
    source: {
      kind: "comp",
      id: frameId,
      key: `comp:${frameId}`,
      mode: "strip",
      stepMs: frameStepMs(compFps(doc, frameId)),
      aspect: frame.width > 0 && frame.height > 0 ? frame.width / frame.height : null,
    },
    // On the comp's own grid, so a cell thumbnail and a timeline tile of the
    // same instant resolve to the same key instead of two near-identical ones.
    sourceMs: compRenderTimeMs(doc, frameId, timeMs),
    heightPx,
  }, owner);
}

function evictStaleRevisions(sourceKey: string, currentRev: string): void {
  for (const [key, entry] of entries) {
    if (entry.sourceKey !== sourceKey || entry.rev === currentRev) continue;
    entries.delete(key);
    forget(entry);
    bytes -= entry.bytes;
    entry.bitmap.close();
  }
}

// ── Production ───────────────────────────────────────────────────────────────

function schedule(key: string, request: ResolvedRequest, owner: object | undefined): void {
  if (inFlight.has(key)) return;
  const queued = queue.get(key);
  if (queued) {
    // Re-asked: it is the newest thing on screen again.
    queue.delete(key);
    if (owner) (queued.owners ??= new Set()).add(owner);
    else queued.owners = null;
    queue.set(key, queued);
  } else {
    queue.set(key, { key, request, owners: owner ? new Set([owner]) : null });
    // Bounded: the oldest asks are the ones that scrolled away first.
    while (queue.size > MAX_QUEUED) queue.delete(queue.keys().next().value!);
  }
  pump();
}

/** Ask the lane for ONE permit when there is work and room to finish it. */
function pump(): void {
  if (permitPending || inFlight.size >= MAX_IN_FLIGHT || queue.size === 0) return;
  permitPending = true;
  backgroundLane().request(runNext);
}

/** The permit: serve the NEWEST wanted request. Its sync part is the lane's to charge. */
function runNext(): Promise<void> | void {
  permitPending = false;
  let job: PosterJob | undefined;
  for (const key of queue.keys()) job = queue.get(key); // newest = last inserted
  if (!job) return;
  queue.delete(job.key);
  if (entries.has(job.key)) return void pump();
  inFlight.add(job.key);
  return run(job);
}

async function run(job: PosterJob): Promise<void> {
  let bitmap: ImageBitmap | null = null;
  const sourceKey = job.request.source.key;
  try {
    const start = performance.now();
    const pending = produce(job.request);
    // The SYNCHRONOUS part is the price a person feels — a comp render, a
    // downscale copy — and it is what decides how dense this source's strips
    // may be (`posterTileFloorPx`). An async tail (a footage seek) is free.
    noteSourceCost(sourceKey, performance.now() - start);
    // The next permit may be asked for now: the thread is free again.
    pumpSoon();
    bitmap = await pending;
  } catch {
    // A poster is decoration: a producer that fails leaves the clip flat.
    bitmap = null;
  }
  inFlight.delete(job.key);
  if (!bitmap) {
    pump();
    return;
  }
  // A clear (or another job on the same key) may have landed while we drew.
  if (entries.has(job.key) || !enabled) {
    bitmap.close();
    pump();
    return;
  }
  const size = bitmap.width * bitmap.height * 4;
  const family = familyOf(sourceKey, job.request.rev, job.request.tier);
  const sourceMs = Math.round(job.request.sourceMs);
  entries.set(job.key, {
    bitmap,
    bytes: size,
    lastUse: ++tick,
    sourceKey,
    rev: job.request.rev,
    family,
    sourceMs,
  });
  let fam = families.get(family);
  if (!fam) families.set(family, (fam = new Map()));
  fam.set(sourceMs, job.key);
  bytes += size;
  evict();
  bump();
  pump();
}

function pumpSoon(): void {
  queueMicrotask(pump);
}

// ── Cost: how dense a source's strips may be ─────────────────────────────────

/**
 * What one picture of each source costs to make, smoothed. Measured, never
 * guessed: a comp's weight is a fact about its content AND this machine, and
 * the first render tells us both. Survives clears (a source's cost does not
 * change because its pictures were dropped).
 */
const sourceCosts = new Map<string, number>();
const costListeners = new Set<() => void>();
let costsVersion = 0;

function noteSourceCost(sourceKey: string, ms: number): void {
  const prev = sourceCosts.get(sourceKey);
  const next = prev === undefined ? ms : prev * 0.6 + ms * 0.4;
  sourceCosts.set(sourceKey, next);
  // Surfaces re-plan only when the DENSITY a cost implies moves a whole
  // power-of-two band — so a noisy measurement cannot thrash every strip.
  if (prev === undefined || costBand(prev) !== costBand(next)) {
    costsVersion++;
    for (const cb of costListeners) cb();
  }
}

/** Log2 band of a cost, so density re-plans happen at band edges only. */
function costBand(ms: number): number {
  return ms <= 1 ? 0 : Math.ceil(Math.log2(ms));
}

/** The smoothed per-picture cost of a source, rounded UP to its band. */
export function posterSourceCostMs(sourceKey: string): number | null {
  const ms = sourceCosts.get(sourceKey);
  return ms === undefined ? null : 2 ** costBand(ms);
}

export function subscribePosterCosts(cb: () => void): () => void {
  costListeners.add(cb);
  return () => costListeners.delete(cb);
}

export function posterCostsVersion(): number {
  return costsVersion;
}

// The ceiling moved — come down to the new share at once, rather than at
// whatever moment this store next happens to write something.
onCacheBudgetChange(() => evict());

function evict(): void {
  const limit = MAX_BYTES();
  while (bytes > limit && entries.size > 0) {
    let victimKey: string | null = null;
    let victimUse = Infinity;
    for (const [key, entry] of entries) {
      if (entry.lastUse < victimUse) {
        victimUse = entry.lastUse;
        victimKey = key;
      }
    }
    if (!victimKey) return;
    const gone = entries.get(victimKey)!;
    entries.delete(victimKey);
    forget(gone);
    bytes -= gone.bytes;
    gone.bitmap.close();
  }
}

// ── Producers ────────────────────────────────────────────────────────────────
//
// One per `PosterSource.kind`. This is the extension point: a new kind of
// preview — a post-effects render, a server-side proxy, a plugin-provided
// thumbnail — is one entry here plus one `PosterSource.kind`, and the plan,
// the store, the invalidation and every surface pick it up unchanged.

type Producer = (req: ResolvedRequest, box: Box) => Promise<ImageBitmap | null> | ImageBitmap | null;

interface Box {
  width: number;
  height: number;
}

/** The pixel box a picture is drawn into: the tier's height at the source's aspect. */
function boxFor(req: ResolvedRequest): Box {
  const aspect = req.source.aspect && req.source.aspect > 0 ? req.source.aspect : 16 / 9;
  return {
    width: Math.max(1, Math.round(req.tier * aspect)),
    height: req.tier,
  };
}

function produce(req: ResolvedRequest): Promise<ImageBitmap | null> | ImageBitmap | null {
  return PRODUCERS[req.source.kind](req, boxFor(req));
}

const PRODUCERS: Record<PosterSource["kind"], Producer> = {
  /**
   * An imported file. Three media paths, and the interesting one is video:
   * a frame a playthrough already banked is reused for free; any other is
   * decoded on the THUMBNAIL decoder (`video-thumbs.ts`) — its own element,
   * one seek at a time, only for tiles on screen, only through the lane. So a
   * filmstrip appears the moment footage lands, as in every NLE, and still
   * never competes with the stage for a decoder.
   */
  asset: async (req, box) => {
    if (req.clip?.kind === "video") {
      // A frame playback already banked is free; otherwise decode it on the
      // thumbnail decoder — a private element, never the stage's.
      const cached = cachedAssetPicture(req.source.id, req.sourceMs);
      if (!cached) return videoThumbAt(req.source.id, assetMime(req.doc, req.source.id), req.sourceMs, box);
      const src = "blob" in cached ? cached.blob : cached.bitmap;
      return createImageBitmap(src, { resizeWidth: box.width, resizeHeight: box.height, resizeQuality: "medium" });
    }
    if (req.clip?.kind !== "image") return null;
    const frame = animatedImageFrameAtRaw(req.source.id, req.sourceMs);
    if (frame) {
      return createImageBitmap(frame, { resizeWidth: box.width, resizeHeight: box.height, resizeQuality: "medium" });
    }
    // A still. `getImageForAsset` kicks the decode on a miss and notifies
    // through `onMediaReady`, which the surfaces already listen to, so a null
    // here resolves itself on the next repaint.
    const img = getImageForAsset(req.source.id, assetMime(req.doc, req.source.id));
    if (!img || !img.complete || img.naturalWidth === 0) return null;
    return createImageBitmap(img, { resizeWidth: box.width, resizeHeight: box.height, resizeQuality: "medium" });
  },

  /**
   * A comp — a nested clip's source, a flipbook cell's drawing, a component
   * master. Rendered through `drawFrameContent`, the one render contract, so a
   * poster is pixel-identical to the canvas at that instant. It quantizes to
   * the comp's OWN rate internally, which is what makes a 12fps sheet's
   * posters land on twelves inside a 60fps parent with nothing here knowing
   * about frame rates at all.
   */
  comp: async (req, box) => {
    const frame = req.doc.frames.find((f) => f.id === req.source.id);
    if (!frame) return null;
    const { canvas, ctx } = surface(box.width, box.height);
    if (!ctx) return null;
    ctx.scale(box.width / frame.width, box.height / frame.height);
    // The comp renders at the poster's SOURCE time — `drawFrameContent`
    // quantizes that onto the comp's own rate, which is the whole reason a
    // 12fps sheet's posters land on twelves inside a 60fps parent without a
    // word about frame rates anywhere in this module.
    // A poster is a thumbnail: rasterise its effects at the size it is actually
    // drawn, not at the comp's full resolution.
    drawFrameContent(ctx, req.doc, frame, req.sourceMs, { renderScale: box.width / frame.width, exporting: true });
    return createImageBitmap(canvas);
  },

  /**
   * The clip itself — a pixel layer today. Fitted to its own silhouette by
   * `drawClipPoster`, so a small layer in a large comp reads instead of being
   * a speck.
   *
   * `sourceMs` is CLIP-LOCAL here, because a layer source's "source time" is
   * its own local time (`clipSourcePhaseAt` passes local time straight through
   * for a clip with no playback). That is what makes a keyframed layer honest:
   * the plan cuts a tile per animated frame and each one renders that instant,
   * so a paint layer fading or shifting colour SHOWS it. A layer with nothing
   * animated plans to a single tile at local 0 and costs one draw.
   */
  layer: async (req, box) => {
    const clip = req.clip;
    if (!clip) return null;
    const frame = req.doc.frames.find((f) => f.id === clip.frameId);
    if (!frame) return null;
    const { canvas, ctx } = surface(box.height, box.height);
    if (!ctx) return null;
    const at = clip.startMs + Math.min(req.sourceMs, Math.max(0, clip.durationMs - 1));
    if (!drawClipPoster(ctx, req.doc, frame, clip as VisualClip, at, box.height, box.height, 0, req.focus)) return null;
    return createImageBitmap(canvas);
  },
};

function assetMime(doc: MotionDocument, assetId: string): string | undefined {
  return doc.assets.find((a) => a.id === assetId)?.mime;
}

/**
 * A fresh canvas per picture.
 *
 * Deliberately not a reused scratch: production is concurrent (`MAX_IN_FLIGHT`
 * jobs draw, then await `createImageBitmap`), and a shared canvas would let
 * the next job overwrite pixels the previous one had not finished snapshotting
 * — the classic "every third thumbnail is the wrong clip" bug. Allocation only
 * happens on a cache MISS, which after the first paint is rare by design, and
 * a 128px canvas is a rounding error next to the draw it exists for.
 */
function surface(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D | null } {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return { canvas, ctx: canvas.getContext("2d") };
}

/**
 * Raster pixels streaming in from disk are the ONE change no revision can see:
 * a paint surface's bytes are not part of the document, so a comp containing
 * one renders identically-keyed before and after its pixels arrive — the
 * picture cached in between is a real miss dressed as a hit.
 *
 * Only RENDERED pictures can contain a surface (comps and layers); a file's
 * pictures cannot, so footage and image strips survive. Coalesced to one drop
 * per animation frame: a project opening streams in dozens of surfaces, and a
 * live brush pokes this on every move.
 */
let surfaceDrop = 0;
onSurfaceReady(() => {
  if (surfaceDrop !== 0) return;
  surfaceDrop = requestAnimationFrame(() => {
    surfaceDrop = 0;
    let changed = false;
    for (const [key, entry] of entries) {
      if (entry.sourceKey.startsWith("asset:")) continue;
      entries.delete(key);
      forget(entry);
      bytes -= entry.bytes;
      entry.bitmap.close();
      changed = true;
    }
    if (changed) bump();
  });
});

/**
 * Footage posters are read out of the media cache's banked frames, so a frame
 * banked is a filmstrip tile that can now be drawn. Through the low-rate
 * banking channel, never the picture channel: a playing video banks many
 * frames a second, and none of them changes a picture on the stage.
 */
onMediaBanked(bump);

registerCacheProducer({
  id: "posters",
  label: "Timeline thumbnails",
  order: 4,
  resolutionFree: true,
  stats: () => ({ bytes, budget: MAX_BYTES() }),
  purge: clearPosters,
});
