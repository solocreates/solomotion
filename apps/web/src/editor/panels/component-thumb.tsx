"use client";

import * as React from "react";
import { collectFontFamilies, compDurationMs, type Clip, type Frame, type MotionDocument } from "@solomotion/core";
import { Component } from "lucide-react";
import { drawFrameContent } from "../stage/render/draw-frame";
import { fontsVersion } from "../stage/render/fonts";
import { ensureDocumentFaces } from "../stage/render/system-fonts";

/**
 * Real, cached component thumbnails. A component's look is rendered ONCE (via
 * the shared `drawFrameContent` — pixel-identical to the canvas) to an offscreen
 * canvas and memoized as a data URL, keyed by a cheap content SIGNATURE. When
 * the component changes, the signature changes and the thumb re-renders;
 * otherwise every card reuses the cached image (no re-render on scroll / mount).
 */

const cache = new Map<string, { sig: string; url: string }>();

/** A content fingerprint — changes exactly when the rendered look would. */
function componentSignature(doc: MotionDocument, frame: Frame): string {
  const parts: string[] = [`${frame.width}x${frame.height}:${frame.background}`];
  for (const track of doc.tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips as Clip[]) {
      if (clip.frameId !== frame.id || clip.kind === "audio" || clip.hidden) continue;
      parts.push(`${clip.id}:${clip.kind}:${clip.startMs}:${clip.durationMs}:k${clip.keyframes.length}`);
      const c = clip as unknown as Record<string, unknown>;
      const t = c.transform as { x: number; y: number; scale: number; scaleY: number | null; rotation: number } | undefined;
      if (t) parts.push(`${t.x},${t.y},${t.scale},${t.scaleY},${t.rotation}`);
      if (c.fills) parts.push(JSON.stringify(c.fills));
      if (c.strokes) parts.push(JSON.stringify(c.strokes));
      parts.push(`o${c.opacity ?? 1}:b${c.blendMode ?? "normal"}`);
      if (clip.kind === "text") parts.push(`${clip.text}:${clip.style.color}:${clip.style.fontFamily}`);
      if (clip.kind === "shape") parts.push(`${clip.width}x${clip.height}:${clip.shape}`);
      if (clip.kind === "path") parts.push(`p${clip.subpaths.length}`);
    }
  }
  return parts.join("|");
}

/** Render the component's frame to a fitted data URL (or null if empty). */
function renderThumb(doc: MotionDocument, frame: Frame, box = 168): string | null {
  if (typeof document === "undefined") return null;
  const s = Math.min(box / frame.width, box / frame.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(frame.width * s));
  canvas.height = Math.max(1, Math.round(frame.height * s));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(s, 0, 0, s, 0, 0);
  // Half-way through the comp — a representative frame past any in-animation.
  const t = Math.min(compDurationMs(doc, frame.id) * 0.5, 3000);
  try {
    drawFrameContent(ctx, doc, frame, t);
  } catch {
    return null;
  }
  return canvas.toDataURL();
}

export function ComponentThumb({ doc, frame }: { doc: MotionDocument; frame: Frame }) {
  // Re-render when fonts finish loading (text components) — cheap counter read.
  const fv = fontsVersion();
  const sig = React.useMemo(() => componentSignature(doc, frame), [doc, frame]);
  const [url, setUrl] = React.useState<string | null>(() => {
    const c = cache.get(frame.id);
    return c && c.sig === sig ? c.url : null;
  });

  React.useEffect(() => {
    const cached = cache.get(frame.id);
    if (cached && cached.sig === sig) {
      setUrl(cached.url);
      return;
    }
    ensureDocumentFaces(doc);
    const u = renderThumb(doc, frame);
    if (u) {
      cache.set(frame.id, { sig, url: u });
      setUrl(u);
    } else {
      setUrl(null);
    }
  }, [doc, frame, sig, fv]);

  if (!url) return <Component className="size-5 text-[#9B7BFF]" />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="" draggable={false} className="max-h-full max-w-full object-contain" />;
}
