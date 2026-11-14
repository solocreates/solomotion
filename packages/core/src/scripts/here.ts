import { hereFrame } from "../api/lookup";
import type { MotionDocument } from "../schema";
import { frameDurationMs } from "../timeline/ops";

/**
 * `here` — the comp a script runs in, as plain data the script can read.
 *
 * Captured once, when Run is pressed, and held for the whole run: a click on
 * another comp halfway through a long script must not split its output across
 * two. Every call without a `frameId` lands here; passing one always wins.
 * After Effects (`app.project.activeItem`) and Blender (`bpy.context`) make
 * the same promise — a script acts where you are unless it says otherwise.
 */
export interface ScriptHere {
  frameId: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
}

export function scriptHere(doc: MotionDocument, focusedId: string | null): ScriptHere | null {
  const f = hereFrame(doc, focusedId);
  return f ? { frameId: f.id, name: f.name, width: f.width, height: f.height, fps: f.fps, durationMs: Math.round(frameDurationMs(doc, f)) } : null;
}
