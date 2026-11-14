"use client";

import * as React from "react";
import type { MotionDocument, Frame, VisualClip } from "@solomotion/core";
import { lazyComponent } from "@/editor/lazy-component";
import { useDocSelector } from "../state/document-context";

/**
 * PHYSICS, LOADED WHEN IT IS USED. The Physics tab's sections, the particle
 * stack and the canvas overlay are their own chunks: an editor that never
 * opens the tab, in a document with nothing that simulates, never fetches
 * them. One place, so every surface that shows a physics section reaches it
 * the same way.
 */

const Sections = {
  body: lazyComponent("BodySection", () => import("./PhysicsSections").then((m) => ({ default: m.BodySection }))),
  joints: lazyComponent("JointsSection", () => import("./PhysicsSections").then((m) => ({ default: m.JointsSection }))),
  simulation: lazyComponent("SimulationSection", () => import("./PhysicsSections").then((m) => ({ default: m.SimulationSection }))),
  forces: lazyComponent("ForceStackSection", () => import("./ForceStack").then((m) => ({ default: m.ForceStackSection }))),
  emitters: lazyComponent("EmitterStackSection", () => import("./EmitterStack").then((m) => ({ default: m.EmitterStackSection }))),
};
const Overlay = lazyComponent("PhysicsOverlay", () => import("./PhysicsOverlay").then((m) => ({ default: m.PhysicsOverlay })));

export const BodySection = (p: { clips: VisualClip[] }) => <React.Suspense fallback={null}><Sections.body {...p} /></React.Suspense>;
export const JointsSection = (p: { clip: VisualClip }) => <React.Suspense fallback={null}><Sections.joints {...p} /></React.Suspense>;
export const SimulationSection = (p: { frame: Frame }) => <React.Suspense fallback={null}><Sections.simulation {...p} /></React.Suspense>;
export const ForceStackSection = (p: { clips: VisualClip[] }) => <React.Suspense fallback={null}><Sections.forces {...p} /></React.Suspense>;
export const EmitterStackSection = (p: { clips: VisualClip[] }) => <React.Suspense fallback={null}><Sections.emitters {...p} /></React.Suspense>;

/** Does anything in the document draw a physics guide — a body, a force, a joint, particles, or a null's crosshair? */
function wantsOverlay(doc: MotionDocument): boolean {
  return doc.tracks.some((t) => t.clips.some((c) => c.kind === "empty" || (c.kind !== "audio" && (!!(c as VisualClip).physics || !!c.forces?.length || !!c.emitters?.length || !!c.joints?.length))));
}

/** The canvas's physics guides — mounted (and fetched) only once the document has something to show. */
export function PhysicsOverlayHost() {
  const wants = useDocSelector(wantsOverlay);
  if (!wants) return null;
  return (
    <React.Suspense fallback={null}>
      <Overlay />
    </React.Suspense>
  );
}
