"use client";

import * as React from "react";
import {
  LFX,
  applyLookAsGroup,
  ensureFrameEffectClipIn,
  frameEffectClip,
  type MotionDocument,
  type Frame,
  type LayerEffect,
  type LayerEffectType,
  type Preset,
  type VisualClip,
} from "@solomotion/core";
import { drawClipPoster, drawFrameContent, layerBleedPad } from "../../stage/render/draw-frame";
import { ensureEffectPasses } from "../../stage/render/passes/registry";

/**
 * LOOK THUMBNAILS — each tile in the look gallery is the SELECTED layer (or
 * the whole frame) wearing that look, at the playhead.
 *
 * Rendered by the one render contract (`drawClipPoster` for a layer, fitted to
 * its silhouette; `drawFrameContent` for a frame), on a derived document whose
 * only change is the target's stack — the look inserted as a group the way
 * applying it would. So a tile is the picture you get, not a swatch of it.
 *
 * The effect preview engine is the other client of that contract, built for
 * the opposite job: ONE card, looping, at the size of a window. Thirty tiles
 * need thirty stills at 96px, so they take the contract directly and borrow
 * the engine's discipline instead of its machinery:
 *
 *   - PACED: one queue, one render per slice, yielding between them, so
 *     opening the gallery never takes the thread from the stage;
 *   - SMALL: rendered at the tile's device size (`renderScale`), never at
 *     the comp's resolution;
 *   - CACHED by picture: the key is the target's identity at that time (the
 *     clip object, or the document for a frame) plus the look, so scrolling
 *     back costs nothing and an edit invalidates only by changing identity;
 *   - NOBODY LOOKING, NOTHING HAPPENS: a tile asks only while mounted and
 *     withdraws on unmount.
 */

export interface LookSubject {
  doc: MotionDocument;
  frame: Frame;
  /** The layer, or null for the whole frame (its effects clip). */
  clip: VisualClip | null;
  timeMs: number;
  /** Swap into this group instead of adding one (what applying would do). */
  into: string | null;
}

const ids = new WeakMap<object, number>();
let nextId = 1;
const idOf = (o: object) => ids.get(o) ?? (ids.set(o, nextId++), nextId - 1);

/** The picture's identity: what has to change for a tile to be stale. */
function subjectKey(s: LookSubject): string {
  return `${s.clip ? `c${idOf(s.clip)}` : `d${idOf(s.doc)}`}|${Math.round(s.timeMs)}|${s.into ?? ""}`;
}

const CACHE_MAX = 160;
const cache = new Map<string, ImageBitmap | HTMLCanvasElement>();
function remember(key: string, pic: ImageBitmap | HTMLCanvasElement) {
  cache.delete(key);
  cache.set(key, pic);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value as string;
    const gone = cache.get(oldest);
    if (gone && "close" in gone) gone.close();
    cache.delete(oldest);
  }
}

interface Job {
  key: string;
  subject: LookSubject;
  preset: Preset;
  w: number;
  h: number;
  done: Set<() => void>;
}
const queue = new Map<string, Job>();
let running = false;

function pump() {
  if (running) return;
  const job = queue.values().next().value as Job | undefined;
  if (!job) return;
  running = true;
  void render(job)
    .then((pic) => {
      if (pic) remember(job.key, pic);
    })
    .catch(() => {})
    .finally(() => {
      queue.delete(job.key);
      for (const fn of job.done) fn();
      running = false;
      // Yield a frame between tiles: the stage keeps its thread.
      requestAnimationFrame(() => setTimeout(pump, 0));
    });
}

/** The target's stack with the look applied as applying would. */
function stackWith(base: readonly LayerEffect[], preset: Preset, into: string | null): LayerEffect[] {
  return applyLookAsGroup(base, { domain: "layer", preset }, into).effects;
}

function withClip(doc: MotionDocument, clipId: string, fn: (c: VisualClip) => VisualClip): MotionDocument {
  return {
    ...doc,
    tracks: doc.tracks.map((t) => {
      const at = t.clips.findIndex((c) => c.id === clipId);
      if (at < 0) return t;
      const clips = t.clips.slice();
      clips[at] = fn(clips[at] as VisualClip);
      return { ...t, clips };
    }),
  };
}

async function render(job: Job): Promise<ImageBitmap | HTMLCanvasElement | null> {
  const { subject: s, preset, w, h } = job;
  const types = (Array.isArray(preset.data) ? (preset.data as Array<{ type?: string }>) : [])
    .map((e) => e.type)
    .filter((t): t is LayerEffectType => !!t && !!LFX.def(t));
  await ensureEffectPasses(types);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  if (s.clip) {
    const clip = { ...s.clip, effects: stackWith(s.clip.effects, preset, s.into) } as VisualClip;
    const doc = withClip(s.doc, clip.id, () => clip);
    // Fit the silhouette PLUS what the look paints past it, or every shadow
    // and glow is cropped off its own tile.
    const pad = Math.min(400, layerBleedPad(doc, s.frame, clip, s.timeMs));
    if (!drawClipPoster(ctx, doc, s.frame, clip, s.timeMs, w, h, pad)) return null;
  } else {
    // The frame's effects clip, made in a COPY of the tracks when the frame
    // has none yet — the real document is never touched.
    const doc: MotionDocument = { ...s.doc, tracks: s.doc.tracks.map((t) => ({ ...t, clips: t.clips.slice() })) };
    const had = frameEffectClip(s.doc, s.frame.id);
    const fx = ensureFrameEffectClipIn(doc, s.frame.id);
    if (!fx) return null;
    const effects = stackWith(had?.effects ?? [], preset, s.into);
    const derived = withClip(doc, fx.id, (c) => ({ ...c, effects }) as VisualClip);
    const scale = Math.min(w / s.frame.width, h / s.frame.height);
    ctx.translate((w - s.frame.width * scale) / 2, (h - s.frame.height * scale) / 2);
    ctx.scale(scale, scale);
    drawFrameContent(ctx, derived, s.frame, s.timeMs, { renderScale: scale, exporting: true });
  }
  return typeof createImageBitmap === "function" ? createImageBitmap(canvas) : canvas;
}

/**
 * A tile's picture. Returns a ref for the tile's <canvas>; it is painted when
 * the render lands (or at once from the cache). Re-asks when the subject's
 * identity changes, debounced so dragging a slider does not queue thirty
 * renders per tick.
 */
export function useLookThumb(subject: LookSubject | null, preset: Preset, cssW: number, cssH: number) {
  const ref = React.useRef<HTMLCanvasElement | null>(null);
  const dpr = typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(cssW * dpr);
  const h = Math.round(cssH * dpr);
  const key = subject ? `${subjectKey(subject)}|${preset.id}|${w}x${h}` : null;
  const subjectRef = React.useRef(subject);
  subjectRef.current = subject;

  React.useEffect(() => {
    if (!key) return;
    const paint = () => {
      const pic = cache.get(key);
      const el = ref.current;
      if (!pic || !el) return;
      el.width = w;
      el.height = h;
      const ctx = el.getContext("2d");
      ctx?.clearRect(0, 0, w, h);
      ctx?.drawImage(pic, 0, 0);
    };
    if (cache.has(key)) {
      paint();
      return;
    }
    let job: Job | undefined;
    const t = setTimeout(() => {
      const s = subjectRef.current;
      if (!s) return;
      job = queue.get(key);
      if (!job) {
        job = { key, subject: s, preset, w, h, done: new Set() };
        queue.set(key, job);
      }
      job.done.add(paint);
      pump();
    }, 180);
    return () => {
      clearTimeout(t);
      if (!job) return;
      job.done.delete(paint);
      // Nobody waiting and not started: withdraw the ask.
      if (job.done.size === 0 && queue.values().next().value !== job) queue.delete(key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return ref;
}
