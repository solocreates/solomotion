import { describe, expect, it } from "vitest";
import { mergeStrokeInto } from "./vector-merge";
import { outlineSubpath } from "./path-fit";
import type { Contour, Subpath } from "../schema/vector";

let n = 0;
const mintId = () => `sub-${++n}`;

const corner = (x: number, y: number) => ({ x, y, hIn: null, hOut: null });

/**
 * A brush stroke is a closed RIBBON, so every self-closing test needs one: an
 * arc of thickness swept between two radii, with a mouth left open. `mouthDeg`
 * is the whole opening, so the narrowest gap across it is the chord at the
 * INNER radius.
 */
function cRibbon(mouthDeg: number, rIn = 80, rOut = 100, stepDeg = 2): Contour {
  const half = mouthDeg / 2;
  const at = (r: number, deg: number) => {
    const a = (deg * Math.PI) / 180;
    return corner(r * Math.cos(a), r * Math.sin(a));
  };
  const pts = [];
  for (let d = half; d <= 360 - half; d += stepDeg) pts.push(at(rOut, d));
  pts.push(at(rOut, 360 - half));
  for (let d = 360 - half; d >= half; d -= stepDeg) pts.push(at(rIn, d));
  pts.push(at(rIn, half));
  return { closed: true, points: pts };
}

const innerChord = (mouthDeg: number, rIn = 80) =>
  2 * rIn * Math.sin((mouthDeg / 2 / 180) * Math.PI);

describe("mergeStrokeInto — closing a gap in the stroke you are drawing", () => {
  /**
   * The bug this file exists for: close gaps reached only for contours that
   * were already in the layer, so the setting did nothing for the stroke under
   * the cursor. Sweeping a C in one gesture left its mouth open however high
   * the gap was set.
   */
  it("closes a stroke against ITSELF with nothing else on the layer", () => {
    const c = cRibbon(6);
    const gap = innerChord(6) + 2;
    const merged = mergeStrokeInto([], [c], mintId, { closeGapPx: gap });
    expect(merged.merged).toBe(true);
    // Outer boundary + the hole it now encloses: the C became an O.
    expect(merged.subpaths.length).toBe(2);
    expect(merged.absorbed).toEqual([]);
  });

  it("leaves the mouth open when the gap setting cannot reach across it", () => {
    const c = cRibbon(6);
    const merged = mergeStrokeInto([], [c], mintId, { closeGapPx: innerChord(6) / 2 });
    expect(merged.merged).toBe(false);
    expect(merged.subpaths.length).toBe(1);
  });

  it("never welds a stroke shut along its own length", () => {
    // A ribbon 20 units thick, with a gap setting far wider than that. The two
    // sides of the stroke come within 20 of each other everywhere and the end
    // caps are 20 across — bridge either and the stroke pinches itself closed.
    // The midpoint test is what saves it: those shortcuts run through solid ink.
    const bar: Contour = {
      closed: true,
      points: [corner(0, 0), corner(300, 0), corner(300, 20), corner(0, 20)],
    };
    const merged = mergeStrokeInto([], [bar], mintId, { closeGapPx: 60 });
    expect(merged.merged).toBe(false);
  });

  it("still bridges to what is already on the layer", () => {
    const host: Subpath = {
      id: "host",
      closed: true,
      points: [corner(0, 0), corner(40, 0), corner(40, 10), corner(0, 10)],
    };
    const incoming: Contour = {
      closed: true,
      points: [corner(46, 0), corner(86, 0), corner(86, 10), corner(46, 10)],
    };
    const apart = mergeStrokeInto([host], [incoming], mintId, { closeGapPx: 2 });
    expect(apart.merged).toBe(false);

    const joined = mergeStrokeInto([host], [incoming], mintId, { closeGapPx: 8 });
    expect(joined.merged).toBe(true);
    expect(joined.absorbed).toEqual(["host"]);
    // The absorbed host's identity survives the join.
    expect(joined.subpaths[0]!.id).toBe("host");
  });
});

describe("mergeStrokeInto — a merged body is not a point cloud", () => {
  /** A circle as the flattener leaves one: dense, and not one point collinear. */
  function disc(cx: number, r: number, samples: number): Contour {
    const pts = [];
    for (let i = 0; i < samples; i++) {
      const a = (i / samples) * Math.PI * 2;
      pts.push(corner(cx + r * Math.cos(a), r * Math.sin(a)));
    }
    return { closed: true, points: pts };
  }

  const total = (subs: Subpath[]) => subs.reduce((sum, s) => sum + s.points.length, 0);

  it("drops the vertices the union invented", () => {
    const host: Subpath = { id: "host", ...disc(0, 100, 360) };
    const incoming = disc(120, 100, 360);
    const raw = mergeStrokeInto([host], [incoming], mintId, { simplifyPx: 0 });
    const merged = mergeStrokeInto([host], [incoming], mintId, {});
    expect(merged.merged).toBe(true);
    // The boolean hands back a corner for every sample either outline was
    // flattened at; a person who drew two strokes expects a shape, not 600
    // anchors to drag. Same silhouette, a fifth of the vertices.
    expect(total(raw.subpaths)).toBeGreaterThan(500);
    expect(total(merged.subpaths)).toBeLessThan(total(raw.subpaths) / 3);
  });

  it("keeps the corners the union MEANT — the crossings", () => {
    // Simplifying must not round off where the two strokes actually meet. The
    // union's two crossing points are cusps, and RDP can never drop a cusp.
    const host: Subpath = { id: "host", ...disc(0, 100, 360) };
    const merged = mergeStrokeInto([host], [disc(120, 100, 360)], mintId, {});
    const pts = merged.subpaths.flatMap((s) => s.points);
    // The discs cross at x = 60, y = ±80.
    for (const y of [80, -80]) {
      const near = pts.some((p) => Math.hypot(p.x - 60, p.y - y) < 0.5);
      expect(near).toBe(true);
    }
  });
});

describe("a merge stays as light as the strokes it merged", () => {
  /** A brush ribbon: a polyline offset to a half-width and fitted closed. */
  const ribbon = (pts: Array<{ x: number; y: number }>, half = 16) =>
    outlineSubpath(pts.map((p) => ({ ...p, width: half * 2 })), 0.5)!;

  /** Hand wobble: LOW frequency, the way an arm actually wanders. */
  const wobbly = (n: number, at: (t: number) => { x: number; y: number }) =>
    Array.from({ length: n }, (_, i) => {
      const t = i / (n - 1);
      const p = at(t);
      return {
        x: p.x + Math.sin(t * 17.3) * 5 + Math.sin(t * 41.1) * 2,
        y: p.y + Math.cos(t * 23.7) * 5 + Math.cos(t * 37.9) * 2,
      };
    });

  it("does not come back denser than its own inputs", () => {
    // A HAND-DRAWN loop crossed by a hand-drawn line — the case that produced a
    // wall of anchors. Three things were wrong and all three are load-bearing:
    // the tolerance was six times finer than the brush's own, the corner test
    // read hand wobble as corners, and the boolean's slivers were all kept.
    const loop = ribbon(wobbly(160, (t) => ({ x: 400 * Math.cos(t * Math.PI * 2), y: 400 * Math.sin(t * Math.PI * 2) })));
    const line = ribbon(wobbly(60, (t) => ({ x: -40 + t * 100, y: -700 + t * 1400 })));
    const before = loop.points.length + line.points.length;

    const merged = mergeStrokeInto([{ ...loop, id: "a" }], [line], () => "new", { simplifyPx: 2.5 });
    expect(merged.merged).toBe(true);
    const after = merged.subpaths.reduce((n, s) => n + s.points.length, 0);
    expect(after).toBeLessThanOrEqual(before);
    // And the specks a self-intersecting ribbon leaves behind are gone: a loop
    // crossed by a line is an outline and the pieces of its inside, not a dozen
    // needles nobody can see.
    expect(merged.subpaths.length).toBeLessThanOrEqual(4);
  });

  it("keeps a crossing sharp while fitting the curves through", () => {
    const a = ribbon([{ x: -300, y: 0 }, { x: 300, y: 0 }]);
    const b = ribbon([{ x: 0, y: -300 }, { x: 0, y: 300 }]);
    const merged = mergeStrokeInto([{ ...a, id: "a" }], [b], () => "new", { simplifyPx: 2.5 });
    // A plus sign is twelve corners and nothing else — it must not round off,
    // and it must not carry a hundred collinear points down each arm either.
    const anchors = merged.subpaths.reduce((n, s) => n + s.points.length, 0);
    expect(anchors).toBeGreaterThanOrEqual(12);
    expect(anchors).toBeLessThan(40);
  });
});
