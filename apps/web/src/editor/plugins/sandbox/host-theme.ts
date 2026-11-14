import { fontStack, type Mode, type Theme } from "@solomotion/theme";

/**
 * The look a plugin window inherits: a SMALL, STABLE set of `--host-*`
 * variables, never the app's own variable namespace (that is free to change;
 * this is protocol, documented in the plugin SDK's README).
 *
 * It lands in the sandbox document's head BEFORE the plugin's own styles, and
 * the defaults hang off `:where(html)` (zero specificity), so a plugin that
 * paints itself wins on every rule and one that does not reads as part of the
 * app instead of a white slab in a dark window.
 */
export function hostThemeCss(theme: Theme, mode: Mode): string {
  const n = theme.neutral[mode];
  const vars: Record<string, string> = {
    "--host-bg": n.panel,
    "--host-raised": n.raised,
    "--host-line": n.line,
    "--host-fg": n.fg,
    "--host-muted": n.muted,
    "--host-accent": theme.accent[mode],
    "--host-on-accent": theme.accentFg[mode],
    "--host-radius": `${Math.round(theme.radius / 2)}px`,
    "--host-font": fontStack(theme.font.ui),
    "--host-mono": fontStack(theme.font.mono),
  };
  const decl = Object.entries(vars)
    .map(([k, v]) => `${k}:${v.replace(/[<>{};]/g, "")}`)
    .join(";");
  return (
    `<style data-host-theme>:root{color-scheme:${mode};${decl}}` +
    `:where(html){background:var(--host-bg);color:var(--host-fg);font:13px/1.45 var(--host-font);accent-color:var(--host-accent)}</style>`
  );
}
