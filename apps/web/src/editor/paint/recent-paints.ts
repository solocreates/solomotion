"use client";

import type { Paint } from "@solomotion/core";
import { shelfKindOf, type ShelfKind } from "./paint-kind";

/**
 * Recently used fills, per kind.
 *
 * Recents used to be a list of hex strings owned by the colour picker, which
 * meant a gradient or a pattern you had just spent two minutes dialling was
 * gone the moment you clicked away — the one thing in the panel most worth
 * getting back was the one thing not kept. A recent is a PAINT now, so all
 * three kinds are remembered by the same list and shown in the same place.
 *
 * Device-scoped and best-effort: recents are a nicety, and a browser that
 * refuses localStorage should lose them silently rather than fail a fill.
 */

const KEY = "tm-recent-paints";
const LIMIT = 24;

/** Everything that makes two paints "the same" for recency — deliberately not
 *  the entry id, opacity or blend, which belong to the slot it came from. */
function signature(paint: Paint): string {
  const { id: _id, opacity: _o, blendMode: _b, enabled: _e, ...look } = paint as Paint & Record<string, unknown>;
  return JSON.stringify(look);
}

function read(): Paint[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as Paint[]) : [];
  } catch {
    return [];
  }
}

const listeners = new Set<() => void>();
let cache: Paint[] | null = null;

/**
 * The per-kind views, cached.
 *
 * `useSyncExternalStore` compares snapshots by IDENTITY, so a getter that
 * filtered on every call would hand React a new array each render and spin
 * forever. Filtering once per write is also simply cheaper, and the whole cache
 * is dropped the moment the list changes.
 */
const views = new Map<ShelfKind, Paint[]>();

/** Recents of one kind, newest first. Referentially stable between writes. */
export function recentPaints(kind: ShelfKind): Paint[] {
  const cached = views.get(kind);
  if (cached) return cached;
  cache ??= read();
  const view = cache.filter((p) => shelfKindOf(p) === kind);
  views.set(kind, view);
  return view;
}

/** Remember a fill. A no-op for a paint that is already the most recent, so
 *  dragging a colour slider does not fill the list with one colour's history. */
export function pushRecentPaint(paint: Paint): void {
  if (typeof window === "undefined") return;
  // A style REFERENCE is not a look — it lives in the library already, and
  // recording it here would list the same thing twice under two names.
  if (paint.type === "variable" || paint.type === "media") return;
  const sig = signature(paint);
  const current = cache ?? read();
  if (current[0] && signature(current[0]) === sig) return;
  const next = [structuredClone(paint), ...current.filter((p) => signature(p) !== sig)].slice(0, LIMIT);
  cache = next;
  views.clear();
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Recents are a nicety, not a requirement.
  }
  for (const cb of listeners) cb();
}

export function subscribeRecentPaints(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}
