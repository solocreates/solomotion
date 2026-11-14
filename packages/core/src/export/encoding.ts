/**
 * Headless video-encoding brain — how an export asks for H.264, decided once.
 *
 * Nothing here touches WebCodecs; it produces the *numbers and strings* a
 * codec configuration needs, so the browser exporter, a worker and (one day) a
 * desktop ffmpeg path all ask for the same picture instead of each inventing a
 * bitrate and a profile.
 *
 * Two facts live here:
 *
 *  - the bitrate an output size deserves, derived from pixels — not a constant
 *  - the AVC codec strings to try, at a level that matches the actual output
 *
 * Both used to be hardcoded at the call site: 12 Mbps for everything from 360p
 * to 4K, and `avc1.640033` (High, level 5.1 — a 4K header) on every export.
 */

/** Bits per pixel per frame for a master render. */
const MASTER_BPP = 0.4;

/** Floor/ceiling for a derived bitrate, in bits/sec. */
const MIN_BITRATE = 8_000_000;
const MAX_BITRATE = 120_000_000;

/**
 * The bitrate an export of this size and rate deserves.
 *
 * Motion graphics are the *expensive* case for H.264 — hard edges, flat fills
 * and fast linear motion are exactly what leaves visible mosquito noise behind
 * a moving shape — so this runs at a master-render 0.4 bpp rather than a
 * streaming 0.1. A flat 12 Mbps was roughly right at 720p and starved 4K by
 * eight times; scaling with pixels means one number stops being a lie at both
 * ends.
 */
export function recommendedVideoBitrate(width: number, height: number, fps: number): number {
  const raw = Math.max(1, width) * Math.max(1, height) * Math.max(1, fps) * MASTER_BPP;
  return Math.round(Math.min(MAX_BITRATE, Math.max(MIN_BITRATE, raw)));
}

/**
 * H.264 levels, ascending. `maxBitrate` uses the Baseline/Main factor (High
 * allows 1.25× more) so one chosen level stays legal for every profile in the
 * ladder below.
 */
const AVC_LEVELS: ReadonlyArray<{ id: number; maxMbps: number; maxFs: number; maxBitrate: number }> = [
  { id: 0x1e, maxMbps: 40_500, maxFs: 1_620, maxBitrate: 10_000_000 }, // 3.0
  { id: 0x1f, maxMbps: 108_000, maxFs: 3_600, maxBitrate: 14_000_000 }, // 3.1
  { id: 0x20, maxMbps: 216_000, maxFs: 5_120, maxBitrate: 20_000_000 }, // 3.2
  { id: 0x28, maxMbps: 245_760, maxFs: 8_192, maxBitrate: 20_000_000 }, // 4.0
  { id: 0x29, maxMbps: 245_760, maxFs: 8_192, maxBitrate: 50_000_000 }, // 4.1
  { id: 0x2a, maxMbps: 522_240, maxFs: 8_704, maxBitrate: 50_000_000 }, // 4.2
  { id: 0x32, maxMbps: 589_824, maxFs: 22_080, maxBitrate: 135_000_000 }, // 5.0
  { id: 0x33, maxMbps: 983_040, maxFs: 36_864, maxBitrate: 240_000_000 }, // 5.1
  { id: 0x34, maxMbps: 2_073_600, maxFs: 36_864, maxBitrate: 240_000_000 }, // 5.2
  { id: 0x3c, maxMbps: 4_177_920, maxFs: 139_264, maxBitrate: 240_000_000 }, // 6.0
  { id: 0x3d, maxMbps: 8_355_840, maxFs: 139_264, maxBitrate: 480_000_000 }, // 6.1
  { id: 0x3e, maxMbps: 16_711_680, maxFs: 139_264, maxBitrate: 800_000_000 }, // 6.2
];

/**
 * The lowest H.264 level that legally carries this output.
 *
 * Declaring a level far above the content is not free: hardware encoders size
 * their internal buffers and pick rate-control presets from it, and hardware
 * *decoders* refuse files above the level they advertise. A 720p render should
 * say 3.1, the way every other encoder on earth says it.
 */
export function avcLevelFor(width: number, height: number, fps: number, bitrate: number): number {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const mbps = mbs * Math.max(1, fps);
  const level = AVC_LEVELS.find((l) => mbs <= l.maxFs && mbps <= l.maxMbps && bitrate <= l.maxBitrate);
  return (level ?? AVC_LEVELS[AVC_LEVELS.length - 1]!).id;
}

/**
 * The AVC codec strings to try, best first, for a given output.
 *
 * High → Main → Constrained Baseline. The last two matter more than they look:
 * Chrome's *software* H.264 encoder (OpenH264) only does Constrained Baseline,
 * so a ladder that stopped at High silently guaranteed a hardware encoder on
 * every machine that had one. At master bitrates the coding-efficiency gap
 * between High and Baseline is invisible; the gap between a software encoder
 * and a Windows hardware one is not.
 */
export function avcCodecLadder(width: number, height: number, fps: number, bitrate: number): string[] {
  const level = avcLevelFor(width, height, fps, bitrate).toString(16).toUpperCase().padStart(2, "0");
  return [`avc1.6400${level}`, `avc1.4D00${level}`, `avc1.42E0${level}`];
}

// ── Quality ─────────────────────────────────────────────────────────────────

/**
 * How an export asks for quality.
 *
 * A bitrate is a *delivery* constraint — "fit this pipe" — and to honour it an
 * encoder must guess, per frame, how many bits the next second deserves. That
 * guess is rate control, it is the least reliable part of any encoder, and it
 * is the part that differs most between a GPU's encoder and a CPU's: give the
 * same bitrate to two machines and they spend it differently. On flat fills and
 * smooth gradients — the whole visual language of motion graphics — a bad guess
 * during fast motion shows up as stray bright specks in the background, which
 * persist through the prediction chain until the next keyframe clears them.
 *
 * A master render has no pipe to fit. It should name a *quality* and let the
 * file be whatever size that costs, which is what H.264's quantizer does: lower
 * means finer, 0 is lossless, and it removes rate control from the picture
 * entirely. Every professional encoder exports this way (x264's CRF, Resolve's
 * quality slider); the app asked for a bitrate because that is what the naive
 * WebCodecs example does.
 *
 * `bitrateScale` is the fallback for browsers with no quantizer control, so one
 * pick still means one thing across every export path.
 */
export type VideoQualityId = "draft" | "high" | "master";

export interface VideoQualityTier {
  id: VideoQualityId;
  label: string;
  /** H.264 quantizer, 0–51. Lower is finer. */
  quantizer: number;
  /** Multiplier on `recommendedVideoBitrate` when only bitrate control exists. */
  bitrateScale: number;
}

export const VIDEO_QUALITY_TIERS: readonly VideoQualityTier[] = [
  { id: "draft", label: "Draft", quantizer: 26, bitrateScale: 0.5 },
  { id: "high", label: "High", quantizer: 18, bitrateScale: 1 },
  { id: "master", label: "Master", quantizer: 12, bitrateScale: 2 },
];

/** The tier a new export opens on — visually clean on gradients, sane size. */
export const DEFAULT_VIDEO_QUALITY: VideoQualityId = "high";

export function videoQuality(id: VideoQualityId | undefined): VideoQualityTier {
  return (
    VIDEO_QUALITY_TIERS.find((t) => t.id === id) ??
    VIDEO_QUALITY_TIERS.find((t) => t.id === DEFAULT_VIDEO_QUALITY)!
  );
}

/** The bitrate this quality tier asks for at this output size — the fallback
 *  path, and what the panel shows so a pick has a number behind it. */
export function qualityBitrate(
  id: VideoQualityId | undefined,
  width: number,
  height: number,
  fps: number,
): number {
  return Math.round(recommendedVideoBitrate(width, height, fps) * videoQuality(id).bitrateScale);
}
