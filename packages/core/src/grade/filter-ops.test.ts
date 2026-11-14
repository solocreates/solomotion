import { describe, expect, it } from "vitest";
import { applyColorAffines, colorAffineOf, filterCss, isIdentityFilterOp, type FilterOp } from "./filter-ops";

const run = (ops: FilterOp[], rgba: number[]) => {
  const d = new Uint8ClampedArray(rgba);
  applyColorAffines(d, ops.map(colorAffineOf).filter((a) => a !== null));
  return [...d];
};

describe("filter ops — the CPU executor agrees with CSS", () => {
  it("writes the same string the GPU path hands ctx.filter", () => {
    expect(filterCss([{ kind: "blur", px: 4 }, { kind: "brightness", amount: 1.2 }])).toBe("blur(4px) brightness(1.2)");
    expect(filterCss([])).toBe("none");
  });

  it("identity ops are recognised so an idle card costs nothing", () => {
    expect(isIdentityFilterOp({ kind: "saturate", amount: 1 })).toBe(true);
    expect(isIdentityFilterOp({ kind: "blur", px: 0 })).toBe(true);
    expect(isIdentityFilterOp({ kind: "hueRotate", deg: 360 })).toBe(true);
    expect(isIdentityFilterOp({ kind: "contrast", amount: 1.5 })).toBe(false);
  });

  it("grayscale(1) makes grey from the Rec.709 weights; saturate(0) the same family", () => {
    const [r, g, b] = run([{ kind: "grayscale", amount: 1 }], [255, 0, 0, 255]);
    expect(r).toBe(g);
    expect(g).toBe(b);
    expect(r).toBeCloseTo(0.2126 * 255, -0.5);
  });

  it("clamps between ops, as each CSS filter function is its own primitive", () => {
    // brightness(2) saturates white at 255; contrast(1) after it keeps 255, not 510.
    expect(run([{ kind: "brightness", amount: 2 }, { kind: "brightness", amount: 0.5 }], [200, 200, 200, 255]).slice(0, 3)).toEqual([128, 128, 128]);
  });

  it("contrast pivots on mid grey and leaves transparent pixels alone", () => {
    expect(run([{ kind: "contrast", amount: 2 }], [128, 128, 128, 255])[0]).toBeCloseTo(129, -0.5);
    expect(run([{ kind: "contrast", amount: 2 }], [10, 20, 30, 0])).toEqual([10, 20, 30, 0]);
  });
});
