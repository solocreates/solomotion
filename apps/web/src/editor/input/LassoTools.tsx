"use client";

import * as React from "react";
import { Lasso, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useLasso } from "./lasso";
import { usePointerEnv } from "./pointer-env";

/**
 * The lasso's two controls, as ONE component, because they are one idea: arm
 * the free selection, and clear what it collected.
 *
 * Every panel that offers the lasso renders this and nothing else. A panel
 * assembling its own pair would be free to disagree about the icon, the armed
 * state, whether Deselect is always visible, and what the tooltip says — which
 * is how the app ended up with three marquees that each meant something
 * slightly different by "selected".
 *
 * ── It is LABELLED, and that is the fix for "I can't tell what it does" ──────
 *
 * It was a bare icon in the middle of the timeline's edit tools, and the only
 * thing that said what it was, was a TOOLTIP — which on a touch device does
 * not exist, because there is no hover. So on exactly the device the lasso was
 * built for, it was an unexplained glyph. An affordance whose entire
 * explanation lives in a hover state is not an affordance there.
 *
 * The label also fixes where it sits: with a word on it, it belongs in the
 * right-hand action cluster beside Track and Clip — things you DO — rather
 * than among the edit tools, which are things that change how a drag behaves.
 *
 * DESELECT ONLY EXISTS WHEN THERE IS A SELECTION. A permanently visible button
 * that does nothing most of the time is noise, and a disabled one is worse: it
 * advertises a capability while refusing it. The button appearing IS the
 * feedback that the lasso caught something.
 */
export function LassoTools({
  selectedCount,
  onDeselect,
  className,
}: {
  /** How many items the host surface currently has selected. */
  selectedCount: number;
  onDeselect: () => void;
  className?: string;
}) {
  const armed = useLasso((s) => s.armed);
  const toggle = useLasso((s) => s.toggle);
  /*
   * ONLY WHERE A FINGER DRIVES (README D19). With a mouse or a trackpad the
   * marquee already sweeps from empty space, so a Lasso button is a second
   * door to the same room, and on a desktop it read as clutter. The lasso
   * exists because a finger on a scroller SCROLLS — it is the touch answer,
   * so it shows when the primary pointer is coarse. An armed lasso stays
   * visible anywhere, so it can always be disarmed.
   */
  const coarse = usePointerEnv().primaryCoarse;
  const showLasso = coarse || armed;

  return (
    <div className={cn("flex shrink-0 items-center gap-1", className)}>
      {showLasso && (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            role="switch"
            aria-checked={armed}
            onClick={toggle}
            // The app's ONE armed state — the same raised pane of glass the
            // rails, the stage's armed tool and the selected tab wear, with the
            // accent carried by the icon and label. A saturated accent slab
            // would read as a sticker and need re-tuning per theme.
            className={cn(armed && "material-glass-raised text-primary")}
          >
            <Lasso /> Lasso
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">
          {armed
            ? "Lasso on — drag to draw a selection, tap to add"
            : "Draw a free-form selection with a finger or pen"}
        </TooltipContent>
      </Tooltip>
      )}

      {showLasso && selectedCount > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`Deselect ${selectedCount}`}
              onClick={onDeselect}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
            >
              <XCircle />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Deselect {selectedCount}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
