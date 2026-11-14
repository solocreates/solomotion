import { describe, expect, it } from "vitest";
import {
  buildStrokePlan,
  isDefaultPipeline,
  markerCommands,
  resolveStrokeAt,
  sampleStroke,
  setStrokeScalar,
  STROKE_SCALAR_PATHS,
  strokeScalar,
} from "./stroke";
import { flattenCommands, totalLength } from "./polyline";
import { solidPaint, strokeStyle, type StrokeStyle } from "../schema/vector";
import { brushPresetSchema, createBrushPreset } from "../drawing/brush";
import { coreBrushes } from "../drawing/brush-packs";
import { vectorStroke, widthProfileSamples } from "../drawing/vector-stroke";
import { STROKE_SETS, STROKE_STACKS, brushStackPresets, strokeFromSet, strokesFromStack } from "../presets/stroke-sets";
import { strokeField } from "./stroke-fields";
import { createModulator } from "../animation/modulators";
import type { PathCommand } from "./geometry";
import { parseDocument, serializeDocument } from "../io";
import { createEmptyDocument, createShapeClip } from "../factories";
import { DOCUMENT_VERSION } from "../schema/document";
import { inkedOutlineAt } from "./reveal-strands";

/** A 100px horizontal line — arc length is exactly its width, so every
 *  distance assertion below is checkable by hand. */
const LINE: PathCommand[] = [
  { type: "M", x: 0, y: 0 },
  { type: "L", x: 100, y: 0 },
];

const SQUARE: PathCommand[] = [
  { type: "M", x: 0, y: 0 },
  { type: "L", x: 100, y: 0 },
  { type: "L", x: 100, y: 100 },
  { type: "L", x: 0, y: 100 },
  { type: "Z" },
];

const stroke = (opts: Partial<StrokeStyle> = {}): StrokeStyle =>
  strokeStyle(solidPaint("#000000"), { width: 4, ...opts });

describe("stroke pipeline", () => {
  it("takes the native fast path for a plain stroke — no baked geometry", () => {
    const plan = buildStrokePlan(LINE, stroke());
    expect(plan.ribbon).toBeNull();
    expect(plan.path).toEqual(LINE);
    expect(plan.markers).toEqual([]);
  });

  it("draws nothing for a hidden, zero-width or transparent stroke", () => {
    for (const s of [stroke({ enabled: false }), stroke({ width: 0 }), stroke({ opacity: 0 })]) {
      const plan = buildStrokePlan(LINE, s);
      expect(plan.path).toBeNull();
      expect(plan.ribbon).toBeNull();
    }
  });

  it("trims per stroke, so two strokes on one outline hold different windows", () => {
    const a = buildStrokePlan(LINE, stroke({ trim: { start: 0, end: 0.4, offset: 0 } }));
    const b = buildStrokePlan(LINE, stroke({ trim: { start: 0.6, end: 1, offset: 0 } }));
    expect((a.path!.at(-1) as { x: number }).x).toBeCloseTo(40, 6);
    expect((b.path![0] as { x: number }).x).toBeCloseTo(60, 6);
  });

  it("hands dash + offset to the rasterizer rather than baking it", () => {
    const plan = buildStrokePlan(LINE, stroke({ dash: [8, 4], dashOffset: 3 }));
    expect(plan.dash).toEqual([8, 4]);
    expect(plan.dashOffset).toBe(3);
    expect(plan.ribbon).toBeNull();
  });

  it("bakes a filled ribbon once the profile tapers, and drops the dash into it", () => {
    const plan = buildStrokePlan(LINE, stroke({ profile: { startWidth: 0, endWidth: 1, startLength: 1, endLength: 0, ease: 0, samples: null } }));
    expect(plan.path).toBeNull();
    expect(plan.dash).toEqual([]);
    expect(plan.ribbon).not.toBeNull();
    // The ribbon is a closed outline; at the tapered start its two edges meet.
    const pts = plan.ribbon!.filter((c): c is Extract<PathCommand, { x: number }> => c.type !== "Z");
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    expect(Math.hypot(first.x - last.x, first.y - last.y)).toBeLessThan(0.5);
  });

  it("a dashed tapered stroke bakes one ribbon per dash", () => {
    const plan = buildStrokePlan(LINE, stroke({
      dash: [10, 10],
      profile: { startWidth: 0, endWidth: 0, startLength: 0.5, endLength: 0.5, ease: 0, samples: null },
    }));
    // 100px of line, 20px period → 5 inked runs → 5 closed subpaths.
    expect(plan.ribbon!.filter((c) => c.type === "Z")).toHaveLength(5);
  });

  it("displaces the centre line for a wave but keeps its endpoints", () => {
    const plan = buildStrokePlan(LINE, stroke({ wave: { amplitude: 10, wavelength: 25, phase: 0, roughness: 0, seed: 1 } }));
    const pts = plan.path!.filter((c): c is Extract<PathCommand, { x: number }> => c.type !== "Z");
    expect(pts[0]).toMatchObject({ x: 0, y: 0 });
    expect(pts.at(-1)!.x).toBeCloseTo(100, 5);
    // Somewhere in the middle it has actually moved off the axis.
    expect(Math.max(...pts.map((p) => Math.abs(p.y)))).toBeGreaterThan(1);
  });

  it("a wave is deterministic — the same stroke samples identically every time", () => {
    const s = stroke({ wave: { amplitude: 8, wavelength: 20, phase: 0.25, roughness: 1, seed: 7 } });
    expect(buildStrokePlan(LINE, s).path).toEqual(buildStrokePlan(LINE, s).path);
  });

  it("places endpoint markers on open paths only", () => {
    const open = buildStrokePlan(LINE, stroke({ markers: { start: { kind: "circle", size: 3 }, end: { kind: "arrow", size: 4 } } }));
    expect(open.markers.filter((c) => c.type === "Z")).toHaveLength(2);
    const closed = buildStrokePlan(SQUARE, stroke({ markers: { start: { kind: "arrow", size: 4 }, end: { kind: "arrow", size: 4 } } }));
    expect(closed.markers).toEqual([]);
  });

  it("scales markers with the stroke width and points them outward", () => {
    const thin = markerCommands({ kind: "triangle", size: 4 }, 0, 0, 0, 2);
    const thick = markerCommands({ kind: "triangle", size: 4 }, 0, 0, 0, 8);
    const span = (cmds: PathCommand[]) => {
      const xs = cmds.filter((c): c is Extract<PathCommand, { x: number }> => c.type !== "Z").map((c) => c.x);
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(span(thick)).toBeCloseTo(span(thin) * 4, 5);
    // Tip sits at the anchor, body trails backwards along −x.
    expect(Math.max(...thin.filter((c): c is Extract<PathCommand, { x: number }> => c.type !== "Z").map((c) => c.x))).toBeCloseTo(0, 5);
  });
});

describe("stroke scalars", () => {
  it("every advertised scalar path round-trips through read and write", () => {
    for (const sub of STROKE_SCALAR_PATHS) {
      const s = stroke();
      expect(strokeScalar(s, sub)).toBeDefined();
      // Pick a target inside each field's own domain: the px-scale fields carry
      // a minimum, so a blanket 0.25 would be clamped and read back different.
      const target =
        sub === "wave.wavelength" || sub === "roughness.scale" || sub === "nib.angleDeg" || sub === "scatter.density"
          ? 33
          : sub.endsWith("Offset") || sub === "wave.phase" || sub === "offset"
            ? 3
            : 0.25;
      setStrokeScalar(s, sub, target);
      expect(strokeScalar(s, sub)).toBeCloseTo(target, 6);
    }
  });

  it("sampling returns the stroke itself when nothing is animated", () => {
    const s = stroke();
    expect(sampleStroke(s, () => undefined)).toBe(s);
  });

  it("sampling never mutates the base stroke", () => {
    const s = stroke();
    const sampled = sampleStroke(s, (p) => (p === `stroke.${s.id}.trim.end` ? 0.5 : undefined));
    expect(sampled.trim.end).toBe(0.5);
    expect(s.trim.end).toBe(1);
  });

  it("a fresh stroke is the identity pipeline", () => {
    expect(isDefaultPipeline(stroke())).toBe(true);
    expect(isDefaultPipeline(stroke({ dashOffset: 4 }))).toBe(false);
  });
});

describe("arc-length polylines", () => {
  it("measures a closed square across its seam", () => {
    expect(totalLength(flattenCommands(SQUARE))).toBeCloseTo(400, 4);
  });

  it("flattens a curve finely enough to measure it", () => {
    const quarter: PathCommand[] = [
      { type: "M", x: 0, y: 0 },
      { type: "C", x1: 55.2, y1: 0, x2: 100, y2: 44.8, x: 100, y: 100 },
    ];
    // A quarter circle of radius 100 is ~157px; the chord is ~141.
    expect(totalLength(flattenCommands(quarter))).toBeGreaterThan(150);
  });
});

describe("trim migration (v57 → v58)", () => {
  it("copies a clip's trim onto every stroke and re-addresses its keyframes", () => {
    // Build a REAL clip, then age the document back to v57 the way a stored
    // file looks: trim on the clip, none on the strokes.
    const doc = createEmptyDocument();
    const shape = createShapeClip({ frameId: doc.frames[0]!.id, shape: "rect", startMs: 0 });
    shape.id = "c1";
    shape.strokes = [{ ...strokeStyle(solidPaint("#ffffff"), { width: 2 }), id: "s1" }];
    doc.tracks[0]!.clips.push(shape);

    const raw = JSON.parse(serializeDocument(doc)) as Record<string, unknown>;
    const clips = (raw.tracks as Array<{ clips: Array<Record<string, unknown>> }>)[0]!.clips;
    const c1 = clips.find((c) => c.id === "c1")!;
    c1.trim = { start: 0.1, end: 0.7, offset: 0.25 };
    c1.keyframes = [
      { id: "k1", property: "trim.end", keys: [{ id: "kk1", timeMs: 0, value: 0, easing: { kind: "linear" } }] },
    ];
    for (const s of c1.strokes as Array<Record<string, unknown>>) delete s.trim;
    raw.version = 57;

    const parsed = parseDocument(JSON.stringify(raw));
    expect(parsed.version).toBe(DOCUMENT_VERSION);
    const clip = parsed.tracks.flatMap((t) => t.clips).find((c) => c.id === "c1")!;
    expect(clip.kind).toBe("shape");
    if (clip.kind !== "shape") return;
    expect(clip.strokes[0]!.trim).toEqual({ start: 0.1, end: 0.7, offset: 0.25 });
    expect(clip.keyframes.map((t) => t.property)).toEqual(["stroke.s1.trim.end"]);
    expect("trim" in clip).toBe(false);
  });
});

describe("strokes and vector brushes are one object", () => {
  it("a brush's lines ARE stroke sets — no converter, no second vocabulary", () => {
    const brush = coreBrushes().find((b) => b.engine === "vector")!;
    const [line] = brush.vector.lines;
    // The brush's line answers the same field registry a layer's stroke does.
    expect(strokeField(strokeFromSet(line!, solidPaint("#000")), "cap")).toBe(line!.cap);
    expect(strokeField(strokeFromSet(line!, solidPaint("#000")), "width")).toBe(line!.width);
  });

  it("a vector brush loads as a stroke-stack preset", () => {
    const presets = brushStackPresets(coreBrushes());
    expect(presets.length).toBeGreaterThan(0);
    expect(presets.every((p) => p.kind === "strokeStack")).toBe(true);
    // Identity-free, like every other preset payload.
    for (const p of presets) for (const l of p.data as Array<Record<string, unknown>>) expect(l.id).toBeUndefined();
  });

  it("a legacy brush's cap/join fold into its line rather than being lost", () => {
    const legacy = brushPresetSchema.parse({
      id: "b1", name: "Old", engine: "vector",
      vector: { cap: "square", join: "bevel", fitTolerance: 3 },
    });
    expect(legacy.vector.lines[0]!.cap).toBe("square");
    expect(legacy.vector.lines[0]!.join).toBe("bevel");
  });

  it("a pressure stroke stays a centre line whose width can still be changed", () => {
    const pts = Array.from({ length: 12 }, (_, i) => ({ x: i * 10, y: 0, pressure: i / 11 }));
    const brush = createBrushPreset({ name: "v", engine: "vector", vector: { variableWidth: true } } as never);
    const drawn = vectorStroke(pts, brush, 8)!;
    const stack = strokesFromStack(drawn.lines, solidPaint("#ff0000"));
    // The measurement is placed by the caller — on the layer's ink here, on the
    // drawn CONTOUR in the app, which is what lets one layer hold many strokes
    // that each pressed differently.
    const strokes = [{
      ...stack[0]!,
      profile: { ...stack[0]!.profile, samples: widthProfileSamples(drawn.widths!, stack[0]!.width) },
    }];
    expect(strokes[0]!.profile.samples).not.toBeNull();

    // Widening it re-scales the whole measured curve, because the samples are
    // multipliers — the thing a baked outline could never do.
    const wide = { ...strokes[0]!, width: strokes[0]!.width * 2 };
    const thin = buildStrokePlan(pts.map((p, i) => (i ? { type: "L" as const, x: p.x, y: p.y } : { type: "M" as const, x: p.x, y: p.y })), strokes[0]!);
    const fat = buildStrokePlan(pts.map((p, i) => (i ? { type: "L" as const, x: p.x, y: p.y } : { type: "M" as const, x: p.x, y: p.y })), wide);
    expect(spanY(fat.ribbon!)).toBeGreaterThan(spanY(thin.ribbon!) * 1.8);
  });
});

describe("modulators reach stroke fields", () => {
  it("a wiggle on a stroke path moves it, and keyframes still come first", () => {
    const s = stroke({ width: 10 });
    const mod = createModulator(`stroke.${s.id}.dashOffset`);
    mod.shape = "wave";
    mod.amount = 20;
    mod.rate = 1;

    const still = resolveStrokeAt(s, {});
    expect(still.dashOffset).toBe(0);

    // The signal MODIFIES the animated value, so a keyed offset shifts with it.
    const keyed = resolveStrokeAt(s, {
      sampled: { [`stroke.${s.id}.dashOffset`]: 100 },
      modulators: [mod],
      timeSec: 0.37,
    });
    const unkeyed = resolveStrokeAt(s, { modulators: [mod], timeSec: 0.37 });
    expect(keyed.dashOffset - unkeyed.dashOffset).toBeCloseTo(100, 6);
  });
});

/**
 * Every shipped look must actually DRAW on a curve. A set whose plan comes back
 * empty is a blank tile in the picker — and a blank tile reads as a broken app,
 * not as a subtle preset, so this is the guard that keeps the library honest as
 * it grows.
 */
describe("the shipped stroke sets", () => {
  /** The curve the picker previews on — a taper, a join and a dash all show. */
  const CURVE: PathCommand[] = [
    { type: "M", x: 6, y: 14 },
    { type: "C", x1: 20, y1: 14, x2: 18, y2: 5, x: 32, y: 5 },
    { type: "C", x1: 46, y1: 5, x2: 44, y2: 15, x: 58, y: 15 },
  ];

  it.each(STROKE_SETS.map((p) => [p.name, p] as const))("%s draws geometry", (_name, preset) => {
    const stroke = { ...strokeStyle(solidPaint("#000")), ...(preset.data as object), align: "center" } as StrokeStyle;
    const plan = buildStrokePlan(CURVE, stroke);
    const drawn = (plan.path?.length ?? 0) + (plan.ribbon?.length ?? 0) + plan.markers.length;
    expect(drawn).toBeGreaterThan(0);
  });

  it.each(STROKE_STACKS.map((p) => [p.name, p] as const))("%s draws every line of its stack", (_name, preset) => {
    const stack = preset.data as Array<Record<string, unknown>>;
    expect(stack.length).toBeGreaterThan(1); // a one-line "stack" belongs in STROKE_SETS
    for (const look of stack) {
      const stroke = { ...strokeStyle(solidPaint("#000")), ...look, align: "center" } as StrokeStyle;
      const plan = buildStrokePlan(CURVE, stroke);
      expect((plan.path?.length ?? 0) + (plan.ribbon?.length ?? 0) + plan.markers.length).toBeGreaterThan(0);
    }
  });

  /** Each new stage must actually change the geometry, or the preset that
   *  relies on it is decoration. Guards the identity gates in `needsSampling`. */
  it("each pipeline stage measurably changes the result", () => {
    const plain = { ...strokeStyle(solidPaint("#000")), width: 8, align: "center" } as StrokeStyle;
    const base = buildStrokePlan(CURVE, plain);
    expect(base.path).not.toBeNull(); // identity settings keep the cheap path

    const rough = buildStrokePlan(CURVE, { ...plain, roughness: { amount: 2, scale: 6, spread: 1, erode: 0, seed: 7 } });
    expect(rough.ribbon).not.toBeNull(); // roughness forces a baked outline
    expect(rough.path).toBeNull();

    const nib = buildStrokePlan(CURVE, { ...plain, nib: { angleDeg: 45, ratio: 0.1 } });
    expect(nib.ribbon).not.toBeNull();

    const scatter = buildStrokePlan(CURVE, {
      ...plain,
      scatter: { density: 40, size: 0.5, sizeJitter: 0.5, spread: 3, shape: "round", seed: 2 },
    });
    expect(scatter.ribbon).not.toBeNull();
    expect(scatter.dash).toEqual([]);

    const offset = buildStrokePlan(CURVE, { ...plain, offset: 6 });
    expect(offset.path).not.toBeNull();
    expect(JSON.stringify(offset.path)).not.toEqual(JSON.stringify(base.path));
  });

  /** Seeded, not random: a brush that re-rolled every frame would boil during
   *  playback and differ between the canvas and the exporter. */
  it("rough and scattered strokes are stable across builds", () => {
    const s = { ...strokeStyle(solidPaint("#000")), width: 8, align: "center",
      roughness: { amount: 2, scale: 6, spread: 1, erode: 0.3, seed: 7 } } as StrokeStyle;
    expect(JSON.stringify(buildStrokePlan(CURVE, s))).toEqual(JSON.stringify(buildStrokePlan(CURVE, s)));
    const sc = { ...strokeStyle(solidPaint("#000")), width: 10, align: "center",
      scatter: { density: 50, size: 0.4, sizeJitter: 0.8, spread: 4, shape: "round", seed: 3 } } as StrokeStyle;
    expect(JSON.stringify(buildStrokePlan(CURVE, sc))).toEqual(JSON.stringify(buildStrokePlan(CURVE, sc)));
  });
});

describe("proportional width (baseWidth)", () => {
  const designed = (): StrokeStyle =>
    strokeStyle(solidPaint("#000"), {
      width: 2,
      dash: [6, 4],
      dashOffset: 3,
      wave: { amplitude: 3, wavelength: 40, phase: 0, roughness: 0, seed: 1 },
      roughness: { amount: 1, scale: 12, spread: 1, erode: 0, seed: 1 },
      scatter: { density: 40, size: 0.5, sizeJitter: 0.5, spread: 4, shape: "round", seed: 1 },
      offset: 5,
      profile: { startWidth: 0.5, endWidth: 1, startLength: 0.5, endLength: 0.5, ease: 0, samples: null },
      markers: { start: { kind: "arrow", size: 4 }, end: { kind: "none", size: 4 } },
    });

  it("scales every pixel length with the width, and nothing else", () => {
    const s = { ...designed(), width: 20 }; // designed at 2 → 10x
    const r = resolveStrokeAt(s, {});
    expect(r.dash).toEqual([60, 40]);
    expect(r.dashOffset).toBe(30);
    expect(r.wave.amplitude).toBe(30);
    expect(r.wave.wavelength).toBe(400);
    expect(r.roughness.amount).toBe(10);
    expect(r.roughness.scale).toBe(120);
    expect(r.scatter.spread).toBe(40);
    expect(r.offset).toBe(50);
    // Fractions and width-multiples are ALREADY proportional — scaling them
    // would double-count and is the bug this rule exists to avoid.
    expect(r.profile.startWidth).toBe(0.5);
    expect(r.markers.start.size).toBe(4);
    expect(r.trim).toEqual({ start: 0, end: 1, offset: 0 });
    // Dabs per 100px is the inverse term: bigger dabs, fewer of them.
    expect(r.scatter.density).toBe(4);
  });

  it("leaves the document untouched — the scaled stroke is a copy", () => {
    const s = { ...designed(), width: 20 };
    resolveStrokeAt(s, {});
    expect(s.dash).toEqual([6, 4]);
    expect(s.wave.amplitude).toBe(3);
  });

  it("is identity at the design width, and opt-out when baseWidth is null", () => {
    const same = designed();
    expect(resolveStrokeAt(same, {})).toBe(same);
    const absolute = { ...designed(), width: 20, baseWidth: null };
    expect(resolveStrokeAt(absolute, {}).dash).toEqual([6, 4]);
  });

  it("scales from the ANIMATED width, so growing a line grows its design", () => {
    const s = { ...designed(), id: "s1", width: 2 };
    const r = resolveStrokeAt(s, { sampled: { "stroke.s1.width": 8 } });
    expect(r.width).toBe(8);
    expect(r.dash).toEqual([24, 16]);
  });

  it("a brush scaled to a live size carries its design with it", () => {
    const brush = createBrushPreset({ ...coreBrushes()[0]!, id: "b" });
    brush.vector.lines = [{ ...brush.vector.lines[0]!, width: 4, baseWidth: 4, dash: [8, 4] }];
    const drawn = vectorStroke(
      [
        { x: 0, y: 0, pressure: 1 },
        { x: 50, y: 0, pressure: 1 },
        { x: 100, y: 0, pressure: 1 },
      ],
      brush,
      16,
    );
    const line = drawn!.lines[0]!;
    expect(line.baseWidth).toBe(4);
    const resolved = resolveStrokeAt(strokeFromSet(line, solidPaint("#000")), {});
    expect(resolved.width / 4).toBeCloseTo(resolved.dash[0]! / 8, 5);
  });
});

/** Vertical extent of a ribbon — stands in for "how wide is this stroke". */
function spanY(cmds: PathCommand[]): number {
  const ys = cmds.filter((c): c is Extract<PathCommand, { y: number }> => c.type !== "Z").map((c) => c.y);
  return Math.max(...ys) - Math.min(...ys);
}

describe("inkedOutlineAt — the line as drawn", () => {
  it("cuts the lead visible stroke's trim, so an arc riding the outline stops where the ink does", () => {
    const doc = createEmptyDocument();
    const clip = createShapeClip({ frameId: doc.frames[0]!.id, shape: "rect", startMs: 0, width: 100, height: 100 });
    const whole = totalLength(flattenCommands(inkedOutlineAt(doc, clip, 0, 0)));
    // An invisible stroke above the visible one doesn't decide the window.
    clip.strokes = [stroke({ width: 0, trim: { start: 0, end: 0.1, offset: 0 } }), stroke({ trim: { start: 0, end: 0.25, offset: 0 } })];
    const inked = totalLength(flattenCommands(inkedOutlineAt(doc, clip, 0, 0)));
    expect(whole).toBeGreaterThan(300);
    expect(inked).toBeCloseTo(whole * 0.25, 0);
  });
});
