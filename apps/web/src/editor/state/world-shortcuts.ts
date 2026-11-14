import { identity } from "@/editor/identity";
import { NAMES } from "@/editor/names";
/**
 * THE 3D VIEWPORT'S COMMANDS — the viewport's half of the one shortcut
 * registry (`shortcut-registry.ts`). Same layering as the app's keys, with a
 * keymap layer of its own, because the two questions are independent: an
 * editor from Premiere can still want Blender in 3D, and a Blender artist can
 * want the app's keys on the timeline.
 *
 *     comboFor(id) = your override ∘ the active 3D keymap ∘ the default here
 *
 * The defaults ARE Blender's (the 3D convention people actually have in their
 * hands), with one deliberate difference: ⌘A selects all, as it does in every
 * other app on the machine — Apply, Blender's Ctrl+A, is ⌘⇧A here (on a Mac
 * ⌘ and ⌃ are one "mod", so Blender's two could not both be honoured).
 *
 * A combo may list alternatives separated by a space ("x backspace"). Keys go
 * to the viewport only while the pointer is over it; a command that has nothing
 * to act on (R with nothing selected) is not taken, so the app's own key for it
 * still works — R records, S snaps.
 *
 * `mode` is Blender's keymap section: a combo may mean one thing in Object mode
 * and another in Edit mode (I inserts a key / insets faces), and in Sculpt
 * mode the letters are brushes (G grabs the SURFACE there, never the object).
 * A command lists every mode it answers in; "any" is all of them. Collisions
 * are only collisions within a mode.
 */

export type WorldKeyMode = "object" | "edit" | "sculpt" | "draw";
export type WorldShortcutGroup = "3D · Transform" | "3D · Select" | "3D · Object" | "3D · Edit mode" | "3D · Sculpt" | "3D · Draw" | "3D · Tools" | "3D · View";

export interface WorldShortcutDef {
  id: string;
  label: string;
  group: WorldShortcutGroup;
  mode: "any" | WorldKeyMode | readonly WorldKeyMode[];
  combo: string;
}

/** Object and Edit: where transforms, selection and the object verbs mean something. */
const MODEL = ["object", "edit"] as const;
/** Every mode the command answers in. */
export function worldKeyModes(m: WorldShortcutDef["mode"]): readonly WorldKeyMode[] {
  return m === "any" ? ["object", "edit", "sculpt", "draw"] : typeof m === "string" ? [m] : m;
}

export const WORLD_SHORTCUT_DEFS = [
  // Transform — the verbs before the objects.
  { id: "world.grab", label: "Move (grab)", group: "3D · Transform", mode: MODEL, combo: "g" },
  { id: "world.rotate", label: "Rotate", group: "3D · Transform", mode: MODEL, combo: "r" },
  { id: "world.scale", label: "Scale", group: "3D · Transform", mode: MODEL, combo: "s" },
  { id: "world.clearLocation", label: "Clear location", group: "3D · Transform", mode: "object", combo: "alt+g" },
  { id: "world.clearRotation", label: "Clear rotation", group: "3D · Transform", mode: "object", combo: "alt+r" },
  { id: "world.clearScale", label: "Clear scale", group: "3D · Transform", mode: "object", combo: "alt+s" },
  { id: "world.applyMenu", label: "Apply menu (transforms, modifiers)", group: "3D · Transform", mode: "object", combo: "mod+shift+a" },
  { id: "world.snapMenu", label: "Snap menu", group: "3D · Transform", mode: MODEL, combo: "shift+s" },
  { id: "world.proportional", label: "Proportional editing", group: "3D · Transform", mode: MODEL, combo: "o" },

  // Select
  { id: "world.selectAll", label: "Select all", group: "3D · Select", mode: MODEL, combo: "a mod+a" },
  { id: "world.deselect", label: "Deselect all", group: "3D · Select", mode: MODEL, combo: "alt+a" },
  { id: "world.invert", label: "Invert selection", group: "3D · Select", mode: MODEL, combo: "mod+i" },
  { id: "world.selectLinked", label: "Select linked under the pointer", group: "3D · Select", mode: "edit", combo: "l" },
  { id: "world.selectLinkedAll", label: "Select linked", group: "3D · Select", mode: "edit", combo: "mod+l" },
  { id: "world.grow", label: "Grow selection", group: "3D · Select", mode: "edit", combo: "mod+= mod+num+" },

  // Object
  { id: "world.toggleEdit", label: "Edit mode — in / out", group: "3D · Object", mode: "any", combo: "tab" },
  { id: "world.add", label: "Add menu", group: "3D · Object", mode: MODEL, combo: "shift+a shift+space" },
  { id: "world.delete", label: "Delete", group: "3D · Object", mode: MODEL, combo: "x backspace" },
  { id: "world.duplicate", label: "Duplicate", group: "3D · Object", mode: MODEL, combo: "shift+d" },
  { id: "world.join", label: "Join meshes", group: "3D · Object", mode: "object", combo: "mod+j" },
  { id: "world.convert", label: "Convert to path (text, shapes)", group: "3D · Object", mode: "object", combo: "mod+e" },
  { id: "world.convertMesh", label: "Convert to mesh (any layer; its picture stays live)", group: "3D · Object", mode: "object", combo: "mod+shift+e" },
  { id: "world.addLattice", label: "Add lattice (a cage that bends what it holds)", group: "3D · Object", mode: "object", combo: "" },
  { id: "world.hide", label: "Hide in the viewport", group: "3D · Object", mode: "object", combo: "h" },
  { id: "world.hideOthers", label: "Hide the others", group: "3D · Object", mode: "object", combo: "shift+h" },
  { id: "world.reveal", label: "Reveal hidden", group: "3D · Object", mode: "object", combo: "alt+h" },
  { id: "world.insertKey", label: "Insert keyframe", group: "3D · Object", mode: "object", combo: "i" },

  // Edit mode — polygons and points.
  { id: "world.extrude", label: "Extrude", group: "3D · Edit mode", mode: "edit", combo: "e" },
  { id: "world.inset", label: "Inset faces", group: "3D · Edit mode", mode: "edit", combo: "i" },
  { id: "world.loopCut", label: "Loop cut", group: "3D · Edit mode", mode: "edit", combo: "mod+r" },
  { id: "world.fill", label: "Fill / close the path", group: "3D · Edit mode", mode: "edit", combo: "f" },
  { id: "world.bridge", label: "Bridge edge loops (two loops, or two face groups)", group: "3D · Edit mode", mode: "edit", combo: "" },
  { id: "world.spin", label: "Spin around the view, through the 3D cursor", group: "3D · Edit mode", mode: "edit", combo: "" },
  { id: "world.toggleClosed", label: "Open / close the path", group: "3D · Edit mode", mode: "edit", combo: "alt+c" },
  { id: "world.pointType", label: "Point type (smooth / corner)", group: "3D · Edit mode", mode: "edit", combo: "v" },
  { id: "world.merge", label: "Merge", group: "3D · Edit mode", mode: "edit", combo: "m" },
  { id: "world.mirror", label: "Mirror", group: "3D · Edit mode", mode: "edit", combo: "mod+m" },
  { id: "world.separate", label: "Separate", group: "3D · Edit mode", mode: "edit", combo: "p" },
  { id: "world.recalcNormals", label: "Recalculate normals", group: "3D · Edit mode", mode: "edit", combo: "shift+n" },
  { id: "world.flipNormals", label: "Flip normals", group: "3D · Edit mode", mode: "edit", combo: "alt+n" },
  { id: "world.vertexMode", label: "Points", group: "3D · Edit mode", mode: "edit", combo: "1" },
  { id: "world.edgeMode", label: "Edges", group: "3D · Edit mode", mode: "edit", combo: "2" },
  { id: "world.faceMode", label: "Faces", group: "3D · Edit mode", mode: "edit", combo: "3" },

  // Tools
  { id: "world.toolSelect", label: "Select tool", group: "3D · Tools", mode: "object", combo: "v" },
  { id: "world.cycleTool", label: "Next transform tool", group: "3D · Tools", mode: MODEL, combo: "w" },
  { id: "world.toolDraw", label: "Draw — the vector brush", group: "3D · Draw", mode: ["object", "draw"], combo: "d" },
  { id: "world.toolPaint", label: "Paint — the pixel brush on surfaces and drawing layers", group: "3D · Draw", mode: ["object", "draw"], combo: "p" },
  { id: "world.toolErase", label: "Erase strokes", group: "3D · Draw", mode: "draw", combo: "e" },
  { id: "world.toolFill", label: "Fill — a closed drawing, or an object's colour", group: "3D · Draw", mode: "draw", combo: "f" },
  { id: "world.toolText", label: "Text tool", group: "3D · Tools", mode: "object", combo: "t" },
  { id: "world.toolKnife", label: "Knife", group: "3D · Tools", mode: "edit", combo: "k" },
  { id: "world.modeSculpt", label: "Sculpt mode", group: "3D · Tools", mode: ["object", "edit", "draw"], combo: "" },
  { id: "world.escape", label: "Step out (tool, then edit mode)", group: "3D · Tools", mode: "any", combo: "escape" },

  // Sculpt — the brushes are letters, as Blender's are.
  { id: "world.sculptDraw", label: "Draw brush", group: "3D · Sculpt", mode: "sculpt", combo: "x" },
  { id: "world.sculptClay", label: "Clay brush", group: "3D · Sculpt", mode: "sculpt", combo: "c" },
  { id: "world.sculptInflate", label: "Inflate brush", group: "3D · Sculpt", mode: "sculpt", combo: "i" },
  { id: "world.sculptCrease", label: "Crease brush", group: "3D · Sculpt", mode: "sculpt", combo: "shift+c" },
  { id: "world.sculptSmooth", label: "Smooth brush (⇧ with any brush)", group: "3D · Sculpt", mode: "sculpt", combo: "s" },
  { id: "world.sculptFlatten", label: "Flatten brush", group: "3D · Sculpt", mode: "sculpt", combo: "shift+t" },
  { id: "world.sculptPinch", label: "Pinch brush", group: "3D · Sculpt", mode: "sculpt", combo: "p" },
  { id: "world.sculptGrab", label: "Grab brush", group: "3D · Sculpt", mode: "sculpt", combo: "g" },
  { id: "world.sculptInvert", label: "Add / subtract", group: "3D · Sculpt", mode: "sculpt", combo: "" },
  { id: "world.brushSmaller", label: "Smaller brush", group: "3D · Sculpt", mode: "sculpt", combo: "[" },
  { id: "world.brushBigger", label: "Bigger brush", group: "3D · Sculpt", mode: "sculpt", combo: "]" },
  { id: "world.sculptDetail", label: "Subdivide for detail", group: "3D · Sculpt", mode: "sculpt", combo: "mod+d" },

  // View
  { id: "world.shadingMenu", label: "Shading menu", group: "3D · View", mode: "any", combo: "z" },
  { id: "world.xray", label: "X-ray", group: "3D · View", mode: "any", combo: "alt+z" },
  { id: "world.viewMenu", label: "View menu", group: "3D · View", mode: "any", combo: "`" },
  { id: "world.viewFront", label: "Front view", group: "3D · View", mode: "any", combo: "num1" },
  { id: "world.viewBack", label: "Back view", group: "3D · View", mode: "any", combo: "mod+num1" },
  { id: "world.viewRight", label: "Right view", group: "3D · View", mode: "any", combo: "num3" },
  { id: "world.viewLeft", label: "Left view", group: "3D · View", mode: "any", combo: "mod+num3" },
  { id: "world.viewTop", label: "Top view", group: "3D · View", mode: "any", combo: "num7" },
  { id: "world.viewBottom", label: "Bottom view", group: "3D · View", mode: "any", combo: "mod+num7" },
  // A laptop has no numpad: the digit row stands in while nothing else wants it.
  { id: "world.viewFrontAlt", label: "Front view (digit row)", group: "3D · View", mode: "object", combo: "1" },
  { id: "world.viewRightAlt", label: "Right view (digit row)", group: "3D · View", mode: "object", combo: "3" },
  { id: "world.viewTopAlt", label: "Top view (digit row)", group: "3D · View", mode: "object", combo: "7" },
  { id: "world.viewOpposite", label: "Opposite view", group: "3D · View", mode: "any", combo: "num9" },
  { id: "world.perspective", label: "Perspective / orthographic", group: "3D · View", mode: "any", combo: "num5" },
  { id: "world.cameraView", label: "Look through the camera", group: "3D · View", mode: "any", combo: "num0 0" },
  { id: "world.cameraToView", label: "Camera to this view", group: "3D · View", mode: "any", combo: "mod+alt+num0 mod+alt+0" },
  { id: "world.frameSelected", label: "Frame selected", group: "3D · View", mode: "any", combo: "num. ." },
  { id: "world.frameAll", label: "Frame all", group: "3D · View", mode: "any", combo: "home" },
  { id: "world.resetCursor", label: "Reset the 3D cursor and frame all", group: "3D · View", mode: ["object", "edit", "draw"], combo: "shift+c" },
  { id: "world.orbitLeft", label: "Orbit left", group: "3D · View", mode: "any", combo: "num4" },
  { id: "world.orbitRight", label: "Orbit right", group: "3D · View", mode: "any", combo: "num6" },
  { id: "world.orbitUp", label: "Orbit up", group: "3D · View", mode: "any", combo: "num8" },
  { id: "world.orbitDown", label: "Orbit down", group: "3D · View", mode: "any", combo: "num2" },
  { id: "world.zoomIn", label: "Zoom in", group: "3D · View", mode: "any", combo: "num+" },
  { id: "world.zoomOut", label: "Zoom out", group: "3D · View", mode: "any", combo: "num-" },
] as const satisfies readonly WorldShortcutDef[];

export type WorldCommandId = (typeof WORLD_SHORTCUT_DEFS)[number]["id"];

export interface WorldKeymap {
  id: string;
  label: string;
  origin: string;
  mark: string;
  tint: string;
  /** Only what this keymap moves. */
  bindings: Partial<Record<WorldCommandId, string>>;
}

/**
 * The 3D keymaps. Blender is the absence of a layer (the defaults are its
 * keys). The app moves exactly what the app's own keys mean everywhere else:
 * R records and S snaps (so rotate and scale take ⇧), ⌘D duplicates, ⌫
 * deletes, B draws, ⇧1 / ⇧2 frame all / the selection as on the canvas.
 */
export const WORLD_KEYMAPS: WorldKeymap[] = [
  {
    id: "blender",
    label: "Blender",
    origin: "Blender's own: G R S, A to select, X to delete, Tab to edit.",
    mark: "G",
    tint: "#FF8732",
    bindings: {},
  },
  {
    id: NAMES.ids.worldShortcuts,
    label: identity.name,
    origin: "The app's keys, in 3D: R records, S snaps, ⌘D duplicates, ⇧1 frames all.",
    mark: "V",
    tint: "#ff2e88",
    bindings: {
      "world.rotate": "shift+r",
      "world.scale": "shift+s",
      "world.snapMenu": "alt+shift+s",
      "world.selectAll": "mod+a",
      "world.delete": "backspace",
      "world.duplicate": "mod+d",
      "world.hide": "mod+shift+h",
      "world.hideOthers": "",
      "world.reveal": "mod+alt+h",
      "world.toolDraw": "b",
      "world.toolPaint": "shift+b",
      "world.toolErase": "shift+e",
      "world.cycleTool": "",
      "world.frameAll": "shift+1",
      "world.frameSelected": "shift+2",
      "world.viewFrontAlt": "",
      "world.viewRightAlt": "",
      "world.viewTopAlt": "",
      "world.toggleEdit": "tab enter",
    },
  },
];

export const DEFAULT_WORLD_KEYMAP_ID = "blender";

export function worldKeymapById(id: string): WorldKeymap {
  return WORLD_KEYMAPS.find((k) => k.id === id) ?? WORLD_KEYMAPS[0]!;
}

export function isWorldCommand(id: string): boolean {
  return id.startsWith("world.");
}
