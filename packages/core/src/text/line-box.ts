/**
 * WHERE A LINE'S BASELINE SITS IN ITS LINE BOX — the one answer, for the canvas,
 * the exporter, the inline editor and anything that centres text in a shape.
 *
 * A line box is `fontSize × lineHeight` tall. The only question is where the
 * letters sit inside it, and there are two answers in saved documents:
 *
 *  - `"fixed"`: 0.78 em below the top, whatever the font. It is what every
 *    document up to v116 was laid out with. It knows nothing about the face, so
 *    the letters ride high in their own box by a different amount per font
 *    (JetBrains Mono at line height 1.15: ~0.16 em — the box looked centred on
 *    the layer and the text did not look centred in the box). Kept only so
 *    those documents do not move.
 *  - `"centered"`: the letters' own middle is the box's middle. For a cased
 *    script that middle is half the CAP HEIGHT above the baseline — what the eye
 *    reads as the centre of "Export", "340 LAYERS", "build it a world" — so a
 *    text layer centred on a pill is centred IN the pill, on every face, at
 *    every line height. A script with no capitals (Arabic, Persian, Hebrew) has
 *    no such band; it centres the face's own content area (ascent + descent),
 *    which is the box its designer balanced the letters in, and what CSS does.
 *
 * The band is a FACE metric, never the ink of the text typed: a box that
 * followed the ink would jump as you type a "g" after "moon".
 */
export type BaselineModel = "fixed" | "centered";

/** A face's vertical metrics as fractions of the font size. */
export interface FaceMetrics {
  /** Baseline → top of a flat capital. */
  cap: number;
  /** Baseline → top of the face's content area. */
  ascent: number;
  /** Baseline → bottom of the face's content area. */
  descent: number;
}

/** The `"fixed"` model's ratio. */
export const FIXED_ASCENT_RATIO = 0.78;

/**
 * A middle-of-the-road sans, for when the real face cannot be measured (a
 * headless run, a font that failed to load, an engine with no font metrics).
 */
export const GENERIC_FACE: FaceMetrics = { cap: 0.7, ascent: 0.95, descent: 0.25 };

/** A measurement is usable when it describes letters at all. */
export function saneFace(face: Partial<FaceMetrics> | null | undefined): FaceMetrics {
  const ok = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
  return {
    cap: ok(face?.cap, 0.3, 1.2) ? face.cap : GENERIC_FACE.cap,
    ascent: ok(face?.ascent, 0.3, 2.5) ? face.ascent : GENERIC_FACE.ascent,
    descent: ok(face?.descent, 0, 1.5) ? face.descent : GENERIC_FACE.descent,
  };
}

/**
 * The baseline's distance below the TOP of a line box `lineBox` px tall, for a
 * line whose largest glyph is `em` px in `face`.
 */
export function lineBaseline(
  model: BaselineModel,
  em: number,
  lineBox: number,
  face: FaceMetrics = GENERIC_FACE,
  script: "cased" | "uncased" = "cased",
): number {
  if (model === "fixed") return em * FIXED_ASCENT_RATIO;
  if (script === "cased") return lineBox / 2 + (face.cap * em) / 2;
  return (lineBox - (face.ascent + face.descent) * em) / 2 + face.ascent * em;
}
