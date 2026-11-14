"use client";

import * as React from "react";
import { FIDELITY_RANGE, SHIFT_SMOOTHING, effectiveSmoothing, type BrushEngine, type BrushPreset } from "@solomotion/core";
import { Gauge, Waves } from "lucide-react";
import type { SliderScaleKind } from "@/components/ui/slider-base";
import { useSession, type Tool } from "../state/session";
import { useBrushLibrary, useDrawing, type BrushSlot } from "./drawing-store";
import { SMOOTHING_ON } from "./FidelityFields";

/**
 * THE PAINT DIALS — the one answer to "what is the armed paint tool set to,
 * and how do I change it".
 *
 * Size, opacity and smoothing are asked for in three places now (the tool
 * options bar, the stage's Procreate handle, and the tooltip that reports the
 * leash) and they are stored in two: a brush's size lives as a per-brush TWEAK
 * in the library, the eraser's lives on the tool, and smoothing lives on the
 * tool's `PathFidelity` for both. Every surface that wanted a size had to know
 * that split, and the second one to learn it would have learned it wrong —
 * which is exactly how the options bar and the drawing overlay ended up with
 * two copies of the same conditional.
 *
 * So the split is answered ONCE, here, and everything above reads a dial: a
 * value, its range, its scale, and the one function that writes it. Adding a
 * fourth surface costs nothing; adding a paint tool costs one arm of `dialsFor`
 * and every surface gains it.
 *
 * It deliberately does NOT own history or commit pacing — `Range` already
 * streams and commits through `useLiveValue`, and a second commit model here
 * would be a second answer to that question too.
 */

/** The tools that paint a sized, stabilised stroke. */
export const PAINT_TOOLS = ["brush", "eraser"] as const;
export type PaintTool = (typeof PAINT_TOOLS)[number];

export function isPaintTool(tool: Tool): tool is PaintTool {
  return (PAINT_TOOLS as readonly string[]).includes(tool);
}

export type PaintDialId = "size" | "opacity" | "smoothing";

/**
 * THE DIALS IN THE ORDER THEY MATTER, which is also the order they survive a
 * short stage in. Size is the last one standing: it is the number you change
 * most, and the only one with no other one-gesture route to it.
 *
 * Ordered data, not a layout constant — the handle slices this rather than
 * carrying its own copy of "which three, and which one goes first".
 */
export const PAINT_DIAL_ORDER: readonly PaintDialId[] = ["size", "opacity", "smoothing"];

/**
 * The tabs of the paint settings sheet.
 *
 * Declared HERE rather than in `PaintSettings`, because a MODE names the tab
 * that explains it and the sheet already reads this module — the other
 * direction would be a cycle, and a duplicated union is how a hold gesture ends
 * up opening a tab that no longer exists.
 */
export type PaintTab = "brush" | "smoothing" | "pressure";

/**
 * AN EVERYDAY SWITCH of the armed paint tool — a thing you arm once and then
 * forget, as opposed to a dial you keep moving.
 *
 * There are two, and before this they lived in different places in different
 * shapes: smoothing was a cap button welded into the brush handle behind its
 * own `smoothing &&` branch, and pen pressure was a pod in the tool options
 * bar. The same kind of object, two implementations, two surfaces, and neither
 * surface could show the other's switch — which is why the handle had a ragged
 * column (one dial with a cap, two without) while the bar carried an icon for a
 * setting the handle beside it already owned.
 *
 * One list, read by both. A third switch is an entry here.
 */
export interface PaintMode {
  id: "smoothing" | "pressure";
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** The tab a HOLD opens — the room where this switch is explained in full. */
  tab: PaintTab;
  on: boolean;
  /** What it reads as right now; the second half of the tooltip. */
  detail: string;
  set: (on: boolean) => void;
  /**
   * What a held ⇧ momentarily makes of this switch, where a modifier owns it.
   * Present only on switches a key can reverse, and answered by the same core
   * function the STROKE asks — a surface that works it out for itself is how a
   * cap ends up reporting the opposite of what the canvas is about to draw.
   */
  shifted?: (on: boolean) => boolean;
}

/** One dialable quantity — everything a control needs, and nothing about how
 *  it is drawn. The same object drives a horizontal Range in the options bar
 *  and a vertical fader on the stage. */
export interface PaintDial {
  id: PaintDialId;
  label: string;
  value: number;
  min: number;
  max: number;
  /** Linear step, where the domain has one. Log dials stay continuous. */
  step?: number;
  scale: SliderScaleKind;
  /**
   * The unit the dial is EDITED in. `"%"` means the stored value is 0..1 and a
   * number field shows 0..100 — stated, not inferred from the range, because
   * "max is 1 so it must be a percentage" is true of smoothing too and would
   * have made a leash read as an opacity the first time anyone typed into it.
   */
  unit: "px" | "%";
  /** Values worth catching — the detents, drawn on the track. */
  ticks?: number[];
  /** Double-click restores this. */
  defaultValue?: number;
  /** How the number reads to a person, unit included. */
  format: (v: number) => string;
  set: (v: number) => void;
  /**
   * What a held ⇧ momentarily makes of this value. Present only on dials a
   * modifier can reverse; from core, for the reason `PaintMode.shifted` gives.
   */
  shifted?: (v: number) => number;
}

export interface PaintDials {
  tool: PaintTool;
  /** The switches this tool offers, in the order they are shown. */
  modes: PaintMode[];
  /** Which library slot is armed — the brush tool's engine, or the eraser's
   *  own. The eraser carries a brush like Procreate's does. */
  slot: BrushSlot;
  /** The preset actually painting. A preview that draws anything else is
   *  drawing a different brush than the one about to hit the canvas. */
  brush: BrushPreset | null;
  dials: Record<PaintDialId, PaintDial>;
}

/**
 * Brush size is LOG, and that is not a detail. On a linear 1–600 track the
 * whole usable range of an inking brush (2–20px) is the bottom three percent,
 * so the control that exists to pick a size cannot pick one. Procreate,
 * Photoshop and Krita all curve it for the same reason.
 */
const SIZE_MIN = 1;
const SIZE_MAX = 600;
/** Sizes worth landing on exactly — the ones people say out loud. */
const SIZE_TICKS = [1, 2, 4, 8, 16, 32, 64, 128, 256];

const pct = (v: number) => `${Math.round(v * 100)}%`;
const px = (v: number) => `${Math.round(v)} px`;

/**
 * IS THE STAGE HANDLE CARRYING THIS TOOL'S DIALS AND SWITCHES RIGHT NOW?
 *
 * One fact, read by both surfaces that care. The handle renders itself on it,
 * and the tool options bar renders its smoothing and pressure pods only when
 * the answer is no — because while the handle is up those two icons are a
 * second copy of switches sitting under the hand already, and a bar that
 * repeats the control beside it is how a person learns to trust neither.
 *
 * The handle can be hidden (its context menu), and then the bar is the only
 * way to them again. That is why this is a question rather than a deletion.
 */
/**
 * WHICH PAINT TOOL THIS SURFACE HOLDS. The flat stage holds the session's
 * tool; a 3D world holds its own (its Draw is the vector brush) and provides
 * it here. A context rather than a global read, so the brush handle and its
 * dials ask the surface they are mounted on — the same component on both, with
 * no branch on where it is.
 */
const PaintToolContext = React.createContext<Tool | null | undefined>(undefined);
export const PaintToolProvider = PaintToolContext.Provider;
export function usePaintTool(): Tool | null {
  const own = React.useContext(PaintToolContext);
  const session = useSession((s) => s.tool);
  return own === undefined ? session : own;
}

/**
 * WHICH BRUSH ENGINE THIS SURFACE PAINTS WITH, when it is not the flat
 * brush's own choice: a world's Draw lays vector strokes and its Paint lays
 * pixels, whatever the flat brush is set to — so the handle's size dial reads
 * the brush that will actually paint.
 */
const PaintEngineContext = React.createContext<BrushEngine | undefined>(undefined);
export const PaintEngineProvider = PaintEngineContext.Provider;

export function useHandleCarriesDials(): boolean {
  const tool = usePaintTool();
  const shown = useSession((s) => s.brushHandle);
  return shown && tool !== null && isPaintTool(tool);
}

export function usePaintDials(): PaintDials | null {
  const tool = usePaintTool();
  const engine = React.useContext(PaintEngineContext);
  const brushOpts = useDrawing((s) => s.brush);
  const eraser = useDrawing((s) => s.eraser);
  const pressure = useDrawing((s) => s.pressure);
  // The whole library: size and opacity are a tweak keyed by the armed brush
  // id, so the slice this needs is "the tweaks, the active ids, and whatever
  // the preset underneath them says" — which is most of it.
  const lib = useBrushLibrary();

  return React.useMemo<PaintDials | null>(() => {
    if (tool === null || !isPaintTool(tool)) return null;

    const smoothing = (
      value: number,
      write: (v: number) => void,
    ): PaintDial => ({
      id: "smoothing",
      label: "Smoothing",
      unit: "%",
      value,
      min: FIDELITY_RANGE.smoothing.min,
      max: FIDELITY_RANGE.smoothing.max,
      step: FIDELITY_RANGE.smoothing.step,
      scale: "linear",
      // Off, and the floor ⇧ forces mid-stroke — the two settings that mean
      // something. An even lattice here would be `step`, not a detent.
      ticks: [0, SHIFT_SMOOTHING],
      defaultValue: 0,
      format: (v) => (v <= 0 ? "Off" : pct(v)),
      set: write,
      shifted: (v) => effectiveSmoothing(v, true),
    });

    /**
     * The switches, built from the same dial the fader shows — so a cap can
     * never disagree with the fader beside it about whether smoothing is on.
     * Pressure is app-level and reads straight from the store.
     */
    const modesFor = (leash: PaintDial): PaintMode[] => [
      {
        id: "smoothing",
        label: "Smoothing",
        icon: Waves,
        tab: "smoothing",
        on: leash.value > 0,
        detail: leash.format(leash.value),
        // Off stores nothing, because 0 IS off on this dial — switching back on
        // lands on the shared "enough leash to see" value.
        set: (on) => leash.set(on ? SMOOTHING_ON : 0),
        shifted: (on) => effectiveSmoothing(on ? 1 : 0, true) > 0,
      },
      {
        id: "pressure",
        label: "Pen pressure",
        icon: Gauge,
        tab: "pressure",
        on: pressure.enabled,
        detail: pressure.enabled ? "on" : "off",
        // The master switch, non-destructive by design: every tuned curve stays
        // saved for the next click back on.
        set: (enabled) => useDrawing.getState().setPressure({ enabled }),
      },
    ];

    if (tool === "eraser") {
      const set = useDrawing.getState().setEraserOptions;
      const dials: Record<PaintDialId, PaintDial> = {
        size: {
          id: "size",
          label: "Size",
          unit: "px",
          value: eraser.size,
          min: SIZE_MIN,
          max: SIZE_MAX,
          scale: "log",
          ticks: SIZE_TICKS,
          defaultValue: 24,
          format: px,
          set: (size) => set({ size: Math.round(size) }),
        },
        opacity: {
          id: "opacity",
          label: "Opacity",
          unit: "%",
          value: eraser.opacity,
          min: 0.01,
          max: 1,
          step: 0.01,
          scale: "linear",
          ticks: [1],
          defaultValue: 1,
          format: pct,
          set: (opacity) => set({ opacity }),
        },
        smoothing: smoothing(eraser.fidelity.smoothing, (v) =>
          set({ fidelity: { ...useDrawing.getState().eraser.fidelity, smoothing: v } }),
        ),
      };
      return {
        tool,
        slot: "eraser",
        brush: lib.brushById(lib.activeEraserBrushId),
        modes: modesFor(dials.smoothing),
        dials,
      };
    }

    const slot: BrushSlot = engine ?? brushOpts.engine;
    const activeId = lib.activeBrushId(slot);
    const eff = lib.effective(activeId);
    const preset = lib.brushById(activeId);
    const dials: Record<PaintDialId, PaintDial> = {
      size: {
        id: "size",
        label: "Size",
        unit: "px",
        value: eff.size,
        min: SIZE_MIN,
        max: SIZE_MAX,
        scale: "log",
        ticks: SIZE_TICKS,
        // The BRUSH's own shipped size, not a constant: reset means "back to
        // how this brush comes", which is a different number per brush.
        defaultValue: preset?.size,
        format: px,
        set: (size) => lib.setTweak(activeId, { size: Math.round(size) }),
      },
      opacity: {
        id: "opacity",
        label: "Opacity",
        unit: "%",
        value: eff.opacity,
        min: 0.01,
        max: 1,
        step: 0.01,
        scale: "linear",
        ticks: [1],
        defaultValue: preset?.opacity,
        format: pct,
        set: (opacity) => lib.setTweak(activeId, { opacity }),
      },
      smoothing: smoothing(brushOpts.fidelity.smoothing, (v) =>
        useDrawing.getState().setBrushOptions({
          fidelity: { ...useDrawing.getState().brush.fidelity, smoothing: v },
        }),
      ),
    };
    return { tool, slot, brush: preset, modes: modesFor(dials.smoothing), dials };
  }, [tool, engine, brushOpts, eraser, pressure, lib]);
}

/**
 * A dial in the units a NUMBER FIELD edits it in.
 *
 * A percentage dial stores 0..1 and is typed as 0..100, and every field that
 * edits one has to undo that — three call sites already did it by hand, each
 * with its own `Math.round(v * 100)` and its own `v / 100` going back. One of
 * them was going to lose the rounding.
 */
export function dialFieldProps(
  dial: PaintDial,
  /** Show this instead of the stored value — what a held modifier makes of it. */
  override?: number,
): {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
} {
  const pct = dial.unit === "%";
  const value = override ?? dial.value;
  return {
    value: pct ? Math.round(value * 100) : Math.round(value),
    min: pct ? Math.max(1, Math.round(dial.min * 100)) : dial.min,
    max: pct ? 100 : dial.max,
    onChange: (v) => dial.set(pct ? v / 100 : v),
  };
}
