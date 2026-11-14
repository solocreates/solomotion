"use client";

import * as React from "react";
import { pointerEnv } from "./pointer-env";

/**
 * The modifier puck's own state: whether it is offered, and where it sits.
 *
 * Deliberately its own store rather than a field on `workspace`. That one holds
 * DOCUMENT-adjacent preferences — templates, categories, favourites, custom
 * colours, panel zoom — and this is neither: it is a property of the input
 * device in front of you. Keeping it here also means the whole input layer is
 * one folder you can read end to end, which is the point of putting it in one.
 */

export type PuckMode = "auto" | "on" | "off";

export interface PuckState {
  mode: PuckMode;
  /**
   * Position as a FRACTION of the viewport, not pixels. A puck parked 40px
   * from the right edge of a phone is off-screen on a desktop and vice versa;
   * a fraction survives rotation, a window resize and moving between the two.
   */
  fx: number;
  fy: number;
}

const KEY = "tm-modifier-puck-v1";

// Bottom-left by default: the reachable corner for a right-handed grip, and
// the one corner of the stage that carries no chrome (tools are top-left, the
// view cluster top-right, zoom bottom-right).
const DEFAULTS: PuckState = { mode: "auto", fx: 0.08, fy: 0.78 };

let state: PuckState = DEFAULTS;
let loaded = false;
const subs = new Set<() => void>();

function load(): PuckState {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<PuckState>;
    return {
      mode: p.mode === "on" || p.mode === "off" ? p.mode : "auto",
      fx: typeof p.fx === "number" ? Math.min(1, Math.max(0, p.fx)) : DEFAULTS.fx,
      fy: typeof p.fy === "number" ? Math.min(1, Math.max(0, p.fy)) : DEFAULTS.fy,
    };
  } catch {
    return DEFAULTS;
  }
}

function ensure(): PuckState {
  if (!loaded) {
    state = load();
    loaded = true;
  }
  return state;
}

function commit(next: PuckState) {
  state = next;
  loaded = true;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Quota / private mode — the puck just won't remember where it was.
  }
  for (const fn of subs) fn();
}

export const puckStore = {
  get: ensure,
  setMode: (mode: PuckMode) => commit({ ...ensure(), mode }),
  setPosition: (fx: number, fy: number) => commit({ ...ensure(), fx, fy }),
  subscribe: (fn: () => void) => {
    subs.add(fn);
    return () => subs.delete(fn);
  },
};

export function usePuckState(): PuckState {
  return React.useSyncExternalStore(puckStore.subscribe, ensure, () => DEFAULTS);
}

/**
 * Should the puck be on screen?
 *
 * `auto` means "touch is the primary way you point here", and the predicate is
 * `primaryCoarse` — NOT `coarse && !fine`, which is the trap this codebase's
 * own notes warn about and which this function was nonetheless still walking
 * into. `coarse` is `any-pointer`, and an Apple Pencil makes `any-pointer:
 * fine` TRUE. So `coarse && !fine` answered "not a tablet" on an iPad the
 * moment a Pencil was paired — hiding the modifier pad on exactly the device
 * it exists for, and hiding it precisely when the user had picked up the
 * instrument that needs ⇧ and ⌥ most.
 *
 * `(pointer: coarse)` asks about the pointer you actually navigate with, so an
 * iPad stays coarse whatever is paired to it and a touchscreen laptop — which
 * has a trackpad and a real Shift key — stays fine.
 */
export function usePuckVisible(): boolean {
  const { mode } = usePuckState();
  const [env, setEnv] = React.useState(() => pointerEnv());
  React.useEffect(() => {
    setEnv(pointerEnv());
  }, []);
  if (mode === "on") return true;
  if (mode === "off") return false;
  return env.primaryCoarse;
}
