"use client";

import {
  PREVIEW_RESOLUTION_SCALE,
  PreviewPacer,
  effectPreviewLoopMs,
  frameStepMs,
  layerEffectMoves,
  layerEffectPath,
  layerEffectPictureAt,
  loopFrameCount,
  partitionScene,
  tierForDisplay,
  type MotionDocument,
  type Clip,
  type EffectPreviewSettings,
  type Frame,
  type LayerEffect,
} from "@solomotion/core";
import { BUDGET_SHARE, EFFECT_PREVIEW_MAX_BYTES, cappedShare } from "../../cache/memory-budget";
import { drawFrameContent, layerBleedPad, layerEffectPaintsAt } from "../../stage/render/draw-frame";
import { stageHitRects } from "../../stage/stage-geometry";
import { createIncrementalScene } from "../../stage/render/live-raster";
import { useSession } from "../../state/session";
import { previewDocuments } from "./preview-doc";
import { NAMES } from "@/editor/names";

/**
 * THE EFFECT PREVIEW'S RENDERER — a client of the stage's pipeline, not a
 * second renderer beside it.
 *
 * The old preview rendered the whole comp through `drawFrameContent` on every
 * tick of its clock, twice in Split, with the clock handed to every layer.
 * Every layer's cache key changed per tick, so nothing was ever reused and the
 * layer cache filled with pictures nobody would ask for again, evicting the
 * stage's. Pixel effects ran at full document resolution inside a box a few
 * hundred pixels wide, and the loop had no idea what a frame cost. On a heavy
 * layer that is a main thread at 100% — and the app with it.
 *
 * What one tick costs now, from the bottom up:
 *
 *  1. THE SCENE AROUND THE LAYER is baked once — the stage's incremental scene
 *     (`createIncrementalScene`, its own instance), verified by clip identity
 *     like the stage's. Everything below the layer and above it is two blits.
 *  2. THE CARDS BENEATH YOURS are a kept prefix (`DrawOptions.effectFocus`),
 *     computed once and valid across edits to your card. The stage cuts the
 *     stack at the same card while this window is open, so the two surfaces
 *     never run the work below twice between them.
 *  3. ONLY YOUR CARD'S CLOCK MOVES. The document stays on the playhead; the
 *     lead reaches this card and the ones above it, nothing else.
 *  4. A LOOP IN MEMORY, IN COMP SPACE. A moving card plays a loop of
 *     `effectPreviewLoopMs`. What is kept is the LAYER'S REGION — the only
 *     pixels the card can change (its box plus the renderer's own bleed pad)
 *     — in frame coordinates, over one still picture of the rest of the
 *     scene. The camera is not part of any of it, so panning and zooming are
 *     redraws, never re-renders; only an edit throws the loop away. Frames
 *     are keyed by the card's PICTURE where it declares one: a 3-drawing
 *     boil is three renders a loop, not sixty.
 *  5. PACED, AND HONEST ABOUT WEIGHT. `PreviewPacer` spaces renders so the
 *     preview never takes more than its share of the thread; a card whose
 *     frame costs more than a frame is paused until you ask for it, and then
 *     builds its loop at the paced rate and plays from memory.
 *  6. AT THE RESOLUTION IT IS SHOWN. Auto renders at the softest tier that
 *     still fills the preview's device pixels — After Effects' Auto. Frames
 *     are kept per tier: zoom in and the softer frames stand in until the
 *     sharper ones arrive, zoom back out and they are still there.
 */

export type PreviewMode = "after" | "split" | "before";

export interface PreviewCamera {
  scale: number;
  tx: number;
  ty: number;
}

export interface PreviewInput {
  doc: MotionDocument;
  clip: Clip;
  effectId: string;
  frame: Frame | null;
  /** Document time the picture is frozen at. */
  timeMs: number;
  fps: number;
  /** CSS px. */
  width: number;
  height: number;
  camera: PreviewCamera;
  mode: PreviewMode;
  split: number;
  settings: EffectPreviewSettings;
}

/** Why a moving preview is standing still. */
export type PreviewHold = "heavy" | "user" | "stage" | null;

export interface PreviewStatus {
  /** Does the card move at all? A still card never runs a clock. */
  alive: boolean;
  playing: boolean;
  hold: PreviewHold;
  /** How much of the loop is in memory, 0..1. */
  cached: number;
  /** The last render's cost, ms. */
  costMs: number;
  /**
   * The card changes NOTHING at this instant — Before and After are the same
   * picture on every frame compared. Almost always a card keyed off (or to
   * zero) at the playhead; saying so is the difference between "the preview is
   * broken" and "move the playhead".
   */
  silent: boolean;
}

const IDLE: PreviewStatus = { alive: false, playing: false, hold: null, cached: 0, costMs: 0, silent: false };

/** An edit younger than this holds the clock: you are still dragging. */
const EDIT_HOLD_MS = 250;

type Variant = "after" | "before";

export class EffectPreviewEngine {
  private canvas: HTMLCanvasElement | null = null;
  private input: PreviewInput | null = null;
  private readonly scene = createIncrementalScene();
  private readonly pacer = new PreviewPacer();

  /**
   * What the kept pictures are pictures OF — the document, the subject, the
   * instant, the scoping. Never the camera or the canvas size: pictures are
   * kept in comp space and drawn through the view.
   */
  private version: readonly unknown[] = [];
  /** Kept frames of the layer's region, by `tier|variant|picture`. */
  private readonly ring = new Map<string, HTMLCanvasElement>();
  /** The still rest of the scene, per tier — outside the region nothing moves. */
  private readonly context = new Map<number, HTMLCanvasElement>();
  private ringBytes = 0;
  private readonly spare: HTMLCanvasElement[] = [];
  private scratch: HTMLCanvasElement | null = null;
  /** The region the card can change, in frame px — measured once per picture. */
  private region: { x: number; y: number; w: number; h: number } | null = null;
  private pictures: number | null = null;

  private index = 0;
  private lastAdvance = 0;
  private lastEdit = -Infinity;
  /** The picture on screen is stale — something changed since it was drawn. */
  private dirty = true;
  /** Play wish: auto (play unless heavy), or the user's own choice. */
  private wish: "auto" | "play" | "pause" = "auto";
  private subject = "";
  private raf = 0;
  /** Is the card silent at the playhead? Judged once per picture — see `silentHere`. */
  private silent: boolean | null = null;

  private status: PreviewStatus = IDLE;
  private readonly listeners = new Set<() => void>();

  constructor() {
    // Dev only, beside `window.__<ns>`: the open preview, for a console or a
    // driving script to read its cost and loop without pixel-reading.
    if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
      (window as unknown as Record<string, unknown>)[NAMES.wire.debug("Preview")] = this;
    }
  }

  attach(canvas: HTMLCanvasElement | null): void {
    this.canvas = canvas;
    this.dirty = true;
    if (canvas && !this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.canvas = null;
    this.clearRing();
    for (const c of this.spare) c.width = c.height = 0;
    this.spare.length = 0;
    this.scene.end();
  }

  /** Called on every React render with what is on screen; cheap when nothing changed. */
  update(input: PreviewInput): void {
    const subject = `${input.clip.id}|${input.effectId}`;
    if (subject !== this.subject) {
      this.subject = subject;
      this.wish = "auto";
      this.pacer.reset();
      this.index = 0;
    }
    this.input = input;
    const version = [
      input.doc, input.clip.id, input.effectId, input.frame, input.timeMs, input.settings.stack, input.settings.scene,
    ];
    if (!sameTuple(version, this.version)) {
      const edited = this.version[0] !== undefined && this.version[0] !== input.doc;
      this.version = version;
      this.clearRing();
      this.silent = null;
      this.region = null;
      this.pictures = null;
      if (edited) this.lastEdit = performance.now();
    }
    // Camera, size, mode and split recompose what is kept; none is a new picture.
    this.dirty = true;
  }

  play(): void {
    this.wish = "play";
    this.lastAdvance = performance.now();
    this.emit();
  }

  pause(): void {
    this.wish = "pause";
    this.emit();
  }

  getStatus = (): PreviewStatus => this.status;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  // ── What is being previewed ───────────────────────────────────────────────

  private dpr(): number {
    return Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
  }

  /** Document px per frame px for the pixel pipeline — the preview's tier. */
  private renderScale(input: PreviewInput, dpr: number): number {
    const r = input.settings.resolution;
    const tier = r === "auto" ? tierForDisplay(input.camera.scale * dpr) : r;
    return PREVIEW_RESOLUTION_SCALE[tier];
  }

  /** Does THIS card move, and do the cards the "before" picture keeps? */
  private liveness(input: PreviewInput): { after: boolean; before: boolean } {
    const clip = input.clip;
    if (clip.kind === "audio") return { after: false, before: false };
    const at = clip.effects.findIndex((e) => e.id === input.effectId);
    const card = at >= 0 ? clip.effects[at] : undefined;
    const path = layerEffectPath(input.effectId, "");
    const modulated = (clip.modulators ?? []).some((m) => m.target.startsWith(path));
    const after = (!!card && card.enabled && layerEffectMoves(card)) || modulated;
    // "Before" is the stack without this card; its clock only reaches the
    // cards above it, which exist in the preview only when it runs them all.
    const before =
      after && input.settings.stack === "all" && clip.effects.slice(at + 1).some((e) => e.enabled && layerEffectMoves(e));
    return { after, before };
  }

  private loopFrames(input: PreviewInput): { frames: number; frameMs: number } {
    const frameMs = frameStepMs(input.fps);
    const card = input.clip.kind !== "audio" ? input.clip.effects.find((e) => e.id === input.effectId) : undefined;
    return { frames: loopFrameCount(effectPreviewLoopMs(card), frameMs), frameMs };
  }

  // ── The loop ──────────────────────────────────────────────────────────────

  private tick = (now: number): void => {
    this.raf = requestAnimationFrame(this.tick);
    const input = this.input;
    if (!input || !this.canvas || !input.frame) return;
    const live = this.liveness(input);
    const { frames, frameMs } = this.loopFrames(input);
    const stageBusy = useSession.getState().playing;
    const heavy = this.pacer.heavy(frameMs, this.pictureCount(live, frames)) && this.cachedShare(live, frames) < 1;
    const hold: PreviewHold = !live.after
      ? null
      : this.wish === "pause"
        ? "user"
        : stageBusy
          ? "stage"
          : this.wish === "auto" && heavy && input.settings.pauseWhenHeavy
            ? "heavy"
            : null;
    const playing = live.after && hold === null;
    const editing = now - this.lastEdit < EDIT_HOLD_MS;
    if (!live.after) this.index = 0;

    if (!playing || editing) {
      // Standing still: only a stale picture costs anything.
      if (this.dirty && this.pacer.mayRender(now)) this.present(this.index % frames, live);
      this.setStatus(live, playing, hold, frames);
      return;
    }
    if (this.dirty && this.pacer.mayRender(now)) this.present(this.index % frames, live);
    if (now - this.lastAdvance < frameMs) {
      this.setStatus(live, playing, hold, frames);
      return;
    }
    const next = (this.index + 1) % frames;
    // Kept → blit on time. Not kept → render only when the pacer allows; the
    // clock WAITS for it, so a heavy first lap plays slow rather than
    // starving the app, and every lap after it is real time.
    if (this.has(next, live) || this.pacer.mayRender(now)) {
      this.index = next;
      this.present(next, live);
      // Hold the cadence without bursting to catch up after a slow frame.
      this.lastAdvance = Math.max(this.lastAdvance + frameMs, now - frameMs);
    }
    this.setStatus(live, playing, hold, frames);
  };

  /** Compose the visible canvas for loop frame `i`, through the camera. */
  private present(i: number, live: { after: boolean; before: boolean }): void {
    const input = this.input!;
    const canvas = this.canvas!;
    const frame = input.frame!;
    const dpr = this.dpr();
    const w = Math.round(input.width * dpr);
    const h = Math.round(input.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const tier = this.renderScale(input, dpr);
    const region = this.regionOf();
    const after = input.mode !== "before" ? this.frameOf(tier, "after", this.pictureOf(i, "after", live)) : null;
    const before = input.mode !== "after" ? this.frameOf(tier, "before", this.pictureOf(i, "before", live)) : null;
    const context = input.settings.scene === "alone" ? null : this.contextOf(tier);
    const cam = input.camera;
    const view = (fn: () => void) => {
      ctx.save();
      ctx.setTransform(dpr * cam.scale, 0, 0, dpr * cam.scale, dpr * cam.tx, dpr * cam.ty);
      ctx.imageSmoothingQuality = "high";
      fn();
      ctx.restore();
    };
    const paintVariant = (img: HTMLCanvasElement | null) =>
      view(() => {
        if (context) ctx.drawImage(context, 0, 0, frame.width, frame.height);
        if (!img) return;
        ctx.clearRect(region.x, region.y, region.w, region.h);
        ctx.drawImage(img, region.x, region.y, region.w, region.h);
      });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (input.mode === "split" && after && before) {
      paintVariant(after);
      const x = Math.round(w * input.split);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, x, h);
      ctx.clip();
      ctx.clearRect(0, 0, x, h);
      paintVariant(before);
      ctx.restore();
    } else {
      paintVariant(after ?? before);
    }
    this.dirty = false;
  }

  /**
   * Does the card paint nothing at the playhead, on any frame of its loop?
   * Asked of the renderer's own compiler (`layerEffectPaintsAt`) — no pixels,
   * no readback. A moving card is sampled across the loop: a strike that lands
   * on frame 30 is not silent.
   */
  private silentHere(frames: number): boolean {
    const input = this.input!;
    if (input.clip.kind === "audio") return false;
    const { frameMs } = this.loopFrames(input);
    const local = input.timeMs - input.clip.startMs;
    const samples = Math.min(frames, 16);
    for (let k = 0; k < samples; k++) {
      const lead = Math.floor((k * frames) / samples) * frameMs;
      if (layerEffectPaintsAt(input.clip, input.effectId, local, lead)) return false;
    }
    return true;
  }

  /**
   * WHICH PICTURE loop frame `i` is. A card that changes only at its clock's
   * steps (`picture` in its registry entry — boil, grain, roughen) names the
   * step; frames showing the same step are one render. Anything else that
   * moves — a keyed card, a modulator, a continuous card — is its own frame.
   */
  private pictureOf(i: number, variant: Variant, live: { after: boolean; before: boolean }): string {
    const moving = variant === "after" ? live.after : live.before;
    if (!moving) return "still";
    const input = this.input!;
    const clip = input.clip;
    if (clip.kind === "audio") return `f${i}`;
    const at = clip.effects.findIndex((e) => e.id === input.effectId);
    const from = variant === "after" ? at : at + 1;
    const stack = input.settings.stack;
    const upTo = stack === "all" ? clip.effects.length : at + 1;
    const cards = clip.effects.slice(Math.max(0, from), upTo).filter((e) => e.enabled && layerEffectMoves(e));
    const { frameMs } = this.loopFrames(input);
    const t = (input.timeMs - clip.startMs + i * frameMs) / 1000;
    const keys: string[] = [];
    for (const fx of cards) {
      if (!steppedAlone(clip, fx)) return `f${i}`;
      keys.push(`${fx.id}:${layerEffectPictureAt(fx, t)}`);
    }
    return keys.join(",") || `f${i}`;
  }

  /**
   * The pixels this card can change, in frame px: the layer's painted box as
   * the stage published it (rotation, nesting and instancing included) grown
   * by the renderer's own bleed pad. Unknown → the whole frame.
   */
  private regionOf(): { x: number; y: number; w: number; h: number } {
    if (this.region) return this.region;
    const input = this.input!;
    const frame = input.frame!;
    const whole = { x: 0, y: 0, w: frame.width, h: frame.height };
    const hit = stageHitRects.current.find((r) => r.clipId === input.clip.id);
    const docs = previewDocuments(input.doc, input.clip.id, input.effectId, input.settings.stack);
    const clip = docs.after.tracks.flatMap((t) => t.clips).find((c) => c.id === input.clip.id);
    if (!hit || !clip || clip.kind === "audio") return (this.region = whole);
    const rad = (hit.rotation * Math.PI) / 180;
    const bw = Math.abs(hit.width * Math.cos(rad)) + Math.abs(hit.height * Math.sin(rad));
    const bh = Math.abs(hit.width * Math.sin(rad)) + Math.abs(hit.height * Math.cos(rad));
    // Conservative on purpose: a region one pixel short is a seam between the
    // moving picture and the still one around it.
    const pad = layerBleedPad(docs.after, frame, clip, input.timeMs) * 1.25 + 8;
    const x = Math.floor(hit.cx - frame.x - bw / 2 - pad);
    const y = Math.floor(hit.cy - frame.y - bh / 2 - pad);
    return (this.region = { x, y, w: Math.ceil(bw + pad * 2), h: Math.ceil(bh + pad * 2) });
  }

  private has(i: number, live: { after: boolean; before: boolean }): boolean {
    const input = this.input!;
    const tier = this.renderScale(input, this.dpr());
    const needAfter = input.mode !== "before";
    const needBefore = input.mode !== "after";
    return (
      (!needAfter || this.ring.has(`${tier}|after|${this.pictureOf(i, "after", live)}`)) &&
      (!needBefore || this.ring.has(`${tier}|before|${this.pictureOf(i, "before", live)}`))
    );
  }

  /**
   * A kept frame at this tier, or a fresh render of it. When the pacer says
   * not yet, the same picture at ANOTHER tier stands in — soft for a moment
   * after a zoom rather than blank.
   */
  private frameOf(tier: number, variant: Variant, picture: string): HTMLCanvasElement | null {
    const key = `${tier}|${variant}|${picture}`;
    const kept = this.ring.get(key);
    if (kept) return kept;
    if (!this.pacer.mayRender(performance.now())) {
      for (const [k, c] of this.ring) if (k.endsWith(`|${variant}|${picture}`)) return c;
    }
    const r = this.regionOf();
    const w = Math.max(1, Math.ceil(r.w * tier));
    const h = Math.max(1, Math.ceil(r.h * tier));
    const bytes = w * h * 4;
    const admit = this.admit(bytes, tier);
    const target = admit ? this.takeCanvas(w, h) : this.scratchCanvas(w, h);
    const start = performance.now();
    const ok = this.render(target, variant, picture, tier);
    this.pacer.note(start, performance.now());
    if (!ok) return null;
    if (admit) {
      this.ring.set(key, target);
      this.ringBytes += bytes;
    }
    return target;
  }

  /** The still scene around the region at this tier, rendered once. */
  private contextOf(tier: number): HTMLCanvasElement | null {
    const kept = this.context.get(tier);
    if (kept) return kept;
    const input = this.input!;
    const frame = input.frame!;
    const w = Math.max(1, Math.ceil(frame.width * tier));
    const h = Math.max(1, Math.ceil(frame.height * tier));
    if (!this.admit(w * h * 4, tier)) return null;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    if (!g) return null;
    const docs = previewDocuments(input.doc, input.clip.id, input.effectId, input.settings.stack);
    // "Beneath" leaves the layers above out everywhere, not only in the region.
    const cut = input.settings.scene === "beneath" ? partitionScene(docs.after, [frame], new Set([input.clip.id])) : null;
    g.setTransform(tier, 0, 0, tier, 0, 0);
    drawFrameContent(g, docs.after, frame, input.timeMs, {
      only: cut ? new Set([...cut.below, ...cut.changing]) : null,
      renderScale: tier,
      previewScale: tier,
    });
    this.context.set(tier, c);
    this.ringBytes += w * h * 4;
    return c;
  }

  /** Room for `bytes`, making it from other tiers first — never from this one. */
  private admit(bytes: number, tier: number): boolean {
    const cap = cappedShare(BUDGET_SHARE.effectPreview, EFFECT_PREVIEW_MAX_BYTES);
    if (this.ringBytes + bytes <= cap) return true;
    for (const [k, c] of this.ring) {
      if (k.startsWith(`${tier}|`)) continue;
      this.ringBytes -= c.width * c.height * 4;
      this.recycle(c);
      this.ring.delete(k);
      if (this.ringBytes + bytes <= cap) return true;
    }
    for (const [t, c] of this.context) {
      if (t === tier) continue;
      this.ringBytes -= c.width * c.height * 4;
      c.width = c.height = 0;
      this.context.delete(t);
      if (this.ringBytes + bytes <= cap) return true;
    }
    return false;
  }

  /** One variant of the layer's region at one picture, into `target`, in frame space. */
  private render(target: HTMLCanvasElement, variant: Variant, picture: string, tier: number): boolean {
    const input = this.input!;
    const frame = input.frame!;
    const g = target.getContext("2d");
    if (!g) return false;
    const docs = previewDocuments(input.doc, input.clip.id, input.effectId, input.settings.stack);
    const doc = variant === "after" ? docs.after : docs.before;
    const { frameMs } = this.loopFrames(input);
    // The first loop frame showing this picture — any of them is the picture.
    const leadMs = this.leadFor(picture, variant) * frameMs;
    const r = this.regionOf();
    const paint = (dst: CanvasRenderingContext2D, only: ReadonlySet<string> | null, board: boolean, onComposite: boolean, lead: number) => {
      dst.save();
      dst.setTransform(tier, 0, 0, tier, -r.x * tier, -r.y * tier);
      drawFrameContent(dst, doc, frame, input.timeMs, {
        only,
        transparent: !board,
        _onComposite: onComposite || undefined,
        renderScale: tier,
        previewScale: tier,
        effectFocus: { clipId: input.clip.id, effectId: input.effectId, leadMs: lead },
      });
      dst.restore();
    };
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, target.width, target.height);
    const subject = new Set([input.clip.id]);
    if (input.settings.scene === "alone") {
      paint(g, subject, false, false, leadMs);
      return true;
    }
    const cut = this.scene.prepare(doc, [frame], subject, `${tier}|${r.x}|${r.y}|${r.w}|${r.h}|${input.timeMs}`, {
      paintSlice: (dst, only, board) => paint(dst, only, board, false, 0),
      width: target.width,
      height: target.height,
    });
    if (!cut) {
      // The scene refused the cut (an adjustment above, glass reading the
      // layer, a driven document…) — render the region whole, as the stage would.
      paint(g, null, true, false, leadMs);
      return true;
    }
    cut.blitBelow(g);
    paint(g, cut.changingOnly, false, true, leadMs);
    if (input.settings.scene === "scene") cut.blitAbove(g);
    return true;
  }

  /** How many distinct pictures the loop holds — what building it costs. Per picture version. */
  private pictureCount(live: { after: boolean; before: boolean }, frames: number): number {
    if (this.pictures !== null) return this.pictures;
    const seen = new Set<string>();
    for (let i = 0; i < frames; i++) seen.add(this.pictureOf(i, "after", live));
    return (this.pictures = seen.size);
  }

  /** The loop frame a picture key was first seen at — its clock position. */
  private leadFor(picture: string, variant: Variant): number {
    const m = /^f(\d+)$/.exec(picture);
    if (m) return Number(m[1]);
    if (picture === "still") return 0;
    const input = this.input!;
    const live = this.liveness(input);
    const { frames } = this.loopFrames(input);
    for (let i = 0; i < frames; i++) if (this.pictureOf(i, variant, live) === picture) return i;
    return 0;
  }

  // ── Memory ────────────────────────────────────────────────────────────────

  private takeCanvas(w: number, h: number): HTMLCanvasElement {
    const c = this.spare.pop() ?? document.createElement("canvas");
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    return c;
  }

  private scratchCanvas(w: number, h: number): HTMLCanvasElement {
    const c = (this.scratch ??= document.createElement("canvas"));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    return c;
  }

  private recycle(c: HTMLCanvasElement): void {
    if (this.spare.length < 8) this.spare.push(c);
    else c.width = c.height = 0;
  }

  private clearRing(): void {
    // Canvases are recycled, not re-allocated: an edit clears the loop many
    // times a second while a slider moves.
    for (const c of this.ring.values()) this.recycle(c);
    for (const c of this.context.values()) c.width = c.height = 0;
    this.ring.clear();
    this.context.clear();
    this.ringBytes = 0;
    this.dirty = true;
  }

  private cachedShare(live: { after: boolean; before: boolean }, frames: number): number {
    if (!live.after || !this.input) return 1;
    const tier = this.renderScale(this.input, this.dpr());
    let n = 0;
    for (let i = 0; i < frames; i++) if (this.ring.has(`${tier}|after|${this.pictureOf(i, "after", live)}`)) n++;
    return n / frames;
  }

  // ── Status, for the UI — changes rarely, never per frame ──────────────────

  private setStatus(live: { after: boolean; before: boolean }, playing: boolean, hold: PreviewHold, frames: number): void {
    // Quantised, so a building loop re-renders React twenty times, not per frame.
    const cached = Math.floor(this.cachedShare(live, frames) * 20) / 20;
    const costMs = Math.round(this.pacer.costMs());
    const silent = (this.silent ??= this.silentHere(frames));
    const s = this.status;
    if (
      s.alive === live.after && s.playing === playing && s.hold === hold && s.cached === cached &&
      s.silent === silent && Math.abs(s.costMs - costMs) < 5
    ) return;
    this.status = { alive: live.after, playing, hold, cached, costMs, silent };
    for (const cb of this.listeners) cb();
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }
}

function sameTuple(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Does this moving card change only at its clock's steps, on its own? Its
 * picture is then a key — unless its fields are keyed or modulated, which move
 * it between steps too (the rule `picture-steady.ts` keeps for the stage).
 */
function steppedAlone(clip: Clip, fx: LayerEffect): boolean {
  if (layerEffectPictureAt(fx, 0) === null) return false;
  const prefix = layerEffectPath(fx.id, "");
  if (clip.keyframes.some((t) => t.property.startsWith(prefix))) return false;
  return !(clip.kind !== "audio" && (clip.modulators ?? []).some((m) => m.target.startsWith(prefix)));
}
