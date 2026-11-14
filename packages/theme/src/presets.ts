import { THEME_SCHEMA_VERSION } from "./parts-list";
import type { Theme } from "./schema";

/**
 * The four looks the open studio ships. Every value here is a decision from
 * the brand rounds (notes/solomotion/brand/round-4.html and the brief), not a
 * placeholder: green with no glow, ink neutrals, Geist for the interface,
 * Space Grotesk for display, Doto for the numbers in value fields.
 *
 * A host app adds its own looks through `registerPreset`; this package never
 * names another product.
 */

const INK = {
  dark: { bg: "#0a0b0a", panel: "#101210", raised: "#191c19", line: "rgba(220,255,235,0.08)", fg: "#e9eee9", muted: "#8f978f", faint: "#5a615a" },
  light: { bg: "#f6f7f5", panel: "#ffffff", raised: "#eef0ec", line: "rgba(10,20,12,0.09)", fg: "#0b0d0b", muted: "#5b635c", faint: "#9ba39c" },
};
const TERM = {
  dark: { bg: "#050605", panel: "#080908", raised: "#101210", line: "rgba(160,255,210,0.10)", fg: "#dfe6e1", muted: "#83908a", faint: "#4f5a54" },
  light: { bg: "#f3f5f4", panel: "#fbfcfb", raised: "#e8ece9", line: "rgba(5,6,5,0.12)", fg: "#070807", muted: "#56605a", faint: "#9aa39e" },
};
const METAL = {
  dark: { bg: "#0f0f0e", panel: "#1a1a18", raised: "#272724", line: "rgba(255,255,255,0.07)", fg: "#ecebe6", muted: "#9b9a94", faint: "#5f5e59" },
  light: { bg: "#d8d7d2", panel: "#e6e5e0", raised: "#f3f2ee", line: "rgba(0,0,0,0.10)", fg: "#1b1b19", muted: "#66655f", faint: "#9b9993" },
};
const PAPER = {
  dark: { bg: "#11120f", panel: "#171814", raised: "#22231e", line: "rgba(240,244,232,0.11)", fg: "#eef0e6", muted: "#a2a596", faint: "#666958" },
  light: { bg: "#f1f0e8", panel: "#f8f7f1", raised: "#e6e5db", line: "rgba(20,22,14,0.13)", fg: "#14160e", muted: "#5f6252", faint: "#9fa190" },
};

/** Presets are plain data (no validator at load, so a page that only compiles
 *  a theme never ships zod); a test proves each one reads as a theme file. */
const define = (t: Omit<Theme, "schema">): Theme => ({ schema: THEME_SCHEMA_VERSION, ...t });

export const SOLOMOTION: Theme = define({
  id: "solomotion",
  name: "SoloMotion",
  mode: "dark",
  neutral: INK,
  accent: { dark: "#3df2a8", light: "#0b8a57" },
  accentFg: { dark: "#03140c", light: "#ffffff" },
  // A linked variable reads in the brand green, like the token in the brief.
  tones: { variable: { dark: "#3df2a8", light: "#0b8a57" } },
  font: { ui: "geist", display: "space-grotesk", mono: "geist-mono", num: "doto" },
  size: 12,
  weight: 550,
  labels: "upper",
  radius: 12,
  density: 28,
  glass: true,
  parts: { range: "trail", measure: "ruler", switch: "notch", tabs: "playhead", button: "solid", field: "well", menu: "solid" },
});

export const TERMINAL: Theme = define({
  id: "solo/motion",
  name: "solo/motion",
  mode: "dark",
  neutral: TERM,
  accent: { dark: "#36f1a8", light: "#00875a" },
  accentFg: { dark: "#03140c", light: "#ffffff" },
  tones: { variable: { dark: "#36f1a8", light: "#00875a" } },
  font: { ui: "martian-mono", display: "martian-mono", mono: "martian-mono", num: "martian-mono" },
  size: 11,
  weight: 500,
  labels: "var",
  radius: 0,
  density: 28,
  glass: false,
  parts: { range: "blocks", measure: "ruler", switch: "led", tabs: "tmux", button: "outline", field: "box", menu: "terminal" },
});

export const PAPER_THEME: Theme = define({
  id: "paper",
  name: "Paper",
  mode: "light",
  neutral: PAPER,
  accent: { dark: "#57d68d", light: "#1d7a4f" },
  accentFg: { dark: "#06140c", light: "#ffffff" },
  font: { ui: "space-grotesk", display: "space-grotesk", mono: "ibm-plex-mono", num: "ibm-plex-mono" },
  size: 12.5,
  weight: 550,
  labels: "title",
  radius: 0,
  density: 30,
  glass: false,
  parts: { range: "line", measure: "ruler", switch: "notch", tabs: "boxed", button: "offset", field: "line", menu: "inverted" },
});

export const HARDWARE: Theme = define({
  id: "hardware",
  name: "Hardware",
  mode: "light",
  neutral: METAL,
  accent: { dark: "#2ee59d", light: "#0f9f66" },
  accentFg: { dark: "#03140c", light: "#ffffff" },
  font: { ui: "geist", display: "space-grotesk", mono: "geist-mono", num: "doto" },
  size: 12,
  weight: 600,
  labels: "upper",
  radius: 12,
  density: 30,
  glass: true,
  parts: { range: "steps", measure: "ruler", switch: "rocker", tabs: "chip", button: "keycap", field: "well", menu: "solid" },
});

/** The open studio's looks, in the order a gallery shows them. */
export const BUILT_IN_PRESETS: readonly Theme[] = [SOLOMOTION, TERMINAL, PAPER_THEME, HARDWARE];
