import { stampedId } from "../identity";

/**
 * IMAGE SEQUENCES — numbered stills that play as footage, the way every
 * compositor treats them. A sequence is an IMAGE asset whose bytes are a pack
 * of frames (see the web reader), so everything that already understands an
 * image that changes over time — the GIF path: playback, trim, loop, posters,
 * tracking, remove-background — understands a sequence with no new clip kind.
 *
 * This file is the headless half: what a sequence IS (its mime) and how an
 * instant becomes a frame. Recognising numbered files as one sequence is
 * `detectImageSequences` (io/sequence).
 */

/**
 * The mime a packed sequence asset carries: `image/x-<ns>-sequence`, written
 * with the importing product's namespace and read for any (identity.ts).
 */
export const SEQUENCE_MIME = stampedId("image/x-", "-", "sequence");

export function isSequenceMime(mime: string | null | undefined): boolean {
  return SEQUENCE_MIME.matches(mime);
}

/** The rate a sequence plays at when nothing says otherwise. */
export const DEFAULT_SEQUENCE_FPS = 24;

/** The frame showing at `sourceMs` — held until the next one, never between. */
export function sequenceFrameAt(sourceMs: number, fps: number, frameCount: number): number {
  const i = Math.floor((Math.max(0, sourceMs) * fps) / 1000 + 1e-6);
  return Math.max(0, Math.min(frameCount - 1, i));
}

export function sequenceDurationMs(frameCount: number, fps: number): number {
  return (frameCount / fps) * 1000;
}
