/**
 * READ THE AUDIO SAMPLES BACK OUT OF AN MP4 THE PLATFORM ENCODED FOR US.
 *
 * WHY THIS EXISTS
 *
 * The MP4 exporter needs AAC frames to hand the muxer. On every desktop engine
 * `AudioEncoder` (WebCodecs) produces them. On iPhone and iPad it does not
 * exist: Safari shipped the WebCodecs *video* interfaces in 16.4 and left
 * `AudioEncoder` undefined until Safari 26, so every phone and tablet running
 * anything older reached the audio step, found no encoder, and exported a
 * silent file. Not an error — silence, which is the worst possible failure for
 * an export because you only discover it after you have shared the video.
 *
 * But those devices are not missing an AAC encoder. They are missing a
 * *WebCodecs* one. `MediaRecorder` has encoded AAC on iOS since 14.3. So the
 * mix is recorded to an `audio/mp4` blob through MediaRecorder, and this
 * module opens that blob and lifts the AAC frames back out — the same frames,
 * addressed as samples instead of as a file — so they can be muxed into the
 * real export beside the frame-accurate video track.
 *
 * WHAT IT PARSES
 *
 * FRAGMENTED MP4 only (`moov` + repeating `moof`/`mdat`), which is what a
 * MediaRecorder necessarily writes: it emits the file as it records, so it
 * cannot go back and fill in a whole-file sample table. A progressive MP4
 * returns null rather than being half-understood — the caller has a fallback,
 * and a wrong answer here would ship as noise.
 *
 * Pure bytes in, samples out: no DOM, no codecs, so it runs in a test.
 */

/** One encoded audio frame, addressed the way `Muxer.addAudioChunkRaw` wants. */
export interface Mp4AudioSample {
  data: Uint8Array;
  /** Presentation time from the start of the track, microseconds. */
  timestampUs: number;
  durationUs: number;
}

export interface Mp4AudioTrack {
  /**
   * The AudioSpecificConfig from `esds` — what a WebCodecs
   * `decoderConfig.description` carries. The muxer can synthesise one from the
   * rate and channel count, but the encoder's own is the truth (it is the only
   * thing that knows about SBR/PS, where the declared rate is half the real
   * one), so it is passed through when present.
   */
  description: Uint8Array | null;
  sampleRate: number;
  numberOfChannels: number;
  samples: Mp4AudioSample[];
}

interface BoxRange {
  type: string;
  /** First byte of the box's payload (after size + type + any largesize). */
  start: number;
  /** One past the last byte of the payload. */
  end: number;
  /** First byte of the box HEADER — fragment offsets are relative to this. */
  boxStart: number;
}

/**
 * Walk the boxes laid out in [start, end). Stops on the first malformed
 * header rather than guessing, because past a bad length every subsequent
 * "box" is noise that happens to parse.
 */
function boxes(view: DataView, start: number, end: number): BoxRange[] {
  const out: BoxRange[] = [];
  let at = start;
  while (at + 8 <= end) {
    let size = view.getUint32(at);
    const type = fourCC(view, at + 4);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) break;
      // 64-bit size. Beyond 2^53 nothing here can address it anyway.
      const hi = view.getUint32(at + 8);
      const lo = view.getUint32(at + 12);
      size = hi * 0x1_0000_0000 + lo;
      header = 16;
    } else if (size === 0) {
      size = end - at; // "to the end of the enclosing box"
    }
    if (size < header || at + size > end) break;
    out.push({ type, start: at + header, end: at + size, boxStart: at });
    at += size;
  }
  return out;
}

function fourCC(view: DataView, at: number): string {
  return (
    String.fromCharCode(view.getUint8(at)) +
    String.fromCharCode(view.getUint8(at + 1)) +
    String.fromCharCode(view.getUint8(at + 2)) +
    String.fromCharCode(view.getUint8(at + 3))
  );
}

function child(view: DataView, parent: BoxRange, type: string): BoxRange | null {
  return boxes(view, parent.start, parent.end).find((b) => b.type === type) ?? null;
}

/** Descend a path of four-CCs, e.g. `mdia/minf/stbl`. */
function descend(view: DataView, from: BoxRange, path: string[]): BoxRange | null {
  let at: BoxRange | null = from;
  for (const step of path) {
    if (!at) return null;
    at = child(view, at, step);
  }
  return at;
}

/**
 * The `mp4a` sample entry: a fixed 28-byte preamble (the generic
 * SampleEntry's 6 reserved bytes + data-reference index, then the v0 sound
 * fields) followed by child boxes, of which `esds` is the one that matters.
 */
function readMp4a(view: DataView, entry: BoxRange): Pick<Mp4AudioTrack, "description" | "sampleRate" | "numberOfChannels"> | null {
  if (entry.end - entry.start < 28) return null;
  const numberOfChannels = view.getUint16(entry.start + 16);
  // 16.16 fixed point; the integer half is the rate for everything we record.
  const sampleRate = view.getUint16(entry.start + 24);
  const esds = boxes(view, entry.start + 28, entry.end).find((b) => b.type === "esds");
  return {
    description: esds ? readAudioSpecificConfig(view, esds) : null,
    sampleRate,
    numberOfChannels,
  };
}

/**
 * Pull the DecoderSpecificInfo (tag 0x05) out of an `esds`. The descriptors
 * nest ES → DecoderConfig → DecoderSpecificInfo with variable-length sizes, and
 * the ES descriptor's optional fields shift everything after them, so this
 * walks the chain rather than indexing at a constant.
 */
function readAudioSpecificConfig(view: DataView, esds: BoxRange): Uint8Array | null {
  let at = esds.start + 4; // FullBox version + flags
  const readLength = (): number => {
    let value = 0;
    for (let i = 0; i < 4 && at < esds.end; i++) {
      const byte = view.getUint8(at++);
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  if (at >= esds.end || view.getUint8(at++) !== 0x03) return null;
  readLength();
  at += 2; // ES_ID
  const flags = view.getUint8(at++);
  if (flags & 0x80) at += 2; // dependsOn_ES_ID
  if (flags & 0x40) at += 1 + view.getUint8(at); // URL
  if (flags & 0x20) at += 2; // OCR_ES_ID
  if (at >= esds.end || view.getUint8(at++) !== 0x04) return null;
  readLength();
  at += 13; // objectTypeIndication, streamType, bufferSizeDB, max/avg bitrate
  if (at >= esds.end || view.getUint8(at++) !== 0x05) return null;
  const length = readLength();
  if (length <= 0 || at + length > esds.end) return null;
  return new Uint8Array(view.buffer, view.byteOffset + at, length);
}

/** `mdhd` timescale — ticks per second for this track's sample times. */
function readTimescale(view: DataView, mdhd: BoxRange): number {
  const version = view.getUint8(mdhd.start);
  const at = mdhd.start + 4 + (version === 1 ? 16 : 8);
  return at + 4 <= mdhd.end ? view.getUint32(at) : 0;
}

interface TrackDefaults {
  sampleDuration: number;
  sampleSize: number;
}

/**
 * Lift the AAC frames out of a fragmented MP4. Returns null when the bytes are
 * not a fragmented MP4 with one sound track, when the codec is not one the
 * caller asked for, or when any structural field is missing — the caller falls
 * back rather than muxing a track it does not understand.
 */
export function parseFragmentedMp4Audio(bytes: Uint8Array): Mp4AudioTrack | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const top = boxes(view, 0, bytes.byteLength);
  const moov = top.find((b) => b.type === "moov");
  if (!moov) return null;

  // The sound track. An audio-only recording has exactly one, but check the
  // handler rather than assuming — the same parser should hold if a future
  // caller records A+V.
  let trackId = 0;
  let timescale = 0;
  let format: ReturnType<typeof readMp4a> = null;
  for (const trak of boxes(view, moov.start, moov.end).filter((b) => b.type === "trak")) {
    const mdia = child(view, trak, "mdia");
    const hdlr = mdia && child(view, mdia, "hdlr");
    if (!mdia || !hdlr || fourCC(view, hdlr.start + 8) !== "soun") continue;
    const stsd = descend(view, mdia, ["minf", "stbl", "stsd"]);
    const mdhd = child(view, mdia, "mdhd");
    const tkhd = child(view, trak, "tkhd");
    if (!stsd || !mdhd || !tkhd) continue;
    // stsd: FullBox + entry_count, then the sample entries.
    const entry = boxes(view, stsd.start + 8, stsd.end)[0];
    if (!entry || (entry.type !== "mp4a" && entry.type !== "enca")) continue;
    format = readMp4a(view, entry);
    timescale = readTimescale(view, mdhd);
    const tkhdVersion = view.getUint8(tkhd.start);
    trackId = view.getUint32(tkhd.start + 4 + (tkhdVersion === 1 ? 16 : 8));
    break;
  }
  if (!format || !timescale || !trackId) return null;

  // `trex` carries the defaults a `tfhd` may lean on instead of repeating.
  const defaults: TrackDefaults = { sampleDuration: 0, sampleSize: 0 };
  const mvex = child(view, moov, "mvex");
  for (const trex of mvex ? boxes(view, mvex.start, mvex.end).filter((b) => b.type === "trex") : []) {
    if (view.getUint32(trex.start + 4) !== trackId) continue;
    defaults.sampleDuration = view.getUint32(trex.start + 12);
    defaults.sampleSize = view.getUint32(trex.start + 16);
  }

  const samples: Mp4AudioSample[] = [];
  const toUs = (ticks: number) => Math.round((ticks / timescale) * 1_000_000);
  let decodeTime = 0;
  for (const moof of top.filter((b) => b.type === "moof")) {
    for (const traf of boxes(view, moof.start, moof.end).filter((b) => b.type === "traf")) {
      const read = readTraf(view, traf, moof, trackId, defaults, decodeTime, bytes.byteLength);
      if (!read) continue;
      decodeTime = read.decodeTime;
      for (const s of read.samples) {
        samples.push({
          data: bytes.subarray(s.offset, s.offset + s.size),
          timestampUs: toUs(s.time),
          durationUs: toUs(s.duration),
        });
      }
    }
  }
  return samples.length > 0 ? { ...format, samples } : null;
}

interface RawSample {
  offset: number;
  size: number;
  time: number;
  duration: number;
}

/**
 * One track fragment: `tfhd` says which track and what the per-sample defaults
 * are, `tfdt` says where in the timeline it resumes, and `trun` lists the
 * samples. Byte offsets are relative to the `moof` header unless the fragment
 * declares an absolute base, which is the one place this is easy to get subtly
 * wrong — an off-by-one base shifts every frame and the file decodes as noise.
 */
function readTraf(
  view: DataView,
  traf: BoxRange,
  moof: BoxRange,
  trackId: number,
  defaults: TrackDefaults,
  decodeTimeIn: number,
  fileEnd: number,
): { samples: RawSample[]; decodeTime: number } | null {
  const tfhd = child(view, traf, "tfhd");
  if (!tfhd || view.getUint32(tfhd.start + 4) !== trackId) return null;
  const tfhdFlags = view.getUint32(tfhd.start) & 0x00ff_ffff;
  let at = tfhd.start + 8;
  let base = moof.boxStart; // default-base-is-moof, and the spec's own default
  if (tfhdFlags & 0x01) {
    const hi = view.getUint32(at);
    base = hi * 0x1_0000_0000 + view.getUint32(at + 4);
    at += 8;
  }
  if (tfhdFlags & 0x02) at += 4; // sample_description_index
  let defaultDuration = defaults.sampleDuration;
  if (tfhdFlags & 0x08) {
    defaultDuration = view.getUint32(at);
    at += 4;
  }
  let defaultSize = defaults.sampleSize;
  if (tfhdFlags & 0x10) {
    defaultSize = view.getUint32(at);
    at += 4;
  }

  let decodeTime = decodeTimeIn;
  const tfdt = child(view, traf, "tfdt");
  if (tfdt) {
    const version = view.getUint8(tfdt.start);
    decodeTime =
      version === 1
        ? view.getUint32(tfdt.start + 4) * 0x1_0000_0000 + view.getUint32(tfdt.start + 8)
        : view.getUint32(tfdt.start + 4);
  }

  const samples: RawSample[] = [];
  for (const trun of boxes(view, traf.start, traf.end).filter((b) => b.type === "trun")) {
    const flags = view.getUint32(trun.start) & 0x00ff_ffff;
    const count = view.getUint32(trun.start + 4);
    let cursor = trun.start + 8;
    let offset = base;
    if (flags & 0x01) {
      offset = base + view.getInt32(cursor);
      cursor += 4;
    }
    if (flags & 0x04) cursor += 4; // first_sample_flags
    for (let i = 0; i < count; i++) {
      let duration = defaultDuration;
      let size = defaultSize;
      if (flags & 0x100) {
        duration = view.getUint32(cursor);
        cursor += 4;
      }
      if (flags & 0x200) {
        size = view.getUint32(cursor);
        cursor += 4;
      }
      if (flags & 0x400) cursor += 4; // sample_flags
      if (flags & 0x800) cursor += 4; // composition time offset
      if (cursor > trun.end || size <= 0 || offset + size > fileEnd) return null;
      samples.push({ offset, size, time: decodeTime, duration });
      offset += size;
      decodeTime += duration;
    }
  }
  return { samples, decodeTime };
}

// ── Progressive MP4 (a whole-file sample table) ──────────────────────────────
//
// The fragmented reader above exists to lift AAC out of a MediaRecorder
// recording. This one exists for the opposite direction: reading back the file
// the EXPORTER just wrote, so an export can verify its own audio survived the
// mux instead of hoping it did.
//
// That check had been delegated to `decodeAudioData`, which some engines simply
// refuse for a container holding video — so on the device where the answer
// mattered most, the answer was "could not be verified". A reader of our own
// does not get to refuse.
//
// A progressive file describes its samples with four tables that have to be
// walked together: sizes (`stsz`), how many samples sit in each chunk (`stsc`),
// where each chunk begins (`stco`/`co64`), and how long each sample runs
// (`stts`). None of them means anything alone.

/** One entry of a run-length coded table. */
function readTable(view: DataView, box: BoxRange, wordsPerEntry: number): number[][] {
  const count = view.getUint32(box.start + 4);
  const rows: number[][] = [];
  let at = box.start + 8;
  for (let i = 0; i < count; i++) {
    const row: number[] = [];
    for (let w = 0; w < wordsPerEntry; w++) {
      if (at + 4 > box.end) return rows;
      row.push(view.getUint32(at));
      at += 4;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Lift the audio samples out of a progressive MP4 — the shape `mp4-muxer`
 * writes with `fastStart: "in-memory"`. Returns null when the file is not one,
 * or has no sound track, or any table is missing: a reader that guesses is
 * worse than one that declines.
 */
export function parseProgressiveMp4Audio(bytes: Uint8Array): Mp4AudioTrack | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const moov = boxes(view, 0, bytes.byteLength).find((b) => b.type === "moov");
  if (!moov) return null;

  for (const trak of boxes(view, moov.start, moov.end).filter((b) => b.type === "trak")) {
    const mdia = child(view, trak, "mdia");
    const hdlr = mdia && child(view, mdia, "hdlr");
    if (!mdia || !hdlr || fourCC(view, hdlr.start + 8) !== "soun") continue;
    const stbl = descend(view, mdia, ["minf", "stbl"]);
    const mdhd = child(view, mdia, "mdhd");
    if (!stbl || !mdhd) continue;

    const stsd = child(view, stbl, "stsd");
    const entry = stsd && boxes(view, stsd.start + 8, stsd.end)[0];
    if (!entry || (entry.type !== "mp4a" && entry.type !== "enca")) continue;
    const format = readMp4a(view, entry);
    const timescale = readTimescale(view, mdhd);
    if (!format || !timescale) continue;

    const stsz = child(view, stbl, "stsz");
    const stsc = child(view, stbl, "stsc");
    const stts = child(view, stbl, "stts");
    const stco = child(view, stbl, "stco") ?? child(view, stbl, "co64");
    if (!stsz || !stsc || !stts || !stco) continue;

    // stsz: a single size for every sample, or one per sample.
    const uniformSize = view.getUint32(stsz.start + 4);
    const sampleCount = view.getUint32(stsz.start + 8);
    const sizes: number[] = [];
    for (let i = 0; i < sampleCount; i++) {
      const at = stsz.start + 12 + i * 4;
      sizes.push(uniformSize || (at + 4 <= stsz.end ? view.getUint32(at) : 0));
    }

    const wide = stco.type === "co64";
    const chunkCount = view.getUint32(stco.start + 4);
    const chunkOffsets: number[] = [];
    for (let i = 0; i < chunkCount; i++) {
      const at = stco.start + 8 + i * (wide ? 8 : 4);
      chunkOffsets.push(
        wide ? view.getUint32(at) * 0x1_0000_0000 + view.getUint32(at + 4) : view.getUint32(at),
      );
    }

    // stsc is run-length: "from chunk N onward, each chunk holds K samples".
    const runs = readTable(view, stsc, 3); // [firstChunk, samplesPerChunk, descIndex]
    const perChunk: number[] = [];
    for (let i = 0; i < runs.length; i++) {
      const [first, samples] = runs[i]!;
      const next = runs[i + 1]?.[0] ?? chunkCount + 1;
      for (let c = first!; c < next; c++) perChunk[c - 1] = samples!;
    }

    // stts is run-length too: "the next N samples each last D ticks".
    const durations: number[] = [];
    for (const [count, delta] of readTable(view, stts, 2)) {
      for (let i = 0; i < count!; i++) durations.push(delta!);
    }

    const samples: Mp4AudioSample[] = [];
    const toUs = (ticks: number) => Math.round((ticks / timescale) * 1_000_000);
    let index = 0;
    let ticks = 0;
    for (let c = 0; c < chunkCount && index < sampleCount; c++) {
      let offset = chunkOffsets[c] ?? 0;
      for (let n = 0; n < (perChunk[c] ?? 0) && index < sampleCount; n++, index++) {
        const size = sizes[index] ?? 0;
        if (size <= 0 || offset + size > bytes.byteLength) return null;
        const duration = durations[index] ?? durations[durations.length - 1] ?? 0;
        samples.push({
          data: bytes.subarray(offset, offset + size),
          timestampUs: toUs(ticks),
          durationUs: toUs(duration),
        });
        offset += size;
        ticks += duration;
      }
    }
    return samples.length > 0 ? { ...format, samples } : null;
  }
  return null;
}
