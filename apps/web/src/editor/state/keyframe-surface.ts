"use client";

import { useSession } from "./session";

/**
 * The active keyframe surface (curve panel or dope sheet) publishes how to
 * enumerate its currently-VISIBLE keys — so ⌘A honours the very filters the
 * eye sees (a hidden property or a collapsed group is never selected) and can
 * grow the selection in one predictable cycle: the primary clip's keys first,
 * then every shown clip's keys on the next press. One registry, one source of
 * truth, shared by both surfaces.
 */
export interface KeyframeSurfaceInfo {
  /** Visible key ids — `primary` = just the primary clip, `all` = every shown clip. */
  visibleKeyIds(scope: "primary" | "all"): string[];
}

let active: KeyframeSurfaceInfo | null = null;

export function registerKeyframeSurface(surface: KeyframeSurfaceInfo): () => void {
  active = surface;
  return () => {
    if (active === surface) active = null;
  };
}

/**
 * ⌘A inside a keyframe surface. Selects the primary clip's visible keys; a
 * second press (once they're all selected) expands to every visible key across
 * the shown clips. Returns false when there's no surface / nothing visible, so
 * the caller can fall back to selecting clips.
 */
export function selectAllVisibleKeyframes(): boolean {
  if (!active) return false;
  const primary = active.visibleKeyIds("primary");
  const all = active.visibleKeyIds("all");
  if (all.length === 0) return false;
  const cur = new Set(useSession.getState().selectedKeyframeIds);
  const hasAllPrimary = primary.length > 0 && primary.every((id) => cur.has(id));
  const isExactlyPrimary = hasAllPrimary && cur.size === primary.length;
  const next = !hasAllPrimary ? primary : isExactlyPrimary && all.length > primary.length ? all : all;
  useSession.getState().setSelectedKeyframes(next);
  return next.length > 0;
}
