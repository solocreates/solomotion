"use client";

import * as React from "react";
import {
  SKIN_TONE_ANGLE,
  VECTORSCOPE_TARGETS,
  computeScope,
  type ScopeData,
  type ScopeKind,
} from "@solomotion/core";
import { cn } from "@/lib/utils";
import { useColorStore } from "./color-store";
import { getStageFrameSample } from "../stage/frame-sample";

/**
 * SCOPES — the measurement half of the page.
 *
 * The maths is headless (`grade/scopes.ts`); this is the painter, and the split
 * matters: a scope is a statistic over pixels, and a statistic belongs where a
 * test can reach it. What lives here is the part that is genuinely about
 * drawing — the graticules, the trace colours, the way a density becomes light.
 *
 * TRACES ARE DRAWN ADDITIVELY, which is the whole look of a real scope: one
 * bright pixel is faint, a thousand stacked on the same value is a solid line,
 * and the eye reads the shape of the distribution rather than a silhouette.
 * `globalCompositeOperation = "lighter"` is doing that, not decoration.
 */

const SCOPES: Array<{ kind: ScopeKind; label: string; hint: string }> = [
  { kind: "waveform", label: "Waveform", hint: "Brightness across the frame — the fastest way to see clipping" },
  { kind: "parade", label: "Parade", hint: "R, G and B side by side — where a colour cast comes from" },
  { kind: "vectorscope", label: "Vector", hint: "Hue and saturation. Faces should sit on the diagonal line" },
  { kind: "histogram", label: "Histogram", hint: "How much of each tone the frame holds" },
];

export function Scopes({ className }: { className?: string }) {
  const scope = useColorStore((s) => s.scope);
  const setScope = useColorStore((s) => s.setScope);

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex shrink-0 items-center gap-0.5 border-b border-border/60 px-1.5 py-1">
        {SCOPES.map((s) => (
          <button
            key={s.kind}
            type="button"
            title={s.hint}
            onClick={() => setScope(s.kind)}
            className={cn(
              "h-6 rounded px-2 text-[11px] transition-colors",
              scope === s.kind ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted",
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 p-1.5">
        <ScopeCanvas kind={scope} />
      </div>
    </div>
  );
}

/**
 * One scope, repainted whenever the stage does.
 *
 * It subscribes to the stage's frame sampler rather than polling: the scope must
 * show THIS frame, and a scope that lags the picture by a frame is worse than
 * none at all when you are chasing a highlight. Sampling is throttled by the
 * sampler itself (see `stage/frame-sample.ts`), so a scrub does not turn into a
 * per-frame `getImageData` of a 4K canvas.
 */
function ScopeCanvas({ kind }: { kind: ScopeKind }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [data, setData] = React.useState<ScopeData | null>(null);
  const [size, setSize] = React.useState({ w: 240, h: 160 });

  // Size from the box, so the scope fills whatever column it is given.
  React.useEffect(() => {
    const el = canvasRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  React.useEffect(() => {
    return getStageFrameSample((frame) => {
      if (!frame) {
        setData(null);
        return;
      }
      const w = kind === "histogram" ? 256 : Math.max(64, Math.min(512, Math.round(size.w)));
      const h = kind === "histogram" ? 1 : Math.max(64, Math.min(320, Math.round(size.h)));
      setData(computeScope(frame, kind, { width: w, height: h }));
    });
  }, [kind, size.w, size.h]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(size.w * dpr));
    canvas.height = Math.max(1, Math.round(size.h * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paint(ctx, size.w, size.h, kind, data);
  }, [data, kind, size.w, size.h]);

  return (
    <div className="relative h-full w-full overflow-hidden rounded-md bg-[#08090b]">
      <canvas ref={canvasRef} className="h-full w-full" />
      {!data && (
        <div className="absolute inset-0 grid place-items-center text-[11px] text-muted-foreground">
          Nothing on the canvas to measure
        </div>
      )}
    </div>
  );
}

const GRID = "rgba(255,255,255,0.09)";
const CHANNEL = ["rgba(255,72,72,", "rgba(72,255,120,", "rgba(96,150,255,"];
const LUMA = "rgba(210,225,255,";

function paint(ctx: CanvasRenderingContext2D, w: number, h: number, kind: ScopeKind, data: ScopeData | null): void {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#08090b";
  ctx.fillRect(0, 0, w, h);
  if (!data) return;

  if (kind === "vectorscope") {
    paintVectorscope(ctx, w, h, data);
    return;
  }

  // IRE graticule at 0/25/50/75/100, the lines a colourist actually reads.
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = Math.round((i / 4) * (h - 1)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  if (kind === "histogram") {
    paintHistogram(ctx, w, h, data);
    return;
  }

  // Waveform / parade: each plane gets its own column band.
  const planes = data.planes.length;
  const bandW = w / planes;
  ctx.globalCompositeOperation = "lighter";
  const img = ctx.createImageData(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  const out = img.data;
  for (let p = 0; p < planes; p++) {
    const tint = planes === 1 ? [210, 225, 255] : p === 0 ? [255, 72, 72] : p === 1 ? [72, 255, 120] : [96, 150, 255];
    const plane = data.planes[p]!;
    for (let y = 0; y < img.height; y++) {
      const sy = Math.min(data.height - 1, Math.floor((y / img.height) * data.height));
      for (let x = 0; x < bandW; x++) {
        const sx = Math.min(data.width - 1, Math.floor((x / bandW) * data.width));
        // A gamma on the density, because a linear map makes everything but the
        // brightest column invisible — the trace IS the low counts.
        const v = Math.min(1, Math.pow(plane[sy * data.width + sx]!, 0.4) * 1.35);
        if (v <= 0.004) continue;
        const px = Math.round(p * bandW + x);
        if (px < 0 || px >= img.width) continue;
        const i = (y * img.width + px) * 4;
        out[i] = Math.min(255, out[i]! + tint[0]! * v);
        out[i + 1] = Math.min(255, out[i + 1]! + tint[1]! * v);
        out[i + 2] = Math.min(255, out[i + 2]! + tint[2]! * v);
        out[i + 3] = 255;
      }
    }
  }
  ctx.globalCompositeOperation = "source-over";
  // Composite the trace over the graticule rather than replacing it.
  const off = document.createElement("canvas");
  off.width = img.width;
  off.height = img.height;
  off.getContext("2d")!.putImageData(img, 0, 0);
  ctx.globalCompositeOperation = "lighter";
  ctx.drawImage(off, 0, 0, w, h);
  ctx.globalCompositeOperation = "source-over";

  if (planes === 3) {
    ctx.strokeStyle = GRID;
    for (let p = 1; p < 3; p++) {
      const x = Math.round(p * bandW) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }
}

function paintHistogram(ctx: CanvasRenderingContext2D, w: number, h: number, data: ScopeData): void {
  ctx.globalCompositeOperation = "lighter";
  for (let p = 0; p < data.planes.length; p++) {
    const plane = data.planes[p]!;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i < plane.length; i++) {
      const x = (i / (plane.length - 1)) * w;
      const y = h - Math.pow(plane[i]!, 0.42) * (h - 2);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = `${CHANNEL[p] ?? LUMA}0.34)`;
    ctx.fill();
    ctx.strokeStyle = `${CHANNEL[p] ?? LUMA}0.85)`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.globalCompositeOperation = "source-over";
}

function paintVectorscope(ctx: CanvasRenderingContext2D, w: number, h: number, data: ScopeData): void {
  const size = Math.min(w, h);
  const ox = (w - size) / 2;
  const oy = (h - size) / 2;
  const cx = ox + size / 2;
  const cy = oy + size / 2;
  const r = size / 2 - 6;

  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  for (const k of [0.25, 0.5, 0.75, 1]) {
    ctx.beginPath();
    ctx.arc(cx, cy, r * k, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(cx - r, cy);
  ctx.lineTo(cx + r, cy);
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx, cy + r);
  ctx.stroke();

  // THE SKIN-TONE LINE. Not decoration: it is the single most-used reference on
  // the scope, and a vectorscope without it is a pretty circle.
  ctx.strokeStyle = "rgba(255,190,150,0.45)";
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(SKIN_TONE_ANGLE) * r, cy - Math.sin(SKIN_TONE_ANGLE) * r);
  ctx.stroke();
  ctx.setLineDash([]);

  // The 75% bar targets, at their real Cb/Cr positions.
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.font = "9px ui-sans-serif, system-ui";
  for (const t of VECTORSCOPE_TARGETS) {
    const x = cx + (t.x - 0.5) * 2 * r;
    const y = cy + (t.y - 0.5) * 2 * r;
    ctx.strokeStyle = "rgba(255,255,255,0.28)";
    ctx.strokeRect(x - 4, y - 4, 8, 8);
    ctx.fillText(t.label, x + 6, y + 3);
  }

  const plane = data.planes[0]!;
  const img = ctx.createImageData(data.width, data.height);
  const out = img.data;
  for (let i = 0; i < plane.length; i++) {
    const v = Math.min(1, Math.pow(plane[i]!, 0.36) * 1.5);
    if (v <= 0.004) continue;
    const j = i * 4;
    out[j] = 120 * v + 135 * v;
    out[j + 1] = 255 * v;
    out[j + 2] = 190 * v;
    out[j + 3] = 255;
  }
  const off = document.createElement("canvas");
  off.width = data.width;
  off.height = data.height;
  off.getContext("2d")!.putImageData(img, 0, 0);
  ctx.globalCompositeOperation = "lighter";
  ctx.drawImage(off, cx - r, cy - r, r * 2, r * 2);
  ctx.globalCompositeOperation = "source-over";
}
