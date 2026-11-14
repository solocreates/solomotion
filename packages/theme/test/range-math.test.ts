import { describe, expect, it } from "vitest";
import {
  blockFills,
  niceStep,
  rangeDetent,
  rangeStep,
  rulerScale,
  snapBlocks,
  snapRuler,
  stepBlocks,
  stepOpacities,
  stepRuler,
} from "../src/range-math";

describe("ruler scale", () => {
  it("picks 1-2-5 steps", () => {
    expect(niceStep(12.5)).toBe(10);
    expect(niceStep(0.3)).toBe(0.2);
    expect(niceStep(40)).toBe(50);
  });
  it("splits majors into readable minors", () => {
    expect(rulerScale(0, 100)).toMatchObject({ major: 10, minor: 2 });
    expect(rulerScale(0, 400)).toMatchObject({ major: 50, minor: 10 });
    expect(rulerScale(0, 2)).toMatchObject({ major: 0.2, minor: 0.05 });
  });
  it("reads angles in 45° majors and 15° minors", () => {
    expect(rulerScale(-180, 180, { unit: "°" })).toEqual({ major: 45, minor: 15, origin: -180 });
  });
});

describe("ruler detents", () => {
  const s = rulerScale(0, 100); // major 10, minor 2
  it("snaps to the nearest minor tick", () => {
    expect(snapRuler(33.1, s)).toBe(34);
    expect(snapRuler(36.9, s)).toBe(36);
  });
  it("pulls harder near a major tick", () => {
    // 41.1 is nearest the minor at 42 by distance, but within 0.6 minor of 40.
    expect(snapRuler(41.1, s)).toBe(40);
    expect(snapRuler(38.9, s)).toBe(40);
  });
  it("Shift frees it", () => {
    expect(snapRuler(33.1, s, { free: true })).toBe(33.1);
  });
  it("arrows step one minor tick, and land on a tick from between two", () => {
    expect(stepRuler(34, 1, s)).toBe(36);
    expect(stepRuler(34, -1, s)).toBe(32);
    expect(stepRuler(33.1, 1, s)).toBe(34);
    expect(stepRuler(33.1, -1, s)).toBe(32);
    expect(stepRuler(100, 1, s, { max: 100 })).toBe(100);
  });
});

describe("blocks", () => {
  it("fill by exact share, so the last lit block is partial", () => {
    expect(blockFills(0.37)).toEqual([1, 1, 1, 0.7, 0, 0, 0, 0, 0, 0]);
    expect(blockFills(1)).toEqual(Array(10).fill(1));
    expect(blockFills(-1)).toEqual(Array(10).fill(0));
  });
  it("steps show the same value by opacity", () => {
    const o = stepOpacities(0.25);
    expect(o.slice(0, 2)).toEqual([1, 1]);
    expect(o[2]).toBeCloseTo(0.625);
    expect(o[3]).toBe(0);
  });
  it("rest on whole blocks unless Shift frees them", () => {
    expect(snapBlocks(0.37)).toBe(0.4);
    expect(snapBlocks(0.37, 10, true)).toBe(0.37);
    expect(stepBlocks(0.37, 1)).toBe(0.4);
    expect(stepBlocks(0.4, 1)).toBe(0.5);
    expect(stepBlocks(0.4, -1)).toBe(0.3);
  });
});

describe("dialect as behaviour", () => {
  it("only ruler and blocks/steps have detents", () => {
    expect(rangeDetent("trail", 33.3, 0, 100)).toBe(33.3);
    expect(rangeDetent("meter", 33.3, 0, 100)).toBe(33.3);
    expect(rangeDetent("ruler", 33.3, 0, 100)).toBe(34);
    expect(rangeDetent("blocks", 33.3, 0, 100)).toBe(30);
    expect(rangeDetent("steps", 33.3, 0, 100, { free: true })).toBe(33.3);
    expect(rangeStep("meter", 10, 1, 0, 100)).toBeNull();
    expect(rangeStep("ruler", 10, 1, 0, 100)).toBe(12);
    expect(rangeStep("blocks", 10, 1, 0, 100)).toBe(20);
  });
});

import { fundLine, settleFund, stepFund } from "../src/fund";
describe("fund amounts", () => {
  it("rest on the stops when near, free with Shift", () => {
    expect(settleFund(24)).toBe(25);
    expect(settleFund(24, true)).toBe(24);
    expect(settleFund(37)).toBe(37);
    expect(settleFund(900)).toBe(500);
  });
  it("arrows jump stop to stop", () => {
    expect(stepFund(25, 1)).toBe(50);
    expect(stepFund(25, -1)).toBe(10);
    expect(stepFund(100, 1)).toBe(150);
    expect(stepFund(3, -1)).toBe(1);
  });
  it("answers each amount", () => {
    expect(fundLine(100)).toMatch(/believer/);
    expect(fundLine(1)).toMatch(/counts/);
  });
});
