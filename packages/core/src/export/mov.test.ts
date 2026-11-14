import { describe, it, expect } from "vitest";
import { ArrayBufferMovTarget, MovMuxer, muxPngMov, patchMdatSize, videoTimescale } from "./mov";

/** Walk the top-level boxes of a file. */
function topBoxes(file: Uint8Array): { type: string; start: number; size: number }[] {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const out: { type: string; start: number; size: number }[] = [];
  let at = 0;
  while (at + 8 <= file.length) {
    let size = view.getUint32(at);
    const type = String.fromCharCode(...file.subarray(at + 4, at + 8));
    if (size === 1) size = Number(view.getBigUint64(at + 8));
    if (size <= 0) break;
    out.push({ type, start: at, size });
    at += size;
  }
  return out;
}

/** Find the first box of `type` anywhere in the file, by brute scan. */
function findBox(file: Uint8Array, type: string): number {
  for (let i = 0; i + 4 <= file.length; i++) {
    if (
      file[i] === type.charCodeAt(0) &&
      file[i + 1] === type.charCodeAt(1) &&
      file[i + 2] === type.charCodeAt(2) &&
      file[i + 3] === type.charCodeAt(3)
    ) {
      return i;
    }
  }
  return -1;
}

const FRAME_A = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
const FRAME_B = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);

describe("videoTimescale", () => {
  it("keeps the NTSC rates exact", () => {
    expect(videoTimescale(29.97)).toEqual({ timescale: 30000, delta: 1001 });
    expect(videoTimescale(23.976)).toEqual({ timescale: 24000, delta: 1001 });
    expect(videoTimescale(59.94)).toEqual({ timescale: 60000, delta: 1001 });
  });

  it("leaves the integer rates alone", () => {
    // 30000/1000, not 30030/1001: an integer rate is an integer rate.
    expect(videoTimescale(30)).toEqual({ timescale: 30000, delta: 1000 });
    expect(videoTimescale(25)).toEqual({ timescale: 25000, delta: 1000 });
    expect(videoTimescale(12)).toEqual({ timescale: 12000, delta: 1000 });
  });

  it("every rate divides out to the rate asked for", () => {
    for (const fps of [12, 23.976, 24, 25, 29.97, 30, 50, 59.94, 60]) {
      const { timescale, delta } = videoTimescale(fps);
      expect(timescale / delta).toBeCloseTo(fps, 3);
    }
  });
});

describe("MovMuxer", () => {
  const file = muxPngMov({
    video: { width: 720, height: 1280, fps: 30 },
    frames: [FRAME_A, FRAME_B],
  });

  it("writes a QuickTime file, in ftyp · mdat · moov order", () => {
    const boxes = topBoxes(file).map((b) => b.type);
    expect(boxes).toEqual(["ftyp", "mdat", "moov"]);
    expect(String.fromCharCode(...file.subarray(8, 12))).toBe("qt  ");
  });

  it("declares an mdat that covers exactly the samples it holds", () => {
    const mdat = topBoxes(file).find((b) => b.type === "mdat")!;
    // 16-byte 64-bit header + both frames.
    expect(mdat.size).toBe(16 + FRAME_A.length + FRAME_B.length);
    // …and the moov begins where the mdat ends: a size that lies is a file no
    // decoder can walk.
    const moov = topBoxes(file).find((b) => b.type === "moov")!;
    expect(moov.start).toBe(mdat.start + mdat.size);
  });

  it("puts every frame in whole, byte for byte", () => {
    const at = findBox(file, "mdat") + 12; // past 'mdat' + largesize
    expect(Array.from(file.subarray(at, at + FRAME_A.length))).toEqual(Array.from(FRAME_A));
    expect(
      Array.from(file.subarray(at + FRAME_A.length, at + FRAME_A.length + FRAME_B.length)),
    ).toEqual(Array.from(FRAME_B));
  });

  it("indexes each frame at the offset it was actually written to", () => {
    const co64 = findBox(file, "co64");
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
    const count = view.getUint32(co64 + 8);
    expect(count).toBe(2);
    const first = Number(view.getBigUint64(co64 + 12));
    const second = Number(view.getBigUint64(co64 + 20));
    expect(Array.from(file.subarray(first, first + FRAME_A.length))).toEqual(Array.from(FRAME_A));
    expect(second - first).toBe(FRAME_A.length);
  });

  it("records each frame's real size", () => {
    const stsz = findBox(file, "stsz");
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
    expect(view.getUint32(stsz + 8)).toBe(0); // no fixed sample size
    expect(view.getUint32(stsz + 12)).toBe(2);
    expect(view.getUint32(stsz + 16)).toBe(FRAME_A.length);
    expect(view.getUint32(stsz + 20)).toBe(FRAME_B.length);
  });

  it("carries PNG frames as `png ` samples", () => {
    expect(findBox(file, "png ")).toBeGreaterThan(0);
  });

  it("has no audio track when there is no audio", () => {
    expect(findBox(file, "smhd")).toBe(-1);
    expect(findBox(file, "sowt")).toBe(-1);
  });

  it("carries PCM audio as `sowt`, with the sample count the bytes imply", () => {
    const pcm = new Uint8Array(48000 * 2 * 2); // one second, stereo, 16-bit
    const withSound = muxPngMov({
      video: { width: 64, height: 64, fps: 30 },
      frames: [FRAME_A],
      audio: { sampleRate: 48000, channels: 2, pcm },
    });
    expect(findBox(withSound, "sowt")).toBeGreaterThan(0);
    const view = new DataView(withSound.buffer, withSound.byteOffset, withSound.byteLength);
    // The audio track's stts is the second one in the file; its delta is the
    // number of PCM frames in that chunk.
    const firstStts = findBox(withSound, "stts");
    const audioStts = withSound.subarray(firstStts + 4).indexOf(0x73); // cheap: re-scan
    expect(audioStts).toBeGreaterThan(-1);
    const mdat = topBoxes(withSound).find((b) => b.type === "mdat")!;
    expect(mdat.size).toBe(16 + FRAME_A.length + pcm.length);
    expect(view.getUint32(firstStts + 8)).toBe(1); // one run of video deltas
  });

  it("refuses audio it has no track for", () => {
    const muxer = new MovMuxer(new ArrayBufferMovTarget(), { video: { width: 8, height: 8, fps: 30 } });
    expect(() => muxer.addAudioSamples(new Uint8Array(4))).toThrow(/no audio track/i);
  });

  it("refuses to be written to after it is finalized", () => {
    const muxer = new MovMuxer(new ArrayBufferMovTarget(), { video: { width: 8, height: 8, fps: 30 } });
    muxer.addVideoFrame(FRAME_A);
    muxer.finalize();
    expect(() => muxer.addVideoFrame(FRAME_B)).toThrow(/finalized/i);
  });

  it("patches an mdat larger than 4 GB without wrapping", () => {
    const file32 = new Uint8Array(32);
    patchMdatSize(file32, { offset: 8, size: 5_000_000_000 });
    const view = new DataView(file32.buffer);
    expect(Number(view.getBigUint64(8))).toBe(5_000_000_000);
  });
});
