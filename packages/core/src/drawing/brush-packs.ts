import { STROKE_SETS, STROKE_STACKS, defaultStrokeSet, type StrokeSet } from "../presets/stroke-sets";
import {
  brushMod,
  createBrushPreset,
  type BrushFamily,
  type BrushMod,
  type BrushPreset,
} from "./brush";

/**
 * THE FACTORY PACK — eighty-odd brushes, described rather than shipped.
 *
 * Every entry here is a claim about how a real tool behaves, and the claims
 * are the point: a pencil is not "a round brush with some noise", it is a
 * broken tip dragging across paper tooth, laying down thin glazes that darken
 * where you go over them, widening when you tilt it. Get those four facts
 * right and it reads as a pencil at any size in any colour. Get them wrong and
 * no amount of texture rescues it.
 *
 * The four dials that decide what family a brush belongs to:
 *
 *   TIP        the stencil (`drawing/tips`) — round, grit, bristle, chisel…
 *   SPACING    < 0.06 reads as a continuous line; > 0.8 reads as separate
 *              stamps. Everything between is a texture decision.
 *   FLOW+STAMP `glaze` accumulates per stamp, so overlapping darkens (markers,
 *              ink, dry media). `uniform` composites the whole stroke once, so
 *              a wash stays even (airbrush, watercolour, highlighter).
 *   GRAIN      what surface the paint is fighting. Zero for anything wet or
 *              synthetic; heavy for everything dry.
 *
 * Ids are STABLE and namespaced `brush_*`: the library stores edits as
 * overrides keyed by id, so renaming one here would silently orphan an
 * artist's customisation.
 */

// ── Builders ────────────────────────────────────────────────────────────────

const m = brushMod;

/** Pressure → size, the response nearly every hand-held tool has. */
const sizeP = (amount: number, floor = 0.1, gamma = 1) => m("size", "pressure", amount, { floor, gamma });
/** Pressure → opacity — dry media and washes; NOT pens, which run at full ink. */
const opacityP = (amount: number, floor = 0.04, gamma = 1) =>
  m("opacity", "pressure", amount, { floor, gamma });
/** Tilt → size: the side of the lead. Only graphite, charcoal and pastel. */
const tiltSize = (amount: number) => m("size", "tilt", amount);
/** Speed → size. NEGATIVE thins the line as the hand accelerates — ink. */
const speedSize = (amount: number, floor = 0.25) => m("size", "velocity", amount, { floor });

interface RasterSpec {
  id: string;
  name: string;
  family: BrushFamily;
  group: string;
  size: number;
  opacity?: number;
  tip?: BrushPreset["shape"]["type"];
  hardness?: number;
  roundness?: number;
  angle?: number;
  follow?: boolean;
  density?: number;
  spread?: number;
  irregular?: number;
  sides?: number;
  seed?: number;
  spacing?: number;
  streamline?: number;
  jitter?: number;
  scatter?: number;
  taperIn?: number;
  taperOut?: number;
  flow?: number;
  stamp?: "uniform" | "glaze";
  blend?: BrushPreset["rendering"]["blend"];
  erase?: boolean;
  /** Paints into a live water film (drawing/watercolor) instead of onto pixels. */
  wet?: Partial<BrushPreset["rendering"]["wet"]>;
  grain?: BrushPreset["grain"]["texture"];
  grainAmount?: number;
  grainScale?: number;
  grainMoving?: boolean;
  mods?: BrushMod[];
}

function raster(s: RasterSpec): BrushPreset {
  return createBrushPreset({
    id: s.id,
    name: s.name,
    family: s.family,
    group: s.group,
    engine: "raster",
    builtIn: true,
    size: s.size,
    opacity: s.opacity ?? 1,
    shape: {
      type: s.tip ?? "round",
      hardness: s.hardness ?? 0.9,
      roundness: s.roundness ?? 1,
      angle: s.angle ?? 0,
      followStroke: s.follow ?? false,
      density: s.density ?? 0.5,
      spread: s.spread ?? 0.5,
      irregular: s.irregular ?? 0.4,
      sides: s.sides ?? 5,
      seed: s.seed ?? 1,
      imageId: null,
    },
    grain: {
      texture: s.grain ?? "paper",
      imageId: null,
      scale: s.grainScale ?? 1,
      intensity: s.grainAmount ?? 0,
      moving: s.grainMoving ?? false,
      seed: 1,
    },
    strokePath: {
      spacing: s.spacing ?? 0.08,
      streamline: s.streamline ?? 0.3,
      jitter: s.jitter ?? 0,
      scatter: s.scatter ?? 0,
      taperStartPx: s.taperIn ?? 0,
      taperEndPx: s.taperOut ?? 0,
    },
    dynamics: { mods: s.mods ?? [], flow: s.flow ?? 1 },
    rendering: {
      blend: s.blend ?? "normal",
      stamp: s.stamp ?? "glaze",
      erase: s.erase ?? false,
      wet: s.wet ? { enabled: true, ...s.wet } : { enabled: false },
    },
  });
}

// ── Sketching — graphite ────────────────────────────────────────────────────
//
// Graphite is a BROKEN tip on TOOTHED paper laying THIN glazes. All four
// pencils below differ only in how much of the tooth they reach into (grain
// intensity), how dark one pass lands (flow) and how hard the core is
// (hardness) — which is exactly what the grade of a pencil means.

const PENCILS = (): BrushPreset[] => [
  raster({
    id: "brush_pencil_6b", name: "6B Pencil", family: "sketching", group: "Graphite",
    size: 9, tip: "grit", hardness: 0.5, irregular: 0.55, density: 0.6, spread: 0.4,
    spacing: 0.09, streamline: 0.22, flow: 0.8,
    grain: "paper", grainAmount: 0.55, grainScale: 0.9,
    mods: [sizeP(0.45, 0.35), opacityP(0.9, 0.05, 1.3), tiltSize(0.55)],
  }),
  raster({
    id: "brush_pencil_2b", name: "2B Pencil", family: "sketching", group: "Graphite",
    size: 7, tip: "grit", hardness: 0.6, irregular: 0.45, density: 0.55, spread: 0.35,
    spacing: 0.09, streamline: 0.25, flow: 0.6,
    grain: "paper", grainAmount: 0.5, grainScale: 0.8,
    mods: [sizeP(0.4, 0.35), opacityP(0.85, 0.04, 1.4), tiltSize(0.45)],
  }),
  raster({
    id: "brush_pencil_hb", name: "HB Pencil", family: "sketching", group: "Graphite",
    size: 5, tip: "grit", hardness: 0.68, irregular: 0.35, density: 0.5, spread: 0.3,
    spacing: 0.09, streamline: 0.3, flow: 0.45,
    grain: "paper", grainAmount: 0.42, grainScale: 0.7,
    mods: [sizeP(0.3, 0.4), opacityP(0.85, 0.03, 1.5), tiltSize(0.35)],
  }),
  raster({
    id: "brush_pencil_2h", name: "2H Technical", family: "sketching", group: "Graphite",
    size: 3, tip: "grit", hardness: 0.8, irregular: 0.25, density: 0.45, spread: 0.22,
    spacing: 0.08, streamline: 0.4, flow: 0.3,
    grain: "paper", grainAmount: 0.3, grainScale: 0.6,
    mods: [sizeP(0.2, 0.5), opacityP(0.8, 0.02, 1.6)],
  }),
  raster({
    id: "brush_pencil_mechanical", name: "Mechanical Pencil", family: "sketching", group: "Graphite",
    // A 0.5mm lead does not change width — that is its whole character. So no
    // size mod at all, and the pressure goes entirely into darkness.
    size: 2.5, tip: "grit", hardness: 0.85, irregular: 0.2, density: 0.4, spread: 0.15,
    spacing: 0.07, streamline: 0.4, flow: 0.5,
    grain: "paper", grainAmount: 0.25, grainScale: 0.5,
    mods: [opacityP(0.75, 0.05, 1.4)],
  }),
  raster({
    id: "brush_pencil_carbon", name: "Carbon Pencil", family: "sketching", group: "Graphite",
    size: 8, tip: "grit", hardness: 0.45, irregular: 0.65, density: 0.7, spread: 0.45,
    spacing: 0.1, streamline: 0.2, flow: 0.95,
    grain: "rough", grainAmount: 0.6, grainScale: 1.1,
    mods: [sizeP(0.5, 0.3), opacityP(0.8, 0.06), tiltSize(0.6)],
  }),
  raster({
    id: "brush_pencil_col_erase", name: "Col Erase", family: "sketching", group: "Graphite",
    // The blue under-drawing pencil: waxy, light, and it refuses to go dark.
    size: 6, opacity: 0.55, tip: "grit", hardness: 0.6, irregular: 0.4, density: 0.5, spread: 0.3,
    spacing: 0.09, streamline: 0.28, flow: 0.4,
    grain: "paper", grainAmount: 0.45,
    mods: [sizeP(0.3, 0.4), opacityP(0.7, 0.05)],
  }),
  raster({
    id: "brush_pencil_sketch_soft", name: "Soft Sketch", family: "sketching", group: "Graphite",
    size: 14, opacity: 0.5, tip: "grit", hardness: 0.35, irregular: 0.6, density: 0.65, spread: 0.6,
    spacing: 0.11, streamline: 0.18, flow: 0.5,
    grain: "paper", grainAmount: 0.5, grainScale: 1.3,
    mods: [sizeP(0.55, 0.3), opacityP(0.9, 0.03), tiltSize(0.7)],
  }),
];

// ── Inking — pens ───────────────────────────────────────────────────────────
//
// Ink runs at FULL opacity: a pen does not get lighter when you press softly,
// it gets THINNER. So every pen here modulates size and leaves opacity alone —
// the single most common way a "pen" ends up feeling like a marker instead.

const PENS = (): BrushPreset[] => [
  raster({
    id: "brush_pen_technical", name: "Technical Pen", family: "inking", group: "Pens",
    // A Rapidograph is a fixed-width nib. No pressure response whatsoever.
    size: 3, hardness: 1, spacing: 0.05, streamline: 0.55, flow: 1,
    mods: [],
  }),
  raster({
    id: "brush_pen_studio", name: "Studio Pen", family: "inking", group: "Pens",
    size: 8, hardness: 0.97, spacing: 0.05, streamline: 0.6, flow: 1,
    taperIn: 6, taperOut: 26,
    mods: [sizeP(0.75, 0.12, 1.2), speedSize(-0.3)],
  }),
  raster({
    id: "brush_pen_fineliner", name: "Fineliner", family: "inking", group: "Pens",
    size: 4, hardness: 1, spacing: 0.05, streamline: 0.6, flow: 1,
    mods: [sizeP(0.25, 0.5)],
  }),
  raster({
    id: "brush_pen_gel", name: "Gel Pen", family: "inking", group: "Pens",
    size: 5, hardness: 0.98, spacing: 0.04, streamline: 0.5, flow: 1,
    mods: [sizeP(0.4, 0.3)],
  }),
  raster({
    id: "brush_pen_ballpoint", name: "Ballpoint", family: "inking", group: "Pens",
    // A biro skips: it lays uneven ink and lightens as it dries out.
    size: 3, opacity: 0.85, tip: "grit", hardness: 0.85, irregular: 0.5, density: 0.35, spread: 0.2,
    spacing: 0.06, streamline: 0.45, flow: 0.6,
    grain: "noise", grainAmount: 0.3, grainScale: 0.5,
    mods: [sizeP(0.25, 0.45), opacityP(0.5, 0.15)],
  }),
  raster({
    id: "brush_pen_brush", name: "Brush Pen", family: "inking", group: "Pens",
    // A flexible nib: huge width range, and it takes real pressure to open up
    // (gamma > 1 delays the response, which is what "firm" feels like).
    size: 22, hardness: 0.95, spacing: 0.04, streamline: 0.55, flow: 1,
    taperIn: 10, taperOut: 40,
    mods: [sizeP(1, 0.05, 1.7), speedSize(-0.35)],
  }),
  raster({
    id: "brush_pen_syrup", name: "Syrup Ink", family: "inking", group: "Pens",
    size: 14, hardness: 0.92, spacing: 0.04, streamline: 0.7, flow: 1,
    wet: { wetness: 0.35, flow: 0.3, evaporation: 0.02, edge: 0.45, granulation: 0.1, deposition: 0.12, texture: "paper" },
    taperIn: 14, taperOut: 50,
    mods: [sizeP(0.9, 0.08, 1.4), speedSize(-0.55)],
  }),
  raster({
    id: "brush_pen_dry_ink", name: "Dry Ink", family: "inking", group: "Pens",
    size: 10, tip: "grit", hardness: 0.75, irregular: 0.7, density: 0.6, spread: 0.35,
    spacing: 0.06, streamline: 0.45, flow: 1,
    grain: "rough", grainAmount: 0.45,
    mods: [sizeP(0.7, 0.15), opacityP(0.35, 0.4)],
  }),
  raster({
    id: "brush_pen_monoline", name: "Monoline", family: "inking", group: "Pens",
    // The reference monoline: one width, one density, forever. Heavy
    // streamline because a constant-width line shows every tremor.
    size: 6, hardness: 1, spacing: 0.04, streamline: 0.75, flow: 1,
    mods: [],
  }),
  raster({
    id: "brush_pen_monoline_bold", name: "Monoline Bold", family: "inking", group: "Pens",
    size: 14, hardness: 1, spacing: 0.04, streamline: 0.8, flow: 1,
    mods: [],
  }),
  raster({
    id: "brush_pen_marker", name: "Marker", family: "inking", group: "Markers",
    // A chisel felt tip at partial flow: overlaps darken, edges stay hard.
    size: 20, opacity: 0.9, tip: "chisel", hardness: 1, spread: 0.62, angle: 35,
    spacing: 0.035, streamline: 0.5, flow: 0.5,
    mods: [],
  }),
  raster({
    id: "brush_pen_marker_fine", name: "Fine Marker", family: "inking", group: "Markers",
    size: 9, opacity: 0.9, tip: "chisel", hardness: 1, spread: 0.7, angle: 35,
    spacing: 0.035, streamline: 0.55, flow: 0.6,
    mods: [],
  }),
  raster({
    id: "brush_pen_highlighter", name: "Highlighter", family: "inking", group: "Markers",
    // Uniform + multiply: the whole point of a highlighter is that going over
    // your own stroke does NOT build up, and that what is under it survives.
    size: 34, opacity: 0.45, tip: "square", hardness: 1, spread: 0.5,
    spacing: 0.05, streamline: 0.6, flow: 1, stamp: "uniform", blend: "multiply",
    mods: [],
  }),
  raster({
    id: "brush_pen_dry_marker", name: "Dry Marker", family: "inking", group: "Markers",
    size: 24, opacity: 0.8, tip: "chisel", hardness: 0.9, spread: 0.6, angle: 40,
    spacing: 0.04, streamline: 0.45, flow: 0.55,
    grain: "fibre", grainAmount: 0.4, grainScale: 1.4,
    mods: [],
  }),
];

// ── Calligraphy ─────────────────────────────────────────────────────────────
//
// Two entirely different instruments that people file under one word:
//   BROAD NIB  — a fixed-angle chisel. Width comes from the DIRECTION you
//                move, never from pressure. `followStroke` must stay OFF, or
//                the nib rotates and the whole effect disappears.
//   POINTED    — a flexible point. Width comes from pressure alone.

const CALLIGRAPHY = (): BrushPreset[] => [
  raster({
    id: "brush_calli_broad", name: "Broad Nib", family: "calligraphy", group: "Nibs",
    size: 26, tip: "chisel", hardness: 1, spread: 0.78, angle: 45, follow: false,
    spacing: 0.03, streamline: 0.6, flow: 1,
    mods: [],
  }),
  raster({
    id: "brush_calli_italic", name: "Italic Nib", family: "calligraphy", group: "Nibs",
    size: 22, tip: "chisel", hardness: 1, spread: 0.82, angle: 30, follow: false,
    spacing: 0.03, streamline: 0.65, flow: 1,
    mods: [],
  }),
  raster({
    id: "brush_calli_pointed", name: "Pointed Pen", family: "calligraphy", group: "Nibs",
    // Copperplate: hairline upstroke, swelling downstroke. Late, steep gamma.
    size: 20, hardness: 1, spacing: 0.03, streamline: 0.7, flow: 1,
    taperIn: 8, taperOut: 24,
    mods: [sizeP(1, 0.04, 2.2)],
  }),
  raster({
    id: "brush_calli_script", name: "Script Brush", family: "calligraphy", group: "Nibs",
    size: 18, hardness: 0.95, spacing: 0.035, streamline: 0.72, flow: 1,
    taperIn: 12, taperOut: 34,
    mods: [sizeP(0.9, 0.07, 1.6), speedSize(-0.4)],
  }),
  raster({
    id: "brush_calli_chisel_marker", name: "Chisel Marker", family: "calligraphy", group: "Nibs",
    size: 30, opacity: 0.92, tip: "chisel", hardness: 1, spread: 0.55, angle: 50, follow: false,
    spacing: 0.03, streamline: 0.55, flow: 0.65,
    mods: [],
  }),
];

// ── Painting ────────────────────────────────────────────────────────────────
//
// The paint family is BRISTLES: a rake of hairs, dragged along the stroke
// (`follow: true`), spaced tightly enough that the hairs streak instead of
// stamping. Spacing above ~0.06 and the illusion breaks into polka dots.

const PAINTING = (): BrushPreset[] => [
  raster({
    id: "brush_paint_round", name: "Round Brush", family: "painting", group: "Brushes",
    size: 26, tip: "bristle", hardness: 0.85, density: 0.55, spread: 0.45, irregular: 0.35,
    follow: true, spacing: 0.03, streamline: 0.3, flow: 0.9,
    grain: "canvas", grainAmount: 0.22,
    mods: [sizeP(0.6, 0.2), opacityP(0.4, 0.2), tiltSize(0.3)],
  }),
  raster({
    id: "brush_paint_flat", name: "Flat Brush", family: "painting", group: "Brushes",
    size: 34, tip: "bristle", hardness: 0.9, density: 0.7, spread: 0.75, irregular: 0.3,
    follow: true, spacing: 0.028, streamline: 0.32, flow: 0.95,
    grain: "canvas", grainAmount: 0.25,
    mods: [sizeP(0.45, 0.3), opacityP(0.3, 0.3)],
  }),
  raster({
    id: "brush_paint_oil", name: "Oil Paint", family: "painting", group: "Brushes",
    size: 38, tip: "bristle", hardness: 0.8, density: 0.8, spread: 0.7, irregular: 0.5,
    follow: true, spacing: 0.025, streamline: 0.28, flow: 1,
    grain: "canvas", grainAmount: 0.4, grainScale: 1.2,
    mods: [sizeP(0.5, 0.3), tiltSize(0.35)],
  }),
  raster({
    id: "brush_paint_acrylic", name: "Acrylic", family: "painting", group: "Brushes",
    size: 30, tip: "bristle", hardness: 0.92, density: 0.65, spread: 0.6, irregular: 0.28,
    follow: true, spacing: 0.03, streamline: 0.3, flow: 1,
    grain: "canvas", grainAmount: 0.3,
    mods: [sizeP(0.45, 0.3)],
  }),
  raster({
    id: "brush_paint_gouache", name: "Gouache", family: "painting", group: "Brushes",
    // Gouache is FLAT and opaque — uniform stamping, almost no texture.
    size: 28, tip: "round", hardness: 0.88, spacing: 0.04, streamline: 0.4,
    flow: 1, stamp: "uniform",
    grain: "paper", grainAmount: 0.15,
    mods: [sizeP(0.5, 0.25)],
  }),
  raster({
    id: "brush_paint_dry_brush", name: "Dry Brush", family: "painting", group: "Brushes",
    // Almost no paint left on the hairs: high irregularity, heavy tooth.
    size: 40, opacity: 0.85, tip: "bristle", hardness: 0.75, density: 0.9, spread: 0.8, irregular: 0.8,
    follow: true, spacing: 0.045, streamline: 0.25, flow: 0.7,
    grain: "rough", grainAmount: 0.7, grainScale: 1.4,
    mods: [sizeP(0.4, 0.35), opacityP(0.6, 0.1)],
  }),
  raster({
    id: "brush_paint_impasto", name: "Impasto", family: "painting", group: "Brushes",
    size: 44, tip: "bristle", hardness: 0.95, density: 0.45, spread: 0.85, irregular: 0.6,
    follow: true, spacing: 0.03, streamline: 0.22, flow: 1,
    grain: "canvas", grainAmount: 0.5, grainScale: 0.7, grainMoving: true,
    mods: [sizeP(0.55, 0.3), tiltSize(0.4)],
  }),
  raster({
    id: "brush_paint_knife", name: "Palette Knife", family: "painting", group: "Brushes",
    size: 46, tip: "chisel", hardness: 0.95, spread: 0.5, follow: true,
    spacing: 0.025, streamline: 0.35, flow: 1,
    grain: "concrete", grainAmount: 0.35, grainMoving: true,
    mods: [sizeP(0.35, 0.4)],
  }),
  raster({
    id: "brush_paint_rake", name: "Rake", family: "painting", group: "Brushes",
    size: 36, tip: "bristle", hardness: 0.95, density: 1, spread: 0.9, irregular: 0.15,
    follow: true, spacing: 0.02, streamline: 0.3, flow: 1,
    mods: [sizeP(0.3, 0.4)],
  }),
  raster({
    id: "brush_paint_hair", name: "Hair", family: "painting", group: "Brushes",
    // Very dense, very thin, very tight spacing — the strand brush.
    size: 18, tip: "bristle", hardness: 0.98, density: 1, spread: 0.35, irregular: 0.5,
    follow: true, spacing: 0.018, streamline: 0.45, flow: 1,
    taperIn: 10, taperOut: 30,
    mods: [sizeP(0.6, 0.15)],
  }),
];

// ── Airbrushing — sprays ────────────────────────────────────────────────────
//
// The airbrush rule: LOW FLOW, TIGHT SPACING, UNIFORM stamping. Low flow is
// what lets you build tone gradually; uniform is what stops a single pass from
// blotching where the stroke crosses itself.

const AIRBRUSH = (): BrushPreset[] => [
  raster({
    id: "brush_air_soft", name: "Soft Airbrush", family: "airbrushing", group: "Airbrush",
    size: 90, opacity: 0.75, hardness: 0.04, spacing: 0.035, streamline: 0.2,
    flow: 0.1, stamp: "uniform",
    mods: [opacityP(0.9, 0.02), sizeP(0.25, 0.65)],
  }),
  raster({
    id: "brush_air_medium", name: "Medium Airbrush", family: "airbrushing", group: "Airbrush",
    size: 60, opacity: 0.8, hardness: 0.3, spacing: 0.035, streamline: 0.25,
    flow: 0.18, stamp: "uniform",
    mods: [opacityP(0.85, 0.03), sizeP(0.3, 0.55)],
  }),
  raster({
    id: "brush_air_hard", name: "Hard Airbrush", family: "airbrushing", group: "Airbrush",
    size: 40, opacity: 0.9, hardness: 0.62, spacing: 0.04, streamline: 0.3,
    flow: 0.3, stamp: "uniform",
    mods: [opacityP(0.8, 0.04), sizeP(0.4, 0.4)],
  }),
  raster({
    id: "brush_air_flat", name: "Flat Airbrush", family: "airbrushing", group: "Airbrush",
    // No build-up at all: full flow, uniform. The flat-colour filling tool.
    size: 50, hardness: 0.75, spacing: 0.04, streamline: 0.3, flow: 1, stamp: "uniform",
    mods: [sizeP(0.35, 0.45)],
  }),
  raster({
    id: "brush_spray_paint", name: "Spray Paint", family: "airbrushing", group: "Spray",
    size: 56, opacity: 0.9, tip: "spray", density: 0.55, spread: 0.5, irregular: 0.4,
    spacing: 0.06, streamline: 0.2, flow: 0.3,
    grain: "speckle", grainAmount: 0.25,
    mods: [opacityP(0.7, 0.1), sizeP(0.3, 0.5)],
  }),
  raster({
    id: "brush_spray_fine", name: "Fine Spray", family: "airbrushing", group: "Spray",
    size: 36, opacity: 0.85, tip: "spray", density: 0.9, spread: 0.25, irregular: 0.3,
    spacing: 0.05, streamline: 0.25, flow: 0.16,
    mods: [opacityP(0.8, 0.06)],
  }),
  raster({
    id: "brush_spray_wide", name: "Wide Nozzle", family: "airbrushing", group: "Spray",
    size: 110, opacity: 0.8, tip: "spray", density: 0.35, spread: 0.85, irregular: 0.55,
    spacing: 0.08, streamline: 0.18, flow: 0.22,
    mods: [opacityP(0.7, 0.08), m("scatter", "random", 0.3)],
  }),
  raster({
    id: "brush_spray_splatter", name: "Splatter", family: "airbrushing", group: "Spray",
    // Separate stamps (spacing > 1) with per-dab size and rotation — this is
    // what makes fifty stamps read as fifty droplets instead of a rope.
    size: 46, tip: "spatter", density: 0.5, spread: 0.5, irregular: 0.6,
    spacing: 1.1, streamline: 0.1, jitter: 0.5, scatter: 0.7, flow: 1,
    mods: [m("size", "random", 0.7, { floor: 0.25 }), m("angle", "random", 1)],
  }),
  raster({
    id: "brush_spray_mist", name: "Mist", family: "airbrushing", group: "Spray",
    size: 130, opacity: 0.5, tip: "spray", density: 0.25, spread: 0.95, irregular: 0.7,
    spacing: 0.12, streamline: 0.15, flow: 0.08, stamp: "uniform",
    mods: [opacityP(0.6, 0.05), m("size", "random", 0.3, { floor: 0.6 })],
  }),
  raster({
    id: "brush_spray_dust", name: "Dust", family: "airbrushing", group: "Spray",
    size: 70, opacity: 0.7, tip: "spray", density: 0.15, spread: 0.9, irregular: 0.8,
    spacing: 0.4, streamline: 0.1, scatter: 0.5, flow: 0.7,
    grain: "speckle", grainAmount: 0.4,
    mods: [m("size", "random", 0.6, { floor: 0.2 })],
  }),
];

// ── Textures — dry media ────────────────────────────────────────────────────
//
// Everything here is a broken tip on a rough surface. The knobs that separate
// them: how HARD the stick is (hardness), how much it CRUMBLES (irregular),
// and which paper it is fighting (grain texture + scale).

const TEXTURES = (): BrushPreset[] => [
  raster({
    id: "brush_charcoal", name: "Charcoal", family: "texture", group: "Dry media",
    size: 30, tip: "grit", hardness: 0.4, density: 0.75, spread: 0.55, irregular: 0.7,
    spacing: 0.1, streamline: 0.2, flow: 0.85,
    grain: "rough", grainAmount: 0.72, grainScale: 1.3,
    mods: [sizeP(0.5, 0.3), opacityP(0.75, 0.06), tiltSize(0.8)],
  }),
  raster({
    id: "brush_charcoal_stick", name: "Charcoal Stick", family: "texture", group: "Dry media",
    size: 52, tip: "chisel", hardness: 0.5, spread: 0.35, angle: 20,
    spacing: 0.08, streamline: 0.18, flow: 0.9,
    grain: "rough", grainAmount: 0.8, grainScale: 1.6,
    mods: [sizeP(0.35, 0.4), opacityP(0.6, 0.1), tiltSize(0.9)],
  }),
  raster({
    id: "brush_chalk", name: "Chalk", family: "texture", group: "Dry media",
    size: 28, opacity: 0.9, tip: "grit", hardness: 0.62, density: 0.6, spread: 0.5, irregular: 0.55,
    spacing: 0.12, streamline: 0.2, flow: 0.8,
    grain: "canvas", grainAmount: 0.62, grainScale: 1.1,
    mods: [sizeP(0.4, 0.35), opacityP(0.7, 0.08), tiltSize(0.5)],
  }),
  raster({
    id: "brush_pastel_soft", name: "Soft Pastel", family: "texture", group: "Dry media",
    size: 40, tip: "grit", hardness: 0.5, density: 0.85, spread: 0.65, irregular: 0.6,
    spacing: 0.09, streamline: 0.18, flow: 0.9,
    grain: "paper", grainAmount: 0.65, grainScale: 1.5,
    mods: [sizeP(0.45, 0.35), opacityP(0.6, 0.12), tiltSize(0.7)],
  }),
  raster({
    id: "brush_pastel_oil", name: "Oil Pastel", family: "texture", group: "Dry media",
    // Waxy: it fills the tooth instead of skipping over it, so heavy flow and
    // a smaller grain than its dry cousin.
    size: 34, tip: "grit", hardness: 0.55, density: 0.9, spread: 0.55, irregular: 0.45,
    spacing: 0.06, streamline: 0.22, flow: 1,
    grain: "rough", grainAmount: 0.45, grainScale: 0.9,
    mods: [sizeP(0.4, 0.35), tiltSize(0.5)],
  }),
  raster({
    id: "brush_crayon", name: "Crayon", family: "texture", group: "Dry media",
    size: 26, opacity: 0.95, tip: "grit", hardness: 0.55, density: 0.7, spread: 0.45, irregular: 0.72,
    spacing: 0.08, streamline: 0.2, flow: 0.9,
    grain: "paper", grainAmount: 0.68, grainScale: 0.8,
    mods: [sizeP(0.35, 0.4), opacityP(0.5, 0.2), tiltSize(0.55)],
  }),
  raster({
    id: "brush_conte", name: "Conté", family: "texture", group: "Dry media",
    size: 32, tip: "chisel", hardness: 0.55, spread: 0.45, angle: 35,
    spacing: 0.09, streamline: 0.2, flow: 0.85,
    grain: "rough", grainAmount: 0.6, grainScale: 1.1,
    mods: [sizeP(0.4, 0.35), opacityP(0.65, 0.1), tiltSize(0.75)],
  }),
  raster({
    id: "brush_graphite_stick", name: "Graphite Stick", family: "texture", group: "Dry media",
    size: 44, tip: "chisel", hardness: 0.6, spread: 0.4, angle: 45,
    spacing: 0.07, streamline: 0.2, flow: 0.6,
    grain: "paper", grainAmount: 0.55, grainScale: 1.2,
    mods: [sizeP(0.3, 0.45), opacityP(0.8, 0.06), tiltSize(0.85)],
  }),
  raster({
    id: "brush_sponge", name: "Sponge", family: "texture", group: "Grunge",
    size: 60, opacity: 0.85, tip: "sponge", density: 0.55, spread: 0.6, irregular: 0.6,
    spacing: 0.35, streamline: 0.1, flow: 0.8,
    grain: "concrete", grainAmount: 0.4,
    mods: [m("angle", "random", 1), m("size", "random", 0.3, { floor: 0.6 }), opacityP(0.5, 0.2)],
  }),
  raster({
    id: "brush_grunge", name: "Grunge", family: "texture", group: "Grunge",
    size: 70, opacity: 0.9, tip: "grit", hardness: 0.35, density: 0.85, spread: 0.8, irregular: 0.85,
    spacing: 0.18, streamline: 0.1, flow: 0.75,
    grain: "concrete", grainAmount: 0.75, grainScale: 1.8,
    mods: [m("angle", "random", 1), opacityP(0.5, 0.2)],
  }),
  raster({
    id: "brush_scratches", name: "Scratches", family: "texture", group: "Grunge",
    size: 40, tip: "hatch", hardness: 0.9, density: 0.25, spread: 0.7, irregular: 0.9,
    spacing: 0.5, streamline: 0.1, flow: 1,
    mods: [m("angle", "random", 1), m("size", "random", 0.5, { floor: 0.4 })],
  }),
  raster({
    id: "brush_noise_grit", name: "Grit", family: "texture", group: "Grunge",
    size: 50, opacity: 0.8, tip: "spray", density: 0.2, spread: 0.85, irregular: 0.9,
    spacing: 0.3, streamline: 0.1, jitter: 0.4, flow: 1,
    grain: "speckle", grainAmount: 0.6,
    mods: [],
  }),
];

// ── Artistic — wet media ────────────────────────────────────────────────────
//
// Water: LOW flow, UNIFORM stamping, and a WET EDGE — pigment migrating to the
// rim as the water evaporates is the single feature that says "watercolour",
// and no amount of soft edge substitutes for it.

const ARTISTIC = (): BrushPreset[] => [
  raster({
    id: "brush_water_wash", name: "Watercolor Wash", family: "artistic", group: "Watercolor",
    size: 90, opacity: 0.55, hardness: 0.14, spacing: 0.04, streamline: 0.28,
    flow: 0.08, stamp: "uniform",
    wet: { wetness: 0.95, flow: 0.85, evaporation: 0.0035, edge: 0.12, granulation: 0.5, texture: "rough" },
    grain: "rough", grainAmount: 0.4, grainScale: 1.6,
    mods: [opacityP(0.7, 0.05), sizeP(0.4, 0.4)],
  }),
  raster({
    id: "brush_water_edge", name: "Watercolor Edge", family: "artistic", group: "Watercolor",
    size: 60, opacity: 0.7, hardness: 0.32, spacing: 0.05, streamline: 0.25,
    flow: 0.16,
    wet: { wetness: 0.8, flow: 0.7, evaporation: 0.006, edge: 1, granulation: 0.4, texture: "rough" },
    grain: "rough", grainAmount: 0.5, grainScale: 1.3,
    mods: [opacityP(0.65, 0.08), sizeP(0.5, 0.3)],
  }),
  raster({
    id: "brush_water_dry", name: "Dry Watercolor", family: "artistic", group: "Watercolor",
    size: 54, opacity: 0.65, tip: "grit", hardness: 0.35, density: 0.8, spread: 0.7, irregular: 0.6,
    spacing: 0.07, streamline: 0.22, flow: 0.22,
    wet: { wetness: 0.45, flow: 0.4, evaporation: 0.012, edge: 0.35, granulation: 0.8, texture: "rough" },
    grain: "rough", grainAmount: 0.72, grainScale: 1.9,
    mods: [opacityP(0.7, 0.06), sizeP(0.45, 0.35)],
  }),
  raster({
    id: "brush_ink_bleed", name: "Ink Bleed", family: "artistic", group: "Watercolor",
    size: 46, opacity: 0.85, hardness: 0.45, spacing: 0.06, streamline: 0.3,
    flow: 0.3,
    wet: { wetness: 0.7, flow: 0.9, evaporation: 0.005, edge: 0.22, granulation: 0.2, texture: "fibre" },
    grain: "fibre", grainAmount: 0.45, grainScale: 1.4,
    mods: [sizeP(0.7, 0.15), opacityP(0.4, 0.25)],
  }),
  raster({
    id: "brush_stipple", name: "Stipple", family: "artistic", group: "Illustration",
    size: 12, hardness: 1, spacing: 1.7, streamline: 0.15, jitter: 0.6, scatter: 0.5, flow: 1,
    mods: [m("size", "random", 0.5, { floor: 0.4 }), opacityP(0.4, 0.4)],
  }),
  raster({
    id: "brush_hatch", name: "Hatching", family: "artistic", group: "Illustration",
    size: 28, tip: "hatch", hardness: 1, density: 0.55, spread: 0.6, irregular: 0.25,
    spacing: 0.45, streamline: 0.3, follow: true, flow: 1,
    mods: [opacityP(0.4, 0.4)],
  }),
  raster({
    id: "brush_crosshatch", name: "Crosshatch", family: "artistic", group: "Illustration",
    size: 34, tip: "hatch", hardness: 0.95, density: 0.4, spread: 0.7, irregular: 0.4,
    spacing: 0.6, streamline: 0.2, flow: 1,
    grain: "crosshatch", grainAmount: 0.35,
    mods: [m("angle", "random", 0.35)],
  }),
  raster({
    id: "brush_halftone", name: "Halftone", family: "artistic", group: "Illustration",
    // Spacing > 1 keeps the dots discrete; size ← pressure IS the tone ramp,
    // exactly like a real screen.
    size: 16, hardness: 1, spacing: 1.05, streamline: 0.4, flow: 1,
    mods: [sizeP(0.8, 0.15)],
  }),
  raster({
    id: "brush_comic_tone", name: "Comic Tone", family: "artistic", group: "Illustration",
    size: 40, hardness: 0.95, spacing: 0.05, streamline: 0.35, flow: 1, stamp: "uniform",
    grain: "halftone", grainAmount: 0.9, grainScale: 0.8,
    mods: [opacityP(0.3, 0.5)],
  }),
  raster({
    id: "brush_engrave", name: "Engraving", family: "artistic", group: "Illustration",
    size: 24, tip: "hatch", hardness: 1, density: 0.8, spread: 0.55, irregular: 0.1,
    follow: true, spacing: 0.25, streamline: 0.5, flow: 1,
    mods: [sizeP(0.6, 0.2)],
  }),
];

// ── Elements — stamps ───────────────────────────────────────────────────────
//
// Everything here is a SEPARATE STAMP (spacing ≥ ~0.6) that must not look
// rubber-stamped. Three mods do all the work: angle ← random, size ← random,
// hue ← random. Without them a leaf brush lays down forty identical leaves,
// which is instantly, unmistakably fake.

const ELEMENTS = (): BrushPreset[] => [
  raster({
    id: "brush_el_foliage", name: "Foliage", family: "elements", group: "Nature",
    size: 44, tip: "leaf", hardness: 0.95, spread: 0.55, irregular: 0.4,
    spacing: 0.85, streamline: 0.1, jitter: 0.35, scatter: 0.55, flow: 1,
    mods: [
      m("angle", "random", 1),
      m("size", "random", 0.55, { floor: 0.4 }),
      m("hue", "random", 0.12),
      m("lightness", "random", 0.2),
    ],
  }),
  raster({
    id: "brush_el_grass", name: "Grass", family: "elements", group: "Nature",
    size: 30, tip: "leaf", hardness: 1, spread: 0.18, irregular: 0.6,
    spacing: 0.5, streamline: 0.1, jitter: 0.2, scatter: 0.4, flow: 1,
    mods: [m("angle", "random", 0.22), m("size", "random", 0.5, { floor: 0.4 }), m("lightness", "random", 0.18)],
  }),
  raster({
    id: "brush_el_petals", name: "Petals", family: "elements", group: "Nature",
    size: 36, tip: "leaf", hardness: 0.85, spread: 0.85, irregular: 0.2,
    spacing: 1.1, streamline: 0.1, jitter: 0.5, scatter: 0.6, flow: 1,
    mods: [m("angle", "random", 1), m("size", "random", 0.4, { floor: 0.5 }), m("hue", "random", 0.08)],
  }),
  raster({
    id: "brush_el_clouds", name: "Clouds", family: "elements", group: "Sky",
    size: 130, opacity: 0.55, tip: "spray", density: 0.4, spread: 0.9, irregular: 0.65,
    spacing: 0.22, streamline: 0.15, scatter: 0.45, flow: 0.1, stamp: "uniform",
    mods: [m("size", "random", 0.35, { floor: 0.55 }), opacityP(0.6, 0.05)],
  }),
  raster({
    id: "brush_el_snow", name: "Snow", family: "elements", group: "Sky",
    size: 22, hardness: 0.35, spacing: 1.3, streamline: 0.1, jitter: 0.8, scatter: 0.9, flow: 1,
    mods: [m("size", "random", 0.7, { floor: 0.2 }), m("opacity", "random", 0.5, { floor: 0.35 })],
  }),
  raster({
    id: "brush_el_stars", name: "Stars", family: "elements", group: "Sky",
    size: 26, tip: "sparkle", sides: 4, spread: 0.25, density: 0.3, hardness: 1,
    spacing: 1.6, streamline: 0.1, jitter: 0.7, scatter: 0.8, flow: 1,
    mods: [m("angle", "random", 0.4), m("size", "random", 0.75, { floor: 0.18 })],
  }),
  raster({
    id: "brush_el_sparkle", name: "Sparkle", family: "elements", group: "Sky",
    size: 34, tip: "sparkle", sides: 6, spread: 0.15, density: 0.45, hardness: 1,
    spacing: 1.4, streamline: 0.1, jitter: 0.6, scatter: 0.7, flow: 1, blend: "screen",
    mods: [m("angle", "random", 1), m("size", "random", 0.6, { floor: 0.3 }), m("hue", "random", 0.15)],
  }),
  raster({
    id: "brush_el_bokeh", name: "Bokeh", family: "elements", group: "Sky",
    size: 70, opacity: 0.5, tip: "ring", spread: 0.35, hardness: 0.35,
    spacing: 1.5, streamline: 0.1, jitter: 0.9, scatter: 1, flow: 0.6,
    stamp: "uniform", blend: "screen",
    mods: [m("size", "random", 0.6, { floor: 0.3 }), m("opacity", "random", 0.6, { floor: 0.3 }), m("hue", "random", 0.2)],
  }),
  raster({
    id: "brush_el_confetti", name: "Confetti", family: "elements", group: "Party",
    size: 20, tip: "square", hardness: 1, spacing: 1.25, streamline: 0.1,
    jitter: 0.8, scatter: 0.9, roundness: 0.45, flow: 1,
    mods: [m("angle", "random", 1), m("hue", "random", 1), m("size", "random", 0.45, { floor: 0.45 })],
  }),
  raster({
    id: "brush_el_bubbles", name: "Bubbles", family: "elements", group: "Party",
    size: 46, opacity: 0.7, tip: "ring", spread: 0.65, hardness: 0.8,
    spacing: 1.35, streamline: 0.1, jitter: 0.7, scatter: 0.8, flow: 1,
    mods: [m("size", "random", 0.65, { floor: 0.25 }), m("opacity", "random", 0.4, { floor: 0.5 })],
  }),
];

// ── Abstract — light and motion ─────────────────────────────────────────────
//
// The `strokeT` source (0 → 1 along the stroke) is what this shelf is built
// on: a ribbon that fades as it travels, a comet that thins to nothing. Neither
// is expressible with pressure, and both are what people reach a motion tool
// for.

const ABSTRACT = (): BrushPreset[] => [
  raster({
    id: "brush_ab_neon", name: "Neon", family: "abstract", group: "Light",
    size: 26, opacity: 0.9, hardness: 0.08, spacing: 0.03, streamline: 0.55,
    flow: 0.35, stamp: "uniform", blend: "screen",
    mods: [sizeP(0.4, 0.4), opacityP(0.5, 0.3)],
  }),
  raster({
    id: "brush_ab_glow_pen", name: "Glow Pen", family: "abstract", group: "Light",
    size: 12, hardness: 0.55, spacing: 0.035, streamline: 0.6, flow: 0.7, blend: "screen",
    mods: [sizeP(0.6, 0.2)],
  }),
  raster({
    id: "brush_ab_light_leak", name: "Light Leak", family: "abstract", group: "Light",
    size: 120, opacity: 0.4, hardness: 0.03, spacing: 0.05, streamline: 0.3,
    flow: 0.08, stamp: "uniform", blend: "screen",
    mods: [m("hue", "strokeT", 0.25), opacityP(0.5, 0.15)],
  }),
  raster({
    id: "brush_ab_ribbon", name: "Fading Ribbon", family: "abstract", group: "Motion",
    size: 22, hardness: 0.95, spacing: 0.04, streamline: 0.6, flow: 1,
    mods: [m("opacity", "strokeT", -1, { floor: 0.05 })],
  }),
  raster({
    id: "brush_ab_comet", name: "Comet", family: "abstract", group: "Motion",
    size: 30, hardness: 0.6, spacing: 0.035, streamline: 0.55, flow: 1,
    mods: [m("size", "strokeT", -0.9, { floor: 0.06 }), m("opacity", "strokeT", -0.5, { floor: 0.2 })],
  }),
  raster({
    id: "brush_ab_speed", name: "Speed Line", family: "abstract", group: "Motion",
    // Faster hand = thinner line, hard. The only brush where velocity leads.
    size: 24, hardness: 1, spacing: 0.04, streamline: 0.7, flow: 1,
    taperIn: 20, taperOut: 60,
    mods: [speedSize(-0.9, 0.06)],
  }),
  raster({
    id: "brush_ab_rainbow", name: "Rainbow", family: "abstract", group: "Motion",
    size: 28, hardness: 0.9, spacing: 0.04, streamline: 0.5, flow: 1,
    mods: [m("hue", "strokeT", 1), sizeP(0.4, 0.4)],
  }),
  raster({
    id: "brush_ab_chroma", name: "Chroma Jitter", family: "abstract", group: "Motion",
    size: 32, hardness: 0.8, spacing: 0.12, streamline: 0.35, scatter: 0.3, flow: 0.8,
    mods: [m("hue", "random", 0.35), m("size", "random", 0.4, { floor: 0.5 })],
  }),
];

// ── Retouch — blenders and erasers ──────────────────────────────────────────

const RETOUCH = (): BrushPreset[] => [
  raster({
    id: "brush_rt_smudge", name: "Soft Blend", family: "retouch", group: "Blend",
    size: 40, hardness: 0.25, spacing: 0.03, streamline: 0.35, flow: 1,
    stamp: "uniform",
    mods: [],
  }),
  raster({
    id: "brush_rt_blender", name: "Blender", family: "retouch", group: "Blend",
    size: 60, hardness: 0.1, spacing: 0.03, streamline: 0.4, flow: 1,
    stamp: "uniform",
    mods: [],
  }),
  raster({
    id: "brush_rt_eraser_hard", name: "Hard Eraser", family: "retouch", group: "Erasers",
    size: 24, hardness: 1, spacing: 0.05, streamline: 0.3, flow: 1, erase: true,
    mods: [sizeP(0.5, 0.3)],
  }),
  raster({
    id: "brush_rt_eraser_soft", name: "Soft Eraser", family: "retouch", group: "Erasers",
    size: 50, hardness: 0.15, spacing: 0.04, streamline: 0.25, flow: 0.35,
    stamp: "uniform", erase: true,
    mods: [opacityP(0.8, 0.05), sizeP(0.3, 0.5)],
  }),
  raster({
    id: "brush_rt_eraser_grit", name: "Textured Eraser", family: "retouch", group: "Erasers",
    size: 36, tip: "grit", hardness: 0.5, density: 0.7, spread: 0.5, irregular: 0.7,
    spacing: 0.09, streamline: 0.2, flow: 0.8, erase: true,
    grain: "rough", grainAmount: 0.5,
    mods: [opacityP(0.6, 0.15), sizeP(0.4, 0.35)],
  }),
];

/** The whole raster pack, in shelf order. */
const rasterPack = (): BrushPreset[] => [
  ...PENCILS(),
  ...PENS(),
  ...CALLIGRAPHY(),
  ...PAINTING(),
  ...AIRBRUSH(),
  ...TEXTURES(),
  ...ARTISTIC(),
  ...ELEMENTS(),
  ...ABSTRACT(),
  ...RETOUCH(),
];

// ── Vector pack ─────────────────────────────────────────────────────────────
//
// A vector brush is a stroke stack plus the input behaviour that turns a
// gesture into it. The three knobs that matter, and only those:
//
//   STREAMLINE     how much of the hand's tremor never reaches the page
//   FIT TOLERANCE  how many anchors the result has — the difference between a
//                  line you can edit and a line you can only redraw
//   VARIABLE WIDTH whether pressure is recorded as a width curve (expressive,
//                  becomes a filled outline) or discarded (clean, stays a
//                  stroked path). Monoline brushes must have it OFF; that is
//                  the definition of a monoline.

const line = (patch: Partial<StrokeSet>): StrokeSet => ({ ...defaultStrokeSet(), ...patch });

interface VectorSpec {
  id: string;
  name: string;
  group: string;
  size: number;
  opacity?: number;
  lines: StrokeSet[];
  streamline: number;
  fit: number;
  variable?: boolean;
  widthPressure?: number;
  minWidth?: number;
  straighten?: number;
  autoClose?: number;
  taperIn?: number;
  taperOut?: number;
}

function vector(s: VectorSpec): BrushPreset {
  return createBrushPreset({
    id: s.id,
    name: s.name,
    family: "vector",
    group: s.group,
    engine: "vector",
    builtIn: true,
    size: s.size,
    opacity: s.opacity ?? 1,
    strokePath: {
      spacing: 0.1,
      streamline: s.streamline,
      jitter: 0,
      scatter: 0,
      taperStartPx: s.taperIn ?? 0,
      taperEndPx: s.taperOut ?? 0,
    },
    vector: {
      lines: s.lines,
      fitTolerance: s.fit,
      variableWidth: s.variable ?? false,
      widthPressure: s.widthPressure ?? 0.8,
      minWidth: s.minWidth ?? 0.15,
      autoClosePx: s.autoClose ?? 0,
      straightenPx: s.straighten ?? 0,
    },
  });
}

const vectorPack = (): BrushPreset[] => [
  vector({
    id: "brush_vector_pen", name: "Vector Pen", group: "Pens",
    size: 4, lines: [line({ width: 4, cap: "round", join: "round" })],
    // A PEN answers to pressure. It shipped monoline, and being the first
    // vector brush in the list it is the one armed by default — so the honest
    // report was "pressure does nothing with vector brushes". Monoline is a
    // deliberate look and the three Monolines below still are one; a pen is not.
    streamline: 0.55, fit: 2.5, variable: true, widthPressure: 0.75, minWidth: 0.25,
  }),
  vector({
    id: "brush_vector_monoline", name: "Monoline", group: "Pens",
    // Constant width, few anchors, heavy smoothing — the logo/icon line.
    size: 6, lines: [line({ width: 6, cap: "round", join: "round" })],
    streamline: 0.8, fit: 5, straighten: 2,
  }),
  vector({
    id: "brush_vector_monoline_thin", name: "Monoline Thin", group: "Pens",
    size: 2, lines: [line({ width: 2, cap: "round", join: "round" })],
    streamline: 0.8, fit: 4, straighten: 2,
  }),
  vector({
    id: "brush_vector_monoline_bold", name: "Monoline Bold", group: "Pens",
    size: 14, lines: [line({ width: 14, cap: "round", join: "round" })],
    streamline: 0.82, fit: 6, straighten: 3,
  }),
  vector({
    id: "brush_vector_technical", name: "Technical Line", group: "Pens",
    size: 2, lines: [line({ width: 2, cap: "butt", join: "miter" })],
    streamline: 0.7, fit: 8, straighten: 8,
  }),
  vector({
    id: "brush_vector_brush", name: "Vector Brush", group: "Expressive",
    size: 10,
    lines: [line({
      width: 10, cap: "round", join: "round",
      profile: { startWidth: 0.08, endWidth: 0, startLength: 0.22, endLength: 0.4, ease: 0.4, samples: null },
    })],
    streamline: 0.45, fit: 3.5, variable: true, widthPressure: 0.9, minWidth: 0.05,
  }),
  vector({
    id: "brush_vector_ink", name: "Vector Ink", group: "Expressive",
    size: 14, lines: [line({ width: 14, cap: "round", join: "round" })],
    streamline: 0.6, fit: 3, variable: true, widthPressure: 1, minWidth: 0.04,
    taperIn: 10, taperOut: 34,
  }),
  vector({
    id: "brush_vector_tapered", name: "Tapered Line", group: "Expressive",
    size: 8,
    lines: [line({
      width: 8, cap: "round", join: "round",
      profile: { startWidth: 0, endWidth: 0, startLength: 0.35, endLength: 0.35, ease: 0.5, samples: null },
    })],
    streamline: 0.6, fit: 4,
  }),
  vector({
    id: "brush_vector_marker", name: "Vector Marker", group: "Expressive",
    size: 18, opacity: 0.9, lines: [line({ width: 18, cap: "square", join: "bevel" })],
    streamline: 0.7, fit: 6, minWidth: 1, autoClose: 24, straighten: 3,
  }),
  vector({
    id: "brush_vector_calligraphy", name: "Vector Calligraphy", group: "Expressive",
    size: 16, lines: [line({ width: 16, cap: "butt", join: "miter" })],
    streamline: 0.72, fit: 3.5, variable: true, widthPressure: 1, minWidth: 0.1,
  }),
  vector({
    id: "brush_vector_sketch", name: "Vector Sketch", group: "Expressive",
    // Almost no smoothing and a tight fit: it keeps the wobble on purpose.
    size: 3, lines: [line({ width: 3, cap: "round", join: "round" })],
    streamline: 0.15, fit: 1.5, variable: true, widthPressure: 0.7, minWidth: 0.2,
  }),
  vector({
    id: "brush_vector_double", name: "Double Line", group: "Layered",
    size: 12,
    lines: [line({ width: 12, cap: "round", join: "round" }), line({ width: 4, cap: "round", join: "round" })],
    streamline: 0.7, fit: 5, straighten: 2,
  }),
  vector({
    id: "brush_vector_outline", name: "Outlined Ink", group: "Layered",
    size: 16,
    lines: [line({ width: 16, cap: "round", join: "round" }), line({ width: 10, cap: "round", join: "round" })],
    streamline: 0.6, fit: 4, variable: true, widthPressure: 0.8,
  }),
];


/**
 * Every builtin stroke LOOK, offered as a vector brush you can draw with.
 *
 * A vector brush already IS a stroke stack plus the input behaviour that turns
 * a gesture into it, so hand-writing a brush per look would be writing the
 * library twice — and the two copies would drift the first time a preset was
 * tuned, leaving a "Charcoal" in the picker that no longer matched the
 * Charcoal in the stroke menu. Deriving them means the pen tool and the stroke
 * picker are ONE library seen from two ends: add a preset to `STROKE_SETS` and
 * it is a brush.
 *
 * Only the INPUT half is decided here, per group, because that is genuinely
 * brush knowledge rather than look knowledge: a sprayed line wants loose
 * smoothing and no fitting, a technical dash wants the path straightened hard,
 * an inked line wants heavy streamlining so tremor never reaches the page.
 */
const INPUT_BY_GROUP: Record<string, { streamline: number; fit: number; straighten: number; pressure: number }> = {
  Basics: { streamline: 0.5, fit: 3, straighten: 0, pressure: 0.5 },
  Dashes: { streamline: 0.6, fit: 4, straighten: 2, pressure: 0 },
  Ends: { streamline: 0.6, fit: 4, straighten: 3, pressure: 0 },
  "Hand-drawn": { streamline: 0.35, fit: 3, straighten: 0, pressure: 0.9 },
  "Dry media": { streamline: 0.3, fit: 2.5, straighten: 0, pressure: 0.95 },
  Ink: { streamline: 0.65, fit: 3.5, straighten: 0, pressure: 0.85 },
  Spray: { streamline: 0.2, fit: 6, straighten: 0, pressure: 0.7 },
  Grunge: { streamline: 0.25, fit: 4, straighten: 0, pressure: 0.8 },
  "Multi-line": { streamline: 0.55, fit: 4, straighten: 1, pressure: 0.4 },
};

const DEFAULT_INPUT = { streamline: 0.45, fit: 3, straighten: 0, pressure: 0.7 };

function vectorBrushesFromLibrary(): BrushPreset[] {
  const out: BrushPreset[] = [];
  for (const preset of [...STROKE_SETS, ...STROKE_STACKS]) {
    // A set preset's payload is one look; a stack preset's is several.
    const looks = (Array.isArray(preset.data) ? preset.data : [preset.data]) as Array<Partial<StrokeSet>>;
    const lines = looks.map((look) => ({ ...defaultStrokeSet(), ...look }));
    const widest = Math.max(1, ...lines.map((l) => l.width));
    const input = INPUT_BY_GROUP[preset.group ?? ""] ?? DEFAULT_INPUT;
    out.push(
      vector({
        id: `brush_look_${preset.id.replace(/^builtin:(stroke|stack)-/, "")}`,
        name: preset.name,
        group: preset.group ?? "Looks",
        size: widest,
        lines,
        streamline: input.streamline,
        fit: input.fit,
        // A look that already varies its own width along the stroke must NOT
        // also be driven by pressure, or the two widths multiply and the
        // preset stops looking like its preview.
        variable: false,
        widthPressure: input.pressure,
        minWidth: 0.1,
        straighten: input.straighten,
      }),
    );
  }
  return out;
}

/**
 * Every builtin brush. LAZY and memoised: building the pack means ~130 zod
 * parses, and an app that opens on the timeline should not pay for a brush
 * library it may never show. The store calls this the first time something
 * asks for a brush; every later call is a free array read.
 */
let packCache: BrushPreset[] | null = null;
let coreCache: BrushPreset[] | null = null;

export function defaultBrushes(): BrushPreset[] {
  if (!packCache) packCache = [...coreBrushes(), ...vectorBrushesFromLibrary()];
  return packCache;
}

/**
 * The HAND-WRITTEN brushes only — the pack above, without the vector looks
 * derived from the stroke library.
 *
 * The stroke-stack menu turns brushes back INTO stroke presets, so handing it
 * `defaultBrushes()` would list every look twice: once as the stroke preset it
 * came from, once as the brush derived from it. This is the set that has
 * something of its own to say.
 */
export function coreBrushes(): BrushPreset[] {
  if (!coreCache) coreCache = [...rasterPack(), ...vectorPack()];
  return coreCache;
}
