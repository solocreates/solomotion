"use client";

import * as React from "react";
import { fitCamera, type AABB, type Camera, type ViewportSize } from "@solomotion/core";
import { dragZoomFactor, middleDragIntent, useZoomGesture } from "./use-zoom-gesture";
import { useMultiTouch, DRAG_SURFACE } from "../input/use-multi-touch";
import { spacePan } from "../stage/space-pan";

/**
 * usePanZoomSurface — the shared PAN/ZOOM brain for any infinite surface. It
 * wraps the headless `Camera` math (`viewport/camera.ts`) with the exact input
 * grammar the Stage already uses — trackpad pan, ⌘/pinch zoom-at-cursor, Space
 * or middle-mouse drag to hand-pan, ⌘+middle drag to scrub the zoom — so the
 * node board FEELS identical to the canvas without re-implementing (or
 * coupling to) Stage's 5k-line internals.
 * This is the "reuse the stage behaviours headlessly" the board is built on.
 *
 * It lives in `state/`, not in `nodes/`, because it is not about nodes: the
 * node board was simply its first consumer, and the effect editor's zoomable
 * preview is its second. Anything with a camera over a world should reach for
 * this rather than growing a third pan/zoom implementation.
 *
 * `minScale`/`maxScale` are per-surface — an infinite board and a 170px preview
 * thumbnail want very different limits — but the GESTURE grammar is fixed, so
 * every surface in the app zooms with the same fingers.
 */

const MIN_SCALE = 0.2;
const MAX_SCALE = 2.5;

/** Zoom by `factor` while keeping the world point under `center` (screen px) fixed. */
function zoomAt(cam: Camera, factor: number, center: { x: number; y: number }, min: number, max: number): Camera {
  const scale = Math.min(max, Math.max(min, cam.scale * factor));
  const k = scale / cam.scale;
  return { scale, tx: center.x - (center.x - cam.tx) * k, ty: center.y - (center.y - cam.ty) * k };
}

export interface PanZoomSurfaceOptions {
  minScale?: number;
  maxScale?: number;
  /** Empty space kept around the bounds when fitting, in screen px. */
  fitPaddingPx?: number;
  /** Plain (unmodified) drag pans. On for surfaces with nothing to select. */
  dragToPan?: boolean;
}

export interface PanZoomSurface {
  camera: Camera;
  setCamera: React.Dispatch<React.SetStateAction<Camera>>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Screen (container-local) px → world coordinates. */
  screenToWorld: (sx: number, sy: number) => { x: number; y: number };
  worldToScreen: (wx: number, wy: number) => { x: number; y: number };
  /** Frame a world box in the viewport (used on open / "fit"). */
  fit: (bounds: AABB) => void;
  /** True while a hand-pan drag (Space / middle-mouse / plain drag) is running. */
  panning: boolean;
  /** Zoom about the viewport centre — for a +/− control or a zoom dial. */
  zoomTo: (scale: number) => void;
  minScale: number;
  maxScale: number;
  /** Attach to the surface: begins a hand-pan on Space-held or middle button. */
  onPanPointerDown: (e: React.PointerEvent) => void;
  viewport: () => ViewportSize;
  /** Spread on the container. Carries the `touch-action` the gestures need —
   *  handed back rather than left to the caller, so a surface cannot wire the
   *  handlers and forget the CSS that lets them run. */
  surfaceClassName: string;
}

export function usePanZoomSurface(initial: Camera, options: PanZoomSurfaceOptions = {}): PanZoomSurface {
  const minScale = options.minScale ?? MIN_SCALE;
  const maxScale = options.maxScale ?? MAX_SCALE;
  const fitPadding = options.fitPaddingPx ?? 80;
  const dragToPan = options.dragToPan ?? false;
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [camera, setCamera] = React.useState<Camera>(initial);
  const [panning, setPanning] = React.useState(false);
  const camRef = React.useRef(camera);
  camRef.current = camera;

  const viewport = React.useCallback((): ViewportSize => {
    const el = containerRef.current;
    return el ? { width: el.clientWidth, height: el.clientHeight } : { width: 1, height: 1 };
  }, []);

  const screenToWorld = React.useCallback((sx: number, sy: number) => {
    const c = camRef.current;
    return { x: (sx - c.tx) / c.scale, y: (sy - c.ty) / c.scale };
  }, []);

  const worldToScreen = React.useCallback((wx: number, wy: number) => {
    const c = camRef.current;
    return { x: wx * c.scale + c.tx, y: wy * c.scale + c.ty };
  }, []);

  const fit = React.useCallback(
    (bounds: AABB) => setCamera(fitCamera(bounds, viewport(), { paddingPx: fitPadding, minScale, maxScale })),
    [viewport, fitPadding, minScale, maxScale],
  );

  /** Zoom about the viewport centre, keeping what you're looking at centred. */
  const zoomTo = React.useCallback(
    (scale: number) => {
      const vp = viewport();
      setCamera((c) => zoomAt(c, Math.min(maxScale, Math.max(minScale, scale)) / c.scale, { x: vp.width / 2, y: vp.height / 2 }, minScale, maxScale));
    },
    [viewport, minScale, maxScale],
  );

  // Wheel: trackpad two-finger pans, ⌘/pinch zooms at the cursor — same as Stage.
  useZoomGesture(containerRef, {
    onZoom: (factor, center) => setCamera((c) => zoomAt(c, factor, center, minScale, maxScale)),
    onPan: (dx, dy) => setCamera((c) => ({ ...c, tx: c.tx + dx, ty: c.ty + dy })),
  });

  /**
   * Two fingers navigate, exactly as on the stage and the timeline — pinch
   * zooms about the centroid, drag pans. It goes through the SAME `zoomAt` and
   * the same camera setter the wheel path above uses, so a canvas cannot end
   * up with a touch zoom that clamps differently from its trackpad zoom.
   *
   * Added here rather than in the node board because this hook is the shared
   * camera for every free canvas in the app (the board and the effect preview
   * today); putting it one level down would have meant writing it twice
   * immediately.
   */
  useMultiTouch(containerRef, {
    onGesture: ({ scale, dx, dy, x, y }) =>
      setCamera((c) => {
        const panned = { ...c, tx: c.tx + dx, ty: c.ty + dy };
        return scale === 1 ? panned : zoomAt(panned, scale, { x, y }, minScale, maxScale);
      }),
  });

  const onPanPointerDown = React.useCallback((e: React.PointerEvent) => {
    const spaceHeld = spacePan.held;
    // Space+left and middle-drag everywhere; plain left-drag only where the
    // surface has no selection to compete with (the effect preview).
    if (e.button !== 1 && !(e.button === 0 && (spaceHeld || dragToPan))) return;
    e.preventDefault();
    setPanning(true);
    // ⌘/Ctrl + middle scrubs the zoom about the press point instead — the same
    // rule the stage applies (`middleDragIntent`), so every camera agrees.
    const zooming = e.button === 1 && middleDragIntent(e) === "zoom";
    const rect = containerRef.current?.getBoundingClientRect();
    const anchor = { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
    let lastX = e.clientX;
    let lastY = e.clientY;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - lastX;
      const dy = ev.clientY - lastY;
      lastX = ev.clientX;
      lastY = ev.clientY;
      if (spaceHeld) spacePan.markDragged();
      if (zooming) setCamera((c) => zoomAt(c, dragZoomFactor(dx, dy), anchor, minScale, maxScale));
      else setCamera((c) => ({ ...c, tx: c.tx + dx, ty: c.ty + dy }));
    };
    const up = () => {
      setPanning(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("blur", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    // Cancel and blur, for the same reason the scrub needs them: touch hands
    // the gesture back with `pointercancel` instead of `pointerup`, and a
    // hand-pan that never tore down left the camera following the pointer
    // around the app forever.
    window.addEventListener("pointercancel", up);
    window.addEventListener("blur", up);
  }, [dragToPan, minScale, maxScale]);

  return {
    camera,
    setCamera,
    containerRef,
    screenToWorld,
    worldToScreen,
    fit,
    panning,
    zoomTo,
    minScale,
    maxScale,
    onPanPointerDown,
    viewport,
    surfaceClassName: DRAG_SURFACE,
  };
}
