import { describe, expect, it } from "vitest";
import { createEmptyDocument, createGroupClip, createPathClip, createTrack } from "../factories";
import { layerSpecFromPreset } from "../animation/layer-animation";
import { solidPaint } from "../schema/vector";
import { moveClipsToScope } from "../timeline/groups";
import { translateLottie } from "./lottie";

const pt = (x: number, y: number) => ({ x, y, hIn: null, hOut: null });
const line = (len: number, y = 0) => ({ closed: false, points: [pt(0, y), pt(len, y)] });

type J = Record<string, unknown>;
const groups = (layer: J, nm: string): J[] => (layer.shapes as J[]).filter((g) => g.nm === nm);
const trimOf = (g: J): J | undefined => (g.it as J[]).find((i) => i.ty === "tm");

describe("Lottie carries Draw On", () => {
  it("a group's draw-on becomes per-strand baked trims on every member", () => {
    const doc = createEmptyDocument();
    const frameId = doc.frames[0]!.id;
    const group = createGroupClip({ frameId, startMs: 0, durationMs: 2000, name: "Icon" });
    group.animIn = { ...layerSpecFromPreset("draw"), easing: { kind: "linear" }, durationMs: 1000 };
    group.animIn.params.order = 2; // staggered: every strand its own window
    group.animIn.params.stagger = 1;
    const a = createPathClip({ frameId, subpaths: [line(10), line(30, 1)], startMs: 0, durationMs: 2000, name: "a" });
    for (const [i, c] of [group, a].entries()) {
      const lane = createTrack(`l${i}`);
      lane.clips.push(c);
      doc.tracks.push(lane);
    }
    moveClipsToScope(doc, [a.id], group.id);

    const out = translateLottie(doc, null, { includeBackground: false });
    const layer = (out.lottie as J).layers as J[];
    const shape = layer.find((l) => l.nm === "a")!;
    const strokes = groups(shape, "Stroke");
    // One group per strand, each trimmed on its own clock.
    expect(strokes).toHaveLength(2);
    const [t0, t1] = strokes.map((g) => trimOf(g)!);
    expect(t0?.nm).toBe("Draw on");
    const e0 = (t0!.e as J).k as Array<{ t: number; s: number[] }>;
    const e1 = (t1!.e as J).k as Array<{ t: number; s: number[] }>;
    // Both start un-inked and end whole…
    expect(e0[0]!.s[0]).toBe(0);
    expect(e0[e0.length - 1]!.s[0]).toBe(100);
    // …and the second strand lags the first at the same instant (a stagger).
    const mid = Math.floor(e0.length / 4);
    expect(e1[mid]!.s[0]!).toBeLessThan(e0[mid]!.s[0]!);
    expect(out.report.some((r) => r.notes.some((n) => /draw-on baked/.test(n)))).toBe(true);
  });

  it("a filled layer with no stroke gets a synthesised outline and a fading fill", () => {
    const doc = createEmptyDocument();
    const frameId = doc.frames[0]!.id;
    const clip = createPathClip({
      frameId,
      subpaths: [{ closed: true, points: [pt(0, 0), pt(20, 0), pt(20, 20), pt(0, 20)] }],
      startMs: 0,
      durationMs: 2000,
      fill: solidPaint("#ff0000"),
      stroke: null,
      name: "square",
    });
    clip.animIn = { ...layerSpecFromPreset("draw"), easing: { kind: "linear" }, durationMs: 1000 };
    const lane = createTrack("l");
    lane.clips.push(clip);
    doc.tracks.push(lane);

    const out = translateLottie(doc, null, { includeBackground: false });
    const shape = ((out.lottie as J).layers as J[]).find((l) => l.nm === "square")!;
    expect(groups(shape, "Draw on")).toHaveLength(1);
    const fills = groups(shape, "Fills")[0]!;
    const tr = (fills.it as J[]).find((i) => i.ty === "tr")!;
    // "Fade late" (the default): the fill's group opacity is keyed, and starts dark.
    expect((tr.o as J).a).toBe(1);
    expect(((tr.o as J).k as Array<{ s: number[] }>)[0]!.s[0]).toBe(0);
  });
});
