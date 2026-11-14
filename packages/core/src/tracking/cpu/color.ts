import type { ColorTarget, TrackRegion, TrackSolve } from "../../schema/tracking";
import type { AnalysisFrame } from "../engine";
import { regionBounds } from "../contour";
import type { RegionPose } from "../pose";
import type { Hit } from "./match";

/**
 * COLOUR MATCHING — follow the weighted centroid and spread of pixels that match
 * one or more target colours.
 *
 * It is a METHOD, not a mode. Before v77 a "colour track" was a different kind
 * of tracker with its own config arm, its own handle and its own code path, so
 * keying a colour inside a hand-drawn pen outline was not expressible. Now the
 * region says what area to look in and this says how to find the subject inside
 * it — and the two compose freely.
 *
 * Correlation beats this on texture and loses to it on a flat, saturated,
 * deforming subject: a ball, a jersey, a highlighter, anything that leaves frame
 * and comes back. Having both is why the tracker stops feeling like a lottery.
 */

/** Per-channel distance with the luma component discounted — a colour match
 *  should survive a shadow falling across the subject. */
function chromaDistance(r: number, g: number, b: number, t: { r: number; g: number; b: number }): number {
  const dr = r - t.r;
  const dg = g - t.g;
  const db = b - t.b;
  const dl = 0.299 * dr + 0.587 * dg + 0.114 * db;
  // Remove the shared luma shift, keep what is left — the chroma difference.
  const cr = dr - dl;
  const cg = dg - dl;
  const cb = db - dl;
  return Math.sqrt(cr * cr + cg * cg + cb * cb) * 0.55 + Math.abs(dl) * 0.12;
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = Number.parseInt(full.slice(0, 6), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** How strongly a pixel matches any target (0..1), taking the best one. */
function matchWeight(r: number, g: number, b: number, targets: Array<ColorTarget & { rgb: { r: number; g: number; b: number } }>): number {
  let best = 0;
  for (const t of targets) {
    const d = chromaDistance(r, g, b, t.rgb);
    const tol = t.tolerance * 2.55;
    const soft = t.softness * 2.55;
    let w: number;
    if (d <= tol) w = 1;
    else if (soft <= 0 || d >= tol + soft) w = 0;
    else {
      const u = (d - tol) / soft;
      w = 1 - u * u * (3 - 2 * u);
    }
    if (w > best) best = w;
  }
  return best;
}

/**
 * Solve a pose from colour. Searches a window around the prior — twice the
 * region's own size — rather than the whole frame, so a second object of the
 * same colour elsewhere in shot cannot steal the track.
 *
 * `scale` comes from the matched spread rather than from a template sweep: the
 * standard deviation of the matched pixels IS the subject's size, and it is
 * free once the centroid has been summed.
 */
export function colorPose(frame: AnalysisFrame, region: TrackRegion, solve: TrackSolve, prior: RegionPose): Hit {
  const targets = solve.colors.map((c) => ({ ...c, rgb: parseHex(c.color) }));
  const data = frame.rgba;
  if (targets.length === 0 || !data) return { ...prior, score: 0 };

  const b = regionBounds(region);
  const halfW = Math.max(8, (b.width * prior.scale) / 2) * 2;
  const halfH = Math.max(8, (b.height * (prior.scaleY ?? prior.scale)) / 2) * 2;
  const x0 = Math.max(0, Math.round(prior.x - halfW));
  const x1 = Math.min(frame.width - 1, Math.round(prior.x + halfW));
  const y0 = Math.max(0, Math.round(prior.y - halfH));
  const y1 = Math.min(frame.height - 1, Math.round(prior.y + halfH));

  let sum = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  // Stride by 2 on both axes: a centroid is a statistic, and a quarter of the
  // pixels gives the same answer four times faster.
  for (let y = y0; y <= y1; y += 2) {
    for (let x = x0; x <= x1; x += 2) {
      const i = (y * frame.width + x) * 4;
      if (data[i + 3]! < 8) continue;
      const w = matchWeight(data[i]!, data[i + 1]!, data[i + 2]!, targets);
      if (w <= 0) continue;
      sum += w;
      sx += x * w;
      sy += y * w;
      sxx += x * x * w;
      syy += y * y * w;
    }
  }

  // Nothing matched — hold the prior and report no confidence, so the health
  // bar shows the gap instead of the track silently teleporting to (0,0).
  if (sum < 4) return { ...prior, score: 0 };

  const cx = sx / sum;
  const cy = sy / sum;
  const devX = Math.sqrt(Math.max(0, sxx / sum - cx * cx));
  const devY = Math.sqrt(Math.max(0, syy / sum - cy * cy));
  const spread = Math.max(2, (devX + devY) / 2) * 2.4;
  const scale = solve.channels.includes("scale") ? spread / Math.max(2, (b.width + b.height) / 4) : prior.scale;

  return {
    ...prior,
    x: cx,
    y: cy,
    scale,
    // Confidence is coverage: how much of the expected area actually matched.
    score: Math.min(1, sum / Math.max(1, (b.width * b.height * prior.scale * prior.scale) / 8)),
  };
}
