import { afterEach, describe, expect, it } from "vitest";
import type { MotionDocument, Clip } from "../schema";
import { createAssetAudioClip, createEmptyDocument, createTrack } from "../factories";
import { clipLookup } from "../timeline/frame-index";
import { compFps } from "../timeline/fps";
import { evaluateProgram } from "../expressions/eval";
import { parseExpression } from "../expressions/parser";
import type { ExprContext } from "../expressions/globals";
import type { ExprLayerApi } from "../expressions/layer-api";
import { mediaLayerApi } from "../speech/source";
import { createGraph, createNode, setNodeParam } from "../nodes/graph-ops";
import { evaluateGraph, socketKey } from "../nodes/eval";
import { defaultNodeRegistry } from "../nodes/builtin";
import { makeDriverEnv } from "../evaluate/driver-env";
import { analyzeSound, createSoundAnalyzer, peakTable } from "./analyze";
import { soundBandsAt, soundBeatAt, soundFeatureAt, soundLevelAt, soundRangeAt, windowPeaks } from "./query";
import { installSoundReader, soundGeneration } from "./reader";
import { SOUND_FEATURES, type SoundAnalysis } from "./types";
import { visualizerBars } from "./visualizer";
import { SOUND_NODE_TYPE } from "../nodes/sound-node";
import "./functions";

const SR = 44100;

function tone(hz: number, seconds: number, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
  return out;
}

/** A click every `periodMs`: 5 ms of deterministic noise, then silence. */
function clicks(periodMs: number, seconds: number, offsetMs = 120): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let t = offsetMs; t < seconds * 1000; t += periodMs) {
    const s0 = Math.round((t / 1000) * SR);
    for (let i = 0; i < 0.005 * SR && s0 + i < out.length; i++) out[s0 + i] = 0.8 * rnd() * (1 - i / (0.005 * SR));
  }
  return out;
}

describe("listening", () => {
  it("hears where a tone sits: a low hum is bass, a whistle is treble", () => {
    const low = analyzeSound([tone(100, 1)], SR);
    const high = analyzeSound([tone(8000, 1)], SR);
    const at = 600;
    expect(soundFeatureAt(low, at, "bass")).toBeGreaterThan(0.75);
    expect(soundFeatureAt(low, at, "treble")).toBeLessThan(0.2);
    expect(soundFeatureAt(high, at, "treble")).toBeGreaterThan(0.75);
    expect(soundFeatureAt(high, at, "bass")).toBeLessThan(0.2);
    expect(soundFeatureAt(high, at, "brightness")).toBeGreaterThan(soundFeatureAt(low, at, "brightness") + 0.4);
  });

  it("level is perceptual: a −9 dB RMS sine reads about 0.85, and quieter reads lower", () => {
    const a = analyzeSound([tone(440, 1, 0.5)], SR);
    const q = analyzeSound([tone(440, 1, 0.05)], SR);
    expect(soundLevelAt(a, 500)).toBeCloseTo(0.85, 1);
    expect(soundLevelAt(q, 500)).toBeCloseTo(0.52, 1);
  });

  it("silence is silent, with no tempo and no beats", () => {
    const a = analyzeSound([new Float32Array(SR * 4)], SR);
    for (const f of SOUND_FEATURES) expect(soundFeatureAt(a, 2000, f.id)).toBe(0);
    expect(a.tempo).toBeNull();
    expect(a.beats.length).toBe(0);
    expect(a.onsets.length).toBe(0);
  });

  it("counts a 120 BPM click track: tempo, beat grid, hits and the pulse", () => {
    const a = analyzeSound([clicks(500, 10)], SR);
    expect(a.tempo).not.toBeNull();
    expect(Math.abs(a.tempo! - 120)).toBeLessThan(2.5);
    const gaps = Array.from(a.beats).slice(1).map((t, i) => t - a.beats[i]!);
    const median = gaps.sort((x, y) => x - y)[gaps.length >> 1]!;
    expect(Math.abs(median - 500)).toBeLessThan(20);
    expect(a.onsets.length).toBeGreaterThanOrEqual(18);
    expect(a.onsets.length).toBeLessThanOrEqual(21);
    // The pulse: full on a beat, mostly gone by the half-beat.
    const beat = a.beats[Math.floor(a.beats.length / 2)]!;
    expect(soundBeatAt(a, beat)).toBeCloseTo(1, 5);
    expect(soundBeatAt(a, beat + 250)).toBeLessThan(0.2);
  });

  it("a stepped analysis is the same analysis — the host's slices change nothing", () => {
    const samples = clicks(400, 3);
    const whole = analyzeSound([samples], SR);
    const stepper = createSoundAnalyzer([samples], SR);
    while (!stepper.step(7));
    const sliced = stepper.finish();
    expect(Array.from(sliced.bands)).toEqual(Array.from(whole.bands));
    expect(Array.from(sliced.level)).toEqual(Array.from(whole.level));
    expect(Array.from(sliced.beats)).toEqual(Array.from(whole.beats));
  });

  it("a stereo file is heard as one sound", () => {
    const l = tone(100, 1);
    const r = new Float32Array(l.length);
    const a = analyzeSound([l, r], SR);
    expect(soundFeatureAt(a, 600, "bass")).toBeGreaterThan(0.6);
    expect(a.peakDb).toBeCloseTo(-6, 0);
  });
});

describe("reading", () => {
  const a = analyzeSound([tone(100, 2)], SR);

  it("ranges and bars come from the same bands", () => {
    const bars = soundBandsAt(a, 1000, 16);
    expect(bars.length).toBe(16);
    expect(Math.max(...bars)).toBeGreaterThan(0.75);
    expect(soundRangeAt(a, 1000, 20000, 40000)).toBe(0); // above everything the sound carries
    expect(soundRangeAt(a, 1000, 90, 110)).toBeGreaterThan(0.75);
  });

  it("the visualizer's spectrum is the analysis's bands, held by its release", () => {
    const style = { mode: "spectrum", template: "bars", barCount: 32, decay: 0, windowMs: 1200 } as Parameters<typeof visualizerBars>[1];
    const timing = { trimInMs: 0, durationMs: 2000, playback: { speed: 1, loop: "none", reverse: false } } as Parameters<typeof visualizerBars>[2];
    expect(Array.from(visualizerBars(a, style, timing, 1000))).toEqual(Array.from(soundBandsAt(a, 1000, 32)));
  });
});

describe("the waveform window, through a clip's playback", () => {
  // A ramp: bucket k holds k / n.
  const n = 400;
  const table = Float32Array.from({ length: n }, (_, k) => k / n);
  const play = (p: Partial<{ speed: number; reverse: boolean; loop: string }>) =>
    ({ trimInMs: 0, playback: { speed: 1, loop: "none", reverse: false, ...p } }) as Parameters<typeof windowPeaks>[3];

  it("forward, reversed and doubled read the source where the clip actually is", () => {
    const fwd = windowPeaks(table, 400, 1000, play({}), 0, 1000, 4, 1000);
    expect(fwd[0]!).toBeLessThan(fwd[3]!);
    const rev = windowPeaks(table, 400, 1000, play({ reverse: true }), 0, 1000, 4, 1000);
    expect(rev[0]!).toBeGreaterThan(rev[3]!);
    // 2× plays the second through by 500 ms; after that a play-once clip is silent.
    const fast = windowPeaks(table, 400, 1000, play({ speed: 2 }), 0, 1000, 4, 1000);
    expect(fast[2]).toBe(0);
    expect(fast[1]!).toBeGreaterThan(0.9);
  });

  it("the table is the same max |sample| the timeline strip draws", () => {
    const t = peakTable([Float32Array.from([0, -0.5, 0.25, 0.1])], 4, 2);
    expect(Array.from(t)).toEqual([0.5, 0.25]);
  });
});

// ── In the document ──────────────────────────────────────────────────────────

const MUSIC = analyzeSound([clicks(500, 6)], SR);
const asked: string[] = [];
function serve(analysis: SoundAnalysis | null = MUSIC) {
  installSoundReader((assetId) => {
    asked.push(assetId);
    return analysis;
  });
}
afterEach(() => {
  installSoundReader(null);
  asked.length = 0;
});

function scene() {
  const doc = createEmptyDocument();
  const frameId = doc.frames[0]!.id;
  doc.assets.push({ id: "song", kind: "audio", name: "song.wav", mime: "audio/wav", bytes: 1, width: null, height: null, durationMs: 6000, fps: null, folderId: null, origin: null });
  const music = createAssetAudioClip({ frameId, assetId: "song", startMs: 1000, durationMs: 5000, name: "Music" });
  const lane = createTrack("Music");
  lane.clips.push(music);
  doc.tracks.push(lane);
  return { doc, frameId, music };
}

function ctxAt(doc: MotionDocument, compId: string, timeMs: number): ExprContext {
  const clipOf = clipLookup(doc);
  const inComp = () => doc.tracks.flatMap((t) => t.clips).filter((c: Clip) => c.frameId === compId);
  const layers: ExprLayerApi = {
    idFor: (name) => inComp().find((c) => c.name.toLowerCase() === name.trim().toLowerCase())?.id,
    nameOf: (id) => clipOf(id)?.name,
    propertiesOf: () => [],
    read: () => undefined,
    all: () => inComp().map((c) => ({ id: c.id, name: c.name })),
    ...mediaLayerApi(doc, timeMs, clipOf),
  };
  return { timeMs, fps: compFps(doc, compId), comp: null, layer: null, playing: false, seed: 0, compId, layers };
}
const run = (src: string, ctx: ExprContext) => evaluateProgram(parseExpression(src), { ctx, readVariable: () => undefined })?.value;

describe("sound() — any value can listen", () => {
  it("reads the music at the clip's own source time, and asking queues the analysis", () => {
    serve();
    const { doc, frameId } = scene();
    // Comp 1500 ms is 500 ms into the clip = source 500 ms.
    const beat = MUSIC.beats.find((t) => t >= 300)!;
    expect(run(`sound("Music", "beat")`, ctxAt(doc, frameId, 1000 + beat))).toBeCloseTo(1, 4);
    expect(run(`sound("Music")`, ctxAt(doc, frameId, 1000 + beat))).toBeCloseTo(soundLevelAt(MUSIC, beat), 6);
    expect(asked).toContain("song");
  });

  it("is silent before the clip, while pending, and for an unknown feature", () => {
    const { doc, frameId } = scene();
    serve();
    expect(run(`sound("Music", "bass")`, ctxAt(doc, frameId, 500))).toBe(0);
    expect(run(`sound("Music", "nonsense")`, ctxAt(doc, frameId, 2000))).toBe(0);
    serve(null);
    expect(run(`sound("Music", "bass")`, ctxAt(doc, frameId, 2000))).toBe(0);
  });

  it("soundBand and soundTempo read the same analysis", () => {
    serve();
    const { doc, frameId } = scene();
    expect(run(`soundBand("Music", 60, 250)`, ctxAt(doc, frameId, 2200))).toBeCloseTo(soundRangeAt(MUSIC, 1200, 60, 250), 6);
    expect(run(`soundTempo("Music")`, ctxAt(doc, frameId, 2200))).toBe(MUSIC.tempo);
  });

  it("an analysis landing bumps the generation every bake keys on", () => {
    const before = soundGeneration();
    serve();
    expect(soundGeneration()).toBeGreaterThan(before);
  });
});

describe("the Sound node", () => {
  it("hears the layer it targets through the driver env, every feature an output", () => {
    serve();
    const { doc, frameId, music } = scene();
    const added = createNode(defaultNodeRegistry, SOUND_NODE_TYPE, 0, 0)!;
    const g = setNodeParam({ ...createGraph(), nodes: [added] }, added.id, "target", music.id);
    const beat = MUSIC.beats.find((t) => t >= 300)!;
    const env = makeDriverEnv(doc, 1000 + beat, frameId);
    const out = evaluateGraph(g, defaultNodeRegistry, { timeMs: 0, fps: 30, mediaAt: env.mediaAt }).outputs;
    expect(out.get(socketKey(added.id, "beat"))).toBeCloseTo(1, 4);
    expect(out.get(socketKey(added.id, "tempo"))).toBe(MUSIC.tempo);
    for (const f of SOUND_FEATURES) expect(typeof out.get(socketKey(added.id, f.id))).toBe("number");
  });
});
