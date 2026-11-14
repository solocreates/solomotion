"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";
import { TabIndicator, useTabIndicator } from "./tab-indicator";

/**
 * Tabs. A row of names; the theme decides how the active one is marked
 * (`parts.css`, keyed on `data-tabs`): the playhead's sliding 2px bar, a
 * raised box, the app's glass chip in a recessed track, a numbered tmux
 * window. No dialect draws a rule under the row.
 */
const Tabs = TabsPrimitive.Root;

function TabsList({ className, children, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  const ref = React.useRef<HTMLDivElement>(null);
  useTabIndicator(ref);
  return (
    <TabsPrimitive.List
      ref={ref}
      data-part="tabs"
      data-track=""
      className={cn(
        "inline-flex h-(--control-h) items-center justify-center text-fg-muted",
        // A tab strip must SCROLL rather than overflow: six settings tabs do
        // not fit a phone, and an inline-flex that cannot shrink pushed them
        // off the dialog's edge. The scrollbar is hidden; under 8px of chrome
        // it reads as damage.
        "max-w-full overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
      {...props}
    >
      <TabIndicator />
      {children}
    </TabsPrimitive.List>
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-part="tab"
      className={cn(
        "inline-flex h-full items-center justify-center whitespace-nowrap px-2.5 py-1 text-body font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      className={cn(
        "ring-offset-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
