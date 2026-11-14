"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { usePointerDrag } from "./use-pointer-drag";
import { useLiveValue } from "./use-live-value";
import { dragModifiers } from "./drag-modifiers";

/**
 * The headless slider brain — ONE gesture/value model behind every fader, zoom
 * dial and (future) adjustment slider in the app. It owns nothing visual: it
 * maps a value to a 0..1 fraction (linear OR log), and turns pointer-drag,
 * wheel, and keyboard into value changes with a smart, axis-aware body cursor.
 * Presentational components (`SliderBase`, `ZoomControl`, …) render whatever
 * chrome they like against `fraction` + `trackProps`/`keyProps`.
 *
 * Log scale is first-class because zoom ranges (12→600 px/s) spend most of a
 * linear track on speeds nobody uses — the same reason the old timeline dial
 * hand-rolled a log map. Now that map lives here, once.
 */

export type SliderOrientation = "horizontal" | "vertical";
export type SliderScaleKind = "linear" | "log";

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Default detent pull: 3% of the range. Wide enough to catch a centre or a
 * 100% without aiming, narrow enough that 97% of the track is free movement —
 * which is the whole point. Override per control with `snapRadius`.
 */
const DEFAULT_SNAP_RADIUS = "3%" as const;
const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);

/** Value → 0..1 along the track, honouring the scale. Shared with the Knob so
 *  every control in the app maps a range the same way. */
export function scaleToFraction(value: number, min: number, max: number, scale: SliderScaleKind): number {
  if (max <= min) return 0;
  if (scale === "log") {
    const lo = Math.log(min);
    const hi = Math.log(max);
    return clamp01((Math.log(clamp(value, min, max)) - lo) / (hi - lo));
  }
  return clamp01((value - min) / (max - min));
}

/** 0..1 → value, the inverse of {@link scaleToFraction}. */
export function scaleFromFraction(f: number, min: number, max: number, scale: SliderScaleKind): number {
  const c = clamp01(f);
  if (scale === "log") {
    const lo = Math.log(min);
    const hi = Math.log(max);
    return Math.exp(lo + c * (hi - lo));
  }
  return min + c * (max - min);
}

/**
 * Where a value may REST, beyond `step` and `ticks` — the detents an
 * instrument dialect carries (a ruler steps tick to tick, blocks step a whole
 * block). Asked at the moment of each move, so a theme switched mid-session
 * changes the behaviour with no re-render. `free` is ⇧: the detents let go.
 */
export interface SliderDetent {
  snap: (v: number, free: boolean) => number;
  /** One arrow press from `v`; null = no detents here, use the plain notch. */
  step: (v: number, dir: 1 | -1) => number | null;
}

export interface UseSliderControlOptions {
  value: number;
  min: number;
  max: number;
  /** Snap increment for LINEAR sliders (ignored on log, which stays continuous). */
  step?: number;
  scale?: SliderScaleKind;
  orientation?: SliderOrientation;
  /**
   * What a PRESS does. `"jump"` (the default) sets the value from where you
   * clicked, which is what a track wants — you aimed at a position. `"hold"`
   * changes nothing until you move, which is what a KNOB wants: a cap has no
   * position to aim at, so jumping on press would throw the value away every
   * time you touched it.
   */
  grab?: "jump" | "hold";
  /**
   * Pixels of drag for the control's FULL travel. Defaults to the track
   * element's own length, which is right for anything you drag ALONG. A knob
   * has no length to drag along, so it names a distance instead (180px is the
   * Ableton/Serum feel).
   */
  travelPx?: number;
  /**
   * Which pointer axis the drag reads. `"both"` sums up-and-right, so neither
   * a vertical nor a horizontal wrist movement is the "wrong" one — the
   * complaint every single-axis knob gets. Defaults from `orientation`.
   */
  axis?: "x" | "y" | "both";
  /** Mouse-wheel over the track nudges the value (default on). */
  wheel?: boolean;
  disabled?: boolean;
  /** Fraction moved per wheel notch / arrow / +- button when no linear `step`
   *  applies (log scale, or a stepless linear slider). Default 1/30. */
  notch?: number;
  /**
   * Detents the value is PULLED toward while dragging — a centre, a 100%, the
   * ends. A detent is an assist, never a rail: outside `snapRadius` the value
   * moves completely freely, and holding Shift disables the pull entirely
   * (along with switching to fine travel), which is the Blender contract.
   */
  ticks?: number[];
  /**
   * How near a detent has to be before it pulls, expressed either as a
   * PERCENTAGE of the range (`"3%"`, the default and the usual way to think
   * about it — it scales with the control) or as a plain number in the value's
   * own units (`0.05`, `10`), for ranges where a fixed tolerance is what the
   * domain actually means.
   */
  snapRadius?: number | `${number}%`;
  detent?: SliderDetent;
  onChange: (v: number) => void;
  /**
   * Fired ONCE when the value stops moving — the end of a drag, a tap, a key
   * or a wheel notch — with the value it ended on.
   *
   * `onChange` is a STREAM and cannot be an undo boundary: a drag across a
   * track fires it at pointer rate, so a caller that recorded there would write
   * a hundred history entries for one gesture. Every consumer that needed a
   * boundary was deriving one by watching `dragging` fall, which misses the
   * keyboard and the wheel entirely.
   */
  onCommit?: (v: number) => void;
  /** Double-click / double-tap the track. */
  onReset?: () => void;
}

export interface SliderControl {
  trackRef: React.RefObject<HTMLDivElement | null>;
  /**
   * What to PAINT — the optimistic value during a gesture, the prop otherwise.
   * A control must render from this, never from its own `value` prop, or it
   * goes back to moving at the speed of the document store. See `useLiveValue`.
   */
  value: number;
  /** 0..1 position of the current value, honoring the scale. */
  fraction: number;
  dragging: boolean;
  horizontal: boolean;
  disabled: boolean;
  /** Step the value one notch in a direction (+1 bigger, -1 smaller). */
  nudge: (dir: 1 | -1, fine?: boolean) => void;
  /** Shift is held — the control is in fine mode (no snapping, slow travel). */
  fine: boolean;
  /** Spread onto the interactive track element. Uses pointer capture, so the
   *  drag engages on the FIRST press (no useEffect timing gap) and keeps
   *  tracking even when the pointer leaves the small track. */
  trackProps: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerCancel: (e: React.PointerEvent) => void;
    onDoubleClick?: () => void;
    /** Straight from the gesture. It travels WITH the handlers so a track
     *  cannot be wired without it. Spread `trackProps` after any style of your
     *  own, or merge it. */
    style: React.CSSProperties;
    "data-no-longpress": string;
  };
  /** Spread onto whatever element owns focus/keyboard + ARIA. */
  keyProps: {
    role: "slider";
    tabIndex: number;
    "aria-valuenow": number;
    "aria-valuemin": number;
    "aria-valuemax": number;
    "aria-orientation": SliderOrientation;
    onKeyDown: (e: React.KeyboardEvent) => void;
  };
}

export function useSliderControl(opts: UseSliderControlOptions): SliderControl {
  const {
    value,
    min,
    max,
    step,
    scale = "linear",
    orientation = "horizontal",
    grab = "jump",
    travelPx,
    axis,
    wheel = true,
    disabled = false,
    notch = 1 / 30,
    ticks,
    snapRadius,
    detent,
    onChange,
    onCommit,
    onReset,
  } = opts;

  const horizontal = orientation === "horizontal";
  const trackRef = React.useRef<HTMLDivElement>(null);

  /*
   * The value the gesture last PUSHED, not the one the component last rendered.
   * Under commit pacing the prop can be a frame behind at release, so reading
   * state here would commit the second-to-last value of every fast drag.
   */
  const pushed = React.useRef(value);
  const commitRef = React.useRef(onCommit);
  commitRef.current = onCommit;

  /*
   * Every slider in the app streams through the shared live-value seam, and it
   * lives HERE rather than in each control for the same reason the gesture
   * does: there is one drag model, so there is one commit model. A Range, a
   * zoom dial and anything built on this tomorrow all get optimistic paint and
   * self-pacing writes without knowing the mechanism exists.
   */
  const streamed = useLiveValue<number>(value, onChange);
  const shown = streamed.value;

  /** Every write goes through here, so `pushed` is never stale at commit time. */
  const push = React.useCallback(
    (v: number) => {
      pushed.current = v;
      streamed.push(v);
    },
    [streamed],
  );
  /** Flush the stream, then record the boundary. Order matters: a commit must
   *  never be the first the store hears of the value it is recording. */
  const finish = React.useCallback(() => {
    streamed.end();
    commitRef.current?.(pushed.current);
  }, [streamed]);
  const fraction = scaleToFraction(shown, min, max, scale);

  // Latest inputs in a ref so the window/native listeners never go stale
  // without re-subscribing on every value tick. `value` is the SHOWN value —
  // a drag continues from where the control is painted, not from where the
  // store has caught up to, which is what made a lagging slider jump backwards.
  const live = React.useRef({
    value: shown,
    min,
    max,
    step,
    scale,
    horizontal,
    notch,
    ticks,
    snapRadius,
    detent,
    travelPx,
    onChange: push,
  });
  live.current = {
    value: shown,
    min,
    max,
    step,
    scale,
    horizontal,
    notch,
    ticks,
    snapRadius,
    detent,
    travelPx,
    onChange: push,
  };

  /**
   * Nearest detent, if one is within the snap radius — otherwise the value
   * untouched. Comparison happens in FRACTION space so a `"3%"` radius means
   * three percent of the control whether the range is 0–1 or 12–600, and a
   * numeric radius is converted into that space rather than the reverse.
   */
  const applySnap = React.useCallback((v: number, force?: number): number => {
    const s = live.current;
    const list = s.ticks;
    if (!list || list.length === 0) return v;

    const r = s.snapRadius ?? DEFAULT_SNAP_RADIUS;
    let radius: number;
    if (force !== undefined) {
      // ⌃ held: the nearest checkpoint wins from anywhere on the track.
      radius = force;
    } else if (typeof r === "string") {
      radius = (parseFloat(r) || 0) / 100;
    } else {
      // A radius in the value's own units → the same distance as a fraction.
      const span = Math.abs(s.max - s.min);
      radius = span ? r / span : 0;
    }
    if (radius <= 0) return v;

    const f = scaleToFraction(v, s.min, s.max, s.scale);
    let best: number | null = null;
    let bestD = Infinity;
    for (const t of list) {
      const d = Math.abs(scaleToFraction(t, s.min, s.max, s.scale) - f);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    return best !== null && bestD <= radius ? best : v;
  }, []);

  /** `fine` (⇧ held) snaps to a tenth of the step — the same modifier the
   *  number inputs use, so scrubbing and typing agree about precision. */
  const valueFromPointer = React.useCallback((clientX: number, clientY: number, fine = false): number => {
    const el = trackRef.current;
    const s = live.current;
    if (!el) return s.value;
    const r = el.getBoundingClientRect();
    // Vertical reads bottom→top so "up = bigger", mixer-fader convention.
    let f = s.horizontal ? (clientX - r.left) / r.width : 1 - (clientY - r.top) / r.height;
    f = clamp01(f);
    let v = scaleFromFraction(f, s.min, s.max, s.scale);
    if (s.step && s.scale === "linear") {
      const step = fine ? s.step / 10 : s.step;
      v = Number((Math.round(v / step) * step).toFixed(6));
    }
    // Detents are a COARSE aid, so ⇧ (fine) turns them off — otherwise the
    // modifier that exists to hit an exact value would keep yanking you to a
    // round one.
    if (!fine) v = applySnap(v);
    if (s.detent) v = s.detent.snap(v, fine);
    return clamp(v, s.min, s.max);
  }, [applySnap]);

  // Keyboard and wheel are DISCRETE, not a stream: one press is one value, so
  // it pushes and immediately ends. Pacing exists to thin out a continuous
  // gesture; applying it to a keystroke would only add latency to it.
  const nudge = React.useCallback(
    (dir: 1 | -1, fine = false) => {
      const s = live.current;
      let v: number;
      const detented = !fine && s.detent ? s.detent.step(s.value, dir) : null;
      if (detented !== null) {
        v = detented;
      } else if (s.step && s.scale === "linear") {
        v = s.value + dir * (fine ? s.step / 10 : s.step);
      } else {
        const f = scaleToFraction(s.value, s.min, s.max, s.scale) + dir * s.notch;
        v = scaleFromFraction(f, s.min, s.max, s.scale);
      }
      push(clamp(v, s.min, s.max));
      finish();
    },
    [push, finish],
  );

  // Wheel-to-change: native + non-passive so we can preventDefault (stop the
  // surface behind from scrolling while the pointer is over the dial).
  React.useEffect(() => {
    const el = trackRef.current;
    if (!el || !wheel || disabled) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      nudge(delta < 0 ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [wheel, disabled, nudge]);

  /**
   * Press = jump to where you clicked; drag = DELTA travel, with the pointer
   * locked. Locking is what makes a 40px slider usable: the cursor stops
   * existing, so the drag never runs out of screen, and ⇧ scales the travel
   * down for fine work — the Blender contract, via the shared
   * `usePointerDrag` gesture rather than a second copy of it here.
   */
  /**
   * The UNSNAPPED value the drag has actually travelled to. Snapping is applied
   * to the OUTPUT only, never fed back in — feeding the snapped value back made
   * every detent a trap: once it caught, the accumulator restarted from the
   * detent, so escaping cost a whole new radius of travel and the control felt
   * magnetised. Tracking the raw position means the pull is exactly as wide as
   * `snapRadius` says, in both directions.
   */
  const rawValue = React.useRef(0);
  /** ⌃ during the gesture — read live, since it can be pressed mid-drag. */
  const snapHeld = React.useRef(false);

  /**
   * WHERE THE GESTURE STARTS FROM — one function, three moments.
   *
   * `"jump"` seats the value at the pointer: you aimed at a position on the
   * track. `"hold"` keeps the value it has: a knob has no position to aim at,
   * so jumping would throw the value away every time you touched it.
   *
   * It used to live in the press handler, and it cannot any more. Under a
   * gesture scope a finger's press inside a scrolling panel is not the
   * control's yet — acting on it would mean a swipe past a fader silently
   * rewrote it. So the same seating now happens at whichever moment the
   * gesture actually becomes ours: the press (mouse, pen, anywhere nothing
   * scrolls), the arming move (a steered or held drag), or the release (a tap
   * that was never a swipe).
   */
  const seat = (clientX: number, clientY: number, fine: boolean) => {
    const v = grab === "hold" ? live.current.value : valueFromPointer(clientX, clientY, fine);
    rawValue.current = v;
    if (grab !== "hold") push(v);
  };

  const drag = usePointerDrag({
    axis: axis ?? (horizontal ? "x" : "y"),
    disabled,
    onStart: (e) => seat(e.clientX, e.clientY, e.shiftKey),
    onTap: (e) => {
      // A press that never travelled. `"hold"` controls have nothing to say
      // about a tap — a knob you touched and released should not move.
      if (grab === "hold") return;
      seat(e.clientX, e.clientY, e.shiftKey);
      finish();
    },
    // Release flushes the last value synchronously and hands authority back to
    // the prop — a paced drag must never end on a value the store never saw.
    onEnd: () => finish(),
    onMove: ({ dx, dy, fine, event }) => {
      if (event) snapHeld.current = dragModifiers(event).snap;
      const s = live.current;
      // A control with a named `travelPx` needs no element — a knob has no
      // track to measure, which is exactly why it names the distance.
      const el = trackRef.current;
      const lengthPx = s.travelPx ?? (el ? (s.horizontal ? el.clientWidth : el.clientHeight) : 0);
      if (!lengthPx) return;
      // Vertical reads bottom→top so "up = bigger", mixer-fader convention.
      // A two-axis control sums them, so up AND right both increase.
      const travel = axis === "both" ? dx - dy : s.horizontal ? dx : -dy;
      const f = scaleToFraction(rawValue.current, s.min, s.max, s.scale) + travel / lengthPx;
      const raw = clamp(scaleFromFraction(clamp01(f), s.min, s.max, s.scale), s.min, s.max);
      rawValue.current = raw;

      let v = raw;
      if (s.step && s.scale === "linear") {
        const step = fine ? s.step / 10 : s.step;
        v = Number((Math.round(v / step) * step).toFixed(6));
      }
      // ⌃ forces the pull, ⇧ releases it, neither wins by default — the one
      // contract, from `drag-modifiers`. Detents still pull on their own within
      // `snapRadius` when no modifier is held.
      if (snapHeld.current) v = applySnap(v, Infinity);
      else if (!fine) v = applySnap(v);
      if (s.detent) v = s.detent.snap(v, fine);
      s.onChange(clamp(v, s.min, s.max));
    },
  });

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled || e.button !== 0) return;
    snapHeld.current = dragModifiers(e).snap;
    // Seating happens in `onStart`/`onTap`, not here — see `seat`. The press
    // alone no longer proves the gesture is this control's.
    drag.bind.onPointerDown(e);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") {
      e.preventDefault();
      nudge(1, e.shiftKey);
    } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
      e.preventDefault();
      nudge(-1, e.shiftKey);
    }
  };

  return {
    trackRef,
    value: shown,
    fraction,
    dragging: drag.dragging,
    fine: drag.fine,
    horizontal,
    disabled,
    nudge,
    trackProps: {
      onPointerDown,
      onPointerMove: drag.bind.onPointerMove,
      onPointerUp: drag.bind.onPointerUp,
      onPointerCancel: drag.bind.onPointerCancel,
      onDoubleClick: onReset,
      /* Straight from the gesture that needs it — selection and iOS callout
       * suppression, and deliberately no `touch-action`: the scroll around
       * this control stays the browser's until the gesture is earned. Take the
       * style FROM the hook; never re-type it. */
      style: drag.bind.style,
      "data-no-longpress": drag.bind["data-no-longpress"],
    },
    keyProps: {
      role: "slider",
      tabIndex: disabled ? -1 : 0,
      "aria-valuenow": Math.round(value * 100) / 100,
      "aria-valuemin": min,
      "aria-valuemax": max,
      "aria-orientation": orientation,
      onKeyDown,
    },
  };
}

/**
 * The plain base slider — a thin track + round thumb, driven entirely by
 * `useSliderControl`. This is the extension point: adjustment sliders, gain
 * faders, etc. can reuse the exact gesture model and restyle the chrome, or
 * drop this in directly. `ZoomControl` is the first richer skin built on the
 * same hook.
 */
export function SliderBase({
  className,
  length = 120,
  thickness = 4,
  ...opts
}: UseSliderControlOptions & { className?: string; length?: number; thickness?: number }) {
  const c = useSliderControl(opts);
  const pct = `${c.fraction * 100}%`;
  return (
    <div
      ref={c.trackRef}
      {...c.trackProps}
      {...c.keyProps}
      className={cn(
        "relative select-none outline-none focus-visible:ring-1 focus-visible:ring-ring",
        c.horizontal ? "cursor-ew-resize" : "cursor-ns-resize",
        c.disabled && "pointer-events-none opacity-40",
        className,
      )}
      style={{
        ...c.trackProps.style,
        ...(c.horizontal ? { width: length, height: 16 } : { width: 16, height: length }),
      }}
    >
      <div
        className="absolute rounded-full bg-secondary"
        style={
          c.horizontal
            ? { left: 0, right: 0, top: "50%", height: thickness, transform: "translateY(-50%)" }
            : { top: 0, bottom: 0, left: "50%", width: thickness, transform: "translateX(-50%)" }
        }
      />
      <div
        className="absolute rounded-full bg-primary"
        style={
          c.horizontal
            ? { left: 0, top: "50%", height: thickness, width: pct, transform: "translateY(-50%)" }
            : { bottom: 0, left: "50%", width: thickness, height: pct, transform: "translateX(-50%)" }
        }
      />
      <div
        className="absolute size-3.5 rounded-full border border-primary/60 bg-foreground shadow"
        style={
          c.horizontal
            ? { left: pct, top: "50%", transform: "translate(-50%,-50%)" }
            : { bottom: pct, left: "50%", transform: "translate(-50%,50%)" }
        }
      />
    </div>
  );
}
