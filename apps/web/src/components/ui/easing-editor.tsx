"use client";

import * as React from "react";
import {
  easingPoints,
  evaluateEasing,
  EASING_PRESET_LABELS,
  EASING_PRESET_POINTS,
  type Easing,
  type EasingPresetName,
} from "@solomotion/core";
import { Check, ChevronRight, Plus, RotateCcw, Waves } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverBody, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * The one easing control for the whole app.
 *
 * `EasingPanel` is the instrument: a draggable bezier graph with a PLAYHEAD —
 * a bead running the curve while two projections trace the axes, so you read
 * the timing (fast here, slow there) and not just the shape. A static curve is
 * a picture of a function; a motion tool has to show the motion.
 *
 * Three surfaces embed it, and no other easing UI exists:
 *   • `EasingBlock` — inline, always visible under whatever it eases.
 *   • `EasingPicker` — a `--control-h` field that opens the panel, for rows.
 *   • the E-shortcut overlay over selected keyframes.
 */

// ── Custom preset store (localStorage) ───────────────────────────────────────

interface CustomEasingPreset {
  name: string;
  values: [number, number, number, number];
}

const CUSTOM_KEY = "tm-custom-easings";
let customCache: CustomEasingPreset[] | null = null;
const customListeners = new Set<() => void>();

function loadCustom(): CustomEasingPreset[] {
  if (customCache) return customCache;
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    const arr = raw ? (JSON.parse(raw) as CustomEasingPreset[]) : [];
    customCache = Array.isArray(arr) ? arr.slice(0, 24) : [];
  } catch {
    customCache = [];
  }
  return customCache;
}

function saveCustom(list: CustomEasingPreset[]) {
  customCache = list;
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
  } catch {
    // Persistence is best-effort.
  }
  for (const l of customListeners) l();
}

function useCustomPresets(): [CustomEasingPreset[], (p: CustomEasingPreset) => void, (name: string) => void] {
  const subscribe = React.useCallback((cb: () => void) => {
    customListeners.add(cb);
    return () => void customListeners.delete(cb);
  }, []);
  const presets = React.useSyncExternalStore(subscribe, loadCustom, () => []);
  const add = React.useCallback((p: CustomEasingPreset) => {
    saveCustom([p, ...loadCustom().filter((x) => x.name !== p.name)]);
  }, []);
  const remove = React.useCallback((name: string) => {
    saveCustom(loadCustom().filter((x) => x.name !== name));
  }, []);
  return [presets, add, remove];
}

// ── Curve drawing ────────────────────────────────────────────────────────────

/** Curve path in an SVG viewBox with vertical padding for overshoot curves. A hold is a step. */
function curvePath(easing: Easing, w: number, h: number, pad: number): string {
  const X = (x: number) => x * w;
  const Y = (y: number) => pad + (1 - y) * (h - pad * 2);
  if (easing.kind === "hold") return `M ${X(0)} ${Y(0)} H ${X(1)} V ${Y(1)}`;
  const [x1, y1, x2, y2] = easingPoints(easing);
  return `M ${X(0)} ${Y(0)} C ${X(x1)} ${Y(y1)}, ${X(x2)} ${Y(y2)}, ${X(1)} ${Y(1)}`;
}

export function EasingCurve({ easing, className }: { easing: Easing; className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-7", className)} aria-hidden>
      <path
        d={curvePath(easing, 32, 32, 7)}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ── Interactive editor ───────────────────────────────────────────────────────

const W = 240;
const H = 158;
/** Vertical room for the overshoot of back/elastic curves. */
const PAD = 34;
/** One loop of the playhead: travel, then a beat at rest so the eye resets. */
const CYCLE_MS = 1150;
const REST_MS = 420;

/**
 * The graph. Drag either handle; a playhead runs the curve continuously with a
 * tick on each axis — the bottom tick moves at constant speed (that is time),
 * the left tick moves at the curve's speed (that is the value). The gap between
 * them IS the easing, which is the one thing a still picture cannot say.
 *
 * The playhead is written straight to the DOM from one rAF. It never re-renders
 * React, so an open easing panel costs nothing during playback.
 */
function CurveEditor({ value, onChange }: { value: Easing; onChange: (e: Easing) => void }) {
  const ref = React.useRef<SVGSVGElement>(null);
  const bead = React.useRef<SVGCircleElement>(null);
  const tTick = React.useRef<SVGLineElement>(null);
  const vTick = React.useRef<SVGLineElement>(null);
  const [x1, y1, x2, y2] = easingPoints(value);
  // A hold has no handles to pull: it is a step until you pick a curve.
  const held = value.kind === "hold";

  const X = (x: number) => x * W;
  const Y = (y: number) => PAD + (1 - y) * (H - PAD * 2);
  const fromScreen = (sx: number, sy: number) => ({
    x: Math.max(0, Math.min(1, sx / W)),
    y: 1 - (sy - PAD) / (H - PAD * 2), // y may overshoot [0,1] — that's allowed
  });

  // The loop reads the LIVE easing through a ref, so dragging a handle changes
  // the motion under the playhead in the same frame.
  const live = React.useRef(value);
  live.current = value;
  React.useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const phase = (now - start) % (CYCLE_MS + REST_MS);
      const t = Math.min(1, phase / CYCLE_MS);
      const v = evaluateEasing(live.current, t);
      const cx = t * W;
      const cy = PAD + (1 - v) * (H - PAD * 2);
      bead.current?.setAttribute("cx", String(cx));
      bead.current?.setAttribute("cy", String(cy));
      tTick.current?.setAttribute("x1", String(cx));
      tTick.current?.setAttribute("x2", String(cx));
      vTick.current?.setAttribute("y1", String(cy));
      vTick.current?.setAttribute("y2", String(cy));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const dragHandle = (which: 1 | 2) => (e: React.PointerEvent) => {
    e.preventDefault();
    const svg = ref.current!;
    const toLocal = (ev: PointerEvent | React.PointerEvent) => {
      const rect = svg.getBoundingClientRect();
      return fromScreen(
        ((ev.clientX - rect.left) / rect.width) * W,
        ((ev.clientY - rect.top) / rect.height) * H,
      );
    };
    const move = (ev: PointerEvent) => {
      const p = toLocal(ev);
      // Shift pins the handle inside the unit box — the way you get a curve
      // that is guaranteed not to overshoot.
      const clampedY = ev.shiftKey
        ? Math.max(0, Math.min(1, p.y))
        : Math.max(-1.5, Math.min(2.5, p.y));
      const next: [number, number, number, number] =
        which === 1 ? [p.x, clampedY, x2, y2] : [x1, y1, p.x, clampedY];
      onChange({ kind: "bezier", values: next.map((v) => Math.round(v * 100) / 100) as typeof next });
    };
    // `pointercancel` too — touch fires it instead of `pointerup` the moment
    // the browser claims the gesture, and a handle that only listened for the
    // release leaked its move listener for the rest of the session.
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${W} ${H}`}
      className="w-full touch-none select-none rounded-md bg-stage shadow-[inset_0_0_0_1px_var(--border)]"
    >
      {/* Quarter grid inside the unit box — enough to read a rate, not a graph
          paper background that competes with the curve. */}
      {[0.25, 0.5, 0.75].map((q) => (
        <React.Fragment key={q}>
          <line x1={X(q)} y1={Y(0)} x2={X(q)} y2={Y(1)} stroke="var(--border)" strokeOpacity={0.5} />
          <line x1={0} y1={Y(q)} x2={W} y2={Y(q)} stroke="var(--border)" strokeOpacity={0.5} />
        </React.Fragment>
      ))}
      {/* Start / end levels. Everything above or below these lines is overshoot. */}
      <line x1={0} y1={Y(0)} x2={W} y2={Y(0)} stroke="var(--border)" strokeDasharray="2 3" />
      <line x1={0} y1={Y(1)} x2={W} y2={Y(1)} stroke="var(--border)" strokeDasharray="2 3" />

      {/* Playhead projections: time along the bottom, value up the left. */}
      <line ref={tTick} x1={0} y1={H - 5} x2={0} y2={H} stroke="var(--muted-foreground)" strokeWidth={2} />
      <line ref={vTick} x1={0} y1={0} x2={5} y2={0} stroke="var(--primary)" strokeWidth={2} />

      {/* Handle arms */}
      {!held && (
        <>
          <line x1={X(0)} y1={Y(0)} x2={X(x1)} y2={Y(y1)} stroke="var(--muted-foreground)" strokeWidth={1} strokeOpacity={0.7} />
          <line x1={X(1)} y1={Y(1)} x2={X(x2)} y2={Y(y2)} stroke="var(--muted-foreground)" strokeWidth={1} strokeOpacity={0.7} />
        </>
      )}

      {/* The curve */}
      <path
        d={curvePath(value, W, H, PAD)}
        fill="none"
        stroke="var(--primary)"
        strokeWidth={2.5}
        strokeLinecap="round"
      />

      {/* Anchors */}
      <circle cx={X(0)} cy={Y(0)} r={3} fill="var(--foreground)" fillOpacity={0.75} />
      <circle cx={X(1)} cy={Y(1)} r={3} fill="var(--foreground)" fillOpacity={0.75} />

      {/* Playhead bead — the thing that is actually moving. */}
      <circle ref={bead} r={3.5} fill="var(--primary)" stroke="var(--stage)" strokeWidth={1.5} />

      {/* Draggable handles */}
      {!held && (
        <>
      <g className="cursor-grab active:cursor-grabbing" onPointerDown={dragHandle(1)}>
        <circle cx={X(x1)} cy={Y(y1)} r={13} fill="transparent" />
        <circle cx={X(x1)} cy={Y(y1)} r={5} fill="var(--primary)" stroke="var(--stage)" strokeWidth={2} />
      </g>
      <g className="cursor-grab active:cursor-grabbing" onPointerDown={dragHandle(2)}>
        <circle cx={X(x2)} cy={Y(y2)} r={13} fill="transparent" />
        <circle cx={X(x2)} cy={Y(y2)} r={5} fill="var(--primary)" stroke="var(--stage)" strokeWidth={2} />
      </g>
        </>
      )}
    </svg>
  );
}

// ── Public picker ────────────────────────────────────────────────────────────

export function easingLabel(value: Easing, custom: CustomEasingPreset[] = []): string {
  if (value.kind === "linear") return "Linear";
  if (value.kind === "hold") return "Hold";
  if (value.kind === "preset") return EASING_PRESET_LABELS[value.name];
  const match = custom.find(
    (c) => JSON.stringify(c.values) === JSON.stringify(value.values),
  );
  return match ? match.name : "Custom";
}

function sameEasing(a: Easing, b: Easing): boolean {
  // A hold and linear share the diagonal as points; only the kind tells them apart.
  if (a.kind === "hold" || b.kind === "hold") return a.kind === b.kind;
  return JSON.stringify(easingPoints(a)) === JSON.stringify(easingPoints(b));
}

/**
 * The easing editor BODY (graph + preset tiles + custom presets) with no chrome
 * of its own — the one panel every easing surface embeds.
 */
export function EasingPanel({
  value,
  onChange,
  onSmooth,
  className,
}: {
  value: Easing;
  onChange: (e: Easing) => void;
  /** When set, shows the "Smooth" action — one continuous, pause-free motion
   *  across the whole selection (values untouched). Wired by the E popover. */
  onSmooth?: () => void;
  className?: string;
}) {
  const [custom, addCustom, removeCustom] = useCustomPresets();
  const [naming, setNaming] = React.useState(false);
  const [name, setName] = React.useState("");
  const pts = easingPoints(value);

  const saveCurrent = () => {
    const trimmed = name.trim();
    if (!trimmed || value.kind === "hold") return;
    addCustom({ name: trimmed, values: pts });
    setNaming(false);
    setName("");
  };

  return (
    <div className={cn("grid gap-1.5", className)}>
      <CurveEditor value={value} onChange={onChange} />

      {/* What the curve IS, in the notation every other tool speaks. Sits under
          the graph rather than in a row of its own so the two read as one
          object — the picture and its number. */}
      <div className="flex items-center gap-1">
        <span className="truncate text-[11px] font-medium">{easingLabel(value, custom)}</span>
        <span className="ml-auto shrink-0 font-mono text-[9px] tabular-nums text-muted-foreground/70">
          {value.kind === "hold" ? "step" : pts.map((n) => n.toFixed(2).replace(/^0\./, ".")).join(" ")}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Reset to Ease Out"
              onClick={() => onChange({ kind: "preset", name: "ease-out" })}
              className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
            >
              <RotateCcw className="size-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Reset</TooltipContent>
        </Tooltip>
      </div>

      {onSmooth && (
        <button
          type="button"
          onClick={onSmooth}
          title="Continuous motion across the selection — removes the pause at every keyframe"
          className="flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-left transition-colors material-chip hover:bg-accent"
        >
          <Waves className="size-3.5 shrink-0 text-primary" />
          <span className="text-[11px] font-medium">Smooth</span>
        </button>
      )}

      {/* Flows, deliberately. This panel is always inside a scroller already —
          the inspector's, or the popover's — and a second scroller nested in
          the first steals the wheel the moment the pointer crosses it. */}
      {/* A wrapped STRIP, not a labelled grid. Twelve tiles each captioned
          with its own name was most of this panel's height, and the caption is
          the one part of an easing you can already see in the curve. */}
      <div className="flex flex-wrap gap-1">
        <PresetTile
          label="Linear"
          easing={{ kind: "linear" }}
          selected={value.kind === "linear"}
          onSelect={onChange}
        />
        <PresetTile label="Hold" easing={{ kind: "hold" }} selected={value.kind === "hold"} onSelect={onChange} />
        {(Object.keys(EASING_PRESET_POINTS) as EasingPresetName[]).map((presetName) => (
          <PresetTile
            key={presetName}
            label={EASING_PRESET_LABELS[presetName]}
            easing={{ kind: "preset", name: presetName }}
            selected={value.kind === "preset" && value.name === presetName}
            onSelect={onChange}
          />
        ))}
        {custom.map((c) => (
          <PresetTile
            key={c.name}
            label={c.name}
            easing={{ kind: "bezier", values: c.values }}
            selected={value.kind === "bezier" && sameEasing(value, { kind: "bezier", values: c.values })}
            onSelect={onChange}
            onRemove={() => removeCustom(c.name)}
          />
        ))}
        {/* The save action is the last CHIP, not a row of its own — it adds to
            exactly this set, and sitting in the strip is what says so. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Save this curve as a preset"
              aria-pressed={naming}
              onClick={() => setNaming((v) => !v)}
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-md border border-dashed transition-colors",
                naming
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground/60 hover:border-foreground/25 hover:text-foreground",
              )}
            >
              <Plus className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Save this curve</TooltipContent>
        </Tooltip>
      </div>

      {naming && (
        <div className="flex items-center gap-1">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveCurrent();
              if (e.key === "Escape") setNaming(false);
            }}
            placeholder="Preset name…"
            className="h-7 w-full rounded-md border bg-input/45 px-2 text-xs outline-none focus:border-primary/60"
          />
          <Button size="icon-sm" variant="secondary" aria-label="Save preset" onClick={saveCurrent}>
            <Check />
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The easing panel INLINE — a hairline-headed block that lives under whatever
 * it eases, open by default.
 *
 * An easing hidden behind a popover is the second most important decision in an
 * animation sitting behind a click, with no way to see the shape you chose
 * while you tune the duration next to it. Collapsible only because a panel can
 * hold three animations at once, and three graphs is a scroll; the state is
 * per-block and starts open, so the curve is what you see.
 */
export function EasingBlock({
  value,
  onChange,
  defaultOpen = true,
  label = "Easing",
}: {
  value: Easing;
  onChange: (e: Easing) => void;
  defaultOpen?: boolean;
  label?: string;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div className="mt-0.5 border-t border-border/60 pt-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="group/eas flex h-6 w-full items-center gap-1 text-left outline-none"
      >
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground/50 transition-transform duration-150",
            open && "rotate-90",
          )}
        />
        <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
          {label}
        </span>
        <EasingCurve easing={value} className="ml-auto size-4 shrink-0 text-primary" />
        <span className="shrink-0 text-[10px] text-muted-foreground">{easingLabel(value)}</span>
      </button>
      {open && <EasingPanel value={value} onChange={onChange} className="pt-1" />}
    </div>
  );
}

export function EasingPicker({
  value,
  onChange,
  className,
}: {
  value: Easing;
  onChange: (e: Easing) => void;
  className?: string;
}) {
  const [custom] = useCustomPresets();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md border border-transparent bg-input/45 px-1.5 text-xs transition-colors hover:border-border",
            className,
          )}
        >
          <EasingCurve easing={value} className="size-4.5 shrink-0 text-primary" />
          <span className="truncate">{easingLabel(value, custom)}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="end" sideOffset={8}>
        <PopoverBody viewportClassName="p-2.5">
          <EasingPanel value={value} onChange={onChange} />
        </PopoverBody>
      </PopoverContent>
    </Popover>
  );
}

function PresetTile({
  label,
  easing,
  selected,
  onSelect,
  onRemove,
}: {
  label: string;
  easing: Easing;
  selected: boolean;
  onSelect: (e: Easing) => void;
  onRemove?: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={selected}
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md border border-transparent transition-colors",
            selected
              ? "border-primary/50 bg-primary/10 text-primary"
              : "text-foreground/55 hover:bg-accent hover:text-foreground",
          )}
          onClick={() => onSelect(easing)}
          onContextMenu={(e) => {
            if (!onRemove) return;
            e.preventDefault();
            onRemove();
          }}
        >
          <EasingCurve easing={easing} className="size-5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {label}
        {onRemove && " · right-click to delete"}
      </TooltipContent>
    </Tooltip>
  );
}
