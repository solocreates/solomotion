import type { MeshData, PathClip, StrokeStyle } from "../schema";
import { profileAt } from "../vector/stroke";
import { curveFrames } from "./curve-deform";
import type { V3 } from "./math";

/**
 * A STROKE IN SPACE, AS A TUBE — a path whose points have depth (drawn round
 * an object, a 3D ribbon) is a real surface: a tube along its curve whose
 * radius is the stroke's width through its PROFILE — the pen's measured
 * pressure, or the taper numbers — so what the brush drew is what stands in
 * the world, lit, shadowed, and modifiable like any other body. Width is in
 * world units (the Draw tool sizes strokes so they read the width you drew).
 *
 * The rings ride rotation-minimising frames (no twist at inflections), with
 * a closing cap at each open end so the tube is a closed solid.
 */
export function strokeTube(points: readonly V3[], stroke: StrokeStyle, opts: { sides?: number; closed?: boolean } = {}): MeshData | null {
  if (points.length < 2) return null;
  const sides = Math.max(3, Math.min(24, opts.sides ?? 8));
  // The drawing plane faces −Y (the picture's front); frames start upright in it.
  const frames = curveFrames(points, [0, -1, 0]);
  if (!frames) return null;
  const total = frames[frames.length - 1]!.s || 1;
  const half = Math.max(0.01, stroke.width / 2);
  const positions: number[] = [];
  const faces: number[][] = [];
  const uv: number[] = [];
  for (const f of frames) {
    const r = half * profileAt(stroke.profile, f.s / total);
    const side: V3 = [f.n[1] * f.t[2] - f.n[2] * f.t[1], f.n[2] * f.t[0] - f.n[0] * f.t[2], f.n[0] * f.t[1] - f.n[1] * f.t[0]];
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      const c = Math.cos(a) * r, s = Math.sin(a) * r;
      positions.push(f.p[0] + f.n[0] * c + side[0] * s, f.p[1] + f.n[1] * c + side[1] * s, f.p[2] + f.n[2] * c + side[2] * s);
      uv.push(f.s, (k / sides) * Math.PI * 2 * half);
    }
  }
  const rings = frames.length;
  // Each ring turns about −t as k grows, so the outward winding runs k → next ring → k+1.
  for (let i = 0; i + 1 < rings; i++) {
    for (let k = 0; k < sides; k++) {
      const k1 = (k + 1) % sides;
      faces.push([i * sides + k, (i + 1) * sides + k, (i + 1) * sides + k1, i * sides + k1]);
    }
  }
  if (opts.closed) {
    const last = rings - 1;
    for (let k = 0; k < sides; k++) {
      const k1 = (k + 1) % sides;
      faces.push([last * sides + k, k, k1, last * sides + k1]);
    }
  } else {
    // Caps: the start faces back along the curve, the end forward.
    faces.push(Array.from({ length: sides }, (_, k) => k));
    faces.push(Array.from({ length: sides }, (_, k) => (rings - 1) * sides + (sides - 1 - k)));
  }
  return { positions, faces, uv };
}

/** The stroke a path's tube wears: its first visible one. */
export function tubeStroke(clip: PathClip): StrokeStyle | null {
  return clip.strokes.find((s) => s.enabled !== false && s.width > 0) ?? null;
}
