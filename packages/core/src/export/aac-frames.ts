/**
 * NORMALISE AAC FRAMES BEFORE THEY GO INTO AN MP4.
 *
 * An MP4 audio track stores **raw** AAC frames, and describes them ONCE in the
 * `esds` box at the top of the file. It is the container's job to say where
 * each frame starts, how long it is, and what format they are all in.
 *
 * ADTS is the other way of shipping AAC: a 7-byte header on the front of every
 * frame, repeating the format over and over, so a frame can be understood with
 * no container at all. It is what you want for a radio stream. It is exactly
 * what you must NOT put in an MP4 — the decoder is told by `esds` that the
 * bytes are raw AAC, so it reads the header as audio, and gets nothing. The
 * file is well-formed, every tool reports success, and it plays silent.
 *
 * WebCodecs has a config for this (`AacEncoderConfig.format`, default `"aac"`),
 * and an encoder that honours it needs none of this module. An encoder that
 * does not is indistinguishable from a working one until you listen to the
 * file — so the frames are checked rather than trusted, and a header found is
 * a header removed.
 *
 * The same applies to duration. `EncodedAudioChunk.duration` is nullable, and a
 * muxer handed zero-length samples writes a zero-length track: again silence,
 * again with nothing failing. An AAC-LC frame is always 1024 samples, so the
 * duration is never actually unknown — it just sometimes goes unstated.
 *
 * Pure bytes in, bytes out. No DOM, no codecs, so it runs in a test.
 */

/** Samples per AAC-LC frame. Fixed by the format, so a missing duration is
 *  never unknown — only unstated. */
export const AAC_FRAME_SAMPLES = 1024;

/** The MPEG-4 sampling-frequency table, indexed by an ADTS header's 4-bit field. */
const SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

export interface AacFrame {
  data: Uint8Array;
  /** Presentation time, microseconds. */
  timestampUs: number;
  durationUs: number;
}

export interface NormalizedAac {
  frames: AacFrame[];
  /** AudioSpecificConfig for `esds` — the encoder's, or derived from an ADTS
   *  header when the encoder supplied none. */
  description: Uint8Array | null;
  /** True when ADTS headers were found and stripped — worth reporting, because
   *  it means this engine ignores `AacEncoderConfig.format`. */
  strippedAdts: boolean;
  /** True when durations were missing and had to be derived from the frame size. */
  derivedDurations: boolean;
}

/**
 * Does this frame begin with an ADTS header? The syncword is twelve 1-bits,
 * and layer (bits 2-1 of the second byte) must be 00 for AAC — checking the
 * layer too is what keeps a raw AAC frame that happens to open with 0xFF from
 * being mistaken for one.
 */
export function looksLikeAdts(data: Uint8Array): boolean {
  return (
    data.length >= 7 &&
    data[0] === 0xff &&
    (data[1]! & 0xf0) === 0xf0 &&
    (data[1]! & 0x06) === 0x00
  );
}

/** Header length in bytes: 7, or 9 when the frame carries a CRC. */
function adtsHeaderLength(data: Uint8Array): number {
  return (data[1]! & 0x01) === 0 ? 9 : 7;
}

/**
 * Build an AudioSpecificConfig from an ADTS header — the two bytes `esds`
 * needs, recovered from the header we are about to throw away.
 *
 * ADTS states the profile as `audioObjectType - 1`; everything else transfers
 * directly. Five bits of object type, four of sample-rate index, four of
 * channel configuration, then padding to a byte boundary.
 */
export function audioSpecificConfigFromAdts(data: Uint8Array): Uint8Array | null {
  if (!looksLikeAdts(data)) return null;
  const objectType = ((data[2]! & 0xc0) >> 6) + 1;
  const frequencyIndex = (data[2]! & 0x3c) >> 2;
  const channelConfig = ((data[2]! & 0x01) << 2) | ((data[3]! & 0xc0) >> 6);
  if (frequencyIndex > 12 || channelConfig === 0) return null;
  return Uint8Array.from([
    (objectType << 3) | (frequencyIndex >> 1),
    ((frequencyIndex & 1) << 7) | (channelConfig << 3),
  ]);
}

/** The sample rate an ADTS header declares, or null if it isn't one. */
export function sampleRateFromAdts(data: Uint8Array): number | null {
  if (!looksLikeAdts(data)) return null;
  return SAMPLE_RATES[(data[2]! & 0x3c) >> 2] ?? null;
}

/**
 * Put a stream of encoded AAC chunks into the shape an MP4 muxer requires:
 * raw frames, every one with a real duration, timestamps that run forward.
 *
 * `description` is the encoder's own when it gave one — it is the only thing
 * that knows about SBR/PS, where the declared rate is half the real one — and
 * is otherwise recovered from the first ADTS header.
 *
 * Prefer {@link toMuxableAacTrack}, which applies this AND the rest of the
 * track's invariants. This is exported for the frame-level tests.
 */
export function normalizeAacFrames(
  chunks: Array<{ data: Uint8Array; timestampUs: number; durationUs: number | null }>,
  sampleRate: number,
  encoderDescription: Uint8Array | null,
): NormalizedAac {
  const adts = chunks.length > 0 && looksLikeAdts(chunks[0]!.data);
  const description =
    encoderDescription ?? (adts ? audioSpecificConfigFromAdts(chunks[0]!.data) : null);
  // A frame's duration is fixed by the format. Deriving it is not a guess.
  const frameDurationUs = Math.round((AAC_FRAME_SAMPLES / sampleRate) * 1_000_000);

  let derivedDurations = false;
  let cursorUs = 0;
  const frames: AacFrame[] = [];
  for (const chunk of chunks) {
    let data = chunk.data;
    if (adts && looksLikeAdts(data)) {
      const header = adtsHeaderLength(data);
      if (data.length <= header) continue; // a header with no payload is not a frame
      data = data.subarray(header);
    }
    let durationUs = chunk.durationUs ?? 0;
    if (durationUs <= 0) {
      durationUs = frameDurationUs;
      derivedDurations = true;
    }
    // Timestamps run forward from the encoder's when it states them, and from
    // the accumulated durations when it does not — a track whose samples all
    // start at the same instant has no length, which is its own kind of silent.
    const timestampUs = chunk.timestampUs > 0 || frames.length === 0 ? chunk.timestampUs : cursorUs;
    frames.push({ data, timestampUs, durationUs });
    cursorUs = timestampUs + durationUs;
  }
  return { frames, description, strippedAdts: adts, derivedDurations };
}

/**
 * WHAT THE BITSTREAM SAYS IT IS — read back, not assumed.
 *
 * An MP4's audio sample entry declares a sample rate and a channel count, and
 * a decoder believes it. Those numbers were being taken from what the *encoder
 * was asked for*, which is a different thing from what it produced: an engine
 * is free to return mono when you request stereo, or to encode HE-AAC whose
 * declared rate is half the real one. When the header and the bitstream
 * disagree the decoder does not complain — it produces nothing, or noise, and
 * every tool in the chain still reports success.
 *
 * The AudioSpecificConfig the encoder hands back is the bitstream describing
 * itself, so it is the one true answer. Two bytes, usually.
 */
export interface AudioSpecificConfig {
  /** MPEG-4 audio object type — 2 is AAC-LC, 5 is HE-AAC (SBR), 29 is HE-AACv2. */
  objectType: number;
  sampleRate: number;
  channels: number;
  /** For SBR/PS: the output rate, which is twice the core rate. */
  extensionSampleRate: number | null;
}

/** A forward-only bit reader — an ASC is packed, not byte-aligned. */
function bits(data: Uint8Array) {
  let at = 0;
  return {
    read(count: number): number {
      let value = 0;
      for (let i = 0; i < count; i++) {
        const byte = data[at >> 3];
        if (byte === undefined) return value << (count - i - 1);
        value = (value << 1) | ((byte >> (7 - (at & 7))) & 1);
        at++;
      }
      return value;
    },
    get exhausted() {
      return at >= data.length * 8;
    },
  };
}

export function parseAudioSpecificConfig(data: Uint8Array): AudioSpecificConfig | null {
  if (data.length < 2) return null;
  const reader = bits(data);
  const readObjectType = () => {
    const value = reader.read(5);
    // 31 is the escape into the extended range.
    return value === 31 ? reader.read(6) + 32 : value;
  };
  const readRate = () => {
    const index = reader.read(4);
    return index === 15 ? reader.read(24) : (SAMPLE_RATES[index] ?? 0);
  };

  const objectType = readObjectType();
  const sampleRate = readRate();
  const channels = reader.read(4);
  if (!sampleRate || channels < 1 || channels > 8) return null;

  // HE-AAC states its OUTPUT rate in an extension, and it is the one the
  // container has to declare — a header carrying the core rate plays a
  // spectral-band-replicated stream an octave down and half speed.
  let extensionSampleRate: number | null = null;
  if (objectType === 5 || objectType === 29) {
    extensionSampleRate = readRate() || null;
    readObjectType();
  }
  return { objectType, sampleRate, channels, extensionSampleRate };
}

/** The rate a container should declare for this config. */
export function declaredSampleRate(config: AudioSpecificConfig): number {
  return config.extensionSampleRate ?? config.sampleRate;
}


/**
 * THE ONE DOOR FROM "ENCODED AAC" TO "AN MP4 AUDIO TRACK".
 *
 * This exists because there are two sources of AAC frames in the exporter —
 * the WebCodecs encoder and the frames read back out of a MediaRecorder
 * recording — and only one of them was ever validated. The recorded frames
 * went to the muxer untouched, which is exactly why a defect could exist that
 * could ONLY appear on that route: WebKit's recorder opens its first fragment
 * 64 samples in, an MP4 track must open at zero, and the muxer refused the
 * whole export. One validated path and one raw path is not two features; it is
 * one feature and one bug waiting for someone to pick the wrong branch.
 *
 * So both go through here, and the invariants an MP4 audio track has to satisfy
 * are asserted in one place rather than assumed in several:
 *
 *  - every frame carries bytes (an empty frame is not a frame);
 *  - frames are raw, not ADTS (the container describes them once, itself);
 *  - every frame has a real duration (zero-length samples make a silent track);
 *  - timestamps advance, and START AT ZERO — a property of the TRACK, not of
 *    whichever encoder happened to fill it;
 *  - the rate and channel count come from the bitstream's own config, not from
 *    what the encoder was asked for.
 *
 * Returns null when nothing usable survives, which callers treat as "this
 * source produced no audio" and fall through to the next one.
 */
export interface MuxableAacTrack {
  frames: AacFrame[];
  description: Uint8Array | null;
  sampleRate: number;
  channels: number;
  totalBytes: number;
  /** Corrections applied, in words, for an export report to show. */
  notes: string[];
}

export function toMuxableAacTrack(
  chunks: Array<{ data: Uint8Array; timestampUs: number; durationUs: number | null }>,
  requestedSampleRate: number,
  encoderDescription: Uint8Array | null,
): MuxableAacTrack | null {
  // An empty frame is not a frame. Dropped before anything reads their count,
  // so nothing downstream can mistake "181 frames" for "181 frames of audio".
  const carrying = chunks.filter((c) => c.data.length > 0);
  if (carrying.length === 0) return null;

  const normalized = normalizeAacFrames(carrying, requestedSampleRate, encoderDescription);
  if (normalized.frames.length === 0) return null;

  const notes: string[] = [];
  if (carrying.length !== chunks.length) notes.push(`dropped ${chunks.length - carrying.length} empty frames`);
  if (normalized.strippedAdts) notes.push("stripped ADTS headers");
  if (normalized.derivedDurations) notes.push("derived frame durations");

  // The track opens at zero. A recording that began 64 samples in is stating
  // where the RECORDER started, not a delay in the audio, so re-basing is the
  // correct reading of the frames rather than a nudge to satisfy the muxer.
  const originUs = normalized.frames[0]!.timestampUs;
  const frames =
    originUs === 0
      ? normalized.frames
      : normalized.frames.map((f) => ({ ...f, timestampUs: Math.max(0, f.timestampUs - originUs) }));
  if (originUs !== 0) notes.push(`re-based from ${originUs} µs`);

  // The bitstream describes itself; the request was only ever a request.
  const asc = normalized.description ? parseAudioSpecificConfig(normalized.description) : null;
  const sampleRate = asc ? declaredSampleRate(asc) : requestedSampleRate;
  const channels = asc ? asc.channels : 2;
  if (asc && (sampleRate !== requestedSampleRate || channels !== 2)) {
    notes.push(`encoder gave ${channels}ch @ ${sampleRate} Hz`);
  } else if (!normalized.description) {
    notes.push("no codec config from encoder");
  }

  return {
    frames,
    description: normalized.description,
    sampleRate,
    channels,
    totalBytes: frames.reduce((n, f) => n + f.data.length, 0),
    notes,
  };
}
