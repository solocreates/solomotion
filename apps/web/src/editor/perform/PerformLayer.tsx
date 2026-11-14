"use client";

import * as React from "react";
import { X } from "lucide-react";
import { useSession } from "../state/session";
import { usePerform } from "./state";
import { lazyComponent } from "@/editor/lazy-component";

const PerformOverlay = lazyComponent("PerformOverlay", () => import("./PerformOverlay"));

/** The stage's Perform slot: nothing until the mode is on, then the lazy surface and pad. */
export function PerformLayer() {
  const active = usePerform((s) => s.active);
  if (!active) return null;
  return (
    <React.Suspense fallback={null}>
      <PerformOverlay />
    </React.Suspense>
  );
}

/** The context bar's way out: `Perform ✕`, with `● Rec` and the count-in on it. */
export function PerformChip() {
  const countIn = usePerform((s) => s.countIn);
  const recording = useSession((s) => s.recording);
  return (
    <button
      type="button"
      title="Leave Perform (Esc)"
      onClick={() => usePerform.getState().exit()}
      className="flex items-center gap-1 rounded-lg bg-primary/15 px-1.5 py-1 font-medium text-primary transition-colors hover:bg-primary/25"
    >
      Perform
      {countIn !== null ? (
        <span className="tabular-nums">{countIn === 2 ? "1…" : "1… 2…"}</span>
      ) : (
        recording && <span className="text-red-500">● Rec</span>
      )}
      <X className="size-3" />
    </button>
  );
}
