"use client";

import * as React from "react";
import { peaksFromSamples, quantisePeaks, type LibraryItem } from "@solomotion/core";
import { audibleSeconds, packBufferSync, renderPackBuffer } from "../audio/sound-engine";
import { ensureAudioBuffer, getAudioBufferForAsset, onAudioBufferReady } from "../audio/waveform";

/**
 * ONE waveform for a sound, wherever its samples come from.
 *
 * A card used to draw a published sound through `PeaksWave` and a local one
 * through `SoundWave`, which meant two binners, two ideas of how long the sound
 * is, and two sweeps — so an audition ran past the end of one sound and
 * stopped short on another depending purely on which branch drew it. That is
 * what "unpredictable" was.
 *
 * Now there is one shape: `{ peaks, durationMs, hitMs }`. A published sound has
 * it already (derived at publish); a synthesized pack renders once and is
 * measured with the SAME `peaksFromSamples` and the same audible-length rule;
 * a decoded file likewise. The waveform is therefore identical before and after
 * a download, and the sweep always runs for exactly as long as you can hear.
 */

export interface SoundShape {
  peaks: number[];
  /** AUDIBLE length — what the sweep runs over, not the file's padded length. */
  durationMs: number;
  hitMs: number;
}

const EMPTY: SoundShape = { peaks: [], durationMs: 0, hitMs: 0 };

/** Measure a decoded buffer the same way the publish pipeline measures a file. */
function shapeOf(buffer: AudioBuffer, hitMs = 0): SoundShape {
  const audible = Math.max(0.02, audibleSeconds(buffer));
  return {
    peaks: quantisePeaks(
      peaksFromSamples(buffer.getChannelData(0), 128, 0, audible * buffer.sampleRate),
    ),
    durationMs: Math.round(audible * 1000),
    hitMs,
  };
}

const cache = new Map<string, SoundShape>();

/**
 * The same measurement, addressed by ASSET rather than by library item.
 *
 * An audio file is a waveform wherever it is drawn — the media grid, the fill
 * row, the picker — and none of those surfaces has a `LibraryItem` to hand.
 * Without this they fell back to `AssetThumb`'s image branch and rendered a
 * broken `<img>`: the empty box where a sound in the media library should be.
 */
export function useAssetSoundShape(assetId: string | null | undefined): SoundShape {
  const subscribe = React.useCallback(
    (wake: () => void) => {
      if (!assetId || cache.has(`asset:${assetId}`)) return () => {};
      if (!getAudioBufferForAsset(assetId)) void ensureAudioBuffer(assetId).then(wake);
      return onAudioBufferReady(wake);
    },
    [assetId],
  );
  const read = () => assetShape(assetId);
  return React.useSyncExternalStore(subscribe, read, read);
}

function assetShape(assetId: string | null | undefined): SoundShape {
  if (!assetId) return EMPTY;
  const hit = cache.get(`asset:${assetId}`);
  if (hit) return hit;
  const buffer = getAudioBufferForAsset(assetId);
  if (!buffer) return EMPTY;
  const shape = shapeOf(buffer);
  cache.set(`asset:${assetId}`, shape);
  return shape;
}

export function useSoundShape(item: LibraryItem): SoundShape {
  const action = item.action?.type === "sound" ? item.action : null;
  const pack = action?.pack;
  const assetId = action?.assetId;

  const subscribe = React.useCallback(
    (wake: () => void) => {
      if (cache.has(item.id)) return () => {};
      if (pack) {
        if (!packBufferSync(pack)) void renderPackBuffer(pack).then(wake);
        return () => {};
      }
      if (assetId && !getAudioBufferForAsset(assetId)) void ensureAudioBuffer(assetId).then(wake);
      return onAudioBufferReady(wake);
    },
    [item.id, pack, assetId],
  );
  const read = () => itemShape(item);
  return React.useSyncExternalStore(subscribe, read, read);
}

/** The published preview's shape, made once per preview so a read is a stable value. */
const publishedShapes = new WeakMap<object, SoundShape>();

function itemShape(item: LibraryItem): SoundShape {
  const hit = cache.get(item.id);
  if (hit) return hit;
  const action = item.action?.type === "sound" ? item.action : null;
  const published = item.preview.type === "peaks" ? item.preview : null;
  const buffer = action?.pack
    ? packBufferSync(action.pack)
    : action?.assetId
      ? getAudioBufferForAsset(action.assetId)
      : null;

  if (buffer) {
    const shape = shapeOf(buffer, published?.hitMs ?? action?.hitMs ?? 0);
    cache.set(item.id, shape);
    return shape;
  }
  // Nothing decoded yet: the PUBLISHED shape stands in, and it is the same
  // shape — which is why a sound does not visibly change when it arrives.
  if (!published) return EMPTY;
  let shape = publishedShapes.get(published);
  if (!shape) {
    shape = { peaks: published.peaks, durationMs: published.durationMs, hitMs: published.hitMs };
    publishedShapes.set(published, shape);
  }
  return shape;
}
