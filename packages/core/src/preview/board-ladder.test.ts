import { describe, expect, it } from "vitest";
import {
  BOARD_RUNG_IDLE_MS,
  boardFirstLevel,
  boardLevel,
  boardMaxSide,
  coarserRung,
  parkedLevel,
  pickRung,
  trimRungs,
} from "./board-ladder";

describe("board ladder", () => {
  it("sizes the longest side from the budget, within 1024–4096", () => {
    expect(boardMaxSide(0)).toBe(1024);
    expect(boardMaxSide(128 * 1024 * 1024)).toBe(2048);
    expect(boardMaxSide(512 * 1024 * 1024)).toBe(4096);
    expect(boardMaxSide(64 * 1024 ** 3)).toBe(4096);
  });

  it("levels are powers of two, capped by the longest side", () => {
    expect(boardLevel(0.3, 1080, 1920, 4096)).toBe(0.5);
    expect(boardLevel(1, 1080, 1920, 4096)).toBe(1);
    // Deep zoom: capped at 4096 / 1920, never null.
    expect(boardLevel(64, 1080, 1920, 4096)).toBeCloseTo(4096 / 1920);
    expect(boardLevel(64, 1080, 1920, 2048)).toBeCloseTo(2048 / 1920);
    expect(boardLevel(0, 100, 100, 4096)).toBeNull();
  });

  it("a first picture is a quarter of the zoom, never tiny", () => {
    expect(boardFirstLevel(1, 1080, 1920)).toBe(0.25);
    expect(boardFirstLevel(0.25, 1080, 1920)).toBeCloseTo(320 / 1920);
  });

  it("draws the smallest rung that covers the zoom, else the sharpest", () => {
    expect(pickRung([2, 0.5, 0.125], 0.4)).toBe(1);
    expect(pickRung([2, 0.5, 0.125], 0.1)).toBe(2);
    expect(pickRung([0.5, 0.125], 1)).toBe(0);
    expect(pickRung([], 1)).toBe(-1);
  });

  it("derives a coarser rung only past a factor of two", () => {
    expect(coarserRung(2, 1)).toBeNull();
    expect(coarserRung(2, 0.3)).toBe(0.5);
    expect(coarserRung(2, 0.02)).toBe(1 / 32);
  });

  it("drops rungs nobody drew, keeps a parked thumbnail when nothing is watched", () => {
    const now = 100_000;
    const fresh = now - 10;
    const stale = now - BOARD_RUNG_IDLE_MS - 1;
    // Zoomed back out: the sharp rung goes, the drawn one stays.
    expect(trimRungs([{ level: 2, lastDrawn: stale }, { level: 0.25, lastDrawn: fresh }], now, 1080, 1920)).toEqual({ drop: [0], park: null });
    // A page you left: one rung, parked at thumbnail size.
    const left = trimRungs([{ level: 2, lastDrawn: stale }, { level: 0.5, lastDrawn: stale }], now, 1080, 1920);
    expect(left.drop).toEqual([0]);
    expect(left.park).toBe(parkedLevel(1080, 1920));
    expect(parkedLevel(1080, 1920) * 1920).toBeLessThanOrEqual(512);
    // Already small: kept as it is.
    expect(trimRungs([{ level: 1 / 8, lastDrawn: stale }], now, 1080, 1920)).toEqual({ drop: [], park: null });
  });
});
