"use client";

import * as React from "react";
import type { DocumentStore } from "@solomotion/core";
import { getAudioBufferForAsset, onAudioBufferReady } from "./waveform";

/**
 * Heal audio lengths against the DECODED buffer — the one ground truth for how
 * long a sound actually is. An HTMLMediaElement over-reports duration for VBR
 * MP3, so a clip imported before the decode-at-import fix (or loaded from an old
 * project) can run LONGER than its real audio: its waveform then fills only the
 * true sound and blanks the phantom tail — the "wave ends sooner / wrong scale"
 * bug. On every decode we reconcile:
 *   1. correct each audio asset's stored `durationMs` to the buffer's, and
 *   2. clamp any NON-looping audio clip that claims more of the asset than
 *      exists down to the true available source ((trueMs − trimIn) ÷ speed).
 * Looping clips are meant to exceed their source, so they're left alone. One
 * coalesced, undoable step; the `needs` guard makes it a no-op once healed, so
 * running it again on the next decode can't loop.
 */

const TOLERANCE_MS = 40;

function trueDurationsByAsset(store: DocumentStore): Map<string, number> {
  const out = new Map<string, number>();
  for (const asset of store.getState().assets) {
    if (asset.kind !== "audio") continue;
    // Sync cache hit; a miss kicks the decode and repaints via onAudioBufferReady.
    const buffer = getAudioBufferForAsset(asset.id);
    if (buffer && buffer.duration > 0.05) out.set(asset.id, Math.round(buffer.duration * 1000));
  }
  return out;
}

/** Available source (ms) an unlooped audio clip can actually play of its asset. */
function clipCapacityMs(clip: { trimInMs: number; playback: { speed: number } }, trueMs: number): number {
  const speed = clip.playback.speed > 0 ? clip.playback.speed : 1;
  return Math.max(0, trueMs - clip.trimInMs) / speed;
}

function heal(store: DocumentStore): void {
  const trueMs = trueDurationsByAsset(store);
  if (trueMs.size === 0) return;
  const doc = store.getState();

  let needs = false;
  for (const asset of doc.assets) {
    const t = trueMs.get(asset.id);
    if (t != null && (asset.durationMs == null || Math.abs(asset.durationMs - t) > TOLERANCE_MS)) {
      needs = true;
      break;
    }
  }
  if (!needs) {
    outer: for (const track of doc.tracks) {
      for (const clip of track.clips) {
        if (clip.kind !== "audio" || clip.source.type !== "asset" || clip.playback.loop !== "none") continue;
        const t = trueMs.get(clip.source.assetId);
        if (t == null) continue;
        const cap = clipCapacityMs(clip, t);
        if (cap >= 1 && clip.durationMs > cap + TOLERANCE_MS) {
          needs = true;
          break outer;
        }
      }
    }
  }
  if (!needs) return;

  store.update(
    "Sync audio length",
    (d) => {
      for (const asset of d.assets) {
        const t = trueMs.get(asset.id);
        if (t != null) asset.durationMs = t;
      }
      for (const track of d.tracks) {
        for (const clip of track.clips) {
          if (clip.kind !== "audio" || clip.source.type !== "asset" || clip.playback.loop !== "none") continue;
          const t = trueMs.get(clip.source.assetId);
          if (t == null) continue;
          const cap = clipCapacityMs(clip, t);
          if (cap >= 1 && clip.durationMs > cap + TOLERANCE_MS) clip.durationMs = Math.max(1, Math.round(cap));
        }
      }
    },
    { mergeKey: "sync-audio-length" },
  );
}

/** Mount once (in the editor shell): reconcile on load and on every decode. */
export function useAudioDurationHeal(store: DocumentStore): void {
  React.useEffect(() => {
    heal(store);
    return onAudioBufferReady(() => heal(store));
  }, [store]);
}
