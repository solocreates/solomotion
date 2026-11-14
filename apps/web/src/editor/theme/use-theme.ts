"use client";

import { create } from "zustand";
import {
  compile,
  presetById,
  readThemeFile,
  writeThemeFile,
  type Dialect,
  type LabelStyle,
  type Mode,
  type Neutral,
  type PartName,
  type Theme,
} from "@solomotion/theme";
import {
  applyThemeToDom,
  defaultTheme,
  defaultStored,
  migrateStored,
  RADIUS_MAX,
  RADIUS_MIN,
  resolveMode,
  SCALE_MAX,
  SCALE_MIN,
  type ModePref,
  type StoredTheme,
} from "./theme-tokens";
import { resolveCssColor } from "./resolve-color";
import { NAMES } from "@/editor/names";

/**
 * The app-theme store: the active theme FILE plus a person's own choices
 * (mode, UI scale, glass). Every mutation re-projects onto the DOM through
 * `applyThemeToDom`, so the UI restyles live with no React re-render dance.
 *
 * `colors` is derived, never stored: the theme's tones resolved to hex by the
 * browser, for the few painters that need a real colour (canvas rulers, the
 * 3D world, brush thumbnails). Subscribing to it is how a canvas repaints on
 * a theme change.
 */

// v4: the theme became a file (@solomotion/theme). Older keys are migrated.
const STORAGE_KEY = NAMES.storage.theme;
const LEGACY_KEYS = [NAMES.storage.legacyTheme];

export interface ResolvedColors {
  background: string;
  foreground: string;
  panel: string;
  card: string;
  popover: string;
  stage: string;
  lane: string;
  primary: string;
  primaryForeground: string;
  mutedForeground: string;
  border: string;
  destructive: string;
}

const RESOLVE: Record<keyof ResolvedColors, string> = {
  background: "--background",
  foreground: "--foreground",
  panel: "--panel",
  card: "--card",
  popover: "--popover",
  stage: "--stage",
  lane: "--track-lane",
  primary: "--primary",
  primaryForeground: "--primary-foreground",
  mutedForeground: "--muted-foreground",
  border: "--border",
  destructive: "--destructive",
};

function resolveColors(theme: Theme, mode: Mode): ResolvedColors {
  const vars = compile(theme, mode).vars;
  const out = {} as ResolvedColors;
  for (const [k, v] of Object.entries(RESOLVE) as Array<[keyof ResolvedColors, string]>) out[k] = resolveCssColor(vars[v] ?? "#000000");
  return out;
}

function load(): StoredTheme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return migrateStored(JSON.parse(raw));
    for (const key of LEGACY_KEYS) {
      const old = localStorage.getItem(key);
      if (old) return migrateStored(JSON.parse(old));
    }
  } catch {
    // storage/parse unavailable — fall back to the shipped default
  }
  return defaultStored();
}

function persist(s: StoredTheme): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // storage unavailable — the session theme still applies
  }
}

/** The theme a stored record stands for. */
function themeOf(s: StoredTheme): Theme {
  if (s.presetId === "custom" && s.custom) return s.custom;
  return presetById(s.presetId)?.theme ?? defaultTheme();
}

export interface ThemeStore extends StoredTheme {
  /** The active theme file. */
  theme: Theme;
  /** The mode actually showing (a `system` preference resolved). */
  activeMode: Mode;
  colors: ResolvedColors;
  /** (Re)apply the stored theme to the document — call once on mount. */
  apply: () => void;
  applyPreset: (id: string) => void;
  setMode: (mode: ModePref) => void;
  setScale: (scale: number) => void;
  setGlass: (glass: boolean) => void;
  setAccent: (color: string) => void;
  setNeutral: (key: keyof Neutral, value: string) => void;
  setFont: (slot: keyof Theme["font"], id: string) => void;
  setLabels: (labels: LabelStyle) => void;
  setRadius: (radius: number) => void;
  setDensity: (density: number) => void;
  setPart: <P extends PartName>(part: P, dialect: Dialect<P>) => void;
  reset: () => void;
  exportTheme: () => string;
  /** Applies a theme file, or returns why it does not read. */
  importTheme: (json: string) => { ok: true } | { ok: false; error: string };
}

const SSR_STORED = defaultStored();

export const useTheme = create<ThemeStore>((set, get) => {
  const stored = (): StoredTheme => {
    const s = get();
    return { v: 4, presetId: s.presetId, custom: s.custom, mode: s.mode, scale: s.scale, glass: s.glass };
  };
  /** Apply → persist → set, in that order, so the DOM is already correct by
   *  the time subscribers re-render. Every mutation funnels through here. */
  const commit = (next: StoredTheme) => {
    const theme = themeOf(next);
    const activeMode = resolveMode(next.mode);
    applyThemeToDom(theme, next);
    persist(next);
    set({ ...next, theme, activeMode, colors: resolveColors(theme, activeMode) });
  };
  /** Edit the active theme: it becomes "Custom (from …)" from here on. */
  const edit = (fn: (t: Theme) => Theme) => {
    const s = stored();
    const base = themeOf(s);
    const from = base.id === "custom" ? base.name : `Custom (from ${base.name})`;
    commit({ ...s, presetId: "custom", custom: { ...fn(base), id: "custom", name: from } });
  };
  const mode = (): Mode => get().activeMode;

  return {
    ...SSR_STORED,
    theme: themeOf(SSR_STORED),
    activeMode: "dark",
    colors: {
      background: "#0c0c0e",
      foreground: "#ededf0",
      panel: "#141416",
      card: "#1b1b1e",
      popover: "#212125",
      stage: "#09090b",
      lane: "#161618",
      primary: "#ff4e6a",
      primaryForeground: "#ffffff",
      mutedForeground: "#8e8e96",
      border: "#ffffff12",
      destructive: "#f2555a",
    },

    apply: () => {
      if (typeof window === "undefined") return;
      commit(load());
    },

    applyPreset: (id) => {
      const p = presetById(id);
      if (!p) return;
      const s = stored();
      // A preset opens in its own mode (Paper and Hardware are light-first),
      // unless the person asked to follow the OS.
      commit({ ...s, presetId: id, custom: undefined, mode: s.mode === "system" ? "system" : p.theme.mode });
    },
    setMode: (m) => commit({ ...stored(), mode: m }),
    setScale: (scale) => commit({ ...stored(), scale: Math.min(SCALE_MAX, Math.max(SCALE_MIN, scale)) }),
    setGlass: (glass) => commit({ ...stored(), glass }),

    setAccent: (color) => edit((t) => ({ ...t, accent: { ...t.accent, [mode()]: color } })),
    setNeutral: (key, value) =>
      edit((t) => ({ ...t, neutral: { ...t.neutral, [mode()]: { ...t.neutral[mode()], [key]: value } } })),
    setFont: (slot, id) => edit((t) => ({ ...t, font: { ...t.font, [slot]: id } })),
    setLabels: (labels) => edit((t) => ({ ...t, labels })),
    setRadius: (radius) => edit((t) => ({ ...t, radius: Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, Math.round(radius))) })),
    setDensity: (density) => edit((t) => ({ ...t, density })),
    setPart: (part, dialect) => edit((t) => ({ ...t, parts: { ...t.parts, [part]: dialect } })),

    reset: () => commit(defaultStored()),

    exportTheme: () => writeThemeFile(get().theme),

    importTheme: (json) => {
      const r = readThemeFile(json);
      if (!r.ok) return r;
      // An imported file keeps its own name, and opens in its own mode.
      commit({ ...stored(), presetId: "custom", custom: { ...r.theme, id: "custom" }, mode: r.theme.mode });
      return { ok: true };
    },
  };
});

/** Follow the OS while the mode preference is `system`. Mount once. */
export function watchSystemMode(): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  const on = () => {
    const s = useTheme.getState();
    if (s.mode === "system") s.setMode("system");
  };
  mq.addEventListener("change", on);
  return () => mq.removeEventListener("change", on);
}
