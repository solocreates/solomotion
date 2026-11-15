/**
 * The editor's side of the theme engine.
 *
 * The engine itself (`@solomotion/theme`) owns the theme FILE: its schema, the
 * compile step that turns it into CSS variables and one `data-*` dialect per
 * part, and the four open looks. This module is the editor's half:
 *
 *  • the product registers its own looks here and names the one a fresh
 *    install opens in (`Product.registerThemes`, `defaultThemeId`);
 *  • it reads whatever an older build stored, handing a record that predates
 *    the theme file to the product that wrote it (`Product.migrateTheme`);
 *  • it is the ONE place a theme touches the document (`applyThemeToDom`).
 */

import { applyCursorPrefs } from "@solomotion/ui/cursors";
import { parseHexColor, setBrandFill } from "@solomotion/core";
import {
  applyCompiled,
  compile,
  parseTheme,
  presetById,
  type Mode,
  type Theme,
} from "@solomotion/theme";
import { identity } from "../identity";
import { NAMES } from "../names";

/** The rem basis UI scale multiplies. */
export const BASE_FONT_PX = 16;
export const SCALE_MIN = 0.8;
export const SCALE_MAX = 1.4;
export const RADIUS_MIN = 0;
export const RADIUS_MAX = 20;

/** Control heights a person picks from; any number in the file is valid. */
export const DENSITY_OPTIONS = [
  { id: 26, label: "Compact" },
  { id: 28, label: "Cozy" },
  { id: 32, label: "Roomy" },
] as const;

/**
 * What CANVAS code needs from the live theme, as values a 2D context can take
 * (it cannot read a CSS variable). Written once per theme change by
 * `applyThemeToDom`, read O(1), so it is safe inside per-frame render loops.
 * The stage's chrome derives its whole palette from this (`scene-chrome.ts`).
 */
export interface CanvasTones {
  accent: string;
  /** Ink that reads ON the accent (a readout pill's text). */
  onAccent: string;
  /** The mode's ground: a handle's fill, so it is a hole in the art in dark
   *  mode and a white chip in light mode (Figma's). */
  paper: string;
  ink: string;
  muted: string;
  light: boolean;
  /** `--r-xs` as px, for square grips. */
  corner: number;
  /** The code face as a real family stack (canvas `font` cannot take var()). */
  codeFont: string;
}

let tones: CanvasTones | null = null;

function tonesOf(theme: Theme, mode: Mode, codeFont: string): CanvasTones {
  const n = theme.neutral[mode];
  return {
    accent: theme.accent[mode],
    onAccent: theme.accentFg[mode],
    paper: n.bg,
    ink: n.fg,
    muted: n.muted,
    light: mode === "light",
    corner: Math.min(3, Math.max(2, theme.radius / 3)),
    codeFont,
  };
}

const CODE_FALLBACK = 'ui-monospace, "SF Mono", Menlo, monospace';

export function canvasTones(): CanvasTones {
  if (tones) return tones;
  const t = defaultTheme();
  return (tones = tonesOf(t, t.mode, CODE_FALLBACK));
}

/** The live accent as a real colour string (see `canvasTones`). */
export function accentColor(): string {
  return canvasTones().accent;
}

identity.registerThemes();

/** The look a fresh install opens in: the product's. */
export const DEFAULT_PRESET_ID = identity.defaultThemeId;

/** The default look's file: the fallback wherever a stored id no longer exists. */
export function defaultTheme(): Theme {
  const t = presetById(DEFAULT_PRESET_ID)?.theme;
  if (!t) throw new Error(`The product's default look "${DEFAULT_PRESET_ID}" is not registered.`);
  return t;
}

// ── Applying ─────────────────────────────────────────────────────────────────

/** Mode as a person picks it: a fixed mode, or follow the OS. */
export type ModePref = Mode | "system";

export function resolveMode(pref: ModePref): Mode {
  if (pref !== "system") return pref;
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** What `applyThemeToDom` needs besides the file: a person's own choices. */
export interface ThemePrefs {
  mode: ModePref;
  /** Blender-style UI zoom (whole app), 1 = 100%. */
  scale: number;
  /** Frosted glass on canvas chrome. A performance choice, so it is theirs. */
  glass: boolean;
}

/**
 * Project a theme onto the DOM. Variables and part dialects come from
 * `compile` (the engine); scale and glass are a person's own and are applied
 * here.
 *
 * Scale is the root FONT SIZE, never `root.style.zoom`: zoom rescales the
 * coordinate space itself, so `getBoundingClientRect()`, pointer clients and
 * every canvas's devicePixelRatio stop agreeing (soft canvases, a caret beside
 * its glyph). The chrome is rem-based, so it grows as one while the stage and
 * the timeline keep their true pixels.
 *
 * This is the ONLY place a theme touches the document.
 */
export function applyThemeToDom(theme: Theme, prefs: ThemePrefs): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const c = compile(theme, resolveMode(prefs.mode));
  applyCompiled(root, c);
  // What a new shape is painted in follows the interface's primary.
  const primary = c.vars["--primary"];
  if (typeof primary === "string") setBrandFill(primary);
  // Custom properties compute with their var()s substituted, so this is the
  // real family list the next/font classes on <html> define.
  const code = getComputedStyle(root).getPropertyValue("--font-code").trim();
  tones = tonesOf(theme, resolveMode(prefs.mode), code || CODE_FALLBACK);
  root.dataset.glass = prefs.glass ? "on" : "off";
  root.style.setProperty("--ui-scale", String(prefs.scale));
  root.style.fontSize = prefs.scale === 1 ? "" : `${BASE_FONT_PX * prefs.scale}px`;
  applyCursorPrefs({ uiScale: prefs.scale });
  // An install that ran a much older build may still have `zoom` on the root.
  root.style.zoom = "";
  // Remember the PAINT, so the next load draws this theme before any script
  // runs (layout.tsx). Written on a theme change only, never per frame.
  try {
    localStorage.setItem(NAMES.storage.themePaint, JSON.stringify({ v: c.vars, a: { ...c.attrs, glass: prefs.glass ? "on" : "off" }, s: c.scheme }));
  } catch {
    /* storage blocked: the product's default paints first, as on a first visit */
  }
}

/**
 * Is this surface colour LIGHT? Parsed by core's `parseHexColor` (an
 * unanchored regex once read `#0b090f` as bright green and gave three dark
 * presets the daylight glass).
 */
export function isLight(hex: string): boolean {
  const c = parseHexColor(hex);
  if (!c) return false;
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255 > 0.5;
}

// ── Stored themes ────────────────────────────────────────────────────────────

/** What is persisted. A preset is stored by id so retuning it reaches everyone
 *  who picked it; only an edited theme is stored whole. */
export interface StoredTheme extends ThemePrefs {
  v: 4;
  presetId: string;
  custom?: Theme;
}

export function defaultStored(): StoredTheme {
  return { v: 4, presetId: DEFAULT_PRESET_ID, mode: presetById(DEFAULT_PRESET_ID)?.theme.mode ?? "dark", scale: 1, glass: true };
}

const num = (v: unknown, lo: number, hi: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

/**
 * Anything an older build stored → today's shape. A v4 record is read here;
 * anything older predates the theme file, and only the product that wrote it
 * knows its shape, so it goes to `Product.migrateTheme`.
 */
export function migrateStored(raw: unknown): StoredTheme {
  const base = defaultStored();
  if (!raw || typeof raw !== "object") return base;
  const o = raw as Record<string, unknown>;
  const scale = num(o.scale, SCALE_MIN, SCALE_MAX, base.scale);
  const glass = typeof o.glass === "boolean" ? o.glass : base.glass;
  const mode: ModePref = o.mode === "light" || o.mode === "dark" || o.mode === "system" ? o.mode : "dark";

  if (o.v === 4) {
    const presetId = typeof o.presetId === "string" ? o.presetId : base.presetId;
    const custom = o.custom ? parseTheme(o.custom) : null;
    if (presetId === "custom" && custom?.ok) return { v: 4, presetId, custom: custom.theme, mode, scale, glass };
    return { v: 4, presetId: presetById(presetId) ? presetId : base.presetId, mode, scale, glass };
  }
  return identity.migrateTheme?.(o, { base: { ...base, scale, glass }, isLight }) ?? { ...base, scale, glass };
}
