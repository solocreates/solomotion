import { describe, expect, it } from "vitest";
import {
  FREEZE_EPSILON,
  SPEED_PROPERTY,
  clipSourceSpanMs,
  applySpeedRamp,
  clipSpeedCurve,
  freezeKeys,
  speedKeyBounds,
  isRetimed,
  rampKeys,
  retimedSourceMs,
  speedAt,
  speedSegments,
} from "./retime";
import { setKeyframe } from "./keyframes";
import { clipSourceTimeAt, clipSourcePhaseAt } from "../timeline/ops";
import { createEmptyDocument, createNestedClip } from "../factories";
import type { MotionDocument, Clip, Easing } from "../schema";

/** A nested clip is the simplest thing that carries `playback`. */
function retimable(durationMs = 4000): { doc: MotionDocument; clip: Clip } {
  const doc = createEmptyDocument();
  const frameId = doc.frames[0]!.id;
  const source = { ...doc.frames[0]!, id: "src", durationMs };
  doc.frames.push(source);
  const clip = createNestedClip({ frameId, sourceFrameId: "src", startMs: 0, durationMs });
  doc.tracks[0]!.clips.push(clip);
  return { doc, clip };
}

/** Linear unless told otherwise — the integral of an EASED ramp is not ½bh. */
function key(clip: Clip, timeMs: number, value: number, easing: Easing = { kind: "linear" }): void {
  setKeyframe(clip.keyframes, SPEED_PROPERTY, timeMs, value, easing);
}

describe("speed as a keyframed property", () => {
  it("costs nothing and changes nothing when the speed is a plain number", () => {
    const { clip } = retimable();
    expect(clipSpeedCurve(clip)).toBeNull();
    expect(isRetimed(clip)).toBe(false);
    expect(speedAt(clip, 1000)).toBe(1);
  });

  it("integrates a CONSTANT rate to exactly t × rate — the old behaviour", () => {
    const { clip } = retimable();
    key(clip, 0, 2);
    key(clip, 4000, 2);
    const curve = clipSpeedCurve(clip)!;
    expect(retimedSourceMs(curve, 1000)).toBeCloseTo(2000, 6);
    expect(retimedSourceMs(curve, 4000)).toBeCloseTo(8000, 6);
  });

  it("integrates a LINEAR ramp exactly (the trapezoid rule is not an approximation here)", () => {
    const { clip } = retimable();
    key(clip, 0, 0);
    key(clip, 4000, 2);
    // Area under a straight line from 0 to 2 over 4s = ½ · 4000 · 2 = 4000.
    expect(retimedSourceMs(clipSpeedCurve(clip)!, 4000)).toBeCloseTo(4000, 3);
    // And half way: ½ · 2000 · 1 = 1000.
    expect(retimedSourceMs(clipSpeedCurve(clip)!, 2000)).toBeCloseTo(1000, 3);
  });

  it("holds the first and last rates outside the keyed span", () => {
    const { clip } = retimable();
    key(clip, 1000, 4);
    key(clip, 2000, 4);
    const curve = clipSpeedCurve(clip)!;
    expect(retimedSourceMs(curve, 500)).toBeCloseTo(2000, 6); // 500 × 4
    expect(retimedSourceMs(curve, 3000)).toBeCloseTo(12_000, 6); // 3000 × 4
  });

  it("never runs backwards through a freeze: the source stops and resumes", () => {
    const { doc, clip } = retimable();
    for (const k of freezeKeys(1000, 1000, 1)) key(clip, k.timeMs, k.value, k.easing);
    // Within a few ms: a hard cut is expressed as a CUT_MS ramp, so the
    // transition itself reads about half a millisecond of source. Nothing plays
    // during a sixteenth of a frame.
    const at = (t: number) => clipSourceTimeAt(doc, clip, t);
    expect(at(1000)).toBeCloseTo(1000, -1);
    expect(at(1500)).toBeCloseTo(1000, -1); // held
    expect(at(2000)).toBeCloseTo(1000, -1); // still held
    expect(at(3000)).toBeCloseTo(2000, -1); // resumed, one second later
  });

  it("a freeze reports itself as HELD — the flag the transport parks on", () => {
    const { doc, clip } = retimable();
    for (const k of freezeKeys(1000, 1000, 1)) key(clip, k.timeMs, k.value, k.easing);
    expect(speedAt(clip, 1500)).toBeLessThan(FREEZE_EPSILON);
    expect(clipSourcePhaseAt(doc, clip, 1500).sourceMs).toBeCloseTo(1000, -1);
    // `held` is what makes a freeze REAL rather than very slow: the video
    // element is parked on the frame it is already showing instead of rolled
    // at a crawl, so there is no seek, no jump, and nothing to resync when the
    // hold ends. Before and after, the source is advancing and it is false.
    expect(clipSourcePhaseAt(doc, clip, 1500).held).toBe(true);
    expect(clipSourcePhaseAt(doc, clip, 500).held).toBe(false);
    expect(clipSourcePhaseAt(doc, clip, 2500).held).toBe(false);
  });

  it("a ramp is never held — a slow rate is still a moving one", () => {
    const { doc, clip } = retimable();
    for (const k of rampKeys(0, 2000, 1, 0.1)) key(clip, k.timeMs, k.value, k.easing);
    expect(clipSourcePhaseAt(doc, clip, 1900).held).toBe(false);
  });

  it("reports the source it consumes over the whole clip", () => {
    const { clip } = retimable();
    key(clip, 0, 0.5);
    key(clip, 4000, 0.5);
    expect(clipSourceSpanMs(clip)).toBeCloseTo(2000, 3);
  });

  it("memoises per clip object, so it can be called per frame", () => {
    const { clip } = retimable();
    key(clip, 0, 2);
    expect(clipSpeedCurve(clip)).toBe(clipSpeedCurve(clip));
  });
});

describe("ramping without drawing a V", () => {
  it("carries the new rate FORWARD instead of ramping straight back up", () => {
    const { clip } = retimable();
    // A first ramp down, then a second one deeper. Writing only each ramp's own
    // two keys leaves the old trailing rate in place, so the curve climbs back
    // out between them — the dip nobody drew.
    applySpeedRamp(clip, 500, 500, 0.5);
    applySpeedRamp(clip, 2000, 500, 0.25);
    const rates = speedSegments(clip).map((s) => [s.kind, s.fromRate, s.toRate]);
    expect(rates).toEqual([
      ["hold", 1, 1],
      ["ramp", 1, 0.5],
      ["hold", 0.5, 0.5],
      ["ramp", 0.5, 0.25],
      ["hold", 0.25, 0.25],
    ]);
  });

  it("stops carrying at the first rate someone deliberately set", () => {
    const { clip } = retimable();
    key(clip, 0, 1);
    key(clip, 1000, 1); // a continuation of 1× — this one moves
    key(clip, 3000, 2); // a decision — this one does not
    applySpeedRamp(clip, 200, 500, 0.5);
    expect(speedSegments(clip).at(-1)!.fromRate).toBe(2);
  });

  it("a key may not be dragged across its neighbours", () => {
    const { clip } = retimable();
    applySpeedRamp(clip, 1000, 500, 0.5);
    const keys = clip.keyframes.find((t) => t.property === SPEED_PROPERTY)!.keys;
    const bounds = speedKeyBounds(clip, keys[1]!.id)!;
    expect(bounds.lo).toBeGreaterThanOrEqual(1000);
    expect(bounds.hi).toBe(4000);
    expect(speedKeyBounds(clip, "nope")).toBeNull();
  });
});

describe("segments — the projection the panel edits", () => {
  it("is one flat segment when nothing is keyed", () => {
    const { clip } = retimable();
    const segs = speedSegments(clip);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ startMs: 0, endMs: 4000, fromRate: 1, kind: "hold", frozen: false });
  });

  it("splits at every key, and names the ramps", () => {
    const { clip } = retimable();
    for (const k of rampKeys(1000, 2000, 1, 0.25)) key(clip, k.timeMs, k.value, k.easing);
    const segs = speedSegments(clip);
    expect(segs.map((s) => [s.startMs, s.endMs])).toEqual([
      [0, 1000],
      [1000, 2000],
      [2000, 4000],
    ]);
    expect(segs[0]!.kind).toBe("hold"); // holds the first key's rate
    expect(segs[1]!.kind).toBe("ramp"); // the ramp itself
    expect(segs[1]!.fromRate).toBe(1);
    expect(segs[1]!.toRate).toBe(0.25);
    expect(segs[2]!.fromRate).toBe(0.25);
  });

  it("marks a frozen stretch so the clip can draw it as a hold", () => {
    const { clip } = retimable();
    for (const k of freezeKeys(1000, 1000, 1)) key(clip, k.timeMs, k.value, k.easing);
    const frozen = speedSegments(clip).filter((s) => s.frozen);
    expect(frozen).toHaveLength(1);
    expect(frozen[0]).toMatchObject({ startMs: 1000, endMs: 2000 });
  });
});
