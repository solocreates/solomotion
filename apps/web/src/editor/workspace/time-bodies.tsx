"use client";

import * as React from "react";
import { flipbookInContext, type DocumentStore, type Frame } from "@solomotion/core";
import { activeCompId, timeToPx, timelineSpanMs } from "../timeline/timeline-utils";
import { Box, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useBoardStore } from "../nodes/board-store";
import { NodeBoardHost } from "../nodes/NodeBoardHost";
import { useColorStore } from "../color/color-store";
import { ColorPanel } from "../color/ColorPanel";
import { Timeline } from "../timeline/Timeline";
import { AudioMixer } from "../timeline/mixer/AudioMixer";
import { GraphSurface } from "../timeline/GraphSurface";
import { GraphPanel, type GraphTab } from "../timeline/GraphPanel";
import { useGraphEditor } from "../timeline/graph-editor";
import { useHeaderWidth } from "../timeline/header-width";
import { usePxPerSec } from "../timeline/use-time-axes";
import { FlipbookPanel } from "../drawing/FlipbookPanel";
import { FrameModeSwitch, switchFrameMode } from "../frames/frame-modes";
import { addFrameFromPreset, addWorldFromPreset } from "../state/clip-actions";
import { useDoc, useDocStore } from "../state/document-context";
import { resolvePanel, usePanels } from "../state/panels";
import { useSession } from "../state/session";
import { PanelBoundary } from "../runtime/ErrorBoundary";
import type { EditorId } from "./editor-registry";
import { useLayout } from "./store";
import { fitTimeline, zoomTimeline } from "../state/timeline-commands";
import { TIME_ZOOM, type ZoomCommand } from "./view-zoom";
import { registerZoomTarget } from "./zoom-shortcuts";

/** The timeline slot of an empty project: nothing has a clock until a frame exists. */
function NoFrameSlot({ store }: { store: DocumentStore }) {
  return (
    <div className="flex h-full min-h-10 items-center justify-center gap-3 border-t bg-background px-4">
      <Button size="xs" variant="outline" onClick={() => addFrameFromPreset(store, { name: "Frame 1", width: 1080, height: 1920 })}>
        <Plus /> Add frame
      </Button>
      <Button size="xs" variant="outline" onClick={() => addWorldFromPreset(store, { name: "World 1", width: 1920, height: 1080 })}>
        <Box /> Add 3D world
      </Button>
    </div>
  );
}

/** The timeline slot of a static frame: no clock, one door out of stillness. */
function StillSlot({ store, frame }: { store: DocumentStore; frame: Frame }) {
  return (
    <div className="flex h-full min-h-10 items-center justify-center gap-3 border-t bg-background px-4">
      <FrameModeSwitch compact value={frame.mode} onChange={(mode) => switchFrameMode(store, frame.id, mode)} />
    </div>
  );
}

/** Which time-family editors does the region with this id host? (stable string → cheap selector) */
function useHosted(regionId: string): ReadonlySet<EditorId> {
  const key = useLayout((s) => {
    const find = (node: typeof s.ws.root): string => {
      if (node.kind === "region") return node.id === regionId ? node.editors.join(",") : "";
      for (const c of node.children) {
        const r = find(c.node);
        if (r) return r;
      }
      return "";
    };
    return find(s.ws.root);
  });
  return React.useMemo(() => new Set(key.split(",").filter(Boolean) as EditorId[]), [key]);
}

/**
 * THE TIMELINE SLOT — the lanes (or the flipbook sheet, or a still's slot)
 * with Keyframes/Curves, Nodes and Color stacking under them and the mixer
 * at the right, exactly as the bottom region always was. The one change:
 * each surface renders here only while THIS region hosts it. Drag Curves
 * beside the canvas and it leaves the stack instead of showing twice.
 *
 * Every hook sits above the first branch: an early return above a hook is
 * how opening a flipbook once crashed the editor ("rendered fewer hooks").
 */
export function TimelineRegionBody({ regionId }: { regionId: string }) {
  const store = useDocStore();
  const activeFrameId = useSession((s) => s.activeFrameId);
  const doc = React.useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const hosted = useHosted(regionId);
  const flipbook = flipbookInContext(doc, activeFrameId);
  const active = doc.frames.find((f) => f.id === activeFrameId);
  const stillFrame = active?.mode === "static" ? active : null;
  const timelineOn = usePanels((s) => resolvePanel(s, "timeline")) && hosted.has("timeline");
  const graphTab = useGraphEditor((s) => s.tab);
  const graphOn = useGraphEditor((s) => s.open) && hosted.has(graphTab);
  const nodesOn = useBoardStore((s) => s.isOpen) && hosted.has("nodes");
  const colorOn = useColorStore((s) => s.open) && hosted.has("color");
  const mixerOn = usePanels((s) => resolvePanel(s, "mixer")) && hosted.has("mixer");
  const stacked = [timelineOn, graphOn, nodesOn, colorOn].filter(Boolean).length;

  return (
    <div className="@container flex h-full min-h-0">
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        {timelineOn && (
          <div className={cn("min-h-0", stacked > 1 ? "flex-1" : "h-full")} data-pick-area="timeline">
            {doc.frames.length === 0 ? (
              <NoFrameSlot store={store} />
            ) : flipbook ? (
              <FlipbookPanel flipbook={flipbook} />
            ) : stillFrame ? (
              <StillSlot store={store} frame={stillFrame} />
            ) : (
              <Timeline />
            )}
          </div>
        )}
        {graphOn && <GraphSurface fill={!timelineOn && !nodesOn} />}
        {nodesOn && (
          <div className={cn("min-h-0", stacked > 1 ? "flex-1" : "h-full")} data-pick-area="nodes">
            <NodeBoardHost />
          </div>
        )}
        {colorOn && (
          <div className={cn("min-h-0", stacked > 1 ? "flex-1" : "h-full")}>
            <PanelBoundary name="Color">
              <ColorPanel />
            </PanelBoundary>
          </div>
        )}
      </div>
      {mixerOn && doc.frames.length > 0 && (
        <PanelBoundary name="Mixer">
          <AudioMixer />
        </PanelBoundary>
      )}
    </div>
  );
}

/**
 * Keyframes or Curves on their OWN — a region, a floating window, an OS
 * window. The tab is fixed by which editor this is; the shared store's tab
 * belongs to the copy stacked under the lanes.
 */
export function StandaloneGraph({ tab }: { tab: GraphTab }) {
  const doc = useDoc();
  const pxPerSec = usePxPerSec();
  const headerW = useHeaderWidth((s) => s.width);
  const compId = activeCompId(doc, useSession((s) => s.activeFrameId));
  const contentWidth = timeToPx(timelineSpanMs(doc, compId), pxPerSec) + 120;
  return (
    <div className="h-full min-h-0" data-pick-area="curves">
      <GraphPanel
        tab={tab}
        onTabChange={(t) => {
          if (t !== tab) useLayout.getState().reveal(t);
        }}
        pxPerSec={pxPerSec}
        contentWidth={contentWidth}
        headerW={headerW}
        fill
      />
    </div>
  );
}

/**
 * The lanes on their own (Timeline floated or moved out of the bottom). The
 * flipbook / still / empty slots come with it — they are the same slot.
 */
export function StandaloneTimeline() {
  const store = useDocStore();
  const activeFrameId = useSession((s) => s.activeFrameId);
  const doc = React.useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const flipbook = flipbookInContext(doc, activeFrameId);
  const active = doc.frames.find((f) => f.id === activeFrameId);
  return (
    <div className="h-full min-h-0" data-pick-area="timeline">
      {doc.frames.length === 0 ? (
        <NoFrameSlot store={store} />
      ) : flipbook ? (
        <FlipbookPanel flipbook={flipbook} />
      ) : active?.mode === "static" ? (
        <StillSlot store={store} frame={active} />
      ) : (
        <Timeline />
      )}
    </div>
  );
}

export function StandaloneNodes() {
  // The board renders from its store's open session; a standalone host opens it.
  React.useEffect(() => {
    if (!useBoardStore.getState().isOpen) useBoardStore.getState().open();
  }, []);
  return (
    <div className="h-full min-h-0" data-pick-area="nodes">
      <NodeBoardHost />
    </div>
  );
}

export function StandaloneColor() {
  return (
    <PanelBoundary name="Color">
      <ColorPanel />
    </PanelBoundary>
  );
}

export function StandaloneMixer() {
  return (
    <PanelBoundary name="Mixer">
      <div className="flex h-full min-h-0 justify-end">
        <AudioMixer />
      </div>
    </PanelBoundary>
  );
}

/**
 * The D5 zoom keys for the TIME views (README D5), registered once for the
 * timeline and the curve/keyframe surfaces that share its axis: ⌘± step the
 * shared px/s about the view's centre, ⌘0 fits the cut. A time axis has no
 * "100%", so ⇧0 is consumed rather than handed on to the stage behind.
 */
export function TimeZoomKeys() {
  const store = useDocStore();
  React.useEffect(() => {
    const run = (cmd: ZoomCommand) => {
      if (cmd === "fit") fitTimeline(store);
      else if (cmd !== "actual") zoomTimeline(store, cmd === "in" ? TIME_ZOOM.step : 1 / TIME_ZOOM.step);
      return true;
    };
    const offs = [registerZoomTarget({ focus: "timeline", run }), registerZoomTarget({ focus: "curves", run })];
    return () => offs.forEach((f) => f());
  }, [store]);
  return null;
}
