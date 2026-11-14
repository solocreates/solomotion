import { describe, expect, it } from "vitest";
import { createEmptyDocument, createShapeClip, createTrack, makeSoundLayer } from "../factories";
import { physicsSchema, simulationSchema, type ShapeClip, type SoundLayer } from "../schema";
import { buildSoundCues, cueVariation } from "./cues";
import { kitTake, limitVoices, noteStep, roundRobin, rateIntensity, scaleSemitones, SOUND_SETS, voiceNote, VOICE_SLOT_MS, VOICES_PER_SLOT } from "./sound-sets";
import { soundIntensityPath } from "./sound-fields";
import { clipAnimatableProperties } from "../animation/clip-properties";
import { setKeyframe } from "../animation/keyframes";

const at = (n: number, extra: Partial<{ member: number; strength: number; seed: number }> = {}) => ({ n, member: 0, strength: 0.5, seed: 0.3, ...extra });

describe("notes", () => {
  it("walks a scale across octaves, both ways", () => {
    expect([0, 1, 2, 3, 4, 5, 7].map((s) => scaleSemitones("pentatonic", s))).toEqual([0, 2, 4, 7, 9, 12, 16]);
    expect(scaleSemitones("pentatonic", -1)).toBe(-3);
    expect(scaleSemitones("fifths", 3)).toBe(19);
  });

  it("picks the step by order: in turn, up and back, per body, by force", () => {
    const span = 4;
    expect([0, 1, 2, 3, 4, 5].map((n) => noteStep({ order: "rise", span }, at(n)))).toEqual([0, 1, 2, 3, 0, 1]);
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => noteStep({ order: "bounce", span }, at(n)))).toEqual([0, 1, 2, 3, 2, 1, 0]);
    expect(noteStep({ order: "body", span }, at(9, { member: 6 }))).toBe(2);
    expect(noteStep({ order: "strength", span }, at(0, { strength: 0 }))).toBe(0);
    expect(noteStep({ order: "strength", span }, at(0, { strength: 1 }))).toBe(3);
    const random = Array.from({ length: 40 }, (_, i) => noteStep({ order: "random", span }, at(0, { seed: i / 40 })));
    expect(new Set(random).size).toBe(span);
  });

  it("at intensity 0 a voice is exactly as tuned; at 1 its notes sit an octave up, louder, with weight under them", () => {
    const tone = { volume: 0.4, pitch: 1.2, notes: null };
    expect(voiceNote(tone, 0, at(3))).toMatchObject({ volume: 0.4, pitch: 1.2, weight: 0 });
    // A lone tone rises a fifth.
    expect(voiceNote(tone, 1, at(3)).pitch).toBeCloseTo(1.2 * 2 ** (7 / 12), 6);

    const set = { volume: 0.4, pitch: 1, notes: { scale: "pentatonic" as const, order: "rise" as const, span: 5 } };
    const calm = voiceNote(set, 0, at(2));
    const peak = voiceNote(set, 1, at(2));
    expect(calm.pitch).toBeCloseTo(2 ** (4 / 12), 6);
    expect(peak.pitch / calm.pitch).toBeCloseTo(2, 6);
    expect(peak.volume).toBeGreaterThan(calm.volume);
    expect(peak.bright).toBeGreaterThan(calm.bright);
    expect(voiceNote(set, 0.5, at(0)).weight).toBe(0);
    expect(voiceNote(set, 1, at(0)).weight).toBe(1);
  });
});

describe("the climax and the voice limit", () => {
  it("climbs with the hit rate on a log scale, reaching 1 at the comp's busiest", () => {
    expect(rateIntensity(2, 200)).toBe(0);
    expect(rateIntensity(200, 200)).toBe(1);
    expect(rateIntensity(20, 200)).toBeCloseTo(0.5, 6);
    // A scene that never gets busy never builds.
    expect(rateIntensity(4, 4)).toBe(0);
  });

  it("keeps the loudest firings of each slot, in time order", () => {
    const items = [
      { ms: 0, loud: 0.2 },
      { ms: 10, loud: 0.9 },
      { ms: 20, loud: 0.5 },
      { ms: 30, loud: 0.1 },
      { ms: VOICE_SLOT_MS + 1, loud: 0.1 },
    ];
    expect(limitVoices(items, 2).map((i) => i.ms)).toEqual([10, 20, VOICE_SLOT_MS + 1]);
  });
});

/** A ring of balls that doubles every half second — the "how many balls" reel in miniature. */
function ringOfBalls(entry: (i: number) => SoundLayer) {
  const doc = createEmptyDocument();
  const frame = doc.frames[0]!;
  frame.width = 1080;
  frame.height = 1080;
  frame.physics = simulationSchema.parse({ floor: false, gravity: 0, guard: false });   // the score, not the stepping, is under test: its hits as authored
  const add = (c: ShapeClip, body: Record<string, unknown>) => {
    c.physics = physicsSchema.parse(body);
    const lane = createTrack(c.name);
    lane.clips.push(c);
    doc.tracks.push(lane);
    return c;
  };
  add(createShapeClip({ frameId: frame.id, shape: "ellipse", startMs: 0, durationMs: 3000, x: 0, y: 0, width: 800, height: 800 }) as ShapeClip, { type: "passive", shape: "edge", bounce: 1, friction: 0 });
  const balls: ShapeClip[] = [];
  for (let i = 0; i < 30; i++) {
    const startMs = i < 2 ? 0 : i < 6 ? 500 : i < 14 ? 1000 : 1500;
    const a = (i * 137.5 * Math.PI) / 180;
    const ball = add(
      createShapeClip({ frameId: frame.id, shape: "ellipse", startMs, durationMs: 3000 - startMs, x: Math.cos(a) * 60, y: Math.sin(a) * 60, width: 24, height: 24 }) as ShapeClip,
      { bounce: 1, friction: 0, damping: 0, velocity: [Math.cos(a) * 1400, Math.sin(a) * 1400, 0] },
    );
    ball.sounds = [entry(i)];
    balls.push(ball);
  }
  return { doc, frame, balls };
}

const climb = SOUND_SETS.find((s) => s.id === "marimba-climb")!;

describe("a ring of balls wearing one set", () => {
  it("plays ONE melody across every ball, thinned to a roll, building to the busiest moment — the same in any window", () => {
    const { doc, frame } = ringOfBalls(() => makeSoundLayer({ kind: "hit", minSpeed: 60, rise: "hits" }, "in", { ...climb.voice, randomness: 0 }));
    const cues = buildSoundCues(doc, 0, 3000, frame.id);
    expect(cues.length).toBeGreaterThan(40);

    // Never more than the voice budget in any slot.
    const perSlot = new Map<number, number>();
    for (const c of cues) perSlot.set(Math.floor(c.timeMs / VOICE_SLOT_MS), (perSlot.get(Math.floor(c.timeMs / VOICE_SLOT_MS)) ?? 0) + 1);
    expect(Math.max(...perSlot.values())).toBeLessThanOrEqual(VOICES_PER_SLOT);

    // One stream for the leveler: every ball's hits are judged together.
    expect(new Set(cues.map((c) => c.stream)).size).toBe(1);

    // The first notes climb the scale in turn, whichever ball rang them.
    const semis = cues.slice(0, 5).map((c) => Math.round(12 * Math.log2(c.pitch)));
    expect(new Set(cues.slice(0, 5).map((c) => c.clipId)).size).toBeGreaterThan(1);
    expect(semis[1]! - semis[0]!).toBeGreaterThan(0);
    expect(semis[2]! - semis[1]!).toBeGreaterThan(0);

    // Busier → built: the last half second is brighter and heavier than the first.
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
    const early = cues.filter((c) => c.timeMs < 500);
    const late = cues.filter((c) => c.timeMs >= 2500);
    expect(mean(late.map((c) => c.bright))).toBeGreaterThan(mean(early.map((c) => c.bright)) + 0.2);
    expect(mean(late.map((c) => c.weight))).toBeGreaterThan(0.2);
    expect(mean(early.map((c) => c.weight))).toBe(0);

    // Playback asks in one-second buckets; the export asks once. Same notes.
    const buckets = [0, 1000, 2000].flatMap((t) => buildSoundCues(doc, t, t + 1000, frame.id));
    expect(buckets.map((c) => [Math.round(c.timeMs), c.pitch.toFixed(5), c.clipId])).toEqual(cues.map((c) => [Math.round(c.timeMs), c.pitch.toFixed(5), c.clipId]));
  });

  it("gives each ball its own note under `body`", () => {
    const { doc, frame, balls } = ringOfBalls(() => makeSoundLayer({ kind: "hit", minSpeed: 60 }, "in", { pack: "marimba", randomness: 0, notes: { scale: "pentatonic", order: "body", span: 10 } }));
    const cues = buildSoundCues(doc, 0, 3000, frame.id);
    for (const ball of balls.slice(0, 6)) {
      const pitches = new Set(cues.filter((c) => c.clipId === ball.id).map((c) => c.pitch.toFixed(5)));
      expect(pitches.size).toBeLessThanOrEqual(1);
    }
    expect(new Set(cues.map((c) => c.pitch.toFixed(5))).size).toBeGreaterThan(3);
  });

  it("climaxes on keys: `snd.<id>.intensity` is listed, keyable, and lifts the notes", () => {
    const { doc, frame, balls } = ringOfBalls(() => makeSoundLayer({ kind: "hit", minSpeed: 60 }, "in", { ...climb.voice, randomness: 0 }));
    const first = balls[0]!;
    const path = soundIntensityPath(first.sounds[0]!.id);
    expect(clipAnimatableProperties(first).some((p) => p.path === path)).toBe(true);
    const flat = buildSoundCues(doc, 0, 3000, frame.id).filter((c) => c.clipId === first.id);
    setKeyframe(first.keyframes, path, 0, 1);
    const lifted = buildSoundCues(doc, 0, 3000, frame.id).filter((c) => c.clipId === first.id);
    expect(lifted.length).toBe(flat.length);
    expect(lifted.length).toBeGreaterThan(0);
    lifted.forEach((c, i) => expect(c.pitch / flat[i]!.pitch).toBeCloseTo(2, 4));
  });
});

describe("recorded kits (v105)", () => {
  const take = (assetId: string, extra: Partial<{ root: number; layer: "any" | "soft" | "hard" }> = {}) => ({ assetId, hitMs: 4, root: 0, layer: "any" as const, ...extra });

  it("plays every take once per cycle and never the same take twice in a row", () => {
    for (const len of [2, 3, 5, 8]) {
      const seq = Array.from({ length: len * 40 }, (_, n) => roundRobin(len, n, len));
      for (let c = 0; c < 40; c++) expect(new Set(seq.slice(c * len, (c + 1) * len)).size).toBe(len);
      for (let n = 1; n < seq.length; n++) expect(seq[n]).not.toBe(seq[n - 1]);
      expect(seq).toEqual(Array.from({ length: len * 40 }, (_, n) => roundRobin(len, n, len)));
    }
  });

  it("answers soft and hard hits from their own layers, and falls back to every take", () => {
    const kit = { takes: [take("soft", { layer: "soft" }), take("hard", { layer: "hard" }), take("mid")] };
    expect(kitTake(kit, { n: 0, strength: 0.1 }).assetId).toMatch(/soft|mid/);
    expect(kitTake(kit, { n: 0, strength: 0.9 }).assetId).toMatch(/hard|mid/);
    expect(kitTake(kit, { n: 3, strength: 0.5 }).assetId).toBe("mid");
    expect(kitTake({ takes: [take("only", { layer: "hard" })] }, { n: 0, strength: 0.1 }).assetId).toBe("only");
  });

  it("retunes a take from its root to the note it plays", () => {
    const voice = { volume: 0.4, pitch: 1, notes: { scale: "minor" as const, order: "rise" as const, span: 7 }, kit: { takes: [take("d", { root: 2 })] } };
    // step 0 is C: a D recording plays two semitones down.
    expect(voiceNote(voice, 0, at(0)).pitch).toBeCloseTo(2 ** (-2 / 12), 6);
    expect(voiceNote(voice, 0, at(0)).take?.assetId).toBe("d");
    // a lone tone plays the take as recorded.
    expect(voiceNote({ ...voice, notes: null }, 0, at(0)).pitch).toBe(1);
  });

  it("a weight climax keeps the register and builds by damping and weight", () => {
    const voice = { volume: 0.4, pitch: 1, notes: { scale: "pentatonic" as const, order: "rise" as const, span: 5 }, climb: "weight" as const };
    const calm = voiceNote(voice, 0, at(2)), peak = voiceNote(voice, 1, at(2));
    expect(peak.pitch).toBe(calm.pitch);
    expect(peak.bright).toBe(calm.bright);
    expect(peak.damp).toBe(1);
    expect(peak.weight).toBe(1);
    expect(peak.volume).toBeGreaterThan(calm.volume);
    expect(voiceNote({ ...voice, climb: "pitch" }, 1, at(2)).damp).toBe(0);
  });

  it("humanises a note by cents, a click by the old spread", () => {
    for (const seed of [0, 0.25, 0.5, 0.75, 0.99]) {
      const note = cueVariation({ seed, randomness: 1, volume: 1, pitch: 1, tuned: true });
      expect(Math.abs(12 * Math.log2(note.pitch))).toBeLessThanOrEqual(0.121);
      expect(note.volume).toBeGreaterThanOrEqual(0.84);
    }
    expect(cueVariation({ seed: 0.99, randomness: 1, volume: 1, pitch: 1 }).volume).toBeLessThan(0.5);
  });

  it("a ring wearing a kit is one ensemble: takes in turn, panned where they struck, bucketed == whole", () => {
    const kit = { takes: ["a", "b", "c", "d"].map((id) => take(id, { root: 2 })) };
    const { doc, frame } = ringOfBalls(() =>
      makeSoundLayer({ kind: "hit", minSpeed: 60, rise: "hits" }, "in", { pack: "marimba", randomness: 0, kit, climb: "weight", notes: { scale: "minor", order: "body", span: 7 } }),
    );
    const whole = buildSoundCues(doc, 0, 3000, frame.id);
    expect(whole.length).toBeGreaterThan(20);
    expect(new Set(whole.map((c) => c.kit)).size).toBe(1);
    expect(new Set(whole.map((c) => c.custom?.assetId))).toEqual(new Set(["a", "b", "c", "d"]));
    const pans = whole.map((c) => c.pan ?? 0);
    expect(Math.min(...pans)).toBeLessThan(-0.1);
    expect(Math.max(...pans)).toBeGreaterThan(0.1);
    pans.forEach((p) => expect(Math.abs(p)).toBeLessThanOrEqual(0.8));
    const bucketed = [0, 1000, 2000].flatMap((t) => buildSoundCues(doc, t, t + 1000, frame.id));
    expect(bucketed.map((c) => [c.timeMs, c.custom?.assetId, c.pitch, c.pan])).toEqual(whole.map((c) => [c.timeMs, c.custom?.assetId, c.pitch, c.pan]));
  });
});
