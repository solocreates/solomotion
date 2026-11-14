import { describe, expect, it } from "vitest";
import { exactRun, type ExactDisc } from "./exact";

/** A ball in a round room: radius R room, radius r ball, launched from `phi0` on the reachable circle at chord angle `theta`. */
function billiard(theta: number, speed = 800, R = 400, r = 20, phi0 = Math.PI / 2) {
  const Rp = R - r;
  const start = { x: Rp * Math.cos(phi0), y: Rp * Math.sin(phi0) };
  const next = { x: Rp * Math.cos(phi0 + theta), y: Rp * Math.sin(phi0 + theta) };
  const dx = next.x - start.x;
  const dy = next.y - start.y;
  const l = Math.hypot(dx, dy);
  // Start a hair inside the wall so the first contact is the next one, not "now".
  const p = { x: start.x * (1 - 1e-12), y: start.y * (1 - 1e-12) };
  const ball: ExactDisc = { id: "ball", p, v: { x: (dx / l) * speed, y: (dy / l) * speed }, r };
  const run = exactRun([ball], [{ id: "ring", kind: "circle", centre: { x: 0, y: 0 }, radius: R }]);
  const chordMs = (l / speed) * 1000;
  return { run, Rp, phi0, chordMs };
}

describe("exact physics: an ideal billiard", () => {
  it("lands bounce n at φ₀ + n·θ, to 1e-9 rad after 355 bounces (no drift)", () => {
    const theta = 2.1937; // an irrational-looking chord angle
    const { run, Rp, phi0, chordMs } = billiard(theta);
    const hits = run.contactsUntil(chordMs * 355 + 1);
    expect(hits).toHaveLength(355);
    for (const n of [1, 22, 100, 355]) {
      const h = hits[n - 1]!;
      expect(Math.hypot(h.at.x, h.at.y)).toBeCloseTo(Rp, 7);
      const want = phi0 + n * theta;
      const got = Math.atan2(h.at.y, h.at.x);
      const diff = Math.atan2(Math.sin(got - want), Math.cos(got - want));
      expect(Math.abs(diff)).toBeLessThan(1e-9);
      // Every chord takes the same time: contacts on a perfect grid.
      expect(h.t).toBeCloseTo(n * chordMs, 6);
    }
  });

  it("comes home exactly when θ = 2π·k/N: a square closes after 4 bounces", () => {
    const { run, Rp, phi0, chordMs } = billiard(Math.PI / 2);
    const home = run.at(chordMs * 4)[0]!;
    expect(home.p.x).toBeCloseTo(Rp * Math.cos(phi0), 6);
    expect(home.p.y).toBeCloseTo(Rp * Math.sin(phi0), 6);
  });

  it("is seekable and deterministic: any order of asking gives the same answer, speed is kept", () => {
    const { run } = billiard(2.0);
    const late = run.at(20_000)[0]!;
    const early = run.at(3_000)[0]!;
    const again = billiard(2.0).run;
    expect(again.at(3_000)[0]).toEqual(early);
    expect(again.at(20_000)[0]).toEqual(late);
    expect(Math.hypot(late.v.x, late.v.y)).toBeCloseTo(800, 9);
  });

  it("two discs and a line: equal masses swap along the line of centres, a line reflects", () => {
    const run = exactRun(
      [
        { id: "a", p: { x: -100, y: 0 }, v: { x: 100, y: 0 }, r: 10 },
        { id: "b", p: { x: 100, y: 0 }, v: { x: 0, y: 0 }, r: 10 },
      ],
      [{ id: "floor", kind: "line", point: { x: 300, y: 0 }, normal: { x: -1, y: 0 } }],
    );
    const hits = run.contactsUntil(5000);
    // a meets b after 180 px at 100 px/s; b then travels 190 px to the line at 300.
    expect(hits[0]).toMatchObject({ disc: "a", other: "b" });
    expect(hits[0]!.t).toBeCloseTo(1800, 9);
    expect(hits[1]).toMatchObject({ disc: "b", other: "floor" });
    expect(hits[1]!.t).toBeCloseTo(3700, 9);
    const [a, b] = run.at(1900);
    expect(a!.v.x).toBeCloseTo(0, 12);
    expect(b!.v.x).toBeCloseTo(100, 12);
    // Back off the line: total kinetic energy is unchanged.
    const after = run.at(4000);
    const e = after.reduce((s, d) => s + d.v.x * d.v.x + d.v.y * d.v.y, 0);
    expect(e).toBeCloseTo(100 * 100, 9);
  });
});
