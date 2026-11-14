import { describe, expect, it } from "vitest";
import { FORCE } from "./forces";
import type { FieldAt } from "./fields";
import { SHADOW_OVER_HORIZON, viewParticles } from "./particle-view";
import { PARTICLE_STRIDE, type SimParticles } from "./solver";

/**
 * A DISK SEEN FROM THE SIDE through its own well — measured against the point
 * lens it claims to be. The well is at the origin, Rs 30, the plane tilted 75°.
 */
const RS = 30;
const well: FieldAt = { spec: { ...FORCE.create("gravity"), mass: 8000, horizon: RS }, origin: [0, 0, 0], axisX: [1, 0, 0], axisZ: [0, 0, 1] };

function particles(points: Array<[number, number, number?, number?]>): SimParticles {
  const data = new Float32Array(points.length * PARTICLE_STRIDE);
  points.forEach(([x, y, vx = 0, vy = 0], i) => data.set([i, x, y, vx, vy, 0, 10, i], i * PARTICLE_STRIDE));
  return { layer: "l", index: 0, data, count: points.length };
}

const view = (patch: Partial<{ tilt: number; lensing: number; beaming: number; hot: number }> = {}) => ({ tilt: 75, lensing: 1, beaming: 0, hot: 1000, ...patch });
const rows = (s: SimParticles) => Array.from({ length: s.count }, (_, k) => ({ i: s.data[k * PARTICLE_STRIDE]!, x: s.data[k * PARTICLE_STRIDE + 1]!, y: s.data[k * PARTICLE_STRIDE + 2]! }));

describe("particle view", () => {
  it("tilts the plane: y shrinks by cos, nothing else moves without a lens", () => {
    const seen = viewParticles(particles([[100, -200], [0, 200]]), view({ lensing: 0 }), [0, 0], [well]);
    const [a, b] = rows(seen);
    expect(a!.x).toBeCloseTo(100);
    expect(a!.y).toBeCloseTo(-200 * Math.cos((75 * Math.PI) / 180), 3);
    expect(b!.y).toBeCloseTo(200 * Math.cos((75 * Math.PI) / 180), 3);
  });

  it("lifts the far side over the shadow to the Einstein radius, and hangs its second image underneath", () => {
    const z = 300 * Math.sin((75 * Math.PI) / 180);
    const re = Math.sqrt(2 * RS * z);
    // Straight behind the hole: its two images sit at ±θE.
    const seen = rows(viewParticles(particles([[0, -300]]), view(), [0, 0], [well]));
    expect(seen).toHaveLength(2);
    const ys = seen.map((r) => r.y).sort((p, q) => p - q);
    // b = 300·cos75 ≈ 78 above the hole: θ± = (b ± √(b² + 4θE²)) / 2.
    const b = 300 * Math.cos((75 * Math.PI) / 180);
    expect(-ys[0]!).toBeCloseTo((b + Math.sqrt(b * b + 4 * re * re)) / 2, 2);
    expect(ys[1]!).toBeCloseTo((Math.sqrt(b * b + 4 * re * re) - b) / 2, 2);
    expect(Math.min(...seen.map((r) => Math.hypot(r.x, r.y)))).toBeGreaterThan(RS * SHADOW_OVER_HORIZON);
  });

  it("leaves the near side and the level edges where they are, so the two halves meet without a seam", () => {
    const seen = rows(viewParticles(particles([[0, 300], [250, 0], [250, -1]]), view(), [0, 0], [well]));
    expect(seen[0]).toMatchObject({ x: 0 });
    expect(seen[0]!.y).toBeCloseTo(300 * Math.cos((75 * Math.PI) / 180), 3);
    expect(seen[1]!.x).toBeCloseTo(250);
    // A hair behind the level line moves a hair, not a jump.
    const far = seen.find((r) => r.i === 2 && r.x > 0)!;
    expect(Math.hypot(far.x - 250, far.y)).toBeLessThan(1);
  });

  it("swallows what lands inside the shadow and dims a second image", () => {
    // Far off axis: its second image falls inside 2.6 Rs and is captured.
    expect(viewParticles(particles([[600, -40]]), view(), [0, 0], [well]).count).toBe(1);
    // Near the axis: both show, the second one fainter.
    const seen = viewParticles(particles([[100, -300]]), view(), [0, 0], [well]);
    expect(seen.count).toBe(2);
    expect(seen.gain[1]!).toBeLessThan(0.3);
    expect(seen.gain[1]!).toBeLessThan(seen.gain[0]!);
  });

  it("beams: the side coming at the camera is brighter and hotter than the side going away", () => {
    const seen = viewParticles(particles([[-200, 0, 0, 600], [200, 0, 0, -600]]), view({ lensing: 0, beaming: 0.5 }), [0, 0], []);
    expect(seen.heat[0]!).toBeGreaterThan(1);
    expect(seen.heat[1]!).toBeLessThan(1);
    expect(seen.gain[0]!).toBeGreaterThan(seen.gain[1]! * 2);
    // …but never a blackout: the receding side keeps a real share of its light.
    expect(seen.gain[1]!).toBeGreaterThan(0.25);
  });
});
