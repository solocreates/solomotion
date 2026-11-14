import { describe, expect, it } from "vitest";
import type { AnalysisFrame, FrameProvider } from "../engine";
import type { DepthTracker } from "../../schema/tracking";
import { affineFit, runDepth, type DepthEngine } from "./run-depth";
import { depthRamp, nearnessAt, type DepthFrame } from "./frame";

/**
 * The depth run's own job, measured with a FAKE network whose truth is known:
 * a scene whose nearness moves over the shot, seen by a "model" that gets
 * the shape right but every window at a different scale and shift — exactly
 * how a relative-depth video model disagrees with itself. The run must hand
 * back one shot: maps that match the truth up to ONE global normalisation,
 * with no step at a window seam.
 */

const SW = 160;
const SH = 90;

/** True nearness of the scene at frame t: a tilted floor plus a disc coming toward the camera. */
function truth(t: number, u: number, v: number): number {
  const floor = 0.2 + 0.5 * v;
  const cx = 0.3 + 0.4 * (t / 100);
  const disc = Math.hypot(u - cx, v - 0.45) < 0.15 ? 0.75 + 0.2 * (t / 100) : 0;
  return Math.max(floor, disc);
}

function provider(frames: number): FrameProvider {
  const times = Array.from({ length: frames }, (_, i) => i * 40);
  return {
    sourceWidth: SW,
    sourceHeight: SH,
    scale: 1,
    times,
    still: false,
    async getFrame(ms): Promise<AnalysisFrame> {
      // The fake model reads the frame index out of the pixels.
      const i = Math.round(ms / 40);
      const rgba = new Uint8ClampedArray(SW * SH * 4);
      rgba.fill(i);
      return { width: SW, height: SH, luma: new Uint8Array(SW * SH).fill(i), rgba };
    },
  };
}

function fakeEngine(frames: number): DepthEngine {
  const W = 32;
  const MW = 64;
  const MH = 36;
  const slots: number[] = new Array(W).fill(0);
  let windowNo = 0;
  return {
    video: {
      width: MW,
      height: MH,
      window: W,
      sense: "disparity",
      async encode(rgb, slot) {
        // Recover the frame index the provider painted (ImageNet-normalised red channel).
        const red = rgb[0]! * 0.229 + 0.485;
        slots[slot] = Math.round(red * 255);
      },
      async head() {
        windowNo++;
        // Each window: the right shape, its own scale and shift.
        const a = 0.6 + 0.35 * Math.sin(windowNo * 1.7);
        const b = 0.3 * Math.cos(windowNo * 2.3);
        return slots.map((i) => {
          const m = new Float32Array(MW * MH);
          for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) m[y * MW + x] = a * truth(Math.min(i, frames - 1), (x + 0.5) / MW, (y + 0.5) / MH) + b;
          return m;
        });
      },
      carry(from, count) {
        for (let k = 0; k < count; k++) slots[k] = slots[from + k]!;
      },
    },
  };
}

const tracker: DepthTracker = {
  kind: "depth",
  id: "d",
  name: "Depth",
  color: "#fff",
  source: { kind: "asset", assetId: "a" },
  via: null,
  solve: { model: "video", mapEdge: 64 },
  maps: null,
  analysis: null,
  dirty: true,
};

describe("depth run", () => {
  it("makes one consistent shot from a model that disagrees with itself every window", async () => {
    const frames = 100;
    const res = await runDepth(provider(frames), tracker, fakeEngine(frames), { signal: new AbortController().signal });
    expect(res.maps.length).toBe(frames);
    expect(res.stats.windows).toBeGreaterThanOrEqual(4);
    // Fit the stored maps to the truth with ONE global affine: what is left is the run's error.
    const cur: Float32Array[] = [];
    const ref: Float32Array[] = [];
    for (let f = 0; f < frames; f++) {
      const m = res.maps[f]!;
      cur.push(Float32Array.from(m, (v) => v / 65535));
      ref.push(Float32Array.from({ length: m.length }, (_, i) => truth(f, ((i % res.width) + 0.5) / res.width, (Math.floor(i / res.width) + 0.5) / res.height)));
    }
    const { a, b } = affineFit(cur, ref);
    // Ignore what the robust range clips on purpose (the outermost half percent).
    let worst = 0;
    for (let f = 0; f < frames; f++)
      for (let i = 0; i < cur[f]!.length; i += 7) {
        const v = cur[f]![i]!;
        if (v <= 0 || v >= 1) continue;
        worst = Math.max(worst, Math.abs(a * v + b - ref[f]![i]!));
      }
    expect(worst).toBeLessThan(0.005);
    // No seam: a pixel on the floor (truth constant over time) does not step between frames.
    const floorPx = Math.floor(res.height * 0.9) * res.width + 2;
    let step = 0;
    for (let f = 1; f < frames; f++) step = Math.max(step, Math.abs(cur[f]![floorPx]! - cur[f - 1]![floorPx]!));
    expect(step).toBeLessThan(0.002);
    // The range is the shot's: something reaches each end.
    const all = res.maps.flatMap((m) => [Math.min(...m), Math.max(...m)]);
    expect(Math.min(...all)).toBe(0);
    expect(Math.max(...all)).toBe(65535);
  });

  it("steadies a per-frame model into a shot when there is no temporal head", async () => {
    const frames = 60;
    let k = 0;
    const engine: DepthEngine = {
      still: {
        sense: "disparity",
        sizeFor: () => ({ width: 64, height: 36 }),
        async estimate(rgb) {
          // A per-frame model: the right shape, a different scale and shift every frame, a little noise.
          const i = Math.round((rgb[0]! * 0.229 + 0.485) * 255);
          k++;
          const a = 0.7 + 0.25 * Math.sin(k * 2.1);
          const b = 0.2 * Math.cos(k * 1.3);
          return Float32Array.from({ length: 64 * 36 }, (_, p) => a * truth(i, ((p % 64) + 0.5) / 64, (Math.floor(p / 64) + 0.5) / 36) + b + 0.003 * Math.sin(p * 12.9898 + k));
        },
      },
    };
    const res = await runDepth(provider(frames), { ...tracker, solve: { model: "video", mapEdge: 64 } }, engine, { signal: new AbortController().signal });
    expect(res.model).toBe("video");
    expect(res.network).toBe("da3-small");
    // A floor pixel's depth stays put frame to frame despite the model's swings.
    const cur = res.maps.map((m) => Float32Array.from(m, (v) => v / 65535));
    const floorPx = Math.floor(res.height * 0.9) * res.width + 2;
    let step = 0;
    for (let f = 1; f < frames; f++) step = Math.max(step, Math.abs(cur[f]![floorPx]! - cur[f - 1]![floorPx]!));
    expect(step).toBeLessThan(0.01);
    // And the shape is still the scene's.
    const ref = cur.map((m, f) => Float32Array.from({ length: m.length }, (_, i) => truth(f, ((i % res.width) + 0.5) / res.width, (Math.floor(i / res.width) + 0.5) / res.height)));
    const { a, b } = affineFit(cur, ref);
    let rms = 0;
    let n = 0;
    for (let f = 0; f < frames; f++) for (let i = 0; i < cur[f]!.length; i += 5) (rms += (a * cur[f]![i]! + b - ref[f]![i]!) ** 2), n++;
    expect(Math.sqrt(rms / n)).toBeLessThan(0.02);
  });

  it("reads a frame in normalised source coordinates, and ramps a band smoothly", () => {
    const f: DepthFrame = { width: 2, height: 1, data: Uint16Array.from([0, 65535]) };
    expect(nearnessAt(f, 0, 0.5)).toBeCloseTo(0, 6);
    expect(nearnessAt(f, 1, 0.5)).toBeCloseTo(1, 6);
    expect(nearnessAt(f, 0.5, 0.5)).toBeCloseTo(0.5, 6);
    expect(depthRamp(0.2, 0.3, 0.6)).toBe(0);
    expect(depthRamp(0.7, 0.3, 0.6)).toBe(1);
    expect(depthRamp(0.45, 0.3, 0.6)).toBeCloseTo(0.5, 6);
  });
});
