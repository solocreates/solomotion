"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { claimPointer, subscribePointerEnd } from "../input/pointer-gestures";
import { capturePointer } from "../input/capture-pointer";
import { DRAG_SURFACE } from "../input/use-multi-touch";
import { useSession } from "../state/session";
import type { ViewAxis } from "./view-axis";
import { centredAt, dragWindow, shownExtent, thumbRect, type AxisWindow, type BarGrip } from "./zoom-bar";

/** Narrowest the thumb draws — both end handles must stay grabbable. */
const MIN_THUMB_PX = 28;

export interface ZoomBarMarker {
  start: number;
  /** A span; omitted = a tick. */
  size?: number;
}

/**
 * THE ZOOM BAR — one control for one axis of any panel: a scrollbar whose
 * thumb IS the visible window.
 *
 *   drag the thumb        pan
 *   drag a round end      zoom, the other end held still — the end stays
 *                         under the cursor the whole way (see `zoom-bar.ts`)
 *   double-click          fit everything
 *   click the track       jump there, keep holding to drag from there
 *
 * Markers show what you are working on — the selected clips' span or track —
 * and `playhead` adds the accent tick on a time axis, so both stay findable
 * however far you zoom. `background` paints under the thumb: the timeline's
 * minimap is the rows bar with a picture behind it, not a second control.
 *
 * Layout is IMPERATIVE: the thumb and the playhead are positioned from the
 * axis's change signal, never by a React render, so playback and scroll-follow
 * cost the bar nothing.
 */
export function ZoomBar({
  axis,
  orientation,
  markers,
  playhead,
  background,
  wide,
  label,
  className,
  style,
  onFit,
}: {
  axis: ViewAxis;
  orientation: "x" | "y";
  markers?: readonly ZoomBarMarker[];
  playhead?: boolean;
  /** Painted under the thumb, given the extent the bar currently stands for. */
  background?: (extent: number) => React.ReactNode;
  /** A thick bar (the minimap): the thumb is a window frame, not a pill. */
  wide?: boolean;
  label: string;
  className?: string;
  style?: React.CSSProperties;
  /** Double-click. Defaults to showing the whole extent. */
  onFit?: () => void;
}) {
  const vertical = orientation === "y";
  const trackRef = React.useRef<HTMLDivElement>(null);
  const thumbRef = React.useRef<HTMLDivElement>(null);
  const tickRef = React.useRef<HTMLDivElement>(null);
  const chipRef = React.useRef<HTMLSpanElement>(null);
  const [grip, setGrip] = React.useState<BarGrip | null>(null);
  /** The extent markers and the background are laid out against (rarely changes). */
  const [extent, setExtent] = React.useState(0);
  const frozen = React.useRef<number | null>(null);
  const lastW = React.useRef<AxisWindow | null>(null);
  const extentRef = React.useRef(0);

  const barPx = React.useCallback(() => {
    const el = trackRef.current;
    return el ? (vertical ? el.clientHeight : el.clientWidth) : 0;
  }, [vertical]);

  const placePlayhead = React.useCallback(() => {
    const el = tickRef.current;
    const e = extentRef.current;
    if (!el || e <= 0) return;
    const at = (useSession.getState().playheadMs / e) * barPx();
    el.style.transform = vertical ? `translateY(${at}px)` : `translateX(${at}px)`;
  }, [vertical, barPx]);

  const layout = React.useCallback(() => {
    const w = axis.read();
    const thumb = thumbRef.current;
    const track = trackRef.current;
    // A bar with no room (its panel squeezed shut) draws nothing — its handles
    // and chip sit outside the thumb and would otherwise float over neighbours.
    if (track) track.style.visibility = barPx() < 24 ? "hidden" : "";
    if (!w || !thumb) return;
    lastW.current = w;
    const e = frozen.current ?? shownExtent(w);
    if (Math.abs(e - extentRef.current) > extentRef.current * 0.002) {
      extentRef.current = e;
      setExtent(e);
    }
    const r = thumbRect(w.start, w.size, e, barPx(), wide ? 12 : MIN_THUMB_PX);
    if (vertical) {
      thumb.style.top = `${r.left}px`;
      thumb.style.height = `${r.width}px`;
    } else {
      thumb.style.left = `${r.left}px`;
      thumb.style.width = `${r.width}px`;
    }
    if (chipRef.current && axis.format) chipRef.current.textContent = axis.format(w);
    placePlayhead();
  }, [axis, vertical, wide, placePlayhead, barPx]);

  React.useLayoutEffect(() => {
    const unsub = axis.subscribe(layout);
    const ro = new ResizeObserver(layout);
    if (trackRef.current) ro.observe(trackRef.current);
    layout();
    return () => {
      unsub();
      ro.disconnect();
    };
  }, [axis, layout]);

  React.useEffect(() => {
    if (!playhead) return;
    let last = useSession.getState().playheadMs;
    placePlayhead();
    return useSession.subscribe((s) => {
      if (s.playheadMs !== last) {
        last = s.playheadMs;
        placePlayhead();
      }
    });
  }, [playhead, placePlayhead]);

  const unitAt = (client: number, e: number) => {
    const el = trackRef.current!;
    const rect = el.getBoundingClientRect();
    const px = barPx();
    return px > 0 ? ((client - (vertical ? rect.top : rect.left)) / px) * e : 0;
  };

  const begin = (g: BarGrip, ev: React.PointerEvent, from?: AxisWindow) => {
    if (ev.button !== 0) return;
    const w0 = from ?? lastW.current ?? axis.read();
    if (!w0) return;
    ev.preventDefault();
    ev.stopPropagation();
    claimPointer(ev.pointerId, "drag");
    capturePointer(ev.currentTarget, ev.pointerId);
    const e0 = shownExtent(w0);
    frozen.current = e0;
    const client0 = vertical ? ev.clientY : ev.clientX;
    // The grab offset: the pointer's distance from the edge it took, so that
    // edge — not the pointer — is what tracks the motion. Without it a press a
    // few pixels inside a handle would snap the edge to the pointer.
    const edge = g === "end" ? w0.start + w0.size : w0.start;
    const offset = unitAt(client0, e0) - edge;
    setGrip(g);
    const move = (m: PointerEvent) => {
      if (m.pointerId !== ev.pointerId) return;
      const next = dragWindow(g, w0, e0, unitAt(vertical ? m.clientY : m.clientX, e0) - offset);
      if (g === "body" || !axis.zoomable) axis.scrollTo(next.start);
      else axis.show(next.start, next.size, g === "start" ? "end" : "start");
    };
    const key = (k: KeyboardEvent) => k.key === "Escape" && end();
    const unsub = subscribePointerEnd((id) => id === ev.pointerId && end());
    function up(u: PointerEvent) {
      if (u.pointerId === ev.pointerId) end();
    }
    function end() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", key);
      unsub();
      frozen.current = null;
      setGrip(null);
      layout();
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", key);
  };

  const onTrackDown = (ev: React.PointerEvent) => {
    const w = lastW.current ?? axis.read();
    if (!w || ev.button !== 0) return;
    const start = centredAt(w, unitAt(vertical ? ev.clientY : ev.clientX, shownExtent(w)));
    axis.scrollTo(start);
    begin("body", ev, { ...w, start });
  };

  const fit = () => {
    if (onFit) return onFit();
    const w = axis.read();
    if (w) axis.show(0, Math.min(w.maxSize, Math.max(w.minSize, w.extent)), "start");
  };

  const zooming = grip === "start" || grip === "end";
  const pct = (v: number) => `${extent > 0 ? (v / extent) * 100 : 0}%`;
  const handle = cn(
    "absolute z-10 flex items-center justify-center",
    vertical ? "inset-x-0 h-3 cursor-ns-resize" : "inset-y-0 w-3 cursor-ew-resize",
    "after:rounded-full after:bg-fg-muted after:shadow-sm after:ring-2 after:ring-panel after:transition-transform hover:after:scale-125 hover:after:bg-fg",
    wide ? (vertical ? "after:h-1 after:w-5" : "after:h-5 after:w-1") : "after:size-2.5",
  );

  return (
    <div
      ref={trackRef}
      role="scrollbar"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={label}
      className={cn("group/zbar relative min-h-0 min-w-0", DRAG_SURFACE, className)}
      style={style}
      onPointerDown={onTrackDown}
    >
      {background ? (
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-sm">
          {extent > 0 && background(extent)}
        </div>
      ) : (
        // The groove: always drawn, so the bar reads as a control, not a gap.
        <div
          aria-hidden
          className={cn("absolute rounded-full bg-raised", vertical ? "inset-y-0 left-1/2 w-1 -translate-x-1/2" : "inset-x-0 top-1/2 h-1 -translate-y-1/2")}
        />
      )}
      {markers?.map((m, i) => (
        <div
          key={i}
          aria-hidden
          className={cn(
            // Neutral ink, not the accent: red reads as an error, and the accent
            // already means "playhead" on this bar.
            "pointer-events-none absolute rounded-full bg-fg/55",
            vertical ? "right-0 w-[3px]" : "bottom-0 h-[3px]",
          )}
          style={
            vertical
              ? { top: pct(m.start), height: m.size ? `max(2px, ${pct(m.size)})` : 2 }
              : { left: pct(m.start), width: m.size ? `max(2px, ${pct(m.size)})` : 2 }
          }
        />
      ))}
      {playhead && (
        <div
          ref={tickRef}
          aria-hidden
          className={cn("pointer-events-none absolute z-20 rounded-full bg-primary", vertical ? "inset-x-0.5 top-0 h-0.5" : "inset-y-0.5 left-0 w-0.5")}
        />
      )}
      <div
        ref={thumbRef}
        title={axis.zoomable ? "Drag to scroll · drag an end to zoom · double-click to fit" : undefined}
        className={cn(
          "absolute transition-colors",
          wide
            ? cn("inset-x-0 rounded-sm border border-fg/25", grip === "body" ? "bg-fg/20" : "bg-fg/10 hover:bg-fg/15")
            : cn(
                "rounded-full",
                vertical ? "left-1/2 w-2.5 -translate-x-1/2" : "top-1/2 h-2.5 -translate-y-1/2",
                grip === "body" ? "bg-fg/35" : "bg-fg/20 hover:bg-fg/30",
              ),
          grip === "body" ? "cursor-grabbing" : "cursor-grab",
          zooming && "bg-selection ring-1 ring-primary/50",
        )}
        onPointerDown={(e) => begin("body", e)}
        onDoubleClick={axis.zoomable ? fit : undefined}
      >
        {axis.zoomable && (
          <>
            <span role="presentation" className={cn(handle, vertical ? "-top-1.5" : "-left-1.5")} onPointerDown={(e) => begin("start", e)} />
            <span role="presentation" className={cn(handle, vertical ? "-bottom-1.5" : "-right-1.5")} onPointerDown={(e) => begin("end", e)} />
          </>
        )}
        <span
          ref={chipRef}
          className={cn(
            "material-chip pointer-events-none absolute z-30 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-meta tabular-nums text-fg",
            vertical ? "right-full top-1/2 mr-1.5 -translate-y-1/2" : "bottom-full left-1/2 mb-1.5 -translate-x-1/2",
            (!zooming || !axis.format) && "hidden",
          )}
        />
      </div>
    </div>
  );
}
