"use client";

import { create } from "zustand";
import type { Contour, DocumentStore, TrackShape } from "@solomotion/core";
import { toast } from "@/lib/toast";
import { useSession, type Tool } from "../state/session";

/**
 * "THE NEXT SHAPE YOU DRAW IS A REGION" — one seam for every outline the app
 * asks you to draw over footage: a grade's power window, a tracker.
 *
 * Both used to be the same idea written once: the shape buttons ARM THE APP'S
 * OWN TOOL (rect, ellipse, polygon, pen) and leave a target behind, and the two
 * places that finish a drawing hand their geometry here instead of making a
 * layer. So a tracker is drawn with the real pen — snapping, ⇧-constrain, node
 * editing and all — exactly as a window is. A new kind of region is one
 * `registerRegionConsumer`, never a third creator seam.
 *
 * The target is SESSION state and ONE-SHOT: you armed a mode, and a mode that
 * survives the thing it was for is a trap. Putting the tool down disarms it.
 */

export type RegionDrawTarget =
  | { kind: "window"; clipId: string; cardId: string; nodeId: string; shape: TrackShape }
  | { kind: "tracker"; clipId: string; shape: TrackShape };

type Consumer<K extends RegionDrawTarget["kind"]> = (
  store: DocumentStore,
  target: Extract<RegionDrawTarget, { kind: K }>,
  /** Centred on their own bounds, frame units. */
  contours: Contour[],
  /** Where that centre sits, FRAME (centre-local) space. */
  centre: { x: number; y: number },
) => void;

const consumers = new Map<string, Consumer<RegionDrawTarget["kind"]>>();

export function registerRegionConsumer<K extends RegionDrawTarget["kind"]>(kind: K, consume: Consumer<K>): void {
  consumers.set(kind, consume as unknown as Consumer<RegionDrawTarget["kind"]>);
}

export const useRegionDraw = create<{ target: RegionDrawTarget | null }>(() => ({ target: null }));

const TOOL_FOR: Record<TrackShape, Tool> = { path: "pen", polygon: "polygon", rect: "rect", ellipse: "ellipse" };

let disarm: (() => void) | null = null;
let prompt: ReturnType<typeof toast.message> | null = null;

/** Arm a region draw: leave the target and pick up the matching tool. */
export function beginRegionDraw(target: RegionDrawTarget): void {
  endRegionDraw();
  const tool = TOOL_FOR[target.shape];
  useRegionDraw.setState({ target });
  useSession.getState().setTool(tool);
  // Putting the tool down is "never mind".
  disarm = useSession.subscribe((s) => {
    if (s.tool !== tool) endRegionDraw();
  });
  const noun = target.kind === "tracker" ? "what to track" : "the window";
  prompt = toast.message(target.shape === "path" ? `Outline ${noun} — click to place points, close it to finish` : `Drag over ${noun}`);
}

export function endRegionDraw(): void {
  disarm?.();
  disarm = null;
  // The instruction goes with the mode it described.
  if (prompt !== null) toast.dismiss(prompt);
  prompt = null;
  if (useRegionDraw.getState().target) useRegionDraw.setState({ target: null });
}

/**
 * Take a finished drawing if one was asked for. Returns true when it was
 * consumed — the caller must then NOT create a layer.
 */
export function consumeRegionDraw(store: DocumentStore, contours: Contour[], centre: { x: number; y: number }): boolean {
  const target = useRegionDraw.getState().target;
  const consume = target ? consumers.get(target.kind) : undefined;
  if (!target || !consume) return false;
  endRegionDraw();
  // A matte is an area: an open outline is closed on the way in.
  consume(store, target, contours.map((c) => ({ ...c, closed: true })), centre);
  useSession.getState().setTool("select");
  return true;
}
