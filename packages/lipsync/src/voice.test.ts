import { describe, expect, it } from "vitest";
import { evaluateCues, runSpeechEngine, shapeCues, VISEME_IDS, type SynthesisResult } from "./index";
import { synthesize } from "./voice/index";

const LINES = [
  "Hello there! My name is Pip, and I make little films about big ideas.",
  "Would you like to see how the mouth moves when I talk? Watch closely.",
  "Five frogs found a phone. Who knew they could sing so softly?",
];

function fnv(pcm: Float32Array): string {
  const b = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i]!, 0x01000193) >>> 0;
  return h.toString(16);
}

describe("Test Voice", () => {
  it("is deterministic: same text + preset + seed → identical samples", () => {
    const a = synthesize(LINES[0]!, { preset: "warm", seed: 7 });
    const b = synthesize(LINES[0]!, { preset: "warm", seed: 7 });
    expect(fnv(a.pcm)).toBe(fnv(b.pcm));
    expect(fnv(synthesize(LINES[0]!, { preset: "warm", seed: 8 }).pcm)).not.toBe(fnv(a.pcm));
    expect(fnv(synthesize(LINES[0]!, { preset: "robo", seed: 7 }).pcm)).not.toBe(fnv(a.pcm));
  });

  it("is fast, sane audio, with exact cues and words on its own timeline", () => {
    const t0 = performance.now();
    const r = synthesize(LINES.join(" "), { preset: "bright" });
    const ms = performance.now() - t0;
    const seconds = r.pcm.length / r.sampleRate;
    expect(ms / seconds).toBeLessThan(60); // measured ≈ 10–20 ms per second of audio
    let peak = 0, nan = 0;
    for (const s of r.pcm) { if (!Number.isFinite(s)) nan++; peak = Math.max(peak, Math.abs(s)); }
    expect(nan).toBe(0);
    expect(peak).toBeCloseTo(0.89, 2);
    expect(r.cues[0]!.startMs).toBe(0);
    expect(r.cues.at(-1)!.endMs).toBeCloseTo(r.durationMs, 6);
    expect(r.words.map((w) => w.text).slice(0, 3)).toEqual(["Hello", "there", "My"]);
    for (const v of VISEME_IDS) expect(r.cues.some((c) => c.viseme === v)).toBe(true);
  });

  it("runs through the registry as a synthesize engine", async () => {
    const r = (await runSpeechEngine("test-voice", { text: "Hi, I'm Pip." }, { preset: "robo" })) as SynthesisResult;
    expect(r.engine).toBe("test-voice");
    expect(r.settingsKey).toContain("preset=robo");
    expect(r.pcm.length).toBeGreaterThan(0);
  });
});

describe("engines measured against Test Voice ground truth", () => {
  const voices = LINES.map((l, i) => synthesize(l, { preset: (["warm", "bright", "robo"] as const)[i], seed: i + 1 }));

  it("spectral (listening) — accuracy floor", async () => {
    let frames = 0, acc = 0, tol = 0, near = 0, rec = 0, prec = 0;
    for (const v of voices) {
      const t = await runSpeechEngine("spectral", { pcm: { samples: v.pcm, sampleRate: v.sampleRate } });
      const s = evaluateCues(t.cues, v.cues, { toleranceMs: 40 });
      frames += s.frames; acc += s.accuracy * s.frames; tol += s.tolerantAccuracy * s.frames; near += s.nearAccuracy * s.frames;
      rec += s.speaking.recall * s.frames; prec += s.speaking.precision * s.frames;
    }
    const r = { accuracy: acc / frames, tolerant: tol / frames, near: near / frames, recall: rec / frames, precision: prec / frames };
    console.log("spectral vs Test Voice", JSON.stringify(r));
    expect(r.accuracy).toBeGreaterThan(0.3);
    expect(r.recall).toBeGreaterThan(0.8);
  });

  it("align from the voice's own word times — accuracy floor", async () => {
    let frames = 0, acc = 0;
    for (const v of voices) {
      const t = await runSpeechEngine("align", { words: v.words, durationMs: v.durationMs });
      const s = evaluateCues(t.cues, v.cues);
      frames += s.frames; acc += s.accuracy * s.frames;
    }
    console.log("align(words) vs Test Voice", (acc / frames).toFixed(3));
    expect(acc / frames).toBeGreaterThan(0.75);
  });

  it("the feel pass calms flicker without losing the read", async () => {
    const v = voices[0]!;
    const t = await runSpeechEngine("spectral", { pcm: { samples: v.pcm, sampleRate: v.sampleRate } });
    const raw = evaluateCues(t.cues, v.cues, { toleranceMs: 40 });
    const out: Record<string, unknown> = { raw: { cps: raw.changesPerSecond.toFixed(1), tol: raw.tolerantAccuracy.toFixed(3) } };
    for (const profile of ["drawings", "morph", "bones"] as const) {
      const shaped = shapeCues(t.cues, { profile, fps: 24, loudness: t.energy, durationMs: t.durationMs });
      // Score against truth moved by the same lead, so we measure the shaping, not the intended offset.
      const lead = profile === "drawings" ? 60 : profile === "morph" ? 90 : 110;
      const truth = v.cues.map((c) => ({ ...c, startMs: Math.max(0, c.startMs - lead), endMs: Math.max(0, c.endMs - lead) }));
      const s = evaluateCues(shaped, truth, { toleranceMs: 40 });
      out[profile] = { cps: s.changesPerSecond.toFixed(1), tol: s.tolerantAccuracy.toFixed(3) };
      expect(s.changesPerSecond).toBeLessThanOrEqual(raw.changesPerSecond);
      expect(s.tolerantAccuracy).toBeGreaterThan(raw.tolerantAccuracy - 0.08);
      for (let i = 1; i < shaped.length; i++) expect(shaped[i]!.startMs).toBe(shaped[i - 1]!.endMs);
    }
    console.log("feel pass", JSON.stringify(out));
  });
});

describe("feel pass rules", () => {
  const c = (startMs: number, endMs: number, viseme: (typeof VISEME_IDS)[number]) => ({ startMs, endMs, viseme, confidence: 1 });
  const base = { profile: "morph" as const, leadMs: 0 };

  it("never drops a closure; borrows from the following cue", () => {
    const out = shapeCues([c(0, 200, "AI"), c(200, 220, "MBP"), c(220, 500, "O")], base);
    const m = out.find((x) => x.viseme === "MBP")!;
    expect(m.endMs - m.startMs).toBe(50);
    expect(m.startMs).toBe(200);
  });

  it("bridges short silences, rests on real pauses, gates breaths", () => {
    const out = shapeCues([c(0, 200, "AI"), c(200, 300, "X"), c(300, 500, "E"), c(500, 900, "X"), c(900, 1000, "O")], {
      ...base,
      loudness: { hopMs: 10, values: Array.from({ length: 100 }, (_, i) => (i >= 90 ? 0.05 : i < 50 ? 0.8 : 0)) },
    });
    expect(out.map((x) => x.viseme)).toEqual(["AI", "E", "X"]); // 100ms gap held; the quiet "O" is a breath
  });

  it("rounds an S before U, applies lead and the energy knob, snaps drawings to frames", () => {
    const rounded = shapeCues([c(0, 100, "X"), c(100, 180, "S"), c(180, 400, "U")], base);
    expect(rounded.map((x) => x.viseme)).toEqual(["X", "U"]);
    const led = shapeCues([c(0, 500, "X"), c(500, 800, "AI")], { profile: "bones", energy: 0.5 });
    expect(led[1]!.startMs).toBe(390);
    expect(led[1]!.intensity).toBe(0.5);
    const drawn = shapeCues([c(0, 333, "X"), c(333, 777, "AI"), c(777, 1000, "X")], { profile: "drawings", fps: 24 });
    for (const x of drawn) expect((x.startMs * 24) / 1000).toBeCloseTo(Math.round((x.startMs * 24) / 1000), 6);
  });
});
