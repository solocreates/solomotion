import type { Clip } from "../schema";

/**
 * Does this layer focus on its ANCHOR rather than its painted bounds (D16)?
 *
 * An emitter's bounds are its particles — empty before the first one is born,
 * the whole comp a second later, different on every frame. A rigid body's are
 * wherever the simulation flung it this frame; a force carrier's are a gizmo.
 * Framing any of those is framing noise: the camera either never moves (the
 * cloud is "visible") or lurches every time the selection is touched. Their
 * anchor — where the layer IS placed — is stable, so that is what focus uses.
 */
export function focusAnchorOf(clip: Pick<Clip, never> & { emitters?: unknown[]; physics?: unknown; forces?: unknown[] }): boolean {
  return (clip.emitters?.length ?? 0) > 0 || clip.physics != null || (clip.forces?.length ?? 0) > 0;
}
