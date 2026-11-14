"use client";

import { createId, type MotionDocument, type Frame, type VisualClip } from "@solomotion/core";
import { putAssetBlob } from "../assets/asset-store";
import { drawClipPoster } from "../stage/render/draw-frame";

/**
 * TURN A LAYER INTO A BRUSH TIP.
 *
 * Procreate makes you export a shape, leave, and re-import it. There is no
 * reason for that here: a tip's source is an opaque blob id, and the app
 * already knows how to draw one clip into a box (`drawClipPoster` — the same
 * function behind layer thumbnails). So "use this as my brush" is a render and
 * a blob, with no round trip through the filesystem and no second code path in
 * the painter, which sees an asset id either way.
 *
 * The capture is ALPHA ONLY, and deliberately: a tip is a stencil, and the
 * stroke's own colour fills it. Keeping the layer's colours would make a brush
 * that paints one colour forever — which is a sticker, not a brush.
 */
export const TIP_CAPTURE_PX = 512;

export async function captureClipAsTip(
  doc: MotionDocument,
  frame: Frame,
  clip: VisualClip,
  timeMs: number,
): Promise<string | null> {
  const canvas = document.createElement("canvas");
  canvas.width = TIP_CAPTURE_PX;
  canvas.height = TIP_CAPTURE_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const drew = drawClipPoster(ctx, doc, frame, clip, timeMs, TIP_CAPTURE_PX, TIP_CAPTURE_PX);
  if (!drew) return null;

  // Flatten to a white stencil: the alpha is the shape, the colour is thrown
  // away. `source-in` keeps exactly the pixels the layer covered.
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, TIP_CAPTURE_PX, TIP_CAPTURE_PX);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return null;
  const id = createId("brushtip");
  await putAssetBlob(id, blob);
  return id;
}
