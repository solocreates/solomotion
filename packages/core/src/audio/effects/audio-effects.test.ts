import { describe, expect, it } from "vitest";
import type { KeyframeTrack } from "../../schema";
import type { AudioEffect } from "../../schema/audio-effects";
import { AFX, AUDIO_EFFECT_TYPES, mergeEqPresetBands } from "./registry";
import { audioEffectsAt, audioChainSignature, eqBandPath, eqBandsAt, parseEqBandPath } from "./resolve";
import { saturationCurve } from "./curves";
import {
  earlyReflections,
  generateReverbIr,
  reverbIrSignature,
  roomVolumeM3,
  sabineDecaySec,
  type ReverbRoom,
} from "../reverb-ir";

const room = (over: Partial<ReverbRoom> = {}): ReverbRoom => ({
  widthM: 12, heightM: 4, lengthM: 20,
  preDelayMs: 20, decaySec: 1.5, diffusion: 0.7, damping: 0.4,
  modulation: 0.2, distance: 0.35, erLevel: 1, tailLevel: 1,
  ...over,
});

const track = (property: string, value: number, timeMs = 0): KeyframeTrack => ({
  id: `t-${property}`,
  property,
  range: null,
  keys: [{ id: `k-${property}`, timeMs, value, easing: { kind: "linear" } }],
});

/**
 * The reverb's claim is that the ROOM is the parameter set — that dragging a
 * wall changes what you hear. These pin that claim, because a regression here
 * would leave the 3D editor still rendering while quietly driving nothing.
 */
describe("reverb room → impulse response", () => {
  it("a wider room moves its side reflections LATER — geometry reaches the ear", () => {
    const near = earlyReflections(room({ widthM: 4 }));
    const far = earlyReflections(room({ widthM: 40 }));
    const side = (taps: ReturnType<typeof earlyReflections>) =>
      taps.find((t) => t.wall === "left")!.timeSec;
    expect(side(far)).toBeGreaterThan(side(near));
  });

  it("every reflection arrives AFTER the direct sound, in order", () => {
    const taps = earlyReflections(room());
    expect(taps).toHaveLength(6);
    for (const t of taps) expect(t.timeSec).toBeGreaterThan(0);
    const times = taps.map((t) => t.timeSec);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("side walls pan opposite ways — the room has a stereo image", () => {
    const taps = earlyReflections(room());
    expect(taps.find((t) => t.wall === "left")!.pan).toBeLessThan(0);
    expect(taps.find((t) => t.wall === "right")!.pan).toBeGreaterThan(0);
  });

  it("damping absorbs energy — a dead room reflects less than a live one", () => {
    const live = earlyReflections(room({ damping: 0 }));
    const dead = earlyReflections(room({ damping: 1 }));
    expect(dead[0]!.gain).toBeLessThan(live[0]!.gain);
  });

  it("is DETERMINISTIC — preview and export convolve with identical taps", () => {
    const a = generateReverbIr(room(), 48000);
    const b = generateReverbIr(room(), 48000);
    expect(Array.from(a.left.slice(0, 512))).toEqual(Array.from(b.left.slice(0, 512)));
  });

  it("decorrelates the channels — a mono tail would collapse the image", () => {
    const ir = generateReverbIr(room(), 48000);
    expect(Array.from(ir.left.slice(4000, 4400))).not.toEqual(
      Array.from(ir.right.slice(4000, 4400)),
    );
  });

  it("a longer decay makes a longer response, and the tail always falls", () => {
    const short = generateReverbIr(room({ decaySec: 0.4 }), 48000);
    const long = generateReverbIr(room({ decaySec: 4 }), 48000);
    expect(long.left.length).toBeGreaterThan(short.left.length);

    const energy = (buf: Float32Array, from: number, to: number) => {
      let sum = 0;
      for (let i = from; i < to && i < buf.length; i++) sum += buf[i]! * buf[i]!;
      return sum;
    };
    const early = energy(long.left, 2000, 12000);
    const late = energy(long.left, long.left.length - 10000, long.left.length);
    expect(late).toBeLessThan(early);
  });

  it("caps its length, so a 20 s decay can still play in real time", () => {
    const ir = generateReverbIr(room({ decaySec: 20 }), 48000);
    expect(ir.left.length).toBeLessThanOrEqual(8 * 48000);
  });

  it("normalises, so resizing the room is not also a volume change", () => {
    const rms = (buf: Float32Array) => {
      let s = 0;
      for (const v of buf) s += v * v;
      return Math.sqrt(s / buf.length);
    };
    const small = rms(generateReverbIr(room({ widthM: 3, lengthM: 3, heightM: 2.4 }), 48000).left);
    const huge = rms(generateReverbIr(room({ widthM: 50, lengthM: 50, heightM: 25 }), 48000).left);
    expect(Math.abs(small - huge)).toBeLessThan(small * 0.5);
  });

  it("Sabine agrees with intuition: a bigger room rings longer", () => {
    expect(sabineDecaySec(room({ widthM: 40, heightM: 20, lengthM: 50 }))).toBeGreaterThan(
      sabineDecaySec(room({ widthM: 4, heightM: 2.4, lengthM: 5 })),
    );
    expect(roomVolumeM3({ widthM: 2, heightM: 3, lengthM: 4 })).toBe(24);
  });

  it("the IR signature moves with the room and ignores what does not reshape it", () => {
    const base = reverbIrSignature(room(), 48000);
    expect(reverbIrSignature(room({ widthM: 13 }), 48000)).not.toBe(base);
    expect(reverbIrSignature(room(), 44100)).not.toBe(base);
    expect(reverbIrSignature(room(), 48000)).toBe(base);
  });
});

/** Drive must change tone, not loudness — or every A/B is confounded. */
describe("saturation curves", () => {
  it("stays bounded and passes through zero", () => {
    for (const c of ["tape", "tube", "diode", "hard"] as const) {
      const curve = saturationCurve(c, 18);
      for (const v of curve) expect(Math.abs(v)).toBeLessThanOrEqual(1.0001);
      expect(Math.abs(curve[Math.floor(curve.length / 2)]!)).toBeLessThan(0.02);
    }
  });

  it("is monotonic — a waveshaper that folds back would alias", () => {
    const curve = saturationCurve("tape", 12);
    for (let i = 1; i < curve.length; i++) expect(curve[i]!).toBeGreaterThanOrEqual(curve[i - 1]! - 1e-6);
  });

  it("normalises: full scale in stays full scale out at ANY drive", () => {
    for (const db of [0, 6, 18, 36]) {
      const curve = saturationCurve("tape", db);
      expect(curve[curve.length - 1]!).toBeCloseTo(1, 2);
    }
  });

  it("tube and diode are ASYMMETRIC — that is where even harmonics come from", () => {
    const curve = saturationCurve("tube", 12);
    const n = curve.length - 1;
    const at = (x: number) => curve[Math.round(((x + 1) / 2) * n)]!;
    expect(Math.abs(at(0.5))).not.toBeCloseTo(Math.abs(at(-0.5)), 3);
    // Tape is symmetric, by contrast — the control case.
    const tape = saturationCurve("tape", 12);
    const atT = (x: number) => tape[Math.round(((x + 1) / 2) * n)]!;
    expect(Math.abs(atT(0.5))).toBeCloseTo(Math.abs(atT(-0.5)), 3);
  });
});

/**
 * The resolver is what keeps the exported file and the audition in agreement.
 * These pin the three rules the engines depend on.
 */
describe("audio chain resolution", () => {
  const reverb = () => AFX.create("reverb") as Extract<AudioEffect, { type: "reverb" }>;

  it("drops disabled cards — the result IS the signal path", () => {
    const a = AFX.create("echo");
    const b = { ...AFX.create("compressor"), enabled: false };
    expect(audioEffectsAt([a, b], [], 0).map((f) => f.type)).toEqual(["echo"]);
  });

  it("preserves order, because order is the chain", () => {
    const chain = [AFX.create("compressor"), AFX.create("reverb"), AFX.create("echo")];
    expect(audioEffectsAt(chain, [], 0).map((f) => f.type)).toEqual(["compressor", "reverb", "echo"]);
  });

  it("a keyframe beats the base value, on the `afx.<id>.<field>` path", () => {
    const fx = reverb();
    const keys = [track(AFX.path(fx.id, "mix"), 0.9)];
    expect(audioEffectsAt([fx], keys, 0)[0]!.values.mix).toBeCloseTo(0.9);
    expect(audioEffectsAt([fx], [], 0)[0]!.values.mix).toBeCloseTo(0.3);
  });

  it("EQ bands sample per band, so a whole curve can sweep", () => {
    const eq = AFX.create("eq") as Extract<AudioEffect, { type: "eq" }>;
    const band = eq.bands[2]!;
    const keys = [track(eqBandPath(eq.id, band.id, "freq"), 5000)];
    const got = audioEffectsAt([eq], keys, 0)[0]!.bands.find((b) => b.id === band.id)!;
    expect(got.freqHz).toBe(5000);
    expect(got.gainDb).toBe(band.gainDb);
  });

  it("eqBandsAt keeps DISABLED bands, so the curve editor can draw every handle", () => {
    const eq = AFX.create("eq") as Extract<AudioEffect, { type: "eq" }>;
    const muted = eq.bands[0]!;
    muted.enabled = false;
    const keys = [track(eqBandPath(eq.id, muted.id, "gain"), 7)];
    // The chain drops it (it is not audible)…
    expect(audioEffectsAt([eq], keys, 0)[0]!.bands.some((b) => b.id === muted.id)).toBe(false);
    // …the editor keeps it, with its keyframed value sampled.
    const drawn = eqBandsAt(eq, keys, 0).find((b) => b.id === muted.id)!;
    expect(drawn.enabled).toBe(false);
    expect(drawn.gainDb).toBe(7);
  });

  it("eqBandsAt interpolates between keys, so a swept curve is drawable mid-tween", () => {
    const eq = AFX.create("eq") as Extract<AudioEffect, { type: "eq" }>;
    const band = eq.bands[1]!;
    const keys: KeyframeTrack[] = [
      {
        id: "t-sweep",
        property: eqBandPath(eq.id, band.id, "gain"),
        range: null,
        keys: [
          { id: "k0", timeMs: 0, value: -12, easing: { kind: "linear" } },
          { id: "k1", timeMs: 1000, value: 12, easing: { kind: "linear" } },
        ],
      },
    ];
    const at = (ms: number) => eqBandsAt(eq, keys, ms).find((b) => b.id === band.id)!.gainDb;
    expect(at(0)).toBeCloseTo(-12);
    expect(at(500)).toBeCloseTo(0);
    expect(at(1000)).toBeCloseTo(12);
  });

  it("EQ band paths round-trip", () => {
    const p = eqBandPath("fx1", "b7", "q");
    expect(p).toBe("afx.fx1.band.b7.q");
    expect(parseEqBandPath(p)).toEqual({ effectId: "fx1", bandId: "b7", field: "q" });
    expect(parseEqBandPath("lfx.a.blur")).toBeNull();
  });

  it("toggles are modes, read straight off the instance", () => {
    const echo = AFX.create("echo") as Extract<AudioEffect, { type: "echo" }>;
    expect(audioEffectsAt([echo], [], 0)[0]!.flags.pingPong).toBe(false);
    expect(audioEffectsAt([{ ...echo, pingPong: true }], [], 0)[0]!.flags.pingPong).toBe(true);
  });

  it("the signature moves when nodes must be REBUILT, not when values move", () => {
    const fx = reverb();
    const base = audioChainSignature(audioEffectsAt([fx], [], 0));
    // Dry/wet is an AudioParam — no rebuild.
    const wet = audioChainSignature(audioEffectsAt([fx], [track(AFX.path(fx.id, "mix"), 0.8)], 0));
    expect(wet).toBe(base);
    // The ROOM is deliberately absent too: resizing it regenerates the impulse
    // response, but the reverb node owns that and debounces it. Rebuilding the
    // whole chain per wall-drag frame is what made the panel feel heavy.
    const moved = audioChainSignature(audioEffectsAt([fx], [track(AFX.path(fx.id, "widthM"), 30)], 0));
    expect(moved).toBe(base);
    // A card added or removed IS structural.
    const added = audioChainSignature(audioEffectsAt([fx, AFX.create("echo")], [], 0));
    expect(added).not.toBe(base);
  });
});

/** The registry is the contract the UI, the node board and presets read. */
describe("audio effect registry", () => {
  it("uses the `afx` namespace, distinct from the layer stack's `lfx`", () => {
    expect(AFX.prefix).toBe("afx");
    expect(AFX.path("x", "mix")).toBe("afx.x.mix");
    expect(AFX.effectIdOf("afx.abc.mix")).toBe("abc");
    expect(AFX.effectIdOf("lfx.abc.blur")).toBeNull();
  });

  it("every kind creates a valid instance whose fields all exist", () => {
    for (const def of AUDIO_EFFECT_TYPES) {
      const made = def.create() as unknown as Record<string, unknown>;
      expect(made.type).toBe(def.type);
      expect(made.enabled).toBe(true);
      for (const f of def.fields) expect(made[f.key]).toBeDefined();
      for (const t of def.toggles ?? []) expect(typeof made[t.key]).toBe("boolean");
    }
  });

  it("every preset patches only fields the effect actually has", () => {
    for (const def of AUDIO_EFFECT_TYPES) {
      const known = new Set([
        ...def.fields.map((f) => f.key),
        ...(def.toggles ?? []).map((t) => t.key),
        "bands",
      ]);
      for (const preset of def.presets ?? []) {
        for (const key of Object.keys(preset.patch)) expect(known).toContain(key);
      }
    }
  });

  it("the summary badge counts only what is actually processing", () => {
    const on = AFX.create("reverb");
    const off = { ...AFX.create("echo"), enabled: false };
    const s = AFX.summary([on, off]);
    expect(s.count).toBe(1);
    expect(s.labels).toEqual(["Reverb"]);
  });
});

/**
 * Applying a preset must never destroy automation. The old EQ panel deleted
 * every band keyframe when you clicked a preset; these pin that it cannot come
 * back, because the failure is silent and only noticed after the work is lost.
 */
describe("presets are keyframe-safe", () => {
  it("an EQ preset REUSES existing band ids, so keyframed bands keep animating", () => {
    const eq = AFX.create("eq") as Extract<AudioEffect, { type: "eq" }>;
    const before = eq.bands.map((b) => b.id);
    const preset = AFX.def("eq")!.presets!.find((p) => p.id === "vocal")!;
    const merged = mergeEqPresetBands(eq.bands, preset.patch.bands as typeof eq.bands);

    // Same ids in the same slots ⇒ `afx.<fx>.band.<id>.gain` still resolves.
    expect(merged.slice(0, before.length).map((b) => b.id)).toEqual(before.slice(0, merged.length));
    // …but the CURVE is the preset's, not the old one.
    expect(merged[0]!.freqHz).toBe(90);
    expect(merged[0]!.type).toBe("highpass");
  });

  it("a preset with MORE bands than the card gives the extras fresh ids", () => {
    const two = [
      { id: "keep-1", type: "peaking" as const, freqHz: 100, gainDb: 0, q: 1, enabled: true },
      { id: "keep-2", type: "peaking" as const, freqHz: 200, gainDb: 0, q: 1, enabled: true },
    ];
    const incoming = AFX.def("eq")!.presets!.find((p) => p.id === "podcast")!.patch.bands as typeof two;
    const merged = mergeEqPresetBands(two, incoming);
    expect(merged.length).toBe(incoming.length);
    expect(merged[0]!.id).toBe("keep-1");
    expect(merged[1]!.id).toBe("keep-2");
    expect(new Set(merged.map((b) => b.id)).size).toBe(merged.length);
  });

  it("every non-EQ preset is a plain field patch — no ids, nothing to orphan", () => {
    for (const def of AUDIO_EFFECT_TYPES) {
      if (def.type === "eq") continue;
      for (const preset of def.presets ?? []) {
        expect(Object.keys(preset.patch)).not.toContain("id");
        for (const v of Object.values(preset.patch)) expect(Array.isArray(v)).toBe(false);
      }
    }
  });
});
