"use client";

import * as React from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

/**
 * A PANEL WITH SIDEBARS — the layout every two-column surface in the app was
 * hand-rolling, and getting wrong in a different way each time.
 *
 * The rule is simple to state and easy to break: the CONTAINER decides the
 * height, and each column scrolls inside it. Every failure has been one of the
 * same three mistakes:
 *
 *   1. The container sized itself to its CONTENT, so it could not constrain
 *      anything. `h-full` on a grid item resolves against its grid AREA, and
 *      with implicit `grid-auto-rows: auto` that area is as tall as the tallest
 *      column — so `height: 100%` faithfully matched the overflow and the
 *      column clipped instead of scrolling. `grid-rows-[minmax(0,1fr)]` is the
 *      fix, and it is not optional.
 *   2. A `min-height: auto` flex/grid item refused to shrink below its content,
 *      which clips for the same reason one level down. Hence `min-h-0` on every
 *      column, always.
 *   3. Someone hid a column responsively by putting `display` on the ScrollArea
 *      itself. ScrollArea's root is a flex COLUMN whose viewport is its
 *      `flex-1 min-h-0` child; making the root `display: block` stops the
 *      viewport being a flex item, so it sizes to its content and the root's
 *      own `overflow-hidden` clips it with NO scrollbar. That is why a column
 *      could clip while its neighbour, which never touched `display`, scrolled
 *      perfectly.
 *
 * All three are structural, so they belong in one component rather than in a
 * comment each panel is expected to remember. Hiding happens on a WRAPPER here,
 * never on the scroller — which is what makes rule 3 unreachable.
 */

export function PanelColumns({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        // `grid-rows-[minmax(0,1fr)]` is what gives the row a height taken from
        // the panel instead of from whichever column happens to be tallest.
        "grid h-full min-h-0 grid-rows-[minmax(0,1fr)]",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function PanelColumn({
  className,
  viewportClassName,
  /** Hidden below this container width. Applied to a WRAPPER — never to the
   *  scroller, whose display is load-bearing (see rule 3). */
  hideBelow,
  scroll = true,
  children,
}: {
  className?: string;
  viewportClassName?: string;
  hideBelow?: string;
  /** Off for a column that manages its own overflow (a canvas, a fixed rig). */
  scroll?: boolean;
  children: React.ReactNode;
}) {
  const body = scroll ? (
    <ScrollArea className="min-h-0 flex-1" viewportClassName={viewportClassName}>
      {children}
    </ScrollArea>
  ) : (
    <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
  );

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-col", hideBelow, className)}>{body}</div>
  );
}
