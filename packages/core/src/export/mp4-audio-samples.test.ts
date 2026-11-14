import { describe, expect, it } from "vitest";
import { parseFragmentedMp4Audio, parseProgressiveMp4Audio } from "./mp4-audio-samples";

/**
 * The parser's whole job is byte offsets, and the only honest way to test byte
 * offsets is to build the bytes. These helpers write the same boxes Safari's
 * MediaRecorder writes for an `audio/mp4` recording, so a regression in the
 * `tfhd`/`trun` offset maths — the failure that would ship AAC noise instead of
 * dialogue — fails here rather than on someone's phone.
 */

function box(type: string, ...payload: Array<Uint8Array | number[]>): Uint8Array {
  const body = concat(...payload);
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}

function concat(...parts: Array<Uint8Array | number[]>): Uint8Array {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}

function u32(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setUint32(i * 4, v));
  return out;
}

function u16(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setUint16(i * 2, v));
  return out;
}

const ASC = [0x11, 0x90]; // AAC-LC, 48 kHz, stereo

function esds(): Uint8Array {
  return box(
    "esds",
    u32(0), // FullBox
    [0x03, 25], // ES_Descriptor
    [0x00, 0x01, 0x00], // ES_ID + flags (no optional fields)
    [0x04, 17], // DecoderConfigDescriptor
    [0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0x05, ASC.length],
    ASC,
  );
}

function moov({ timescale = 48000, trackId = 1, defaultDuration = 1024, defaultSize = 0 } = {}): Uint8Array {
  const mp4a = box(
    "mp4a",
    new Uint8Array(6), // reserved
    u16(1), // data_reference_index
    new Uint8Array(8), // version/revision/vendor
    u16(2), // channelcount
    u16(16), // samplesize
    u16(0, 0), // pre_defined + reserved
    u32(48000 << 16),
    esds(),
  );
  const trak = box(
    "trak",
    box("tkhd", u32(0), u32(0, 0, trackId)),
    box(
      "mdia",
      box("mdhd", u32(0), u32(0, 0, timescale, 0)),
      box("hdlr", u32(0, 0), Uint8Array.from("soun".split("").map((c) => c.charCodeAt(0)))),
      box("minf", box("stbl", box("stsd", u32(0), u32(1), mp4a))),
    ),
  );
  return box("moov", box("mvhd", new Uint8Array(100)), trak, box("mvex", box("trex", u32(0), u32(trackId, 1, defaultDuration, defaultSize, 0))));
}

/**
 * A fragment whose `trun` carries explicit per-sample sizes and a data offset
 * measured from the `moof` header — the shape MediaRecorder emits.
 */
function fragment(baseDecodeTime: number, sizes: number[], fill: number): Uint8Array {
  const mdatBody = concat(...sizes.map((n) => new Uint8Array(n).fill(fill)));
  // trun payload: flags+count(8) + data_offset(4) + 2 words per sample.
  const trunSize = 8 + 8 + 4 + sizes.length * 8;
  const trafSize = 8 + (8 + 8) + (8 + 8) + trunSize; // tfhd + tfdt + trun
  const moofSize = 8 + (8 + 8) + trafSize; // mfhd + traf
  // Samples begin right after the mdat header, which follows the whole moof.
  const dataOffset = moofSize + 8;
  const trun = box(
    "trun",
    u32(0x0000_0301), // version 0, flags: data-offset + sample-duration + sample-size
    u32(sizes.length),
    u32(dataOffset),
    ...sizes.map((size) => u32(1024, size)),
  );
  const traf = box(
    "traf",
    box("tfhd", u32(0x0000_0000), u32(1)), // no per-fragment overrides
    box("tfdt", u32(0), u32(baseDecodeTime)),
    trun,
  );
  const moof = box("moof", box("mfhd", u32(0), u32(1)), traf);
  expect(moof.length).toBe(moofSize);
  return concat(moof, box("mdat", mdatBody));
}

describe("parseFragmentedMp4Audio", () => {
  const file = concat(
    box("ftyp", Uint8Array.from("iso5".split("").map((c) => c.charCodeAt(0))), u32(0)),
    moov(),
    fragment(0, [7, 9], 0xaa),
    fragment(2048, [11], 0xbb),
  );

  it("reads the codec description and format out of the sample entry", () => {
    const track = parseFragmentedMp4Audio(file);
    expect(track).not.toBeNull();
    expect(track!.sampleRate).toBe(48000);
    expect(track!.numberOfChannels).toBe(2);
    expect([...track!.description!]).toEqual(ASC);
  });

  it("lands each sample on its own bytes across fragments", () => {
    const { samples } = parseFragmentedMp4Audio(file)!;
    expect(samples.map((s) => s.data.length)).toEqual([7, 9, 11]);
    // Every byte of a sample must come from its own fragment's mdat — the
    // check that actually catches a wrong data-offset base.
    expect(samples.slice(0, 2).every((s) => s.data.every((b) => b === 0xaa))).toBe(true);
    expect(samples[2]!.data.every((b) => b === 0xbb)).toBe(true);
  });

  it("times samples from tfdt at the track timescale", () => {
    const { samples } = parseFragmentedMp4Audio(file)!;
    // 1024 ticks at 48 kHz = 21333 µs; the second fragment resumes at 2048.
    expect(samples.map((s) => s.timestampUs)).toEqual([0, 21333, 42667]);
    expect(samples[0]!.durationUs).toBe(21333);
  });

  it("returns null for bytes that are not a fragmented MP4", () => {
    expect(parseFragmentedMp4Audio(new Uint8Array(64))).toBeNull();
    // A moov with no fragments is a progressive file — understood enough to
    // recognise, deliberately not enough to guess at.
    expect(parseFragmentedMp4Audio(concat(moov()))).toBeNull();
  });
});

/**
 * The progressive reader exists so an export can verify its OWN output — the
 * whole-file sample table `mp4-muxer` writes, walked back. Its four tables only
 * mean anything together, so the test spreads samples across two chunks of
 * different lengths: a reader that ignores `stsc` still passes a single-chunk
 * file and fails this one.
 */
describe("parseProgressiveMp4Audio", () => {
  function stbl(sizes: number[], chunkOffsets: number[], runs: number[][]): Uint8Array {
    const mp4a = box(
      "mp4a",
      new Uint8Array(6),
      u16(1),
      new Uint8Array(8),
      u16(2),
      u16(16),
      u16(0, 0),
      u32(48000 << 16),
      esds(),
    );
    return box(
      "stbl",
      box("stsd", u32(0), u32(1), mp4a),
      box("stts", u32(0), u32(1), u32(sizes.length, 1024)),
      box("stsz", u32(0), u32(0), u32(sizes.length), u32(...sizes)),
      box("stsc", u32(0), u32(runs.length), ...runs.map((r) => u32(...r))),
      box("stco", u32(0), u32(chunkOffsets.length), u32(...chunkOffsets)),
    );
  }

  it("walks the sample tables and lands each sample on its own bytes", () => {
    // Two chunks: the first holds 2 samples, the second holds 1.
    const sizes = [4, 6, 5];
    const head = concat(
      box("ftyp", Uint8Array.from("iso5".split("").map((c) => c.charCodeAt(0))), u32(0)),
    );
    // Build moov first so the mdat offsets can be computed against it.
    const moovBox = (offsets: number[]) =>
      box(
        "moov",
        box(
          "trak",
          box("tkhd", u32(0), u32(0, 0, 1)),
          box(
            "mdia",
            box("mdhd", u32(0), u32(0, 0, 48000, 0)),
            box("hdlr", u32(0, 0), Uint8Array.from("soun".split("").map((c) => c.charCodeAt(0)))),
            box("minf", stbl(sizes, offsets, [[1, 2, 1], [2, 1, 1]])),
          ),
        ),
      );
    const moovLength = moovBox([0, 0]).length;
    const mdatStart = head.length + moovLength + 8;
    const file = concat(
      head,
      moovBox([mdatStart, mdatStart + 10]),
      box(
        "mdat",
        concat(
          new Uint8Array(4).fill(0xa1),
          new Uint8Array(6).fill(0xb2),
          new Uint8Array(5).fill(0xc3),
        ),
      ),
    );

    const track = parseProgressiveMp4Audio(file)!;
    expect(track).not.toBeNull();
    expect(track.sampleRate).toBe(48000);
    expect(track.numberOfChannels).toBe(2);
    expect(track.samples.map((s) => s.data.length)).toEqual(sizes);
    expect(track.samples[0]!.data.every((b) => b === 0xa1)).toBe(true);
    expect(track.samples[1]!.data.every((b) => b === 0xb2)).toBe(true);
    // The third sample lives in the SECOND chunk — only an stsc-aware walk
    // finds it, and a reader that assumed one chunk would read 0xb2 here.
    expect(track.samples[2]!.data.every((b) => b === 0xc3)).toBe(true);
    expect(track.samples.map((s) => s.timestampUs)).toEqual([0, 21333, 42667]);
  });

  it("declines bytes with no sample table rather than guessing", () => {
    expect(parseProgressiveMp4Audio(new Uint8Array(64))).toBeNull();
  });
});
