"use client";

import {
  boardFirstLevel,
  boardLevel as ladderLevel,
  boardMaxSide,
  BOARD_RUNG_IDLE_MS,
  coarserRung,
  createPictureFill,
  pickRung,
  trimRungs,
} from "@solomotion/core";
import { BOARD_MAX_BYTES, BUDGET_SHARE, cappedShare, onCacheBudgetChange } from "../../cache/memory-budget";
import type { ClipHitRect } from "./draw-frame";

/**
 * RETAINED BOARD PICTURES — the board is a set of pictures, not a set of
 * renders.
 *
 * The free-form canvas shows every comp of a page at once. While you pan, zoom
 * or simply look, none of them changes — yet each full stage render redrew
 * every comp from its vectors, effects and nested scenes. A page of five heavy
 * comps (a film's master, its cut-down, two thumbnails, a brand card) cost over
 * a second a render and froze the browser on an idle board.
 *
 * Figma's answer, and this one: each comp that is not being worked in is kept
 * as a PICTURE, drawn through the camera like any image, and re-rendered only
 * when something it depends on changes (core `compPictureDeps`) or when the
 * zoom asks for more pixels than it has.
 *
 * ── A ladder of levels, like a texture's mipmaps ────────────────────────────
 * A picture is rendered at a power-of-two LEVEL of the device pixels a comp
 * unit covers on screen (core `board-ladder.ts` holds the policy). Zooming IN
 * past a level shows the picture it has (scaled — soft for a moment, never
 * empty) and the sharp one is rendered on an idle tick, one comp per tick
 * (`takeUpgradeSlot`), so a zoom never turns into a stall.
 *
 * Zooming OUT draws the smallest rung that still covers the zoom. It used to
 * draw the sharpest picture it had, smaller — and a 2D canvas has no mipmaps,
 * so after one zoom in and back out every comp was a 4096 px picture resampled
 * into a few hundred pixels on every pan frame, forever: the board never got
 * smooth again. A missing coarse rung is DERIVED by halving the one above it,
 * once (`drawBoardPicture`), not rendered.
 *
 * ── Rungs nobody draws go ───────────────────────────────────────────────────
 * A rung not drawn for a few seconds is released by a timer — never by a
 * stage tick, so an idle board stays free. A comp nobody looks at at all (off
 * screen, or on a page you left) keeps ONE thumbnail-sized rung, so going back
 * shows it at once and sharpens it like a first look. The bytes are a capped
 * share of the app's one memory ceiling (`cache/memory-budget.ts`), which
 * already follows the device, and the longest side a picture may have follows
 * that share.
 *
 * ── A page opens progressively ──────────────────────────────────────────────
 * A MISSING picture used to be rendered on the spot, every one of them in the
 * same tick: opening a page of four heavy scenes was one 11–14 s task — the
 * browser's "page unresponsive" dialog. Now a tick renders misses only inside
 * a budget (`renderInBudget`; the first is always allowed, so the board never
 * starves), and a comp seen for the first time is rendered COARSE first
 * (`firstLevel`) and sharpened on idle ticks like any zoom. A comp still
 * waiting shows the picture it last had (`readStaleBoardPicture`), or its bare
 * board.
 *
 * ── One picture, whatever the transport ─────────────────────────────────────
 * A picture is the PARKED look of its comp at its own level. It never takes
 * the live stage's preview tier or transport: keyed on those, pressing play or
 * the tier governor stepping down re-keyed every picture on the page, the
 * re-render slowed the frame, and the governor stepped down again.
 *
 * ── What is never retained ──────────────────────────────────────────────────
 * The comp you are working in, anything advancing with the playhead, and any
 * comp containing a selected / edited / cropped / effect-focused layer: those
 * render live, exactly as before. The caller decides eligibility; this module
 * only keeps pictures honestly keyed. Pictures are a cache: the board never
 * depends on one existing.
 */

export interface PictureRung {
  canvas: HTMLCanvasElement;
  level: number;
  bytes: number;
  lastDrawn: number;
  /** The stage paint that last drew it — on screen now, if that is the latest paint. */
  lastPaint: number;
}

export interface BoardPicture {
  key: string;
  /** The SHARPEST rung's level — what the zoom is compared against to sharpen. */
  level: number;
  /** Hit rects in COMP space (board offset removed) — clicking works on a picture. */
  hits: ClipHitRect[];
  /** Every rung held, sharpest first. Same key, same picture, different resolutions. */
  rungs: PictureRung[];
  width: number;
  height: number;
}

const budget = () => cappedShare(BUDGET_SHARE.board, BOARD_MAX_BYTES);

const pictures = new Map<string, BoardPicture>();
let totalBytes = 0;
let epoch = 0;
let upgradeSlots = 0;
/** Counts stage paints. A rung drawn by the latest one is ON SCREEN, however long ago that paint was. */
let paint = 0;
/** What a tick may spend on missing pictures beyond its first — taken in turns (core `createPictureFill`). */
const fill = createPictureFill(12);

/** Something outside the document changed what any picture would show
 *  (media decoded, a font, a surface, an engine). Every picture is stale. */
export function endBoardEpoch(): void {
  epoch++;
}

/** A different project, or memory pressure: let everything go. */
export function dropBoardPictures(): void {
  pictures.clear();
  totalBytes = 0;
}

/** Start of a stage tick: how many sharpenings this tick may afford. */
export function beginBoardTick(allowUpgrade: boolean): void {
  upgradeSlots = allowUpgrade ? 1 : 0;
  fill.beginFrame();
  paint++;
  // A paint may have stopped drawing some comp (a page switch, a pan away): the trim decides.
  if (pictures.size > 0) scheduleTrim();
}

/**
 * Render this comp's missing picture if the tick may afford it — the first
 * always may (a board that waits for an idle frame that never comes would
 * never fill), the rest inside the budget, each comp in its turn so the comps
 * drawn first do not starve the rest. Undefined means "a later tick".
 */
export function renderInBudget<T>(compId: string, render: () => T): T | undefined {
  if (!fill.mayMake(compId)) return undefined;
  const t0 = performance.now();
  const out = render();
  fill.made(compId, performance.now() - t0);
  return out;
}

export function takeUpgradeSlot(): boolean {
  if (upgradeSlots <= 0) return false;
  upgradeSlots--;
  return true;
}

/** The level a comp drawn at `devicePxPerUnit` wants — core `boardLevel`, capped by this device's share. */
export function boardLevel(devicePxPerUnit: number, width: number, height: number): number | null {
  return ladderLevel(devicePxPerUnit, width, height, boardMaxSide(budget()));
}

/** The level a comp's FIRST picture renders at — core `boardFirstLevel`. */
export const firstLevel = boardFirstLevel;

export function boardPictureKey(signature: string, timeMs: number, variant: string): string {
  return `${epoch}|${variant}|${timeMs}|${signature}`;
}

/** The picture held for this comp under this key, at whatever level it has. */
export function readBoardPicture(frameId: string, key: string): BoardPicture | null {
  const p = pictures.get(frameId);
  return p && p.key === key ? p : null;
}

/**
 * The picture this comp last had, under ANY key — what a comp waiting for its
 * render slot shows. Stale for a tick or two, which is the trade: soft or a
 * moment old, never a frozen browser.
 */
export function readStaleBoardPicture(frameId: string): BoardPicture | null {
  return pictures.get(frameId) ?? null;
}

const sizeAt = (len: number, level: number) => Math.max(1, Math.round(len * level));

function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function addRung(p: BoardPicture, rung: PictureRung): void {
  const at = p.rungs.findIndex((r) => r.level === rung.level);
  if (at >= 0) {
    totalBytes -= p.rungs[at]!.bytes;
    p.rungs.splice(at, 1);
  }
  p.rungs.push(rung);
  p.rungs.sort((a, b) => b.level - a.level);
  p.level = p.rungs[0]!.level;
  totalBytes += rung.bytes;
}

/**
 * Render a comp into its picture at `level`. `render` paints the comp's content
 * in COMP space onto the given context (already scaled) and returns the hit
 * rects it produced, in board space; `boardX/Y` take them back to comp space.
 *
 * Under the same key it becomes another rung of the same picture; under a new
 * key it replaces the ladder (a canvas of the same size is reused).
 */
export function renderBoardPicture(
  frameId: string,
  key: string,
  level: number,
  width: number,
  height: number,
  boardX: number,
  boardY: number,
  nowMs: number,
  render: (ctx: CanvasRenderingContext2D) => ClipHitRect[],
): BoardPicture | null {
  const pw = sizeAt(width, level);
  const ph = sizeAt(height, level);
  const old = pictures.get(frameId);
  const same = old && old.key === key && old.width === width && old.height === height;
  const reuse = old?.rungs.find((r) => r.canvas.width === pw && r.canvas.height === ph)?.canvas;
  const canvas = reuse ?? newCanvas(pw, ph);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, pw, ph);
  // Exactly picture-sized (the size is rounded), so the comp's edge never seams.
  ctx.setTransform(pw / width, 0, 0, ph / height, 0, 0);
  const hits = render(ctx).map((r) => ({ ...r, cx: r.cx - boardX, cy: r.cy - boardY }));
  const rung: PictureRung = { canvas, level, bytes: pw * ph * 4, lastDrawn: nowMs, lastPaint: paint };
  let p: BoardPicture;
  if (same) {
    p = old;
    // A reused canvas belonged to a rung of this picture: that rung is this one now.
    if (reuse) {
      const at = p.rungs.findIndex((r) => r.canvas === reuse);
      totalBytes -= p.rungs[at]!.bytes;
      p.rungs.splice(at, 1);
    }
    p.hits = hits;
  } else {
    if (old) for (const r of old.rungs) totalBytes -= r.bytes;
    p = { key, level, hits, rungs: [], width, height };
    pictures.set(frameId, p);
  }
  addRung(p, rung);
  evict(frameId);
  scheduleTrim();
  return p;
}

/**
 * A coarser rung made from a sharper one by repeated halving — each step
 * averages four pixels into one, which is what a mipmap level is. Once, when
 * the zoom first asks for it; never per frame.
 */
function deriveRung(p: BoardPicture, from: PictureRung, level: number, nowMs: number): PictureRung {
  let src: HTMLCanvasElement = from.canvas;
  let cur = from.level;
  const tw = sizeAt(p.width, level);
  const th = sizeAt(p.height, level);
  while (cur / 2 > level + 1e-9) {
    cur /= 2;
    const step = newCanvas(sizeAt(p.width, cur), sizeAt(p.height, cur));
    const g = step.getContext("2d")!;
    g.imageSmoothingQuality = "high";
    g.drawImage(src, 0, 0, step.width, step.height);
    src = step;
  }
  const out = newCanvas(tw, th);
  const g = out.getContext("2d")!;
  g.imageSmoothingQuality = "high";
  g.drawImage(src, 0, 0, tw, th);
  const rung: PictureRung = { canvas: out, level, bytes: tw * th * 4, lastDrawn: nowMs, lastPaint: paint };
  addRung(p, rung);
  return rung;
}

/**
 * Draw a picture over the comp's box (the caller's context is in comp space),
 * from the rung that fits `want` — the level the zoom asks for.
 */
export function drawBoardPicture(
  g: CanvasRenderingContext2D,
  p: BoardPicture,
  width: number,
  height: number,
  nowMs: number,
  want: number,
): void {
  if (p.rungs.length === 0) return;
  let rung = p.rungs[pickRung(p.rungs.map((r) => r.level), want)]!;
  const coarser = coarserRung(rung.level, want);
  if (coarser != null) {
    rung = deriveRung(p, rung, coarser, nowMs);
    evict(null);
  }
  rung.lastDrawn = nowMs;
  rung.lastPaint = paint;
  g.drawImage(rung.canvas, 0, 0, width, height);
}

// ── Letting go ──────────────────────────────────────────────────────────────

let trimTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * A timer, not a tick: dropping a rung nobody draws changes nothing on screen.
 * Armed by a paint and re-armed only while some rung is waiting to age out, so
 * an idle board — nothing painting, everything settled — runs nothing at all.
 */
function scheduleTrim(): void {
  if (trimTimer != null || typeof window === "undefined") return;
  trimTimer = setTimeout(trimBoardPictures, BOARD_RUNG_IDLE_MS + 250);
}

/** Release every rung nobody has drawn lately; park unwatched comps at a thumbnail. Exported for tests and the HUD. */
export function trimBoardPictures(): void {
  trimTimer = null;
  const now = performance.now();
  let more = false;
  for (const p of pictures.values()) {
    // On screen in the latest paint: in use, however long the board has been still.
    const uses = p.rungs.map((r) => ({ level: r.level, lastDrawn: r.lastPaint === paint ? now : r.lastDrawn }));
    const { drop, park } = trimRungs(uses, now, p.width, p.height);
    if (park != null) {
      // Derive the thumbnail before letting the rung it comes from go.
      const from = p.rungs[p.rungs.length - 1]!;
      const parked = deriveRung(p, from, park, from.lastDrawn);
      parked.lastPaint = from.lastPaint;
      for (const r of p.rungs.filter((r) => r !== parked)) totalBytes -= r.bytes;
      p.rungs = [parked];
      p.level = parked.level;
      continue;
    }
    if (drop.length) {
      const gone = new Set(drop.map((i) => p.rungs[i]!));
      for (const r of gone) totalBytes -= r.bytes;
      p.rungs = p.rungs.filter((r) => !gone.has(r));
      p.level = p.rungs[0]!.level;
    }
    // A rung kept only because it was drawn a moment ago ages out on a later run;
    // one on screen now is reconsidered by the next paint, which re-arms the timer.
    if (p.rungs.some((r) => r.lastPaint !== paint) && (p.rungs.length > 1 || trimRungs(p.rungs, Infinity, p.width, p.height).park != null)) more = true;
  }
  if (more) scheduleTrim();
}

function evict(keep: string | null): void {
  const cap = budget();
  if (totalBytes <= cap) return;
  const seen = (p: BoardPicture) => Math.max(...p.rungs.map((r) => r.lastDrawn));
  const order = [...pictures.entries()].filter(([id]) => id !== keep).sort((a, b) => seen(a[1]) - seen(b[1]));
  for (const [id, p] of order) {
    if (totalBytes <= cap) break;
    pictures.delete(id);
    for (const r of p.rungs) totalBytes -= r.bytes;
  }
}

// A smaller ceiling (or the render cache switching on and taking its share) applies at once.
if (typeof window !== "undefined") onCacheBudgetChange(() => evict(null));

/** What the board holds — for the perf HUD and the dev hook. */
export function boardPictureStats(): { pictures: number; rungs: number; bytes: number; budget: number } {
  let rungs = 0;
  for (const p of pictures.values()) rungs += p.rungs.length;
  return { pictures: pictures.size, rungs, bytes: totalBytes, budget: budget() };
}
