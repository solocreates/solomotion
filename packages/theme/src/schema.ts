import { z } from "zod";
import { LABEL_STYLES, MODES, PART_DIALECTS, THEME_SCHEMA_VERSION } from "./parts-list";

export * from "./parts-list";

/**
 * THE THEME FILE — the whole contract between a look and the studio.
 *
 * A theme is data and nothing else. It picks colours, type, shape, and a
 * DIALECT for every part (how a range, a switch, a tab row… is drawn). The
 * studio compiles it to CSS custom properties plus one `data-*` attribute per
 * part on the root (`compile.ts`), and components read only those. No
 * component ever asks which theme is on, which is what lets anyone write one,
 * paste it in, and change everything.
 *
 * Validated with zod, so an imported file either reads or says exactly which
 * field is wrong and why — never a half-applied theme.
 */

/** Any CSS colour. A theme may say `#3df2a8`, `rgb(…)` or `color-mix(…)`; the
 *  browser is the parser, so this only rejects what cannot possibly be one. */
const color = z
  .string()
  .trim()
  .min(3)
  .max(200)
  .refine((s) => !/[;{}<>]/.test(s), "not a CSS colour");

/** The seven neutrals a mode is built from, plus surfaces a theme may pin.
 *  Anything optional is DERIVED from the seven (see `derive.ts`), so a theme
 *  author only has to get seven colours right per mode. */
export const neutralSchema = z.object({
  /** The void the app stands on. */
  bg: color,
  /** Docked surfaces: rails, panels, the timeline. */
  panel: color,
  /** Cards, wells, anything one step up from a panel. */
  raised: color,
  /** The one hairline, where two planes meet. Use alpha. */
  line: color,
  /** Ink. */
  fg: color,
  /** Quieter ink: labels, secondary text. */
  muted: color,
  /** Counts, shortcuts, placeholders. */
  faint: color,
  // ── Optional, derived when absent ─────────────────────────────────────────
  /** Menus, popovers, dialogs. */
  popover: color.optional(),
  /** The canvas surround. */
  stage: color.optional(),
  /** A timeline track lane. */
  lane: color.optional(),
  /** Field wells. Alpha, so it works on every plane. */
  input: color.optional(),
  /** Secondary button surface. */
  secondary: color.optional(),
  /** The faintest filled surface (badges, muted wells). */
  subtle: color.optional(),
  /** Hover and pressed wash. */
  wash: color.optional(),
  /** Delete and destructive confirms. */
  danger: color.optional(),
});
export type Neutral = z.infer<typeof neutralSchema>;

const perMode = <T extends z.ZodTypeAny>(t: T) => z.object({ dark: t, light: t });

const partsSchema = z.object({
  range: z.enum(PART_DIALECTS.range),
  measure: z.enum(PART_DIALECTS.measure),
  switch: z.enum(PART_DIALECTS.switch),
  tabs: z.enum(PART_DIALECTS.tabs),
  button: z.enum(PART_DIALECTS.button),
  field: z.enum(PART_DIALECTS.field),
  menu: z.enum(PART_DIALECTS.menu),
});

/** A font is a family id from `fonts.ts`, or a raw CSS stack for anything else. */
const font = z.string().trim().min(1).max(300);


export const themeSchema = z.object({
  schema: z.literal(THEME_SCHEMA_VERSION).default(THEME_SCHEMA_VERSION),
  id: z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9/_-]*$/i, "letters, digits, - _ /"),
  name: z.string().trim().min(1).max(64),
  /** The mode the theme opens in. A person can still flip it; see the store. */
  mode: z.enum(MODES).default("dark"),
  neutral: perMode(neutralSchema),
  accent: perMode(color),
  /** Ink drawn ON the accent. */
  accentFg: perMode(color),
  /**
   * Colours that say where a value COMES FROM: a field linked to a variable,
   * driven by an expression, by a node graph. Optional; a host keeps its own
   * language when a theme leaves them out.
   */
  tones: z
    .object({
      variable: perMode(color).optional(),
      expression: perMode(color).optional(),
      graph: perMode(color).optional(),
    })
    .optional(),
  font: z.object({
    /** Interface text. */
    ui: font,
    /** Headings, the wordmark, big numbers on a page. */
    display: font,
    /** Code, timecode, keyboard shortcuts. */
    mono: font,
    /** Numbers in value fields. Falls back to `mono` at small sizes. */
    num: font,
  }),
  /** Body text size in px. The whole job-named type scale moves with it. */
  size: z.number().min(10).max(15).default(12),
  /** The weight of a label that leads a row or a group. */
  weight: z.number().min(300).max(700).default(550),
  labels: z.enum(LABEL_STYLES).default("title"),
  /** The LARGEST radius in px (dialogs, windows). Everything smaller is graded
   *  from it, and fields, bars and tabs never drop below 3px. */
  radius: z.number().min(0).max(20).default(12),
  /** Control height in px. Small and large controls are derived ±4. */
  density: z.number().min(22).max(36).default(28),
  /** Glass on floating surfaces over the artwork. A default: a person's own
   *  choice wins, because it is a performance setting as much as a look. */
  glass: z.boolean().default(true),
  parts: partsSchema,
});

/** A complete, validated theme. */
export type Theme = z.infer<typeof themeSchema>;
/** What a theme file may leave out (defaults fill it). */
export type ThemeInput = z.input<typeof themeSchema>;

export type ParseResult = { ok: true; theme: Theme } | { ok: false; error: string };

/**
 * Read a theme file. On failure the message names the FIRST bad field in the
 * file's own words (`parts.switch: expected one of notch | dial | …`), because
 * "invalid theme" is not something a person can fix.
 */
export function parseTheme(raw: unknown): ParseResult {
  const r = themeSchema.safeParse(raw);
  if (r.success) return { ok: true, theme: r.data };
  const issue = r.error.issues[0];
  if (!issue) return { ok: false, error: "That file isn't a theme." };
  const where = issue.path.join(".") || "file";
  const what =
    issue.code === "invalid_enum_value"
      ? `expected one of ${issue.options.join(" | ")}`
      : issue.message.replace(/^Required$/, "missing");
  return { ok: false, error: `${where}: ${what}` };
}

/** JSON text → theme, with parse errors reported the same way. */
export function readThemeFile(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "That file isn't JSON." };
  }
  return parseTheme(raw);
}
