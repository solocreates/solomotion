"use client";

import { create } from "zustand";

/**
 * AI ACTIVITY — which layers (or comps) an AI job is working on RIGHT NOW,
 * so the canvas and the timeline can show it happening on the thing itself:
 * a live shimmer on the image being cut out, the clip being transcribed, the
 * comp a video is being generated into.
 *
 * Session state, never the document: it lives exactly as long as the job and
 * is nobody's undo. Written in ONE place (`agent/call.ts`, the wrapper every
 * registry call goes through — the chat agent, the right-click menu, external
 * MCP agents), read by the stage overlay and the timeline clips. Nothing here
 * imports the agent, so reading it costs the main bundle a few lines.
 */

export interface AiJob {
  id: string;
  /** Layers the job touches (their painted boxes shimmer). */
  clipIds: string[];
  /** A comp that is receiving something not made yet (a ghost card shows there). */
  frameId: string | null;
  /** "Cutting out", "Transcribing", "Shooting video". */
  label: string;
  /** "Generating · 40%" — the provider's own words, when it has any. */
  progress: string | null;
  startedAt: number;
}

interface AiActivityState {
  jobs: Record<string, AiJob>;
}

export const useAiActivity = create<AiActivityState>(() => ({ jobs: {} }));

let counter = 0;

/**
 * ONE STORE WRITE PER FRAME, however many calls land in it. An agent building
 * a scene fires a write every few milliseconds, and each began and ended its
 * own job — two store updates per call, each re-rendering the overlay and the
 * clip's timeline row, which made a call several times dearer on a focused,
 * busy comp than the edit it was announcing. Starts, progress and ends are
 * queued and applied together on the next frame; nobody can see a shimmer
 * sooner than that anyway.
 */
type JobsOp = (jobs: Record<string, AiJob>) => Record<string, AiJob>;
let queued: JobsOp[] = [];
let flushScheduled = false;

function flush(): void {
  flushScheduled = false;
  const ops = queued;
  queued = [];
  useAiActivity.setState((s) => {
    const jobs = ops.reduce((acc, op) => op(acc), s.jobs);
    return jobs === s.jobs ? s : { jobs };
  });
}

function enqueue(op: JobsOp): void {
  queued.push(op);
  if (flushScheduled) return;
  flushScheduled = true;
  // A hidden tab draws nothing, and its animation frames never come: a timer
  // still lands the queue there.
  if (typeof requestAnimationFrame === "function" && typeof document !== "undefined" && document.visibilityState === "visible") requestAnimationFrame(flush);
  else setTimeout(flush, 16);
}

/** Start showing work; returns how to update and end it. */
export function beginAiWork(target: { clipIds?: string[]; frameId?: string | null }, label: string) {
  const id = `ai_${(counter++).toString(36)}`;
  const job: AiJob = { id, clipIds: target.clipIds ?? [], frameId: target.frameId ?? null, label, progress: null, startedAt: Date.now() };
  enqueue((jobs) => ({ ...jobs, [id]: job }));
  return {
    progress(text: string) {
      enqueue((jobs) => (jobs[id] ? { ...jobs, [id]: { ...jobs[id]!, progress: text } } : jobs));
    },
    end() {
      enqueue((jobs) => {
        if (!jobs[id]) return jobs;
        const { [id]: _gone, ...rest } = jobs;
        return rest;
      });
    },
  };
}

/** The job working on this layer, if any — for a timeline clip. */
export function useAiWorkOn(clipId: string): AiJob | null {
  return useAiActivity((s) => {
    for (const j of Object.values(s.jobs)) if (j.clipIds.includes(clipId)) return j;
    return null;
  });
}
