import { describe, expect, it } from "vitest";
import {
  boundsSpan,
  layerEffectOutsetPx,
  layerRegionPad,
  quadBounds,
  regionRect,
  shutterQuads,
  shutterSeenRect,
  velocityOffsetAt,
  MAX_LAYER_BUFFER_PX,
  type Affine2d,
} from "./layer-region";
import type { Quad } from "./motion";
import type { ShutterPlan } from "./shutter";

/** A square of side `s` centred on the origin. */
const square = (s: number): Quad => [
  { x: -s / 2, y: -s / 2 },
  { x: s / 2, y: -s / 2 },
  { x: s / 2, y: s / 2 },
  { x: -s / 2, y: s / 2 },
];

const rotated = (q: Quad, deg: number): Quad => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return q.map((p) => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c })) as Quad;
};

const scaled = (q: Quad, k: number): Quad => q.map((p) => ({ x: p.x * k, y: p.y * k })) as Quad;

const plan = (over: Partial<ShutterPlan> = {}): ShutterPlan =>
  ({
    samples: [
      { timeMs: 0, weight: 0.5 },
      { timeMs: 10, weight: 0.5 },
    ],
    openMs: 0,
    closeMs: 10,
    motionPx: 40,
    motion: { px: 40, dx: 0, dy: 0, rotationDeg: 0, scaleRatio: 1 },
    tier: "transform",
    settings: {} as ShutterPlan["settings"],
    ...over,
  }) as ShutterPlan;

describe("the swept region", () => {
  it("reserves room for a spin whose centre never moves", () => {
    // THE BUG: a square rotating about its own pivot has zero mean corner
    // displacement, so the old `travel` pad was 0 and the smear was cut off at
    // the frame-time silhouette. The union has to be the circumscribed box.
    const base = square(100);
    const quads = shutterQuads(plan(), 0, base, (t) => rotated(base, t === 0 ? 0 : 45));
    const b = quadBounds(quads);
    // A 100px square turned 45° spans 100·√2 ≈ 141.4.
    expect(boundsSpan(b)).toBeCloseTo(100 * Math.SQRT2, 3);
    expect(boundsSpan(b)).toBeGreaterThan(boundsSpan(quadBounds([base])));
  });

  it("reserves room for a scale whose centre never moves", () => {
    const base = square(100);
    const quads = shutterQuads(plan(), 0, base, (t) => scaled(base, t === 0 ? 1 : 2));
    expect(boundsSpan(quadBounds(quads))).toBeCloseTo(200, 6);
  });

  it("keeps the crisp frame-time quad even when no sample lands on it", () => {
    // `strength < 1` composites the un-smeared layer underneath, so the base
    // quad is part of the region whether or not a sample sits at localMs.
    const base = square(100);
    const quads = shutterQuads(plan(), 0, base, () => scaled(base, 4));
    expect(quads[0]).toEqual(base);
  });

  it("smears the velocity tier along the measured vector, straddling the frame", () => {
    const p = plan({
      tier: "velocity",
      motion: { px: 40, dx: 40, dy: 0, rotationDeg: 0, scaleRatio: 1 },
      samples: [
        { timeMs: 0, weight: 0.5 },
        { timeMs: 10, weight: 0.5 },
      ],
    });
    // localMs sits mid-window, so the streak reaches half a vector each way.
    expect(velocityOffsetAt(p, 0, 5).x).toBeCloseTo(-20, 6);
    expect(velocityOffsetAt(p, 10, 5).x).toBeCloseTo(20, 6);
    const b = quadBounds(shutterQuads(p, 5, square(100), () => square(1)));
    expect(b.minX).toBeCloseTo(-70, 6);
    expect(b.maxX).toBeCloseTo(70, 6);
    // A straight-line tier must not reserve room in the axis it never moves in.
    expect(b.minY).toBeCloseTo(-50, 6);
  });

  it("reaches the shutter's open and close, where each bin's sub-steps end, for a plan sampled at bin centres", () => {
    // Two bins over 0..10 ms, sampled at 2.5 and 7.5; the layer slides 4 px/ms.
    const p = plan({ samples: [{ timeMs: 2.5, weight: 0.5 }, { timeMs: 7.5, weight: 0.5 }] });
    const at = (t: number) => square(10).map((q) => ({ x: q.x + 4 * t, y: q.y })) as Quad;
    const b = quadBounds(shutterQuads(p, 5, at(5), at));
    expect(b.minX).toBeCloseTo(-5, 9);
    expect(b.maxX).toBeCloseTo(45, 9);
  });

  it("does not divide by a zero-length window", () => {
    const p = plan({ openMs: 4, closeMs: 4, tier: "velocity" });
    expect(velocityOffsetAt(p, 4, 4).x).toBe(0);
    expect(velocityOffsetAt(p, 4, 4).y).toBe(0);
  });
});

describe("the outset", () => {
  const sampled = {};

  it("reaches three sigma past a blur so the buffer never clips its tail", () => {
    const clip = { effects: [{ id: "a", type: "blur", enabled: true, radius: 10 }] } as never;
    expect(layerEffectOutsetPx(clip, sampled, 100)).toBe(30);
  });

  it("follows an animated radius rather than the authored one", () => {
    const clip = { effects: [{ id: "a", type: "blur", enabled: true, radius: 10 }] } as never;
    expect(layerEffectOutsetPx(clip, { "lfx.a.radius": 40 }, 100)).toBe(120);
  });

  it("ignores a switched-off effect", () => {
    const clip = { effects: [{ id: "a", type: "blur", enabled: false, radius: 10 }] } as never;
    expect(layerEffectOutsetPx(clip, sampled, 100)).toBe(0);
  });

  it("counts an outside stroke's full width and an inside stroke's none", () => {
    const out = { strokes: [{ id: "s", opacity: 1, width: 12, align: "outside" }] } as never;
    const inn = { strokes: [{ id: "s", opacity: 1, width: 12, align: "inside" }] } as never;
    expect(layerEffectOutsetPx(out, sampled, 100)).toBe(12);
    expect(layerEffectOutsetPx(inn, sampled, 100)).toBe(0);
  });

  it("reserves room for a per-glyph glow the layer stack never sees", () => {
    // `tfx.` passes live on the resolved TEXT STYLE, so an outset that only
    // walked `clip.effects` squared off every text glow at the buffer wall.
    const clip = { textEffects: [[{ id: "g", type: "glow", enabled: true, opacity: 1, radius: 20 }]] } as never;
    expect(layerEffectOutsetPx(clip, sampled, 100)).toBe(30);
  });

  it("takes the biggest halo any RANGE casts, not the base style's", () => {
    const clip = {
      textEffects: [
        [{ id: "g", type: "glow", enabled: true, opacity: 1, radius: 4 }],
        [{ id: "g", type: "glow", enabled: true, opacity: 1, radius: 40 }],
      ],
    } as never;
    expect(layerEffectOutsetPx(clip, sampled, 100)).toBe(60);
  });

  it("ignores a fully transparent per-glyph pass", () => {
    const clip = { textEffects: [[{ id: "g", type: "glow", enabled: true, opacity: 0, radius: 20 }]] } as never;
    expect(layerEffectOutsetPx(clip, sampled, 100)).toBe(0);
  });

  it("is the same pad both buffers ask for", () => {
    const clip = { effects: [{ id: "a", type: "blur", enabled: true, radius: 10 }] } as never;
    // feather*2 + outset + 4 slack.
    expect(layerRegionPad(clip, sampled, 5, 100)).toBe(10 + 30 + 4);
  });
});

describe("the rect", () => {
  it("places centre-origin bounds against the frame centre", () => {
    const r = regionRect({ minX: -50, minY: -25, maxX: 50, maxY: 25 }, 10, { x: 640, y: 360 });
    expect(r).toEqual({ x: 580, y: 325, width: 120, height: 70 });
  });

  it("leaves already-frame-space bounds where they are", () => {
    const r = regionRect({ minX: 100, minY: 200, maxX: 140, maxY: 260 }, 0);
    expect(r).toEqual({ x: 100, y: 200, width: 40, height: 60 });
  });

  it("never returns a zero-size buffer", () => {
    const r = regionRect({ minX: 0, minY: 0, maxX: 0, maxY: 0 }, 0);
    expect(r.width).toBe(1);
    expect(r.height).toBe(1);
  });
});

describe("shutterSeenRect — a scale-animated group stays at output resolution", () => {
  // The "How ideas go viral" camera: a group 7260×12060 frame px at ×4.2 on a
  // 1080×1920 frame, easing out. Integrated whole, its shutter buffer was capped
  // at 4096 px — a third of the output — and every blurred zoom went blocky.
  const frame = { x: 0, y: 0, width: 1080, height: 1920 };
  const whole = { x: -3090, y: -5070, width: 7260, height: 12060 };
  /** Scale by k about the frame centre, as an affine. */
  const zoomAbout = (k: number): Affine2d => [k, 0, 0, k, 540 * (1 - k), 960 * (1 - k)];
  // Pullbacks D⁻¹ of a shutter whose samples shrink the picture by up to 4%.
  const pullbacks = [1, 1 / 0.98, 1 / 0.96, 1 / 1.02].map(zoomAbout);

  it("cuts the region to what can land on the frame, so it fits one buffer at 1:1", () => {
    const cut = shutterSeenRect(whole, frame, pullbacks)!;
    expect(cut).not.toBeNull();
    expect(Math.max(cut.width, cut.height)).toBeLessThan(MAX_LAYER_BUFFER_PX);
    // Buffer px per frame px at an export's zoom of 1 — never below the output.
    expect(Math.min(1, MAX_LAYER_BUFFER_PX / Math.max(cut.width, cut.height))).toBe(1);
    // The sum is read over the whole frame…
    expect(cut.x).toBeLessThanOrEqual(0);
    expect(cut.y).toBeLessThanOrEqual(0);
    expect(cut.x + cut.width).toBeGreaterThanOrEqual(1080);
    expect(cut.y + cut.height).toBeGreaterThanOrEqual(1920);
    // …and every sample's source pixels are inside it (the ×1/0.96 pullback is the widest).
    expect(cut.width).toBeCloseTo(1080 / 0.96, 3);
    expect(cut.height).toBeCloseTo(1920 / 0.96, 3);
  });

  it("holds a translated sample's source, not just the frame", () => {
    const cut = shutterSeenRect(whole, frame, [[1, 0, 0, 1, 0, 0], [1, 0, 0, 1, -300, 0]])!;
    expect(cut.x).toBeCloseTo(-300, 6);
    expect(cut.x + cut.width).toBeCloseTo(1080, 6);
  });

  it("never grows past the layer, and keeps a layer that is all on screen whole", () => {
    const small = { x: 100, y: 100, width: 400, height: 400 };
    expect(shutterSeenRect(small, frame, pullbacks)).toBeNull();
    const cut = shutterSeenRect({ x: 500, y: -5000, width: 6000, height: 6000 }, frame, pullbacks)!;
    expect(cut.x).toBe(500);
    expect(cut.y + cut.height).toBeCloseTo(1000, 6);
  });

  it("is empty when nothing of the layer can reach the frame", () => {
    const cut = shutterSeenRect({ x: 5000, y: 5000, width: 9000, height: 9000 }, frame, pullbacks)!;
    expect(cut.width * cut.height).toBeLessThan(1e-6);
  });
});
