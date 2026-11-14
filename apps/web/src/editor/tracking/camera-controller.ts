"use client";

import {
  catchShadowsOnGround,
  createCameraTracker,
  makeCameraScene,
  placeTextOnSolvedPoints,
  worldsFollowing,
  resetCameraScene,
  setCameraGround,
  setCameraOrigin,
  setCameraScale,
  setCameraSolve,
  type CameraSolve,
  type DocumentStore,
} from "@solomotion/core";
import { useSession } from "../state/session";
import { toast } from "@/lib/toast";
import { startTrack } from "./track-controller";
import { useCameraPoints } from "./camera-points";

/**
 * The camera solve's actions, each one labelled update (one undo step). The
 * solve itself is an ordinary run (`startTrack` → the analysis worker), so it
 * shares the transport, the activity ring and the strip with region tracks.
 */

/** A camera tracker on this video, solving at once. */
export function solveCameraOf(store: DocumentStore, clipId: string): string | null {
  let id = "";
  store.update("Solve camera", (d) => {
    id = createCameraTracker(d, { clipId })?.id ?? "";
  });
  if (!id) return null;
  useSession.getState().setActiveTracker(id);
  void startTrack(store, id);
  return id;
}

export function patchCameraSolve(store: DocumentStore, trackerId: string, patch: Partial<CameraSolve>): void {
  store.update("Camera solve settings", (d) => setCameraSolve(d, trackerId, patch), { mergeKey: `camera-solve-${trackerId}-${Object.keys(patch).join(",")}` });
}

const picked = (trackerId: string) => {
  const s = useCameraPoints.getState();
  return s.trackerId === trackerId ? s.points : [];
};

/** The picked points are the floor. */
export function groundFromPicked(store: DocumentStore, trackerId: string): void {
  const pts = picked(trackerId);
  let rms: number | null = null;
  store.update("Set ground", (d) => {
    rms = setCameraGround(d, trackerId, pts);
    // A known floor catches the scene's shadows on the plate.
    if (rms !== null) catchShadowsOnGround(d, trackerId);
  });
  if (rms === null) toast.error("Pick three or more points that lie on the floor.");
}

/** The picked point is the world's origin. */
export function originFromPicked(store: DocumentStore, trackerId: string): void {
  const [p] = picked(trackerId);
  if (p === undefined) return;
  store.update("Set origin", (d) => void setCameraOrigin(d, trackerId, p));
}

/** The two picked points are `distance` world units apart (1 unit = 1 cm). */
export function scaleFromPicked(store: DocumentStore, trackerId: string, distance: number): void {
  const [a, b] = picked(trackerId);
  if (a === undefined || b === undefined) return;
  store.update("Set scale", (d) => void setCameraScale(d, trackerId, a, b, distance));
}

export function resetScene(store: DocumentStore, trackerId: string): void {
  store.update("Reset camera scene", (d) => resetCameraScene(d, trackerId));
}

/**
 * MAKE 3D SCENE — the solve becomes a world nested where the footage was
 * (core `makeCameraScene`). Selects the new layer; returns the world's id.
 */
export function makeSceneFrom(store: DocumentStore, trackerId: string): string | null {
  let ids: ReturnType<typeof makeCameraScene> = null;
  store.update("Make 3D scene", (d) => {
    ids = makeCameraScene(d, trackerId);
  });
  const made = ids as ReturnType<typeof makeCameraScene>;
  if (!made) {
    toast.error("Solve the camera first.");
    return null;
  }
  useSession.getState().select([made.nestedId]);
  return made.worldId;
}

/** The world this solve already drives, if any — what "Open in 3D" opens. */
export function sceneOf(doc: Parameters<typeof worldsFollowing>[0], trackerId: string): string | null {
  return worldsFollowing(doc, trackerId)[0] ?? null;
}

/** A text standing on the picked points, in the solve's world (made first if needed). */
export function textOnPicked(store: DocumentStore, trackerId: string): void {
  const pts = picked(trackerId);
  if (!pts.length) return;
  const worldId = sceneOf(store.getState(), trackerId) ?? makeSceneFrom(store, trackerId);
  if (!worldId) return;
  // The world's own clock: the nested world starts where the footage did.
  const doc = store.getState();
  const host = doc.tracks.flatMap((t) => t.clips).find((c) => c.kind === "nested" && c.sourceFrameId === worldId);
  const atMs = Math.max(0, useSession.getState().playheadMs - (host?.startMs ?? 0));
  let id: string | null = null;
  store.update("Text in the shot", (d) => {
    id = placeTextOnSolvedPoints(d, trackerId, worldId, pts, atMs, "Text");
  });
  if (id) useCameraPoints.getState().clear();
}
