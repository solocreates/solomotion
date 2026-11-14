"use client";

import {
  isVisualClip,
  layerEffectPath,
  locateClip,
  ENABLED_FIELD,
  type Frame,
  type KeyframeTrack,
  type LayerEffect,
  type MotionDocument,
} from "@solomotion/core";
import { drawFrameContent, type ClipHitRect } from "../stage/render/draw-frame";
import { hitAABB } from "../stage/stage-geometry";

/**
 * Layer-export bounds: the tight frame-space rectangle a set of clips covers.
 *
 * Reuses the renderer's own hit-rect pass — the same geometry the transform
 * box hugs — so text layout, corner-dragged shapes, morphing paths and every
 * future clip kind measure correctly without a second bounds implementation.
 * Animated exports union the rect across sampled times so nothing animates
 * out of the crop; layer effects (shadows/blur) pad the rect by their reach.
 */

export interface ExportBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * How far a clip's layer effects paint past its geometry.
 *
 * An effect counts if it is on at ANY point on the timeline, not just right
 * now: `enabled` is keyframable, and a bound that shrank when the glow switched
 * off would crop the glow the moment it came back. Padding is a worst case by
 * definition, so the worst case is what it asks for.
 */
function effectsPadding(effects: LayerEffect[], keyframes: readonly KeyframeTrack[] = []): number {
  const keyed = new Set(
    keyframes.filter((t) => t.property.endsWith(`.${ENABLED_FIELD}`)).map((t) => t.property),
  );
  let pad = 0;
  for (const fx of effects) {
    if (!fx.enabled && !keyed.has(layerEffectPath(fx.id, ENABLED_FIELD))) continue;
    if (fx.type === "shadow") {
      pad = Math.max(pad, Math.hypot((fx.x as number) ?? 0, (fx.y as number) ?? 0) + (((fx.blur as number) ?? 0) * 1.5));
    } else if (fx.type === "blur") {
      pad = Math.max(pad, (((fx.radius as number) ?? 0) * 2));
    } else if (fx.type === "glow" && !fx.inner) {
      // A bloom reaches roughly its blur radius, and the additive stack pushes
      // the faint tail out further than the nominal size.
      pad = Math.max(pad, ((fx.size as number) ?? 0) * 2);
    } else if (fx.type === "stroke" && fx.placement !== "inside") {
      const width = (fx.width as number) ?? 0;
      pad = Math.max(pad, fx.placement === "center" ? width / 2 : width);
    } else if (fx.type === "longShadow") {
      // The trail is cast entirely to one side, but the box is symmetric, so
      // the full length has to be allowed for in every direction.
      pad = Math.max(pad, (fx.length as number) ?? 0);
    }
  }
  return Math.ceil(pad);
}

/** Evenly spread sample times across a span (bounds of an animated export). */
export function boundsSampleTimes(startMs: number, endMs: number, fps: number, cap = 48): number[] {
  const span = Math.max(0, endMs - startMs);
  if (span === 0) return [startMs];
  const frames = Math.max(1, Math.round((span / 1000) * fps));
  const steps = Math.min(cap, frames);
  const times: number[] = [];
  for (let i = 0; i <= steps; i++) times.push(startMs + (span * i) / steps);
  return times;
}

// One tiny shared scratch context — the pass only collects geometry.
let scratch: CanvasRenderingContext2D | null = null;
function scratchCtx(): CanvasRenderingContext2D | null {
  if (!scratch) {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    scratch = canvas.getContext("2d");
  }
  return scratch;
}

/**
 * Measure the union bounds of `clipIds` in `frame` across `sampleTimes`
 * (document time, ms). Returns integer pixel bounds with a 1px breathing
 * margin, or null when nothing draws at any sampled time.
 */
export function measureTargetBounds(
  doc: MotionDocument,
  frame: Frame,
  clipIds: string[],
  sampleTimes: number[],
): ExportBounds | null {
  const ctx = scratchCtx();
  if (!ctx || clipIds.length === 0) return null;
  const only = new Set(clipIds);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const t of sampleTimes) {
    const hits: ClipHitRect[] = [];
    ctx.save();
    drawFrameContent(ctx, doc, frame, t, { only, hitRects: hits, transparent: true });
    ctx.restore();
    for (const h of hits) {
      if (!only.has(h.clipId)) continue;
      const box = hitAABB(h);
      minX = Math.min(minX, box.minX);
      minY = Math.min(minY, box.minY);
      maxX = Math.max(maxX, box.maxX);
      maxY = Math.max(maxY, box.maxY);
    }
  }
  if (minX > maxX) return null;

  let pad = 1;
  for (const id of clipIds) {
    const loc = locateClip(doc, id);
    if (loc && isVisualClip(loc.clip)) pad = Math.max(pad, effectsPadding(loc.clip.effects, loc.clip.keyframes));
  }

  return {
    x: Math.floor(minX - pad),
    y: Math.floor(minY - pad),
    width: Math.max(2, Math.ceil(maxX - minX + pad * 2)),
    height: Math.max(2, Math.ceil(maxY - minY + pad * 2)),
  };
}
