"use client";

import { MediaError, reportError } from "@solomotion/core";
import {
  WetLayer,
  canGrowRaster,
  padFor,
  padIsEmpty,
  type BrushWet,
  type PixelBounds,
  type SurfacePad,
  type WetSettings,
} from "@solomotion/core";
import type { MotionDocument, RasterClip } from "@solomotion/core";
import { pushLog } from "@solomotion/platform";
import { deleteAssetBlob, getAssetBlob, putAssetBlob } from "../assets/asset-store";

/**
 * The raster surface store — the pixels behind every `raster` clip. The
 * document stores only `{ surfaceId, rev }`; this store owns the bitmaps and
 * keeps them IN LOCKSTEP with document history:
 *
 *   paint:  beginStroke() snapshots → tools mutate the canvas → commitStroke()
 *           crops before/after to the dirty rect into a journal entry, and the
 *           SAME document update bumps the clip's `rev`.
 *   undo:   the doc patch rolls `rev` back → `syncToDocument` sees the
 *           mismatch and replays the journal to that revision. Redo walks
 *           forward. No listeners inside history, no double bookkeeping — the
 *           one integer in the document is the source of truth.
 *
 * Memory: journal entries are dirty-rect ImageData pairs under a global
 * budget; the oldest entries fall off first (undo horizon, Procreate-style).
 * Persistence: surfaces flush to the asset blob store (OPFS/IDB) as PNG,
 * debounced after each commit — project JSON never carries pixels.
 */

interface JournalEntry {
  from: number;
  to: number;
  x: number;
  y: number;
  before: ImageData;
  after: ImageData;
  bytes: number;
  /**
   * This revision also GREW the surface by this much (see `growSurface`).
   *
   * Geometry has to live on the entry, not beside it, because a journal is a
   * list of coordinate spaces as much as a list of pixels: entries recorded
   * before a growth address the smaller canvas, and replaying them into the
   * bigger one would put every earlier stroke back in the wrong place. So the
   * seek grows on the way forward and shrinks on the way back, at exactly the
   * revision that changed it, and `x`/`y` always mean what they meant when they
   * were written.
   */
  pad?: SurfacePad;
}

interface Surface {
  id: string;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  /** The revision the pixels currently represent (session-relative). */
  rev: number;
  journal: JournalEntry[];
  /** Oldest revision the journal can still reach (entries evict forward). */
  baseRev: number;
  loading: boolean;
  /** Needs a persist flush (committed strokes since the last write). */
  dirty: boolean;
  /**
   * The WET FILM over these pixels, when something has painted wet media here.
   *
   * Deliberately NOT part of the bitmap. Wet paint is still moving — it flows,
   * bleeds and evaporates every frame — so folding it in would mean the
   * committed pixels changed sixty times a second, which makes both the undo
   * journal and the persist flush meaningless. It composites on top at draw
   * time, and the bitmap only ever changes when paint DRIES.
   */
  wet: WetLayer | null;
  /** Reused compose target — a wet frame must never allocate. */
  wetImage: ImageData | null;
  /**
   * Everywhere this film has BEEN, unioned as it flows.
   *
   * The film's own dirty rect is where it is moving right now and is empty the
   * moment it settles — which is exactly when the pixels have to be journalled,
   * so by then it can no longer say which pixels those were. Without this the
   * settle has to journal the whole canvas: a full before/after ImageData pair
   * for a wash the size of a thumb, ~16MB of undo budget on a 1080×1920 layer.
   */
  wetBox: PixelBounds | null;
  /**
   * The box the layer's INK actually occupies, and the revision it describes.
   *
   * The document knows how big a pixel layer IS; only the pixels know how much
   * of it is used. Thumbnails need the second one: a sheet cell showing a
   * 1080×1920 canvas with a face drawn in one corner is a picture of mostly
   * nothing, and the fix is to frame the ink rather than the canvas.
   *
   * Computed by one alpha scan, lazily and off the paint path, and cached until
   * the revision moves. A scan is a few ms on a full-size layer and happens at
   * most once per stroke, on the next thumbnail paint rather than during the
   * stroke — but it is a scan, and an incremental union of committed dirty
   * rects would be cheaper if this ever shows up in a profile.
   */
  ink: { x0: number; y0: number; x1: number; y1: number } | null;
  inkRev: number;
}

/** An open stroke transaction: the pre-stroke pixels + the touched rect. */
export interface StrokeTx {
  surfaceId: string;
  /**
   * THE UNDO SNAPSHOT, TAKEN IN TILES AND ONLY WHERE THE STROKE GOES.
   *
   * It used to be one `getImageData` of the WHOLE surface at pointer-down —
   * 8MB on a 1080×1920 layer, and a synchronous read back off the GPU, on the
   * one event that has to feel instant. That is the lag you feel when a layer
   * already has a lot on it, and with the eraser set to all layers it was paid
   * once per layer.
   *
   * A stroke touches a handful of tiles, so a handful of tiles is what gets
   * read, captured JUST BEFORE the first write that lands in each one. Order
   * matters and is the whole correctness argument: earliest capture of a tile
   * is the one that predates the paint, so `cropBefore` lays them back
   * earliest-on-top.
   */
  tiles: Array<{ x: number; y: number; data: ImageData }>;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Growth applied during this transaction, carried onto its journal entry
   *  AND onto the document's box (`commitDrawSurface` reads it from here, so
   *  no caller can commit the pixels and forget the geometry). */
  pad: SurfacePad;
  /** May this write grow its surface — decided once, at `beginStroke`, by
   *  core `canGrowRaster`. Nothing downstream re-asks. */
  grows: boolean;
}

/**
 * Snapshot granularity. Big enough that a normal stroke reads a few of them
 * rather than hundreds; small enough that a dot does not pay for a quarter of
 * the canvas.
 */
const TILE_PX = 256;

const surfaces = new Map<string, Surface>();
const JOURNAL_BUDGET_BYTES = 128 * 1024 * 1024;
let journalBytes = 0;

// ── Repaint notification (same shape as media-cache's onMediaReady) ─────────
const readyCallbacks = new Set<() => void>();
export function onSurfaceReady(cb: () => void): () => void {
  readyCallbacks.add(cb);
  return () => readyCallbacks.delete(cb);
}
function notifyReady(): void {
  for (const cb of readyCallbacks) cb();
}

/** Poke every listener to repaint NOW — live tools mutating a surface mid-gesture. */
export function touchSurfaces(): void {
  notifyReady();
}

function makeSurface(id: string, width: number, height: number): Surface {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  return {
    id,
    canvas,
    ctx,
    width: canvas.width,
    height: canvas.height,
    rev: 0,
    journal: [],
    baseRev: 0,
    loading: false,
    dirty: false,
    wet: null,
    wetImage: null,
    wetBox: null,
    ink: null,
    inkRev: -1,
  };
}

// ── Wet media ───────────────────────────────────────────────────────────────

/**
 * The wet film for a surface, created on the first wet dab.
 *
 * A brush's `wet` block IS the simulation's settings — one vocabulary, so the
 * numbers in the Brush Studio are literally the numbers the physics runs on.
 */
export function wetForSurface(surface: Surface, settings: BrushWet): WetLayer {
  const wanted: WetSettings = {
    flow: settings.flow,
    evaporation: settings.evaporation,
    granulation: settings.granulation,
    edge: settings.edge,
    deposition: settings.deposition,
    texture: settings.texture,
  };
  // A different paper means a different height field, and that is baked at
  // construction — so switching brushes mid-wash starts a fresh film rather
  // than silently painting on the previous brush's paper.
  if (!surface.wet || surface.wet.settings.texture !== wanted.texture) {
    if (surface.wet && !surface.wet.isDry) dryIntoSurface(surface);
    surface.wet = new WetLayer(surface.width, surface.height, wanted);
    surface.wetBox = null;
    wetLog("new-film", { surface: surface.id, texture: wanted.texture });
  } else {
    Object.assign(surface.wet.settings, wanted);
  }
  startWetTick();
  return surface.wet;
}

/**
 * Is there paint that has not become pixels yet?
 *
 * A film that has finished drying still counts, and that is the point: it is
 * paint the bitmap has never seen. Asking `!isDry` here meant a wash that
 * settled on its own reported "nothing wet", so the Dry button greyed out on
 * the one film that most needed flattening.
 */
export function hasWetPaint(): boolean {
  for (const s of surfaces.values()) if (s.wet) return true;
  return false;
}

/** Every surface carrying a film, settled or not. */
function filmSurfaces(): Surface[] {
  const out: Surface[] = [];
  for (const s of surfaces.values()) if (s.wet) out.push(s);
  return out;
}

/**
 * Told when a film finishes drying by itself.
 *
 * The tick cannot flatten it here: turning paint into pixels bumps the
 * surface's revision, and a revision the document does not know about is one
 * `syncSurfacesToDocument` will helpfully replay AWAY on the next doc change.
 * So the simulation only announces the moment, and the seam that owns both
 * halves — `dryWetPaint`, the same one behind the Dry button — performs it.
 */
const settleListeners = new Set<() => void>();

export function onFilmSettled(cb: () => void): () => void {
  settleListeners.add(cb);
  return () => settleListeners.delete(cb);
}

/** A film that has stopped moving, on a layer nobody is drawing on. */
function settleableFilm(): boolean {
  for (const s of surfaces.values()) {
    if (s.wet?.isDry && !surfaceIsBusy(s.id)) return true;
  }
  return false;
}

function announceSettled(): void {
  // Only when there is something to settle. The clock keeps turning while a
  // stroke is open on the one drying layer, and telling the document about it
  // sixty times a second would walk every track for nothing each frame.
  if (!settleableFilm()) return;
  for (const cb of settleListeners) cb();
}

/**
 * The open transaction on each surface, if any — at most one, because at most
 * one stroke can be live on a layer at a time.
 *
 * A settle draws into the canvas and journals a revision, so doing it while a
 * stroke is open would interleave with a snapshot taken BEFORE the paint dried:
 * that stroke's own commit would then put the pre-dry pixels back over the top
 * and swallow the wash. So a settle waits for the surface to be idle, and the
 * tick keeps running until it is.
 *
 * A new stroke SUPERSEDES whatever was registered, which is what makes this
 * self-healing: abandoning a gesture (a tool switch mid-stroke — the one path
 * that does not reach `commitStroke`) leaves the film unsettled until anything
 * touches that layer again, rather than wedging it forever.
 */
const openTx = new Map<string, StrokeTx>();

export function surfaceIsBusy(surfaceId: string): boolean {
  return openTx.has(surfaceId);
}

/**
 * ONE simulation clock for the whole app.
 *
 * Not an effect per component and not a timer per surface: wet layers have to
 * advance in lockstep with each other and with the stage's repaint, and N loops
 * would step some films twice a frame and others not at all. It starts when
 * paint lands and STOPS when everything is dry, so an idle canvas costs nothing.
 */
let wetRaf = 0;
let wetFrames = 0;

function startWetTick(): void {
  if (wetRaf !== 0) return;
  wetFrames = 0;
  const tick = () => {
    const films = filmSurfaces();
    const live = films.filter((s) => !s.wet!.isDry);
    if (live.length === 0) {
      // Everything dried while we were not looking. Paint that has stopped
      // moving is paint, so say so — the settle turns it into pixels. If a
      // stroke is open on one of them the settle has to wait, and so does the
      // clock: stopping here would strand the film until something else woke
      // the simulation up.
      announceSettled();
      if (filmSurfaces().length > 0) {
        wetRaf = requestAnimationFrame(tick);
        return;
      }
      wetRaf = 0;
      wetLog("dry-idle", { frames: wetFrames });
      return;
    }
    // Step, and notice whether anything actually moved. A film settling in a
    // corner must not drive a full-stage repaint at 60Hz just by existing —
    // that was a SECOND scheduler competing with the stage's own dirty-flag
    // loop, which is why dragging a layer felt like it was fighting something.
    let changed = false;
    let settled = false;
    for (const s of live) {
      const before = s.wet!.version;
      s.wet!.step();
      if (s.wet!.version !== before) changed = true;
      // Remember where the wash went while it can still say; once it settles
      // its dirty rect is empty and the pixels have no address.
      s.wetBox = unionBounds(s.wetBox, s.wet!.dirtyRect);
      if (s.wet!.isDry) settled = true;
    }
    wetFrames++;
    // A film that settles must not wait for its neighbours to finish.
    if (settled) announceSettled();
    if (wetFrames % 60 === 0) {
      const l = live[0]!.wet!;
      const r = l.dirtyRect;
      wetLog("tick", { frames: wetFrames, films: live.length, wet: Math.round(l.totalWater()), area: `${r.x1 - r.x0}x${r.y1 - r.y0}` });
    }
    if (changed) notifyReady();
    wetRaf = requestAnimationFrame(tick);
  };
  wetRaf = requestAnimationFrame(tick);
  wetLog("tick-start", {});
}

/**
 * Flatten a surface's wet film into its pixels. The ONLY path that lets wet
 * paint touch the bitmap, so "when did these pixels change" has one answer.
 */
function dryIntoSurface(surface: Surface): boolean {
  const layer = surface.wet;
  // Note the guard: A FILM, not a WET film.
  //
  // It used to refuse a settled one, which stranded every wash that dried by
  // itself. `isDry` means "nothing left to simulate" — the pigment is all in
  // `deposit`, which is precisely what wants flattening — so refusing there
  // left the paint alive only inside the film: composited on screen, absent
  // from the bitmap, and therefore invisible to the eraser, to merge-down, to
  // the wand, to the paint-inside reference and to the undo journal alike.
  // That is the "I waited for it to dry and the eraser still won't touch it"
  // bug, and it could never be reached through the Dry button either, because
  // that skipped settled films too.
  if (!layer) return false;
  layer.dryAll();
  const image = composeWet(surface);
  if (image) surface.ctx.drawImage(imageToCanvas(image), 0, 0);
  surface.wet = null;
  surface.wetImage = null;
  surface.wetBox = null;
  filmCanvases.delete(surface.id);
  return true;
}

/**
 * DRY THIS LAYER — the user-facing command, as one undoable step.
 *
 * Wrapped in the same stroke transaction a brush uses, so drying is an ordinary
 * entry in the journal: ⌘Z puts it back the way it un-paints a stroke. That
 * reuse is why drying needed no history code of its own.
 */
export function dryLayer(clip: Pick<RasterClip, "surfaceId" | "width" | "height" | "rev">): boolean {
  const surface = surfaceForClip(clip);
  if (!surface.wet) return false;
  const box = surface.wetBox;
  const tx = beginStroke(clip);
  // The wash's own extent, not the canvas: a journal entry is a before/after
  // pair of ImageData, so "the whole layer" is two full-size bitmaps of undo
  // budget for a stroke that covered a corner of it.
  if (box) extendDirty(tx, box.x0, box.y0, box.x1, box.y1);
  else extendDirty(tx, 0, 0, surface.width, surface.height);
  if (!dryIntoSurface(surface)) return false;
  const ok = commitStroke(tx, clip.rev + 1);
  wetLog("dry-layer", { surface: surface.id, committed: ok });
  notifyReady();
  return ok;
}

/** Union of two pixel boxes; an empty one contributes nothing. */
function unionBounds(a: PixelBounds | null, b: PixelBounds): PixelBounds | null {
  if (b.x1 <= b.x0 || b.y1 <= b.y0) return a;
  if (!a) return { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

/** The drying fan: evaporate hard under a point. */
export function fanSurface(surfaceId: string, x: number, y: number, radius: number, strength: number): boolean {
  const surface = surfaces.get(surfaceId);
  if (!surface?.wet || surface.wet.isDry) return false;
  surface.wet.fan(x, y, radius, strength);
  notifyReady();
  return true;
}

/**
 * The wet film as an ImageData, into the surface's own reusable buffer.
 * Returns null when there is nothing wet — the caller then draws only pixels.
 */
export function composeWet(surface: Surface): ImageData | null {
  const layer = surface.wet;
  if (!layer) return null;
  if (!surface.wetImage || surface.wetImage.width !== surface.width || surface.wetImage.height !== surface.height) {
    surface.wetImage = new ImageData(surface.width, surface.height);
  }
  layer.compose(surface.wetImage.data);
  return surface.wetImage;
}

/** ImageData → a canvas the 2D context can composite (putImageData ignores it). */
let wetScratch: HTMLCanvasElement | null = null;
function imageToCanvas(image: ImageData): HTMLCanvasElement {
  if (!wetScratch) wetScratch = document.createElement("canvas");
  if (wetScratch.width !== image.width || wetScratch.height !== image.height) {
    wetScratch.width = image.width;
    wetScratch.height = image.height;
  }
  wetScratch.getContext("2d")!.putImageData(image, 0, 0);
  return wetScratch;
}

/**
 * Wet-media diagnostics, onto the app's OWN log bus — so what the simulation is
 * doing shows up in the Console panel the user can already open, rather than in
 * a private channel only a developer knows about.
 */
export function wetLog(event: string, data: Record<string, unknown>): void {
  pushLog("debug", [`[wet] ${event}`, JSON.stringify(data)]);
}

/**
 * The live canvas for a raster clip — synchronous for the render path. A
 * surface not yet in memory is created blank immediately (paintable at once)
 * and its persisted pixels stream in behind it; `onSurfaceReady` fires a
 * repaint when they land. The journal is session-scoped, so on load the
 * surface simply adopts the document's current rev — undo across reloads is
 * a history question, not a pixels question.
 */
export function surfaceForClip(clip: Pick<RasterClip, "surfaceId" | "width" | "height" | "rev">): Surface {
  let s = surfaces.get(clip.surfaceId);
  if (!s) {
    s = makeSurface(clip.surfaceId, clip.width, clip.height);
    s.rev = clip.rev;
    s.baseRev = clip.rev;
    surfaces.set(clip.surfaceId, s);
    const id = s.id;
    surfaceLoads.set(id, loadSurface(s).finally(() => surfaceLoads.delete(id)));
  }
  return s;
}

/** In-flight persisted-pixel loads — the awaitable seam so a render never
 * captures a surface still streaming its bytes (the blank-flash bug). */
const surfaceLoads = new Map<string, Promise<void>>();

/** Every surface id the document's raster clips (and their per-frame capture
 * snapshots) reference, paired with the geometry to create a blank at. */
function rasterSurfaceRefs(
  doc: MotionDocument,
): Array<Pick<RasterClip, "surfaceId" | "width" | "height" | "rev">> {
  const refs: Array<Pick<RasterClip, "surfaceId" | "width" | "height" | "rev">> = [];
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== "raster") continue;
      refs.push(clip);
      if (clip.captureRevs) {
        for (const [surfaceId, rev] of Object.entries(clip.captureRevs)) {
          refs.push({ surfaceId, width: clip.width, height: clip.height, rev });
        }
      }
    }
  }
  return refs;
}

/** Fire every referenced surface's persisted-pixel load without waiting — warms
 * a freshly opened project so pixel-brush layers paint on first playback rather
 * than flashing blank until their PNG streams in. */
export function warmSurfaces(doc: MotionDocument): void {
  for (const ref of rasterSurfaceRefs(doc)) surfaceForClip(ref);
}

/** Kick + AWAIT every referenced surface — the export counterpart of the media
 * prepares, so a stepped render never bakes in a blank raster layer. */
export async function prepareSurfacesForExport(doc: MotionDocument): Promise<void> {
  for (const ref of rasterSurfaceRefs(doc)) surfaceForClip(ref);
  await Promise.all([...surfaceLoads.values()]);
}

/** The drawable canvas for the renderer (blank while its bytes stream in). */
export function surfaceCanvas(clip: Pick<RasterClip, "surfaceId" | "width" | "height" | "rev">): HTMLCanvasElement {
  return surfaceForClip(clip).canvas;
}

/**
 * The WET FILM over a surface, as its own canvas — or null when there is none.
 *
 * A SECOND LAYER, drawn after the pixels, rather than a composite pretending to
 * be the pixels. `surfaceCanvas` used to return a scratch buffer with the film
 * already merged in, which broke its contract in the way that matters: callers
 * had always been able to hold that canvas and expect it to keep its contents,
 * and this one was cleared and repainted on every call. Anything that cached it
 * across a frame — thumbnails, onion ghosts, a drag's own repaint — was holding
 * a buffer something else was wiping, which is exactly what "layers blink and
 * go transparent while I drag" looks like.
 *
 * Re-composed only when the film's `version` changes, so a dry layer costs one
 * integer comparison and a wash being dragged around costs nothing extra.
 */
export function wetFilmCanvas(
  clip: Pick<RasterClip, "surfaceId" | "width" | "height" | "rev">,
): HTMLCanvasElement | null {
  const surface = surfaceForClip(clip);
  const layer = surface.wet;
  if (!layer) return null;

  let cached = filmCanvases.get(surface.id);
  if (!cached || cached.canvas.width !== surface.width || cached.canvas.height !== surface.height) {
    const canvas = document.createElement("canvas");
    canvas.width = surface.width;
    canvas.height = surface.height;
    cached = { canvas, version: -1 };
    filmCanvases.set(surface.id, cached);
  }
  if (cached.version !== layer.version) {
    const image = composeWet(surface);
    if (image) cached.canvas.getContext("2d")!.putImageData(image, 0, 0);
    cached.version = layer.version;
  }
  return cached.canvas;
}

/** One film canvas per surface — never shared, or two wet layers in a frame
 *  would both show whichever composed last. */
const filmCanvases = new Map<string, { canvas: HTMLCanvasElement; version: number }>();


async function loadSurface(s: Surface): Promise<void> {
  s.loading = true;
  try {
    const blob = await getAssetBlob(s.id);
    if (!blob) return;
    const bitmap = await createImageBitmap(blob);
    // A stroke may have landed while loading — persisted pixels are older
    // than live paint, never overwrite it.
    if (s.journal.length === 0 && !s.dirty) {
      s.ctx.clearRect(0, 0, s.width, s.height);
      s.ctx.drawImage(bitmap, 0, 0);
      notifyReady();
    }
    bitmap.close();
  } catch {
    // No persisted pixels yet (a brand-new layer) — blank is correct.
  } finally {
    s.loading = false;
  }
}


/**
 * The box this layer's ink occupies, in surface pixels — or null for a layer
 * with nothing on it (and for one whose bytes are still streaming in, where
 * answering "empty" would make a thumbnail zoom to nothing and then jump).
 */
export function surfaceInk(
  clip: Pick<RasterClip, "surfaceId" | "width" | "height" | "rev">,
): { x0: number; y0: number; x1: number; y1: number } | null {
  const s = surfaceForClip(clip);
  if (s.loading) return null;
  if (s.inkRev === s.rev) return s.ink;
  s.inkRev = s.rev;
  s.ink = scanInk(s);
  return s.ink;
}

/** One alpha scan. Rows first so a blank layer costs a single pass. */
function scanInk(s: Surface): { x0: number; y0: number; x1: number; y1: number } | null {
  if (s.width <= 0 || s.height <= 0) return null;
  const data = s.ctx.getImageData(0, 0, s.width, s.height).data;
  let x0 = s.width;
  let y0 = s.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < s.height; y++) {
    const row = y * s.width * 4;
    for (let x = 0; x < s.width; x++) {
      if (data[row + x * 4 + 3]! === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

// ── Painting ────────────────────────────────────────────────────────────────

/**
 * Open a stroke on a surface: snapshots the pixels so commit can journal the
 * before/after crop. Tools then draw straight onto `surface.canvas` (through
 * their own painter) and grow the dirty rect via `extendDirty`.
 */

// ── Growing a surface ───────────────────────────────────────────────────────

/**
 * Resize a surface's canvas, keeping its pixels where they are — the app-side
 * half of {@link growRasterClip}.
 *
 * Everything already on the canvas moves to `(left, top)` in the new one, which
 * is a pure translation, so nothing has to be re-rendered and nothing loses
 * precision. The document half (width/height and the re-normalised pivot) is
 * written by the caller in the SAME update that bumps `rev`, so the two can
 * never be one revision apart — which would draw the layer's pixels squashed
 * into the old box for exactly one frame.
 *
 * The wet film is dropped rather than resized: it is a physics simulation with
 * a baked paper height field, and stretching one is meaningless. Anything wet
 * dries into the pixels first, so no paint is lost.
 */
function growSurface(s: Surface, pad: SurfacePad): void {
  if (padIsEmpty(pad)) return;
  const width = s.width + pad.left + pad.right;
  const height = s.height + pad.top + pad.bottom;
  const next = document.createElement("canvas");
  next.width = width;
  next.height = height;
  const ctx = next.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(s.canvas, pad.left, pad.top);
  if (s.wet && !s.wet.isDry) dryIntoSurface(s);
  s.wet = null;
  s.wetImage = null;
  s.canvas = next;
  s.ctx = ctx;
  s.width = width;
  s.height = height;
  s.dirty = true;
}

/** The inverse — used only by the journal walking BACK across a growth. */
function shrinkSurface(s: Surface, pad: SurfacePad): void {
  if (padIsEmpty(pad)) return;
  const width = Math.max(1, s.width - pad.left - pad.right);
  const height = Math.max(1, s.height - pad.top - pad.bottom);
  const next = document.createElement("canvas");
  next.width = width;
  next.height = height;
  const ctx = next.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(s.canvas, -pad.left, -pad.top);
  s.wet = null;
  s.wetImage = null;
  s.canvas = next;
  s.ctx = ctx;
  s.width = width;
  s.height = height;
  s.dirty = true;
}

/**
 * GROW MID-STROKE — the seam a painting tool calls when its marks have reached
 * past the layer's edge.
 *
 * Everything the open transaction holds is in surface coordinates, so all three
 * move together or the commit lands somewhere else entirely: the canvas grows,
 * the pre-stroke SNAPSHOT is re-padded (it is what `before` is cropped from),
 * and the dirty rect slides by the same offset. The padding accumulates on the
 * transaction so one journal entry describes the whole stroke however many
 * times it grew.
 *
 * Returns the pad actually applied, so the caller can offset whatever it is
 * about to draw.
 */
export function growStroke(tx: StrokeTx, pad: SurfacePad): SurfacePad {
  const s = surfaces.get(tx.surfaceId);
  if (!s || padIsEmpty(pad)) return { left: 0, top: 0, right: 0, bottom: 0 };
  growSurface(s, pad);

  // Everything already captured slid by the growth; the tiles keep their own
  // pixels and simply describe a new place. (They stop being grid-aligned after
  // this, which is why a tile carries its origin rather than an index.)
  for (const t of tx.tiles) {
    t.x += pad.left;
    t.y += pad.top;
  }
  if (Number.isFinite(tx.minX)) {
    tx.minX += pad.left;
    tx.maxX += pad.left;
    tx.minY += pad.top;
    tx.maxY += pad.top;
  }
  tx.pad = {
    left: tx.pad.left + pad.left,
    top: tx.pad.top + pad.top,
    right: tx.pad.right + pad.right,
    bottom: tx.pad.bottom + pad.bottom,
  };
  return pad;
}

/**
 * WRITE INTO A LAYER, GROWING IT TO HOLD WHAT IS WRITTEN — the one seam every
 * painting tool commits through.
 *
 * A raster surface is a fixed canvas, so anything a tool draws past its edge is
 * simply gone: not clipped by the frame (which would be correct — a frame is a
 * window), but destroyed at the buffer, where nothing downstream can find it.
 * The layer must therefore grow BEFORE the paint lands, and growing is four
 * things that have to happen in one order or the commit describes the wrong
 * pixels:
 *
 *   1. how much room the write needs          `padFor`      (headless)
 *   2. re-pad the open transaction + canvas   `growStroke`
 *   3. draw at the surface's NEW origin       the caller's payload
 *   4. write the box + re-normalised pivot    `growRasterClip` (headless)
 *
 * Step 3 is the only part that differs between tools, so it is the only part
 * they pass in. The brush had all four inlined and the bucket had none of them,
 * which is exactly why filling a layer that had been moved stopped at the
 * layer's old box instead of covering the frame.
 *
 * `bounds` is what the write covers in the layer's CURRENT surface pixels; the
 * payload receives the OFFSET its coordinates gained, so a tool that already
 * knows where it is drawing adds two numbers rather than re-deriving anything.
 * The returned pad goes to `commitDrawSurface` so the document's box changes in
 * the same update that bumps `rev` — a box one revision out of step with its
 * pixels is an undo that puts every earlier mark in the wrong place.
 */
export function paintIntoRaster(
  tx: StrokeTx,
  bounds: PixelBounds,
  paint: (ctx: CanvasRenderingContext2D, offset: { x: number; y: number }) => void,
): { pad: SurfacePad; dirty: PixelBounds } {
  const surface = surfaces.get(tx.surfaceId);
  if (!surface) throw new Error(`paintIntoRaster: surface ${tx.surfaceId} has no open stroke`);
  // Measured against the SURFACE — the clip's width/height is stale the moment
  // an earlier write in this transaction grew it.
  const want = tx.grows ? padFor(bounds, surface.width, surface.height) : null;
  const pad = want ? growStroke(tx, want) : { left: 0, top: 0, right: 0, bottom: 0 };
  const dirty = {
    x0: bounds.x0 + pad.left,
    y0: bounds.y0 + pad.top,
    x1: bounds.x1 + pad.left,
    y1: bounds.y1 + pad.top,
  };
  captureBefore(tx, dirty.x0, dirty.y0, dirty.x1, dirty.y1);
  surface.ctx.save();
  paint(surface.ctx, { x: pad.left, y: pad.top });
  surface.ctx.restore();
  extendDirty(tx, dirty.x0, dirty.y0, dirty.x1, dirty.y1);
  return { pad, dirty };
}

/**
 * Open a write. `grows` comes from core `canGrowRaster` for the surface being
 * written (a snapshot never grows) and defaults to NO: a tool that never asked
 * for room can never change a layer's box behind its back.
 */
export function beginStroke(
  clip: Pick<RasterClip, "surfaceId" | "width" | "height" | "rev">,
  opts: { grows?: boolean } = {},
): StrokeTx {
  const s = surfaceForClip(clip);
  // Nothing is read here. See `StrokeTx.tiles`: the undo snapshot is taken
  // where the stroke actually goes, as it goes, so opening one costs nothing
  // however much is already painted.
  const tx = registerTx({
    surfaceId: s.id,
    tiles: [],
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    pad: { left: 0, top: 0, right: 0, bottom: 0 },
    grows: opts.grows ?? false,
  });
  return tx;
}

function registerTx(tx: StrokeTx): StrokeTx {
  openTx.set(tx.surfaceId, tx);
  return tx;
}

/**
 * Capture the pixels a write is ABOUT TO REPLACE — call immediately before
 * painting, with the box the paint will cover.
 *
 * Idempotent per tile: a tile already captured is left alone, because the first
 * capture is the one that predates the stroke. Every destructive path goes
 * through here, which is what makes an undo describe the right pixels.
 */
export function captureBefore(tx: StrokeTx, x0: number, y0: number, x1: number, y1: number): void {
  const s = surfaces.get(tx.surfaceId);
  if (!s || s.loading) return;
  const gx0 = Math.max(0, Math.floor(x0 / TILE_PX) * TILE_PX);
  const gy0 = Math.max(0, Math.floor(y0 / TILE_PX) * TILE_PX);
  for (let ty = gy0; ty < Math.min(s.height, y1); ty += TILE_PX) {
    for (let tx0 = gx0; tx0 < Math.min(s.width, x1); tx0 += TILE_PX) {
      const w = Math.min(TILE_PX, s.width - tx0);
      const h = Math.min(TILE_PX, s.height - ty);
      if (w <= 0 || h <= 0) continue;
      if (tx.tiles.some((t) => t.x === tx0 && t.y === ty)) continue;
      tx.tiles.push({ x: tx0, y: ty, data: s.ctx.getImageData(tx0, ty, w, h) });
    }
  }
}

/**
 * The stroke's BEFORE over one rectangle: the live canvas (correct everywhere
 * the stroke never wrote) with every captured tile laid back over it,
 * EARLIEST LAST — so a tile captured after a growth cannot overwrite the one
 * that was taken before the paint.
 */
function cropBefore(tx: StrokeTx, s: Surface, x: number, y: number, w: number, h: number): ImageData {
  if (tx.tiles.length === 0) return s.ctx.getImageData(x, y, w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.putImageData(s.ctx.getImageData(x, y, w, h), 0, 0);
  for (let i = tx.tiles.length - 1; i >= 0; i--) {
    const t = tx.tiles[i]!;
    g.putImageData(t.data, t.x - x, t.y - y);
  }
  return g.getImageData(0, 0, w, h);
}

/** Grow a stroke's dirty rect (surface px; callers pad for brush radius). */
export function extendDirty(tx: StrokeTx, x0: number, y0: number, x1: number, y1: number): void {
  tx.minX = Math.min(tx.minX, x0);
  tx.minY = Math.min(tx.minY, y0);
  tx.maxX = Math.max(tx.maxX, x1);
  tx.maxY = Math.max(tx.maxY, y1);
}

/**
 * Close a stroke: journal the dirty-rect before/after pair and stamp the
 * surface at `revAfter` — the caller bumps the clip's `rev` to the same value
 * INSIDE the same document update ("Brush stroke"). Returns false when the
 * stroke never touched a pixel (callers skip the doc update entirely).
 */
export function commitStroke(tx: StrokeTx, revAfter: number): boolean {
  // However this ends — with pixels, with nothing, or refused — the surface is
  // no longer busy. `finishStroke` funnels lift, cancel and lost through here,
  // so this is the one place that can say so.
  if (openTx.get(tx.surfaceId) === tx) openTx.delete(tx.surfaceId);
  const s = surfaces.get(tx.surfaceId);
  if (!s) return false;
  const x = Math.max(0, Math.floor(tx.minX));
  const y = Math.max(0, Math.floor(tx.minY));
  const x1 = Math.min(s.width, Math.ceil(tx.maxX));
  const y1 = Math.min(s.height, Math.ceil(tx.maxY));
  const w = x1 - x;
  const h = y1 - y;
  if (w <= 0 || h <= 0) {
    // Nothing to journal, so nothing will write the box either: any room this
    // transaction made goes back, or the canvas would outgrow its box.
    if (!padIsEmpty(tx.pad)) shrinkSurface(s, tx.pad);
    tx.pad = { left: 0, top: 0, right: 0, bottom: 0 };
    return false;
  }

  // The BEFORE is rebuilt from the captured tiles, the AFTER read live.
  const before = cropBefore(tx, s, x, y, w, h);
  const after = s.ctx.getImageData(x, y, w, h);
  const entry: JournalEntry = {
    from: s.rev,
    to: revAfter,
    x,
    y,
    before,
    after,
    bytes: before.data.byteLength * 2,
    ...(padIsEmpty(tx.pad) ? {} : { pad: tx.pad }),
  };
  s.journal.push(entry);
  journalBytes += entry.bytes;
  s.rev = revAfter;
  s.dirty = true;
  enforceBudget();
  schedulePersist(s);
  return true;
}

/**
 * End a stroke that must leave NO trace — a touch that turned out to be the
 * first finger of a pinch. Its pixels go back from the captured BEFORE and
 * nothing is journaled, so the surface's revision and its undo history are
 * exactly as they were.
 */
export function abortStroke(tx: StrokeTx): void {
  if (openTx.get(tx.surfaceId) === tx) openTx.delete(tx.surfaceId);
  const s = surfaces.get(tx.surfaceId);
  if (!s) return;
  const x = Math.max(0, Math.floor(tx.minX));
  const y = Math.max(0, Math.floor(tx.minY));
  const w = Math.min(s.width, Math.ceil(tx.maxX)) - x;
  const h = Math.min(s.height, Math.ceil(tx.maxY)) - y;
  if (w > 0 && h > 0) s.ctx.putImageData(cropBefore(tx, s, x, y, w, h), x, y);
  // No trace means no growth either — the box was never told.
  if (!padIsEmpty(tx.pad)) shrinkSurface(s, tx.pad);
  tx.pad = { left: 0, top: 0, right: 0, bottom: 0 };
}

/** Drop the oldest journal entries until the budget holds (undo horizon). */
function enforceBudget(): void {
  while (journalBytes > JOURNAL_BUDGET_BYTES) {
    // Evict the globally oldest entry (smallest `to` across surfaces).
    let victim: Surface | null = null;
    for (const s of surfaces.values()) {
      if (s.journal.length === 0) continue;
      if (!victim || s.journal[0]!.to < victim.journal[0]!.to) victim = s;
    }
    if (!victim) break;
    const dropped = victim.journal.shift()!;
    journalBytes -= dropped.bytes;
    victim.baseRev = dropped.to;
  }
}

// ── History lockstep ────────────────────────────────────────────────────────

/**
 * Bring every surface's pixels to the document's revisions — THE undo/redo
 * seam. Called from one document-store subscriber; walks raster clips and
 * replays each surface's journal backward/forward to the doc's `rev`.
 * A revision beyond the journal horizon keeps the current pixels (the undo
 * limit — same contract as Procreate's).
 */
export function syncSurfacesToDocument(doc: MotionDocument): void {
  let repaint = false;
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== "raster") continue;
      // The doc references this surface again — undo (or redo-of-undo)
      // resurrected a clip that pointed at a surface pending GC. Cancel the
      // purge; its pixels are still exactly what the doc expects.
      cancelPendingDeletion(clip.surfaceId);
      const s = surfaces.get(clip.surfaceId);
      if (s && s.rev !== clip.rev) {
        if (seekSurface(s, clip.rev)) repaint = true;
        else s.rev = clip.rev; // beyond horizon — adopt the doc's rev as-is
      }
      if (s && fitSurfaceToBox(s, clip)) repaint = true;
      // Capture snapshots each carry their own revision (recorded drawing over
      // time) — seek every one to the doc's, so undo/redo of a per-frame edit
      // rewinds exactly that frame's pixels.
      if (clip.captureRevs) {
        for (const [surfaceId, rev] of Object.entries(clip.captureRevs)) {
          cancelPendingDeletion(surfaceId);
          const snap = surfaces.get(surfaceId);
          if (!snap) continue;
          if (snap.rev !== rev) {
            if (seekSurface(snap, rev)) repaint = true;
            else snap.rev = rev;
          }
          if (fitSurfaceToBox(snap, clip)) repaint = true;
        }
      }
    }
  }
  if (repaint) notifyReady();
}

/**
 * THE BOX IS THE SIZE. A layer's `width`×`height` is the one authority for how
 * big its pixels are; a surface is a cache of them in that box, one pixel per
 * unit, never scaled.
 *
 * Every path that changes a size changes both together (`growStroke` +
 * `commitDrawSurface`, the journal's pads), so this should never find work.
 * It exists because the renderer cannot tell "the box is right" from "the
 * canvas is right": when they disagreed — an undo past the journal horizon, a
 * write that grew and never committed — the whole drawing was drawn SQUASHED
 * into the box. Here the canvas is re-fitted 1:1 at its origin instead: nothing
 * rescales, and the disagreement is logged rather than painted.
 *
 * Skipped while a write is open: mid-gesture the surface legitimately leads the
 * box by the room the commit is about to write.
 */
function fitSurfaceToBox(s: Surface, box: Pick<RasterClip, "width" | "height">): boolean {
  const width = Math.max(1, Math.round(box.width));
  const height = Math.max(1, Math.round(box.height));
  if (s.width === width && s.height === height) return false;
  if (openTx.has(s.id)) return false;
  pushLog("warn", [`[raster] surface ${s.id} was ${s.width}×${s.height}, box ${width}×${height} — refitted 1:1`]);
  const pad = { left: 0, top: 0, right: width - s.width, bottom: height - s.height };
  if (pad.right >= 0 && pad.bottom >= 0) growSurface(s, pad);
  else {
    const next = document.createElement("canvas");
    next.width = width;
    next.height = height;
    const ctx = next.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(s.canvas, 0, 0);
    s.wet = null;
    s.wetImage = null;
    s.canvas = next;
    s.ctx = ctx;
    s.width = width;
    s.height = height;
    s.dirty = true;
  }
  schedulePersist(s);
  return true;
}

function seekSurface(s: Surface, targetRev: number): boolean {
  let moved = false;
  // Walk BACK (undo): apply `before` of the entry that produced our rev, then
  // undo any growth it carried — in that order, because `before` is in the
  // POST-growth space the entry was written in.
  while (s.rev > targetRev) {
    const entry = [...s.journal].reverse().find((j) => j.to === s.rev && j.from >= targetRev);
    if (!entry) break;
    s.ctx.putImageData(entry.before, entry.x, entry.y);
    if (entry.pad) shrinkSurface(s, entry.pad);
    s.rev = entry.from;
    s.dirty = true;
    moved = true;
  }
  // Walk FORWARD (redo): grow FIRST, then apply `after` into the space it was
  // recorded in. The mirror image, and the reason geometry rides the entry.
  while (s.rev < targetRev) {
    const entry = s.journal.find((j) => j.from === s.rev && j.to <= targetRev);
    if (!entry) break;
    if (entry.pad) growSurface(s, entry.pad);
    s.ctx.putImageData(entry.after, entry.x, entry.y);
    s.rev = entry.to;
    s.dirty = true;
    moved = true;
  }
  if (moved) schedulePersist(s);
  return moved && s.rev === targetRev;
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * Draw arbitrary content into a surface (created if absent) and persist it —
 * the primitive for SEEDING a fresh layer's pixels, e.g. a lasso selection
 * lifted into its own raster clip. rev stays 0: the seeded pixels are the
 * surface's baseline, and the first real stroke journals from them (its
 * `before` crop captures them), so undo returns here correctly.
 */
export function writeSurface(
  surfaceId: string,
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
): void {
  const s = surfaceForClip({ surfaceId, width, height, rev: 0 });
  draw(s.ctx, s.width, s.height);
  s.dirty = true;
  schedulePersist(s);
  notifyReady();
}

/**
 * A surface's RGBA bytes — one read, for code that has to look at what was
 * actually painted (separating a layer into its connected regions).
 *
 * Null while the surface is still streaming in from the blob store: an empty
 * buffer would read as an empty layer, and the honest answer to "what is on
 * this layer" before the pixels arrive is "not yet".
 */
export function surfacePixels(
  clip: Pick<RasterClip, "surfaceId" | "width" | "height" | "rev">,
): Uint8ClampedArray | null {
  const s = surfaceForClip(clip);
  if (s.loading || s.width <= 0 || s.height <= 0) return null;
  return s.ctx.getImageData(0, 0, s.width, s.height).data;
}

/** Copy one surface's pixels into another (deep cell duplication). */
export function cloneSurfacePixels(fromId: string, toId: string, width: number, height: number): void {
  const to = surfaceForClip({ surfaceId: toId, width, height, rev: 0 });
  const from = surfaces.get(fromId);
  const paint = (source: CanvasImageSource) => {
    to.ctx.clearRect(0, 0, to.width, to.height);
    to.ctx.drawImage(source, 0, 0);
    to.dirty = true;
    schedulePersist(to);
    notifyReady();
  };
  if (from && !from.loading) {
    paint(from.canvas);
    return;
  }
  // Source still streaming in — copy from its persisted bytes when they land.
  // The `catch` is load-bearing: a floating async IIFE with no handler turns a
  // single undecodable surface blob into an unhandled rejection at the window,
  // which in dev is a full-screen error overlay over a drawing that was
  // otherwise fine. A copy that cannot find its source leaves the cell empty,
  // which is what an empty source looks like anyway.
  void (async () => {
    const blob = await getAssetBlob(fromId);
    if (!blob) return;
    const bitmap = await createImageBitmap(blob);
    paint(bitmap);
    bitmap.close();
  })().catch((err) =>
    reportError(
      new MediaError({
        code: "media/surface-copy-failed",
        message: `Could not read surface ${fromId} to copy from`,
        userMessage: "That drawing couldn’t be copied.",
        severity: "warning",
        announce: false,
        context: { fromId },
        cause: err,
      }),
    ),
  );
}

/**
 * Deleting a cell/layer is a document mutation the user can undo — but
 * freeing its surface here is a side effect OUTSIDE the doc's patch history,
 * invisible to undo/redo. Hard-deleting immediately meant Ctrl+Z correctly
 * brought the clip/track entry back (same surfaceId) with nothing left to
 * read: the pixels were already gone. So deletion here is a GRACE-PERIOD
 * purge, not immediate — pixels stay exactly as they were for a window long
 * enough to cover "delete, then undo" without pinning memory forever.
 * `syncSurfacesToDocument` cancels the purge the instant undo re-references
 * the surfaceId, so a same-session undo always finds its bytes intact.
 */
const GC_GRACE_MS = 60_000;
const pendingDeletion = new Map<string, ReturnType<typeof setTimeout>>();

/** Free surfaces (deleted cells/layers) after a grace period — undo-safe. */
export function deleteSurfaces(ids: string[]): void {
  for (const id of ids) {
    const prev = pendingDeletion.get(id);
    if (prev) clearTimeout(prev);
    pendingDeletion.set(
      id,
      setTimeout(() => {
        pendingDeletion.delete(id);
        const s = surfaces.get(id);
        if (s) {
          for (const j of s.journal) journalBytes -= j.bytes;
          surfaces.delete(id);
        }
        void deleteAssetBlob(id);
      }, GC_GRACE_MS),
    );
  }
}

/**
 * Let go of every surface no document on screen references — the pixels and
 * the undo journal of a project that was closed. Its bytes stay in the blob
 * store (this is not a delete): a dirty surface is persisted first, and the
 * next open of that project streams it back like any first load. The journal
 * has nothing left to undo once the document store has been replaced.
 */
export async function releaseSurfacesNotIn(onScreen: () => readonly MotionDocument[]): Promise<void> {
  const referenced = (id: string) => onScreen().some((d) => rasterSurfaceRefs(d).some((r) => r.surfaceId === id));
  const keep = new Set<string>();
  for (const doc of onScreen()) for (const ref of rasterSurfaceRefs(doc)) keep.add(ref.surfaceId);
  for (const s of [...surfaces.values()]) {
    if (keep.has(s.id) || openTx.has(s.id) || pendingDeletion.has(s.id)) continue;
    const t = persistTimers.get(s.id);
    if (t) {
      clearTimeout(t);
      persistTimers.delete(s.id);
    }
    if (s.dirty) await persistSurface(s);
    // Re-referenced while it saved (the project was reopened): keep it.
    if (referenced(s.id)) continue;
    for (const j of s.journal) journalBytes -= j.bytes;
    surfaces.delete(s.id);
    filmCanvases.delete(s.id);
  }
}

function cancelPendingDeletion(id: string): void {
  const t = pendingDeletion.get(id);
  if (t) {
    clearTimeout(t);
    pendingDeletion.delete(id);
  }
}

// ── Persistence (debounced PNG flush into the asset blob store) ─────────────

const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

function schedulePersist(s: Surface): void {
  const prev = persistTimers.get(s.id);
  if (prev) clearTimeout(prev);
  persistTimers.set(
    s.id,
    setTimeout(() => {
      persistTimers.delete(s.id);
      void persistSurface(s);
    }, 1200),
  );
}

async function persistSurface(s: Surface): Promise<void> {
  if (!s.dirty) return;
  s.dirty = false;
  const blob = await new Promise<Blob | null>((resolve) => s.canvas.toBlob(resolve, "image/png"));
  if (!blob) {
    s.dirty = true;
    return;
  }
  try {
    await putAssetBlob(s.id, blob);
  } catch {
    s.dirty = true; // storage hiccup — the next commit retries
  }
}

/** Flush every dirty surface NOW (project save / export). */
export async function flushSurfaces(): Promise<void> {
  const pending: Array<Promise<void>> = [];
  for (const s of surfaces.values()) {
    const t = persistTimers.get(s.id);
    if (t) {
      clearTimeout(t);
      persistTimers.delete(s.id);
    }
    if (s.dirty) pending.push(persistSurface(s));
  }
  await Promise.all(pending);
}
