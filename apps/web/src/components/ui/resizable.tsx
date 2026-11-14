"use client";

import * as React from "react";
import { GripVertical } from "lucide-react";
import * as ResizablePrimitive from "react-resizable-panels";
import { cn } from "@/lib/utils";
import { claimPointer } from "@/editor/input/pointer-gestures";
import { DRAG_SURFACE } from "@/editor/input/use-multi-touch";

function ResizablePanelGroup({
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelGroup>) {
  return (
    <ResizablePrimitive.PanelGroup
      className={cn("flex h-full w-full data-[panel-group-direction=vertical]:flex-col", className)}
      {...props}
    />
  );
}

const ResizablePanel = ResizablePrimitive.Panel;

function ResizableHandle({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelResizeHandle> & { withHandle?: boolean }) {
  return (
    <ResizablePrimitive.PanelResizeHandle
      /*
       * THE HIT AREA IS THE ELEMENT. One line, and it is the fix three attempts
       * at this bug walked past, because the default it overrides is invisible.
       *
       * The library hit-tests pointers against each handle's bounding rect PLUS
       * a margin — 15px on a coarse pointer by default — from a listener on
       * `body`. So a finger landing 15px above the gutter, on the timeline's
       * lane scroller, starts a resize. That press never touched this element,
       * so nothing this element declares governed it: not `touch-action: none`,
       * not the arbiter claim below, not `data-gesture`. The browser saw a
       * one-finger drag on a scroller, took it as a pan, and fired
       * `pointercancel` — "it moves a few pixels and disconnects", from a
       * gesture that was never ours to begin with.
       *
       * **An invisible hit area is a gesture no element governs.** Ours is the
       * element's own box, grown by `--gutter-reach` (see `.shell-gutter`), so
       * the library's rect, the browser's hit test and our touch policy are the
       * same rectangle by construction and cannot drift apart.
       */
      hitAreaMargins={{ fine: 0, coarse: 0 }}
      /*
       * CLAIM ON PRESS. `touch-action: none` tells the BROWSER not to scroll
       * from this element; claiming tells the ARBITER, which then refuses the
       * browser's scroll for the whole gesture from a non-passive `touchmove`.
       * Both are needed on iOS, where a drag beginning near a screen edge is
       * still eligible for a system gesture the CSS alone does not cover.
       *
       * `onPointerDownCapture`, because the library's own `onPointerDown` takes
       * no event and would give us nothing to claim. Capture also runs before
       * it, so the claim is in place before the drag starts.
       *
       * `"hold"`: a gutter is meaningful while STATIONARY — you put a finger on
       * it and position it — so no context menu opens on top of a resize. That
       * matters more here than anywhere: the library ends its own drag on
       * `contextmenu`, so a long press firing mid-resize is not a menu ON a
       * drag, it is the drag being deleted.
       */
      onPointerDownCapture={(e) => claimPointer(e.pointerId, "hold")}
      className={cn(
        // A GUTTER, not a rule. In the shell the gap between two cards is
        // already the separator, so a 1px line down the middle of it just adds
        // a seam to a layout that had stopped needing one. The handle IS the
        // shell gap, transparent until you touch it — then a short rounded grip
        // fades in, which is the only moment anyone needs to know it is
        // draggable.
        //
        // `.shell-gutter` carries the geometry: the gap's width, plus the reach
        // that makes it grabbable by a finger, handed straight back to the flex
        // line by a negative margin so no panel ever moves to make room for a
        // target. The gutter looks identical on a phone and on a desktop; only
        // the size of the thing you can grab differs.
        "shell-gutter",
        // A resize gutter is a DRAG, so the browser must not read it as a
        // scroll — and iOS must not raise a selection callout over it, which
        // cancels the touch outright.
        DRAG_SURFACE,
        "group/handle flex items-center justify-center bg-transparent",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        // The grip: a pill centred in the gutter, on hover/drag only.
        "after:absolute after:rounded-full after:bg-foreground/25 after:opacity-0 after:transition-opacity",
        "after:h-8 after:w-[3px] data-[panel-group-direction=vertical]:after:h-[3px] data-[panel-group-direction=vertical]:after:w-8",
        "hover:after:opacity-100 data-[resize-handle-state=drag]:after:bg-primary data-[resize-handle-state=drag]:after:opacity-100",
        className,
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-4 w-3 items-center justify-center rounded-sm border bg-border">
          <GripVertical className="h-2.5 w-2.5" />
        </div>
      )}
    </ResizablePrimitive.PanelResizeHandle>
  );
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
