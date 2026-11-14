"use client";

import * as React from "react";
import { resolveColor, type MotionDocument, type Paint, type PatternSpec } from "@solomotion/core";
import { getImageForAsset, onMediaReady } from "../stage/render/media-cache";
import { drawPaintInto, makeColorResolver, type ColorResolver } from "../stage/render/paint-style";
import { useDoc } from "../state/document-context";
import { cn } from "@/lib/utils";

/**
 * THE preview of a paint — a canvas painted by the SAME code that paints the
 * stage.
 *
 * Every swatch, chip, preset card and studio preview in the app is this
 * component, so "what the picker shows" and "what the layer draws" are not two
 * implementations that agree by diligence; they are one implementation. The
 * previous arrangement approximated paints in CSS, which was exact for solids,
 * close enough for ramps, and a fiction for patterns — CSS cannot rotate a
 * tiling, so every hatch in the picker was drawn straight while the canvas drew
 * it at 45°.
 *
 * It repaints on any change to the paint, so dragging an angle or a scale
 * animates the preview under your finger, which is the entire point of having
 * one.
 *
 * A SOLID is the one paint that skips the raster, and it is not an exception to
 * the rule above — see `PaintCanvas`. A flat fill has no geometry to get wrong;
 * the element's background is literally the string the painter would have
 * filled with.
 */

/** The checker under anything with transparency. Painted, not a CSS layer, so
 *  it survives being screenshotted and exported alongside the paint. */
function paintChecker(ctx: CanvasRenderingContext2D, w: number, h: number, size = 8) {
  ctx.fillStyle = "#2a2a30";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#3a3a42";
  for (let y = 0; y < h; y += size) {
    for (let x = 0; x < w; x += size) {
      if (((x / size) | 0) % 2 === ((y / size) | 0) % 2) ctx.fillRect(x, y, size, size);
    }
  }
}

const assetImages = (assetId: string) => getImageForAsset(assetId);

/** The painted checker's two tones, as CSS — the same values `paintChecker`
 *  fills with, so the rastered and un-rastered halves match. */
const CHECKER_CSS = "repeating-conic-gradient(#3a3a42 0% 25%, #2a2a30 0% 50%) 0 0 / 16px 16px";

export function PaintPreview({
  paint,
  className,
  /** Checker beneath, for paints that may be transparent. On by default. */
  checker = true,
  /** Resolve colours through this document. Defaults to the open one. */
  doc,
  radius,
}: {
  paint: Paint;
  className?: string;
  checker?: boolean;
  doc?: MotionDocument;
  radius?: number;
}) {
  const open = useDoc();
  const document_ = doc ?? open;
  const resolve = React.useMemo(() => makeColorResolver(document_), [document_]);
  return <PaintCanvas paint={paint} resolve={resolve} className={className} checker={checker} radius={radius} />;
}

/**
 * The document-free half. A preset card renders paints that are not in any
 * document yet, and asking it to invent one just to get a resolver would have
 * been the reason someone eventually wrote a second, CSS-based preview.
 */
export function PaintCanvas({
  paint,
  resolve,
  className,
  checker = true,
  radius,
}: {
  paint: Paint;
  resolve: ColorResolver;
  className?: string;
  checker?: boolean;
  radius?: number;
}) {
  const ref = React.useRef<HTMLCanvasElement | null>(null);
  // The paint's own values, not its identity: a draft that replaces the object
  // every keystroke would otherwise repaint on every render whether or not
  // anything visible changed.
  const key = JSON.stringify(paint);

  /**
   * A SOLID needs no canvas.
   *
   * Not a CSS approximation — the exception this file exists to prevent. The
   * canvas path for a solid is `fillStyle = resolve(color); fillRect(…)`, so
   * the element background IS the value the painter would use, byte for byte.
   * There is nothing to disagree about, and no second implementation: the same
   * resolver produces the same string.
   *
   * It matters because a palette shelf is a hundred of these. A hundred
   * canvases means a hundred contexts, a hundred DPR-scaled backing stores and
   * a hundred repaints every time the popover re-renders — which is what put
   * the fan on. Gradients, patterns and media still go through the painter,
   * where the fidelity actually was at stake.
   */
  const flat = paint.type === "solid" ? resolve(paint.color) : null;
  const [mediaTick, setMediaTick] = React.useState(0);

  // An image pattern or media fill may still be decoding when we first paint.
  // The media cache announces when that changes; one subscription per preview
  // is cheap and is what stops an image swatch staying empty until you nudge it.
  const wantsMedia = key.includes('"image"') || key.includes('"media"');
  React.useEffect(() => {
    if (!wantsMedia) return;
    return onMediaReady(() => setMediaTick((t) => t + 1));
  }, [wantsMedia]);

  React.useEffect(() => {
    const canvas = ref.current;
    if (!canvas || flat !== null) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (checker) paintChecker(ctx, w, h);
    drawPaintInto(ctx, paint, { x: 0, y: 0, w, h }, resolve, assetImages);
  }, [key, resolve, checker, mediaTick, paint, flat]);

  if (flat !== null) {
    return (
      <span
        aria-hidden
        className={cn("block size-full", className)}
        style={{
          // The checker shows through a translucent colour, exactly as the
          // painted one does — it is the same two layers, minus the raster.
          background: checker ? CHECKER_CSS : undefined,
          borderRadius: radius,
        }}
      >
        <span className="block size-full" style={{ background: flat, borderRadius: radius }} />
      </span>
    );
  }

  return (
    <canvas
      ref={ref}
      aria-hidden
      className={cn("block size-full", className)}
      style={radius !== undefined ? { borderRadius: radius } : undefined}
    />
  );
}

/**
 * A pattern's preview, for surfaces that hold a spec rather than a whole paint
 * (the studio's header, a design card). Wraps the spec so there is still only
 * one painter — a second one that "just draws patterns" is how the studio and
 * the swatch would start disagreeing about what scale means.
 */
export function PatternPreview({
  pattern,
  className,
  doc,
  radius,
}: {
  pattern: PatternSpec;
  className?: string;
  doc?: MotionDocument;
  radius?: number;
}) {
  const paint = React.useMemo<Paint>(
    () => ({ id: "preview", type: "pattern", pattern, enabled: true, opacity: 1, blendMode: "normal" }),
    [pattern],
  );
  return <PaintPreview paint={paint} className={className} doc={doc} radius={radius} />;
}

/** Resolve a colour through a document without a component — for the handful of
 *  places that still need a string (an input's text, a contrast decision). */
export function useColorResolver(): (color: string) => string {
  const doc = useDoc();
  return React.useCallback((c: string) => resolveColor(doc, c), [doc]);
}
