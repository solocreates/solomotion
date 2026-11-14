import { cursors } from "@solomotion/ui/cursors";
import type { PointerAct } from "../input/pointer-authority";

/**
 * THE VIEWPORT'S MODES AND TOOLS — one table, every reader.
 *
 * Blender's model, because it is the one that scales: a MODE is what you are
 * working ON (objects, a mesh's polygons, a mesh's surface, marks in space),
 * and it decides which tools exist, what the rail shows, which keys mean what
 * and what the options row offers. A TOOL is what the next drag does.
 *
 * Before this, the tool union was one flat list and every reader asked its own
 * question of it: the rail hard-coded which tools showed in which mode, the
 * stage derived a cursor in a ternary, the viewport derived the stroke gesture
 * in a third place, and NOTHING asked which pointer was allowed to drive it —
 * so a finger drew with the brush while a Pencil was on the glass. Now a tool
 * is one row: its modes, its pointer act, its cursor, whether its drag IS a
 * stroke. A new tool is a row; nothing else learns its name.
 *
 *   object   select · cursor · move · rotate · scale · shape · text · bone
 *   edit     select · cursor · move · rotate · scale · knife
 *   sculpt   the sculpt brush (which brush is a setting, as the flat brush's
 *            engine is — one tool, eight materials)
 *   draw     vector brush · pixel brush · eraser · fill — the flat canvas's
 *            own brush family, landing in space
 */

export type WorldMode = "object" | "edit" | "sculpt" | "draw";

export const WORLD_MODES: ReadonlyArray<{ id: WorldMode; label: string }> = [
  { id: "object", label: "Object" },
  { id: "edit", label: "Edit" },
  { id: "sculpt", label: "Sculpt" },
  { id: "draw", label: "Draw" },
];

export type WorldTool =
  | "select"
  | "cursor"
  | "move"
  | "rotate"
  | "scale"
  | "transform"
  | "shape"
  | "text"
  | "bone"
  | "knife"
  | "sculpt"
  | "draw"
  | "paint"
  | "erase"
  | "fill";

/** Tools whose drag IS the input — a stroke the viewport records, never a selection or a camera move. */
export type StrokeTool = Extract<WorldTool, "draw" | "paint" | "erase" | "knife" | "sculpt">;

export interface WorldToolDef {
  modes: readonly WorldMode[];
  /**
   * What a pointer DOING this tool is (`pointer-authority`): the one question
   * the viewport's door asks before a press becomes this tool's. A refused
   * finger is not dead — it orbits the view instead.
   */
  act: PointerAct;
  stroke?: boolean;
  cursor: string;
}

const MODELING: readonly WorldMode[] = ["object", "edit"];

export const WORLD_TOOLS: Record<WorldTool, WorldToolDef> = {
  select: { modes: MODELING, act: "transform", cursor: cursors.arrow },
  cursor: { modes: MODELING, act: "pick", cursor: cursors.crosshair },
  move: { modes: MODELING, act: "transform", cursor: cursors.arrow },
  rotate: { modes: MODELING, act: "transform", cursor: cursors.arrow },
  scale: { modes: MODELING, act: "transform", cursor: cursors.arrow },
  transform: { modes: MODELING, act: "transform", cursor: cursors.arrow },
  shape: { modes: ["object"], act: "shape", cursor: cursors.crosshairAdd },
  text: { modes: ["object"], act: "shape", cursor: cursors.text },
  // Drawing a skeleton is placing joints; posing is a handle (`transform`).
  bone: { modes: ["object"], act: "shape", cursor: cursors.crosshair },
  knife: { modes: ["edit"], act: "shape", stroke: true, cursor: cursors.knife },
  sculpt: { modes: ["sculpt"], act: "paint", stroke: true, cursor: "none" },
  draw: { modes: ["draw"], act: "paint", stroke: true, cursor: cursors.pen },
  paint: { modes: ["draw"], act: "paint", stroke: true, cursor: cursors.brush },
  erase: { modes: ["draw"], act: "paint", stroke: true, cursor: cursors.eraser },
  fill: { modes: ["draw"], act: "pick", cursor: cursors.fill },
};

export function strokeToolOf(tool: WorldTool): StrokeTool | null {
  return WORLD_TOOLS[tool].stroke ? (tool as StrokeTool) : null;
}

/** May `tool` be armed in `mode`? */
export function toolInMode(tool: WorldTool, mode: WorldMode): boolean {
  return WORLD_TOOLS[tool].modes.includes(mode);
}

/** The tool a mode starts with. */
export function defaultToolFor(mode: WorldMode): WorldTool {
  return mode === "sculpt" ? "sculpt" : mode === "draw" ? "draw" : "select";
}

/** The act a press with `tool` performs — what the viewport's door asks `pointerMay`. */
export function worldActFor(tool: WorldTool): PointerAct {
  return WORLD_TOOLS[tool].act;
}
