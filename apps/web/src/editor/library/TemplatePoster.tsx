"use client";

import * as React from "react";
import { landingFrameId, type MotionDocument } from "@solomotion/core";
import { cn } from "@/lib/utils";
import { drawFrameContent } from "../stage/render/draw-frame";
import { templatePreviewDoc } from "./templates";

/**
 * A built-in template's card art: the comp it opens on (`landingFrameId`),
 * drawn by the real renderer from the document its build script makes
 * (`preview: render` — the library's
 * rule that what the app can draw itself, it draws). A still at rest, the
 * timeline looping while `playing`.
 */
const STILL_MS = 1800;

export function TemplatePoster({ templateId, playing, className }: { templateId: string; playing: boolean; className?: string }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = React.useState<MotionDocument | null>(null);

  React.useEffect(() => {
    let alive = true;
    void templatePreviewDoc(templateId).then((d) => alive && setDoc(d));
    return () => {
      alive = false;
    };
  }, [templateId]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    const landing = doc ? landingFrameId(doc) : null;
    const frame = doc?.frames.find((f) => f.id === landing);
    if (!canvas || !doc || !frame) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const box = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(box.width * dpr));
    canvas.height = Math.max(1, Math.round(box.height * dpr));
    // Cover, not contain: a poster fills its card.
    const s = Math.max(canvas.width / frame.width, canvas.height / frame.height);
    const ox = (canvas.width - frame.width * s) / 2;
    const oy = (canvas.height - frame.height * s) / 2;
    const draw = (t: number) => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(s, 0, 0, s, ox, oy);
      drawFrameContent(ctx, doc, frame, t);
    };
    if (!playing) {
      draw(STILL_MS);
      return;
    }
    const dur = frame.durationMs ?? doc.durationMs ?? 4000;
    const start = performance.now();
    let raf = 0;
    const loop = () => {
      draw((performance.now() - start) % dur);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [doc, playing]);

  return <canvas ref={canvasRef} className={cn("size-full", !doc && "animate-pulse bg-muted/40", className)} />;
}
