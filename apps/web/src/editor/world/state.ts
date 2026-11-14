"use client";

import * as React from "react";
import { create } from "zustand";
import { EMPTY_SELECTION, type ElementMode, type Falloff, type MeshSelection, type ShadingMode, type V3 } from "@solomotion/core";
import { useSession } from "../state/session";
import { useDoc } from "../state/document-context";
import type { WorldMode, WorldTool } from "./tools";

/**
 * THE VIEWPORT'S SESSION — what a 3D view is doing, never what the world IS.
 *
 * The selection of OBJECTS is the app's own (`session.selectedClipIds`), so
 * the layers panel, the inspector and the timeline follow a click in 3D with
 * nothing to sync. What lives here is what only a viewport has: edit mode and
 * its element selection, the active tool, the 3D cursor, shading, and which
 * root world artboard was opened from the board.
 */

export { strokeToolOf, type StrokeTool, type WorldMode, type WorldTool } from "./tools";

export type PivotMode = "median" | "origins" | "cursor" | "active";

export interface WorldUi {
  /** A ROOT world artboard opened from the board (nested worlds open by navigation). */
  openId: string | null;
  /** What you are working ON (`tools.ts`): objects, a shape's polygons, its surface, marks in space. */
  mode: WorldMode;
  /** The object Edit and Sculpt work on — the one you entered them with. */
  editClipId: string | null;
  elementMode: ElementMode;
  elementSel: MeshSelection;
  tool: WorldTool;
  /** What the Shape tool places (a primitive id). */
  shape: string;
  pivot: PivotMode;
  orientation: "global" | "local";
  snap: boolean;
  /** Proportional editing (O): neighbours of the selection follow it, by falloff. */
  proportional: boolean;
  propRadius: number;
  propFalloff: Falloff;
  cursor: V3;
  shading: ShadingMode;
  xray: boolean;
  /**
   * X-ray while the Bone tool is armed (Characters 3.0): bones live INSIDE the
   * mesh, so building them through solid skin is building blind. On by
   * default; its own switch, so turning it off sticks for the Bone tool alone.
   */
  boneXray: boolean;
  overlays: boolean;
  /** Where selected animated objects travel, drawn through space with their keys (After Effects' motion paths). */
  motionPaths: boolean;
  grid: boolean;
  gridSize: number;
  gridDivisions: number;
  throughCamera: boolean;
  /**
   * WHICH camera "look through" looks through — the camera you last picked
   * (Layers, timeline, the viewport), or null for the one rendering now. A
   * viewport choice, never the document's: picking a camera to look through
   * must not restack anything. Stale ids fall back to the live camera.
   */
  viewCameraId: string | null;
  lockCamera: boolean;
  localHidden: string[];
  /** The modal operator's header line ("D: 120 along X"), shown while it runs. */
  hud: string | null;
  /**
   * "Open this layer's own editor" from OUTSIDE the viewport — the timeline's
   * double-click, the layer menu's top item, the Layers list. The viewport
   * answers it (its points, its polygons, its crop, its words) the moment it
   * is mounted, so a request made while the world is still opening lands too.
   */
  editRequest: string | null;
  set(patch: Partial<WorldUi>): void;
}

export const useWorldUi = create<WorldUi>((set) => ({
  openId: null,
  mode: "object",
  editClipId: null,
  elementMode: "vertex",
  elementSel: EMPTY_SELECTION,
  tool: "select",
  shape: "cube",
  pivot: "median",
  orientation: "global",
  snap: false,
  proportional: false,
  propRadius: 200,
  propFalloff: "smooth",
  cursor: [0, 0, 0],
  shading: "solid",
  xray: false,
  boneXray: true,
  overlays: true,
  motionPaths: true,
  grid: true,
  gridSize: 100,
  gridDivisions: 10,
  throughCamera: false,
  viewCameraId: null,
  lockCamera: false,
  localHidden: [],
  hud: null,
  editRequest: null,
  set: (patch) => set(patch),
}));

/**
 * Which world comp the centre stage shows as a 3D viewport, or null for the 2D
 * stage. A world opens when you are INSIDE it: reached through a nested clip,
 * or a root world artboard you double-clicked. Derived each time — the open id
 * is only consulted while that very frame is the one you are standing in, so a
 * stale value can never show the wrong world.
 */
export function useWorldViewportFrame(): string | null {
  const doc = useDoc();
  const activeFrameId = useSession((s) => s.activeFrameId);
  const hops = useSession((s) => s.nav.path.hops.length);
  const openId = useWorldUi((s) => s.openId);
  return React.useMemo(() => {
    const frame = doc.frames.find((f) => f.id === activeFrameId);
    if (!frame?.world) return null;
    return hops > 0 || openId === frame.id ? frame.id : null;
  }, [doc.frames, activeFrameId, hops, openId]);
}

/**
 * An object's extent in its own space as the open viewport MEASURED it — a
 * body's real geometry (glyphs, a silhouette), which only the engine knows.
 * Null when no viewport is open or it has not built that object.
 */
export function measuredBounds(clipId: string): { min: [number, number, number]; max: [number, number, number] } | null {
  return boundsReader?.(clipId) ?? null;
}
let boundsReader: ((clipId: string) => { min: [number, number, number]; max: [number, number, number] } | null) | null = null;
export function setMeasuredBoundsReader(fn: typeof boundsReader): void {
  boundsReader = fn;
}

/** Is a world viewport on screen right now? (Non-React readers: the shortcut layer.) */
export function worldViewportOpen(): boolean {
  return viewportMounted > 0;
}
let viewportMounted = 0;
export function markViewportMounted(on: boolean): void {
  viewportMounted += on ? 1 : -1;
}

/** Step out of the world: back to the parent comp, or back to the board. */
export function exitWorldViewport(): void {
  const ui = useWorldUi.getState();
  if (ui.mode === "edit") {
    ui.set({ mode: "object", editClipId: null, elementSel: EMPTY_SELECTION });
    return;
  }
  const session = useSession.getState();
  if (session.nav.path.hops.length > 0) session.exitContext();
  else {
    // Back on the board the world is an artboard again: select IT, so nothing
    // draws 2D handles for a 3D object that only has meaning inside.
    const id = ui.openId;
    ui.set({ openId: null });
    if (id) session.selectFrame(id);
  }
}

/** Is X-ray on now: the switch, or the Bone tool's own (see `boneXray`). */
export function xrayOn(ui: Pick<WorldUi, "xray" | "boneXray" | "tool">): boolean {
  return ui.xray || (ui.tool === "bone" && ui.boneXray);
}
