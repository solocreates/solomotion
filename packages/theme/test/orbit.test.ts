import { describe, expect, it } from "vitest";
import { angleTo, catchOf, moonAt, moonSpin, orbitRest, stepOrbit, type OrbitState } from "../src/dial";

const run = (s: OrbitState, speed: number, secs: number, fps = 60) => {
  for (let i = 0; i < secs * fps; i++) s = stepOrbit(s, speed, 1 / fps);
  return s;
};

describe("orbit", () => {
  it("free moons settle into their own spin", () => {
    // Centre held still, pointing away from moon 6 (straight down).
    const s = run({ ...orbitRest(12), spin: 0 }, 0, 4);
    expect(s.moons[6]!.v).toBeCloseTo(moonSpin(6), 0);
  });
  it("a moon the quarter points at turns to face the centre and holds", () => {
    const s = run(orbitRest(12), 0, 3);
    // Moon 0 sits at twelve o'clock; the centre's quarter points up, at it.
    expect(Math.abs(angleTo(s.moons[0]!.a, moonAt(0, 12) + 180))).toBeLessThan(2);
    expect(Math.abs(s.moons[0]!.v)).toBeLessThan(2);
  });
  it("only the quarter's own neighbourhood catches", () => {
    expect(catchOf(0, 0)).toBe(1);
    expect(catchOf(0, 60)).toBeLessThan(0.1);
    expect(catchOf(0, 90)).toBeLessThan(1e-6);
    expect(catchOf(0, 180)).toBe(0);
  });
  it("a moon faces the centre AS the quarter crosses it, not a beat late", () => {
    // The support page's default ($25) spins about half a turn a second.
    let s = run(orbitRest(12), 0.56, 4);
    const misses: number[] = [];
    for (let f = 0; f < 6 * 60; f++) {
      s = stepOrbit(s, 0.56, 1 / 60);
      const i = Math.round((((s.spin % 360) + 360) % 360) / 30) % 12;
      if (Math.abs(angleTo(s.spin, moonAt(i, 12))) < 4) misses.push(Math.abs(angleTo(s.moons[i]!.a, moonAt(i, 12) + 180)));
    }
    expect(misses.reduce((a, b) => a + b, 0) / misses.length).toBeLessThan(15);
  });
  it("is frame-rate independent enough to look the same", () => {
    const a = run(orbitRest(12), 0.3, 2, 60);
    const b = run(orbitRest(12), 0.3, 2, 120);
    expect(a.spinV).toBeCloseTo(b.spinV, 0);
  });
  it("a slept tab resumes calmly", () => {
    const s = stepOrbit(run(orbitRest(12), 0.5, 2), 0.5, 60);
    expect(s.moons.every((m) => Number.isFinite(m.a) && Math.abs(m.v) < 1000)).toBe(true);
  });
});
