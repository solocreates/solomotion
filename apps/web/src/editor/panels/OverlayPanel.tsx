"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { usePanels, type PanelKey } from "../state/panels";

/**
 * A side panel FLOATING over the stage — the compact presentation of the same
 * panel that docks as a column when there is room.
 *
 * Deliberately not a `Sheet`. Radix's sheet is modal: it dims the page, traps
 * focus and blocks the surface behind it. That is right for a dialog and wrong
 * for an editor, where the whole point of dragging an opacity slider is
 * watching the canvas change while you drag it. This is a non-modal card
 * anchored to its rail's edge, and the stage stays live behind it.
 *
 * It is `absolute` inside the workspace region, so it costs the stage no width:
 * opening Properties must never resize the canvas you are inspecting. (Zones
 * never size each other — the rule the stage chrome already obeys.)
 *
 * There is no close button ON the card, on purpose. The rail button that
 * opened it is still there, still armed, and clicking it closes — the same
 * gesture as at desktop width, one polarity at both. An X in the corner would
 * be a second way to say the same thing, and every panel in this app already
 * has its own header controls for it to land on.
 */
export function OverlayPanel({
  panel,
  side,
  title,
  children,
}: {
  /** A classic side panel, or the id of a region the user split off. */
  panel: PanelKey | string;
  side: "left" | "right";
  /** Named for the screen reader; the visible label is the armed rail button. */
  title: string;
  children: React.ReactNode;
}) {
  // Escape closes it. A floating surface with no keyboard way out is the same
  // bug as a collapse toggle living inside the panel it collapses.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Let a menu, dialog or text edit inside the panel claim it first.
      const t = e.target as HTMLElement | null;
      if (t?.closest("[role='dialog'],[role='menu'],input,textarea,[contenteditable='true']")) return;
      const p = usePanels.getState();
      if (panel === "left" || panel === "inspector") p.setVisible(panel, false);
      else p.setOverlayRegion(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel]);

  return (
    <div
      role="region"
      aria-label={title}
      className={cn(
        // Full height of the workspace region, and as wide as the window allows
        // up to a real panel's width. Capped in vw so a strip of canvas always
        // survives beside it — that strip is what keeps the panel reading as
        // temporary rather than as a screen you navigated to.
        "shell-card absolute inset-y-0 z-30 flex w-[min(20rem,84vw)] flex-col",
        side === "left" ? "left-0" : "right-0",
        side === "left" ? "animate-overlay-in-left" : "animate-overlay-in-right",
        // A floating panel needs more separation from the canvas than a docked
        // one, which has the shell's gap doing that job for it.
        "shadow-2xl",
      )}
    >
      {children}
    </div>
  );
}
