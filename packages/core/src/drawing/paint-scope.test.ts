import { describe, expect, it } from "vitest";
import {
  growMask,
  invertMask,
  maskCoverage,
  polygonArea,
  resolveRegion,
  traceRegion,
  type RegionMask,
} from "./area";
import { mergeStrokeInto } from "./vector-merge";
import { DEFAULT_PAINT_SCOPE, referenceKey, toggleReference } from "./paint-scope";
import type { Contour, Subpath } from "../schema/vector";

/** An RGBA buffer: transparent, with `paint` calling in opaque black. */
function canvas(w: number, h: number, paint: (set: (x: number, y: number) => void) => void) {
  const px = new Uint8ClampedArray(w * h * 4);
  paint((x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    px[i] = 0;
    px[i + 1] = 0;
    px[i + 2] = 0;
    px[i + 3] = 255;
  });
  return px;
}

const count = (m: RegionMask) => m.data.reduce((a, b) => a + b, 0);

describe("resolveRegion", () => {
  const W = 40;
  const H = 40;
  /** A 20×20 box outline with a `gap`-wide hole in its top edge. */
  const boxWithGap = (gap: number) =>
    canvas(W, H, (set) => {
      for (let x = 10; x < 30; x++) {
        // Leave `gap` px missing in the middle of the top edge.
        if (!(gap > 0 && x >= 19 && x < 19 + gap)) set(x, 10);
        set(x, 29);
      }
      for (let y = 10; y <= 29; y++) {
        set(10, y);
        set(29, y);
      }
    });

  it("floods the inside of a closed outline and stops at the line", () => {
    const mask = resolveRegion(boxWithGap(0), W, H, 20, 20, { tolerance: 0.1 })!;
    expect(mask).not.toBeNull();
    // 18×18 interior.
    expect(count(mask)).toBe(18 * 18);
    expect(mask.data[20 * W + 10]).toBe(0); // the line itself is not inside
  });

  it("leaks out through a gap when gap closing is off", () => {
    const mask = resolveRegion(boxWithGap(3), W, H, 20, 20, { tolerance: 0.1 })!;
    // Escaped: the region reaches the canvas edge.
    expect(count(mask)).toBeGreaterThan(18 * 18 * 2);
  });

  it("holds the paint in once the gap is closed", () => {
    const mask = resolveRegion(boxWithGap(3), W, H, 20, 20, {
      tolerance: 0.1,
      closeGapPx: 3,
    })!;
    // Contained: comfortably smaller than the leaked case, and nowhere near the
    // canvas corner.
    expect(count(mask)).toBeLessThan(18 * 18 * 1.6);
    expect(mask.data[0]).toBe(0);
  });

  it("gap closing never reaches further than the flood could have", () => {
    // A CLOSED box: gap closing has nothing to close, so it must change nothing
    // outside the region. The bug was a plain dilation after the barriered
    // flood, which grew the region by the gap in every direction — invisible on
    // line art, and several pixels of paint outside the area on a photograph.
    const closed = boxWithGap(0);
    const plain = resolveRegion(closed, W, H, 20, 20, { tolerance: 0.1 })!;
    const gapped = resolveRegion(closed, W, H, 20, 20, { tolerance: 0.1, closeGapPx: 4 })!;
    expect(count(gapped)).toBe(count(plain));
    // And specifically: it has not crossed the outline.
    expect(gapped.data[20 * W + 10]).toBe(0);
    expect(gapped.data[20 * W + 9]).toBe(0);
  });

  it("gap closing contains the flood and never spills past the outline", () => {
    // Gap closing has one job: stop the leak. It must not also GROW the region,
    // which is what put paint outside the area on every edge of a photograph.
    const mask = resolveRegion(boxWithGap(3), W, H, 20, 20, {
      tolerance: 0.1,
      closeGapPx: 3,
    })!;
    expect(mask.data[20 * W + 5]).toBe(0); // well outside the box
    expect(mask.bounds.x0).toBeGreaterThanOrEqual(10);
    expect(mask.bounds.x1).toBeLessThanOrEqual(29);
    // Contained. Not "smaller than the interior" — restoring what the barrier
    // took reaches a short tongue through the sealed opening, by design (see
    // `geodesicGrow`'s call site) — but nowhere near the leaked case, and never
    // anywhere near the canvas edge.
    expect(count(mask)).toBeLessThan(18 * 18 * 1.4);
    expect(mask.data[0]).toBe(0);
  });

  it("expands and contracts the finished region", () => {
    const base = resolveRegion(boxWithGap(0), W, H, 20, 20, { tolerance: 0.1 })!;
    const grown = resolveRegion(boxWithGap(0), W, H, 20, 20, { tolerance: 0.1, expandPx: 2 })!;
    const shrunk = resolveRegion(boxWithGap(0), W, H, 20, 20, { tolerance: 0.1, expandPx: -2 })!;
    expect(count(grown)).toBeGreaterThan(count(base));
    expect(count(shrunk)).toBeLessThan(count(base));
  });

  it("inverts for paint-outside, and the two halves tile the canvas", () => {
    const inside = resolveRegion(boxWithGap(0), W, H, 20, 20, { tolerance: 0.1 })!;
    const outside = resolveRegion(boxWithGap(0), W, H, 20, 20, { tolerance: 0.1, invert: true })!;
    expect(count(inside) + count(outside)).toBe(W * H);
  });
});

describe("traceRegion", () => {
  it("drops specks by AREA and keeps nesting intact", () => {
    const W = 60;
    const H = 60;
    // A filled square with a square hole, plus a one-pixel speck far away.
    const px = canvas(W, H, (set) => {
      for (let y = 10; y < 50; y++) for (let x = 10; x < 50; x++) set(x, y);
    });
    // Punch the hole back to transparent.
    for (let y = 22; y < 38; y++) {
      for (let x = 22; x < 38; x++) {
        px[(y * W + x) * 4 + 3] = 0;
      }
    }
    const mask = resolveRegion(px, W, H, 12, 12, { tolerance: 0.05 })!;
    const loops = traceRegion(mask, 1, 24);
    // The outer contour and its hole survive; nothing else does.
    expect(loops.length).toBe(2);
    // Largest first, by area — the order a caller reading "the main piece" wants.
    expect(Math.abs(polygonArea(loops[0]!))).toBeGreaterThan(Math.abs(polygonArea(loops[1]!)));
  });

  it("raising the floor only ever removes loops, smallest first", () => {
    // The invariant that makes an area floor nesting-safe, stated as the thing
    // a caller can rely on: the kept set SHRINKS monotonically and always keeps
    // the largest. Slicing by count had neither property — it could drop an
    // outer contour and keep the hole inside it, which fills a window solid.
    const W = 60;
    const H = 60;
    const px = canvas(W, H, (set) => {
      for (let y = 8; y < 52; y++) for (let x = 8; x < 52; x++) set(x, y);
    });
    for (let y = 20; y < 40; y++) for (let x = 20; x < 40; x++) px[(y * W + x) * 4 + 3] = 0;
    const mask = resolveRegion(px, W, H, 10, 10, { tolerance: 0.05 })!;
    const counts = [1, 50, 200, 1000, 100000].map((f) => traceRegion(mask, 1, f).length);
    for (let i = 1; i < counts.length; i++) expect(counts[i]!).toBeLessThanOrEqual(counts[i - 1]!);
    expect(counts[counts.length - 1]).toBe(0);
    // And the survivor at a middling floor is the biggest loop, never a hole.
    const all = traceRegion(mask, 1, 1).map((l) => Math.abs(polygonArea(l)));
    expect(Math.abs(polygonArea(traceRegion(mask, 1, 200)[0]!))).toBe(Math.max(...all));
  });
});

describe("growMask", () => {
  it("is a no-op at 0 and symmetric in sign", () => {
    const m = resolveRegion(
      canvas(20, 20, (set) => {
        for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) set(x, y);
      }),
      20,
      20,
      10,
      10,
      { tolerance: 0.05 },
    )!;
    expect(growMask(m, 0)).toBe(m);
    expect(count(growMask(m, 2))).toBeGreaterThan(count(m));
    expect(count(growMask(m, -2))).toBeLessThan(count(m));
    expect(count(invertMask(m))).toBe(20 * 20 - count(m));
  });
});

describe("maskCoverage", () => {
  it("is binary with no feather and ramps inward with one", () => {
    const m = resolveRegion(
      canvas(30, 30, (set) => {
        for (let y = 5; y < 25; y++) for (let x = 5; x < 25; x++) set(x, y);
      }),
      30,
      30,
      15,
      15,
      { tolerance: 0.05 },
    )!;
    const hard = maskCoverage(m, 0);
    expect(new Set(hard)).toEqual(new Set([0, 255]));
    const soft = maskCoverage(m, 4);
    // Dead centre stays solid; a pixel one in from the boundary does not.
    expect(soft[15 * 30 + 15]).toBe(255);
    expect(soft[6 * 30 + 15]!).toBeLessThan(255);
    expect(soft[6 * 30 + 15]!).toBeGreaterThan(0);
  });
});

// ── Vector merge ────────────────────────────────────────────────────────────

let n = 0;
const mintId = () => `c${n++}`;

/** A closed axis-aligned rectangle contour. */
function rect(x: number, y: number, w: number, h: number): Contour {
  return {
    closed: true,
    points: [
      { x, y, hIn: null, hOut: null },
      { x: x + w, y, hIn: null, hOut: null },
      { x: x + w, y: y + h, hIn: null, hOut: null },
      { x, y: y + h, hIn: null, hOut: null },
    ],
  };
}
const sub = (id: string, c: Contour): Subpath => ({ ...c, id });

describe("mergeStrokeInto", () => {
  it("appends when nothing is touched, and leaves survivors by identity", () => {
    const a = sub("a", rect(0, 0, 10, 10));
    const r = mergeStrokeInto([a], [rect(50, 50, 10, 10)], mintId);
    expect(r.merged).toBe(false);
    expect(r.subpaths).toHaveLength(2);
    expect(r.subpaths[0]).toBe(a);
  });

  it("unions an overlapping stroke into one body, keeping the host's id", () => {
    const a = sub("a", rect(0, 0, 10, 10));
    const r = mergeStrokeInto([a], [rect(5, 0, 10, 10)], mintId);
    expect(r.merged).toBe(true);
    expect(r.absorbed).toEqual(["a"]);
    expect(r.subpaths).toHaveLength(1);
    expect(r.subpaths[0]!.id).toBe("a");
    // One 15×10 body, not two 10×10 rectangles.
    const xs = r.subpaths[0]!.points.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(15, 1);
  });

  it("does not touch contours the stroke misses", () => {
    const a = sub("a", rect(0, 0, 10, 10));
    const far = sub("far", rect(100, 100, 10, 10));
    const r = mergeStrokeInto([a, far], [rect(5, 0, 10, 10)], mintId);
    expect(r.subpaths.some((s) => s === far)).toBe(true);
  });

  it("bridges a near miss only once gaps are being closed", () => {
    const a = sub("a", rect(0, 0, 10, 10));
    const near = rect(13, 0, 10, 10); // 3px short of touching
    expect(mergeStrokeInto([a], [near], mintId).merged).toBe(false);
    const closed = mergeStrokeInto([a], [near], mintId, { closeGapPx: 4 });
    expect(closed.merged).toBe(true);
    expect(closed.subpaths).toHaveLength(1);
  });
});

describe("references", () => {
  it("toggles, and keys order-independently", () => {
    const one = toggleReference(DEFAULT_PAINT_SCOPE.refs, { kind: "clip", id: "a" });
    const two = toggleReference(one, { kind: "track", id: "t" });
    expect(two).toHaveLength(2);
    expect(referenceKey(two)).toBe(referenceKey([...two].reverse()));
    expect(toggleReference(two, { kind: "clip", id: "a" })).toHaveLength(1);
    expect(referenceKey([])).toBe("*");
  });
});
