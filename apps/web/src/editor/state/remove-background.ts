"use client";

import {
  clipLocalTime,
  createLayerEffect,
  locateClip,
  type DocumentStore,
} from "@solomotion/core";
import { formatHex } from "@/lib/color";
import {
  animatedImageFrameAt,
  getImageForAsset,
  isAnimatedImageMime,
  videoFrameForClip,
  clipSourceMs,
} from "../stage/render/media-cache";
import { useSession } from "./session";
import { revealInInspector } from "./inspector-nav";

/**
 * "Remove background" — the one action every entry point (stage pill,
 * right-click, media inspector) calls. It reads the clip's CURRENT source
 * picture, auto-detects the dominant border color (that's the background in a
 * green-screen / product-shot / white-card frame), adds a Chroma key effect
 * seeded with it, and asks the inspector to scroll to the new card so the
 * user lands directly on tolerance/softness. More colors = add more cards.
 */
export function addBackgroundRemoval(store: DocumentStore, clipId: string): boolean {
  const doc = store.getState();
  const loc = locateClip(doc, clipId);
  if (!loc || (loc.clip.kind !== "image" && loc.clip.kind !== "video")) return false;
  const clip = loc.clip;
  const asset = doc.assets.find((a) => a.id === clip.assetId);
  const localMs = clipLocalTime(clip, useSession.getState().playheadMs) ?? 0;

  let src: CanvasImageSource | null = null;
  if (clip.kind === "video") {
    src = videoFrameForClip(
      clip.id,
      clip.assetId,
      clipSourceMs(doc, clip, localMs) / 1000,
    );
  } else if (asset && isAnimatedImageMime(asset.mime, asset.name)) {
    src = animatedImageFrameAt(clip.assetId, localMs);
  } else {
    src = getImageForAsset(clip.assetId, asset?.mime);
  }

  const detected = src ? detectEdgeKeyColor(src) : null;
  const fx = createLayerEffect("chromaKey");
  if (detected && fx.type === "chromaKey") fx.color = detected;

  store.update("Remove background", (d) => {
    const l = locateClip(d, clipId);
    if (l && l.clip.kind !== "audio") l.clip.effects.push(fx);
  });
  useSession.getState().select([clipId]);
  // ONE door: the tab, the section and the card, in a single request. This used
  // to be a bespoke `lfxFocusId` channel that could open the right tab and
  // still leave the stack collapsed.
  revealInInspector({ tab: "effects", section: "effects", entry: fx.id });
  return true;
}

/**
 * The dominant color of the picture's border ring — sampled at thumbnail
 * scale, clustered into coarse RGB buckets, averaged. Backgrounds live at the
 * margins, so this is the right seed even when the same color also appears
 * inside the subject ("edges only" exists for that case).
 */
export function detectEdgeKeyColor(src: CanvasImageSource): string | null {
  const canvas = document.createElement("canvas");
  const W = 96;
  const H = 96;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(src, 0, 0, W, H);
  } catch {
    return null;
  }
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, W, H).data;
  } catch {
    return null; // tainted source
  }

  // 4-bit RGB buckets over a 3px border ring.
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  const RING = 3;
  const sample = (x: number, y: number) => {
    const j = (y * W + x) * 4;
    if (data[j + 3]! < 128) return; // transparent border → nothing to key
    const r = data[j]!;
    const g = data[j + 1]!;
    const b = data[j + 2]!;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bucket.n++;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x >= RING && x < W - RING && y >= RING && y < H - RING) continue;
      sample(x, y);
    }
  }

  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
  if (!best || best.n < 8) return null; // no dominant border color — keep the default
  return formatHex({ r: best.r / best.n, g: best.g / best.n, b: best.b / best.n, a: 1 });
}
