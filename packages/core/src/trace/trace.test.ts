import { describe, expect, it } from "vitest";
import type { MotionDocument, Clip, ShapeClip, TraceClip } from "../schema";
import { fxToken } from "../schema/expressions";
import { keyframeTrackSchema } from "../schema/animation";
import { physicsSchema, simulationSchema } from "../schema/physics";
import { createEmptyDocument, createFrame, createNestedClip, createShapeClip, createTraceClip, createTrack } from "../factories";
import { resolvedDocAt } from "../evaluate/resolved-doc";
import { clipByIdIn } from "../timeline/frame-index";
import { layerContentRefs } from "../timeline/layer-content";
import { parseDocument, serializeDocument } from "../io";
import { getClipProperty, setClipProperty } from "../animation/paths";
import { propertyDef } from "../animation/properties";
import { evaluateTrace, traceBounds, traceLookAt, type TraceState } from "./evaluate";

/** A 1080 × 1920 comp, a way to add a dot and a trace of it. */
function comp() {
  const doc = createEmptyDocument();
  const frame = doc.frames[0]!;
  frame.width = 1080;
  frame.height = 1920;
  const lane = <C extends ShapeClip | TraceClip>(c: C) => {
    const t = createTrack(c.name);
    t.clips.push(c);
    doc.tracks.push(t);
    return c;
  };
  const dot = (drivers: Record<string, string> = {}, x = 0, y = 0) => {
    const c = createShapeClip({ frameId: frame.id, shape: "ellipse", startMs: 0, durationMs: 10000, x, y, width: 20, height: 20 }) as ShapeClip;
    c.drivers = {};
    for (const [path, source] of Object.entries(drivers)) {
      const id = `fx_${c.id}_${path}`;
      doc.expressions.push({ id, source, name: "" });
      c.drivers[path] = fxToken(id);
    }
    return lane(c);
  };
  const trace = (sourceClipId: string | null, patch: Parameters<typeof createTraceClip>[0]["trace"] = {}) =>
    lane(createTraceClip({ frameId: frame.id, startMs: 0, durationMs: 10000, sourceClipId, trace: patch }));
  return { doc, frame, dot, trace };
}

const verts = (s: TraceState) => s.runs.flat();
const at = (doc: MotionDocument, tr: TraceClip, ms: number) => evaluateTrace(doc, tr, ms);

describe("trace", () => {
  it("follows an expression-driven dot over the whole shot: a Lissajous figure", () => {
    const { doc, dot, trace } = comp();
    const d = dot({ x: "300 * sin(3 * #time)", y: "300 * sin(2 * #time)" });
    const tr = trace(d.id, { rate: 60 });
    const s = at(doc, tr, 4000);
    const v = verts(s);
    // 4 s at 60/s, both ends exact: 241 vertices, in time order.
    expect(v.length).toBe(241);
    expect(v[0]!.t).toBe(0);
    expect(v.at(-1)!.t).toBe(4000);
    for (const p of v) {
      expect(p.x).toBeCloseTo(300 * Math.sin(3 * (p.t / 1000)), 6);
      expect(p.y).toBeCloseTo(300 * Math.sin(2 * (p.t / 1000)), 6);
    }
  });

  it("is a function of the instant: scrubbed, played or asked twice, the same polyline", () => {
    const { doc, dot, trace } = comp();
    const d = dot({ x: "200 * cos(#time)", y: "200 * sin(#time)" });
    const tr = trace(d.id, { rate: 30 });
    const late = verts(at(doc, tr, 3210));
    const early = verts(at(doc, tr, 1100));
    // Played forward frame by frame to the same instant…
    for (let ms = 0; ms <= 3210; ms += 1000 / 24) at(doc, tr, ms);
    expect(verts(at(doc, tr, 3210))).toEqual(late);
    expect(verts(at(doc, tr, 1100))).toEqual(early);
    // …and from a fresh copy of the document (an export, another session).
    const copy = parseDocument(serializeDocument(doc));
    const again = copy.tracks.flatMap((t) => t.clips).find((c) => c.id === tr.id) as TraceClip;
    expect(verts(at(copy, again, 3210))).toEqual(late);
  });

  it("re-samples when the source changes, keeps its points when only its look does", () => {
    const { doc, dot, trace } = comp();
    const d = dot();
    d.keyframes.push(keyframeTrackSchema.parse({ id: "t", property: "x", keys: [{ id: "k0", timeMs: 0, value: 0, easing: { kind: "linear" } }, { id: "k1", timeMs: 1000, value: 100, easing: { kind: "linear" } }] }));
    const tr = trace(d.id, { rate: 10 });
    expect(verts(at(doc, tr, 1000)).map((p) => p.x)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((x) => expect.closeTo(x, 6)));
    // The look: new document, same points.
    const looked: MotionDocument = { ...doc, tracks: doc.tracks.map((t) => (t.clips[0]?.id === tr.id ? { ...t, clips: [{ ...tr, trace: { ...tr.trace, head: { ...tr.trace.head, width: 20 } } }] } : t)) };
    const lookedTrace = looked.tracks.flatMap((t) => t.clips).find((c) => c.id === tr.id) as TraceClip;
    expect(verts(at(looked, lookedTrace, 1000)).map((p) => p.x)).toEqual(verts(at(doc, tr, 1000)).map((p) => p.x));
    // The source: new document, new points.
    const moved: MotionDocument = { ...doc, tracks: doc.tracks.map((t) => (t.clips[0]?.id === d.id ? { ...t, clips: [{ ...d, transform: { ...d.transform, y: 50 } }] } : t)) };
    expect(verts(at(moved, tr, 1000)).every((p) => p.y === 50)).toBe(true);
  });

  it("traces a body in the comp's simulation: a ball falls exactly where the solver drops it", () => {
    const { doc, frame, dot, trace } = comp();
    frame.physics = simulationSchema.parse({ floor: false });
    const ball = dot({}, 0, -800);
    ball.physics = physicsSchema.parse({ velocity: [400, 0, 0] });
    const tr = trace(ball.id, { rate: 50 });
    const v = verts(at(doc, tr, 1000));
    expect(v.length).toBe(51);
    // A parabola: x grows linearly, y as ½ g t² (≈ 981 px/s² at the default gravity).
    const mid = v[25]!;
    expect(mid.x).toBeGreaterThan(190);
    expect(mid.x).toBeLessThan(210);
    expect(mid.y - -800).toBeGreaterThan(100);
    expect(mid.y - -800).toBeLessThan(140);
    for (let i = 1; i < v.length; i++) expect(v[i]!.y).toBeGreaterThanOrEqual(v[i - 1]!.y - 1e-6);
  });

  it("traces a point of the source carried by its rotation: a rolling wheel's rim draws a cycloid", () => {
    const { doc, dot, trace } = comp();
    // r = 100 rolling right without slipping: x = 100·θ, rotation = θ.
    const wheel = dot({ x: "100 * #time", rotation: "degrees(#time)" });
    const tr = trace(wheel.id, { rate: 100, source: { point: { x: 0, y: 100 } } });
    for (const p of verts(at(doc, tr, 2 * Math.PI * 1000))) {
      const th = p.t / 1000;
      expect(p.x).toBeCloseTo(100 * (th - Math.sin(th)), 4);
      expect(p.y).toBeCloseTo(100 * Math.cos(th), 4);
    }
  });

  it("a pen with no source draws its own position", () => {
    const { doc, trace } = comp();
    const tr = trace(null, { rate: 20 });
    const id = "fx_pen";
    doc.expressions.push({ id, source: "50 * #time", name: "" });
    tr.drivers = { x: fxToken(id), y: fxToken(id) };
    const v = verts(at(doc, tr, 2000));
    expect(v.length).toBe(41);
    expect(v.at(-1)!.x).toBeCloseTo(100, 6);
    expect(v.at(-1)!.y).toBeCloseTo(100, 6);
  });

  it("a finite length keeps the last N ms with an exact tail; ghosts sit on a fixed Δt grid", () => {
    const { doc, dot, trace } = comp();
    const d = dot({ x: "100 * #time" });
    const tr = trace(d.id, { rate: 10, lengthMs: 500, ghosts: { enabled: true, everyMs: 250 } });
    const v = verts(at(doc, tr, 2030));
    expect(v[0]!.t).toBeCloseTo(1530, 6);
    expect(v[0]!.x).toBeCloseTo(153, 6);
    expect(v.at(-1)!.x).toBeCloseTo(203, 6);
    const ghosts = at(doc, tr, 2030).ghosts.map((g) => g.t);
    expect(ghosts).toEqual([2000, 1750]);
    // The grid does not swim with the playhead.
    expect(at(doc, tr, 2240).ghosts.map((g) => g.t)).toEqual([2000, 1750]);
  });

  it("breaks the line where the source is off the timeline", () => {
    const { doc, dot, trace } = comp();
    const d = dot({ x: "100 * #time" });
    d.startMs = 1000;
    d.durationMs = 1000;
    const tr = trace(d.id, { rate: 10 });
    const s = at(doc, tr, 3000);
    expect(s.runs.length).toBe(1);
    expect(s.runs[0]![0]!.t).toBeCloseTo(1000, 6);
    expect(s.runs[0]!.at(-1)!.t).toBeLessThan(2000);
    // A dangling source draws nothing, and never throws.
    tr.trace.source.clipId = "nope";
    expect(at(doc, tr, 3000).runs).toEqual([]);
  });

  it("cools head → tail by age: colour, width and opacity on one ramp", () => {
    const { doc, dot, trace } = comp();
    const d = dot({ x: "100 * #time" });
    const tr = trace(d.id, { coolMs: 1000, falloff: 1 });
    const s = at(doc, tr, 3000);
    expect(traceLookAt(s.spec, 0, s.coolMs)).toEqual({ u: 0, width: 8, opacity: 1 });
    expect(traceLookAt(s.spec, 500, s.coolMs).width).toBeCloseTo(4.5, 6);
    // Past the cooling time a vertex stays chalk.
    expect(traceLookAt(s.spec, 2500, s.coolMs)).toEqual({ u: 1, width: 1, opacity: 0.35 });
    // No cooling time: across the visible trace.
    tr.trace.coolMs = null;
    expect(at(doc, tr, 3000).coolMs).toBe(3000);
    expect(traceBounds(s)!.maxX).toBeCloseTo(300, 6);
  });

  it("its look is keyable and drivable through `trace.*` paths", () => {
    const { doc, dot, trace } = comp();
    const tr = trace(dot().id);
    expect(propertyDef("trace.head.width")?.appliesTo).toEqual(["trace"]);
    expect(getClipProperty(tr, "trace.tail.color")).toBe("#EDE9E2");
    setClipProperty(tr, "trace.head.width", 12);
    expect(tr.trace.head.width).toBe(12);
    tr.keyframes.push(keyframeTrackSchema.parse({ id: "w", property: "trace.head.width", keys: [{ id: "a", timeMs: 0, value: 2, easing: { kind: "linear" } }, { id: "b", timeMs: 1000, value: 22, easing: { kind: "linear" } }] }));
    expect(at(doc, tr, 500).spec.head.width).toBeCloseTo(12, 6);
    expect(tr.trace.head.width).toBe(12);
  });

  /**
   * The Two Balls room: a ball moved by expressions of a keyed "Clock" (plus
   * `#value` riding its own drop keys), traced, inside a comp nested in a
   * parent that has its own "Clock" and a driven readout.
   */
  function room() {
    const doc = createEmptyDocument();
    const main = doc.frames[0]!;
    const inner = createFrame({ name: "Room", width: 1080, height: 1080 });
    doc.frames.push(inner);
    const lane = <C extends Clip>(c: C) => {
      const t = createTrack(c.name);
      t.clips.push(c);
      doc.tracks.push(t);
      return c;
    };
    const ramp = (id: string, property: string, a: number, b: number, ms = 10000) =>
      keyframeTrackSchema.parse({ id, property, keys: [{ id: `${id}0`, timeMs: 0, value: a, easing: { kind: "linear" } }, { id: `${id}1`, timeMs: ms, value: b, easing: { kind: "linear" } }] });
    const box = (frameId: string, name: string) => lane(createShapeClip({ frameId, shape: "rect", startMs: 0, durationMs: 10000, width: 2, height: 2, name }) as ShapeClip);
    const fx = (c: Clip, path: string, source: string) => {
      const id = `fx_${c.id}_${path}`;
      doc.expressions.push({ id, source, name: "" });
      (c.drivers ??= {})[path] = fxToken(id);
    };
    const clock = box(inner.id, "Clock");
    clock.keyframes.push(ramp("c", "x", 0, 10));
    const ball = lane(createShapeClip({ frameId: inner.id, shape: "ellipse", startMs: 0, durationMs: 10000, width: 40, height: 40, name: "Ball" }) as ShapeClip);
    ball.keyframes.push(ramp("drop", "y", -330, 0, 300));
    fx(ball, "x", `200 * cos(layer("Clock").x) + #value`);
    fx(ball, "y", `200 * sin(layer("Clock").x) + #value`);
    const tr = lane(createTraceClip({ frameId: inner.id, startMs: 0, durationMs: 10000, sourceClipId: ball.id, trace: { rate: 10 } }));
    box(main.id, "Clock").keyframes.push(ramp("m", "x", 50, 60));
    fx(box(main.id, "Readout"), "rotation", `layer("Clock").x`);
    lane(createNestedClip({ frameId: main.id, sourceFrameId: inner.id, startMs: 500, durationMs: 10000 }));
    const expected = (t: number) => ({ x: 200 * Math.cos(t / 1000), y: 200 * Math.sin(t / 1000) + Math.min(0, -330 + 1.1 * t) });
    return { doc, main, inner, clock, tr, expected };
  }
  const drawnIn = (doc: MotionDocument, compId: string, tr: TraceClip, ms: number) => {
    const bake = resolvedDocAt(doc, ms, compId);
    return verts(evaluateTrace(bake, (clipByIdIn(bake, tr.id) as TraceClip | undefined) ?? tr, ms));
  };

  it("samples its source in its own comp, whatever bake the caller holds: nested, driven, #value", () => {
    const { doc, main, inner, tr, expected } = room();
    // The parent asks first (bounds, a hit test): its bake left the room's ball
    // unresolved, and those points must not be the ones the room then draws.
    for (const p of drawnIn(doc, main.id, tr, 1500)) expect(p).toEqual({ ...expected(p.t), t: p.t, x: expect.closeTo(expected(p.t).x, 6), y: expect.closeTo(expected(p.t).y, 6) });
    const v = drawnIn(doc, inner.id, tr, 2000);
    expect(v.length).toBe(21);
    for (const p of v) {
      expect(p.x).toBeCloseTo(expected(p.t).x, 6);
      expect(p.y).toBeCloseTo(expected(p.t).y, 6);
    }
  });

  it("its picture is made of its source's history: keying the clock later re-draws it, a look edit does not", () => {
    const { doc, inner, clock, tr } = room();
    const refs = (d: MotionDocument) => layerContentRefs(d, tr);
    drawnIn(doc, inner.id, tr, 2000);
    const before = refs(doc);
    // Edits land in order: a look edit, then the clock is keyed.
    const keyed: MotionDocument = { ...doc, tracks: doc.tracks.map((t) => (t.clips[0]?.id === clock.id ? { ...t, clips: [{ ...clock, keyframes: [keyframeTrackSchema.parse({ id: "k", property: "x", keys: [{ id: "a", timeMs: 0, value: 0, easing: { kind: "linear" } }, { id: "b", timeMs: 10000, value: 30, easing: { kind: "linear" } }] })] }] } : t)) };
    const looked: MotionDocument = { ...doc, tracks: doc.tracks.map((t) => (t.clips[0]?.id === tr.id ? { ...t, clips: [{ ...tr, trace: { ...tr.trace, head: { ...tr.trace.head, width: 20 } } }] } : t)) };
    expect(refs(looked)).toStrictEqual(before)
    expect(refs(looked)[0]).toBe(before[0]);
    expect(refs(keyed)[0]).not.toBe(before[0]);
  });
});
