"use client";

/**
 * THE LAYOUT STORE — the workspace tree, live. Its own zustand store on
 * purpose: dragging a panel, previewing a drop or resizing a split writes
 * HERE and nowhere else, so the stage and the timeline (which subscribe to
 * the document and the session) never re-render because chrome moved.
 *
 * Two layers, kept apart (see `presets.ts`):
 *   • STRUCTURE — this tree: which editor lives in which region, splits,
 *     floating and OS windows. Persisted per browser.
 *   • VISIBILITY — `state/panels.ts`: density, focus mode, workspace memory,
 *     the base show/hide flags. A phone, focus mode or an auto-armed
 *     workspace hides things WITHOUT touching the tree, which is what keeps
 *     a narrow window from ever rewriting the desktop layout.
 */

import { create } from "zustand";
import { useBoardStore } from "../nodes/board-store";
import { useColorStore } from "../color/color-store";
import { useGraphEditor } from "../timeline/graph-editor";
import { setRevealHandler, usePanels, type PanelKey } from "../state/panels";
import { useSession } from "../state/session";
import { TIME_FAMILY, editorMeta, type EditorId } from "./editor-registry";
import {
  addToRegion,
  allNodes,
  closeEditor,
  defaultWorkspace,
  findRegion,
  hostOf,
  insertAtEdge,
  migrateFromLegacy,
  parseWorkspace,
  regionOf,
  serialise,
  setActive,
  setCollapsed,
  setFloatingBounds,
  setMaximised,
  type Bounds,
  type Workspace,
} from "./layout-tree";
import { presetById, type WorkspacePreset } from "./presets";
import { placeFloating, transition } from "./window-host";
import { osWindowSupport } from "./os-window";

const TREE_KEY = "tm-workspace-tree-v1";
const SAVED_KEY = "tm-workspace-saved-v1";

/** Region ids whose visibility the legacy flags own (wide layout). */
export const LEGACY_REGION_KEY: Record<string, PanelKey> = { left: "left", inspector: "inspector", timeline: "timeline" };

export interface SavedWorkspace {
  id: string;
  name: string;
  tree: string;
  panels: Partial<Record<PanelKey, boolean>>;
}

interface LayoutState {
  ws: Workspace;
  saved: SavedWorkspace[];
  /** The preset or saved workspace last applied (for the menu's check). */
  current: string;
  /**
   * Change the tree. `sizesOnly` is for the resize handles writing back what
   * the groups already show; every other change is STRUCTURAL, and any split
   * whose sizes it rewrote is queued for `takeSizeSync` so the mounted group
   * shows the tree's sizes rather than the ones it remembers.
   */
  apply: (fn: (ws: Workspace) => Workspace, opts?: { sizesOnly?: boolean }) => void;
  /** The workspace container's rect (the shell registers it). */
  rect: () => Bounds;
  setContainer: (el: HTMLElement | null) => void;

  /** "Take me to X" — wherever X lives, show it. Every reveal goes here. */
  reveal: (editor: EditorId) => void;
  float: (editor: EditorId, at?: { x: number; y: number }) => void;
  toWindow: (editor: EditorId) => void;
  home: (editor: EditorId) => void;
  /** An OS window that could not open becomes a floating window, same HOME. */
  windowToFloating: (editor: EditorId) => void;
  close: (editor: EditorId) => void;
  setBounds: (editor: EditorId, patch: Partial<Bounds>) => void;
  toggleMinimized: (editor: EditorId) => void;
  toggleMaximised: (regionId: string) => void;

  applyPreset: (id: string) => void;
  reset: () => void;
  saveAs: (name: string) => void;
  removeSaved: (id: string) => void;
}

let container: HTMLElement | null = null;

function load(): Workspace {
  if (typeof window === "undefined") return defaultWorkspace();
  try {
    const parsed = parseWorkspace(window.localStorage.getItem(TREE_KEY));
    if (parsed) return parsed;
  } catch {
    // Private mode — fall through to migration.
  }
  // First run of the tree: migrate. The visibility flags stay where they
  // are (panels.ts) and the resizable groups find their saved sizes under
  // the same ids, so this IS the layout the user had.
  return migrateFromLegacy({});
}

function loadSaved(): SavedWorkspace[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(SAVED_KEY);
    const list = raw ? (JSON.parse(raw) as SavedWorkspace[]) : [];
    return Array.isArray(list) ? list.filter((s) => s && typeof s.id === "string" && typeof s.tree === "string") : [];
  } catch {
    return [];
  }
}

function persist(ws: Workspace) {
  try {
    window.localStorage.setItem(TREE_KEY, serialise(ws));
  } catch {
    // Quota / private mode — the layout just won't persist.
  }
}

function persistSaved(saved: SavedWorkspace[]) {
  try {
    window.localStorage.setItem(SAVED_KEY, JSON.stringify(saved));
  } catch {
    // ignore
  }
}

function viewport(): { width: number; height: number } {
  return typeof window === "undefined" ? { width: 1440, height: 900 } : { width: window.innerWidth, height: window.innerHeight };
}

/**
 * Make a REGION visible. Legacy regions answer to their flag (so the Window
 * menu, shortcuts, workspace memory and compact overlays keep working);
 * regions the user made answer to their own `collapsed`, and on compact
 * they float over the stage like the side panels always have.
 */
export function showRegion(regionId: string): void {
  const key = LEGACY_REGION_KEY[regionId];
  const panels = usePanels.getState();
  if (key && key !== "timeline") {
    panels.setVisible(key, true);
    return;
  }
  if (!key) {
    if (panels.density === "compact" && regionId !== "stage") panels.setOverlayRegion(regionId);
    useLayout.getState().apply((ws) => setCollapsed(ws, regionId, false));
  }
}

/** Open a time-family surface INSIDE the bottom region (its own store says so). */
function showInBottom(editor: EditorId): void {
  switch (editor) {
    case "timeline":
      usePanels.getState().setVisible("timeline", true);
      return;
    case "keys":
    case "curves":
      useGraphEditor.getState().show(editor);
      return;
    case "nodes":
      useBoardStore.getState().open();
      useColorStore.getState().setOpen(false);
      return;
    case "color":
      useColorStore.getState().setOpen(true);
      useBoardStore.getState().close();
      return;
    case "mixer":
      usePanels.getState().setVisible("mixer", true);
      return;
  }
}

export const useLayout = create<LayoutState>((set, get) => {
  const commit = (ws: Workspace) => {
    const prevLeft = findRegion(get().ws, "left")?.active;
    set({ ws });
    persist(ws);
    // Mirror the left region's editor onto the session for code that still
    // reads `leftTab` (the agent bridge, quick actions). One writer: here.
    const left = findRegion(ws, "left")?.active;
    if (left && left !== prevLeft) {
      try {
        useSession.getState().setLeftTab(left as never);
      } catch {
        // leftTab union narrower than the editor set — nothing to mirror.
      }
    }
  };

  const applyLayoutPreset = (preset: Pick<WorkspacePreset, "build" | "panels" | "surfaces" | "inspectorTab">, id: string) => {
    commit(preset.build());
    const panels = usePanels.getState();
    for (const [k, v] of Object.entries(preset.panels)) if (v !== undefined) panels.setVisible(k as PanelKey, v);
    const s = preset.surfaces;
    if (s.graph) useGraphEditor.getState().show(s.graph);
    else if (s.graph === null) useGraphEditor.getState().setOpen(false);
    if (s.color !== undefined) useColorStore.getState().setOpen(s.color);
    if (s.nodes) useBoardStore.getState().open();
    else if (s.nodes === false) useBoardStore.getState().close();
    if (preset.inspectorTab) {
      try {
        useSession.getState().setInspectorTab(preset.inspectorTab as never);
      } catch {
        // tab not offered for this selection; the rail will pick one.
      }
    }
    set({ current: id });
  };

  return {
    ws: load(),
    saved: loadSaved(),
    current: "animate",
    apply: (fn, opts) => {
      const prev = get().ws;
      const next = fn(prev);
      if (next === prev) return;
      if (!opts?.sizesOnly) queueSizeSync(prev, next);
      commit(next);
    },
    rect: () => {
      const r = container?.getBoundingClientRect();
      if (r && r.width > 0) return { x: r.left, y: r.top, width: r.width, height: r.height };
      const v = viewport();
      return { x: 64, y: 8, width: v.width - 108, height: v.height - 44 };
    },
    setContainer: (el) => {
      container = el;
    },

    reveal: (editor) => {
      const ws = get().ws;
      const host = hostOf(ws, editor);
      if (host === "floating") {
        get().apply((w) => ({ ...w, floating: w.floating.map((f) => (f.editor === editor ? { ...f, minimized: false } : f)) }));
        return;
      }
      if (host === "window") {
        osWindowFocus(editor);
        return;
      }
      if (host === null) {
        // Closed: it comes back where it would by default — the left region
        // for document surfaces, a right column otherwise.
        const fallback = findRegion(ws, "left") ? "left" : null;
        get().apply((w) => (fallback ? addToRegion(w, fallback, editor) : insertAtEdge(w, "right", editor)));
      }
      const region = regionOf(get().ws, editor);
      if (!region) return;
      if (region.id === "timeline") {
        // The bottom region STACKS its time family from their own stores; any
        // other editor dropped into its rail takes the region over as `active`.
        // Switching between the two worlds is the one time `active` is written.
        const timeNow = TIME_FAMILY.includes(region.active);
        const timeNext = TIME_FAMILY.includes(editor);
        if (timeNow !== timeNext || !timeNext || region.collapsed)
          get().apply((w) => setCollapsed(setActive(w, region.id, editor), region.id, false));
        if (timeNext) showInBottom(editor);
        return;
      }
      get().apply((w) => setActive(w, region.id, editor));
      showRegion(region.id);
    },

    float: (editor, at) => {
      const meta = editorMeta(editor);
      if (!meta) return;
      const bounds = placeFloating(meta.floatSize, viewport(), get().ws.floating.length, at);
      get().apply((ws) => transition(ws, editor, { to: "floating", bounds }, get().rect()));
    },
    toWindow: (editor) => {
      const meta = editorMeta(editor);
      if (!meta || osWindowSupport() !== "portal") return;
      const v = viewport();
      const bounds = { x: Math.round(v.width / 2 - meta.floatSize.w / 2), y: 80, width: meta.floatSize.w, height: meta.floatSize.h };
      get().apply((ws) => transition(ws, editor, { to: "window", bounds }, get().rect(), "portal"));
    },
    home: (editor) => {
      get().apply((ws) => transition(ws, editor, { to: "home" }, get().rect()));
      get().reveal(editor);
    },
    windowToFloating: (editor) => {
      const meta = editorMeta(editor);
      get().apply((ws) => {
        const w = ws.windows.find((x) => x.editor === editor);
        if (!w || !meta) return ws;
        const bounds = placeFloating(meta.floatSize, viewport(), ws.floating.length);
        return { ...ws, windows: ws.windows.filter((x) => x !== w), floating: [...ws.floating, { editor, bounds, home: w.home }] };
      });
    },
    close: (editor) => get().apply((ws) => closeEditor(ws, editor)),
    setBounds: (editor, patch) => get().apply((ws) => setFloatingBounds(ws, editor, patch)),
    toggleMinimized: (editor) =>
      get().apply((ws) => ({ ...ws, floating: ws.floating.map((f) => (f.editor === editor ? { ...f, minimized: !f.minimized } : f)) })),
    toggleMaximised: (regionId) => get().apply((ws) => setMaximised(ws, ws.maximised === regionId ? null : regionId)),

    applyPreset: (id) => {
      const preset = presetById(id);
      if (preset) {
        applyLayoutPreset(preset, id);
        return;
      }
      const saved = get().saved.find((s) => s.id === id);
      const tree = saved ? parseWorkspace(saved.tree) : null;
      if (saved && tree) applyLayoutPreset({ build: () => tree, panels: saved.panels, surfaces: {} }, id);
    },
    reset: () => {
      const id = get().current;
      const preset = presetById(id) ?? presetById("animate")!;
      applyLayoutPreset(preset, preset.id);
      // The split sizes live in react-resizable-panels' own storage under the
      // node ids; a reset that left them would "reset" to the old proportions.
      try {
        for (const k of Object.keys(window.localStorage)) {
          if (k.startsWith("react-resizable-panels:")) window.localStorage.removeItem(k);
        }
      } catch {
        // ignore
      }
      bumpLayoutEpoch();
    },
    saveAs: (name) => {
      const p = usePanels.getState();
      const entry: SavedWorkspace = {
        id: `saved-${Date.now().toString(36)}`,
        name: name.trim() || "Workspace",
        tree: serialise(get().ws),
        panels: { left: p.left, inspector: p.inspector, timeline: p.timeline, mixer: p.mixer },
      };
      const saved = [...get().saved, entry];
      persistSaved(saved);
      set({ saved, current: entry.id });
    },
    removeSaved: (id) => {
      const saved = get().saved.filter((s) => s.id !== id);
      persistSaved(saved);
      set({ saved });
    },
  };
});

setRevealHandler((editor) => useLayout.getState().reveal(editor));

/**
 * THE TREE IS THE SIZE AUTHORITY. react-resizable-panels remembers each
 * group's percentages under its `autoSaveId` and restores them on mount — so
 * a drop that rewrote a split's sizes (a new dock keeps the side columns'
 * widths and takes its room from the stage) was overridden by the old
 * percentages the moment the group remounted under its new parent, then
 * reported them back through `onLayout` — the preview said Layers keeps
 * 220px, the result squeezed it to 165. Structural changes forget the
 * library's memory for every split whose sizes changed and queue it; a
 * still-mounted group takes the tree's sizes once (`takeSizeSync`), and the
 * library then saves them as usual. Resizes (`sizesOnly`) never queue — they ARE the
 * library's sizes.
 */
const sizeSync = new Set<string>();
function queueSizeSync(prev: Workspace, next: Workspace): void {
  const was = new Map<string, string>();
  for (const n of allNodes(prev.root)) if (n.kind === "split") was.set(n.id, n.children.map((c) => `${c.node.id}=${c.size.toFixed(4)}`).join(","));
  for (const n of allNodes(next.root)) {
    if (n.kind !== "split") continue;
    const now = n.children.map((c) => `${c.node.id}=${c.size.toFixed(4)}`).join(",");
    if (was.get(n.id) !== now) {
      sizeSync.add(n.id);
      // A group that REMOUNTS (reparented under a new split) restores from
      // here before anything can tell it otherwise; with nothing saved it
      // takes its `defaultSize`, which is the tree's.
      try {
        window.localStorage.removeItem(`react-resizable-panels:${n.id}`);
      } catch {
        // private mode — the push below still applies
      }
    }
  }
}
/** True once for a split whose sizes a structural change rewrote. */
export function takeSizeSync(splitId: string): boolean {
  return sizeSync.delete(splitId);
}

/**
 * A remount key for the resizable groups. Resetting the workspace clears the
 * library's saved sizes, but a MOUNTED group keeps its in-memory layout, so
 * the shell keys its groups on this.
 */
export const useLayoutEpoch = create<{ epoch: number }>(() => ({ epoch: 0 }));
function bumpLayoutEpoch() {
  useLayoutEpoch.setState((s) => ({ epoch: s.epoch + 1 }));
}

/** Focus an OS window (the host registers its handles). */
const osFocus = new Map<EditorId, () => void>();
export function registerOsWindowFocus(editor: EditorId, fn: (() => void) | null): void {
  if (fn) osFocus.set(editor, fn);
  else osFocus.delete(editor);
}
function osWindowFocus(editor: EditorId): void {
  osFocus.get(editor)?.();
}
