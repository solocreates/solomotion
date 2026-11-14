"use client";

import * as React from "react";
import { formatRuler, rulerStep } from "@solomotion/core";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession, useStageView } from "../state/session";
import { beginGuideDrag } from "./guide-drag";
import { RulerSettings } from "./RulerSettings";
import { useTheme } from "../theme/use-theme";
import { accentColor } from "../theme/theme-tokens";
import { hitAABB, stageHitRects, unionAABB } from "./stage-geometry";

export const RULER_SIZE = 20;

/**
 * Figma-style rulers on the canvas top & left edges. One canvas paints both
 * strips + ticks (measured in the active frame's coordinate space, relabelled
 * in the chosen unit); thin DOM strips over them own the interaction: right-
 * click for the settings popover (unit + guide snapping), press-drag to pull a
 * new guide out. Hidden entirely when `rulers` is off.
 */
export function RulerOverlay() {
  const doc = useDoc();
  const store = useDocStore();
  const rulers = useSession((s) => s.rulers);
  const unit = useSession((s) => s.rulerUnit);
  const view = useStageView();
  // The ruler is a canvas: it paints theme colours INTO pixels, so a theme
  // change must repaint it. It used to read `--panel` at draw time with
  // nothing to trigger a draw, so switching light ↔ dark left the strips in
  // the previous theme until the view moved.
  const theme = useTheme((t) => t.colors);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [menu, setMenu] = React.useState<{ x: number; y: number } | null>(null);
  // The selection's extent, highlighted on both rulers (D17, Figma).
  const selectedClipIds = useSession((s) => s.selectedClipIds);
  const selectedFrameIds = useSession((s) => s.selectedFrameIds);

  // The frame whose origin is the ruler's zero (the one you're working in).
  const origin = React.useMemo(() => {
    const session = useSession.getState();
    const f = doc.frames.find((fr) => fr.id === session.activeFrameId) ?? doc.frames[0];
    return f ? { x: f.x, y: f.y } : { x: 0, y: 0 };
  }, [doc, view]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    if (!rulers) return;
    const canvas = canvasRef.current;
    const root = rootRef.current;
    if (!canvas || !root) return;
    const draw = () => {
      const w = root.clientWidth;
      const h = root.clientHeight;
      if (!w || !h) return;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const fg = theme.mutedForeground;
      // Hex + alpha, not color-mix(): canvas colour parsing of CSS functions is uneven.
      const line = /^#[0-9a-f]{6}$/i.test(theme.mutedForeground) ? `${theme.mutedForeground}59` : theme.border;

      ctx.fillStyle = theme.panel;
      ctx.fillRect(0, 0, w, RULER_SIZE); // top strip
      ctx.fillRect(0, 0, RULER_SIZE, h); // left strip
      ctx.strokeStyle = line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, RULER_SIZE + 0.5);
      ctx.lineTo(w, RULER_SIZE + 0.5);
      ctx.moveTo(RULER_SIZE + 0.5, 0);
      ctx.lineTo(RULER_SIZE + 0.5, h);
      ctx.stroke();

      // ── Selection band: the selection's world extent, an accent wash on each
      // ruler with its start/end printed in accent; tick labels that would
      // collide with those two values step aside.
      const sel = (() => {
        if (selectedClipIds.length) {
          const ids = new Set(selectedClipIds);
          return unionAABB(stageHitRects.current.filter((r) => ids.has(r.clipId)).map(hitAABB));
        }
        const fs = doc.frames.filter((f) => selectedFrameIds.includes(f.id));
        return unionAABB(fs.map((f) => ({ minX: f.x, minY: f.y, maxX: f.x + f.width, maxY: f.y + f.height })));
      })();
      const accent = accentColor();
      const bandX = sel ? [view.tx + sel.minX * view.scale, view.tx + sel.maxX * view.scale] : null;
      const bandY = sel ? [view.ty + sel.minY * view.scale, view.ty + sel.maxY * view.scale] : null;
      const KEEP_OUT = 26;
      const nearBand = (s: number, band: number[] | null) => !!band && (Math.abs(s - band[0]!) < KEEP_OUT || Math.abs(s - band[1]!) < KEEP_OUT);
      if (bandX && bandY) {
        ctx.save();
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = accent;
        const x0 = Math.max(RULER_SIZE, bandX[0]!);
        const y0 = Math.max(RULER_SIZE, bandY[0]!);
        if (bandX[1]! > x0) ctx.fillRect(x0, 0, bandX[1]! - x0, RULER_SIZE);
        if (bandY[1]! > y0) ctx.fillRect(0, y0, RULER_SIZE, bandY[1]! - y0);
        ctx.restore();
      }

      const step = rulerStep(view.scale, unit).world;
      ctx.font = "9px var(--font-jetbrains-mono), monospace";
      ctx.fillStyle = fg;
      ctx.strokeStyle = line;

      // Top (horizontal) ruler — ticks aligned to the frame origin.
      const wx0 = (RULER_SIZE - view.tx) / view.scale;
      const wx1 = (w - view.tx) / view.scale;
      let wx = origin.x + Math.floor((wx0 - origin.x) / step) * step;
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      for (; wx <= wx1; wx += step) {
        const sx = view.tx + wx * view.scale;
        if (sx < RULER_SIZE) continue;
        ctx.beginPath();
        ctx.moveTo(sx + 0.5, RULER_SIZE - 6);
        ctx.lineTo(sx + 0.5, RULER_SIZE);
        ctx.stroke();
        if (!nearBand(sx, bandX)) ctx.fillText(formatRuler(wx - origin.x, unit), sx + 3, 10);
      }

      // Left (vertical) ruler — labels drawn rotated.
      const wy0 = (RULER_SIZE - view.ty) / view.scale;
      const wy1 = (h - view.ty) / view.scale;
      let wy = origin.y + Math.floor((wy0 - origin.y) / step) * step;
      for (; wy <= wy1; wy += step) {
        const sy = view.ty + wy * view.scale;
        if (sy < RULER_SIZE) continue;
        ctx.beginPath();
        ctx.moveTo(RULER_SIZE - 6, sy + 0.5);
        ctx.lineTo(RULER_SIZE, sy + 0.5);
        ctx.stroke();
        if (nearBand(sy, bandY)) continue;
        ctx.save();
        ctx.translate(10, sy - 3);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = "left";
        ctx.fillText(formatRuler(wy - origin.y, unit), 0, 0);
        ctx.restore();
      }

      // The band's two values, in accent, each set on its own side of the edge
      // so a narrow selection never stacks them.
      if (sel && bandX && bandY) {
        ctx.save();
        ctx.fillStyle = accent;
        ctx.strokeStyle = accent;
        ctx.font = "600 9px var(--font-jetbrains-mono), monospace";
        ctx.textBaseline = "alphabetic";
        const edgeTick = (x0: number, y0: number, x1: number, y1: number) => {
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();
        };
        for (const [i, sx] of bandX.entries()) {
          if (sx < RULER_SIZE || sx > w) continue;
          const v = formatRuler((i === 0 ? sel.minX : sel.maxX) - origin.x, unit);
          ctx.textAlign = i === 0 ? "right" : "left";
          ctx.fillText(v, i === 0 ? sx - 3 : sx + 3, 10);
          edgeTick(Math.round(sx) + 0.5, RULER_SIZE - 8, Math.round(sx) + 0.5, RULER_SIZE);
        }
        for (const [i, sy] of bandY.entries()) {
          if (sy < RULER_SIZE || sy > h) continue;
          const v = formatRuler((i === 0 ? sel.minY : sel.maxY) - origin.y, unit);
          ctx.save();
          ctx.translate(10, sy);
          ctx.rotate(-Math.PI / 2);
          ctx.textAlign = i === 0 ? "left" : "right";
          ctx.fillText(v, i === 0 ? 3 : -3, 0);
          ctx.restore();
          edgeTick(RULER_SIZE - 8, Math.round(sy) + 0.5, RULER_SIZE, Math.round(sy) + 0.5);
        }
        ctx.restore();
      }
    };
    draw();
    // The selection band reads the stage's hit rects, which the stage refreshes
    // on ITS next paint — so draw once more after it, or a just-made selection
    // (or a drag's latest move) shows a frame late or not at all.
    const raf = requestAnimationFrame(() => requestAnimationFrame(draw));
    const ro = new ResizeObserver(draw);
    ro.observe(root);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [rulers, unit, view, origin, theme, doc, selectedClipIds, selectedFrameIds]);

  if (!rulers) return null;

  return (
    <div ref={rootRef} data-ruler className="pointer-events-none absolute inset-0 z-20">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      {/* Interaction strips (top / left) + corner. */}
      <div
        className="pointer-events-auto absolute left-0 right-0 top-0 cursor-ns-resize"
        style={{ height: RULER_SIZE, left: RULER_SIZE }}
        onPointerDown={(e) => beginGuideDrag(e, "y", store)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      />
      <div
        className="pointer-events-auto absolute bottom-0 left-0 cursor-ew-resize"
        style={{ width: RULER_SIZE, top: RULER_SIZE }}
        onPointerDown={(e) => beginGuideDrag(e, "x", store)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      />
      <div className="pointer-events-auto absolute left-0 top-0" style={{ width: RULER_SIZE, height: RULER_SIZE }} />

      <Popover open={!!menu} onOpenChange={(o) => !o && setMenu(null)}>
        <PopoverAnchor asChild>
          <div className="pointer-events-none fixed" style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }} />
        </PopoverAnchor>
        <PopoverContent align="start" sideOffset={4} className="w-56 p-3">
          <RulerSettings heading />
        </PopoverContent>
      </Popover>
    </div>
  );
}
