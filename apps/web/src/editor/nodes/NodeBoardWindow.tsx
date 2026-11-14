"use client";

import * as React from "react";
import { Waypoints } from "lucide-react";
import { FloatingWindow, type WindowBounds } from "@/components/ui/floating-window";
import { useBoardStore } from "./board-store";
import { NodeBoardHost } from "./NodeBoardHost";

/**
 * The node board as a FLOATING WINDOW (like the plugin / variables / console
 * windows) — draggable, resizable, minimizable — so the graph overlays the
 * canvas and you see edits update live. Toggled from the topbar switcher and the
 * Window menu via `board-store.isOpen`. The window is just chrome; the graph
 * resolution + editing all live in `NodeBoardHost` / `NodeBoard` unchanged.
 */
export function NodeBoardWindow() {
  const open = useBoardStore((s) => s.isOpen);
  const [bounds, setBounds] = React.useState<WindowBounds | null>(null);

  React.useEffect(() => {
    if (open && !bounds) {
      const width = Math.min(920, window.innerWidth - 120);
      const height = Math.min(560, window.innerHeight - 200);
      setBounds({ x: window.innerWidth - width - 40, y: 96, width, height, minimized: false });
    }
  }, [open, bounds]);

  if (!open || !bounds) return null;

  return (
    <FloatingWindow
      title="Nodes"
      icon={<Waypoints className="size-3.5" />}
      bounds={bounds}
      windowId="nodes"
      minWidth={420}
      minHeight={280}
      onBoundsChange={(patch) => setBounds((b) => (b ? { ...b, ...patch } : b))}
      onToggleMinimize={() => setBounds((b) => (b ? { ...b, minimized: !b.minimized } : b))}
      onClose={() => useBoardStore.getState().close()}
      // A pan/zoom surface: it fills the frame and owns its own navigation.
      body="fill"
    >
      <div className="h-full w-full overflow-hidden">
        <NodeBoardHost />
      </div>
    </FloatingWindow>
  );
}
