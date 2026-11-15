"use client";

import * as React from "react";
import { ScrollArea } from "@/components/ui/scroll-area";

/**
 * ONE menu surface for every menu primitive (dropdown, context, menubar): the
 * dropdown and context menus each carried a private copy of this, and copies
 * drift. The LOOK is the theme's `menu` part (`packages/theme/parts.css`);
 * this is only the behaviour — the check/radio gutter, the open/close motion
 * (it grows from the side it opened toward), and the edge rule: never taller
 * than the space Radix measured, the rest scrolls.
 */
export const MENU_EDGE_PADDING = 8;
export const MENU_SURFACE =
  "group/menu [&:has([role=menuitemcheckbox])_[role=menuitem]:not(:has(>svg:first-child))]:pl-8 [&:has([role=menuitemradio])_[role=menuitem]:not(:has(>svg:first-child))]:pl-8 z-50 flex flex-col overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-[0.98] data-[state=open]:zoom-in-[0.98] data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1";
/** The separator between groups: inset to the items' text, not full bleed. */
export const MENU_SEPARATOR = "mx-2 my-1 h-px";

export function MenuScroll({ children }: { children: React.ReactNode }) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="p-1">{children}</div>
    </ScrollArea>
  );
}
