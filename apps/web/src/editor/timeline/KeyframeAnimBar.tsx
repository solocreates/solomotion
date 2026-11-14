"use client";

import * as React from "react";
import type { Clip } from "@solomotion/core";
import { useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import {
  animAbsToPx,
  beginKeyframeTransform,
  clipAnimSpan,
  type AnimTransformMode,
} from "./keyframe-transform";

/**
 * The draggable animation "clip" — a capsule over a layer's keyframes. Its
 * body slides the whole animation; the two edge grips scale it (stretch =
 * slower, squash = faster) about the far edge, so you can make a move take
 * longer or snappier in one gesture. With a keyframe selection it spans (and
 * transforms) just the selected keys, across every clip that owns some; with
 * none it owns the clip's whole animation. Rendered identically in the dope
 * sheet (on each clip's header row) and the curve panel (a strip up top) —
 * one component, one gesture brain.
 *
 * Grips flank JUST OUTSIDE the first/last key so they never fight the diamonds
 * sitting on those times. Placed by the caller via `top`/`height` inside a
 * position:relative container.
 */

const GRIP_W = 7;
/** Clearance so the grips flank OUTSIDE the end diamonds, never fighting them. */
const GRIP_GAP = 5;

export function KeyframeAnimBar({
  clips,
  clip,
  pxPerSec,
  top,
  height,
}: {
  /** Every clip the surface shows — the group a selection-driven scale spans. */
  clips: Clip[];
  clip: Clip;
  pxPerSec: number;
  top: number;
  height: number;
}) {
  const store = useDocStore();
  const selectedIds = useSession((s) => s.selectedKeyframeIds);
  const selected = React.useMemo(() => new Set(selectedIds), [selectedIds]);

  const span = clipAnimSpan(clip, selected);
  if (!span || span.endMs <= span.startMs) return null; // need a real span to move/scale

  const left = animAbsToPx(span.startMs, pxPerSec);
  const right = animAbsToPx(span.endMs, pxPerSec);
  const width = Math.max(2, right - left);
  const begin = (mode: AnimTransformMode) => (e: React.PointerEvent) =>
    beginKeyframeTransform({ e, store, pxPerSec, clips, grabbedClipId: clip.id, mode });

  return (
    <>
      <div
        title="Drag to move the whole animation"
        onPointerDown={begin("move")}
        className="absolute cursor-grab rounded-[3px] border border-primary/30 bg-primary/10 transition-colors hover:bg-primary/20 active:cursor-grabbing"
        style={{ left, width, top, height }}
      />
      <div
        title="Drag to stretch or squash the whole animation"
        onPointerDown={begin("scale-start")}
        className="absolute z-20 cursor-ew-resize rounded-l-sm bg-primary/50 transition-colors hover:bg-primary"
        style={{ left: left - GRIP_W - GRIP_GAP, width: GRIP_W, top, height }}
      />
      <div
        title="Drag to stretch or squash the whole animation"
        onPointerDown={begin("scale-end")}
        className="absolute z-20 cursor-ew-resize rounded-r-sm bg-primary/50 transition-colors hover:bg-primary"
        style={{ left: right + GRIP_GAP, width: GRIP_W, top, height }}
      />
    </>
  );
}
