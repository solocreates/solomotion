import type { Clip, PathClip, ShapeClip } from "../schema/clips";
import type { KeyframeValue } from "../schema/animation";
import { resolveStrokeAt } from "./stroke";

/**
 * HOLLOW LAYERS — a shape or path drawn by its strokes alone.
 *
 * With no fill, the inside of the outline is not the layer's: you see straight
 * through it to whatever is beneath, so a press there should land on THAT.
 * Only the line itself — the band the strokes actually paint — is the layer's
 * to claim. The interior stays reachable as a last resort, so a lone hollow
 * rectangle over empty canvas is still one click away.
 *
 * Two headless facts feed the stage's hit test: whether a layer is hollow,
 * and how far from its outline its strokes reach.
 */
export function isHollowVector(clip: Clip): clip is ShapeClip | PathClip {
  if (clip.kind !== "shape" && clip.kind !== "path") return false;
  return !clip.fills.some((f) => f.enabled && f.opacity > 0);
}

/**
 * How far from the outline a hollow layer's strokes reach, clip-local px — the
 * widest visible stroke's full extent to either side of the line, plus its
 * offset. Conservative on purpose: an inside- or outside-aligned stroke is
 * counted at its whole width on both sides, so a press that lands near the
 * line picks the line. A layer with no visible stroke at all reaches nothing
 * and is reachable only by the hit slop.
 */
export function hollowStrokeReach(clip: ShapeClip | PathClip, sampled: Record<string, KeyframeValue>): number {
  let reach = 0;
  for (const s of clip.strokes) {
    if (!s.enabled || s.opacity <= 0) continue;
    const r = resolveStrokeAt(s, { sampled });
    const w = Math.max(0, r.width);
    reach = Math.max(reach, (r.align === "center" ? w / 2 : w) + Math.abs(r.offset));
  }
  return reach;
}
