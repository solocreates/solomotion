"use client";

import * as React from "react";
import {
  AudioLines,
  Frame as FrameIcon,
  Image as ImageIcon,
  Layers,
  Library,
  Palette,
  PanelBottom,
  Puzzle,
  SlidersHorizontal,
  Sparkles,
  Spline,
  SquareTerminal,
  Waypoints,
} from "lucide-react";
import { LayersPanel } from "./LayersPanel";
import { LibraryBrowser } from "../library/LibraryBrowser";
import { MediaLibrary } from "./MediaLibrary";
import { PluginsPanel } from "../plugins/PluginsPanel";
import { Inspector } from "../inspector/Inspector";
import { CenterStage } from "../nodes/CenterStage";
import { lazyComponent } from "@/editor/lazy-component";
import { PanelBoundary } from "./PanelLoading";
import { EDITORS, editorMeta, LEFT_DEFAULT, type EditorId, type EditorMeta } from "../workspace/editor-registry";
import {
  StandaloneColor,
  StandaloneGraph,
  StandaloneMixer,
  StandaloneNodes,
  StandaloneTimeline,
} from "../workspace/time-bodies";

/**
 * The Agents panel is a LAZY chunk — its runtime, provider SDKs and skill load
 * the first time the panel opens, so an editor that never uses AI never pays
 * for it. Scripts are lazy for the same reason (CodeMirror and the runtime ride
 * in the chunk). Neither carries a fallback: every body is wrapped in ONE
 * boundary below, so a lazy panel only has to be lazy.
 */
const AgentsPanel = lazyComponent("AgentPanelChunk", () => import("../agent/AgentPanel"));
const ScriptsPanel = lazyComponent("ScriptsPanelChunk", () => import("../scripts/ScriptsPanel"));

/**
 * Every body inside the shared loading boundary, so whichever host draws it
 * (a region, a floating window, an OS window, a compact overlay) shows the
 * same loading state while a chunk arrives — never a blank panel.
 */
function bounded(Body: React.ComponentType): React.ComponentType {
  function Bounded() {
    return (
      <PanelBoundary>
        <Body />
      </PanelBoundary>
    );
  }
  Bounded.displayName = `Bounded(${Body.displayName ?? Body.name ?? "Panel"})`;
  return Bounded;
}

/**
 * THE VIEW BINDING — the React half of `workspace/editor-registry.ts`.
 *
 * The registry used to carry a `side`, and the side was the arrangement: a
 * panel born left could only ever be left. Location now belongs to the layout
 * tree, so this file binds only what React needs to draw an editor anywhere —
 * its icon and its prop-free body. Every host (a region, a floating window,
 * an OS window, a compact overlay) renders from here, so a view is written
 * once and appears identically wherever it is.
 *
 * Bodies that need to know their region (the stacked timeline slot) are
 * rendered by the shell itself; they are absent here on purpose.
 */
const VIEWS: Record<EditorId, { icon: React.ComponentType<{ className?: string }>; component: React.ComponentType }> = {
  stage: { icon: FrameIcon, component: CenterStage },
  layers: { icon: Layers, component: LayersPanel },
  inspector: { icon: SlidersHorizontal, component: Inspector },
  timeline: { icon: PanelBottom, component: StandaloneTimeline },
  keys: { icon: SlidersHorizontal, component: () => <StandaloneGraph tab="keys" /> },
  curves: { icon: Spline, component: () => <StandaloneGraph tab="curves" /> },
  color: { icon: Palette, component: StandaloneColor },
  nodes: { icon: Waypoints, component: StandaloneNodes },
  mixer: { icon: AudioLines, component: StandaloneMixer },
  library: { icon: Library, component: LibraryBrowser },
  media: { icon: ImageIcon, component: MediaLibrary },
  agents: { icon: Sparkles, component: AgentsPanel },
  scripts: { icon: SquareTerminal, component: ScriptsPanel },
  plugins: { icon: Puzzle, component: PluginsPanel },
};

export interface PanelDef extends EditorMeta {
  id: EditorId;
  icon: React.ComponentType<{ className?: string }>;
  component: React.ComponentType;
  /** Opening size for a sticky window (legacy name for `floatSize`). */
  defaultSize: { width: number; height: number };
}

export const PANELS: readonly PanelDef[] = EDITORS.map((e) => ({
  ...e,
  ...VIEWS[e.id],
  component: bounded(VIEWS[e.id].component),
  defaultSize: { width: e.floatSize.w, height: e.floatSize.h },
}));

export type AnyPanelDef = PanelDef;

/**
 * Which editor the left region shows — mirrored onto `session.leftTab` for
 * the code that still asks. Any editor can live there now, so it is the whole
 * editor set rather than a "left" subset.
 */
export type LeftTab = EditorId;

/** The default left region, in rail order (D10: Layers first). */
export const LEFT_PANELS: readonly PanelDef[] = LEFT_DEFAULT.map((id) => panelDef(id)!);

export function panelDef(id: string): PanelDef | undefined {
  return editorMeta(id) ? PANELS.find((p) => p.id === id) : undefined;
}

export function editorIcon(id: EditorId): React.ComponentType<{ className?: string }> {
  return VIEWS[id].icon;
}
