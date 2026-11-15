"use client";

import { create } from "zustand";
import {
  DRAW_PLACEMENTS,
  FALLOFFS,
  isSculptBrush,
  type DrawPlacement,
  type Falloff,
  type SculptBrush,
  defaultTextStyle,
  type CornerRadius,
  type FrameMode,
  type PartialTextStyle,
  type ShapeKind,
  type TextStyle,
} from "@solomotion/core";
import type { ShapeTool } from "./session";

/**
 * Tool creation defaults — "what the NEXT object I draw looks like", the
 * headless twin of the frame tool's size presets. One persisted store feeds
 * both the per-tool inspector (edit the defaults with the same reusable
 * sections a real layer uses) and the creation paths (shape/text/pen read
 * these when they mint a clip). Ephemeral-but-sticky: it's a preference, not
 * document data, so it lives here and in localStorage, never in the project file.
 *
 * Adding a new creating tool is: one field here + one reader at its creation
 * site + one entry in the inspector registry. Nothing else needs to know.
 */

/**
 * What the NEXT shape looks like. Paint is shared across every shape tool (you
 * want the same fill whether you draw a rect or a star); GEOMETRY is per shape,
 * because the parameter only exists for some of them and its good value differs.
 *
 * It used to be paint plus a lone `cornerRadius`, so every other thing a shape
 * HAS — point count, star depth, vertex rounding, the ellipse arc — could only
 * be set after drawing, by finding the layer and editing it. The tool offered
 * five doors into one shape and no way to say what came through them.
 *
 * Point counts are per tool rather than one shared number: the tool IS the
 * choice of starting geometry (Triangle is the polygon pipeline pre-set to 3),
 * so one count would make arming Star change what Polygon draws.
 */
export interface ShapeDefaults {
  /** null = the brand fill (`brandFillColor`), read when the shape is drawn. */
  fill: string | null;
  strokeOn: boolean;
  stroke: string;
  strokeWidth: number;
  /** Rect: uniform corner radius (px). */
  cornerRadius: number;
  /** Polygon/star/triangle: vertex rounding (px). */
  vertexRadius: number;
  /** Polygon vertex count. */
  polygonPoints: number;
  /** Star point count. */
  starPoints: number;
  /** Star inner radius as a ratio of the outer (0..1) — how deep the points cut. */
  innerRatio: number;
  /** Ellipse arc: how far it sweeps. 360 = a full ellipse. */
  arcSweepDeg: number;
  /** Ellipse arc: where the sweep starts, in degrees (0 = 3 o'clock). */
  arcStartDeg: number;
  /** Ellipse arc: inner-hole radius as a fraction of the outer (0 = solid). */
  arcRatio: number;
}

/** Everything the shape factory needs to mint the shape a tool promises. */
export interface ShapeCreation {
  shape: ShapeKind;
  pointCount: number;
  cornerRadius: CornerRadius;
  radius: number;
  innerRatio: number;
  arcStartDeg: number;
  arcSweepDeg: number;
  arcRatio: number;
}

/**
 * A shape tool + its defaults → the exact shape it draws. ONE answer, asked by
 * the drag preview and by the creation site.
 *
 * They used to answer it separately: the preview hard-coded `cornerRadius: 0,
 * radius: 0, innerRatio: 0.5` while creation read the defaults and then patched
 * the clip afterwards. So the outline you dragged was never the shape you got —
 * a five-point star previewed at 5 no matter what you had set, and a rounded
 * rect previewed sharp. A preview that lies is worse than no preview.
 *
 * Triangle is a polygon(3), reusing the entire polygon pipeline — the tool is
 * just a friendlier door to it, which is why its count is fixed here rather
 * than being a default the user can drift into a pentagon.
 */
export function shapeCreation(tool: ShapeTool, d: ShapeDefaults): ShapeCreation {
  const none: CornerRadius = { tl: 0, tr: 0, br: 0, bl: 0 };
  const base: ShapeCreation = {
    shape: "polygon",
    pointCount: 3,
    cornerRadius: none,
    radius: 0,
    innerRatio: 0.5,
    arcStartDeg: 0,
    arcSweepDeg: 360,
    arcRatio: 0,
  };
  switch (tool) {
    case "rect": {
      const r = Math.max(0, d.cornerRadius);
      return { ...base, shape: "rect", cornerRadius: { tl: r, tr: r, br: r, bl: r } };
    }
    case "ellipse":
      return {
        ...base,
        shape: "ellipse",
        arcSweepDeg: d.arcSweepDeg,
        arcStartDeg: d.arcStartDeg,
        arcRatio: d.arcRatio,
      };
    case "triangle":
      return { ...base, pointCount: 3, radius: d.vertexRadius };
    case "polygon":
      return { ...base, pointCount: Math.max(3, Math.round(d.polygonPoints)), radius: d.vertexRadius };
    case "star":
      return {
        ...base,
        shape: "star",
        pointCount: Math.max(3, Math.round(d.starPoints)),
        radius: d.vertexRadius,
        innerRatio: d.innerRatio,
      };
  }
}

export interface PenDefaults {
  stroke: string;
  strokeWidth: number;
  /** Fill applied to CLOSED paths (open paths stay stroke-only); null = the brand fill. */
  fill: string | null;
}

/**
 * What happens when a pen stroke ENDS on another path — the one decision the
 * pen cannot make for you, because both answers are legitimate art.
 *
 * Two independent facts, deliberately not collapsed into one enum: `connect` is
 * WHAT to do (and is the choice the popover remembers and pre-selects), `ask` is
 * whether to confirm it first. Folding them into "ask | connect | apart" would
 * lose the remembered answer the moment you switched back to asking.
 */
export interface PenJunction {
  /** Join the runs into one path (vs. leave the point sitting on top, unattached). */
  connect: boolean;
  /** Offer the choice at the junction instead of silently applying `connect`. */
  ask: boolean;
}

/**
 * A 3D world's tools: where a drawn stroke lands, and the sculpt brush. The
 * radius is SCREEN px (Blender's default): the same brush covers the same
 * part of the view however far away the shape is.
 */
export interface SculptDefaults {
  brush: SculptBrush;
  radiusPx: number;
  strength: number;
  direction: 1 | -1;
  falloff: Falloff;
  symmetry: [boolean, boolean, boolean];
  frontOnly: boolean;
  pressureRadius: boolean;
  pressureStrength: boolean;
}

export interface WorldToolDefaults {
  placement: DrawPlacement;
  /**
   * How far a stroke drawn ON a surface stands off it, in world units, on top
   * of half its own width (Blender's Surface Offset). Without the half width a
   * stroke's tube sank half into what it was drawn on.
   */
  surfaceOffset: number;
  sculpt: SculptDefaults;
}

export interface ToolDefaultsState {
  text: TextStyle;
  shape: ShapeDefaults;
  pen: PenDefaults;
  penJunction: PenJunction;
  /** The mode the frame tool draws the NEXT frame in (timeline / flipbook / static). */
  frameMode: FrameMode;
  world: WorldToolDefaults;
  setText: (patch: PartialTextStyle) => void;
  setShape: (patch: Partial<ShapeDefaults>) => void;
  setPen: (patch: Partial<PenDefaults>) => void;
  setPenJunction: (patch: Partial<PenJunction>) => void;
  setFrameMode: (mode: FrameMode) => void;
  setPlacement: (placement: DrawPlacement) => void;
  setSurfaceOffset: (units: number) => void;
  setSculpt: (patch: Partial<SculptDefaults>) => void;
}

const STORAGE_KEY = "tm-tool-defaults";

const INITIAL = {
  // Matches createTextClip's built-in default, so nothing changes until edited.
  text: defaultTextStyle(),
  shape: {
    // null, never a hex: the brand fill is the app's primary, read when the
    // shape is drawn (core `brandFillColor`), so it follows the product and
    // the theme instead of being frozen here.
    fill: null,
    strokeOn: false,
    stroke: "#131316",
    strokeWidth: 4,
    cornerRadius: 0,
    vertexRadius: 0,
    polygonPoints: 5,
    starPoints: 5,
    innerRatio: 0.5,
    arcSweepDeg: 360,
    arcStartDeg: 0,
    arcRatio: 0,
  } as ShapeDefaults,
  pen: { stroke: "#F4F2ED", strokeWidth: 4, fill: null } as PenDefaults,
  // Connect by default (the hover preview promises it), and ask the first few
  // times so the choice is discoverable rather than a setting nobody finds.
  penJunction: { connect: true, ask: true } as PenJunction,
  frameMode: "timeline" as FrameMode,
  world: {
    placement: "view",
    surfaceOffset: 0.5,
    // Blender's: a mid-strength Draw, mirrored across X (most things you
    // sculpt are symmetrical, and the one that is not is one click away).
    sculpt: {
      brush: "draw",
      radiusPx: 50,
      strength: 0.5,
      direction: 1,
      falloff: "smooth",
      symmetry: [true, false, false],
      frontOnly: false,
      pressureRadius: false,
      pressureStrength: true,
    },
  } as WorldToolDefaults,
};

type Persisted = Pick<ToolDefaultsState, "text" | "shape" | "pen" | "penJunction" | "frameMode" | "world">;

/** A stored world section, read field by field through the defaults — a value from an older build cannot be a bad one. */
function loadWorld(saved: Partial<WorldToolDefaults> | undefined): WorldToolDefaults {
  const d = INITIAL.world;
  const sc: Partial<SculptDefaults> = saved?.sculpt ?? {};
  const num = (v: unknown, fallback: number, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
  return {
    placement: DRAW_PLACEMENTS.includes(saved?.placement as DrawPlacement) ? saved!.placement! : d.placement,
    surfaceOffset: num(saved?.surfaceOffset, d.surfaceOffset, 0, 100),
    sculpt: {
      brush: typeof sc.brush === "string" && isSculptBrush(sc.brush) ? sc.brush : d.sculpt.brush,
      radiusPx: num(sc.radiusPx, d.sculpt.radiusPx, 2, 600),
      strength: num(sc.strength, d.sculpt.strength, 0, 1),
      direction: sc.direction === -1 ? -1 : 1,
      falloff: FALLOFFS.includes(sc.falloff as Falloff) ? sc.falloff! : d.sculpt.falloff,
      symmetry: Array.isArray(sc.symmetry) && sc.symmetry.length === 3 ? [!!sc.symmetry[0], !!sc.symmetry[1], !!sc.symmetry[2]] : d.sculpt.symmetry,
      frontOnly: typeof sc.frontOnly === "boolean" ? sc.frontOnly : d.sculpt.frontOnly,
      pressureRadius: typeof sc.pressureRadius === "boolean" ? sc.pressureRadius : d.sculpt.pressureRadius,
      pressureStrength: typeof sc.pressureStrength === "boolean" ? sc.pressureStrength : d.sculpt.pressureStrength,
    },
  };
}

/**
 * Fills older builds wrote while they were still the DEFAULT. The store used
 * to persist every field on any edit, so changing a text size froze the
 * shape colour of that day forever and no later default could reach it.
 * Those values read back as "not chosen".
 */
const LEGACY_DEFAULT_FILLS = new Set(["#FF4E6A", "#F5B843"]);
const unfrozen = <T extends { fill?: string | null }>(v: T | undefined): T | undefined =>
  v && typeof v.fill === "string" && LEGACY_DEFAULT_FILLS.has(v.fill.toUpperCase()) ? { ...v, fill: null } : v;

function load(): Persisted {
  if (typeof window === "undefined") return INITIAL;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return INITIAL;
    const saved = JSON.parse(raw) as Partial<typeof INITIAL>;
    // Merge field-by-field so an older saved blob gains any new keys.
    return {
      text: { ...INITIAL.text, ...saved.text },
      shape: { ...INITIAL.shape, ...unfrozen(saved.shape) },
      pen: { ...INITIAL.pen, ...unfrozen(saved.pen) },
      penJunction: { ...INITIAL.penJunction, ...saved.penJunction },
      frameMode:
        saved.frameMode === "flipbook" || saved.frameMode === "static" ? saved.frameMode : INITIAL.frameMode,
      world: loadWorld(saved.world),
    };
  } catch {
    return INITIAL;
  }
}

/** The fields of `v` the user actually changed — a default is never written down. */
function changed<T extends object>(v: T, base: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(v) as Array<keyof T>) {
    if (JSON.stringify(v[k]) !== JSON.stringify(base[k])) out[k] = v[k];
  }
  return out;
}

function persist(s: Persisted) {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        text: changed(s.text, INITIAL.text),
        shape: changed(s.shape, INITIAL.shape),
        pen: changed(s.pen, INITIAL.pen),
        penJunction: changed(s.penJunction, INITIAL.penJunction),
        frameMode: s.frameMode,
        world: s.world,
      }),
    );
  } catch {
    /* storage full / unavailable — defaults just don't persist */
  }
}

export const useToolDefaults = create<ToolDefaultsState>((set, get) => ({
  ...load(),
  setText: (patch) => {
    const text = { ...get().text, ...patch };
    set({ text });
    persist(get());
  },
  setShape: (patch) => {
    const shape = { ...get().shape, ...patch };
    set({ shape });
    persist(get());
  },
  setPen: (patch) => {
    const pen = { ...get().pen, ...patch };
    set({ pen });
    persist(get());
  },
  setPenJunction: (patch) => {
    const penJunction = { ...get().penJunction, ...patch };
    set({ penJunction });
    persist(get());
  },
  setFrameMode: (frameMode) => {
    set({ frameMode });
    persist(get());
  },
  setPlacement: (placement) => {
    set({ world: { ...get().world, placement } });
    persist(get());
  },
  setSurfaceOffset: (surfaceOffset) => {
    set({ world: { ...get().world, surfaceOffset } });
    persist(get());
  },
  setSculpt: (patch) => {
    set({ world: { ...get().world, sculpt: { ...get().world.sculpt, ...patch } } });
    persist(get());
  },
}));
