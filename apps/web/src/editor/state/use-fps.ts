"use client";

import * as React from "react";
import { DEFAULT_FPS, compFps, frameStepMs, snapMsToFrame } from "@solomotion/core";
import { useDoc, peekDoc } from "./document-context";
import { useSession } from "./session";
import { activeCompId } from "../timeline/timeline-utils";

/**
 * "What rate is the comp I'm editing running at?" — the ONE question every
 * editing surface has to ask, and the one it used to get wrong.
 *
 * Before v48 the timeline ruler, the curve and dope-sheet grids, the ⇦/⇨
 * frame-step shortcuts, marker snapping and the motion-path dots all read the
 * document's global rate, while the exporter and the flipbook read the frame's.
 * Open a 12fps sheet and the ruler still ticked at 30: stepping "one frame"
 * moved you a third of a frame, and snapping put keys between the drawings
 * they were supposed to land on. There is no document rate any more, so the
 * only way to be wrong now is to not ask — hence this hook, and hence
 * `peekEditingFps` for the headless dispatchers that have no hooks.
 *
 * Resolution goes through `activeCompId`, so a drilled-into COMPONENT INSTANCE
 * answers with its definition's rate (one component, one timeline, one grid)
 * and a cell you've opened inside a flipbook answers with the cell's own.
 */
export function useEditingFps(): number {
  const doc = useDoc();
  const activeFrameId = useSession((s) => s.activeFrameId);
  return React.useMemo(() => compFps(doc, activeCompId(doc, activeFrameId)), [doc, activeFrameId]);
}

/**
 * The editing rate, read imperatively. For the keyboard dispatcher and other
 * headless paths that run outside React; identical resolution to the hook.
 * Falls back to the core default only when there is no document yet.
 */
export function peekEditingFps(): number {
  const doc = peekDoc();
  if (!doc) return DEFAULT_FPS;
  return compFps(doc, activeCompId(doc, useSession.getState().activeFrameId));
}

/** The editing comp's frame duration in ms — its grid unit. */
export function useEditingFrameStepMs(): number {
  return frameStepMs(useEditingFps());
}

/**
 * Snap a time onto the editing comp's grid. Handed out as a stable callback so
 * gesture code can depend on it without re-subscribing every render.
 */
export function useSnapToFrame(): (ms: number) => number {
  const fps = useEditingFps();
  return React.useCallback((ms: number) => snapMsToFrame(ms, fps), [fps]);
}
