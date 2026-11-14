"use client";

import type { Vec2 } from "@solomotion/core";
import { layoutHandles, layoutHandleValue, type LayoutGeometry, type LayoutHandle } from "./layout-chrome";

/**
 * AUTO LAYOUT — what the overlay paints for a selected container, Figma's way:
 * the slots as faint outlines, each gap and padding as a short accent LINE
 * across its band, and — on the band you are hovering or dragging — the band
 * itself hatched in the accent with its value beside it. A finger has no
 * hover, so the lines are always there; the hatch is the answer to "which one
 * is this".
 */

/** Line length on screen: a share of the band it sits in, never a speck, never a bar. */
const LINE_MIN = 10;
const LINE_MAX = 22;

export function drawLayoutChrome(
  ctx: CanvasRenderingContext2D,
  geo: LayoutGeometry,
  opts: { accent: string; active?: LayoutHandle | null; hover?: LayoutHandle | null; carried?: string | null },
): void {
  const { space } = geo;
  const toScreen = (p: Vec2) => space.toScreen(p);
  ctx.save();

  // Slots: the member footprints, hairline, so the arrangement reads. The one
  // being carried shows no outline — its slot is wherever it lands.
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = opts.accent;
  ctx.globalAlpha = 0.35;
  for (const s of geo.slots) {
    if (s.id === opts.carried) continue;
    const a = toScreen({ x: s.x, y: s.y });
    const b = toScreen({ x: s.x + s.width, y: s.y + s.height });
    ctx.strokeRect(Math.min(a.x, b.x) + 0.5, Math.min(a.y, b.y) + 0.5, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  }
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);

  // A member is being carried: the handles would only be in the way.
  if (opts.carried) {
    ctx.restore();
    return;
  }

  const lit = opts.active ?? opts.hover ?? null;
  for (const h of layoutHandles(geo)) {
    const on = lit !== null && sameLayoutHandle(lit, h);
    if (on) drawBand(ctx, geo, h, opts.accent);
    drawLine(ctx, geo, h, opts.accent, on);
    if (on) drawValue(ctx, geo, h, opts.accent);
  }
  ctx.restore();
}

/** The band this handle sizes, hatched — Figma's pink stripes. */
function drawBand(ctx: CanvasRenderingContext2D, geo: LayoutGeometry, h: LayoutHandle, accent: string): void {
  const a = geo.space.toScreen({ x: h.band.x, y: h.band.y });
  const b = geo.space.toScreen({ x: h.band.x + h.band.width, y: h.band.y + h.band.height });
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x);
  const hh = Math.abs(b.y - a.y);
  if (w < 1 || hh < 1) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, hh);
  ctx.clip();
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = accent;
  ctx.fillRect(x, y, w, hh);
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let d = -hh; d < w; d += 6) {
    ctx.moveTo(x + d, y + hh);
    ctx.lineTo(x + d + hh, y);
  }
  ctx.stroke();
  ctx.restore();
}

/** The handle: a short rounded line across the band, haloed so it reads on any art. */
function drawLine(ctx: CanvasRenderingContext2D, geo: LayoutGeometry, h: LayoutHandle, accent: string, on: boolean): void {
  const c = geo.space.toScreen(h.at);
  const a = geo.space.toScreen({ x: h.band.x, y: h.band.y });
  const b = geo.space.toScreen({ x: h.band.x + h.band.width, y: h.band.y + h.band.height });
  const across = h.vertical ? Math.abs(b.y - a.y) : Math.abs(b.x - a.x);
  const len = Math.max(LINE_MIN, Math.min(LINE_MAX, across * 0.35));
  const [dx, dy] = h.vertical ? [0, len / 2] : [len / 2, 0];
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(c.x - dx, c.y - dy);
  ctx.lineTo(c.x + dx, c.y + dy);
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.lineWidth = on ? 5 : 4;
  ctx.stroke();
  ctx.strokeStyle = on ? "#ffffff" : accent;
  ctx.lineWidth = on ? 2.5 : 2;
  ctx.stroke();
}

/** The value, in a small accent tag beside the line. */
function drawValue(ctx: CanvasRenderingContext2D, geo: LayoutGeometry, h: LayoutHandle, accent: string): void {
  const c = geo.space.toScreen(h.at);
  const text = String(Math.round(layoutHandleValue(geo.spec, h)));
  ctx.font = "600 10px ui-sans-serif, system-ui, sans-serif";
  const w = ctx.measureText(text).width + 8;
  const x = h.vertical ? c.x + 8 : c.x - w / 2;
  const y = h.vertical ? c.y - 8 : c.y + 8;
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.roundRect(x, y, w, 16, 4);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + 4, y + 8.5);
}

export function sameLayoutHandle(a: LayoutHandle | null, b: LayoutHandle | null): boolean {
  if (!a || !b) return a === b;
  return a.key === b.key;
}
