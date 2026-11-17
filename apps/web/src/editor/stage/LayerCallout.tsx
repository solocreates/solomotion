"use client";

import * as React from "react";
import { placeCallout, type CalloutSide, type Rect } from "@solomotion/core";

interface Size {
  width: number;
  height: number;
}

const same = (a: { size: Size; stage: Size }, b: { size: Size; stage: Size }): boolean =>
  Math.abs(a.size.width - b.size.width) < 0.5 &&
  Math.abs(a.size.height - b.size.height) < 0.5 &&
  a.stage.width === b.stage.width &&
  a.stage.height === b.stage.height;
import { cn } from "@/lib/utils";
import { hitAABB, stageHitRects, unionAABB } from "./stage-geometry";
import { useStageCamera } from "../state/session";

/**
 * THE layer callout — a floating surface that belongs to a LAYER, not to the
 * canvas.
 *
 * Docked chrome (`StageChrome`) answers "where am I and what tool is armed".
 * This answers the other question: what can I do to THIS thing, asked right
 * where the thing is — the way a rich-text editor puts bold and italic above
 * the words you highlighted rather than in a panel across the room. A
 * contextual action buried in a strip at the edge of the screen is an action
 * nobody finds, which is what happened to the whole vector toolset when its
 * only door was a right-click.
 *
 * It is deliberately EMPTY. Content is a slot, so this is the one place any
 * per-layer contextual action ever has to learn about positioning:
 *
 *  - anchors to the selection's world box and follows pan and zoom;
 *  - stays a CONSTANT SCREEN SIZE, because it is positioned in screen pixels
 *    and never scaled — a bar that grew with the zoom would be unusable at both
 *    ends of the range;
 *  - picks its side by stage-edge collision through `placeCallout` (core, and
 *    tested): above by default, below or beside near an edge, always clamped
 *    inside the viewport;
 *  - measures itself, so a caller never declares a size it might not have.
 *
 * It renders inside the stage container rather than portalling to the body:
 * the container is `relative` and never clips (the canvas is `inset-0`), so
 * there is nothing to escape from, and staying inside keeps it in the same
 * coordinate space as `stageHitRects` — one less conversion to get wrong.
 */
export function LayerCallout({
  clipIds,
  insets,
  prefer,
  gap,
  className,
  children,
}: {
  /** Anchors to the union of these clips' painted world boxes. */
  clipIds: readonly string[];
  /** Edges eaten by other chrome (the rulers), so it never lands under them. */
  insets?: { top?: number; right?: number; bottom?: number; left?: number };
  prefer?: readonly CalloutSide[];
  gap?: number;
  className?: string;
  children: React.ReactNode;
}) {
  // Pan/zoom moves the anchor, so the callout re-places with the camera —
  // once per frame, in step with the canvas (`useStageCamera`).
  const { scale, tx, ty } = useStageCamera();
  const ref = React.useRef<HTMLDivElement>(null);
  const [box, setBox] = React.useState<{ size: Size; stage: Size } | null>(null);

  // Measure BOTH itself and the stage it sits in, from its own node.
  //
  // The stage is read as `offsetParent` rather than taken as a prop, and that
  // is not a shortcut — a parent's ref is still EMPTY while a child's layout
  // effect runs (React attaches refs bottom-up, children first), so a
  // `containerRef` handed down from the stage measures null forever and the
  // callout never appears. Asking the DOM the question it can actually answer
  // removes the ordering problem instead of racing it.
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const parent = el.offsetParent as HTMLElement | null;
      if (!parent) return;
      const r = el.getBoundingClientRect();
      const next = {
        size: { width: r.width, height: r.height },
        stage: { width: parent.clientWidth, height: parent.clientHeight },
      };
      setBox((prev) => (prev && same(prev, next) ? prev : next));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    const parent = el.offsetParent;
    if (parent) ro.observe(parent);
    return () => ro.disconnect();
  }, [children]);

  const anchor = React.useMemo((): Rect | null => {
    if (clipIds.length === 0) return null;
    const ids = new Set(clipIds);
    // ANY depth: a piece of artwork selected inside a nested comp has a world
    // box now (see `ClipHitRect.depth`), and its actions belong beside it just
    // as much as a top-level layer's do.
    const boxes = stageHitRects.current.filter((h) => ids.has(h.clipId)).map(hitAABB);
    const u = unionAABB(boxes);
    if (!u) return null;
    // World → container screen. The same mapping the canvas paints with, so the
    // callout cannot drift from the layer it is describing.
    return {
      x: tx + u.minX * scale,
      y: ty + u.minY * scale,
      width: (u.maxX - u.minX) * scale,
      height: (u.maxY - u.minY) * scale,
    };
  }, [clipIds, scale, tx, ty]);

  if (!anchor) return null;

  const top = insets?.top ?? 0;
  const left = insets?.left ?? 0;
  const placement = box
    ? placeCallout({
        anchor,
        size: box.size,
        viewport: {
          x: left,
          y: top,
          width: box.stage.width - left - (insets?.right ?? 0),
          height: box.stage.height - top - (insets?.bottom ?? 0),
        },
        prefer,
        gap,
      })
    : // First paint: park it off-screen to be measured rather than flashing it
      // in the wrong place, which is the classic anchored-popover jump.
      { side: "top" as const, x: -9999, y: -9999, fits: false };

  return (
    <div
      ref={ref}
      data-stage-chrome
      data-callout-side={placement.side}
      className={cn("pointer-events-auto absolute z-30 w-max", className)}
      style={{ left: placement.x, top: placement.y }}
      // The callout is chrome, not canvas: a press on it must never start a
      // marquee or deselect the very layer it is acting on.
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}
