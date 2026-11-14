/**
 * A tiny, dependency-free CSS resolver for SVG import. SVGs style their shapes
 * three ways — presentation attributes (`fill="red"`), inline `style="…"`, and
 * `<style>` blocks with class/id/tag selectors — and the browser's cascade + a
 * live DOM mount is fragile (mount timing, global `<style>` pollution, the
 * inherited-`visibility` trap). This resolves the cascade PURELY from strings,
 * so shape/style detection is deterministic, testable and future-safe: any SVG,
 * any browser, the same result.
 */

export interface CssRule {
  selectors: string[];
  decls: Record<string, string>;
}

/** Element facts a selector matches against (no DOM needed). */
export interface ElementFacts {
  tag: string;
  id: string | null;
  classes: string[];
}

/** Parse CSS declarations ("fill:#fff; stroke:none") into a prop→value map. */
export function parseDeclarations(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split(";")) {
    const idx = part.indexOf(":");
    if (idx < 0) continue;
    const prop = part.slice(0, idx).trim().toLowerCase();
    const value = part.slice(idx + 1).trim();
    if (prop) out[prop] = value;
  }
  return out;
}

/** Parse the text of one or more `<style>` blocks into ordered rules. */
export function parseCssRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  // Drop comments, then match `selectorList { declarations }`.
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const selectors = m[1]!
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const decls = parseDeclarations(m[2]!);
    if (selectors.length > 0 && Object.keys(decls).length > 0) rules.push({ selectors, decls });
  }
  return rules;
}

/** CSS specificity of a simple/compound selector (id·100 + class·10 + tag·1). */
export function selectorSpecificity(selector: string): number {
  const compound = rightmostCompound(selector);
  const ids = (compound.match(/#[\w-]+/g) ?? []).length;
  const classes = (compound.match(/[.\[][\w-]+/g) ?? []).length;
  const tags = (compound.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length;
  return ids * 100 + classes * 10 + tags;
}

/** The rightmost compound selector — we ignore descendant combinators (rare in
 * icon SVGs) and match on the subject, a safe, predictable approximation. */
function rightmostCompound(selector: string): string {
  const parts = selector.trim().split(/[\s>+~]+/).filter(Boolean);
  return parts[parts.length - 1] ?? selector.trim();
}

/** Does a compound selector (e.g. `path.st0`, `.st0`, `#id`, `*`) match? */
export function selectorMatches(selector: string, el: ElementFacts): boolean {
  const compound = rightmostCompound(selector);
  if (compound === "*" || compound === "") return true;
  const idM = compound.match(/#([\w-]+)/);
  if (idM && idM[1] !== el.id) return false;
  const classes = Array.from(compound.matchAll(/\.([\w-]+)/g)).map((x) => x[1]!);
  if (classes.some((c) => !el.classes.includes(c))) return false;
  const tagM = compound.match(/^([a-zA-Z][\w-]*)/);
  if (tagM && tagM[1]!.toLowerCase() !== el.tag.toLowerCase()) return false;
  return true;
}

/** Merge every `<style>` declaration that matches, in specificity order. */
export function cssDeclarationsFor(el: ElementFacts, rules: CssRule[]): Record<string, string> {
  const matched: Array<{ spec: number; order: number; decls: Record<string, string> }> = [];
  rules.forEach((rule, order) => {
    let best = -1;
    for (const sel of rule.selectors) {
      if (selectorMatches(sel, el)) best = Math.max(best, selectorSpecificity(sel));
    }
    if (best >= 0) matched.push({ spec: best, order, decls: rule.decls });
  });
  // Lower specificity first; equal specificity → source order (later wins).
  matched.sort((a, b) => a.spec - b.spec || a.order - b.order);
  const out: Record<string, string> = {};
  for (const m of matched) Object.assign(out, m.decls);
  return out;
}

/**
 * Resolve ONE presentation property for an element via the SVG cascade
 * (low→high precedence): inherited value < presentation attribute < matched
 * `<style>` rules < inline `style`. Returns undefined when nothing sets it.
 */
export function resolveStyleProp(
  prop: string,
  opts: {
    inherited?: string;
    presentationAttr?: string | null;
    cssRuleValue?: string;
    inlineStyleValue?: string;
  },
): string | undefined {
  if (opts.inlineStyleValue !== undefined) return opts.inlineStyleValue;
  if (opts.cssRuleValue !== undefined) return opts.cssRuleValue;
  if (opts.presentationAttr !== undefined && opts.presentationAttr !== null) return opts.presentationAttr;
  return opts.inherited;
}

// ── CSS color → hex ──────────────────────────────────────────────────────────

const NAMED_COLORS: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff",
  yellow: "#ffff00", cyan: "#00ffff", aqua: "#00ffff", magenta: "#ff00ff", fuchsia: "#ff00ff",
  gray: "#808080", grey: "#808080", silver: "#c0c0c0", maroon: "#800000", olive: "#808000",
  lime: "#00ff00", teal: "#008080", navy: "#000080", purple: "#800080", orange: "#ffa500",
  pink: "#ffc0cb", brown: "#a52a2a", gold: "#ffd700", transparent: "#00000000",
};

const clampByte = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");

/**
 * Any CSS color string ("#abc", "#aabbcc", "rgb(…)", "rgba(…)", a named color)
 * plus an extra alpha multiplier → an 8- or 6-digit hex. `currentColor` must be
 * pre-resolved by the caller. Returns null for none/unresolvable.
 */
export function cssColorToHex(input: string, alphaMul = 1): string | null {
  const v = input.trim().toLowerCase();
  if (!v || v === "none") return null;
  if (alphaMul <= 0.003) return null;

  const withAlpha = (rgb: string, a: number) => (a >= 0.999 ? rgb : `${rgb}${clampByte(a * 255)}`);

  // #rgb / #rgba / #rrggbb / #rrggbbaa
  const hex = /^#([0-9a-f]{3,8})$/.exec(v);
  if (hex) {
    const h = hex[1]!;
    let r: number, g: number, b: number, a = 1;
    if (h.length === 3 || h.length === 4) {
      r = parseInt(h[0]! + h[0]!, 16);
      g = parseInt(h[1]! + h[1]!, 16);
      b = parseInt(h[2]! + h[2]!, 16);
      if (h.length === 4) a = parseInt(h[3]! + h[3]!, 16) / 255;
    } else if (h.length === 6 || h.length === 8) {
      r = parseInt(h.slice(0, 2), 16);
      g = parseInt(h.slice(2, 4), 16);
      b = parseInt(h.slice(4, 6), 16);
      if (h.length === 8) a = parseInt(h.slice(6, 8), 16) / 255;
    } else {
      return null;
    }
    return withAlpha(`#${clampByte(r)}${clampByte(g)}${clampByte(b)}`, a * alphaMul);
  }

  // rgb()/rgba()
  const rgb = /rgba?\(\s*([\d.]+%?)[,\s]+([\d.]+%?)[,\s]+([\d.]+%?)(?:[,\s/]+([\d.]+%?))?\s*\)/.exec(v);
  if (rgb) {
    const chan = (s: string) => (s.endsWith("%") ? (parseFloat(s) / 100) * 255 : parseFloat(s));
    const a = rgb[4] !== undefined ? (rgb[4].endsWith("%") ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4])) : 1;
    return withAlpha(`#${clampByte(chan(rgb[1]!))}${clampByte(chan(rgb[2]!))}${clampByte(chan(rgb[3]!))}`, a * alphaMul);
  }

  const named = NAMED_COLORS[v];
  if (named) return named === "#00000000" ? null : withAlpha(named, alphaMul);
  return null;
}
