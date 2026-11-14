"use client";

import * as React from "react";
import { visibleWorldRect, type AABB, type Camera, type ViewportSize } from "@solomotion/core";
import { capturePointer } from "../input/capture-pointer";

/**
 * THE BOARD MINIMAP — every board's (nodes, machines, grades) whole content
 * shrunk into a corner card, with the viewport rectangle you click or drag to
 * fly the camera there. It auto-fits: the content plus the view scale to fill
 * a fixed frame, so it stays useful at three cards or three hundred. A board
 * hands it boxes and colours; the camera maths is the board surface's own
 * (`usePanZoomSurface`), so pan and zoom move the box for free.
 */

export interface MinimapItem {
  id: string;
  box: AABB;
  color: string;
  /** Drawn brighter (the live state, the selection). */
  lit?: boolean;
}

const MM_W = 164;
const MM_H = 104;
const PAD = 7;

export function BoardMinimap({
  items,
  camera,
  viewport,
  corner = "br",
  onCenterOn,
  onHide,
}: {
  items: readonly MinimapItem[];
  camera: Camera;
  viewport: ViewportSize;
  corner?: "tl" | "tr" | "bl" | "br";
  onCenterOn: (worldX: number, worldY: number) => void;
  onHide?: () => void;
}) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  let content: AABB | null = null;
  for (const it of items) {
    content = content
      ? { minX: Math.min(content.minX, it.box.minX), minY: Math.min(content.minY, it.box.minY), maxX: Math.max(content.maxX, it.box.maxX), maxY: Math.max(content.maxY, it.box.maxY) }
      : { ...it.box };
  }
  // Frame the content plus the current viewport, so the box is always visible.
  const vis = visibleWorldRect(camera, viewport);
  const bounds: AABB = content
    ? { minX: Math.min(content.minX, vis.minX), minY: Math.min(content.minY, vis.minY), maxX: Math.max(content.maxX, vis.maxX), maxY: Math.max(content.maxY, vis.maxY) }
    : vis;
  const cw = Math.max(1, bounds.maxX - bounds.minX);
  const ch = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.min((MM_W - PAD * 2) / cw, (MM_H - PAD * 2) / ch);
  const offX = PAD + (MM_W - PAD * 2 - cw * scale) / 2;
  const offY = PAD + (MM_H - PAD * 2 - ch * scale) / 2;
  const toMini = (wx: number, wy: number) => ({ x: (wx - bounds.minX) * scale + offX, y: (wy - bounds.minY) * scale + offY });
  const toWorld = (mx: number, my: number) => ({ x: (mx - offX) / scale + bounds.minX, y: (my - offY) / scale + bounds.minY });

  const onPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    capturePointer(e.currentTarget as Element, e.pointerId);
    const go = (cx: number, cy: number) => {
      const r = ref.current!.getBoundingClientRect();
      const w = toWorld(cx - r.left, cy - r.top);
      onCenterOn(w.x, w.y);
    };
    go(e.clientX, e.clientY);
    const move = (ev: PointerEvent) => go(ev.clientX, ev.clientY);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const vp = { a: toMini(vis.minX, vis.minY), b: toMini(vis.maxX, vis.maxY) };
  const pos: React.CSSProperties = {
    top: corner[0] === "t" ? 12 : undefined,
    bottom: corner[0] === "b" ? 12 : undefined,
    left: corner[1] === "l" ? 12 : undefined,
    right: corner[1] === "r" ? 12 : undefined,
  };
  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onHide?.();
      }}
      className="material-glass absolute cursor-pointer overflow-hidden rounded-lg"
      style={{ width: MM_W, height: MM_H, ...pos }}
      aria-label="Minimap"
      title={onHide ? "Drag to pan · right-click to hide" : "Drag to pan"}
    >
      {items.map((it) => {
        const p = toMini(it.box.minX, it.box.minY);
        return (
          <div
            key={it.id}
            className="absolute rounded-[2px]"
            style={{
              left: p.x,
              top: p.y,
              width: Math.max(2, (it.box.maxX - it.box.minX) * scale),
              height: Math.max(2, (it.box.maxY - it.box.minY) * scale),
              backgroundColor: it.color,
              opacity: it.lit ? 1 : 0.8,
              boxShadow: it.lit ? "0 0 0 1px var(--primary)" : undefined,
            }}
          />
        );
      })}
      <div
        className="absolute rounded-[2px] border border-primary/90 bg-primary/10"
        style={{ left: vp.a.x, top: vp.a.y, width: Math.max(4, vp.b.x - vp.a.x), height: Math.max(4, vp.b.y - vp.a.y) }}
      />
    </div>
  );
}
