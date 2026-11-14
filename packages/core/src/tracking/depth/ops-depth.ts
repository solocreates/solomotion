import type { MotionDocument } from "../../schema";
import type { DepthMaps, DepthSolve, DepthTracker, TrackSpan } from "../../schema/tracking";
import { createId } from "../../ids";
import { nextTrackerColor } from "../palette";
import { findVisualClip, mergeSpans } from "../ops";

/** DEPTH TRACKER OPS — create one on footage, commit a run, change how it runs. */

function getDepth(doc: MotionDocument, id: string): DepthTracker | null {
  const t = doc.trackers.find((x) => x.id === id);
  return t?.kind === "depth" ? t : null;
}

/** A depth tracker on what `clipId` shows (video or image). Null otherwise. */
export function createDepthTracker(doc: MotionDocument, input: { clipId: string; name?: string; solve?: Partial<DepthSolve> }): DepthTracker | null {
  const clip = findVisualClip(doc, input.clipId);
  if (!clip || (clip.kind !== "video" && clip.kind !== "image")) return null;
  const tracker: DepthTracker = {
    kind: "depth",
    id: createId("tracker"),
    name: input.name ?? "Depth",
    color: nextTrackerColor(doc.trackers.length),
    source: { kind: "asset", assetId: clip.assetId },
    via: clip.id,
    solve: { model: "auto", mapEdge: 512, ...input.solve },
    maps: null,
    analysis: null,
    dirty: true,
  };
  doc.trackers.push(tracker);
  return tracker;
}

/** A run's maps (already in the host's store under `maps.key`) become the tracker's. */
export function commitDepthRun(doc: MotionDocument, id: string, maps: DepthMaps, solved: TrackSpan[]): void {
  const t = getDepth(doc, id);
  if (!t) return;
  t.maps = maps;
  t.analysis = { version: t.analysis?.version ?? 0, engine: maps.model, coverage: mergeSpans(solved), at: Date.now() };
  t.dirty = false;
}

export function setDepthSolve(doc: MotionDocument, id: string, patch: Partial<DepthSolve>): void {
  const t = getDepth(doc, id);
  if (!t) return;
  t.solve = { ...t.solve, ...patch };
  t.dirty = true;
}
