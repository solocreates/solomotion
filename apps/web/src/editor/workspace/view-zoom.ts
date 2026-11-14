/**
 * ONE ZOOM, SPECIFIED BY KIND (README D5).
 *
 * The kit existed (`ZoomControl`, `useZoomGesture`, `usePanelZoom`, the stage
 * camera, the timeline's pxPerSec) and every surface wired it differently:
 * different presets, different bounds, different keys, some with Fit, some
 * without. The missing piece was a SPEC per kind of view, so a surface says
 * "I am a camera" and inherits the whole contract:
 *
 *   camera — stage, node board, curves, flipbook sheet, 3D: zoom about the
 *            cursor; Fit; 100%; presets Fit · 25 · 50 · 100 · 200 · 400.
 *   time   — timeline / keyframes X: presets are DURATIONS of visible time;
 *            Fit = the work area. (Lane height Y is the `lanes` reflow axis.)
 *   reflow — Library, Media, Plugins grids: tile size 0.6 – 1.4.
 *
 * Bounds are CLAMPED ON READ. Levels are persisted; a store holds a number,
 * not a promise about it, so lowering a ceiling must never strand someone
 * above it with the dial pinned (`docs/responsive-and-gestures.md`).
 *
 * Shortcuts route to the FOCUSED region (`session.focusedPanel`), never to
 * every listener at once: ⌘= / ⌘− step, ⌘0 fit, ⇧0 100%.
 */

import type { ZoomKind } from "./editor-registry";

export interface ZoomPreset {
  label: string;
  /** Level, or `"fit"`. For `time`, the level is visible SECONDS. */
  value: number | "fit";
}

export interface ViewZoomSpec {
  kind: Exclude<ZoomKind, "none">;
  min: number;
  max: number;
  default: number;
  /** Multiplicative step for ⌘± and one wheel notch. */
  step: number;
  presets: readonly ZoomPreset[];
  /** Wheel: ⌘-wheel / pinch zooms; plain wheel scrolls (camera: pans). */
  wheel: "modifier";
  /** Fit + 100% apply to this kind. */
  fit: boolean;
  actual: boolean;
  /** How the level reads in a control. */
  format: (level: number) => string;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export const CAMERA_ZOOM: ViewZoomSpec = {
  kind: "camera",
  min: 0.02,
  max: 64,
  default: 1,
  step: 1.25,
  presets: [
    { label: "Fit", value: "fit" },
    { label: "25%", value: 0.25 },
    { label: "50%", value: 0.5 },
    { label: "100%", value: 1 },
    { label: "200%", value: 2 },
    { label: "400%", value: 4 },
  ],
  wheel: "modifier",
  fit: true,
  actual: true,
  format: pct,
};

/**
 * `time` levels are pixels-per-second; presets are visible durations. The
 * floor is the absolute one — a long edit may zoom out far enough to fit
 * hours; the timeline narrows it per span on read (`dynamicMinPxPerSec`).
 */
export const TIME_ZOOM: ViewZoomSpec = {
  kind: "time",
  min: 0.05,
  max: 600,
  default: 90,
  step: 1.25,
  presets: [
    { label: "Fit", value: "fit" },
    { label: "1 s", value: 1 },
    { label: "5 s", value: 5 },
    { label: "10 s", value: 10 },
    { label: "30 s", value: 30 },
    { label: "1 min", value: 60 },
  ],
  wheel: "modifier",
  fit: true,
  actual: false,
  format: (pxPerSec) => `${Math.round(pxPerSec)} px/s`,
};

export const REFLOW_ZOOM: ViewZoomSpec = {
  kind: "reflow",
  min: 0.6,
  max: 1.4,
  default: 1,
  step: 1.1,
  presets: [
    { label: "Small", value: 0.75 },
    { label: "Medium", value: 1 },
    { label: "Large", value: 1.25 },
  ],
  wheel: "modifier",
  fit: false,
  actual: true,
  format: pct,
};

export const ZOOM_SPECS: Record<ViewZoomSpec["kind"], ViewZoomSpec> = {
  camera: CAMERA_ZOOM,
  time: TIME_ZOOM,
  reflow: REFLOW_ZOOM,
};

export function zoomSpec(kind: ZoomKind): ViewZoomSpec | null {
  return kind === "none" ? null : ZOOM_SPECS[kind];
}

/** Clamp on read. NaN / missing → the spec default. */
export function readLevel(spec: Pick<ViewZoomSpec, "min" | "max" | "default">, stored: number | null | undefined): number {
  if (stored === null || stored === undefined || !Number.isFinite(stored)) return spec.default;
  return Math.min(spec.max, Math.max(spec.min, stored));
}

export function stepLevel(spec: ViewZoomSpec, level: number, dir: 1 | -1): number {
  return readLevel(spec, level * (dir > 0 ? spec.step : 1 / spec.step));
}

/**
 * Resolve a preset to a level. `fit` needs the caller's fit level; a `time`
 * preset is a visible duration, so it needs the visible width in px.
 */
export function presetLevel(
  spec: ViewZoomSpec,
  preset: ZoomPreset,
  ctx: { fitLevel?: number; viewportPx?: number } = {},
): number {
  if (preset.value === "fit") return readLevel(spec, ctx.fitLevel ?? spec.default);
  if (spec.kind === "time") return readLevel(spec, (ctx.viewportPx ?? 1000) / preset.value);
  return readLevel(spec, preset.value);
}

/**
 * Zoom about a point: the new pan so the content point under `anchor` stays
 * under it. Pan is "content offset in screen px" (screen = content*level + pan).
 */
export function zoomAbout(
  pan: { x: number; y: number },
  level: number,
  next: number,
  anchor: { x: number; y: number },
): { x: number; y: number } {
  const r = next / level;
  return { x: anchor.x - (anchor.x - pan.x) * r, y: anchor.y - (anchor.y - pan.y) * r };
}

export type ZoomCommand = "in" | "out" | "fit" | "actual";

/**
 * Map a key event to a zoom command (D5's one shortcut set). Returns null for
 * keys that are not zoom keys, so the caller can let them through.
 */
export function zoomCommandFor(e: { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): ZoomCommand | null {
  const mod = e.metaKey || e.ctrlKey;
  if (e.altKey) return null;
  if (mod && (e.key === "=" || e.key === "+")) return "in";
  if (mod && (e.key === "-" || e.key === "_")) return "out";
  if (mod && !e.shiftKey && e.key === "0") return "fit";
  // ⇧0 → 100%. On most layouts ⇧0 types ")" — match the physical key too.
  if (!mod && e.shiftKey && (e.key === ")" || e.code === "Digit0" || e.key === "0")) return "actual";
  return null;
}

/**
 * Which zoom handler gets a command: the FOCUSED region's, and only if the
 * view there declared one. Handlers register by focus key.
 */
export interface ZoomRouter {
  register: (focusKey: string, handler: (cmd: ZoomCommand) => boolean | void) => () => void;
  dispatch: (focusKey: string | null, cmd: ZoomCommand) => boolean;
}

export function createZoomRouter(): ZoomRouter {
  const handlers = new Map<string, Array<(cmd: ZoomCommand) => boolean | void>>();
  return {
    register(key, handler) {
      const list = handlers.get(key) ?? [];
      list.push(handler);
      handlers.set(key, list);
      return () => {
        const l = handlers.get(key);
        if (!l) return;
        const i = l.indexOf(handler);
        if (i >= 0) l.splice(i, 1);
        if (l.length === 0) handlers.delete(key);
      };
    },
    dispatch(key, cmd) {
      if (!key) return false;
      const list = handlers.get(key);
      if (!list?.length) return false;
      // The newest mount wins (a view inside a view registered last).
      return list[list.length - 1]!(cmd) !== false;
    },
  };
}
