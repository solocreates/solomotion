"use client";

import * as React from "react";
import {
  COLOR_GRADE_PRESETS,
  createLayerEffect,
  layerEffectPath,
  layerEffectTypeDef,
  type ColorGradeEffect,
  type ColorGradePreset,
  type VisualClip,
} from "@solomotion/core";
import { ChevronDown, RotateCcw } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useSession } from "../state/session";
import { commitProperty, useEffectiveValue } from "./animatable";
import { ValueField } from "./value-field";
import { useClipUpdater } from "./use-clip-updater";
import { capturePointer } from "../input/capture-pointer";

/**
 * The Color grade card body — a DaVinci-style grading node in the effect
 * stack. Lift/Gamma/Gain trackball wheels (relative drag, ⌥ for fine, double-
 * click resets), master trims, white balance / tonal / color sliders, and a
 * preset menu of looks from the core registry. Every value keyframes through
 * the standard `lfx.<id>.<field>` paths, so wheels animate like any field.
 */

// Wheel-rim trim — full deflection stays cinematic; type into the master
// fields (or the timeline) for values beyond it.
const RIM = 0.35;

/** Trims (r,g,b) → wheel-plane coords; r = R·cos(hue CW from red-at-top). */
function trimsToPlane(r: number, g: number, b: number): [number, number] {
  return [(2 * r - g - b) / 3, (g - b) / Math.sqrt(3)];
}

function planeToTrims(u: number, v: number): [number, number, number] {
  return [u, -u / 2 + (Math.sqrt(3) / 2) * v, -u / 2 - (Math.sqrt(3) / 2) * v];
}

export function ColorWheel({
  label,
  r,
  g,
  b,
  onDrag,
  onReset,
}: {
  label: string;
  r: number;
  g: number;
  b: number;
  onDrag: (r: number, g: number, b: number) => void;
  onReset: () => void;
}) {
  const [u, v] = trimsToPlane(r, g, b);
  const mag = Math.hypot(u, v);
  const shown = mag > RIM ? [u * (RIM / mag), v * (RIM / mag)] : [u, v];
  const neutral = mag < 0.0005;

  const dragState = React.useRef({ u: 0, v: 0 });
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragState.current = { u, v };
    const el = e.currentTarget as HTMLElement;
    capturePointer(el, e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const move = (ev: PointerEvent) => {
      const sens = (RIM / 140) * (ev.altKey ? 0.2 : 1);
      let nu = dragState.current.u - (ev.clientY - startY) * sens;
      let nv = dragState.current.v + (ev.clientX - startX) * sens;
      const m = Math.hypot(nu, nv);
      if (m > RIM) {
        nu *= RIM / m;
        nv *= RIM / m;
      }
      onDrag(...planeToTrims(nu, nv));
    };
    // `pointercancel` as well as `pointerup`: touch fires the former whenever
    // the browser decides the gesture is its own, and a wheel that tore down
    // only on release kept a live move listener for the rest of the session.
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  return (
    <div className="flex flex-col items-center gap-1">
      <div
        className="relative size-14 cursor-crosshair touch-none select-none rounded-full"
        style={{
          background:
            "conic-gradient(#f55 0deg, #ff5 60deg, #5f5 120deg, #5ff 180deg, #55f 240deg, #f5f 300deg, #f55 360deg)",
        }}
        onPointerDown={onPointerDown}
        onDoubleClick={onReset}
        title={`${label} — drag to trim, ⌥ fine, double-click resets`}
      >
        {/* Inner disc turns the hue circle into a ring. */}
        <div className="absolute inset-1.25 rounded-full bg-secondary/90 shadow-inner" />
        <div className="absolute inset-x-1/2 inset-y-1.75 w-px -translate-x-1/2 bg-border/50" />
        <div className="absolute inset-x-1.75 inset-y-1/2 h-px -translate-y-1/2 bg-border/50" />
        <div
          className={cn(
            "absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border shadow",
            neutral ? "border-muted-foreground/60 bg-background" : "border-white bg-primary",
          )}
          style={{
            left: `calc(50% + ${(shown[1]! / RIM) * 21}px)`,
            top: `calc(50% - ${(shown[0]! / RIM) * 21}px)`,
          }}
        />
      </div>
      <span className="text-[10px] font-medium text-muted-foreground">{label}</span>
    </div>
  );
}

const WHEELS = [
  { key: "lift", label: "Lift" },
  { key: "gamma", label: "Gamma" },
  { key: "gain", label: "Gain" },
] as const;

const SLIDERS = [
  "temperature",
  "tint",
  "exposure",
  "contrast",
  "saturation",
  "vibrance",
  "hueDeg",
  "intensity",
] as const;

/**
 * The grading body, used in TWO places: as an effect card in the inspector, and
 * as the payload of a corrector node on the Color page.
 *
 * `pathFor` is the entire difference. A card in the stack addresses its fields
 * at `lfx.<id>.<field>`; the same card inside a node addresses them at
 * `lfx.<card>.n.<node>.fx.<id>.<field>`. Taking the path as a parameter is what
 * let the colour page reuse the wheels rather than grow a second set — which
 * would then have had its own drag feel, its own keyframe wiring and its own
 * bugs.
 */
export function ColorGradeBody({
  clip,
  effect,
  pathFor,
}: {
  clip: VisualClip;
  effect: ColorGradeEffect;
  pathFor?: (field: string) => string;
}) {
  const update = useClipUpdater(clip.id);
  const path = pathFor ?? ((field: string) => layerEffectPath(effect.id, field));
  const def = layerEffectTypeDef("colorGrade")!;
  const fieldDef = (key: string) => def.fields.find((f) => f.key === key)!;

  // Effective (keyframe-sampled) trims so the wheels animate with playback —
  // a custom hook called in fixed order over the static wheel-field list.
  const useEff = (key: keyof ColorGradeEffect & string) =>
    Number(useEffectiveValue(clip, path(key), effect[key] as number));
  const trims = {
    lift: [useEff("liftR"), useEff("liftG"), useEff("liftB")] as const,
    gamma: [useEff("gammaR"), useEff("gammaG"), useEff("gammaB")] as const,
    gain: [useEff("gainR"), useEff("gainG"), useEff("gainB")] as const,
  };

  const commitWheel = (wheel: (typeof WHEELS)[number]["key"], r: number, g: number, b: number) => {
    update(
      `Grade ${wheel}`,
      (c) => {
        if (c.kind === "audio") return;
        const ms = useSession.getState().playheadMs;
        commitProperty(c, path(`${wheel}R`), r, ms);
        commitProperty(c, path(`${wheel}G`), g, ms);
        commitProperty(c, path(`${wheel}B`), b, ms);
      },
      `lfx-${effect.id}-${wheel}`,
    );
  };

  const commitField = (key: string, v: number | string) => {
    update(
      `Grade ${fieldDef(key).label}`,
      (c) => {
        if (c.kind !== "audio") {
          commitProperty(c, path(key), v, useSession.getState().playheadMs);
        }
      },
      `lfx-${effect.id}-${key}`,
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between px-1">
        {WHEELS.map((w) => (
          <ColorWheel
            key={w.key}
            label={w.label}
            r={trims[w.key][0]}
            g={trims[w.key][1]}
            b={trims[w.key][2]}
            onDrag={(r, g, b) => commitWheel(w.key, r, g, b)}
            onReset={() => commitWheel(w.key, 0, 0, 0)}
          />
        ))}
      </div>
      <div className="space-y-1">
        {WHEELS.map((w) => {
          const f = fieldDef(`${w.key}M`);
          return (
            <ValueField
              key={f.key}
              clip={clip}
              canKey
              path={path(f.key)}
              kind="number"
              label={f.label}
              base={effect[`${w.key}M`]}
              min={f.min}
              max={f.max}
              step={f.step}
              onChange={(v) => commitField(f.key, v as number)}
            />
          );
        })}
      </div>

      <div className="space-y-1 border-t border-border/50 pt-1.5">
        {SLIDERS.map((key) => {
          const f = fieldDef(key);
          return (
            <ValueField
              key={key}
              clip={clip}
              canKey
              path={path(key)}
              kind="number"
              label={f.label}
              base={effect[key]}
              min={f.min}
              max={f.max}
              step={f.step}
              onChange={(v) => commitField(key, v as number)}
            />
          );
        })}
      </div>
    </div>
  );
}
