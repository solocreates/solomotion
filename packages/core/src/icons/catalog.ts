/**
 * THE ICON CATALOGUE — model and pure helpers.
 *
 * the app does not ship icons; it reads the open-source world's. The source is
 * the Iconify data format (`@iconify/json`), which every major open set is
 * published in — 200+ sets, 370k icons, one shape: a set has metadata, an icon
 * is an SVG BODY plus a viewBox. Iterating "every icon there is" therefore
 * costs nothing to maintain here: a set that appears upstream appears in the
 * panel, and nobody maps anything by hand.
 *
 * What lives in this file is everything that is true of an icon WITHOUT a
 * network: the model, the licence gate, how a body becomes an `<svg>`, and
 * how to tell a stroke icon from a filled one. The client (`client.ts`) is
 * the half that fetches.
 */

/** How an icon is drawn — decides what a draw-on can do with it. */
export type IconStyle = "stroke" | "fill" | "color";

export interface IconSet {
  /** Iconify prefix — `lucide`, `tabler`, `ph`. Half of every icon's id. */
  prefix: string;
  name: string;
  total: number;
  author: { name: string; url: string | null };
  license: { title: string; spdx: string | null; url: string | null };
  /** A few representative icon names — the set's cover. */
  samples: string[];
  /** The grid the set is drawn on (24 for most UI sets). */
  height: number | null;
  /** Multicolour artwork (emoji, logos) rather than a single-ink glyph. */
  palette: boolean;
  /** Upstream's shelf — "UI 24px", "Emoji", "Logos", "Flags / Maps"… */
  category: string | null;
  /** Upstream's descriptors — "Uses Stroke", "Has Padding"… */
  tags: string[];
  /** Derived from `palette` + `tags`: what a draw-on can expect. */
  style: IconStyle;
}

/** One icon's identity. Its id is `prefix:name`, the same string Iconify uses. */
export interface IconRef {
  prefix: string;
  name: string;
}

export const iconId = (ref: IconRef): string => `${ref.prefix}:${ref.name}`;

export function parseIconId(id: string): IconRef | null {
  const i = id.indexOf(":");
  if (i <= 0 || i === id.length - 1) return null;
  return { prefix: id.slice(0, i), name: id.slice(i + 1) };
}

/** One icon's drawable data — the Iconify icon record, viewBox defaults resolved. */
export interface IconData {
  body: string;
  width: number;
  height: number;
  left: number;
  top: number;
}

/* -------------------------------------------------------------------------- */
/* Licence gate                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Sets the panel offers, by SPDX id. Everything here permits commercial use in
 * a rendered artwork; attribution (CC-BY) is shown on the set and travels with
 * every layer the icon becomes as its `origin` (`schema/provenance.ts`), so a
 * credits list can be read back off the document (`credits.ts`). Copyleft,
 * non-commercial and share-alike licences are excluded on purpose — a video
 * you export must not inherit a licence from a 24px glyph.
 */
export const ICON_LICENSES_ALLOWED: ReadonlySet<string> = new Set([
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-3-Clause",
  "BSD-2-Clause",
  "CC0-1.0",
  "Unlicense",
  "CC-BY-4.0",
  "CC-BY-3.0",
  "OFL-1.1",
  "MPL-2.0",
]);

export function iconSetAllowed(license: { spdx: string | null }): boolean {
  return license.spdx !== null && ICON_LICENSES_ALLOWED.has(license.spdx);
}

/** Does this licence ask for a credit line? The one CC-BY test, shared by the set cover and the credits list. */
export function licenseNeedsAttribution(spdx: string | null): boolean {
  return spdx?.startsWith("CC-BY") ?? false;
}

/** Does using this set require a credit line? */
export function iconSetNeedsAttribution(set: IconSet): boolean {
  return licenseNeedsAttribution(set.license.spdx);
}

/* -------------------------------------------------------------------------- */
/* Style                                                                      */
/* -------------------------------------------------------------------------- */

/** The set's style from upstream's own descriptors. */
export function iconSetStyle(info: { palette: boolean; tags: readonly string[] }): IconStyle {
  if (info.palette) return "color";
  return info.tags.some((t) => /stroke/i.test(t)) ? "stroke" : "fill";
}

/**
 * The style of ONE icon, read off its body — sets like Phosphor and Heroicons
 * mix outline and solid variants under one prefix, so the set's label is only
 * a default. A body that strokes `currentColor` and fills nothing is a line
 * drawing; anything else with `currentColor` is a glyph; a body carrying its
 * own colours is artwork.
 */
export function iconBodyStyle(body: string): IconStyle {
  const usesCurrent = /currentColor/.test(body);
  if (!usesCurrent) return "color";
  const strokes = /stroke="currentColor"/.test(body);
  const fillsNone = /fill="none"/.test(body);
  const fillsCurrent = /fill="currentColor"/.test(body);
  return strokes && (fillsNone || !fillsCurrent) ? "stroke" : "fill";
}

/* -------------------------------------------------------------------------- */
/* Markup                                                                     */
/* -------------------------------------------------------------------------- */

export interface IconSvgOptions {
  /** Rendered size in px (square; the viewBox keeps the icon's aspect). */
  size?: number;
  /** Ink for `currentColor`. Omit to leave `currentColor` for CSS to resolve. */
  color?: string;
  /**
   * Override the stroke width of a LINE icon (a `stroke-width` on the body).
   * Ignored for filled and colour icons, which have no line to widen.
   */
  strokeWidth?: number;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * An icon's body as a complete `<svg>`. Pure string work, so a thumbnail, a
 * drag ghost and the layer import all build from the same markup and can
 * never disagree about what an icon looks like.
 */
export function iconSvg(icon: IconData, opts: IconSvgOptions = {}): string {
  const size = opts.size ?? Math.max(icon.width, icon.height);
  const scale = size / Math.max(icon.width, icon.height);
  const w = icon.width * scale;
  const h = icon.height * scale;
  let body = icon.body;
  if (opts.strokeWidth !== undefined && iconBodyStyle(body) === "stroke") {
    body = body.replace(/stroke-width="[^"]*"/g, `stroke-width="${opts.strokeWidth}"`);
  }
  const color = opts.color ? ` color="${esc(opts.color)}"` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w)}" height="${fmt(h)}" ` +
    `viewBox="${fmt(icon.left)} ${fmt(icon.top)} ${fmt(icon.width)} ${fmt(icon.height)}"${color}>${body}</svg>`
  );
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, ""));

/* -------------------------------------------------------------------------- */
/* Tags                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * An icon's searchable words, derived — never authored. Its name's tokens,
 * its set, its style and any category the set files it under. The panel shows
 * them as hashtags and the search matches on them; an upstream set that ships
 * richer keywords can extend this list without a schema change.
 */
export function iconTags(ref: IconRef, set: Pick<IconSet, "style"> | null, categories: readonly string[] = []): string[] {
  const words = ref.name.split(/[-_ ]+/).filter((w) => w.length > 1 && !/^\d+$/.test(w));
  const out = new Set<string>([...words, ref.prefix, ...(set ? [set.style] : []), ...categories.map((c) => c.toLowerCase())]);
  return [...out];
}
