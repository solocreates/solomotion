import { describe, expect, it } from "vitest";
import {
  audioSpecificConfigFromAdts,
  declaredSampleRate,
  parseAudioSpecificConfig,
  looksLikeAdts,
  normalizeAacFrames,
  sampleRateFromAdts,
  toMuxableAacTrack,
} from "./aac-frames";

/**
 * These are the two ways an AAC track ends up silent while every tool in the
 * chain reports success: headers the container was not told about, and samples
 * with no duration. Both are invisible until someone plays the file, so they
 * are pinned here instead.
 */

/** An ADTS header: AAC-LC, 48 kHz (index 3), stereo, no CRC (7 bytes). */
function adtsHeader(payloadLength: number): number[] {
  const frameLength = 7 + payloadLength;
  return [
    0xff,
    0xf1, // sync + MPEG-4 + layer 00 + protection_absent
    (1 << 6) | (3 << 2) | ((2 >> 2) & 0x01), // profile LC, freq idx 3, channels hi bit
    ((2 & 0x03) << 6) | ((frameLength >> 11) & 0x03),
    (frameLength >> 3) & 0xff,
    ((frameLength & 0x07) << 5) | 0x1f,
    0xfc,
  ];
}

const adtsFrame = (payload: number[]) => Uint8Array.from([...adtsHeader(payload.length), ...payload]);

describe("ADTS detection", () => {
  it("recognises a header, and does not see one in raw AAC", () => {
    expect(looksLikeAdts(adtsFrame([1, 2, 3]))).toBe(true);
    expect(looksLikeAdts(Uint8Array.from([0x21, 0x1a, 0x00, 0x4e, 0x00, 0x00, 0x00]))).toBe(false);
    // 0xFF alone is not a syncword — a raw frame may legitimately open with it.
    expect(looksLikeAdts(Uint8Array.from([0xff, 0x0a, 0, 0, 0, 0, 0]))).toBe(false);
    expect(looksLikeAdts(Uint8Array.from([0xff]))).toBe(false);
  });

  it("recovers the format the header was carrying", () => {
    const frame = adtsFrame([9, 9, 9]);
    expect(sampleRateFromAdts(frame)).toBe(48000);
    // AAC-LC (object type 2), freq index 3, 2 channels → 0x11 0x90.
    expect([...audioSpecificConfigFromAdts(frame)!]).toEqual([0x11, 0x90]);
  });
});

describe("normalizeAacFrames", () => {
  it("strips ADTS headers and recovers the description from one", () => {
    const chunks = [
      { data: adtsFrame([1, 2, 3, 4]), timestampUs: 0, durationUs: 21333 },
      { data: adtsFrame([5, 6]), timestampUs: 21333, durationUs: 21333 },
    ];
    const out = normalizeAacFrames(chunks, 48000, null);
    expect(out.strippedAdts).toBe(true);
    expect(out.frames.map((f) => [...f.data])).toEqual([[1, 2, 3, 4], [5, 6]]);
    expect([...out.description!]).toEqual([0x11, 0x90]);
  });

  it("leaves raw frames exactly alone", () => {
    const raw = Uint8Array.from([0x21, 0x1a, 0x00]);
    const out = normalizeAacFrames([{ data: raw, timestampUs: 0, durationUs: 21333 }], 48000, null);
    expect(out.strippedAdts).toBe(false);
    expect(out.frames[0]!.data).toBe(raw);
    expect(out.derivedDurations).toBe(false);
  });

  it("keeps the encoder's own description over one derived from a header", () => {
    const mine = Uint8Array.from([0x12, 0x34]);
    const out = normalizeAacFrames(
      [{ data: adtsFrame([1]), timestampUs: 0, durationUs: 21333 }],
      48000,
      mine,
    );
    expect(out.description).toBe(mine);
  });

  it("gives every sample a real duration when the encoder states none", () => {
    const raw = () => Uint8Array.from([0x21, 0x1a]);
    const out = normalizeAacFrames(
      [
        { data: raw(), timestampUs: 0, durationUs: null },
        { data: raw(), timestampUs: 0, durationUs: 0 },
        { data: raw(), timestampUs: 0, durationUs: null },
      ],
      48000,
      null,
    );
    expect(out.derivedDurations).toBe(true);
    // 1024 samples at 48 kHz.
    expect(out.frames.map((f) => f.durationUs)).toEqual([21333, 21333, 21333]);
    // …and the timestamps must ADVANCE. A track whose samples all start at
    // zero has no length, which is its own way of being silent.
    expect(out.frames.map((f) => f.timestampUs)).toEqual([0, 21333, 42666]);
  });

  it("trusts timestamps the encoder does state", () => {
    const raw = () => Uint8Array.from([0x21]);
    const out = normalizeAacFrames(
      [
        { data: raw(), timestampUs: 0, durationUs: 21333 },
        { data: raw(), timestampUs: 21333, durationUs: 21333 },
        { data: raw(), timestampUs: 42666, durationUs: 21333 },
      ],
      48000,
      null,
    );
    expect(out.frames.map((f) => f.timestampUs)).toEqual([0, 21333, 42666]);
    expect(out.derivedDurations).toBe(false);
  });

  it("drops a header with no payload rather than muxing an empty sample", () => {
    const out = normalizeAacFrames(
      [
        { data: Uint8Array.from(adtsHeader(0)), timestampUs: 0, durationUs: 21333 },
        { data: adtsFrame([7]), timestampUs: 21333, durationUs: 21333 },
      ],
      48000,
      null,
    );
    expect(out.frames).toHaveLength(1);
    expect([...out.frames[0]!.data]).toEqual([7]);
  });
});

describe("parseAudioSpecificConfig", () => {
  it("reads AAC-LC 48 kHz stereo", () => {
    const config = parseAudioSpecificConfig(Uint8Array.from([0x11, 0x90]))!;
    expect(config).toEqual({ objectType: 2, sampleRate: 48000, channels: 2, extensionSampleRate: null });
    expect(declaredSampleRate(config)).toBe(48000);
  });

  it("catches an encoder that returned MONO when stereo was asked for", () => {
    // objectType 2, freq index 3 (48 kHz), channelConfiguration 1.
    const config = parseAudioSpecificConfig(Uint8Array.from([0x11, 0x88]))!;
    expect(config.channels).toBe(1);
  });

  it("catches a rate that is not the one requested", () => {
    // objectType 2, freq index 4 (44.1 kHz), stereo.
    expect(parseAudioSpecificConfig(Uint8Array.from([0x12, 0x10]))!.sampleRate).toBe(44100);
  });

  it("reports HE-AAC's output rate, not its core rate", () => {
    // AOT 5 (SBR), core 24 kHz (index 6), stereo, extension 48 kHz (index 3).
    // 00101 0110 0010 0011 00010 → 0x2B 0x11 0x88 0x40
    const config = parseAudioSpecificConfig(Uint8Array.from([0x2b, 0x11, 0x88, 0x40]))!;
    expect(config.objectType).toBe(5);
    expect(config.sampleRate).toBe(24000);
    expect(config.extensionSampleRate).toBe(48000);
    // A container declaring 24000 would play this half speed.
    expect(declaredSampleRate(config)).toBe(48000);
  });

  it("returns null for bytes that are not a config", () => {
    expect(parseAudioSpecificConfig(Uint8Array.from([0x00]))).toBeNull();
    expect(parseAudioSpecificConfig(Uint8Array.from([0x00, 0x00]))).toBeNull();
  });
});

describe("toMuxableAacTrack", () => {
  const raw = (n = 40) => Uint8Array.from(Array.from({ length: n }, (_, i) => (i * 7) % 251));

  it("re-bases a track that does not open at zero", () => {
    // WebKit's recorder opens its first fragment 64 samples in: 1333 µs. An MP4
    // track must open at 0, and the muxer refuses the export outright if not.
    const track = toMuxableAacTrack(
      [
        { data: raw(), timestampUs: 1333, durationUs: 21333 },
        { data: raw(), timestampUs: 22666, durationUs: 21333 },
        { data: raw(), timestampUs: 43999, durationUs: 21333 },
      ],
      48000,
      Uint8Array.from([0x11, 0x90]),
    )!;
    expect(track.frames.map((f) => f.timestampUs)).toEqual([0, 21333, 42666]);
    expect(track.notes).toContain("re-based from 1333 µs");
  });

  it("leaves a track that already opens at zero untouched", () => {
    const track = toMuxableAacTrack(
      [
        { data: raw(), timestampUs: 0, durationUs: 21333 },
        { data: raw(), timestampUs: 21333, durationUs: 21333 },
      ],
      48000,
      Uint8Array.from([0x11, 0x90]),
    )!;
    expect(track.frames.map((f) => f.timestampUs)).toEqual([0, 21333]);
    expect(track.notes.some((n) => n.startsWith("re-based"))).toBe(false);
  });

  it("drops empty frames so a count can never stand in for audio", () => {
    const track = toMuxableAacTrack(
      [
        { data: new Uint8Array(0), timestampUs: 0, durationUs: 21333 },
        { data: raw(), timestampUs: 21333, durationUs: 21333 },
        { data: new Uint8Array(0), timestampUs: 42666, durationUs: 21333 },
      ],
      48000,
      null,
    )!;
    expect(track.frames).toHaveLength(1);
    expect(track.totalBytes).toBe(40);
    expect(track.notes).toContain("dropped 2 empty frames");
  });

  it("returns null when nothing carries any bytes at all", () => {
    expect(
      toMuxableAacTrack(
        [
          { data: new Uint8Array(0), timestampUs: 0, durationUs: 21333 },
          { data: new Uint8Array(0), timestampUs: 21333, durationUs: 21333 },
        ],
        48000,
        null,
      ),
    ).toBeNull();
    expect(toMuxableAacTrack([], 48000, null)).toBeNull();
  });

  it("takes the format from the bitstream, not from the request", () => {
    // The encoder answered mono at 44.1 kHz to a stereo 48 kHz request.
    const track = toMuxableAacTrack(
      [{ data: raw(), timestampUs: 0, durationUs: 21333 }],
      48000,
      Uint8Array.from([0x12, 0x08]),
    )!;
    expect(track.sampleRate).toBe(44100);
    expect(track.channels).toBe(1);
    expect(track.notes).toContain("encoder gave 1ch @ 44100 Hz");
  });

  it("normalises both sources identically — the whole point of one door", () => {
    // The SAME frames, arriving from the encoder (at zero, with durations) and
    // from a recording (offset, ADTS-framed, durations unstated), must produce
    // the same muxable track.
    const fromEncoder = toMuxableAacTrack(
      [
        { data: raw(), timestampUs: 0, durationUs: 21333 },
        { data: raw(), timestampUs: 21333, durationUs: 21333 },
      ],
      48000,
      Uint8Array.from([0x11, 0x90]),
    )!;
    const fromRecording = toMuxableAacTrack(
      [
        { data: adtsFrame([...raw()]), timestampUs: 1333, durationUs: null },
        { data: adtsFrame([...raw()]), timestampUs: 22666, durationUs: null },
      ],
      48000,
      null,
    )!;
    expect(fromRecording.frames.map((f) => f.timestampUs)).toEqual(
      fromEncoder.frames.map((f) => f.timestampUs),
    );
    expect(fromRecording.frames.map((f) => [...f.data])).toEqual(
      fromEncoder.frames.map((f) => [...f.data]),
    );
    expect(fromRecording.sampleRate).toBe(fromEncoder.sampleRate);
    expect(fromRecording.channels).toBe(fromEncoder.channels);
  });
});
