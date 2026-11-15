/**
 * The vocabulary of a theme file, as plain constants: modes, label styles,
 * and every part with its dialects. Kept apart from the zod schema so a page
 * that only COMPILES a theme (the studio, the site) never ships the validator.
 */
export const MODES = ["dark", "light"] as const;
export type Mode = (typeof MODES)[number];

/** How labels are cased. `title` means AS WRITTEN — the copy is sentence case,
 *  and `text-transform: capitalize` would turn "Play once" into "Play Once". */
export const LABEL_STYLES = ["upper", "title", "lower", "var"] as const;
export type LabelStyle = (typeof LABEL_STYLES)[number];

/**
 * THE PARTS AND THEIR DIALECTS. One list, so the settings UI, the validator
 * and the CSS can never disagree about what a dialect is called.
 */
export const RANGE_DIALECTS = ["meter", "trail", "ruler", "blocks", "steps", "line"] as const;
export const PART_DIALECTS = {
  /** Amounts: opacity, mix, volume, feather. */
  range: RANGE_DIALECTS,
  /** Measures: scale, size, angle, pan. */
  measure: RANGE_DIALECTS,
  switch: ["notch", "dial", "pill", "led", "rocker"],
  tabs: ["playhead", "boxed", "chip", "tmux"],
  button: ["solid", "glass", "outline", "keycap", "offset"],
  /** Never a black well: a field is always a step of the surface it sits on. */
  field: ["well", "line", "box"],
  menu: ["solid", "terminal", "inverted"],
  /** The stage's tool rail: a glass capsule with an accent armed tool, or a
   *  roomy neutral float whose armed tool is a lit tile, with rich tips. */
  tools: ["capsule", "float"],
  /** The stage's surround: plain, or a quiet dot field. */
  backdrop: ["plain", "dots"],
  /** A section's or a window's title: set in the display face, or as an
   *  eyebrow (the code face, small, tracked caps), like the site's sections. */
  heads: ["display", "eyebrow"],
} as const;
export type PartName = keyof typeof PART_DIALECTS;
export type Dialect<P extends PartName> = (typeof PART_DIALECTS)[P][number];
export type Parts = { [P in PartName]: Dialect<P> };
export const PART_NAMES = Object.keys(PART_DIALECTS) as PartName[];


/** The theme file format version. */
export const THEME_SCHEMA_VERSION = 1 as const;
