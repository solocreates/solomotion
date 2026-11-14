import { SEQUENCE_MIME } from "@solomotion/core";
import { ENGINE } from "@/editor/names";

/**
 * THE IMAGE SEQUENCE FILE — many stills as ONE asset.
 *
 * A sequence is stored as a single blob so it is one asset everywhere that
 * counts: the library shows one item, a project bundle carries one file,
 * storage and collection treat it like any media. Frames keep their ORIGINAL
 * bytes (an imported PNG stays that PNG — nothing is re-encoded), so packing is
 * a copy and reading one frame is a `Blob.slice`: lazy, whatever the length.
 *
 *   "ACRB" · u32 header length · header JSON · frame bytes, back to back
 *
 * The header lists each frame's byte length and type; offsets are running
 * sums. Detected by the magic, never by the blob's type — OPFS hands files
 * back typeless.
 */

const MAGIC = "ACRB";

export interface SequenceHeader {
  v: 1;
  fps: number;
  /** Pixel size of the frames. */
  width: number;
  height: number;
  /** Byte length of each frame, in order. */
  frames: number[];
  /** Each frame's image type; absent = WebP (the first renders wrote none). */
  types?: string[];
}

export interface OpenSequence {
  header: SequenceHeader;
  blob: Blob;
  offsets: number[];
}

export function packSequence(meta: { fps: number; width: number; height: number }, frames: Blob[]): Blob {
  const header: SequenceHeader = {
    v: 1,
    ...meta,
    frames: frames.map((f) => f.size),
    types: frames.map((f) => f.type || "image/png"),
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const head = new Uint8Array(8);
  head.set(new TextEncoder().encode(MAGIC), 0);
  new DataView(head.buffer).setUint32(4, json.length, true);
  return new Blob([head, json, ...frames], { type: SEQUENCE_MIME.of(ENGINE.ns) });
}

export async function isSequenceBlob(blob: Blob): Promise<boolean> {
  if (blob.size < 8) return false;
  return new TextDecoder().decode(await blob.slice(0, 4).arrayBuffer()) === MAGIC;
}

export async function openSequence(blob: Blob): Promise<OpenSequence> {
  const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  if (new TextDecoder().decode(head.subarray(0, 4)) !== MAGIC) throw new Error("not an image sequence");
  const len = new DataView(head.buffer).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(await blob.slice(8, 8 + len).arrayBuffer())) as SequenceHeader;
  const offsets: number[] = [];
  let at = 8 + len;
  for (const n of header.frames) {
    offsets.push(at);
    at += n;
  }
  return { header, blob, offsets };
}

export function sequenceFrameBlob(seq: OpenSequence, i: number): Blob {
  const at = seq.offsets[i]!;
  return seq.blob.slice(at, at + seq.header.frames[i]!, seq.header.types?.[i] ?? "image/webp");
}

/** Read the file back and prove it: frame count, byte layout, first and last decode. */
export async function verifySequence(blob: Blob, expectFrames: number): Promise<boolean> {
  try {
    const seq = await openSequence(blob);
    if (seq.header.frames.length !== expectFrames) return false;
    if (seq.offsets.at(-1)! + seq.header.frames.at(-1)! !== blob.size) return false;
    for (const i of new Set([0, expectFrames - 1])) (await createImageBitmap(sequenceFrameBlob(seq, i))).close();
    return true;
  } catch {
    return false;
  }
}
