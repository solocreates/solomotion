import type { SoundAnchor, SoundVoice } from "../schema";

/**
 * TEXT-LOOK PREFERENCES — the two dials the preset browser puts in front of a
 * look before you commit to it, and the reason a hundred presets do not have to
 * be a hundred colour decisions.
 *
 * The model is INHERIT-BY-DEFAULT and it is a discriminated union, not a
 * nullable field with a boolean beside it. "Use the preset's own colour" and
 * "use #FF3366" are two different facts, and a `{ enabled, value }` pair stores
 * them as one — which is how a switch and the swatch under it end up
 * disagreeing about which is authoritative. One arm, one meaning.
 *
 * Both dials are BROWSE-time, not document data: they change what the next
 * apply writes and what the cards show you it would write, and they are then
 * out of the loop entirely. A clip that has been styled owns its own colours.
 */

/**
 * THE COLOUR ROLES. Three, closed, and enough — this is a palette, not a theme.
 *
 *   ink     the look's IDENTITY colour. Whatever the eye reads as "the colour
 *           of this preset" — usually the type, but on a look whose type is
 *           near-black on a coloured pill it is the PILL. Role is by meaning,
 *           never by which field it happens to sit in, which is exactly what
 *           makes one override recolour a hundred different looks coherently.
 *   accent  the second colour: an offset shadow, a chrome fringe, a second word.
 *   shade   the neutral that makes the other two legible — a near-black or a
 *           near-white. Deliberately NOT recoloured by an override, because a
 *           user picking "make it pink" means the identity, not the outline
 *           that is keeping the identity readable.
 */
export const COLOR_ROLES = ["ink", "accent", "shade"] as const;
export type ColorRole = (typeof COLOR_ROLES)[number];

/** A look's own three colours. The only place a template writes a literal hex. */
export type TemplatePalette = Record<ColorRole, string>;

/**
 * A colour slot inside a template: a role token (`"@ink"`, `"@accent/40"`) or a
 * plain hex for the rare colour that is genuinely fixed (a chroma key green).
 *
 * The `/NN` suffix is an ALPHA PERCENT, and it is why the token beats a second
 * palette entry per translucency: a drop shadow at `"@shade/45"` follows a
 * recolour and keeps its own weight, where `#00000073` would go on being black
 * forever and `shadeSoft` would be a fourth role that means nothing.
 */
export type ColorToken = string;

const ROLE_TOKEN = /^@(ink|accent|shade)(?:\/(\d{1,3}))?$/;

/** `#RRGGBB` + 0..100 alpha → `#RRGGBBAA`. Passes through anything else. */
function withAlpha(hex: string, pct: number): string {
  // `pct * 2.55` is not the same number: 50 lands on 127.4999… and rounds DOWN,
  // so a half-opacity shadow came out one step light. Divide last.
  const a = Math.round((Math.min(100, Math.max(0, pct)) * 255) / 100)
    .toString(16)
    .padStart(2, "0");
  if (/^#[0-9a-f]{6}$/i.test(hex)) return `${hex}${a}`;
  if (/^#[0-9a-f]{8}$/i.test(hex)) return `${hex.slice(0, 7)}${a}`;
  return hex;
}

/** One token against a palette. Not a token → returned untouched. */
export function resolveColorToken(token: ColorToken, palette: TemplatePalette): string {
  const m = ROLE_TOKEN.exec(token);
  if (!m) return token;
  const base = palette[m[1] as ColorRole];
  return m[2] === undefined ? base : withAlpha(base, Number(m[2]));
}

/**
 * Deep-clone `value`, substituting every role token it contains.
 *
 * It walks EVERY string rather than a list of known colour fields, and that is
 * the decision worth defending: a template's colours live in `style.color`,
 * `style.highlight.color`, each `textEffects[].color` and each `effects[].color`
 * — four shapes today, and a fifth the day someone adds an effect with a
 * `tint`. A field list would have to be edited then, silently produce a look
 * with a stray `"@ink"` in it if it were not, and there is nothing else in a
 * template that a leading `@` could plausibly mean.
 */
export function substituteRoles<T>(value: T, palette: TemplatePalette): T {
  if (typeof value === "string") return resolveColorToken(value, palette) as T;
  if (Array.isArray(value)) return value.map((v) => substituteRoles(v, palette)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteRoles(v, palette);
    return out as T;
  }
  return value;
}

// ── The preferences ──────────────────────────────────────────────────────────

/**
 * `inherit` is not "no preference" — it is the statement that the preset's own
 * palette wins, which is the right default and the one a user returns to.
 * `custom` carries `accent: null` for "recolour the identity, leave the second
 * colour alone", which is what someone dropping a brand colour into a browser
 * almost always means.
 */
export type TextLookColorPref =
  | { mode: "inherit" }
  | { mode: "custom"; ink: string; accent: string | null };

/**
 * The voice a preset's per-unit sound uses.
 *
 * `off` is a real arm and not `custom` at volume 0: silence is a decision, it
 * has to survive switching between presets that do and do not ship a sound,
 * and it must not be reachable by accidentally dragging a fader to the floor.
 *
 * `custom` applies to EVERY look, including the ones authored silent — which is
 * the feature. A per-unit voice is a property of the typing, not of the
 * typeface, so "every text I place clicks like this" is one setting rather than
 * a hundred presets that would each have had to agree.
 */
export type TextLookSoundPref =
  | { mode: "inherit" }
  | { mode: "off" }
  | { mode: "custom"; voice: SoundVoice; anchor: SoundAnchor; offsetMs: number };

export interface TextLookPrefs {
  color: TextLookColorPref;
  sound: TextLookSoundPref;
}

/** Everything inherited — what the browser starts at and "Reset" returns to. */
export const INHERIT_PREFS: TextLookPrefs = {
  color: { mode: "inherit" },
  sound: { mode: "inherit" },
};

/** A starting voice for the sound override, so the popover opens on something
 *  audible rather than on silence the user has to go and fix. */
export function defaultLookVoice(): Extract<TextLookSoundPref, { mode: "custom" }> {
  return {
    mode: "custom",
    voice: { pack: "soft", custom: null, volume: 0.3, randomness: 0.55, pitch: 1, notes: null, kit: null, climb: "pitch" },
    anchor: "start",
    offsetMs: 0,
  };
}

/** True when this preference changes nothing — what the browser's chip reads. */
export function prefsAreInherited(prefs: TextLookPrefs): boolean {
  return prefs.color.mode === "inherit" && prefs.sound.mode === "inherit";
}

/** The palette a look is actually drawn and applied with, under `prefs`. */
export function effectivePalette(base: TemplatePalette, pref: TextLookColorPref): TemplatePalette {
  if (pref.mode === "inherit") return base;
  return { ink: pref.ink, accent: pref.accent ?? base.accent, shade: base.shade };
}
