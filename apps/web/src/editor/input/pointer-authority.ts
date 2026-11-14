"use client";

import { create } from "zustand";
import { pointerEnv } from "./pointer-env";

/**
 * POINTER AUTHORITY — what a given pointer is ALLOWED to do, app-wide.
 *
 * This replaces `toolAcceptsPointer`, which asked one boolean question ("may
 * this pointer drive a tool?") and therefore had one boolean answer for twelve
 * different kinds of thing. On a tablet that answer is wrong in both
 * directions at once: a finger must not lay down a brush stroke or rubber-band
 * a selection while a stylus is in play, but it absolutely must still be able
 * to drag a layer, pull a resize handle, or draw out a text box. A single
 * `penOnly` flag cannot express that, and every attempt to express it at the
 * call sites produced a different rule per surface.
 *
 * So authority is a small union of ACTS and a policy table, read through ONE
 * predicate:
 *
 *     pointerMay(e, "paint")   → false for a finger once a stylus exists
 *     pointerMay(e, "transform") → true for a finger, always, by default
 *
 * Adding a thirteenth tool is choosing which act it performs. Changing the
 * rule for every brush in the app is one row of a table. Neither is a new
 * `if (pointerType === "touch")` in a component, which is the shape this
 * replaces.
 *
 * ── Why acts and not tools ──────────────────────────────────────────────────
 *
 * A rule keyed by TOOL has to grow a row per tool forever and says nothing
 * about the ten hand-rolled gestures that are not tools at all (resize
 * handles, the pivot, gradient knobs, motion-path points). Acts are the small
 * closed set of things a pointer can MEAN, and every gesture in the app is one
 * of them. Five rows cover a surface area that would otherwise be fifty.
 */

/** What a pointer is trying to DO. Every gesture in the app is one of these. */
export type PointerAct =
  /** Freehand marks that become artwork: brush, eraser, smudge. */
  | "paint"
  /** A selection region swept from empty space: marquee, freehand lasso. */
  | "sweep"
  /** Creating geometry by dragging it out: shapes, frames, text boxes, paths. */
  | "shape"
  /** Moving, resizing, rotating, skewing something that already exists. */
  | "transform"
  /** A tap: select, eyedrop, flood fill, hit a handle. */
  | "pick";

/**
 * The rule for one act, for TOUCH. Mouse and pen are never restricted — a
 * stylus is the precise instrument and restricting it is what "pen only" is
 * for, not against.
 *
 *   "always"  a finger may do this, stylus present or not.
 *   "no-pen"  a finger may do this only while NO stylus is in play. The moment
 *             one is, this becomes the stylus's job and the finger navigates.
 *   "never"   a finger may never do this here.
 */
export type TouchRule = "always" | "no-pen" | "never";

export type TouchAuthority = Record<PointerAct, TouchRule>;

/**
 * The defaults, and each one is a decision rather than a hedge.
 *
 * `paint` and `sweep` are the two acts where a stray finger costs you work: a
 * palm stroke has to be found and undone, and a rubber band silently replaces
 * a selection you had built up. Both are also the two acts a stylus is
 * unambiguously better at. Everything else — dragging a layer, pulling a
 * handle, dropping a text box, tapping to select — a finger does perfectly
 * well, is faster at, and cannot get wrong in a way that is expensive. Taking
 * those away is what made pen-only read as "the app is broken" rather than as
 * a feature.
 */
export const AUTHORITY_DEFAULTS: TouchAuthority = {
  paint: "no-pen",
  sweep: "no-pen",
  shape: "always",
  transform: "always",
  pick: "always",
};

/** Labels for the settings table. Kept beside the union so a new act cannot be
 *  added without one. */
export const ACT_LABELS: Record<PointerAct, { title: string; hint: string }> = {
  paint: {
    title: "Paint strokes",
    hint: "Brush, eraser and smudge. Off with a stylus paired is what stops palm and knuckle marks.",
  },
  sweep: {
    title: "Drag a selection box",
    hint: "Rubber-band and freehand lasso from empty space. The gesture most easily started by accident, and the one that silently replaces a selection.",
  },
  shape: {
    title: "Draw shapes and text boxes",
    hint: "Dragging out a rectangle, a frame, a text box or a path. Precise enough with a finger and faster than reaching for the pen.",
  },
  transform: {
    title: "Move and resize layers",
    hint: "Dragging a layer, pulling a handle, rotating. A finger is good at this; taking it away is what makes an app feel dead.",
  },
  pick: {
    title: "Tap to select",
    hint: "Selecting, eyedropping, filling. Turning this off leaves the canvas unable to respond to a finger at all.",
  },
};

/**
 * PEN-ONLY — the master switch, `auto` by default.
 *
 * `auto` asks two questions, and it needs both:
 *
 *   · is touch the PRIMARY pointer here (a tablet or a phone, not a laptop
 *     with a touchscreen)? — `primaryCoarse`, never `coarse && !fine`, which
 *     answers "not a tablet" on an iPad with a Pencil paired because the
 *     Pencil is itself a fine pointer;
 *   · has a stylus actually been used? — because "pen only" on a device with
 *     no pen means "nothing works", which an Android phone proved once
 *     already.
 *
 * The second question is why `notePen` is fed by the app-wide pointer tracker
 * rather than by the tool doors. It used to be recorded only when a stylus
 * pressed on the stage or the drawing overlay, so a Pencil that had spent five
 * minutes tapping buttons, opening panels and scrubbing the timeline had still
 * never been "seen", and the first stroke of the session went to the finger
 * anyway. A stylus touching the glass ANYWHERE is a stylus.
 */
export type PenOnlyMode = "auto" | "on" | "off";

/**
 * WHAT ONE FINGER DOES ON A CANVAS.
 *
 * `tool` is the default, and the reversal is the point.
 *
 * It was `navigate` — a finger pans, two fingers pan and zoom — on the
 * reasoning that Procreate does it. Procreate is a PAINTING app: one finger has
 * no precise job there, so spending it on the camera is free. A stage is not.
 * On a stage one finger has the most ordinary job in the application — pick a
 * layer up and move it — and taking that away to give the camera a second
 * gesture it already had is the trade backwards. Dragging a layer scrolled the
 * canvas instead, and because the press sat still while you found the layer,
 * the 500ms hold fired too: you got a pan AND a context menu, and no move.
 *
 * Two fingers were already navigation, unconditionally, on every surface. So:
 *
 *   tool      DEFAULT. One finger is the armed tool, immediately — select,
 *             move, resize, rotate, pen, text, shape. Two fingers pan and zoom.
 *             Holding still is still a right-click, because a press that has
 *             not moved has not done anything yet.
 *   hold      pause briefly before dragging to use the tool; a quick swipe is
 *             inert. For people who rest a hand on the glass.
 *   navigate  one finger pans as well. The Procreate feel, for painting.
 *
 * This is the setting, not the rule. The rule is `gesture-scope.ts`: a canvas
 * has nothing to scroll, so a press there GRABS, while the same finger in a
 * scrolling panel defers to a brief hold. The three modes only shift the canvas
 * end of that, and they are per-user because how much of the glass your palm
 * touches is not something an app can measure.
 */
export type FingerCanvasMode = "navigate" | "hold" | "tool";

/*
 * ONE FINGER IN A 3D WORLD is the same three answers with the other default.
 *
 * In a world there is no layer to pick up and slide — moving an object is a
 * gizmo handle or G, and a handle is always grabbed whatever this says. What
 * one finger does constantly is LOOK: turn the scene round, as every 3D app on
 * a tablet does it. So `navigate` is the default here: drag orbits, two
 * fingers pan and pinch, a tap selects, holding still is the menu. A brush
 * (sculpt, draw) is still the brush wherever a finger may paint — that is the
 * pen-only rule's question, not this one.
 */

interface AuthorityState {
  mode: PenOnlyMode;
  /** A stylus has touched the glass recently (see `PEN_MEMORY_MS`). */
  penSeen: boolean;
  fingerCanvas: FingerCanvasMode;
  /** One finger in a 3D viewport (see above). */
  fingerWorld: FingerCanvasMode;
  /** Two- and three-finger taps run undo / redo. */
  tapUndo: boolean;
  /** Press and hold opens the context menu, touch and pen alike. */
  longPressMenu: boolean;
  touch: TouchAuthority;
  setMode: (mode: PenOnlyMode) => void;
  setFingerCanvas: (mode: FingerCanvasMode) => void;
  setFingerWorld: (mode: FingerCanvasMode) => void;
  setTapUndo: (on: boolean) => void;
  setLongPressMenu: (on: boolean) => void;
  setTouchRule: (act: PointerAct, rule: TouchRule) => void;
  resetTouchRules: () => void;
  notePen: () => void;
  /** Is the restricted policy in force right now? */
  restricted: () => boolean;
}

const MODE_KEY = "tm-pen-only-v1";
/*
 * BUMPED FROM v1. The stored table is a snapshot of a MODEL, and the model
 * changed: `fingerCanvas` used to default to panning the canvas, which on a
 * stage meant dragging a layer scrolled the view instead of moving the layer.
 * Anyone who had ever opened the app carried that value forward and would have
 * kept the old behaviour with no way to know why — a default that only applies
 * to people who have never run the app is not a default, it is a trap.
 *
 * Bumping the key is the honest migration for preferences whose MEANING moved.
 * Explicit choices worth keeping across a rename can be read from the old key;
 * these were not — they were defaults nobody chose.
 */
const PREFS_KEY = "tm-touch-prefs-v2";
const PEN_KEY = "tm-pen-seen-v1";

/**
 * How long a stylus is remembered across reloads.
 *
 * Not persisting it at all was the previous behaviour and it made `auto`
 * useless in practice: every reload handed the first stroke of the session
 * back to the finger, because the app had forgotten it was on a device with a
 * Pencil until the Pencil touched it again. Persisting it forever is the other
 * error — a stylus borrowed once should not disable finger drawing on a device
 * it is no longer paired with. Two weeks is "this is my pen".
 */
const PEN_MEMORY_MS = 14 * 24 * 60 * 60 * 1000;

function loadMode(): PenOnlyMode {
  if (typeof window === "undefined") return "auto";
  const raw = window.localStorage.getItem(MODE_KEY);
  return raw === "on" || raw === "off" ? raw : "auto";
}

function loadPenSeen(): boolean {
  if (typeof window === "undefined") return false;
  const at = Number(window.localStorage.getItem(PEN_KEY) ?? 0);
  return Number.isFinite(at) && at > 0 && Date.now() - at < PEN_MEMORY_MS;
}

interface TouchPrefs {
  fingerCanvas: FingerCanvasMode;
  fingerWorld: FingerCanvasMode;
  tapUndo: boolean;
  longPressMenu: boolean;
  touch: TouchAuthority;
}

const PREF_DEFAULTS: TouchPrefs = {
  fingerCanvas: "tool",
  fingerWorld: "navigate",
  tapUndo: true,
  longPressMenu: true,
  touch: AUTHORITY_DEFAULTS,
};

const isRule = (v: unknown): v is TouchRule => v === "always" || v === "no-pen" || v === "never";

function loadPrefs(): TouchPrefs {
  if (typeof window === "undefined") return PREF_DEFAULTS;
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return PREF_DEFAULTS;
    const p = JSON.parse(raw) as Partial<TouchPrefs>;
    // Read each rule through the default, so an act added later is present and
    // sane for someone whose stored table predates it — the table is persisted
    // and a missing key would otherwise read as `undefined` and deny silently.
    const stored = (p.touch ?? {}) as Partial<Record<PointerAct, unknown>>;
    const touch = { ...AUTHORITY_DEFAULTS };
    for (const act of Object.keys(AUTHORITY_DEFAULTS) as PointerAct[]) {
      if (isRule(stored[act])) touch[act] = stored[act];
    }
    return {
      fingerCanvas: p.fingerCanvas ?? PREF_DEFAULTS.fingerCanvas,
      fingerWorld: p.fingerWorld ?? PREF_DEFAULTS.fingerWorld,
      tapUndo: p.tapUndo ?? PREF_DEFAULTS.tapUndo,
      longPressMenu: p.longPressMenu ?? PREF_DEFAULTS.longPressMenu,
      touch,
    };
  } catch {
    return PREF_DEFAULTS;
  }
}

export const usePointerAuthority = create<AuthorityState>((set, get) => {
  const persist = (patch: Partial<TouchPrefs>) =>
    set((s) => {
      const next: TouchPrefs = {
        fingerCanvas: s.fingerCanvas,
        fingerWorld: s.fingerWorld,
        tapUndo: s.tapUndo,
        longPressMenu: s.longPressMenu,
        touch: s.touch,
        ...patch,
      };
      try {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        /* private mode — the preference just won't persist */
      }
      return next;
    });

  return {
    mode: loadMode(),
    penSeen: loadPenSeen(),
    ...loadPrefs(),
    setFingerCanvas: (fingerCanvas) => persist({ fingerCanvas }),
    setFingerWorld: (fingerWorld) => persist({ fingerWorld }),
    setTapUndo: (tapUndo) => persist({ tapUndo }),
    setLongPressMenu: (longPressMenu) => persist({ longPressMenu }),
    setTouchRule: (act, rule) => persist({ touch: { ...get().touch, [act]: rule } }),
    resetTouchRules: () => persist({ touch: { ...AUTHORITY_DEFAULTS } }),
    setMode: (mode) => {
      try {
        window.localStorage.setItem(MODE_KEY, mode);
      } catch {
        /* private mode — the preference just won't persist */
      }
      set({ mode });
    },
    notePen: () => {
      try {
        window.localStorage.setItem(PEN_KEY, String(Date.now()));
      } catch {
        /* the stylus is still noted for this session */
      }
      if (!get().penSeen) set({ penSeen: true });
    },
    restricted: () => {
      const s = get();
      if (s.mode !== "auto") return s.mode === "on";
      return pointerEnv().primaryCoarse && s.penSeen;
    },
  };
});

/** Record that a stylus exists. Called by the app-wide pointer tracker for
 *  EVERY pen event, so no surface can be the one that forgets. */
export function notePen(): void {
  usePointerAuthority.getState().notePen();
}

/** Is a stylus in play on this device right now? */
export function penPresent(): boolean {
  return usePointerAuthority.getState().penSeen;
}

/** Is the restricted touch policy in force? Exposed for the settings readout;
 *  gestures should ask `pointerMay` instead of branching on this. */
export function touchRestricted(): boolean {
  return usePointerAuthority.getState().restricted();
}

/**
 * THE question every gesture asks: may this pointer do this?
 *
 * Call it at the entry point of a gesture family — a tool door, a marquee
 * start, a handle's `onPointerDown` — and return early when false. A refused
 * finger is NOT a dead pointer: it still scrolls, pans, pinches, taps and
 * opens menus. Refusing an ACT never refuses navigation, and that distinction
 * is the whole reason this reads as a feature rather than as an app that
 * ignores you.
 */
export function pointerMay(e: { pointerType?: string }, act: PointerAct): boolean {
  const type = e.pointerType ?? "mouse";
  if (type !== "touch") return true;
  const s = usePointerAuthority.getState();
  const rule = s.touch[act] ?? AUTHORITY_DEFAULTS[act];
  if (rule === "always") return true;
  if (rule === "never") return false;
  return !s.restricted();
}

/**
 * Which act a stage tool performs, so the stage's one door can ask the right
 * question instead of asking one question for every tool.
 *
 * `select` maps to `transform` deliberately: a select press USUALLY grabs
 * something, and the one case where it does not — a drag from empty space — is
 * a `sweep` and asks for itself at the point where the stage discovers there
 * was nothing under the finger. Gating the whole door on `sweep` would take
 * away moving a layer to prevent a rubber band.
 */
export function actForTool(tool: string): PointerAct {
  switch (tool) {
    case "brush":
    case "eraser":
      return "paint";
    case "lasso":
      return "sweep";
    case "fill":
    case "wand":
    case "eyedropper":
      return "pick";
    case "text":
    case "frame":
    case "rect":
    case "ellipse":
    case "triangle":
    case "polygon":
    case "star":
    case "pen":
    case "cut":
      return "shape";
    default:
      return "transform";
  }
}
