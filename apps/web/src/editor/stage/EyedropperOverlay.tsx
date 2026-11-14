"use client";

import * as React from "react";
import { formatHex } from "@/lib/color";
import { useEyedrop } from "@/lib/eyedropper";

/**
 * The glass-loupe pick surface — a macOS-style magnifier centered on the
 * cursor: a circular zoom of the REAL stage canvas with a crisp pixel grid,
 * the center pixel ringed, and a live hex chip underneath. It re-samples every
 * animation frame, so picking during playback is exact. Click picks, Esc or
 * right-click cancels. Mounted by Stage over its canvas; activated through
 * the headless eyedropper service.
 */

const LOUPE = 148; // css px diameter
const CELLS = 15; // sampled pixel grid (odd → true center pixel)

export function EyedropperOverlay({
  canvasRef,
}: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
}) {
  const active = useEyedrop((s) => s.active);
  const registerSurface = useEyedrop((s) => s.registerSurface);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const loupeRef = React.useRef<HTMLDivElement>(null);
  const zoomRef = React.useRef<HTMLCanvasElement>(null);
  const chipRef = React.useRef<HTMLDivElement>(null);
  // Cursor in client coords + the current sample, outside React state — the
  // loupe follows at rAF cadence with zero re-renders.
  const pointer = React.useRef<{ x: number; y: number } | null>(null);
  const hexRef = React.useRef<string>("#000000");

  React.useEffect(() => registerSurface(), [registerSurface]);

  React.useEffect(() => {
    if (!active) {
      pointer.current = null;
      return;
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        useEyedrop.getState().finish(null);
      }
    };
    window.addEventListener("keydown", onKey, true);

    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const canvas = canvasRef.current;
      const root = rootRef.current;
      const loupe = loupeRef.current;
      const zoom = zoomRef.current;
      const chip = chipRef.current;
      const p = pointer.current;
      if (!canvas || !root || !loupe || !zoom || !chip) return;
      if (!p) {
        loupe.style.opacity = "0";
        return;
      }
      loupe.style.opacity = "1";

      const rootRect = root.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();
      const dpr = canvas.width / Math.max(canvasRect.width, 1);
      const cx = Math.round((p.x - canvasRect.left) * dpr);
      const cy = Math.round((p.y - canvasRect.top) * dpr);
      const half = (CELLS - 1) / 2;

      // Magnified pixels — straight from the live canvas, no smoothing.
      const zctx = zoom.getContext("2d");
      if (zctx) {
        const size = zoom.width; // backing px, square
        zctx.imageSmoothingEnabled = false;
        zctx.clearRect(0, 0, size, size);
        zctx.drawImage(canvas, cx - half, cy - half, CELLS, CELLS, 0, 0, size, size);
        // Pixel grid + ringed center cell.
        const cell = size / CELLS;
        zctx.strokeStyle = "rgba(255,255,255,0.14)";
        zctx.lineWidth = 1;
        zctx.beginPath();
        for (let i = 1; i < CELLS; i++) {
          zctx.moveTo(i * cell + 0.5, 0);
          zctx.lineTo(i * cell + 0.5, size);
          zctx.moveTo(0, i * cell + 0.5);
          zctx.lineTo(size, i * cell + 0.5);
        }
        zctx.stroke();
        zctx.strokeStyle = "rgba(0,0,0,0.85)";
        zctx.lineWidth = 2;
        zctx.strokeRect(half * cell - 1, half * cell - 1, cell + 2, cell + 2);
        zctx.strokeStyle = "#ffffff";
        zctx.strokeRect(half * cell + 1, half * cell + 1, cell - 2, cell - 2);
      }

      // Center pixel → hex readout + tinted ring.
      const cctx = canvas.getContext("2d");
      if (cctx && cx >= 0 && cy >= 0 && cx < canvas.width && cy < canvas.height) {
        const d = cctx.getImageData(cx, cy, 1, 1).data;
        hexRef.current = formatHex({ r: d[0]!, g: d[1]!, b: d[2]!, a: 1 }).toUpperCase();
      }
      chip.textContent = hexRef.current;
      loupe.style.setProperty("--sample", hexRef.current);
      loupe.style.transform = `translate(${p.x - rootRect.left - LOUPE / 2}px, ${p.y - rootRect.top - LOUPE / 2}px)`;
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [active, canvasRef]);

  if (!active) return null;

  return (
    <div
      ref={rootRef}
      data-eyedrop-overlay
      className="absolute inset-0 z-50 cursor-none touch-none select-none"
      onPointerMove={(e) => {
        pointer.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerLeave={() => {
        pointer.current = null;
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.button !== 0) {
          useEyedrop.getState().finish(null);
          return;
        }
        useEyedrop.getState().finish(pointer.current ? hexRef.current : null);
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        ref={loupeRef}
        className="pointer-events-none absolute left-0 top-0 opacity-0 will-change-transform"
        style={{ width: LOUPE, height: LOUPE }}
      >
        {/* Glass circle: magnified pixels, inner glass sheen, sample-tinted ring. */}
        <div
          className="absolute inset-0 overflow-hidden rounded-full shadow-[0_12px_40px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.25)]"
          style={{
            border: "3px solid var(--sample, #888)",
            outline: "1.5px solid rgba(255,255,255,0.35)",
            outlineOffset: "-0.5px",
            boxShadow:
              "0 12px 40px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(0,0,0,0.5), inset 0 14px 24px rgba(255,255,255,0.08)",
          }}
        >
          <canvas
            ref={zoomRef}
            width={LOUPE * 2}
            height={LOUPE * 2}
            className="h-full w-full"
          />
          {/* Glass highlight sweep. */}
          <div className="pointer-events-none absolute inset-0 rounded-full bg-[radial-gradient(ellipse_at_30%_18%,rgba(255,255,255,0.18),transparent_45%)]" />
        </div>
        {/* Hex chip below the lens. */}
        <div
          ref={chipRef}
          className="absolute left-1/2 top-full mt-2 -translate-x-1/2 rounded-md border border-white/10 bg-[#131316]/95 px-2 py-0.5 font-mono text-[11px] tabular-nums text-white shadow-lg backdrop-blur"
        />
      </div>
    </div>
  );
}
