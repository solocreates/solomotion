import { describe, expect, it } from "vitest";
import { DEFAULT_PRESSURE_SETTINGS, type PenSample } from "./pressure";
import { StrokeEngine } from "./stroke-engine";
import { brushMod, createBrushPreset, type BrushPreset } from "./brush";
import { coreBrushes, defaultBrushes } from "./brush-packs";
import { tipStencil, DEFAULT_TIP_PARAMS, TIP_KINDS } from "./tips";
import { grainTile, GRAIN_TEXTURES, GRAIN_TILE } from "./grain";

/** A straight, constant-pressure drag — the simplest thing that makes dabs. */
function drag(brush: BrushPreset, opts: { pressure?: number; steps?: number; dx?: number } = {}) {
  const { pressure = 0.5, steps = 40, dx = 6 } = opts;
  const engine = new StrokeEngine(brush, DEFAULT_PRESSURE_SETTINGS, brush.size, brush.opacity, 9);
  const dabs = [];
  for (let i = 0; i <= steps; i++) {
    const s: PenSample = { x: 10 + i * dx, y: 40, pressure, tiltX: 0, tiltY: 0, timeMs: i * 8 };
    dabs.push(...engine.feed(s));
  }
  return dabs;
}

describe("tip stencils", () => {
  it("every family produces marks — none is silently empty", () => {
    for (const kind of TIP_KINDS) {
      const s = tipStencil(kind, DEFAULT_TIP_PARAMS, 3);
      const marks = s.polys.length + s.dots.length + (s.mask ? 1 : 0);
      expect(marks, `${kind} drew nothing`).toBeGreaterThan(0);
    }
  });

  it("is deterministic — the same seed is the same tip, forever", () => {
    const a = tipStencil("bristle", DEFAULT_TIP_PARAMS, 42);
    const b = tipStencil("bristle", DEFAULT_TIP_PARAMS, 42);
    const c = tipStencil("bristle", DEFAULT_TIP_PARAMS, 43);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("stays inside the unit box, so a dab never paints outside its own size", () => {
    for (const kind of TIP_KINDS) {
      const s = tipStencil(kind, DEFAULT_TIP_PARAMS, 5);
      for (const p of s.polys.flat()) {
        expect(Math.hypot(p.x, p.y), kind).toBeLessThanOrEqual(1.5);
      }
      for (const d of s.dots) {
        expect(Math.hypot(d.x, d.y) + d.r, kind).toBeLessThanOrEqual(1.6);
      }
    }
  });

  it("density actually adds marks — the control is not decorative", () => {
    const sparse = tipStencil("bristle", { ...DEFAULT_TIP_PARAMS, density: 0.1 }, 1);
    const dense = tipStencil("bristle", { ...DEFAULT_TIP_PARAMS, density: 0.9 }, 1);
    expect(dense.dots.length).toBeGreaterThan(sparse.dots.length);
  });
});

describe("grain", () => {
  it("every texture fills a tile with real variation", () => {
    for (const texture of GRAIN_TEXTURES) {
      const tile = grainTile(texture, 2);
      expect(tile.length).toBe(GRAIN_TILE * GRAIN_TILE);
      const min = Math.min(...tile);
      const max = Math.max(...tile);
      expect(max - min, `${texture} is flat`).toBeGreaterThan(20);
    }
  });

  it("tiles seamlessly — the noise families wrap at the edge", () => {
    // A visible seam is the one failure mode of a generated paper, and it only
    // shows once it is tiled across a canvas — far too late to notice by eye.
    const tile = grainTile("paper", 4);
    let worst = 0;
    for (let y = 0; y < GRAIN_TILE; y++) {
      worst = Math.max(worst, Math.abs(tile[y * GRAIN_TILE]! - tile[y * GRAIN_TILE + GRAIN_TILE - 1]!));
    }
    // Adjacent columns of a continuous field differ a little; a seam is a cliff.
    expect(worst).toBeLessThan(90);
  });
});

describe("modulation", () => {
  const base = (mods: BrushPreset["dynamics"]["mods"]) =>
    createBrushPreset({
      name: "t", size: 20, id: "t",
      shape: { type: "round", hardness: 1 },
      strokePath: { spacing: 0.5, streamline: 0 },
      dynamics: { mods, flow: 1 },
    });

  it("pressure → size scales the dab, and the floor holds the minimum", () => {
    const brush = base([brushMod("size", "pressure", 1, { floor: 0.25 })]);
    const heavy = drag(brush, { pressure: 1 });
    const light = drag(brush, { pressure: 0 });
    expect(heavy[5]!.size).toBeGreaterThan(light[5]!.size);
    expect(light[5]!.size).toBeGreaterThanOrEqual(20 * 0.25 * 0.9);
  });

  it("a negative amount INVERTS rather than subtracting — one control, both directions", () => {
    const up = drag(base([brushMod("size", "pressure", 1)]), { pressure: 1 });
    const down = drag(base([brushMod("size", "pressure", -1)]), { pressure: 1 });
    expect(up[5]!.size).toBeGreaterThan(down[5]!.size);
  });

  it("multiplicative mods COMPOSE — two half-strength mods never cancel", () => {
    const one = drag(base([brushMod("size", "pressure", 0.5)]), { pressure: 0 });
    const two = drag(
      base([brushMod("size", "pressure", 0.5), brushMod("size", "pressure", 0.5)]),
      { pressure: 0 },
    );
    expect(two[5]!.size).toBeLessThan(one[5]!.size);
  });

  it("random angle actually varies per dab — a stamp brush is not a rubber stamp", () => {
    const dabs = drag(base([brushMod("angle", "random", 1)]));
    const angles = new Set(dabs.map((d) => d.angle.toFixed(4)));
    expect(angles.size).toBeGreaterThan(dabs.length * 0.8);
  });

  it("one random draw feeds every mod on a dab, so a leaf keeps its own colour", () => {
    // Hue and lightness both ride `random`; if each drew its own number the
    // two would decorrelate and a stamp would rotate as one leaf and tint as
    // another.
    const dabs = drag(base([brushMod("hue", "random", 1), brushMod("lightness", "random", 1)]));
    for (const d of dabs) {
      expect(d.hue / 180).toBeCloseTo(d.lightness, 5);
    }
  });

  it("strokeT runs forward along the stroke — ribbons fade, comets thin", () => {
    const dabs = drag(base([brushMod("opacity", "strokeT", -1, { floor: 0 })]), { steps: 60 });
    expect(dabs.at(-1)!.alpha).toBeLessThan(dabs[0]!.alpha);
  });

  it("a brush with no mods is flat — pressure changes nothing", () => {
    const brush = base([]);
    expect(drag(brush, { pressure: 1 })[5]!.size).toBeCloseTo(drag(brush, { pressure: 0.1 })[5]!.size, 6);
  });
});

describe("the factory pack", () => {
  const pack = defaultBrushes();

  it("ships a real library across every family", () => {
    expect(pack.length).toBeGreaterThan(80);
    const rasters = pack.filter((b) => b.engine === "raster");
    expect(rasters.length).toBeGreaterThanOrEqual(50);
    expect(new Set(rasters.map((b) => b.family)).size).toBeGreaterThanOrEqual(8);
  });

  it("has no duplicate ids — the override map is keyed by them", () => {
    const ids = pack.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is memoised — the second call is the same array, not a rebuild", () => {
    expect(defaultBrushes()).toBe(pack);
    expect(coreBrushes()).toBe(coreBrushes());
  });

  it("every brush actually paints", () => {
    for (const brush of coreBrushes().filter((b) => b.engine === "raster")) {
      const dabs = drag(brush, { pressure: 0.7 });
      expect(dabs.length, `${brush.name} laid down nothing`).toBeGreaterThan(0);
      for (const d of dabs) {
        expect(Number.isFinite(d.size) && d.size > 0, `${brush.name} size`).toBe(true);
        expect(d.alpha, `${brush.name} alpha`).toBeGreaterThan(0);
      }
    }
  });

  it("pens hold their ink: a pen thins under pressure, it does not fade", () => {
    // The single most common way a "pen" ends up feeling like a marker.
    for (const id of ["brush_pen_technical", "brush_pen_studio", "brush_pen_brush", "brush_pen_monoline"]) {
      const pen = pack.find((b) => b.id === id)!;
      expect(pen.dynamics.mods.some((m) => m.target === "opacity"), pen.name).toBe(false);
    }
  });

  it("a monoline is constant width — that IS the definition", () => {
    for (const id of ["brush_pen_monoline", "brush_pen_monoline_bold", "brush_pen_technical"]) {
      const b = pack.find((x) => x.id === id)!;
      expect(b.dynamics.mods.filter((m) => m.target === "size"), b.name).toHaveLength(0);
    }
    const vectorMono = pack.find((b) => b.id === "brush_vector_monoline")!;
    expect(vectorMono.vector.variableWidth).toBe(false);
  });

  it("dry media fight paper; wet media do not", () => {
    for (const id of ["brush_pencil_6b", "brush_charcoal", "brush_crayon", "brush_pastel_soft"]) {
      expect(pack.find((b) => b.id === id)!.grain.intensity, id).toBeGreaterThan(0.3);
    }
    for (const id of ["brush_pen_technical", "brush_air_soft", "brush_paint_gouache"]) {
      expect(pack.find((b) => b.id === id)!.grain.intensity, id).toBeLessThan(0.2);
    }
  });

  it("airbrushes build up gradually; markers accumulate per stamp", () => {
    for (const id of ["brush_air_soft", "brush_air_medium", "brush_water_wash"]) {
      const b = pack.find((x) => x.id === id)!;
      expect(b.rendering.stamp, id).toBe("uniform");
      expect(b.dynamics.flow, id).toBeLessThan(0.25);
    }
    expect(pack.find((b) => b.id === "brush_pen_marker")!.rendering.stamp).toBe("glaze");
  });

  it("bristle brushes streak — their spacing keeps the hairs continuous", () => {
    for (const b of coreBrushes().filter((x) => x.shape.type === "bristle")) {
      expect(b.strokePath.spacing, b.name).toBeLessThan(0.06);
      expect(b.shape.followStroke, b.name).toBe(true);
    }
  });

  it("organic stamp brushes vary per dab, or they read as a rubber stamp", () => {
    // Regular lattices are exempt and deliberately so: a halftone screen that
    // jittered would stop being a screen. Everything that depicts a natural
    // thing — leaves, snow, splatter — must vary or it is instantly fake.
    const REGULAR = new Set(["Illustration"]);
    for (const b of coreBrushes().filter((x) => x.strokePath.spacing >= 0.8 && !REGULAR.has(x.group ?? ""))) {
      const varies = b.dynamics.mods.some((m) => m.source === "random");
      expect(varies, `${b.name} stamps identically every time`).toBe(true);
    }
  });

  it("a broad nib takes its width from direction, never from a rotating tip", () => {
    const nib = pack.find((b) => b.id === "brush_calli_broad")!;
    expect(nib.shape.type).toBe("chisel");
    expect(nib.shape.followStroke).toBe(false);
    expect(nib.dynamics.mods.some((m) => m.target === "size")).toBe(false);
  });
});

describe("legacy libraries", () => {
  it("a v1 brush's four named dynamics fold into the mod list", () => {
    const old = {
      id: "b", name: "Old", engine: "raster",
      dynamics: { sizePressure: 0.8, opacityPressure: 0.5, sizeVelocity: 0.3, sizeTilt: 0, flow: 0.9, minSize: 0.2, minOpacity: 0.1 },
    };
    const brush = createBrushPreset(old as never);
    const size = brush.dynamics.mods.find((m) => m.target === "size" && m.source === "pressure")!;
    expect(size.amount).toBeCloseTo(0.8);
    expect(size.floor).toBeCloseTo(0.2);
    expect(brush.dynamics.flow).toBeCloseTo(0.9);
    // sizeVelocity was "positive = thins when fast", which is a NEGATIVE mod.
    expect(brush.dynamics.mods.find((m) => m.source === "velocity")!.amount).toBeCloseTo(-0.3);
    // A zero response was never a response — it does not become a dead mod.
    expect(brush.dynamics.mods.some((m) => m.source === "tilt")).toBe(false);
  });
});

describe("particle tips", () => {
  const particle = (weights: number[]) =>
    createBrushPreset({
      name: "p", id: "p",
      shape: {
        type: "image",
        sources: weights.map((weight, i) => ({ id: `s${i}`, assetId: `a${i}`, weight })),
      },
      strokePath: { spacing: 0.6, streamline: 0 },
      dynamics: { mods: [], flow: 1 },
    });

  it("one source is a plain image brush — every dab is the same stamp", () => {
    expect(new Set(drag(particle([1])).map((d) => d.variant))).toEqual(new Set([0]));
  });

  it("several sources deal a different stamp per dab", () => {
    const seen = new Set(drag(particle([1, 1, 1]), { steps: 80 }).map((d) => d.variant));
    expect(seen.size).toBe(3);
  });

  it("weights bias the deal — a heavy entry lands more often", () => {
    const dabs = drag(particle([1, 7]), { steps: 200 });
    const heavy = dabs.filter((d) => d.variant === 1).length;
    expect(heavy / dabs.length).toBeGreaterThan(0.6);
  });

  it("never indexes past the set, whatever the weights", () => {
    for (const dab of drag(particle([0, 0, 0]), { steps: 60 })) {
      expect(dab.variant).toBeGreaterThanOrEqual(0);
      expect(dab.variant).toBeLessThan(3);
    }
  });

  it("a legacy single-bitmap tip folds into the source list", () => {
    const brush = createBrushPreset({ name: "old", shape: { type: "image", imageId: "asset_1" } as never });
    expect(brush.shape.sources).toHaveLength(1);
    expect(brush.shape.sources[0]!.assetId).toBe("asset_1");
  });
});
