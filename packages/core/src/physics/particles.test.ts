import { describe, expect, it } from "vitest";
import type { EmitterSpec, ShapeClip, VisualClip } from "../schema";
import { physicsSchema, simulationSchema } from "../schema/physics";
import { createEmptyDocument, createShapeClip, createTrack, makeSoundLayer } from "../factories";
import { createEmptyClip } from "../world/ops";
import { flatParticles, flatPhysics } from "./flat";
import { EMITTER, emitterCarrierFor, emitterFromLook, emitterLook, emitterLookOf, emittersFromLook, getEmitterProperty, setEmitterProperty, subParentIndex } from "./emitters";
import { MAX_PARTICLES, PARTICLE_STRIDE, clearSimulations } from "./solver";
import { FORCE } from "./forces";
import { buildSoundCues } from "../audio/cues";

function comp(settings: Partial<ReturnType<typeof simulationSchema.parse>> = {}) {
  const doc = createEmptyDocument();
  const frame = doc.frames[0]!;
  frame.width = 1080;
  frame.height = 1080;
  frame.physics = simulationSchema.parse(settings);
  const add = <C extends VisualClip>(c: C) => {
    const lane = createTrack(c.name);
    lane.clips.push(c);
    doc.tracks.push(lane);
    return c;
  };
  const emitter = (spec: Partial<EmitterSpec> & { type?: EmitterSpec["type"] }, x = 0, y = 0, rotation = 0) => {
    const e = createEmptyClip({ frameId: frame.id, startMs: 0, durationMs: 6000 });
    e.transform = { ...e.transform, x, y, rotation };
    e.emitters = [{ ...EMITTER.create(spec.type ?? "stream"), ...spec }];
    return add(e);
  };
  const shape = (s: ShapeClip["shape"], x: number, y: number, w: number, h: number, body: Partial<ReturnType<typeof physicsSchema.parse>>) => {
    const c = createShapeClip({ frameId: frame.id, shape: s, startMs: 0, durationMs: 6000, x, y, width: w, height: h }) as ShapeClip;
    c.physics = physicsSchema.parse(body);
    return add(c);
  };
  /** Several cards on one null, in stack order. */
  const stack = (specs: Array<Partial<EmitterSpec> & { type?: EmitterSpec["type"] }>, x = 0, y = 0, rotation = 0) => {
    const e = createEmptyClip({ frameId: frame.id, startMs: 0, durationMs: 6000 });
    e.transform = { ...e.transform, x, y, rotation };
    e.emitters = specs.map((spec) => ({ ...EMITTER.create(spec.type ?? "stream"), ...spec }));
    return add(e);
  };
  /** Every particle at `ms` — or only card `card`'s, of each carrier. */
  const at = (ms: number, card?: number) => {
    const all = flatParticles(doc, frame.id, ms);
    const pts: Array<{ i: number; x: number; y: number; vx: number; vy: number; age: number; family: number }> = [];
    for (const p of all) {
      if (card !== undefined && p.index !== card) continue;
      for (let k = 0; k < p.count; k++) {
        const o = k * PARTICLE_STRIDE;
        pts.push({ i: p.data[o]!, x: p.data[o + 1]!, y: p.data[o + 2]!, vx: p.data[o + 3]!, vy: p.data[o + 4]!, age: p.data[o + 5]!, family: p.data[o + 7]! });
      }
    }
    return pts;
  };
  return { doc, frame, emitter, stack, shape, at };
}

describe("particles", () => {
  it("a burst stays inside an edge ring — swept, so none slips through the wall", () => {
    const { emitter, shape, at } = comp({ gravity: 0, floor: false });
    shape("ellipse", 0, 0, 800, 800, { type: "passive", shape: "edge", bounce: 1, friction: 0 });
    emitter({ type: "burst", count: 300, spread: 360, speed: 2400, variance: 0.5, life: 5, size: 6, bounce: 1, friction: 0 });
    for (const ms of [200, 900, 2500, 3600]) {
      const pts = at(ms);
      // Lives wander ±25% of 5 s: all still alive before 3.75 s.
      expect(pts.length).toBe(300);
      for (const p of pts) expect(Math.hypot(p.x, p.y)).toBeLessThan(400);
    }
  });

  it("falls with gravity × weight and comes to rest ON the floor, never through it", () => {
    const { emitter, at } = comp({ floor: true });
    emitter({ type: "burst", count: 60, spread: 90, speed: 300, life: 6, size: 10, variance: 0, bounce: 0.3, weight: 1 }, 0, -300, -90);
    const settled = at(4000);
    expect(settled.length).toBe(60);
    for (const p of settled) {
      expect(p.y).toBeLessThanOrEqual(540 - 4.9);
      expect(p.y).toBeGreaterThan(540 - 30);
    }
    // A weight of 0 floats along its first heading.
    const float = comp({ floor: true });
    float.emitter({ type: "burst", count: 10, spread: 0, speed: 200, life: 6, weight: 0 }, 0, 0, 0);
    for (const p of float.at(1000)) expect(p.y).toBeCloseTo(0, 3);
  });

  it("feels the force stack", () => {
    const { doc, frame, emitter, at } = comp({ gravity: 0, floor: false });
    emitter({ type: "burst", count: 40, spread: 0, speed: 0, life: 6 });
    const wind = createEmptyClip({ frameId: frame.id, startMs: 0, durationMs: 6000 });
    wind.forces = [{ ...FORCE.create("wind"), strength: 400 }];
    const lane = createTrack("wind");
    lane.clips.push(wind);
    doc.tracks.push(lane);
    // ½·a·t² = 200 units after a second.
    for (const p of at(1000)) expect(p.x).toBeCloseTo(200, -1);
  });

  it("a stream emits at its rate, keyed rate stops it, and every read is the same run", () => {
    const { doc, frame, emitter, at } = comp({ gravity: 0, floor: false });
    const e = emitter({ rate: 100, life: 10, speed: 100 });
    expect(at(1000).length).toBeGreaterThanOrEqual(99);
    expect(at(1000).length).toBeLessThanOrEqual(101);
    const id = e.emitters![0]!.id;
    e.keyframes = [{ id: "k", property: `emit.${id}.rate`, keys: [{ id: "a", timeMs: 0, value: 100, easing: { kind: "hold" } }, { id: "b", timeMs: 500, value: 0, easing: { kind: "hold" } }] } as never];
    const n = at(2000).length;
    expect(n).toBeGreaterThanOrEqual(49);
    expect(n).toBeLessThanOrEqual(51);
    // Between steps: interpolated, ordered by birth, and the same every time.
    const a = at(1003.3), b = at(1003.3);
    expect(a).toEqual(b);
    expect(a.every((p, k) => k === 0 || p.i > a[k - 1]!.i)).toBe(true);
    // Recolouring draws differently but never re-simulates.
    const key = flatPhysics(doc, frame.id)!.scene.key;
    expect(setEmitterProperty(e, `emit.${id}.color`, "#FF0000")).toBe(true);
    expect(getEmitterProperty(e, `emit.${id}.color`)).toBe("#FF0000");
    const recoloured = { ...doc, tracks: doc.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...c })) })) };
    expect(flatPhysics(recoloured, frame.id)!.scene.key).toBe(key);
  });

  it("rings the emitter's hit sound, thinned to the hardest per window", () => {
    const { doc, frame, emitter } = comp({ floor: true });
    const rain = emitter({ ...emitterFromLook(emitterLook("rain")!), source: "point", spread: 10, rate: 400, speed: 600 }, 0, 0, 90);
    rain.sounds = [makeSoundLayer({ kind: "hit", minSpeed: 60 }, "in")];
    const cues = buildSoundCues(doc, 0, 3000, frame.id).filter((c) => c.clipId === rain.id);
    expect(cues.length).toBeGreaterThan(20);
    // No two within the thinning window.
    const times = cues.map((c) => c.timeMs).sort((x, y) => x - y);
    for (let k = 1; k < times.length; k++) expect(times[k]! - times[k - 1]!).toBeGreaterThan(0);
    expect(cues.length).toBeLessThanOrEqual(Math.ceil(3000 / 45) + 1);
  });

  it("a hit emitter on a body throws off ITS contacts — up off the floor, harder hits throw more, none before it lands", () => {
    const { emitter, shape, at } = comp({ floor: true });
    const ball = shape("ellipse", 0, 0, 60, 60, { type: "active", bounce: 0.5, friction: 0 });
    ball.emitters = [{ ...emitterFromLook(emitterLook("impact")!), variance: 0, threshold: 100 }];
    // Falls 510 units: lands about 1.02 s in.
    expect(at(950).length).toBe(0);
    const after = at(1060);
    expect(after.length).toBeGreaterThan(10);
    for (const p of after) {
      expect(Math.abs(p.x)).toBeLessThan(80);
      expect(p.y).toBeGreaterThan(400);
      expect(p.y).toBeLessThanOrEqual(540);
    }
    // Thrown out of the floor, never into it.
    expect(after.filter((p) => p.age < 0.03).every((p) => p.vy <= 1)).toBe(true);
    // A lone emitter's null is not a body: it answers every body's hits — and a high threshold answers none.
    const quiet = comp({ floor: true });
    quiet.shape("ellipse", 0, 0, 60, 60, { type: "active", bounce: 0.5, friction: 0 });
    quiet.emitter({ ...emitterFromLook(emitterLook("impact")!), threshold: 5000 });
    expect(quiet.at(1200).length).toBe(0);
    const any = comp({ floor: true });
    any.shape("ellipse", 0, 0, 60, 60, { type: "active", bounce: 0.5, friction: 0 });
    any.emitter({ ...emitterFromLook(emitterLook("impact")!), threshold: 100 }, 300, -300);
    expect(any.at(1060).length).toBeGreaterThan(10);
    // Answers its own body only: a second ball's landing throws nothing from the first's emitter.
    const own = comp({ floor: true });
    const a = own.shape("ellipse", -200, 0, 60, 60, { type: "active", bounce: 0.5, friction: 0 });
    own.shape("ellipse", 200, -300, 60, 60, { type: "active", bounce: 0.5, friction: 0 });
    a.emitters = [{ ...emitterFromLook(emitterLook("impact")!), threshold: 100, life: 3 }];
    // The first lands ~1.02 s, the second ~1.28 s, the first again ~2 s: no births between.
    const landed = own.at(1150).length;
    expect(landed).toBeGreaterThan(10);
    expect(own.at(1600).length).toBe(landed);
  });

  it("a hit emitter's sparks are quiet — the ball's own hit is the sound", () => {
    const { doc, frame, shape } = comp({ floor: true });
    const ball = shape("ellipse", 0, 0, 60, 60, { type: "active", bounce: 0.5, friction: 0 });
    ball.emitters = [{ ...emitterFromLook(emitterLook("impact")!), threshold: 100 }];
    ball.sounds = [makeSoundLayer({ kind: "hit", minSpeed: 120 }, "in")];
    const cues = buildSoundCues(doc, 0, 1500, frame.id).filter((c) => c.clipId === ball.id);
    expect(cues.length).toBe(1);
  });

  it("an emitter on a falling body rides it — a trail behind the ball, not a fountain where it started", () => {
    const { shape, at } = comp({ floor: false });
    const ball = shape("ellipse", 0, 0, 60, 60, { type: "active", velocity: [400, 0, 0] });
    ball.emitters = [{ ...EMITTER.create("stream"), rate: 200, speed: 0, spread: 0, weight: 0, collide: false, life: 5, variance: 0 }];
    // ½·981·0.8² ≈ 314 down, 320 across by 0.8 s.
    const pts = at(800);
    const newest = pts.reduce((m, p) => (p.age < m.age ? p : m));
    expect(newest.y).toBeGreaterThan(280);
    expect(newest.x).toBeGreaterThan(290);
    // The oldest stayed where they were dropped: a trail along the arc.
    const oldest = pts.reduce((m, p) => (p.age > m.age ? p : m));
    expect(Math.hypot(oldest.x, oldest.y)).toBeLessThan(20);
  });

  it("a sub-emitter throws from each parent particle as it dies — where it died, one family per parent", () => {
    const { stack, at } = comp({ gravity: 0, floor: false });
    stack([
      { type: "burst", count: 10, spread: 0, speed: 200, life: 0.5, variance: 0, weight: 0, collide: false },
      { type: "sub", count: 5, spread: 360, speed: 100, life: 1, variance: 0, weight: 0, collide: false, inherit: 0 },
    ]);
    expect(at(450, 1).length).toBe(0);
    const pop = at(560, 1);
    expect(pop.length).toBe(50);
    // Born where the shells died, 100 units along their way, then flung out at 100/s.
    for (const p of pop) expect(Math.hypot(p.x - 100, p.y)).toBeLessThan(100 * p.age + 4);
    const families = new Map<number, number>();
    for (const p of pop) families.set(p.family, (families.get(p.family) ?? 0) + 1);
    expect([...families.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect([...families.values()].every((n) => n === 5)).toBe(true);
    // The parents' own particles carry themselves as their family.
    expect(at(300, 0).every((p) => p.family === p.i)).toBe(true);
    // Seeded: a cold re-run is the same run.
    const before = at(1003.3);
    clearSimulations();
    expect(at(1003.3)).toEqual(before);
  });

  it("carries its parent's motion by `inherit`, and fans about the way the parent went", () => {
    const { stack, at } = comp({ gravity: 0, floor: false });
    stack([
      { type: "burst", count: 4, spread: 0, speed: 300, life: 0.4, variance: 0, weight: 0, collide: false },
      { type: "sub", count: 8, spread: 0, speed: 50, life: 1, variance: 0, weight: 0, collide: false, inherit: 1 },
    ]);
    // Speed 50 along the parent's heading (+X) plus all of its 300.
    for (const p of at(600, 1)) {
      expect(p.vx).toBeCloseTo(350, -1);
      expect(Math.abs(p.vy)).toBeLessThan(2);
    }
  });

  it("on hit: thrown off the surface each time a parent particle lands", () => {
    const { stack, at } = comp({ floor: true });
    // Drops 440 units onto the floor (y 540): lands about 0.95 s in.
    stack([
      { type: "burst", count: 6, spread: 0, speed: 0, life: 4, variance: 0, size: 4, bounce: 0.2, friction: 0.5 },
      { type: "sub", on: "hit", count: 4, spread: 90, speed: 200, life: 0.3, variance: 0, weight: 0, collide: false, inherit: 0 },
    ], 0, 100, 90);
    expect(at(900, 1).length).toBe(0);
    const splash = at(1000, 1);
    expect(splash.length).toBeGreaterThanOrEqual(4);
    // Up off the floor, never into it.
    for (const p of splash) {
      expect(p.y).toBeLessThanOrEqual(540);
      expect(p.vy).toBeLessThan(0);
    }
  });

  it("never runs away: a sub has no parent in a loop, and each card keeps its particle cap", () => {
    const list = [
      { id: "a", type: "stream" as const, parent: "" },
      { id: "b", type: "sub" as const, parent: "" },
      { id: "c", type: "sub" as const, parent: "d" },
      { id: "d", type: "sub" as const, parent: "c" },
      { id: "e", type: "sub" as const, parent: "e" },
      { id: "f", type: "sub" as const, parent: "gone" },
    ];
    expect(subParentIndex(list, 0)).toBe(null);
    expect(subParentIndex(list, 1)).toBe(0);
    expect(subParentIndex(list, 2)).toBe(null);
    expect(subParentIndex(list, 3)).toBe(null);
    // Naming itself is the card above; a parent that is gone (a look re-applied with fresh ids) is too.
    expect(subParentIndex(list, 4)).toBe(3);
    expect(subParentIndex(list, 5)).toBe(4);
    expect(subParentIndex([{ id: "x", type: "sub", parent: "" }], 0)).toBe(null);
    // Two subs naming each other throw nothing.
    const loop = comp({ gravity: 0, floor: false });
    loop.stack([
      { id: "p", type: "sub", parent: "q", count: 10, life: 0.1 },
      { id: "q", type: "sub", parent: "p", count: 10, life: 0.1 },
    ]);
    expect(loop.at(2000).length).toBe(0);
    // 4000 shells × 10 each: the sub stops at its own cap.
    const many = comp({ gravity: 0, floor: false });
    many.stack([
      { type: "burst", count: 4000, spread: 360, speed: 100, life: 0.2, variance: 0, collide: false },
      { type: "sub", count: 10, spread: 360, speed: 100, life: 3, collide: false },
    ]);
    const n = many.at(400, 1).length;
    expect(n).toBe(MAX_PARTICLES);
  });

  it("a firework shell rises, bursts high in its own colour, and crackles", () => {
    const { frame, stack, at } = comp({ floor: false });
    const look = emitterLook("shell")!;
    const cards = emittersFromLook(look, frame);
    expect(cards.map((c) => c.type)).toEqual(["stream", "sub", "sub"]);
    // Each card is called by its look; fitted to a portrait comp, the shell still is one.
    expect(cards.map((c) => emitterLookOf(c)?.id)).toEqual(["shell", "peony", "crackle"]);
    const tall = emittersFromLook(look, { height: 1920 })[0]!;
    expect(tall.speed).toBeCloseTo(cards[0]!.speed * Math.sqrt(1920 / 1080), 3);
    expect(emitterLookOf(tall)?.id).toBe("shell");
    const place = emitterCarrierFor(look, frame);
    const c = stack(cards, place.x, place.y, place.rotation);
    c.transform = { ...c.transform, scale: place.scale, scaleY: place.scaleY };
    // Shells leave the bottom strip going up.
    const shells = at(500, 0);
    expect(shells.length).toBeGreaterThan(0);
    for (const s of shells) {
      expect(s.vy).toBeLessThan(0);
      expect(Math.abs(s.x)).toBeLessThan(frame.width * 0.35);
    }
    const bursts = at(3000, 1);
    expect(bursts.length).toBeGreaterThan(100);
    // High in the comp, and from more than one shell by now.
    const mid = bursts.reduce((m, p) => m + p.y, 0) / bursts.length;
    expect(mid).toBeLessThan(0);
    expect(new Set(bursts.map((p) => p.family)).size).toBeGreaterThan(1);
    expect(at(3000, 2).length).toBeGreaterThan(0);
  });

  it("a sphere fills a disc with a bright rim, where a flat burst draws a ring", () => {
    const radii = (sphere: boolean) => {
      const { stack, at } = comp({ gravity: 0, floor: false });
      stack([{ type: "burst", count: 400, spread: 360, speed: 400, variance: 0, life: 3, weight: 0, drag: 0, collide: false, sphere }]);
      return at(1000).map((p) => Math.hypot(p.x, p.y));
    };
    const ring = radii(false);
    expect(Math.min(...ring)).toBeGreaterThan(395);
    const ball = radii(true);
    expect(Math.max(...ball)).toBeLessThanOrEqual(401);
    // A projected shell: a quarter of them inside 0.66 of the radius, most crowded at the rim.
    expect(ball.filter((r) => r < 264).length / ball.length).toBeGreaterThan(0.18);
    expect(ball.filter((r) => r > 360).length).toBeGreaterThan(ball.filter((r) => r < 40).length * 4);
  });

  it("rain falls from its strip across the top — down, not sideways", () => {
    const { frame, stack, at } = comp({ floor: false });
    const look = emitterLook("rain")!;
    const place = emitterCarrierFor(look, frame);
    const c = stack([emitterFromLook(look)], place.x, place.y, place.rotation);
    c.transform = { ...c.transform, scale: place.scale, scaleY: place.scaleY };
    const drops = at(600, 0);
    expect(drops.length).toBeGreaterThan(50);
    for (const d of drops) expect(d.vy).toBeGreaterThan(Math.abs(d.vx) * 5);
    const xs = drops.map((d) => d.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(frame.width * 0.8);
  });
});

describe("a carrier's opacity (v103)", () => {
  it("moves onto its emitters when an older project opens, so nothing that shipped changes", async () => {
    const { parseDocument } = await import("../io");
    const { keyframeTrackSchema } = await import("../schema/animation");
    const doc = createEmptyDocument();
    const frameId = doc.frames[0]!.id;
    const word = createShapeClip({ frameId, shape: "rect", startMs: 0, durationMs: 4000, x: 0, y: 0, width: 200, height: 60 }) as ShapeClip;
    word.emitters = [EMITTER.create("stream"), EMITTER.create("burst")];
    word.keyframes.push(keyframeTrackSchema.parse({ id: "fade", property: "opacity", keys: [{ id: "a", timeMs: 0, value: 0, easing: { kind: "linear" } }, { id: "b", timeMs: 500, value: 1, easing: { kind: "linear" } }] }));
    const still = createShapeClip({ frameId, shape: "rect", startMs: 0, durationMs: 4000, x: 0, y: 0, width: 10, height: 10 }) as ShapeClip;
    still.opacity = 0;
    still.emitters = [EMITTER.create("hit")];
    for (const c of [word, still]) {
      const lane = createTrack(c.name);
      lane.clips.push(c);
      doc.tracks.push(lane);
    }
    const raw = JSON.parse(JSON.stringify({ ...doc, version: 102 })) as { tracks: Array<{ clips: Array<{ emitters?: Array<Record<string, unknown>> }> }> };
    for (const t of raw.tracks) for (const c of t.clips) for (const e of c.emitters ?? []) delete e.opacity;
    const migrated = parseDocument(JSON.stringify(raw));
    const clips = migrated.tracks.flatMap((t) => t.clips) as VisualClip[];
    const w = clips.find((c) => c.id === word.id)!;
    for (const e of w.emitters!) expect(w.keyframes.find((t) => t.property === `emit.${e.id}.opacity`)?.keys.map((k) => k.value)).toEqual([0, 1]);
    // The layer keeps its own fade; the card now has one of its own.
    expect(w.keyframes.some((t) => t.property === "opacity")).toBe(true);
    expect(clips.find((c) => c.id === still.id)!.emitters![0]!.opacity).toBe(0);
    // A fresh card shows fully, whatever its layer does.
    expect(EMITTER.create("stream").opacity).toBe(1);
  });
});
