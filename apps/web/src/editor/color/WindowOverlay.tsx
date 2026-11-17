"use client";

import { cursors, resizeCursor } from "@solomotion/ui/cursors";
import * as React from "react";
import {
  contourAtPose,
  findVisualClip,
  pathCommands,
  type PowerWindow,
  type RegionPose,
} from "@solomotion/core";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession, useStageCamera, useParkedPlayhead, useTransportRunning } from "../state/session";
import { accentColor } from "../theme/theme-tokens";
import { capturePointer } from "../input/capture-pointer";
import { claimPointer, subscribePointerEnd } from "../input/pointer-gestures";
import { frameSpace } from "../stage/edit-space";
import { useColorStore } from "./color-store";
import { patchKey } from "./grade-actions";

/**
 * POWER WINDOWS ON STAGE.
 *
 * A window you can add and cannot move is not a window. This is the rig that
 * makes the Windows tab mean something: drag the body, pull a corner, turn the
 * dial — and every one of those writes a keyframable field
 * (`lfx.<card>.n.<node>.w.<win>.x` and friends), so a window animates like any
 * other property without a second system.
 *
 * TWO POSES, COMPOSED, and that is the whole coordinate story. A window's
 * contour is stored centred on the LAYER in natural pixels; the window's own
 * transform places it within the layer; the layer's transform places that in
 * the frame. Composing them in that order is what makes a window ride its clip
 * when the clip moves — which is the behaviour that distinguishes a correction
 * ON a shot from a hole punched in the viewport.
 *
 * A TRACKED window has no rig at all. Its pose is the tracker's samples, and a
 * handle that silently did nothing (or worse, fought the solve) would be the
 * cruellest control on the page. Its outline is still drawn, dashed, so you can
 * see what it is doing.
 */
type Grab = { kind: "body" } | { kind: "scale" } | { kind: "rotate" };

const HANDLE_R = 5;

export function WindowOverlay() {
  const doc = useDoc();
  const store = useDocStore();
  const view = useStageCamera();
  const playheadMs = useParkedPlayhead();
  const navPath = useSession((s) => s.nav.path);
  // An editing overlay is for a still frame: the canvas draws the motion.
  const running = useTransportRunning();
  const open = useColorStore((s) => s.open);
  const clipId = useColorStore((s) => s.clipId);
  const cardId = useColorStore((s) => s.cardId);
  const nodeId = useColorStore((s) => s.selectedNodeId);
  const tab = useColorStore((s) => s.tab);

  const svgRef = React.useRef<SVGSVGElement>(null);
  const [grab, setGrab] = React.useState<{ windowId: string; kind: Grab["kind"] } | null>(null);
  const startRef = React.useRef<{ transform: PowerWindow["source"] extends infer _ ? { x: number; y: number; scale: number; scaleY: number | null; rotation: number } : never; local: { x: number; y: number } } | null>(null);

  React.useEffect(() => subscribePointerEnd(() => setGrab(null)), []);

  // Only while the page is showing the tab these belong to. A rig that outlives
  // its panel is chrome nobody asked for over the canvas.
  if (running || !open || tab !== "windows" || !clipId || !cardId || !nodeId) return null;

  const clip = findVisualClip(doc, clipId);
  const frame = clip ? doc.frames.find((f) => f.id === clip.frameId) : null;
  if (!clip || !frame) return null;
  const card = clip.effects.find((e) => e.id === cardId);
  if (card?.type !== "grade") return null;
  const node = card.graph.nodes.find((n) => n.id === nodeId);
  if (node?.kind !== "corrector" || node.key.windows.length === 0) return null;

  // Visible only where the clip is — a window on a layer that is not on screen
  // at this instant has nothing to sit over.
  if (playheadMs < clip.startMs || playheadMs >= clip.startMs + clip.durationMs) return null;

  const t = clip.transform;
  const layerPose: RegionPose = {
    x: t.x,
    y: t.y,
    scale: t.scale,
    scaleY: t.scaleY ?? t.scale,
    rotation: t.rotation,
  };
  const space = frameSpace(frame.id, doc, { path: navPath, playheadMs });
  const toScreen = (p: { x: number; y: number }) => {
    const world = space
      ? space.toWorld(p)
      : { x: frame.x + frame.width / 2 + p.x, y: frame.y + frame.height / 2 + p.y };
    return { x: view.tx + world.x * view.scale, y: view.ty + world.y * view.scale };
  };

  /** Screen point → the LAYER's local space (the space a window transform lives in). */
  const toLayer = (e: { clientX: number; clientY: number }) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const w = {
      x: (e.clientX - rect.left - view.tx) / view.scale,
      y: (e.clientY - rect.top - view.ty) / view.scale,
    };
    const fp = space
      ? space.fromWorld(w)
      : { x: w.x - (frame.x + frame.width / 2), y: w.y - (frame.y + frame.height / 2) };
    const rad = (-layerPose.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const dx = fp.x - layerPose.x;
    const dy = fp.y - layerPose.y;
    return {
      x: (dx * cos - dy * sin) / (layerPose.scale || 1),
      y: (dx * sin + dy * cos) / (layerPose.scaleY || 1),
    };
  };

  const color = accentColor();

  const begin = (e: React.PointerEvent, windowId: string, kind: Grab["kind"], transform: { x: number; y: number; scale: number; scaleY: number | null; rotation: number }) => {
    e.stopPropagation();
    e.preventDefault();
    claimPointer(e.pointerId, "drag");
    capturePointer(e.target as Element, e.pointerId);
    startRef.current = { transform: { ...transform }, local: toLayer(e) };
    setGrab({ windowId, kind });
  };

  const move = (e: React.PointerEvent) => {
    if (!grab || !startRef.current) return;
    const start = startRef.current;
    const now = toLayer(e);
    const key = `win-${grab.windowId}-${grab.kind}`;
    const write = (patch: Partial<typeof start.transform>) =>
      patchKey(
        store,
        clipId,
        cardId,
        nodeId,
        (k) => {
          const w = k.windows.find((x) => x.id === grab.windowId);
          if (w?.source.type === "shape") Object.assign(w.source.transform, patch);
        },
        key,
      );

    if (grab.kind === "body") {
      write({ x: start.transform.x + (now.x - start.local.x), y: start.transform.y + (now.y - start.local.y) });
      return;
    }
    if (grab.kind === "scale") {
      const d0 = Math.hypot(start.local.x - start.transform.x, start.local.y - start.transform.y);
      const d1 = Math.hypot(now.x - start.transform.x, now.y - start.transform.y);
      if (d0 < 1) return;
      const k = Math.max(0.02, d1 / d0);
      write({
        scale: start.transform.scale * k,
        scaleY: start.transform.scaleY == null ? null : start.transform.scaleY * k,
      });
      return;
    }
    const a0 = Math.atan2(start.local.y - start.transform.y, start.local.x - start.transform.x);
    const a1 = Math.atan2(now.y - start.transform.y, now.x - start.transform.x);
    write({ rotation: start.transform.rotation + ((a1 - a0) * 180) / Math.PI });
  };

  const end = (e: React.PointerEvent) => {
    setGrab(null);
    startRef.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  };

  return (
    <svg ref={svgRef} className="absolute inset-0 h-full w-full" style={{ pointerEvents: "none" }}>
      {node.key.windows.map((win) => {
        if (!win.enabled) return null;
        const tracked = win.source.type === "tracker";
        // The contour, placed by its own transform and then by the layer's.
        const local =
          win.source.type === "shape"
            ? contourAtPose(
                { shape: win.source.shape, subpaths: win.source.subpaths, feather: 0, expand: 0, invert: false },
                {
                  x: win.source.transform.x,
                  y: win.source.transform.y,
                  scale: win.source.transform.scale,
                  scaleY: win.source.transform.scaleY,
                  rotation: win.source.transform.rotation,
                },
              )
            : [];
        const framed = local.map((c) => ({
          closed: c.closed,
          points: c.points.map((p) => ({
            ...p,
            ...posed(p, layerPose),
            hIn: p.hIn ? posed(p.hIn, layerPose) : null,
            hOut: p.hOut ? posed(p.hOut, layerPose) : null,
          })),
        }));

        const d = pathCommands(framed)
          .map((c) => {
            if (c.type === "M" || c.type === "L") {
              const p = toScreen({ x: c.x, y: c.y });
              return `${c.type}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
            }
            if (c.type === "C") {
              const a = toScreen({ x: c.x1, y: c.y1 });
              const b = toScreen({ x: c.x2, y: c.y2 });
              const p = toScreen({ x: c.x, y: c.y });
              return `C${a.x.toFixed(1)} ${a.y.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
            }
            return "Z";
          })
          .join(" ");
        if (!d) return null;

        const tf = win.source.type === "shape" ? win.source.transform : null;
        const centre = toScreen(posed({ x: tf?.x ?? 0, y: tf?.y ?? 0 }, layerPose));
        // The rig's reach: the contour's own extent through both poses, so the
        // handles sit on the shape however it is turned.
        const span = extentOf(framed);
        const dial = toScreen(posed({ x: (tf?.x ?? 0), y: (tf?.y ?? 0) - span.ry * 1.3 }, layerPose));
        const corner = toScreen(posed({ x: (tf?.x ?? 0) + span.rx, y: (tf?.y ?? 0) - span.ry }, layerPose));

        return (
          <g key={win.id}>
            <path
              d={d}
              fill={color}
              fillOpacity={win.invert ? 0.03 : 0.08}
              stroke={color}
              strokeWidth={1.5}
              strokeDasharray={tracked ? "5 4" : win.invert ? "2 3" : undefined}
              style={tracked ? undefined : { pointerEvents: "auto", cursor: cursors.move }}
              onPointerDown={tf ? (e) => begin(e, win.id, "body", tf) : undefined}
              onPointerMove={move}
              onPointerUp={end}
              onPointerCancel={end}
            />
            {tf && (
              <>
                <line x1={centre.x} y1={centre.y} x2={dial.x} y2={dial.y} stroke={color} strokeWidth={1} opacity={0.45} />
                <circle
                  cx={dial.x}
                  cy={dial.y}
                  r={HANDLE_R}
                  fill="var(--background)"
                  stroke={color}
                  strokeWidth={1.5}
                  style={{ pointerEvents: "auto", cursor: cursors.grab }}
                  onPointerDown={(e) => begin(e, win.id, "rotate", tf)}
                  onPointerMove={move}
                  onPointerUp={end}
                  onPointerCancel={end}
                />
                <rect
                  x={corner.x - HANDLE_R}
                  y={corner.y - HANDLE_R}
                  width={HANDLE_R * 2}
                  height={HANDLE_R * 2}
                  fill="var(--background)"
                  stroke={color}
                  strokeWidth={1.5}
                  style={{ pointerEvents: "auto", cursor: resizeCursor(135) }}
                  onPointerDown={(e) => begin(e, win.id, "scale", tf)}
                  onPointerMove={move}
                  onPointerUp={end}
                  onPointerCancel={end}
                />
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** Apply a pose to a point (the layer's placement of a window's geometry). */
function posed(p: { x: number; y: number }, pose: RegionPose): { x: number; y: number } {
  const sy = pose.scaleY ?? pose.scale;
  const rad = (pose.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const lx = p.x * pose.scale;
  const ly = p.y * sy;
  return { x: pose.x + lx * cos - ly * sin, y: pose.y + lx * sin + ly * cos };
}

/** Half-extents of a contour set, in the space it is given. */
function extentOf(contours: Array<{ points: Array<{ x: number; y: number }> }>): { rx: number; ry: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of contours) {
    for (const p of c.points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  if (!Number.isFinite(minX)) return { rx: 60, ry: 60 };
  return { rx: (maxX - minX) / 2, ry: (maxY - minY) / 2 };
}
