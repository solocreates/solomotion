"use client";

import * as React from "react";
import { pathTrail, type TrailCrumb } from "@solomotion/core";
import {
  Bone,
  Box,
  ChevronRight,
  Component,
  CornerUpLeft,
  Crop,
  Frame as FrameIcon,
  PenTool,
  Spline,
  Type,
  Crosshair,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { CHROME_CAPSULE } from "./StageChrome";
import { SCROLL_SURFACE } from "../input/use-multi-touch";
import { useDoc } from "../state/document-context";
import { useSession } from "../state/session";
import { FRAME_MODE_META } from "../frames/frame-modes";
import type { LeafMode } from "../state/navigation";
import { useRigUi } from "../rig/state";
import { useShapeKeyUi } from "../shape-keys/state";
import { EditingKeyChip } from "../shape-keys/EditingKeyChip";
import { usePerform } from "../perform/state";
import { PerformChip } from "../perform/PerformLayer";

/**
 * THE context bar — "where am I, and how do I get out?", answered in one strip
 * over the canvas.
 *
 * It renders the navigation path directly (`pathTrail`), so it is structurally
 * incapable of the duplicate-last-crumb ("Frame 1 ▸ Frame 1") it used to show:
 * the target is the last element of the trail, not a separate field printed
 * beside it. Each crumb carries the BADGE of what kind of inside it is —
 * component, nested comp, vector artwork, drawing, flipbook — because "you are
 * two levels down" is much less useful than "you are inside a component, inside
 * a nested comp".
 *
 * The interior editor (glyphs, Bézier nodes, shape corners, crop) is a crumb
 * too. Entering the pen tool's node editor IS navigation — the same ladder,
 * the same Escape — and showing it here is what makes that legible instead of
 * a hidden mode you discover by pressing keys.
 */

const CRUMB_ICON: Record<TrailCrumb["badge"], React.ComponentType<{ className?: string }>> = {
  root: FrameIcon,
  component: Component,
  nested: Box,
  vector: PenTool,
  static: FRAME_MODE_META.static.icon,
  flipbook: FRAME_MODE_META.flipbook.icon,
};

const LEAF_META: Record<LeafMode, { icon: React.ComponentType<{ className?: string }>; label: string }> = {
  text: { icon: Type, label: "Text" },
  vectorNodes: { icon: Spline, label: "Nodes" },
  shapeCorners: { icon: Spline, label: "Corners" },
  crop: { icon: Crop, label: "Crop" },
  pivot: { icon: Crosshair, label: "Pivot" },
};


export function StageContextBar() {
  const doc = useDoc();
  const nav = useSession((s) => s.nav);

  const trail = React.useMemo(() => pathTrail(doc, nav.path), [doc, nav.path]);
  const leaf = nav.leaf;
  // Rig SETUP is a mode like any interior editor: it shows here, and clicking it is the way out.
  const rigSetup = useRigUi((s) => s.mode === "setup");
  // An armed shape key is a mode too: "Editing key · Smile", click or Esc saves it.
  const editingKey = useShapeKeyUi((s) => s.session !== null);
  // Perform is a stage mode: its chip is the visible way out.
  const performing = usePerform((s) => s.active);

  // "Edit as vector" used to live HERE, in the docked strip. It was the wrong
  // room: a contextual ACTION belongs beside the thing it acts on, the way a
  // rich-text editor puts bold above the words you highlighted — so it is now a
  // `LayerCallout` anchored to the layer itself. This bar keeps what it is
  // actually for: where you are, and how to get out.

  // Scroll the deepest end into view whenever the path changes: after stepping
  // in, the crumb you just entered is the one you need to see, and it is the
  // one a left-anchored scroller pushes off the end. Above the early return —
  // a hook after a conditional exit is a hook that stops being called.
  const trailRef = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    const el = trailRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [trail.length, leaf?.mode]);

  // Nothing to say at the top level with no editor open: the canvas speaks for
  // itself, and a permanent "Frame 1" chip is just furniture.
  if (trail.length <= 1 && !leaf && !rigSetup && !editingKey && !performing) return null;

  const LeafIcon = leaf ? LEAF_META[leaf.mode].icon : null;

  return (
    <div data-stage-chrome className={CHROME_CAPSULE}>
      {/* THE TRAIL SCROLLS; the two actions never do.
          A deep path used to collapse to `Frame 1 … Text`, which throws away
          the names that answer the only question this bar exists for, and it
          STILL crushed: the crumbs and the buttons had no `shrink-0` between
          them, so on a narrow stage they compressed into each other until the
          icons overlapped the words. One behaviour instead of two half ones —
          the trail keeps every crumb at full size and you swipe it, like the
          tool rail and every other capsule that can outgrow the stage. */}
      <nav
        ref={trailRef}
        aria-label="Edit context"
        className={cn(
          "flex min-w-0 items-center gap-0.5 overflow-x-auto overflow-y-hidden text-xs",
          "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          "*:shrink-0",
          SCROLL_SURFACE,
        )}
      >
        {trail.map((crumb, i) => (
          <React.Fragment key={`${crumb.frameId}:${crumb.depth}`}>
            {i > 0 && <ChevronRight className="size-3 shrink-0 text-muted-foreground/50" />}
            <Crumb crumb={crumb} dimmed={crumb.isTarget && leaf != null} />
          </React.Fragment>
        ))}
        {leaf && LeafIcon && (
          <>
            <ChevronRight className="size-3 shrink-0 text-muted-foreground/50" />
            <button
              type="button"
              onClick={() => useSession.getState().closeLeaf()}
              className="flex items-center gap-1 rounded-lg bg-primary/15 px-1.5 py-1 font-medium text-primary transition-colors hover:bg-primary/25"
            >
              <LeafIcon className="size-3" />
              {LEAF_META[leaf.mode].label}
            </button>
          </>
        )}
        {rigSetup && (
          <>
            <ChevronRight className="size-3 shrink-0 text-muted-foreground/50" />
            <button
              type="button"
              title="Back to posing (Esc)"
              onClick={() => useRigUi.getState().setMode("pose")}
              className="flex items-center gap-1 rounded-lg bg-primary/15 px-1.5 py-1 font-medium text-primary transition-colors hover:bg-primary/25"
            >
              <Bone className="size-3" />
              Rig setup
            </button>
          </>
        )}
        {editingKey && (
          <>
            <ChevronRight className="size-3 shrink-0 text-muted-foreground/50" />
            <EditingKeyChip icon={<Spline className="size-3" />} />
          </>
        )}
        {performing && (
          <>
            <ChevronRight className="size-3 shrink-0 text-muted-foreground/50" />
            <PerformChip />
          </>
        )}
      </nav>

      <span className="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden />

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Step out"
            onClick={() => (useRigUi.getState().mode === "setup" ? useRigUi.getState().setMode("pose") : useSession.getState().exitContext())}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-3.5"
          >
            <CornerUpLeft />
          </button>
        </TooltipTrigger>
        <TooltipContent>
          Step out <kbd className="ml-1 rounded bg-muted px-1">Esc</kbd>
        </TooltipContent>
      </Tooltip>

    </div>
  );
}

function Crumb({ crumb, dimmed }: { crumb: TrailCrumb; dimmed: boolean }) {
  const Icon = CRUMB_ICON[crumb.badge];
  const active = crumb.isTarget && !dimmed;
  return (
    <button
      type="button"
      onClick={() => useSession.getState().jumpToDepth(crumb.depth)}
      aria-current={crumb.isTarget ? "true" : undefined}
      className={cn(
        "flex max-w-36 shrink-0 items-center gap-1 truncate rounded-lg px-1.5 py-1 transition-colors",
        active
          ? "bg-muted font-medium text-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <Icon className={cn("size-3 shrink-0", crumb.badge === "component" && "text-primary")} />
      <span className="truncate">{crumb.name}</span>
    </button>
  );
}
