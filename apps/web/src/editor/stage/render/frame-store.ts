"use client";

import {
  PREVIEW_RESOLUTIONS,
  type PreviewResolution,
  createFrameCache,
  createFrameLedger,
  type DocumentDelta,
  type FrameContributors,
  type FrameLedger,
  type FramePayload,
} from "@solomotion/core";
import {
  compSubject,
  dropSubjectCoverage,
  layersCacheOn,
  isRollingCache,
  subscribeCacheStatus,
  onCachingEnabledChange,
  registerCacheProducer,
  reportFrameCached,
  reportFrameDropped,
  setSubjectGrid,
} from "../../cache/cache-status";
import { BUDGET_SHARE, onCacheBudgetChange, shareOfBudget } from "../../cache/memory-budget";
import type { ClipHitRect } from "./draw-frame";

/**
 * THE COMPOSITE CACHE — the top of the stack. Core's brain, holding pixels.
 *
 * Core decides WHAT is still valid (`preview/frame-cache.ts`); this decides
 * what the pixels are made of and who is told about them. The split is not
 * ceremony: invalidation is a document question with tests, storage is a
 * canvas question that cannot run in one.
 *
 * ## One tier, raw, and why the second one was deleted
 *
 * There used to be a COLD tier: frames evicted from raw storage were encoded
 * to WebP (`toBlob`) and a prefetcher decoded them back ahead of the playhead.
 * On paper, five times the range. In practice it was the reason playback got
 * heavier every time you replayed:
 *
 *   - `toBlob` on a GPU canvas is a synchronous READBACK on the main thread —
 *     megabytes per frame, paid on the very tick playback was trying to keep.
 *   - Every promoted frame entered the raw tier by evicting another, which was
 *     demoted — another readback. Steady state on a second pass: one decode
 *     and one encode PER FRAME, on top of the render.
 *   - The more you had cached, the more of it was cold, the more of that
 *     traffic there was. First pass smooth, second jittery, third heavier.
 *
 * A cache whose cost grows with how much it holds is not a cache. The frame
 * that is read during playback must already be pixels — which is exactly what
 * After Effects' RAM preview is — so there is one tier: preview-resolution
 * canvases under this producer's share of the one ceiling. The TIER (half,
 * quarter) is where the compression honestly comes from, and unlike a codec it
 * is a proportional saving in render cost too.
 *
 * ## What may enter
 *
 * Only a FAITHFUL frame: every picture it drew was the exact picture of its
 * instant (see `pictureFaults` in `media-cache.ts`). A frame drawn while a video
 * was mid-seek, or while a rolling element had drifted off the instant, is a
 * photograph of something moving and would replay as the jitter it was taken
 * with. Because only exact frames are admitted, nothing arriving from outside
 * the document ever has to invalidate one — an exact picture of an instant does
 * not go stale.
 *
 * And only a frame with CONTENT. An instant where the painter drew nothing is a
 * gap in the timeline: it is marked empty (resolved, zero bytes) instead of
 * stored, so a range build skips it and a bar does not paint it.
 *
 * `VideoEncoder` was ruled out before and still is: random access forces
 * all-intra, decode is async against a synchronous paint, and `VideoFrame` is
 * 4:2:0 with no alpha.
 */

/** The pixels of one cached composite, plus what you could click in it. */
export interface CachedFrame extends FramePayload {
  canvas: HTMLCanvasElement;
  /**
   * In the COMP'S OWN space, so the same picture can be replayed wherever the
   * comp is shown: offset onto the board by the stage, mapped through a nested
   * clip's placement by the renderer.
   */
  hits: readonly Omit<ClipHitRect, "depth">[];
  /** Who painted it — replayed into whatever frame blits it, so an edit to any
   *  of them reaches every picture that shows this one. */
  contributors: FrameContributors;
}

const budget = () => shareOfBudget(BUDGET_SHARE.composite);

/**
 * Freed backing stores, kept to be handed out again. Steady state while
 * building is "store one" per tick, and allocating a full comp canvas each time
 * is how a cache becomes a GC pause.
 */
const pool: HTMLCanvasElement[] = [];
const MAX_POOLED = 8;

function recycle(canvas: HTMLCanvasElement): void {
  if (pool.length >= MAX_POOLED) return;
  pool.push(canvas);
}

function takeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = pool.pop() ?? document.createElement("canvas");
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return canvas;
}

/**
 * THE VARIANT: what a comp's picture is made AT — the resolution and the
 * shutter, nothing about where it is seen from. The page you are on, the comp
 * you have drilled into, what is selected: none of it changes a comp's
 * picture, so none of it is in the key. That is what makes ONE store serve a
 * comp at every depth: played as the root, seen through a nested clip, or
 * drilled into — the same entries.
 *
 * A picture is WRITTEN under the run's tier and READ under it or any sharper
 * one (`serving`): a picture made sharper than a draw needs is that picture,
 * scaled down. The governor stepping a run down used to re-key everything the
 * run had kept, so a heavy comp that stepped down twice kept three disjoint
 * thirds of its loop and was served none of them — the cover's wall, measured.
 * A picture SOFTER than a draw needs is not served (`minWidth`), and the
 * sharper one replaces it.
 */
let variant = "";
/** The variants whose pictures serve this one: its own tier, then each sharper. */
let serving: readonly string[] = [];
/** Every comp this store holds pictures of — the bars of all of them. */
const knownComps = new Set<string>();

const heldIn = (compId: string, timeMs: number, vs: readonly string[]): boolean =>
  vs.some((v) => cache.has(compId, v, timeMs));
const cover = (compId: string, v: string, timeMs: number): void => {
  if (serving.includes(v)) reportFrameCached(compSubject(compId), timeMs);
};
const uncover = (compId: string, v: string, timeMs: number): void => {
  // Still held at another serving tier: still green.
  if (serving.includes(v) && !heldIn(compId, timeMs, serving)) reportFrameDropped(compSubject(compId), timeMs);
};
// Built markers say a run of THIS tier was presented — the layer buffers it
// left are that tier's, so a marker serves its own variant only.
const coverBuilt = (compId: string, v: string, timeMs: number): void => {
  if (v === variant) reportFrameCached(compSubject(compId), timeMs);
};
const uncoverBuilt = (compId: string, v: string, timeMs: number): void => {
  if (v === variant && !heldIn(compId, timeMs, serving)) reportFrameDropped(compSubject(compId), timeMs);
};

const cache = createFrameCache<CachedFrame>({
  budgetBytes: budget(),
  admission: isRollingCache() ? "roll" : "hold",
  onCover: cover,
  onUncover: uncover,
});
// Admission follows the rolling setting. The store serves nested comps in
// BOTH modes, so a mode switch does not empty it; leaving the Layers mode lets
// go of its built markers.
let wasLayers = layersCacheOn();
subscribeCacheStatus(() => {
  cache.setAdmission(isRollingCache() ? "roll" : "hold");
  const layers = layersCacheOn();
  if (wasLayers && !layers) built.clear();
  wasLayers = layers;
});

/**
 * WHICH INSTANTS ARE BUILT — in the Layers mode, where no finished frame is
 * kept to ask.
 *
 * An instant is built once the stage has presented it EXACTLY during a run: its
 * kept units are in the layer cache, and whatever was not kept is cheap enough
 * to draw live. The same core brain as the frame store, holding markers
 * instead of pixels — so an edit drops exactly the instants it reached, by the
 * same windows, and a layer evicted from memory un-builds the instants it
 * covered (`unbuildLayer`). This is what the ruler bar shows in the Layers
 * mode, and what a play press asks before deciding whether to build.
 */
interface Marker extends FramePayload {}
const built = createFrameCache<Marker>({
  budgetBytes: Number.MAX_SAFE_INTEGER,
  onCover: coverBuilt,
  onUncover: uncoverBuilt,
});
const MARKER: Marker = { bytes: 1, release: () => {} };
const layersMode = () => layersCacheOn();

/** The stage presented this instant exactly, during a run, in the Layers mode. */
export function noteBuilt(
  compId: string,
  timeMs: number,
  contributors: { clipIds: ReadonlySet<string>; frameIds: ReadonlySet<string> },
  gridMs: number,
): void {
  if (!layersMode()) return;
  knownComps.add(compId);
  setSubjectGrid(compSubject(compId), gridMs);
  built.put(compId, variant, timeMs, { ...MARKER }, {
    clipIds: new Set(contributors.clipIds),
    frameIds: new Set(contributors.frameIds),
  });
}

/** A kept layer left memory: the instants it covered are no longer built. */
export function unbuildLayer(clipId: string, compId: string, fromMs: number, toMs: number): void {
  built.invalidateSubjectIn(clipId, compId, fromMs, toMs);
}

/** The ledger the renderer fills — who painted into the frame being drawn. */
export const frameLedger: FrameLedger = createFrameLedger();

/**
 * Ids the LAYER cache served this frame, so the profile can say "cached"
 * instead of charging a blit to the layer. Cleared per frame by the stage.
 */
export const layerCacheHits = new Set<string>();

// ── The variant ─────────────────────────────────────────────────────────────

/**
 * How the stage is painting: the run's tier and shutter. Part of the KEY, never
 * a reason to clear: a person who zooms out and back, or pauses and plays, has
 * not invalidated anything.
 */
export function setFrameVariant(tier: PreviewResolution, shutter: string): void {
  const next = `${tier}|${shutter}`;
  if (next === variant) return;
  for (const comp of knownComps) dropSubjectCoverage(compSubject(comp));
  variant = next;
  serving = PREVIEW_RESOLUTIONS.slice(PREVIEW_RESOLUTIONS.indexOf(tier)).map((t) => `${t}|${shutter}`);
  for (const comp of knownComps) {
    for (const v of serving) for (const t of cache.coveredTimes(comp, v)) reportFrameCached(compSubject(comp), t);
    for (const t of built.coveredTimes(comp, variant)) reportFrameCached(compSubject(comp), t);
  }
}

/** The variant the stage is painting — for the dev cache report. */
export function currentFrameVariant(): string {
  return variant;
}

// ── Invalidation ────────────────────────────────────────────────────────────

/** A source that cannot say what it changed (a font, a surface, an engine). */
export function endFrameEpoch(): void {
  cache.clear();
  built.clear();
}

/**
 * The document changed — ONLY where the delta says it did (see
 * `core/preview/picture-change.ts`). Computed once per edit by the stage, from
 * the RAW store document, and handed to the layer cache as well.
 */
export function applyDeltaToFrameCache(delta: DocumentDelta): void {
  cache.applyDelta(delta);
  built.applyDelta(delta);
}


onCachingEnabledChange((on) => {
  if (!on) endFrameEpoch();
});

// ── Reading ─────────────────────────────────────────────────────────────────

/**
 * The variant a picture is kept under: the stage's, plus the INSTANCE SCOPE's
 * key when the comp is drawn through an instance whose inputs change it ("" =
 * the comp's own picture). Scoped pictures never paint a comp's bar — the bar
 * is the comp itself — and an edit inside drops them like any other.
 */
const variantFor = (scopeKey: string): string => (scopeKey ? `${variant}\u0001${scopeKey}` : variant);

/**
 * The picture of this comp at this instant, at least `minWidth` px wide (a
 * picture is kept at the size it was seen — see `drawCompPicture`), from this
 * run's tier or any sharper one.
 */
export function readFrame(compId: string, timeMs: number, minWidth: number, scopeKey = ""): CachedFrame | null {
  for (const v of serving) {
    const held = cache.get(compId, scopeKey ? `${v}\u0001${scopeKey}` : v, timeMs);
    if (held && held.canvas.width >= minWidth - 1) return held;
  }
  return null;
}

/** Pixels held for this instant. What the bar means by green. */
export function hasFrameAt(compId: string, timeMs: number): boolean {
  return heldIn(compId, timeMs, serving);
}

/**
 * Nothing left to do at this instant — pixels held, or nothing there to hold.
 * What a range build and "is this range ready" mean by done.
 */
export function isResolvedAt(compId: string, timeMs: number): boolean {
  return (
    heldIn(compId, timeMs, serving) ||
    serving.some((v) => cache.isEmpty(compId, v, timeMs)) ||
    (layersMode() && built.has(compId, variant, timeMs))
  );
}

/**
 * Are the next `count` instants after `timeMs` all held — kept frames under
 * Frames, built instants under Layers?
 *
 * Playback over live footage enters the cache only at the start of a RUN. A
 * cached frame is the exact picture; a live one shows the element wherever its
 * own clock has it, a frame or two away. Alternating between them — which is
 * what sparse coverage produces — is the frame jumping back and forth. Reading
 * in runs means the picture changes source once per run edge, not per frame.
 */
export function cachedRunAhead(compId: string, timeMs: number, stepMs: number, count: number): boolean {
  for (let i = 0; i <= count; i++) if (!isResolvedAt(compId, timeMs + i * stepMs)) return false;
  return true;
}

// ── Writing ─────────────────────────────────────────────────────────────────

/**
 * Keep what was just painted.
 *
 * `source` is the comp buffer, copied rather than kept: the stage reuses it for
 * the next tick. The caller has already established the frame is FAITHFUL —
 * see the header; this module no longer has a way to take a frame back.
 */
export function storeFrame(
  compId: string,
  timeMs: number,
  source: HTMLCanvasElement,
  hits: readonly Omit<ClipHitRect, "depth">[],
  contributors: { clipIds: ReadonlySet<string>; frameIds: ReadonlySet<string> },
  gridMs: number,
  /**
   * `compSteadyKey` for this instant: equal keys are identical frames, so the
   * whole steady stretch holds ONE copy. Null when anything in it moves.
   */
  steadyKey: string | null,
  /** The instance scope's key (see `variantFor`). */
  scopeKey = "",
): void {
  if (source.width < 1 || source.height < 1) return;
  const variant = variantFor(scopeKey);
  knownComps.add(compId);
  setSubjectGrid(compSubject(compId), gridMs);
  // What is stored is where the playhead is: the rolling cache gives up what
  // lies furthest behind THIS.
  cache.setFocus(compId, variant, timeMs);
  // A GAP. Nothing painted, so there is nothing to keep — resolved for free.
  if (contributors.clipIds.size === 0) {
    cache.markEmpty(compId, variant, timeMs);
    return;
  }
  // A SNAPSHOT OF THE SETS, not the sets. The ledger is reused every frame, so
  // storing it directly would leave every entry pointing at whatever the most
  // recent render happened to paint — and the reverse index would then name the
  // wrong frames on the next edit. That is a wrong picture, not a slow one.
  const refs: FrameContributors = {
    clipIds: new Set(contributors.clipIds),
    frameIds: new Set(contributors.frameIds),
  };
  const shareKey = steadyKey ? `${compId}\u0000${variant}\u0000${steadyKey}` : undefined;
  const held = shareKey ? cache.shared(shareKey) : null;
  if (held) {
    // The same picture as an instant already kept: point at it. No copy, no
    // bytes — the share is accounted once, and released by its last holder.
    cache.put(
      compId,
      variant,
      timeMs,
      { canvas: held.canvas, hits: held.hits, contributors: refs, bytes: held.bytes, release: () => {}, shareKey },
      refs,
    );
    return;
  }
  const canvas = takeCanvas(source.width, source.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0);

  cache.put(
    compId,
    variant,
    timeMs,
    { canvas, hits: hits.slice(), contributors: refs, bytes: canvas.width * canvas.height * 4, release: () => recycle(canvas), shareKey },
    refs,
  );
}

/**
 * A steady key made specific to a picture's width. Pictures are kept at the
 * size they were seen, so two holders of one steady stretch may hold it at
 * different sizes — and a share must never lend a small one to a large draw.
 */
export function withPictureSize(steadyKey: string | null, width: number): string | null {
  return steadyKey ? `${steadyKey}@${width}` : null;
}

// ── Budget, stats, purge ────────────────────────────────────────────────────

onCacheBudgetChange(() => cache.setBudget(budget()));

/** Everything goes — the project closed, or the person asked. */
export function purgeFrameCache(): void {
  endFrameEpoch();
}

export function frameCacheStats(): { bytes: number; entries: number; budget: number } {
  const s = cache.stats();
  return { bytes: s.bytes, entries: s.entries, budget: budget() };
}

registerCacheProducer({
  id: "comp",
  label: "Rendered frames",
  order: 3,
  stats: () => ({ bytes: cache.stats().bytes, budget: budget() }),
  purge: purgeFrameCache,
});
