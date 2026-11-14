"use client";

import * as React from "react";
import { resolveSurfaceParams, sampleKeyframes, type Clip, type LayerEffect, type SurfaceEffect } from "@solomotion/core";
import { useParkedPlayhead } from "../state/session";
import { clipLocalClamped } from "./animatable";
import { getImageForAsset, onMediaReady } from "../stage/render/media-cache";

/**
 * WHAT AN EFFECT MAKES OF AN `image` FIELD, live — the picture the field's
 * well shows (see `ImageWell`). Keyed by effect type and field, so a new
 * texture-reading effect that generates a picture of its own adds one row
 * here; one that only reads a picture needs nothing (the well shows the
 * asset).
 */
type PictureProps = { clip: Clip; effectId: string };

const PICTURES: Record<string, Record<string, React.ComponentType<PictureProps>>> = {
  surface: { texture: SurfaceSheet },
};

export function effectFieldPicture(type: string | undefined, field: string, clip: Clip | null, effectId: string): React.ReactNode {
  const Picture = type ? PICTURES[type]?.[field] : undefined;
  return Picture && clip ? <Picture clip={clip} effectId={effectId} /> : undefined;
}

/** The card's own effect object, from the live clip. */
function findEffect(clip: Clip, effectId: string): LayerEffect | undefined {
  const stack = (clip as { effects?: LayerEffect[] }).effects;
  return stack?.find((e) => e.id === effectId);
}

/** A flat sheet to lay the material on: a neutral, so the material's own tone and dye read true. */
function plate(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f4f1ea";
  g.fillRect(0, 0, w, h);
  return c;
}

/**
 * THE SHEET, through the real Surface pass — the same code the stage and the
 * exporter run, at the playhead, with this card's dials. Only the cut is left
 * out (there is no picture to cut here): what you see is the pattern and the
 * light, your texture or the material's own, moving as you drag.
 */
function SurfaceSheet({ clip, effectId }: PictureProps) {
  const ref = React.useRef<HTMLCanvasElement>(null);
  const playheadMs = useParkedPlayhead();
  const fx = findEffect(clip, effectId);
  const [decoded, setDecoded] = React.useState(0);

  // A texture still decoding draws the material; repaint the moment it lands.
  React.useEffect(() => onMediaReady(() => setDecoded((n) => n + 1)), []);

  React.useEffect(() => {
    const canvas = ref.current;
    if (!canvas || fx?.type !== "surface") return;
    let live = true;
    const frame = requestAnimationFrame(async () => {
      const { surface } = await import("../stage/render/passes/surface");
      if (!live) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(64, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(32, Math.round(canvas.clientHeight * dpr));
      const sampled = sampleKeyframes(clip.keyframes, clipLocalClamped(clip, playheadMs));
      // The sheet alone: no cut, no lights to spare, fully wet.
      const sheet: SurfaceEffect = { ...(fx as SurfaceEffect), lift: 0, edge: 0, breakup: 0, lights: 0, mix: 1 };
      // About 600 frame px across the well — enough of the sheet to read its pattern.
      const params = { ...resolveSurfaceParams(sheet, sampled, w / 600, (playheadMs - clip.startMs) / 1000), lift: 0, edge: 0, breakup: 0, lights: 0, mix: 1 };
      const img = params.texture ? getImageForAsset(params.texture) : null;
      const out = surface({ kind: "surface", params, texture: img && img.width ? img : null }, plate(w, h), w, h, { backdrop: null });
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d")!.drawImage(out, 0, 0);
    });
    return () => {
      live = false;
      cancelAnimationFrame(frame);
    };
  }, [clip, fx, playheadMs, decoded]);

  return <canvas ref={ref} aria-hidden className="size-full" />;
}
