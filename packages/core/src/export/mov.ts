/**
 * A QUICKTIME (.mov) MUXER — the container for exports that must not lose a
 * pixel.
 *
 * ## Why this exists
 *
 * An MP4 export is H.264, and H.264 is **4:2:0**: colour stored at half
 * resolution in both directions. Measured on a real project, converting an
 * exported PNG to 4:2:0 and straight back — no encoder, no compression, no
 * browser involved — damages the frame by 0.14% of its pixels with errors up to
 * 82 levels, which is *exactly* what the finished MP4 shows. The encoder, the
 * bitrate, the quantizer and the browser account for the remaining ~2%. Black
 * type on a saturated fill is the worst case there is for it, and it is the
 * whole visual language of motion graphics.
 *
 * So no amount of encoder tuning fixes it, and neither does shipping our own
 * H.264: the loss is the *colour format*, not the codec. What fixes it is not
 * subsampling colour at all — which means a container that can carry frames we
 * already produce perfectly.
 *
 * ## Why a muxer and not an encoder
 *
 * the app already renders every frame to a flawless PNG; the PNG export is the
 * control group that proved the drawing was never the problem. QuickTime can
 * carry PNG frames directly (`png ` in the sample description) and PCM audio
 * beside them, and QuickTime Player, Final Cut, Premiere, After Effects and
 * Resolve all read it. So the "lossless master" is a *packaging* job:
 *
 *   - no video encoder — the frames go in byte-for-byte
 *   - no audio encoder — PCM, so WebKit's broken AAC path is never touched
 *   - nothing platform-specific — identical output on Chrome, Firefox, Safari,
 *     iOS and Windows, because every byte is written here
 *
 * It also carries **alpha** (32-bit PNG frames), which H.264 cannot.
 *
 * ProRes 4444 lands in this same container later: a different sample
 * description and encoded frames instead of PNG ones. Nothing else changes,
 * which is why the container is the part being built first.
 *
 * Pure bytes. No DOM, no WebCodecs, no browser — a test, a worker and the
 * desktop build all mux identically.
 */

/** Where the finished file goes. In-memory today; a file stream later. */
export interface MovTarget {
  write(chunk: Uint8Array): void;
}

/** Collects the whole file in memory. */
export class ArrayBufferMovTarget implements MovTarget {
  private readonly chunks: Uint8Array[] = [];
  private size = 0;
  write(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
  }
  /** The finished file. */
  buffer(): Uint8Array {
    const out = new Uint8Array(this.size);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

export interface MovVideoOptions {
  width: number;
  height: number;
  /**
   * Frames per second. Fractional rates are exact: 29.97 becomes a 30000/1001
   * timescale rather than a rounded 30, so a long export does not drift.
   */
  fps: number;
  /** 32 carries the PNG's alpha channel; 24 is opaque. */
  depth?: 24 | 32;
  /** The compressor name players show (≤ 31 bytes): the app signs its file ("<app> PNG"). */
  compressorName?: string;
}

export interface MovAudioOptions {
  sampleRate: number;
  channels: number;
  /** Signed little-endian PCM — 16-bit ("sowt") or 24-bit ("in24"). */
  bitDepth?: 16 | 24;
}

/**
 * A media timescale that expresses `fps` exactly, plus the per-frame delta.
 *
 * The NTSC rates are not decimals, they are `n x 1000/1001` — so 29.97 becomes
 * 30000/1001 rather than a rounded 30. At 30 a 29.97 export drifts a frame
 * every 33 seconds, which is how a five-minute video ends up out of sync with
 * its own soundtrack.
 */
export function videoTimescale(fps: number): { timescale: number; delta: number } {
  const rate = fps > 0 ? fps : 30;
  const ntsc = Math.round((rate * 1001) / 1000);
  if (ntsc > 0 && Math.abs(rate - (ntsc * 1000) / 1001) < 1e-3) {
    return { timescale: ntsc * 1000, delta: 1001 };
  }
  return { timescale: Math.round(rate * 1000), delta: 1000 };
}

// ── Box plumbing ─────────────────────────────────────────────────────────────

class Writer {
  private readonly parts: number[] = [];
  u8(v: number): this {
    this.parts.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    return this.u8(v >> 8).u8(v);
  }
  i16(v: number): this {
    return this.u16(v < 0 ? v + 0x10000 : v);
  }
  u24(v: number): this {
    return this.u8(v >> 16).u8(v >> 8).u8(v);
  }
  u32(v: number): this {
    return this.u8(v >> 24).u8(v >> 16).u8(v >> 8).u8(v);
  }
  u64(v: number): this {
    return this.u32(Math.floor(v / 2 ** 32)).u32(v >>> 0);
  }
  /** 16.16 fixed point — QuickTime's dimensions, rates and volumes. */
  fixed32(v: number): this {
    return this.u32(Math.round(v * 0x10000));
  }
  /** 8.8 fixed point. */
  fixed16(v: number): this {
    return this.u16(Math.round(v * 0x100));
  }
  ascii(s: string): this {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
    return this;
  }
  bytes(b: Uint8Array | number[]): this {
    for (const v of b) this.u8(v);
    return this;
  }
  zeros(n: number): this {
    for (let i = 0; i < n; i++) this.u8(0);
    return this;
  }
  get length(): number {
    return this.parts.length;
  }
  build(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

/** `[size][type][payload]` — the one shape every box has. */
function box(type: string, ...payload: (Uint8Array | number[])[]): Uint8Array {
  let size = 8;
  for (const p of payload) size += p.length;
  const w = new Writer().u32(size).ascii(type);
  for (const p of payload) w.bytes(p);
  return w.build();
}

/** A box whose first four bytes are version + flags. */
function fullBox(type: string, version: number, flags: number, ...payload: (Uint8Array | number[])[]): Uint8Array {
  return box(type, new Writer().u8(version).u24(flags).build(), ...payload);
}

/** The identity matrix QuickTime writes when nothing is rotated. */
const UNITY_MATRIX = new Writer()
  .fixed32(1).fixed32(0).fixed32(0)
  .fixed32(0).fixed32(1).fixed32(0)
  .u32(0).u32(0).u32(0x40000000)
  .build();

/** Seconds between 1904-01-01 (QuickTime's epoch) and the Unix epoch. */
const QT_EPOCH_OFFSET = 2_082_844_800;

function qtNow(): number {
  return Math.floor(Date.now() / 1000) + QT_EPOCH_OFFSET;
}

interface TrackState {
  /** Byte size of every sample, in order. */
  sizes: number[];
  /** File offset of every sample, in order. */
  offsets: number[];
  /** Per-sample duration in media ticks, run-length encoded on write. */
  deltas: number[];
  timescale: number;
}

/**
 * Muxes PNG video (and optional PCM audio) into a QuickTime file.
 *
 * Samples are handed to `addVideoFrame` / `addAudioSamples` in time order and
 * written to the target as they arrive; `finalize` appends the index. The file
 * is therefore `ftyp` · `mdat` · `moov` — the index at the end, which is what
 * every editor wants and what lets this stream without knowing the length up
 * front. (A "fast start" variant, for a file meant to be played over a network,
 * would move `moov` in front; a master is opened locally, so it does not.)
 */
export class MovMuxer {
  private readonly target: MovTarget;
  private readonly video: Required<MovVideoOptions>;
  private readonly audio: (MovAudioOptions & { bitDepth: 16 | 24 }) | null;
  private readonly videoTrack: TrackState;
  private readonly audioTrack: TrackState;
  private readonly frameDelta: number;
  /** Bytes written so far — every sample offset comes from here. */
  private cursor = 0;
  /** Where the `mdat` size field sits, so it can be corrected at the end. */
  private mdatSizeAt = 0;
  private mdatBytes = 0;
  private finalized = false;

  constructor(target: MovTarget, options: { video: MovVideoOptions; audio?: MovAudioOptions }) {
    this.target = target;
    this.video = {
      width: Math.max(1, Math.round(options.video.width)),
      height: Math.max(1, Math.round(options.video.height)),
      fps: options.video.fps > 0 ? options.video.fps : 30,
      depth: options.video.depth ?? 24,
      compressorName: (options.video.compressorName ?? "PNG").slice(0, 31),
    };
    this.audio = options.audio
      ? { ...options.audio, bitDepth: options.audio.bitDepth ?? 16 }
      : null;
    const { timescale, delta } = videoTimescale(this.video.fps);
    this.frameDelta = delta;
    this.videoTrack = { sizes: [], offsets: [], deltas: [], timescale };
    this.audioTrack = {
      sizes: [],
      offsets: [],
      deltas: [],
      timescale: this.audio?.sampleRate ?? 48000,
    };
    this.writeHeader();
  }

  private emit(chunk: Uint8Array): void {
    this.target.write(chunk);
    this.cursor += chunk.length;
  }

  private writeHeader(): void {
    // 'qt  ' — this is a QuickTime file, not an ISO MP4. The distinction
    // matters: `png ` and `sowt` are QuickTime sample descriptions, and a
    // reader told it is looking at an MP4 is entitled not to know them.
    this.emit(
      box(
        "ftyp",
        new Writer().ascii("qt  ").u32(0x00000200).ascii("qt  ").build(),
      ),
    );
    // A 64-bit `mdat`: `size=1` says "the real size is the largesize below",
    // which is what lets a master run past 4 GB. The largesize is corrected in
    // `finalize`, so a target that cannot seek must buffer (the in-memory one
    // does).
    this.mdatSizeAt = this.cursor + 8;
    this.emit(new Writer().u32(1).ascii("mdat").u64(0).build());
    this.mdatBytes = 16;
  }

  /** One encoded video frame (a whole PNG file), in presentation order. */
  addVideoFrame(data: Uint8Array): void {
    this.assertLive();
    this.videoTrack.offsets.push(this.cursor);
    this.videoTrack.sizes.push(data.length);
    this.videoTrack.deltas.push(this.frameDelta);
    this.emit(data);
    this.mdatBytes += data.length;
  }

  /**
   * Interleaved signed little-endian PCM. Any number of audio frames per call —
   * they are one QuickTime "chunk", which is why the caller should hand over a
   * reasonable block (a second of sound, say) rather than one frame at a time.
   */
  addAudioSamples(pcm: Uint8Array): void {
    this.assertLive();
    if (!this.audio) throw new Error("This MOV has no audio track");
    const frameBytes = this.audio.channels * (this.audio.bitDepth / 8);
    const frames = Math.floor(pcm.length / frameBytes);
    if (frames === 0) return;
    const used = frames * frameBytes;
    this.audioTrack.offsets.push(this.cursor);
    this.audioTrack.sizes.push(used);
    this.audioTrack.deltas.push(frames);
    this.emit(used === pcm.length ? pcm : pcm.subarray(0, used));
    this.mdatBytes += used;
  }

  /** Writes the index and returns the number of bytes in the file. */
  finalize(): number {
    this.assertLive();
    this.finalized = true;
    this.emit(this.moov());
    return this.cursor;
  }

  /**
   * The `mdat` largesize, and where it belongs — an in-memory target patches
   * this itself, and a future file-stream target seeks to it.
   */
  get mdatPatch(): { offset: number; size: number } {
    return { offset: this.mdatSizeAt, size: this.mdatBytes };
  }

  private assertLive(): void {
    if (this.finalized) throw new Error("This MOV has already been finalized");
  }

  // ── The index ──────────────────────────────────────────────────────────────

  private get videoDurationTicks(): number {
    return this.videoTrack.deltas.reduce((a, b) => a + b, 0);
  }

  private get audioDurationTicks(): number {
    return this.audioTrack.deltas.reduce((a, b) => a + b, 0);
  }

  /** Movie timescale: milliseconds. Long enough for any export, exact enough. */
  private static readonly MOVIE_TIMESCALE = 1000;

  private get durationMs(): number {
    const v = (this.videoDurationTicks / this.videoTrack.timescale) * 1000;
    const a = this.audio ? (this.audioDurationTicks / this.audioTrack.timescale) * 1000 : 0;
    return Math.round(Math.max(v, a));
  }

  private moov(): Uint8Array {
    const parts: Uint8Array[] = [this.mvhd()];
    parts.push(this.trak(1, "video"));
    if (this.audio && this.audioTrack.sizes.length > 0) parts.push(this.trak(2, "audio"));
    return box("moov", ...parts);
  }

  private mvhd(): Uint8Array {
    const now = qtNow();
    return fullBox(
      "mvhd",
      0,
      0,
      new Writer()
        .u32(now).u32(now)
        .u32(MovMuxer.MOVIE_TIMESCALE)
        .u32(this.durationMs)
        .fixed32(1) // preferred rate
        .fixed16(1) // preferred volume
        .zeros(10)
        .bytes(UNITY_MATRIX)
        .zeros(24) // pre-defined
        .u32(3) // next track id
        .build(),
    );
  }

  private trak(id: number, kind: "video" | "audio"): Uint8Array {
    const track = kind === "video" ? this.videoTrack : this.audioTrack;
    const durationTicks = kind === "video" ? this.videoDurationTicks : this.audioDurationTicks;
    const durationMs = Math.round((durationTicks / track.timescale) * 1000);
    const now = qtNow();
    // 0x0001 enabled | 0x0002 in movie | 0x0004 in preview | 0x0008 in poster
    const tkhd = fullBox(
      "tkhd",
      0,
      0x0f,
      new Writer()
        .u32(now).u32(now)
        .u32(id)
        .u32(0)
        .u32(durationMs)
        .zeros(8)
        .u16(0) // layer
        .u16(0) // alternate group
        .fixed16(kind === "audio" ? 1 : 0) // volume
        .u16(0)
        .bytes(UNITY_MATRIX)
        .fixed32(kind === "video" ? this.video.width : 0)
        .fixed32(kind === "video" ? this.video.height : 0)
        .build(),
    );

    const mdhd = fullBox(
      "mdhd",
      0,
      0,
      new Writer()
        .u32(now).u32(now)
        .u32(track.timescale)
        .u32(durationTicks)
        .u16(0x55c4) // language: undetermined
        .u16(0)
        .build(),
    );

    const hdlr = fullBox(
      "hdlr",
      0,
      0,
      new Writer()
        .u32(0)
        .ascii(kind === "video" ? "vide" : "soun")
        .zeros(12)
        .ascii(kind === "video" ? "VideoHandler" : "SoundHandler")
        .u8(0)
        .build(),
    );

    const media = kind === "video" ? this.vmhd() : this.smhd();
    const minf = box("minf", media, this.dinf(), this.stbl(kind));
    return box("trak", tkhd, box("mdia", mdhd, hdlr, minf));
  }

  private vmhd(): Uint8Array {
    // flags = 1 (no lean ahead) is what QuickTime writes.
    return fullBox("vmhd", 0, 1, new Writer().u16(0).u16(0).u16(0).u16(0).build());
  }

  private smhd(): Uint8Array {
    return fullBox("smhd", 0, 0, new Writer().u16(0).u16(0).build());
  }

  private dinf(): Uint8Array {
    // One data reference, flagged "the media is in this same file".
    const url = fullBox("url ", 0, 1);
    return box("dinf", fullBox("dref", 0, 0, new Writer().u32(1).build(), url));
  }

  private stbl(kind: "video" | "audio"): Uint8Array {
    const track = kind === "video" ? this.videoTrack : this.audioTrack;
    const stsd = kind === "video" ? this.videoStsd() : this.audioStsd();

    // stts — run-length encoded sample durations.
    const runs: { count: number; delta: number }[] = [];
    for (const d of track.deltas) {
      const last = runs[runs.length - 1];
      if (last && last.delta === d) last.count++;
      else runs.push({ count: 1, delta: d });
    }
    const sttsBody = new Writer().u32(runs.length);
    for (const r of runs) sttsBody.u32(r.count).u32(r.delta);
    const stts = fullBox("stts", 0, 0, sttsBody.build());

    // One sample per chunk: sample sizes and chunk offsets then say everything,
    // and a master is read by editors that seek per frame anyway.
    const stsc = fullBox(
      "stsc",
      0,
      0,
      new Writer().u32(1).u32(1).u32(1).u32(1).build(),
    );

    const stszBody = new Writer().u32(0).u32(track.sizes.length);
    for (const s of track.sizes) stszBody.u32(s);
    const stsz = fullBox("stsz", 0, 0, stszBody.build());

    // co64 unconditionally: a lossless master passes 4 GB sooner than anyone
    // expects, and a 32-bit offset table that silently wraps is a corrupt file.
    const co64Body = new Writer().u32(track.offsets.length);
    for (const o of track.offsets) co64Body.u64(o);
    const co64 = fullBox("co64", 0, 0, co64Body.build());

    return box("stbl", stsd, stts, stsc, stsz, co64);
  }

  /** `png ` — every frame is a complete PNG, so every frame is a sync sample. */
  private videoStsd(): Uint8Array {
    const name = this.video.compressorName;
    const compressor = new Writer().u8(name.length).ascii(name).zeros(31 - name.length).build();
    const entry = box(
      "png ",
      new Writer()
        .zeros(6) // reserved
        .u16(1) // data reference index
        .u16(0) // version
        .u16(0) // revision level
        .u32(0) // vendor
        .u32(0) // temporal quality
        .u32(512) // spatial quality — "normal"
        .u16(this.video.width)
        .u16(this.video.height)
        .fixed32(72) // horizontal resolution
        .fixed32(72) // vertical resolution
        .u32(0) // data size
        .u16(1) // frame count per sample
        .bytes(compressor)
        .u16(this.video.depth)
        .i16(-1) // colour table id: none
        .build(),
    );
    return fullBox("stsd", 0, 0, new Writer().u32(1).build(), entry);
  }

  /** `sowt` / `in24` — signed little-endian PCM, the losslessly obvious choice. */
  private audioStsd(): Uint8Array {
    const a = this.audio!;
    const format = a.bitDepth === 24 ? "in24" : "sowt";
    const entry = box(
      format,
      new Writer()
        .zeros(6)
        .u16(1) // data reference index
        .u16(0) // version
        .u16(0) // revision
        .u32(0) // vendor
        .u16(a.channels)
        .u16(a.bitDepth)
        .u16(0) // compression id
        .u16(0) // packet size
        .fixed32(a.sampleRate)
        .build(),
    );
    return fullBox("stsd", 0, 0, new Writer().u32(1).build(), entry);
  }
}

/**
 * Mux a finished set of PNG frames (and optional PCM) into a QuickTime file.
 *
 * The convenience door for callers that already hold every frame; the streaming
 * path is the muxer itself.
 */
export function muxPngMov(input: {
  video: MovVideoOptions;
  frames: Uint8Array[];
  audio?: MovAudioOptions & { pcm: Uint8Array };
}): Uint8Array {
  const target = new ArrayBufferMovTarget();
  const muxer = new MovMuxer(target, { video: input.video, audio: input.audio });
  for (const f of input.frames) muxer.addVideoFrame(f);
  if (input.audio) muxer.addAudioSamples(input.audio.pcm);
  muxer.finalize();
  return patchMdatSize(target.buffer(), muxer.mdatPatch);
}

/**
 * Write the real `mdat` size into a buffered file.
 *
 * The size cannot be known when the box is opened — that is the point of
 * streaming — so it is written last. A file-backed target seeks; a buffer is
 * patched in place.
 */
export function patchMdatSize(file: Uint8Array, patch: { offset: number; size: number }): Uint8Array {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  view.setUint32(patch.offset, Math.floor(patch.size / 2 ** 32));
  view.setUint32(patch.offset + 4, patch.size >>> 0);
  return file;
}
