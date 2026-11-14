"use client";

import * as React from "react";
import { DEFAULT_KEYMAP_ID, keymapById } from "./keymaps";
import {
  DEFAULT_WORLD_KEYMAP_ID,
  WORLD_SHORTCUT_DEFS,
  isWorldCommand,
  worldKeymapById,
  worldKeyModes,
  type WorldKeyMode,
  type WorldShortcutDef,
} from "./world-shortcuts";

export { WORLD_SHORTCUT_DEFS, WORLD_KEYMAPS, type WorldCommandId } from "./world-shortcuts";

/**
 * The one shortcut registry. Every keyboard command declares itself here;
 * `use-shortcuts` dispatches through it, menus render their hints from it,
 * and Settings edits it (overrides persist in localStorage). One source of
 * truth — keys, menus and the palette can never disagree.
 *
 * A combo is a normalized string: `[mod+][alt+][shift+]<key>` where key is
 * the name `eventKey` gives the event ("v", "space", "backspace", ",",
 * "arrowleft" …) — the layout's own name when it is a plain ASCII key, the US
 * name of the PHYSICAL key otherwise, so "mod+z" is ⌘Z under a Persian layout
 * too. "mod" is ⌘ on mac, Ctrl elsewhere. Delete normalizes to backspace.
 */

export interface ShortcutDef {
  id: string;
  label: string;
  group: "File" | "Tools" | "Edit" | "Playback" | "View";
  combo: string;
}

export const SHORTCUT_DEFS: ShortcutDef[] = [
  { id: "file.save", label: "Save project", group: "File", combo: "mod+s" },

  { id: "tool.select", label: "Select tool", group: "Tools", combo: "v" },
  { id: "tool.hand", label: "Hand tool", group: "Tools", combo: "h" },
  { id: "tool.text", label: "Text tool", group: "Tools", combo: "t" },
  { id: "tool.frame", label: "Frame tool", group: "Tools", combo: "f" },
  { id: "tool.rect", label: "Rectangle tool", group: "Tools", combo: "q" },
  { id: "tool.ellipse", label: "Ellipse tool", group: "Tools", combo: "o" },
  { id: "tool.pen", label: "Pen tool", group: "Tools", combo: "p" },
  { id: "tool.bone", label: "Bone tool — draw and edit a rig", group: "Tools", combo: "j" },
  { id: "tool.brush", label: "Brush tool", group: "Tools", combo: "b" },
  { id: "tool.brushEngine", label: "Toggle brush engine (pixel / vector)", group: "Tools", combo: "shift+b" },
  // "E" is contextual (first match wins): over selected keyframes the handler
  // opens the easing popover (edit.easing's behavior); otherwise the eraser.
  { id: "tool.eraser", label: "Eraser tool", group: "Tools", combo: "e" },
  { id: "tool.fill", label: "Paint bucket", group: "Tools", combo: "g" },
  { id: "tool.lasso", label: "Lasso — free / auto select", group: "Tools", combo: "l" },
  { id: "tool.eyedropper", label: "Eyedropper — sample a canvas color", group: "Tools", combo: "i" },

  // THE PAINT MODES. They belong to the gesture rather than to a tool, so they
  // are bound once and work under the brush, the eraser and the bucket alike —
  // which is also why they are not filed under any one of them.
  { id: "paint.confine", label: "Paint inside the region", group: "Tools", combo: "shift+i" },
  { id: "paint.depth", label: "Paint over / under", group: "Tools", combo: "shift+u" },
  { id: "paint.closeGaps", label: "Close gaps in line art", group: "Tools", combo: "shift+g" },
  { id: "paint.merge", label: "Merge overlapping vector strokes", group: "Tools", combo: "shift+m" },
  { id: "paint.reference", label: "Use the selection as the paint reference", group: "Tools", combo: "shift+r" },

  { id: "edit.undo", label: "Undo", group: "Edit", combo: "mod+z" },
  { id: "edit.redo", label: "Redo", group: "Edit", combo: "mod+shift+z" },
  { id: "edit.copy", label: "Copy", group: "Edit", combo: "mod+c" },
  { id: "edit.cut", label: "Cut", group: "Edit", combo: "mod+x" },
  { id: "edit.paste", label: "Paste", group: "Edit", combo: "mod+v" },
  { id: "edit.duplicate", label: "Duplicate", group: "Edit", combo: "mod+d" },
  { id: "edit.delete", label: "Delete selection", group: "Edit", combo: "backspace" },
  { id: "edit.group", label: "Group layers", group: "Edit", combo: "mod+g" },
  { id: "edit.ungroup", label: "Ungroup", group: "Edit", combo: "mod+shift+g" },
  { id: "edit.flatten", label: "Flatten to path", group: "Edit", combo: "mod+e" },
  { id: "edit.auto-layout", label: "Add / remove auto layout", group: "Edit", combo: "shift+a" },
  { id: "edit.flip-h", label: "Flip horizontal", group: "Edit", combo: "shift+h" },
  { id: "edit.flip-v", label: "Flip vertical", group: "Edit", combo: "shift+v" },
  { id: "edit.mask", label: "Use as mask", group: "Edit", combo: "mod+alt+m" },
  { id: "edit.lock", label: "Lock / unlock selection", group: "Edit", combo: "mod+shift+l" },
  { id: "edit.hide", label: "Show / hide selection", group: "Edit", combo: "mod+shift+h" },
  // Figma's binding: ⌘K is the command palette here. Inside the text editor
  // ⌘K adds a link too — the binding every document editor uses.
  { id: "edit.link", label: "Add or edit link", group: "Edit", combo: "mod+shift+u" },
  { id: "edit.split", label: "Split at playhead", group: "Edit", combo: "mod+b" },
  {
    id: "edit.transition",
    label: "Add default transition at playhead",
    group: "Edit",
    combo: "mod+shift+d",
  },
  { id: "edit.selectAll", label: "Select all clips", group: "Edit", combo: "mod+a" },
  // TRACK SELECT — the verb every NLE has and this app did not. "Everything
  // from here on" is how you make room, and doing it by rubber-band means
  // scrolling to the end of the timeline first.
  { id: "edit.selectForward", label: "Select clips forward", group: "Edit", combo: "a" },
  { id: "edit.selectBackward", label: "Select clips backward", group: "Edit", combo: "shift+a" },
  // Delete AND close the hole, in one step — Premiere's ⇧⌫, and the other half
  // of the gap work: plain Delete leaves the hole, this one doesn't.
  { id: "edit.rippleDelete", label: "Ripple delete (close the gap)", group: "Edit", combo: "shift+backspace" },
  { id: "edit.nudgeLeft", label: "Nudge one frame left", group: "Edit", combo: "alt+arrowleft" },
  { id: "edit.nudgeRight", label: "Nudge one frame right", group: "Edit", combo: "alt+arrowright" },
  { id: "edit.freezeFrame", label: "Freeze frame at playhead", group: "Edit", combo: "shift+f" },
  { id: "edit.speed", label: "Speed — open the panel", group: "Edit", combo: "mod+r" },
  // Keyframe navigation with a KEY, not just the section arrows: once a
  // property is animated, moving between its keys is the gesture you make most.
  { id: "keyframe.prev", label: "Previous keyframe", group: "Edit", combo: "mod+arrowleft" },
  { id: "keyframe.next", label: "Next keyframe", group: "Edit", combo: "mod+arrowright" },
  { id: "edit.easing", label: "Edit easing of selected keyframes", group: "Edit", combo: "e" },
  { id: "marker.add", label: "Add marker at playhead", group: "Edit", combo: "m" },

  { id: "playback.toggle", label: "Play / pause", group: "Playback", combo: "space" },
  { id: "playback.home", label: "Jump to start", group: "Playback", combo: "home" },
  { id: "playback.stepBack", label: "Step one frame back", group: "Playback", combo: "," },
  { id: "playback.stepForward", label: "Step one frame forward", group: "Playback", combo: "." },
  { id: "range.in", label: "Set range in point", group: "Playback", combo: "[" },
  { id: "range.out", label: "Set range out point", group: "Playback", combo: "]" },

  { id: "view.palette", label: "Command palette", group: "View", combo: "mod+k" },
  { id: "view.navigator", label: "Go to anything — frames, worlds, components, layers", group: "View", combo: "mod+p" },
  // Back / Forward through the places you stood (links, ⌘P, pages) — the
  // browser's own binding, so the desktop window answers it the same way.
  { id: "view.back", label: "Back", group: "View", combo: "mod+[" },
  { id: "view.forward", label: "Forward", group: "View", combo: "mod+]" },
  { id: "view.snap", label: "Toggle snapping", group: "View", combo: "s" },
  { id: "view.focusMode", label: "Toggle focus mode (hide panels)", group: "View", combo: "mod+\\" },
  { id: "view.recording", label: "Toggle recording mode", group: "Playback", combo: "r" },
  { id: "view.perform", label: "Perform — play it live", group: "Playback", combo: "shift+p" },

  // The time axis had a pinch, a wheel and a slider, and no keys at all —
  // which is the one input a person editing with two hands on the keyboard
  // actually reaches for.
  { id: "timeline.zoomIn", label: "Zoom in (timeline)", group: "View", combo: "=" },
  { id: "timeline.zoomOut", label: "Zoom out (timeline)", group: "View", combo: "-" },
  { id: "timeline.zoomFit", label: "Fit the whole timeline", group: "View", combo: "\\" },
];

const STORAGE_KEY = "tm-shortcut-overrides";
const KEYMAP_KEY = "tm-keymap";
const WORLD_KEYMAP_KEY = "tm-keymap-3d";

let overrides: Record<string, string> = loadOverrides();
let keymapId: string = loadKeymapId();
let worldKeymapId: string = loadWorldKeymapId();

function loadWorldKeymapId(): string {
  if (typeof window === "undefined") return DEFAULT_WORLD_KEYMAP_ID;
  try {
    return window.localStorage.getItem(WORLD_KEYMAP_KEY) ?? DEFAULT_WORLD_KEYMAP_ID;
  } catch {
    return DEFAULT_WORLD_KEYMAP_ID;
  }
}

const worldDef = (id: string): WorldShortcutDef | undefined => WORLD_SHORTCUT_DEFS.find((d) => d.id === id);
const listeners = new Set<() => void>();

function loadOverrides(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function loadKeymapId(): string {
  if (typeof window === "undefined") return DEFAULT_KEYMAP_ID;
  try {
    return window.localStorage.getItem(KEYMAP_KEY) ?? DEFAULT_KEYMAP_ID;
  } catch {
    return DEFAULT_KEYMAP_ID;
  }
}

function persist(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
    window.localStorage.setItem(KEYMAP_KEY, keymapId);
    window.localStorage.setItem(WORLD_KEYMAP_KEY, worldKeymapId);
  } catch {
    // Private mode — overrides live for the session only.
  }
  for (const l of listeners) l();
}

/**
 * THE KEYMAP LAYER.
 *
 * Switching keymaps changes the BASE, never your own edits — they sit above it
 * (see `comboFor`). That is the whole reason this is a layer rather than a
 * bulk-assignment of overrides: a bulk assign would make every binding look
 * "customised", so "reset this one" would have nothing to reset to, and your
 * three deliberate tweaks would be indistinguishable from the forty the preset
 * brought with it.
 */
export function activeKeymapId(): string {
  return keymapId;
}

export function setKeymap(id: string): void {
  keymapId = keymapById(id).id;
  persist();
  if (process.env.NODE_ENV !== "production") {
    for (const c of shortcutCollisions()) {
      console.warn(`[keymap:${keymapId}] ${c.combo} is bound to ${c.ids.join(" and ")}`);
    }
  }
}

/** The 3D viewport's keymap — its own layer, independent of the app's (`world-shortcuts.ts`). */
export function activeWorldKeymapId(): string {
  return worldKeymapId;
}

export function setWorldKeymap(id: string): void {
  worldKeymapId = worldKeymapById(id).id;
  persist();
  if (process.env.NODE_ENV !== "production") {
    for (const c of shortcutCollisions()) {
      if (c.ids.some(isWorldCommand)) console.warn(`[3d keymap:${worldKeymapId}] ${c.combo} is bound to ${c.ids.join(" and ")}`);
    }
  }
}

/** The binding the active keymap layer gives a command, if it moves it at all. */
function keymapBinding(id: string): string | undefined {
  return isWorldCommand(id) ? worldKeymapById(worldKeymapId).bindings[id as keyof ReturnType<typeof worldKeymapById>["bindings"]] : keymapById(keymapId).bindings[id];
}

/** The command's own default, app or 3D. */
function defaultCombo(id: string): string | undefined {
  return isWorldCommand(id) ? worldDef(id)?.combo : SHORTCUT_DEFS.find((d) => d.id === id)?.combo;
}

/** Has this command been moved by the active keymap (rather than by you)? */
export function isFromKeymap(id: string): boolean {
  return overrides[id] === undefined && keymapBinding(id) !== undefined;
}

export function subscribeShortcuts(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/**
 * The active combo for a command. ONE formula, three layers, nearest wins:
 *
 *     your override  ∘  the active keymap  ∘  the app's own default
 *
 * A keymap only states what it moves, so a command added tomorrow appears in
 * every keymap at its default rather than silently having no binding there.
 */
export function comboFor(id: string): string {
  return overrides[id] ?? keymapBinding(id) ?? defaultCombo(id) ?? "";
}

/** What this command would be WITHOUT your override — what "reset" returns to. */
export function baseComboFor(id: string): string {
  return keymapBinding(id) ?? defaultCombo(id) ?? "";
}

/** Every combo a command answers to — a binding may list alternatives ("x backspace"). */
export function combosOf(id: string): string[] {
  return comboFor(id).split(" ").filter(Boolean);
}

/**
 * The 3D commands a combo fires in a mode, in table order. The viewport tries
 * them in turn; one that has nothing to act on declines, and the next — or
 * the app — gets the key.
 */
export function worldCommandsFor(combo: string, mode: WorldKeyMode): WorldShortcutDef[] {
  return WORLD_SHORTCUT_DEFS.filter((d) => worldKeyModes(d.mode).includes(mode) && combosOf(d.id).includes(combo));
}

export function isOverridden(id: string): boolean {
  return overrides[id] !== undefined;
}

/** Set a custom combo (null resets to the default). */
export function setCombo(id: string, combo: string | null): void {
  if (combo === null) delete overrides[id];
  else overrides[id] = combo;
  persist();
}

export function resetAllShortcuts(): void {
  overrides = {};
  persist();
}

/**
 * Every combo two commands are fighting over, right now.
 *
 * Dispatch is first-match-wins, which is SILENT: a keymap that moves a command
 * onto a combo something else already holds produces a key that appears to do
 * the wrong thing, with nothing anywhere saying why. Exactly one collision is
 * deliberate (`e` is contextual — the easing popover over selected keyframes,
 * the eraser otherwise), so it is listed rather than tolerated, and anything
 * else is a mistake in a keymap table that should be caught the first time a
 * developer opens the app.
 */
const INTENTIONAL_COLLISIONS = new Set(["e"]);

export function shortcutCollisions(): Array<{ combo: string; ids: string[] }> {
  const byCombo = new Map<string, string[]>();
  const note = (key: string, id: string) => {
    const list = byCombo.get(key);
    if (list) list.push(id);
    else byCombo.set(key, [id]);
  };
  for (const def of SHORTCUT_DEFS) {
    const combo = comboFor(def.id);
    if (!combo || INTENTIONAL_COLLISIONS.has(combo)) continue;
    note(combo, def.id);
  }
  // 3D commands collide only within a mode ("any" sits in both).
  for (const def of WORLD_SHORTCUT_DEFS) {
    for (const combo of combosOf(def.id)) {
      for (const mode of modesOf(def.mode)) note(`3d:${mode}:${combo}`, def.id);
    }
  }
  return [...byCombo]
    .filter(([, ids]) => ids.length > 1)
    .map(([combo, ids]) => ({ combo: combo.replace(/^3d:\w+:/, ""), ids }));
}

const modesOf = worldKeyModes;

/** The command currently bound to a combo, if any — among the app's, or among the 3D ones that share a mode with `exceptId`. */
export function commandForCombo(combo: string, exceptId?: string): { id: string; label: string } | null {
  if (exceptId && isWorldCommand(exceptId)) {
    const modes = modesOf(worldDef(exceptId)?.mode ?? "any");
    return WORLD_SHORTCUT_DEFS.find((d) => d.id !== exceptId && modesOf(d.mode).some((m) => modes.includes(m)) && combosOf(d.id).includes(combo)) ?? null;
  }
  for (const def of SHORTCUT_DEFS) {
    if (def.id === exceptId) continue;
    if (comboFor(def.id) === combo) return def;
  }
  return null;
}

/**
 * The US-layout name of a physical key (`KeyboardEvent.code`), for the keys a
 * shortcut can name. Letters, digits and the punctuation row — the keys whose
 * `e.key` changes with the layout. Named keys (Escape, ArrowLeft, F5 …) are
 * the same string in every layout and never need this.
 */
const CODE_KEYS: Record<string, string> = {
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  IntlBackslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Space: " ",
  NumpadDecimal: ".",
  NumpadSubtract: "-",
  NumpadAdd: "+",
  NumpadDivide: "/",
  NumpadMultiply: "*",
};
for (let i = 0; i < 26; i++) {
  const letter = String.fromCharCode(97 + i);
  CODE_KEYS[`Key${letter.toUpperCase()}`] = letter;
}
for (let i = 0; i < 10; i++) {
  CODE_KEYS[`Digit${i}`] = String(i);
  CODE_KEYS[`Numpad${i}`] = String(i);
}

/**
 * Does the layout name this key with something a combo can be written in — a
 * printable ASCII character, or a named key (`escape`, `arrowleft`, `f5`)?
 * `dead`, `process` and `unidentified` are the platform saying it does NOT
 * know: a ⌥-dead-key on a Mac, an IME mid-composition, a keyless soft key.
 */
function isLayoutNamed(key: string): boolean {
  if (key.length === 1) {
    const c = key.charCodeAt(0);
    return c >= 0x20 && c <= 0x7e;
  }
  return key.length > 1 && key !== "dead" && key !== "process" && key !== "unidentified";
}

/**
 * The key an event names, lowercased — `""` when it names none.
 *
 * THE one reader of a key's identity; every shortcut, every hand-rolled
 * `meta && key === "z"`, and the Settings recorder go through it, which is what
 * lets it answer two questions at once:
 *
 * **Which layout wins.** A keyboard layout that names the key with a plain
 * ASCII character is the keycap the user is looking at — AZERTY's A is A,
 * Dvorak's O is O — and is honoured as written. A layout that names it with
 * anything else (Persian, Arabic, Cyrillic, Greek, Hebrew, Thai; a Mac's
 * ⌥-dead-keys "å" / "Dead"; an IME's "Process") gets the US name of the
 * PHYSICAL key from `e.code`, so ⌘Z is ⌘Z whatever the OS is currently typing.
 * This is the rule Chromium and macOS themselves use for accelerators under a
 * non-Latin layout; it is also what makes `mod+alt+m` work on a Mac at all,
 * where ⌥M types "µ". Because the recorder reads the same function, a combo
 * recorded under one layout matches under every other.
 *
 * **Never throwing.** `KeyboardEvent.key` IS NOT GUARANTEED. Soft keyboards,
 * IMEs and dictation on iPadOS dispatch key events carrying no `key` at all,
 * and every bare `e.key.toLowerCase()` in the editor threw on them — a crash
 * reachable only on a tablet, from thirty unrelated places. One reader, so a
 * keyless event is a shortcut that does not match rather than a dead editor.
 * No consumer reads `e.key` raw for a shortcut.
 */
export function eventKey(e: KeyboardEvent | React.KeyboardEvent): string {
  const key = typeof e.key === "string" ? e.key.toLowerCase() : "";
  if (isLayoutNamed(key)) return key;
  const physical = typeof e.code === "string" ? CODE_KEYS[e.code] : undefined;
  return physical ?? key;
}

/** Did this event type ONE printable character (`a`, `7`, `,` — not `Enter`)? */
export function isPrintableKey(e: KeyboardEvent | React.KeyboardEvent): boolean {
  return typeof e.key === "string" && e.key.length === 1;
}

/** Normalize a keyboard event to a combo string (null for bare modifiers). */
export function comboFromEvent(e: KeyboardEvent | React.KeyboardEvent): string | null {
  const raw = e.key;
  if (raw === "Shift" || raw === "Control" || raw === "Meta" || raw === "Alt") return null;
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  let key = eventKey(e);
  if (!key) return null;
  if (key === " ") key = "space";
  if (key === "delete") key = "backspace";
  parts.push(key);
  return parts.join("+");
}

/**
 * A combo from an event in the 3D viewport's terms: the app's, except that the
 * NUMPAD is its own keys ("num1", "num.", "num+" — Blender's views live
 * there, the digit row means something else in edit mode) and the digit row is
 * named by its digit even under ⇧ ("shift+1", not "shift+!").
 */
export function worldComboFromEvent(e: KeyboardEvent): string | null {
  const code = typeof e.code === "string" ? e.code : "";
  const pad = /^Numpad(\d|Decimal|Add|Subtract|Multiply|Divide|Enter)$/.exec(code);
  const digit = /^Digit(\d)$/.exec(code);
  if (!pad && !digit) return comboFromEvent(e);
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  const NUM: Record<string, string> = { Decimal: ".", Add: "+", Subtract: "-", Multiply: "*", Divide: "/", Enter: "enter" };
  parts.push(pad ? `num${NUM[pad[1]!] ?? pad[1]}` : digit![1]!);
  return parts.join("+");
}

const IS_MAC =
  typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform ?? "");

const KEY_GLYPHS: Record<string, string> = {
  space: "Space",
  backspace: "⌫",
  escape: "Esc",
  enter: "↵",
  home: "Home",
  end: "End",
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
  tab: "Tab",
};

/** "mod+shift+g" → "⇧⌘G" (mac) / "Ctrl+Shift+G"; alternatives "x backspace" → "X / ⌫". */
export function formatCombo(combo: string): string {
  if (!combo) return "";
  if (combo.includes(" ")) return combo.split(" ").filter(Boolean).map(formatCombo).join(" / ");
  // Modifiers lead; the rest is the key, which may itself hold a plus ("num+").
  const tokens = combo.split("+");
  let lead = 0;
  while (lead < tokens.length - 1 && (tokens[lead] === "mod" || tokens[lead] === "alt" || tokens[lead] === "shift")) lead++;
  const mods = new Set(tokens.slice(0, lead));
  let key = tokens.slice(lead).join("+");
  const pad = key.startsWith("num") && key.length > 3;
  if (pad) key = key.slice(3);
  const keyLabel = (pad ? "Num " : "") + (KEY_GLYPHS[key] ?? (key.length === 1 ? key.toUpperCase() : key));
  if (IS_MAC) {
    return [
      mods.has("alt") ? "⌥" : "",
      mods.has("shift") ? "⇧" : "",
      mods.has("mod") ? "⌘" : "",
      keyLabel,
    ].join("");
  }
  return [
    mods.has("mod") ? "Ctrl" : "",
    mods.has("alt") ? "Alt" : "",
    mods.has("shift") ? "Shift" : "",
    keyLabel,
  ]
    .filter(Boolean)
    .join("+");
}

/** React hook: the active combo for a command, live across edits. */
export function useCombo(id: string): string {
  const subscribe = React.useCallback((cb: () => void) => subscribeShortcuts(cb), []);
  return React.useSyncExternalStore(
    subscribe,
    () => comboFor(id),
    () => SHORTCUT_DEFS.find((d) => d.id === id)?.combo ?? "",
  );
}

/**
 * React hook: any value read from the registry, live across edits — the active
 * keymap, whether a command is overridden. `read` must return a primitive (or
 * an object the registry keeps), since snapshots are compared by identity.
 */
export function useShortcutValue<T>(read: () => T): T {
  return React.useSyncExternalStore(subscribeShortcuts, read, read);
}
