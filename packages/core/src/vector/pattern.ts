import type { PatternSpec } from "../schema/vector";

/**
 * THE pattern engine: a spec in, a headless TILE PLAN out.
 *
 * The plan is a flat list of marks in tile space, exactly as `StrokePlan` is a
 * flat description of a line — and for the same reason. A pattern has to be
 * drawn by the canvas renderer, by every swatch and preview in the picker, by
 * the exporter, and one day by a host adapter that has no canvas at all. When
 * the picker approximated patterns in CSS and the renderer painted them for
 * real, the two disagreed the moment either grew a feature, and the swatch
 * stopped being a preview of anything.
 *
 * So the geometry is decided ONCE, here, with no DOM in sight, and every
 * surface executes the same plan. A new pattern kind is one arm of `tileMarks`
 * and one entry in the field registry; no renderer, no swatch and no exporter
 * learns anything about it.
 *
 * TILE SPACE is (0,0)–(w,h) with y down. The lattice's rotation and phase are
 * on the plan rather than baked into the marks, because a canvas pattern
 * carries them in its own transform and baking them in would force every
 * consumer to re-derive the tiling.
 */

export interface PatternMarkRect {
  kind: "rect";
  x: number;
  y: number;
  w: number;
  h: number;
  /** Corner radius, px. 0 = sharp. */
  r: number;
  color: string;
}
export interface PatternMarkCircle {
  kind: "circle";
  cx: number;
  cy: number;
  radius: number;
  color: string;
}
/** A filled polygon — triangles, diamonds, anything with corners. */
export interface PatternMarkPoly {
  kind: "poly";
  points: number[];
  color: string;
}
/** A stroked polyline — hatching, zigzags, waves. */
export interface PatternMarkLine {
  kind: "line";
  points: number[];
  width: number;
  color: string;
  round: boolean;
}
/** Procedural grain. Executed per-pixel by the consumer; there is no mark list
 *  that describes noise without being one entry per pixel. */
export interface PatternMarkNoise {
  kind: "noise";
  /** Cell size in px — big is blotchy, small is grain. */
  cell: number;
  /** 0 = flat, 1 = full black-to-white swing. */
  contrast: number;
  seed: number;
  color: string;
}
/** An imported image, tiled. The consumer resolves the asset. */
export interface PatternMarkImage {
  kind: "image";
  assetId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export type PatternMark =
  | PatternMarkRect
  | PatternMarkCircle
  | PatternMarkPoly
  | PatternMarkLine
  | PatternMarkNoise
  | PatternMarkImage;

export interface PatternTile {
  /** Tile size in px, already scaled. Always ≥ 1 in both axes. */
  w: number;
  h: number;
  /** Rotation of the whole lattice, degrees. */
  angleDeg: number;
  /** Phase, px — slides the tiling under the shape. Keyframe it to scroll. */
  offsetX: number;
  offsetY: number;
  /** Resolved background colour, or null for a transparent tile. */
  background: string | null;
  marks: PatternMark[];
}

/** Colour resolver — the caller's `resolveColor`, so `var:` tokens work inside
 *  a pattern exactly as they do in a solid fill. */
export type PatternColorResolver = (color: string) => string;

const TAU = Math.PI * 2;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Build the tile for a spec. Pure, cheap and deterministic — every jitter reads
 * the spec's own seed, so a pattern is stable frame to frame and only crawls
 * when you animate the seed. Playback that re-rolled its own grain would boil.
 */
export function buildPatternTile(spec: PatternSpec, resolve: PatternColorResolver): PatternTile {
  const scale = clamp(spec.scale, 0.02, 40);
  const period = Math.max(1, spec.spacing * scale);
  const aspect = clamp(spec.aspect, 0.1, 10);
  const w = period;
  // `spacing · aspect` is the distance from one ROW to the next, whatever the
  // kind. Dots and squares lay two rows in a tile (so `stagger` can shift the
  // second), so their tile is two rows tall — sized one row tall, every dot
  // lattice came out 2:1 (rows at half the spacing) and a square grid needed
  // `aspect: 2` to look square.
  const h = Math.max(1, period * aspect * patternRowsPerTile(spec.kind));
  const color = resolve(spec.color);
  const background = resolve(spec.background);

  return {
    w,
    h,
    angleDeg: spec.angleDeg,
    offsetX: spec.offsetX * scale,
    offsetY: spec.offsetY * scale,
    // A fully transparent background is a real, useful answer (a pattern laid
    // over a gradient underneath it), and it is what "no background" means.
    background: isTransparent(background) ? null : background,
    marks: tileMarks(spec, { w, h, scale, color }),
  };
}

/** How many lattice rows one tile of this kind holds. */
export function patternRowsPerTile(kind: PatternSpec["kind"]): 1 | 2 {
  return kind === "dots" || kind === "squares" ? 2 : 1;
}

function isTransparent(color: string): boolean {
  const c = color.trim().toLowerCase();
  return c === "transparent" || c === "none" || /^#[0-9a-f]{6}00$/.test(c) || /^#[0-9a-f]{3}0$/.test(c);
}

interface TileCtx {
  w: number;
  h: number;
  scale: number;
  color: string;
}

/**
 * The marks each kind lays down inside one tile.
 *
 * Marks that touch an edge are duplicated across the seam rather than trusting
 * the tiling to complete them — a dot cut in half by the tile boundary is a
 * dot in three other tiles too, and only the consumer that happens to clip
 * generously would draw them.
 */
function tileMarks(spec: PatternSpec, ctx: TileCtx): PatternMark[] {
  const { w, h, scale, color } = ctx;
  const t = Math.max(0, spec.thickness * scale);
  const round = clamp(spec.roundness, 0, 1);
  const stagger = clamp(spec.stagger, 0, 1);

  switch (spec.kind) {
    case "stripes":
      return [{ kind: "rect", x: 0, y: 0, w: Math.min(t, w), h, r: 0, color }];

    case "grid":
      return [
        { kind: "rect", x: 0, y: 0, w: Math.min(t, w), h, r: 0, color },
        { kind: "rect", x: 0, y: 0, w, h: Math.min(t, h), r: 0, color },
      ];

    case "checks":
      return [
        { kind: "rect", x: 0, y: 0, w: w / 2, h: h / 2, r: (round * Math.min(w, h)) / 4, color },
        { kind: "rect", x: w / 2, y: h / 2, w: w / 2, h: h / 2, r: (round * Math.min(w, h)) / 4, color },
      ];

    case "dots": {
      // Two rows per tile so `stagger` has somewhere to shift the second one —
      // a one-row tile cannot express a brick or hex lattice at all.
      const r = Math.max(0, t / 2);
      const dx = stagger * w;
      const out: PatternMark[] = [{ kind: "circle", cx: w / 2, cy: h / 4, radius: r, color }];
      const cx2 = w / 2 + dx;
      for (const x of [cx2 - w, cx2, cx2 + w]) {
        if (x + r < 0 || x - r > w) continue;
        out.push({ kind: "circle", cx: x, cy: (3 * h) / 4, radius: r, color });
      }
      return out;
    }

    case "squares": {
      const s = Math.max(0, t);
      const dx = stagger * w;
      const out: PatternMark[] = [
        { kind: "rect", x: (w - s) / 2, y: h / 4 - s / 2, w: s, h: s, r: (round * s) / 2, color },
      ];
      const cx2 = w / 2 + dx;
      for (const x of [cx2 - w, cx2, cx2 + w]) {
        if (x + s / 2 < 0 || x - s / 2 > w) continue;
        out.push({ kind: "rect", x: x - s / 2, y: (3 * h) / 4 - s / 2, w: s, h: s, r: (round * s) / 2, color });
      }
      return out;
    }

    case "cross":
      // Corner-to-corner both ways: the two diagonals meet their neighbours
      // exactly at the seams, so the hatch reads as continuous.
      return [
        { kind: "line", points: [0, 0, w, h], width: t, color, round: round > 0.5 },
        { kind: "line", points: [w, 0, 0, h], width: t, color, round: round > 0.5 },
        { kind: "line", points: [-w, 0, 0, h], width: t, color, round: round > 0.5 },
        { kind: "line", points: [w, 0, 2 * w, h], width: t, color, round: round > 0.5 },
      ];

    case "triangles":
      return [
        { kind: "poly", points: [0, h, w / 2, 0, w, h], color },
      ];

    case "zigzag": {
      const a = clamp(spec.amplitude * scale, 0, h);
      const mid = h / 2;
      return [
        {
          kind: "line",
          points: [0, mid + a / 2, w / 2, mid - a / 2, w, mid + a / 2],
          width: t,
          color,
          round: round > 0.5,
        },
      ];
    }

    case "waves": {
      const a = clamp(spec.amplitude * scale, 0, h);
      const steps = 24;
      const points: number[] = [];
      for (let i = 0; i <= steps; i++) {
        const x = (i / steps) * w;
        points.push(x, h / 2 + (Math.sin((i / steps) * TAU) * a) / 2);
      }
      return [{ kind: "line", points, width: t, color, round: true }];
    }

    case "noise":
      return [
        {
          kind: "noise",
          cell: Math.max(1, t || scale),
          contrast: clamp(spec.amplitude, 0, 1),
          seed: Math.round(spec.seed),
          color,
        },
      ];

    case "image":
      return spec.assetId ? [{ kind: "image", assetId: spec.assetId, x: 0, y: 0, w, h }] : [];
  }
}

/**
 * Deterministic value noise in 0..1 for a tile cell. Exported so the canvas
 * executor and any other consumer produce the SAME grain — a pattern that
 * looked different in the export than on the stage would be worse than no
 * pattern at all.
 */
export function patternNoiseAt(x: number, y: number, seed: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return n - Math.floor(n);
}
