"use client";

import * as React from "react";
import { Activity } from "lucide-react";
import { FloatingWindow, type WindowBounds } from "@/components/ui/floating-window";
import { cn } from "@/lib/utils";
import { useSession } from "../state/session";
import { renderProfiler } from "./render/profiler-instance";
import type { FrameProfile } from "@solomotion/core";

/**
 * RENDER COST — which layer is spending the frame.
 *
 * This is the honest version of the "activity monitor" a canvas app cannot
 * actually build. We will not invent a GPU number we have no way to measure,
 * but we can say exactly where our own renderer spent its milliseconds, because
 * every layer in the app funnels through one function — and that is almost
 * always the number that answers "why is this slow".
 *
 * It reads a module singleton on a timer rather than subscribing to a store:
 * the profiler is written to dozens of times per frame, and re-rendering React
 * at that rate to display a performance readout would make the readout the
 * problem it is reporting.
 */

/** ms → a 0..1 share of the row's bar, against the frame's own worst layer. */
function share(ms: number, max: number) {
  return max <= 0 ? 0 : Math.max(0.02, Math.min(1, ms / max));
}

export function PerfHud() {
  const open = useSession((s) => s.perfHud);
  const [profile, setProfile] = React.useState<FrameProfile | null>(null);
  const [bounds, setBounds] = React.useState<WindowBounds | null>(null);

  React.useEffect(() => {
    if (!open) {
      renderProfiler.reset();
      setProfile(null);
      return;
    }
    // Four reads a second: fast enough to feel live, slow enough that the HUD
    // itself never shows up in its own list.
    const id = window.setInterval(() => setProfile(renderProfiler.read()), 250);
    return () => window.clearInterval(id);
  }, [open]);

  // Bottom-right on first open, like a devtools panel.
  React.useEffect(() => {
    if (open && !bounds) {
      const width = 280;
      const height = 300;
      setBounds({
        x: Math.max(16, window.innerWidth - width - 72),
        y: Math.max(16, window.innerHeight - height - 96),
        width,
        height,
        minimized: false,
      });
    }
  }, [open, bounds]);

  if (!open || !bounds) return null;

  const rows = (profile?.layers ?? []).slice(0, 8);
  const frames = profile?.frames ?? 0;
  const perFrame = frames > 0 ? (profile?.totalMs ?? 0) / frames : 0;
  const worst = rows[0]?.totalMs ?? 0;

  return (
    <FloatingWindow
      title="Render cost"
      icon={<Activity className="size-3.5" />}
      bounds={bounds}
      onBoundsChange={(patch) => setBounds((b) => (b ? { ...b, ...patch } : b))}
      onClose={() => useSession.getState().setPerfHud(false)}
      onToggleMinimize={() => setBounds((b) => (b ? { ...b, minimized: !b.minimized } : b))}
      windowId="perf-hud"
      titleActions={
        <span className="font-mono text-2xs tabular-nums text-foreground/70">
          {perFrame > 0 ? `${perFrame.toFixed(1)} ms` : "—"}
        </span>
      }
    >
      <div className="p-2">

      {rows.length === 0 ? (
        <div className="px-1 py-2 text-[10px] text-muted-foreground">Move the playhead to sample.</div>
      ) : (
        <div className="space-y-1">
          {rows.map((r) => {
            const ms = frames > 0 ? r.totalMs / frames : 0;
            const blurMs = frames > 0 ? r.motionBlurMs / frames : 0;
            // The motion-blur share is drawn INSIDE the layer's own bar rather
            // than as a second row: the question is never "how much motion
            // blur" in the abstract, it is "how much of THIS layer is blur",
            // and a nested bar is that sentence.
            const blurShare = r.totalMs > 0 ? Math.min(1, r.motionBlurMs / r.totalMs) : 0;
            return (
              <div key={r.clipId} className="px-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate text-[10px] text-foreground/85">{r.name}</span>
                  <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                    {ms.toFixed(2)}
                  </span>
                </div>
                <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-input/50">
                  <div
                    className="h-full rounded-full bg-foreground/35"
                    style={{ width: `${share(r.totalMs, worst) * 100}%` }}
                  >
                    <div
                      className={cn("h-full rounded-full")}
                      style={{
                        width: `${blurShare * 100}%`,
                        background: "var(--primary)",
                      }}
                    />
                  </div>
                </div>
                {blurMs > 0.01 && (
                  <div className="mt-0.5 text-[9px] text-muted-foreground/70">
                    shutter {blurMs.toFixed(2)} ms ·{" "}
                    {r.calls > 0 ? Math.round(r.motionBlurSamples / r.calls) : 0} samples
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      </div>
    </FloatingWindow>
  );
}
