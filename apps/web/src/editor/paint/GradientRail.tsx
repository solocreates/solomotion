"use client";

import { rotateCursor } from "@solomotion/ui/cursors";
import * as React from "react";
import type { GradientPaint, GradientStop, GradientType } from "@solomotion/core";
import { cn } from "@/lib/utils";
import { capturePointer } from "../input/capture-pointer";
import { beginHeldDrag } from "../input/hold-to-drag";
import { subscribePointerEnd } from "../input/pointer-gestures";

/**
 * THE STOP RAIL — and it takes the SHAPE of the gradient it edits.
 *
 * All three gradient types shared one horizontal bar, which quietly taught the
 * wrong thing three times over. A radial ramp does not run left to right, it
 * runs centre to edge; an angular one does not run anywhere, it goes around.
 * Editing all three on a bar meant the control disagreed with the artwork, and
 * "where is 40% on a conic sweep" was a question the panel refused to answer.
 *
 * So: a bar for linear, a disc with pins along one radius for radial, a ring
 * with pins around it for angular. The DATA is identical in all three — one
 * offset per stop, 0..1 — because the geometry is already unified in the
 * schema. Only the mapping from a pointer to that offset changes, which is why
 * this is one component and not three.
 *
 * The ramp itself is CSS here rather than the canvas painter, and that is
 * correct: this is not a preview of the fill, it is the CONTROL, drawn in the
 * abstract 0..1 space of the ramp with no bounds, no angle and no tiling. The
 * live preview of the actual fill sits above it.
 */

export interface GradientRailProps {
  paint: GradientPaint;
  /** Stops, already sorted by offset. */
  stops: GradientStop[];
  selectedId: string | null;
  resolve: (color: string) => string;
  onSelect: (id: string) => void;
  /** Streamed while dragging — the caller passes an undo mergeKey. */
  onMove: (id: string, offset: number) => void;
  /** Click on empty ramp: add a stop here, sampling the colour under it. */
  onAdd: (offset: number) => void;
  /** ⌥-drag duplicated this stop; the copy is what moves. */
  onDuplicate: (id: string) => string | null;
  onOpenColor: (id: string) => void;
  /** Wraps each pin — the caller supplies its context menu. */
  pinWrapper?: (stop: GradientStop, pin: React.ReactNode) => React.ReactNode;
}

const RING_INNER = 0.56; // donut hole, as a fraction of the radius

export function GradientRail(props: GradientRailProps) {
  return props.paint.type === "linear" ? <LinearRail {...props} /> : <RadialRail {...props} />;
}

/** Shared pin. Identical in all three forms, so a stop reads as the same object
 *  whatever shape it is sitting on. */
function Pin({
  stop,
  selected,
  resolve,
  style,
  cursor,
  onPointerDown,
  onDoubleClick,
  wrapper,
}: {
  stop: GradientStop;
  selected: boolean;
  resolve: (c: string) => string;
  style: React.CSSProperties;
  cursor: string;
  onPointerDown: (e: React.PointerEvent) => void;
  onDoubleClick: (e: React.MouseEvent) => void;
  wrapper?: GradientRailProps["pinWrapper"];
}) {
  const pin = (
    <button
      type="button"
      aria-label={`Gradient stop at ${Math.round(stop.offset * 100)}%`}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      className={cn(
        "absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 shadow outline-none focus-visible:ring-2 focus-visible:ring-primary",
        cursor,
        selected ? "border-primary" : "border-white/90",
      )}
      style={{ ...style, background: resolve(stop.color) }}
    />
  );
  return <>{wrapper ? wrapper(stop, pin) : pin}</>;
}

/** The drag loop, shared by all three forms. `toOffset` is the only difference
 *  between a bar, a radius and a ring. */
function useStopDrag(props: GradientRailProps, toOffset: (e: { clientX: number; clientY: number }, rect: DOMRect) => number) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);

  const start = (e: React.PointerEvent, stopId: string) => {
    // Primary button only: right-clicking a stop asks for its MENU (edit
    // colour, delete), and a drag that starts on any button would both move the
    // stop and swallow the gesture the menu was waiting for.
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const host = hostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const target = e.currentTarget as HTMLElement;
    // ⌥-drag DUPLICATES: the copy is what moves, the original stays (Figma).
    const dragId = e.altKey ? (props.onDuplicate(stopId) ?? stopId) : stopId;
    props.onSelect(dragId);
    target.focus();
    capturePointer(target, e.pointerId);
    /*
     * The rail runs left-to-right and the panel around it scrolls up and down,
     * so there is nothing to wait for: direction alone says which is which.
     * `axis: "x"` is what buys that — without it the scope has to assume the
     * drag reads every direction and falls back to a pause nobody needs.
     */
    const arm = beginHeldDrag(e, { axis: "x" });
    const onMove = (ev: PointerEvent) => {
      if (!arm.update(ev.clientX, ev.clientY)) return;
      props.onMove(dragId, toOffset(ev, rect));
    };
    const off = subscribePointerEnd((pid) => {
      if (pid !== e.pointerId) return;
      arm.end();
      off();
      target.removeEventListener("pointermove", onMove);
    });
    target.addEventListener("pointermove", onMove);
  };

  const addAt = (e: React.PointerEvent) => {
    // A right-click on the rail is a request for a menu, never a new stop.
    if (e.button !== 0) return;
    const host = hostRef.current;
    if (!host) return;
    props.onAdd(toOffset(e, host.getBoundingClientRect()));
  };

  return { hostRef, start, addAt };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** The ramp as a CSS stop list, in the abstract 0..1 space of the control. */
function rampStops(stops: GradientStop[], resolve: (c: string) => string): string {
  return stops.map((s) => `${resolve(s.color)} ${(s.offset * 100).toFixed(1)}%`).join(", ");
}

// ── Linear: a bar ───────────────────────────────────────────────────────────

function LinearRail(props: GradientRailProps) {
  const { stops, selectedId, resolve } = props;
  const { hostRef, start, addAt } = useStopDrag(props, (e, rect) => clamp01((e.clientX - rect.left) / rect.width));

  return (
    <div
      ref={hostRef}
      onPointerDown={addAt}
      className="relative h-7 cursor-copy overflow-visible rounded-md shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]"
      style={{ background: `linear-gradient(90deg, ${rampStops(stops, resolve)})` }}
    >
      {stops.map((s) => (
        <Pin
          key={s.id}
          stop={s}
          selected={s.id === selectedId}
          resolve={resolve}
          cursor="cursor-ew-resize"
          style={{ left: `${s.offset * 100}%`, top: "50%" }}
          onPointerDown={(e) => start(e, s.id)}
          onDoubleClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            props.onOpenColor(s.id);
          }}
          wrapper={props.pinWrapper}
        />
      ))}
    </div>
  );
}

// ── Radial and angular: a disc ──────────────────────────────────────────────
//
// One component for both. A radial ramp runs centre → edge and an angular one
// runs around, so the pins sit on a radius in the first and on the rim in the
// second — but the disc, the hit maths and the pin are the same object, and
// splitting them would have been two files that both had to be told when the
// pin styling changed.

function RadialRail(props: GradientRailProps) {
  const { stops, selectedId, resolve, paint } = props;
  const angular = paint.type === "angular";

  const { hostRef, start, addAt } = useStopDrag(props, (e, rect) => {
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    if (angular) {
      // Around: 0 at twelve o'clock, clockwise, so it matches the conic ramp
      // drawn underneath rather than making the reader do the trigonometry.
      const a = Math.atan2(e.clientX - cx, cy - e.clientY);
      return clamp01(((a / (Math.PI * 2)) % 1 + 1) % 1);
    }
    // Out: distance from the centre over the radius.
    const r = Math.min(rect.width, rect.height) / 2;
    return clamp01(Math.hypot(e.clientX - cx, e.clientY - cy) / r);
  });

  const css = angular
    ? `conic-gradient(from 0deg, ${rampStops(stops, resolve)})`
    : `radial-gradient(circle at 50% 50%, ${rampStops(stops, resolve)})`;

  return (
    <div className="flex justify-center py-1">
      <div
        ref={hostRef}
        onPointerDown={addAt}
        className="relative size-[124px] cursor-copy rounded-full shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]"
        style={{
          background: css,
          // The angular ramp is a RING: the middle of a conic gradient is a
          // singularity where every stop meets, so showing it would put the
          // one part of the picture that means nothing at the centre of
          // attention.
          ...(angular
            ? { maskImage: `radial-gradient(circle, transparent ${RING_INNER * 100}%, #000 ${RING_INNER * 100 + 0.5}%)` }
            : {}),
        }}
      >
        {stops.map((s) => {
          const style = angular
            ? (() => {
                const a = s.offset * Math.PI * 2;
                const r = (RING_INNER + (1 - RING_INNER) / 2) * 50;
                return {
                  left: `${50 + Math.sin(a) * r}%`,
                  top: `${50 - Math.cos(a) * r}%`,
                  // The pin travels around the ring, so its cursor wraps the spot it sits on.
                  cursor: rotateCursor(s.offset * 360 - 90),
                };
              })()
            : { left: `${50 + s.offset * 50}%`, top: "50%" };
          return (
            <Pin
              key={s.id}
              stop={s}
              selected={s.id === selectedId}
              resolve={resolve}
              cursor={angular ? "cursor-grab" : "cursor-ew-resize"}
              style={style}
              onPointerDown={(e) => start(e, s.id)}
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                props.onOpenColor(s.id);
              }}
              wrapper={props.pinWrapper}
            />
          );
        })}
        {/* The radial ramp's own axis, so the pins read as sitting ON something
            rather than floating over a disc. */}
        {!angular && (
          <span className="pointer-events-none absolute left-1/2 top-1/2 h-px w-1/2 -translate-y-1/2 bg-white/25" />
        )}
      </div>
    </div>
  );
}

/** Label for the rail's own hint line — what an offset MEANS in this form. */
export const RAIL_HINT: Record<GradientType, string> = {
  linear: "Start to end",
  radial: "Centre to edge",
  angular: "Around the sweep",
};
