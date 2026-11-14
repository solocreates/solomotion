"use client";

import { pictureReadsSlotTokens, stackPrefixUnchanged, traceSamplesOf, type MotionDocument, type Clip, type DocumentDelta, type TimeSpans } from "@solomotion/core";
import {
  cacheSettings,
  isRollingCache,
  playbackRegime,
  layersCacheOn,
  registerCacheProducer,
  subscribeCacheStatus,
  touchCacheStatus,
} from "../../cache/cache-status";
import { BUDGET_SHARE, onCacheBudgetChange, shareOfBudget } from "../../cache/memory-budget";
import type { ClipHitRect } from "./draw-frame";
import { unbuildLayer } from "./frame-store";
import { replayPicture } from "./media-cache";

/**
 * THE LAYER CACHE — the middle of the stack: one layer's finished pixels.
 *
 * Everything below `withLayer()` — the effect stack, the feather, the
 * rasterisation — produces one buffer, and this keeps it. It is what makes a
 * change to the TOP of a comp cheap to rebuild: the composite is invalidated
 * (it really did change), but every layer that did not change is a blit, and
 * only the layer you touched renders. See `cache/cache-status.ts` for the
 * stack as a whole.
 *
 * ## The key is identity plus declared inputs, never a signature
 *
 * The store is immer, so an untouched clip keeps its object identity and an
 * edited one does not: a stale entry is unreachable by construction. Everything
 * that is NOT the clip object is enumerated in the key by the caller — the
 * buffer's placement and scale, the draw mode, the effect clock and, for a
 * material, the key of the backdrop it refracts. A layer that does not read
 * what is behind it has nothing about the layers beneath it in its key, so
 * editing a layer below an opaque image or video never touches that image's
 * pixels. Only glass-like materials, which genuinely see through, carry their
 * backdrop.
 *
 * ## Time: the instant, or the steady SEGMENT
 *
 * The key's time term is the instant — or, when the layer is provably holding
 * still there (`layerPictureSegment`), the steady segment it sits in. A still
 * graded background under ten seconds of animation is then ONE entry instead
 * of three hundred.
 *
 * ## An edit re-attaches what it did not change
 *
 * Identity alone would throw away every instant of a clip when one keyframe
 * moves. `applyDelta` reads the SAME change analysis the frame cache does
 * (`core/preview/picture-change.ts`): entries outside the edit's window are
 * re-attached to the new clip object, entries inside it are dropped. For
 * containers and glass the same question is asked of every clip they are made
 * of, in comp time. One analysis, so the two caches cannot disagree about
 * where an edit landed.
 *
 * ## When it keeps things
 *
 * Parked: every isolated layer, because the next twenty renders are of the same
 * instant. Playing (or building a range): only layers that are EXPENSIVE — a
 * per-instant buffer of a cheap layer is memory spent to save nothing — or
 * STEADY, where one buffer serves the whole segment. And playing admits only
 * while there is room: it never evicts the range it is building to make room
 * for more of it.
 *
 * Nothing is committed that the media layer says was not faithful — see
 * `pictureFaults`. Parked accepts a stable-but-inexact frame (a video frozen
 * where playback stopped is what is on screen, and stays there); a range never
 * does.
 */

interface Entry {
  /** The clip this was rendered from. Identity IS the validity check. */
  clip: Clip;
  key: string;
  /** Objects that must still be the same objects — a container's contents, a material's backdrop. */
  refs: unknown[];
  generation: number;
  canvas: HTMLCanvasElement;
  rect: { x: number; y: number; w: number; h: number };
  hits: readonly HitRectLike[];
  bytes: number;
  used: number;
  /** Clip-local instants this entry is the picture of: one, or a steady segment. */
  from: number;
  to: number;
  /** Shown on the bar? Only the stage's own pass is — not posters, not spill. */
  reported: boolean;
  /** The comp's frame step, so an instant covers its frame on the bar. */
  grid: number;
  /**
   * Every picture this was made from was the exact picture of its instant.
   * An exact entry cannot go stale from outside the document — a video landing
   * a new frame is news only for entries kept from a frame that was NOT the
   * instant's (footage frozen where playback stopped).
   */
  exact: boolean;
  /** Made from footage: live playback neither keeps nor reads it (see `playbackRegime`). */
  footage: boolean;
  /** Kept by a PAUSED render — the editing working set, see `dropParkedLayers`. */
  parked: boolean;
  /** The key with its resolution taken out — see `readLayerCacheAnyScale`. */
  family: string;
}

/**
 * A rect as the renderer emits it, BEFORE the hit space maps it to world.
 * A type-only import of the renderer's own shape, erased at runtime.
 */
export type HitRectLike = Omit<ClipHitRect, "depth">;

/**
 * Keyed by CLIP ID PLUS RENDER KEY: a layer is drawn more than once per frame
 * (the inside pass and the spill, a matte, an export), and one slot per clip
 * would make those variants evict each other every frame.
 */
const entries = new Map<string, Entry>();
const slotOf = (clipId: string, key: string) => `${clipId}\u0000${key}`;
let totalBytes = 0;
let useClock = 0;

const budget = () => shareOfBudget(BUDGET_SHARE.layers);

/**
 * Bumped by what changes a render without changing a clip AND cannot say which
 * layer it changed: a font loading, a paint surface arriving, an effect
 * engine's chunk landing. Media is NOT here any more — it names its clip, and
 * `invalidateLayersShowing` drops exactly the layers that painted it.
 */
let renderGeneration = 0;
export function invalidateLayerCache(): void {
  renderGeneration++;
}

// ── Coverage ────────────────────────────────────────────────────────────────

/**
 * WHAT THE BAR SHOWS IS DERIVED FROM WHAT IS HELD — never bookkept beside it.
 *
 * Coverage used to be reported cell by cell into the registry and taken back
 * cell by cell on drop, and any asymmetry between the two (an entry re-attached
 * to a clip, a grid that moved) left a refcount that could never be paid back:
 * a bar that stayed green after Purge. Now the bar asks for the spans of the
 * entries that exist. Nothing to leak.
 */
let contentVersion = 0;
const spansMemo = new Map<string, { version: number; spans: Array<[number, number]> }>();

function changed(): void {
  contentVersion++;
  touchCacheStatus();
}

/** Clip-local spans this clip's kept pixels cover, merged and ascending. */
export function layerCoverageSpans(clipId: string): ReadonlyArray<readonly [number, number]> {
  const hit = spansMemo.get(clipId);
  if (hit && hit.version === contentVersion) return hit.spans;
  const raw: Array<[number, number]> = [];
  for (const e of entries.values()) {
    if (e.clip.id !== clipId || !e.reported) continue;
    const lo = Math.max(0, e.from);
    const hi = Math.min(e.clip.durationMs, e.to);
    if (hi < lo) continue;
    // One instant covers its whole frame on the bar.
    raw.push([lo, e.from === e.to ? lo + e.grid : hi]);
  }
  raw.sort((a, b) => a[0] - b[0]);
  const spans: Array<[number, number]> = [];
  for (const [a, b] of raw) {
    const last = spans[spans.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else spans.push([a, b]);
  }
  spansMemo.set(clipId, { version: contentVersion, spans });
  return spans;
}

function drop(slot: string): void {
  const e = entries.get(slot);
  if (!e) return;
  entries.delete(slot);
  totalBytes -= e.bytes;
  changed();
  // The backing store is NOT zeroed, deliberately. Eviction runs from
  // `commit`, part-way up a nested render — a group commits after its
  // children — so a canvas being dropped may be one an outer frame is still
  // about to composite. Dropping the reference is enough; GC owns the rest.
}

// ── What a layer costs ──────────────────────────────────────────────────────

/** Smoothed render cost per clip (full resolution), measured on misses only. */
const costs = new Map<string, number>();

export function noteLayerCost(clipId: string, ms: number): void {
  const prev = costs.get(clipId);
  costs.set(clipId, prev === undefined ? ms : prev * 0.7 + ms * 0.3);
}

// ── Admission ───────────────────────────────────────────────────────────────

/**
 * May this layer be READ from the cache at all? Identity is the validity check,
 * so the only layer refused is one whose pixels move while its clip object
 * stands still: a slot token resolved at paint time, in it or in anything it
 * holds (core `pictureReadsSlotTokens`, which says why that is the whole rule).
 * A DRIVEN clip is baked into a fresh object per instant and needs no gate.
 */
export function layerCacheReadable(doc: MotionDocument, clip: Clip): boolean {
  return !pictureReadsSlotTokens(doc, clip);
}

/**
 * May a freshly rendered buffer be KEPT? Parked: yes. Playing: only what pays —
 * an expensive layer, or a steady one whose one buffer covers a whole segment —
 * and only when the switch is on, because while playing this is part of what a
 * person means by "caching".
 *
 * Two kinds of keeping, and the playback MODE only owns one of them:
 *
 *  · PER INSTANT — a buffer per frame. That is the Layers mode's job; under
 *    Frames the finished frame is kept instead, and a copy per layer is waste.
 *  · PER SEGMENT — a steady picture (`layerPictureSegment`): one buffer stands
 *    for every frame of its stretch, and a stepped card's few pictures for the
 *    whole timeline. No finished-frame cache replaces that — the frame around
 *    it moves — so a costly one is kept in EITHER mode, at any depth. Refusing
 *    it is how a 3-drawing Line boil re-warped a 1000² outline on every frame
 *    of default playback: 35 ms a frame for three pictures.
 */
export function layerCacheAdmits(
  clipId: string,
  playing: boolean,
  steady: boolean,
  /** Shows footage (a video, or a container or material that holds one). */
  footage = false,
  /** How many renders one kept picture stands for — a shutter's samples. */
  costScale = 1,
): boolean {
  if (!playing) return true;
  // Kept only when it MEASURED slower than the person's threshold
  // (`layerMinMs`): a buffer for a layer that draws in a millisecond is memory
  // spent to save nothing. It used to keep any layer with a pixel effect
  // regardless, which is how cheap effects filled the budget.
  const pays = (costs.get(clipId) ?? 0) * costScale >= cacheSettings().layerMinMs;
  // A COSTLY STEADY PICTURE, in either mode and inside any unit: a unit drawn
  // per instant (a nested comp, a moving group) repaints its members every
  // frame, and this is what stops that repaint re-running their effects.
  // Footage is never steady here — its picture is only as exact as its clock.
  if (steady && pays && !footage) return true;
  if (!layersCacheOn()) return false;
  // THE OUTERMOST UNIT ONLY. A group being kept per instant already holds its
  // children's pixels; keeping them too was every pixel twice — the layer
  // cache climbing into the thousands of entries. A child of a unit that is
  // NOT kept (a plain nested clip, a cheap group) is outermost itself.
  if (unitDepth > 0) return false;
  // FOOTAGE: in exact playback always — drawing it is cheap, but HAVING the
  // frame is a decode, the costliest thing in the stack to get back. In live
  // playback never: the picture is only as exact as the element's clock, and
  // claiming the slot would throw away the exact picture a build kept there.
  // STEADY in the Layers mode: one buffer covers the whole segment — always
  // worth it, cheap or not.
  if (footage) return playbackRegime() === "exact";
  return steady || pays;
}

/** How many units being kept per instant are drawing their contents right now. */
let unitDepth = 0;

/** Once per stage frame: a render that threw must not leave the depth stuck. */
export function resetKeptUnits(): void {
  unitDepth = 0;
}

/**
 * Bracket the render of a unit that is being kept, so nothing inside it is
 * kept a second time. Returns the closer; `withLayer` calls it around the
 * draw of an entry it owns while playing.
 */
export function enterKeptUnit(): () => void {
  unitDepth++;
  let open = true;
  return () => {
    if (!open) return;
    open = false;
    unitDepth--;
  };
}

// ── Reading and writing ─────────────────────────────────────────────────────

/** The cached buffer for this exact render, or null. */
export function readLayerCache(
  clip: Clip,
  key: string,
  refs: readonly unknown[],
  /**
   * Footage is rolling live on screen. A kept picture MADE FROM footage shows
   * the exact frame of its instant; the live element beside it shows wherever
   * its own clock is — alternating the two is the jump. So while footage
   * rolls, such entries are drawn live, exactly as with the cache off.
   */
  footageLive = false,
): { canvas: HTMLCanvasElement; rect: { x: number; y: number; w: number; h: number }; hits: readonly HitRectLike[] } | null {
  const hit = entries.get(slotOf(clip.id, key));
  if (!hit) return null;
  if (footageLive && hit.footage) return null;
  if (hit.clip !== clip || hit.generation !== renderGeneration) return null;
  if (hit.refs.length !== refs.length) return null;
  for (let i = 0; i < refs.length; i++) if (hit.refs[i] !== refs[i]) return null;
  hit.used = ++useClock;
  replayPicture(hit.exact, hit.footage);
  return { canvas: hit.canvas, rect: hit.rect, hits: hit.hits };
}

/**
 * THIS LAYER'S PICTURE AT ANOTHER RESOLUTION — the same clip, instant, mode and
 * scene beneath, rendered for a different zoom. What a layer shows while the
 * stage is still sharpening after a zoom (`DrawOptions.settle`): the buffer it
 * has, scaled into its frame-space rect, soft for a tick and never a stall.
 * The buffer's rect is frame space, so a picture made at any scale lands in
 * exactly the same place. Most recently used first.
 */
export function readLayerCacheAnyScale(
  clip: Clip,
  family: string,
  refs: readonly unknown[],
): { canvas: HTMLCanvasElement; rect: { x: number; y: number; w: number; h: number }; hits: readonly HitRectLike[] } | null {
  let best: Entry | null = null;
  for (const e of entries.values()) {
    if (e.family !== family || e.clip !== clip || e.generation !== renderGeneration || e.footage) continue;
    if (e.refs.length !== refs.length || e.refs.some((r, i) => r !== refs[i])) continue;
    if (!best || e.used > best.used) best = e;
  }
  if (!best) return null;
  best.used = ++useClock;
  return { canvas: best.canvas, rect: best.rect, hits: best.hits };
}

export interface LayerCacheSlot {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  commit: (
    refs: readonly unknown[],
    rect: { x: number; y: number; w: number; h: number },
    hits: readonly HitRectLike[],
    exact: boolean,
    footage: boolean,
  ) => void;
}

/**
 * A canvas for this layer to render into, which the cache OWNS — and a commit
 * to call once it actually holds the finished picture. Registering up front
 * would publish a canvas still being drawn into; a render that throws half way
 * would leave half a layer cached forever.
 */
export function acquireLayerCanvas(
  clip: Clip,
  key: string,
  width: number,
  height: number,
  span: {
    /** Clip-local instants the picture covers: one instant, or a steady segment. */
    from: number;
    to: number;
    /** The comp's frame step, for the bar's cells. */
    gridMs: number;
    /** Show on the clip's bar — the stage's own pass only. */
    report: boolean;
    /** Playing: fill free room, never evict. Parked: least recently used out. */
    evict: boolean;
    /** Made while the transport runs (a run, or a build). */
    playing: boolean;
    /** The key without its resolution terms (`readLayerCacheAnyScale`). */
    family: string;
  },
): LayerCacheSlot | null {
  // NON-FINITE GEOMETRY NEVER ENTERS. `String(NaN) === String(NaN)`, so a
  // poisoned key matches forever after.
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
  const bytes = width * height * 4;
  if (bytes > budget()) return null;
  // HOLD refuses once full while a range is being made; ROLL makes room.
  if (!span.evict && !isRollingCache() && totalBytes + bytes > budget()) return null;

  // An EDITED clip's old variants can never be served again — drop them here
  // rather than leave them for the budget to discover.
  const slot = slotOf(clip.id, key);
  let canvas: HTMLCanvasElement | undefined;
  for (const [k, e] of entries) {
    if (e.clip.id !== clip.id) continue;
    if (e.clip === clip && k !== slot) continue;
    if (!canvas) canvas = e.canvas;
    drop(k);
  }
  canvas ??= document.createElement("canvas");
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const target = canvas;

  return {
    canvas: target,
    ctx,
    commit: (refs, rect, hits, exact, footage) => {
      // LIVE playback keeps nothing made from footage: its picture is only as
      // exact as the element's own clock, and the next frame is drawn live.
      if (footage && span.playing && playbackRegime() === "live") return;
      const entry: Entry = {
        clip,
        key,
        refs: [...refs],
        generation: renderGeneration,
        canvas: target,
        rect,
        hits,
        bytes,
        used: ++useClock,
        from: span.from,
        to: span.to,
        reported: span.report,
        grid: span.gridMs,
        exact,
        footage,
        parked: !span.playing,
        family: span.family,
      };
      entries.set(slot, entry);
      totalBytes += bytes;
      changed();
      evictToBudget();
    },
  };
}

/** Least recently used out first, until the total is under budget. */
function evictToBudget(): void {
  if (totalBytes <= budget()) return;
  const byAge = [
    ...[...entries].map(([k, e]) => ({ k, used: e.used, prefix: false })),
    ...[...prefixes].map(([k, e]) => ({ k, used: e.used, prefix: true })),
  ].sort((a, b) => a.used - b.used);
  for (const v of byAge) {
    if (totalBytes <= budget()) return;
    if (v.prefix) {
      dropPrefix(v.k);
      continue;
    }
    // An evicted unit un-builds the instants it covered — the ruler must not
    // stay green over pixels that are gone.
    const e = entries.get(v.k);
    if (e) unbuildLayer(e.clip.id, e.clip.frameId, e.clip.startMs + e.from - 1, e.clip.startMs + e.to + 1);
    drop(v.k);
  }
}

// ── Invalidation ────────────────────────────────────────────────────────────

type RefKind = { kind: "clip"; clip: Clip } | { kind: "track"; id: string } | { kind: "frame"; id: string } | { kind: "samples" } | null;

/** What a ref IS. The refs are written by two walks in this app and core; their shapes are closed. */
function refKind(r: unknown): RefKind {
  if (!r || typeof r !== "object") return null;
  // A trace's sample store (core `traceSamplesOf`): the source history it draws.
  if (r instanceof Map) return { kind: "samples" };
  const o = r as Record<string, unknown>;
  if (typeof o.id !== "string") return null;
  if (typeof o.frameId === "string" && Array.isArray(o.keyframes)) return { kind: "clip", clip: r as Clip };
  if (Array.isArray(o.clips)) return { kind: "track", id: o.id };
  if (typeof o.width === "number" && typeof o.height === "number") return { kind: "frame", id: o.id };
  return null;
}

function spansTouch(spans: TimeSpans, from: number, to: number): boolean {
  if (spans === "all") return true;
  for (const [a, b] of spans) if (a <= to && b >= from) return true;
  return false;
}

/**
 * An edit landed. Entries it did not reach are RE-ATTACHED to the new objects;
 * entries it did reach are dropped. Driven by the same `DocumentDelta` the
 * frame cache applies — computed once per edit, by the stage.
 */
export function applyDeltaToLayerCache(delta: DocumentDelta, next: MotionDocument): void {
  if (delta.total) {
    purgeLayerCache();
    return;
  }
  if (delta.clips.size === 0 && delta.changedFrames.size === 0) return;
  // A prefix survives an edit that cannot reach it — a card above the cut, a
  // key on one — and is carried onto the new object. Anything else drops it
  // now rather than when the budget notices.
  for (const [slot, p] of [...prefixes]) {
    const d = delta.clips.get(p.clip.id);
    if (!d) continue;
    if (d.next && stackPrefixUnchanged(p.clip, d.next, p.count)) p.clip = d.next;
    else dropPrefix(slot);
  }
  const tracks = new Map(next.tracks.map((t) => [t.id, t]));
  const frames = new Map(next.frames.map((f) => [f.id, f]));
  const trackOfClip = new Map<string, (typeof next.tracks)[number]>();
  for (const t of next.tracks) for (const c of t.clips) trackOfClip.set(c.id, t);

  for (const [slot, e] of [...entries]) {
    let own = e.clip;
    const d = delta.clips.get(own.id);
    if (d) {
      // Only the object the edit started from can be carried across it.
      if (!d.next || d.prev !== own || spansTouch(d.change.local, e.from, e.to)) {
        drop(slot);
        continue;
      }
      own = d.next;
    }
    if (delta.changedFrames.has(own.frameId)) {
      drop(slot);
      continue;
    }
    const ownTrack = trackOfClip.get(own.id);
    const ownLoops = ownTrack != null && ownTrack.loop !== "none";
    // The entry's instants in its comp's time — where a content change lands.
    const compFrom = own.startMs + e.from;
    const compTo = own.startMs + e.to;
    let stale = false;
    const refs = e.refs.map((r) => {
      if (stale) return r;
      const k = refKind(r);
      if (!k) return r;
      if (k.kind === "clip") {
        const dr = delta.clips.get(k.clip.id);
        if (!dr) return r;
        const sameClock = k.clip.frameId === own.frameId && !ownLoops;
        if (!dr.next || dr.prev !== r || !sameClock || spansTouch(dr.change.comp, compFrom, compTo)) {
          stale = true;
          return r;
        }
        return dr.next;
      }
      if (k.kind === "samples") {
        // Re-sampled = some source may have moved: the trace's picture is stale.
        if (traceSamplesOf(next) !== r) stale = true;
        return r;
      }
      if (k.kind === "track") {
        const t = tracks.get(k.id);
        if (t === r) return r;
        const was = r as { hidden: boolean; loop: unknown; transitions: unknown };
        if (!t || t.hidden !== was.hidden || t.loop !== was.loop || t.transitions !== was.transitions) stale = true;
        return t ?? r;
      }
      const f = frames.get(k.id);
      if (f !== r || delta.changedFrames.has(k.id)) stale = true;
      return r;
    });
    if (stale) {
      drop(slot);
      continue;
    }
    e.refs = refs;
    changed();
    if (own !== e.clip) {
      // The same pixels, now belonging to the new object. Coverage is keyed by
      // clip id and local time, both unchanged.
      e.clip = own;
    }
  }
}

/**
 * The picture a clip is PAINTING changed without the document changing — a
 * video's seek landed, its latch moved. Drops the layers that painted it —
 * itself, a container holding it, glass looking through it — but only entries
 * that were NOT exact. An exact entry holds the frame of its own instant, and a
 * decode anywhere else in the file says nothing about it; dropping those is
 * what erased a built glass range every time playback paused.
 */
export function invalidateLayersShowing(clipId: string): void {
  // A media FILL's element is keyed `host::fill::id`; the layer is the host.
  const host = clipId.includes("::") ? clipId.slice(0, clipId.indexOf("::")) : clipId;
  for (const [slot, e] of [...entries]) {
    if (e.exact) continue;
    if (e.clip.id === host) {
      drop(slot);
      continue;
    }
    for (const r of e.refs) {
      const k = refKind(r);
      if (k?.kind === "clip" && k.clip.id === host) {
        drop(slot);
        break;
      }
    }
  }
}

/**
 * THE PAUSED WORKING SET GOES. A paused render keeps its layers so an edit on
 * the frame you are looking at re-renders only the layer you touch — but it
 * renders at FULL resolution (paused is the true frame), and keeping those
 * buffers past the frame they were made for filled memory with full-res copies
 * of every frame you ever paused or stepped onto, none of which playback (at
 * its own tier) can use. The stage calls this when the paused instant changes
 * and when a run starts: full resolution costs one frame, never a history.
 */
export function dropParkedLayers(): void {
  for (const [slot, e] of [...entries]) if (e.parked) drop(slot);
}

/** Everything goes — the person asked, or the document could not be diffed. */
export function purgeLayerCache(): void {
  for (const slot of [...entries.keys()]) drop(slot);
  for (const slot of [...prefixes.keys()]) dropPrefix(slot);
  renderGeneration++;
}

// ── The steady prefix of an effect stack ────────────────────────────────────

/**
 * The output of a layer's effect stack up to the first card that MOVES — see
 * `steadyStackPrefix` in core. Grain over a colour grade re-rolls every frame,
 * but the grade underneath it does not, and recomputing it on every frame to
 * feed the grain identical pixels is the waste this removes. One entry per
 * steady segment; the moving tail runs on top of it each frame.
 *
 * Kept beside the layer entries and accounted in the same share: it IS layer
 * pixels, one stage short of finished.
 */
interface PrefixEntry {
  clip: Clip;
  /** How many leading cards it holds — what an edit above it may not touch. */
  count: number;
  generation: number;
  /** What the layer is MADE of — see `readLayerCache`. A group's prefix is its members' picture. */
  refs: readonly unknown[];
  canvas: HTMLCanvasElement;
  hits: readonly HitRectLike[];
  bytes: number;
  used: number;
  /** What it was made of — replayed on every read (see `replayPicture`). */
  exact: boolean;
  footage: boolean;
}

const prefixes = new Map<string, PrefixEntry>();
const PREFIXES_PER_LAYER = 3;

export function readStackPrefix(
  clip: Clip,
  key: string,
  refs: readonly unknown[],
  count: number,
): { canvas: HTMLCanvasElement; hits: readonly HitRectLike[] } | null {
  const e = prefixes.get(slotOf(clip.id, key));
  if (!e || e.generation !== renderGeneration || e.count !== count) return null;
  // Not the object it was made from: the SAME picture beneath the cut is
  // enough — the effect editor's preview reads through a derived clip whose
  // cards beneath yours are the very same objects.
  if (e.clip !== clip && !stackPrefixUnchanged(e.clip, clip, count)) return null;
  if (e.refs.length !== refs.length) return null;
  for (let i = 0; i < refs.length; i++) if (e.refs[i] !== refs[i]) return null;
  e.used = ++useClock;
  replayPicture(e.exact, e.footage);
  return e;
}

/** Keep a COPY of `source` — the caller's buffer is scratch it is about to reuse. */
export function storeStackPrefix(
  clip: Clip,
  key: string,
  refs: readonly unknown[],
  count: number,
  source: HTMLCanvasElement,
  hits: readonly HitRectLike[],
  made: { exact: boolean; footage: boolean },
): void {
  const bytes = source.width * source.height * 4;
  if (bytes > budget() * 0.25) return;
  // A FEW live prefixes per layer, not one: the stage and the effect editor's
  // preview hold the same layer at different sizes, and with one slot each
  // store evicted the other on every tick. Bounded, so a layer walked through
  // many instants still holds only the most recent handful.
  dropPrefix(slotOf(clip.id, key));
  const mine = [...prefixes].filter(([, e]) => e.clip.id === clip.id).sort((a, b) => a[1].used - b[1].used);
  for (let i = 0; i <= mine.length - PREFIXES_PER_LAYER; i++) dropPrefix(mine[i]![0]);
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(source, 0, 0);
  prefixes.set(slotOf(clip.id, key), {
    clip,
    count,
    generation: renderGeneration,
    refs: [...refs],
    canvas,
    hits: [...hits],
    bytes,
    used: ++useClock,
    exact: made.exact,
    footage: made.footage,
  });
  totalBytes += bytes;
  evictToBudget();
}

function dropPrefix(slot: string): void {
  const e = prefixes.get(slot);
  if (!e) return;
  prefixes.delete(slot);
  totalBytes -= e.bytes;
}

onCacheBudgetChange(evictToBudget);

// Leaving the Layers mode (or switching caching off) lets go of what playback
// kept; parked editing buffers are rebuilt on the next render.
let wasLayers = layersCacheOn();
subscribeCacheStatus(() => {
  const now = layersCacheOn();
  if (wasLayers && !now) purgeLayerCache();
  wasLayers = now;
});

/** Per clip: what is held and how big — the dev cache report. */
export function layerCacheBreakdown(): Record<string, { entries: number; bytes: number; segments: number; maxW: number; maxH: number }> {
  const out: Record<string, { entries: number; bytes: number; segments: number; maxW: number; maxH: number }> = {};
  for (const e of entries.values()) {
    const r = (out[e.clip.id] ??= { entries: 0, bytes: 0, segments: 0, maxW: 0, maxH: 0 });
    r.entries++;
    r.bytes += e.bytes;
    if (e.to > e.from) r.segments++;
    r.maxW = Math.max(r.maxW, e.canvas.width);
    r.maxH = Math.max(r.maxH, e.canvas.height);
  }
  return out;
}

/** Cached bytes and entry count — for the perf HUD. */
export function layerCacheStats(): { bytes: number; entries: number; budget: number } {
  return { bytes: totalBytes, entries: entries.size, budget: budget() };
}

registerCacheProducer({
  id: "layer",
  // Under Frames it holds the layers kept while you edit a paused frame, and
  // the costly steady pictures playback reuses.
  get label() {
    return layersCacheOn() ? "Layer pixels" : "Steady layers";
  },
  order: 2,
  stats: () => ({ bytes: totalBytes, budget: budget() }),
  purge: purgeLayerCache,
});
