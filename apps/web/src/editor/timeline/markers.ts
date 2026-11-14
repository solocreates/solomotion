"use client";

import { compFps, createId, frameStepMs, type DocumentStore } from "@solomotion/core";
import { useSession } from "../state/session";

/**
 * Marker actions shared by the M shortcut, the toolbar button and the ruler.
 * One marker per moment: adding where one already stands (within half a frame)
 * selects the existing pin instead of stacking another on top of it.
 */

export const DEFAULT_MARKER_COLOR = "#5B9CF6";

export function addMarkerAtPlayhead(store: DocumentStore): string | null {
  const session = useSession.getState();
  if (!session.markersEnabled) session.setMarkersEnabled(true);
  const doc = store.getState();
  const compId = session.activeFrameId ?? doc.frames[0]?.id;
  if (!compId) return null;
  const t = Math.round(session.playheadMs);
  const half = frameStepMs(compFps(doc, compId)) / 2;
  const existing = doc.markers.find((m) => m.frameId === compId && Math.abs(m.timeMs - t) <= half);
  if (existing) {
    session.setSelectedMarkers([existing.id]);
    return existing.id;
  }
  const id = createId("marker");
  store.update("Add marker", (d) => {
    d.markers.push({ id, frameId: compId, timeMs: t, name: "", color: DEFAULT_MARKER_COLOR, groupId: null });
  });
  session.setSelectedMarkers([id]);
  return id;
}

export function deleteMarkers(store: DocumentStore, ids: string[]): void {
  if (ids.length === 0) return;
  const set = new Set(ids);
  store.update(ids.length > 1 ? `Delete ${ids.length} markers` : "Delete marker", (d) => {
    d.markers = d.markers.filter((m) => !set.has(m.id));
  });
  useSession.getState().setSelectedMarkers([]);
}
