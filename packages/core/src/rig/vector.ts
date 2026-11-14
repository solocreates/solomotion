import type { KeyframeValue, PathClip, ShapeClip, Subpath } from "../schema";
import { pathCommands, pathGeometryAt } from "../vector/geometry";
import { flattenCommands } from "../vector/polyline";
import { resolveShapeGeometry } from "../animation/paths";
import { shapeAsPath } from "../timeline/ops";
import { keepPivotThroughBoxChange, pathBox } from "../pivot";
import type { Mat4 } from "../world/math";
import { skinPoints2d, type Field2d } from "./bind";

/**
 * A BENDING VECTOR, DRAWN AS ITSELF — the layer with its outline flattened
 * finely and every point skinned, so its fills, strokes (at their own width),
 * trims, dashes and effects are all still its own. Not its control points:
 * a rectangle has four, and a four-point arm cannot bend at the elbow. A shape
 * goes through the path it draws (`shapeAsPath`).
 *
 * The pivot holds its local point through the new box (`keepPivotThroughBoxChange`),
 * so the bent outline is placed by the same transform as the straight one.
 *
 * `tolerance` is how far a flattened chord may stray from the curve, in the
 * layer's own px: the renderer passes about a third of a device pixel.
 */
export function warpedVectorClip(clip: PathClip | ShapeClip, sampled: Record<string, KeyframeValue>, field: Field2d, skins: readonly Mat4[], tolerance: number): PathClip {
  const path = clip.kind === "shape" ? shapeAsPath(clip, resolveShapeGeometry(clip, sampled)) : clip;
  const subs = clip.kind === "shape" ? path.subpaths : pathGeometryAt(path, sampled);
  const warped: Subpath[] = [];
  for (const sub of subs) {
    const line = flattenCommands(pathCommands([sub]), Math.max(0.05, tolerance))[0];
    if (!line) continue;
    // Every segment cut to the weight grid's spacing: straight sides need
    // points to bend at, and the bend cannot change faster than the weights do.
    const step = field.grid.cell;
    const flat: number[] = [];
    const n = line.pts.length;
    for (let i = 0; i < n; i++) {
      const a = line.pts[i]!;
      // A closed outline repeats its first point last; the contour closes itself.
      if (line.closed && i === n - 1) break;
      flat.push(a.x, a.y);
      const b = line.pts[i + 1];
      if (!b) break;
      const cuts = Math.min(512, Math.floor(Math.hypot(b.x - a.x, b.y - a.y) / step));
      for (let k = 1; k <= cuts; k++) {
        const t = k / (cuts + 1);
        flat.push(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
      }
    }
    const bent = skinPoints2d(field, skins, flat);
    const points = [];
    for (let i = 0; i + 1 < bent.length; i += 2) points.push({ x: bent[i]!, y: bent[i + 1]!, hIn: null, hOut: null });
    warped.push({ ...sub, closed: line.closed, points });
  }
  // `subs` already carries the shape-key mix (`pathGeometryAt`): keys morph
  // BEFORE the bones bend. The bent clip drops its keys, or drawing it would
  // mix them a second time onto points they do not describe.
  const { shapeKeys: _mixed, ...rest } = path;
  const out: PathClip = {
    ...rest,
    transform: { ...path.transform },
    subpaths: warped,
    // The bent outline IS the geometry now; a morph key would draw over it.
    keyframes: path.keyframes.filter((t) => t.property !== "geometry").map((t) => (t.property === "anchor.x" || t.property === "anchor.y" ? { ...t, keys: t.keys.map((k) => ({ ...k })) } : t)),
  };
  // The straight clip poses about its DECLARED box (`clipBox`), never a morphed
  // one — so that is the box the pivot is carried from.
  keepPivotThroughBoxChange(out, pathBox(clip.kind === "shape" ? subs : path.subpaths), pathBox(warped));
  return out;
}
