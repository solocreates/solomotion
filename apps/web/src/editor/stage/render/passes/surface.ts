"use client";

import {
  buildSurfaceLayers,
  cutSurface,
  shadeSurfaceTile,
  surfaceFrontField,
  surfaceFrontMask,
  surfaceLayersKey,
  surfaceLightMask,
  surfaceMorphEnds,
  surfaceMottle,
  surfaceOverlaysAll,
  surfaceReadsPicture,
  surfaceTextureSide,
  surfaceTileKey,
  type SurfaceParams,
  type SurfaceTile,
} from "@solomotion/core";
import { acquireTemp, nextOutput, releaseTemp, type Buf } from "./buffers";
import { readPixels } from "./resample";
import type { PassEnv, PassFn } from "./types";

/**
 * SURFACE — the texture family's renderer. A lazy chunk: nothing here loads
 * until a document uses a Surface card.
 *
 * Deliberately stupid, like the analog family: core (`animation/surface.ts`)
 * builds the material, lights it, finds the picture's shapes and cuts them;
 * this file uploads the result and composites it with two blend modes every
 * engine has (multiply and screen) — never `ctx.filter`, so WebKit draws the
 * same sheet as Chrome.
 *
 * Caches, each against the exact key that produced it (a few entries each,
 * since a morph shows two materials at once):
 *   layers   the material's raw fields — (material, unit, seed). The costly one.
 *   tile     those fields lit — + relief, tooth, light. A dial move relights
 *            without regenerating fibres.
 *   mottle   the coarse tone for one region size and one step.
 *   front    a morph's "where the new material arrives first", per region;
 *            a frame only re-thresholds it.
 * A still sheet costs one of each for the whole timeline; a stop-motion sheet
 * re-rolls by OFFSETTING the tile, so a step costs a pattern transform and a
 * sixteenth-resolution mottle.
 */

interface LitTile {
  tile: SurfaceTile;
  dark: HTMLCanvasElement;
  light: HTMLCanvasElement;
  /** The recipe's colour map (a phosphor's triads), multiplied over the picture. */
  color: HTMLCanvasElement | null;
}

/**
 * Each cache is bounded by BYTES, least recently used out — never by a count.
 * Six slots were right for one layer and a morph (two materials a frame) and
 * wrong for any wall of looks: a 3×3 cover asks for nine tiles a frame in
 * order, so a six-slot LRU evicted each one just before it was asked for again
 * and rebuilt all nine — fibres, facets, a rank sort — on every pan tick.
 */
const CACHE_BYTES = 96 * 1024 * 1024;

interface Kept<V> {
  value: V;
  bytes: number;
}

/** What `v` holds in pixels and typed arrays, two levels deep — what it costs to keep. */
function bytesOf(v: unknown, depth = 0): number {
  if (v == null || typeof v !== "object") return 0;
  if (ArrayBuffer.isView(v)) return v.byteLength;
  if (typeof HTMLCanvasElement !== "undefined" && v instanceof HTMLCanvasElement) return v.width * v.height * 4;
  if (depth > 2) return 0;
  let n = 0;
  for (const x of Object.values(v)) n += bytesOf(x, depth + 1);
  return n;
}

function byteCache<V>() {
  const map = new Map<string, Kept<V>>();
  let total = 0;
  return (key: string, make: () => V): V => {
    const hit = map.get(key);
    if (hit) {
      map.delete(key);
      map.set(key, hit);
      return hit.value;
    }
    const value = make();
    const bytes = bytesOf(value);
    map.set(key, { value, bytes });
    total += bytes;
    // Never the entry just made: a frame always gets what it asked for.
    for (const [k, e] of map) {
      if (total <= CACHE_BYTES || k === key) break;
      map.delete(k);
      total -= e.bytes;
    }
    return value;
  };
}

const layersCache = byteCache<ReturnType<typeof buildSurfaceLayers>>();
const tileCache = byteCache<LitTile>();
const mottleCache = byteCache<{ canvas: HTMLCanvasElement; blend: GlobalCompositeOperation }>();
const frontFieldCache = byteCache<Float32Array>();
let frontCache: { key: string; canvas: HTMLCanvasElement } | null = null;

function greyCanvas(data: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < data.length; i++) {
    const o = i * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = data[i]!;
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function rgbaCanvas(data: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  img.data.set(data);
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** A decoded custom texture, as the pass receives it. */
type Texture = CanvasImageSource & { width: number; height: number };

/**
 * The texture's pixels in the square core reads: cover-fitted (centre crop),
 * resampled by the engine's own high-quality scaler — the one resize every
 * browser does well, so core never has to filter a photo.
 */
function texturePixels(p: SurfaceParams, img: Texture): { rgba: Uint8ClampedArray; side: number } {
  const side = surfaceTextureSide(p);
  const c = document.createElement("canvas");
  c.width = c.height = side;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  const k = Math.max(side / img.width, side / img.height);
  const dw = img.width * k;
  const dh = img.height * k;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(img, (side - dw) / 2, (side - dh) / 2, dw, dh);
  return { rgba: g.getImageData(0, 0, side, side).data, side };
}

/**
 * `p` with its texture only when the pixels are here. Until a texture has
 * decoded the sheet is the material's own — and it must be KEYED as that,
 * or the stand-in would be cached under the texture's name and outlive it.
 */
function withTexture(p: SurfaceParams, texture: Texture | null | undefined): SurfaceParams {
  return p.texture && !texture ? { ...p, texture: null } : p;
}

function litTile(p: SurfaceParams, texture: Texture | null): LitTile {
  return tileCache(surfaceTileKey(p), () => {
    const built = layersCache(surfaceLayersKey(p), () => buildSurfaceLayers(p, p.texture && texture ? texturePixels(p, texture) : undefined));
    const tile = shadeSurfaceTile(p, built);
    return {
      tile,
      dark: greyCanvas(tile.dark, tile.size, tile.size),
      light: greyCanvas(tile.light, tile.size, tile.size),
      color: tile.color ? rgbaCanvas(tile.color, tile.size, tile.size) : null,
    };
  });
}

/** One mottle sample per 16 device px — it is a tone, not a texture. */
const MOTTLE_CELL = 16;

function mottle(p: SurfaceParams, w: number, h: number): { canvas: HTMLCanvasElement; blend: GlobalCompositeOperation } {
  const fw = Math.max(4, Math.ceil(w / MOTTLE_CELL));
  const fh = Math.max(4, Math.ceil(h / MOTTLE_CELL));
  return mottleCache(`${p.material}|${p.unit.toFixed(3)}|${p.stepSeed}|${w}x${h}`, () => {
    const m = surfaceMottle(p, w, h, fw, fh);
    return { canvas: greyCanvas(m.data, fw, fh), blend: m.blend };
  });
}

/** One front sample per 4 device px: the edge is a soft band, and the smoothed upscale keeps it one. */
const FRONT_CELL = 4;

/**
 * The morph's front as an ALPHA canvas (opaque = the new material). The
 * field — where the front reaches first — is a pure function of the region
 * and the card, so it is computed once and only re-thresholded as `morph`
 * moves.
 */
function front(p: SurfaceParams, w: number, h: number): HTMLCanvasElement {
  const fw = Math.max(4, Math.ceil(w / FRONT_CELL));
  const fh = Math.max(4, Math.ceil(h / FRONT_CELL));
  const fkey = `${p.seed}|${p.morphStyle}|${p.lightAngle}|${p.unit.toFixed(3)}|${w}x${h}`;
  const key = `${fkey}|${p.morph.toFixed(4)}`;
  if (frontCache?.key === key) return frontCache.canvas;
  const field = frontFieldCache(fkey, () => surfaceFrontField(p, w, h, fw, fh));
  const mask = surfaceFrontMask(field, p.morph);
  const canvas = frontCache?.canvas ?? document.createElement("canvas");
  canvas.width = fw;
  canvas.height = fh;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(fw, fh);
  for (let i = 0; i < mask.length; i++) {
    const o = i * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
    img.data[o + 3] = mask[i]!;
  }
  ctx.putImageData(img, 0, 0);
  frontCache = { key, canvas };
  return canvas;
}

/**
 * ONE MATERIAL, whole: the picture cut and shaped (core), then the lit sheet,
 * its colour and its mottle composited over it, clipped back to the shapes.
 * Returns a temp buffer the caller releases.
 */
function paintMaterial(p: SurfaceParams, src: CanvasImageSource, w: number, h: number, texture: Texture | null): Buf {
  const lit = litTile(p, texture);
  const T = lit.tile.size;
  const ox = Math.floor(p.offsetX * T);
  const oy = Math.floor(p.offsetY * T);

  const stage = acquireTemp(w, h);
  if (surfaceReadsPicture(p)) {
    const { image, buf } = readPixels(src, w, h);
    cutSurface(image.data, w, h, p, lit.tile);
    stage.ctx.putImageData(image, 0, 0);
    releaseTemp(buf);
  } else {
    stage.ctx.drawImage(src, 0, 0);
  }
  // The shapes as they now stand — the alpha every texture is re-clipped to,
  // since a blend mode unions its coverage with the backdrop.
  const shape = acquireTemp(w, h);
  shape.ctx.drawImage(stage.canvas, 0, 0);

  const c = stage.ctx;
  c.save();
  if (p.mode === "multiply") {
    c.globalCompositeOperation = "multiply";
    c.fillStyle = `rgb(${p.tone[0]}, ${p.tone[1]}, ${p.tone[2]})`;
    c.fillRect(0, 0, w, h);
  }
  // A material whose sheet is only the GROUND (neon's wall, foil's card) had
  // it laid by the shape stage, between the shapes; laying it again here
  // would print brick on the tube.
  const layers: Array<[HTMLCanvasElement, GlobalCompositeOperation]> = surfaceOverlaysAll(p)
    ? [
        [lit.dark, "multiply"],
        [lit.light, "screen"],
      ]
    : [];
  if (lit.color) layers.push([lit.color, "multiply"]);
  // A sheet built coarser than it is seen (`surfaceTileScale`) is laid at its
  // scale, smoothly — the same reads `cutSurface` makes of it.
  const k = lit.tile.scale ?? 1;
  if (k !== 1) {
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = "high";
  }
  for (const [canvas, op] of layers) {
    const pat = c.createPattern(canvas, "repeat");
    if (!pat) continue;
    pat.setTransform?.(new DOMMatrix().scale(k).translate(-ox, -oy));
    c.globalCompositeOperation = op;
    c.fillStyle = pat;
    c.fillRect(0, 0, w, h);
  }
  if (surfaceOverlaysAll(p)) {
    const mot = mottle(p, w, h);
    c.globalCompositeOperation = mot.blend;
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = "high";
    c.drawImage(mot.canvas, 0, 0, w, h);
  }
  c.globalCompositeOperation = "destination-in";
  c.drawImage(shape.canvas, 0, 0);
  c.restore();
  releaseTemp(shape);
  return stage;
}

/** The material over `src` (both ends of a morph, the wet/dry mix), into a temp buffer the caller releases. */
function materialOver(p: SurfaceParams, src: CanvasImageSource, w: number, h: number, texture: Texture | null): Buf {
  // A MORPH is both materials, whole, blended by the front: felt's pillow
  // and fuzz give way to foil's bevel and rainbow where the front has passed.
  const ends = surfaceMorphEnds(p);
  const a = paintMaterial(ends.a, src, w, h, texture);
  if (ends.b) {
    const b = paintMaterial(ends.b, src, w, h, texture);
    b.ctx.save();
    b.ctx.globalCompositeOperation = "destination-in";
    b.ctx.imageSmoothingEnabled = true;
    b.ctx.imageSmoothingQuality = "high";
    b.ctx.drawImage(front(p, w, h), 0, 0, w, h);
    b.ctx.restore();
    a.ctx.drawImage(b.canvas, 0, 0);
    releaseTemp(b);
  }
  const out = acquireTemp(w, h);
  if (p.mix < 0.999) {
    out.ctx.drawImage(src, 0, 0);
    out.ctx.globalAlpha = p.mix;
  }
  out.ctx.drawImage(a.canvas, 0, 0);
  out.ctx.globalAlpha = 1;
  releaseTemp(a);
  return out;
}

function surfacePass(given: SurfaceParams, texture: Texture | null, src: CanvasImageSource, w: number, h: number, env: PassEnv): CanvasImageSource {
  const p = withTexture(given, texture);
  const out = nextOutput(w, h);
  // SPARE LIGHTS FROM THE LIGHT LAYERS. The host painted `src` without its
  // lights and hands the lights' own picture here: the material is laid on the
  // unlit picture and the lights go back ON TOP, untouched — a white-hot core
  // is clean, and a glow's halo is light over the textured card, never chalk.
  // Below a full dial the result leans back toward the lights printed with
  // everything else.
  if (p.lights > 0.002 && p.lightsFrom === "layers") {
    const lights = env.lights ?? null;
    if (p.lights < 0.999) {
      const lit = acquireTemp(w, h);
      lit.ctx.drawImage(src, 0, 0);
      if (lights) lit.ctx.drawImage(lights, 0, 0);
      const printed = p.mix < 0.002 ? null : materialOver(p, lit.canvas, w, h, texture);
      out.ctx.drawImage(printed?.canvas ?? lit.canvas, 0, 0);
      releaseTemp(printed);
      releaseTemp(lit);
      out.ctx.globalAlpha = p.lights;
    }
    const spared = p.mix < 0.002 ? null : materialOver(p, src, w, h, texture);
    out.ctx.drawImage(spared?.canvas ?? src, 0, 0);
    if (lights) out.ctx.drawImage(lights, 0, 0);
    out.ctx.globalAlpha = 1;
    releaseTemp(spared);
    return out.canvas;
  }
  if (p.mix < 0.002) return src;
  const done = materialOver(p, src, w, h, texture);
  out.ctx.drawImage(done.canvas, 0, 0);
  releaseTemp(done);
  if (p.lights > 0.002) spareColouredLight(p, src, out.ctx, w, h);
  return out.canvas;
}

/**
 * SPARE LIGHTS BY COLOUR, for flat media (`lightsFrom: "colour"`): the
 * picture's coloured pixels laid back over the material by `surfaceLightMask`,
 * so an ember in a video stays a clean light while the chalk around it takes
 * the card's tooth. Last, after the mix, so a light is clean at any wet/dry.
 */
function spareColouredLight(p: SurfaceParams, src: CanvasImageSource, ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const { image, buf } = readPixels(src, w, h);
  const keep = surfaceLightMask(image.data, w, h, p.lights);
  const d = image.data;
  for (let i = 0; i < keep.length; i++) d[i * 4 + 3] = keep[i]!;
  const light = acquireTemp(w, h);
  light.ctx.putImageData(image, 0, 0);
  if (buf) releaseTemp(buf);
  ctx.drawImage(light.canvas, 0, 0);
  releaseTemp(light);
}

export const surface: PassFn<"surface"> = (p, src, w, h, env) => surfacePass(p.params, p.texture ?? null, src, w, h, env);
