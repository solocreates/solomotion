"use client";

import { FORCE, createEmptyClip, emitterCarrierFor, emittersFromLook, emitterLook, frameDurationMs, locateClip, physicsSchema, placeClip, type DocumentStore, type ForceType, type PhysicsSpec, type VisualClip } from "@solomotion/core";
import { useSession } from "../state/session";
import { contentFrameIn } from "../state/clip-actions";
import { toast } from "@/lib/toast";

/**
 * Physics from the menus — the same writes the Physics tab and the agent's
 * verbs make, with the selection and the tab following the result.
 */

/** A force on a new null in the comp you are in, at its centre; selected, the Physics tab open. */
export function addForce(store: DocumentStore, type: ForceType = "wind"): void {
  let id: string | null = null;
  const label = FORCE.def(type)!.label;
  store.update(`Add ${label.toLowerCase()}`, (d) => {
    const frame = contentFrameIn(d);
    const e = createEmptyClip({ frameId: frame.id, startMs: 0, durationMs: frameDurationMs(d, frame), name: label, display: "arrows", size: 60 });
    e.forces = [FORCE.create(type)];
    placeClip(d, e, { landing: "surface" });
    id = e.id;
  });
  const made = id as string | null;
  if (!made) return;
  const s = useSession.getState();
  s.select([made]);
  s.setInspectorTab("physics");
  toast(`${label} added — drag it to place, turn it to aim`);
}

/**
 * Particles in a look on a new null in the comp you are in, placed for the
 * look; selected, the Physics tab open. A look made for a moving layer (a
 * trail, sparks on hit) goes on the ONE selected layer instead, when there is
 * one — a trail on a null that never moves is a blob.
 */
export function addEmitter(store: DocumentStore, lookId: string): void {
  const look = emitterLook(lookId);
  if (!look) return;
  let id: string | null = null;
  const picked = useSession.getState().selectedClipIds;
  let onto: string | null = null;
  store.update(`Add ${look.name.toLowerCase()}`, (d) => {
    const frame = contentFrameIn(d);
    if (frame.world) return;
    const sel = look.carried && picked.length === 1 ? locateClip(d, picked[0]!)?.clip : undefined;
    if (sel && sel.kind !== "audio" && sel.frameId === frame.id) {
      (sel.emitters ??= []).push(...emittersFromLook(look, frame));
      id = onto = sel.id;
      return;
    }
    const place = emitterCarrierFor(look, frame);
    const e = createEmptyClip({ frameId: frame.id, startMs: 0, durationMs: frameDurationMs(d, frame), name: look.name, display: "arrows", size: 60 });
    e.transform = { ...e.transform, x: place.x, y: place.y, rotation: place.rotation, scale: place.scale, scaleY: place.scaleY };
    e.emitters = emittersFromLook(look, frame);
    placeClip(d, e, { landing: "surface" });
    id = e.id;
  });
  const made = id as string | null;
  if (!made) return void toast("Particles live in flat comps for now");
  const s = useSession.getState();
  s.select([made]);
  s.setInspectorTab("physics");
  const carrier = onto as string | null;
  toast(
    carrier
      ? `${look.name} added to ${locateClip(store.getState(), carrier)?.clip.name ?? "the layer"}`
      : look.type === "hit"
        ? `${look.name} on every hit in this comp — select a body first for its hits only`
        : look.carried
          ? `${look.name} added — select a moving layer first to put it there`
          : look.type === "burst"
            ? `${look.name} added — move its clip to time the pop`
            : look.then?.length && look.aim < 0
              ? `${look.name} added — drag the strip to move the launch`
            : `${look.name} added — drag it to place, turn it to aim`,
  );
}

/** Give the layers a body (or take it away), keeping what they had. */
export function setBodies(store: DocumentStore, ids: string[], type: PhysicsSpec["type"] | null): void {
  store.update(type === null ? "No physics" : type === "active" ? "Make it fall" : type === "passive" ? "Make it a collider" : "Make it push", (d) => {
    for (const id of ids) {
      const c = locateClip(d, id)?.clip;
      if (!c || c.kind === "audio" || c.kind === "adjustment" || c.kind === "camera" || c.kind === "light") continue;
      const v = c as VisualClip;
      v.physics = type === null ? undefined : physicsSchema.parse({ ...(v.physics ?? {}), type });
    }
  });
  if (type) useSession.getState().setInspectorTab("physics");
}
