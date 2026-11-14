import {
  buildPatternTile,
  patternNoiseAt,
  resolvePaint,
  variableValueNow,
  parseColorVarToken,
  type MotionDocument,
  type Paint,
  type PatternSpec,
} from "@solomotion/core";

/**
 * PAINT → CANVAS. The one place a fill becomes something a 2D context can draw,
 * and therefore the one place a preview and the stage cannot drift apart.
 *
 * It used to live inside `draw-frame`, which meant every swatch, every picker
 * chip and every preset card approximated a paint in CSS instead — fine while
 * paints were solids and ramps, and a lie the moment patterns arrived, because
 * CSS cannot rotate a tiling and had no idea what a hatch was. Lifting it out
 * costs nothing at render time and makes "the preview IS the fill" true by
 * construction rather than by diligence.
 */

export interface PaintBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A Paint as a canvas style. Solid resolves through color variables; every
 * gradient reads the SAME two normalized handle points (`start`/`end`, 0..1
 * across the bounds) — the exact model the on-stage handles manipulate — so the
 * canvas, the exporters, and the handles never disagree:
 *   linear   ramp along start → end.
 *   radial   center at start, radius = |end − start| in px.
 *   angular  conic sweep centered at start, 0° pointing start → end.
 */
export function paintStyle(
  ctx: CanvasRenderingContext2D,
  entry: Paint,
  bounds: PaintBounds,
  resolve: ColorResolver,
  /** Asset lookup for an IMAGE pattern's tile. Absent = the tile draws its
   *  ground and marks and simply omits the picture. */
  images?: (assetId: string) => CanvasImageSource | null,
): string | CanvasGradient | CanvasPattern {
  // A paint bound to a variable is drawn as whatever the variable holds. One
  // deref, at the top of the one function every fill and stroke style comes
  // through, so no branch below ever meets a reference.
  const paint = resolve.paint(entry);
  if (paint.type === "solid") return resolve(paint.color);
  // A dangling or cyclic reference already resolved to magenta; a reference
  // that survived to here would be a bug, and drawing nothing is how it shows.
  if (paint.type === "variable") return "rgba(0,0,0,0)";
  // A procedural tiling pattern (stripes, …) as a repeating canvas pattern.
  if (paint.type === "pattern") return patternCanvasStyle(ctx, paint.pattern, resolve, images) ?? "rgba(0,0,0,0)";
  // Media fills draw their footage via drawMediaFill (image/video, keyed element
  // pool), never as a flat fillStyle — so as a canvas STYLE they're transparent.
  if (paint.type === "media") return "rgba(0,0,0,0)";
  const sx = bounds.x + paint.start.x * bounds.w;
  const sy = bounds.y + paint.start.y * bounds.h;
  const ex = bounds.x + paint.end.x * bounds.w;
  const ey = bounds.y + paint.end.y * bounds.h;
  let g: CanvasGradient;
  if (paint.type === "linear") {
    g = ctx.createLinearGradient(sx, sy, ex, ey);
  } else if (paint.type === "radial") {
    const r = Math.max(0.001, Math.hypot(ex - sx, ey - sy));
    g = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
  } else {
    g = ctx.createConicGradient(Math.atan2(ey - sy, ex - sx), sx, sy);
  }
  for (const s of [...paint.stops].sort((a, b) => a.offset - b.offset)) {
    g.addColorStop(Math.min(1, Math.max(0, s.offset)), resolve(s.color));
  }
  return g;
}

/**
 * A procedural pattern as a repeating CanvasPattern — the EXECUTOR for the tile
 * plan `buildPatternTile` describes.
 *
 * All the geometry lives in core; this only knows how to put a rect, a circle,
 * a polygon, a polyline, grain or an image onto a canvas. That split is why the
 * picker's swatches and the studio's live preview are the same picture as the
 * stage: they run this same executor over the same plan rather than
 * approximating patterns in CSS, which is what used to make a swatch stop
 * resembling the fill it stood for the moment either grew a feature.
 *
 * The tile is drawn at DEVICE resolution and shrunk back by the pattern
 * transform, so a hairline hatch stays a hairline instead of aliasing into a
 * grey wash on a retina canvas.
 */
export function patternCanvasStyle(
  ctx: CanvasRenderingContext2D,
  pattern: PatternSpec,
  resolve: ColorResolver,
  images?: (assetId: string) => CanvasImageSource | null,
): CanvasPattern | null {
  const tile = buildPatternTile(pattern, resolve);
  const canvas = paintPatternTile(tile, images, patternDensity(ctx));
  if (!canvas) return null;
  const cp = ctx.createPattern(canvas, "repeat");
  if (!cp) return null;
  try {
    // Back to the tile's EXACT size: the canvas is a whole number of pixels,
    // and scaling by a fixed 1/k turned the rounding into a wrong period.
    const m = new DOMMatrix()
      .translateSelf(tile.offsetX, tile.offsetY)
      .rotateSelf(tile.angleDeg)
      .scaleSelf(tile.w / canvas.width, tile.h / canvas.height);
    cp.setTransform(m);
  } catch {
    /* DOMMatrix unavailable — fall back to an un-rotated, un-phased tiling. */
  }
  return cp;
}

/** Tiles are rasterised at this multiple and scaled back down by the pattern
 *  transform. 2 is enough to keep a 1px hatch crisp without quadrupling the
 *  cost of a pattern that is redrawn on every dirty frame. */
const PATTERN_SUPERSAMPLE = 2;

/**
 * Tile pixels per layer px for THIS draw: about one per device pixel, the
 * same 2× headroom on top, and never below what keeps a mark drawable.
 *
 * It was a fixed 2× whatever the target's scale. A canvas pattern has no
 * mipmaps, so a tile drawn at 2× and shown at 0.4× (a `view_render` look, a
 * zoomed-out board) is sampled five tile pixels per screen pixel with no
 * filtering: a fine grid's lines landed on some samples and between others,
 * and read as close PAIRS with wide gaps instead of an even lattice. Drawn at
 * the scale it is seen, each line is antialiased once, where it really falls.
 */
function patternDensity(ctx: CanvasRenderingContext2D): number {
  const t = ctx.getTransform();
  const device = (Math.hypot(t.a, t.b) + Math.hypot(t.c, t.d)) / 2;
  return Math.min(8, Math.max(0.25, (Number.isFinite(device) && device > 0 ? device : 1) * PATTERN_SUPERSAMPLE));
}

/** Paint a tile plan onto an offscreen canvas. Exported through
 *  `patternTileCanvas` so the picker's previews use the identical painter. */
function paintPatternTile(
  tile: ReturnType<typeof buildPatternTile>,
  images?: (assetId: string) => CanvasImageSource | null,
  k = PATTERN_SUPERSAMPLE,
): HTMLCanvasElement | null {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(2, Math.round(tile.w * k));
  canvas.height = Math.max(2, Math.round(tile.h * k));
  const c = canvas.getContext("2d");
  if (!c) return null;
  // The tile fills its whole-pixel canvas exactly; the pattern transform undoes it.
  c.scale(canvas.width / tile.w, canvas.height / tile.h);
  if (tile.background) {
    c.fillStyle = tile.background;
    c.fillRect(0, 0, tile.w, tile.h);
  }
  for (const mark of tile.marks) {
    switch (mark.kind) {
      case "rect": {
        c.fillStyle = mark.color;
        c.beginPath();
        if (mark.r > 0 && typeof c.roundRect === "function") c.roundRect(mark.x, mark.y, mark.w, mark.h, mark.r);
        else c.rect(mark.x, mark.y, mark.w, mark.h);
        c.fill();
        break;
      }
      case "circle": {
        if (mark.radius <= 0) break;
        c.fillStyle = mark.color;
        c.beginPath();
        c.arc(mark.cx, mark.cy, mark.radius, 0, Math.PI * 2);
        c.fill();
        break;
      }
      case "poly": {
        if (mark.points.length < 6) break;
        c.fillStyle = mark.color;
        c.beginPath();
        c.moveTo(mark.points[0]!, mark.points[1]!);
        for (let i = 2; i < mark.points.length; i += 2) c.lineTo(mark.points[i]!, mark.points[i + 1]!);
        c.closePath();
        c.fill();
        break;
      }
      case "line": {
        if (mark.width <= 0 || mark.points.length < 4) break;
        c.strokeStyle = mark.color;
        c.lineWidth = mark.width;
        c.lineCap = mark.round ? "round" : "butt";
        c.lineJoin = mark.round ? "round" : "miter";
        c.beginPath();
        c.moveTo(mark.points[0]!, mark.points[1]!);
        for (let i = 2; i < mark.points.length; i += 2) c.lineTo(mark.points[i]!, mark.points[i + 1]!);
        c.stroke();
        break;
      }
      case "noise": {
        // Cell-quantised so the grain has a SIZE. Per-device-pixel noise would
        // read as a flat grey the moment the pattern was scaled down.
        const cell = Math.max(1, mark.cell);
        c.fillStyle = mark.color;
        for (let y = 0; y < tile.h; y += cell) {
          for (let x = 0; x < tile.w; x += cell) {
            const n = patternNoiseAt(Math.floor(x / cell), Math.floor(y / cell), mark.seed);
            const a = (n - 0.5) * 2 * mark.contrast;
            if (a <= 0) continue;
            c.globalAlpha = Math.min(1, a);
            c.fillRect(x, y, cell, cell);
          }
        }
        c.globalAlpha = 1;
        break;
      }
      case "image": {
        const img = images?.(mark.assetId);
        if (!img) break;
        try {
          c.drawImage(img, mark.x, mark.y, mark.w, mark.h);
        } catch {
          /* A decoding or tainted image must not take the whole frame down. */
        }
        break;
      }
    }
  }
  return canvas;
}

/** The pattern painter, for surfaces outside the render loop — the picker's
 *  swatches, the studio's live preview, a preset card. ONE painter means a
 *  preview is the fill, not a drawing of it. */
export function patternTileCanvas(
  pattern: PatternSpec,
  resolve: (color: string) => string,
  images?: (assetId: string) => CanvasImageSource | null,
): HTMLCanvasElement | null {
  return paintPatternTile(buildPatternTile(pattern, resolve), images);
}


/**
 * The draw's window onto the document's variables: call it with a colour to
 * dereference a `var:` token, or call `.paint()` to dereference a whole paint
 * that IS a variable.
 *
 * Both live on one object rather than as two threaded arguments because they
 * are one question — "what does this document actually say here" — and the
 * resolver is already a per-draw closure over the doc. Twenty-five signatures
 * would otherwise have grown a second parameter every one of them merely
 * forwards.
 */
export interface ColorResolver {
  (value: string): string;
  /** Deref a `variable` paint to the look it points at. Everything else passes
   *  through untouched, so call sites never branch on the paint type. */
  paint(paint: Paint): Paint;
}

/** The no-document resolver: everything is already a literal. Named rather than
 *  re-made inline so a default parameter cannot forget the `.paint` half. */
export const IDENTITY_RESOLVER: ColorResolver = Object.assign((v: string) => v, { paint: (p: Paint) => p });

export function makeColorResolver(doc: MotionDocument): ColorResolver {
  const colors = doc.variables.filter((v) => v.type === "color");
  const hasPaints = doc.variables.some((v) => v.type === "paint");
  const byId = new Map(colors.map((v) => [v.id, v]));
  const resolve = ((value: string) => {
    const id = parseColorVarToken(value);
    if (!id) return value;
    const v = byId.get(id);
    // `variableValueNow`, not the stored literal: a colour variable may be
    // keyframed, driven by a graph or modulated, and reading `v.value` here is
    // what used to freeze an animated palette at its first frame on the canvas
    // while every other surface showed it moving.
    return v ? String(variableValueNow(v)) : "#FF00FF";
  }) as ColorResolver;
  resolve.paint = hasPaints ? (paint: Paint) => resolvePaint(doc, paint) : (paint: Paint) => paint;
  return resolve;
}

/**
 * Paint a whole paint into a rectangle — the previews' entry point, and the
 * same styles the stage lays down.
 *
 * Media fills are the one thing a swatch cannot draw for itself (the footage
 * lives in an element pool the renderer owns), so they get the checker plus
 * whatever image the caller can supply.
 */
export function drawPaintInto(
  ctx: CanvasRenderingContext2D,
  paint: Paint,
  bounds: PaintBounds,
  resolve: ColorResolver = IDENTITY_RESOLVER,
  images?: (assetId: string) => CanvasImageSource | null,
): void {
  const resolved = resolve.paint(paint);
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, paint.opacity));
  if (resolved.type === "media") {
    const src = resolved.source.type === "asset" ? images?.(resolved.source.assetId) : null;
    if (src) {
      try {
        ctx.drawImage(src, bounds.x, bounds.y, bounds.w, bounds.h);
        ctx.restore();
        return;
      } catch {
        /* a tainted or still-decoding image falls through to the placeholder */
      }
    }
    ctx.fillStyle = "rgba(120,124,134,0.28)";
  } else {
    ctx.fillStyle = paintStyle(ctx, resolved, bounds, resolve, images);
  }
  ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
  ctx.restore();
}
