"use client";

import * as React from "react";
import { drawWaveform } from "../audio/waveform";
import { cn } from "@/lib/utils";

/**
 * A waveform drawn from PUBLISHED peaks — no `AudioBuffer`, no download, no
 * decode.
 *
 * This is the single detail that makes an online sound card feel like a local
 * one: before a byte of audio is fetched, the card already shows the real
 * shape, at the real length, with the hit marked where it will land. A library
 * of grey placeholder rectangles is a library nobody browses.
 *
 * It shares `drawWaveform` with the timeline and the picker, so a sound looks
 * the same in all three — and visibly does NOT change the moment you download
 * it, which is what would happen if published and decoded peaks came from two
 * different binners (they don't; see `peaksFromSamples`).
 */
export function PeaksWave({
  peaks,
  durationMs,
  hitMs,
  playing = false,
  className,
}: {
  peaks: number[];
  durationMs: number;
  hitMs: number;
  playing?: boolean;
  className?: string;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const [progress, setProgress] = React.useState(0);

  // The audition sweep. It runs for exactly the AUDIBLE length of the sound —
  // the same number `useSoundShape` measures and the same one the manifest
  // publishes — so it reaches the end of every sound, not just the ones whose
  // file length happened to match. Floored at 220 ms because a 40 ms click is
  // over before the eye can follow it, and the point of the sweep is to be seen.
  React.useEffect(() => {
    if (!playing) {
      setProgress(0);
      return;
    }
    const runMs = Math.max(220, durationMs);
    let raf = 0;
    const start = performance.now();
    const tick = () => {
      const t = Math.min(1, (performance.now() - start) / runMs);
      setProgress(t);
      if (t < 1) raf = requestAnimationFrame(tick);
      else setProgress(0); // settle back to the resting look
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, durationMs]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Resting state is NEUTRAL and the played part is accented — a wall of
    // brand colour makes every sound look selected, and then the one you are
    // actually hearing has nothing left to say. Both colours come from the
    // element's own computed style, so themes need no second definition.
    const style = getComputedStyle(canvas);
    const base = style.color;
    const played = style.getPropertyValue("--tm-wave-played").trim() || base;
    const data = Float32Array.from(peaks);
    ctx.globalAlpha = 0.55;
    drawWaveform(ctx, data, { x: 0, y: 0, w, h }, base);
    if (progress > 0 && progress < 1) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, w * progress, h);
      ctx.clip();
      ctx.globalAlpha = 1;
      drawWaveform(ctx, data, { x: 0, y: 0, w, h }, played);
      ctx.restore();
    }

    // Where it strikes. A thin tick, not a label — the number is in the row.
    if (durationMs > 0 && hitMs > 0.5) {
      const x = Math.round((hitMs / durationMs) * w) + 0.5;
      if (x < w) {
        ctx.globalAlpha = 0.55;
        ctx.strokeStyle = base;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
    }
  }, [peaks, progress, hitMs, durationMs]);

  return <canvas ref={canvasRef} className={cn("block", className)} />;
}
