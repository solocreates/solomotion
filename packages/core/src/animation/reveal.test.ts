import { describe, expect, it } from "vitest";
import { createEmptyDocument, createGroupClip, createPathClip, createTrack } from "../factories";
import { moveClipsToScope } from "../timeline/groups";
import { groupNeedsIsolation } from "../timeline/group-paint";
import { measureCommands, trimSubpaths } from "../vector/trim";
import { buildStrokePlan } from "../vector/stroke";
import { strokeStyle, solidPaint } from "../schema/vector";
import { clipRevealAt, clipHasOutline } from "../vector/reveal-strands";
import { layerPoseAt, layerPresetsFor, layerSpecFromPreset } from "./layer-animation";
import { GLYPH_IDENTITY } from "./presets";
import { layerRevealAt, revealFillAlpha, revealFromParams, strandProgress, strandWindows } from "./reveal";
import type { PathCommand } from "../vector/geometry";

const pt = (x: number, y: number) => ({ x, y, hIn: null, hOut: null });
/** An open horizontal line of the given length. */
const line = (len: number, y = 0) => ({ closed: false, points: [pt(0, y), pt(len, y)] });

const reveal = (progress: number, p: Record<string, number> = {}) => revealFromParams(progress, p);

describe("strand progress", () => {
  const lengths = [10, 30, 60];

  it("together: every strand at the reveal's progress", () => {
    expect(strandProgress(lengths, reveal(0.4, { order: 0 }))).toEqual([0.4, 0.4, 0.4]);
  });

  it("one by one: the pen never lifts, so progress runs along the total length", () => {
    // 40% of 100 = 40px: strand 0 (10) done, strand 1 (30) done, strand 2 at 0.
    expect(strandProgress(lengths, reveal(0.4, { order: 1 }))).toEqual([1, 1, 0]);
    // 70px in: strand 2 has 30 of its 60.
    const p = strandProgress(lengths, reveal(0.7, { order: 1 }));
    expect(p[2]).toBeCloseTo(0.5);
  });

  it("staggered: 0 is together, 1 is strictly one after another by count, more leaves a pause", () => {
    expect(strandProgress(lengths, reveal(0.5, { order: 2, stagger: 0 }))).toEqual([0.5, 0.5, 0.5]);
    const seq = strandProgress(lengths, reveal(0.5, { order: 2, stagger: 1 }));
    // Three equal shares: at 0.5 the second strand is half way.
    expect(seq[0]).toBe(1);
    expect(seq[1]).toBeCloseTo(0.5);
    expect(seq[2]).toBe(0);
    // A pause: with 1.5 shares between starts, the second strand has not begun
    // when the first is done.
    const gap = strandProgress(lengths, reveal(1 / (1 + 2 * 1.5), { order: 2, stagger: 1.5 }));
    expect(gap[0]).toBeCloseTo(1);
    expect(gap[1]).toBe(0);
  });

  it("top first reads the same clock from the other end", () => {
    const p = strandProgress(lengths, reveal(0.4, { order: 1, topFirst: 1 }));
    // 40px of 100 from the top: the 60 is two thirds done, the rest untouched.
    expect(p[2]).toBeCloseTo(2 / 3);
    expect(p[0]).toBe(0);
  });

  it("both ends of the clock are total", () => {
    for (const order of [0, 1, 2]) {
      expect(strandProgress(lengths, reveal(0, { order }))).toEqual([0, 0, 0]);
      expect(strandProgress(lengths, reveal(1, { order }))).toEqual([1, 1, 1]);
    }
  });

  it("origin and direction place the inked span as an offset window", () => {
    // Backward from the end: the span [0.5,1] is [0,0.5] rotated by 0.5.
    expect(strandWindows([1], reveal(0.5, { order: 0, origin: 1, direction: 1 }))[0]).toEqual([0, 0.5, 0.5]);
    // Both ways from the middle: [0.25,0.75].
    expect(strandWindows([1], reveal(0.5, { order: 0, origin: 0.5, direction: 2 }))[0]).toEqual([0, 0.5, 0.25]);
    // Forward from a third of the way in.
    expect(strandWindows([1], reveal(0.5, { order: 0, origin: 0.3 }))[0]).toEqual([0, 0.5, 0.3]);
  });

  it("fill modes", () => {
    expect(revealFillAlpha(reveal(0.2, { fill: 0 }))).toBe(1);
    expect(revealFillAlpha(reveal(0.2, { fill: 1 }))).toBe(0.2);
    expect(revealFillAlpha(reveal(0.2, { fill: 2 }))).toBe(0);
    expect(revealFillAlpha(reveal(1, { fill: 2 }))).toBe(1);
  });
});

describe("per-subpath trimming", () => {
  const cmds: PathCommand[] = [
    { type: "M", x: 0, y: 0 },
    { type: "L", x: 10, y: 0 },
    { type: "M", x: 0, y: 5 },
    { type: "L", x: 40, y: 5 },
  ];

  it("measures each subpath", () => {
    expect(measureCommands(cmds)).toEqual([10, 40]);
  });

  it("cuts each subpath to its own window and drops empty ones", () => {
    const out = trimSubpaths(cmds, [
      [0, 0.5, 0],
      [0, 0, 0],
    ]);
    expect(out).toEqual([
      { type: "M", x: 0, y: 0 },
      { type: "L", x: 5, y: 0 },
    ]);
  });

  it("the stroke plan applies the reveal before the stroke's own trim", () => {
    const s = strokeStyle(solidPaint("#000"), { width: 2, trim: { start: 0, end: 0.5, offset: 0 } });
    // Reveal inks the first half of each strand; the trim keeps half of THAT.
    const plan = buildStrokePlan(cmds, s, [
      [0, 0.5, 0],
      [0, 0.5, 0],
    ]);
    expect(measureCommands(plan.path!).reduce((a, b) => a + b, 0)).toBeCloseTo(12.5);
  });
});

describe("the draw-on layer preset", () => {
  it("is a reveal, not a pose — the compositor sees the identity", () => {
    const doc = createEmptyDocument();
    const clip = createPathClip({ frameId: doc.frames[0]!.id, subpaths: [line(100)], startMs: 0, durationMs: 2000 });
    clip.animIn = layerSpecFromPreset("draw");
    clip.animIn.easing = { kind: "linear" };
    expect(layerPoseAt(clip, 300)).toBe(GLYPH_IDENTITY);
    const r = layerRevealAt(clip, 450);
    expect(r?.progress).toBeCloseTo(0.5);
    // Settled: nothing to reveal any more.
    expect(layerRevealAt(clip, 1500)).toBeNull();
  });

  it("an exit lifts the ink backwards", () => {
    const doc = createEmptyDocument();
    const clip = createPathClip({ frameId: doc.frames[0]!.id, subpaths: [line(100)], startMs: 0, durationMs: 2000 });
    clip.animOut = { ...layerSpecFromPreset("draw"), easing: { kind: "linear" }, durationMs: 1000 };
    expect(layerRevealAt(clip, 500)).toBeNull();
    expect(layerRevealAt(clip, 1750)?.progress).toBeCloseTo(0.25);
  });

  it("is only offered to layers with an outline", () => {
    const doc = createEmptyDocument();
    const frameId = doc.frames[0]!.id;
    const path = createPathClip({ frameId, subpaths: [line(10)], startMs: 0 });
    const group = createGroupClip({ frameId, startMs: 0, durationMs: 1000 });
    expect(layerPresetsFor(doc, path).some((p) => p.id === "draw")).toBe(true);
    // An empty group holds nothing to draw.
    const lane = createTrack("g");
    lane.clips.push(group);
    doc.tracks.push(lane);
    expect(clipHasOutline(doc, group)).toBe(false);
    expect(layerPresetsFor(doc, group).some((p) => p.id === "draw")).toBe(false);
  });
});

describe("a group's draw-on reads through to its members", () => {
  function iconDoc() {
    const doc = createEmptyDocument();
    const frameId = doc.frames[0]!.id;
    const group = createGroupClip({ frameId, startMs: 1000, durationMs: 4000, name: "Icon" });
    const a = createPathClip({ frameId, subpaths: [line(10)], startMs: 1000, durationMs: 4000, name: "a" });
    const b = createPathClip({ frameId, subpaths: [line(30), line(60, 1)], startMs: 1000, durationMs: 4000, name: "b" });
    for (const [i, c] of [group, a, b].entries()) {
      const lane = createTrack(`l${i}`);
      lane.clips.push(c);
      doc.tracks.push(lane);
    }
    moveClipsToScope(doc, [a.id, b.id], group.id);
    group.animIn = { ...layerSpecFromPreset("draw"), easing: { kind: "linear" }, durationMs: 1000 };
    group.animIn.params.order = 1; // one by one, along the total length
    return { doc, group, a, b };
  }

  it("distributes one clock across every strand beneath it, bottom first", () => {
    const { doc, a, b } = iconDoc();
    // Bottom of the stack (b, on the last lane) draws first: strands run
    // 30, 60, then a's 10 — total 100, so at 40% the 30 is done and the 60 is
    // 10px in.
    const atB = clipRevealAt(doc, b, 400, 1400)!;
    expect(atB.windows[0]![1]).toBe(1);
    expect(atB.windows[1]![1]).toBeCloseTo(1 / 6);
    const atA = clipRevealAt(doc, a, 400, 1400)!;
    expect(atA.windows[0]![1]).toBe(0);
    // A path born with a stroke inks that stroke; strip it and the outline
    // is synthesised from the fill instead.
    expect(atA.synthesiseOutline).toBe(false);
    a.strokes = [];
    expect(clipRevealAt(doc, a, 400, 1400)!.synthesiseOutline).toBe(true);
  });

  it("a member's own draw-on overrides the group's", () => {
    const { doc, a } = iconDoc();
    a.animIn = { ...layerSpecFromPreset("draw"), easing: { kind: "linear" }, durationMs: 1000 };
    a.animIn.params.order = 0;
    const own = clipRevealAt(doc, a, 250, 1250)!;
    expect(own.windows[0]![1]).toBeCloseTo(0.25);
    expect(own.windows[0]![2]).toBe(0);
  });

  it("is over once the edge has played", () => {
    const { doc, b } = iconDoc();
    expect(clipRevealAt(doc, b, 3000, 4000)).toBeNull();
  });

  it("does not make the group isolate", () => {
    const { group } = iconDoc();
    expect(groupNeedsIsolation(group)).toBe(false);
    group.animIn = layerSpecFromPreset("fade-up");
    expect(groupNeedsIsolation(group)).toBe(true);
  });
});
