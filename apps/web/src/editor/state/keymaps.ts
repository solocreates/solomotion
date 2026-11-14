import { identity } from "@/editor/identity";
import { NAMES } from "@/editor/names";
/**
 * KEYMAPS — the muscle memory you already have.
 *
 * Nobody learns an editor's shortcuts twice. A cutter arriving from Premiere
 * reaches for A to select forward and C to razor; one from Resolve reaches for
 * B to blade and N to toggle snapping; one from Blender reaches for G, S and X.
 * Making them re-bind forty commands by hand is asking them to pay for our
 * defaults, and almost nobody does — they just find the app slower than the one
 * they left.
 *
 * So a keymap is a LAYER, not a replacement, and the resolution is one formula
 * with the same shape as the panel-visibility one:
 *
 *     comboFor(id) =  personal override
 *                  ∘  the active keymap
 *                  ∘  the app's own default
 *
 * That layering is what makes this safe to ship. A preset only has to state
 * what it CHANGES, so it is a short readable table rather than a fork of the
 * whole registry that drifts the moment a command is added — a new command
 * appears in every keymap at the app's default until someone deliberately
 * gives it a home. And a personal tweak survives switching keymaps, because it
 * sits above them; switching is a decision about the base, not about your
 * edits.
 *
 * WHAT A PRESET IS NOT: a claim of compatibility. These are the bindings those
 * editors are known for, on the commands this app actually has. Where we have
 * no equivalent there is nothing to bind, and where they disagree with
 * themselves across versions the modern default wins. Every one of them stays
 * editable afterwards, which is the real answer to "but mine has X on Y".
 */

export interface Keymap {
  id: string;
  label: string;
  /** What this keymap is, in a line — for docs and search; the picker shows the logo and the name only. */
  origin: string;
  /** The keymap's signature key (Premiere A, Resolve B, Blender G) — the fallback mark where there is no logo (`menus/keymap-logos.ts`). */
  mark: string;
  /** The logo's colour, so the four are distinguishable at a glance. */
  tint: string;
  /** ONLY the commands this keymap moves. Everything else falls through. */
  bindings: Record<string, string>;
}

/**
 * The keymaps. the product's own keymap is deliberately empty: it is not a table of our own
 * defaults (that would be the same list written twice, and the copies would
 * disagree within a release) — it is the absence of a layer.
 */
export const KEYMAPS: Keymap[] = [
  {
    id: NAMES.ids.defaultKeymap,
    label: identity.name,
    origin: "Figma-shaped: one letter per tool, ⌘ for documents.",
    mark: "V",
    tint: "#ff2e88",
    bindings: {},
  },
  {
    id: "premiere",
    label: "Premiere",
    origin: "Adobe's editing set — A to select forward, C to razor, I/O to mark.",
    mark: "A",
    tint: "#9999FF",
    bindings: {
      "tool.select": "v",
      "tool.hand": "h",
      "tool.text": "t",
      "tool.pen": "p",
      "edit.split": "c",
      "edit.selectForward": "a",
      "edit.selectBackward": "shift+a",
      "edit.rippleDelete": "shift+backspace",
      "range.in": "i",
      "range.out": "o",
      // I and O are the mark keys in every editorial app, so the two TOOLS
      // sitting on them move rather than losing a first-match race nobody
      // could see. A keymap that displaces a binding has to say where it went.
      "tool.eyedropper": "alt+i",
      "tool.ellipse": "alt+o",
      "timeline.zoomIn": "=",
      "timeline.zoomOut": "-",
      "timeline.zoomFit": "\\",
      "edit.speed": "mod+r",
      "edit.duplicate": "mod+shift+/",
      "edit.nudgeLeft": "alt+arrowleft",
      "edit.nudgeRight": "alt+arrowright",
      "keyframe.prev": "mod+arrowleft",
      "keyframe.next": "mod+arrowright",
    },
  },
  {
    id: "resolve",
    label: "DaVinci Resolve",
    origin: "Blackmagic's edit page — B to blade, N for snapping, ⌘R to retime.",
    mark: "B",
    tint: "#E5484D",
    bindings: {
      "tool.select": "a",
      "edit.split": "b",
      "view.snap": "n",
      "range.in": "i",
      "range.out": "o",
      "tool.eyedropper": "alt+i",
      "tool.ellipse": "alt+o",
      // B is Resolve's blade, so the brush moves; ⇧R is its freeze, so the
      // paint reference moves. Same rule as I and O above.
      "tool.brush": "alt+b",
      "edit.freezeFrame": "shift+r",
      "paint.reference": "alt+r",
      "edit.speed": "mod+r",
      // ⌘= / ⌘− are the shared zoom keys (workspace/zoom-shortcuts): they
      // zoom the timeline whenever the timeline is the focused region.
      "timeline.zoomFit": "shift+z",
      "edit.rippleDelete": "shift+backspace",
      "edit.selectForward": "shift+y",
      "keyframe.prev": "[",
      "keyframe.next": "]",
    },
  },
  {
    id: "blender",
    label: "Blender",
    origin: "Verbs before objects — G to move, K to cut, X to delete.",
    mark: "G",
    tint: "#FF8732",
    bindings: {
      "edit.split": "k",
      "edit.delete": "x",
      "edit.duplicate": "shift+d",
      "edit.selectAll": "a",
      // A is select-all in Blender, so track-select moves off it.
      "edit.selectForward": "alt+a",
      "edit.selectBackward": "alt+shift+a",
      "tool.select": "w",
      "tool.hand": "shift+space",
      "view.snap": "shift+tab",
      "timeline.zoomFit": "home",
      "playback.home": "shift+arrowleft",
      "keyframe.prev": "arrowdown",
      "keyframe.next": "arrowup",
      "edit.nudgeLeft": "alt+arrowleft",
      "edit.nudgeRight": "alt+arrowright",
    },
  },
];

export const DEFAULT_KEYMAP_ID = NAMES.ids.defaultKeymap;

export function keymapById(id: string): Keymap {
  return KEYMAPS.find((k) => k.id === id) ?? KEYMAPS[0]!;
}
