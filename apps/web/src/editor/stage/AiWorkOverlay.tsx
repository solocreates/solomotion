"use client";

import * as React from "react";
import { Sparkles } from "lucide-react";
import { useAiActivity, type AiJob } from "../state/ai-activity";
import { useDocStore } from "../state/document-context";
import { useStageView } from "../state/session";
import { stageHitRects } from "./stage-geometry";

/**
 * AI WORK ON THE CANVAS — while an AI job touches a layer, the layer itself
 * shows it: a turning gradient ring on its painted box (rotation included), a
 * sheen sweeping across, a slow glow, and a glass pill saying what is
 * happening ("Cutting out · Generating 40%"). A job still making something
 * with nowhere to land yet shows a ghost card in its comp instead.
 *
 * Pure chrome over the canvas: pointer-transparent, in screen pixels so it
 * stays crisp at any zoom, following pan/zoom and the layer's own motion
 * (the painted boxes are re-read every frame while work is on — they change
 * during playback and as the job writes).
 */

interface Box {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  job: AiJob;
  ghost: boolean;
}

/** "Drawing" + "Drawing…" says it twice; the progress only earns its place when it adds something. */
const echoes = (label: string, progress: string) => progress.toLowerCase().replace(/[.…]+$/, "").startsWith(label.toLowerCase());

export function AiWorkOverlay() {
  const jobs = useAiActivity((s) => s.jobs);
  const active = Object.values(jobs);
  const store = useDocStore();
  const [boxes, setBoxes] = React.useState<Box[]>([]);

  React.useEffect(() => {
    if (!active.length) {
      setBoxes([]);
      return;
    }
    let raf = 0;
    let last = "";
    const tick = () => {
      const { scale, tx, ty } = useStageView.getState();
      const next: Box[] = [];
      for (const job of active) {
        let found = false;
        for (const clipId of job.clipIds) {
          // One box per layer: its shallowest painting (an instance repeats it).
          const h = stageHitRects.current.find((r) => r.clipId === clipId);
          if (!h) continue;
          found = true;
          next.push({ key: `${job.id}:${clipId}`, x: tx + h.cx * scale, y: ty + h.cy * scale, w: Math.max(12, h.width * scale), h: Math.max(12, h.height * scale), rotation: h.rotation, job, ghost: false });
        }
        const frame = job.frameId ? store.getState().frames.find((f) => f.id === job.frameId) : null;
        if (!found && frame) {
          const w = Math.max(140, frame.width * scale * 0.42);
          const hgt = Math.max(84, frame.height * scale * 0.42);
          next.push({ key: `${job.id}:ghost`, x: tx + (frame.x + frame.width / 2) * scale, y: ty + (frame.y + frame.height / 2) * scale, w, h: hgt, rotation: 0, job, ghost: true });
        }
      }
      const sig = next.map((b) => `${b.key}|${Math.round(b.x)}|${Math.round(b.y)}|${Math.round(b.w)}|${Math.round(b.h)}|${Math.round(b.rotation)}|${b.job.progress}`).join(";");
      if (sig !== last) {
        last = sig;
        setBoxes(next);
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
    // `jobs` identity changes whenever a job starts, ends or reports progress.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, store]);

  if (!boxes.length) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden" aria-live="polite">
      {boxes.map((b) => (
        <div
          key={b.key}
          className="absolute"
          style={{ left: b.x, top: b.y, width: b.w, height: b.h, transform: `translate(-50%, -50%) rotate(${b.rotation}deg)` }}
        >
          <div className={b.ghost ? "ai-work inset-0 rounded-xl border border-dashed border-primary/40" : "ai-work inset-0"} />
          <div
            className="agent-rise absolute left-1/2 flex max-w-[min(320px,80vw)] -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full border border-white/10 bg-background/70 px-2.5 py-1 text-2xs font-medium text-foreground shadow-lg backdrop-blur-md"
            style={{ top: b.ghost ? "50%" : -30, transform: `translateX(-50%) ${b.ghost ? "translateY(-50%)" : ""} rotate(${-b.rotation}deg)` }}
          >
            <Sparkles className="size-3 shrink-0 text-primary" />
            <span className="agent-shimmer">{b.job.label}</span>
            {b.job.progress && !echoes(b.job.label, b.job.progress) && <span className="truncate text-muted-foreground">· {b.job.progress}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
