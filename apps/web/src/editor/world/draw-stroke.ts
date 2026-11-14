import {
  StrokeEngine,
  brushLines,
  contoursHaveDepth,
  createPathClip,
  editPathGeometry,
  inkInSpace,
  landContours,
  locateClip,
  pathOnPage,
  placeClip,
  setContourInk,
  stabilizerRadius,
  toPage,
  toSubpath,
  vectorStroke,
  vectorStrokeInk,
  type BrushPreset,
  type DocumentStore,
  type DrawPage,
  type V3,
  type VectorStroke,
} from "@solomotion/core";
import { armedBrushFor, useBrushLibrary, useDrawing } from "../drawing/drawing-store";
import { paintVectorStroke } from "../drawing/brush-preview";
import { PenInput } from "../drawing/pen-input";
import { gestureMods } from "../input/modifiers";
import { animWriteMode } from "../inspector/animatable";

/**
 * THE VECTOR BRUSH, DRAWING IN A WORLD.
 *
 * The flat brush, exactly: the same front end (`PenInput` — coalesced samples,
 * the leash in screen px, the pen response), the same streamline
 * (`StrokeEngine`), the same fit (`vectorStroke`) at the brush's px sizes, and
 * the same preview (`paintVectorStroke`). The fit happens in SCREEN px, where
 * the brush's units are true, and the preview paints that fit — so the line
 * you watch is the line that lands. (The preview used to be a round marker at
 * the nominal size: the real stroke, with its pressure and taper, replaced it
 * on release and looked like the line shrank.)
 *
 * Size is screen-sized, as Blender's grease pencil is: a 6px brush draws a line
 * that looks 6px wide where you drew it, at any camera distance. What is 3D's
 * alone is WHERE it lands — the viewport's `DrawLanding`, and core `world/draw`.
 */
export class DrawGesture {
  readonly brush: BrushPreset = armedBrushFor("vector");
  readonly sizePx: number;
  readonly opacity: number;
  readonly color: string;
  private readonly pen: PenInput;
  private readonly engine: StrokeEngine;
  private fitted: { n: number; fit: VectorStroke | null } = { n: -1, fit: null };

  constructor(e: PointerEvent, local: (ev: PointerEvent) => { x: number; y: number }) {
    const drawing = useDrawing.getState();
    const eff = useBrushLibrary.getState().effective(this.brush.id);
    this.sizePx = eff.size;
    this.opacity = eff.opacity;
    this.color = drawing.brush.color;
    this.pen = new PenInput(drawing.pressure, e.pointerType, () => stabilizerRadius(useDrawing.getState().brush.fidelity.smoothing, gestureMods().shift));
    this.engine = new StrokeEngine(this.brush, drawing.pressure, eff.size, 1, Date.now() & 0xffff);
    this.push(e, local);
  }

  push(e: PointerEvent, local: (ev: PointerEvent) => { x: number; y: number }): void {
    for (const s of this.pen.take(e, local)) this.engine.feed(s);
  }

  /** The stroke as it will commit — refitted only when the hand has moved since. */
  fit(): VectorStroke | null {
    const line = this.engine.polyline;
    if (this.fitted.n !== line.length) {
      const drawing = useDrawing.getState();
      this.fitted = { n: line.length, fit: line.length > 1 ? vectorStroke(line, this.brush, this.sizePx, { fidelity: drawing.brush.fidelity, pressure: drawing.pressure }) : null };
    }
    return this.fitted.fit;
  }

  /** The pen lifted: the streamline catches up with the hand, and the fit is final. */
  finish(): VectorStroke | null {
    this.engine.finish();
    this.fitted.n = -1;
    return this.fit();
  }

  /** The live stroke on the viewport's overlay, in screen px. */
  paint(ctx: CanvasRenderingContext2D, resolve: (color: string) => string): void {
    const fit = this.fit();
    if (fit) paintVectorStroke(ctx, fit, resolve(this.color), this.opacity);
  }
}

/**
 * WHERE A STROKE LANDS — the viewport's half, handed to the commit.
 *
 * `land` meets the drawing (the page, or a surface under it); `onPage` meets
 * the page alone. `into` is an existing flat stroke layer standing on this very
 * page: a stroke APPENDS to it, as a flat brush stroke appends to its vector
 * layer, so a drawing on one page is one layer — its regions fill together and
 * it moves as one — instead of a layer per line.
 */
export interface DrawLanding {
  page: DrawPage;
  /** World units per screen px on the page. */
  unitsPerPx: number;
  land(x: number, y: number): V3 | null;
  onPage(x: number, y: number): V3 | null;
  into: { clipId: string; toLayer(w: V3): { x: number; y: number; z: number }; unitsPerWorld: number } | null;
}

/** Commit a finished gesture. Returns the layer it landed in. */
export function commitDrawnStroke(store: DocumentStore, frameId: string, gesture: DrawGesture, at: DrawLanding, span: { startMs: number; durationMs: number }): string | null {
  const fit = gesture.finish();
  if (!fit) return null;
  const ink = vectorStrokeInk(fit, brushLines(fit, gesture.color));

  const into = at.into;
  if (into) {
    const local = landContours(fit.subpaths, at.land, at.onPage, into.toLayer);
    const target = locateClip(store.getState(), into.clipId)?.clip;
    if (local && !contoursHaveDepth(local) && target?.kind === "path" && animWriteMode(target, "geometry") !== "keyframe") {
      const subs = local.map(toSubpath);
      store.update("Brush stroke", (d) => {
        const clip = locateClip(d, into.clipId)?.clip;
        if (clip?.kind !== "path") return;
        editPathGeometry(clip, (list) => list.push(...subs));
        const strokes = inkInSpace(ink, at.unitsPerPx * into.unitsPerWorld);
        for (const c of subs) setContourInk(clip, c.id, { strokes, fills: [] });
      });
      return into.clipId;
    }
  }

  const onPage = landContours(fit.subpaths, at.land, at.onPage, (w) => toPage(at.page, w));
  const placed = onPage && pathOnPage(onPage, at.page);
  if (!placed) return null;
  const clip = createPathClip({ frameId, ...span, subpaths: placed.subpaths, name: "Stroke", fill: null, strokes: inkInSpace(ink, at.unitsPerPx) });
  clip.transform = { ...clip.transform, ...placed.transform };
  clip.fillDuration = true;
  store.update("Draw", (d) => placeClip(d, clip, { landing: "surface" }));
  return clip.id;
}
