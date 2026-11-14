import type { BrushPreset } from "./brush";
import { fitPolyline, type PathFidelity } from "./fidelity";
import { pressureResponse, type PressureSettings } from "./pressure";
import { strokesFromStack, type StrokeSet } from "../presets/stroke-sets";
import { solidPaint, type Contour, type StrokeStyle } from "../schema";

/**
 * THE vector brush rasterizer: a streamlined polyline + a `BrushPreset` become
 * an editable path. This is the vector twin of `stroke-engine` + the raster
 * painter — one function, so the stage, the Brush Studio preview and the brush
 * card thumbnail cannot disagree about what a vector brush draws.
 *
 * It is deliberately the LAST step of the same pipeline the raster engine uses:
 * `StrokeEngine` streamlines and stabilises the samples for BOTH engines, and
 * only here do the points become anchors instead of dabs. That is why taper
 * (`strokePath.taperStartPx/EndPx`) is honoured here too — a brush's feel is one
 * description, not two.
 */

/** One point of the streamlined polyline the engine produced. */
export interface VectorStrokePoint {
  x: number;
  y: number;
  /** Normalized pen pressure 0..1 at this point. */
  pressure: number;
}

/**
 * A finished vector stroke, described the way a `path` clip consumes it: a
 * centre line, the ink to paint it with, and the pressure that was applied
 * along it. Callers never branch on `variableWidth` themselves.
 */
export interface VectorStroke {
  subpaths: Contour[];
  /**
   * The MEASURED width of the line, in px, at evenly spaced stations along its
   * arc length — the pressure record, in the one form that stays true no matter
   * what happens to the geometry afterwards. `null` when the brush does not
   * vary its width.
   *
   * Absolute px, deliberately: a consumer divides by whatever stroke width the
   * curve ends up living on, so the same measurement can become the profile of
   * a brand-new layer's stroke (divide by the peak) or of one contour appended
   * to a layer that already has ink (divide by that layer's width, so the
   * layer's width slider still scales the whole drawing).
   *
   * ARC LENGTH, also deliberately: `profileAt` reads a profile's samples as
   * evenly spaced along the line, and these used to be one-per-input-sample.
   * Input samples are spaced by TIME, so the pressure curve was stretched
   * wherever the hand moved slowly and squeezed wherever it moved fast — the
   * pressure landed nowhere near where it was applied. Resampling by distance
   * is what makes "hard here, soft there" mean here and there.
   */
  widths: number[] | null;
  /**
   * The STROKE STACK to paint the centre line with — the brush's own lines,
   * scaled to the live size. Uniform: the pressure lives in `widths`, because
   * a line stack is authored once per BRUSH and a pressure curve is measured
   * once per STROKE, and folding the second into the first is what made every
   * stroke after the first on a layer wear the first one's pressure.
   *
   * This used to be `paint: "stroke" | "fill"`, and a pressure stroke came back
   * as a filled ribbon: the width was baked into the geometry, so the moment
   * you let go you could no longer change the width, the colour, the caps, or
   * add a dash. A drawn line stopped being a line. Now the geometry is always
   * the centre line and the width lives in the stroke, which is what makes a
   * brush stroke and a shape's stroke the same editable object.
   */
  lines: StrokeSet[];
}

/**
 * Per-point half-widths for a variable-width stroke: base size, shaped by the
 * app's pen curve, modulated by the brush's own `vector.widthPressure` (floored
 * at `vector.minWidth`) and pulled to nothing over its taper lengths.
 *
 * `pressure` is THE app-level pen response — the same `PressureSettings.size`
 * curve the raster engine puts every dab through. Without it a vector brush
 * answered to `widthPressure` alone, so Settings › Pen (amount, curve, minimum)
 * moved the pixel brush and did nothing at all to the vector one: two
 * implementations of "how hard you press becomes how wide it is", disagreeing
 * on every stroke. Omitted, the raw sample pressure is used, which is the
 * identity curve and what a preview with no app settings to hand wants.
 *
 * Exported because the studio graphs it — the width profile is the single most
 * useful thing to SEE while tuning a vector brush, and graphing a copy of this
 * math would be the usual way two implementations start to drift.
 */
export function vectorStrokeWidths(
  points: readonly VectorStrokePoint[],
  brush: BrushPreset,
  sizePx: number,
  pressure?: PressureSettings,
): number[] {
  const { widthPressure, minWidth } = brush.vector;
  const { taperStartPx, taperEndPx } = brush.strokePath;

  // Arc length at each point, and the total — taper is expressed in px, so it
  // must be measured along the line, not counted in samples.
  const at: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    at.push(at[i - 1]! + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const total = at[at.length - 1] ?? 0;

  return points.map((p, i) => {
    const shaped = pressure ? pressureResponse(p.pressure, pressure.size) : p.pressure;
    const press = 1 - widthPressure + widthPressure * shaped;
    let w = sizePx * Math.max(minWidth, press);
    if (taperStartPx > 0) w *= Math.min(1, at[i]! / Math.min(taperStartPx, Math.max(1, total)));
    if (taperEndPx > 0) w *= Math.min(1, (total - at[i]!) / Math.min(taperEndPx, Math.max(1, total)));
    return Math.max(0.25, w);
  });
}

/** What a live drawing gesture knows that a brush preset does not. */
export interface VectorStrokeContext {
  /** The tool's fidelity for this gesture. Falls back to the preset's own
   *  `fitTolerance` wherever there is no tool to ask (studio previews, card
   *  thumbnails). */
  fidelity?: PathFidelity;
  /** The app's pen response — see `vectorStrokeWidths`. */
  pressure?: PressureSettings;
}

/**
 * Fit a drawn polyline into the stroke a brush describes. `null` when there is
 * nothing to fit (a tap, or a degenerate ribbon).
 *
 * `sizePx` is the LIVE size from the tool options bar (the preset's base size
 * already applied by the caller), matching the raster engine's contract.
 */
export function vectorStroke(
  points: readonly VectorStrokePoint[],
  brush: BrushPreset,
  sizePx: number,
  ctx: VectorStrokeContext = {},
): VectorStroke | null {
  if (points.length < 2) return null;
  const v = brush.vector;
  const pts = v.straightenPx > 0 ? straighten(points, v.straightenPx) : points;
  const closed = shouldClose(pts, v.autoClosePx);

  // Point density belongs to the DRAWING, not to the brush: the tool's
  // fidelity fits a live stroke, and the preset's own `fitTolerance` is the
  // baseline for wherever there is no tool to ask (studio previews, card
  // thumbnails). Fitting runs through the shared corner-aware fitter, so a
  // deliberate corner in a freehand line survives instead of being smoothed
  // away — the same rule that keeps a carved rectangle rectangular.
  const fit = ctx.fidelity ?? { smoothing: 0, simplify: v.fitTolerance, corner: 40 };
  const fitted = fitPolyline([...pts], fit, closed);
  if (!fitted) return null;

  // Scale the brush's authored lines to the live size from the options bar.
  //
  // Only the WIDTH is scaled here, and that is now the whole point: each line
  // carries the width it was AUTHORED at (`baseWidth`), so the dash, the wave
  // and the roughness follow the size at resolve time through one rule in
  // `strokeAtWidth` instead of being re-derived here. Before that reference
  // existed this multiplication was the entire scaling story, and a 60px brush
  // drew a 60px line wearing an 8px brush's grain.
  const base = Math.max(0.01, v.lines[0]?.width ?? sizePx);
  const k = sizePx / base;
  const lines = v.lines.map((l) => ({
    ...l,
    baseWidth: l.baseWidth ?? l.width,
    width: Math.max(0.25, l.width * k),
  }));

  // Pressure is measured against the bottom line — the one that carries the
  // stroke's body — and handed back for the caller to place. It is NOT baked
  // into `lines` here: a drawn contour appended to a layer that already has ink
  // must carry its OWN curve, and a brush's authored line stack is shared by
  // every stroke drawn with it.
  const widths =
    v.variableWidth && lines[0] ? resampleByArcLength(pts, brush, lines[0].width, ctx.pressure) : null;
  return { subpaths: [fitted], lines, widths };
}

/** One station per this many px of line — fine enough that a pressure swell
 *  reads smooth, coarse enough that a long stroke stores a curve and not a log. */
const WIDTH_STATION_PX = 2;
const MAX_WIDTH_STATIONS = 256;

/**
 * The per-point width curve, resampled onto stations spaced evenly along the
 * DRAWN LENGTH — the form `StrokeProfile.samples` is defined in.
 *
 * The station count is bounded on both ends: a document should not grow by a
 * thousand floats because someone drew one slow line, and a two-station curve
 * is still a curve. Everything between is linear, which is what `profileAt`
 * reads it back with, so the round trip is exact at the stations and honest
 * between them.
 */
function resampleByArcLength(
  points: readonly VectorStrokePoint[],
  brush: BrushPreset,
  sizePx: number,
  pressure?: PressureSettings,
): number[] | null {
  const w = vectorStrokeWidths(points, brush, sizePx, pressure);
  if (w.length === 0) return null;
  if (w.length === 1) return [w[0]!];

  // Arc length at each measured point — the same walk `vectorStrokeWidths` does,
  // and the reason it is repeated rather than shared is that the widths are the
  // studio's graph and must stay a pure function of the points.
  const at: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    at.push(at[i - 1]! + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const total = at[at.length - 1]!;
  // A stroke with no length (every sample on one spot) has no curve to place —
  // one station says "this width, everywhere", which is exactly true.
  if (total <= 1e-6) return [w[0]!];

  const n = Math.max(2, Math.min(MAX_WIDTH_STATIONS, Math.round(total / WIDTH_STATION_PX) + 1));
  const out = new Array<number>(n);
  let i = 0;
  for (let k = 0; k < n; k++) {
    const d = (total * k) / (n - 1);
    while (i < at.length - 2 && at[i + 1]! < d) i++;
    const span = at[i + 1]! - at[i]!;
    const f = span <= 1e-9 ? 0 : (d - at[i]!) / span;
    out[k] = w[i]! + (w[i + 1]! - w[i]!) * f;
  }
  return out;
}

/** Ends close enough to be one loop → close the path (see `vector.autoClosePx`). */
function shouldClose(points: readonly VectorStrokePoint[], autoClosePx: number): boolean {
  if (autoClosePx <= 0 || points.length < 4) return false;
  const a = points[0]!;
  const b = points[points.length - 1]!;
  return Math.hypot(b.x - a.x, b.y - a.y) <= autoClosePx;
}

/**
 * Collapse runs that are already near-straight into their two endpoints
 * (Douglas–Peucker). Fewer, more deliberate anchors — the fitter then only has
 * to curve what is genuinely curved.
 */
function straighten(points: readonly VectorStrokePoint[], epsilonPx: number): VectorStrokePoint[] {
  if (points.length < 3) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!;
    if (hi - lo < 2) continue;
    const a = points[lo]!;
    const b = points[hi]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    let worst = -1;
    let worstD = 0;
    for (let i = lo + 1; i < hi; i++) {
      const p = points[i]!;
      const d =
        len < 1e-9
          ? Math.hypot(p.x - a.x, p.y - a.y)
          : Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worstD > epsilonPx && worst > 0) {
      keep[worst] = 1;
      stack.push([lo, worst], [worst, hi]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

/**
 * A measured width curve as a `StrokeProfile.samples` array — multipliers on a
 * stroke of `strokeWidthPx`.
 *
 * The ONE conversion, so the stage, the append and the studio preview cannot
 * disagree about what a pressure curve means. Expressing it as a multiplier
 * (rather than baking the px in) is what keeps a drawing's width slider live:
 * every contour scales together, and the pressure shape survives.
 */
export function widthProfileSamples(widths: readonly number[], strokeWidthPx: number): number[] {
  const w = Math.max(0.01, strokeWidthPx);
  return widths.map((v) => Math.max(0, v / w));
}

/**
 * THE INK A DRAWN STROKE WEARS — the stroke styles it lands with: `lines` (the
 * brush's line stack, already in whatever space the stroke is written in), with
 * this stroke's own measured pressure folded onto the line that carries the
 * body. Per stroke, never per gesture: a confined stroke is several pieces, each
 * with its own pressure along its own length.
 *
 * One answer for every surface that draws with a vector brush — the flat
 * canvas and a 3D world's Draw.
 */
export function vectorStrokeInk(stroke: VectorStroke, lines: readonly StrokeStyle[]): StrokeStyle[] {
  const out = [...lines];
  if (stroke.widths && out[0]) {
    out[0] = { ...out[0], profile: { ...out[0].profile, samples: widthProfileSamples(stroke.widths, out[0].width) } };
  }
  return out;
}

/** The brush's line stack in a colour — the `lines` a fresh stroke is inked with. */
export function brushLines(stroke: VectorStroke, color: string): StrokeStyle[] {
  return strokesFromStack(stroke.lines, solidPaint(color));
}
