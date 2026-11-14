"use client";

import * as React from "react";
import { clipPlaybackOf, clipSourceCapacityMs, locateClip, setClipPlayback } from "@solomotion/core";
import { Repeat, Snowflake, Turtle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";

/**
 * Shown when a trim stretches a play-once media clip past its footage — the
 * user picks what fills the extra time (the DaVinci/Premiere question, asked
 * instead of guessed):
 *
 *   Loop      — the footage starts over (loop mode)
 *   Stretch   — the clip slows down so the footage exactly fills the new length
 *   Freeze    — the last frame holds (also what dismissing picks: it's the
 *               only choice that changes nothing)
 */
export function FootageOverrunDialog() {
  const doc = useDoc();
  const store = useDocStore();
  const clipId = useSession((s) => s.footageOverrunClipId);

  const loc = clipId ? locateClip(doc, clipId) : null;
  const capacityMs = loc ? clipSourceCapacityMs(doc, loc.clip) : null;
  // The clip may have been undone/deleted, or no longer overrun — nothing to ask.
  const open = !!loc && capacityMs !== null && loc.clip.durationMs > capacityMs + 1;

  const close = () => useSession.getState().setFootageOverrun(null);

  const chooseLoop = () => {
    store.update("Loop footage", (d) => {
      const l = clipId ? locateClip(d, clipId) : null;
      if (l) setClipPlayback(l.clip, { loop: "loop" });
    });
    close();
  };

  const stretchSpeed = (() => {
    if (!loc || capacityMs === null) return null;
    const pb = clipPlaybackOf(loc.clip);
    if (!pb) return null;
    const rawSourceMs = capacityMs * (pb.speed > 0 ? pb.speed : 1);
    return Math.min(16, Math.max(0.05, rawSourceMs / loc.clip.durationMs));
  })();

  const chooseStretch = () => {
    store.update("Stretch speed to fit footage", (d) => {
      const l = clipId ? locateClip(d, clipId) : null;
      const pb = l ? clipPlaybackOf(l.clip) : null;
      if (l && pb && stretchSpeed !== null) pb.speed = stretchSpeed;
    });
    close();
  };

  const overrunSec = loc && capacityMs !== null ? (loc.clip.durationMs - capacityMs) / 1000 : 0;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Clip is longer than its footage</DialogTitle>
          <DialogDescription>
            The clip now runs {overrunSec.toFixed(1)}s past the end of its media. What should fill
            the extra time?
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <OverrunChoice
            icon={<Repeat className="size-4" />}
            title="Loop footage"
            hint="Start the media over each time it runs out"
            onClick={chooseLoop}
          />
          <OverrunChoice
            icon={<Turtle className="size-4" />}
            title={`Stretch to fit${stretchSpeed !== null ? ` · ${stretchSpeed.toFixed(2)}×` : ""}`}
            hint="Slow the clip down so the footage exactly fills it"
            onClick={chooseStretch}
          />
          <OverrunChoice
            icon={<Snowflake className="size-4" />}
            title="Freeze last frame"
            hint="Hold the final frame for the remainder (keep as-is)"
            onClick={close}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function OverrunChoice({
  icon,
  title,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:border-primary/60 hover:bg-primary/10"
    >
      <span className="text-primary">{icon}</span>
      <span className="flex flex-col">
        <span className="text-sm font-semibold">{title}</span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}
