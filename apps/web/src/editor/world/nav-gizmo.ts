import type * as React from "react";
import { capturePointer } from "../input/capture-pointer";
import type { V3 } from "@solomotion/core";
import { pan, viewBasis, type ViewState } from "./viewport/view";
import { AXIS_COLORS } from "./viewport/overlays";
import type { WorldViewport } from "./viewport/viewport";

/**
 * THE NAVIGATION GIZMO — Blender's axis balls: drag to orbit, click a ball to
 * look from that side; plus the zoom and pan handles beside it. Drawn into a
 * canvas imperatively after each viewport frame (no React per frame), and its
 * pointer state lives on an instance — one per viewport — rather than in
 * module variables two viewports would share.
 */
export class NavGizmo {
  private hover: string | null = null;
  private drag: { x: number; y: number; moved: boolean; kind: "orbit" | "zoom" | "pan"; id: number } | null = null;

  constructor(
    private readonly size: number,
    private readonly vp: () => WorldViewport | null,
    private readonly canvas: () => HTMLCanvasElement | null,
  ) {}

  /** Which way each ball sits for this view, back to front. */
  private axes(v: ViewState) {
    const { right, up, forward } = viewBasis(v);
    const list: Array<{ dir: V3; label: string; color: string; positive: boolean }> = [
      { dir: [1, 0, 0], label: "X", color: AXIS_COLORS.x, positive: true },
      { dir: [0, 1, 0], label: "Y", color: AXIS_COLORS.y, positive: true },
      { dir: [0, 0, 1], label: "Z", color: AXIS_COLORS.z, positive: true },
      { dir: [-1, 0, 0], label: "-X", color: AXIS_COLORS.x, positive: false },
      { dir: [0, -1, 0], label: "-Y", color: AXIS_COLORS.y, positive: false },
      { dir: [0, 0, -1], label: "-Z", color: AXIS_COLORS.z, positive: false },
    ];
    const half = this.size / 2;
    const r = half - 11;
    const dot = (a: V3, b: readonly number[]) => a[0] * b[0]! + a[1] * b[1]! + a[2] * b[2]!;
    return list
      .map((a) => ({ ...a, x: half + dot(a.dir, right) * r, y: half - dot(a.dir, up) * r, depth: dot(a.dir, forward) }))
      .sort((a, b) => b.depth - a.depth);
  }

  draw(v: ViewState, ink: string): void {
    const canvas = this.canvas();
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(this.size * dpr);
    if (canvas.width !== px) canvas.width = canvas.height = px;
    const ctx = canvas.getContext("2d")!;
    const half = this.size / 2;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.size, this.size);
    if (this.hover) {
      ctx.fillStyle = ink.replace("ALPHA", "0.08");
      ctx.beginPath();
      ctx.arc(half, half, half - 1, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const a of this.axes(v)) {
      if (a.positive) {
        ctx.strokeStyle = a.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(half, half);
        ctx.lineTo(a.x, a.y);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.positive ? 8.5 : 7.5, 0, Math.PI * 2);
      ctx.fillStyle = a.positive ? a.color : `${a.color}40`;
      ctx.fill();
      if (!a.positive) {
        ctx.strokeStyle = a.color;
        ctx.lineWidth = 1.25;
        ctx.stroke();
      }
      if (this.hover === a.label) {
        ctx.strokeStyle = ink.replace("ALPHA", "1");
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      if (a.positive || this.hover === a.label) {
        ctx.fillStyle = a.positive ? "#101012" : ink.replace("ALPHA", "1");
        ctx.font = "600 10px Inter, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(a.label.replace("-", ""), a.x, a.y + 0.5);
      }
    }
  }

  private hit(x: number, y: number) {
    const vp = this.vp();
    if (!vp) return null;
    for (const a of this.axes(vp.view).reverse()) if (Math.hypot(a.x - x, a.y - y) < 10) return a;
    return null;
  }

  readonly down = (e: React.PointerEvent, kind: "orbit" | "zoom" | "pan") => {
    e.stopPropagation();
    capturePointer(e.currentTarget as Element, e.pointerId);
    this.drag = { x: e.clientX, y: e.clientY, moved: false, kind, id: e.pointerId };
  };

  readonly move = (e: React.PointerEvent) => {
    const vp = this.vp();
    const d = this.drag;
    if (!d) {
      if (e.currentTarget !== this.canvas()) return;
      const r = (e.currentTarget as Element).getBoundingClientRect();
      this.hover = this.hit(e.clientX - r.left, e.clientY - r.top)?.label ?? "bg";
      vp?.requestDraw();
      return;
    }
    if (!vp || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (Math.hypot(dx, dy) > 2) d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    const v = vp.view;
    if (d.kind === "orbit") vp.setView({ ...v, yaw: v.yaw - dx * 0.5, pitch: Math.max(-90, Math.min(90, v.pitch + dy * 0.5)), ortho: false }, false);
    else if (d.kind === "zoom") vp.setView({ ...v, distance: v.distance * Math.exp(dy * 0.01) }, false);
    else vp.setView(pan(v, dx, dy, vp.renderer.domElement.clientHeight || 600), false);
  };

  /** Release — and a click (no travel) on a ball looks FROM that side, Blender's way: −Y is the front. */
  readonly up = (e: React.PointerEvent) => {
    const d = this.drag;
    this.drag = null;
    if (!d || d.moved || d.kind !== "orbit" || e.type === "pointercancel") return;
    const r = (e.currentTarget as Element).getBoundingClientRect();
    const a = this.hit(e.clientX - r.left, e.clientY - r.top);
    const vp = this.vp();
    if (!a || !vp) return;
    const [x, y, z] = a.dir;
    const yaw = z !== 0 ? 0 : x > 0 ? 90 : x < 0 ? -90 : y < 0 ? 0 : 180;
    const pitch = z > 0 ? 90 : z < 0 ? -90 : 0;
    vp.setView({ ...vp.view, yaw, pitch, ortho: true });
  };

  readonly leave = () => {
    if (this.drag) return;
    this.hover = null;
    this.vp()?.requestDraw();
  };
}
