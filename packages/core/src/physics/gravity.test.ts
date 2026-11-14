import { describe, expect, it } from "vitest";
import type { EmitterSpec, ForceSpec, ShapeClip, VisualClip } from "../schema";
import { physicsSchema, simulationSchema } from "../schema/physics";
import { createEmptyDocument, createShapeClip, createTrack } from "../factories";
import { createEmptyClip } from "../world/ops";
import { flatParticles, flatPhysics, resolveFlatPhysics } from "./flat";
import { EMITTER } from "./emitters";
import { FORCE } from "./forces";
import { circularSpeed, fieldAcceleration } from "./fields";
import { PARTICLE_STRIDE, clearSimulations } from "./solver";
import { locateClip } from "../timeline/ops";

/**
 * GRAVITY WELLS — measured, not eyeballed. Space has no floor and no Earth:
 * every comp here has gravity 0, so the well is the only pull.
 */
function space() {
  clearSimulations();
  const doc = createEmptyDocument();
  const frame = doc.frames[0]!;
  frame.width = 1080;
  frame.height = 1920;
  frame.physics = simulationSchema.parse({ gravity: 0, floor: false });
  const add = <C extends VisualClip>(c: C) => {
    const lane = createTrack(c.name);
    lane.clips.push(c);
    doc.tracks.push(lane);
    return c;
  };
  const well = (patch: Partial<ForceSpec> = {}) => {
    const e = createEmptyClip({ frameId: frame.id, startMs: 0, durationMs: 40000 });
    e.forces = [{ ...FORCE.create("gravity"), ...patch }];
    return add(e);
  };
  const emitter = (spec: Partial<EmitterSpec>, x: number, y: number, rotation: number) => {
    const e = createEmptyClip({ frameId: frame.id, startMs: 0, durationMs: 40000 });
    e.transform = { ...e.transform, x, y, rotation };
    e.emitters = [{ ...EMITTER.create("burst"), count: 1, spread: 0, variance: 0, weight: 0, drag: 0, life: 30, collide: false, ...spec }];
    return add(e);
  };
  const at = (ms: number) => {
    const pts: Array<{ x: number; y: number; vx: number; vy: number }> = [];
    for (const p of flatParticles(doc, frame.id, ms)) for (let k = 0; k < p.count; k++) {
      const o = k * PARTICLE_STRIDE;
      pts.push({ x: p.data[o + 1]!, y: p.data[o + 2]!, vx: p.data[o + 3]!, vy: p.data[o + 4]! });
    }
    return pts;
  };
  return { doc, frame, add, well, emitter, at };
}

describe("gravity well", () => {
  it("holds a circle: launched at √(GM/r), a particle stays on its orbit within 1% over five orbits", () => {
    const { well, emitter, at } = space();
    const w = well({ horizon: 0 });
    const spec = w.forces![0]!;
    const r = 320;
    const v = circularSpeed(spec, r);
    // At (r, 0), moving +y (down on screen): a clockwise circle about the well.
    emitter({ speed: v }, r, 0, 90);
    const period = (2 * Math.PI * r) / v;
    let turned = 0;
    let last = 0;
    const samples = 5 * 48;
    for (let k = 1; k <= samples; k++) {
      const ms = ((k * 5 * period) / samples) * 1000;
      const [p] = at(ms);
      expect(p, `alive at ${ms.toFixed(0)} ms`).toBeTruthy();
      expect(Math.abs(Math.hypot(p!.x, p!.y) - r) / r).toBeLessThan(0.01);
      const a = Math.atan2(p!.y, p!.x);
      let d = a - last;
      d = d > Math.PI ? d - 2 * Math.PI : d < -Math.PI ? d + 2 * Math.PI : d;
      turned += d;
      last = a;
    }
    // Five turns clockwise on screen (+ angle with y down), to within a few degrees.
    expect(turned / (2 * Math.PI)).toBeGreaterThan(4.97);
    expect(turned / (2 * Math.PI)).toBeLessThan(5.03);
  });

  it("is inverse-square: twice as far, a quarter of the pull", () => {
    const f = { spec: { ...FORCE.create("gravity"), core: 0 }, origin: [0, 0, 0] as [number, number, number], axisX: [1, 0, 0] as [number, number, number], axisZ: [0, 0, 1] as [number, number, number] };
    const a1 = fieldAcceleration(f, [200, 0, 0], [0, 0, 0], 0);
    const a2 = fieldAcceleration(f, [400, 0, 0], [0, 0, 0], 0);
    expect(a1[0]).toBeLessThan(0);
    expect(a1[0] / a2[0]).toBeCloseTo(4, 6);
    // Its mass is its pull 100 units out.
    expect(fieldAcceleration(f, [100, 0, 0], [0, 0, 0], 0)[0]).toBeCloseTo(-f.spec.mass, 6);
  });

  it("kills a particle that crosses the horizon — and only then", () => {
    const { well, emitter, at } = space();
    well({ horizon: 60 });
    // Dropped from rest 400 units out: it falls straight in.
    emitter({ speed: 0 }, 400, 0, 0);
    expect(at(200)).toHaveLength(1);
    let gone = -1;
    for (let ms = 50; ms <= 6000; ms += 50) {
      const pts = at(ms);
      if (!pts.length) {
        gone = ms;
        break;
      }
      expect(Math.hypot(pts[0]!.x, pts[0]!.y)).toBeGreaterThan(60 - 1e-6);
    }
    expect(gone).toBeGreaterThan(0);
    // Free fall from r0 into a point mass: t = π/2 · √(r0³ / 2GM) (the core trims a little).
    const tff = (Math.PI / 2) * Math.sqrt(400 ** 3 / (2 * 8000e4));
    expect(gone / 1000).toBeLessThan(tff + 0.1);
  });

  it("sweeps the horizon: a particle fast enough to jump the hole in one step still dies", () => {
    const { well, emitter, at } = space();
    // No pull to speak of, so the path is exact: 9000 units/s is 75 units a
    // 120 Hz step, and from −637.5 the steps land at −37.5 and +37.5 — both
    // outside a 30-unit horizon. Only a swept test sees it cross.
    well({ mass: 0.0001, horizon: 30, core: 0 });
    emitter({ count: 40, speed: 9000, variance: 0, spread: 0 }, -637.5, 0, 0);
    expect(at(20)).toHaveLength(40);
    for (const ms of [200, 600, 1500]) expect(at(ms)).toHaveLength(0);
  });

  it("swallows a falling body: hidden from the instant it crosses, untouched before", () => {
    const { doc, frame, add, well } = space();
    well({ horizon: 80 });
    const ball = createShapeClip({ frameId: frame.id, shape: "ellipse", startMs: 0, durationMs: 40000, x: 0, y: -500, width: 30, height: 30 }) as ShapeClip;
    ball.physics = physicsSchema.parse({ type: "active", damping: 0 });
    add(ball);
    const hiddenAt = (ms: number) => (locateClip(resolveFlatPhysics(doc, frame.id, ms), ball.id)!.clip as VisualClip).hidden;
    expect(hiddenAt(100)).toBe(false);
    let first = -1;
    for (let ms = 0; ms <= 8000; ms += 25) if (hiddenAt(ms)) {
      first = ms;
      break;
    }
    expect(first).toBeGreaterThan(0);
    // Once gone, gone — its span on the timeline never brings it back.
    for (const ms of [first + 500, first + 3000, 20000]) expect(hiddenAt(ms)).toBe(true);
  });

  it("drags space round with its spin: a still particle is swept clockwise, far harder near the horizon", () => {
    const spec = { ...FORCE.create("gravity"), horizon: 60, spin: 1 };
    const f = { spec, origin: [0, 0, 0] as [number, number, number], axisX: [1, 0, 0] as [number, number, number], axisZ: [0, 0, 1] as [number, number, number] };
    const near = fieldAcceleration(f, [120, 0, 0], [0, 0, 0], 0)[1];
    const far = fieldAcceleration(f, [480, 0, 0], [0, 0, 0], 0)[1];
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(0);
    expect(near).toBeGreaterThan(far * 100);
    // Turning with space already, it feels no drag at all.
    const vf = circularSpeed(spec, 60) * 0.25;
    expect(Math.abs(fieldAcceleration(f, [120, 0, 0], [0, vf, 0], 0)[1])).toBeLessThan(1e-6);
  });

  it("spins an orbit down: a circle that holds without spin spirals through the horizon with it", () => {
    const run = (spin: number) => {
      const { well, emitter, at } = space();
      const w = well({ horizon: 60, spin });
      const r = 200;
      emitter({ speed: circularSpeed(w.forces![0]!, r) }, r, 0, 90);
      return [400, 8000].map((ms) => at(ms)[0] ?? null);
    };
    const still = run(0);
    for (const p of still) expect(Math.abs(Math.hypot(p!.x, p!.y) - 200)).toBeLessThan(3);
    const spun = run(1);
    expect(Math.hypot(spun[0]!.x, spun[0]!.y)).toBeLessThan(195);
    expect(spun[1]).toBeNull();
  });
});

describe("emitter launch and ring source", () => {
  it("a ring is born inside its annulus, and launched in orbit each particle keeps its own radius", () => {
    const { well, emitter, at } = space();
    well({ horizon: 0 });
    // The carrier sits on the well; the ring is about it.
    emitter({ count: 200, source: "ring", inner: 150, outer: 450, launch: "orbit", orbit: 1 }, 0, 0, 0);
    const born = at(10);
    expect(born).toHaveLength(200);
    for (const p of born) {
      const r = Math.hypot(p.x, p.y);
      expect(r).toBeGreaterThan(149);
      expect(r).toBeLessThan(451);
      // Sideways, clockwise on screen: velocity ⟂ radius, turning +.
      expect(Math.abs(p.x * p.vx + p.y * p.vy) / (r * Math.hypot(p.vx, p.vy))).toBeLessThan(0.05);
      expect(p.x * p.vy - p.y * p.vx).toBeGreaterThan(0);
    }
    const start = new Map(born.map((p, k) => [k, Math.hypot(p.x, p.y)]));
    const later = at(6000);
    expect(later).toHaveLength(200);
    // Same index order: each one still on its own circle.
    later.forEach((p, k) => expect(Math.abs(Math.hypot(p.x, p.y) - start.get(k)!) / start.get(k)!).toBeLessThan(0.02));
  });

  it("under 1 it dips toward the well; a negative factor goes the other way round", () => {
    const { well, emitter, at } = space();
    well({ horizon: 0 });
    emitter({ source: "ring", inner: 300, outer: 300, launch: "orbit", orbit: -0.7, seed: 3 }, 0, 0, 0);
    const p0 = at(10)[0]!;
    expect(p0.x * p0.vy - p0.y * p0.vx).toBeLessThan(0);
    let least = Infinity;
    for (let ms = 50; ms < 4000; ms += 50) least = Math.min(least, Math.hypot(at(ms)[0]!.x, at(ms)[0]!.y));
    // Periapsis of a 0.7× circular launch: r · k² / (2 − k²) ≈ 0.32 r.
    expect(least).toBeLessThan(300 * 0.4);
    expect(least).toBeGreaterThan(300 * 0.25);
  });

  it("inward falls toward the layer, outward leaves it", () => {
    const { emitter, at } = space();
    emitter({ count: 50, source: "ring", inner: 200, outer: 200, launch: "inward", speed: 300 }, 0, 0, 0);
    emitter({ count: 50, source: "ring", inner: 200, outer: 200, launch: "outward", speed: 300, seed: 9 }, 0, 0, 0);
    const pts = at(10);
    expect(pts).toHaveLength(100);
    const radial = pts.map((p) => (p.x * p.vx + p.y * p.vy) / Math.hypot(p.x, p.y));
    expect(radial.filter((v) => v < -290)).toHaveLength(50);
    expect(radial.filter((v) => v > 290)).toHaveLength(50);
  });
});

describe("colour by temperature", () => {
  it("is look-only: recolouring a disk never re-simulates it", () => {
    const { doc, frame, well, emitter } = space();
    well();
    const e = emitter({ source: "ring", launch: "orbit" }, 0, 0, 0);
    const key = flatPhysics(doc, frame.id)!.scene.key;
    e.emitters = [{ ...e.emitters![0]!, colorBy: "temperature", kelvin: 20000, hot: 900 }];
    expect(flatPhysics(doc, frame.id)!.scene.key).toBe(key);
  });
});
