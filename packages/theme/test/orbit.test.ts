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
  it("only near-alignment catches", () => {
    expect(catchOf(0, 0)).toBe(1);
    expect(catchOf(0, 60)).toBeLessThan(0.01);
    expect(catchOf(0, 180)).toBe(0);
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
