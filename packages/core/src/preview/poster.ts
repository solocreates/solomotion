import { CLIP_KINDS, clipPlaybackOf, type PosterMode } from "../clip-registry";
import { compFps, frameStepMs } from "../timeline/fps";
import { clipSourcePhaseAt } from "../timeline/ops";
import { clipVariesWithTime } from "../animation/clip-properties";
import { nestedIsAudioOnly } from "../audio/cues";
import type { MotionDocument, Clip } from "../schema";

/**
 * CLIP POSTERS — the ONE model behind "what does this clip LOOK like?".
 *
 * A poster is the picture a clip shows at one instant, at thumbnail size. A
 * poster STRIP is that clip's wall-clock span cut at the boundaries where the
 * picture changes. Say it that way and every hard case answers itself:
 *
 *  - **Speed** halves or doubles the tiles, because a source frame occupies
 *    `step / speed` of wall time.
 *  - **Loop** restarts the pictures where the source wraps, so a looped clip
 *    visibly repeats instead of quietly holding.
 *  - **Ping-pong** runs them back, so the mirror is a thing you can see.
 *  - **Play-once past the source** collapses into ONE wide tile: the frozen
 *    tail is drawn as a hold, which is the only honest picture of it.
 *  - **Trim-in** shifts the whole strip, because it shifts the source time.
 *  - **A 12fps flipbook in a 60fps comp** cuts on twelves, because the cut is
 *    the SOURCE's grid and the parent only samples it.
 *
 * None of that is implemented here. It is all one call to `clipSourcePhaseAt`
 * — core's single clip→source map — asked once per sample. That is the whole
 * design: the strip has no playback model of its own to drift from the
 * renderer's, because it has no playback model at all.
 *
 * Which is also how it stays right for retiming features that do not exist
 * yet. A FROZEN FRAME and a LOOPED RANGE INSIDE a clip are not new kinds of
 * preview — they are new shapes of that one map. A freeze returns the same
 * source time over a span, so the merge below collapses it into a single wide
 * tile flagged `held`, and the surface that already shades a play-once tail
 * shades it. A range loop wraps within a sub-span, so `cycleIndex` ticks and
 * the strip draws repeat boundaries exactly where it already does. The rule to
 * keep: **every retiming lands in `clipSourcePhaseAt` and nowhere else**, and
 * posters, the renderer, the video conductor and the cache bars all pick it up
 * on the same day for free.
 *
 * This module is pure: no canvas, no bitmaps, no cache. It says WHICH pictures
 * at WHICH times; a host decides how to draw and store them (`editor/preview`
 * in the web app). That split is what lets the timeline strip, the flipbook
 * sheet's cells and any future surface share one plan and one store.
 *
 * ── A poster shows the SOURCE, never the effect stack ────────────────────────
 *
 * A clip with three effects on it posters as its untouched footage, and an
 * `fx` badge says the effects are there. That is a decision, not an omission,
 * and it is forced by the identity above rather than chosen on taste:
 *
 *  - A source-keyed picture is shared by every clip cut from that file and by
 *    every instance of that component — one bitmap, reused across duplicates,
 *    surviving every trim and move. Fold the effect stack into it and the key
 *    has to carry the clip's effects, their keyframes and their modulators;
 *    since grain, wiggle and glass are functions of TIME, that is a distinct
 *    picture per clip per instant, and the cache's hit rate goes to zero at
 *    the exact moment its size explodes.
 *  - Effects are the expensive half of the renderer — scratch buffers, pixel
 *    passes, a backdrop snapshot for materials. Paying that per tile, per
 *    clip, per zoom level is the "heavy and laggy" this whole feature exists
 *    to avoid.
 *  - It is also the convention every reference tool follows, for the same
 *    reason: the timeline is where you IDENTIFY a shot, the canvas is where
 *    you JUDGE it. Judging a grade off a 48px thumbnail is not a workflow.
 *
 * The one exception falls out rather than being carved: a `layer` poster (a
 * shape, a path, a pixel layer) has no source but itself, so it is a real
 * isolated render of that layer — effects and all — and it is a STILL, so it
 * costs one draw per content revision no matter how long the clip is.
 *
 * If a post-effects poster is ever genuinely wanted, it arrives as another
 * PRODUCER behind the same plan and the same store, with a key that admits
 * what it depends on. Nothing here changes.
 */

// ── Legibility floors ────────────────────────────────────────────────────────
//
// Posters are an aid, not a payload. Below these sizes they stop being
// readable — a 14px-tall smear of a frame communicates nothing, and paying
// decode + memory for it is worse than nothing. Both floors are stated once,
// here, so the plan and the surfaces that gate on them cannot disagree.

/** Lane height under which a clip shows no poster at all. */
export const POSTER_MIN_LANE_PX = 28;

/** Narrowest tile worth cutting; below this, consecutive frames are skipped. */
export const POSTER_MIN_TILE_PX = 18;

/** Ceiling on tiles per clip, so a zoomed-in hour of footage stays bounded. */
export const POSTER_MAX_TILES = 96;

/**
 * The heights posters are ever rendered at.
 *
 * Lane height is continuous — it is a track's own px times a live zoom slider
 * — so keying cached pictures by the exact height would miss on every frame of
 * a zoom gesture and re-render the whole timeline into a cache nobody ever
 * reads again. Snapping to a short ladder and letting the canvas scale the
 * last few percent makes a zoom FREE: the pictures are already there, they
 * just land in a slightly different box. Powers of two so the scale-down is
 * clean, capped because a timeline row is never a canvas.
 */
export const POSTER_HEIGHT_TIERS = [32, 48, 64, 96, 128] as const;

/**
 * The tier to render at for a given lane height — the smallest that still
 * covers it, so a poster is scaled DOWN (sharp) and never up (soft).
 */
export function posterHeightTier(heightPx: number): number {
  for (const tier of POSTER_HEIGHT_TIERS) if (tier >= heightPx) return tier;
  return POSTER_HEIGHT_TIERS[POSTER_HEIGHT_TIERS.length - 1]!;
}

/**
 * The grid a VIDEO's pictures are keyed on. A video file's own frame rate is
 * not in the document (the asset carries duration and pixel size, not fps), so
 * a poster cannot cut on true source frames. 30 cells per second is not a
 * guess dressed as a fact — it is the grid the app's decoded-frame and proxy
 * caches already key on, so a poster can only ever ask for a picture those
 * caches can name. Sharing the grid is what makes "show it if we already
 * decoded it" a lookup rather than a decode.
 */
export const VIDEO_POSTER_STEP_MS = 1000 / 30;

// ── The source ───────────────────────────────────────────────────────────────

/**
 * WHERE a clip's pictures come from, and what invalidates them.
 *
 * `key` is deliberately the identity of the SOURCE, not of the clip: two clips
 * cut from the same file, or ten instances of one component, are ten views of
 * one set of pictures. Keying by clip would cache the same bitmap ten times and
 * re-render it on every duplicate — keying by source means a copy/paste is free
 * and a trim invalidates nothing, because neither changes what the source is.
 */
export interface PosterSource {
  /** Which producer draws it: an imported file, a comp, or the layer itself. */
  kind: "asset" | "comp" | "layer";
  /** Asset id / source frame id / clip id, per `kind`. */
  id: string;
  /** Cache namespace — `<kind>:<id>`. Shared by every clip on this source. */
  key: string;
  /** Resolved for THIS clip (the registry's `poster` is only the ceiling). */
  mode: Exclude<PosterMode, "none">;
  /**
   * Milliseconds of SOURCE time per distinguishable picture — the grid tiles
   * cut on. `Infinity` for a still: there is only ever one picture.
   */
  stepMs: number;
  /** Intrinsic w/h when the document knows it; null = ask the producer. */
  aspect: number | null;
}

/**
 * The poster source for one clip, or null when it should show none.
 *
 * The registry declares the ceiling per kind; this narrows it per instance.
 * The narrowing rule is the same one every time and worth stating once: a clip
 * gets a STRIP when its picture is a function of source time — which is
 * exactly "it has a `playback`" — and a STILL when it does not.
 */
export function clipPosterSource(doc: MotionDocument, clip: Clip): PosterSource | null {
  const ceiling = CLIP_KINDS[clip.kind].poster;
  if (ceiling === "none" || clip.hidden) return null;

  switch (clip.kind) {
    case "image": {
      const asset = doc.assets.find((a) => a.id === clip.assetId);
      // An animated image carries `playback` (the import path seeds it only for
      // gif/apng/animated webp), so the registry's ceiling narrows itself: a
      // PNG has no playback and therefore exactly one picture. Its per-frame
      // step lives in the app's decode cache, so `stepMs` is left to the host
      // to refine — the render grid is the honest floor until it does.
      const animated = clipPlaybackOf(clip) !== null;
      return {
        kind: "asset",
        id: clip.assetId,
        key: `asset:${clip.assetId}`,
        mode: animated ? "strip" : "still",
        stepMs: animated ? 0 : Infinity,
        aspect: aspectOf(asset?.width, asset?.height),
      };
    }
    case "video": {
      const asset = doc.assets.find((a) => a.id === clip.assetId);
      return {
        kind: "asset",
        id: clip.assetId,
        key: `asset:${clip.assetId}`,
        mode: "strip",
        stepMs: VIDEO_POSTER_STEP_MS,
        aspect: aspectOf(asset?.width, asset?.height),
      };
    }
    case "nested": {
      // An audio-only comp reads as audio everywhere else on the timeline
      // (audio tint, waveform, AudioLines) — the same capability question, so
      // the same answer: it has no picture worth showing.
      if (nestedIsAudioOnly(doc, clip)) return null;
      const source = doc.frames.find((f) => f.id === clip.sourceFrameId);
      if (!source) return null;
      return {
        kind: "comp",
        id: clip.sourceFrameId,
        key: `comp:${clip.sourceFrameId}`,
        mode: "strip",
        // THE nesting rule, unchanged: a comp's pictures land on ITS OWN rate.
        // A 12fps sheet inside a 60fps comp cuts on twelves whatever the
        // parent samples at — nothing inherits, nothing negotiates.
        stepMs: frameStepMs(compFps(doc, clip.sourceFrameId)),
        aspect: aspectOf(source.width, source.height),
      };
    }
    default: {
      // A pixel layer: drawn in isolation from the clip itself, so the clip IS
      // the source and its own content is what invalidates it. (The registry's
      // ceiling has already turned away every other kind that lands here —
      // shapes and paths deliberately show no poster; see CLIP_KINDS.)
      //
      // The still/strip choice here is the general rule made concrete. A poster
      // is a picture of a SOURCE, and a source's picture varies with SOURCE
      // TIME — for an asset or a comp that means playback, and keyframes on the
      // clip are irrelevant because they animate the LAYER, not the file. But
      // when the clip IS the source, its own animation is the source's
      // animation: a paint layer whose opacity, colour or effects are
      // keyframed genuinely looks different at different instants, and one
      // frozen thumbnail claiming otherwise is the same lie that made a
      // colour-animating rectangle feel wrong. So it strips, on the comp's own
      // grid, and every tile is a real render of a real instant.
      //
      // "Animated" is `clipVariesWithTime`, not a keyframe count: a driven
      // value, a wiggle, a tracked pose, an in-animation and a live grain all
      // move a layer without writing a key, and a poster that only watched
      // keys would freeze on every one of them.
      //
      // A layer with nothing animated collapses to exactly one picture, which
      // is the common case and costs one draw however long the clip runs.
      const animates = clipVariesWithTime(clip);
      return {
        kind: "layer",
        id: clip.id,
        key: `layer:${clip.id}`,
        mode: animates ? "strip" : "still",
        stepMs: animates ? frameStepMs(compFps(doc, clip.frameId)) : Infinity,
        aspect: null,
      };
    }
  }
}

function aspectOf(w: number | null | undefined, h: number | null | undefined): number | null {
  return w && h && w > 0 && h > 0 ? w / h : null;
}

// ── The plan ─────────────────────────────────────────────────────────────────

/** One span of the clip showing one picture. */
export interface PosterTile {
  /** Clip-local ms this picture starts / stops being the right one. */
  startMs: number;
  endMs: number;
  /**
   * The SOURCE time to draw — the start of the source frame this tile shows,
   * never the sample instant.
   *
   * This is the whole reason zooming the timeline is cheap. A picture's
   * identity is `(source, source frame, height tier)`; none of those three
   * mentions zoom, the clip's position, its length or its trim. So panning,
   * zooming, trimming, sliding, duplicating and retiming a clip all re-PLAN
   * (microseconds of arithmetic) and re-use every bitmap they had before.
   * Sampling at raw instants instead would mint a new key on every pixel of
   * every gesture, and the cache would be a memory leak with a hit rate of
   * zero.
   */
  sourceMs: number;
  /** Which pass over the source (see `SourcePhase.cycleIndex`). */
  cycleIndex: number;
  /** This tile is the frozen tail of a play-once clip. */
  held: boolean;
  /** First tile of a new pass — where the strip draws a repeat boundary. */
  cycleStart: boolean;
}

export interface PosterPlanInput {
  /** Clip-local span to cover. */
  durationMs: number;
  /** Horizontal scale the strip is being drawn at. */
  pxPerMs: number;
  /**
   * The PARENT comp's frame step. The picture cannot change faster than the
   * comp it lives in samples it, so this floors the cut — the same clock
   * `drawFrameContent` quantizes on, which is why a tile boundary always lands
   * on a frame the renderer can actually show.
   */
  renderStepMs: number;
  /** `PosterSource.stepMs` (`Infinity` for a still). */
  sourceStepMs: number;
  /** Playback speed, so one source frame's WALL width is right. */
  speed: number;
  /** Clip-local ms → source phase. Bind core's `clipSourcePhaseAt` to this. */
  phaseAt: (localMs: number) => { sourceMs: number; cycleIndex: number; held: boolean };
  minTilePx?: number;
  maxTiles?: number;
  /**
   * The clip-local span that is ON SCREEN. Absent = the whole clip.
   *
   * A strip costs what you can SEE, never what the clip contains: a 35 s nested
   * comp at a deep zoom is hundreds of renders end to end, and the dozen in
   * view are the only ones anybody asked for. The grid stays anchored at the
   * clip's start, so a windowed tile is the very tile the whole-clip plan has
   * there — scrolling re-plans in arithmetic and hits every picture it had.
   */
  window?: PosterWindow;
}

/** A clip-local span of time — the part of a strip that is on screen. */
export interface PosterWindow {
  fromMs: number;
  toMs: number;
}

/**
 * THE COST-AWARE LEGIBILITY FLOOR — how wide a tile must be, given what one
 * picture of this source measured to cost.
 *
 * A filmstrip is a recognition aid, and its price is paid on the main thread.
 * A cheap source (footage frames, a light comp) gets the full density; a comp
 * whose single render takes a second gets a picture every few hundred pixels,
 * because a strip that takes minutes to fill and freezes the app while it does
 * is not a strip, it is a hang. Linear in cost above one frame's worth of work
 * (`POSTER_CHEAP_MS`), so density degrades smoothly rather than at a cliff,
 * and capped so even the heaviest source still shows SOMETHING per screen.
 */
export const POSTER_CHEAP_MS = 16;
export const POSTER_MAX_TILE_PX = 640;
/**
 * Above this, one picture of the source is a long task on its own — the strip
 * collapses to ONE picture per clip (a still), shared by every clip on the
 * source. A filmstrip of a comp that takes a quarter-second per frame is a
 * luxury nobody would choose if asked what it costs.
 */
export const POSTER_STILL_MS = 250;

export function posterTileFloorPx(costMs: number | null | undefined, minTilePx = POSTER_MIN_TILE_PX): number {
  if (!(costMs != null && costMs > POSTER_CHEAP_MS)) return minTilePx;
  return Math.min(POSTER_MAX_TILE_PX, Math.max(minTilePx, (minTilePx * costMs) / POSTER_CHEAP_MS));
}

/**
 * Cut a clip's span into tiles.
 *
 * The walk samples at a PITCH and merges consecutive samples that land on the
 * same source frame, which is what makes one loop handle every regime:
 *
 *  - pitch = one source frame in wall time, when that is legible → every
 *    source frame gets its own tile (a flipbook reads cell by cell);
 *  - pitch = the legibility floor, when frames are narrower than that → tiles
 *    are honest samples of real instants, just not every one of them, which is
 *    what every NLE does when you zoom out;
 *  - the merge collapses runs → a held tail, a slow source or a ping-pong
 *    turnaround becomes one wide tile instead of a row of identical thumbnails.
 *
 * Cheap by construction: the sample count is bounded by the clip's PIXEL width
 * over the tile floor, so zooming out costs less, never more, and a two-hour
 * clip plans in the same time as a two-second one.
 */
export function planPosterTiles(input: PosterPlanInput): PosterTile[] {
  const {
    durationMs,
    pxPerMs,
    renderStepMs,
    sourceStepMs,
    speed,
    phaseAt,
    minTilePx = POSTER_MIN_TILE_PX,
    maxTiles = POSTER_MAX_TILES,
    window,
  } = input;
  if (durationMs <= 0 || pxPerMs <= 0) return [];
  const fromMs = window ? Math.max(0, window.fromMs) : 0;
  const toMs = window ? Math.min(durationMs, window.toMs) : durationMs;
  if (toMs <= fromMs) return [];

  const first = phaseAt(0);

  // A still has one picture by definition — no walk, no merge, no cache churn.
  // The host still tiles it across the body; that is a painting decision, and
  // deliberately not a modelling one.
  if (!Number.isFinite(sourceStepMs) || sourceStepMs <= 0) {
    return [
      {
        startMs: fromMs,
        endMs: toMs,
        sourceMs: first.sourceMs,
        cycleIndex: 0,
        held: false,
        cycleStart: false,
      },
    ];
  }

  const rate = speed > 0 ? speed : 1;
  // One source frame in wall ms, floored by what the parent comp can show.
  const framePitch = Math.max(sourceStepMs / rate, renderStepMs);
  // The tile cap bounds ONE PLAN, so it is spread over the span being planned —
  // the window when there is one. The pixel floor already bounds a screen.
  const wanted = Math.max(framePitch, minTilePx / pxPerMs, (toMs - fromMs) / maxTiles);
  // A LADDER, not a continuum: the pitch is one source frame × a power of two.
  // Every zoom level's samples are then a subset of the level below it, so
  // zooming out reuses pictures already made and zooming back in only adds the
  // frames between them — instead of every zoom step minting a fresh set of
  // instants (a cache with a hit rate of zero that only grows).
  const pitch = framePitch * 2 ** Math.max(0, Math.ceil(Math.log2(wanted / framePitch) - 1e-9));

  const tiles: PosterTile[] = [];
  let prevCell: number | null = null;
  // Anchored on the clip's own grid (k·pitch from its start), never on the
  // window's edge, so a tile does not change identity as it scrolls.
  const firstStep = Math.floor(fromMs / pitch + 1e-9);
  for (let k = firstStep, t = k * pitch; t < toMs; k++, t = k * pitch) {
    // Sample on the parent's grid: the strip must show a picture the renderer
    // would actually put on screen at that instant, not one between frames.
    const at = Math.min(durationMs, quantizeDown(t, renderStepMs));
    const phase = phaseAt(at);
    const cell = Math.floor(phase.sourceMs / sourceStepMs + 1e-6);
    const last = tiles[tiles.length - 1];
    if (last && prevCell === cell && last.cycleIndex === phase.cycleIndex) {
      last.endMs = Math.min(durationMs, t + pitch);
      last.held ||= phase.held;
      continue;
    }
    if (last) last.endMs = t;
    tiles.push({
      startMs: last ? t : Math.max(fromMs, t),
      endMs: Math.min(durationMs, t + pitch),
      sourceMs: cell * sourceStepMs,
      cycleIndex: phase.cycleIndex,
      held: phase.held,
      cycleStart: last != null && phase.cycleIndex !== last.cycleIndex,
    });
    prevCell = cell;
  }
  const tail = tiles[tiles.length - 1];
  if (!tail) return tiles;
  // Only the CLIP'S end has a remainder; a window's edge is just where the
  // screen stops, and the tile across it is drawn clipped, not absorbed.
  if (toMs < durationMs) return tiles;
  tail.endMs = durationMs;
  // The walk leaves a REMAINDER at the end — whatever is left after the last
  // whole pitch — and it can be a sliver. A sliver is the one tile guaranteed
  // to be unreadable, so it is absorbed into its neighbour rather than drawn:
  // showing the previous picture a few px longer is invisible, and a 2px
  // fragment of a different frame is noise plus a cache entry nobody sees.
  const minTileMs = minTilePx / pxPerMs;
  if (tiles.length > 1 && tail.endMs - tail.startMs < minTileMs) {
    tiles.pop();
    tiles[tiles.length - 1]!.endMs = durationMs;
  }
  return tiles;
}

/** Floor onto a grid — the render clock's rule, kept local so a plan needs no fps. */
function quantizeDown(ms: number, stepMs: number): number {
  if (!(stepMs > 0) || ms <= 0) return Math.max(0, ms);
  return Math.floor(ms / stepMs + 1e-6) * stepMs;
}

/**
 * The plan for a real clip: `planPosterTiles` with core's clip→source map
 * already bound, which is the form every surface should call.
 *
 * `naturalMs` passes the host's natural span through (an animated image's
 * length, a video whose asset duration is still loading) exactly as
 * `clipSourceTimeAt` takes it — one override, one meaning, one place.
 */
export function clipPosterTiles(
  doc: MotionDocument,
  clip: Clip,
  source: PosterSource,
  opts: {
    pxPerMs: number;
    /** Parent comp step; defaults to the comp the clip renders into. */
    renderStepMs?: number;
    /** Refines `source.stepMs` when the host knows better (animated images). */
    sourceStepMs?: number;
    naturalMs?: number | null;
    minTilePx?: number;
    maxTiles?: number;
    window?: PosterWindow;
  },
): PosterTile[] {
  const playback = clipPlaybackOf(clip);
  const stepMs = opts.sourceStepMs ?? source.stepMs;
  return planPosterTiles({
    durationMs: clip.durationMs,
    pxPerMs: opts.pxPerMs,
    renderStepMs: opts.renderStepMs ?? frameStepMs(compFps(doc, clip.frameId)),
    // A strip whose step the host never refined (an animated image before its
    // decode lands) falls back to the render grid: still truthful, just as
    // fine-grained as the comp can show, and it sharpens itself on the next
    // pass once the real step is known.
    sourceStepMs: stepMs > 0 ? stepMs : frameStepMs(compFps(doc, clip.frameId)),
    speed: playback?.speed ?? 1,
    phaseAt: (localMs) => clipSourcePhaseAt(doc, clip, localMs, opts.naturalMs),
    minTilePx: opts.minTilePx,
    maxTiles: opts.maxTiles,
    window: opts.window,
  });
}
