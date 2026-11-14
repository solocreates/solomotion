"use client";

import {
  buildStrokePlan,
  pathCommands,
  solidPaint,
  applyEndTaper,
  StrokeEngine,
  strokeStyle,
  WetLayer,
  vectorStroke,
  widthProfileSamples,
  type BrushPreset,
  type Dab,
  type PenSample,
  type PressureSettings,
  type VectorStroke,
} from "@solomotion/core";
import { commandsToPath2D } from "../stage/render/draw-frame";
import { grainGatedBuffer, stampDabs } from "./dab-painter";

/**
 * Brush previews — ONE painter behind every place a brush shows itself: the
 * Brush Studio playground's demo stroke, the picker's preview cards, and the
 * options-bar trigger chip. All of them run the REAL StrokeEngine over the
 * same S-sweep with rising-and-falling pressure, stamped by the real dab
 * painter (grain included) or fitted like a real vector stroke — so a
 * preview can never lie about how the brush actually paints.
 */

/**
 * Run samples through the engine and fit them EXACTLY as a real vector stroke
 * on the stage would — same streamline, same taper, same width profile, same
 * fit. Returned rather than painted so the studio can also show the anchors it
 * produced (the one thing a picture of a line cannot tell you).
 */
export function vectorPreviewStroke(
  brush: BrushPreset,
  pressure: PressureSettings,
  samples: PenSample[],
  sizePx = brush.size,
): VectorStroke | null {
  const engine = new StrokeEngine(brush, pressure, sizePx, 1, 7);
  for (const s of samples) engine.feed(s);
  return vectorStroke(engine.polyline, brush, sizePx);
}

/**
 * Paint a fitted vector stroke exactly as the stage will — through
 * `buildStrokePlan`, one line of the brush's stack at a time.
 *
 * The studio preview used to have its own two-branch painter (fill a ribbon, or
 * stroke a line), which meant a brush's taper looked one way here and another
 * on the canvas. There is one painter now, so the preview is the result.
 */
export function paintVectorStroke(
  ctx: CanvasRenderingContext2D,
  stroke: VectorStroke,
  color: string,
  opacity: number,
): void {
  const cmds = pathCommands(stroke.subpaths);
  ctx.save();
  ctx.globalAlpha = opacity;
  for (const [i, line] of stroke.lines.entries()) {
    const base = { ...strokeStyle(solidPaint(color)), ...line, paint: solidPaint(color) };
    // The bottom line carries the stroke's body, so it carries the pressure —
    // the same placement the stage makes when it commits a drawn contour, which
    // is what keeps the playground an honest preview of the real thing.
    const style =
      i === 0 && stroke.widths
        ? { ...base, profile: { ...base.profile, samples: widthProfileSamples(stroke.widths, line.width) } }
        : base;
    const plan = buildStrokePlan(cmds, style);
    if (plan.ribbon) {
      ctx.fillStyle = color;
      ctx.fill(commandsToPath2D(plan.ribbon));
    } else if (plan.path) {
      ctx.strokeStyle = color;
      ctx.lineWidth = line.width;
      ctx.lineCap = line.cap;
      ctx.lineJoin = line.join;
      ctx.setLineDash(plan.dash);
      ctx.lineDashOffset = -plan.dashOffset;
      ctx.stroke(commandsToPath2D(plan.path));
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
    }
    if (plan.markers.length) {
      ctx.fillStyle = color;
      ctx.fill(commandsToPath2D(plan.markers));
    }
  }
  ctx.restore();
}

/** The canonical demo stroke: an S-sweep whose pressure rises and falls. */
export function demoSamples(width: number, height: number, count = 110): PenSample[] {
  const samples: PenSample[] = [];
  const padX = width * 0.09;
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    samples.push({
      x: padX + t * (width - padX * 2),
      y: height / 2 + Math.sin(t * Math.PI * 2) * (height / 4.2),
      pressure: Math.sin(t * Math.PI) ** 1.2,
      tiltX: 0,
      tiltY: 0,
      timeMs: i * 6,
    });
  }
  return samples;
}

/**
 * Run one stroke of `brush` through the engine and paint it — the shared
 * preview painter. `sizePx`/`opacity` default to the preset's own values so
 * tweaked brushes preview exactly as tweaked.
 */
export function renderBrushStroke(
  ctx: CanvasRenderingContext2D,
  brush: BrushPreset,
  pressure: PressureSettings,
  samples: PenSample[],
  color: string,
  sizePx = brush.size,
  opacity = brush.opacity,
): void {
  if (brush.engine === "vector") {
    const stroke = vectorPreviewStroke(brush, pressure, samples, sizePx);
    if (!stroke) return;
    paintVectorStroke(ctx, stroke, color, opacity);
    return;
  }
  const engine = new StrokeEngine(brush, pressure, sizePx, 1, 7);
  const dabs = samples.flatMap((s) => engine.feed(s));
  applyEndTaper(dabs, brush);

  // A WET brush must preview through the SIMULATION, not the dab painter.
  // Painted dry it is a very soft tip at very low flow — which is exactly what
  // an airbrush is, and exactly what those previews looked like. Run the real
  // physics to a settled state instead and the preview gets what the medium
  // actually has: a body, a bloom, and a dark rim.
  if (brush.rendering.wet.enabled) {
    paintWetStroke(ctx, dabs, brush, color, opacity);
    return;
  }
  paintRasterStroke(ctx, dabs, brush, color, opacity);
}

/**
 * How far a preview runs the simulation.
 *
 * Enough for the wash to bloom and its rim to form, not so far that every wet
 * brush previews as the same fully-dried blob — a preview should show the
 * medium mid-life, which is when it is recognisable.
 */
const PREVIEW_WET_STEPS = 90;

/**
 * Paint a wet stroke by running the real `WetLayer` over the dabs. Same physics
 * as the canvas, at preview scale, so a card cannot flatter a brush.
 */
export function paintWetStroke(
  ctx: CanvasRenderingContext2D,
  dabs: readonly Dab[],
  brush: BrushPreset,
  color: string,
  opacity: number,
): void {
  const w = Math.max(1, Math.ceil(ctx.canvas.width));
  const h = Math.max(1, Math.ceil(ctx.canvas.height));
  const wet = brush.rendering.wet;
  const film = new WetLayer(w, h, {
    flow: wet.flow,
    evaporation: wet.evaporation,
    granulation: wet.granulation,
    edge: wet.edge,
    deposition: wet.deposition,
    texture: wet.texture,
  });

  // The preview canvas is DPR-scaled; the film is in device pixels, so dabs
  // have to be placed in the same space the transform would have put them.
  const t = ctx.getTransform();
  const rgb = unitRgb(color);
  for (const d of dabs) {
    film.dab(d.x * t.a + t.e, d.y * t.d + t.f, Math.max(0.5, (d.size / 2) * t.a), rgb, d.alpha * opacity, wet.wetness);
  }
  for (let i = 0; i < PREVIEW_WET_STEPS && !film.isDry; i++) film.step();

  const image = new ImageData(w, h);
  film.compose(image.data);
  const scratch = document.createElement("canvas");
  scratch.width = w;
  scratch.height = h;
  scratch.getContext("2d")!.putImageData(image, 0, 0);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(scratch, 0, 0);
  ctx.restore();
}

/** A CSS colour as unit RGB — the simulation carries pigment, not strings. */
function unitRgb(color: string): [number, number, number] {
  if (color.startsWith("#")) {
    const hex =
      color.length === 4
        ? `${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
        : color.slice(1, 7);
    const n = parseInt(hex, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  return [1, 1, 1];
}

/**
 * Composite a finished raster stroke — THE seam where `rendering.stamp` means
 * something, and the reason a marker and an airbrush are different instruments
 * rather than two opacity values.
 *
 *  • `uniform` assembles the stroke in its own buffer at full strength and
 *    composites it ONCE at the brush's opacity. Crossing your own stroke inside
 *    one pass changes nothing, so a 30% wash stays an even 30%.
 *  • `glaze` stamps every dab straight onto the target, so paint accumulates
 *    where dabs overlap and where the stroke crosses itself. Going over an ink
 *    line twice makes it darker, which is the whole feel of the medium.
 *
 * Grain gates the assembled stroke in both cases, so the paper is a property of
 * the SURFACE rather than of each stamp — which is what makes two strokes reveal
 * the same tooth where they cross.
 */
export function paintRasterStroke(
  ctx: CanvasRenderingContext2D,
  dabs: readonly Dab[],
  brush: BrushPreset,
  color: string,
  opacity: number,
): void {
  const grained = brush.grain.intensity > 0.001;
  const buffered = brush.rendering.stamp === "uniform" || grained;

  if (!buffered) {
    ctx.save();
    ctx.globalAlpha = opacity;
    stampDabs({ ctx }, dabs, brush, color);
    ctx.restore();
    return;
  }

  const buffer = document.createElement("canvas");
  buffer.width = ctx.canvas.width;
  buffer.height = ctx.canvas.height;
  const bctx = buffer.getContext("2d")!;
  bctx.setTransform(ctx.getTransform());
  stampDabs({ ctx: bctx }, dabs, brush, color);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // A glazed brush already accumulated inside the buffer; re-applying opacity
  // on the way out is the correct ceiling in both modes.
  ctx.globalAlpha = opacity;
  ctx.drawImage(grainGatedBuffer(buffer, brush), 0, 0);
  ctx.restore();
}

/**
 * A card-sized preview of a brush AS IT WOULD PAINT RIGHT NOW: the real colour,
 * the options-bar size/opacity tweaks, the current pressure feel.
 *
 * PURE and uncached on purpose. It used to memoise its own results, which meant
 * two caches answered "what does this brush look like" — this one, and the
 * thumbnail queue that had to exist anyway to keep ninety encodes off the
 * render path. `brush-thumbs` owns caching now; this owns drawing.
 */
export function brushCardPreview(
  brush: BrushPreset,
  pressure: PressureSettings,
  color: string,
  width: number,
  height: number,
  sizePx = brush.size,
  opacity = brush.opacity,
): string {
  const dpr = 2;
  const canvas = document.createElement("canvas");
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  // Preview size scales down so huge brushes still read as a stroke.
  const previewSize = Math.min(sizePx, height * 0.62);
  renderBrushStroke(ctx, brush, pressure, demoSamples(width, height), color, previewSize, opacity);
  return canvas.toDataURL("image/png");
}
