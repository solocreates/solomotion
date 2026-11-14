"use client";

import * as React from "react";
import type { BrushEngine } from "@solomotion/core";
import { Brush, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FloatingWindow, type WindowBounds } from "@/components/ui/floating-window";
import { useBrushLibrary } from "../drawing/drawing-store";
import { BrushBrowser } from "./BrushBrowser";

/**
 * The brush library, in a window.
 *
 * A window rather than a popover, because choosing a brush is not a one-click
 * errand you want dismissed the moment you look away: you compare marks, you
 * open one in the studio, you drag it into a folder, you come back. A popover
 * that closes on the first outside click makes all of that a fight.
 *
 * It is also the SAME window for pixel brushes, vector brushes and the eraser —
 * `slot` is the only difference, and it decides which brush a pick arms. Three
 * pickers that looked alike would have drifted the first time one of them
 * grew a feature; there is one, so they cannot.
 */
export function BrushLibraryWindow() {
  const slot = useBrushLibrary((s) => s.librarySlot);
  const openLibrary = useBrushLibrary((s) => s.openLibrary);
  const lib = useBrushLibrary();
  const [bounds, setBounds] = React.useState<WindowBounds | null>(null);

  React.useEffect(() => {
    if (slot && !bounds) {
      const width = Math.min(760, window.innerWidth - 80);
      const height = Math.min(560, window.innerHeight - 120);
      setBounds({
        x: Math.max(24, (window.innerWidth - width) / 2),
        y: Math.max(24, (window.innerHeight - height) / 2),
        width,
        height,
        minimized: false,
      });
    }
  }, [slot, bounds]);

  if (!slot || !bounds) return null;
  const engine: BrushEngine = slot === "vector" ? "vector" : "raster";

  return (
    <FloatingWindow
      title={slot === "eraser" ? "Erasers" : engine === "vector" ? "Vector brushes" : "Pixel brushes"}
      icon={<Brush className="size-3.5" />}
      bounds={bounds}
      windowId="brush-library"
      minWidth={560}
      minHeight={360}
      onBoundsChange={(patch) => setBounds((b) => (b ? { ...b, ...patch } : b))}
      onToggleMinimize={() => setBounds((b) => (b ? { ...b, minimized: !b.minimized } : b))}
      onClose={() => openLibrary(null)}
      titleActions={
        <Button
          size="xs"
          variant="ghost"
          className="gap-1 text-[11px]"
          onClick={() => lib.openStudio(lib.createBrush(engine).id)}
        >
          <Plus className="size-3" /> New
        </Button>
      }
      // Two panes that own their own scrollers.
      body="fill"
    >
      <BrushBrowser
        engine={engine}
        activeId={lib.activeBrushId(slot)}
        onPick={(brush) => lib.setActiveBrush(slot, brush.id)}
        onEdit={(brush) => lib.openStudio(brush.id)}
        className="h-full"
      />
    </FloatingWindow>
  );
}
