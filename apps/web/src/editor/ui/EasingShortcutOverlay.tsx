"use client";

import * as React from "react";
import type { Easing } from "@solomotion/core";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { EasingPanel } from "@/components/ui/easing-editor";
import { useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import {
  applyEasingToSelectedKeyframes,
  selectedKeyframeEasing,
  smoothSelectedKeyframes,
} from "../state/keyframe-actions";
import { toast } from "@/lib/toast";

/**
 * The E shortcut's easing popover — select keyframes anywhere (timeline
 * lane, curves panel, dope sheet), hit E, and the ONE easing panel (same
 * curve editor + preset gallery the text Animate tab uses) opens at the
 * cursor. Picking applies to every selected keyframe in one undo step.
 */

/** Last pointer position — where the popover opens. Passive, module-level. */
export const lastPointer = { x: 0, y: 0 };
if (typeof window !== "undefined") {
  window.addEventListener(
    "pointermove",
    (e) => {
      lastPointer.x = e.clientX;
      lastPointer.y = e.clientY;
    },
    { passive: true, capture: true },
  );
}

export function EasingShortcutOverlay() {
  const store = useDocStore();
  const at = useSession((s) => s.easingPopoverAt);
  const [value, setValue] = React.useState<Easing>({ kind: "preset", name: "ease-in-out" });

  // Seed with the first selected key's current easing when opening.
  React.useEffect(() => {
    if (!at) return;
    const seed = selectedKeyframeEasing(store);
    if (seed) setValue(seed);
  }, [at, store]);

  if (!at) return null;
  return (
    <Popover open onOpenChange={(open) => !open && useSession.getState().setEasingPopoverAt(null)}>
      <PopoverAnchor asChild>
        <div className="pointer-events-none fixed size-px" style={{ left: at.x, top: at.y }} />
      </PopoverAnchor>
      <PopoverContent className="w-64 p-2.5" side="top" sideOffset={10} collisionPadding={8}>
        <EasingPanel
          value={value}
          onChange={(easing) => {
            setValue(easing);
            applyEasingToSelectedKeyframes(store, easing);
          }}
          onSmooth={() => {
            const n = smoothSelectedKeyframes(store);
            if (n) toast(`Smoothed ${n} keyframe${n > 1 ? "s" : ""}`);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
