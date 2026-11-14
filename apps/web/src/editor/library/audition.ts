"use client";

import { auditionGain, type LibraryItem } from "@solomotion/core";
import { libraryClient } from "./client";
import { auditionPrefs } from "./audition-prefs";
import { soundEngine } from "../audio/sound-engine";

/**
 * Hear a sound before you own it.
 *
 * Local sounds go through the app's own engine, so an audition is mixed and
 * gained exactly like the real thing. An ONLINE sound streams straight from its
 * public URL through a plain `<audio>` element — no download, no adoption, no
 * entry in anyone's library. Auditioning is not acquiring, and a browser that
 * silently downloaded every sound you hovered would fill a disk by lunchtime.
 *
 * One voice at a time, always: a library where two clicks overlap is a library
 * you cannot judge a sound in.
 *
 * AND ALWAYS THROUGH THE EAR GUARD. Auditioning a catalogue means clicking
 * through files mastered by hundreds of different people, on headphones, at
 * whatever level the last quiet one needed — which is why the guard exists at
 * all. It used to live in the sound browser, so the two other surfaces that
 * play online files (the Library browser and the inspector's sound picker)
 * played them raw: the exact ambush the guard was written to prevent, on the
 * two screens that never mentioned it. The correction is applied HERE, once,
 * below every browser, so there is no surface left that can forget.
 */

let current: HTMLAudioElement | null = null;

export function stopAudition(): void {
  if (!current) return;
  current.pause();
  current.src = "";
  current = null;
}

export function auditionItem(item: LibraryItem, volume?: number): void {
  stopAudition();
  const { volume: monitor, guard } = auditionPrefs();
  const level = volume ?? monitor;
  const action = item.action;

  if (action?.type === "sound") {
    // A synthesized pack has no measured loudness, so the guard has nothing to
    // correct — `auditionGain` returns the volume unchanged, which is the right
    // answer rather than a special case.
    if (action.pack) soundEngine.preview(action.pack, level);
    else if (action.assetId) soundEngine.previewCustom(action.assetId, level);
    return;
  }

  const client = libraryClient();
  if (!item.blob || !client) return;
  const el = new Audio(client.url(item.blob.path));
  el.crossOrigin = "anonymous";
  const loudnessDb = item.preview.type === "peaks" ? item.preview.loudnessDb : null;
  el.volume = Math.max(0, Math.min(1, auditionGain(level, loudnessDb ?? null, guard)));
  current = el;
  el.addEventListener("ended", () => {
    if (current === el) current = null;
  });
  void el.play().catch(() => {
    if (current === el) current = null;
  });
}

/** How long an audition of this item will run, for the sweep. */
export function auditionMs(item: LibraryItem): number {
  if (item.preview.type === "peaks") return item.preview.durationMs;
  return 400;
}
