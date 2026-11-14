"use client";

import { create } from "zustand";
import { DEFAULT_EFFECT_PREVIEW, type EffectEditorHint, type EffectPreviewSettings } from "@solomotion/core";
import {
  createWindowSizes,
  type WindowBounds,
  type WindowSize,
} from "@/components/ui/floating-window";
import { NAMES } from "@/editor/names";

/**
 * Which effect card has its editor open — where that window sits, and how big
 * each KIND of effect likes to be.
 *
 * Only the effect ID lives here. The window itself is rendered BY the stack
 * that owns the card, so it reads live values through that stack's own state
 * and writes through that stack's own semantics (the layer stack fans an edit
 * across a multi-selection; the text stack writes a range style). Storing a
 * copy of the effect here instead would be a second source of truth for the
 * values on screen — the exact bug this codebase keeps paying for.
 *
 * ── Size ────────────────────────────────────────────────────────────────────
 * There are three answers to "how big is this window", in priority order:
 *
 *   1. what the USER dragged it to, for this KIND of effect — remembered;
 *   2. what the effect's registry entry asks for (`def.editor`);
 *   3. the default below.
 *
 * Keyed by TYPE, not by instance. Two reverbs on one clip are the same tool
 * opened twice; sizing them independently would mean the window you just
 * tuned re-opens wrong on the next card, and would grow an unbounded map keyed
 * by ids that die with the clip.
 *
 * POSITION is deliberately NOT per type — there is one window at a time and it
 * lives where you last parked it, which is how every floating tool palette
 * behaves. Remembering a position per effect would make the window jump around
 * the screen as you walk down a stack.
 */

const MIN_W = 320;
const DEFAULT_WIDTH = 380;

/**
 * Sizes are remembered by the SHARED window-size store, filed under the effect
 * TYPE. Nothing about that mechanism is effect-specific — a plugin window will
 * file under a plugin id against the same store — which is why it lives in
 * `components/ui/window-sizes` and this file only decides what the key is.
 */
const sizes = createWindowSizes("effect-editor");

interface EffectEditorStore {
  openId: string | null;
  /** The open effect's KIND — the key its remembered size is filed under. */
  openType: string | null;
  /** The registry's size for the open kind, so "reset" has something to reset TO. */
  openHint: EffectEditorHint | null;
  bounds: WindowBounds;
  previewOpen: boolean;
  /** How the preview runs — one set for every card, remembered per viewer. */
  previewSettings: EffectPreviewSettings;
  open: (id: string, type?: string, hint?: EffectEditorHint) => void;
  close: () => void;
  toggle: (id: string, type?: string, hint?: EffectEditorHint) => void;
  setBounds: (patch: Partial<WindowBounds>) => void;
  /** Forget this kind's remembered size and snap back to the registry's. */
  resetSize: () => void;
  setPreviewOpen: (v: boolean) => void;
  setPreviewSettings: (patch: Partial<EffectPreviewSettings>) => void;
}

const SETTINGS_KEY = NAMES.storage.effectPreview;

/** A per-viewer convenience, so storage may be absent or hold anything. */
function loadPreviewSettings(): EffectPreviewSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as Partial<EffectPreviewSettings> | null;
    if (!raw || typeof raw !== "object") return DEFAULT_EFFECT_PREVIEW;
    const pick = <K extends keyof EffectPreviewSettings>(k: K, allowed: readonly EffectPreviewSettings[K][]) =>
      allowed.includes(raw[k] as EffectPreviewSettings[K]) ? (raw[k] as EffectPreviewSettings[K]) : DEFAULT_EFFECT_PREVIEW[k];
    return {
      stack: pick("stack", ["solo", "through", "all"]),
      scene: pick("scene", ["scene", "beneath", "alone"]),
      resolution: pick("resolution", ["auto", "full", "half", "quarter", "eighth"]),
      pauseWhenHeavy: pick("pauseWhenHeavy", [true, false]),
    };
  } catch {
    return DEFAULT_EFFECT_PREVIEW;
  }
}

/** Parked clear of the inspector, so you tune while watching the stage. */
function place(size: WindowSize, prev?: WindowBounds): WindowBounds {
  const vw = typeof window === "undefined" ? 1440 : window.innerWidth;
  const width = Math.max(MIN_W, Math.min(size.width, vw - 48));
  // Reuse the last position — but the NEW window is a different width, so the
  // old x has to be re-checked against it. Keeping the x from a 660px card and
  // opening a 780px one there is how the equaliser ended up hanging off the
  // right edge of the screen.
  const maxX = Math.max(16, vw - width - 16);
  const usable = prev && prev.x > -width + 80 && prev.x < vw - 80;
  return {
    x: usable ? Math.min(prev.x, maxX) : Math.max(16, Math.min(vw - 320 - width - 24, maxX)),
    y: usable ? prev.y : 104,
    width,
    height: size.height,
    minimized: false,
  };
}

export const useEffectEditor = create<EffectEditorStore>((set, get) => ({
  openId: null,
  openType: null,
  openHint: null,
  bounds: place({ width: DEFAULT_WIDTH, height: "auto" }),
  previewOpen: true,
  previewSettings: typeof window === "undefined" ? DEFAULT_EFFECT_PREVIEW : loadPreviewSettings(),
  open: (id, type, hint) =>
    set((s) => {
      const size = sizes.resolve(type ?? null, hint, DEFAULT_WIDTH);
      return {
        openId: id,
        openType: type ?? null,
        openHint: hint ?? null,
        bounds: place(size, s.bounds),
      };
    }),

  close: () => set({ openId: null, openType: null, openHint: null }),

  toggle: (id, type, hint) => (get().openId === id ? get().close() : get().open(id, type, hint)),

  setBounds: (patch) =>
    set((s) => {
      const bounds = { ...s.bounds, ...patch };
      // A resize is a PREFERENCE for this kind of effect; a move is not.
      if (patch.width !== undefined || patch.height !== undefined) {
        sizes.remember(s.openType, { width: bounds.width, height: bounds.height });
      }
      return { bounds };
    }),

  resetSize: () =>
    set((s) => {
      if (!s.openType) return {};
      sizes.forget(s.openType);
      return {
        bounds: {
          ...s.bounds,
          width: Math.max(MIN_W, s.openHint?.width ?? DEFAULT_WIDTH),
          height: s.openHint?.height ?? "auto",
        },
      };
    }),

  setPreviewOpen: (previewOpen) => set({ previewOpen }),
  setPreviewSettings: (patch) =>
    set((s) => {
      const previewSettings = { ...s.previewSettings, ...patch };
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(previewSettings));
      } catch {
        // Private window or blocked storage: the choice lasts the session.
      }
      return { previewSettings };
    }),
}));
