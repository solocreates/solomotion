import { afterEach, describe, expect, it } from "vitest";
import type { SpeechTrack, VisemeId } from "@solomotion/lipsync";
import type { MotionDocument, AudioClip, Clip, GroupClip, ShapeClip } from "../schema";
import { createAssetAudioClip, createEmptyDocument, createShapeClip, createTrack } from "../factories";
import { clipLookup } from "../timeline/frame-index";
import { locateClip } from "../timeline/ops";
import { makeSwitch } from "../timeline/switch-ops";
import { switchValueAt } from "../timeline/switch";
import { compFps } from "../timeline/fps";
import { evaluateProgram } from "../expressions/eval";
import { parseExpression } from "../expressions/parser";
import { withExpressionContext, withExpressionLayer } from "../expressions/bind";
import type { ExprContext } from "../expressions/globals";
import type { ExprLayerApi } from "../expressions/layer-api";
import { resolveDocumentDrivers } from "../nodes/resolve-clip";
import { defaultNodeRegistry } from "../nodes/builtin";
import { variableValueNow } from "../variables";
import { installSpeechReader, speechGeneration } from "./reader";
import { mediaLayerApi, mediaSourceAt } from "./source";
import { bakeMouth, mouthsIn, setMouthVoice } from "./bind";
import { poseChannelAt, resolvePose } from "../rig/poses";
import { addExpression } from "../expressions/document";
import { fxToken } from "../schema";
import "./functions";

// A 4 s recording: four clear one-second shapes, loud throughout.
const SEGMENTS: VisemeId[] = ["AI", "O", "MBP", "U"];
const TRACK: SpeechTrack = {
  engine: "test",
  version: 1,
  settingsKey: "",
  durationMs: 4000,
  cues: SEGMENTS.map((viseme, i) => ({ startMs: i * 1000, endMs: (i + 1) * 1000, viseme, confidence: 1 })),
  energy: { hopMs: 10, values: new Array(400).fill(0.8) },
};
/** What the recording says at source ms (segment centres only — the feel pass leads and snaps edges). */
const said = (sourceMs: number) => SEGMENTS[Math.floor(sourceMs / 1000)]!;

const asked: string[] = [];
function serve(track: SpeechTrack | null = TRACK) {
  installSpeechReader((assetId) => {
    asked.push(assetId);
    return track;
  });
}
afterEach(() => {
  installSpeechReader(null);
  asked.length = 0;
});

function scene() {
  const doc = createEmptyDocument();
  const frameId = doc.frames[0]!.id;
  doc.assets.push({ id: "take1", kind: "audio", name: "take1.wav", mime: "audio/wav", bytes: 1, width: null, height: null, durationMs: 4000, fps: null, folderId: null, origin: null });
  const voice = createAssetAudioClip({ frameId, assetId: "take1", startMs: 0, durationMs: 4000, name: "Voice" });
  const lane = createTrack("Voice");
  lane.clips.push(voice);
  doc.tracks.push(lane);
  return { doc, frameId, voice };
}

/** A mouth switch with five drawings — no U, no FV, no L. */
function withMouth(doc: MotionDocument, frameId: string) {
  const ids = ["Rest", "MBP", "AI", "E", "O"].map((name) => {
    const c = createShapeClip({ frameId, shape: "ellipse", startMs: 0, durationMs: 10_000, x: 0, y: 0, width: 40, height: 20 }) as ShapeClip;
    c.name = name;
    const t = createTrack(name);
    t.clips.push(c);
    doc.tracks.push(t);
    return c.id;
  });
  return makeSwitch(doc, ids, { name: "Mouth" })!;
}

function layersAt(doc: MotionDocument, compId: string, timeMs: number): ExprLayerApi {
  const clipOf = clipLookup(doc);
  const inComp = () => doc.tracks.flatMap((t) => t.clips).filter((c) => c.frameId === compId);
  return {
    idFor: (name) => inComp().find((c) => c.name.toLowerCase() === name.trim().toLowerCase())?.id,
    nameOf: (id) => clipOf(id)?.name,
    propertiesOf: () => [],
    read: () => undefined,
    all: () => inComp().map((c) => ({ id: c.id, name: c.name })),
    ...mediaLayerApi(doc, timeMs, clipOf),
  };
}

function ctxAt(doc: MotionDocument, compId: string, timeMs: number, layer: Clip | null = null): ExprContext {
  return {
    timeMs,
    fps: compFps(doc, compId),
    comp: null,
    layer: layer ? { id: layer.id, name: layer.name, index: 0, startMs: layer.startMs, durationMs: layer.durationMs, width: 0, height: 0, opacity: 1 } : null,
    playing: false,
    seed: 0,
    compId,
    layers: layersAt(doc, compId, timeMs),
  };
}

const run = (src: string, ctx: ExprContext) => evaluateProgram(parseExpression(src), { ctx, readVariable: () => undefined })?.value;

describe("comp time → the voice's source time (THE source-time map)", () => {
  it("honours trim, speed, reverse and loop, and is silent past a play-once end", () => {
    const { doc, voice } = scene();
    voice.startMs = 1000;
    voice.trimInMs = 500;
    voice.playback = { ...voice.playback, speed: 2 };
    voice.durationMs = 1500;
    // 250 ms in, at 2× → 500 ms of source after a 500 ms trim.
    expect(mediaSourceAt(doc, voice, 1250)?.sourceMs).toBeCloseTo(1000, 6);
    expect(mediaSourceAt(doc, voice, 999)).toBeNull();
    expect(mediaSourceAt(doc, voice, 2500)).toBeNull();

    voice.startMs = 0;
    voice.trimInMs = 0;
    voice.playback = { ...voice.playback, speed: 1, reverse: true };
    voice.durationMs = 4000;
    expect(mediaSourceAt(doc, voice, 500)?.sourceMs).toBeCloseTo(3500, 6);

    voice.trimInMs = 3000; // a 1 s natural span, looped three times
    voice.playback = { ...voice.playback, reverse: false, loop: "loop" };
    voice.durationMs = 3000;
    expect(mediaSourceAt(doc, voice, 1500)?.sourceMs).toBeCloseTo(3500, 6);

    voice.playback = { ...voice.playback, loop: "none" };
    expect(mediaSourceAt(doc, voice, 1500)).toBeNull(); // past the end of a play-once source
  });
});

describe("lipsync() reads the voice through its own clip", () => {
  it("trimmed + sped + reversed + looped audio map to the right cue", () => {
    serve();
    const { doc, frameId, voice } = scene();
    const at = (t: number) => run('lipsync("Voice")', ctxAt(doc, frameId, t));

    voice.trimInMs = 1000;
    voice.playback = { ...voice.playback, speed: 2 };
    voice.durationMs = 1500;
    expect(at(250)).toBe(said(1500)); // O
    expect(at(1250)).toBe(said(3500)); // U

    voice.trimInMs = 0;
    voice.playback = { ...voice.playback, speed: 1, reverse: true };
    voice.durationMs = 4000;
    expect(at(500)).toBe(said(3500));
    expect(at(3500)).toBe(said(500));

    voice.trimInMs = 2000; // MBP, U, MBP, U…
    voice.playback = { ...voice.playback, reverse: false, loop: "loop" };
    voice.durationMs = 8000;
    expect(at(500)).toBe("MBP");
    expect(at(2500)).toBe("MBP");
    expect(at(5500)).toBe("U");
  });

  it("re-syncs when the clip moves — the same track, nothing re-analysed", () => {
    serve();
    const { doc, frameId, voice } = scene();
    const before = run('lipsync("Voice")', ctxAt(doc, frameId, 1500));
    voice.startMs = 2000;
    expect(run('lipsync("Voice")', ctxAt(doc, frameId, 3500))).toBe(before);
    expect(run('lipsync("Voice")', ctxAt(doc, frameId, 1500))).toBe("X"); // not sounding yet
    expect(new Set(asked)).toEqual(new Set(["take1"]));
  });

  it("two clips of one asset share one track", () => {
    serve();
    const { doc, frameId, voice } = scene();
    const again = { ...voice, id: "clip_again", name: "Again", startMs: 5000 } as AudioClip;
    doc.tracks[doc.tracks.length - 1]!.clips.push(again);
    expect(run('lipsync("Again")', ctxAt(doc, frameId, 6500))).toBe(run('lipsync("Voice")', ctxAt(doc, frameId, 1500)));
    expect(new Set(asked)).toEqual(new Set(["take1"]));
  });

  it("a pending track is rest (and asking for it is the request); speaking/loudness are 0", () => {
    serve(null);
    const { doc, frameId } = scene();
    const ctx = ctxAt(doc, frameId, 1500);
    expect(run('lipsync("Voice")', ctx)).toBe("X");
    expect(run('speaking("Voice")', ctx)).toBe(0);
    expect(run('loudness("Voice")', ctx)).toBe(0);
    expect(asked).toContain("take1");
    expect(run('lipsync("Nobody")', ctx)).toBe("X");
  });

  it("speaking and loudness follow the voice", () => {
    serve();
    const { doc, frameId } = scene();
    expect(run('speaking("Voice")', ctxAt(doc, frameId, 1500))).toBe(1);
    expect(run('loudness("Voice")', ctxAt(doc, frameId, 1500))).toBeCloseTo(0.8, 2);
    expect(run('speaking("Voice")', ctxAt(doc, frameId, 4500))).toBe(0);
  });

  it("is deterministic across scrub direction", () => {
    serve();
    const { doc, frameId, voice } = scene();
    voice.playback = { ...voice.playback, speed: 1.37 };
    const times = Array.from({ length: 120 }, (_, i) => i * 33.333);
    const forward = times.map((t) => run('lipsync("Voice")', ctxAt(doc, frameId, t)));
    const backward = [...times].reverse().map((t) => run('lipsync("Voice")', ctxAt(doc, frameId, t))).reverse();
    expect(backward).toEqual(forward);
  });

  it("hand fixes live in source time — they ride the clip when it moves", () => {
    serve();
    const { doc, frameId, voice } = scene();
    doc.assets[0]!.speech = { engine: "auto", edits: [{ startMs: 1200, endMs: 1800, viseme: "E" }] };
    expect(run('lipsync("Voice")', ctxAt(doc, frameId, 1500))).toBe("E");
    expect(run('lipsync("Voice")', ctxAt(doc, frameId, 2500))).toBe("MBP");
    voice.startMs = 1000;
    expect(run('lipsync("Voice")', ctxAt(doc, frameId, 2500))).toBe("E");
  });
});

describe("a mouth talks through its Lip sync behavior", () => {
  function talking() {
    serve();
    const { doc, frameId, voice } = scene();
    const switchId = withMouth(doc, frameId);
    const at = setMouthVoice(doc, mouthsIn(doc, frameId)[0]!, "Voice")!;
    const group = () => locateClip(doc, at.groupId)!.clip as GroupClip;
    const set = () => group().poses!.find((s) => s.id === at.setId)!;
    const poseAt = (t: number) => resolvePose(set(), poseChannelAt(doc, group(), set(), t))?.name;
    return { doc, frameId, voice, switchId, at, group, poseAt };
  }

  it("a bare mouth switch becomes a viseme set on itself, heard through a behavior", () => {
    const { doc, frameId, switchId, at, poseAt } = talking();
    expect(at.groupId).toBe(switchId);
    const [m] = mouthsIn(doc, frameId);
    expect(m).toMatchObject({ setId: at.setId, behaviorId: at.behaviorId, voice: "Voice" });
    expect([500, 1500, 2500].map(poseAt)).toEqual(["AI", "O", "MBP"]);
    expect(poseAt(3500)).toBe("O"); // no U drawn → the nearest round shape
  });

  it("silencing disables the behavior (its map survives); a voice turns it back on", () => {
    const { doc, frameId, at, group } = talking();
    setMouthVoice(doc, mouthsIn(doc, frameId)[0]!, null);
    expect(mouthsIn(doc, frameId)[0]!.voice).toBeNull();
    expect(group().behaviors).toHaveLength(1);
    setMouthVoice(doc, mouthsIn(doc, frameId)[0]!, "");
    expect(group().behaviors![0]).toMatchObject({ id: at.behaviorId, enabled: true, voice: "" });
  });

  it("an older lipsync() driver reads as the voice, and giving a voice replaces it", () => {
    serve();
    const { doc, frameId } = scene();
    const switchId = withMouth(doc, frameId);
    const sw = locateClip(doc, switchId)!.clip;
    sw.drivers = { switch: fxToken(addExpression(doc, 'lipsync("Voice")', "Mouth · lip sync").id) };
    expect(mouthsIn(doc, frameId)[0]).toMatchObject({ setId: null, voice: "Voice" });
    setMouthVoice(doc, mouthsIn(doc, frameId)[0]!, "Voice");
    expect(locateClip(doc, switchId)!.clip.drivers?.switch).toBeUndefined();
    expect(mouthsIn(doc, frameId)).toHaveLength(1);
  });

  it("a landed track is a new speech generation (bakes re-key)", () => {
    const g = speechGeneration();
    serve();
    expect(speechGeneration()).toBeGreaterThan(g);
  });

  it("bakes to hold keys that show what it said, and switches the behavior off", () => {
    const { doc, voice, at, group, poseAt } = talking();
    const live = [500, 1500, 2500, 3500].map(poseAt);
    const res = bakeMouth(doc, at.groupId, at.setId, voice.id)!;
    expect(res.keys).toBeGreaterThanOrEqual(4);
    expect(group().behaviors![0]!.enabled).toBe(false);
    expect([500, 1500, 2500, 3500].map(poseAt)).toEqual(live);
  });
});
