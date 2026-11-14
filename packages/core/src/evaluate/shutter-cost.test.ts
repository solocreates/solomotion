import { describe, expect, it } from "vitest";
import type { MotionDocument, ShapeClip, VisualClip } from "../schema";
import { physicsSchema, simulationSchema } from "../schema/physics";
import { fxToken } from "../schema/expressions";
import { createEmptyDocument, createShapeClip, createTrack } from "../factories";
import { clipByIdIn } from "../timeline/frame-index";
import { settleDocument } from "../timeline/settled";
import { POLICY_FULL, resolveMotionBlur, resolveShutter, shutterWindow } from "../animation/shutter";
import { bakeCount, clipAtInstant, resolvedDocAt } from "./resolved-doc";

/**
 * THE SHUTTER'S COST SHAPE — the "How many balls" reel (2026-10-30): a tall
 * comp full of bouncing bodies with the default motion blur, and a navigator
 * of chips whose every field is an expression of `#time`. Each body's shutter
 * reads it at a handful of sub-frame instants (`clipAtInstant`), and the count
 * differs per body because it follows speed — so one frame asks about dozens of
 * distinct instants. Each used to be a whole-comp bake, all ~700 expressions
 * included: 6–9 s a frame where blur off took 0.3 s.
 *
 * The guard is on BAKES, not milliseconds: a sub-sample of a body costs its own
 * pose, so a frame with any number of blurred bodies bakes the comp once.
 * `STUDIO_BENCH=1` also times frames (the numbers in the commit message).
 */

const FPS = 30;

function reel(bodies: number, chips: number): { doc: MotionDocument; frameId: string; balls: string[]; driven: string[] } {
  const doc = createEmptyDocument();
  const frame = doc.frames[0]!;
  frame.width = 1080;
  frame.height = 1920;
  frame.fps = FPS;
  frame.physics = simulationSchema.parse({ gravity: 981, floor: true, walls: true });
  const lane = (c: VisualClip) => {
    const t = createTrack(c.name);
    t.clips.push(c);
    doc.tracks.push(t);
    return c;
  };
  let s = 7;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const balls: string[] = [];
  for (let i = 0; i < bodies; i++) {
    const b = createShapeClip({ frameId: frame.id, shape: "ellipse", startMs: 0, durationMs: 20000, x: (rnd() - 0.5) * 900, y: (rnd() - 0.5) * 1500, width: 36, height: 36 }) as ShapeClip;
    b.name = `Ball ${i + 1}`;
    const a = rnd() * Math.PI * 2, v = 200 + rnd() * 900;
    b.physics = physicsSchema.parse({ bounce: 1, friction: 0, damping: 0, velocity: [Math.cos(a) * v, Math.sin(a) * v, 0] });
    balls.push(lane(b).id);
  }
  // The navigator: every chip's place, fade, size, turn and lift follow the count.
  const K = "floor(71 * pow(clamp(#time / 15.4, 0, 1), 1.8))";
  const driven: string[] = [];
  for (let i = 0; i < chips; i++) {
    const c = createShapeClip({ frameId: frame.id, shape: "rect", startMs: 0, durationMs: 20000, x: 0, y: 520, width: 116, height: 116 }) as ShapeClip;
    c.name = `Chip ${i + 1}`;
    c.drivers = {};
    const at = `(${i} - ${K})`;
    const fields: Record<string, string> = {
      x: `-150 + 150 * ${at}`,
      opacity: `clamp(1 - abs(${at}) / 3, 0, 1)`,
      scale: `1 + 0.2 * smoothstep(0, 0.35, 1 - abs(${at}))`,
      rotation: `sin(#time * 2 + ${i}) * 4`,
      y: `520 - 12 * smoothstep(0, 1, 1 - abs(${at}))`,
    };
    for (const [path, source] of Object.entries(fields)) {
      const id = `fx_${i}_${path}`;
      doc.expressions.push({ id, source, name: "" });
      c.drivers[path] = fxToken(id);
    }
    driven.push(lane(c).id);
  }
  return { doc: settleDocument(doc), frameId: frame.id, balls, driven };
}

/** One frame as the renderer reads it: the bake, then every blurred layer's shutter. */
function frameReads(doc: MotionDocument, frameId: string, ids: string[], compMs: number): number {
  const frame = doc.frames.find((f) => f.id === frameId)!;
  const bake = resolvedDocAt(doc, compMs, frameId);
  let samples = 0;
  for (const id of ids) {
    const clip = clipByIdIn(bake, id) as VisualClip;
    const local = compMs - clip.startMs;
    const blur = resolveMotionBlur(frame, clip, POLICY_FULL, local);
    if (!blur) continue;
    const at = (t: number) => clipAtInstant(bake, clip, compMs + (t - local)).clip.transform;
    const { openMs, closeMs } = shutterWindow(1000 / FPS, local, blur.settings);
    const a = at(openMs), b = at(closeMs);
    const dx = b.x - a.x, dy = b.y - a.y;
    const plan = resolveShutter({ frameIntervalMs: 1000 / FPS, localMs: local, ...blur }, { px: Math.hypot(dx, dy), dx, dy } as never);
    if (!plan) continue;
    for (const sample of plan.samples) at(sample.timeMs);
    samples += plan.samples.length;
  }
  return samples;
}

describe("the shutter's cost", () => {
  it("bakes a comp of blurred bodies and driven layers once per frame, however many sub-samples it reads", () => {
    const { doc, frameId, balls, driven } = reel(40, 60);
    for (const ms of [2000, 2033.3333]) {
      const before = bakeCount();
      const samples = frameReads(doc, frameId, [...balls, ...driven], ms);
      // The bodies moved and blurred, at many distinct instants…
      expect(samples).toBeGreaterThan(balls.length * 2);
      // …and the comp was baked for the frame alone.
      expect(bakeCount() - before).toBe(1);
    }
  });

  it("smears a driven layer through its own drivers at each sub-sample", () => {
    const { doc, frameId, driven } = reel(1, 3);
    const bake = resolvedDocAt(doc, 1000, frameId);
    const chip = clipByIdIn(bake, driven[0]!) as VisualClip;
    const before = bakeCount();
    const r = [990, 1000, 1010].map((t) => clipAtInstant(bake, chip, t).clip.transform.rotation);
    expect(bakeCount()).toBe(before);
    // rotation = sin(2t) * 4: exactly what a full bake at each instant says.
    r.forEach((v, k) => expect(v).toBeCloseTo(Math.sin(2 * ((990 + 10 * k) / 1000)) * 4, 6));
  });

  it.runIf(!!process.env.STUDIO_BENCH)("bench: 130 blurred bodies + 700 time expressions", () => {
    const { doc, frameId, balls, driven } = reel(130, 140);
    const ids = [...balls, ...driven];
    frameReads(doc, frameId, ids, 1000); // the simulation, warmed
    const frames = 10;
    const b0 = bakeCount();
    const t0 = performance.now();
    let samples = 0;
    for (let f = 0; f < frames; f++) samples += frameReads(doc, frameId, ids, 3000 + (f * 1000) / FPS);
    const ms = (performance.now() - t0) / frames;
    console.log(`[shutter bench] ${ms.toFixed(1)} ms/frame · ${((bakeCount() - b0) / frames).toFixed(1)} bakes/frame · ${(samples / frames).toFixed(0)} sub-samples/frame`);
  }, 600_000);
});
