"use client";

import { create } from "zustand";
import { NAMES } from "@/editor/names";

/**
 * App-shell routing — which top-level screen is showing, and which projects the
 * user has open as TABS.
 *
 * The memory model is the whole design, and it is enforced by structure rather
 * than by discipline: there is exactly ONE document store in the app (mounted
 * above both screens in layout.tsx), so exactly one project can be resident at
 * a time. A tab is therefore not a loaded project — it is an ID, and switching
 * to it is the same operation as deep-linking to it. Forty tabs cost what one tab costs, and no amount of tab-opening can leak
 * a document, an undo stack or a decoded media buffer, because there is nowhere
 * for a second one to live.
 *
 * That also means tabs add no new loading path. `openProject` sets
 * `currentProjectId`; `use-url-sync` already owns "id changed → load it", and
 * `Editor.tsx` already owns "document changed → autosave it". This store only
 * decides WHICH id, never how it is fetched.
 */

export type AppView = "home" | "editor";

/** What Home is showing: your projects, or the community's. */
export type HomeSection = "projects" | "community";

/**
 * A tab is a project ID — nothing else. Its label is DERIVED (`useProjectName`
 * in `project-index`): v1 stored `{ id, name }`, and that copy of the name is
 * what said "Untitled" until you opened the project it belonged to.
 */
const TABS_KEY = NAMES.storage.openTabs;
const LEGACY_TABS_KEY = NAMES.storage.legacyOpenTabs;

function loadTabs(): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const legacy = localStorage.getItem(TABS_KEY) === null ? localStorage.getItem(LEGACY_TABS_KEY) : null;
    const raw: unknown = JSON.parse(legacy ?? localStorage.getItem(TABS_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    // v1 rows were `{ id, name }`; only the id survives.
    const ids = raw
      .map((t: unknown) => (typeof t === "string" ? t : t && typeof (t as { id?: unknown }).id === "string" ? (t as { id: string }).id : null))
      .filter((id): id is string => !!id);
    const tabs = [...new Set(ids)].slice(0, 40);
    if (legacy !== null) {
      saveTabs(tabs);
      localStorage.removeItem(LEGACY_TABS_KEY);
    }
    return tabs;
  } catch {
    return [];
  }
}

function saveTabs(tabs: string[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify(tabs));
  } catch {
    /* a full quota must never break navigation */
  }
}

interface AppShellState {
  view: AppView;
  /** Id of the LOADED project — the one the document store actually holds. */
  currentProjectId: string | null;
  /**
   * The project the user has asked for but which is not loaded yet. Kept
   * separate from `currentProjectId` on purpose: a switch that optimistically
   * moved `currentProjectId` made the loader's "is this already open?" guard
   * true before the fetch, so it returned early, never loaded, and never
   * cleared `switching` — the tab span forever.
   */
  pendingProjectId: string | null;
  /** The open tab strip — project ids, in user order. */
  tabs: string[];
  /** True while a tab switch is fetching its document (drives the tab spinner). */
  switching: boolean;
  /** The reusable New Project dialog (openable from the menubar and home). */
  newProjectOpen: boolean;
  /** Why Home is showing instead of a project that was asked for (a link to one this browser lacks). Home shows it; any open clears it. */
  homeNotice: string | null;
  setHomeNotice: (notice: string | null) => void;
  homeSection: HomeSection;
  setHomeSection: (section: HomeSection) => void;

  goHome: () => void;
  /** The loader's promotion: the document for `projectId` is in the store. Call `makeResident`, not this. */
  enterEditor: (projectId: string) => void;
  /** Open (or focus) a project as a tab and switch to it. */
  openProject: (projectId: string) => void;
  closeTab: (projectId: string) => void;
  closeOthers: (keepId: string) => void;
  closeToRight: (fromId: string) => void;
  closeAll: () => void;
  /** Move a tab to a new index (drag reorder). */
  reorderTabs: (from: number, to: number) => void;
  setSwitching: (v: boolean) => void;
  openNewProject: () => void;
  setNewProjectOpen: (open: boolean) => void;
}

/** Append a tab unless it is already open; an open tab keeps its place. */
function withTab(tabs: string[], id: string): string[] {
  return tabs.includes(id) ? tabs : [...tabs, id];
}

/**
 * After a bulk close: if the project on screen lost its tab, go to the tab
 * that is left (or Home). Without this, "Close others" from a background tab
 * left the editor showing a project with no tab at all.
 */
function keepTabbed(s: AppShellState, tabs: string[]): Partial<AppShellState> {
  if (!s.currentProjectId || tabs.includes(s.currentProjectId)) return { tabs };
  if (s.view === "home" || !tabs.length) return { tabs, currentProjectId: null, pendingProjectId: null, view: "home", switching: false };
  return { tabs, pendingProjectId: tabs[tabs.length - 1]!, view: "editor", switching: true };
}

export const useAppShell = create<AppShellState>((set, get) => ({
  view: "home",
  currentProjectId: null,
  pendingProjectId: null,
  tabs: loadTabs(),
  switching: false,
  newProjectOpen: false,
  homeNotice: null,
  setHomeNotice: (homeNotice) => set({ homeNotice }),
  homeSection: "projects",
  setHomeSection: (homeSection) => set({ homeSection }),

  // Going Home keeps the strip AND the loaded project: Home is a screen, not
  // a session reset, and losing your open tabs by glancing at the project list
  // is not a trade anyone would choose.
  goHome: () => set({ view: "home", pendingProjectId: null, switching: false }),

  enterEditor: (projectId) =>
    set((s) => {
      const tabs = withTab(s.tabs, projectId);
      saveTabs(tabs);
      return {
        view: "editor" as const,
        currentProjectId: projectId,
        pendingProjectId: null,
        tabs,
        switching: false,
        homeNotice: null,
      };
    }),

  openProject: (projectId) => {
    const s0 = get();
    // Already loaded and showing — only the view needs to change (Home → editor).
    if (s0.currentProjectId === projectId) {
      set({ view: "editor", pendingProjectId: null, switching: false });
      return;
    }
    set((s) => {
      const tabs = withTab(s.tabs, projectId);
      saveTabs(tabs);
      // `currentProjectId` deliberately does NOT move here — it names what is
      // loaded. The loader watches `pendingProjectId` and promotes it via
      // `enterEditor` once the document is actually in the store.
      return { view: "editor" as const, pendingProjectId: projectId, tabs, switching: true };
    });
  },

  closeTab: (projectId) =>
    set((s) => {
      const at = s.tabs.indexOf(projectId);
      if (at < 0) return s;
      const tabs = s.tabs.filter((t) => t !== projectId);
      saveTabs(tabs);
      // Closing a tab ends its session: its suspended undo and view go too.
      void import("./suspended-sessions").then((m) => m.forgetSession(projectId));
      if (s.currentProjectId !== projectId) return { ...s, tabs };
      // Closing the ACTIVE tab lands on its right-hand neighbour, then its
      // left — the browser convention, and the one that keeps a rapid
      // close-close-close from bouncing you to Home mid-way.
      const next = tabs[at] ?? tabs[at - 1] ?? null;
      // Closing it from Home does not throw you into another project.
      if (s.view === "home") return { ...s, tabs, currentProjectId: null, pendingProjectId: null };
      return next
        ? { ...s, tabs, pendingProjectId: next, view: "editor" as const, switching: true }
        : { ...s, tabs, currentProjectId: null, pendingProjectId: null, view: "home" as const, switching: false };
    }),

  closeOthers: (keepId) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t === keepId);
      saveTabs(tabs);
      return keepTabbed(s, tabs);
    }),

  closeToRight: (fromId) =>
    set((s) => {
      const at = s.tabs.indexOf(fromId);
      if (at < 0 || at === s.tabs.length - 1) return s;
      const tabs = s.tabs.slice(0, at + 1);
      saveTabs(tabs);
      return keepTabbed(s, tabs);
    }),

  closeAll: () =>
    set(() => {
      saveTabs([]);
      return {
        tabs: [],
        currentProjectId: null,
        pendingProjectId: null,
        view: "home" as const,
        switching: false,
      };
    }),

  reorderTabs: (from, to) =>
    set((s) => {
      if (from === to || from < 0 || to < 0 || from >= s.tabs.length || to >= s.tabs.length) return s;
      const tabs = s.tabs.slice();
      const [moved] = tabs.splice(from, 1);
      tabs.splice(to, 0, moved!);
      saveTabs(tabs);
      return { ...s, tabs };
    }),

  setSwitching: (v) => set({ switching: v }),
  openNewProject: () => set({ newProjectOpen: true }),
  setNewProjectOpen: (open) => set({ newProjectOpen: open }),
}));
