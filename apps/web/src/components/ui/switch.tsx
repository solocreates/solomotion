"use client";

import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";
import { useDynamicControl } from "@/editor/binding/dynamic-field";

/**
 * THE switch. One body for every theme — a recessed slot with a hairline that
 * fills with the accent tint when on — and the theme picks the THUMB
 * (`parts.css`, keyed on `data-switch`): a notch that clicks into place, the
 * logo's dial filling a quarter at a time, the app's pill (a hole cut in the
 * accent, painted as the surface behind it, never a white headlight), an LED
 * with its word, a rocker. Every dialect snaps in ~110ms.
 *
 * The component paints nothing: it renders every piece a dialect may draw
 * (thumb, the on/off words) and the stylesheet shows what this theme uses.
 */
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitives.Root>) {
  // A driven switch still SHOWS its state (that is the value) but toggling it
  // would write into a slot the source overwrites — so the press opens the
  // source instead, and the tint says why.
  const dynamic = useDynamicControl();
  return (
    <SwitchPrimitives.Root
      data-part="switch"
      className={cn("peer outline-none focus-visible:ring-1 focus-visible:ring-ring", dynamic?.className, className)}
      style={dynamic?.style}
      {...props}
      {...(dynamic ? { ...dynamic.props, onCheckedChange: undefined } : {})}
    >
      <SwitchPrimitives.Thumb data-part="switch-thumb" />
      <span data-el="word" data-word="off" aria-hidden>
        off
      </span>
      <span data-el="word" data-word="on" aria-hidden>
        on
      </span>
    </SwitchPrimitives.Root>
  );
}

export { Switch };
