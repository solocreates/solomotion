"use client";

import { exprTypeForProperty, linkPropertyTo, linkPropertyToTrack, propertyDef, propertyPickKey, trackReadingPickKey, type Clip, type DocumentStore } from "@solomotion/core";
import { CLAIM_SLOP_PX, subscribePointerEnd } from "../input/pointer-gestures";
import { beginPickDrag, type PickRequest } from "./pick-mode";

/**
 * THE PICK-WHIP — make this value follow another one. Two steps, one gesture:
 * point at a layer (any surface), then choose which of its values in the menu
 * that opens where you pointed — the field's own path first, so rotation →
 * rotation is a tap and an Enter. A TRACKER is a target too: point at its
 * outline on the stage (or its row) and pick a reading — `x` lands on `x`,
 * `position` on a point — written as `track("tracker:<id>").x`. Only values that can land in this field are
 * offered (`fits`, the checker's own rule). The result is an ordinary
 * expression (core `linkPropertyTo`), so it previews, keys off, exports and
 * undoes like one typed by hand.
 */
export function propertyLinkRequest(opts: {
  store: DocumentStore;
  clip: Clip;
  path: string;
  label: string;
  owner: string;
}): PickRequest {
  const { store, clip, path, label, owner } = opts;
  const def = propertyDef(path);
  const fits = def ? exprTypeForProperty(def) : null;
  // The value itself is the one thing it may not follow.
  const self = propertyPickKey(clip.id, path);
  return {
    owner,
    noun: "layer to follow",
    filter: { kinds: ["layer", "property", "tracker", "track-reading"], frameId: clip.frameId, exclude: [self] },
    refine: (picked) => {
      if (picked.kind === "layer") return { filter: { kinds: ["property"], ofLayers: [picked.id], fits, exclude: [self] }, prefer: propertyPickKey(picked.id, path) };
      if (picked.kind === "tracker") {
        const tracker = picked.id;
        return { filter: { kinds: ["track-reading"], fits, predicate: (c) => c.ownerId === tracker }, prefer: trackReadingPickKey(tracker, path) };
      }
      return null;
    },
    onPick: (c) => {
      if (c.kind === "track-reading" && c.ownerId && c.path) {
        const tracker = c.ownerId;
        const reading = c.path;
        store.update(`Link ${label} to track`, (d) => void linkPropertyToTrack(d, clip.id, path, tracker, reading));
        return;
      }
      const target = c.ownerId;
      const targetPath = c.path;
      if (c.kind !== "property" || !target || !targetPath) return;
      store.update(`Link ${label}`, (d) => void linkPropertyTo(d, clip.id, path, target, targetPath));
    },
  };
}

/**
 * Arm a whip only once a press from this control TRAVELS. A press that stays
 * put keeps its own meaning — the ◆ still keys on a click. Mouse and pen only:
 * a finger dragging across a row is scrolling the panel, and the row's menu
 * (long press → "Link to a layer…") is a finger's way in.
 */
export function whipOnDrag(e: React.PointerEvent, request: () => PickRequest): void {
  if (e.button !== 0 || e.pointerType === "touch") return;
  const id = e.pointerId;
  const x0 = e.clientX;
  const y0 = e.clientY;
  const onMove = (ev: PointerEvent) => {
    const travel = Math.hypot(ev.clientX - x0, ev.clientY - y0);
    if (ev.pointerId !== id || travel <= CLAIM_SLOP_PX) return;
    stop();
    beginPickDrag({ pointerId: id, clientX: x0, clientY: y0, travel }, request());
  };
  const stopEnd = subscribePointerEnd((ended) => ended === id && stop());
  const stop = () => {
    window.removeEventListener("pointermove", onMove, true);
    stopEnd();
  };
  window.addEventListener("pointermove", onMove, true);
}
