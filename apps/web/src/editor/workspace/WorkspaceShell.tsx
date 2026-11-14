"use client";

import * as React from "react";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { useBoardStore } from "../nodes/board-store";
import { useColorStore } from "../color/color-store";
import { useGraphEditor } from "../timeline/graph-editor";
import { resolvePanel, usePanels } from "../state/panels";
import { useSession } from "../state/session";
import { PanelBoundary } from "../runtime/ErrorBoundary";
import { OverlayPanel } from "../panels/OverlayPanel";
// Also installs the document title (`<project> — <product>`) on import.
import { panelDef } from "../panels/panel-registry";
import { TIME_FAMILY, editorMeta, type EditorId } from "./editor-registry";
import { findNode, regionOf, regions, setSizes, type LayoutNode, type RegionNode, type SplitNode, type Workspace } from "./layout-tree";
import { LEGACY_REGION_KEY, takeSizeSync, useLayout, useLayoutEpoch } from "./store";
import type { ImperativePanelGroupHandle } from "react-resizable-panels";
import { WS_NODE_ATTR, setDragRoot } from "./drag";
import { RegionTabStrip } from "./TabStrip";
import { InspectorSectionBar } from "../inspector/InspectorSectionBar";
import { TimeZoomKeys, TimelineRegionBody } from "./time-bodies";

/**
 * THE SHELL, RENDERED FROM THE TREE.
 *
 * Every split is a resizable group, every region a card. The legacy node ids
 * ("tm-vertical", "tm-horizontal" → panel "main", "left", "stage",
 * "inspector", "timeline") are the ids the old hand-written layout used, so
 * react-resizable-panels restores the sizes it saved for them: an existing
 * user's first load of this shell is their old layout, to the pixel.
 *
 * PERFORMANCE: the shell subscribes to the tree's STRUCTURE (a string with no
 * sizes) and to a VISIBILITY key. Resizing writes sizes into the store
 * without re-rendering anything; a drag preview lives in another store
 * entirely. Region bodies are memoised by (id, active editor), so the stage
 * and the timeline content never re-render because chrome moved.
 */

/** Panel ids inside their parent group — "main" is what the old vertical group called its top half. */
const panelIdOf = (node: LayoutNode) => (node.id === "tm-horizontal" ? "main" : node.id);

/** The old hand-tuned constraints, kept for the legacy regions (percent of the group). */
const LEGACY: Record<string, { min: number; max?: number; collapsible?: boolean }> = {
  left: { min: 8, max: 45, collapsible: true },
  stage: { min: 15 },
  inspector: { min: 15, max: 50, collapsible: true },
  timeline: { min: 10, max: 85 },
  "tm-horizontal": { min: 35 },
};

/** The tree without sizes — what the shell re-renders on. */
function structureKey(ws: Workspace): string {
  const walk = (n: LayoutNode): string =>
    n.kind === "region"
      ? `R(${n.id}|${n.active}|${n.editors.join(",")}|${n.rail ?? ""}|${n.collapsed ? 1 : 0})`
      : `S(${n.id}|${n.axis}|${n.children.map((c) => walk(c.node)).join(";")})`;
  return `${walk(ws.root)}#${ws.maximised ?? ""}`;
}

/**
 * Which regions are SHOWING — the visibility layer read for the tree. One
 * string so the shell re-renders only when a region appears or goes.
 */
function useVisibilityKey(ws: Workspace): string {
  const focus = usePanels((s) => s.focusMode);
  const left = usePanels((s) => resolvePanel(s, "left"));
  const inspector = usePanels((s) => resolvePanel(s, "inspector"));
  const timeline = usePanels((s) => resolvePanel(s, "timeline"));
  const graphOpen = useGraphEditor((s) => s.open);
  const graphTab = useGraphEditor((s) => s.tab);
  const nodes = useBoardStore((s) => s.isOpen);
  const color = useColorStore((s) => s.open);
  return regions(ws.root)
    .filter((r) => {
      if (r.editors.includes("stage")) return true;
      if (focus) return false;
      if (r.id === "left") return left;
      if (r.id === "inspector") return inspector;
      if (r.id === "timeline") {
        // Another editor dropped into the bottom rail owns the region while active.
        if (!TIME_FAMILY.includes(r.active)) return !r.collapsed;
        const has = (e: EditorId) => r.editors.includes(e);
        return (timeline && has("timeline")) || (graphOpen && has(graphTab)) || (nodes && has("nodes")) || (color && has("color"));
      }
      return !r.collapsed;
    })
    .map((r) => r.id)
    .join(",");
}

/**
 * The project's identity (D2, `Project name ⌄`) sits at the top of the
 * LEFT-MOST docked region — whichever editor it shows — because "which file
 * am I in" is the question every other panel assumes is answered.
 */
const HeaderHost = React.createContext<string | null>(null);

function leftmostRegion(root: LayoutNode, shown: ReadonlySet<string>): string | null {
  const first = (n: LayoutNode): RegionNode | null => {
    if (n.kind === "region") return shown.has(n.id) ? n : null;
    // Row: the first visible child is the left-most; column: the TOP child
    // spans the left edge only if it is the first.
    for (const c of n.children) {
      const r = first(c.node);
      if (r) return r;
    }
    return null;
  };
  const r = first(root);
  return r && !r.editors.includes("stage") && r.id !== "timeline" ? r.id : null;
}

const visibleIn = (node: LayoutNode, shown: ReadonlySet<string>): boolean =>
  node.kind === "region" ? shown.has(node.id) : node.children.some((c) => visibleIn(c.node, shown));

export function WorkspaceShell({ compact }: { compact: boolean }) {
  const structure = useLayout((s) => structureKey(s.ws));
  // Read the tree only when its STRUCTURE changed. Sizes are written behind
  // the shell's back (onLayout) and read by the groups on mount.
  const ws = React.useMemo(() => useLayout.getState().ws, [structure]); // eslint-disable-line react-hooks/exhaustive-deps
  const epoch = useLayoutEpoch((s) => s.epoch);
  const visKey = useVisibilityKey(ws);
  const shown = React.useMemo(() => new Set(visKey.split(",").filter(Boolean)), [visKey]);
  const overlay = usePanels((s) => s.overlay);

  const rootRef = React.useCallback((el: HTMLDivElement | null) => {
    useLayout.getState().setContainer(el);
    setDragRoot(el);
  }, []);

  // ⌃Space — maximise the focused region (Blender). Esc restores.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input,textarea,[contenteditable='true']")) return;
      const max = useLayout.getState().ws.maximised;
      if (e.key === "Escape" && max) {
        useLayout.getState().toggleMaximised(max);
        return;
      }
      if (e.code !== "Space" || !e.ctrlKey || e.metaKey || e.altKey) return;
      const el = document.activeElement?.closest(`[data-region]`) ?? document.querySelector(`[data-region]:hover`);
      const id = el?.getAttribute("data-region") ?? "stage";
      e.preventDefault();
      useLayout.getState().toggleMaximised(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const keys = <TimeZoomKeys />;

  if (compact) {
    // COMPACT: the tree is untouched; it is PRESENTED as the stage over the
    // timeline region with every other region one overlay away — exactly the
    // old compact layout, which is what "a phone never rewrites the desktop"
    // means structurally.
    const stage = regions(ws.root).find((r) => r.editors.includes("stage"))!;
    const bottom = regions(ws.root).find((r) => r.id === "timeline");
    const bottomShown = bottom ? shown.has(bottom.id) : false;
    const floating = regions(ws.root).filter((r) => r !== stage && r !== bottom);
    return (
      <div ref={rootRef} className="relative flex min-h-0 min-w-0 flex-1">
        {keys}
        <ResizablePanelGroup direction="vertical" className="min-h-0 flex-1" key={`compact:${epoch}`} autoSaveId="tm-vertical-compact">
          <ResizablePanel id="main" order={1} defaultSize={58} minSize={25}>
            <div className="h-full" {...{ [WS_NODE_ATTR]: stage.id }}>
              <RegionView region={stage} />
            </div>
          </ResizablePanel>
          {bottom && bottomShown && (
            <>
              <ResizableHandle />
              <ResizablePanel id="timeline" order={2} defaultSize={42} minSize={10} maxSize={85}>
                <div className="h-full" {...{ [WS_NODE_ATTR]: bottom.id }}>
                  <RegionView region={bottom} />
                </div>
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
        {floating.map((r) => {
          const key = LEGACY_REGION_KEY[r.id];
          const open = key ? shown.has(r.id) : overlay === r.id;
          if (!open) return null;
          const side = r.id === "inspector" || r.rail === "right" ? "right" : "left";
          return (
            <OverlayPanel key={r.id} panel={key ?? r.id} side={side} title={editorMeta(r.active)?.name ?? "Panel"}>
              <RegionBody regionId={r.id} active={r.active} />
            </OverlayPanel>
          );
        })}
      </div>
    );
  }

  const maxed = ws.maximised ? findNode(ws.root, ws.maximised) : null;
  const headerHost = leftmostRegion(ws.root, shown);
  return (
    <HeaderHost.Provider value={headerHost}>
    <div ref={rootRef} className="relative flex min-h-0 min-w-0 flex-1" {...{ [WS_NODE_ATTR]: maxed ? undefined : ws.root.id }}>
      {keys}
      {maxed && maxed.kind === "region" ? (
        <div className="h-full min-w-0 flex-1" {...{ [WS_NODE_ATTR]: maxed.id }}>
          <RegionView region={maxed} />
        </div>
      ) : ws.root.kind === "region" ? (
        <div className="h-full min-w-0 flex-1">
          <RegionView region={ws.root} />
        </div>
      ) : (
        <SplitView split={ws.root} shown={shown} epoch={epoch} />
      )}
    </div>
    </HeaderHost.Provider>
  );
}

function SplitView({ split, shown, epoch }: { split: SplitNode; shown: ReadonlySet<string>; epoch: number }) {
  const visible = split.children.map((c, i) => ({ ...c, order: i + 1 })).filter((c) => visibleIn(c.node, shown));
  // A single visible child needs no group (and must not cost a handle).
  if (visible.length === 1) {
    const only = visible[0]!.node;
    return only.kind === "region" ? (
      <div className="h-full w-full" {...{ [WS_NODE_ATTR]: only.id }}>
        <RegionView region={only} />
      </div>
    ) : (
      <div className="h-full w-full" {...{ [WS_NODE_ATTR]: only.id }}>
        <SplitView split={only} shown={shown} epoch={epoch} />
      </div>
    );
  }
  const total = visible.reduce((a, c) => a + c.size, 0) || 1;

  // A structural change rewrote this split's sizes: show the TREE's, not the
  // percentages the library restored from its own storage (see `takeSizeSync`).
  // A passive effect on purpose: it runs after the group's own effects, so
  // nothing the library restores afterwards can undo it.
  const group = React.useRef<ImperativePanelGroupHandle>(null);
  React.useEffect(() => {
    if (!takeSizeSync(split.id)) return;
    group.current?.setLayout(visible.map((c) => (c.size / total) * 100));
  });

  const onLayout = (sizes: number[]) => {
    // Write the measured sizes back for the VISIBLE children, keeping the
    // hidden ones' shares: a region you hide and show again comes back the
    // size it was.
    const live = useLayout.getState().ws;
    const node = findNode(live.root, split.id);
    if (!node || node.kind !== "split") return;
    const visTotal = node.children.filter((c) => visibleIn(c.node, shown)).reduce((a, c) => a + c.size, 0);
    let vi = 0;
    const next = node.children.map((c) => (visibleIn(c.node, shown) ? ((sizes[vi++] ?? 0) / 100) * visTotal : c.size));
    scheduleSizes(split.id, next);
  };

  return (
    <ResizablePanelGroup
      ref={group}
      direction={split.axis === "row" ? "horizontal" : "vertical"}
      className="min-h-0 min-w-0 flex-1"
      autoSaveId={split.id}
      key={`${split.id}:${epoch}`}
      onLayout={onLayout}
    >
      {visible.map((c, i) => {
        const legacy = LEGACY[c.node.id];
        const isRegion = c.node.kind === "region";
        const region = isRegion ? (c.node as RegionNode) : null;
        const key = region ? LEGACY_REGION_KEY[region.id] : undefined;
        return (
          <React.Fragment key={c.node.id}>
            {i > 0 && <ResizableHandle />}
            <ResizablePanel
              id={panelIdOf(c.node)}
              order={c.order}
              defaultSize={(c.size / total) * 100}
              minSize={legacy?.min ?? minPercent(c.node, split.axis)}
              maxSize={legacy?.max}
              collapsible={legacy?.collapsible}
              collapsedSize={legacy?.collapsible ? 2 : undefined}
              onCollapse={
                legacy?.collapsible && key && key !== "timeline"
                  ? () => usePanels.getState().setVisible(key, false)
                  : undefined
              }
            >
              <div className="h-full w-full" {...{ [WS_NODE_ATTR]: c.node.id }}>
                {region ? <RegionView region={region} /> : <SplitView split={c.node as SplitNode} shown={shown} epoch={epoch} />}
              </div>
            </ResizablePanel>
          </React.Fragment>
        );
      })}
    </ResizablePanelGroup>
  );
}

/** A user region's floor, as a percent of a typical window (the library speaks only %). */
function minPercent(node: LayoutNode, axis: SplitNode["axis"]): number {
  const minPx = (n: LayoutNode): number => {
    if (n.kind === "region") {
      const m = editorMeta(n.active)?.minSize;
      return m ? (axis === "row" ? m.w : m.h) : 120;
    }
    return Math.max(...n.children.map((c) => minPx(c.node)));
  };
  const len = typeof window === "undefined" ? 1200 : axis === "row" ? window.innerWidth - 108 : window.innerHeight - 44;
  return Math.min(40, Math.max(5, (minPx(node) / Math.max(1, len)) * 100));
}

let sizeTimer = 0;
const pendingSizes = new Map<string, number[]>();
/** Sizes trickle into the store (and storage) once a resize settles. */
function scheduleSizes(splitId: string, sizes: number[]) {
  pendingSizes.set(splitId, sizes);
  window.clearTimeout(sizeTimer);
  sizeTimer = window.setTimeout(() => {
    const batch = [...pendingSizes];
    pendingSizes.clear();
    useLayout.getState().apply((ws) => batch.reduce((w, [id, s]) => setSizes(w, id, s), ws), { sizesOnly: true });
  }, 160);
}

/**
 * A REGION: one card, one editor at a time. Its editor list is PRESENTED by
 * `rail`: a window-edge rail (no header — the pixel-identical default for the
 * classic regions) or, for a region the user made, a named tab strip in its
 * header (`TabStrip.tsx`).
 */
const RegionView = React.memo(function RegionView({ region }: { region: RegionNode }) {
  const header = region.rail === null && (region.editors.length > 1 || !region.editors.includes("stage"));
  return (
    <div className="shell-card flex h-full min-h-0 flex-col" data-region={region.id}>
      {header && <RegionTabStrip region={region} />}
      <div className="flex min-h-0 flex-1 flex-col">
        <RegionBody regionId={region.id} active={region.active} />
      </div>
    </div>
  );
});

/**
 * Properties carries its SECTIONS wherever it goes. On a rail (right, left, or
 * the compact dock) the rail shows them; anywhere else — a region's tab strip,
 * a floating or OS window — the panel shows its own section bar on top, or
 * Effects and Sound would be unreachable.
 */
function InspectorHost({ body: Body }: { body: React.ComponentType }) {
  const onRail = useLayout((s) => !!regionOf(s.ws, "inspector")?.rail);
  if (onRail)
    return (
      <InspectorBoundary>
        <div className="contents" data-pick-area="inspector">
          <Body />
        </div>
      </InspectorBoundary>
    );
  return (
    <InspectorBoundary>
      <div className="flex h-full min-h-0 flex-col" data-pick-area="inspector">
        <InspectorSectionBar />
        <div className="flex min-h-0 flex-1 flex-col">
          <Body />
        </div>
      </div>
    </InspectorBoundary>
  );
}

/** The Properties panel heals on the next selection. */
function InspectorBoundary({ children }: { children: React.ReactNode }) {
  const selection = useSession((s) => s.selectedClipIds);
  return (
    <PanelBoundary name="Properties" resetKey={selection}>
      {children}
    </PanelBoundary>
  );
}

/**
 * One editor's body, memoised on (region, editor) — the only two facts that
 * change what it draws. Exported for floating and OS-window hosts.
 */
export const RegionBody = React.memo(function RegionBody({ regionId, active }: { regionId: string; active: EditorId }) {
  if (regionId === "timeline" && TIME_FAMILY.includes(active)) return <TimelineRegionBody regionId={regionId} />;
  return <EditorBody editor={active} />;
});

export const EditorBody = React.memo(function EditorBody({ editor }: { editor: EditorId }) {
  const def = panelDef(editor);
  if (!def) return null;
  const Body = def.component;
  if (editor === "inspector") return <InspectorHost body={Body} />;
  if (editor === "stage")
    return (
      <PanelBoundary name="Canvas">
        <Body />
      </PanelBoundary>
    );
  return (
    <div className="flex h-full min-h-0 flex-col" data-pick-area={editor}>
      <PanelBoundary name={def.name} resetKey={editor}>
        <Body />
      </PanelBoundary>
    </div>
  );
});
