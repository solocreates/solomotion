"use client";

import { create } from "zustand";
import type { LeftTab } from "../panels/panel-registry";
import { useSession } from "./session";

/**
 * Panel layout state — which docked panels are visible. Which TAB the left panel
 * shows lives on the session (`session.leftTab`), the one place it ever lived
 * usefully; this store used to keep a second, finer-grained copy for the
 * library's own sub-tabs, and the two disagreed the moment the library stopped
 * having sub-tabs. This is what the Window menu checks/unchecks, so the
 * app feels like a real workstation: hide the inspector, pop the media library,
 * collapse the timeline. Persisted to localStorage so a layout survives reloads.
 *
 * A HIDDEN side panel is never gone: it collapses into a thin icon strip on
 * its edge (Blender/Photoshop) — its tabs stay one click away, and dragging a
 * panel's resize handle to (near) zero collapses it into the same strip.
 */


/** The dockable panels the Window menu governs (the stage is always present). */
export type PanelKey = "left" | "inspector" | "timeline" | "mixer";

/**
 * WORKSPACES (v32): a named layout, auto-armed by where you are — open a
 * flipbook and the sheet takes over; open a drawing and the chrome steps back
 * Procreate-style; step out and your own layout returns.
 *
 * Resolution order per panel:  workspace MEMORY  ∘  workspace PRESET  ∘  the
 * user's base flags. The preset is each workspace's factory default; the
 * MEMORY is what the user changed while that workspace was armed — persisted,
 * so "I opened the inspector inside drawing mode once" is remembered forever,
 * exactly like the base layout. Focus mode still trumps everything without
 * writing anything.
 */
export type Workspace = "default" | "flipbook" | "drawing" | "static";

const WORKSPACE_PRESETS: Record<Workspace, Partial<Record<PanelKey, boolean>>> = {
  default: {},
  // The sheet needs room; the inspector rarely matters while flipping.
  flipbook: { inspector: false },
  // Drawing: canvas-first — layers reachable, inspector one strip-click away.
  drawing: { inspector: false, left: true },
  // Static: a design has no clock — the canvas takes the timeline's room.
  static: { timeline: false },
};

type PanelFlags = Partial<Record<PanelKey, boolean>>;

/**
 * DENSITY (v33) — how much room the workspace has, and therefore how a docked
 * panel is PRESENTED.
 *
 * There used to be a second layout component for narrow screens: its own
 * chrome bar, its own two buttons, its own sheets. It knew nothing about the
 * rails, the panel registry, `sharedTabs`, the timeline surfaces or the Window
 * menu — so on a phone the app was a stage, a timeline and two icons, and
 * every control added to a rail since simply did not exist there. A forked
 * layout is a fork of the whole grammar, and it rots the moment either side
 * grows.
 *
 * So width is not a different LAYOUT. It is one more layer of the visibility
 * formula. `wide` docks a panel as a resizable column; `compact` floats it over
 * the stage, one at a time, because a 375px window cannot host a sidebar and a
 * canvas at once. Every caller keeps saying `setVisible("inspector", true)` and
 * asking `resolvePanel(s, "inspector")` — the rails, the app menu, the
 * shortcuts and the collapse gestures work identically at both widths without
 * knowing this exists.
 */
export type ShellDensity = "wide" | "compact";

/** Below this the workspace cannot hold two sidebars AND a usable canvas. */
export const COMPACT_MAX_WIDTH = 900;

/**
 * The side panels — the ones that become overlays when compact. The timeline
 * stays DOCKED at every width on purpose: a motion editor's bottom region is
 * not an inspection surface you visit, it is the thing you are editing, and it
 * has to be on screen at the same time as the stage. Every mobile NLE (Rush,
 * CapCut, LumaFusion) stacks them for the same reason.
 */
const OVERLAY_PANELS: readonly PanelKey[] = ["left", "inspector"];

const isOverlayPanel = (panel: PanelKey) => OVERLAY_PANELS.includes(panel);

interface PanelsState {
  left: boolean;
  inspector: boolean;
  timeline: boolean;
  /** The audio mixer docked at the timeline's right edge. */
  mixer: boolean;
  /** Focus mode: hides left/inspector/timeline without touching their own
   *  visibility flags, so toggling it off always returns exactly what was
   *  showing before. Deliberately not persisted — a reload should never
   *  come back in focus mode. */
  focusMode: boolean;
  /** The auto-armed workspace (navigation context drives it). */
  workspace: Workspace;
  /** How much room the shell has. Synced from one media query (see the hook). */
  density: ShellDensity;
  /**
   * Which side panel is floating over the stage while compact — at most one,
   * and never persisted. An overlay is a MODE you are in, not a layout you
   * keep: coming back to the app with a panel covering the canvas would read
   * as broken, and writing it to the shared flags would silently rearrange the
   * desktop layout from a phone.
   *
   * A PanelKey for the two classic side regions, or the id of a region the
   * user split off — on compact every non-stage, non-timeline region floats
   * the same way.
   */
  overlay: PanelKey | string | null;
  /** Per-workspace remembered layouts — the user's own changes inside each. */
  memory: Partial<Record<Workspace, PanelFlags>>;

  toggle: (panel: PanelKey) => void;
  setVisible: (panel: PanelKey, visible: boolean) => void;
  /** Reveal the media library: show the left panel and switch to its Media tab. */
  /**
   * Show a left surface: arm the tab and open the panel if it was closed. The
   * rail, the app menu and anything else that means "take me to Layers" go
   * through here — you asked to SEE something, not to set a hidden flag, and
   * every caller writing that pair by hand is how one of them forgets half.
   */
  showLeftPanel: (tab: LeftTab) => void;
  toggleFocusMode: () => void;
  setDensity: (density: ShellDensity) => void;
  /** Compact: float a user-made region over the stage (null puts it away). */
  setOverlayRegion: (regionId: string | null) => void;
  /** Arm a workspace (no-op when already armed). */
  setWorkspace: (w: Workspace) => void;
  /** What a panel actually shows right now: memory ∘ preset ∘ flags ∘ focus. */
  isShown: (panel: PanelKey) => boolean;
}

const STORAGE_KEY = "tm-panels-v1";
const MEMORY_KEY = "tm-workspace-memory-v1";

interface Persisted {
  left: boolean;
  inspector: boolean;
  timeline: boolean;
  mixer: boolean;
}

const DEFAULTS: Persisted = { left: true, inspector: true, timeline: true, mixer: true };

function load(): Persisted {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<Persisted>;
    return {
      left: p.left ?? DEFAULTS.left,
      inspector: p.inspector ?? DEFAULTS.inspector,
      timeline: p.timeline ?? DEFAULTS.timeline,
      mixer: p.mixer ?? DEFAULTS.mixer,
    };
  } catch {
    return DEFAULTS;
  }
}

function loadMemory(): Partial<Record<Workspace, PanelFlags>> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(MEMORY_KEY);
    return raw ? (JSON.parse(raw) as Partial<Record<Workspace, PanelFlags>>) : {};
  } catch {
    return {};
  }
}

/** The one visibility formula (exported for layout code that already has state). */
export function resolvePanel(
  s: Pick<
    PanelsState,
    "focusMode" | "workspace" | "memory" | "density" | "overlay" | "left" | "inspector" | "timeline" | "mixer"
  >,
  panel: PanelKey,
): boolean {
  if (s.focusMode) return false;
  // Compact: a side panel shows only while it is THE overlay. Deliberately
  // ahead of the workspace layers — a phone has no room for a workspace preset
  // to open a second sidebar, and "which one is over the stage" is a stricter
  // fact than "which ones would I like docked".
  if (s.density === "compact" && isOverlayPanel(panel)) return s.overlay === panel;
  return (
    s.memory[s.workspace]?.[panel] ??
    WORKSPACE_PRESETS[s.workspace][panel] ??
    s[panel]
  );
}

let revealHandler: ((editor: LeftTab) => void) | null = null;
/** The layout store registers how to reveal an editor (no import cycle). */
export function setRevealHandler(fn: (editor: LeftTab) => void): void {
  revealHandler = fn;
}

export const usePanels = create<PanelsState>((set, get) => {
  const persist = (patch: Partial<Persisted>) =>
    set((s) => {
      const next = { left: s.left, inspector: s.inspector, timeline: s.timeline, mixer: s.mixer, ...patch };
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Quota / private mode — the layout just won't persist.
      }
      return next;
    });

  const persistMemory = (memory: Partial<Record<Workspace, PanelFlags>>) => {
    try {
      window.localStorage.setItem(MEMORY_KEY, JSON.stringify(memory));
    } catch {
      // Quota / private mode — the workspace memory just won't persist.
    }
    set({ memory });
  };

  const setPanel = (panel: PanelKey, visible: boolean) => {
    const s = get();
    if (s.density === "compact" && isOverlayPanel(panel)) {
      // One overlay at a time: opening Layers puts away Properties. Two
      // stacked sheets over a 300px canvas is a pile, not a workspace.
      set({ overlay: visible ? panel : s.overlay === panel ? null : s.overlay });
      return;
    }
    if (s.workspace === "default") {
      // The base layout IS the default workspace's memory.
      persist({ [panel]: visible } as Partial<Persisted>);
      return;
    }
    // Inside a workspace: the change belongs to THAT workspace, forever.
    persistMemory({
      ...s.memory,
      [s.workspace]: { ...s.memory[s.workspace], [panel]: visible },
    });
  };

  return {
    ...load(),
    focusMode: false,
    workspace: "default" as Workspace,
    // Wide until the media query says otherwise: the server renders no window
    // to measure, and guessing compact would flash the phone layout onto every
    // desktop first paint.
    density: "wide" as ShellDensity,
    overlay: null,
    memory: loadMemory(),
    toggle: (panel) => setPanel(panel, !get().isShown(panel)),
    setVisible: (panel, visible) => setPanel(panel, visible),
    // "Take me to Layers" means Layers, wherever it lives now — a region, a
    // floating window or an OS window. The layout store answers that; this
    // keeps the old name for every caller (agents, scripts, the app menu).
    showLeftPanel: (tab) => {
      if (revealHandler) {
        revealHandler(tab);
        return;
      }
      useSession.getState().setLeftTab(tab);
      get().setVisible("left", true);
    },
    toggleFocusMode: () => set((s) => ({ focusMode: !s.focusMode })),
    // Leaving compact drops the overlay rather than carrying it: the panel it
    // named is docked again the moment the columns come back, so keeping the
    // flag would leave a stale sheet armed the next time the window narrows.
    setDensity: (density) =>
      set((s) => (s.density === density ? {} : { density, overlay: null })),
    setOverlayRegion: (regionId) =>
      set((s) => (s.density !== "compact" ? {} : { overlay: regionId })),
    setWorkspace: (w) => set((s) => (s.workspace === w ? {} : { workspace: w })),
    isShown: (panel) => resolvePanel(get(), panel),
  };
});
