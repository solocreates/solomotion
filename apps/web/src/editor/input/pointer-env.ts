"use client";

import * as React from "react";

/**
 * WHAT THIS DEVICE CAN DO — the one place the app asks, and it asks about
 * CAPABILITIES, not about device names.
 *
 * "Detect the device" is the reflex, and it is the wrong question. There is no
 * stable set of devices: an iPad has a trackpad and a keyboard, a Surface has a
 * touchscreen and a mouse, a MacBook has a Pencil-less touchpad that reports
 * pinch as ctrl+wheel, and a phone plugged into a dock has all three. Every
 * app that branched on `isMobile` ended up with a tablet that got the phone's
 * gestures and a laptop that got neither. The questions that actually decide
 * behaviour are narrower and each has a real answer:
 *
 *   can it hover?          → tooltips, hover affordances, drag previews
 *   is there a coarse      → hit-target sizing, long-press menus, the modifier
 *   pointer?                 puck
 *   how many touches?      → is a two-finger gesture even possible
 *   is this event a pen?   → pressure, tilt, palm rejection, no panning
 *   which platform?        → ⌘ vs Ctrl in LABELS only, never in behaviour
 *
 * The last one is the only place a platform string is legitimate, and it is
 * cosmetic. Two copies of that check already existed (`drag-modifiers.ts` and
 * `shortcut-registry.ts`, both reading the deprecated `navigator.platform`);
 * they now read this.
 *
 * Everything here is LIVE. A media query, not a boot-time snapshot: plugging in
 * a mouse, detaching a keyboard case, or dragging the window to a touchscreen
 * all change the answer, and an app that sampled once at load is wrong for the
 * rest of the session.
 */

/** The kind of thing that produced a pointer event. Mirrors `pointerType`. */
export type PointerClass = "mouse" | "touch" | "pen";

/** Normalise `PointerEvent.pointerType`, which is an open string in the spec. */
export function pointerClass(e: { pointerType?: string }): PointerClass {
  return e.pointerType === "touch" ? "touch" : e.pointerType === "pen" ? "pen" : "mouse";
}

export type Platform = "mac" | "ios" | "windows" | "android" | "linux" | "unknown";

/**
 * Platform, for LABELS. `navigator.platform` is deprecated and lies on iPadOS
 * (which reports "MacIntel"), so the modern hint comes first and touch points
 * disambiguate the iPad — an iPad has them, a Mac does not.
 */
export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "unknown";
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const raw = (nav.userAgentData?.platform || nav.platform || navigator.userAgent || "").toLowerCase();
  const touchy = (navigator.maxTouchPoints ?? 0) > 1;
  if (/iphone|ipod/.test(raw)) return "ios";
  if (/ipad/.test(raw)) return "ios";
  if (/mac/.test(raw)) return touchy ? "ios" : "mac";
  if (/android/.test(raw)) return "android";
  if (/win/.test(raw)) return "windows";
  if (/linux/.test(raw)) return "linux";
  return "unknown";
}

/** ⌘ or Ctrl — the only behavioural use of the platform, and it is a label. */
export function isApplePlatform(): boolean {
  const p = detectPlatform();
  return p === "mac" || p === "ios";
}

export interface PointerEnv {
  /** A mouse/trackpad/stylus that can point precisely is available. */
  fine: boolean;
  /** SOME pointer on this device is a finger. Note `any-pointer`, not
   *  `pointer`: a laptop with a touchscreen has both, and both must be true. */
  coarse: boolean;
  /** Hover states are real here. False on touch-only, and that is what makes
   *  a hover-only affordance a bug rather than a nicety. */
  hover: boolean;
  /**
   * The PRIMARY pointer is coarse — a phone or a tablet, where the finger is
   * how you drive the app.
   *
   * Distinct from `coarse` (`any-pointer`) and the distinction is load-bearing:
   * an iPad with an Apple Pencil paired reports `any-pointer: fine` TRUE,
   * because the Pencil is a fine pointer. Anything asking "is this a tablet?"
   * with `coarse && !fine` therefore answers NO on exactly the device it was
   * written for — which is how pen-only mode shipped inert on every iPad that
   * had a Pencil.
   *
   * `(pointer: coarse)` asks about the pointer you actually navigate with, so
   * an iPad is coarse whatever is paired to it, and a laptop with a touchscreen
   * stays fine.
   */
  primaryCoarse: boolean;
  /** How many simultaneous touches — 0 means no touchscreen at all. */
  touchPoints: number;
  /** Two-finger gestures (pinch, twist, two-finger pan) are possible. */
  multiTouch: boolean;
  platform: Platform;
  /** Show ⌘/⌥/⇧ glyphs rather than Ctrl/Alt/Shift. */
  apple: boolean;
  /**
   * There is probably no physical keyboard, so any gesture that needs a
   * modifier is UNREACHABLE without help.
   *
   * Genuinely undetectable — the web has no keyboard API — so this is a
   * judgement, and it is stated as one: touch present, no fine pointer, no
   * hover. An iPad with a Magic Keyboard reports a fine pointer and hover, so
   * it correctly lands on `false`; a bare iPad or a phone lands on `true`.
   * Only ever used to pick a DEFAULT the user can change, never to remove a
   * capability.
   */
  keyboardUnlikely: boolean;
}

const SERVER_ENV: PointerEnv = {
  fine: true,
  coarse: false,
  primaryCoarse: false,
  hover: true,
  touchPoints: 0,
  multiTouch: false,
  platform: "unknown",
  apple: false,
  keyboardUnlikely: false,
};

function readEnv(): PointerEnv {
  if (typeof window === "undefined") return SERVER_ENV;
  const q = (s: string) => window.matchMedia(s).matches;
  const fine = q("(any-pointer: fine)");
  const coarse = q("(any-pointer: coarse)");
  const primaryCoarse = q("(pointer: coarse)");
  const hover = q("(any-hover: hover)");
  const touchPoints = navigator.maxTouchPoints ?? 0;
  const platform = detectPlatform();
  return {
    fine,
    coarse,
    primaryCoarse,
    hover,
    touchPoints,
    multiTouch: touchPoints > 1,
    platform,
    apple: platform === "mac" || platform === "ios",
    keyboardUnlikely: coarse && !fine && !hover,
  };
}

/** Imperative read, for non-React callers (stores, event handlers, labels). */
let cached: PointerEnv | null = null;
export function pointerEnv(): PointerEnv {
  if (typeof window === "undefined") return SERVER_ENV;
  return (cached ??= readEnv());
}

const QUERIES = ["(any-pointer: fine)", "(any-pointer: coarse)", "(any-hover: hover)", "(pointer: coarse)"];

/**
 * Subscribe to capability changes. Attaching a mouse to a tablet fires these,
 * and the app has to follow — a rail that stayed finger-sized after a trackpad
 * appeared is the same staleness bug as a layout that sampled the window width
 * once at boot.
 */
export function subscribePointerEnv(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const invalidate = () => {
    cached = null;
    cb();
  };
  const lists = QUERIES.map((q) => window.matchMedia(q));
  for (const l of lists) l.addEventListener("change", invalidate);
  return () => {
    for (const l of lists) l.removeEventListener("change", invalidate);
  };
}

/** The React face. Re-renders when the device's capabilities actually change. */
export function usePointerEnv(): PointerEnv {
  return React.useSyncExternalStore(subscribePointerEnv, pointerEnv, () => SERVER_ENV);
}

/**
 * Publish the device's pointer class as an ATTRIBUTE on <html>, so CSS can
 * size hit targets without every component subscribing.
 *
 * Mounted once at the shell root. The alternative — `usePointerEnv()` in each
 * control that wants a bigger grab zone on a tablet — is one media-query
 * subscription per clip, per keyframe, per handle, for a single boolean that
 * changes about twice in a session. `data-pointer` plus `--hit-grip` is the
 * same trick `data-glass` uses, and it costs nothing at any scale.
 */
export function useCoarsePointerSync(): void {
  const env = usePointerEnv();
  React.useEffect(() => {
    document.documentElement.dataset.pointer = env.primaryCoarse ? "coarse" : "fine";
  }, [env.primaryCoarse]);
}
