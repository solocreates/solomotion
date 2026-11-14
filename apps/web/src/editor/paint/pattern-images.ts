"use client";

import * as React from "react";
import { NAMES } from "@/editor/names";

/**
 * Pattern images saved "for all my projects (this device)" — the same bargain
 * custom sounds strike, and deliberately the same shape.
 *
 * The BYTES live in the shared asset blob store keyed by id, exactly as every
 * imported file's do; this registry is only the metadata list. So adopting a
 * device pattern into a project is one `doc.assets` row pointing at bytes that
 * are already there — no copy, no second store, and a project that travels to
 * another machine carries its own asset because it was a real asset all along.
 *
 * A person who imports a paper texture wants it in THIS project by default and
 * in every project when they say so. Anything cleverer than those two options
 * is a preference nobody asked for.
 */
export interface DevicePatternImage {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  /** When it was saved — the browser sorts newest first. */
  savedAt: number;
}

const KEY = NAMES.storage.patternImages;

/** Parsed and cached: `useSyncExternalStore` needs a snapshot that is
 *  referentially stable between writes, or it loops. */
let snapshot: DevicePatternImage[] | null = null;
const EMPTY: DevicePatternImage[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  snapshot = null;
  for (const cb of listeners) cb();
}

export function listDevicePatternImages(): DevicePatternImage[] {
  if (typeof window === "undefined") return EMPTY;
  if (snapshot) return snapshot;
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    snapshot = Array.isArray(parsed) ? (parsed as DevicePatternImage[]).sort((a, b) => b.savedAt - a.savedAt) : EMPTY;
  } catch {
    snapshot = EMPTY;
  }
  return snapshot;
}

export function saveDevicePatternImage(image: DevicePatternImage): void {
  const list = listDevicePatternImages().filter((i) => i.id !== image.id);
  list.push(image);
  window.localStorage.setItem(KEY, JSON.stringify(list));
  emit();
}

export function removeDevicePatternImage(id: string): void {
  window.localStorage.setItem(KEY, JSON.stringify(listDevicePatternImages().filter((i) => i.id !== id)));
  emit();
}

/** Re-render when this device's pattern images change. */
export function useDevicePatternImages(): DevicePatternImage[] {
  return React.useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    listDevicePatternImages,
    () => EMPTY,
  );
}
