"use client";

import { SlidersHorizontal, Spline } from "lucide-react";
import type * as React from "react";
import type { GraphTab } from "./GraphPanel";

/**
 * The registry of TIMELINE SURFACES — the things that can open in the strip
 * under the lanes. The same idea as `panel-registry` for the sidebars: a
 * surface is described once, and every host that offers it (the bottom rail
 * today, the Window menu and the command palette next) renders from this list
 * rather than hard-coding a pair of buttons.
 *
 * This exists because the keyframe/curve switch had been written TWICE — once
 * as a segmented control in the timeline header, once as a floating pill inside
 * the graph panel — and the two disagreed about what "active" meant. A third
 * surface (an audio mixer, a marker list) would have made it three.
 *
 * Open/closed state is NOT here: `useGraphEditor` already owns it, and a
 * registry that also held state would be a second source of truth for the one
 * question the store exists to answer.
 */
export interface TimelineSurfaceDef {
  id: GraphTab;
  name: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Tooltip line — what the surface is FOR, not what the button does. */
  hint: string;
}

export const TIMELINE_SURFACES: TimelineSurfaceDef[] = [
  {
    id: "keys",
    name: "Keyframes",
    icon: SlidersHorizontal,
    hint: "Dope sheet — every keyframe as a grid",
  },
  {
    id: "curves",
    name: "Curves",
    icon: Spline,
    hint: "Value graph — easing curves you can shape",
  },
];
