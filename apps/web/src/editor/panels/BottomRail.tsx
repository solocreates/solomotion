"use client";

import * as React from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
} from "lucide-react";
import { Palette, PanelBottom, Waypoints } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useBoardStore } from "../nodes/board-store";
import { useColorStore } from "../color/color-store";
import { cn } from "@/lib/utils";
import { Rail, type RailItem } from "./Rail";
import { useGraphEditor } from "../timeline/graph-editor";
import { TIMELINE_SURFACES } from "../timeline/timeline-surfaces";
import { resolvePanel, usePanels } from "../state/panels";
import { useStatusBar, type StatusKind } from "../state/status-bar";
import { useIsCompact } from "../state/use-shell-density";
import { AppMenu } from "../menus/AppMenu";
import { ActivityRing } from "../runtime/ActivityRing";
import { ExportButton, GlobalActions, useInspectorRailItems, useLeftRailItems } from "./SideRail";
import { panelDef } from "./panel-registry";
import { useLayout } from "../workspace/store";
import { findRegion, regions, setCollapsed } from "../workspace/layout-tree";
import { TIME_FAMILY, type EditorId } from "../workspace/editor-registry";

/**
 * THE BOTTOM BAR — the horizontal twin of `PanelRail`, and the app's only
 * bottom chrome.
 *
 * It used to be two strips stacked on each other: a rail of timeline surfaces,
 * and under it a status footer whose right half was a ⌘K chip advertising a
 * shortcut. Two full-width bars for one edge is a lot of rent, and the lower
 * one was mostly decoration.
 *
 * Now one bar does both jobs, in the three-column layout that keeps them from
 * fighting: the app's latest message on the left, the surface controls dead
 * CENTRE (a real grid, so a long message can't shove them off-axis), and the
 * right column left open. The controls live OUTSIDE the collapsible timeline on
 * purpose — a control that hides the timeline must not be inside the thing it
 * hides, or collapsing it takes away its own way back.
 *
 * Same material language as the side rails: no surface of its own, standing on
 * the app's ground, with the armed state carried by a raised pane of glass and
 * an accent icon.
 */

const KIND_META: Record<StatusKind, { Icon: React.ComponentType<{ className?: string }>; tint: string }> = {
  info: { Icon: Info, tint: "text-muted-foreground" },
  success: { Icon: CheckCircle2, tint: "text-success" },
  error: { Icon: AlertCircle, tint: "text-destructive" },
  warning: { Icon: AlertTriangle, tint: "text-warning" },
  loading: { Icon: Loader2, tint: "text-primary" },
};

export function BottomRail() {
  const compact = useIsCompact();

  // NARROW: every rail, in this one. See `RailDock`. The three-column grid
  // below needs roughly 520px before the message column stops squeezing the
  // controls off their axis, and a hundred-pixel sliver of a truncated sentence
  // is worse than no sentence — messages still reach the user as toasts.
  if (compact) return <RailDock />;

  // The whole bar is the bottom rail's drop BAND: a drag toward the bottom
  // edge lands in the rail wherever along the edge it arrives, not only over
  // the centred buttons.
  return (
    <div
      className="grid h-9 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 bg-background px-3"
      data-dock-band="rail:bottom"
      data-dock-kind="rail"
      data-dock-edge="bottom"
    >
      <StatusMessage />
      <SurfaceControls />
      {/* The right column keeps the middle at TRUE centre, and holds the one
          mark that says something is loading or running. */}
      <div className="flex min-w-0 justify-end">
        <ActivityRing />
      </div>
    </div>
  );
}

/** The app's latest message — every `toast(...)` lands here (see @/lib/toast). */
function StatusMessage() {
  const latest = useStatusBar((s) => s.latest);
  if (!latest) return <div aria-hidden />;
  const { Icon, tint } = KIND_META[latest.kind];
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs" role="status" aria-live="polite">
      <Icon className={cn("size-3.5 shrink-0", tint, latest.kind === "loading" && "animate-spin")} />
      <span className={cn("truncate", latest.kind === "error" ? "text-foreground" : "text-foreground/75")}>
        {latest.text}
      </span>
      {latest.description && (
        <span className="truncate text-muted-foreground/70">— {latest.description}</span>
      )}
      {latest.action && (
        <button
          type="button"
          onClick={() => {
            const act = latest.action;
            useStatusBar.getState().dismiss(latest.id);
            act?.onClick();
          }}
          className="shrink-0 rounded px-1.5 py-0.5 font-medium text-primary transition-colors hover:bg-primary/10"
        >
          {latest.action.label}
        </button>
      )}
    </div>
  );
}

/**
 * The bottom region's surfaces — Timeline, Keyframes, Curves, Nodes.
 *
 * A hook rather than a component so the compact dock can fold them in beside
 * the other two rails' items without a second copy of the mutual exclusion
 * between the lanes and the node graph, which is the part that would rot.
 */
export function useTimelineRailItems(): Array<RailItem | "separator"> {
  const timelineOpen = usePanels((s) => resolvePanel(s, "timeline"));
  const graphOpen = useGraphEditor((s) => s.open);
  const nodesOn = useBoardStore((s) => s.isOpen);
  const colorOn = useColorStore((s) => s.open);
  const tab = useGraphEditor((s) => s.tab);
  // Only the surfaces the bottom region still HOSTS: drag Curves beside the
  // canvas and its button leaves this rail for the region it went to.
  const hosted = useLayout((s) => findRegion(s.ws, "timeline")?.editors.join(",") ?? "");
  const bottomActive = useLayout((s) => findRegion(s.ws, "timeline")?.active);
  const bottomCollapsed = useLayout((s) => !!findRegion(s.ws, "timeline")?.collapsed);
  // Another editor dropped into this rail owns the region while it is active;
  // the time surfaces then read as off, and clicking one switches back.
  const other = !!bottomActive && !TIME_FAMILY.includes(bottomActive);

  const all: Array<RailItem | "separator"> = [
        {
          key: "timeline",
          name: "Timeline",
          icon: PanelBottom,
          hint: "The track lanes",
          active: timelineOpen,
          onClick: () => {
            if (!timelineOpen) {
              useBoardStore.getState().close();
              useColorStore.getState().setOpen(false);
            }
            usePanels.getState().setVisible("timeline", !timelineOpen);
          },
        },
        ...TIMELINE_SURFACES.map((s) => ({
        key: s.id,
        name: s.name,
        icon: s.icon,
        hint: s.hint,
        active: graphOpen && tab === s.id,
        onClick: () => {
          if (!(graphOpen && tab === s.id)) {
            useBoardStore.getState().close();
            useColorStore.getState().setOpen(false);
          }
          useGraphEditor.getState().toggle(s.id);
        },
      })),
        // Time surfaces on one side of the rule, the node graph on the other.
        // They are mutually exclusive, so the separator is not decoration — it
        // marks where "another view of the timeline" stops and "a different
        // editor" begins.
        "separator" as const,
        // COLOR is the other kind of editor, and it sits beside the node board
        // rather than beside the time surfaces for the same reason: it is a
        // different view of the document, not another reading of the clock.
        {
          key: "color",
          name: "Color",
          icon: Palette,
          hint: "Grade the selected layer",
          active: colorOn,
          onClick: () => {
            if (colorOn) {
              useColorStore.getState().setOpen(false);
              return;
            }
            useColorStore.getState().setOpen(true);
            useBoardStore.getState().close();
            usePanels.getState().setVisible("timeline", false);
            useGraphEditor.getState().setOpen(false);
          },
        },
        {
          key: "nodes",
          name: "Nodes",
          icon: Waypoints,
          hint: "The selected layer's node graph",
          active: nodesOn,
          onClick: () => {
            if (nodesOn) {
              useBoardStore.getState().close();
              return;
            }
            // Timeline, Keyframes and Curves are three views of one time axis
            // and stack happily. The node graph is a different editor for the
            // same document, and sharing the region with the lanes leaves both
            // too short to use — so opening it takes the region.
            useBoardStore.getState().open();
            useColorStore.getState().setOpen(false);
            usePanels.getState().setVisible("timeline", false);
            useGraphEditor.getState().setOpen(false);
          },
        },
  ];
  const order = hosted.split(",").filter(Boolean) as EditorId[];
  const has = new Set<string>(order);
  const time = all
    .filter((i) => i === "separator" || has.has(i.key))
    .map((i) =>
      i === "separator"
        ? i
        : {
            ...i,
            editor: i.key as EditorId,
            region: "timeline",
            active: i.active && !other,
            onClick: other ? () => useLayout.getState().reveal(i.key as EditorId) : i.onClick,
          },
    );
  // Any editor dropped into this rail (Layers, Agents …), after a rule, in tree order.
  const guests: RailItem[] = order
    .filter((id) => !TIME_FAMILY.includes(id))
    .map((id) => {
      const def = panelDef(id);
      const active = other && bottomActive === id && !bottomCollapsed;
      return {
        key: id,
        name: def?.name ?? id,
        icon: def?.icon ?? PanelBottom,
        hint: def?.hint,
        active,
        editor: id,
        region: "timeline",
        onClick: () =>
          active
            ? useLayout.getState().apply((w) => setCollapsed(w, "timeline", true))
            : useLayout.getState().reveal(id),
        onPopOut: () => useLayout.getState().float(id),
      };
    });
  const kept = guests.length ? [...time, "separator" as const, ...guests] : time;
  // No leading, trailing or doubled rules once items have left.
  return kept.filter((i, idx) => i !== "separator" || (idx > 0 && idx < kept.length - 1 && kept[idx - 1] !== "separator"));
}

/**
 * Compact: regions the user split off have no edge rail of their own, so the
 * dock carries their active editor; tapping floats that region over the stage.
 */
function useUserRegionItems(): RailItem[] {
  const key = useLayout((s) =>
    regions(s.ws.root)
      .filter((r) => r.rail === null && !r.editors.includes("stage"))
      .map((r) => `${r.id}:${r.active}`)
      .join("|"),
  );
  const overlay = usePanels((s) => s.overlay);
  if (!key) return [];
  return key.split("|").map((pair) => {
    const [id, active] = pair.split(":") as [string, EditorId];
    const def = panelDef(active);
    return {
      key: `region:${id}`,
      name: def?.name ?? active,
      icon: def?.icon ?? PanelBottom,
      hint: def?.hint,
      active: overlay === id,
      editor: active,
      onClick: () => usePanels.getState().setOverlayRegion(overlay === id ? null : id),
    };
  });
}

function SurfaceControls() {
  return <Rail side="bottom" items={useTimelineRailItems()} dock />;
}

/**
 * THE DOCK — what the three rails become when the window is narrow.
 *
 * Two vertical rails cost 88px of a 375px window before anything is drawn in
 * it, and they cost it permanently: a phone has one column, and two of them are
 * chrome. So at compact width the side rails do not narrow, they MOVE — down
 * here, into the bar that was already at the bottom, as three groups of the
 * same rail:
 *
 *     [ ☰ ]  Library · Media · Layers │ Timeline · Curves │ Design · Effects …  [ ↶ ↷ ⚙ ↓ ]
 *
 * This is not a second layout. It is the same `Rail`, fed the same item lists
 * the vertical rails read (`useLeftRailItems`, `useTimelineRailItems`,
 * `useInspectorRailItems`) — so a surface that appears on a desktop rail appears
 * here, and an inspector tab that a selection does not offer is missing from
 * both. The forked mobile layout this app deleted was exactly the other choice,
 * and it went stale in a week.
 *
 * The middle scrolls; the app menu and the global actions are pinned ends, so a
 * long surface list can never push undo off the screen.
 */
function RailDock() {
  const left = useLeftRailItems();
  const time = useTimelineRailItems();
  const inspector = useInspectorRailItems();
  const user = useUserRegionItems();

  return (
    <Rail
      side="bottom"
      className="h-11"
      header={<AppMenu />}
      // Export comes down here too. It is the right RAIL's header, and the
      // right rail does not exist at this width — leaving it there would have
      // made shipping the thing you made impossible on a phone.
      footer={
        <>
          <ActivityRing />
          <GlobalActions horizontal />
          <ExportButton />
        </>
      }
      items={[...left, "separator", ...time, "separator", ...inspector, ...(user.length ? (["separator", ...user] as const) : [])]}
    />
  );
}
