"use client";

import * as React from "react";
import type { DeviceSound } from "@solomotion/core";
import { NAMES } from "@/editor/names";

/**
 * App-level custom sounds — saved "for all my projects (this device)". The
 * BYTES live in the same OPFS blob store as every asset (keyed by id); this
 * registry is just the metadata list, so any project can adopt one by adding a
 * `doc.assets` entry pointing at the same id.
 *
 * This is also where a DOWNLOADED library sound lands. There is no separate
 * downloads store, because a downloaded sound and a saved sound are the same
 * thing wearing different provenance — `originId` records where it came from
 * and that is the entire difference.
 *
 * The row shape is core's `DeviceSound`, not a local copy of it: the catalogue
 * reads these, and two structs describing one row is how the picker and the
 * browser end up disagreeing about what a sound is called.
 */
export type AppSound = DeviceSound;

const KEY = NAMES.storage.appSounds;

/**
 * The parsed list, cached. `useSyncExternalStore` needs a snapshot that is
 * referentially stable between writes, and re-parsing localStorage on every
 * render would both churn and loop.
 */
let snapshot: AppSound[] | null = null;
const EMPTY: AppSound[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  snapshot = null;
  for (const cb of listeners) cb();
}

export function listAppSounds(): AppSound[] {
  if (typeof window === "undefined") return EMPTY;
  if (snapshot) return snapshot;
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    snapshot = Array.isArray(parsed) ? (parsed as AppSound[]) : EMPTY;
  } catch {
    snapshot = EMPTY;
  }
  return snapshot;
}

export function saveAppSound(sound: AppSound): void {
  const list = listAppSounds().filter((s) => s.id !== sound.id);
  list.push(sound);
  window.localStorage.setItem(KEY, JSON.stringify(list));
  emit();
}

export function removeAppSound(id: string): void {
  window.localStorage.setItem(KEY, JSON.stringify(listAppSounds().filter((s) => s.id !== id)));
  emit();
}

/** Re-render when this device's sound list changes (a save, or a download). */
export function useAppSounds(): AppSound[] {
  return React.useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    listAppSounds,
    () => EMPTY,
  );
}
