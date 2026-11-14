/**
 * WRITE THE COLOUR SPACE WHERE DECODERS ACTUALLY LOOK — into the H.264
 * bitstream, not only into the MP4 box beside it.
 *
 * ## The bug this exists for
 *
 * An exported MP4 came back with its pinks and reds visibly off — darker,
 * shifted towards orange — while the PNG of the same frame, and the WebM of the
 * same timeline, were right. The pixels were not the problem: decoded with the
 * colour space the file declares, an exported frame matches the PNG to within
 * one level per channel. The problem is that only ONE of the two places a file
 * can declare it was filled in.
 *
 * WebCodecs hands back `decoderConfig.colorSpace` and `mp4-muxer` turns that
 * into the container's `colr` box — so an MP4 player that reads the container
 * is fine (Chrome is). But the H.264 elementary stream inside carries its own
 * copy of the same fact, in the SPS's VUI, and the browser encoders leave it
 * blank: strip the container and `ffprobe` says `color_space=unknown`.
 *
 * A decoder that trusts the bitstream over the container then has to *guess*,
 * and the near-universal guess is by picture size: SD → BT.601, HD → BT.709.
 * Every vertical export (1080×1920, 720×1280) is on the wrong side of that
 * line, and BT.601 maths applied to BT.709 pixels is exactly the hue and
 * saturation shift that was reported — a #FF4E6A pink arrives as #EE3768.
 *
 * So a "correct" file was still a file whose colours depended on which layer
 * the reader happened to trust. This makes the two layers agree.
 *
 * ## The rule
 *
 * It only ever restates what the encoder itself reported. When the browser
 * gives no `colorSpace` there is nothing to restate, and inventing a value in
 * the bitstream would be worse than the silence it replaces — so the bytes are
 * returned untouched. It also verifies its own work: the patched SPS is parsed
 * back, and unless every field reads exactly as written (and the geometry is
 * unchanged) the ORIGINAL bytes are returned. A wrong patch here is an
 * unplayable file, so "no change" is always the safe answer.
 *
 * Pure bytes, no WebCodecs types, no DOM: the browser exporter, a worker and a
 * future desktop path all patch identically.
 */

/** The colour space of an encoded stream — WebCodecs' `VideoColorSpace`, as data. */
export interface AvcColourSpace {
  primaries?: string | null;
  transfer?: string | null;
  matrix?: string | null;
  fullRange?: boolean | null;
}

/** The three code points an SPS carries, plus the range flag. */
export interface AvcColourCodes {
  primaries: number;
  transfer: number;
  matrix: number;
  fullRange: boolean;
}

// ITU-T H.273 code points. Only the values WebCodecs can name are listed; an
// unknown name resolves to 2 ("unspecified"), which is what the SPS already
// says, so it is never worth writing on its own.
const PRIMARIES: Record<string, number> = { bt709: 1, bt470bg: 5, smpte170m: 6 };
const TRANSFER: Record<string, number> = {
  bt709: 1,
  smpte170m: 6,
  "iec61966-2-1": 13,
  linear: 8,
  pq: 16,
  hlg: 18,
};
const MATRIX: Record<string, number> = { rgb: 0, bt709: 1, bt470bg: 5, smpte170m: 6, "bt2020-ncl": 9 };

const UNSPECIFIED = 2;

/** The codes for a reported colour space — null when it says nothing useful. */
export function avcColourCodes(cs: AvcColourSpace | null | undefined): AvcColourCodes | null {
  if (!cs) return null;
  const primaries = cs.primaries ? (PRIMARIES[cs.primaries] ?? UNSPECIFIED) : UNSPECIFIED;
  const transfer = cs.transfer ? (TRANSFER[cs.transfer] ?? UNSPECIFIED) : UNSPECIFIED;
  const matrix = cs.matrix ? (MATRIX[cs.matrix] ?? UNSPECIFIED) : UNSPECIFIED;
  // Nothing identifiable and no range claim: there is no fact to write down.
  if (primaries === UNSPECIFIED && transfer === UNSPECIFIED && matrix === UNSPECIFIED && cs.fullRange == null) {
    return null;
  }
  return { primaries, transfer, matrix, fullRange: cs.fullRange === true };
}

// ── Bit plumbing ──────────────────────────────────────────────────────────────

class BitReader {
  private pos = 0;
  constructor(private readonly bytes: Uint8Array) {}
  get bitPos(): number {
    return this.pos;
  }
  get bitLength(): number {
    return this.bytes.length * 8;
  }
  u1(): number {
    if (this.pos >= this.bitLength) throw new Error("SPS ended early");
    const byte = this.bytes[this.pos >> 3]!;
    const bit = (byte >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return bit;
  }
  u(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.u1();
    return v >>> 0;
  }
  /** Exp-Golomb, unsigned. */
  ue(): number {
    let zeros = 0;
    while (this.u1() === 0) {
      zeros++;
      if (zeros > 32) throw new Error("SPS exp-golomb overrun");
    }
    return zeros === 0 ? 0 : (1 << zeros) - 1 + this.u(zeros);
  }
  /** Exp-Golomb, signed. */
  se(): number {
    const k = this.ue();
    return k % 2 === 0 ? -(k / 2) : (k + 1) / 2;
  }
}

class BitWriter {
  private readonly bits: number[] = [];
  u1(bit: number): void {
    this.bits.push(bit & 1);
  }
  u(value: number, n: number): void {
    for (let i = n - 1; i >= 0; i--) this.u1((value >> i) & 1);
  }
  /** Copy `count` bits straight out of a reader — the parts we do not touch. */
  copy(reader: BitReader, count: number): void {
    for (let i = 0; i < count; i++) this.u1(reader.u1());
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    for (let i = 0; i < this.bits.length; i++) {
      if (this.bits[i]) out[i >> 3]! |= 1 << (7 - (i & 7));
    }
    return out;
  }
}

/** RBSP: the NAL payload with its emulation-prevention `0x03` bytes removed. */
function toRbsp(nal: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 0x03 && nal[i - 1] === 0x00 && nal[i - 2] === 0x00 && (nal[i + 1] ?? 0) <= 0x03) {
      continue;
    }
    out.push(nal[i]!);
  }
  return Uint8Array.from(out);
}

/** The inverse: a payload safe to put back in a NAL. */
function toNalPayload(rbsp: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (const b of rbsp) {
    if (zeros >= 2 && b <= 0x03) {
      out.push(0x03);
      zeros = 0;
    }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

// ── The SPS ───────────────────────────────────────────────────────────────────

/** Profiles whose SPS carries the chroma/bit-depth/scaling-list block. */
const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

function skipScalingList(r: BitReader, size: number): void {
  let lastScale = 8;
  let nextScale = 8;
  for (let i = 0; i < size; i++) {
    if (nextScale !== 0) {
      const delta = r.se();
      nextScale = (lastScale + delta + 256) % 256;
    }
    lastScale = nextScale === 0 ? lastScale : nextScale;
  }
}

/** Everything the SPS says before its VUI — the part we copy through verbatim. */
interface SpsHead {
  profile: number;
  level: number;
  widthMbs: number;
  heightMapUnits: number;
  /** Bit offset of `vui_parameters_present_flag`. */
  vuiFlagBit: number;
}

function readSpsHead(r: BitReader): SpsHead {
  const profile = r.u(8);
  r.u(8); // constraint flags + reserved
  const level = r.u(8);
  r.ue(); // seq_parameter_set_id
  if (HIGH_PROFILES.has(profile)) {
    const chromaFormat = r.ue();
    if (chromaFormat === 3) r.u1(); // separate_colour_plane_flag
    r.ue(); // bit_depth_luma_minus8
    r.ue(); // bit_depth_chroma_minus8
    r.u1(); // qpprime_y_zero_transform_bypass_flag
    if (r.u1() === 1) {
      const lists = chromaFormat === 3 ? 12 : 8;
      for (let i = 0; i < lists; i++) {
        if (r.u1() === 1) skipScalingList(r, i < 6 ? 16 : 64);
      }
    }
  }
  r.ue(); // log2_max_frame_num_minus4
  const pocType = r.ue();
  if (pocType === 0) {
    r.ue(); // log2_max_pic_order_cnt_lsb_minus4
  } else if (pocType === 1) {
    r.u1(); // delta_pic_order_always_zero_flag
    r.se(); // offset_for_non_ref_pic
    r.se(); // offset_for_top_to_bottom_field
    const cycle = r.ue();
    for (let i = 0; i < cycle; i++) r.se();
  }
  r.ue(); // max_num_ref_frames
  r.u1(); // gaps_in_frame_num_value_allowed_flag
  const widthMbs = r.ue();
  const heightMapUnits = r.ue();
  const frameMbsOnly = r.u1();
  if (frameMbsOnly === 0) r.u1(); // mb_adaptive_frame_field_flag
  r.u1(); // direct_8x8_inference_flag
  if (r.u1() === 1) {
    r.ue(); // frame_crop_left_offset
    r.ue(); // frame_crop_right_offset
    r.ue(); // frame_crop_top_offset
    r.ue(); // frame_crop_bottom_offset
  }
  return { profile, level, widthMbs, heightMapUnits, vuiFlagBit: r.bitPos };
}

/**
 * The colour description an SPS already carries — null when it has none.
 * Used to verify a patch, and to leave an already-tagged stream alone.
 */
export function readSpsColour(sps: Uint8Array): AvcColourCodes | null {
  try {
    const rbsp = toRbsp(sps.subarray(1));
    const r = new BitReader(rbsp);
    readSpsHead(r);
    if (r.u1() === 0) return null; // no VUI
    if (r.u1() === 1) {
      // aspect_ratio_info_present_flag
      const idc = r.u(8);
      if (idc === 255) {
        r.u(16);
        r.u(16);
      }
    }
    if (r.u1() === 1) r.u1(); // overscan
    if (r.u1() === 0) return null; // video_signal_type_present_flag
    r.u(3); // video_format
    const fullRange = r.u1() === 1;
    if (r.u1() === 0) return null; // colour_description_present_flag
    return { primaries: r.u(8), transfer: r.u(8), matrix: r.u(8), fullRange };
  } catch {
    return null;
  }
}

/**
 * One SPS with `colour` written into its VUI. Returns the input untouched when
 * it cannot be parsed, patched and read back exactly as written.
 */
export function patchSpsColour(sps: Uint8Array, colour: AvcColourCodes): Uint8Array {
  let patched: Uint8Array;
  try {
    patched = rewriteSps(sps, colour);
  } catch {
    return sps;
  }
  // Verify, always. The only thing worse than an untagged file is a corrupt one.
  const back = readSpsColour(patched);
  if (
    !back ||
    back.primaries !== colour.primaries ||
    back.transfer !== colour.transfer ||
    back.matrix !== colour.matrix ||
    back.fullRange !== colour.fullRange
  ) {
    return sps;
  }
  try {
    const before = readSpsHead(new BitReader(toRbsp(sps.subarray(1))));
    const after = readSpsHead(new BitReader(toRbsp(patched.subarray(1))));
    if (
      before.profile !== after.profile ||
      before.level !== after.level ||
      before.widthMbs !== after.widthMbs ||
      before.heightMapUnits !== after.heightMapUnits
    ) {
      return sps;
    }
  } catch {
    return sps;
  }
  return patched;
}

function rewriteSps(sps: Uint8Array, colour: AvcColourCodes): Uint8Array {
  const header = sps[0]!;
  if ((header & 0x1f) !== 7) throw new Error("not an SPS NAL");
  const rbsp = toRbsp(sps.subarray(1));
  const head = readSpsHead(new BitReader(rbsp));

  const r = new BitReader(rbsp);
  const w = new BitWriter();
  /** Read a field and write it straight back out — the bits we have no view on. */
  const keep = (n: number): number => {
    const v = r.u(n);
    w.u(v, n);
    return v;
  };

  // Everything before the VUI flag is none of our business.
  w.copy(r, head.vuiFlagBit);

  const hadVui = r.u1() === 1;
  w.u1(1); // vui_parameters_present_flag — there is one now either way

  if (!hadVui) {
    w.u1(0); // aspect_ratio_info_present_flag
    w.u1(0); // overscan_info_present_flag
    writeVideoSignalType(w, colour, 5);
    w.u1(0); // chroma_loc_info_present_flag
    w.u1(0); // timing_info_present_flag
    w.u1(0); // nal_hrd_parameters_present_flag
    w.u1(0); // vcl_hrd_parameters_present_flag
    w.u1(0); // pic_struct_present_flag
    w.u1(0); // bitstream_restriction_flag
    w.u1(1); // rbsp_stop_one_bit
    return assemble(header, w);
  }

  // An existing VUI: keep what precedes the colour block, replace the block,
  // then copy the remainder — timing info, HRD, bitstream restrictions — bit
  // for bit. Re-emitting those from a parse would be a second chance to be
  // wrong about fields we have no opinion on.
  if (keep(1) === 1) {
    const idc = keep(8);
    if (idc === 255) keep(32); // sar_width, sar_height
  }
  if (keep(1) === 1) keep(1); // overscan_info_present_flag, overscan_appropriate_flag

  // The old video_signal_type block is read off and dropped — ours replaces it.
  let videoFormat = 5;
  if (r.u1() === 1) {
    videoFormat = r.u(3);
    r.u1(); // video_full_range_flag
    if (r.u1() === 1) {
      r.u(8); // colour_primaries
      r.u(8); // transfer_characteristics
      r.u(8); // matrix_coefficients
    }
  }
  writeVideoSignalType(w, colour, videoFormat);
  // The rest of the RBSP, verbatim — including the stop bit and its padding.
  w.copy(r, r.bitLength - r.bitPos);
  return assemble(header, w);
}

function writeVideoSignalType(w: BitWriter, colour: AvcColourCodes, videoFormat: number): void {
  w.u1(1); // video_signal_type_present_flag
  w.u(videoFormat, 3);
  w.u1(colour.fullRange ? 1 : 0);
  w.u1(1); // colour_description_present_flag
  w.u(colour.primaries, 8);
  w.u(colour.transfer, 8);
  w.u(colour.matrix, 8);
}

function assemble(header: number, w: BitWriter): Uint8Array {
  const payload = toNalPayload(w.bytes());
  const out = new Uint8Array(payload.length + 1);
  out[0] = header;
  out.set(payload, 1);
  return out;
}

/** True when a colour description says something — not three "unspecified"s. */
function namesAColourSpace(codes: AvcColourCodes | null): boolean {
  if (!codes) return false;
  return codes.primaries !== UNSPECIFIED || codes.transfer !== UNSPECIFIED || codes.matrix !== UNSPECIFIED;
}

// ── avcC ──────────────────────────────────────────────────────────────────────

/**
 * The AVC decoder configuration record (`avcC` — WebCodecs' `description` for
 * `avc1`) with every SPS it holds tagged with `colour`.
 *
 * Out-of-band is the only place it needs to happen for MP4: the SPS lives here,
 * not in the sample data, and an extraction to Annex B (`h264_mp4toannexb` and
 * friends) rebuilds the in-band SPS from exactly these bytes.
 */
export function patchAvcCColour(description: Uint8Array, colour: AvcColourCodes): Uint8Array {
  if (description.length < 7 || description[0] !== 1) return description;
  const out = Array.from(description.subarray(0, 5));
  const spsCount = description[5]! & 0x1f;
  out.push(description[5]!);
  let p = 6;
  for (let i = 0; i < spsCount; i++) {
    if (p + 2 > description.length) return description;
    const len = (description[p]! << 8) | description[p + 1]!;
    if (p + 2 + len > description.length) return description;
    const sps = description.subarray(p + 2, p + 2 + len);
    // Already NAMES a colour space? Then the encoder had an opinion and it is
    // not this function's place to overrule it. "Unspecified" is not an
    // opinion — it is the blank this exists to fill, and it is what the browser
    // encoders actually write: a VUI whose three code points are all 2, which
    // is why `ffprobe` calls the stream's colour space "unknown".
    const patched = namesAColourSpace(readSpsColour(sps)) ? sps : patchSpsColour(sps, colour);
    out.push((patched.length >> 8) & 0xff, patched.length & 0xff, ...patched);
    p += 2 + len;
  }
  for (; p < description.length; p++) out.push(description[p]!);
  return Uint8Array.from(out);
}
