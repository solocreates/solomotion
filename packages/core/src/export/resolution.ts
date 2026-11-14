/**
 * Headless export-sizing brain — the single source of truth for named ("famous")
 * output resolutions and the free-tier quality gate.
 *
 * Everything here is pure and UI-agnostic. Given a source pixel size it produces
 * the standard resolution presets that make sense for that aspect ratio, and it
 * decides whether an output size is within the free tier. The editor's export
 * panel renders these presets and the licensing gate reuses `isWithinFreeTier`,
 * so the "720p is free, above is Pro" rule lives in exactly one place.
 */

/** Longest-edge ceiling (px) for a free, non-Pro raster export — 720p-class. */
export const FREE_MAX_LONGEST_EDGE = 1280;

/** The larger of the two dimensions — how "720p vs 1080p" is actually judged. */
export function longestEdge(width: number, height: number): number {
  return Math.max(width, height);
}

/**
 * A raster output is free when its longest edge is within the 720p-class cap.
 * The +1 absorbs sub-pixel rounding on non-16:9 aspect ratios so an exact 720p
 * preset never trips the gate by a single pixel.
 */
export function isWithinFreeTier(width: number, height: number): boolean {
  return longestEdge(width, height) <= FREE_MAX_LONGEST_EDGE + 1;
}

/**
 * The largest scale factor a free user may apply to a given source before the
 * output crosses the cap. Never upscales past native for the default (callers
 * clamp with `Math.min(1, …)`); can exceed 1 for sources smaller than the cap.
 */
export function maxFreeScale(srcW: number, srcH: number): number {
  const longest = longestEdge(srcW, srcH);
  return longest > 0 ? FREE_MAX_LONGEST_EDGE / longest : 1;
}

/**
 * The famous resolution tiers, keyed by the SHORTER edge — the universal
 * convention ("1080p" means 1080 on the short side, whether 1920×1080 landscape
 * or 1080×1920 portrait). Ordered ascending.
 */
export interface ResolutionTier {
  id: string;
  /** Short pill label, e.g. "1080p". */
  label: string;
  /** Long name for menus, e.g. "Full HD". */
  name: string;
  /** Target size of the SHORTER edge, in px. */
  shortEdge: number;
}

export const RESOLUTION_TIERS: readonly ResolutionTier[] = [
  { id: "360p", label: "360p", name: "Low", shortEdge: 360 },
  { id: "480p", label: "480p", name: "SD", shortEdge: 480 },
  { id: "720p", label: "720p", name: "HD", shortEdge: 720 },
  { id: "1080p", label: "1080p", name: "Full HD", shortEdge: 1080 },
  { id: "1440p", label: "1440p", name: "QHD", shortEdge: 1440 },
  { id: "2160p", label: "4K", name: "Ultra HD", shortEdge: 2160 },
];

export interface ResolutionOption extends ResolutionTier {
  /** Scale factor relative to the source size that hits this tier. */
  scale: number;
  /** Aspect-preserved output size at this tier. */
  width: number;
  height: number;
  /** True when this tier upsamples above the source resolution. */
  upscale: boolean;
  /** True when the output exceeds the free-tier cap (Pro only). */
  pro: boolean;
}

/**
 * The resolution presets worth offering for a given source size. A tier is
 * included when its output is a sensible neighbour of the source — from a fifth
 * up to 2× the native short edge — so a tiny sticker isn't offered 4K and a 4K
 * comp isn't offered 360p. Always aspect-preserved off the SHORT edge.
 */
export function resolutionOptions(srcW: number, srcH: number): ResolutionOption[] {
  const shortSrc = Math.min(srcW, srcH);
  if (shortSrc <= 0) return [];
  const lo = shortSrc * 0.2;
  const hi = shortSrc * 2 + 1;
  const out: ResolutionOption[] = [];
  for (const tier of RESOLUTION_TIERS) {
    if (tier.shortEdge < lo || tier.shortEdge > hi) continue;
    const scale = tier.shortEdge / shortSrc;
    const width = Math.round(srcW * scale);
    const height = Math.round(srcH * scale);
    out.push({
      ...tier,
      scale,
      width,
      height,
      upscale: scale > 1.0001,
      pro: !isWithinFreeTier(width, height),
    });
  }
  return out;
}

/**
 * Which resolution tier (if any) a scale currently corresponds to, so the two
 * linked selectors (scale ⇄ resolution) agree. Matches on scale within a small
 * tolerance; returns null for a "Custom" scale that lands on no famous tier.
 */
export function matchResolution(
  options: readonly ResolutionOption[],
  scale: number,
): ResolutionOption | null {
  return options.find((o) => Math.abs(o.scale - scale) < 0.005) ?? null;
}
