"use client";

import * as React from "react";
import { NAMES } from "@/editor/names";

/**
 * REMEMBERED WINDOW SIZES — headless, keyed by whatever the caller calls a
 * "kind" of window.
 *
 * A floating window has three answers to "how big are you", in priority order:
 *
 *   1. what the USER last dragged this KIND to — remembered here, across reloads;
 *   2. what the thing being shown asks for (its `WindowSizeHint`);
 *   3. the caller's default.
 *
 * The key is a plain string and this file has never heard of effects, so the
 * effect editor files sizes under an effect TYPE (`reverb`, `glass`), and a
 * plugin window will file them under a plugin id, with no code added here. That
 * is the point: this is the reusable half, and it lives beside `window-manager`
 * (which owns stacking) rather than inside the one surface that needed it first.
 *
 * Keyed by KIND, never by instance. Two reverbs on one clip are the same tool
 * opened twice; sizing them independently would mean the window you just tuned
 * re-opens wrong on the next card, and would grow an unbounded map keyed by ids
 * that die with their document.
 */

/** What a window asks to open at. `"auto"` height hugs the content. */
export interface WindowSizeHint {
  width?: number;
  height?: number | "auto";
}

export interface WindowSize {
  width: number;
  height: number | "auto";
}

type Sizes = Record<string, WindowSize>;

function storageKey(scope: string) {
  return NAMES.storage.windowSizes(scope);
}

function load(scope: string): Sizes {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(scope)) ?? "{}") as unknown;
    if (!raw || typeof raw !== "object") return {};
    const out: Sizes = {};
    for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
      const s = v as Partial<WindowSize>;
      if (typeof s?.width !== "number") continue;
      out[key] = {
        width: s.width,
        height: s.height === "auto" || typeof s.height === "number" ? s.height : "auto",
      };
    }
    return out;
  } catch {
    // A corrupt preference is not worth a crash — fall back to the defaults.
    return {};
  }
}

/**
 * One store per scope, created on demand. Debounced on write because a resize
 * drag streams a patch per pointermove, and localStorage is synchronous.
 */
export function createWindowSizes(scope: string) {
  let sizes = load(scope);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();

  const flush = () => {
    if (typeof localStorage === "undefined") return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        localStorage.setItem(storageKey(scope), JSON.stringify(sizes));
      } catch {
        /* quota or private mode — a remembered size is a nicety, not a promise */
      }
    }, 400);
  };

  return {
    /** The size this kind should open at, given its hint and a fallback. */
    resolve(key: string | null, hint?: WindowSizeHint, fallbackWidth = 380): WindowSize {
      const remembered = key ? sizes[key] : undefined;
      if (remembered) return remembered;
      return { width: hint?.width ?? fallbackWidth, height: hint?.height ?? "auto" };
    },
    /** Record what the user dragged this kind to. */
    remember(key: string | null, size: WindowSize) {
      if (!key) return;
      sizes = { ...sizes, [key]: size };
      flush();
      for (const fn of listeners) fn();
    },
    /** Forget this kind, so it re-opens at its hint. */
    forget(key: string | null) {
      if (!key || !(key in sizes)) return;
      const { [key]: _dropped, ...rest } = sizes;
      sizes = rest;
      flush();
      for (const fn of listeners) fn();
    },
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    snapshot: () => sizes,
  };
}

export type WindowSizes = ReturnType<typeof createWindowSizes>;

/** Whether this kind has a size the user set (i.e. "reset" would do something). */
export function useHasRememberedSize(store: WindowSizes, key: string | null): boolean {
  return React.useSyncExternalStore(
    store.subscribe,
    () => (key ? store.snapshot()[key] !== undefined : false),
    () => false,
  );
}
