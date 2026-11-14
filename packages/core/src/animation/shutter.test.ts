import { describe, expect, it } from "vitest";
import { CENTER_ANCHOR, type LayerBox } from "../transform-map";
import { MOTION_EPSILON_PX, MOTION_FULL_PX, poseMotion, poseQuad, motionSpeed, type LayerPose } from "./motion";
import {
  POLICY_FAST,
  POLICY_FULL,
  POLICY_OFF,
  resolveMotionBlur,
  resolveShutter,
  shutterExposure,
  shutterSubsteps,
  shutterWeight,
  shutterWindow,
  VELOCITY_TIER_SAMPLES,
} from "./shutter";
import { motionBlurSettingsSchema, frameMotionBlurSchema, clipMotionBlurSchema } from "../schema/motion-blur";
import type { Frame } from "../schema/document";
import type { Clip } from "../schema/clips";
import { createLayerEffect } from "./layer-effects";
import type { GlassEffect } from "../schema/layer-effects";

const BOX: LayerBox = { width: 100, height: 100, cx: 0, cy: 0 };
const pose = (p: Partial<LayerPose> = {}): LayerPose => ({
  x: 0, y: 0, scale: 1, scaleY: 1, rotation: 0, skewX: 0, skewY: 0, anchor: CENTER_ANCHOR, ...p,
});
const settings = (p: Parameters<typeof motionBlurSettingsSchema.parse>[0] = {}) =>
  motionBlurSettingsSchema.parse(p);

const frameWith = (mb: Parameters<typeof frameMotionBlurSchema.parse>[0]): Frame =>
  ({ motionBlur: frameMotionBlurSchema.parse(mb) }) as Frame;
const clipWith = (mb: Parameters<typeof clipMotionBlurSchema.parse>[0]): Pick<Clip, "motionBlur"> => ({
  motionBlur: clipMotionBlurSchema.parse(mb),
});

describe("measurement", () => {
  it("a pure translation moves every corner by the same amount", () => {
    const m = poseMotion(pose(), pose({ x: 30, y: 40 }), BOX);
    expect(m.px).toBeCloseTo(50);
    expect(m.dx).toBeCloseTo(30);
    expect(m.dy).toBeCloseTo(40);
  });

  it("a spin about the centre moves the CORNERS while the centre stays put", () => {
    // The whole reason displacement is measured at corners: a centre-based
    // measure would call this still, and it is the most obviously moving thing
    // a motion tool renders.
    const m = poseMotion(pose(), pose({ rotation: 90 }), BOX);
    // Each corner sits 50√2 from the centre, so a quarter turn is a chord of
    // exactly 100 — very visible motion, zero centre displacement.
    expect(m.px).toBeCloseTo(100);
    expect(m.dx).toBeCloseTo(0);
    expect(m.dy).toBeCloseTo(0);
    expect(m.rotationDeg).toBe(90);
  });

  it("scaling is motion", () => {
    const m = poseMotion(pose(), pose({ scale: 2, scaleY: 2 }), BOX);
    expect(m.px).toBeGreaterThan(MOTION_EPSILON_PX);
    expect(m.scaleRatio).toBe(2);
  });

  it("a still layer measures zero, whatever its transform", () => {
    const p = pose({ x: 500, y: -200, rotation: 33, scale: 2.5, skewX: 12 });
    expect(poseMotion(p, p, BOX).px).toBe(0);
  });

  it("the quad respects a non-centre pivot", () => {
    // Rotating about a corner pivot must swing the box, not spin it in place.
    const centre = poseQuad(pose({ rotation: 180 }), BOX);
    const corner = poseQuad(pose({ rotation: 180, anchor: { x: 0, y: 0 } }), BOX);
    expect(centre[0]!.x).not.toBeCloseTo(corner[0]!.x);
  });

  it("speed is per SECOND, so it survives a rate change", () => {
    const m = poseMotion(pose(), pose({ x: 10 }), BOX);
    // 10px over one 24fps frame and over one 60fps frame are different speeds…
    expect(motionSpeed(m, 1000 / 24)).toBeCloseTo(240);
    expect(motionSpeed(m, 1000 / 60)).toBeCloseTo(600);
    // …but 240px/s stays 240px/s however the comp is re-rated.
  });
});

describe("the shutter window", () => {
  it("a 180° shutter at the default phase straddles the frame", () => {
    const w = shutterWindow(1000 / 24, 1000, settings());
    expect(w.openMs).toBeCloseTo(1000 - (1000 / 24) / 4);
    expect(w.closeMs).toBeCloseTo(1000 + (1000 / 24) / 4);
    expect((w.openMs + w.closeMs) / 2).toBeCloseTo(1000);
  });

  it("the exposure is a fraction of the COMP's frame, so a slower comp exposes longer", () => {
    const s = settings({ shutterAngle: 360 });
    const fast = shutterWindow(1000 / 60, 0, s);
    const slow = shutterWindow(1000 / 12, 0, s);
    expect(slow.closeMs - slow.openMs).toBeCloseTo(5 * (fast.closeMs - fast.openMs));
  });

  it("a zero angle exposes nothing", () => {
    const w = shutterWindow(1000 / 24, 0, settings({ shutterAngle: 0 }));
    expect(w.closeMs).toBeCloseTo(w.openMs);
  });
});

describe("weighting", () => {
  it("box is uniform; a trail fades into the past, a lead into the future", () => {
    expect(shutterWeight("box", 0)).toBe(shutterWeight("box", 1));
    // A comet: its head (the latest instant) solid, its tail (the earliest) gone.
    expect(shutterWeight("trail", 1)).toBeGreaterThan(shutterWeight("trail", 0));
    expect(shutterWeight("trail", 0)).toBe(0);
    expect(shutterWeight("lead", 0)).toBeGreaterThan(shutterWeight("lead", 1));
  });

  it("ease peaks in the middle and never goes negative", () => {
    expect(shutterWeight("ease", 0.5)).toBeGreaterThan(shutterWeight("ease", 0));
    for (let u = 0; u <= 1; u += 0.1) expect(shutterWeight("ease", u)).toBeGreaterThanOrEqual(0);
  });
});

describe("the plan", () => {
  const plan = (motionPx: number, over = settings()) =>
    resolveShutter(
      { frameIntervalMs: 1000 / 24, localMs: 0, settings: over, tier: over.sampling, maxSamples: over.maxSamples },
      { px: motionPx, dx: motionPx, dy: 0, rotationDeg: 0, scaleRatio: 1 },
    );

  it("returns null below the significance threshold — the reason this is free when nothing moves", () => {
    expect(plan(0)).toBeNull();
    expect(plan(MOTION_EPSILON_PX * 0.9)).toBeNull();
    expect(plan(MOTION_EPSILON_PX * 1.1)).not.toBeNull();
  });

  it("conserves the frame's light at every strength — a fading-in smear never flashes a glow", () => {
    // The flash this guards: crisp painted at full alpha and the smear OVER it
    // at `strength` gave a 40%-alpha glow c + s·c·(1−c) on every frame where
    // the blur was fading in or out. As shares of one exposure, a uniform
    // picture must come out unchanged for every strength and every alpha.
    for (let px = MOTION_EPSILON_PX * 1.05; px <= MOTION_FULL_PX * 1.5; px += 0.05) {
      const e = shutterExposure(plan(px)!);
      expect(e.combine).toBe("sum");
      for (const alpha of [0.05, 0.4, 1]) {
        const out = e.crisp * alpha + e.smear * e.weights.reduce((t, w) => t + w * alpha, 0);
        expect(out).toBeCloseTo(alpha, 9);
      }
    }
  });

  it("the crisp share fades out continuously — no strength at which it switches off", () => {
    let prev = 1;
    for (let px = MOTION_EPSILON_PX * 1.05; px <= MOTION_FULL_PX; px += 0.02) {
      const { crisp } = shutterExposure(plan(px)!);
      expect(crisp).toBeLessThanOrEqual(prev);
      expect(prev - crisp).toBeLessThan(0.05);
      prev = crisp;
    }
    expect(shutterExposure(plan(MOTION_FULL_PX)!).crisp).toBe(0);
  });

  it("the looks pile samples up at full strength; average shares them", () => {
    const add = shutterExposure(plan(20, settings({ combine: "add" }))!);
    expect(add.combine).toBe("sum");
    expect(add.weights.every((w) => w === 1)).toBe(true);
    expect(shutterExposure(plan(20, settings({ combine: "screen" }))!).combine).toBe("screen");
    expect(shutterExposure(plan(20, settings({ combine: "max" }))!).combine).toBe("max");
    // A look keeps its weighting's shape: a trail's head full, fading to nothing.
    const comet = shutterExposure(plan(40, settings({ combine: "max", weighting: "trail" }))!).weights;
    expect(comet.at(-1)).toBeCloseTo(1, 6);
    expect(comet[0]).toBeLessThan(0.2);
    for (let i = 1; i < comet.length; i++) expect(comet[i]).toBeGreaterThan(comet[i - 1]!);
  });

  it("fades the blur in with speed — no frame pops from crisp to smeared on a slow ease", () => {
    const full = settings().strength;
    const at = (px: number) => plan(px)!.settings.strength;
    expect(at(MOTION_EPSILON_PX * 1.05)).toBeLessThan(full * 0.05);
    let prev = 0;
    for (let px = MOTION_EPSILON_PX * 1.05; px <= MOTION_FULL_PX; px += 0.1) {
      expect(at(px)).toBeGreaterThanOrEqual(prev);
      prev = at(px);
    }
    expect(at(MOTION_FULL_PX)).toBe(full);
    expect(at(30)).toBe(full);
  });

  it("spends more samples on faster motion, and stops at the ceiling", () => {
    expect(plan(3)!.samples.length).toBeLessThan(plan(30)!.samples.length);
    expect(plan(100_000)!.samples.length).toBe(settings().maxSamples);
  });

  it("never plans fewer than two samples — one sample is not an integral", () => {
    expect(plan(MOTION_EPSILON_PX * 1.1)!.samples.length).toBeGreaterThanOrEqual(2);
  });

  it("weights always sum to 1, for every weighting", () => {
    for (const w of ["box", "ease", "trail", "lead", "curve"] as const) {
      const p = plan(40, settings({ weighting: w }))!;
      expect(p.samples.reduce((a, s) => a + s.weight, 0)).toBeCloseTo(1);
    }
  });

  it("a weight curve authored flat at zero falls back to uniform, not to an invisible layer", () => {
    const p = plan(40, settings({ weighting: "curve", curve: { kind: "bezier", values: [0, 0, 1, 0] } }))!;
    expect(p.samples.reduce((a, s) => a + s.weight, 0)).toBeCloseTo(1);
    for (const s of p.samples) expect(s.weight).toBeGreaterThan(0);
  });

  it("samples sit at bin centres, strictly inside the window", () => {
    // Sampling the endpoints would double-count the shutter's edges between
    // adjacent frames and pulse a constant-velocity pan once per frame.
    const p = plan(40)!;
    for (const s of p.samples) {
      expect(s.timeMs).toBeGreaterThan(p.openMs);
      expect(s.timeMs).toBeLessThan(p.closeMs);
    }
  });

  it("`amount` scales what counts as visible, so an exaggerated layer blurs sooner", () => {
    const sub = MOTION_EPSILON_PX * 0.5;
    expect(plan(sub)).toBeNull();
    expect(plan(sub, settings({ amount: 4 }))).not.toBeNull();
  });

  it("the velocity tier caps its step count — its saving is cheap steps, not few draws", () => {
    const fast = plan(400, settings({ sampling: "velocity", maxSamples: 64 }))!;
    const exact = plan(400, settings({ sampling: "transform", maxSamples: 64 }))!;
    expect(fast.samples.length).toBe(VELOCITY_TIER_SAMPLES);
    expect(exact.samples.length).toBeGreaterThan(fast.samples.length);
  });
});

describe("resolution — layer × comp × surface", () => {
  const on = frameWith({ enabled: true });
  const off = frameWith({ enabled: false });

  it("a material floors at the content tier — one banked render cannot slide a refraction", () => {
    const glass = createLayerEffect("glass") as GlassEffect;
    const blur = createLayerEffect("blur");
    const mb = clipMotionBlurSchema.parse({ enabled: true });

    // `transform` is the default: bank one render, move it per sample. Fine for
    // a layer whose picture is a function of its pose.
    expect(resolveMotionBlur(on, { motionBlur: mb, effects: [blur] }, POLICY_FULL)!.tier).toBe("transform");
    // Not fine for one that refracts the scene behind it — that scene stays put.
    expect(resolveMotionBlur(on, { motionBlur: mb, effects: [glass] }, POLICY_FULL)!.tier).toBe("content");
    // A disabled material asks for nothing.
    expect(
      resolveMotionBlur(on, { motionBlur: mb, effects: [{ ...glass, enabled: false }] }, POLICY_FULL)!.tier,
    ).toBe("transform");
    // Edge-only reads no backdrop, so there is nothing to keep still.
    expect(
      resolveMotionBlur(on, { motionBlur: mb, effects: [{ ...glass, edgeOnly: true }] }, POLICY_FULL)!.tier,
    ).toBe("transform");
  });

  it("the surface's budget still outranks the floor — approximate beats unaffordable", () => {
    const mb = clipMotionBlurSchema.parse({ enabled: true });
    const fast = { kind: "capped", maxTier: "velocity", maxSamples: 8 } as const;
    const r = resolveMotionBlur(on, { motionBlur: mb, effects: [createLayerEffect("glass")] }, fast)!;
    expect(r.tier).toBe("velocity");
  });

  it("all three levels must agree", () => {
    expect(resolveMotionBlur(on, clipWith({ enabled: true }), POLICY_FULL)).not.toBeNull();
    expect(resolveMotionBlur(off, clipWith({ enabled: true }), POLICY_FULL)).toBeNull();
    expect(resolveMotionBlur(on, clipWith({ enabled: false }), POLICY_FULL)).toBeNull();
    expect(resolveMotionBlur(on, clipWith({ enabled: true }), POLICY_OFF)).toBeNull();
  });

  it("the comp master alone holds a whole project still — what the v56 migration relies on", () => {
    expect(resolveMotionBlur(off, clipWith({ enabled: true, override: settings() }), POLICY_FULL)).toBeNull();
  });

  it("`override: null` inherits the comp's settings, and the master never leaks in as one", () => {
    const comp = frameWith({ enabled: true, shutterAngle: 270 });
    const r = resolveMotionBlur(comp, clipWith({ enabled: true }), POLICY_FULL)!;
    expect(r.settings.shutterAngle).toBe(270);
    expect(r.settings).not.toHaveProperty("enabled");
  });

  it("an override wins over the comp", () => {
    const comp = frameWith({ enabled: true, shutterAngle: 270 });
    const r = resolveMotionBlur(comp, clipWith({ enabled: true, override: settings({ shutterAngle: 90 }) }), POLICY_FULL)!;
    expect(r.settings.shutterAngle).toBe(90);
  });

  it("a surface can only ever cap the tier, never raise it", () => {
    const cheap = clipWith({ enabled: true, override: settings({ sampling: "velocity" }) });
    const dear = clipWith({ enabled: true, override: settings({ sampling: "content" }) });
    expect(resolveMotionBlur(on, dear, POLICY_FAST)!.tier).toBe("velocity");
    expect(resolveMotionBlur(on, cheap, POLICY_FULL)!.tier).toBe("velocity");
    expect(resolveMotionBlur(on, dear, POLICY_FULL)!.tier).toBe("content");
  });

  it("a capped policy also caps the sample ceiling", () => {
    const c = clipWith({ enabled: true, override: settings({ maxSamples: 64 }) });
    expect(resolveMotionBlur(on, c, POLICY_FAST)!.maxSamples).toBe(8);
    expect(resolveMotionBlur(on, c, POLICY_FULL)!.maxSamples).toBe(64);
  });
});

describe("keyed shutter", () => {
  it("a keyed strength ramp is read at the layer's time; a path write makes the layer's own shutter", async () => {
    const { createEmptyDocument, createShapeClip } = await import("../factories");
    const { setKeyframe } = await import("./keyframes");
    const { getClipProperty, setClipProperty } = await import("./paths");
    const frame = createEmptyDocument().frames[0]!;
    frame.motionBlur.enabled = true;
    const clip = createShapeClip({ frameId: frame.id, shape: "rect", startMs: 0, durationMs: 2000 });
    clip.motionBlur = { enabled: true, override: null };
    setClipProperty(clip, "mblur.shutterAngle", 360);
    expect(clip.motionBlur.override?.shutterAngle).toBe(360);
    expect(getClipProperty(clip, "mblur.shutterAngle")).toBe(360);
    setKeyframe(clip.keyframes, "mblur.strength", 0, 0);
    setKeyframe(clip.keyframes, "mblur.strength", 1000, 1);
    const policy = { kind: "full" } as const;
    expect(resolveMotionBlur(frame, clip, policy as never, 0)!.settings.strength).toBe(0);
    expect(resolveMotionBlur(frame, clip, policy as never, 1000)!.settings.strength).toBe(1);
  });
});

describe("shutterSubsteps: each bin integrated whole", () => {
  it("cuts a capped plan into steps no wider than the sample spacing, covering the window evenly", () => {
    // 16 bins of 7.25 px each (a 116 px streak at the default cap): 5 steps per bin.
    const weights = Array.from({ length: 16 }, () => 1 / 16);
    const steps = shutterSubsteps(weights, 116 / 16, "sum");
    expect(steps.length).toBe(16 * 5);
    expect(steps.reduce((s, x) => s + x.weight, 0)).toBeCloseTo(1, 12);
    // Evenly spaced from the window's open to its close, in sample-index units.
    expect(steps[0]!.at).toBeCloseTo(-0.4, 12);
    expect(steps.at(-1)!.at).toBeCloseTo(15.4, 12);
    for (let i = 1; i < steps.length; i++) expect(steps[i]!.at - steps[i - 1]!.at).toBeCloseTo(0.2, 12);
    // In pixels: every step under the spacing that fuses (1.5 px).
    expect((116 / 16) * 0.2).toBeLessThanOrEqual(1.5);
  });

  it("leaves a plan already fine enough alone, and keeps a trail's brightness under max", () => {
    expect(shutterSubsteps([0.5, 0.5], 1, "sum")).toEqual([{ at: 0, weight: 0.5 }, { at: 1, weight: 0.5 }]);
    const trail = shutterSubsteps([1, 0.5], 6, "max");
    expect(trail.filter((s) => s.at < 0.5).every((s) => s.weight === 1)).toBe(true);
  });
});
