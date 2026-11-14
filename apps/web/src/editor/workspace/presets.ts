/**
 * WORKSPACE PRESETS (README D3) — "a preset is just a tree", plus the two
 * facts a tree does not carry:
 *
 *   • `panels` — the visibility layer (`state/panels.ts`). Hiding a region is
 *     not a structural change: the region keeps its slot and its rail, which
 *     is what lets a phone, focus mode and workspace memory all hide things
 *     without rewriting the desktop tree.
 *   • `surfaces` — which time-family surfaces are open INSIDE the bottom
 *     region (their own stores own that: graph editor, colour, nodes).
 *
 * Saved workspaces ("Save as new workspace") are the same shape, captured.
 */

import type { EditorId } from "./editor-registry";
import { defaultWorkspace, setActive, splitRegion, type Workspace } from "./layout-tree";

export type PresetId = "animate" | "design" | "draw" | "color" | "sound";

export interface PresetVisibility {
  left?: boolean;
  inspector?: boolean;
  timeline?: boolean;
  mixer?: boolean;
}

export interface SurfaceState {
  /** Keyframes / Curves under the lanes, or closed. */
  graph?: "keys" | "curves" | null;
  color?: boolean;
  nodes?: boolean;
}

export interface WorkspacePreset {
  id: string;
  name: string;
  build: () => Workspace;
  panels: PresetVisibility;
  surfaces: SurfaceState;
  /** Inspector tab to arm, if the preset is about one. */
  inspectorTab?: string;
}

const withLeft = (ws: Workspace, editor: EditorId) => setActive(ws, "left", editor);

export const PRESETS: readonly WorkspacePreset[] = [
  {
    id: "animate",
    name: "Animate",
    build: () => defaultWorkspace(),
    panels: { left: true, inspector: true, timeline: true, mixer: true },
    surfaces: { graph: null, color: false, nodes: false },
  },
  {
    id: "design",
    name: "Design",
    // A design has no clock: the canvas takes the timeline's room.
    build: () => defaultWorkspace(),
    panels: { left: true, inspector: true, timeline: false, mixer: false },
    surfaces: { graph: null, color: false, nodes: false },
    inspectorTab: "design",
  },
  {
    id: "draw",
    name: "Draw",
    // Canvas-first: layers reachable, properties one rail-click away.
    build: () => withLeft(defaultWorkspace(), "layers"),
    panels: { left: true, inspector: false, timeline: true, mixer: false },
    surfaces: { graph: null, color: false, nodes: false },
  },
  {
    id: "color",
    name: "Color",
    // Grading wants the curves BESIDE the canvas, not under the lanes: a
    // Curves region splits off the stage's right, the colour page takes the
    // bottom.
    build: () => splitRegion(defaultWorkspace(), "stage", "right", "curves", 0.38),
    panels: { left: false, inspector: true, timeline: true, mixer: false },
    surfaces: { graph: null, color: true, nodes: false },
    inspectorTab: "effects",
  },
  {
    id: "sound",
    name: "Sound",
    build: () => withLeft(defaultWorkspace(), "library"),
    panels: { left: true, inspector: true, timeline: true, mixer: true },
    surfaces: { graph: null, color: false, nodes: false },
    inspectorTab: "sound",
  },
];

export function presetById(id: string): WorkspacePreset | undefined {
  return PRESETS.find((p) => p.id === id);
}
