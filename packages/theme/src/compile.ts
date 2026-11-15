import { fontDef, fontStack } from "./fonts";
import { PART_NAMES, type Mode } from "./parts-list";
import type { Neutral, Theme } from "./schema";

/**
 * THEME → CSS. The one place a theme becomes something a browser can draw.
 *
 * Pure: a theme and a mode in, a map of custom properties and a map of root
 * attributes out. The host applies both (`applyCompiled`), and that is the
 * only way a theme ever touches a document. Components read the variables and
 * the `data-*` dialects; none of them reads a theme.
 *
 * The variable NAMES are the studio's existing ones (`--background`,
 * `--panel`, `--primary`…), so every utility class already written keeps
 * working, and a theme that reproduces today's colours reproduces today's app.
 */
export interface Compiled {
  vars: Record<string, string>;
  /** Keys without the `data-` prefix: `{ switch: "notch" }` → `data-switch="notch"`. */
  attrs: Record<string, string>;
  /** For `color-scheme`, so native scrollbars and widgets follow. */
  scheme: Mode;
  /** The live accent as a colour string, for canvas code that cannot read a var. */
  accent: string;
}

const REM = 16;
const rem = (px: number) => `${Number((px / REM).toFixed(5))}rem`;
const ink = (fg: string, pct: number) => `color-mix(in srgb, ${fg} ${pct}%, transparent)`;

/** Ring = the accent at 60%. A six-digit hex gets an alpha byte (identical to
 *  what the studio always emitted); anything else is mixed. */
function ringFrom(accent: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(accent) ? `${accent}99` : `color-mix(in srgb, ${accent} 60%, transparent)`;
}

/**
 * Every surface a mode needs, from the seven neutrals. A theme that pins a
 * surface wins; otherwise it is mixed from the ones it did give, so a light
 * mode and a dark mode each get their own tones by construction.
 */
export function surfaces(n: Neutral, mode: Mode) {
  const dark = mode === "dark";
  return {
    popover: n.popover ?? (dark ? `color-mix(in oklab, ${n.raised}, ${n.fg} 4%)` : n.panel),
    stage: n.stage ?? (dark ? `color-mix(in oklab, ${n.bg}, #000 28%)` : `color-mix(in oklab, ${n.bg}, ${n.fg} 7%)`),
    lane: n.lane ?? `color-mix(in oklab, ${n.panel}, ${n.fg} ${dark ? 2.5 : 2}%)`,
    input: n.input ?? ink(n.fg, dark ? 6 : 5),
    secondary: n.secondary ?? ink(n.fg, dark ? 6 : 4),
    subtle: n.subtle ?? ink(n.fg, 3),
    wash: n.wash ?? ink(n.fg, dark ? 8 : 6),
    danger: n.danger ?? (dark ? "#f2555a" : "#d93a3f"),
    success: n.success ?? (dark ? "#46d39a" : "#13895a"),
    warning: n.warning ?? (dark ? "#f2b13c" : "#a86a07"),
  };
}

export function compile(theme: Theme, mode: Mode = theme.mode): Compiled {
  const n = theme.neutral[mode];
  const s = surfaces(n, mode);
  const accent = theme.accent[mode];
  const light = mode === "light";
  const v: Record<string, string> = {};
  const set = (k: string, x: string) => (v[k] = x);

  // ── Colour ────────────────────────────────────────────────────────────────
  set("--background", n.bg);
  set("--foreground", n.fg);
  set("--card", n.raised);
  set("--card-foreground", n.fg);
  set("--popover", s.popover);
  set("--popover-foreground", n.fg);
  set("--primary", accent);
  set("--primary-foreground", theme.accentFg[mode]);
  set("--secondary", s.secondary);
  set("--secondary-foreground", n.fg);
  set("--muted", s.subtle);
  set("--muted-foreground", n.muted);
  set("--accent", s.wash);
  set("--accent-foreground", n.fg);
  set("--border", n.line);
  set("--input", s.input);
  set("--ring", ringFrom(accent));
  set("--panel", n.panel);
  set("--stage", s.stage);
  set("--track-lane", s.lane);
  set("--destructive", s.danger);
  set("--success", s.success);
  set("--warning", s.warning);
  set("--fg-faint", n.faint);
  // Where a value comes from. Left to the host's own language when unset.
  if (theme.tones?.variable) set("--bind-variable", theme.tones.variable[mode]);
  if (theme.tones?.expression) set("--bind-expression", theme.tones.expression[mode]);
  if (theme.tones?.graph) set("--bind-graph", theme.tones.graph[mode]);

  // ── Shape ─────────────────────────────────────────────────────────────────
  // ONE knob, graded in globals: the largest radius; menus 2/3, controls 1/2,
  // chips 1/3, with fields, bars and tabs floored at 3px there.
  set("--radius", rem(theme.radius));
  set("--control-h", rem(theme.density));
  set("--control-h-sm", rem(theme.density - 4));
  set("--control-h-lg", rem(theme.density + 4));

  // ── Type ──────────────────────────────────────────────────────────────────
  set("--font-sans", fontStack(theme.font.ui));
  set("--font-ui", fontStack(theme.font.ui));
  set("--font-display", fontStack(theme.font.display));
  set("--font-code", fontStack(theme.font.mono));
  set("--font-num", fontStack(theme.font.num));
  set("--font-features", fontDef(theme.font.ui)?.features ?? "normal");
  // A dot-matrix numeral face stops reading below its own floor; the small
  // job sizes take the code face there instead (see parts.css).
  const numDef = fontDef(theme.font.num);
  const numFloor = numDef?.minPx;
  set("--num-weight", numDef?.numerals ? String(numDef.numerals.weight) : "inherit");
  set("--num-scale", String(numDef?.numerals?.scale ?? 1));
  set("--font-num-small", numFloor ? fontStack(theme.font.mono) : fontStack(theme.font.num));
  // The job-named scale is authored at 12px body; a theme moves all of it.
  set("--type-step", rem(theme.size - 12));
  set("--label-weight", String(theme.weight));
  // CAPS and --var labels run wider than sentence case; the property column
  // that leads every inspector row widens with them instead of truncating.
  set("--label-col", rem(theme.labels === "upper" || theme.labels === "var" ? 76 : 56));

  // ── Glass ─────────────────────────────────────────────────────────────────
  // Differs by mode because the naive recipe only works on dark: a white
  // specular on a pale surface is invisible, so light takes a dark rim.
  set("--glass-tint", `color-mix(in srgb, ${s.popover} ${light ? 92 : 88}%, transparent)`);
  set("--glass-solid", s.popover);
  set("--glass-raised", light ? "rgb(255 255 255 / 0.70)" : "rgb(255 255 255 / 0.10)");
  set("--glass-specular", light ? "rgb(255 255 255 / 0.80)" : "rgb(255 255 255 / 0.12)");
  set("--glass-specular-strong", light ? "rgb(255 255 255 / 0.95)" : "rgb(255 255 255 / 0.18)");
  set("--glass-shade", light ? "rgb(0 0 0 / 0.06)" : "rgb(0 0 0 / 0.22)");
  set("--glass-rim", light ? "rgb(0 0 0 / 0.10)" : "rgb(255 255 255 / 0.08)");

  // ── Elevation ─────────────────────────────────────────────────────────────
  // A cast shadow is a statement about how much light the ground reflects:
  // 40–70% black reads as depth on a near-black room and as a grey smear on a
  // pale one, so light gets a weak, tight cast and a dark hairline rim.
  if (light) {
    set("--elevation-1", "0 1px 2px rgb(15 15 25 / 0.06)");
    set("--elevation-2", "0 4px 12px -6px rgb(15 15 25 / 0.12), 0 1px 2px rgb(15 15 25 / 0.06)");
    set(
      "--elevation-3",
      "0 12px 32px -12px rgb(15 15 25 / 0.18), 0 2px 8px -4px rgb(15 15 25 / 0.10), inset 0 0 0 1px rgb(15 15 25 / 0.07)",
    );
  } else {
    set("--elevation-1", "0 1px 2px rgb(0 0 0 / 0.4)");
    set("--elevation-2", "0 4px 16px -6px rgb(0 0 0 / 0.55), 0 1px 3px rgb(0 0 0 / 0.35)");
    set(
      "--elevation-3",
      "0 16px 48px -12px rgb(0 0 0 / 0.7), 0 4px 12px -4px rgb(0 0 0 / 0.4), inset 0 1px 0 0 rgb(255 255 255 / 0.06)",
    );
  }

  // ── Dialects ──────────────────────────────────────────────────────────────
  const attrs: Record<string, string> = { mode, labels: theme.labels };
  for (const p of PART_NAMES) attrs[p] = theme.parts[p];

  return { vars: v, attrs, scheme: mode, accent };
}

/** The attributes a compiled theme owns on the root — for clearing them. */
export const THEME_ATTRS = ["mode", "labels", ...PART_NAMES] as const;

/**
 * Apply a compiled theme to an element (the document root, or a preview box
 * that wears a different theme from the page around it). Setting variables
 * restyles live with no re-render; nothing else is needed.
 */
const applied = new WeakMap<HTMLElement, string[]>();

// #region apply
export function applyCompiled(el: HTMLElement, c: Compiled): void {
  // A theme may set a variable the next one leaves to the host (an optional
  // tone); clear what the last theme set and this one does not, or it lingers.
  for (const k of applied.get(el) ?? []) if (!(k in c.vars)) el.style.removeProperty(k);
  applied.set(el, Object.keys(c.vars));
  for (const [k, x] of Object.entries(c.vars)) el.style.setProperty(k, x);
  for (const [k, x] of Object.entries(c.attrs)) el.setAttribute(`data-${k}`, x);
  el.style.colorScheme = c.scheme;
}
// #endregion

/**
 * The COLOURS and type of a compiled theme as a `style` object, for an element
 * that previews a theme inside a page wearing another (a preset card).
 *
 * Dialects are deliberately not included: they are keyed on the ROOT
 * (`:root[data-switch=…]`), because CSS has no "nearest ancestor wins" for
 * attribute selectors — a nested `data-switch` would fight the root's by
 * source order, not by nearness. Variables do inherit by nearness, so colour,
 * type and shape preview correctly in a box.
 */
export function previewStyle(c: Compiled): Record<string, string> {
  return { ...c.vars, colorScheme: c.scheme };
}

