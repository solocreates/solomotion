"use client";

import {
  CAPTURE_PROPERTY,
  createId,
  locateClip,
  removeClipKeyframes,
  setKeyframe,
  setKeyframeEasing,
  smoothKeyframes,
  type DocumentStore,
  type Easing,
  type KeyframeRange,
  type KeyframeValue,
  type SpatialTangents,
} from "@solomotion/core";
import { clipLocalClamped } from "../inspector/animatable";
import { cloneSurfacePixels } from "../drawing/raster-store";
import { useSession } from "./session";

/**
 * Keyframe-level clipboard + delete. When keyframes are selected (session.
 * selectedKeyframeIds), the edit commands operate on THEM, not the clip — copy /
 * cut / paste / delete at the keyframe granularity. Times are stored relative to
 * the earliest copied key so a paste lands as a block at the playhead.
 */

interface CopiedKey {
  property: string;
  range: KeyframeRange | null;
  relTimeMs: number;
  value: KeyframeValue;
  easing: Easing;
  /** Motion-path curve handles ride along with a copied position key. */
  spatial: SpatialTangents | null;
}

let clipboard: CopiedKey[] = [];

function collectSelected(store: DocumentStore): CopiedKey[] {
  const ids = new Set(useSession.getState().selectedKeyframeIds);
  if (ids.size === 0) return [];
  const doc = store.getState();
  const out: CopiedKey[] = [];
  let minTime = Infinity;
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      for (const tr of clip.keyframes) {
        for (const k of tr.keys) {
          if (ids.has(k.id)) {
            out.push({ property: tr.property, range: tr.range, relTimeMs: k.timeMs, value: k.value, easing: k.easing, spatial: k.spatial ?? null });
            minTime = Math.min(minTime, k.timeMs);
          }
        }
      }
    }
  }
  return out.map((c) => ({ ...c, relTimeMs: c.relTimeMs - minTime }));
}

export function copyKeyframes(store: DocumentStore): number {
  const collected = collectSelected(store);
  if (collected.length === 0) return 0;
  clipboard = collected;
  return clipboard.length;
}

export function deleteKeyframes(store: DocumentStore): number {
  const ids = useSession.getState().selectedKeyframeIds;
  if (ids.length === 0) return 0;
  // Each clip bakes at ITS OWN local time — the selection can span layers with
  // different starts, and every one of them must keep the pose it shows now.
  const playheadMs = useSession.getState().playheadMs;
  store.update("Delete keyframes", (d) => {
    for (const track of d.tracks) {
      for (const clip of track.clips) {
        removeClipKeyframes(clip, ids, clipLocalClamped(clip, playheadMs));
      }
    }
  });
  useSession.getState().setSelectedKeyframes([]);
  return ids.length;
}

export function cutKeyframes(store: DocumentStore): number {
  const n = copyKeyframes(store);
  if (n > 0) deleteKeyframes(store);
  return n;
}

/** The easing of the first selected keyframe (seed for the easing popover). */
export function selectedKeyframeEasing(store: DocumentStore): Easing | null {
  const ids = new Set(useSession.getState().selectedKeyframeIds);
  if (ids.size === 0) return null;
  const doc = store.getState();
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      for (const tr of clip.keyframes) {
        for (const k of tr.keys) if (ids.has(k.id)) return k.easing;
      }
    }
  }
  return null;
}

/** Apply one easing to EVERY selected keyframe (the E popover's commit). */
export function applyEasingToSelectedKeyframes(store: DocumentStore, easing: Easing): number {
  const ids = useSession.getState().selectedKeyframeIds;
  if (ids.length === 0) return 0;
  store.update(
    "Set easing",
    (d) => {
      for (const track of d.tracks) {
        for (const clip of track.clips) {
          for (const id of ids) setKeyframeEasing(clip.keyframes, id, easing);
        }
      }
    },
    { mergeKey: "easing-popover" },
  );
  return ids.length;
}

/**
 * "Smooth" the selected keyframes — the smart-easing pass that finds the
 * flowing route between the values so the animation stops PAUSING at every
 * key (see core `smoothKeyframes`). Values, positions and times are untouched;
 * only easings (and motion-path tangents) change. Returns the count.
 */
export function smoothSelectedKeyframes(store: DocumentStore): number {
  const ids = useSession.getState().selectedKeyframeIds;
  if (ids.length === 0) return 0;
  const idSet = new Set(ids);
  store.update("Smooth keyframes", (d) => {
    for (const track of d.tracks) {
      for (const clip of track.clips) {
        if (clip.keyframes.some((tr) => tr.keys.some((k) => idSet.has(k.id)))) {
          smoothKeyframes(clip.keyframes, idSet);
        }
      }
    }
  });
  return ids.length;
}

export function pasteKeyframes(store: DocumentStore): number {
  if (clipboard.length === 0) return 0;
  const session = useSession.getState();
  const clipId = session.selectedClipIds[0];
  if (!clipId) return 0;
  const newIds: string[] = [];
  // Capture snapshots can't be shared between keys — each pasted frame gets a
  // fresh, independently-editable copy of the source snapshot's pixels.
  const snapshotClones: Array<{ from: string; to: string; width: number; height: number }> = [];
  store.update("Paste keyframes", (d) => {
    const loc = locateClip(d, clipId);
    if (!loc) return;
    const base = clipLocalClamped(loc.clip, session.playheadMs);
    for (const c of clipboard) {
      let value = c.value;
      if (c.property === CAPTURE_PROPERTY && typeof c.value === "string" && loc.clip.kind === "raster") {
        const to = createId("snap");
        snapshotClones.push({ from: c.value, to, width: loc.clip.width, height: loc.clip.height });
        value = to;
      }
      const key = setKeyframe(
        loc.clip.keyframes,
        c.property,
        Math.min(loc.clip.durationMs, base + c.relTimeMs),
        value,
        c.easing,
        c.range,
      );
      if (c.spatial) key.spatial = { in: c.spatial.in ? { ...c.spatial.in } : null, out: c.spatial.out ? { ...c.spatial.out } : null };
      newIds.push(key.id);
    }
  });
  for (const clone of snapshotClones) cloneSurfacePixels(clone.from, clone.to, clone.width, clone.height);
  session.setSelectedKeyframes(newIds);
  return newIds.length;
}
