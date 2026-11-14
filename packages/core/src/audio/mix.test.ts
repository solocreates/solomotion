import { describe, expect, it } from "vitest";
import { createAssetAudioClip, createEmptyDocument, createTrack } from "../factories";
import { integratedLoudness, maxMomentaryLoudness, measureLoudnessTable, type LoudnessTable } from "./loudness";
import { duckCurve, duckGainAt } from "./ducking";
import { buildMixPlan, segmentKey, withMixOverride } from "./mix-plan";
import { collectCompMedia } from "./cues";
import { createSoundBus, deleteSoundBus } from "./buses";
import { dbToGain } from "./envelope";

function sine(amp: number, seconds: number, rate = 48000, hz = 997): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

describe("loudness (BS.1770)", () => {
  it("a -20 dBFS 997Hz mono sine reads -23 LUFS", () => {
    const t = measureLoudnessTable([sine(0.1, 3)], 48000);
    expect(integratedLoudness(t, 0, 3000)).toBeCloseTo(-23, 0);
  });

  it("a short hit is judged by its loudest moment, not its average", () => {
    const hit = new Float32Array(48000 * 3);
    hit.set(sine(0.5, 0.2), 48000);
    const t = measureLoudnessTable([hit], 48000);
    expect(maxMomentaryLoudness(t, 0, 3000)).toBeGreaterThan(integratedLoudness(t, 0, 3000) - 1);
  });
});

describe("ducking", () => {
  it("is fully down during the trigger and already moving before it (look-ahead)", () => {
    const c = duckCurve([{ from: 1000, to: 2000 }], { depthDb: 12, attackMs: 200, releaseMs: 400 }, 4000);
    expect(duckGainAt(c, 1500)).toBeCloseTo(dbToGain(-12), 3);
    expect(duckGainAt(c, 900)).toBeLessThan(1);
    expect(duckGainAt(c, 3500)).toBeCloseTo(1, 3);
  });
});

function project() {
  const doc = createEmptyDocument();
  const frameId = doc.frames[0]!.id;
  doc.assets.push(
    { id: "loud", kind: "audio", name: "loud.wav", mime: "audio/wav", durationMs: 4000 } as never,
    { id: "vo", kind: "audio", name: "vo.wav", mime: "audio/wav", durationMs: 4000 } as never,
  );
  const music = createAssetAudioClip({ frameId, assetId: "loud", startMs: 0, durationMs: 4000, soundBus: "music" });
  const vo = createAssetAudioClip({ frameId, assetId: "vo", startMs: 1000, durationMs: 1000, soundBus: "voice" });
  const track = createTrack("t", frameId);
  track.clips.push(music, vo);
  doc.tracks = [track];
  const tables: Record<string, LoudnessTable> = {
    loud: measureLoudnessTable([sine(0.9, 4)], 48000),
    vo: measureLoudnessTable([sine(0.1, 4)], 48000),
  };
  const loudness = { asset: (id: string) => tables[id] ?? null, pack: () => -20 };
  return { doc, frameId, music, vo, loudness };
}

describe("mix plan", () => {
  it("tames a too-loud music bed toward its category target, leaves quiet speech alone", () => {
    const { doc, frameId, loudness } = project();
    const plan = buildMixPlan(doc, frameId, loudness);
    const segs = collectCompMedia(doc, frameId);
    const music = segs.find((s) => s.assetId === "loud")!;
    const vo = segs.find((s) => s.assetId === "vo")!;
    expect(plan.segmentTrim(music)).toBeLessThan(0.5);
    expect(plan.segmentTrim(vo)).toBe(1); // lift is off by default
    expect(plan.pending).toBe(0);
  });

  it("a new project's music ducks under dialogue; an export can switch the leveler off", () => {
    const { doc, frameId, loudness } = project();
    const plan = buildMixPlan(withMixOverride(doc, frameId, { leveler: false }), frameId, loudness);
    expect(duckGainAt(plan.buses.get("music")!.duck, 1500)).toBeLessThan(0.5);
    expect(duckGainAt(plan.buses.get("music")!.duck, 3900)).toBeCloseTo(1, 2);
    expect(plan.segmentTrim(collectCompMedia(doc, frameId)[0]!)).toBe(1);
  });

  it("solo silences every other category; an unmeasured asset is pending, not guessed", () => {
    const { doc, frameId } = project();
    doc.soundBuses.find((b) => b.id === "voice")!.solo = true;
    const plan = buildMixPlan(doc, frameId, { asset: () => null, pack: () => null });
    expect(plan.buses.get("music")!.gain).toBe(0);
    expect(plan.unroutedGain).toBe(0);
    expect(plan.pending).toBe(2);
    expect(segmentKey(collectCompMedia(doc, frameId)[0]!)).toContain(":");
  });

  it("deleting a custom category re-routes its clips and drops rules that pointed at it", () => {
    const { doc, music } = project();
    const id = createSoundBus(doc, { name: "Foley" });
    music.soundBus = id;
    doc.soundBuses[0]!.ducking.push({ id: "d", enabled: true, under: { kind: "bus", id }, depthDb: 6, attackMs: 0, releaseMs: 0 });
    expect(deleteSoundBus(doc, id)).toBe(true);
    expect(music.soundBus).toBeUndefined();
    expect(doc.soundBuses[0]!.ducking).toHaveLength(0);
    expect(deleteSoundBus(doc, "voice")).toBe(false);
  });
});
