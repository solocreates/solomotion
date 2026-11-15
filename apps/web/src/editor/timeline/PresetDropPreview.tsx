"use client";

import * as React from "react";
import { describePresetDrop, resolvePresetDrop, type Track } from "@solomotion/core";
import { cn } from "@/lib/utils";
import { useSession, type LibraryDrag } from "../state/session";
import { timeToPx } from "./timeline-utils";

/**
 * How close the pointer must come to a cut for a dragged transition to claim
 * it. Shared by the preview and the drop itself, so the ghost can never promise
 * a target the drop then refuses.
 */
export const PRESET_DROP_TOLERANCE_PX = 28;

/** The preset family a library drag belongs to, or null if it is neither. */
export function dragPresetKind(drag: LibraryDrag): "animation" | "transition" | null {
  if (!drag) return null;
  if (drag.kind === "transition") return "transition";
  if (drag.kind === "anim") return "animation";
  return null;
}

/**
 * Live preview while a PRESET is dragged over the timeline — one component for
 * both families, because the question is the same one: which span on this lane
 * am I about to change?
 *
 * A transition highlights the cut it would claim (a shared seam spanning two
 * clips, or a lone clip edge); an animation highlights the half of the clip it
 * would land on, in or out. Both are drawn from the same resolver that commits
 * the drop, so what is shown is literally what will happen — which is the
 * difference between a drop that feels aimed and one that feels like a guess.
 */
export function PresetDropPreview({
  track,
  frameId,
  pxPerSec,
}: {
  track: Track;
  frameId: string;
  pxPerSec: number;
}) {
  const drag = useSession((s) => s.libraryDrag);
  const pos = useSession((s) => s.libraryDragPos);
  const anchorRef = React.useRef<HTMLDivElement>(null);

  const kind = dragPresetKind(drag);
  const active = kind !== null && pos?.over === "timeline";

  // The lane's own box, read during render rather than parked in state. A
  // `setRect` effect ran a SECOND render pass per lane on every pointer frame
  // and drew the preview one frame stale — the lane scrolls and zooms mid-drag,
  // so the rect is not a value to remember, it is a measurement to take. This
  // component only renders at all while a drag is live.
  const rect = active ? (anchorRef.current?.getBoundingClientRect() ?? null) : null;

  const preview = React.useMemo(() => {
    if (!active || !drag || !kind || !pos || !rect) return null;
    // Only the lane actually under the pointer previews — otherwise every lane
    // would light up its nearest target at once.
    if (pos.y < rect.top || pos.y > rect.bottom) return null;
    const timeMs = ((pos.x - rect.left) / pxPerSec) * 1000;
    const tolerance = (PRESET_DROP_TOLERANCE_PX / pxPerSec) * 1000;
    const target = resolvePresetDrop(track, frameId, timeMs, { kind, id: drag.id }, tolerance);
    if (!target) return null;
    return { target, label: describePresetDrop(target, drag.label) };
  }, [active, drag, kind, pos, rect, track, frameId, pxPerSec]);

  return (
    <>
      <div ref={anchorRef} className="pointer-events-none absolute inset-0" />
      {preview && (
        <div
          className={cn(
            "pointer-events-none absolute top-1 bottom-1 z-30 flex items-center justify-center overflow-hidden rounded-md border-2 border-dashed",
            preview.target.replaces ? "border-warning" : "border-primary",
            // An animation previews as the RAMP it becomes — the same shading
            // the committed zone draws on the clip, falling off away from the
            // edge it attaches to — while a transition previews as the solid
            // band that straddles its cut. Each looks like its own result.
            preview.target.kind === "animation"
              ? preview.target.edge === "in"
                ? "bg-linear-to-r from-primary/45 to-primary/5"
                : "bg-linear-to-l from-primary/45 to-primary/5"
              : "bg-primary/15",
          )}
          style={{
            left: timeToPx(preview.target.startMs, pxPerSec),
            width: Math.max(10, timeToPx(preview.target.endMs - preview.target.startMs, pxPerSec)),
          }}
        >
          <span className="truncate px-1 text-[10px] font-medium text-primary">{preview.label}</span>
        </div>
      )}
    </>
  );
}
