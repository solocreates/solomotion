import type { Clip, ExtrudeSpec } from "../schema";
import { resolveShapeGeometry } from "../animation/paths";
import { sampleKeyframes } from "../animation/keyframes";
import { pathCommands, shapeCommands, type PathCommand } from "../vector/geometry";
import { bodyThickness } from "./body";

/**
 * SOLID DEPTH — which layers stand in a world as extruded objects, and the
 * outline they extrude, headlessly where it can be (a shape's and a path's
 * outline are geometry core owns). A text's outline needs its font, so the
 * renderer supplies that one; everything else about extrusion is here.
 */

/** The thickness a layer has at this instant, or null for a flat picture plane. (See `body.ts`.) */
export function extrudeOf(clip: Clip): ExtrudeSpec | null {
  return bodyThickness(clip);
}

/**
 * A shape's or a path's outline in its own centred local space (the space
 * its pivot is a fraction of), at a local instant. Null for a text (the
 * renderer outlines its glyphs) and for anything without a closed outline.
 */
export function extrudeOutline(clip: Clip, localMs: number): PathCommand[] | null {
  if (clip.kind === "shape") {
    return shapeCommands(resolveShapeGeometry(clip, sampleKeyframes(clip.keyframes, localMs)));
  }
  if (clip.kind === "path") {
    const closed = clip.subpaths.filter((s) => s.closed && s.points.length >= 3);
    return closed.length ? pathCommands(closed) : null;
  }
  return null;
}

/**
 * A layer's LINE: what its strokes follow — every contour of a path, open ones
 * included (an extrusion wants only closed ones), a shape's outline. What an
 * edge collider walls along.
 */
export function lineOutline(clip: Clip, localMs: number): PathCommand[] | null {
  if (clip.kind !== "path") return extrudeOutline(clip, localMs);
  const lines = clip.subpaths.filter((s) => s.points.length >= 2);
  return lines.length ? pathCommands(lines) : null;
}
